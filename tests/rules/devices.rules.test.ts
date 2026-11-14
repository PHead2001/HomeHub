import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
  type TokenOptions,
} from '@firebase/rules-unit-testing';
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';

// Firestore rules for registered wall tablets (device principals), section 5 of
// docs/modules/devices/README.md: every read clause per collection (positive,
// unauthenticated, wrong generation, removed/unpaired, household being deleted,
// other household, section off, forged claims), every device write denied, the
// exact notification list queries, private and personal data never readable.

const projectId = 'demo-homehub-e2e';
const H = 'dev-rules-house';
const HB = 'dev-rules-house-b';
const HDEL = 'dev-rules-deleting';
const HLEGACY = 'dev-rules-legacy';
let environment: RulesTestEnvironment;

const id20 = (prefix: string) => prefix.padEnd(20, '0');
const D = {
  active: id20('DevActive'),
  off: id20('DevOff'),
  removed: id20('DevRemoved'),
  unpaired: id20('DevUnpaired'),
  deleting: id20('DevDeleting'),
  legacy: id20('DevLegacy'),
  b: id20('DevB'),
};

const people = {
  owner: { uid: 'dr-owner', email: 'dr.owner@example.test' },
  admin: { uid: 'dr-admin', email: 'dr.admin@example.test' },
  member: { uid: 'dr-member', email: 'dr.member@example.test' },
  ownerB: { uid: 'dr-owner-b', email: 'dr.ownerb@example.test' },
};

const allOn = { chores: true, shopping: true, pets: true, calendar: true, maintenance: true };
const allOff = { chores: false, shopping: false, pets: false, calendar: false, maintenance: false };

type TokenExtra = Record<string, unknown>;
const deviceClaims = (deviceId: string, household: string, gen: number, extra: TokenExtra = {}) => ({
  hh_kind: 'device',
  hh_household: household,
  hh_device: deviceId,
  hh_gen: gen,
  firebase: { sign_in_provider: 'custom', identities: {} },
  ...extra,
});

const deviceDb = (deviceId: string, household = H, gen = 2, extra: TokenExtra = {}, uid = `device_${deviceId}`): Firestore =>
  environment.authenticatedContext(uid, deviceClaims(deviceId, household, gen, extra) as unknown as TokenOptions).firestore() as unknown as Firestore;
const activeDb = () => deviceDb(D.active);
const personDb = (person: { uid: string; email: string }): Firestore =>
  environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore;
const anonDb = (): Firestore => environment.unauthenticatedContext().firestore() as unknown as Firestore;

const ts = Timestamp.fromDate(new Date('2026-08-01T12:00:00.000Z'));
const inMinutes = (minutes: number) => Timestamp.fromMillis(Date.now() + minutes * 60_000);

/** Household paths a tablet reads, with the section that opens them (null: any active tablet). */
const SECTION_DOCS: Array<{ section: 'chores' | 'shopping' | 'pets' | 'maintenance'; path: string[] }> = [
  { section: 'chores', path: ['chores', 'c1'] },
  { section: 'chores', path: ['chore-settings', 'preferences'] },
  { section: 'chores', path: ['chore-templates', 't1'] },
  { section: 'chores', path: ['rooms', 'r1'] },
  { section: 'chores', path: ['stats', 'chores-2026'] },
  { section: 'shopping', path: ['shopping-lists', 'l1'] },
  { section: 'shopping', path: ['shopping-lists', 'l1', 'items', 'i1'] },
  { section: 'shopping', path: ['shopping-lists', 'l1', 'config', 'categories'] },
  { section: 'shopping', path: ['pantry-inventory', 'p1'] },
  { section: 'shopping', path: ['barcode-library', '1234567890123'] },
  { section: 'shopping', path: ['stores', 's1'] },
  { section: 'shopping', path: ['shopping-settings', 'preferences'] },
  { section: 'shopping', path: ['trips', 't1'] },
  { section: 'shopping', path: ['shopping-usuals', 'milk'] },
  { section: 'pets', path: ['pets', 'p1'] },
  { section: 'pets', path: ['pets', 'p1', 'feeding-logs', 'f1'] },
  { section: 'pets', path: ['pets', 'p1', 'feeding-state', 'current'] },
  { section: 'pets', path: ['pets', 'p1', 'medication-logs', 'm1'] },
  { section: 'pets', path: ['pets', 'p1', 'care-logs', 'k1'] },
  { section: 'maintenance', path: ['home-assets', 'a1'] },
  { section: 'maintenance', path: ['vehicles', 'v1'] },
  { section: 'maintenance', path: ['maintenance', 'm1'] },
  { section: 'maintenance', path: ['maintenance-attachments', 'x1'] },
];

/** Household paths a tablet never reads. */
const NEVER_HOUSEHOLD_DOCS: string[][] = [
  ['auditLogs', 'a1'],
  ['home-automation', 'config'],
  ['members', 'dr-member', 'private', 'contact'],
  ['members', 'dr-member', 'private', 'pin'],
  ['members', 'dr-member', 'private', 'pinGuard'],
  ['devices', D.active, 'ops', 'o1'],
  ['devices', D.active, 'pinSessions', 's1'],
  ['devices', D.active, 'pinGuards', 'dr-member'],
  ['devices', D.off],
  ['unknown-collection', 'x1'],
  ['notifications', 'n-target'],
  ['notifications', 'n-automation'],
];

const NOTIFICATION_CATEGORIES = ['chores', 'pets', 'shopping', 'maintenance', 'system', 'general'] as const;

const hdoc = (db: Firestore, household: string, path: string[]) => doc(db, 'households', household, ...path);

const deviceRecord = (status: string, generation: number, sections: Record<string, boolean> = allOn) => ({
  id: 'ignored', name: 'Kitchen tablet', room: 'Kitchen', status, generation, sections,
  startPage: { kind: 'home' },
});

const seedHousehold = async (db: Firestore, household: string, data: Record<string, unknown>) => {
  await setDoc(doc(db, 'households', household), data);
  for (const { path } of SECTION_DOCS) await setDoc(hdoc(db, household, path), { name: 'x', task: 'x', createdAt: '2026-08-01' });
  await setDoc(hdoc(db, household, ['auditLogs', 'a1']), { action: 'x' });
  await setDoc(hdoc(db, household, ['home-automation', 'config']), { token: 'secret' });
  await setDoc(hdoc(db, household, ['unknown-collection', 'x1']), { x: 1 });
  for (const category of [...NOTIFICATION_CATEGORIES, 'automation']) {
    await setDoc(hdoc(db, household, ['notifications', `n-${category}`]), {
      householdId: household, category, message: 'hello', audience: ['*'], createdAt: ts, expiresAt: inMinutes(60), readBy: {}, dismissedBy: {},
    });
  }
  await setDoc(hdoc(db, household, ['notifications', 'n-target']), {
    householdId: household, category: 'chores', message: 'for one', audience: [people.member.uid], targetUserUid: people.member.uid,
    createdAt: ts, expiresAt: inMinutes(60), readBy: {}, dismissedBy: {},
  });
};

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore() as unknown as Firestore;
    await seedHousehold(db, H, { name: 'Device House', ownerUid: people.owner.uid });
    await seedHousehold(db, HB, { name: 'Other House', ownerUid: people.ownerB.uid });
    await seedHousehold(db, HDEL, { name: 'Deleting House', ownerUid: people.owner.uid, deletingAt: ts });
    await seedHousehold(db, HLEGACY, { name: 'Legacy House', ownerUid: people.owner.uid, memberEmails: [people.owner.email] });
    for (const [person, role, perms] of [
      [people.owner, 'owner', {}],
      [people.admin, 'admin', {}],
      // A member who may manage invites still never reads device codes or records.
      [people.member, 'member', { 'household.manageInvites': true }],
    ] as const) {
      await setDoc(doc(db, 'households', H, 'members', person.uid), { uid: person.uid, role, status: 'active', displayName: person.uid, permissions: perms });
    }
    await setDoc(doc(db, 'households', HB, 'members', people.ownerB.uid), { uid: people.ownerB.uid, role: 'owner', status: 'active' });
    await setDoc(doc(db, 'households', H, 'members', 'dr-member', 'private', 'contact'), { email: people.member.email });
    await setDoc(doc(db, 'households', H, 'members', 'dr-member', 'private', 'pin'), { hash: 'x' });
    await setDoc(doc(db, 'households', H, 'members', 'dr-member', 'private', 'pinGuard'), { failures: 0 });

    await setDoc(doc(db, 'households', H, 'devices', D.active), deviceRecord('active', 2));
    await setDoc(doc(db, 'households', H, 'devices', D.off), deviceRecord('active', 2, allOff));
    await setDoc(doc(db, 'households', H, 'devices', D.removed), deviceRecord('removed', 3));
    await setDoc(doc(db, 'households', H, 'devices', D.unpaired), deviceRecord('unpaired', 2));
    await setDoc(doc(db, 'households', H, 'devices', D.active, 'ops', 'o1'), { state: 'applied' });
    await setDoc(doc(db, 'households', H, 'devices', D.active, 'pinSessions', 's1'), { memberUid: 'x' });
    await setDoc(doc(db, 'households', H, 'devices', D.active, 'pinGuards', 'dr-member'), { failures: 1 });
    await setDoc(doc(db, 'households', HDEL, 'devices', D.deleting), deviceRecord('active', 2));
    await setDoc(doc(db, 'households', HLEGACY, 'devices', D.legacy), deviceRecord('active', 2));
    await setDoc(doc(db, 'households', HB, 'devices', D.b), deviceRecord('active', 2));
    // The same device id registered active in household B: a helper that read only the
    // token would let household A's tablet into B. Every helper uses the path's household.
    await setDoc(doc(db, 'households', HB, 'devices', D.active), deviceRecord('active', 2));

    await setDoc(doc(db, 'inviteCodes', 'INVT-CODE-AA'), { householdId: H, code: 'INVT-CODE-AA' });
    await setDoc(doc(db, 'deviceCodes', 'DEVC-CODE-AA'), { householdId: H, code: 'DEVC-CODE-AA', kind: 'pair', createdByUid: people.owner.uid });
    await setDoc(doc(db, 'users', people.member.email), { email: people.member.email, displayName: 'Member' });
    await setDoc(doc(db, 'users', people.member.email, 'private', 'push'), { fcmTokens: ['t'] });
    await setDoc(doc(db, 'users', people.member.email, 'notifications', 'n1'), { message: 'x' });
    await setDoc(doc(db, 'aiUsage', 'u1'), { count: 1 });
  });
});

after(async () => {
  await environment?.cleanup();
});

const read = (db: Firestore, household: string, path: string[]) => getDoc(hdoc(db, household, path));

describe('device reads of household data (positive)', () => {
  test('an active tablet reads the household document and members (get and list)', async () => {
    const db = activeDb();
    await assertSucceeds(getDoc(doc(db, 'households', H)));
    await assertSucceeds(getDoc(doc(db, 'households', H, 'members', people.owner.uid)));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'members')));
  });

  for (const { section, path } of SECTION_DOCS) {
    test(`an active tablet with ${section} on reads ${path.join('/')}`, async () => {
      await assertSucceeds(read(activeDb(), H, path));
    });
  }

  test('a tablet reads its own record in every status, and nothing else under devices', async () => {
    await assertSucceeds(getDoc(doc(activeDb(), 'households', H, 'devices', D.active)));
    await assertSucceeds(getDoc(doc(deviceDb(D.removed, H, 3), 'households', H, 'devices', D.removed)));
    await assertSucceeds(getDoc(doc(deviceDb(D.removed, H, 2), 'households', H, 'devices', D.removed)));
    await assertSucceeds(getDoc(doc(deviceDb(D.unpaired), 'households', H, 'devices', D.unpaired)));
    await assertSucceeds(getDoc(doc(deviceDb(D.deleting, HDEL), 'households', HDEL, 'devices', D.deleting)));
    await assertFails(getDoc(doc(activeDb(), 'households', H, 'devices', D.off)));
    await assertFails(getDocs(collection(activeDb(), 'households', H, 'devices')));
    // Its own record in another household's path: the token names household H only.
    await assertFails(getDoc(doc(activeDb(), 'households', HB, 'devices', D.active)));
  });
});

describe('device reads refused', () => {
  const refusedEverywhere = (label: string, db: () => Firestore, household = H) => {
    test(`${label}: no household document, member, or section data`, async () => {
      await assertFails(getDoc(doc(db(), 'households', household)));
      await assertFails(getDoc(doc(db(), 'households', household, 'members', people.owner.uid)));
      await assertFails(getDocs(collection(db(), 'households', household, 'members')));
      for (const { path } of SECTION_DOCS) await assertFails(read(db(), household, path));
      for (const category of NOTIFICATION_CATEGORIES) await assertFails(read(db(), household, ['notifications', `n-${category}`]));
    });
  };

  refusedEverywhere('unauthenticated', anonDb);
  refusedEverywhere('wrong generation (older)', () => deviceDb(D.active, H, 1));
  refusedEverywhere('wrong generation (newer)', () => deviceDb(D.active, H, 3));
  refusedEverywhere('removed tablet', () => deviceDb(D.removed, H, 3));
  refusedEverywhere('unpaired tablet', () => deviceDb(D.unpaired, H, 2));
  refusedEverywhere('household being deleted', () => deviceDb(D.deleting, HDEL), HDEL);
  refusedEverywhere('unregistered device id', () => deviceDb(id20('DevNobody'), H, 1));
  // Household A's active tablet against household B, where a record with its id exists.
  refusedEverywhere('other household (same device id registered there)', activeDb, HB);
  refusedEverywhere('household B tablet in household A', () => deviceDb(D.b, HB), H);

  refusedEverywhere('forged: hh_device does not match the uid', () => deviceDb(D.active, H, 2, {}, `device_${D.off}`));
  refusedEverywhere('forged: uid without the device_ prefix', () => deviceDb(D.active, H, 2, {}, D.active));
  refusedEverywhere('forged: no sign_in_provider', () => deviceDb(D.active, H, 2, { firebase: { identities: {} } }));
  refusedEverywhere('forged: Google sign-in provider', () => deviceDb(D.active, H, 2, { firebase: { sign_in_provider: 'google.com', identities: {} } }));
  refusedEverywhere('forged: an email beside the device claims', () => deviceDb(D.active, H, 2, { email: 'tablet@example.test' }));
  refusedEverywhere('forged: hh_gen as a string', () => deviceDb(D.active, H, 2, { hh_gen: '2' }));
  refusedEverywhere('forged: no hh_kind', () => deviceDb(D.active, H, 2, { hh_kind: 'person' }));

  test('section off: a tablet with every section off reads no section data, but the household and members', async () => {
    const db = deviceDb(D.off);
    for (const { path } of SECTION_DOCS) await assertFails(read(db, H, path));
    await assertSucceeds(getDoc(doc(db, 'households', H)));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'members')));
  });

  test('a household that still carries legacy email fields: no household document (section data still per section)', async () => {
    const db = deviceDb(D.legacy, HLEGACY);
    await assertFails(getDoc(doc(db, 'households', HLEGACY)));
    await assertSucceeds(read(db, HLEGACY, ['chores', 'c1']));
  });

  test('never readable by an active tablet: private member data, activity, automation, ops, other records, targeted notices', async () => {
    const db = activeDb();
    for (const path of NEVER_HOUSEHOLD_DOCS) await assertFails(read(db, H, path));
    await assertFails(getDocs(collection(db, 'households', H, 'auditLogs')));
    await assertFails(getDocs(collection(db, 'households', H, 'members', 'dr-member', 'private')));
    await assertFails(getDocs(collection(db, 'households', H, 'devices', D.active, 'ops')));
  });

  test('never readable by an active tablet: invite and device codes, profiles, push tokens, personal inbox, AI usage', async () => {
    const db = activeDb();
    await assertFails(getDoc(doc(db, 'inviteCodes', 'INVT-CODE-AA')));
    await assertFails(getDoc(doc(db, 'deviceCodes', 'DEVC-CODE-AA')));
    await assertFails(getDocs(query(collection(db, 'deviceCodes'), where('householdId', '==', H))));
    await assertFails(getDoc(doc(db, 'users', people.member.email)));
    await assertFails(getDoc(doc(db, 'users', people.member.email, 'private', 'push')));
    await assertFails(getDoc(doc(db, 'users', people.member.email, 'notifications', 'n1')));
    await assertFails(getDocs(collection(db, 'users')));
    await assertFails(getDoc(doc(db, 'aiUsage', 'u1')));
  });
});

describe('the list queries a tablet runs', () => {
  const recent = (db: Firestore, household: string, category: string) => query(
    collection(db, 'households', household, 'notifications'),
    where('audience', 'array-contains', '*'),
    where('category', '==', category),
    orderBy('createdAt', 'desc'),
    limit(50),
  );

  for (const category of NOTIFICATION_CATEGORIES) {
    test(`notifications: the ${category} query is allowed while its source is shown`, async () => {
      const snapshot = await assertSucceeds(getDocs(recent(activeDb(), H, category)));
      assert.deepEqual(snapshot.docs.map(d => d.id), [`n-${category}`]);
    });
  }

  test('notifications: module categories are refused when the section is off; system and general stay', async () => {
    const db = deviceDb(D.off);
    for (const category of ['chores', 'pets', 'shopping', 'maintenance']) await assertFails(getDocs(recent(db, H, category)));
    await assertSucceeds(getDocs(recent(db, H, 'system')));
    await assertSucceeds(getDocs(recent(db, H, 'general')));
  });

  test('notifications: every other query shape is refused', async () => {
    const db = activeDb();
    const ref = collection(db, 'households', H, 'notifications');
    await assertFails(getDocs(recent(db, H, 'automation')));
    await assertFails(getDocs(query(ref, where('audience', 'array-contains', '*'), orderBy('createdAt', 'desc'), limit(50))));
    await assertFails(getDocs(query(ref, where('audience', 'array-contains-any', [people.member.uid, '*']), where('category', '==', 'chores'))));
    await assertFails(getDocs(query(ref, where('audience', 'array-contains', people.member.uid), where('category', '==', 'chores'))));
    await assertFails(getDocs(query(ref, where('category', '==', 'chores'))));
    await assertFails(getDocs(query(ref, where('audience', 'array-contains', '*'), where('category', 'in', ['chores', 'automation']))));
    await assertFails(getDocs(query(collection(deviceDb(D.off), 'households', H, 'notifications'),
      where('audience', 'array-contains', '*'), where('category', 'in', ['system', 'pets']))));
    await assertFails(getDoc(doc(db, 'households', H, 'notifications', 'n-target')));
  });

  test('the section lists a tablet opens (members, chores, shopping, pets, maintenance)', async () => {
    const db = activeDb();
    await assertSucceeds(getDocs(collection(db, 'households', H, 'members')));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'chores')));
    await assertSucceeds(getDocs(query(collection(db, 'households', H, 'chores'), where('isCompleted', '==', false))));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'rooms')));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'shopping-lists')));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'shopping-lists', 'l1', 'items')));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'pets')));
    await assertSucceeds(getDocs(query(collection(db, 'households', H, 'pets', 'p1', 'feeding-logs'), orderBy('createdAt', 'desc'), limit(20))));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'pets', 'p1', 'feeding-state')));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'home-assets')));
    await assertSucceeds(getDocs(collection(db, 'households', H, 'maintenance')));
    const off = deviceDb(D.off);
    await assertFails(getDocs(collection(off, 'households', H, 'chores')));
    await assertFails(getDocs(collection(off, 'households', H, 'pets')));
    await assertFails(getDocs(collection(deviceDb(D.removed, H, 3), 'households', H, 'members')));
  });
});

describe('no device client writes', () => {
  const writable: string[][] = [
    ...SECTION_DOCS.map(entry => entry.path),
    ['notifications', 'n-system'],
    ['members', people.owner.uid],
    ['members', 'dr-member', 'private', 'contact'],
    ['devices', D.active],
    ['devices', D.active, 'ops', 'o1'],
    ['auditLogs', 'a1'],
  ];

  for (const path of writable) {
    test(`an active tablet cannot create, update or delete ${path.join('/')}`, async () => {
      const db = activeDb();
      await assertFails(setDoc(hdoc(db, H, [...path.slice(0, -1), `${path[path.length - 1]}-new`]), { name: 'new', task: 'new' }));
      await assertFails(updateDoc(hdoc(db, H, path), { name: 'changed' }));
      await assertFails(deleteDoc(hdoc(db, H, path)));
    });
  }

  test('an active tablet cannot change its own comfort settings directly, the household, codes or profiles', async () => {
    const db = activeDb();
    await assertFails(updateDoc(doc(db, 'households', H, 'devices', D.active), { 'comfort.theme': 'dark' }));
    await assertFails(updateDoc(doc(db, 'households', H), { timeZone: 'UTC' }));
    await assertFails(setDoc(doc(db, 'households', H, 'notifications', 'n-new'), {
      householdId: H, category: 'system', message: 'hi', audience: ['*'], createdAt: inMinutes(0), expiresAt: inMinutes(60), readBy: {}, dismissedBy: {},
    }));
    await assertFails(setDoc(doc(db, 'deviceCodes', 'DEVC-CODE-BB'), { householdId: H }));
    await assertFails(setDoc(doc(db, 'inviteCodes', 'INVT-CODE-BB'), { householdId: H }));
    await assertFails(setDoc(doc(db, 'users', 'device@example.test'), { email: 'device@example.test', role: 'member' }));
    await assertFails(setDoc(doc(db, 'households', 'new-house-by-device'), { name: 'x' }));
  });
});

describe('devices and deviceCodes for people', () => {
  test('owners and admins read and list device records; members cannot', async () => {
    for (const person of [people.owner, people.admin]) {
      await assertSucceeds(getDoc(doc(personDb(person), 'households', H, 'devices', D.active)));
      await assertSucceeds(getDocs(collection(personDb(person), 'households', H, 'devices')));
    }
    await assertFails(getDoc(doc(personDb(people.member), 'households', H, 'devices', D.active)));
    await assertFails(getDocs(collection(personDb(people.member), 'households', H, 'devices')));
    await assertFails(getDocs(collection(personDb(people.ownerB), 'households', H, 'devices')));
  });

  test('device codes: owners and admins of the household only (never a member with manageInvites)', async () => {
    for (const person of [people.owner, people.admin]) {
      await assertSucceeds(getDoc(doc(personDb(person), 'deviceCodes', 'DEVC-CODE-AA')));
      await assertSucceeds(getDocs(query(collection(personDb(person), 'deviceCodes'), where('householdId', '==', H))));
    }
    await assertFails(getDoc(doc(personDb(people.member), 'deviceCodes', 'DEVC-CODE-AA')));
    await assertFails(getDocs(query(collection(personDb(people.member), 'deviceCodes'), where('householdId', '==', H))));
    await assertFails(getDoc(doc(personDb(people.ownerB), 'deviceCodes', 'DEVC-CODE-AA')));
    await assertFails(getDoc(doc(anonDb(), 'deviceCodes', 'DEVC-CODE-AA')));
    await assertFails(setDoc(doc(personDb(people.owner), 'deviceCodes', 'DEVC-CODE-CC'), { householdId: H }));
    await assertFails(setDoc(doc(personDb(people.owner), 'households', H, 'devices', id20('DevByOwner')), deviceRecord('active', 1)));
    await assertFails(updateDoc(doc(personDb(people.owner), 'households', H, 'devices', D.active), { name: 'Hall' }));
  });

  test('personal reads keep their meaning (a member reads chores and the household; no device data)', async () => {
    const db = personDb(people.member);
    await assertSucceeds(getDoc(doc(db, 'households', H)));
    await assertSucceeds(read(db, H, ['chores', 'c1']));
    await assertSucceeds(getDocs(query(collection(db, 'households', H, 'notifications'),
      where('audience', 'array-contains-any', [people.member.uid, '*']))));
  });
});
