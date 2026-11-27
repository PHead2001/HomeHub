import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { completeChoresAs } from '../../src/lib/server/chore-completion';
import { reviewChoreProofAs, submitChoreProofAs, type ProofBucket } from '../../src/lib/server/chore-proof';
import { proofPath } from '../../src/lib/chores/proof';
import { chorePoints } from '../../src/lib/chores/stats';
import type { ChoreRecord } from '../../src/lib/chores/dates';

// Photo proof for kids (CH-30) through the Admin SDK, against the Firestore emulator.
// Storage is a test double: the operations only ask whether the photo exists, what it is
// and who uploaded it, and delete it after the review.
const HOUSE = 'server-chore-proof-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const chores = () => house().collection('chores');
// Noon on Fri Nov 27, 2026 in Chicago; the approval comes the next day.
const SENT = new Date('2026-11-27T18:00:00Z');

type FakeFile = { contentType: string; size: number; metadata: Record<string, string> };
const files = new Map<string, FakeFile>();
const deleted: string[] = [];
const bucket: ProofBucket = {
  file: (path: string) => ({
    exists: async () => [files.has(path)],
    getMetadata: async () => [files.get(path) ?? {}],
    delete: async () => { deleted.push(path); files.delete(path); },
  }),
};

const kid = { uid: 'proof-kid', displayName: 'Kid' };
const parent = { uid: 'proof-parent' };
const member = { uid: 'proof-member' };

const upload = (choreId: string, uid = kid.uid, extra: Partial<FakeFile> = {}) => {
  const path = proofPath(HOUSE, choreId, uid, 'AbCdEf123456');
  files.set(path, { contentType: 'image/jpeg', size: 200_000, metadata: { uploadedByUid: uid }, ...extra });
  return path;
};
const read = async (id: string) => (await chores().doc(id).get()).data()!;

beforeEach(async () => {
  files.clear();
  deleted.length = 0;
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'Proof', ownerUid: parent.uid, timeZone: 'America/Chicago', memberEmails: [] });
  for (const [uid, role, displayName] of [[kid.uid, 'child', 'Kid'], [parent.uid, 'owner', 'Pat'], [member.uid, 'member', 'Max']] as const) {
    await house().collection('members').doc(uid).set({ uid, role, status: 'active', displayName });
  }
  await house().collection('chore-templates').doc('dishes').set({ task: 'Dishes', requiresPhoto: true, roomIds: [], subTasks: ['Rinse', 'Dry'] });
  await house().collection('chore-templates').doc('bins').set({ task: 'Bins', roomIds: [], subTasks: [] });
  const base = { assignedToUid: kid.uid, dueDate: '2026-11-27T06:00:00.000Z', originalDueDate: '2026-11-27', isCompleted: false, roomIds: [], completedSubTasks: [] };
  await chores().doc('dishes-day').set({ ...base, task: 'Dishes', templateId: 'dishes', subTasks: ['Rinse', 'Dry'] });
  await chores().doc('bins-day').set({ ...base, task: 'Bins', templateId: 'bins', subTasks: [] });
  await chores().doc('dishes-tomorrow').set({ ...base, task: 'Dishes', templateId: 'dishes', subTasks: [], originalDueDate: '2026-11-28', dueDate: '2026-11-28T06:00:00.000Z' });
});

after(async () => {
  await adminDb.recursiveDelete(house());
});

describe('photo proof for kids (CH-30)', () => {
  test('a kid cannot complete a photo chore directly; adults can, and other chores are unchanged', async () => {
    const [refused] = await completeChoresAs(adminDb, { uid: kid.uid, email: 'kid@example.test' }, HOUSE, { choreIds: ['dishes-day'] }, SENT);
    assert.deepEqual(refused, { choreId: 'dishes-day', status: 'refused', refused: 'photo' });
    assert.equal((await read('dishes-day')).isCompleted, false);
    const [bins] = await completeChoresAs(adminDb, { uid: kid.uid, email: 'kid@example.test' }, HOUSE, { choreIds: ['bins-day'] }, SENT);
    assert.equal(bins.status, 'completed');
    const [byParent] = await completeChoresAs(adminDb, { uid: parent.uid, email: 'p@example.test' }, HOUSE, { choreIds: ['dishes-day'] }, SENT);
    assert.equal(byParent.status, 'completed');
  });

  test('the photo leaves the chore pending with no points; approval completes it for the kid at the time they sent it', async () => {
    const path = upload('dishes-day');
    assert.deepEqual(await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: path }, SENT), { choreId: 'dishes-day', status: 'pending' });
    const pending = await read('dishes-day');
    assert.equal(pending.isCompleted, false);
    assert.equal(pending.proof.status, 'pending');
    assert.equal(pending.proof.submittedByName, 'Kid');
    assert.equal(chorePoints({ id: 'dishes-day', ...pending } as ChoreRecord), 0);
    assert.deepEqual(await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: path }, SENT), { choreId: 'dishes-day', status: 'refused', refused: 'already-pending' });

    assert.deepEqual(await reviewChoreProofAs(adminDb, bucket, HOUSE, parent, { choreId: 'dishes-day', approve: true }), { choreId: 'dishes-day', status: 'approved' });
    const done = await read('dishes-day');
    assert.equal(done.isCompleted, true);
    assert.equal(done.completedByUid, kid.uid);
    assert.equal(done.completedAt, SENT.toISOString());
    assert.ok(done.completedAtServer instanceof Timestamp);
    assert.deepEqual(done.completedSubTasks, ['Rinse', 'Dry']);
    assert.equal('proof' in done, false);
    assert.deepEqual(deleted, [path], 'the photo is deleted once reviewed');
  });

  test('sending it back leaves the chore open and the kid may send another', async () => {
    const path = upload('dishes-day');
    await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: path }, SENT);
    assert.equal((await reviewChoreProofAs(adminDb, bucket, HOUSE, parent, { choreId: 'dishes-day', approve: false })).status, 'sent-back');
    const back = await read('dishes-day');
    assert.equal(back.isCompleted, false);
    assert.equal(back.proof.status, 'rejected');
    assert.equal(back.proof.photoPath, null);
    const again = upload('dishes-day');
    assert.equal((await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: again }, SENT)).status, 'pending');
  });

  test('refuses forged, missing or foreign photos, chores that need none, and early ones', async () => {
    const theirs = upload('dishes-day', member.uid);
    await assert.rejects(submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: theirs }, SENT), /invalid/);
    await assert.rejects(submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: 'households/other/chore-proofs/dishes-day/proof-kid-AbCdEf123456.jpg' }, SENT), /invalid/);
    const missing = proofPath(HOUSE, 'dishes-day', kid.uid, 'ZZZZZZ999999');
    assert.equal((await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: missing }, SENT)).status, 'refused');
    // Named for the kid but uploaded by someone else, or not an image.
    const forged = upload('dishes-day', kid.uid, { metadata: { uploadedByUid: member.uid } });
    assert.deepEqual(await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: forged }, SENT), { choreId: 'dishes-day', status: 'refused', refused: 'photo-missing' });
    const pdf = upload('dishes-day', kid.uid, { contentType: 'application/pdf' });
    assert.equal((await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: pdf }, SENT)).status, 'refused');
    assert.deepEqual(await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'bins-day', photoPath: upload('bins-day') }, SENT), { choreId: 'bins-day', status: 'refused', refused: 'not-required' });
    assert.deepEqual(await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-tomorrow', photoPath: upload('dishes-tomorrow') }, SENT), { choreId: 'dishes-tomorrow', status: 'refused', refused: 'early' });
    assert.equal((await read('dishes-day')).proof, undefined);
  });

  test('only a member who may edit chores reviews, and never their own photo', async () => {
    const path = upload('dishes-day');
    await submitChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', photoPath: path }, SENT);
    assert.deepEqual(await reviewChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', approve: true }), { choreId: 'dishes-day', status: 'refused', refused: 'forbidden' });
    // A kid given chores.edit still cannot approve their own photo.
    await house().collection('members').doc(kid.uid).update({ permissions: { 'chores.edit': true } });
    assert.deepEqual(await reviewChoreProofAs(adminDb, bucket, HOUSE, kid, { choreId: 'dishes-day', approve: true }), { choreId: 'dishes-day', status: 'refused', refused: 'own-photo' });
    assert.equal((await read('dishes-day')).isCompleted, false);
    assert.equal((await reviewChoreProofAs(adminDb, bucket, HOUSE, member, { choreId: 'dishes-day', approve: true })).status, 'approved');
    assert.deepEqual(await reviewChoreProofAs(adminDb, bucket, HOUSE, parent, { choreId: 'dishes-day', approve: true }), { choreId: 'dishes-day', status: 'refused', refused: 'not-pending' });
  });
});
