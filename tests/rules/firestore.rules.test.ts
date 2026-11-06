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
    for (const deepLink of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
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

describe('Home Assistant credentials', () => {
  test('no client can read the stored token', async () => {
    for (const user of [users.owner, users.admin, users.member, users.guest]) {
      await assertFails(getDoc(doc(dbFor(user), 'households', householdA, 'home-automation', 'credentials')));
    }
  });

  test('only automation managers can save or clear credentials', async () => {
    const credentials = { url: 'https://ha.example.test', accessToken: 'new-token' };
    await assertSucceeds(setDoc(doc(dbFor(users.owner), 'households', householdA, 'home-automation', 'credentials'), credentials));
    await assertFails(setDoc(doc(dbFor(users.member), 'households', householdA, 'home-automation', 'credentials'), credentials));
    await assertSucceeds(deleteDoc(doc(dbFor(users.admin), 'households', householdA, 'home-automation', 'credentials')));
  });
});
