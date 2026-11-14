import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
  type TokenOptions,
} from '@firebase/rules-unit-testing';
import { Timestamp, deleteDoc, deleteField, doc, getDoc, getDocs, collection, serverTimestamp, setDoc, updateDoc, type Firestore } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage';

// Rules for actors and PINs on wall tablets (docs/modules/devices/README.md, "PINs",
// "Attribution"; design 7.1, 9, 12, S10): PIN documents and the tablet's PIN sessions,
// guards and op ledger are unreadable and unwritable for owners, the member themselves
// and tablets; personal clients can never add, change or remove `deviceAttribution`
// (chores: removal only together with clearing the completion); kid profile photos.

const projectId = 'demo-homehub-e2e';
const H = 'actors-rules-house';
const HB = 'actors-rules-house-b';
const DEV = 'ActorsRulesDevice000';
const KID = 'kid_ActorsRulesKid000000';
let environment: RulesTestEnvironment;

const owner = { uid: 'ar-owner', email: 'ar.owner@example.test' };
const admin = { uid: 'ar-admin', email: 'ar.admin@example.test' };
const member = { uid: 'ar-member', email: 'ar.member@example.test' };
const ownerB = { uid: 'ar-owner-b', email: 'ar.ownerb@example.test' };

const personDb = (person: { uid: string; email: string }): Firestore =>
  environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore;
const deviceClaims = { hh_kind: 'device', hh_household: H, hh_device: DEV, hh_gen: 1, firebase: { sign_in_provider: 'custom', identities: {} } };
const deviceDb = (): Firestore =>
  environment.authenticatedContext(`device_${DEV}`, deviceClaims as unknown as TokenOptions).firestore() as unknown as Firestore;
const deviceStorage = () => environment.authenticatedContext(`device_${DEV}`, deviceClaims as unknown as TokenOptions).storage();
const personStorage = (person: { uid: string; email: string }) => environment.authenticatedContext(person.uid, { email: person.email }).storage();

const attribution = { deviceId: DEV, deviceName: 'Kitchen tablet', generation: 1, actorUid: member.uid, level: 'face' };
let devlogDate: Timestamp;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
    storage: { rules: readFileSync(process.env.HOMEHUB_STORAGE_RULES ?? 'storage.rules', 'utf8') },
  });
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', H), { name: 'H', ownerUid: owner.uid });
    await setDoc(doc(db, 'households', HB), { name: 'B', ownerUid: ownerB.uid });
    await setDoc(doc(db, 'households', H, 'members', owner.uid), { uid: owner.uid, role: 'owner', status: 'active' });
    await setDoc(doc(db, 'households', H, 'members', admin.uid), { uid: admin.uid, role: 'admin', status: 'active' });
    await setDoc(doc(db, 'households', H, 'members', member.uid), { uid: member.uid, role: 'member', status: 'active' });
    await setDoc(doc(db, 'households', H, 'members', KID), { uid: KID, kind: 'identity', role: 'child', status: 'active', displayName: 'Mia' });
    await setDoc(doc(db, 'households', HB, 'members', ownerB.uid), { uid: ownerB.uid, role: 'owner', status: 'active' });
    await setDoc(doc(db, 'households', H, 'devices', DEV), {
      name: 'Kitchen tablet', room: 'Kitchen', status: 'active', generation: 1,
      sections: { chores: true, shopping: true, pets: true, calendar: true, maintenance: true },
    });
    for (const uid of [owner.uid, member.uid, KID]) {
      await setDoc(doc(db, 'households', H, 'members', uid, 'private', 'pin'), { hash: 'aGFzaA==', salt: 'c2FsdA==', pepperId: 'p1', pinVersion: 1 });
      await setDoc(doc(db, 'households', H, 'members', uid, 'private', 'pinGuard'), { recentFailures: [], lockedAt: null });
    }
    await setDoc(doc(db, 'households', H, 'devices', DEV, 'pinSessions', 's1'), { memberUid: member.uid, generation: 1 });
    await setDoc(doc(db, 'households', H, 'devices', DEV, 'pinGuards', member.uid), { failures: 0 });
    await setDoc(doc(db, 'households', H, 'devices', DEV, 'ops', 'op1'), { state: 'applied' });
    // Records a device action wrote (Admin SDK) carry deviceAttribution.
    await setDoc(doc(db, 'households', H, 'pets', 'p1'), { name: 'Rex' });
    // Written moments ago by the member at a tablet: inside the author's 10-minute window,
    // so a time correction (the only feeding-log update, P1) is theirs to make.
    devlogDate = Timestamp.fromMillis(Date.now() - 60_000);
    await setDoc(doc(db, 'households', H, 'pets', 'p1', 'feeding-logs', 'devlog'), {
      date: devlogDate, cups: 1, repeat: 'none', backdated: false,
      loggedAt: Timestamp.now(), loggedByUid: member.uid, loggedByName: 'Max', deviceAttribution: attribution,
    });
    await setDoc(doc(db, 'households', H, 'pets', 'p1', 'medication-logs', 'devlog'), { date: '2026-11-14', medication: 'X', loggedByUid: member.uid, deviceAttribution: attribution });
    await setDoc(doc(db, 'households', H, 'pets', 'p1', 'care-logs', 'devlog'), { date: '2026-11-14', activity: 'Walk', loggedByUid: member.uid, deviceAttribution: attribution });
    await setDoc(doc(db, 'households', H, 'chores', 'devdone'), {
      task: 'Dishes', isCompleted: true, completedAt: '2026-11-14T10:00:00.000Z', completedAtServer: Timestamp.now(),
      completedByUid: member.uid, completionId: 'op1', deviceAttribution: attribution,
    });
    await setDoc(doc(db, 'households', H, 'chores', 'plain'), { task: 'Bins', isCompleted: false });
    await setDoc(doc(db, 'households', H, 'pets', 'p1', 'medication-logs', 'plain'), { date: '2026-11-14', medication: 'X', loggedByUid: member.uid });
    await uploadBytes(ref(context.storage(), `households/${H}/members/${KID}/avatar/a.png`), png, { contentType: 'image/png' });
  });
});

after(async () => environment?.cleanup());

describe('PIN material: no client reads or writes it (WT-17f)', () => {
  const pinPaths = (uid: string) => [['members', uid, 'private', 'pin'], ['members', uid, 'private', 'pinGuard']];
  const devicePaths = [['devices', DEV, 'pinSessions', 's1'], ['devices', DEV, 'pinGuards', member.uid], ['devices', DEV, 'ops', 'op1']];

  test('owner, the member themselves and the tablet cannot get, list, create, update or delete PIN documents', async () => {
    const readers: Array<[string, Firestore]> = [['owner', personDb(owner)], ['admin', personDb(admin)], ['member', personDb(member)], ['device', deviceDb()]];
    for (const [, db] of readers) {
      for (const uid of [owner.uid, member.uid, KID]) {
        for (const path of pinPaths(uid)) {
          const target = doc(db, 'households', H, ...path);
          await assertFails(getDoc(target));
          await assertFails(setDoc(target, { hash: 'x', pinVersion: 9 }));
          await assertFails(updateDoc(target, { pinVersion: 9 }));
          await assertFails(deleteDoc(target));
        }
        await assertFails(getDocs(collection(db, 'households', H, 'members', uid, 'private')));
      }
    }
    // The member's own contact document stays readable to them (regression).
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'households', H, 'members', member.uid, 'private', 'contact'), { email: member.email });
    });
    await assertSucceeds(getDoc(doc(personDb(member), 'households', H, 'members', member.uid, 'private', 'contact')));
  });

  test("a tablet's PIN sessions, guards and op ledger are unreadable and unwritable for everyone", async () => {
    for (const db of [personDb(owner), personDb(member), deviceDb()]) {
      for (const path of devicePaths) {
        const target = doc(db, 'households', H, ...path);
        await assertFails(getDoc(target));
        await assertFails(setDoc(target, { forged: true }));
        await assertFails(deleteDoc(target));
      }
      await assertFails(getDocs(collection(db, 'households', H, 'devices', DEV, 'pinSessions')));
    }
  });

  test('membership records (kid profiles included) are never client-writable; a kid record cannot be forged', async () => {
    await assertFails(setDoc(doc(personDb(owner), 'households', H, 'members', 'kid_Forged00000000000000'), { uid: 'kid_Forged00000000000000', kind: 'identity', role: 'child', status: 'active' }));
    await assertFails(updateDoc(doc(personDb(owner), 'households', H, 'members', KID), { role: 'admin' }));
    await assertFails(updateDoc(doc(personDb(owner), 'households', H, 'members', member.uid), { kind: 'identity' }));
    await assertFails(setDoc(doc(deviceDb(), 'households', H, 'members', KID), { role: 'owner' }));
    await assertSucceeds(getDoc(doc(deviceDb(), 'households', H, 'members', KID)));
  });
});

describe('deviceAttribution: personal clients never add, change or remove it (S10)', () => {
  const db = () => personDb(member);

  test('creates carrying it are refused in every collection a device writes to (positive control without it)', async () => {
    // A valid P1 create: a backdated feed (operation fields, server loggedAt, device time).
    const feeding = {
      date: Timestamp.fromMillis(Date.now() - 2 * 3600_000), cups: 1, loggedByUid: member.uid, loggedByName: 'Max',
      loggedAt: serverTimestamp(), repeat: 'none', backdated: true,
    };
    await assertFails(setDoc(doc(db(), 'households', H, 'pets', 'p1', 'feeding-logs', 'n1'), { ...feeding, deviceAttribution: attribution }));
    await assertSucceeds(setDoc(doc(db(), 'households', H, 'pets', 'p1', 'feeding-logs', 'n1'), feeding));
    const med = { date: '2026-11-14', medication: 'X', loggedByUid: member.uid };
    await assertFails(setDoc(doc(db(), 'households', H, 'pets', 'p1', 'medication-logs', 'n1'), { ...med, deviceAttribution: attribution }));
    await assertSucceeds(setDoc(doc(db(), 'households', H, 'pets', 'p1', 'medication-logs', 'n1'), med));
    const care = { date: '2026-11-14', activity: 'Walk', loggedByUid: member.uid };
    await assertFails(setDoc(doc(db(), 'households', H, 'pets', 'p1', 'care-logs', 'n1'), { ...care, deviceAttribution: attribution }));
    await assertSucceeds(setDoc(doc(db(), 'households', H, 'pets', 'p1', 'care-logs', 'n1'), care));
    await assertFails(setDoc(doc(db(), 'households', H, 'chores', 'n1'), { task: 'Mop', isCompleted: false, deviceAttribution: attribution }));
    await assertSucceeds(setDoc(doc(db(), 'households', H, 'chores', 'n1'), { task: 'Mop', isCompleted: false }));
    await assertFails(setDoc(doc(db(), 'households', H, 'pets', 'p1', 'feeding-state', 'current'), {
      lastLogId: 'n1', lastFedAt: Timestamp.now(), lastFedByUid: member.uid, lastFedByName: 'Max', day: '2026-11-14', countOnDay: 1, deviceAttribution: attribution,
    }));
  });

  test('updates may not add it to a personal record', async () => {
    await assertFails(updateDoc(doc(db(), 'households', H, 'pets', 'p1', 'medication-logs', 'plain'), { deviceAttribution: attribution }));
    await assertFails(updateDoc(doc(db(), 'households', H, 'chores', 'plain'), { deviceAttribution: attribution }));
    await assertSucceeds(updateDoc(doc(db(), 'households', H, 'pets', 'p1', 'medication-logs', 'plain'), { dosage: '1 tab' }));
  });

  test('updates may not change or remove it on a device-written record; other edits keep it and pass', async () => {
    for (const name of ['feeding-logs', 'medication-logs', 'care-logs']) {
      const target = doc(db(), 'households', H, 'pets', 'p1', name, 'devlog');
      await assertFails(updateDoc(target, { deviceAttribution: { ...attribution, level: 'pin' } }));
      await assertFails(updateDoc(target, { 'deviceAttribution.actorUid': owner.uid }));
      await assertFails(updateDoc(target, { deviceAttribution: deleteField() }));
    }
    await assertSucceeds(updateDoc(doc(db(), 'households', H, 'pets', 'p1', 'care-logs', 'devlog'), { notes: 'Long walk' }));
    // The only feeding-log update (P1): a time correction by its author, which keeps the attribution.
    await assertSucceeds(updateDoc(doc(db(), 'households', H, 'pets', 'p1', 'feeding-logs', 'devlog'), {
      date: Timestamp.fromMillis(Date.now() - 30 * 60_000), originalDate: devlogDate,
      dateCorrectedAt: serverTimestamp(), dateCorrectedByUid: member.uid,
    }));
    // The same correction that also strips the attribution is refused.
    await assertFails(updateDoc(doc(db(), 'households', H, 'pets', 'p1', 'feeding-logs', 'devlog'), {
      date: Timestamp.fromMillis(Date.now() - 20 * 60_000), dateCorrectedAt: serverTimestamp(), dateCorrectedByUid: member.uid,
      deviceAttribution: deleteField(),
    }));
  });

  test('chores: attribution leaves only with the completion it describes', async () => {
    const chore = doc(db(), 'households', H, 'chores', 'devdone');
    await assertFails(updateDoc(chore, { deviceAttribution: { ...attribution, actorUid: owner.uid } }));
    await assertFails(updateDoc(chore, { deviceAttribution: deleteField() }));
    await assertFails(updateDoc(chore, { deviceAttribution: deleteField(), notes: 'x' }));
    await assertSucceeds(updateDoc(chore, { notes: 'kept attribution' }));
    // Reopening (chores.edit holders) removes the completion and its attribution together.
    await assertSucceeds(updateDoc(chore, {
      isCompleted: false, completedAt: null, completedAtServer: null, deviceAttribution: deleteField(),
    }));
    // A completion can never bring a forged one back.
    await assertFails(updateDoc(chore, { isCompleted: true, completedAtServer: serverTimestamp(), deviceAttribution: attribution }));
  });
});

describe('kid profile photos (storage)', () => {
  const path = `households/${H}/members/${KID}/avatar/b.png`;

  test('owners and admins upload and delete; members read; tablets read; nobody else writes', async () => {
    await assertSucceeds(uploadBytes(ref(personStorage(admin), path), png, { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(personStorage(member), `households/${H}/members/${KID}/avatar/c.png`), png, { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(personStorage(ownerB), `households/${H}/members/${KID}/avatar/d.png`), png, { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(personStorage(owner), `households/${H}/members/${member.uid}/avatar/e.png`), png, { contentType: 'image/png' }));
    await assertFails(uploadBytes(ref(personStorage(owner), `households/${H}/members/${KID}/avatar/f.txt`), png, { contentType: 'text/plain' }));
    await assertFails(uploadBytes(ref(deviceStorage(), `households/${H}/members/${KID}/avatar/g.png`), png, { contentType: 'image/png' }));
    await assertSucceeds(getBytes(ref(personStorage(member), `households/${H}/members/${KID}/avatar/a.png`)));
    await assertSucceeds(getBytes(ref(deviceStorage(), `households/${H}/members/${KID}/avatar/a.png`)));
    await assertFails(getBytes(ref(personStorage(ownerB), `households/${H}/members/${KID}/avatar/a.png`)));
    await assertFails(getBytes(ref(environment.unauthenticatedContext().storage(), `households/${H}/members/${KID}/avatar/a.png`)));
    await assertFails(deleteObject(ref(personStorage(member), path)));
    await assertSucceeds(deleteObject(ref(personStorage(owner), path)));
  });
});
