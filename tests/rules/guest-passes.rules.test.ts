import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { Timestamp, collection, doc, getDoc, getDocs, setDoc, type Firestore } from 'firebase/firestore';
import { getBytes, ref, uploadBytes } from 'firebase/storage';

// Guest passes (audit HO-14, HO-24; src/lib/guest-pass.ts): a membership record with
// `accessUntil` grants what its role allows only until that time. From then on, before
// any sweep removes it, Firestore and Storage refuse everything the role allowed, and an
// `accessUntil` that is not a timestamp grants nothing (fail closed). Records without
// it are unaffected.

const projectId = 'demo-homehub-e2e';
const H = 'guest-pass-rules-house';
let environment: RulesTestEnvironment;

const owner = { uid: 'gp-owner', email: 'gp.owner@example.test' };
const current = { uid: 'gp-current', email: 'gp.current@example.test' };
const ended = { uid: 'gp-ended', email: 'gp.ended@example.test' };
const malformed = { uid: 'gp-malformed', email: 'gp.malformed@example.test' };
const plainGuest = { uid: 'gp-plain', email: 'gp.plain@example.test' };

const personDb = (person: { uid: string; email: string }): Firestore =>
  environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore;
const personStorage = (person: { uid: string; email: string }) =>
  environment.authenticatedContext(person.uid, { email: person.email }).storage();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PHOTO = `households/${H}/pets/rex/photo.png`;

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
    storage: { rules: readFileSync(process.env.HOMEHUB_STORAGE_RULES ?? 'storage.rules', 'utf8') },
  });
  const hour = 60 * 60 * 1000;
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'households', H), { name: 'Pass House', ownerUid: owner.uid });
    await setDoc(doc(db, 'households', H, 'members', owner.uid), { uid: owner.uid, role: 'owner', status: 'active' });
    await setDoc(doc(db, 'households', H, 'members', current.uid), {
      uid: current.uid, role: 'guest', status: 'active', accessUntil: Timestamp.fromMillis(Date.now() + hour),
    });
    await setDoc(doc(db, 'households', H, 'members', ended.uid), {
      uid: ended.uid, role: 'guest', status: 'active', accessUntil: Timestamp.fromMillis(Date.now() - hour),
    });
    await setDoc(doc(db, 'households', H, 'members', malformed.uid), {
      uid: malformed.uid, role: 'guest', status: 'active', accessUntil: '2099-01-01T00:00:00.000Z',
    });
    await setDoc(doc(db, 'households', H, 'members', plainGuest.uid), { uid: plainGuest.uid, role: 'guest', status: 'active' });
    await setDoc(doc(db, 'households', H, 'chores', 'c1'), { task: 'Dishes', isCompleted: false });
    await uploadBytes(ref(context.storage(), PHOTO), png, { contentType: 'image/png' });
  });
});

after(async () => {
  await environment?.cleanup();
});

describe('guest passes in the rules (HO-14)', () => {
  test('a running pass reads what a guest may read', async () => {
    await assertSucceeds(getDoc(doc(personDb(current), 'households', H)));
    await assertSucceeds(getDocs(collection(personDb(current), 'households', H, 'chores')));
    await assertSucceeds(getDocs(collection(personDb(current), 'households', H, 'members')));
  });

  test('an ended pass reads nothing of the household, though its record still exists', async () => {
    await assertFails(getDoc(doc(personDb(ended), 'households', H)));
    await assertFails(getDocs(collection(personDb(ended), 'households', H, 'chores')));
    await assertFails(getDocs(collection(personDb(ended), 'households', H, 'members')));
    // Their own record stays readable, so the app can say the pass ended.
    await assertSucceeds(getDoc(doc(personDb(ended), 'households', H, 'members', ended.uid)));
  });

  test('a pass end that is not a timestamp grants nothing', async () => {
    await assertFails(getDocs(collection(personDb(malformed), 'households', H, 'chores')));
  });

  test('guests without a pass and owners are unaffected', async () => {
    await assertSucceeds(getDocs(collection(personDb(plainGuest), 'households', H, 'chores')));
    await assertSucceeds(getDocs(collection(personDb(owner), 'households', H, 'chores')));
  });

  test('Storage follows the same end time', async () => {
    await assertSucceeds(getBytes(ref(personStorage(current), PHOTO)));
    await assertFails(getBytes(ref(personStorage(ended), PHOTO)));
    await assertFails(getBytes(ref(personStorage(malformed), PHOTO)));
    await assertSucceeds(getBytes(ref(personStorage(plainGuest), PHOTO)));
  });

  test('nobody can give themselves a pass end or remove one from a client', async () => {
    const db = personDb(current);
    await assertFails(setDoc(doc(db, 'households', H, 'members', current.uid), { accessUntil: null }, { merge: true }));
  });
});
