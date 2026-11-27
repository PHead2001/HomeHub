import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { undoQuickAddChore, undoQuickAddItems } from '../../src/app/command/actions';
import { undoQuickAddItemsOnServer } from '../../src/lib/server/quick-add-undo';

// QA-9: Undo of quick-add saves, against the Auth and Firestore emulators. The
// narrow permission: a member with shopping.edit but not shopping.delete may take
// back an item only they added, within a minute, while it is still needed; a
// one-time chore only they added, while open.
const HOUSE = 'quick-add-undo-house';
const house = adminDb.collection('households').doc(HOUSE);
const items = house.collection('shopping-lists').doc('weekly').collection('items');

const CALLERS = {
  owner: { uid: 'qau-owner', email: 'qau.owner@example.test' },
  editor: { uid: 'qau-editor', email: 'qau.editor@example.test' },
  viewer: { uid: 'qau-viewer', email: 'qau.viewer@example.test' },
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

before(async () => {
  for (const caller of Object.keys(CALLERS) as Caller[]) tokens.set(caller, await idTokenFor(caller));
});

beforeEach(async () => {
  await adminDb.recursiveDelete(house);
  await house.set({ name: 'Undo House', ownerUid: CALLERS.owner.uid });
  await house.collection('members').doc(CALLERS.owner.uid).set({ ...CALLERS.owner, role: 'owner', status: 'active', permissions: {} });
  await house.collection('members').doc(CALLERS.editor.uid).set({
    ...CALLERS.editor, role: 'member', status: 'active', permissions: { 'shopping.edit': true, 'shopping.delete': false, 'chores.create': true, 'chores.delete': false },
  });
  await house.collection('members').doc(CALLERS.viewer.uid).set({
    ...CALLERS.viewer, role: 'member', status: 'active', permissions: { 'shopping.view': true, 'shopping.edit': false, 'chores.create': false },
  });
  await house.collection('shopping-lists').doc('weekly').set({ name: 'Weekly', type: 'Grocery' });
});

after(async () => {
  await adminDb.recursiveDelete(house);
  await Promise.all(Object.values(CALLERS).map(({ uid }) => adminAuth.deleteUser(uid).catch(() => undefined)));
});

const undoItems = (caller: Caller, list: unknown[]) => undoQuickAddItems({ idToken: tokens.get(caller)!, householdId: HOUSE, listId: 'weekly', items: list });

describe('undoQuickAddItems', () => {
  test('removes an item the editor just added, without shopping.delete', async () => {
    await items.doc('milk').set({ name: 'Milk', quantity: 1, status: 'needed', addedByUid: CALLERS.editor.uid });
    const result = await undoItems('editor', [{ itemId: 'milk', merged: false, quantity: 1 }]);
    assert.deepEqual(result, { ok: true, undone: 1, kept: 0 });
    assert.equal((await items.doc('milk').get()).exists, false);
  });

  test("never removes someone else's item, an old one or a bought one", async () => {
    await items.doc('eggs').set({ name: 'Eggs', quantity: 1, status: 'needed', addedByUid: CALLERS.owner.uid });
    await items.doc('bread').set({ name: 'Bread', quantity: 1, status: 'purchased', addedByUid: CALLERS.editor.uid });
    const result = await undoItems('editor', [{ itemId: 'eggs', merged: false, quantity: 1 }, { itemId: 'bread', merged: false, quantity: 1 }]);
    assert.deepEqual(result, { ok: true, undone: 0, kept: 2 });
    assert.equal((await items.doc('eggs').get()).exists, true);
    assert.equal((await items.doc('bread').get()).exists, true);
    // Older than the grace window: the server's clock decides, not the client.
    await items.doc('old').set({ name: 'Old', quantity: 1, status: 'needed', addedByUid: CALLERS.editor.uid });
    const late = await undoQuickAddItemsOnServer(adminDb, {
      householdId: HOUSE, uid: CALLERS.editor.uid, listId: 'weekly', items: [{ itemId: 'old', merged: false, quantity: 1 }], nowMs: Date.now() + 120_000,
    });
    assert.deepEqual(late, { undone: 0, kept: ['old'] });
    assert.equal((await items.doc('old').get()).exists, true);
  });

  test('takes a merge back off the item it merged into', async () => {
    await items.doc('milk').set({ name: 'Milk', quantity: 3, status: 'needed', addedByUid: CALLERS.owner.uid });
    const result = await undoItems('editor', [{ itemId: 'milk', merged: true, quantity: 2 }]);
    assert.deepEqual(result, { ok: true, undone: 1, kept: 0 });
    assert.equal((await items.doc('milk').get()).get('quantity'), 1);
  });

  test('needs shopping.edit and a valid request', async () => {
    await items.doc('milk').set({ name: 'Milk', quantity: 1, status: 'needed', addedByUid: CALLERS.viewer.uid });
    const denied = await undoItems('viewer', [{ itemId: 'milk', merged: false, quantity: 1 }]);
    assert.equal(denied.ok ? null : denied.code, 'forbidden');
    const bad = await undoItems('editor', [{ itemId: '../milk', merged: false, quantity: 1 }]);
    assert.equal(bad.ok ? null : bad.code, 'invalid_input');
    const unsigned = await undoQuickAddItems({ idToken: '', householdId: HOUSE, listId: 'weekly', items: [] });
    assert.equal(unsigned.ok ? null : unsigned.code, 'unauthenticated');
    assert.equal((await items.doc('milk').get()).exists, true);
  });
});

describe('undoQuickAddChore', () => {
  const chores = house.collection('chores');
  const notices = house.collection('notifications');
  const run = (caller: Caller, choreId: string) => undoQuickAddChore({ idToken: tokens.get(caller)!, householdId: HOUSE, choreId });

  test('removes an open one-time chore the editor just added, and its notice', async () => {
    await chores.doc('c1').set({ task: 'Vacuum', sourceType: 'temporary', isCompleted: false, createdByUid: CALLERS.editor.uid, assignedToUid: CALLERS.owner.uid });
    await notices.doc('n1').set({ sourceType: 'chore-assignment', sourceId: 'c1', title: 'New chore assigned' });
    await notices.doc('n2').set({ sourceType: 'chore-assignment', sourceId: 'other', title: 'New chore assigned' });
    assert.deepEqual(await run('editor', 'c1'), { ok: true, undone: 1, kept: 0 });
    assert.equal((await chores.doc('c1').get()).exists, false);
    assert.equal((await notices.doc('n1').get()).exists, false);
    assert.equal((await notices.doc('n2').get()).exists, true);
  });

  test("keeps a completed chore, someone else's, and a repeating instance", async () => {
    await chores.doc('done').set({ task: 'Done', sourceType: 'temporary', isCompleted: true, createdByUid: CALLERS.editor.uid });
    await chores.doc('theirs').set({ task: 'Theirs', sourceType: 'temporary', isCompleted: false, createdByUid: CALLERS.owner.uid });
    await chores.doc('rep').set({ task: 'Rep', sourceType: 'template', isCompleted: false, createdByUid: CALLERS.editor.uid });
    for (const id of ['done', 'theirs', 'rep']) {
      assert.deepEqual(await run('editor', id), { ok: true, undone: 0, kept: 1 }, id);
      assert.equal((await chores.doc(id).get()).exists, true, id);
    }
    const denied = await run('viewer', 'theirs');
    assert.equal(denied.ok ? null : denied.code, 'forbidden');
  });
});
