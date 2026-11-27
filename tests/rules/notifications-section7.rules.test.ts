import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { Timestamp, deleteField, doc, setDoc, updateDoc, type Firestore } from 'firebase/firestore';

// Notifications, audit section 7. Server-only push fields (NO-3 held pushes) can be neither
// created nor changed by clients. NO-8: marking read needs only notifications.view; dismissing
// still needs notifications.dismiss.

const projectId = 'demo-homehub-e2e';
const H = 'no7-rules-house';
let environment: RulesTestEnvironment;

const people = {
  owner: { uid: 'no7-owner', email: 'no7.owner@example.test' },
  member: { uid: 'no7-member', email: 'no7.member@example.test' },
  guest: { uid: 'no7-guest', email: 'no7.guest@example.test' },
};
const personDb = (person: { uid: string; email: string }): Firestore =>
  environment.authenticatedContext(person.uid, { email: person.email }).firestore() as unknown as Firestore;

const now = () => Timestamp.now();
const later = () => Timestamp.fromMillis(Date.now() + 86_400_000);
const notice = (fields: Record<string, unknown> = {}) => ({
  householdId: H, category: 'general', title: 'Hello', message: 'Dinner at 6', createdAt: now(), expiresAt: later(),
  readBy: {}, dismissedBy: {}, audience: ['*'], ...fields,
});

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore() as unknown as Firestore;
    await setDoc(doc(db, 'households', H), { name: 'No7', ownerUid: people.owner.uid, timeZone: 'America/Chicago' });
    for (const [person, role] of [[people.owner, 'owner'], [people.member, 'member'], [people.guest, 'guest']] as const) {
      await setDoc(doc(db, 'households', H, 'members', person.uid), { uid: person.uid, role, status: 'active', displayName: person.uid, permissions: {} });
    }
    await setDoc(doc(db, 'households', H, 'notifications', 'held'), notice({ pushHeld: { [people.member.uid]: later() }, pushHeldNext: later() }));
    await setDoc(doc(db, 'households', H, 'notifications', 'wide'), notice());
    await setDoc(doc(db, 'households', H, 'notifications', 'for-member'), notice({ targetUserUid: people.member.uid, audience: [people.member.uid] }));
  });
});

after(async () => {
  await environment?.cleanup();
});

describe('held push fields are server-only (NO-3)', () => {
  test('an owner may create a household notice, but not with hold or release fields', async () => {
    const db = personDb(people.owner);
    await assertSucceeds(setDoc(doc(db, 'households', H, 'notifications', 'plain'), notice()));
    for (const [key, value] of [
      ['pushHeld', {}], ['pushHeldNext', later()], ['pushRelease', { at: now(), uids: [people.member.uid] }], ['holdUntilMorning', true],
    ] as const) {
      await assertFails(setDoc(doc(db, 'households', H, 'notifications', `with-${key}`), notice({ [key]: value })));
    }
  });

  test('a member in the audience cannot release, clear or move a held push', async () => {
    const db = personDb(people.member);
    const ref = doc(db, 'households', H, 'notifications', 'held');
    await assertFails(updateDoc(ref, { pushRelease: { at: now(), uids: [people.member.uid] } }));
    await assertFails(updateDoc(ref, { pushHeld: {} }));
    await assertFails(updateDoc(ref, { pushHeldNext: now() }));
  });
});

describe('NO-8: read state needs only view; dismissing needs notifications.dismiss', () => {
  const action = (uid: string) => ({ at: now(), uid, displayName: uid });

  test('a guest marks a household notice read (and can take it back), but cannot dismiss it', async () => {
    const db = personDb(people.guest);
    const ref = doc(db, 'households', H, 'notifications', 'wide');
    await assertSucceeds(updateDoc(ref, { [`readBy.${people.guest.uid}`]: action(people.guest.uid) }));
    await assertSucceeds(updateDoc(ref, { [`readBy.${people.guest.uid}`]: deleteField() }));
    await assertFails(updateDoc(ref, { [`dismissedBy.${people.guest.uid}`]: action(people.guest.uid) }));
    await assertFails(updateDoc(ref, {
      [`readBy.${people.guest.uid}`]: action(people.guest.uid), [`dismissedBy.${people.guest.uid}`]: action(people.guest.uid),
    }));
  });

  test("a guest still cannot write someone else's entry, an email, or a notice not addressed to them", async () => {
    const db = personDb(people.guest);
    await assertFails(updateDoc(doc(db, 'households', H, 'notifications', 'wide'), { [`readBy.${people.member.uid}`]: action(people.member.uid) }));
    await assertFails(updateDoc(doc(db, 'households', H, 'notifications', 'wide'), { [`readBy.${people.guest.uid}`]: { ...action(people.guest.uid), email: people.guest.email } }));
    await assertFails(updateDoc(doc(db, 'households', H, 'notifications', 'for-member'), { [`readBy.${people.guest.uid}`]: action(people.guest.uid) }));
  });

  test('a member reads and dismisses as before', async () => {
    const db = personDb(people.member);
    const ref = doc(db, 'households', H, 'notifications', 'for-member');
    await assertSucceeds(updateDoc(ref, { [`readBy.${people.member.uid}`]: action(people.member.uid) }));
    await assertSucceeds(updateDoc(ref, { [`dismissedBy.${people.member.uid}`]: action(people.member.uid) }));
  });
});
