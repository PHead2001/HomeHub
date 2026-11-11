import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { MemberContactsUnavailable, readMemberContacts, runHouseholdReminders } from '../../functions/src/reminders';
import { contactEmailOf } from '../../functions/src/shared/member-contact';
import { parseNotificationDoc } from '../../src/lib/notifications';
import { activeBellNotifications } from '../../src/lib/dashboard/notification-display';
import { choreStatsAssigneeKey, choreStatsMemberKey, deterministicNotificationId, recurringChoreId } from '../../functions/src/shared/ids';
import { readHouseholdPeople, scrubChoreCollection, settleHouseholdFormerPeople } from '../../scripts/ops/member-privacy-household.mjs';

// The hourly Cloud Function's per-household step, against the Firestore emulator.
const HOUSE = 'upkeep-house';
const ts = (d: Date) => Timestamp.fromDate(d) as never;
const run = (now: Date) => runHouseholdReminders(adminDb as never, HOUSE, now, ts);
const house = () => adminDb.collection('households').doc(HOUSE);

// The real database, except that listing one of this household's subcollections
// returns a stale result: the view of a run that read before someone else committed.
const bind = <T extends object>(target: T, override: (key: PropertyKey) => unknown) =>
  new Proxy(target, {
    get(obj, key) {
      const replaced = override(key);
      if (replaced !== undefined) return replaced;
      const value = Reflect.get(obj, key, obj);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
const staleListingDb = (staleSub: string, listing: unknown) => bind(adminDb, key => key === 'collection'
  ? (name: string) => bind(adminDb.collection(name), k => k === 'doc'
    ? (id: string) => bind(adminDb.collection(name).doc(id), d => d === 'collection'
      ? (sub: string) => sub === staleSub
        ? bind(adminDb.collection(name).doc(id).collection(sub), c => c === 'get' ? async () => listing : undefined)
        : adminDb.collection(name).doc(id).collection(sub)
      : undefined)
    : undefined)
  : undefined);
const staleChoresDb = () => staleListingDb('chores', { docs: [] });
// The real database, except that the household reference's Firestore fails getAll,
// the call only the members' contact read makes.
const failingContactsDb = bind(adminDb, key => key === 'collection'
  ? (name: string) => bind(adminDb.collection(name), k => k === 'doc'
    ? (id: string) => bind(adminDb.collection(name).doc(id), d => d === 'firestore'
      ? bind(adminDb, f => f === 'getAll' ? async () => { throw new Error('unavailable'); } : undefined)
      : undefined)
    : undefined)
  : undefined);

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Upkeep', ownerUid: 'o1', timeZone: 'America/Chicago', memberEmails: [] });
  // As the server writes members: no email on the record, the email in the contact document.
  await house().collection('members').doc('o1').set({ uid: 'o1', role: 'owner', status: 'active', displayName: 'Owner' });
  await house().collection('members').doc('o1').collection('private').doc('contact').set({ email: 'owner@example.test', updatedAt: 'x' });
  await house().collection('members').doc('p1').set({ uid: 'p1', role: 'newuser', status: 'pending' });
  await house().collection('members').doc('p1').collection('private').doc('contact').set({ email: 'pending@example.test', updatedAt: 'x' });
  await adminDb.collection('users').doc('owner@example.test').set({ email: 'owner@example.test', choreSettings: { reminderEnabled: true, reminderTime: '17:00' } });
  await house().collection('chore-templates').doc('trash').set({
    task: 'Trash', assignedToEmail: 'owner@example.test', roomIds: [],
    recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [4] }, assignedToEmail: 'owner@example.test' },
  });
  await house().collection('chore-templates').doc('ghost').set({
    task: 'Ghost', assignedToEmail: 'pending@example.test',
    recurrence: { frequency: 'daily', assignedToEmail: 'pending@example.test' },
  });
  await house().collection('home-assets').doc('hvac').set({ name: 'Main HVAC', schedules: [{ id: 's1', scheduleName: 'Replace filter', nextDueDate: '2026-10-01' }] });
});

after(async () => {
  await adminDb.recursiveDelete(house());
  await adminDb.collection('users').doc('owner@example.test').delete();
});

describe('household upkeep', () => {
  test('generates recurring chores for approved members only, idempotently', async () => {
    const now = new Date('2026-11-05T15:00:00Z'); // Thursday 9am Chicago
    const first = await run(now);
    assert.equal(first.generatedChores, 30);
    const chores = await house().collection('chores').get();
    assert.equal(chores.size, 30);
    assert.ok(chores.docs.every(d => d.data().task === 'Trash'), 'nothing generated for a pending member');
    const firstDue = chores.docs.map(d => d.data().originalDueDate).sort()[0];
    assert.equal(firstDue, '2026-11-05');
    assert.equal(chores.docs.find(d => d.data().originalDueDate === '2026-11-05')?.data().dueDate, '2026-11-05T06:00:00.000Z');

    const second = await run(now);
    assert.equal(second.generatedChores, 0);
    assert.equal((await house().collection('chores').get()).size, 30);
  });

  test('generated chores carry the assignee uid only, under the ids they always had', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const chore = (await house().collection('chores').doc(recurringChoreId('trash', 'general', '2026-11-05', 'owner@example.test')).get()).data();
    assert.equal(chore?.assignedToUid, 'o1');
    assert.equal(chore?.assignedToEmail, undefined, 'member privacy release C: no email on generated chores');
    assert.equal(chore?.assignedToDisplayName, 'Owner');
  });

  test('a template whose email is scrubbed (release C) generates by uid without a second copy of any day', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    assert.equal((await run(now)).generatedChores, 30);
    // scripts/ops/scrub-shared-emails.mjs: the uid is set and both email copies removed.
    await house().collection('chore-templates').doc('trash').update({
      assignedToUid: 'o1', assignedToEmail: FieldValue.delete(), 'recurrence.assignedToEmail': FieldValue.delete(),
    });
    // A week later: the 29 open days generated under the email-keyed ids are still there.
    const later = new Date('2026-11-12T15:00:00Z');
    const result = await run(later);
    assert.equal(result.generatedChores, 1, 'only the one new day at the end of the window');
    const chores = (await house().collection('chores').get()).docs.map(d => d.data());
    const days = chores.map(c => c.originalDueDate);
    assert.equal(new Set(days).size, days.length, 'no day twice');
    const fresh = await house().collection('chores').doc(recurringChoreId('trash', 'general', '2027-06-03', 'o1')).get();
    assert.equal(fresh.exists, true, 'new days are keyed by uid');
    assert.equal(fresh.data()?.assignedToEmail, undefined);
  });

  test('a template assigned by uid only (email no longer known to its writer) still generates', async () => {
    await house().collection('chore-templates').doc('trash').delete();
    await house().collection('chore-templates').doc('mop').set({
      task: 'Mop', assignedToUid: 'o1', assignedToEmail: '', roomIds: ['kitchen'],
      recurrence: { frequency: 'daily', assignedToEmail: '' },
    });
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const chore = (await house().collection('chores').doc(recurringChoreId('mop', 'kitchen', '2026-11-05', 'o1')).get()).data();
    assert.equal(chore?.assignedToUid, 'o1');
    assert.equal(chore?.assignedToEmail, undefined);
    // A uid that is not an approved member gets nothing.
    await house().collection('chore-templates').doc('mop').update({ assignedToUid: 'p1' });
    await adminDb.recursiveDelete(house().collection('chores'));
    await run(now);
    assert.equal((await house().collection('chores').where('task', '==', 'Mop').get()).size, 0);
  });

  test('maintenance reminders are created once and refreshed while still overdue', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const notes = await house().collection('notifications').where('category', '==', 'maintenance').get();
    assert.equal(notes.size, 1);
    assert.equal(notes.docs[0].data().message, 'Replace filter for Main HVAC is overdue.');
    assert.deepEqual(notes.docs[0].data().audience, ['*'], 'household-wide');
    assert.equal((await run(now)).createdNotifications, 0);

    const eightDaysLater = new Date(now.getTime() + 8 * 86400000);
    const later = await run(eightDaysLater);
    assert.equal(later.refreshedNotifications, 1, 'an expired but still-overdue reminder stays visible');
    const refreshed = await house().collection('notifications').where('category', '==', 'maintenance').get();
    assert.equal(refreshed.size, 1);
    // Clients list the last 7 days by createdAt, so the refresh must move it.
    assert.equal(refreshed.docs[0].data().createdAt.toDate().toISOString(), eightDaysLater.toISOString());
    assert.deepEqual(refreshed.docs[0].data().audience, ['*'], 'a refresh keeps the audience');
  });

  test('refreshing or reopening a reminder written before audience existed adds it', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const ref = (await house().collection('notifications').where('category', '==', 'maintenance').get()).docs[0].ref;
    const legacy = { ...(await ref.get()).data()! };
    delete legacy.audience;
    await ref.set(legacy);
    assert.equal((await ref.get()).data()!.audience, undefined);
    assert.equal((await run(new Date(now.getTime() + 5.5 * 86400000))).refreshedNotifications, 1);
    assert.deepEqual((await ref.get()).data()!.audience, ['*'], 'added on refresh');

    await ref.set({ ...legacy, resolvedAt: new Date('2026-11-05T15:30:00Z'), resolvedBy: { uid: 'o1' } });
    assert.equal((await run(new Date('2026-11-05T16:00:00Z'))).reopenedNotifications, 1);
    assert.deepEqual((await ref.get()).data()!.audience, ['*'], 'added on reopen');
  });

  test('chore reminders are addressed to their member', async () => {
    await run(new Date('2026-11-05T23:30:00Z')); // 5:30pm Chicago, after the 5pm reminder
    const reminders = await house().collection('notifications').where('sourceType', '==', 'chore-reminder').get();
    assert.ok(reminders.size > 0);
    for (const reminder of reminders.docs) {
      assert.equal(reminder.data().targetUserUid, 'o1');
      assert.deepEqual(reminder.data().audience, ['o1']);
    }
  });

  test('a maintenance reminder resolved while its schedule is still actionable is reopened', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const ref = (await house().collection('notifications').where('category', '==', 'maintenance').get()).docs[0].ref;
    // The app resolved it, but the schedule never advanced (for example the write failed).
    await ref.update({ resolvedAt: new Date('2026-11-05T15:30:00Z'), resolvedBy: { uid: 'o1' } });
    const later = await run(new Date('2026-11-05T16:00:00Z'));
    assert.equal(later.reopenedNotifications, 1);
    assert.equal(later.createdNotifications, 0);
    assert.equal((await ref.get()).data()!.resolvedAt, null);
  });

  test('a still-overdue reminder is refreshed before TTL could delete it, keeping its state', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const ref = (await house().collection('notifications').where('category', '==', 'maintenance').get()).docs[0].ref;
    await ref.update({ 'dismissedBy.o1': true, 'readBy.o1': true });
    // Five days in: not expired yet (expiry is day 7) but within the 2-day margin.
    assert.equal((await run(new Date(now.getTime() + 4 * 86400000))).refreshedNotifications, 0, 'not refreshed early');
    const fiveDays = new Date(now.getTime() + 5.5 * 86400000);
    assert.equal((await run(fiveDays)).refreshedNotifications, 1, 'refreshed before expiry');
    const data = (await ref.get()).data()!;
    assert.ok(data.expiresAt.toDate() > new Date(fiveDays.getTime() + 6 * 86400000), 'expiry pushed out');
    assert.equal(data.dismissedBy.o1, true, 'dismissal kept');
    assert.equal(data.readBy.o1, true, 'read state kept');
  });

  test('the reminder email comes from the contact document; a legacy record email is ignored', async () => {
    await house().collection('members').doc('o1').update({ email: 'stale@example.test' });
    await run(new Date('2026-11-05T23:30:00Z'));
    const reminders = await house().collection('notifications').where('sourceType', '==', 'chore-reminder').get();
    assert.deepEqual(reminders.docs.map(d => d.id), ['o1-reminder-2026-11-05']);
  });

  test('without a contact document there is no email, even if the record still has one', async () => {
    await house().collection('members').doc('o1').update({ email: 'owner@example.test' });
    await house().collection('members').doc('o1').collection('private').doc('contact').delete();
    await run(new Date('2026-11-05T23:30:00Z'));
    const reminders = await house().collection('notifications').where('sourceType', '==', 'chore-reminder').get();
    assert.equal(reminders.size, 0);
  });

  test('chore reminders respect the member’s reminder time and never duplicate', async () => {
    await run(new Date('2026-11-05T15:00:00Z')); // 9am: before the 5pm reminder
    const morning = await house().collection('notifications').where('sourceType', '==', 'chore-reminder').get();
    assert.equal(morning.size, 0);
    await run(new Date('2026-11-05T23:30:00Z')); // 5:30pm
    await run(new Date('2026-11-05T23:45:00Z'));
    const evening = await house().collection('notifications').where('sourceType', '==', 'chore-reminder').get();
    assert.deepEqual(evening.docs.map(d => d.id), ['o1-reminder-2026-11-05']);
    assert.equal(evening.docs[0].data().targetUserUid, 'o1');
  });

  test('a run after the reminder time includes the chores it just generated', async () => {
    // First run ever, at 5:30pm Thursday: the Thursday trash chore does not exist yet.
    await run(new Date('2026-11-05T23:30:00Z'));
    const reminder = await house().collection('notifications').doc('o1-reminder-2026-11-05').get();
    assert.equal(reminder.exists, true, 'reminder sent in the same run that generated the chore');
    assert.equal(reminder.data()?.message, '1 chore due today.');
  });

  test('a run with a stale view never resets a chore completed in the meantime', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    await run(now);
    const thursday = (await house().collection('chores').where('originalDueDate', '==', '2026-11-05').get()).docs[0];
    await thursday.ref.update({ isCompleted: true, completedAt: '2026-11-05T15:05:00.000Z' });
    // A second, overlapping run that read the chores before the first one committed.
    const result = await runHouseholdReminders(staleChoresDb() as never, HOUSE, now, ts);
    assert.equal(result.generatedChores, 0, 'nothing re-created');
    const after = (await thursday.ref.get()).data();
    assert.equal(after?.isCompleted, true);
    assert.equal(after?.completedAt, '2026-11-05T15:05:00.000Z');
  });

  test('a run with a stale template never recreates a cancelled or edited recurrence', async () => {
    const now = new Date('2026-11-05T15:00:00Z');
    const trash = () => house().collection('chores').where('templateId', '==', 'trash').get();
    // Cancelled after the run read the templates.
    let stale = await house().collection('chore-templates').get();
    await house().collection('chore-templates').doc('trash').delete();
    let result = await runHouseholdReminders(staleListingDb('chore-templates', stale) as never, HOUSE, now, ts);
    assert.equal(result.generatedChores, 0);
    assert.equal((await trash()).size, 0, 'a cancelled recurrence is not repopulated');
    // Edited (reassigned) after the run read the templates.
    await house().collection('chore-templates').doc('trash').set({
      task: 'Trash', assignedToEmail: 'owner@example.test', roomIds: [],
      recurrence: { frequency: 'weekly', weeklyOptions: { daysOfWeek: [4] }, assignedToEmail: 'owner@example.test' },
    });
    stale = await house().collection('chore-templates').get();
    await house().collection('chore-templates').doc('trash').update({ task: 'Trash and recycling' });
    result = await runHouseholdReminders(staleListingDb('chore-templates', stale) as never, HOUSE, now, ts);
    assert.equal((await trash()).size, 0, 'nothing generated from the pre-edit template');
    // The next run sees the current template and generates from it.
    await run(now);
    const fresh = await trash();
    assert.equal(fresh.size, 30);
    assert.ok(fresh.docs.every(d => d.data().task === 'Trash and recycling'));
  });

  test('a household being deleted gets no upkeep writes', async () => {
    await house().update({ deletingAt: new Date() });
    const result = await run(new Date('2026-11-05T23:30:00Z'));
    assert.equal(result.generatedChores, 0);
    assert.equal((await house().collection('chores').get()).size, 0);
    assert.equal((await house().collection('notifications').get()).size, 0);
  });

  test('completed chores older than 90 days are removed; recent ones are kept', async () => {
    await house().collection('chores').doc('old').set({ task: 'Old', isCompleted: true, completedAt: '2026-07-01T12:00:00.000Z' });
    await house().collection('chores').doc('recent').set({ task: 'Recent', isCompleted: true, completedAt: '2026-10-30T12:00:00.000Z' });
    const result = await run(new Date('2026-11-05T15:00:00Z'));
    assert.equal(result.purgedChores, 1);
    assert.equal((await house().collection('chores').doc('old').get()).exists, false);
    assert.equal((await house().collection('chores').doc('recent').get()).exists, true);
  });

  test('a failed contact read defers purging chores credited by email; the next run credits them once', async () => {
    const chores = house().collection('chores');
    // Credited only through the owner's email (no uid, no recorded completer).
    await chores.doc('old-email').set({ task: 'Old', isCompleted: true, completedAt: '2026-07-01T12:00:00.000Z', assignedToEmail: 'owner@example.test' });
    // Credited by uid: purged even without emails.
    await chores.doc('old-uid').set({ task: 'Old uid', isCompleted: true, completedAt: '2026-07-02T12:00:00.000Z', assignedToUid: 'o1', completedByUid: 'o1', completedByName: 'Owner' });
    const owner = choreStatsMemberKey('o1');

    const failed = await runHouseholdReminders(failingContactsDb as never, HOUSE, new Date('2026-11-05T15:00:00Z'), ts);
    assert.equal(failed.purgedChores, 1);
    assert.equal((await chores.doc('old-email').get()).exists, true, 'left for a run that has the emails');
    let stats = (await house().collection('stats').doc('chores-2026').get()).data();
    assert.equal(stats?.completed, 1);
    assert.deepEqual(stats?.byAssignee, { [owner]: 1 });

    const next = await run(new Date('2026-11-05T16:00:00Z'));
    assert.equal(next.purgedChores, 1);
    assert.equal((await chores.doc('old-email').get()).exists, false);
    stats = (await house().collection('stats').doc('chores-2026').get()).data();
    assert.equal(stats?.completed, 2);
    assert.deepEqual(stats?.byAssignee, { [owner]: 2 });
    assert.equal((await run(new Date('2026-11-05T17:00:00Z'))).purgedChores, 0);
    assert.equal((await house().collection('stats').doc('chores-2026').get()).data()?.completed, 2);
  });

  test('the push trigger\'s contact read retries a failed read, and fails rather than report no recipients', async () => {
    // The household reference's Firestore fails getAll (the contact read) the next `failures` times.
    let failures = 1;
    const flakyHouse = bind(house(), d => d === 'firestore'
      ? bind(adminDb, f => f === 'getAll'
        ? async (...refs: Parameters<typeof adminDb.getAll>) => {
          if (failures > 0) { failures -= 1; throw new Error('unavailable'); }
          return adminDb.getAll(...refs);
        }
        : undefined)
      : undefined);
    const waits: number[] = [];
    const wait = async (ms: number) => { waits.push(ms); };
    const contacts = await readMemberContacts(flakyHouse as never, ['o1'], [5, 10], wait);
    assert.equal(contactEmailOf(contacts.get('o1')), 'owner@example.test', 'the second read succeeds: recipients found once');
    assert.deepEqual(waits, [5]);

    failures = 99;
    waits.length = 0;
    await assert.rejects(readMemberContacts(flakyHouse as never, ['o1'], [5, 10], wait),
      (error: unknown) => error instanceof MemberContactsUnavailable && error.attempts === 3);
    assert.deepEqual(waits, [5, 10], 'three reads in all, then it fails');
    assert.equal(failures, 96);
  });

  test('a failed contact read defers templates that still carry an email; uid-only ones still generate', async () => {
    // Bob and Anna are members. A legacy template was reassigned by email only to Anna by an
    // older build, so its uid is Bob's, stale; another template is assigned by uid only.
    for (const [uid, name] of [['b1', 'Bob'], ['a1', 'Anna']]) {
      await house().collection('members').doc(uid).set({ uid, role: 'member', status: 'active', displayName: name });
      await house().collection('members').doc(uid).collection('private').doc('contact').set({ email: `${name.toLowerCase()}@example.test`, updatedAt: 'x' });
    }
    await house().collection('chore-templates').doc('legacy').set({
      task: 'Dishes', assignedToUid: 'b1', assignedToEmail: 'anna@example.test', roomIds: [],
      recurrence: { frequency: 'daily', assignedToEmail: 'anna@example.test' },
    });
    await house().collection('chore-templates').doc('modern').set({ task: 'Sweep', assignedToUid: 'b1', roomIds: [], recurrence: { frequency: 'daily' } });
    const byTemplate = async (templateId: string) => (await house().collection('chores').where('templateId', '==', templateId).get()).docs.map(d => d.data());

    const failed = await runHouseholdReminders(failingContactsDb as never, HOUSE, new Date('2026-11-05T15:00:00Z'), ts);
    assert.equal((await byTemplate('legacy')).length, 0, 'nothing generated from a template whose email cannot be checked');
    assert.equal((await byTemplate('trash')).length, 0, 'the owner\'s email-keyed template waits too');
    const sweep = await byTemplate('modern');
    assert.ok(sweep.length > 0 && sweep.every(c => c.assignedToUid === 'b1'), 'a uid-only template generates as usual');
    assert.equal(failed.generatedChores, sweep.length);

    await run(new Date('2026-11-05T16:00:00Z'));
    const dishes = await byTemplate('legacy');
    assert.equal(dishes.length, sweep.length, 'every day generated once the emails are known');
    assert.ok(dishes.every(c => c.assignedToUid === 'a1' && c.assignedToDisplayName === 'Anna'), 'for the member the email names, never the stale uid');
    assert.ok(dishes.every(c => c.assignedToEmail === undefined));
    assert.ok((await byTemplate('trash')).every(c => c.assignedToUid === 'o1'));
  });

  test('a completion credited to someone who left waits for the scrub, then keeps its own score', async () => {
    const chores = house().collection('chores');
    // Lee has left: one chore names them only as assignee by email, another only as completer by email.
    await chores.doc('lee-assigned').set({ task: 'Old', isCompleted: true, completedAt: '2026-07-01T12:00:00.000Z', assignedToEmail: 'lee@example.test', assignedToDisplayName: 'Lee' });
    await chores.doc('lee-completed').set({ task: 'Older', isCompleted: true, completedAt: '2026-07-02T12:00:00.000Z', assignedToUid: 'o1', completedByEmail: 'LEE@example.test', completedByName: 'Lee' });
    const first = await run(new Date('2026-11-05T15:00:00Z'));
    assert.equal(first.purgedChores, 0, 'the email names nobody: purging now would drop the credit');
    assert.equal((await chores.get()).docs.filter(d => d.id.startsWith('lee-')).length, 2);

    // scripts/ops/scrub-member-emails.mjs's chore step: Lee's identity settled and stored, then the chores scrubbed.
    const people = await readHouseholdPeople(adminDb as never, house());
    const former = await settleHouseholdFormerPeople(adminDb as never, house(), people, { apply: true });
    const counts = { scanned: 0, clean: 0, kept: 0, scrub: 0, assignee: 0, completer: 0, former: 0, written: 0, changed: 0 };
    await scrubChoreCollection(adminDb as never, chores, { apply: true, uidByEmail: people.uidByEmail, formerKeyOf: former.identityOf, counts });
    assert.equal(counts.former, 2);
    const lee = former.identityOf('lee@example.test');
    assert.match(lee, /^former-[0-9a-f]{24}$/, 'no uid pairs with the email: an opaque key');
    assert.equal((await chores.doc('lee-assigned').get()).data()?.assignedToUid, lee);
    assert.equal((await chores.doc('lee-completed').get()).data()?.completedByUid, lee);

    const next = await run(new Date('2026-11-05T16:00:00Z'));
    assert.equal(next.purgedChores, 2);
    const stats = (await house().collection('stats').doc('chores-2026').get()).data();
    assert.equal(stats?.completed, 2);
    assert.deepEqual(stats?.byAssignee, { [choreStatsMemberKey(lee)]: 2 }, 'one score for Lee, not the owner');
    assert.deepEqual(stats?.names, { [choreStatsMemberKey(lee)]: 'Lee' });
    assert.ok(!JSON.stringify(stats).includes('example'));
  });

  test("a purged chore is added to its year's stats exactly once, even when upkeep runs twice", async () => {
    const chores = house().collection('chores');
    // Sam has left: chores recorded by uid still count for that uid.
    await chores.doc('old-sam').set({ task: 'Old', isCompleted: true, completedAt: '2026-07-01T12:00:00.000Z', assignedToUid: 's1', assignedToDisplayName: 'Sam Member' });
    await chores.doc('old-sam-2').set({ task: 'Older', isCompleted: true, completedAt: '2026-06-01T12:00:00.000Z', assignedToUid: 's1', completedByUid: 's1', completedByName: 'Sam Member' });
    // Stats written before they were keyed by uid: the owner's legacy key is folded in.
    await house().collection('stats').doc('chores-2026').set({
      year: 2026, completed: 5, byAssignee: { [choreStatsAssigneeKey('Owner@example.test')]: 5 }, names: { [choreStatsAssigneeKey('owner@example.test')]: 'Owner' },
    });
    // Completed just after New Year in UTC, but still Dec 31 in the household's timezone (Chicago).
    await chores.doc('new-year').set({ task: 'Party', isCompleted: true, completedAt: '2026-01-01T03:00:00.000Z', assignedToEmail: 'owner@example.test' });
    await chores.doc('recent').set({ task: 'Recent', isCompleted: true, completedAt: '2026-10-30T12:00:00.000Z', assignedToEmail: 'owner@example.test' });
    // The server stamp is authoritative: completedAt says Dec 31 2025 (Chicago),
    // completedAtServer says Jan 1 2026 (Chicago), so it belongs to 2026.
    await chores.doc('stamped').set({
      task: 'Stamped', isCompleted: true, assignedToEmail: 'owner@example.test',
      completedAt: '2026-01-01T05:30:00.000Z', completedAtServer: Timestamp.fromDate(new Date('2026-01-01T07:00:00.000Z')),
    });
    // Keyed by uid; the owner's email-only chore is matched through their contact document.
    const key = choreStatsMemberKey('s1');
    const owner = choreStatsMemberKey('o1');

    const first = await run(new Date('2026-11-05T15:00:00Z'));
    assert.equal(first.purgedChores, 4);
    const stats2026 = (await house().collection('stats').doc('chores-2026').get()).data();
    assert.equal(stats2026?.year, 2026);
    assert.equal(stats2026?.completed, 8);
    assert.deepEqual(stats2026?.byAssignee, { [key]: 2, [owner]: 6 });
    assert.deepEqual(stats2026?.names, { [key]: 'Sam Member', [owner]: 'Owner' });
    assert.ok(!JSON.stringify(stats2026).includes('example'), 'nothing derived from an email is left');
    const stats2025 = (await house().collection('stats').doc('chores-2025').get()).data();
    assert.equal(stats2025?.completed, 1);

    // Nothing left to purge: a second run counts nothing again.
    const second = await run(new Date('2026-11-05T16:00:00Z'));
    assert.equal(second.purgedChores, 0);
    assert.equal((await house().collection('stats').doc('chores-2026').get()).data()?.completed, 8);
    assert.equal((await house().collection('chores').doc('recent').get()).exists, true);
  });

  describe('pet medication reminders', () => {
    // Household time zone is America/Chicago (UTC-5 in November 2026).
    const meds = () => house().collection('notifications').where('sourceType', '==', 'pet_medication').get();
    const logs = () => house().collection('pets').doc('maple').collection('medication-logs');
    beforeEach(async () => {
      await house().collection('pets').doc('maple').set({ name: 'Maple', type: 'Dog', photoUrl: 'https://placehold.co/300x300.png' });
      await logs().doc('d1').set({ date: '2026-10-07T14:00:00.000Z', medication: 'Flea prevention', dosage: '1 chew', notes: '', nextDueDate: '2026-11-06' });
    });

    test('nothing the day before; one reminder on the due day, idempotently', async () => {
      // 11:30pm Nov 5 in Chicago (05:30 UTC Nov 6): still the day before.
      await run(new Date('2026-11-06T05:30:00Z'));
      assert.equal((await meds()).size, 0);

      // 12:30am Nov 6 in Chicago.
      const dueDay = new Date('2026-11-06T06:30:00Z');
      const first = await run(dueDay);
      const notes = await meds();
      assert.equal(notes.size, 1);
      const note = notes.docs[0].data();
      assert.equal(note.category, 'pets');
      assert.equal(note.title, "Maple's Flea prevention is due today");
      assert.equal(note.sourceId, 'maple:flea prevention');
      assert.equal(note.stateKey, 'due|2026-11-06');
      assert.equal(note.deepLink, '/pets/maple?tab=medication');
      assert.equal(note.targetUserUid, undefined, 'household-wide, like maintenance');
      assert.equal(notes.docs[0].id, deterministicNotificationId('pet_medication', 'maple:flea prevention', 'due|2026-11-06'));
      assert.ok(first.createdNotifications >= 1);

      await run(new Date('2026-11-06T18:00:00Z'));
      assert.equal((await meds()).size, 1, 'a re-run creates nothing new');
    });

    test('an overdue countdown gets its own overdue reminder once', async () => {
      await run(new Date('2026-11-08T15:00:00Z'));
      await run(new Date('2026-11-08T16:00:00Z'));
      const notes = await meds();
      assert.equal(notes.size, 1);
      assert.equal(notes.docs[0].data().title, "Maple's Flea prevention is overdue");
      assert.equal(notes.docs[0].data().stateKey, 'overdue|2026-11-06');
    });

    test('a newer dose resolves the reminder, with or without a next due date', async () => {
      await run(new Date('2026-11-06T15:00:00Z'));
      await logs().doc('d2').set({ date: '2026-11-06T16:00:00.000Z', medication: ' flea PREVENTION ', dosage: '1 chew', notes: '' });
      const after = await run(new Date('2026-11-06T17:00:00Z'));
      assert.equal(after.resolvedNotifications, 1);
      const notes = await meds();
      assert.equal(notes.size, 1);
      assert.ok(notes.docs[0].data().resolvedAt, 'resolved');
      // Already resolved: nothing more to do, and no countdown means no new reminder.
      const again = await run(new Date('2026-11-07T17:00:00Z'));
      assert.equal(again.resolvedNotifications, 0);
      assert.equal((await meds()).size, 1);
    });

    test('deleting the dose that resolved a reminder reopens it, without a new document', async () => {
      await run(new Date('2026-11-08T15:00:00Z'));
      const [note] = (await meds()).docs;
      assert.equal(note.data().stateKey, 'overdue|2026-11-06');
      // A dose logged by mistake resolves the overdue reminder...
      await logs().doc('oops').set({ date: '2026-11-08T15:30:00.000Z', medication: 'Flea prevention', dosage: '1 chew', notes: '', nextDueDate: '2026-12-08' });
      assert.equal((await run(new Date('2026-11-08T16:00:00Z'))).resolvedNotifications, 1);
      assert.ok((await note.ref.get()).data()!.resolvedAt);
      await note.ref.update({ 'dismissedBy.o1': true });
      // ...and deleting it makes the countdown pending again: the same reminder comes back.
      await logs().doc('oops').delete();
      const later = new Date('2026-11-09T15:00:00Z');
      const reopened = await run(later);
      assert.equal(reopened.reopenedNotifications, 1);
      assert.equal(reopened.createdNotifications, 0, 'same identity, no new document (and no new push)');
      const notes = await meds();
      assert.equal(notes.size, 1);
      const data = notes.docs[0].data();
      assert.equal(data.resolvedAt, null);
      assert.equal(data.resolvedBy, null);
      assert.equal(data.title, "Maple's Flea prevention is overdue");
      assert.equal(data.createdAt.toDate().toISOString(), later.toISOString(), 'listed again in the 7-day window');
      assert.ok(data.expiresAt.toDate() > new Date(later.getTime() + 6 * 86400000), 'expiry pushed out');
      assert.equal(data.dismissedBy.o1, true, 'a member who dismissed it keeps that choice');
      // Visible again in the app's bell list.
      const parsed = parseNotificationDoc(notes.docs[0] as never);
      assert.equal(activeBellNotifications([parsed], { uid: 'm2', email: 'm2@example.test' }, later).length, 1);
      // Stable afterwards.
      const again = await run(new Date('2026-11-09T16:00:00Z'));
      assert.equal(again.reopenedNotifications, 0);
      assert.equal(again.resolvedNotifications, 0);
    });

    test('a run with stale medication entries never resolves a still-pending reminder', async () => {
      await run(new Date('2026-11-08T15:00:00Z'));
      const [note] = (await meds()).docs;
      assert.ok(!note.data().resolvedAt);
      // This run read the pet's entries while a mistaken dose existed (since
      // deleted, and another run may have reopened the reminder meanwhile).
      const staleLogs = [
        { date: '2026-10-07T14:00:00.000Z', medication: 'Flea prevention', nextDueDate: '2026-11-06' },
        { date: '2026-11-08T15:30:00.000Z', medication: 'Flea prevention', nextDueDate: '2026-12-08' },
      ];
      const stalePets = { docs: [{
        id: 'maple',
        get: (field: string) => (field === 'name' ? 'Maple' : undefined),
        ref: { collection: () => ({ get: async () => ({ docs: staleLogs.map(data => ({ data: () => data })) }) }) },
      }] };
      const stale = await runHouseholdReminders(staleListingDb('pets', stalePets) as never, HOUSE, new Date('2026-11-08T16:00:00Z'), ts);
      assert.equal(stale.resolvedNotifications, 0, 'revalidated against the real entries in the transaction');
      assert.ok(!(await note.ref.get()).data()!.resolvedAt, 'still open');
    });

    test('a resolved countdown leaves the next one free to remind', async () => {
      await run(new Date('2026-11-06T15:00:00Z'));
      await logs().doc('d2').set({ date: '2026-11-06T16:00:00.000Z', medication: 'Flea prevention', dosage: '1 chew', notes: '', nextDueDate: '2026-12-06' });
      await run(new Date('2026-11-06T17:00:00Z'));
      assert.equal((await meds()).docs.filter(d => !d.data().resolvedAt).length, 0);
      await run(new Date('2026-12-06T15:00:00Z'));
      const open = (await meds()).docs.filter(d => !d.data().resolvedAt);
      assert.equal(open.length, 1);
      assert.equal(open[0].data().stateKey, 'due|2026-12-06');
    });
  });
});
