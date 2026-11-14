import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
  type TokenOptions,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, type Firestore } from 'firebase/firestore';

// Household quiet hours (docs/modules/devices/README.md, "Night dimming"; F3): the new
// `households/{h}.quietHours` field is written only by the server. No rule changed: the
// household update rule allows only `timeZone` and `updatedAt`, so every client write of
// the field is refused; an active tablet of the household reads it with the household
// document (positive), others do not (unauthenticated, removed tablet, other household,
// forged claims).

const projectId = 'demo-homehub-e2e';
const H = 'qh-rules-house';
const HB = 'qh-rules-house-b';
const DEVICE = 'QuietTablet000000000';
const REMOVED = 'QuietRemoved00000000';
const DEVICE_B = 'QuietTabletB00000000';
let environment: RulesTestEnvironment;

const people = {
  owner: { uid: 'qh-owner', email: 'qh.owner@example.test' },
  admin: { uid: 'qh-admin', email: 'qh.admin@example.test' },
  member: { uid: 'qh-member', email: 'qh.member@example.test' },
  ownerB: { uid: 'qh-owner-b', email: 'qh.ownerb@example.test' },
};

const claims = (deviceId: string, household: string, gen = 1, extra: Record<string, unknown> = {}) => ({
  hh_kind: 'device', hh_household: household, hh_device: deviceId, hh_gen: gen,
  firebase: { sign_in_provider: 'custom', identities: {} }, ...extra,
});
const deviceDb = (deviceId: string, household = H, extra: Record<string, unknown> = {}): Firestore =>
  environment.authenticatedContext(`device_${deviceId}`, claims(deviceId, household, 1, extra) as unknown as TokenOptions).firestore() as unknown as Firestore;
const personDb = (person: { uid: string; email: string }): Firestore =>
  environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore;
const anonDb = (): Firestore => environment.unauthenticatedContext().firestore() as unknown as Firestore;

const quiet = { start: '22:00', end: '07:00', updatedByUid: 'qh-owner' };
const sections = { chores: true, shopping: true, pets: true, calendar: true, maintenance: true };

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore() as unknown as Firestore;
    await setDoc(doc(db, 'households', H), { name: 'Quiet', ownerUid: people.owner.uid, timeZone: 'America/Chicago', quietHours: quiet });
    await setDoc(doc(db, 'households', HB), { name: 'Other', ownerUid: people.ownerB.uid, quietHours: quiet });
    for (const [person, role] of [[people.owner, 'owner'], [people.admin, 'admin'], [people.member, 'member']] as const) {
      await setDoc(doc(db, 'households', H, 'members', person.uid), { uid: person.uid, role, status: 'active', displayName: person.uid, permissions: {} });
    }
    await setDoc(doc(db, 'households', HB, 'members', people.ownerB.uid), { uid: people.ownerB.uid, role: 'owner', status: 'active', displayName: 'B', permissions: {} });
    await setDoc(doc(db, 'households', H, 'devices', DEVICE), { name: 'Hall', room: 'Hall', status: 'active', generation: 1, sections });
    await setDoc(doc(db, 'households', H, 'devices', REMOVED), { name: 'Old', room: 'Hall', status: 'removed', generation: 1, sections });
    await setDoc(doc(db, 'households', HB, 'devices', DEVICE_B), { name: 'B', room: 'B', status: 'active', generation: 1, sections });
  });
});

after(async () => {
  await environment.cleanup();
});

describe('households/{h}.quietHours (server-written only)', () => {
  test('an active tablet of the household reads it with the household document', async () => {
    await assertSucceeds(getDoc(doc(deviceDb(DEVICE), 'households', H)));
  });

  test('unauthenticated, a removed tablet, another household\'s tablet and forged claims are refused', async () => {
    await assertFails(getDoc(doc(anonDb(), 'households', H)));
    await assertFails(getDoc(doc(deviceDb(REMOVED), 'households', H)));
    await assertFails(getDoc(doc(deviceDb(DEVICE_B, HB), 'households', H)));
    await assertFails(getDoc(doc(deviceDb(DEVICE, H, { email: 'x@example.test' }), 'households', H)));
  });

  test('no client writes it: owner, admin, member, other household or tablet', async () => {
    for (const person of [people.owner, people.admin, people.member, people.ownerB]) {
      await assertFails(updateDoc(doc(personDb(person), 'households', H), { quietHours: { start: '20:00', end: '06:00' } }));
      await assertFails(updateDoc(doc(personDb(person), 'households', H), { quietHours: null }));
      await assertFails(updateDoc(doc(personDb(person), 'households', H), { 'quietHours.start': '01:00' }));
    }
    await assertFails(updateDoc(doc(deviceDb(DEVICE), 'households', H), { quietHours: null }));
    await assertFails(updateDoc(doc(anonDb(), 'households', H), { quietHours: null }));
  });

  test('positive control: an owner still updates the time zone alone', async () => {
    await assertSucceeds(updateDoc(doc(personDb(people.owner), 'households', H), { timeZone: 'America/New_York' }));
    await assertFails(updateDoc(doc(personDb(people.owner), 'households', H), { timeZone: 'America/New_York', quietHours: null }));
  });
});
