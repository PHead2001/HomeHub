import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

const projectId = 'demo-homehub-e2e';
const householdA = 'household-a-e2e';
const householdB = 'household-b-e2e';
let environment: RulesTestEnvironment;

const users = {
  owner: { uid: 'owner-a', email: 'owner.a@example.test' },
  member: { uid: 'member-a', email: 'member.a@example.test' },
  child: { uid: 'child-a', email: 'child.a@example.test' },
  guest: { uid: 'guest-a', email: 'guest.a@example.test' },
  denied: { uid: 'denied-a', email: 'denied.a@example.test' },
  pending: { uid: 'pending-a', email: 'pending.a@example.test' },
  legacy: { uid: 'legacy-a', email: 'legacy.a@example.test' },
  ownerB: { uid: 'owner-b', email: 'owner.b@example.test' },
};

const dbFor = (user: { uid: string; email: string }) => environment
  .authenticatedContext(user.uid, { email: user.email })
  .firestore();

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });

  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, 'households', householdA), {
        name: 'Household A',
        ownerUid: users.owner.uid,
        ownerEmail: users.owner.email,
        memberEmails: Object.values(users).filter(user => user !== users.ownerB).map(user => user.email),
      }),
      setDoc(doc(db, 'households', householdB), {
        name: 'Household B',
        ownerUid: users.ownerB.uid,
        ownerEmail: users.ownerB.email,
        memberEmails: [users.ownerB.email],
      }),
      setDoc(doc(db, 'users', users.legacy.email), {
        email: users.legacy.email,
        householdId: householdA,
        role: 'super-admin',
        permissions: { 'household.delete': true },
      }),
    ]);

    for (const [key, role] of [
      ['owner', 'owner'],
      ['member', 'member'],
      ['child', 'child'],
      ['guest', 'guest'],
      ['denied', 'member'],
      ['pending', 'newuser'],
    ] as const) {
      const user = users[key];
      await setDoc(doc(db, 'households', householdA, 'members', user.uid), {
        uid: user.uid,
        email: user.email,
        role,
        status: key === 'pending' ? 'pending' : 'active',
        ...(key === 'denied' ? { permissions: { 'shopping.view': false, 'shopping.edit': false } } : {}),
      });
    }
    await setDoc(doc(db, 'households', householdB, 'members', users.ownerB.uid), {
      ...users.ownerB,
      role: 'owner',
      status: 'active',
    });
    await Promise.all([
      setDoc(doc(db, 'households', householdA, 'shopping-lists', 'groceries'), { name: 'A groceries' }),
      setDoc(doc(db, 'households', householdB, 'shopping-lists', 'groceries'), { name: 'B groceries' }),
      setDoc(doc(db, 'households', householdA, 'chores', 'task'), { task: 'A task', isCompleted: false }),
      setDoc(doc(db, 'households', householdA, 'home-assets', 'asset'), { name: 'A asset' }),
    ]);
  });
});

after(async () => environment?.cleanup());

describe('household module rules', () => {
  test('member can use allowed Household A shopping operations but not delete', async () => {
    const db = dbFor(users.member);
    await assertSucceeds(getDoc(doc(db, 'households', householdA, 'shopping-lists', 'groceries')));
    await assertSucceeds(setDoc(doc(db, 'households', householdA, 'shopping-lists', 'hardware'), { name: 'Hardware' }));
    await assertFails(deleteDoc(doc(db, 'households', householdA, 'shopping-lists', 'hardware')));
  });

  test('Household A identities cannot read or write Household B', async () => {
    const db = dbFor(users.owner);
    await assertFails(getDoc(doc(db, 'households', householdB, 'shopping-lists', 'groceries')));
    await assertFails(setDoc(doc(db, 'households', householdB, 'shopping-lists', 'attack'), { name: 'Denied' }));
  });

  test('permission overrides, pending status, and guest/child presets are enforced', async () => {
    await assertFails(getDoc(doc(dbFor(users.denied), 'households', householdA, 'shopping-lists', 'groceries')));
    await assertFails(getDoc(doc(dbFor(users.pending), 'households', householdA, 'chores', 'task')));
    await assertSucceeds(getDoc(doc(dbFor(users.guest), 'households', householdA, 'shopping-lists', 'groceries')));
    await assertFails(setDoc(doc(dbFor(users.guest), 'households', householdA, 'shopping-lists', 'guest-write'), { name: 'Denied' }));
    await assertSucceeds(updateDoc(doc(dbFor(users.child), 'households', householdA, 'chores', 'task'), {
      isCompleted: true,
      completedAt: '2026-08-04T12:00:00.000Z',
    }));
  });

  test('legacy profile elevation is ignored while normal member access remains', async () => {
    const db = dbFor(users.legacy);
    await assertSucceeds(getDoc(doc(db, 'households', householdA, 'shopping-lists', 'groceries')));
    await assertFails(deleteDoc(doc(db, 'households', householdA, 'home-assets', 'asset')));
    await assertFails(setDoc(doc(db, 'households', householdA, 'members', users.legacy.uid), {
      uid: users.legacy.uid,
      email: users.legacy.email,
      role: 'admin',
      status: 'active',
    }));
    await assertSucceeds(setDoc(doc(db, 'households', householdA, 'members', users.legacy.uid), {
      uid: users.legacy.uid,
      email: users.legacy.email,
      role: 'member',
      status: 'active',
    }));
  });

  test('owners retain destructive maintenance access and unknown collections are denied', async () => {
    const db = dbFor(users.owner);
    await assertSucceeds(deleteDoc(doc(db, 'households', householdA, 'home-assets', 'asset')));
    await assertFails(setDoc(doc(db, 'households', householdA, 'future-module', 'document'), { unsafe: true }));
    assert.ok(true);
  });
});
