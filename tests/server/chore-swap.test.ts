import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { answerSwapAs, offerSwapAs } from '../../src/lib/server/chore-swap';
import { MAX_PENDING_SWAPS } from '../../src/lib/chores/swap';

// Chore swaps (CH-31) through the Admin SDK, against the Firestore emulator.
const HOUSE = 'server-chore-swap-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const chores = () => house().collection('chores');
const NOW = new Date('2026-11-27T18:00:00Z');
const LATER = new Date('2026-12-01T18:00:00Z');

const sam = { uid: 'swap-sam' };
const ada = { uid: 'swap-ada' };
const max = { uid: 'swap-max' };
const KID = 'kid_abcdefghijklmnopqrst';

const seedChore = (id: string, assignedToUid: string, extra: Record<string, unknown> = {}) => chores().doc(id).set({
  task: id, assignedToUid, assignedToDisplayName: assignedToUid, dueDate: '2026-11-28T06:00:00.000Z', originalDueDate: '2026-11-28',
  isCompleted: false, roomIds: [], subTasks: [], completedSubTasks: [], ...extra,
});
const read = async (id: string) => (await chores().doc(id).get()).data()!;
const notificationsFor = async (uid: string) => (await house().collection('notifications').where('targetUserUid', '==', uid).get()).docs.map(doc => doc.data());

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Swap', ownerUid: sam.uid, timeZone: 'America/Chicago', memberEmails: [] });
  for (const [uid, role, displayName, extra] of [[sam.uid, 'member', 'Sam', {}], [ada.uid, 'child', 'Ada', {}], [max.uid, 'member', 'Max', {}], [KID, 'child', 'Kiddo', { kind: 'identity' }]] as const) {
    await house().collection('members').doc(uid).set({ uid, role, status: 'active', displayName, ...extra });
  }
  await seedChore('dishes', sam.uid);
  await seedChore('bins', ada.uid);
  await seedChore('kid-chore', KID);
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('chore swaps (CH-31)', () => {
  test('an offer notifies the other person; accepting swaps the two assignees and tells the offerer', async () => {
    const offer = await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW);
    assert.equal(offer.status, 'offered');
    const offerId = offer.status === 'offered' ? offer.offerId : '';
    const [note] = await notificationsFor(ada.uid);
    assert.equal(note.deepLink, `/chores?swap=${offerId}`);
    assert.match(note.message, /Sam offers to do bins if you do dishes/);
    assert.deepEqual(note.audience, [ada.uid]);
    // Only the person asked may answer.
    assert.deepEqual(await answerSwapAs(adminDb, HOUSE, max, { offerId, answer: 'accept' }, NOW), { status: 'refused', refused: 'not-for-you' });
    assert.deepEqual(await answerSwapAs(adminDb, HOUSE, ada, { offerId, answer: 'accept' }, NOW), { status: 'accepted' });
    assert.equal((await read('dishes')).assignedToUid, ada.uid);
    assert.equal((await read('dishes')).assignedToDisplayName, 'Ada');
    assert.equal((await read('bins')).assignedToUid, sam.uid);
    assert.equal((await notificationsFor(sam.uid)).length, 1);
    assert.deepEqual(await answerSwapAs(adminDb, HOUSE, ada, { offerId, answer: 'accept' }, NOW), { status: 'refused', refused: 'answered' });
  });

  test('nothing is swapped when a chore changed, was done, or the offer expired', async () => {
    const first = await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW);
    const firstId = first.status === 'offered' ? first.offerId : '';
    await chores().doc('bins').update({ assignedToUid: max.uid });
    assert.deepEqual(await answerSwapAs(adminDb, HOUSE, ada, { offerId: firstId, answer: 'accept' }, NOW), { status: 'refused', refused: 'changed' });
    assert.equal((await read('dishes')).assignedToUid, sam.uid);

    await chores().doc('bins').update({ assignedToUid: ada.uid });
    const second = await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW);
    const secondId = second.status === 'offered' ? second.offerId : '';
    assert.deepEqual(await answerSwapAs(adminDb, HOUSE, ada, { offerId: secondId, answer: 'accept' }, LATER), { status: 'refused', refused: 'expired' });

    await chores().doc('dishes').update({ isCompleted: true });
    assert.deepEqual(await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW), { status: 'refused', refused: 'done' });
  });

  test('only your own chore, someone else\'s with an account, and decline or withdraw change nothing', async () => {
    assert.deepEqual(await offerSwapAs(adminDb, HOUSE, max, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW), { status: 'refused', refused: 'not-yours' });
    assert.deepEqual(await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'kid-chore' }, NOW), { status: 'refused', refused: 'kid-profile' });
    await seedChore('grabs', '');
    assert.deepEqual(await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'grabs' }, NOW), { status: 'refused', refused: 'not-theirs' });
    const offer = await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW);
    const offerId = offer.status === 'offered' ? offer.offerId : '';
    assert.deepEqual(await answerSwapAs(adminDb, HOUSE, ada, { offerId, answer: 'cancel' }, NOW), { status: 'refused', refused: 'not-for-you' });
    assert.deepEqual(await answerSwapAs(adminDb, HOUSE, ada, { offerId, answer: 'decline' }, NOW), { status: 'declined' });
    assert.equal((await read('dishes')).assignedToUid, sam.uid);
    const again = await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW);
    const againId = again.status === 'offered' ? again.offerId : '';
    assert.deepEqual(await answerSwapAs(adminDb, HOUSE, sam, { offerId: againId, answer: 'cancel' }, NOW), { status: 'cancelled' });
  });

  test('a sender has at most 5 open offers; an answered or expired one frees a place', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_SWAPS; i++) {
      const offer = await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW);
      assert.equal(offer.status, 'offered');
      ids.push(offer.status === 'offered' ? offer.offerId : '');
    }
    assert.deepEqual(await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW), { status: 'refused', refused: 'too-many' });
    assert.equal((await notificationsFor(ada.uid)).length, MAX_PENDING_SWAPS, 'no notification for the refused one');
    // Someone else's offers do not count against Sam.
    await seedChore('laundry', max.uid);
    await seedChore('sweep', ada.uid);
    assert.equal((await offerSwapAs(adminDb, HOUSE, max, { myChoreId: 'laundry', theirChoreId: 'sweep' }, NOW)).status, 'offered');
    assert.deepEqual(await answerSwapAs(adminDb, HOUSE, sam, { offerId: ids[0], answer: 'cancel' }, NOW), { status: 'cancelled' });
    assert.equal((await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, NOW)).status, 'offered');
    // Three days on, the old offers have expired and no longer count.
    assert.equal((await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'bins' }, LATER)).status, 'offered');
  });

  test('only to and from members with an approved account', async () => {
    for (const [uid, fields] of [['swap-pending', { role: 'newuser', status: 'pending' }], ['swap-gone', { role: 'member', status: 'deleting' }]] as const) {
      await house().collection('members').doc(uid).set({ uid, displayName: uid, ...fields });
      await seedChore(`${uid}-chore`, uid);
      assert.deepEqual(await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: `${uid}-chore` }, NOW), { status: 'refused', refused: 'not-member' });
    }
    // A chore of someone who has left entirely (no member record).
    await seedChore('left-chore', 'swap-left');
    assert.deepEqual(await offerSwapAs(adminDb, HOUSE, sam, { myChoreId: 'dishes', theirChoreId: 'left-chore' }, NOW), { status: 'refused', refused: 'not-member' });
    // A sender whose own membership is not approved.
    await seedChore('pending-own', 'swap-pending');
    assert.deepEqual(await offerSwapAs(adminDb, HOUSE, { uid: 'swap-pending' }, { myChoreId: 'pending-own', theirChoreId: 'bins' }, NOW), { status: 'refused', refused: 'not-member' });
    assert.equal((await notificationsFor(ada.uid)).length, 0);
  });
});
