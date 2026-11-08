import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { executeAuthorizedAiAction, MAX_AI_ACTION_PAYLOAD_BYTES, type AiActionPermission } from '../../src/ai/action-auth';
import type { HouseholdPermission } from '../../src/lib/types';

// Authorization for every AI action, against the Auth and Firestore emulators:
// single permissions as before, the any-of list the palette reader uses, and the
// order of the guards (payload cap, then authorization, then quota, then the task).
const HOUSEHOLD = 'ai-auth-any-of-house';
const household = adminDb.collection('households').doc(HOUSEHOLD);
const day = () => new Date().toISOString().slice(0, 10);

const CALLERS = {
  owner: { uid: 'anyof-owner', email: 'anyof.owner@example.test' },
  member: { uid: 'anyof-member', email: 'anyof.member@example.test' },
  pending: { uid: 'anyof-pending', email: 'anyof.pending@example.test' },
  outsider: { uid: 'anyof-outsider', email: 'anyof.outsider@example.test' },
} as const;
type Caller = keyof typeof CALLERS;

// The member's overrides decide exactly which of the palette's permissions they hold.
const MEMBER_OVERRIDES: Partial<Record<HouseholdPermission, boolean>> = {
  'shopping.edit': true,
  'chores.create': false,
  'maintenance.createLogs': false,
  'pets.addLogs': false,
  'automation.manage': false,
};

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

const usageDocs = async () => (await adminDb.collection('aiUsage').get()).docs
  .filter((entry) => entry.id.includes(HOUSEHOLD) || Object.values(CALLERS).some(({ uid }) => entry.id.includes(uid)));
const clearUsage = async () => Promise.all((await usageDocs()).map((entry) => entry.ref.delete()));

let flowCounter = 0;
/** Runs an action as `caller`; each call gets its own flow name so the per-minute guard never interferes. */
async function run(caller: Caller, permission: AiActionPermission, options: { input?: unknown; consumeQuota?: boolean } = {}) {
  let ran = false;
  const result = await executeAuthorizedAiAction({
    context: { idToken: tokens.get(caller)!, householdId: HOUSEHOLD },
    input: options.input ?? { text: 'hello' },
    permission,
    flowName: `auth-test-${flowCounter += 1}`,
    maxRequestsPerMinute: 1_000,
    consumeQuota: options.consumeQuota ?? false,
    task: async (user) => {
      ran = true;
      return user.uid;
    },
  });
  return { result, ran, code: result.ok ? null : result.error.code };
}

before(async () => {
  await household.set({ name: 'Any-of Test House', ownerUid: CALLERS.owner.uid });
  const member = (uid: string, email: string, data: Record<string, unknown>) =>
    household.collection('members').doc(uid).set({ uid, email, displayName: email, ...data });
  await member(CALLERS.owner.uid, CALLERS.owner.email, { role: 'owner', status: 'active', permissions: {} });
  await member(CALLERS.member.uid, CALLERS.member.email, { role: 'member', status: 'active', permissions: MEMBER_OVERRIDES });
  await member(CALLERS.pending.uid, CALLERS.pending.email, { role: 'newuser', status: 'pending', permissions: {} });
  for (const caller of Object.keys(CALLERS) as Caller[]) tokens.set(caller, await idTokenFor(caller));
});

beforeEach(clearUsage);

after(async () => {
  await clearUsage();
  const members = await household.collection('members').get();
  await Promise.all(members.docs.map((entry) => entry.ref.delete()));
  await household.delete();
  await Promise.all(Object.values(CALLERS).map(({ uid }) => adminAuth.deleteUser(uid).catch(() => undefined)));
});

describe('AI action authorization', () => {
  test('a single permission behaves as before: allowed and denied', async () => {
    const allowed = await run('member', 'shopping.edit');
    assert.equal(allowed.result.ok, true);
    assert.equal(allowed.ran, true);
    assert.equal(allowed.result.ok && allowed.result.data, CALLERS.member.uid);

    const denied = await run('member', 'chores.create');
    assert.equal(denied.code, 'forbidden');
    assert.equal(denied.ran, false);

    const owner = await run('owner', 'chores.create');
    assert.equal(owner.result.ok, true);
  });

  test('a list grants access when the member holds any one of them', async () => {
    const outcome = await run('member', ['chores.create', 'maintenance.createLogs', 'shopping.edit', 'pets.addLogs']);
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.ran, true);
    // Order does not matter.
    assert.equal((await run('member', ['shopping.edit', 'chores.create'])).result.ok, true);
  });

  test('a list denies access when the member holds none of them', async () => {
    const outcome = await run('member', ['chores.create', 'maintenance.createLogs', 'pets.addLogs', 'automation.manage']);
    assert.equal(outcome.code, 'forbidden');
    assert.equal(outcome.ran, false);
  });

  test('an empty list grants nothing, even to the owner', async () => {
    for (const caller of ['owner', 'member'] as const) {
      const outcome = await run(caller, []);
      assert.equal(outcome.code, 'forbidden', caller);
      assert.equal(outcome.ran, false, caller);
    }
  });

  test('pending and non-member callers are denied for a single permission, a list and an empty list', async () => {
    const shapes: AiActionPermission[] = ['shopping.edit', ['shopping.edit', 'chores.create'], []];
    for (const caller of ['pending', 'outsider'] as const) {
      for (const permission of shapes) {
        const outcome = await run(caller, permission, { consumeQuota: true });
        assert.equal(outcome.code, 'forbidden', `${caller} ${JSON.stringify(permission)}`);
        assert.equal(outcome.ran, false);
      }
    }
    assert.equal((await usageDocs()).length, 0, 'a denied caller takes no quota');
  });

  test('the payload cap runs before any grant, even for the owner', async () => {
    const outcome = await run('owner', ['shopping.edit'], { input: { text: 'x'.repeat(MAX_AI_ACTION_PAYLOAD_BYTES + 1) }, consumeQuota: true });
    assert.equal(outcome.code, 'invalid_input');
    assert.equal(outcome.ran, false);
    assert.equal((await usageDocs()).length, 0, 'an oversized request takes no quota');
  });

  test('the daily quota runs after the grant and before the task', async () => {
    const granted = await run('member', ['chores.create', 'shopping.edit'], { consumeQuota: true });
    assert.equal(granted.result.ok, true);
    const usage = await adminDb.collection('aiUsage').doc(`user_${CALLERS.member.uid}_${day()}`).get();
    assert.equal(usage.data()?.count, 1, 'a granted request takes one unit');

    await adminDb.collection('aiUsage').doc(`user_${CALLERS.member.uid}_${day()}`).set({ count: 100_000 }, { merge: true });
    const exhausted = await run('member', ['chores.create', 'shopping.edit'], { consumeQuota: true });
    assert.equal(exhausted.code, 'quota_exceeded');
    assert.equal(exhausted.ran, false, 'the task never runs past the quota');
  });
});
