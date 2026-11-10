import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import type { DocumentReference } from 'firebase-admin/firestore';
import { deleteShoppingList } from '../../src/app/shopping/actions';

// SH-9: the deleteShoppingList server action, against the Auth and Firestore
// emulators: it removes the list and everything under it, only for a member of
// that household with shopping.delete.
const HOUSE = 'shopping-delete-house';
const OTHER = 'shopping-delete-other';
const house = adminDb.collection('households').doc(HOUSE);
const other = adminDb.collection('households').doc(OTHER);

const CALLERS = {
  owner: { uid: 'sdl-owner', email: 'sdl.owner@example.test' },
  editor: { uid: 'sdl-editor', email: 'sdl.editor@example.test' },
  outsider: { uid: 'sdl-outsider', email: 'sdl.outsider@example.test' },
} as const;
type Caller = keyof typeof CALLERS;
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

const seedList = async (household: DocumentReference, listId: string) => {
  const list = household.collection('shopping-lists').doc(listId);
  await list.set({ name: `List ${listId}`, type: 'Grocery' });
  await list.collection('items').doc('milk').set({ name: 'Milk', quantity: 1, category: 'Dairy', status: 'needed' });
  await list.collection('items').doc('bread').set({ name: 'Bread', quantity: 2, category: 'Bakery', status: 'purchased' });
  await list.collection('config').doc('categories').set({ list: ['Bakery', 'Dairy', 'Other'] });
  return list;
};

const leftUnder = async (list: DocumentReference) => {
  const [snapshot, items, config] = await Promise.all([list.get(), list.collection('items').get(), list.collection('config').get()]);
  return { exists: snapshot.exists, items: items.size, config: config.size };
};

const run = (caller: Caller, householdId: string, listId: string) =>
  deleteShoppingList({ idToken: tokens.get(caller)!, householdId, listId });

before(async () => {
  for (const caller of Object.keys(CALLERS) as Caller[]) tokens.set(caller, await idTokenFor(caller));
});

beforeEach(async () => {
  await Promise.all([adminDb.recursiveDelete(house), adminDb.recursiveDelete(other)]);
  await house.set({ name: 'Delete House', ownerUid: CALLERS.owner.uid });
  await house.collection('members').doc(CALLERS.owner.uid).set({ ...CALLERS.owner, role: 'owner', status: 'active', permissions: {} });
  // Can edit lists but not delete them.
  await house.collection('members').doc(CALLERS.editor.uid).set({
    ...CALLERS.editor, role: 'member', status: 'active', permissions: { 'shopping.edit': true, 'shopping.delete': false },
  });
  await other.set({ name: 'Other House', ownerUid: CALLERS.outsider.uid });
  await other.collection('members').doc(CALLERS.outsider.uid).set({ ...CALLERS.outsider, role: 'owner', status: 'active', permissions: {} });
});

after(async () => {
  await Promise.all([adminDb.recursiveDelete(house), adminDb.recursiveDelete(other)]);
  await Promise.all(Object.values(CALLERS).map(({ uid }) => adminAuth.deleteUser(uid).catch(() => undefined)));
});

describe('deleteShoppingList', () => {
  test('deletes the list with its items and categories, and nothing else', async () => {
    const list = await seedList(house, 'weekly');
    const kept = await seedList(house, 'hardware');
    const result = await run('owner', HOUSE, 'weekly');
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(await leftUnder(list), { exists: false, items: 0, config: 0 });
    assert.deepEqual(await leftUnder(kept), { exists: true, items: 2, config: 1 });
  });

  test('also removes what an older client left under a list it deleted, and a repeat is safe', async () => {
    const list = await seedList(house, 'orphaned');
    await list.delete();
    assert.equal((await list.collection('items').get()).size, 2);
    assert.deepEqual(await run('owner', HOUSE, 'orphaned'), { ok: true });
    assert.deepEqual(await leftUnder(list), { exists: false, items: 0, config: 0 });
    assert.deepEqual(await run('owner', HOUSE, 'orphaned'), { ok: true });
  });

  test('is denied without shopping.delete', async () => {
    const list = await seedList(house, 'weekly');
    const result = await run('editor', HOUSE, 'weekly');
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, 'forbidden');
    assert.deepEqual(await leftUnder(list), { exists: true, items: 2, config: 1 });
  });

  test("is denied for another household's list", async () => {
    const list = await seedList(house, 'weekly');
    const result = await run('outsider', HOUSE, 'weekly');
    assert.equal(result.ok ? null : result.code, 'forbidden');
    assert.deepEqual(await leftUnder(list), { exists: true, items: 2, config: 1 });
    // In their own household the same id only touches their own data.
    const own = await seedList(other, 'weekly');
    assert.deepEqual(await run('outsider', OTHER, 'weekly'), { ok: true });
    assert.deepEqual(await leftUnder(own), { exists: false, items: 0, config: 0 });
    assert.deepEqual(await leftUnder(list), { exists: true, items: 2, config: 1 });
  });

  test('rejects a missing token and a malformed list id', async () => {
    const list = await seedList(house, 'weekly');
    const unsigned = await deleteShoppingList({ idToken: '', householdId: HOUSE, listId: 'weekly' });
    assert.equal(unsigned.ok ? null : unsigned.code, 'unauthenticated');
    for (const listId of ['', '../weekly', 'a/b', '__weekly__']) {
      const result = await run('owner', HOUSE, listId);
      assert.equal(result.ok ? null : result.code, 'invalid_input', `list id ${JSON.stringify(listId)}`);
    }
    assert.deepEqual(await leftUnder(list), { exists: true, items: 2, config: 1 });
  });
});
