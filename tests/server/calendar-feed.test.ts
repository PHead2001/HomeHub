import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import {
  CalendarFeedError, disableCalendarFeed, hashFeedToken, householdForFeedToken, readCalendarFeed, rotateCalendarFeed,
} from '../../src/lib/server/calendar-feed';
import { GET } from '../../src/app/api/calendar-feed/[token]/route';
import { deleteHousehold } from '../../src/lib/server/household-membership';

// The household's phone calendar feed (audit CA-25) against the Firestore emulator:
// owners and admins manage it, the token opens exactly one household, rotation and
// turning it off end the old URL at once, and the feed never carries an email.
const HOUSE = 'server-calendar-feed-house';
const OTHER = 'server-calendar-feed-other';
const house = () => adminDb.collection('households').doc(HOUSE);
const owner = { uid: 'cf-owner', email: 'cf.owner@example.test' };
const admin = { uid: 'cf-admin', email: 'cf.admin@example.test' };
const member = { uid: 'cf-member', email: 'cf.member@example.test' };
const stranger = { uid: 'cf-stranger', email: 'cf.stranger@example.test' };

const refusal = async (run: Promise<unknown>) => {
  try {
    await run;
    return 'ok';
  } catch (error) {
    return error instanceof CalendarFeedError ? error.code : String(error);
  }
};

const fetchFeed = (token: string) => GET(new Request(`https://homehub.example/api/calendar-feed/${token}`), { params: Promise.resolve({ token }) });

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await adminDb.recursiveDelete(adminDb.collection('households').doc(OTHER));
  for (const snap of (await adminDb.collection('calendarFeeds').get()).docs) await snap.ref.delete();
  await house().set({ name: 'Feed House', timeZone: 'America/Chicago' });
  for (const [person, role, name] of [[owner, 'owner', 'Olive'], [admin, 'admin', 'Ada'], [member, 'member', 'Max']] as const) {
    await house().collection('members').doc(person.uid).set({ uid: person.uid, role, status: 'active', displayName: name });
  }
  await adminDb.collection('households').doc(OTHER).set({ name: 'Other', timeZone: 'UTC' });
  await adminDb.collection('households').doc(OTHER).collection('members').doc(stranger.uid).set({ uid: stranger.uid, role: 'owner', status: 'active' });
  await house().collection('chores').doc('dishes').set({
    task: 'Dishes, then dry', assignedToUid: member.uid, assignedToEmail: member.email, assignedToDisplayName: 'Max',
    originalDueDate: today(), dueDate: new Date().toISOString(), isCompleted: false, roomIds: [],
  });
});

after(async () => {
  await adminDb.recursiveDelete(house());
  await adminDb.recursiveDelete(adminDb.collection('households').doc(OTHER));
});

describe('phone calendar feed', () => {
  test('owners and admins turn it on and read it; members and other households cannot', async () => {
    assert.deepEqual(await readCalendarFeed(adminDb, owner, HOUSE), { token: null });
    const { token } = await rotateCalendarFeed(adminDb, admin, HOUSE);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await readCalendarFeed(adminDb, owner, HOUSE), { token });
    assert.equal(await refusal(readCalendarFeed(adminDb, member, HOUSE)), 'forbidden');
    assert.equal(await refusal(rotateCalendarFeed(adminDb, member, HOUSE)), 'forbidden');
    assert.equal(await refusal(rotateCalendarFeed(adminDb, stranger, HOUSE)), 'not_member');
    assert.equal(await refusal(readCalendarFeed(adminDb, owner, 'missing-house')), 'not_found');
    // Only the hash is the lookup's id; the token itself is never a document id.
    assert.equal((await adminDb.collection('calendarFeeds').doc(hashFeedToken(token)).get()).get('householdId'), HOUSE);
    assert.equal((await adminDb.collection('calendarFeeds').doc(token).get()).exists, false);
  });

  test('the URL serves the household calendar as iCalendar, without emails', async () => {
    // An older pantry item: an ISO timestamp expiry and no packages field (read through readPantryBatch).
    await house().collection('pantry-inventory').doc('milk').set({ name: 'Milk', unit: 'items', quantity: 1, expiryDate: `${today()}T18:00:00.000Z` });
    const { token } = await rotateCalendarFeed(adminDb, owner, HOUSE);
    const response = await fetchFeed(token);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/calendar/);
    const body = await response.text();
    assert.ok(body.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(body.endsWith('END:VCALENDAR\r\n'));
    assert.match(body, /X-WR-CALNAME:Feed House \(HomeHub\)/);
    assert.match(body, /SUMMARY:Dishes\\, then dry \(Max\)/);
    assert.match(body, new RegExp(`DTSTART;VALUE=DATE:${today().replace(/-/g, '')}`));
    assert.doesNotMatch(body, /@example\.test/);
    assert.match(body, /SUMMARY:Milk expires/);
    assert.equal((await fetchFeed(`${token}.ics`)).status, 200, 'a trailing .ics is accepted');
  });

  test('rotating ends the old URL at once; turning it off ends the new one', async () => {
    const first = await rotateCalendarFeed(adminDb, owner, HOUSE);
    const second = await rotateCalendarFeed(adminDb, owner, HOUSE);
    assert.notEqual(first.token, second.token);
    assert.equal(await householdForFeedToken(adminDb, first.token), null);
    assert.equal((await fetchFeed(first.token)).status, 404);
    assert.equal(await householdForFeedToken(adminDb, second.token), HOUSE);
    await disableCalendarFeed(adminDb, admin, HOUSE);
    assert.equal((await fetchFeed(second.token)).status, 404);
    assert.deepEqual(await readCalendarFeed(adminDb, owner, HOUSE), { token: null });
  });

  test('deleting the household removes the feed secret and every lookup', async () => {
    const { token } = await rotateCalendarFeed(adminDb, owner, HOUSE);
    // A stale lookup left by an older run goes too.
    await adminDb.collection('calendarFeeds').doc('stale-hash').set({ householdId: HOUSE });
    await adminDb.collection('calendarFeeds').doc('other-hash').set({ householdId: OTHER });
    await deleteHousehold(owner, HOUSE, 'Feed House', new Date(), { deleteFiles: async () => undefined });
    assert.equal((await adminDb.collection('calendarFeeds').where('householdId', '==', HOUSE).get()).size, 0);
    assert.equal((await house().collection('calendar-feed').doc('current').get()).exists, false);
    assert.equal((await adminDb.collection('calendarFeeds').doc('other-hash').get()).exists, true, 'another household keeps its feed');
    assert.equal((await fetchFeed(token)).status, 404);
  });

  test('malformed tokens, a stale lookup and a household being deleted all get 404', async () => {
    assert.equal((await fetchFeed('short')).status, 404);
    assert.equal((await fetchFeed('../../etc')).status, 404);
    const { token } = await rotateCalendarFeed(adminDb, owner, HOUSE);
    // A lookup the household's current feed does not name opens nothing.
    const forged = 'A'.repeat(43);
    await adminDb.collection('calendarFeeds').doc(hashFeedToken(forged)).set({ householdId: HOUSE });
    assert.equal((await fetchFeed(forged)).status, 404);
    await house().update({ deletingAt: new Date() });
    assert.equal((await fetchFeed(token)).status, 404);
    assert.equal(await refusal(rotateCalendarFeed(adminDb, owner, HOUSE)), 'household_deleting');
  });
});
