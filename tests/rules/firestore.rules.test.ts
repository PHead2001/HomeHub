import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  Timestamp,
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  deleteField,
  increment,
  limit,
  orderBy,
  query,
  where,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';

const projectId = 'demo-homehub-e2e';
const householdA = 'household-a-e2e';
const householdB = 'household-b-e2e';
let environment: RulesTestEnvironment;

type Identity = { uid: string; email: string };

const users = {
  owner: { uid: 'owner-a', email: 'owner.a@example.test' },
  admin: { uid: 'admin-a', email: 'admin.a@example.test' },
  member: { uid: 'member-a', email: 'member.a@example.test' },
  child: { uid: 'child-a', email: 'child.a@example.test' },
  guest: { uid: 'guest-a', email: 'guest.a@example.test' },
  denied: { uid: 'denied-a', email: 'denied.a@example.test' },
  pending: { uid: 'pending-a', email: 'pending.a@example.test' },
  // Listed in memberEmails but has no membership record (legacy compatibility field only).
  legacy: { uid: 'legacy-a', email: 'legacy.a@example.test' },
  ownerB: { uid: 'owner-b', email: 'owner.b@example.test' },
  stranger: { uid: 'stranger', email: 'stranger@example.test' },
  lonerA: { uid: 'loner-a', email: 'loner.a@example.test' },
  lonerB: { uid: 'loner-b', email: 'loner.b@example.test' },
} satisfies Record<string, Identity>;

const dbFor = (user: Identity) => environment
  .authenticatedContext(user.uid, { email: user.email })
  .firestore();

const now = () => Timestamp.fromDate(new Date('2026-08-01T12:00:00.000Z'));
// Notifications and invites are checked against the real request time.
const inMinutes = (minutes: number) => Timestamp.fromMillis(Date.now() + minutes * 60_000);

const notification = (overrides: Record<string, unknown> = {}) => ({
  householdId: householdA,
  category: 'chores',
  title: 'New chore assigned',
  message: 'You have a new chore.',
  createdAt: inMinutes(0),
  expiresAt: inMinutes(7 * 24 * 60),
  deepLink: '/chores',
  readBy: {},
  dismissedBy: {},
  ...overrides,
});

const seed = async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const memberEmails = [
      users.owner, users.admin, users.member, users.child, users.guest, users.denied, users.pending, users.legacy,
    ].map(user => user.email);
    await setDoc(doc(db, 'households', householdA), {
      name: 'Household A',
      ownerUid: users.owner.uid,
      ownerEmail: users.owner.email,
      memberEmails,
    });
    await setDoc(doc(db, 'households', householdB), {
      name: 'Household B',
      ownerUid: users.ownerB.uid,
      ownerEmail: users.ownerB.email,
      memberEmails: [users.ownerB.email],
    });

    const memberships: Array<[keyof typeof users, string, string, Record<string, boolean>?]> = [
      ['owner', 'owner', 'active'],
      ['admin', 'admin', 'active'],
      ['member', 'member', 'active'],
      ['child', 'child', 'active'],
      ['guest', 'guest', 'active'],
      ['denied', 'member', 'active', { 'shopping.view': false, 'shopping.edit': false }],
      ['pending', 'newuser', 'pending'],
    ];
    for (const [key, role, status, permissions] of memberships) {
      const user = users[key];
      await setDoc(doc(db, 'households', householdA, 'members', user.uid), {
        uid: user.uid,
        email: user.email,
        role,
        status,
        ...(permissions ? { permissions } : {}),
      });
      await setDoc(doc(db, 'users', user.email), {
        email: user.email,
        householdId: householdA,
        role,
        permissions: permissions ?? {},
      });
    }
    await setDoc(doc(db, 'households', householdB, 'members', users.ownerB.uid), {
      ...users.ownerB,
      role: 'owner',
      status: 'active',
    });
    await setDoc(doc(db, 'users', users.ownerB.email), { email: users.ownerB.email, householdId: householdB, role: 'owner' });
    await setDoc(doc(db, 'users', users.legacy.email), {
      email: users.legacy.email,
      householdId: householdA,
      role: 'super-admin',
      permissions: { 'household.delete': true },
    });
    await setDoc(doc(db, 'users', users.stranger.email), { email: users.stranger.email, householdId: null, role: 'member' });
    await setDoc(doc(db, 'users', users.lonerA.email), { email: users.lonerA.email, householdId: null, role: 'member' });
    await setDoc(doc(db, 'users', users.lonerB.email), {
      email: users.lonerB.email, householdId: null, role: 'member', birthday: '2000-02-02',
    });

    await setDoc(doc(db, 'households', householdA, 'shopping-lists', 'groceries'), { name: 'A groceries' });
    await setDoc(doc(db, 'households', householdB, 'shopping-lists', 'groceries'), { name: 'B groceries' });
    await setDoc(doc(db, 'households', householdA, 'chores', 'task'), { task: 'A task', isCompleted: false });
    await setDoc(doc(db, 'households', householdA, 'home-assets', 'asset'), { name: 'A asset' });
    await setDoc(doc(db, 'households', householdA, 'home-automation', 'credentials'), {
      url: 'https://ha.example.test', accessToken: 'fake-token',
    });
    await setDoc(doc(db, 'households', householdA, 'notifications', 'existing'), notification());
    await setDoc(doc(db, 'inviteCodes', 'AAAA-BBBB-CC'), {
      code: 'AAAA-BBBB-CC',
      householdId: householdA,
      createdByUid: users.owner.uid,
      createdByEmail: users.owner.email,
      createdAt: '2026-08-01T12:00:00.000Z',
      expiresAt: '2026-08-01T12:30:00.000Z',
      maxUses: 1,
      useCount: 0,
    });
  });
};

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8') },
  });
});

beforeEach(seed);

after(async () => environment?.cleanup());

describe('household modules', () => {
  test('member can use allowed shopping operations but cannot delete', async () => {
    const db = dbFor(users.member);
    await assertSucceeds(getDoc(doc(db, 'households', householdA, 'shopping-lists', 'groceries')));
    await assertSucceeds(setDoc(doc(db, 'households', householdA, 'shopping-lists', 'hardware'), { name: 'Hardware' }));
    await assertFails(deleteDoc(doc(db, 'households', householdA, 'shopping-lists', 'hardware')));
  });

  test('one household cannot read or write another', async () => {
    const db = dbFor(users.owner);
    await assertFails(getDoc(doc(db, 'households', householdB, 'shopping-lists', 'groceries')));
    await assertFails(setDoc(doc(db, 'households', householdB, 'shopping-lists', 'attack'), { name: 'Denied' }));
    await assertFails(getDoc(doc(db, 'households', householdB)));
  });

  test('permission overrides, pending status and guest/child presets are enforced', async () => {
    await assertFails(getDoc(doc(dbFor(users.denied), 'households', householdA, 'shopping-lists', 'groceries')));
    await assertFails(getDoc(doc(dbFor(users.pending), 'households', householdA, 'chores', 'task')));
    await assertSucceeds(getDoc(doc(dbFor(users.guest), 'households', householdA, 'shopping-lists', 'groceries')));
    await assertFails(setDoc(doc(dbFor(users.guest), 'households', householdA, 'shopping-lists', 'guest-write'), { name: 'Denied' }));
    await assertSucceeds(updateDoc(doc(dbFor(users.child), 'households', householdA, 'chores', 'task'), {
      isCompleted: true,
      completedAt: '2026-08-04T12:00:00.000Z',
      completedAtServer: serverTimestamp(),
    }));
    await assertFails(updateDoc(doc(dbFor(users.child), 'households', householdA, 'chores', 'task'), { task: 'Renamed' }));
  });

  test('owners keep destructive access and unknown collections are denied', async () => {
    const db = dbFor(users.owner);
    await assertSucceeds(deleteDoc(doc(db, 'households', householdA, 'home-assets', 'asset')));
    await assertFails(setDoc(doc(db, 'households', householdA, 'future-module', 'document'), { unsafe: true }));
    await assertFails(getDoc(doc(db, 'households', householdA, 'settings', 'legacy')));
  });

  test('unauthenticated callers are denied everywhere', async () => {
    const db = environment.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'households', householdA)));
    await assertFails(getDoc(doc(db, 'households', householdA, 'chores', 'task')));
    await assertFails(getDoc(doc(db, 'users', users.owner.email)));
    await assertFails(getDoc(doc(db, 'inviteCodes', 'AAAA-BBBB-CC')));
  });
});

describe('membership is authoritative; legacy fields grant nothing', () => {
  test('a memberEmails-only identity has no access and cannot backfill itself', async () => {
    const db = dbFor(users.legacy);
    await assertFails(getDoc(doc(db, 'households', householdA)));
    await assertFails(getDoc(doc(db, 'households', householdA, 'shopping-lists', 'groceries')));
    for (const role of ['member', 'admin', 'owner']) {
      await assertFails(setDoc(doc(db, 'households', householdA, 'members', users.legacy.uid), {
        uid: users.legacy.uid, email: users.legacy.email, role, status: 'active',
      }));
    }
  });

  test('a pending member who deletes their own record loses access instead of gaining it', async () => {
    const db = dbFor(users.pending);
    await assertSucceeds(getDoc(doc(db, 'households', householdA)));
    await assertFails(getDoc(doc(db, 'households', householdA, 'chores', 'task')));
    await assertSucceeds(deleteDoc(doc(db, 'households', householdA, 'members', users.pending.uid)));
    await assertFails(getDoc(doc(db, 'households', householdA)));
    await assertFails(getDoc(doc(db, 'households', householdA, 'chores', 'task')));
    await assertFails(setDoc(doc(db, 'households', householdA, 'members', users.pending.uid), {
      uid: users.pending.uid, email: users.pending.email, role: 'member', status: 'active',
    }));
  });

  test('a child who deletes their own record cannot come back with more power', async () => {
    const db = dbFor(users.child);
    await assertSucceeds(deleteDoc(doc(db, 'households', householdA, 'members', users.child.uid)));
    await assertFails(setDoc(doc(db, 'households', householdA, 'chores', 'new'), { task: 'x' }));
  });

  test('a pending member cannot promote themselves or edit the member list', async () => {
    const db = dbFor(users.pending);
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.pending.uid), {
      role: 'member', status: 'active',
    }));
    await assertFails(updateDoc(doc(db, 'households', householdA), {
      memberEmails: [users.owner.email, users.pending.email, users.stranger.email],
      updatedAt: '2026-08-01T12:00:00.000Z',
    }));
  });

  test('nobody can create a membership in an existing household from the client', async () => {
    await assertFails(setDoc(doc(dbFor(users.stranger), 'households', householdA, 'members', users.stranger.uid), {
      uid: users.stranger.uid, email: users.stranger.email, role: 'newuser', status: 'pending',
    }));
    await assertFails(setDoc(doc(dbFor(users.owner), 'households', householdA, 'members', users.stranger.uid), {
      uid: users.stranger.uid, email: users.stranger.email, role: 'member', status: 'active',
    }));
  });

  test('households cannot be listed', async () => {
    await assertFails(getDocs(collection(dbFor(users.owner), 'households')));
  });
});

describe('household creation', () => {
  test('a new user creates a household together with their owner record', async () => {
    const db = dbFor(users.stranger);
    const batch = writeBatch(db);
    batch.set(doc(db, 'households', 'new-house'), {
      name: 'New House',
      ownerUid: users.stranger.uid,
      ownerEmail: users.stranger.email,
      memberEmails: [users.stranger.email],
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z',
    });
    batch.set(doc(db, 'households', 'new-house', 'members', users.stranger.uid), {
      uid: users.stranger.uid, email: users.stranger.email, role: 'owner', status: 'active', permissions: {},
    });
    batch.set(doc(db, 'users', users.stranger.email), { householdId: 'new-house', role: 'owner', permissions: {} }, { merge: true });
    batch.set(doc(collection(db, 'households', 'new-house', 'auditLogs')), {
      actorUid: users.stranger.uid,
      actorEmail: users.stranger.email,
      action: 'household.created',
      createdAt: '2026-08-01T12:00:00.000Z',
    });
    await assertSucceeds(batch.commit());
  });

  test('a household cannot be created without its owner record or for someone else', async () => {
    const db = dbFor(users.stranger);
    await assertFails(setDoc(doc(db, 'households', 'orphan'), {
      name: 'Orphan', ownerUid: users.stranger.uid, ownerEmail: users.stranger.email, memberEmails: [],
    }));
    const batch = writeBatch(db);
    batch.set(doc(db, 'households', 'spoof'), {
      name: 'Spoof', ownerUid: users.owner.uid, ownerEmail: users.owner.email, memberEmails: [],
    });
    batch.set(doc(db, 'households', 'spoof', 'members', users.stranger.uid), {
      uid: users.stranger.uid, email: users.stranger.email, role: 'owner', status: 'active',
    });
    await assertFails(batch.commit());
  });

  test('creating over an existing household id is denied', async () => {
    const db = dbFor(users.stranger);
    const batch = writeBatch(db);
    batch.set(doc(db, 'households', householdA), {
      name: 'Takeover', ownerUid: users.stranger.uid, ownerEmail: users.stranger.email, memberEmails: [],
    });
    batch.set(doc(db, 'households', householdA, 'members', users.stranger.uid), {
      uid: users.stranger.uid, email: users.stranger.email, role: 'owner', status: 'active',
    });
    await assertFails(batch.commit());
  });
});

describe('roles and ownership', () => {
  test('owners and admins approve pending members; members cannot', async () => {
    await assertFails(updateDoc(doc(dbFor(users.member), 'households', householdA, 'members', users.pending.uid), {
      role: 'member', status: 'active',
    }));
    await assertSucceeds(updateDoc(doc(dbFor(users.admin), 'households', householdA, 'members', users.pending.uid), {
      role: 'member', status: 'active',
    }));
  });

  test('admins cannot create or modify owners', async () => {
    const db = dbFor(users.admin);
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.member.uid), { role: 'owner' }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.owner.uid), { role: 'member' }));
    await assertFails(deleteDoc(doc(db, 'households', householdA, 'members', users.owner.uid)));
  });

  test('members cannot change their own role', async () => {
    await assertFails(updateDoc(doc(dbFor(users.member), 'households', householdA, 'members', users.member.uid), { role: 'admin' }));
  });

  test('the last owner cannot demote or remove themselves without a transfer', async () => {
    const db = dbFor(users.owner);
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.owner.uid), { role: 'admin' }));
    await assertFails(deleteDoc(doc(db, 'households', householdA, 'members', users.owner.uid)));
    await assertFails(updateDoc(doc(db, 'households', householdA), { ownerUid: users.admin.uid }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.admin.uid), { role: 'owner' }));
  });

  test('ownership transfer succeeds as one consistent batch', async () => {
    const db = dbFor(users.owner);
    const batch = writeBatch(db);
    batch.update(doc(db, 'households', householdA), {
      ownerUid: users.admin.uid, ownerEmail: users.admin.email, updatedAt: '2026-08-01T12:00:00.000Z',
    });
    batch.update(doc(db, 'households', householdA, 'members', users.admin.uid), { role: 'owner', status: 'active', permissions: {} });
    batch.update(doc(db, 'households', householdA, 'members', users.owner.uid), { role: 'admin', status: 'active', permissions: {} });
    batch.set(doc(db, 'users', users.admin.email), { role: 'owner', permissions: {} }, { merge: true });
    batch.set(doc(db, 'users', users.owner.email), { role: 'admin', permissions: {} }, { merge: true });
    await assertSucceeds(batch.commit());
  });

  test('member identity fields cannot be rewritten', async () => {
    await assertFails(updateDoc(doc(dbFor(users.owner), 'households', householdA, 'members', users.member.uid), {
      uid: users.stranger.uid,
    }));
  });

  test('owners rename; admins rename; members cannot', async () => {
    await assertSucceeds(updateDoc(doc(dbFor(users.owner), 'households', householdA), { name: 'Renamed', updatedAt: 'x' }));
    await assertSucceeds(updateDoc(doc(dbFor(users.admin), 'households', householdA), { name: 'Renamed again', updatedAt: 'y' }));
    await assertFails(updateDoc(doc(dbFor(users.member), 'households', householdA), { name: 'Nope', updatedAt: 'z' }));
    await assertFails(updateDoc(doc(dbFor(users.owner), 'households', householdA), { name: '' }));
  });

  test('a household without ownerUid (legacy) blocks owner edits until backfilled', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'households', householdA), {
        name: 'Legacy', ownerEmail: users.owner.email, memberEmails: [users.owner.email],
      });
    });
    await assertFails(updateDoc(doc(dbFor(users.owner), 'households', householdA), { name: 'Legacy 2', updatedAt: 'x' }));
    // Module access is unaffected because it depends only on membership records.
    await assertSucceeds(getDoc(doc(dbFor(users.member), 'households', householdA, 'chores', 'task')));
  });
});

describe('independent review regressions', () => {
  test('an admin cannot edit their own record or lift restrictions', async () => {
    const db = dbFor(users.admin);
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.admin.uid), { permissions: {} }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.admin.uid), {
      permissions: { 'household.delete': true },
    }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.member.uid), {
      permissions: { 'household.transferOwnership': true },
    }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.member.uid), { uid: 'x', role: 'member' }));
    await assertSucceeds(updateDoc(doc(db, 'households', householdA, 'members', users.member.uid), {
      permissions: { 'shopping.edit': false },
    }));
  });

  test('owners cannot grant owner-only permissions or invent fields', async () => {
    const db = dbFor(users.owner);
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.admin.uid), {
      permissions: { 'household.delete': true },
    }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.admin.uid), { superPower: true }));
  });

  test('ownership cannot end up with two owners or a pending owner', async () => {
    const db = dbFor(users.owner);
    const twoOwners = writeBatch(db);
    twoOwners.update(doc(db, 'households', householdA), { ownerUid: users.admin.uid, ownerEmail: users.admin.email });
    twoOwners.update(doc(db, 'households', householdA, 'members', users.admin.uid), { role: 'owner', status: 'active' });
    await assertFails(twoOwners.commit());
    await assertFails(updateDoc(doc(db, 'households', householdA, 'members', users.owner.uid), { status: 'pending' }));
  });

  test('owners and admins set the household timezone; members save their own', async () => {
    await assertSucceeds(updateDoc(doc(dbFor(users.admin), 'households', householdA), { timeZone: 'America/New_York' }));
    await assertFails(updateDoc(doc(dbFor(users.member), 'households', householdA), { timeZone: 'UTC' }));
    await assertFails(updateDoc(doc(dbFor(users.owner), 'households', householdA), { name: 'Fine', timeZone: 'x'.repeat(100) }));
    await assertSucceeds(updateDoc(doc(dbFor(users.member), 'users', users.member.email), { timeZone: 'America/Denver' }));
  });

  test('households cannot be deleted from the client', async () => {
    await assertFails(deleteDoc(doc(dbFor(users.owner), 'households', householdA)));
  });

  test('notifications are limited by what the sender may do and pinned to now', async () => {
    const col = (user: Identity) => collection(dbFor(user), 'households', householdA, 'notifications');
    await assertFails(addDoc(col(users.guest), notification({ category: 'system', deepLink: '/household?tab=members' })));
    await assertFails(addDoc(col(users.child), notification({ category: 'chores' })));
    await assertFails(addDoc(col(users.member), notification({ category: 'system' })));
    await assertSucceeds(addDoc(col(users.admin), notification({ category: 'system' })));
    await assertFails(addDoc(col(users.member), notification({ createdAt: inMinutes(60 * 24) })));
    // A slow device clock (or a fixed test clock) must not block chore assignment.
    await assertSucceeds(addDoc(col(users.member), notification({ createdAt: inMinutes(-60 * 24 * 90), expiresAt: inMinutes(-60 * 24 * 83) })));
    await assertFails(addDoc(col(users.member), notification({ expiresAt: inMinutes(60 * 24 * 30) })));
    await assertFails(addDoc(col(users.member), notification({ createdByUid: users.owner.uid })));
    await assertSucceeds(addDoc(col(users.member), notification({ createdByUid: users.member.uid })));
  });

  test('a Google sign-up profile without householdId can be created', async () => {
    const newcomer = { uid: 'google-newcomer', email: 'google.newcomer@example.test' };
    await assertSucceeds(setDoc(doc(dbFor(newcomer), 'users', newcomer.email), {
      email: newcomer.email, displayName: 'New', role: 'member', forcePasswordChange: false,
    }));
  });

  test('invites need a real expiry within two hours', async () => {
    const base = {
      householdId: householdA, createdByUid: users.owner.uid, createdByEmail: users.owner.email,
      createdAt: 'x', maxUses: 1, useCount: 0,
    };
    const db = dbFor(users.owner);
    await assertFails(setDoc(doc(db, 'inviteCodes', 'STRG-EXPI-RE'), { ...base, code: 'STRG-EXPI-RE', expiresAt: '2099-01-01' }));
    await assertFails(setDoc(doc(db, 'inviteCodes', 'LONG-EXPI-RE'), { ...base, code: 'LONG-EXPI-RE', expiresAt: inMinutes(60 * 24) }));
    await assertFails(setDoc(doc(db, 'inviteCodes', 'PAST-EXPI-RE'), { ...base, code: 'PAST-EXPI-RE', expiresAt: inMinutes(-1) }));
    await assertSucceeds(setDoc(doc(db, 'inviteCodes', 'GOOD-EXPI-RE'), { ...base, code: 'GOOD-EXPI-RE', expiresAt: inMinutes(30) }));
    // The deployed client writes ISO strings; accepted, and the server caps every invite
    // at two hours from Firestore's own create time.
    await assertSucceeds(setDoc(doc(db, 'inviteCodes', 'ISOS-TRIN-GG'), { ...base, code: 'ISOS-TRIN-GG', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    await assertFails(setDoc(doc(db, 'inviteCodes', 'JUNK-STRI-NG'), { ...base, code: 'JUNK-STRI-NG', expiresAt: 'tomorrow' }));
  });

  test('a member may remind themselves about chores, and only themselves', async () => {
    const col = (user: Identity) => collection(dbFor(user), 'households', householdA, 'notifications');
    const reminder = (target: string) => notification({ sourceType: 'chore-reminder', sourceId: 'reminder-x', targetUserUid: target, targetUserEmail: users.child.email });
    await assertSucceeds(addDoc(col(users.child), reminder(users.child.uid)));
    await assertFails(addDoc(col(users.child), { ...reminder(users.member.uid), targetUserEmail: users.member.email }));
    await assertFails(addDoc(col(users.child), notification({ sourceType: 'chore-assignment', targetUserUid: users.child.uid })));
    // Long temporary-task names still fit; unbounded text does not.
    await assertSucceeds(addDoc(col(users.member), notification({ message: 'x'.repeat(900) })));
    await assertFails(addDoc(col(users.member), notification({ message: 'x'.repeat(1001) })));
  });

  test('a leaving member records their own departure in the same batch', async () => {
    const leave = (user: Identity, extra: (batch: ReturnType<typeof writeBatch>, db: ReturnType<typeof dbFor>) => void) => {
      const db = dbFor(user);
      const batch = writeBatch(db);
      batch.delete(doc(db, 'households', householdA, 'members', user.uid));
      extra(batch, db);
      return batch.commit();
    };
    const audit = (user: Identity) => ({
      actorUid: user.uid, actorEmail: user.email, actorName: 'X', action: 'member.left',
      targetUid: user.uid, targetEmail: user.email, targetName: 'X', createdAt: 'x',
    });
    const notice = (user: Identity) => notification({
      category: 'system', title: 'Member left household', message: 'X left the household.',
      deepLink: '/household?tab=members', sourceType: 'household-member-left', sourceId: user.uid,
    });
    // Without leaving, nobody may write a departure record.
    await assertFails(addDoc(collection(dbFor(users.member), 'households', householdA, 'auditLogs'), audit(users.member)));
    await assertFails(addDoc(collection(dbFor(users.member), 'households', householdA, 'notifications'), notice(users.member)));
    // Departure records must describe the leaver.
    await assertFails(leave(users.member, (b, db) => b.set(doc(collection(db, 'households', householdA, 'auditLogs')), { ...audit(users.member), targetUid: users.owner.uid })));
    await assertSucceeds(leave(users.admin, (b, db) => {
      b.set(doc(collection(db, 'households', householdA, 'auditLogs')), audit(users.admin));
      b.set(doc(collection(db, 'households', householdA, 'notifications')), notice(users.admin));
    }));
    await assertSucceeds(leave(users.member, (b, db) => {
      b.set(doc(collection(db, 'households', householdA, 'auditLogs')), audit(users.member));
      b.set(doc(collection(db, 'households', householdA, 'notifications')), notice(users.member));
    }));
  });

  test('owners can check that a new code is free inside the generation transaction', async () => {
    await assertSucceeds(getDoc(doc(dbFor(users.owner), 'inviteCodes', 'FREE-CODE-00')));
    await assertFails(getDoc(doc(dbFor(users.member), 'inviteCodes', 'AAAA-BBBB-CC')));
  });

  test('reading a missing profile is a plain denial', async () => {
    await assertFails(getDoc(doc(dbFor(users.member), 'users', 'nobody@example.test')));
  });
});

describe('invite codes', () => {
  test('owners and admins create and revoke invites; others cannot', async () => {
    const invite = {
      code: 'ZZZZ-YYYY-XX', householdId: householdA, createdByUid: users.admin.uid, createdByEmail: users.admin.email,
      createdAt: 'x', expiresAt: inMinutes(30), maxUses: 1, useCount: 0,
    };
    await assertSucceeds(setDoc(doc(dbFor(users.admin), 'inviteCodes', 'ZZZZ-YYYY-XX'), invite));
    await assertFails(setDoc(doc(dbFor(users.member), 'inviteCodes', 'MMMM-MMMM-MM'), {
      ...invite, code: 'MMMM-MMMM-MM', createdByUid: users.member.uid, createdByEmail: users.member.email,
    }));
    await assertFails(setDoc(doc(dbFor(users.ownerB), 'inviteCodes', 'BBBB-BBBB-BB'), {
      ...invite, code: 'BBBB-BBBB-BB', createdByUid: users.ownerB.uid, createdByEmail: users.ownerB.email,
    }));
    await assertSucceeds(updateDoc(doc(dbFor(users.owner), 'inviteCodes', 'AAAA-BBBB-CC'), { revokedAt: 'now' }));
  });

  test('invites cannot be pre-used or created with unlimited uses', async () => {
    const db = dbFor(users.owner);
    await assertFails(setDoc(doc(db, 'inviteCodes', 'PPPP-PPPP-PP'), {
      code: 'PPPP-PPPP-PP', householdId: householdA, createdByUid: users.owner.uid, createdByEmail: users.owner.email,
      createdAt: 'x', expiresAt: inMinutes(30), maxUses: 1000, useCount: 0,
    }));
  });

  test('outsiders cannot read, redeem or reset invite codes from the client', async () => {
    const db = dbFor(users.stranger);
    await assertFails(getDoc(doc(db, 'inviteCodes', 'AAAA-BBBB-CC')));
    await assertFails(updateDoc(doc(db, 'inviteCodes', 'AAAA-BBBB-CC'), {
      useCount: 1, usedByUid: users.stranger.uid, usedAt: 'now',
    }));
    // Even owners cannot rewrite the redemption counter; only the server does.
    await assertFails(updateDoc(doc(dbFor(users.owner), 'inviteCodes', 'AAAA-BBBB-CC'), { useCount: 1 }));
    await assertFails(updateDoc(doc(dbFor(users.owner), 'inviteCodes', 'AAAA-BBBB-CC'), { maxUses: 10 }));
  });
});

describe('profiles', () => {
  test('an owner cannot point someone else’s profile at their household', async () => {
    await assertFails(updateDoc(doc(dbFor(users.ownerB), 'users', users.stranger.email), {
      householdId: householdB, role: 'owner', permissions: {},
    }));
    await assertFails(getDoc(doc(dbFor(users.ownerB), 'users', users.stranger.email)));
  });

  test('owners update or clear the profiles of their own members only', async () => {
    const db = dbFor(users.owner);
    await assertSucceeds(updateDoc(doc(db, 'users', users.member.email), { role: 'admin', permissions: {} }));
    await assertSucceeds(updateDoc(doc(db, 'users', users.guest.email), { householdId: null, role: 'member', permissions: {} }));
    await assertFails(updateDoc(doc(db, 'users', users.ownerB.email), { role: 'member' }));
    await assertFails(updateDoc(doc(db, 'users', users.member.email), { householdId: householdB }));
  });

  test('users cannot point their own profile at a household they do not belong to', async () => {
    await assertFails(updateDoc(doc(dbFor(users.stranger), 'users', users.stranger.email), {
      householdId: householdA, role: 'member', permissions: {},
    }));
  });

  test('people without a household cannot read each other', async () => {
    await assertFails(getDoc(doc(dbFor(users.lonerA), 'users', users.lonerB.email)));
    await assertSucceeds(getDoc(doc(dbFor(users.lonerA), 'users', users.lonerA.email)));
  });

  test('approved housemates can read each other; pending and outsiders cannot', async () => {
    await assertSucceeds(getDoc(doc(dbFor(users.member), 'users', users.owner.email)));
    await assertFails(getDoc(doc(dbFor(users.pending), 'users', users.owner.email)));
    await assertFails(getDoc(doc(dbFor(users.ownerB), 'users', users.owner.email)));
  });

  test('users create their own profile only, without a household', async () => {
    const newcomer = { uid: 'newcomer', email: 'newcomer@example.test' };
    await assertSucceeds(setDoc(doc(dbFor(newcomer), 'users', newcomer.email), {
      email: newcomer.email, uid: newcomer.uid, householdId: null, role: 'member',
    }));
    await assertFails(setDoc(doc(dbFor(newcomer), 'users', 'someone@example.test'), {
      email: 'someone@example.test', householdId: null, role: 'member',
    }));
    await assertFails(setDoc(doc(dbFor(users.stranger), 'users', 'x@example.test'), {
      email: 'x@example.test', householdId: householdA, role: 'owner',
    }));
  });

  test('per-user notification inboxes cannot be written by others', async () => {
    await assertFails(setDoc(doc(dbFor(users.owner), 'users', users.member.email, 'notifications', 'n'), { message: 'hi' }));
  });
});

describe('profile demographics (no longer collected)', () => {
  const seedLegacyDemographics = () => environment.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'users', users.member.email), { birthday: '2/2', gender: 'female' });
  });

  test('a profile that still holds birthday and gender stays readable and updatable', async () => {
    await seedLegacyDemographics();
    await assertSucceeds(getDoc(doc(dbFor(users.member), 'users', users.member.email)));
    await assertSucceeds(getDoc(doc(dbFor(users.owner), 'users', users.member.email)));
    await assertSucceeds(updateDoc(doc(dbFor(users.member), 'users', users.member.email), { displayName: 'Still works' }));
    await assertSucceeds(setDoc(doc(dbFor(users.member), 'users', users.member.email), { timeZone: 'America/Chicago' }, { merge: true }));
    await assertSucceeds(updateDoc(doc(dbFor(users.owner), 'users', users.member.email), { role: 'admin', permissions: {} }));
  });

  test('the owner may remove them but nobody may change them', async () => {
    await seedLegacyDemographics();
    const ref = doc(dbFor(users.member), 'users', users.member.email);
    await assertFails(updateDoc(ref, { birthday: '3/3' }));
    await assertFails(updateDoc(ref, { gender: 'male' }));
    await assertSucceeds(updateDoc(ref, { birthday: deleteField(), gender: deleteField() }));
  });

  test('new writes cannot add birthday or gender', async () => {
    const ref = doc(dbFor(users.member), 'users', users.member.email);
    await assertFails(updateDoc(ref, { birthday: '2/2' }));
    await assertFails(updateDoc(ref, { gender: 'female' }));
    await assertFails(setDoc(ref, { displayName: 'x', gender: 'female' }, { merge: true }));
    const newcomer = { uid: 'demo-newcomer', email: 'demo.newcomer@example.test' };
    await assertFails(setDoc(doc(dbFor(newcomer), 'users', newcomer.email), {
      email: newcomer.email, householdId: null, role: 'member', birthday: '1/1',
    }));
    await assertFails(setDoc(doc(dbFor(newcomer), 'users', newcomer.email), {
      email: newcomer.email, householdId: null, role: 'member', gender: 'female',
    }));
  });
});

describe('push tokens', () => {
  const pushDoc = (reader: Identity, owner: Identity = reader, id = 'push') =>
    doc(dbFor(reader), 'users', owner.email, 'private', id);

  test('the owner saves, reads and clears their own push tokens', async () => {
    await assertSucceeds(setDoc(pushDoc(users.member), { fcmTokens: ['token-1'], updatedAt: serverTimestamp() }, { merge: true }));
    await assertSucceeds(getDoc(pushDoc(users.member)));
    await assertSucceeds(updateDoc(pushDoc(users.member), { fcmTokens: ['token-1', 'token-2'] }));
    await assertSucceeds(deleteDoc(pushDoc(users.member)));
  });

  test('housemates, managers and outsiders can neither read nor write them', async () => {
    await assertSucceeds(setDoc(pushDoc(users.member), { fcmTokens: ['token-1'] }));
    for (const user of [users.owner, users.admin, users.child, users.guest, users.pending, users.ownerB, users.stranger]) {
      await assertFails(getDoc(pushDoc(user, users.member)));
      await assertFails(setDoc(pushDoc(user, users.member), { fcmTokens: ['hijack'] }));
      await assertFails(deleteDoc(pushDoc(user, users.member)));
    }
    await assertFails(getDocs(collection(dbFor(users.owner), 'users', users.member.email, 'private')));
  });

  test('only the push document exists and it holds only bounded tokens', async () => {
    await assertFails(setDoc(pushDoc(users.member, users.member, 'other'), { fcmTokens: [] }));
    await assertFails(setDoc(pushDoc(users.member), { fcmTokens: ['a'], extra: true }));
    await assertFails(setDoc(pushDoc(users.member), { fcmTokens: 'not-a-list' }));
    await assertFails(setDoc(pushDoc(users.member), { fcmTokens: Array.from({ length: 21 }, (_, i) => `t${i}`) }));
    await assertFails(setDoc(pushDoc(users.member), { fcmTokens: ['a'], updatedAt: Timestamp.fromDate(new Date('2020-01-01')) }));
  });

  test('a full list can be replaced by a trimmed one that adds a new device', async () => {
    const full = Array.from({ length: 20 }, (_, i) => `t${i}`);
    await assertSucceeds(setDoc(pushDoc(users.member), { fcmTokens: full, updatedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(pushDoc(users.member), { fcmTokens: [...full.slice(1), 'new'], updatedAt: serverTimestamp() }));
    await assertFails(setDoc(pushDoc(users.member), { fcmTokens: [...full, 'new'], updatedAt: serverTimestamp() }));
  });

  test('legacy profile tokens may only shrink or be removed', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), 'users', users.member.email), { fcmTokens: ['old-1', 'old-2'] });
    });
    const profile = doc(dbFor(users.member), 'users', users.member.email);
    await assertFails(updateDoc(profile, { fcmTokens: ['old-1', 'old-2', 'new'] }));
    await assertFails(updateDoc(profile, { fcmTokens: ['other'] }));
    await assertSucceeds(updateDoc(profile, { fcmTokens: ['old-1'] }));
    await assertSucceeds(updateDoc(profile, { fcmTokens: deleteField() }));
    await assertFails(updateDoc(profile, { fcmTokens: ['new'] }));
    // Moving tokens into the private document and dropping the field is one batch.
    await environment.withSecurityRulesDisabled(async context => {
      await updateDoc(doc(context.firestore(), 'users', users.member.email), { fcmTokens: ['old-1'] });
    });
    const db = dbFor(users.member);
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', users.member.email, 'private', 'push'), { fcmTokens: ['old-1', 'new'], updatedAt: serverTimestamp() }, { merge: true });
    batch.update(doc(db, 'users', users.member.email), { fcmTokens: deleteField() });
    await assertSucceeds(batch.commit());
  });

  test('new profiles cannot carry push tokens', async () => {
    const newcomer = { uid: 'push-newcomer', email: 'push.newcomer@example.test' };
    await assertFails(setDoc(doc(dbFor(newcomer), 'users', newcomer.email), {
      email: newcomer.email, householdId: null, role: 'member', fcmTokens: ['t'],
    }));
  });
});

describe('notifications', () => {
  test('approved members create well-formed household notifications', async () => {
    await assertSucceeds(addDoc(collection(dbFor(users.member), 'households', householdA, 'notifications'), notification({
      targetUserEmail: users.owner.email,
      targetUserUid: users.owner.uid,
      sourceType: 'chore-assignment',
      sourceId: 'task',
    })));
  });

  test('external and protocol-relative links are rejected', async () => {
    const db = dbFor(users.member);
    for (const deepLink of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/\t/evil.example', '/\n/evil.example', '/chores\u0000']) {
      await assertFails(addDoc(collection(db, 'households', householdA, 'notifications'), notification({ deepLink })));
    }
  });

  test('targets outside the household are rejected', async () => {
    const db = dbFor(users.member);
    await assertFails(addDoc(collection(db, 'households', householdA, 'notifications'), notification({
      targetUserEmail: users.ownerB.email,
    })));
    await assertFails(addDoc(collection(db, 'households', householdA, 'notifications'), notification({
      targetUserUid: users.ownerB.uid,
    })));
  });

  test('unknown fields, wrong households and pending or outside senders are rejected', async () => {
    await assertFails(addDoc(collection(dbFor(users.member), 'households', householdA, 'notifications'), notification({ pushTo: 'all' })));
    await assertFails(addDoc(collection(dbFor(users.member), 'households', householdA, 'notifications'), notification({ householdId: householdB })));
    await assertFails(addDoc(collection(dbFor(users.pending), 'households', householdA, 'notifications'), notification()));
    await assertFails(addDoc(collection(dbFor(users.legacy), 'households', householdA, 'notifications'), notification()));
    await assertFails(addDoc(collection(dbFor(users.ownerB), 'households', householdA, 'notifications'), notification()));
  });

  test('restricted members can list with the bell category filter', async () => {
    // The bell, center and dashboard tile filter categories in the query for
    // members who cannot see every module (see notification-query.ts).
    const bellQuery = query(
      collection(dbFor(users.child), 'households', householdA, 'notifications'),
      where('category', 'in', ['chores', 'pets', 'system', 'general']),
      where('createdAt', '>=', Timestamp.fromDate(new Date(Date.now() - 7 * 86400000))),
      orderBy('createdAt', 'desc'),
      limit(30),
    );
    await assertSucceeds(getDocs(bellQuery));
    await assertFails(getDocs(query(
      collection(dbFor(users.pending), 'households', householdA, 'notifications'),
      where('category', 'in', ['system', 'general']),
    )));
  });

  test('members dismiss only their own state', async () => {
    const db = dbFor(users.member);
    await assertSucceeds(updateDoc(doc(db, 'households', householdA, 'notifications', 'existing'), {
      readBy: { [users.member.uid]: { at: now(), uid: users.member.uid } },
    }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'notifications', 'existing'), {
      readBy: { [users.owner.uid]: { at: now(), uid: users.owner.uid } },
    }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'notifications', 'existing'), { message: 'changed' }));
  });

  test('audience, when present, must match the targeting; absent is still accepted', async () => {
    const col = collection(dbFor(users.member), 'households', householdA, 'notifications');
    const targeted = (overrides: Record<string, unknown> = {}) => notification({
      targetUserUid: users.owner.uid, targetUserEmail: users.owner.email, ...overrides,
    });
    // Present and valid.
    await assertSucceeds(addDoc(col, targeted({ audience: [users.owner.uid] })));
    await assertSucceeds(addDoc(col, notification({ targetUserUid: users.owner.uid, audience: [users.owner.uid] })));
    await assertSucceeds(addDoc(col, notification({ audience: ['*'] })));
    // Absent: clients cached from before the field existed.
    await assertSucceeds(addDoc(col, targeted()));
    await assertSucceeds(addDoc(col, notification()));
    // Present and wrong on a targeted document.
    await assertFails(addDoc(col, targeted({ audience: ['*'] })));
    await assertFails(addDoc(col, targeted({ audience: [users.member.uid] })));
    await assertFails(addDoc(col, targeted({ audience: [users.owner.uid, users.member.uid] })));
    await assertFails(addDoc(col, targeted({ audience: [users.owner.uid, '*'] })));
    await assertFails(addDoc(col, targeted({ audience: [] })));
    await assertFails(addDoc(col, targeted({ audience: users.owner.uid })));
    await assertFails(addDoc(col, targeted({ audience: { 0: users.owner.uid } })));
    await assertFails(addDoc(col, targeted({ audience: [users.owner.email] })));
    // Present and wrong on a household-wide document.
    await assertFails(addDoc(col, notification({ audience: [users.member.uid] })));
    await assertFails(addDoc(col, notification({ audience: ['*', users.member.uid] })));
    await assertFails(addDoc(col, notification({ audience: [] })));
    await assertFails(addDoc(col, notification({ audience: '*' })));
    await assertFails(addDoc(col, notification({ audience: [1] })));
    await assertFails(addDoc(col, notification({ audience: null })));
    // A legacy email-only target has no uid to name: only the empty list.
    await assertSucceeds(addDoc(col, notification({ targetUserEmail: users.owner.email, audience: [] })));
    await assertFails(addDoc(col, notification({ targetUserEmail: users.owner.email, audience: ['*'] })));
    await assertFails(addDoc(col, notification({ targetUserEmail: users.owner.email, audience: [users.owner.uid] })));
  });

  test('clients cannot change, add or remove audience on update', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'households', householdA, 'notifications', 'with-audience'),
        notification({ category: 'maintenance', audience: ['*'] }));
      await setDoc(doc(context.firestore(), 'households', householdA, 'notifications', 'legacy-maintenance'),
        notification({ category: 'maintenance' }));
    });
    const state = { at: now(), uid: users.member.uid };
    const resolved = { resolvedAt: now(), resolvedBy: state };
    for (const user of [users.member, users.owner]) {
      const withAudience = doc(dbFor(user), 'households', householdA, 'notifications', 'with-audience');
      const legacy = doc(dbFor(user), 'households', householdA, 'notifications', 'existing');
      await assertFails(updateDoc(withAudience, { audience: [user.uid] }));
      await assertFails(updateDoc(withAudience, { audience: ['*', user.uid] }));
      await assertFails(updateDoc(withAudience, { audience: deleteField() }));
      await assertFails(updateDoc(legacy, { audience: ['*'] }));
      await assertFails(updateDoc(legacy, { audience: [user.uid] }));
    }
    // Not alongside the two updates clients may make.
    const db = dbFor(users.member);
    await assertFails(updateDoc(doc(db, 'households', householdA, 'notifications', 'with-audience'), {
      [`dismissedBy.${users.member.uid}`]: state, audience: [users.member.uid],
    }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'notifications', 'with-audience'), {
      ...resolved, audience: [users.member.uid],
    }));
    await assertFails(updateDoc(doc(db, 'households', householdA, 'notifications', 'legacy-maintenance'), {
      ...resolved, audience: ['*'],
    }));
    // Those updates still work and leave audience as it was.
    await assertSucceeds(updateDoc(doc(db, 'households', householdA, 'notifications', 'with-audience'), {
      [`dismissedBy.${users.member.uid}`]: state,
    }));
    await assertSucceeds(updateDoc(doc(db, 'households', householdA, 'notifications', 'with-audience'), resolved));
  });
});

// EXPERIMENT (not the production rules). A later release will make reads
// require `audience`. This block loads a copy of firestore.rules in which
// notification `get, list` additionally need
// `resource.data.audience.hasAny([request.auth.uid, '*'])`, in its own
// emulator project, and records which query shapes the rules engine accepts.
// firestore.rules itself keeps the permission-only read rule.
describe('EXPERIMENT: notification reads limited by audience (alternate ruleset)', () => {
  const experimentProject = 'demo-homehub-audience-experiment';
  const productionRead = "allow read: if hasHouseholdPermission(householdId, 'notifications.view');";
  const experimentRead = "allow get, list: if hasHouseholdPermission(householdId, 'notifications.view') &&\n" +
    "          resource.data.audience.hasAny([request.auth.uid, '*']);";
  let experiment: RulesTestEnvironment;
  const as = (user: Identity) => collection(
    experiment.authenticatedContext(user.uid, { email: user.email }).firestore(),
    'households', householdA, 'notifications');
  const since = () => where('createdAt', '>=', Timestamp.fromDate(new Date(Date.now() - 7 * 86400000)));
  const ids = (snapshot: { docs: Array<{ id: string }> }) => snapshot.docs.map(d => d.id).sort();
  const childCategories = ['chores', 'pets', 'system', 'general'];

  before(async () => {
    const rules = readFileSync(process.env.HOMEHUB_FIRESTORE_RULES ?? 'firestore.rules', 'utf8');
    if (rules.split(productionRead).length !== 2) throw new Error('Notification read rule not found exactly once.');
    experiment = await initializeTestEnvironment({
      projectId: experimentProject,
      firestore: { rules: rules.replace(productionRead, experimentRead) },
    });
  });

  beforeEach(async () => {
    await experiment.clearFirestore();
    await experiment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      for (const [user, role] of [[users.owner, 'owner'], [users.member, 'member'], [users.child, 'child']] as const) {
        await setDoc(doc(db, 'households', householdA, 'members', user.uid), { ...user, role, status: 'active' });
      }
      const put = (id: string, minutesAgo: number, overrides: Record<string, unknown>) =>
        setDoc(doc(db, 'households', householdA, 'notifications', id), notification({ createdAt: inMinutes(-minutesAgo), ...overrides }));
      await put('everyone-chores', 1, { audience: ['*'] });
      await put('everyone-shopping', 2, { category: 'shopping', audience: ['*'] });
      await put('for-member', 3, { targetUserUid: users.member.uid, audience: [users.member.uid] });
      await put('for-child', 4, { targetUserUid: users.child.uid, audience: [users.child.uid] });
      await put('for-child-shopping', 5, { category: 'shopping', targetUserUid: users.child.uid, audience: [users.child.uid] });
      await put('for-owner', 6, { category: 'system', targetUserUid: users.owner.uid, audience: [users.owner.uid] });
      await put('legacy-no-audience', 7, {});
      await put('unresolvable', 8, { targetUserEmail: 'gone@example.test', audience: [] });
    });
  });

  after(async () => experiment?.cleanup());

  test('(a) array-contains-any [uid, "*"] with the createdAt window and limit is allowed and returns only matching documents', async () => {
    const snapshot = await assertSucceeds(getDocs(query(
      as(users.member), where('audience', 'array-contains-any', [users.member.uid, '*']),
      since(), orderBy('createdAt', 'desc'), limit(30))));
    assert.deepEqual(ids(snapshot), ['everyone-chores', 'everyone-shopping', 'for-member']);
  });

  test('(b) the same combined with the category "in" filter', async () => {
    // Result (emulator, firebase 12 SDK): `array-contains-any` and `in` are
    // accepted together in one query, by the SDK and by the rules engine
    // (2 audience values x up to 6 categories stays under Firestore's limit of
    // 30 disjunctions). The emulator does not enforce composite indexes, so the
    // index this needs is only checked against live Firestore.
    const combined = await assertSucceeds(getDocs(query(
      as(users.child), where('audience', 'array-contains-any', [users.child.uid, '*']),
      where('category', 'in', childCategories), since(), orderBy('createdAt', 'desc'), limit(30))));
    assert.deepEqual(ids(combined), ['everyone-chores', 'for-child']);
    // Fallback shape, also accepted: one query per audience value, merged by the client.
    const perValue = async (value: string) => ids(await assertSucceeds(getDocs(query(
      as(users.child), where('audience', 'array-contains', value),
      where('category', 'in', childCategories), since(), orderBy('createdAt', 'desc'), limit(30)))));
    assert.deepEqual(await perValue(users.child.uid), ['for-child']);
    assert.deepEqual(await perValue('*'), ['everyone-chores']);
  });

  test('(c) lists that do not name the caller\'s audience are denied', async () => {
    await assertFails(getDocs(as(users.member)));
    await assertFails(getDocs(query(as(users.member), since(), orderBy('createdAt', 'desc'), limit(30))));
    await assertFails(getDocs(query(as(users.member), where('category', 'in', childCategories), since(), orderBy('createdAt', 'desc'))));
    // Someone else's uid, alone or next to '*'.
    await assertFails(getDocs(query(as(users.member), where('audience', 'array-contains', users.child.uid))));
    await assertFails(getDocs(query(as(users.member), where('audience', 'array-contains-any', [users.child.uid, '*']))));
    await assertFails(getDocs(query(as(users.member), where('audience', 'array-contains-any', [users.member.uid, users.child.uid, '*']))));
  });

  test('single documents follow the same rule', async () => {
    const at = (user: Identity, id: string) => doc(as(user), id);
    await assertSucceeds(getDoc(at(users.member, 'for-member')));
    await assertSucceeds(getDoc(at(users.member, 'everyone-chores')));
    await assertFails(getDoc(at(users.member, 'for-child')));
    await assertFails(getDoc(at(users.member, 'unresolvable')));
    // A document written before the field existed is unreadable: the backfill must run first.
    await assertFails(getDoc(at(users.member, 'legacy-no-audience')));
  });
});

describe('audit log', () => {
  test('owners and admins write known actions as themselves; others cannot write at all', async () => {
    const col = (user: Identity) => collection(dbFor(user), 'households', householdA, 'auditLogs');
    await assertSucceeds(addDoc(col(users.admin), {
      actorUid: users.admin.uid, actorEmail: users.admin.email, action: 'invite.generated', createdAt: 'x',
    }));
    await assertFails(addDoc(col(users.owner), {
      actorUid: users.owner.uid, actorEmail: users.owner.email, action: 'anything.else', createdAt: 'x',
    }));
    await assertFails(addDoc(col(users.owner), {
      actorUid: users.owner.uid, actorEmail: users.owner.email, action: 'member.removed', createdAt: 'x', extra: true,
    }));
    for (const user of [users.member, users.child, users.guest]) {
      await assertFails(addDoc(col(user), {
        actorUid: user.uid, actorEmail: user.email, action: 'ownership.transferred', createdAt: '2020-01-01',
      }));
    }
    await assertFails(addDoc(col(users.member), {
      actorUid: users.owner.uid, actorEmail: users.owner.email, action: 'member.removed', createdAt: 'x',
    }));
    await assertFails(addDoc(col(users.pending), {
      actorUid: users.pending.uid, actorEmail: users.pending.email, action: 'member.removed', createdAt: 'x',
    }));
    await assertSucceeds(getDocs(col(users.owner)));
    await assertFails(getDocs(col(users.member)));
  });
});

describe('AI usage counters', () => {
  test('no client can read, create or reset AI quota counters', async () => {
    for (const user of [users.owner, users.admin, users.member]) {
      const ref = doc(dbFor(user), 'aiUsage', `user_${user.uid}_2026-08-01`);
      await assertFails(getDoc(ref));
      await assertFails(setDoc(ref, { count: 0 }));
    }
    await assertFails(getDocs(collection(dbFor(users.owner), 'aiUsage')));
  });
});

describe('Home Assistant credentials', () => {
  // Only the server (Admin SDK, after authorizing the caller) touches these.
  const everyone = [
    users.owner, users.admin, users.member, users.child, users.guest, users.denied, users.pending,
    users.legacy, users.ownerB, users.stranger,
  ];
  const credentials = (user: Identity, id = 'credentials') =>
    doc(dbFor(user), 'households', householdA, 'home-automation', id);

  test('no client can read the stored token, owners included', async () => {
    for (const user of everyone) {
      await assertFails(getDoc(credentials(user)));
      await assertFails(getDocs(collection(dbFor(user), 'households', householdA, 'home-automation')));
    }
    await assertFails(getDoc(doc(environment.unauthenticatedContext().firestore(), 'households', householdA, 'home-automation', 'credentials')));
  });

  test('no client can save, change or clear credentials, owners included', async () => {
    const data = { url: 'https://ha.example.test', accessToken: 'new-token' };
    for (const user of everyone) {
      await assertFails(setDoc(credentials(user), data));
      await assertFails(updateDoc(credentials(user), { accessToken: 'swapped' }));
      await assertFails(deleteDoc(credentials(user)));
      await assertFails(setDoc(credentials(user, 'other'), data));
    }
  });
});

describe('chore completion stamps and chore settings', () => {
  const chore = (user: Identity, id = 'task') => doc(dbFor(user), 'households', householdA, 'chores', id);

  test('a completion stamp must be the server time', async () => {
    // A client-chosen (backdated) stamp is denied, for completers and editors alike.
    await assertFails(updateDoc(chore(users.child), {
      isCompleted: true,
      completedAt: '2026-07-01T12:00:00.000Z',
      completedAtServer: Timestamp.fromDate(new Date('2026-07-01T12:00:00.000Z')),
    }));
    await assertFails(updateDoc(chore(users.owner), {
      isCompleted: true,
      completedAtServer: Timestamp.fromDate(new Date('2026-07-01T12:00:00.000Z')),
    }));
    await assertSucceeds(updateDoc(chore(users.child), {
      isCompleted: true,
      completedAt: '2026-08-04T12:00:00.000Z',
      completedAtServer: serverTimestamp(),
      completedSubTasks: [],
    }));
  });

  test('a completed chore keeps its stamp; undo removes it', async () => {
    await assertSucceeds(updateDoc(chore(users.child), {
      isCompleted: true, completedAt: '2026-08-04T12:00:00.000Z', completedAtServer: serverTimestamp(),
    }));
    // Rewriting the stamp of a completed chore is denied, even for editors.
    await assertFails(updateDoc(chore(users.owner), { completedAtServer: Timestamp.fromDate(new Date('2026-07-01T12:00:00.000Z')) }));
    await assertFails(updateDoc(chore(users.child), { completedAtServer: deleteField() }));
    // Editors may still change other fields of a completed chore.
    await assertSucceeds(updateDoc(chore(users.owner), { task: 'Renamed after completion' }));
    // Undo: reopen and clear the completion fields.
    await assertSucceeds(updateDoc(chore(users.child), {
      isCompleted: false, completedAt: deleteField(), completedSubTasks: deleteField(), completedAtServer: deleteField(),
    }));
  });

  test('a completion without a server stamp is denied', async () => {
    await assertFails(updateDoc(chore(users.child), { isCompleted: true, completedAt: '2026-08-04T12:00:00.000Z' }));
    await assertFails(updateDoc(chore(users.owner), { isCompleted: true, completedAt: '2026-08-04T12:00:00.000Z' }));
    await assertFails(setDoc(doc(dbFor(users.member), 'households', householdA, 'chores', 'unstamped-done'), {
      task: 'Unstamped', isCompleted: true, completedAt: '2026-08-04T12:00:00.000Z',
    }));
  });

  test('a chore completed before stamps existed can still be edited and reopened', async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'households', householdA, 'chores', 'legacy-done'), {
        task: 'Legacy done', isCompleted: true, completedAt: '2026-07-01T12:00:00.000Z',
      });
    });
    await assertSucceeds(updateDoc(chore(users.owner, 'legacy-done'), { task: 'Legacy done (renamed)' }));
    await assertSucceeds(updateDoc(chore(users.child, 'legacy-done'), { isCompleted: false, completedAt: deleteField() }));
  });

  test('chores cannot be created already completed with a client-chosen stamp', async () => {
    const db = dbFor(users.member);
    await assertFails(setDoc(doc(db, 'households', householdA, 'chores', 'fake-done'), {
      task: 'Fake', isCompleted: true, completedAt: '2026-07-01T12:00:00.000Z',
      completedAtServer: Timestamp.fromDate(new Date('2026-07-01T12:00:00.000Z')),
    }));
    await assertSucceeds(setDoc(doc(db, 'households', householdA, 'chores', 'open-task'), {
      task: 'Open', isCompleted: false,
    }));
  });

  test('only owners and admins change chore preferences; chore viewers read them', async () => {
    const prefs = (user: Identity, id = 'preferences') => doc(dbFor(user), 'households', householdA, 'chore-settings', id);
    await assertSucceeds(setDoc(prefs(users.owner), { leaderboardEnabled: false, updatedAt: '2026-08-01T12:00:00.000Z' }));
    await assertSucceeds(setDoc(prefs(users.admin), { leaderboardEnabled: true }));
    await assertFails(setDoc(prefs(users.member), { leaderboardEnabled: false }));
    await assertFails(setDoc(prefs(users.child), { leaderboardEnabled: false }));
    await assertFails(setDoc(prefs(users.owner), { leaderboardEnabled: 'no' }));
    await assertFails(setDoc(prefs(users.owner), { leaderboardEnabled: true, points: 9000 }));
    await assertFails(setDoc(prefs(users.owner, 'other'), { leaderboardEnabled: true }));
    await assertFails(deleteDoc(prefs(users.owner)));
    await assertSucceeds(getDoc(prefs(users.child)));
    await assertSucceeds(getDoc(prefs(users.guest)));
    await assertFails(getDoc(prefs(users.pending)));
    await assertFails(getDoc(doc(dbFor(users.ownerB), 'households', householdA, 'chore-settings', 'preferences')));
  });
});

describe('yearly chore stats', () => {
  const stats = (user: Identity, household = householdA) => doc(dbFor(user), 'households', household, 'stats', 'chores-2026');

  test('members who can view chores read stats; nobody else does and no client writes', async () => {
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'households', householdA, 'stats', 'chores-2026'), {
        year: 2026, completed: 3, byAssignee: { member_a_x: 3 }, names: { member_a_x: 'Member A' },
      });
    });
    await assertSucceeds(getDoc(stats(users.member)));
    await assertSucceeds(getDoc(stats(users.child)));
    await assertFails(getDoc(stats(users.pending)));
    await assertFails(getDoc(stats(users.ownerB)));
    await assertFails(getDoc(doc(environment.unauthenticatedContext().firestore(), 'households', householdA, 'stats', 'chores-2026')));
    for (const user of [users.owner, users.admin, users.member]) {
      await assertFails(setDoc(stats(user), { year: 2026, completed: 999 }));
      await assertFails(updateDoc(stats(user), { completed: 0 }));
      await assertFails(deleteDoc(stats(user)));
    }
    await assertFails(setDoc(doc(dbFor(users.owner), 'households', householdA, 'stats', 'anything-else'), { completed: 1 }));
  });
});

// Content shapes (QA-8). Every accepted fixture is built from a real client
// writer (file noted per fixture); the rest are the shapes that must be refused.
describe('content shapes: chores and templates', () => {
  const noAssign = { uid: 'no-assign-a', email: 'no.assign.a@example.test' };
  const chores = (user: Identity) => collection(dbFor(user), 'households', householdA, 'chores');
  const chore = (user: Identity, id: string) => doc(dbFor(user), 'households', householdA, 'chores', id);
  const template = (user: Identity, id: string) => doc(dbFor(user), 'households', householdA, 'chore-templates', id);

  beforeEach(async () => {
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      // A member whose chores.assign is switched off: may create, edit, complete.
      await setDoc(doc(db, 'households', householdA, 'members', noAssign.uid), {
        uid: noAssign.uid, email: noAssign.email, role: 'member', status: 'active', permissions: { 'chores.assign': false },
      });
      // Shape the server upkeep writes (functions/src/reminders.ts), plus a legacy field.
      await setDoc(doc(db, 'households', householdA, 'chores', 'generated'), {
        task: 'Generated', assignedToEmail: users.member.email, assignedToDisplayName: 'Member A',
        dueDate: '2026-08-01T05:00:00.000Z', isCompleted: false, notes: '', subTasks: ['One'], completedSubTasks: [],
        templateId: 'tpl', originalDueDate: '2026-08-01', roomIds: [], legacyPriority: 'high',
      });
      await setDoc(doc(db, 'households', householdA, 'chore-templates', 'existing'), {
        task: 'Existing', notes: '', roomIds: ['kitchen'], subTasks: [], legacyColor: 'red',
        assignedToEmail: users.member.email,
        recurrence: { frequency: 'daily', interval: 1, assignedToEmail: users.member.email, dailyOptions: { excludeWeekends: false } },
      });
    });
  });

  // chore-chart-client.tsx handleCreateChore / quick-add-actions.ts createOneTimeChore
  const oneTime = (assignedToEmail: string, overrides: Record<string, unknown> = {}) => ({
    task: 'Water plants', notes: '', assignedToEmail, assignedToDisplayName: 'Someone',
    dueDate: '2026-08-02T12:00:00.000Z', originalDueDate: '2026-08-02', roomIds: [], isCompleted: false,
    completedSubTasks: [], sourceType: 'temporary', ...overrides,
  });
  // chore-chart-client.tsx handleAssignChores (one-time library assignment)
  const fromLibrary = (assignedToEmail: string) => ({
    task: 'Vacuum', assignedToEmail, assignedToDisplayName: 'Someone', dueDate: '2026-08-02T12:00:00.000Z',
    isCompleted: false, notes: '', subTasks: ['Rugs'], completedSubTasks: [], templateId: 'vacuum',
    sourceType: 'template', originalDueDate: '2026-08-02', roomIds: ['kitchen'],
  });

  test('every shipped chore write shape is accepted', async () => {
    await assertSucceeds(addDoc(chores(users.member), oneTime(users.owner.email)));
    await assertSucceeds(addDoc(chores(users.member), fromLibrary(users.child.email)));
    // Old clients: no sourceType, deterministic id over an existing chore.
    const { sourceType: _unused, ...legacy } = fromLibrary(users.member.email);
    void _unused;
    await assertSucceeds(setDoc(chore(users.member, 'generated'), legacy));
    await assertSucceeds(updateDoc(chore(users.child, 'task'), { completedSubTasks: ['Wipe'] }));
    // completion.ts completionUpdate / undoCompletionUpdate
    await assertSucceeds(updateDoc(chore(users.child, 'task'), {
      isCompleted: true, completedAt: '2026-08-04T12:00:00.000Z', completedAtServer: serverTimestamp(), completedSubTasks: [],
    }));
    await assertSucceeds(updateDoc(chore(users.child, 'task'), {
      isCompleted: false, completedAt: deleteField(), completedSubTasks: deleteField(), completedAtServer: deleteField(),
    }));
    // household-calendar.tsx moveChore; template edit propagation
    await assertSucceeds(updateDoc(chore(users.member, 'generated'), { dueDate: '2026-08-05T12:00:00.000Z', originalDueDate: '2026-08-05' }));
    await assertSucceeds(updateDoc(chore(users.member, 'generated'), { task: 'Renamed', notes: 'n', subTasks: [] }));
    // chore-chart-client.tsx handleReassign; household-management-client.tsx member removal
    await assertSucceeds(updateDoc(chore(users.member, 'generated'), { assignedToEmail: users.child.email, assignedToDisplayName: 'Child A' }));
    await assertSucceeds(updateDoc(chore(users.owner, 'generated'), { assignedToEmail: '', assignedToDisplayName: 'Unassigned' }));
  });

  test('a chore with a legacy field stays updatable on its other fields', async () => {
    await assertSucceeds(updateDoc(chore(users.member, 'generated'), { notes: 'Still editable' }));
    await assertSucceeds(updateDoc(chore(users.child, 'generated'), {
      isCompleted: true, completedAt: '2026-08-04T12:00:00.000Z', completedAtServer: serverTimestamp(),
    }));
    // ...but a client cannot add a new unknown field or rewrite the legacy one.
    await assertFails(updateDoc(chore(users.member, 'generated'), { legacyPriority: 'low' }));
  });

  test('unknown fields, wrong types and over-long strings are refused', async () => {
    await assertFails(addDoc(chores(users.member), oneTime(users.member.email, { points: 9000 })));
    await assertFails(addDoc(chores(users.member), oneTime(users.member.email, { isCompleted: 'no' })));
    await assertFails(addDoc(chores(users.member), oneTime(users.member.email, { roomIds: 'kitchen' })));
    await assertFails(addDoc(chores(users.member), oneTime(users.member.email, { task: 'x'.repeat(501) })));
    await assertFails(addDoc(chores(users.member), oneTime(users.member.email, { task: '' })));
    await assertFails(addDoc(chores(users.member), oneTime(users.member.email, { sourceType: 'server' })));
    const { task: _task, ...noTask } = oneTime(users.member.email);
    void _task;
    await assertFails(addDoc(chores(users.member), noTask));
    await assertFails(updateDoc(chore(users.member, 'task'), { notes: 'x'.repeat(5001) }));
    await assertFails(updateDoc(chore(users.child, 'task'), { completedSubTasks: 'all' }));
  });

  test('assigning a chore to someone else needs chores.assign', async () => {
    await assertFails(addDoc(chores(noAssign), oneTime(users.member.email)));
    await assertSucceeds(addDoc(chores(users.member), oneTime(users.owner.email)));
    // chores.create alone: yourself or unassigned.
    await assertSucceeds(addDoc(chores(noAssign), oneTime(noAssign.email)));
    await assertSucceeds(addDoc(chores(noAssign), oneTime('')));
    // Changing the assignee needs chores.assign, even to yourself.
    await assertFails(updateDoc(chore(noAssign, 'generated'), { assignedToEmail: users.child.email, assignedToDisplayName: 'Child A' }));
    await assertFails(updateDoc(chore(noAssign, 'generated'), { assignedToEmail: noAssign.email }));
    await assertSucceeds(updateDoc(chore(noAssign, 'generated'), { task: 'Edited without reassigning' }));
  });

  // chore-chart-client.tsx handleCreateChore (repeat) / quick-add-writes.ts repeatingChoreTemplate
  const repeating = (assignedToEmail: string, recurrence: Record<string, unknown> = { frequency: 'weekly', interval: 1, weeklyOptions: { daysOfWeek: [1, 3] } }) => ({
    task: 'Trash night', notes: '', roomIds: [], subTasks: [], recurrence: { ...recurrence, assignedToEmail }, assignedToEmail,
  });

  test('every shipped template write shape is accepted', async () => {
    await assertSucceeds(setDoc(template(users.member, 'weekly'), repeating(users.owner.email)));
    await assertSucceeds(setDoc(template(users.member, 'biweekly'), repeating(users.member.email,
      { frequency: 'biweekly', interval: 2, weeklyOptions: { daysOfWeek: [6] }, startDate: '2026-07-20' })));
    await assertSucceeds(setDoc(template(users.member, 'monthly'), repeating(users.member.email,
      { frequency: 'monthly', interval: 1, monthlyOptions: { mode: 'nthWeekday', nthWeekday: { week: 2, dayOfWeek: 3 } } })));
    await assertSucceeds(setDoc(template(users.member, 'daily'), repeating(users.member.email,
      { frequency: 'daily', interval: 1, dailyOptions: { excludeWeekends: true } })));
    // Library chore (chore-dialogs.tsx handleSave), then edited with merge.
    await assertSucceeds(setDoc(template(users.member, 'library'), { task: 'Dust', notes: '', roomIds: ['kitchen'], subTasks: ['Shelves'] }));
    await assertSucceeds(setDoc(template(users.member, 'existing'), { task: 'Existing (renamed)', notes: 'n', roomIds: [], subTasks: [] }, { merge: true }));
    // handleAssignChores (recurring, merge), handleUpdateRecurringTask, handleDeleteRecurringTask, handleDeleteRoom
    await assertSucceeds(setDoc(template(users.member, 'existing'), {
      recurrence: { frequency: 'monthly', interval: 1, monthlyOptions: { mode: 'dayOfMonth', dayOfMonth: 15 }, assignedToEmail: users.child.email },
      assignedToEmail: users.child.email,
    }, { merge: true }));
    await assertSucceeds(updateDoc(template(users.member, 'existing'), {
      assignedToEmail: users.member.email, recurrence: { frequency: 'weekly', interval: 1, weeklyOptions: { daysOfWeek: [2] }, assignedToEmail: users.member.email },
    }));
    await assertSucceeds(updateDoc(template(users.member, 'existing'), { roomIds: [] }));
    await assertSucceeds(updateDoc(template(users.member, 'existing'), { recurrence: null, assignedToEmail: null }));
  });

  test('template shapes are validated, including the recurrence map', async () => {
    await assertFails(setDoc(template(users.member, 'bad1'), { ...repeating(users.member.email), points: 5 }));
    await assertFails(setDoc(template(users.member, 'bad2'), { ...repeating(users.member.email), subTasks: 'one' }));
    await assertFails(setDoc(template(users.member, 'bad3'), { ...repeating(users.member.email), task: 'x'.repeat(501) }));
    await assertFails(setDoc(template(users.member, 'bad4'), repeating(users.member.email, { frequency: 'hourly', interval: 1 })));
    await assertFails(setDoc(template(users.member, 'bad5'), repeating(users.member.email, { frequency: 'daily', interval: 1, cron: '* * *' })));
    await assertFails(setDoc(template(users.member, 'bad6'), repeating(users.member.email, { frequency: 'weekly', interval: 1, weeklyOptions: { daysOfWeek: [0, 1, 2, 3, 4, 5, 6, 0] } })));
    await assertFails(setDoc(template(users.member, 'bad7'), { notes: 'No task' }));
    // A legacy field does not block edits of the other fields.
    await assertSucceeds(updateDoc(template(users.member, 'existing'), { notes: 'Edited' }));
  });

  test('setting a template assignee other than yourself needs chores.assign', async () => {
    await assertFails(setDoc(template(noAssign, 'other'), repeating(users.member.email)));
    await assertSucceeds(setDoc(template(noAssign, 'mine'), repeating(noAssign.email)));
    await assertSucceeds(setDoc(template(noAssign, 'lib'), { task: 'Dust', notes: '', roomIds: [], subTasks: [] }));
    // Only the recurrence assignee changed to someone else: still refused.
    await assertFails(updateDoc(template(noAssign, 'existing'), {
      recurrence: { frequency: 'daily', interval: 1, assignedToEmail: users.child.email },
    }));
    await assertFails(setDoc(template(noAssign, 'existing'), { recurrence: repeating(users.child.email).recurrence, assignedToEmail: users.child.email }, { merge: true }));
    // Keeping the current assignee or switching to yourself (EditRecurringTaskDialog) is allowed.
    await assertSucceeds(updateDoc(template(noAssign, 'existing'), {
      assignedToEmail: users.member.email, recurrence: { frequency: 'weekly', interval: 1, weeklyOptions: { daysOfWeek: [1] }, assignedToEmail: users.member.email },
    }));
    await assertSucceeds(updateDoc(template(noAssign, 'existing'), {
      assignedToEmail: noAssign.email, recurrence: { frequency: 'weekly', interval: 1, weeklyOptions: { daysOfWeek: [1] }, assignedToEmail: noAssign.email },
    }));
    await assertSucceeds(setDoc(template(users.member, 'assigned'), repeating(users.child.email)));
  });
});

describe('content shapes: shopping', () => {
  const items = (user: Identity, list = 'groceries') => collection(dbFor(user), 'households', householdA, 'shopping-lists', list, 'items');
  const item = (user: Identity, id: string) => doc(items(user), id);
  // shopping-items.ts buildShoppingListItem (shopping list, quick add, share target, pantry hand-off, barcode adds)
  const built = (overrides: Record<string, unknown> = {}) => ({
    name: 'Milk', quantity: 2, category: 'Dairy', createdAt: new Date(), status: 'needed', ...overrides,
  });

  beforeEach(async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'households', householdA, 'shopping-lists', 'groceries', 'items', 'legacy'), {
        name: 'Eggs', quantity: 12, category: 'Dairy', status: 'needed', createdAt: now(), aisle: 4,
      });
    });
  });

  test('every shipped item write shape is accepted', async () => {
    await assertSucceeds(setDoc(item(users.member, 'milk'), built()));
    await assertSucceeds(setDoc(item(users.member, 'scanned'), built({
      imageUrl: 'https://images.openfoodfacts.org/images/products/1.jpg', barcode: '012345678905',
    })));
    await assertSucceeds(setDoc(item(users.member, 'shared'), built({ sourceUrl: 'https://example.test/recipe' })));
    await assertSucceeds(setDoc(item(users.member, 'offline'), built({ category: 'Other' })));
    // Tick / untick (shopping-list-client.tsx), quantity merge (item-transactions.ts), legacy absolute merge.
    await assertSucceeds(updateDoc(item(users.member, 'milk'), { status: 'purchased' }));
    await assertSucceeds(updateDoc(item(users.member, 'milk'), { status: 'needed' }));
    await assertSucceeds(updateDoc(item(users.member, 'milk'), { quantity: increment(3) }));
    await assertSucceeds(updateDoc(item(users.member, 'milk'), { quantity: 7 }));
    // Undo of a delete restores the document as it was read (createdAt comes back as a Timestamp).
    const snapshot = await getDoc(item(users.member, 'milk'));
    await assertSucceeds(deleteDoc(item(users.owner, 'milk')));
    await assertSucceeds(setDoc(item(users.member, 'milk'), snapshot.data()!));
  });

  test('item shapes are validated', async () => {
    await assertFails(setDoc(item(users.member, 'x1'), built({ price: 3 })));
    await assertFails(setDoc(item(users.member, 'x2'), built({ quantity: '2' })));
    await assertFails(setDoc(item(users.member, 'x3'), built({ quantity: 0 })));
    await assertFails(setDoc(item(users.member, 'x4'), built({ quantity: -1 })));
    await assertFails(setDoc(item(users.member, 'x5'), built({ quantity: 100001 })));
    await assertFails(setDoc(item(users.member, 'x6'), built({ status: 'stolen' })));
    await assertFails(setDoc(item(users.member, 'x7'), built({ name: 'x'.repeat(501) })));
    await assertFails(setDoc(item(users.member, 'x8'), built({ name: '' })));
    await assertFails(setDoc(item(users.member, 'x9'), { quantity: 1, status: 'needed' }));
    await assertFails(updateDoc(item(users.member, 'legacy'), { status: 1 }));
  });

  test('an item with a legacy field stays updatable on its other fields', async () => {
    await assertSucceeds(updateDoc(item(users.member, 'legacy'), { status: 'purchased' }));
    await assertSucceeds(updateDoc(item(users.member, 'legacy'), { quantity: increment(1) }));
    await assertFails(updateDoc(item(users.member, 'legacy'), { aisle: 5 }));
  });

  test('list documents and categories are validated', async () => {
    const list = (id: string) => doc(dbFor(users.member), 'households', householdA, 'shopping-lists', id);
    // shopping-list-client.tsx handleSaveList (merge) and pantry-inventory-client.tsx offerAddToList
    await assertSucceeds(setDoc(list('hardware'), { name: 'Hardware', description: '', icon: 'Hammer', type: 'Hardware', color: 'tint-6' }, { merge: true }));
    await assertSucceeds(setDoc(list('groceries-2'), { name: 'Groceries', icon: 'ShoppingCart', type: 'Grocery', description: '' }));
    await assertSucceeds(setDoc(list('groceries'), { name: 'Renamed', icon: 'ShoppingCart', type: 'Grocery' }, { merge: true }));
    await assertFails(setDoc(list('bad1'), { name: 'Bad', owner: 'me' }));
    await assertFails(setDoc(list('bad2'), { name: 'x'.repeat(101) }));
    await assertFails(setDoc(list('bad3'), { name: 'Bad', icon: 7 }));
    const categories = doc(dbFor(users.member), 'households', householdA, 'shopping-lists', 'groceries', 'config', 'categories');
    await assertSucceeds(setDoc(categories, { list: ['Dairy', 'Other', 'Produce'] }));
    await assertFails(setDoc(categories, { list: 'Dairy' }));
    await assertFails(setDoc(categories, { list: [], extra: true }));
  });
});

describe('content shapes: pet logs', () => {
  const logs = (user: Identity, kind: string) => collection(dbFor(user), 'households', householdA, 'pets', 'maple', kind);
  const log = (user: Identity, kind: string, id: string) => doc(logs(user, kind), id);
  const by = (user: Identity) => ({ loggedByUid: user.uid, loggedByName: 'Someone' });
  // Pre-operation feeding shape (older clients); medication-log.tsx and care-log.tsx onSubmit
  const feeding = (user: Identity) => ({ date: new Date(), cups: 1.5, foodAmountType: 'Cups', foodType: 'Dry', comments: '', ampm: 'AM', ...by(user) });
  const medication = (user: Identity) => ({ date: new Date().toISOString(), medication: 'Flea drops', dosage: '1 dose', notes: '', nextDueDate: '2026-09-01', ...by(user) });
  const care = (user: Identity) => ({ date: new Date().toISOString(), activity: 'Walk', notes: '', ...by(user) });

  beforeEach(async () => {
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await setDoc(doc(db, 'households', householdA, 'pets', 'maple'), { name: 'Maple', type: 'Dog' });
      await setDoc(doc(db, 'households', householdA, 'pets', 'maple', 'feeding-logs', '1'), {
        date: now(), cups: 1, foodAmountType: 'Cups', foodType: 'Dry', comments: '', ampm: 'AM',
      });
      await setDoc(doc(db, 'households', householdA, 'pets', 'maple', 'feeding-logs', 'signed'), {
        date: now(), cups: 1, foodAmountType: 'Cups', foodType: 'Dry', comments: '', ampm: 'PM',
        loggedByUid: users.member.uid, loggedByName: 'Member A', legacyMood: 'happy',
      });
    });
  });

  test('every shipped log write shape is accepted', async () => {
    await assertSucceeds(addDoc(logs(users.member, 'feeding-logs'), feeding(users.member)));
    await assertSucceeds(addDoc(logs(users.child, 'feeding-logs'), feeding(users.child)));
    await assertSucceeds(addDoc(logs(users.member, 'medication-logs'), medication(users.member)));
    const { nextDueDate: _due, ...noDue } = medication(users.member);
    void _due;
    await assertSucceeds(addDoc(logs(users.member, 'medication-logs'), noDue));
    await assertSucceeds(addDoc(logs(users.member, 'care-logs'), care(users.member)));
    // Clients from before "who logged it" (count + 1 ids, no logger), including overwriting an older entry.
    const legacy = { cups: 1, foodAmountType: 'Cups', foodType: 'Wet', comments: '', date: new Date(), ampm: 'PM' };
    await assertSucceeds(setDoc(log(users.member, 'feeding-logs', '2'), legacy));
    await assertSucceeds(setDoc(log(users.member, 'feeding-logs', '1'), legacy));
    await assertSucceeds(addDoc(logs(users.member, 'care-logs'), { date: new Date().toISOString(), activity: 'Brush', notes: '' }));
  });

  test('loggedByUid must be the writer and cannot change afterwards', async () => {
    await assertFails(addDoc(logs(users.member, 'feeding-logs'), feeding(users.child)));
    await assertFails(addDoc(logs(users.member, 'medication-logs'), medication(users.owner)));
    await assertFails(addDoc(logs(users.member, 'care-logs'), care(users.child)));
    await assertFails(addDoc(logs(users.member, 'care-logs'), { date: new Date().toISOString(), activity: 'Walk', notes: '', loggedByName: 'Forged' }));
    await assertFails(updateDoc(log(users.owner, 'feeding-logs', 'signed'), { loggedByUid: users.owner.uid }));
    await assertFails(updateDoc(log(users.member, 'feeding-logs', 'signed'), { loggedByName: 'Someone else' }));
    await assertFails(updateDoc(log(users.member, 'feeding-logs', 'signed'), { loggedByUid: deleteField() }));
    // An old client overwriting a signed entry would drop who logged it: refused.
    await assertFails(setDoc(log(users.member, 'feeding-logs', 'signed'), { cups: 2, foodAmountType: 'Cups', foodType: 'Dry', comments: '', date: new Date(), ampm: 'AM' }));
    // Other fields of a signed entry with a legacy field can still change.
    await assertSucceeds(updateDoc(log(users.member, 'feeding-logs', 'signed'), { comments: 'Ate half' }));
  });

  test('log shapes are validated', async () => {
    await assertFails(addDoc(logs(users.member, 'feeding-logs'), { ...feeding(users.member), treats: 3 }));
    await assertFails(addDoc(logs(users.member, 'feeding-logs'), { ...feeding(users.member), cups: 'one' }));
    await assertFails(addDoc(logs(users.member, 'feeding-logs'), { ...feeding(users.member), ampm: 'noon' }));
    await assertFails(addDoc(logs(users.member, 'feeding-logs'), { ...feeding(users.member), comments: 'x'.repeat(2001) }));
    await assertFails(addDoc(logs(users.member, 'medication-logs'), { ...medication(users.member), medication: 'x'.repeat(201) }));
    await assertFails(addDoc(logs(users.member, 'medication-logs'), { ...medication(users.member), refill: true }));
    await assertFails(addDoc(logs(users.member, 'care-logs'), { ...care(users.member), activity: 5 }));
    await assertFails(addDoc(logs(users.member, 'care-logs'), { ...care(users.member), notes: 'x'.repeat(2001) }));
  });
});

describe('feeding state and the shared feed operation (PE-23, PE-2)', () => {
  // One Firestore instance per user, so a batch never mixes references from two instances.
  let instances = new Map<string, ReturnType<typeof dbFor>>();
  const dbOf = (user: Identity) => {
    if (!instances.has(user.uid)) instances.set(user.uid, dbFor(user));
    return instances.get(user.uid)!;
  };
  const petPath = ['households', householdA, 'pets', 'rex'] as const;
  const logs = (user: Identity, household = householdA) => collection(dbOf(user), 'households', household, 'pets', 'rex', 'feeding-logs');
  const log = (user: Identity, id: string, household = householdA) => doc(logs(user, household), id);
  const state = (user: Identity, household = householdA, id = 'current') =>
    doc(dbOf(user), 'households', household, 'pets', 'rex', 'feeding-state', id);
  const minutesAgo = (minutes: number) => Timestamp.fromMillis(Date.now() - minutes * 60_000);
  // src/lib/pets/feed-operation.ts feedPet (online): server times, repeat, signed.
  const liveFeeding = (user: Identity, overrides: Record<string, unknown> = {}) => ({
    date: serverTimestamp(), loggedAt: serverTimestamp(), cups: 1, foodAmountType: 'Cups', foodType: 'Dry',
    comments: '', ampm: 'AM', loggedByUid: user.uid, loggedByName: 'Someone', repeat: 'none', ...overrides,
  });
  const stateFor = (user: Identity, logId: string, overrides: Record<string, unknown> = {}) => ({
    lastLogId: logId, lastFedAt: serverTimestamp(), lastFedByUid: user.uid, lastFedByName: 'Someone',
    day: '2026-11-10', countOnDay: 1, prev: null, ...overrides,
  });
  const previous = {
    lastLogId: 'older', lastFedAt: Timestamp.fromDate(new Date('2026-11-10T08:00:00.000Z')),
    lastFedByUid: users.child.uid, lastFedByName: 'Child', day: '2026-11-10', countOnDay: 1,
  };

  beforeEach(async () => {
    instances = new Map();
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await setDoc(doc(db, ...petPath), { name: 'Rex', type: 'Dog', feedingsPerDay: 2 });
      await setDoc(doc(db, ...petPath, 'feeding-logs', 'older'), {
        date: previous.lastFedAt, cups: 1, foodAmountType: 'Cups', foodType: 'Dry', comments: '', ampm: 'AM',
        loggedByUid: users.child.uid, loggedByName: 'Child',
      });
      // The member's feed from 2 minutes ago (inside the 10-minute window) and one from 11 minutes ago.
      await setDoc(doc(db, ...petPath, 'feeding-logs', 'recent'), {
        date: minutesAgo(2), loggedAt: minutesAgo(2), cups: 1, foodAmountType: 'Cups', foodType: 'Dry', comments: '',
        ampm: 'AM', loggedByUid: users.member.uid, loggedByName: 'Member', repeat: 'none',
      });
      await setDoc(doc(db, ...petPath, 'feeding-logs', 'stale'), {
        date: minutesAgo(11), loggedAt: minutesAgo(11), cups: 1, foodAmountType: 'Cups', foodType: 'Dry', comments: '',
        ampm: 'AM', loggedByUid: users.member.uid, loggedByName: 'Member', repeat: 'none',
      });
      await setDoc(doc(db, ...petPath, 'feeding-state', 'current'), {
        lastLogId: 'recent', lastFedAt: minutesAgo(2), lastFedByUid: users.member.uid, lastFedByName: 'Member',
        day: '2026-11-10', countOnDay: 2, prev: previous,
      });
    });
  });

  test('a feed writes the log and the state together; members and children may', async () => {
    let latest = 'recent';
    for (const user of [users.member, users.child]) {
      const db = dbOf(user);
      const ref = doc(logs(user));
      const batch = writeBatch(db);
      batch.set(ref, liveFeeding(user));
      batch.set(state(user), stateFor(user, ref.id, { countOnDay: 3, prev: { ...previous, lastLogId: latest } }));
      await assertSucceeds(batch.commit());
      latest = ref.id;
    }
    // Readable with pets.view (guest), not by another household.
    await assertSucceeds(getDoc(state(users.guest)));
    await assertFails(getDoc(state(users.ownerB)));
  });

  test('the new feeding-log fields are validated', async () => {
    await assertSucceeds(addDoc(logs(users.member), liveFeeding(users.member, { repeat: 'confirmed' })));
    await assertSucceeds(addDoc(logs(users.member), liveFeeding(users.member, { repeat: 'offline', clockSource: 'device', date: new Date() })));
    await assertSucceeds(addDoc(logs(users.member), liveFeeding(users.member, { backdated: true, date: Timestamp.fromDate(new Date('2026-11-09T12:00:00Z')) })));
    await assertFails(addDoc(logs(users.member), liveFeeding(users.member, { repeat: 'twice' })));
    await assertFails(addDoc(logs(users.member), liveFeeding(users.member, { clockSource: 'sundial' })));
    await assertFails(addDoc(logs(users.member), liveFeeding(users.member, { backdated: 'yes' })));
    // loggedAt is the server time of the write: a chosen one (which would stretch the delete window) is refused.
    await assertFails(addDoc(logs(users.member), liveFeeding(users.member, { loggedAt: inMinutes(5) })));
    await assertFails(updateDoc(log(users.member, 'recent'), { loggedAt: serverTimestamp() }));
  });

  test('state writes are validated and paired with an existing log', async () => {
    const member = users.member;
    const write = async (data: Record<string, unknown>, logData: Record<string, unknown> | null = liveFeeding(member), id = 'current') => {
      const db = dbOf(member);
      const ref = doc(logs(member));
      const batch = writeBatch(db);
      if (logData) batch.set(ref, logData);
      batch.set(state(member, householdA, id), { ...stateFor(member, ref.id, { prev: { ...previous, lastLogId: 'recent' } }), ...data });
      return batch.commit();
    };
    await assertFails(write({}, null)); // no log behind it
    await assertFails(write({ lastLogId: 'older' }, null)); // someone else's log
    await assertFails(write({ countOnDay: -1 }));
    await assertFails(write({ countOnDay: 1.5 }));
    await assertFails(write({ day: 'today' }));
    await assertFails(write({ mood: 'happy' }));
    await assertFails(write({ prev: { ...previous, extra: true } }));
    await assertFails(write({}, liveFeeding(member), 'other'));
    // A guest (pets.view only) and another household cannot write.
    const guestBatch = writeBatch(dbOf(users.guest));
    guestBatch.set(state(users.guest), stateFor(users.guest, 'recent'));
    await assertFails(guestBatch.commit());
    await assertFails(setDoc(state(users.ownerB, householdB), stateFor(users.ownerB, 'recent')));
    await assertFails(deleteDoc(state(users.owner)));
  });

  test('a forged lastFedByUid is refused', async () => {
    const db = dbOf(users.member);
    const ref = doc(logs(users.member));
    const batch = writeBatch(db);
    batch.set(ref, liveFeeding(users.member));
    batch.set(state(users.member), stateFor(users.child, ref.id, { prev: { ...previous, lastLogId: 'recent' } }));
    await assertFails(batch.commit());
    // A log signed by someone else cannot be created either.
    await assertFails(addDoc(logs(users.member), liveFeeding(users.child)));
  });

  test('undo restores exactly the stored prev, or only changes the count', async () => {
    const db = dbOf(users.member);
    // Restoring something other than `prev` (an old whole snapshot) is refused.
    const forged = writeBatch(db);
    forged.delete(log(users.member, 'recent'));
    forged.set(state(users.member), { ...previous, lastLogId: 'stale', countOnDay: 1, prev: null });
    await assertFails(forged.commit());
    // Restoring `prev` while the log still exists is refused.
    await assertFails(setDoc(state(users.member), { ...previous, countOnDay: 1, prev: null }));
    // Count-only changes are allowed.
    await assertSucceeds(updateDoc(state(users.member), { countOnDay: 1 }));
    // Delete the latest log and restore `prev` in one commit.
    const undo = writeBatch(db);
    undo.delete(log(users.member, 'recent'));
    undo.set(state(users.member), { ...previous, countOnDay: 0, prev: null });
    await assertSucceeds(undo.commit());
  });

  test('the author may delete their own feeding for 10 minutes; others need pets.deleteLogs', async () => {
    // Just logged through the operation, then deleted by its author (a member without pets.deleteLogs).
    const ref = await addDoc(logs(users.member), liveFeeding(users.member));
    await assertSucceeds(deleteDoc(log(users.member, ref.id)));
    await assertSucceeds(deleteDoc(log(users.member, 'recent')));
    // After 10 minutes, refused.
    await assertFails(deleteDoc(log(users.member, 'stale')));
    // Someone else's feeding, or one without loggedAt (legacy), is refused to a member.
    await assertFails(deleteDoc(log(users.child, 'stale')));
    await assertFails(deleteDoc(log(users.member, 'older')));
    // A guest cannot; another household cannot; pets.deleteLogs (owner) can delete any.
    await assertFails(deleteDoc(log(users.guest, 'stale')));
    await assertFails(deleteDoc(log(users.ownerB, 'stale')));
    await assertSucceeds(deleteDoc(log(users.owner, 'stale')));
  });
});

describe('content shapes: maintenance', () => {
  const col = (user: Identity, name: string) => collection(dbFor(user), 'households', householdA, name);
  const ref = (user: Identity, name: string, id: string) => doc(col(user, name), id);
  const nowIso = '2026-08-01T12:00:00.000Z';
  // maintenance-log-client.tsx handleSaveLog (after cleanForFirestore) / applyScheduleCompletion / quick-add-writes.ts quickMaintenanceLog
  const formLog = (overrides: Record<string, unknown> = {}) => ({
    householdId: householdA, targetType: 'vehicle', vehicleId: 'car', title: 'Oil change', item: 'Oil change',
    date: '2026-08-01', type: 'routine', notes: 'Synthetic', cost: 79.99, partsUsed: 'Filter', serviceProvider: 'Shop',
    mileage: 42000, createdAt: nowIso, updatedAt: nowIso, ...overrides,
  });
  const asset = (overrides: Record<string, unknown> = {}) => ({
    householdId: householdA, name: 'Furnace', category: 'HVAC', location: 'Basement', brand: 'Acme', model: 'X1',
    serialNumber: 'SN', purchaseDate: '2020-01-01', purchasePrice: 3000, warrantyExpiration: '2030-01-01',
    warrantyProvider: 'Acme', status: 'active', notes: '',
    schedules: [{ id: 's1', mode: 'scheduled', scheduleName: 'Filter', frequencyType: 'months', intervalValue: 3, nextDueDate: '2026-09-01' }],
    createdAt: nowIso, updatedAt: nowIso, ...overrides,
  });
  const vehicle = (overrides: Record<string, unknown> = {}) => ({
    householdId: householdA, nickname: 'Car', year: 2019, make: 'Make', model: 'Model', trim: 'LX', vin: 'VIN',
    licensePlate: 'ABC', currentMileage: 42000, purchaseDate: '2019-05-01', purchasePrice: 20000,
    insuranceProvider: 'Ins', registrationExpiration: '2027-01-01', inspectionExpiration: '2027-01-01',
    status: 'active', notes: '', serviceSchedules: [{ id: 'v1', serviceName: 'Oil', intervalMiles: 5000 }],
    createdAt: nowIso, updatedAt: nowIso, ...overrides,
  });

  beforeEach(async () => {
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      // The first release's log shape (item, notes, date) plus an unknown legacy field.
      await setDoc(doc(db, 'households', householdA, 'maintenance', 'legacy'), {
        item: 'Gutter clean', notes: 'Old', date: '2025-06-01T00:00:00.000Z', vendorRef: 'v-1',
      });
      await setDoc(doc(db, 'households', householdA, 'home-assets', 'furnace'), { ...asset(), legacyTag: 'x' });
      await setDoc(doc(db, 'households', householdA, 'vehicles', 'car'), vehicle());
    });
  });

  test('every shipped log, asset and vehicle write shape is accepted', async () => {
    await assertSucceeds(setDoc(ref(users.member, 'maintenance', 'oil'), formLog()));
    await assertSucceeds(setDoc(ref(users.member, 'maintenance', 'general'), {
      householdId: householdA, targetType: 'general', title: 'Smoke alarms', item: 'Smoke alarms', date: '2026-08-01',
      type: 'routine', notes: 'Odometer: 12 mi', createdAt: nowIso, updatedAt: nowIso,
    }));
    await assertSucceeds(setDoc(ref(users.member, 'maintenance', 'asset-log'), (() => {
      const { vehicleId: _v, mileage: _m, ...log } = formLog({ targetType: 'home_asset', assetId: 'furnace' });
      void _v; void _m;
      return log;
    })()));
    // Editing carries summary and receiptUrl through.
    await assertSucceeds(setDoc(ref(users.member, 'maintenance', 'oil'), formLog({ summary: 'AI summary', receiptUrl: 'https://example.test/r.pdf' })));
    // Deleting the target re-links its logs (maintenance-log-client.tsx deleteRegistryRecord).
    await assertSucceeds(updateDoc(ref(users.member, 'maintenance', 'oil'), {
      targetType: 'general', vehicleId: deleteField(), formerTargetType: 'vehicle', formerTargetName: 'Car', updatedAt: nowIso,
    }));
    await assertSucceeds(setDoc(ref(users.member, 'home-assets', 'dishwasher'), asset({ name: 'Dishwasher' })));
    await assertSucceeds(setDoc(ref(users.member, 'vehicles', 'truck'), vehicle({ nickname: 'Truck' })));
    // Schedule completion re-writes the whole record; snooze updates only its schedules.
    await assertSucceeds(setDoc(ref(users.member, 'home-assets', 'furnace'), { ...asset(), legacyTag: 'x', updatedAt: '2026-08-02T00:00:00.000Z' }));
    await assertSucceeds(updateDoc(ref(users.member, 'home-assets', 'furnace'), { schedules: [{ id: 's1', nextDueDate: '2026-09-08', snoozedUntil: '2026-09-08' }], updatedAt: nowIso }));
    await assertSucceeds(updateDoc(ref(users.member, 'vehicles', 'car'), { serviceSchedules: [], updatedAt: nowIso }));
    await assertSucceeds(setDoc(ref(users.member, 'vehicles', 'car'), vehicle({ currentMileage: 43000 })));
    // A negative or zero cost typed into the form has always been stored.
    await assertSucceeds(setDoc(ref(users.member, 'maintenance', 'refund'), formLog({ cost: -10 })));
  });

  test('a legacy log stays updatable on its other fields', async () => {
    await assertSucceeds(updateDoc(ref(users.member, 'maintenance', 'legacy'), { notes: 'Edited', updatedAt: nowIso }));
    await assertFails(updateDoc(ref(users.member, 'maintenance', 'legacy'), { vendorRef: 'v-2' }));
  });

  test('shapes are validated and householdId must match the path', async () => {
    await assertFails(setDoc(ref(users.member, 'maintenance', 'x1'), formLog({ householdId: householdB })));
    await assertFails(updateDoc(ref(users.member, 'maintenance', 'legacy'), { householdId: householdB }));
    await assertFails(setDoc(ref(users.member, 'home-assets', 'x2'), asset({ householdId: householdB })));
    await assertFails(setDoc(ref(users.member, 'vehicles', 'x3'), vehicle({ householdId: householdB })));
    await assertFails(setDoc(ref(users.member, 'maintenance', 'x4'), formLog({ approvedBy: 'me' })));
    await assertFails(setDoc(ref(users.member, 'maintenance', 'x5'), formLog({ cost: '80' })));
    await assertFails(setDoc(ref(users.member, 'maintenance', 'x6'), formLog({ type: 'bribe' })));
    await assertFails(setDoc(ref(users.member, 'maintenance', 'x7'), formLog({ title: 'x'.repeat(1001) })));
    await assertFails(setDoc(ref(users.member, 'home-assets', 'x8'), asset({ status: 'broken' })));
    await assertFails(setDoc(ref(users.member, 'home-assets', 'x9'), asset({ schedules: 'monthly' })));
    await assertFails(setDoc(ref(users.member, 'vehicles', 'x10'), vehicle({ year: '2019' })));
    await assertFails(updateDoc(ref(users.member, 'vehicles', 'car'), { color: 'red' }));
  });
});

describe('content shapes: barcode library', () => {
  const item = (user: Identity, id: string) => doc(dbFor(user), 'households', householdA, 'barcode-library', id);
  const storageUrl = (household = householdA, bucket = 'homehub-j91jb.appspot.com') =>
    `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/households%2F${household}%2Fbarcode-library%2Fabc.jpg?alt=media&token=1-2-3`;
  // barcode-library-client.tsx handleSave
  const saved = (overrides: Record<string, unknown> = {}) => ({
    name: 'Oat cereal', imageUrl: storageUrl(), imagePath: `households/${householdA}/barcode-library/abc.jpg`,
    createdAt: '2026-08-01T12:00:00.000Z', ...overrides,
  });

  beforeEach(async () => {
    await environment.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'households', householdA, 'barcode-library', '012345678905'), {
        name: 'Seeded', imageUrl: '/favicon.ico', createdAt: '2026-07-25T15:00:00.000Z',
      });
    });
  });

  test('uploaded, emulator and Open Food Facts images are accepted', async () => {
    await assertSucceeds(setDoc(item(users.member, '111'), saved()));
    await assertSucceeds(setDoc(item(users.member, '112'), saved({ imageUrl: storageUrl(householdA, 'homehub-j91jb.firebasestorage.app') })));
    await assertSucceeds(setDoc(item(users.member, '113'), saved({
      imageUrl: `http://127.0.0.1:9199/v0/b/demo-homehub-e2e.appspot.com/o/households%2F${householdA}%2Fbarcode-library%2Fabc.jpg?alt=media&token=t`,
    })));
    await assertSucceeds(setDoc(item(users.member, '114'), { name: 'OFF', imageUrl: 'https://images.openfoodfacts.org/images/products/1/front.jpg', createdAt: '2026-08-01T12:00:00.000Z' }));
  });

  test('an existing product keeps a legacy image URL when edited', async () => {
    await assertSucceeds(setDoc(item(users.member, '012345678905'), { name: 'Renamed', imageUrl: '/favicon.ico', createdAt: '2026-07-25T15:00:00.000Z' }));
    await assertSucceeds(setDoc(item(users.member, '012345678905'), saved({ name: 'New photo' })));
  });

  test('image URLs, paths and fields are restricted', async () => {
    await assertFails(setDoc(item(users.member, '201'), saved({ imageUrl: 'https://evil.example.test/pixel.gif' })));
    await assertFails(setDoc(item(users.member, '202'), saved({ imageUrl: storageUrl(householdB) })));
    await assertFails(setDoc(item(users.member, '203'), saved({ imageUrl: storageUrl(householdA, 'attacker-project.appspot.com') })));
    await assertFails(setDoc(item(users.member, '204'), saved({ imageUrl: 'javascript:alert(1)' })));
    await assertFails(updateDoc(item(users.member, '012345678905'), { imageUrl: 'https://evil.example.test/x.png' }));
    await assertFails(setDoc(item(users.member, '205'), saved({ imagePath: `households/${householdB}/barcode-library/abc.jpg` })));
    await assertFails(setDoc(item(users.member, '206'), saved({ name: 'x'.repeat(201) })));
    await assertFails(setDoc(item(users.member, '207'), saved({ price: 3 })));
    await assertFails(setDoc(item(users.member, '208'), saved({ name: 7 })));
    await assertFails(setDoc(item(users.member, 'x'.repeat(129)), saved()));
  });
});
