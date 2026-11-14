import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { adminAuth, adminDb, adminStorageBucket } from '../../src/lib/server/firebase-admin';
import { deletePetAction } from '../../src/app/pets/actions';
import { deletePetCascade, PET_DELETE_PAGE_SIZE, type PetPhotoBucket } from '../../src/lib/server/pet-delete';
import { runHouseholdReminders } from '../../functions/src/reminders';

// D-P12 / PE-21f / PE-30: deleting a pet on the server (`deletePetAction` →
// `deletePetCascade`) against the Auth, Firestore and Storage emulators, and a
// rename seen by the hourly upkeep's medication reminders.
const HOUSE = 'pet-delete-house';
const OTHER = 'pet-delete-other';
const house = adminDb.collection('households').doc(HOUSE);
const other = adminDb.collection('households').doc(OTHER);

const CALLERS = {
  owner: { uid: 'pd-owner', email: 'pd.owner@example.test' },
  editor: { uid: 'pd-editor', email: 'pd.editor@example.test' },
  member: { uid: 'pd-member', email: 'pd.member@example.test' },
  outsider: { uid: 'pd-outsider', email: 'pd.outsider@example.test' },
} as const;
type Caller = keyof typeof CALLERS;
const tokens = new Map<Caller, string>();

async function idTokenFor(caller: Caller) {
  const { uid, email } = CALLERS[caller];
  await adminAuth.deleteUser(uid).catch(() => undefined);
  await adminAuth.createUser({ uid, email });
  const customToken = await adminAuth.createCustomToken(uid);
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  assert.ok(response.ok, `emulator sign-in for ${caller}`);
  return ((await response.json()) as { idToken: string }).idToken;
}

const bucket = () => adminStorageBucket()!;
const photoUrl = (path: string) => `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}/v0/b/${bucket().name}/o/${encodeURIComponent(path)}?alt=media&token=t`;
const upload = (path: string) => bucket().file(path).save(Buffer.from('fake image'), { contentType: 'image/jpeg' });
const stored = async (path: string) => (await bucket().file(path).exists())[0];

const REX_OWN = `households/${HOUSE}/pets/rex/a.jpg`;
const REX_OLD = `households/${HOUSE}/pets/rex/replaced-earlier.jpg`;
const MAPLE_LEGACY = `households/${HOUSE}/pets/maple-legacy.jpg`;
const SHARED_LEGACY = `households/${HOUSE}/pets/shared-legacy.jpg`;
const BISCUIT_LEGACY = `households/${HOUSE}/pets/biscuit-legacy.jpg`;

const SUBCOLLECTIONS = ['feeding-logs', 'feeding-state', 'medication-logs', 'medication-courses', 'care-logs', 'notes', 'weights'] as const;

async function seedHistory(pet: DocumentReference, feedings: number) {
  for (let start = 0; start < feedings; start += 400) {
    const batch = adminDb.batch();
    for (let index = start; index < Math.min(feedings, start + 400); index += 1) {
      batch.set(pet.collection('feeding-logs').doc(`f${index}`), { date: Timestamp.fromMillis(Date.UTC(2026, 0, 1) + index * 3_600_000), cups: 1, foodType: 'Dry' });
    }
    await batch.commit();
  }
  await pet.collection('feeding-state').doc('current').set({ lastLogId: 'f0', countOnDay: 1, day: '2026-01-01' });
  await pet.collection('medication-logs').doc('m1').set({ date: '2026-10-07T14:00:00.000Z', medication: 'Flea prevention', nextDueDate: '2026-11-06' });
  await pet.collection('medication-courses').doc('c1').set({ name: 'Flea prevention' });
  await pet.collection('care-logs').doc('c1').set({ date: '2026-10-07T14:00:00.000Z', activity: 'Walk' });
  await pet.collection('notes').doc('n1').set({ text: 'Allergic to chicken', pinned: true });
  await pet.collection('weights').doc('w1').set({ value: 4.2, unit: 'kg' });
}

const leftUnder = async (pet: DocumentReference) => {
  let total = 0;
  for (const name of SUBCOLLECTIONS) total += (await pet.collection(name).get()).size;
  return total;
};

const reminder = (petId: string, extra: Record<string, unknown> = {}) => ({
  category: 'pets', sourceType: 'pet_medication', sourceId: `${petId}:flea prevention`, stateKey: 'due|2026-11-06',
  title: `${petId}'s Flea prevention is due today`, audience: ['*'], createdAt: Timestamp.now(), ...extra,
});

before(async () => {
  for (const caller of Object.keys(CALLERS) as Caller[]) tokens.set(caller, await idTokenFor(caller));
});

beforeEach(async () => {
  await adminDb.recursiveDelete(house);
  await adminDb.recursiveDelete(other);
  await bucket().deleteFiles({ prefix: `households/${HOUSE}/` });
  await house.set({ name: 'Pet delete', ownerUid: CALLERS.owner.uid, timeZone: 'America/Chicago', memberEmails: [] });
  await other.set({ name: 'Other', ownerUid: CALLERS.outsider.uid, timeZone: 'America/Chicago', memberEmails: [] });
  await house.collection('members').doc(CALLERS.owner.uid).set({ uid: CALLERS.owner.uid, role: 'owner', status: 'active', displayName: 'Olive' });
  await house.collection('members').doc(CALLERS.editor.uid).set({ uid: CALLERS.editor.uid, role: 'member', status: 'active', displayName: 'Eddie', permissions: { 'pets.editProfiles': true } });
  await house.collection('members').doc(CALLERS.member.uid).set({ uid: CALLERS.member.uid, role: 'member', status: 'active', displayName: 'Mo' });
  await other.collection('members').doc(CALLERS.outsider.uid).set({ uid: CALLERS.outsider.uid, role: 'owner', status: 'active' });

  await house.collection('pets').doc('rex').set({ name: 'Rex', type: 'Dog', photoUrl: photoUrl(REX_OWN) });
  await house.collection('pets').doc('maple').set({ name: 'Maple', type: 'Cat', photoUrl: photoUrl(MAPLE_LEGACY) });
  await house.collection('pets').doc('pepper').set({ name: 'Pepper', type: 'Cat', photoUrl: photoUrl(SHARED_LEGACY) });
  await house.collection('pets').doc('biscuit').set({ name: 'Biscuit', type: 'Dog', photoUrl: photoUrl(BISCUIT_LEGACY) });
  await seedHistory(house.collection('pets').doc('rex'), PET_DELETE_PAGE_SIZE * 2 + 17);
  await seedHistory(house.collection('pets').doc('maple'), 3);
  for (const path of [REX_OWN, REX_OLD, MAPLE_LEGACY, SHARED_LEGACY, BISCUIT_LEGACY]) await upload(path);

  await house.collection('notifications').doc('rex-open').set(reminder('rex'));
  await house.collection('notifications').doc('rex-done').set(reminder('rex', { stateKey: 'due|2026-10-06', resolvedAt: Timestamp.fromDate(new Date('2026-10-07T00:00:00Z')) }));
  await house.collection('notifications').doc('maple-open').set(reminder('maple'));
  await house.collection('notifications').doc('rexford-open').set(reminder('rexford'));
});

after(async () => {
  await adminDb.recursiveDelete(house);
  await adminDb.recursiveDelete(other);
});

const run = (caller: Caller, petId = 'rex', householdId = HOUSE) =>
  deletePetAction({ idToken: tokens.get(caller)!, householdId, petId });

describe('deletePetAction (D-P12)', () => {
  test('deletes the pet, every history under it (in pages), its photos and resolves its open reminders', async () => {
    const rex = house.collection('pets').doc('rex');
    assert.deepEqual(await run('editor'), { ok: true, status: 'deleted' });
    assert.equal((await rex.get()).exists, false);
    assert.equal(await leftUnder(rex), 0, 'feedings beyond two pages, state, medication, courses, care, notes, weights');
    assert.deepEqual(await rex.listCollections(), []);
    // Photos: everything in Rex's folder; nothing of any other pet.
    assert.equal(await stored(REX_OWN), false);
    assert.equal(await stored(REX_OLD), false, 'an earlier photo left in the folder');
    assert.equal(await stored(MAPLE_LEGACY), true);
    assert.equal(await stored(SHARED_LEGACY), true);
    // Reminders: Rex's open one resolved, the rest unchanged.
    assert.ok((await house.collection('notifications').doc('rex-open').get()).get('resolvedAt'));
    assert.equal((await house.collection('notifications').doc('rex-done').get()).get('resolvedAt').toDate().toISOString(), '2026-10-07T00:00:00.000Z');
    assert.equal((await house.collection('notifications').doc('maple-open').get()).get('resolvedAt'), undefined);
    assert.equal((await house.collection('notifications').doc('rexford-open').get()).get('resolvedAt'), undefined, 'a pet id that only starts the same');
    // Other pets untouched; one activity entry; no tombstone left.
    assert.equal(await leftUnder(house.collection('pets').doc('maple')), 9);
    const audit = (await house.collection('auditLogs').get()).docs.map((entry) => entry.data());
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'pet.deleted');
    assert.equal(audit[0].actorUid, CALLERS.editor.uid);
    assert.equal(audit[0].actorName, 'Eddie');
    assert.equal(audit[0].actorEmail, null, 'the name, not the email');
    assert.deepEqual(audit[0].details, { petId: 'rex', petName: 'Rex' });
    assert.equal((await house.collection('pet-deletions').get()).size, 0);
  });

  test('is idempotent: a retry reports already, writes no second activity entry', async () => {
    assert.deepEqual(await run('owner'), { ok: true, status: 'deleted' });
    assert.deepEqual(await run('owner'), { ok: true, status: 'already' });
    assert.equal((await house.collection('auditLogs').get()).size, 1);
  });

  test('a legacy photo in the pets folder is removed only when no other pet uses it', async () => {
    await house.collection('pets').doc('pepper').delete();
    await house.collection('pets').doc('maple').update({ photoUrl: photoUrl(SHARED_LEGACY) });
    await house.collection('pets').doc('rex').update({ photoUrl: photoUrl(SHARED_LEGACY) });
    assert.equal((await run('owner')).ok, true);
    assert.equal(await stored(SHARED_LEGACY), true, 'Maple still shows it');
    assert.deepEqual(await run('owner', 'biscuit'), { ok: true, status: 'deleted' });
    assert.equal(await stored(BISCUIT_LEGACY), false, 'only Biscuit used it');
    // A placeholder or foreign URL is never touched (and never breaks the delete).
    await house.collection('pets').doc('ghost').set({ name: 'Ghost', photoUrl: 'https://placehold.co/300x300.png' });
    assert.deepEqual(await run('owner', 'ghost'), { ok: true, status: 'deleted' });
  });

  test('refuses a member without pets.editProfiles, another household, a bad token and a bad id', async () => {
    assert.equal((await run('member')).ok, false);
    assert.equal((await run('member') as { code: string }).code, 'forbidden');
    assert.equal((await run('outsider') as { code: string }).code, 'forbidden');
    // The outsider's own household: the path comes from the verified household, never ours.
    assert.deepEqual(await run('outsider', 'rex', OTHER), { ok: true, status: 'already' });
    assert.equal((await house.collection('pets').doc('rex').get()).exists, true);
    assert.equal((await deletePetAction({ idToken: 'not-a-token', householdId: HOUSE, petId: 'rex' }) as { code: string }).code, 'unauthenticated');
    assert.equal((await run('owner', 'a/b') as { code: string }).code, 'invalid_input');
    assert.equal(await leftUnder(house.collection('pets').doc('rex')), PET_DELETE_PAGE_SIZE * 2 + 17 + 6);
  });

  test('resumes after a crash: the tombstone keeps the photo, a retry finishes everything', async () => {
    const rex = house.collection('pets').doc('rex');
    await house.collection('pets').doc('rex').update({ photoUrl: photoUrl(BISCUIT_LEGACY) });
    await house.collection('pets').doc('biscuit').update({ photoUrl: '' });
    await assert.rejects(deletePetCascade(adminDb, bucket() as unknown as PetPhotoBucket, {
      householdId: HOUSE, petId: 'rex', actor: { uid: CALLERS.owner.uid, name: 'Olive' },
    }, { afterBarrier: async () => { throw new Error('crash'); } }));
    assert.equal((await rex.get()).exists, false);
    assert.ok(await leftUnder(rex) > 0);
    assert.equal((await house.collection('pet-deletions').doc('rex').get()).exists, true);
    assert.deepEqual(await run('owner'), { ok: true, status: 'deleted' });
    assert.equal(await leftUnder(rex), 0);
    assert.equal(await stored(BISCUIT_LEGACY), false, 'the photo recorded before the crash');
    assert.equal(await stored(REX_OWN), false);
    assert.equal((await house.collection('pet-deletions').get()).size, 0);
    assert.equal((await house.collection('auditLogs').get()).size, 1, 'one activity entry for the one delete');
  });

  test('a write that lands under the pet while it is being swept is swept too', async () => {
    const rex = house.collection('pets').doc('rex');
    const outcome = await deletePetCascade(adminDb, bucket() as unknown as PetPhotoBucket, {
      householdId: HOUSE, petId: 'rex', actor: { uid: CALLERS.owner.uid },
    }, { afterBarrier: async () => { await rex.collection('care-logs').doc('late').set({ activity: 'Late walk' }); } });
    assert.equal(outcome.status, 'deleted');
    assert.equal(await leftUnder(rex), 0);
  });
});

describe('rename and the medication reminders (PE-30d)', () => {
  const ts = (d: Date) => Timestamp.fromDate(d) as never;
  test('upkeep names the renamed pet (same id), and a deleted pet gets no reminder back', async () => {
    await house.collection('notifications').doc('maple-open').delete();
    await house.collection('pets').doc('maple').update({ name: 'Marmalade' });
    await runHouseholdReminders(adminDb as never, HOUSE, new Date('2026-11-06T18:00:00Z'), ts);
    const open = (await house.collection('notifications').where('sourceType', '==', 'pet_medication').get()).docs
      .map((entry) => entry.data())
      .filter((note) => String(note.sourceId).startsWith('maple:') && !note.resolvedAt);
    assert.equal(open.length, 1);
    assert.match(String(open[0].title), /^Marmalade's /);
    assert.equal(open[0].deepLink, '/pets/maple?tab=medication', 'the id, not the name, links the reminder');

    assert.equal((await run('owner')).ok, true);
    await runHouseholdReminders(adminDb as never, HOUSE, new Date('2026-11-06T19:00:00Z'), ts);
    const rexOpen = (await house.collection('notifications').where('sourceType', '==', 'pet_medication').get()).docs
      .filter((entry) => String(entry.get('sourceId')).startsWith('rex:') && !entry.get('resolvedAt'));
    assert.equal(rexOpen.length, 0, 'no stale reminder for the deleted pet');
  });
});
