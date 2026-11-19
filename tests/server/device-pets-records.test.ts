import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { doc, serverTimestamp, Timestamp as ClientTimestamp, writeBatch, type DocumentData, type Firestore as ClientFirestore } from 'firebase/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { DeviceActionError } from '../../src/lib/server/device-gate';
import {
  addNoteFromTablet,
  addWeightFromTablet,
  correctFeedTimeFromTablet,
  deleteLogFromTablet,
  deleteNoteFromTablet,
  deletePetFromTablet,
  editNoteFromTablet,
  editPetProfileFromTablet,
  feedPetFromTablet,
  giveDoseFromTablet,
  saveCourseFromTablet,
  saveMealPlanFromTablet,
  setCourseFinishedFromTablet,
  setNotePinnedFromTablet,
  undoDoseFromTablet,
  undoNoteFromTablet,
  undoWeightFromTablet,
  type DeviceDoseRequest,
} from '../../src/lib/server/device-pets';
import { giveDoseFromTabletAction } from '../../src/app/pets/device-actions';
import { createDeviceRepairCode, redeemDeviceCode } from '../../src/lib/server/device-management';
import { setMyPin, verifyDevicePin } from '../../src/lib/server/pins';
import { UNDO_PROVEN } from '../../src/lib/devices/action-policy';
import { runGiveDose, runUndoDose } from '../../src/lib/pets/medication-transaction';
import { runSetNotePinned } from '../../src/lib/pets/record-transaction';
import { doseChoices, doseConfirmOf, legacyCourseId, readCourse } from '../../src/lib/pets/medication-course';
import { householdDay } from '../../src/lib/pets/feed-decision';
import { clientSession, deleteDeviceUsers, nonce, personToken, seedHousehold, signIn, type Person } from './device-test-helpers';
import { house, opId, pairTablet, seedKid, tokenGeneration, type Tablet } from './device-actor-helpers';

// The Undo proof for the rest of the Pets face actions on wall tablets (design 10.4; tracker
// WT-20f), with real ID tokens, for `pets.dose.give` (now, and backdated within 12 hours),
// `pets.note.add` and `pets.weight.add`: (1) a personal client and another tablet act in
// between (a later dose stays the course's latest; a record changed since is never undone),
// (2) a reload Undoes by the journal's opId inside the window and is refused after it, (3) a
// dropped connection repeats the action (one record) and the Undo (then `already`), (4)
// action, Undo, late retry, (5) Undo first, (6) a queued send in flight with its Undo at
// once, both orders, (7) the wrong tablet, person, generation or window. Plus "Already
// given?" bound to the dose it named across devices, the `.old` dose at PIN level (JC-27),
// a child's face, answers without emails, the PIN-level actions (JC-14) with their activity
// entries and record-level rules, and every server write replayed through the rules as the
// person would write it.

const H = 'dev-pets-rec-house';
const TZ = 'America/Chicago';
const owner: Person = { uid: 'dr-owner', email: 'dr.owner@example.test', displayName: 'Olive', role: 'owner' };
const member: Person = { uid: 'dr-member', email: 'dr.member@example.test', displayName: 'Max', role: 'member' };
const child: Person = { uid: 'dr-child', email: 'dr.child@example.test', displayName: 'Cleo', role: 'child' };
const KID = 'kid_DevPetsRecKid0000000';
const created = new Set<string>();
const NAMES = ['dose', 'backdated', 'note', 'weight', 'again', 'other', 'parity', 'pin', 'pin2', 'pin3', 'pin4', 'pin5', 'pin6', 'pin7', 'extra', 'line', 'review', 'mFace', 'mPin', 'cFace', 'cPin'] as const;
const tablets = {} as Record<(typeof NAMES)[number], Tablet>;
let ownerDb: ClientFirestore;
let memberDb: ClientFirestore;
let childDb: ClientFirestore;
const closers: Array<() => Promise<void>> = [];

const pet = (id: string) => house(H).collection('pets').doc(id);
const doses = (id: string) => pet(id).collection('medication-logs');
const course = (id: string, courseId = 'course-a') => pet(id).collection('medication-courses').doc(courseId);
const notes = (id: string) => pet(id).collection('notes');
const weights = (id: string) => pet(id).collection('weights');
const later = (ms: number) => new Date(Date.now() + ms);

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeviceActionError, `expected DeviceActionError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const seedPet = async (id: string, extra: Record<string, unknown> = {}) => {
  await adminDb.recursiveDelete(pet(id));
  await pet(id).set({ name: `Pet ${id}`, type: 'Dog', foodSchedule: '1 cup twice daily', feedingsPerDay: 2, portionAmount: 1, portionUnit: 'Cups', ...extra });
};
/** An active course every 6 hours from midnight, started three days ago. */
const seedCourse = async (petId: string, courseId = 'course-a', name = 'Apoquel') => {
  const stamp = Timestamp.fromMillis(Date.now() - 3 * 86_400_000);
  await course(petId, courseId).set({
    name, dosage: '1 tablet', schedule: { kind: 'hours', everyHours: 6, firstTime: '00:00' },
    startDay: householdDay(later(-3 * 86_400_000), TZ), endDay: null, status: 'active', legacyKeys: [],
    lastDose: null, prevDose: null, coveredUntil: null,
    createdAt: stamp, createdByUid: owner.uid, createdByName: 'Olive', updatedAt: stamp, updatedByUid: owner.uid, updatedByName: 'Olive',
  });
};
const seedDosePet = async (id: string) => {
  await seedPet(id);
  await seedCourse(id);
};
/** The occurrence Give dose is prefilled with now (from the course as stored). */
const prefill = async (petId: string, courseId = 'course-a') => {
  const view = readCourse(courseId, (await course(petId, courseId).get()).data() ?? {})!;
  return doseChoices(view, new Date(), TZ).prefill!.key;
};

type Variant = 'live' | 'backdated';
const variantExtra = (variant: Variant) => (variant === 'backdated' ? { givenAt: later(-60 * 60_000).toISOString() } : {});
const doseRequest = (t: Tablet, actorUid: string, op: string, petId: string, occurrenceKey: string, extra: Partial<DeviceDoseRequest> = {}): DeviceDoseRequest => ({
  idToken: t.idToken, householdId: H, actorUid, opId: op, petId, courseId: 'course-a', occurrenceKey, ...extra,
});
const give = async (t: Tablet, actorUid: string, op: string, petId: string, extra: Partial<DeviceDoseRequest> = {}, now?: Date) =>
  giveDoseFromTablet(doseRequest(t, actorUid, op, petId, (extra.occurrenceKey as string | undefined) ?? await prefill(petId), extra), now ? { clock: () => now } : {});
/** Gives, answering "Already given?" with the dose it named (as the tablet's prompt does). */
const giveSure = async (t: Tablet, actorUid: string, op: string, petId: string, extra: Partial<DeviceDoseRequest> = {}) => {
  const occurrenceKey = (extra.occurrenceKey as string | undefined) ?? await prefill(petId);
  let answer = await give(t, actorUid, op, petId, { ...extra, occurrenceKey });
  for (let i = 0; answer.result.status === 'needsConfirm' && i < 3; i += 1) {
    answer = await give(t, actorUid, op, petId, { ...extra, occurrenceKey, confirm: { lastLogId: answer.result.check.last?.logId ?? null } });
  }
  assert.equal(answer.result.status, 'saved', JSON.stringify(answer.result));
  return answer;
};
const undoDose = (t: Tablet, actorUid: string, op: string, extra: Record<string, unknown> = {}, now?: Date) =>
  undoDoseFromTablet({ idToken: t.idToken, householdId: H, actorUid, opId: op, ...extra }, now ? { clock: () => now } : {});
const addNote = (t: Tablet, actorUid: string, op: string, petId: string, extra: Record<string, unknown> = {}, now?: Date) =>
  addNoteFromTablet({ idToken: t.idToken, householdId: H, actorUid, opId: op, petId, text: 'Barked at the mail carrier', tag: 'behaviour', ...extra }, now ? { clock: () => now } : {});
const undoNote = (t: Tablet, actorUid: string, op: string, extra: Record<string, unknown> = {}, now?: Date) =>
  undoNoteFromTablet({ idToken: t.idToken, householdId: H, actorUid, opId: op, ...extra }, now ? { clock: () => now } : {});
const addWeight = (t: Tablet, actorUid: string, op: string, petId: string, extra: Record<string, unknown> = {}, now?: Date) =>
  addWeightFromTablet({ idToken: t.idToken, householdId: H, actorUid, opId: op, petId, value: 12.4, unit: 'kg', ...extra }, now ? { clock: () => now } : {});
const undoWeight = (t: Tablet, actorUid: string, op: string, extra: Record<string, unknown> = {}, now?: Date) =>
  undoWeightFromTablet({ idToken: t.idToken, householdId: H, actorUid, opId: op, ...extra }, now ? { clock: () => now } : {});
const queued = (t: Tablet, msAgo: number) => ({ queued: { createdAt: later(-msAgo).toISOString(), generation: tokenGeneration(t.idToken) } });

/** A personal client's dose (the shared client transaction), answering "Already given?" once. */
const personalDose = async (db: ClientFirestore, person: Person, petId: string, op: string) => {
  const input = { householdId: H, petId, courseId: 'course-a', opId: op, occurrenceKey: await prefill(petId), givenAt: null, timeZone: TZ, user: { uid: person.uid, name: person.displayName ?? person.uid } };
  let result = await runGiveDose(db, input);
  if (result.status === 'needsConfirm') result = await runGiveDose(db, { ...input, confirm: doseConfirmOf(result.check) });
  assert.equal(result.status, 'saved');
};

/** A PIN session for a person on a tablet (each test asks for a fresh one). */
const pinOf = async (t: Tablet, person: Person) =>
  (await verifyDevicePin({ idToken: t.idToken, householdId: H, actorUid: person.uid, pin: '2580' })).pinSessionId;
const pinBase = (t: Tablet, actorUid: string, pinSessionId: string, op = opId()) => ({ idToken: t.idToken, householdId: H, actorUid, pinSessionId, opId: op });
const activity = async (capability: string) =>
  (await house(H).collection('auditLogs').where('action', '==', 'device.action').get()).docs.map((d) => d.data()).filter((entry) => entry.details?.capability === capability);

before(async () => {
  await seedHousehold(H, [owner, member, child], { timeZone: TZ });
  await seedKid(H, KID, 'Mia');
  for (const name of NAMES) tablets[name] = await pairTablet(H, owner, created, `${name[0].toUpperCase()}${name.slice(1)} tablet`);
  for (const person of [owner, member, child]) {
    await adminAuth.deleteUser(person.uid).catch(() => undefined);
    await adminAuth.createUser({ uid: person.uid, email: person.email });
  }
  const childSession = await clientSession(await adminAuth.createCustomToken(child.uid));
  childDb = childSession.db;
  closers.push(childSession.close);
  const ownerSession = await clientSession(await adminAuth.createCustomToken(owner.uid));
  const memberSession = await clientSession(await adminAuth.createCustomToken(member.uid));
  ownerDb = ownerSession.db;
  memberDb = memberSession.db;
  closers.push(ownerSession.close, memberSession.close);
  await setMyPin(owner, { householdId: H, pin: '2580' });
  await setMyPin(member, { householdId: H, pin: '2580' });
  await setMyPin(child, { householdId: H, pin: '2580' });
});

after(async () => {
  await Promise.all(closers.map((close) => close()));
  await deleteDeviceUsers([...created]);
  await adminDb.recursiveDelete(house(H));
  const codes = await adminDb.collection('deviceCodes').where('householdId', '==', H).get();
  await Promise.all(codes.docs.map((d) => d.ref.delete()));
});

describe('doses, notes and weights are face-level with their Undo proven', () => {
  test('UNDO_PROVEN holds the capabilities proven in this file; older doses stay PIN-level (JC-27)', () => {
    for (const capability of ['pets.dose.give', 'pets.dose.undo', 'pets.note.add', 'pets.note.undo', 'pets.weight.add', 'pets.weight.undo'] as const) {
      assert.ok(UNDO_PROVEN.has(capability), capability);
    }
    assert.equal(UNDO_PROVEN.has('pets.dose.give.old'), false);
  });
});

for (const variant of ['live', 'backdated'] as const) {
  const t = () => (variant === 'live' ? tablets.dose : tablets.backdated);
  const extra = () => variantExtra(variant);
  describe(`pets.dose.give (${variant})`, () => {
    test('the selected person is credited; the dose carries the tablet attribution; log id == opId; the course pointer names it', async () => {
      const id = `${variant}-credit`;
      await seedDosePet(id);
      const op = opId();
      const { result, level, capability } = await give(t(), KID, op, id, extra());
      assert.equal(result.status, 'saved');
      assert.equal(level, 'face');
      assert.equal(capability, 'pets.dose.give');
      const log = (await doses(id).doc(op).get()).data()!;
      assert.equal(log.loggedByUid, KID);
      assert.equal(log.loggedByName, 'Mia');
      assert.equal(log.courseId, 'course-a');
      assert.equal(log.medication, 'Apoquel');
      assert.equal(log.repeat, 'none');
      assert.equal(log.deviceAttribution.actorUid, KID);
      assert.equal(log.deviceAttribution.level, 'face');
      if (variant === 'backdated') assert.equal(log.backdated, true);
      const pointer = (await course(id).get()).get('lastDose');
      assert.equal(pointer.logId, op);
      assert.equal(pointer.byUid, KID);
    });

    test('case 1: a personal client and another tablet give in between: the Undo removes only its own dose and the later dose stays the latest', async () => {
      const id = `${variant}-between`;
      await seedDosePet(id);
      const op = opId();
      await give(t(), member.uid, op, id, extra());
      const personalOp = opId();
      await personalDose(ownerDb, owner, id, personalOp);
      const otherOp = opId();
      await giveSure(tablets.other, child.uid, otherOp, id);
      assert.equal((await undoDose(t(), member.uid, op, {}, later(3000))).status, 'undone');
      assert.equal((await doses(id).doc(op).get()).exists, false);
      assert.equal((await doses(id).doc(personalOp).get()).exists, true);
      const stored = (await course(id).get()).data()!;
      assert.equal(stored.lastDose.logId, otherOp, 'the latest dose stays the latest');
      assert.equal(stored.prevDose.logId, personalOp);

      // A personal delete of the tablet's dose in between: never "undone" again here.
      const gone = `${variant}-deleted`;
      await seedDosePet(gone);
      const deleted = opId();
      await give(t(), member.uid, deleted, gone, extra());
      assert.equal(await runUndoDose(ownerDb, { householdId: H, petId: gone, logId: deleted }), 'saved');
      await refused(undoDose(t(), member.uid, deleted, {}, later(2000)), 'changed_since');
      assert.equal((await course(gone).get()).get('lastDose'), null);
    });

    test('case 2: after a reload the journal opId Undoes inside the window and is refused after it', async () => {
      const id = `${variant}-reload`;
      await seedDosePet(id);
      const inside = opId();
      await give(t(), member.uid, inside, id, extra());
      assert.equal((await undoDose(t(), member.uid, inside, {}, later(9000))).status, 'undone');
      assert.equal((await course(id).get()).get('lastDose'), null, 'the pointer moved off the undone dose');
      const outside = opId();
      await giveSure(t(), member.uid, outside, id, extra());
      await refused(undoDose(t(), member.uid, outside, {}, later(15_500)), 'undo_expired');
      assert.equal((await doses(id).doc(outside).get()).exists, true);
    });

    test('case 3: a dropped connection repeats the dose (one record) and the Undo (then already)', async () => {
      const id = `${variant}-dropped`;
      await seedDosePet(id);
      const op = opId();
      await give(t(), member.uid, op, id, extra());
      const repeat = await give(t(), member.uid, op, id, extra());
      assert.equal(repeat.result.status, 'saved');
      assert.equal((await doses(id).get()).size, 1);
      assert.equal((await undoDose(t(), member.uid, op)).status, 'undone');
      assert.equal((await undoDose(t(), member.uid, op)).status, 'already');
      assert.equal((await doses(id).get()).size, 0);
    });

    test('case 4: give, Undo, then a late retry of the dose is already undone', async () => {
      const id = `${variant}-late`;
      await seedDosePet(id);
      const op = opId();
      await give(t(), member.uid, op, id, extra());
      await undoDose(t(), member.uid, op);
      await refused(give(t(), member.uid, op, id, extra()), 'already_undone');
      assert.equal((await doses(id).get()).size, 0);
    });

    test('case 5: the Undo arrives first (a tombstone), then the dose is refused', async () => {
      const id = `${variant}-first`;
      await seedDosePet(id);
      const op = opId();
      assert.equal((await undoDose(t(), member.uid, op)).status, 'not_applied');
      await refused(give(t(), member.uid, op, id, extra()), 'already_undone');
      assert.equal((await doses(id).get()).size, 0);
    });

    test('case 6: a queued dose in flight and its Undo at once, both orders, leave no dose', async () => {
      for (const order of ['action-first', 'undo-first'] as const) {
        const id = `${variant}-race-${order}`;
        await seedDosePet(id);
        const op = opId();
        const key = await prefill(id);
        const action = giveDoseFromTablet({ ...doseRequest(t(), member.uid, op, id, key, extra()), ...queued(t(), 30_000) }).catch((error) => error);
        const undo = undoDoseFromTablet({ idToken: t().idToken, householdId: H, actorUid: member.uid, opId: op, ...queued(t(), 25_000) }).catch((error) => error);
        await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
        assert.equal((await doses(id).get()).size, 0, order);
        await refused(give(t(), member.uid, op, id, extra()), 'already_undone');
      }
    });

    test('case 7: another tablet, another person, an older generation, or after the window cannot Undo it', async () => {
      const id = `${variant}-principal`;
      await seedDosePet(id);
      const op = opId();
      await give(t(), member.uid, op, id, extra());
      assert.equal((await undoDose(tablets.other, member.uid, op)).status, 'not_applied');
      await refused(undoDose(t(), child.uid, op), 'forbidden');
      await refused(undoDose(t(), owner.uid, op), 'pin_required');
      await refused(undoDose(t(), member.uid, op, {}, later(16_000)), 'undo_expired');
      assert.equal((await doses(id).doc(op).get()).exists, true);
    });
  });
}

describe('pets.dose.give: generation, the queued path, "Already given?", levels and answers', () => {
  test('case 7 (generation): a re-paired tablet cannot Undo what the older credential gave', async () => {
    const spare = await pairTablet(H, owner, created, 'Spare tablet');
    await seedDosePet('dose-gen');
    const op = opId();
    await give(spare, member.uid, op, 'dose-gen');
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    const fresh = { ...spare, idToken: (await signIn(repaired.customToken)).idToken };
    await refused(undoDose(fresh, member.uid, op), 'not_undoable');
    assert.equal((await doses('dose-gen').get()).size, 1);
  });

  test('a queued dose is recorded once at the device time as an offline dose (no pointer, never asked)', async () => {
    await seedDosePet('dose-offline');
    await giveSure(tablets.extra, owner.uid, opId(), 'dose-offline');
    const before = (await course('dose-offline').get()).get('lastDose');
    const op = opId();
    const key = await prefill('dose-offline');
    const sent = await giveDoseFromTablet({ ...doseRequest(tablets.extra, member.uid, op, 'dose-offline', key), ...queued(tablets.extra, 60_000) });
    assert.equal(sent.result.status, 'saved');
    const again = await giveDoseFromTablet({ ...doseRequest(tablets.extra, member.uid, op, 'dose-offline', key), ...queued(tablets.extra, 60_000) });
    assert.equal(again.result.status, 'saved');
    const log = (await doses('dose-offline').doc(op).get()).data()!;
    assert.equal(log.repeat, 'offline');
    assert.equal(log.clockSource, 'device');
    assert.equal((await doses('dose-offline').get()).size, 2);
    assert.deepEqual((await course('dose-offline').get()).get('lastDose'), before, 'a queued dose never moves the pointer');
  });

  test('"Already given?" is bound to the dose it named; a dose on another tablet meanwhile asks again naming it', async () => {
    await seedDosePet('dose-again');
    const first = opId();
    await give(tablets.again, member.uid, first, 'dose-again');
    const asking = opId();
    const key = await prefill('dose-again');
    const asked = await give(tablets.other, owner.uid, asking, 'dose-again', { occurrenceKey: key });
    assert.equal(asked.result.status, 'needsConfirm');
    if (asked.result.status !== 'needsConfirm') return;
    assert.equal(asked.result.check.last?.logId, first);
    assert.equal(asked.result.check.last?.byName, 'Max');
    assert.equal((await doses('dose-again').get()).size, 1, 'asking writes nothing');
    const meanwhile = opId();
    await giveSure(tablets.again, child.uid, meanwhile, 'dose-again', { occurrenceKey: key });
    const stale = await give(tablets.other, owner.uid, asking, 'dose-again', { occurrenceKey: key, confirm: { lastLogId: first } });
    assert.equal(stale.result.status, 'needsConfirm');
    if (stale.result.status !== 'needsConfirm') return;
    assert.equal(stale.result.staleConfirm, true);
    assert.equal(stale.result.check.last?.logId, meanwhile);
    const saved = await give(tablets.other, owner.uid, asking, 'dose-again', { occurrenceKey: key, confirm: { lastLogId: meanwhile } });
    assert.equal(saved.result.status, 'saved');
    const log = (await doses('dose-again').doc(asking).get()).data()!;
    assert.equal(log.repeat, 'confirmed');
    assert.equal(log.confirmOf, meanwhile);
  });

  test('a finished course or a moved schedule is answered, never written', async () => {
    await seedDosePet('dose-finished');
    await course('dose-finished').update({ status: 'finished' });
    const answer = await give(tablets.extra, member.uid, opId(), 'dose-finished', { occurrenceKey: '2026-11-01T00:00' });
    assert.deepEqual(answer.result, { status: 'refused', reason: 'finished' });
    assert.equal((await doses('dose-finished').get()).size, 0);
  });

  test('JC-27: a dose given more than 12 hours ago needs a PIN and is recorded at PIN level with an activity entry', async () => {
    await seedDosePet('dose-old');
    const old = { givenAt: later(-13 * 60 * 60_000).toISOString() };
    await refused(give(tablets.pin, owner.uid, opId(), 'dose-old', old), 'pin_required');
    const op = opId();
    const { level, capability } = await give(tablets.pin, owner.uid, op, 'dose-old', { ...old, pinSessionId: await pinOf(tablets.pin, owner) });
    assert.equal(level, 'pin');
    assert.equal(capability, 'pets.dose.give.old');
    assert.equal((await doses('dose-old').doc(op).get()).get('deviceAttribution').level, 'pin');
    assert.ok((await activity('pets.dose.give.old')).some((entry) => entry.targetName === 'Pet dose-old'));
  });

  test("D-P6 and PE-17e: the points PIN never applies; a child's face gives what the role allows and no more", async () => {
    await house(H).update({ devicePolicy: { pointsPin: 'everyone' } });
    await seedDosePet('dose-points');
    assert.equal((await give(tablets.extra, child.uid, opId(), 'dose-points')).level, 'face');
    await house(H).update({ devicePolicy: { pointsPin: 'off' } });
    await house(H).collection('members').doc(child.uid).update({ permissions: { 'pets.addLogs': false } });
    await refused(give(tablets.extra, child.uid, opId(), 'dose-points'), 'forbidden');
    await refused(addNote(tablets.extra, child.uid, opId(), 'dose-points'), 'forbidden');
    await refused(addWeight(tablets.extra, child.uid, opId(), 'dose-points'), 'forbidden');
    await house(H).collection('members').doc(child.uid).update({ permissions: {} });
    // A child never reaches a PIN-level profile action (no pets.editProfiles).
    await refused(editPetProfileFromTablet({ ...pinBase(tablets.extra, child.uid, 'x'.repeat(43)), petId: 'dose-points', name: 'Rex' }), 'forbidden');
  });

  test('answers to a tablet carry no email; a personal token is not a tablet', async () => {
    await seedDosePet('dose-email');
    const older = opId();
    await doses('dose-email').doc(older).set({
      courseId: 'course-a', occurrence: await prefill('dose-email'), occurrenceAt: Timestamp.fromMillis(Date.now() - 60_000), date: Timestamp.fromMillis(Date.now() - 60_000),
      loggedAt: Timestamp.fromMillis(Date.now() - 60_000), medication: 'Apoquel', dosage: '1 tablet', notes: '', loggedByUid: 'someone', loggedByName: 'someone@example.test', repeat: 'none',
    });
    const at = Timestamp.fromMillis(Date.now() - 60_000);
    await course('dose-email').update({ lastDose: { logId: older, occurrence: await prefill('dose-email'), occurrenceAt: at, givenAt: at, byUid: 'someone', byName: 'someone@example.test' } });
    const answer = await give(tablets.extra, member.uid, opId(), 'dose-email');
    assert.equal(answer.result.status, 'needsConfirm');
    assert.equal(JSON.stringify(answer).includes('@'), false, JSON.stringify(answer));
    const personal = await giveDoseFromTabletAction({ idToken: await personToken(owner), householdId: H, actorUid: member.uid, opId: opId(), petId: 'dose-email', courseId: 'course-a', occurrenceKey: await prefill('dose-email') });
    assert.equal(personal.ok ? 'ok' : personal.code, 'not_a_device');
  });
});

for (const kind of ['note', 'weight'] as const) {
  const t = () => (kind === 'note' ? tablets.note : tablets.weight);
  const add = kind === 'note' ? addNote : addWeight;
  const undo = kind === 'note' ? undoNote : undoWeight;
  const records = kind === 'note' ? notes : weights;
  describe(`pets.${kind}.add`, () => {
    test('the selected person is credited, with the tablet attribution; id == opId', async () => {
      await seedPet(`${kind}-credit`);
      const op = opId();
      assert.equal((await add(t(), KID, op, `${kind}-credit`)).status, 'added');
      const entry = (await records(`${kind}-credit`).doc(op).get()).data()!;
      assert.equal(entry.loggedByUid, KID);
      assert.equal(entry.loggedByName, 'Mia');
      assert.equal(entry.deviceAttribution.actorUid, KID);
      assert.ok(entry.date instanceof Timestamp);
      if (kind === 'note') assert.equal(entry.pinned, false);
      else assert.equal(entry.value, 12.4);
    });

    test('case 1: another tablet adds meanwhile (kept); a record changed since is never undone', async () => {
      const id = `${kind}-between`;
      await seedPet(id);
      const op = opId();
      await add(t(), member.uid, op, id);
      const otherOp = opId();
      await add(tablets.other, child.uid, otherOp, id);
      assert.equal((await undo(t(), member.uid, op)).status, 'undone');
      assert.equal((await records(id).doc(otherOp).get()).exists, true);
      const changed = opId();
      await add(t(), member.uid, changed, id);
      if (kind === 'note') {
        // The owner pins it on a phone in between.
        await runSetNotePinned(ownerDb, { householdId: H, petId: id, noteId: changed, pinned: true });
      } else {
        // The owner removes it on a phone in between (weights are never edited).
        await records(id).doc(changed).delete();
      }
      await refused(undo(t(), member.uid, changed), 'changed_since');
    });

    test('cases 2-5: reload inside and outside the window, dropped connection, late retry, Undo first', async () => {
      const id = `${kind}-cases`;
      await seedPet(id);
      const inside = opId();
      await add(t(), member.uid, inside, id);
      assert.equal((await undo(t(), member.uid, inside, {}, later(9000))).status, 'undone');
      const outside = opId();
      await add(t(), member.uid, outside, id);
      await refused(undo(t(), member.uid, outside, {}, later(15_500)), 'undo_expired');
      const dropped = opId();
      await add(t(), member.uid, dropped, id);
      assert.equal((await add(t(), member.uid, dropped, id)).status, 'added');
      assert.equal((await undo(t(), member.uid, dropped)).status, 'undone');
      assert.equal((await undo(t(), member.uid, dropped)).status, 'already');
      await refused(add(t(), member.uid, dropped, id), 'already_undone');
      const first = opId();
      assert.equal((await undo(t(), member.uid, first)).status, 'not_applied');
      await refused(add(t(), member.uid, first, id), 'already_undone');
      assert.deepEqual((await records(id).get()).docs.map((d) => d.id), [outside]);
    });

    test('case 6: a queued add in flight and its Undo at once, both orders, leave nothing', async () => {
      for (const order of ['action-first', 'undo-first'] as const) {
        const id = `${kind}-race-${order}`;
        await seedPet(id);
        const op = opId();
        const action = add(t(), member.uid, op, id, queued(t(), 30_000)).catch((error) => error);
        const undone = undo(t(), member.uid, op, queued(t(), 25_000)).catch((error) => error);
        await Promise.all(order === 'action-first' ? [action, undone] : [undone, action]);
        assert.equal((await records(id).get()).size, 0, order);
      }
    });

    test('case 7: another tablet, another person, after the window', async () => {
      const id = `${kind}-principal`;
      await seedPet(id);
      const op = opId();
      await add(t(), member.uid, op, id);
      assert.equal((await undo(tablets.other, member.uid, op)).status, 'not_applied');
      await refused(undo(t(), child.uid, op), 'forbidden');
      await refused(undo(t(), owner.uid, op), 'pin_required');
      await refused(undo(t(), member.uid, op, {}, later(16_000)), 'undo_expired');
      assert.equal((await records(id).doc(op).get()).exists, true);
    });
  });
}

describe('notes and weights: what the forms check', () => {
  test('a pinned note is a PIN action (never a face add); an invalid draft is answered, never written', async () => {
    await seedPet('note-shape');
    await refused(addNote(tablets.extra, member.uid, opId(), 'note-shape', { pinned: true }), 'invalid_input');
    const empty = await addNote(tablets.extra, member.uid, opId(), 'note-shape', { text: '   ' });
    assert.equal(empty.status, 'refused');
    const future = await addNote(tablets.extra, member.uid, opId(), 'note-shape', { day: '2999-01-01' });
    assert.equal(future.status, 'refused');
    const heavy = await addWeight(tablets.extra, member.uid, opId(), 'note-shape', { value: 900, unit: 'kg' });
    assert.equal(heavy.status, 'refused');
    assert.equal((await notes('note-shape').get()).size + (await weights('note-shape').get()).size, 0);
    // An earlier day's entry is dated noon of that household day.
    const op = opId();
    const day = householdDay(later(-2 * 86_400_000), TZ);
    await addNote(tablets.extra, member.uid, op, 'note-shape', { day });
    assert.equal(householdDay((await notes('note-shape').doc(op).get()).get('date').toDate(), TZ), day);
  });
});

describe('PIN-level Pets actions (JC-14): the gate, the record-level rules and the activity entries', () => {
  const t = () => tablets.pin;

  test('every PIN-level action without a PIN is refused before anything is read', async () => {
    await seedPet('pin-none');
    await refused(setNotePinnedFromTablet({ idToken: t().idToken, householdId: H, actorUid: owner.uid, opId: opId(), petId: 'pin-none', noteId: 'n1', pinned: true }), 'pin_required');
    await refused(deleteLogFromTablet({ idToken: t().idToken, householdId: H, actorUid: owner.uid, opId: opId(), petId: 'pin-none', kind: 'care-logs', logId: 'c1' }), 'pin_required');
    await refused(deletePetFromTablet({ idToken: t().idToken, householdId: H, actorUid: owner.uid, opId: opId(), petId: 'pin-none' }), 'pin_required');
    assert.equal((await pet('pin-none').get()).exists, true);
  });

  test('note pin, unpin, edit and delete follow the note rules (author or pets.editProfiles; delete within 10 minutes for the author)', async () => {
    await seedPet('pin-notes');
    const mine = opId();
    await addNote(tablets.pin2, member.uid, mine, 'pin-notes', { text: 'Loves the park' });
    const theirs = opId();
    await addNote(tablets.pin2, owner.uid, theirs, 'pin-notes', { text: 'Owner note' });
    const memberPin = await pinOf(t(), member);
    // The author pins their own note; someone else's is refused (no pets.editProfiles).
    const pinned = await setNotePinnedFromTablet({ ...pinBase(t(), member.uid, memberPin), petId: 'pin-notes', noteId: mine, pinned: true });
    assert.equal(pinned.status, 'saved');
    assert.equal((await notes('pin-notes').doc(mine).get()).get('pinned'), true);
    await refused(setNotePinnedFromTablet({ ...pinBase(t(), member.uid, memberPin), petId: 'pin-notes', noteId: theirs, pinned: true }), 'forbidden');
    assert.ok((await activity('pets.note.pin')).some((entry) => entry.targetName === 'Pet pin-notes' && entry.level === 'pin'));
    // The owner (pets.editProfiles) unpins it; unpinning again changes nothing.
    const ownerPin = await pinOf(t(), owner);
    assert.equal((await setNotePinnedFromTablet({ ...pinBase(t(), owner.uid, ownerPin), petId: 'pin-notes', noteId: mine, pinned: false })).status, 'saved');
    assert.equal((await setNotePinnedFromTablet({ ...pinBase(t(), owner.uid, ownerPin), petId: 'pin-notes', noteId: mine, pinned: false })).status, 'already');
    // An edit is bound to what the form opened with.
    const stale = await editNoteFromTablet({ ...pinBase(t(), member.uid, memberPin), petId: 'pin-notes', noteId: mine, expected: { text: 'Something else', tag: 'behaviour' }, text: 'Loves the big park', tag: 'behaviour' });
    assert.deepEqual(stale, { status: 'refused', reason: 'changed' });
    const edited = await editNoteFromTablet({ ...pinBase(t(), member.uid, memberPin), petId: 'pin-notes', noteId: mine, expected: { text: 'Loves the park', tag: 'behaviour' }, text: 'Loves the big park', tag: null });
    assert.equal(edited.status, 'saved');
    const note = (await notes('pin-notes').doc(mine).get()).data()!;
    assert.equal(note.text, 'Loves the big park');
    assert.equal('tag' in note, false);
    assert.equal(note.editedByUid, member.uid);
    // Delete: the author within 10 minutes; someone else's needs pets.deleteLogs.
    await refused(deleteNoteFromTablet({ ...pinBase(t(), member.uid, memberPin), petId: 'pin-notes', noteId: theirs }), 'forbidden');
    assert.equal((await deleteNoteFromTablet({ ...pinBase(t(), member.uid, memberPin), petId: 'pin-notes', noteId: mine })).status, 'deleted');
    await notes('pin-notes').doc(theirs).update({ loggedAt: Timestamp.fromMillis(Date.now() - 11 * 60_000) });
    assert.equal((await deleteNoteFromTablet({ ...pinBase(t(), owner.uid, ownerPin), petId: 'pin-notes', noteId: theirs })).status, 'deleted');
  });

  test('a replay of the same opId writes nothing more and logs one activity entry', async () => {
    await seedPet('pin-replay');
    const note = opId();
    await addNote(tablets.pin2, member.uid, note, 'pin-replay');
    const ownerPin = await pinOf(tablets.pin3, owner);
    const op = opId();
    const before = (await activity('pets.note.pin')).length;
    const first = await setNotePinnedFromTablet({ ...pinBase(tablets.pin3, owner.uid, ownerPin, op), petId: 'pin-replay', noteId: note, pinned: true });
    const again = await setNotePinnedFromTablet({ ...pinBase(tablets.pin3, owner.uid, ownerPin, op), petId: 'pin-replay', noteId: note, pinned: true });
    assert.equal(first.status, 'saved');
    assert.equal(again.status, 'saved');
    assert.equal((again as { replayed?: true }).replayed, true);
    assert.equal((await activity('pets.note.pin')).length, before + 1);
  });

  test('older entries: feedings and doses re-derive their state, care needs pets.deleteLogs, weights follow mayDeleteWeight', async () => {
    await seedDosePet('pin-logs');
    const fed1 = opId();
    const fed2 = opId();
    await feedPetFromTablet({ idToken: tablets.pin2.idToken, householdId: H, actorUid: owner.uid, opId: fed1, petId: 'pin-logs', portion: { amount: 1, unit: 'Cups' }, food: 'Dry', backdatedAt: later(-3 * 60 * 60_000).toISOString() });
    await feedPetFromTablet({ idToken: tablets.pin2.idToken, householdId: H, actorUid: owner.uid, opId: fed2, petId: 'pin-logs', portion: { amount: 1, unit: 'Cups' }, food: 'Dry', backdatedAt: later(-60 * 60_000).toISOString() });
    const ownerPin = await pinOf(tablets.pin4, owner);
    const memberPin = await pinOf(tablets.pin4, member);
    // The member is not the feeder and lacks pets.deleteLogs.
    await refused(deleteLogFromTablet({ ...pinBase(tablets.pin4, member.uid, memberPin), petId: 'pin-logs', kind: 'feeding-logs', logId: fed2 }), 'forbidden');
    assert.equal((await deleteLogFromTablet({ ...pinBase(tablets.pin4, owner.uid, ownerPin), petId: 'pin-logs', kind: 'feeding-logs', logId: fed2 })).status, 'deleted');
    assert.equal((await pet('pin-logs').collection('feeding-state').doc('current').get()).get('lastLogId'), fed1, 'the previous feed is the latest again');
    // A dose: the course pointer moves off it.
    const dose1 = opId();
    await give(tablets.pin2, owner.uid, dose1, 'pin-logs');
    assert.equal((await deleteLogFromTablet({ ...pinBase(tablets.pin4, owner.uid, ownerPin), petId: 'pin-logs', kind: 'medication-logs', logId: dose1 })).status, 'deleted');
    assert.equal((await course('pin-logs').get()).get('lastDose'), null);
    // Care: pets.deleteLogs only, even for its author.
    await pet('pin-logs').collection('care-logs').doc('care-1').set({ date: new Date().toISOString(), activity: 'Walk', notes: '', loggedByUid: member.uid, loggedByName: 'Max' });
    await refused(deleteLogFromTablet({ ...pinBase(tablets.pin4, member.uid, memberPin), petId: 'pin-logs', kind: 'care-logs', logId: 'care-1' }), 'forbidden');
    assert.equal((await deleteLogFromTablet({ ...pinBase(tablets.pin4, owner.uid, ownerPin), petId: 'pin-logs', kind: 'care-logs', logId: 'care-1' })).status, 'deleted');
    // A weighing: its author within 10 minutes.
    const weighed = opId();
    await addWeight(tablets.pin2, member.uid, weighed, 'pin-logs');
    assert.equal((await deleteLogFromTablet({ ...pinBase(tablets.pin4, member.uid, memberPin), petId: 'pin-logs', kind: 'weights', logId: weighed })).status, 'deleted');
    assert.equal((await deleteLogFromTablet({ ...pinBase(tablets.pin4, member.uid, memberPin), petId: 'pin-logs', kind: 'weights', logId: weighed })).status, 'already');
    assert.ok((await activity('pets.log.delete')).length >= 4);
  });

  test("a feeding's time is corrected as the personal path does (originalDate kept, state follows); the future is refused", async () => {
    await seedPet('pin-time');
    const fed = opId();
    await feedPetFromTablet({ idToken: tablets.pin2.idToken, householdId: H, actorUid: owner.uid, opId: fed, petId: 'pin-time', portion: { amount: 1, unit: 'Cups' }, food: 'Dry' });
    const ownerPin = await pinOf(tablets.pin3, owner);
    const original = (await pet('pin-time').collection('feeding-logs').doc(fed).get()).get('date');
    const target = later(-2 * 60 * 60_000);
    assert.equal((await correctFeedTimeFromTablet({ ...pinBase(tablets.pin3, owner.uid, ownerPin), petId: 'pin-time', logId: fed, date: target.toISOString() })).status, 'saved');
    const log = (await pet('pin-time').collection('feeding-logs').doc(fed).get()).data()!;
    assert.equal(log.date.toMillis(), target.getTime());
    assert.equal(log.originalDate.toMillis(), original.toMillis());
    assert.equal(log.dateCorrectedByUid, owner.uid);
    assert.equal((await pet('pin-time').collection('feeding-state').doc('current').get()).get('lastFedAt').toMillis(), target.getTime());
    const future = await correctFeedTimeFromTablet({ ...pinBase(tablets.pin3, owner.uid, ownerPin), petId: 'pin-time', logId: fed, date: later(10 * 60_000).toISOString() });
    assert.deepEqual(future, { status: 'refused', reason: 'future' });
  });

  test('courses: create, a duplicate active name refused, edit, finish, resume; a legacy medication confirmed under its own id', async () => {
    await seedDosePet('pin-course');
    const memberPin = await pinOf(tablets.pin5, member);
    const values = { name: 'Gabapentin', dosage: '100 mg', kind: 'days', everyDays: '1', times: ['08:00', '20:00'], everyHours: '12', firstTime: '08:00', startDay: householdDay(new Date(), TZ), endDay: '' };
    const createdCourse = await saveCourseFromTablet({ ...pinBase(tablets.pin5, member.uid, memberPin), petId: 'pin-course', courseId: 'course-new', create: true, values });
    assert.equal(createdCourse.status, 'saved');
    const stored = (await course('pin-course', 'course-new').get()).data()!;
    assert.equal(stored.createdByUid, member.uid);
    assert.equal(stored.status, 'active');
    const duplicate = await saveCourseFromTablet({ ...pinBase(tablets.pin5, member.uid, memberPin), petId: 'pin-course', courseId: 'course-dup', create: true, values: { ...values, name: 'apoquel' } });
    assert.equal(duplicate.status, 'refused');
    const edited = await saveCourseFromTablet({ ...pinBase(tablets.pin5, member.uid, memberPin), petId: 'pin-course', courseId: 'course-new', create: false, values: { ...values, dosage: '150 mg' } });
    assert.equal(edited.status, 'saved');
    assert.equal((await course('pin-course', 'course-new').get()).get('dosage'), '150 mg');
    assert.equal((await setCourseFinishedFromTablet({ ...pinBase(tablets.pin5, member.uid, memberPin), petId: 'pin-course', courseId: 'course-new', finished: true })).status, 'saved');
    assert.equal((await course('pin-course', 'course-new').get()).get('finishedByUid'), member.uid);
    assert.equal((await setCourseFinishedFromTablet({ ...pinBase(tablets.pin5, member.uid, memberPin), petId: 'pin-course', courseId: 'course-new', finished: true })).status, 'already');
    assert.equal((await setCourseFinishedFromTablet({ ...pinBase(tablets.pin5, member.uid, memberPin), petId: 'pin-course', courseId: 'course-new', finished: false })).status, 'saved');
    assert.equal((await course('pin-course', 'course-new').get()).get('status'), 'active');
    assert.ok((await activity('pets.course.resume')).length >= 1);
    const legacy = await saveCourseFromTablet({ ...pinBase(tablets.pin5, member.uid, memberPin), petId: 'pin-course', legacyKey: 'heartgard', values: { ...values, name: 'Heartgard', times: ['09:00'] } });
    assert.equal(legacy.status, 'saved');
    assert.deepEqual((await course('pin-course', legacyCourseId('heartgard')).get()).get('legacyKeys'), ['heartgard']);
  });

  test('profile edits: rename with the duplicate check, vet contact set and cleared, weight unit; meal plan confirmed by the person', async () => {
    await seedPet('pin-profile');
    await seedPet('pin-other', { name: 'Biscuit' });
    const ownerPin = await pinOf(tablets.pin6, owner);
    const memberPin = await pinOf(tablets.pin6, member);
    await refused(editPetProfileFromTablet({ ...pinBase(tablets.pin6, member.uid, memberPin), petId: 'pin-profile', name: 'Rex' }), 'forbidden');
    assert.deepEqual(await editPetProfileFromTablet({ ...pinBase(tablets.pin6, owner.uid, ownerPin), petId: 'pin-profile', name: 'biscuit' }), { status: 'refused', reason: 'duplicate-name' });
    assert.equal((await editPetProfileFromTablet({ ...pinBase(tablets.pin6, owner.uid, ownerPin), petId: 'pin-profile', name: 'Rex', vetName: 'Dr. Lee', vetPhone: '555 0100', weightUnit: 'lb' })).status, 'saved');
    let profile = (await pet('pin-profile').get()).data()!;
    assert.equal(profile.name, 'Rex');
    assert.equal(profile.vetName, 'Dr. Lee');
    assert.equal(profile.weightUnit, 'lb');
    await editPetProfileFromTablet({ ...pinBase(tablets.pin6, owner.uid, ownerPin), petId: 'pin-profile', vetName: null });
    profile = (await pet('pin-profile').get()).data()!;
    assert.equal('vetName' in profile, false);
    assert.equal(profile.vetPhone, '555 0100');
    const rows = [{ id: 'slot-breakfast', name: 'Breakfast', time: '07:30', amount: '1', unit: 'Cups', offDays: [] }, { id: 'slot-dinner', name: 'Dinner', time: '18:00', amount: '1.5', unit: 'Cups', offDays: [] }];
    assert.equal((await saveMealPlanFromTablet({ ...pinBase(tablets.pin6, owner.uid, ownerPin), petId: 'pin-profile', rows })).status, 'saved');
    const plan = (await pet('pin-profile').get()).data()!;
    assert.equal(plan.mealPlan.confirmedByUid, owner.uid);
    assert.equal(plan.mealPlan.slots.length, 2);
    assert.equal(plan.feedingsPerDay, 2);
    assert.equal((await saveMealPlanFromTablet({ ...pinBase(tablets.pin6, owner.uid, ownerPin), petId: 'pin-profile', rows })).status, 'already');
    const bad = await saveMealPlanFromTablet({ ...pinBase(tablets.pin6, owner.uid, ownerPin), petId: 'pin-profile', rows: [{ ...rows[0], time: '7' }] });
    assert.equal(bad.status, 'refused');
  });

  test('pet delete runs the existing cascade inside the gate; a retry finishes and replays', async () => {
    await seedDosePet('pin-delete');
    await addNote(tablets.pin2, owner.uid, opId(), 'pin-delete');
    const memberPin = await pinOf(tablets.pin7, member);
    await refused(deletePetFromTablet({ ...pinBase(tablets.pin7, member.uid, memberPin), petId: 'pin-delete' }), 'forbidden');
    const ownerPin = await pinOf(tablets.pin7, owner);
    const op = opId();
    assert.deepEqual(await deletePetFromTablet({ ...pinBase(tablets.pin7, owner.uid, ownerPin, op), petId: 'pin-delete' }), { status: 'deleted', petId: 'pin-delete' });
    assert.equal((await pet('pin-delete').get()).exists, false);
    assert.equal((await pet('pin-delete').listCollections()).length, 0);
    const audits = (await house(H).collection('auditLogs').where('action', '==', 'pet.deleted').get()).docs.map((d) => d.data());
    assert.ok(audits.some((entry) => entry.details?.petId === 'pin-delete' && entry.actorUid === owner.uid && entry.actorEmail === null));
    assert.ok((await activity('pets.pet.delete')).some((entry) => entry.targetName === 'Pet pin-delete'));
    const again = await deletePetFromTablet({ ...pinBase(tablets.pin7, owner.uid, ownerPin, op), petId: 'pin-delete' });
    assert.equal(again.petId, 'pin-delete');
    assert.equal((await activity('pets.pet.delete')).filter((entry) => entry.targetName === 'Pet pin-delete').length, 1);
  });
});

describe('the server writes exactly what the rules accept from the person (replayed as a client)', () => {
  /** Admin values read back as client values of the same instant (nanoseconds kept). */
  const asClient = (value: unknown): unknown => {
    if (value instanceof Timestamp) return new ClientTimestamp(value.seconds, value.nanoseconds);
    if (Array.isArray(value)) return value.map(asClient);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, asClient(child)]));
    }
    return value;
  };
  const withServerTimes = (data: Record<string, unknown>, fields: string[]) => {
    const out: Record<string, unknown> = { ...data };
    delete out.deviceAttribution;
    for (const field of fields) {
      const [outer, inner] = field.split('.');
      if (inner) out[outer] = { ...(out[outer] as Record<string, unknown>), [inner]: serverTimestamp() };
      else out[outer] = serverTimestamp();
    }
    return out;
  };

  /** Runs a dose, puts the log and the course pointer back, then the member writes both as the client does. */
  const doseParity = async (petId: string, run: () => Promise<string>) => {
    const pointerBefore = (await course(petId).get()).data()!;
    const op = await run();
    const logRef = doses(petId).doc(op);
    const log = (await logRef.get()).data()!;
    const after = (await course(petId).get()).data()!;
    assert.ok(log.deviceAttribution, 'the server stores the attribution');
    await logRef.delete();
    await course(petId).update({ lastDose: pointerBefore.lastDose ?? null, prevDose: pointerBefore.prevDose ?? null });
    const live = log.repeat !== 'offline' && log.backdated !== true;
    const batch = writeBatch(memberDb);
    batch.set(doc(memberDb, logRef.path), asClient(withServerTimes(log, live ? ['date', 'loggedAt'] : ['loggedAt'])) as Record<string, unknown>);
    if (log.repeat !== 'offline') {
      const pointer = { lastDose: after.lastDose ?? null, prevDose: after.prevDose ?? null };
      const times = live && after.lastDose?.logId === op ? ['lastDose.givenAt'] : [];
      batch.update(doc(memberDb, course(petId).path), asClient(withServerTimes(pointer, times)) as DocumentData);
    }
    await batch.commit();
    assert.equal((await logRef.get()).exists, true);
  };

  test('a dose now, a confirmed dose, a backdated dose and a queued dose', async () => {
    await seedDosePet('parity-dose');
    await doseParity('parity-dose', async () => { const op = opId(); await give(tablets.parity, member.uid, op, 'parity-dose'); return op; });
    await doseParity('parity-dose', async () => { const op = opId(); await giveSure(tablets.parity, member.uid, op, 'parity-dose'); return op; });
    await doseParity('parity-dose', async () => { const op = opId(); await giveSure(tablets.parity, member.uid, op, 'parity-dose', { givenAt: later(-60 * 60_000).toISOString() }); return op; });
    await doseParity('parity-dose', async () => {
      const op = opId();
      await giveDoseFromTablet({ ...doseRequest(tablets.parity, member.uid, op, 'parity-dose', await prefill('parity-dose')), ...queued(tablets.parity, 60_000) });
      return op;
    });
  });

  test("the dose Undo: the same delete and pointer the person may write (author within 10 minutes)", async () => {
    await seedDosePet('parity-dose-undo');
    const first = opId();
    await give(tablets.parity, member.uid, first, 'parity-dose-undo');
    const op = opId();
    await giveSure(tablets.parity, member.uid, op, 'parity-dose-undo');
    const before = (await course('parity-dose-undo').get()).data()!;
    const log = (await doses('parity-dose-undo').doc(op).get()).data()!;
    assert.equal((await undoDose(tablets.parity, member.uid, op)).status, 'undone');
    const afterUndo = (await course('parity-dose-undo').get()).data()!;
    assert.equal(afterUndo.lastDose.logId, first);
    await doses('parity-dose-undo').doc(op).set(log);
    await course('parity-dose-undo').update({ lastDose: before.lastDose, prevDose: before.prevDose });
    const batch = writeBatch(memberDb);
    batch.delete(doc(memberDb, doses('parity-dose-undo').doc(op).path));
    batch.update(doc(memberDb, course('parity-dose-undo').path), asClient({ lastDose: afterUndo.lastDose, prevDose: afterUndo.prevDose ?? null }) as DocumentData);
    await batch.commit();
    assert.equal((await doses('parity-dose-undo').doc(op).get()).exists, false);
  });

  test('a behaviour note and a weighing (and their Undo: the author within 10 minutes)', async () => {
    await seedPet('parity-records');
    for (const kind of ['note', 'weight'] as const) {
      const op = opId();
      if (kind === 'note') await addNote(tablets.parity, member.uid, op, 'parity-records');
      else await addWeight(tablets.parity, member.uid, op, 'parity-records');
      const ref = (kind === 'note' ? notes : weights)('parity-records').doc(op);
      const data = (await ref.get()).data()!;
      assert.ok(data.deviceAttribution);
      await ref.delete();
      const batch = writeBatch(memberDb);
      batch.set(doc(memberDb, ref.path), asClient(withServerTimes(data, ['loggedAt'])) as Record<string, unknown>);
      await batch.commit();
      const removal = writeBatch(memberDb);
      removal.delete(doc(memberDb, ref.path));
      await removal.commit();
    }
  });

  /** A PIN-level update the owner's own client may write: restore, then set the after state with its server times. */
  const updateParity = async (ref: FirebaseFirestore.DocumentReference, run: () => Promise<unknown>, serverTimes: string[]) => {
    const before = (await ref.get()).data()!;
    await run();
    const after = (await ref.get()).data()!;
    await ref.set(before);
    const batch = writeBatch(ownerDb);
    batch.set(doc(ownerDb, ref.path), asClient(withServerTimes(after, serverTimes)) as Record<string, unknown>);
    await batch.commit();
  };

  test('note pin, course finish, profile edit and meal plan are writes the owner may make', async () => {
    await seedDosePet('parity-pin');
    const note = opId();
    await addNote(tablets.pin2, owner.uid, note, 'parity-pin');
    const ownerPin = await pinOf(tablets.parity, owner);
    const base = () => pinBase(tablets.parity, owner.uid, ownerPin);
    // The tablet's own note keeps its deviceAttribution through the update.
    const noteRef = notes('parity-pin').doc(note);
    const noteBefore = (await noteRef.get()).data()!;
    await setNotePinnedFromTablet({ ...base(), petId: 'parity-pin', noteId: note, pinned: true });
    const noteAfter = (await noteRef.get()).data()!;
    assert.deepEqual(noteAfter.deviceAttribution, noteBefore.deviceAttribution);
    await noteRef.set(noteBefore);
    const pinBatch = writeBatch(ownerDb);
    pinBatch.update(doc(ownerDb, noteRef.path), { pinned: true, pinnedAt: serverTimestamp() });
    await pinBatch.commit();
    await updateParity(course('parity-pin'), () => setCourseFinishedFromTablet({ ...base(), petId: 'parity-pin', courseId: 'course-a', finished: true }), ['finishedAt']);
    await updateParity(pet('parity-pin'), () => editPetProfileFromTablet({ ...base(), petId: 'parity-pin', name: 'Parity Rex', vetClinic: 'Main St Vet', weightUnit: 'lb' }), []);
    const rows = [{ id: 'slot-am', name: 'Breakfast', time: '07:00', amount: '1', unit: 'Cups', offDays: [] }];
    await updateParity(pet('parity-pin'), () => saveMealPlanFromTablet({ ...base(), petId: 'parity-pin', rows }), ['mealPlan.confirmedAt']);
  });
});

describe('F4b-2 review fixes', () => {
  test('S1: a queued dose is classified by its queue time: 11 h is face, 13 h and a forged 23 h need a PIN (never queued)', async () => {
    await seedDosePet('line-queued');
    const key = await prefill('line-queued');
    const face = await giveDoseFromTablet({ ...doseRequest(tablets.line, member.uid, opId(), 'line-queued', key), ...queued(tablets.line, 11 * 60 * 60_000) });
    assert.equal(face.capability, 'pets.dose.give');
    assert.equal(face.result.status, 'saved');
    for (const hours of [13, 23]) {
      await refused(giveDoseFromTablet({ ...doseRequest(tablets.line, member.uid, opId(), 'line-queued', key), ...queued(tablets.line, hours * 60 * 60_000) }), 'pin_required');
    }
    assert.equal((await doses('line-queued').get()).size, 1);
  });

  test('S2: a retry crossing the 12-hour line after the commit gets the recorded answer and capability', async () => {
    await seedDosePet('line-retry');
    const op = opId();
    const givenAt = later(-(12 * 60 - 2) * 60_000).toISOString();
    const first = await give(tablets.line, member.uid, op, 'line-retry', { givenAt });
    assert.equal(first.capability, 'pets.dose.give');
    const retry = await give(tablets.line, member.uid, op, 'line-retry', { givenAt }, later(5 * 60_000));
    assert.equal(retry.capability, 'pets.dose.give');
    assert.equal(retry.result.status, 'saved');
    assert.equal((retry.result as { replayed?: true }).replayed, true);
    assert.equal((await doses('line-retry').get()).size, 1);
  });

  test('S3: an opId reused for another pet, note or log is a conflict, never the first answer', async () => {
    await seedDosePet('reuse-a');
    await seedDosePet('reuse-b');
    const op = opId();
    await give(tablets.review, member.uid, op, 'reuse-a');
    await refused(give(tablets.review, member.uid, op, 'reuse-b'), 'conflict');
    const noteOp = opId();
    await addNote(tablets.review, member.uid, noteOp, 'reuse-a');
    await refused(addNote(tablets.review, member.uid, noteOp, 'reuse-b'), 'conflict');
    await refused(addWeight(tablets.review, member.uid, noteOp, 'reuse-a'), 'conflict');
    const ownerPin = await pinOf(tablets.review, owner);
    const careA = pet('reuse-a').collection('care-logs');
    await careA.doc('care-a').set({ date: new Date().toISOString(), activity: 'Walk', notes: '', loggedByUid: owner.uid, loggedByName: 'Olive' });
    await careA.doc('care-b').set({ date: new Date().toISOString(), activity: 'Walk', notes: '', loggedByUid: owner.uid, loggedByName: 'Olive' });
    const pinOp = opId();
    assert.equal((await deleteLogFromTablet({ ...pinBase(tablets.review, owner.uid, ownerPin, pinOp), petId: 'reuse-a', kind: 'care-logs', logId: 'care-a' })).status, 'deleted');
    await refused(deleteLogFromTablet({ ...pinBase(tablets.review, owner.uid, ownerPin, pinOp), petId: 'reuse-a', kind: 'care-logs', logId: 'care-b' }), 'conflict');
    assert.equal((await careA.doc('care-b').get()).exists, true, 'the other log is untouched');
  });

  test('S3: an Undo never removes a record recreated under the same id by someone else or for another tablet', async () => {
    await seedDosePet('recreate');
    for (const kind of ['note', 'weight', 'dose'] as const) {
      const op = opId();
      const ref = kind === 'note' ? notes('recreate').doc(op) : kind === 'weight' ? weights('recreate').doc(op) : doses('recreate').doc(op);
      if (kind === 'note') await addNote(tablets.review, member.uid, op, 'recreate');
      else if (kind === 'weight') await addWeight(tablets.review, member.uid, op, 'recreate');
      else await giveSure(tablets.review, member.uid, op, 'recreate');
      const data = (await ref.get()).data()!;
      // Deleted and written again under the same id by the owner (no attribution), then as another tablet's.
      await ref.delete();
      await ref.set({ ...data, loggedByUid: owner.uid, loggedByName: 'Olive', deviceAttribution: null });
      await refused((kind === 'note' ? undoNote : kind === 'weight' ? undoWeight : undoDose)(tablets.review, member.uid, op), 'changed_since');
      await ref.delete();
      await ref.set({ ...data, deviceAttribution: { ...data.deviceAttribution, deviceId: tablets.other.deviceId } });
      await refused((kind === 'note' ? undoNote : kind === 'weight' ? undoWeight : undoDose)(tablets.review, member.uid, op), 'changed_since');
      assert.equal((await ref.get()).exists, true, kind);
    }
  });

  test("N1: the author's window closes a few seconds before the rules' (a commit after the deadline is never attempted)", async () => {
    await seedPet('margin');
    const memberPin = await pinOf(tablets.review, member);
    for (const [ago, outcome] of [[10 * 60_000 - 3_000, 'forbidden'], [9 * 60_000, 'deleted']] as const) {
      const op = opId();
      await addNote(tablets.review, member.uid, op, 'margin');
      await notes('margin').doc(op).update({ loggedAt: Timestamp.fromMillis(Date.now() - ago) });
      const attempt = deleteNoteFromTablet({ ...pinBase(tablets.review, member.uid, memberPin), petId: 'margin', noteId: op });
      if (outcome === 'forbidden') await refused(attempt, 'forbidden');
      else assert.equal((await attempt).status, 'deleted');
    }
  });

  test('N5: a care entry may be deleted by its author within 10 minutes of loggedAt, as the rules allow', async () => {
    await seedPet('care-author');
    const memberPin = await pinOf(tablets.review, member);
    const care = pet('care-author').collection('care-logs');
    await care.doc('mine').set({ date: new Date().toISOString(), loggedAt: Timestamp.now(), activity: 'Walk', notes: '', loggedByUid: member.uid, loggedByName: 'Max' });
    await care.doc('old').set({ date: new Date().toISOString(), loggedAt: Timestamp.fromMillis(Date.now() - 11 * 60_000), activity: 'Walk', notes: '', loggedByUid: member.uid, loggedByName: 'Max' });
    assert.equal((await deleteLogFromTablet({ ...pinBase(tablets.review, member.uid, memberPin), petId: 'care-author', kind: 'care-logs', logId: 'mine' })).status, 'deleted');
    await refused(deleteLogFromTablet({ ...pinBase(tablets.review, member.uid, memberPin), petId: 'care-author', kind: 'care-logs', logId: 'old' }), 'forbidden');
  });

  test('N2 and N3: a pet-delete replay answers deleted, never sweeps a pet re-created under the same id; the entry says it came from a tablet', async () => {
    await seedPet('again-pet');
    const ownerPin = await pinOf(tablets.review, owner);
    const op = opId();
    assert.equal((await deletePetFromTablet({ ...pinBase(tablets.review, owner.uid, ownerPin, op), petId: 'again-pet' })).status, 'deleted');
    const entry = (await house(H).collection('auditLogs').where('action', '==', 'pet.deleted').get()).docs.map((d) => d.data()).find((e) => e.details?.petId === 'again-pet')!;
    assert.equal(entry.via, 'device');
    assert.equal(entry.deviceId, tablets.review.deviceId);
    assert.equal(entry.deviceName, 'Review tablet');
    assert.equal(entry.level, 'pin');
    // Someone re-creates a pet under the same id (on purpose); the retry of the old press keeps it whole.
    await seedPet('again-pet');
    await pet('again-pet').collection('notes').doc('kept').set({ text: 'Kept', pinned: false, date: Timestamp.now(), loggedAt: Timestamp.now(), loggedByUid: owner.uid });
    const again = await deletePetFromTablet({ ...pinBase(tablets.review, owner.uid, ownerPin, op), petId: 'again-pet' });
    assert.equal(again.status, 'deleted', 'the stored answer');
    assert.equal((await pet('again-pet').get()).exists, true);
    assert.equal((await pet('again-pet').collection('notes').doc('kept').get()).exists, true);
    // The same opId for another pet is a conflict.
    await seedPet('other-pet');
    await refused(deletePetFromTablet({ ...pinBase(tablets.review, owner.uid, ownerPin, op), petId: 'other-pet' }), 'conflict');
  });
});

describe('S4: every PIN-level write kind replayed through the rules as the member and as the child', () => {
  const asClient = (value: unknown): unknown => {
    if (value instanceof Timestamp) return new ClientTimestamp(value.seconds, value.nanoseconds);
    if (Array.isArray(value)) return value.map(asClient);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, asClient(child)]));
    }
    return value;
  };
  /** Server times as request.time; deviceAttribution kept when the record had it (the rules keep it unchanged). */
  const timed = (data: Record<string, unknown>, fields: string[]) => {
    const out: Record<string, unknown> = { ...data };
    for (const field of fields) {
      const [outer, inner] = field.split('.');
      if (inner) out[outer] = { ...(out[outer] as Record<string, unknown>), [inner]: serverTimestamp() };
      else out[outer] = serverTimestamp();
    }
    return asClient(out) as DocumentData;
  };
  type Ref = FirebaseFirestore.DocumentReference;
  /** An update: run it, put the document back, then the person's client sets the after state. */
  const updateParity = async (db: ClientFirestore, ref: Ref, run: () => Promise<unknown>, serverTimes: string[], extra: Ref[] = []) => {
    const refs = [ref, ...extra];
    const before = await Promise.all(refs.map(async (r) => (await r.get()).data() ?? null));
    const outcome = await run();
    assert.ok(['saved', 'deleted'].includes((outcome as { status?: string }).status ?? ''), JSON.stringify(outcome));
    const after = await Promise.all(refs.map(async (r) => (await r.get()).data() ?? null));
    for (const [index, r] of refs.entries()) { if (before[index]) await r.set(before[index]!); else await r.delete(); }
    const batch = writeBatch(db);
    refs.forEach((r, index) => { if (after[index]) batch.set(doc(db, r.path), timed(after[index]!, index === 0 ? serverTimes : [])); });
    await batch.commit();
  };
  /** A delete: run it, put everything back, then the person's client deletes and writes the derived state or pointer. */
  const deleteParity = async (db: ClientFirestore, ref: Ref, run: () => Promise<unknown>, extra: Array<{ ref: Ref; fields?: string[] }> = []) => {
    const before = (await ref.get()).data()!;
    const extraBefore = await Promise.all(extra.map(async (e) => (await e.ref.get()).data() ?? null));
    assert.equal(((await run()) as { status?: string }).status, 'deleted');
    const extraAfter = await Promise.all(extra.map(async (e) => (await e.ref.get()).data() ?? null));
    await ref.set(before);
    for (const [index, e] of extra.entries()) if (extraBefore[index]) await e.ref.set(extraBefore[index]!);
    const batch = writeBatch(db);
    batch.delete(doc(db, ref.path));
    extra.forEach((e, index) => {
      const after = extraAfter[index];
      if (!after) return;
      if (e.fields) batch.update(doc(db, e.ref.path), timed(Object.fromEntries(e.fields.map((field) => [field, after[field] ?? null])), []));
      else batch.set(doc(db, e.ref.path), timed(after, []));
    });
    await batch.commit();
    assert.equal((await ref.get()).exists, false);
  };
  /** A create: run it, remove it, then the person's client creates it. */
  const createParity = async (db: ClientFirestore, ref: Ref, run: () => Promise<unknown>, serverTimes: string[]) => {
    assert.equal(((await run()) as { status?: string }).status, 'saved');
    const data = (await ref.get()).data()!;
    await ref.delete();
    const batch = writeBatch(db);
    batch.set(doc(db, ref.path), timed(data, serverTimes));
    await batch.commit();
  };

  for (const who of ['member', 'child'] as const) {
    test(`as the ${who}: note pin, unpin, edit and delete; the four log deletes; the time correction; course create, edit, finish, resume and a legacy confirmation`, async () => {
      const person = who === 'member' ? member : child;
      const db = who === 'member' ? memberDb : childDb;
      const face = who === 'member' ? tablets.mFace : tablets.cFace;
      const t = who === 'member' ? tablets.mPin : tablets.cPin;
      const id = `s4-${who}`;
      await seedDosePet(id);
      const pinId = await pinOf(t, person);
      const base = () => pinBase(t, person.uid, pinId);

      // Notes: their own note.
      const note = opId();
      await addNote(face, person.uid, note, id, { text: 'Likes the window' });
      const noteRef = notes(id).doc(note);
      await updateParity(db, noteRef, () => setNotePinnedFromTablet({ ...base(), petId: id, noteId: note, pinned: true }), ['pinnedAt']);
      await updateParity(db, noteRef, () => setNotePinnedFromTablet({ ...base(), petId: id, noteId: note, pinned: false }), []);
      await updateParity(db, noteRef, () => editNoteFromTablet({ ...base(), petId: id, noteId: note, expected: { text: 'Likes the window', tag: 'behaviour' }, text: 'Likes the sunny window', tag: null }), ['editedAt']);
      await deleteParity(db, noteRef, () => deleteNoteFromTablet({ ...base(), petId: id, noteId: note }));

      // Feedings: their own, within 10 minutes (state derived again); then a time correction.
      const stateRef = pet(id).collection('feeding-state').doc('current');
      const fed1 = opId();
      const fed2 = opId();
      await feedPetFromTablet({ idToken: face.idToken, householdId: H, actorUid: person.uid, opId: fed1, petId: id, portion: { amount: 1, unit: 'Cups' }, food: 'Dry', backdatedAt: later(-3 * 60 * 60_000).toISOString() });
      await feedPetFromTablet({ idToken: face.idToken, householdId: H, actorUid: person.uid, opId: fed2, petId: id, portion: { amount: 1, unit: 'Cups' }, food: 'Dry', backdatedAt: later(-60 * 60_000).toISOString() });
      await updateParity(db, pet(id).collection('feeding-logs').doc(fed1), () => correctFeedTimeFromTablet({ ...base(), petId: id, logId: fed1, date: later(-2 * 60 * 60_000).toISOString() }), ['dateCorrectedAt'], [stateRef]);
      await deleteParity(db, pet(id).collection('feeding-logs').doc(fed2), () => deleteLogFromTablet({ ...base(), petId: id, kind: 'feeding-logs', logId: fed2 }), [{ ref: stateRef }]);

      // A care entry with loggedAt (the author window), a weighing, and a dose with its pointer.
      const careRef = pet(id).collection('care-logs').doc(`care-${who}`);
      await careRef.set({ date: new Date().toISOString(), loggedAt: Timestamp.now(), activity: 'Walk', notes: '', loggedByUid: person.uid, loggedByName: person.displayName ?? who });
      await deleteParity(db, careRef, () => deleteLogFromTablet({ ...base(), petId: id, kind: 'care-logs', logId: careRef.id }));
      const weighed = opId();
      await addWeight(face, person.uid, weighed, id);
      await deleteParity(db, weights(id).doc(weighed), () => deleteLogFromTablet({ ...base(), petId: id, kind: 'weights', logId: weighed }));
      const dosed = opId();
      await giveSure(face, person.uid, dosed, id);
      await deleteParity(db, doses(id).doc(dosed), () => deleteLogFromTablet({ ...base(), petId: id, kind: 'medication-logs', logId: dosed }), [{ ref: course(id), fields: ['lastDose', 'prevDose'] }]);

      // Courses (pets.addLogs): create, edit, finish, resume; a legacy medication confirmed.
      const values = { name: `Gaba ${who}`, dosage: '100 mg', kind: 'days', everyDays: '1', times: ['08:00', '20:00'], everyHours: '12', firstTime: '08:00', startDay: householdDay(new Date(), TZ), endDay: '' };
      const newCourse = course(id, `course-${who}`);
      await createParity(db, newCourse, () => saveCourseFromTablet({ ...base(), petId: id, courseId: newCourse.id, create: true, values }), ['createdAt', 'updatedAt']);
      await updateParity(db, newCourse, () => saveCourseFromTablet({ ...base(), petId: id, courseId: newCourse.id, create: false, values: { ...values, times: ['09:00', '21:00'] } }), ['updatedAt']);
      await updateParity(db, newCourse, () => setCourseFinishedFromTablet({ ...base(), petId: id, courseId: newCourse.id, finished: true }), ['finishedAt']);
      await setCourseFinishedFromTablet({ ...base(), petId: id, courseId: newCourse.id, finished: true });
      await updateParity(db, newCourse, () => setCourseFinishedFromTablet({ ...base(), petId: id, courseId: newCourse.id, finished: false }), []);
      const legacy = course(id, legacyCourseId(`legacy-${who}`));
      await createParity(db, legacy, () => saveCourseFromTablet({ ...base(), petId: id, legacyKey: `legacy-${who}`, values: { ...values, name: `Legacy ${who}`, times: ['07:00'] } }), ['createdAt', 'updatedAt']);
    });
  }
});
