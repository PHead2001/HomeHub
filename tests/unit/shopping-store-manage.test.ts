import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  StoreChangeDeclined,
  checkStoreRename,
  deleteStoreQuestion,
  listsUsingStore,
  outcomeAppliesTo,
  planStoreDelete,
  planStoreRestore,
  storeDeclinedMessage,
  storeDeletedSubject,
  storeRenamedSubject,
  storeRestoredSubject,
  undoRemaining,
  type StoreRestore,
} from '../../src/lib/shopping/store-manage';
import { UNDO_WINDOW_MS } from '../../src/lib/undo-window';

const stores = [
  { id: 'corner', name: 'Corner Shop' },
  { id: 'costco', name: 'Costco' },
];

describe('checkStoreRename', () => {
  test('trims and accepts a new name', () => {
    assert.deepEqual(checkStoreRename('  Corner   Market ', 'corner', stores), { ok: true, name: 'Corner Market', unchanged: false });
  });

  test('the same name is unchanged; the same name in another case is a rename', () => {
    assert.deepEqual(checkStoreRename('Corner Shop', 'corner', stores), { ok: true, name: 'Corner Shop', unchanged: true });
    assert.deepEqual(checkStoreRename('corner shop', 'corner', stores), { ok: true, name: 'corner shop', unchanged: false });
  });

  test('empty, too long, or another store\'s name (case and spacing ignored) is explained', () => {
    assert.deepEqual(checkStoreRename('   ', 'corner', stores), { ok: false, error: 'Give the store a name.' });
    const long = checkStoreRename('x'.repeat(61), 'corner', stores);
    assert.equal(long.ok, false);
    assert.match(!long.ok ? long.error : '', /under 60 characters/);
    assert.deepEqual(checkStoreRename(' COSTCO ', 'corner', stores), {
      ok: false, error: 'You already have a store called Costco. Pick another name.',
    });
    assert.equal(checkStoreRename('x'.repeat(60), 'corner', stores).ok, true);
  });
});

describe('listsUsingStore and the confirmation', () => {
  test('only lists naming exactly that store', () => {
    const lists = [
      { id: 'a', storeId: 'corner' }, { id: 'b', storeId: 'costco' }, { id: 'c', storeId: null }, { id: 'd' }, { id: 'e', storeId: 'corner' },
    ];
    assert.deepEqual(listsUsingStore('corner', lists), ['a', 'e']);
    assert.deepEqual(listsUsingStore('gone', lists), []);
  });

  test('names the store and how many lists use it', () => {
    assert.equal(deleteStoreQuestion('Costco', 2).title, 'Delete Costco?');
    assert.match(deleteStoreQuestion('Costco', 2).body, /^2 lists use it\. They go back to their own category order/);
    assert.match(deleteStoreQuestion('Costco', 1).body, /^1 list uses it\. It goes back to its own category order/);
    assert.match(deleteStoreQuestion('Costco', 0).body, /^No list uses it now/);
    assert.equal(storeDeletedSubject('Costco', 0), 'Costco deleted');
    assert.equal(storeDeletedSubject('Costco', 1), 'Costco deleted, 1 list back to its own order');
    assert.equal(storeDeletedSubject('Costco', 3), 'Costco deleted, 3 lists back to their own order');
  });
});

describe('planStoreDelete', () => {
  const data = { name: 'Corner Shop', aisleOrder: ['Party', 'Dairy'], createdByUid: 'member', updatedAt: 1 };

  test('a store already gone is declined', () => {
    assert.deepEqual(planStoreDelete({ storeId: 'corner', store: { exists: false }, lists: [], fallbackName: 'Corner Shop' }), { kind: 'declined', reason: 'gone' });
  });

  test('clears only lists that still exist and still name the store, and keeps the restore', () => {
    const plan = planStoreDelete({
      storeId: 'corner',
      store: { exists: true, data },
      lists: [
        { id: 'a', exists: true, storeId: 'corner' },
        { id: 'moved', exists: true, storeId: 'costco' },
        { id: 'gone', exists: false },
        { id: 'own', exists: true, storeId: null },
      ],
      fallbackName: 'Corner Shop',
    });
    assert.equal(plan.kind, 'delete');
    if (plan.kind !== 'delete') return;
    assert.deepEqual(plan.clearListIds, ['a']);
    assert.deepEqual(plan.restore, { storeId: 'corner', name: 'Corner Shop', aisleOrder: ['Party', 'Dairy'], createdByUid: 'member', listIds: ['a'] });
  });

  test('a stored shape the rules would refuse again is made restorable', () => {
    const plan = planStoreDelete({
      storeId: 's',
      store: { exists: true, data: { name: '', aisleOrder: ['Dairy', 7, '', 'x'.repeat(101), ...Array.from({ length: 210 }, (_, i) => `A${i}`)] } },
      lists: [],
      fallbackName: ' On screen ',
    });
    if (plan.kind !== 'delete') throw new Error('expected a delete');
    assert.equal(plan.restore.name, 'On screen');
    assert.equal(plan.restore.aisleOrder.length, 200);
    assert.equal(plan.restore.aisleOrder[0], 'Dairy');
    assert.equal(plan.restore.createdByUid, null);
    const unnamed = planStoreDelete({ storeId: 's', store: { exists: true, data: { aisleOrder: 'x' } }, lists: [], fallbackName: '' });
    if (unnamed.kind !== 'delete') throw new Error('expected a delete');
    assert.equal(unnamed.restore.name, 'Store');
    assert.deepEqual(unnamed.restore.aisleOrder, []);
  });
});

describe('planStoreRestore', () => {
  const restore: StoreRestore = { storeId: 'corner', name: 'Corner Shop', aisleOrder: ['Party'], createdByUid: 'member', listIds: ['a', 'b', 'c'] };

  test('the creator restores it as it was, with the lists that still name no store', () => {
    const plan = planStoreRestore({
      restore,
      uid: 'member',
      storeExists: false,
      lists: [
        { id: 'a', exists: true, storeId: null },
        { id: 'b', exists: true, storeId: 'costco' },
        { id: 'c', exists: false },
        { id: 'z', exists: true, storeId: null },
      ],
      stores: [{ id: 'costco', name: 'Costco' }],
    });
    assert.deepEqual(plan, {
      kind: 'restore',
      store: { name: 'Corner Shop', aisleOrder: ['Party'], createdByUid: 'member' },
      listIds: ['a'],
      restoredAsYours: false,
    });
  });

  test('another member restores it as theirs (the rules\' create condition) and is told', () => {
    const plan = planStoreRestore({ restore, uid: 'admin', storeExists: false, lists: [{ id: 'a', exists: true }], stores: [] });
    assert.equal(plan.kind, 'restore');
    if (plan.kind !== 'restore') return;
    assert.equal(plan.store.createdByUid, 'admin');
    assert.equal(plan.restoredAsYours, true);
    assert.deepEqual(plan.listIds, ['a']);
    assert.equal(storeRestoredSubject('Corner Shop', true), 'Corner Shop restored (now listed as created by you)');
    assert.equal(storeRestoredSubject('Corner Shop', false), 'Corner Shop restored');
    // A store without a recorded creator is also restored as the restorer's.
    const legacy = planStoreRestore({ restore: { ...restore, createdByUid: null }, uid: 'member', storeExists: false, lists: [], stores: [] });
    assert.equal(legacy.kind === 'restore' && legacy.restoredAsYours, true);
  });

  test('declined when the store is back already or its name was taken meanwhile', () => {
    assert.deepEqual(planStoreRestore({ restore, uid: 'member', storeExists: true, lists: [], stores: [] }), { kind: 'declined', reason: 'exists' });
    assert.deepEqual(
      planStoreRestore({ restore, uid: 'member', storeExists: false, lists: [], stores: [{ id: 'new', name: ' corner shop' }] }),
      { kind: 'declined', reason: 'name-taken' },
    );
    const error = new StoreChangeDeclined('name-taken', 'Corner Shop');
    assert.equal(error.reason, 'name-taken');
    assert.match(storeDeclinedMessage('gone', 'Corner Shop'), /already deleted/);
    assert.match(storeDeclinedMessage('exists', 'Corner Shop'), /nothing to undo/);
    assert.match(storeDeclinedMessage('name-taken', 'Corner Shop'), /was not restored/);
  });
});

describe('undoRemaining', () => {
  test('counts down the shared window and never below zero', () => {
    assert.equal(undoRemaining(1_000, 1_000, UNDO_WINDOW_MS), UNDO_WINDOW_MS);
    assert.equal(undoRemaining(1_000, 4_000, UNDO_WINDOW_MS), UNDO_WINDOW_MS - 3_000);
    assert.equal(undoRemaining(1_000, 1_000 + UNDO_WINDOW_MS + 5, UNDO_WINDOW_MS), 0);
  });
});

describe('the Undo decides on what is stored when it runs', () => {
  const restore: StoreRestore = { storeId: 'corner', name: 'Corner Shop', aisleOrder: [], createdByUid: 'member', listIds: ['a'] };

  test('a store named the same since the dialog closed (any case) declines, whatever the screen showed', () => {
    // The screen's copy (frozen when the dialog closed) had no such store; the server snapshot read by the Undo does.
    const screen: { id: string; name: string }[] = [];
    const server = [{ id: 'new-one', name: 'CORNER  shop' }];
    assert.equal(planStoreRestore({ restore, uid: 'member', storeExists: false, lists: [{ id: 'a', exists: true, storeId: null }], stores: screen }).kind, 'restore');
    assert.deepEqual(
      planStoreRestore({ restore, uid: 'member', storeExists: false, lists: [{ id: 'a', exists: true, storeId: null }], stores: server }),
      { kind: 'declined', reason: 'name-taken' },
    );
  });

  test('each list is pointed back only on its current storeId', () => {
    const plan = planStoreRestore({ restore, uid: 'member', storeExists: false, lists: [{ id: 'a', exists: true, storeId: 'elsewhere' }], stores: [] });
    assert.deepEqual(plan.kind === 'restore' && plan.listIds, []);
  });
});

describe('late outcomes stay with their store', () => {
  test('a rejected rename gives its draft back only while the same store is selected', () => {
    assert.equal(outcomeAppliesTo('a', 'a'), true);
    assert.equal(outcomeAppliesTo('a', 'b'), false);
    assert.equal(outcomeAppliesTo('a', null), false);
  });

  test('the rename status names both stores', () => {
    assert.equal(storeRenamedSubject('Corner Shop', 'Corner Market'), 'Corner Shop renamed to Corner Market');
  });
});
