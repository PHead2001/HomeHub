import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEVICE_ACTION_POLICY, UNDO_OF, UNDO_PROVEN, requiredLevel } from '../../src/lib/devices/action-policy';
import { addedNames, choreAnswerMeaning, queuedSendResult, SENDABLE_CAPABILITIES, UNDO_CAPABILITY_OF } from '../../src/lib/devices/device-action-answers';
import { dropNotice, createQueuedAction, queueAllowed } from '../../src/lib/devices/offline-queue';
import { deviceAddEntries, kitchenActivity, kitchenAttribution, kitchenItems, kitchenListChoice, kitchenLists, rosterFirstNames } from '../../src/lib/devices/tablet-shopping';
import { devicePermissions } from '../../src/lib/devices/tablet-settings-apply';
import { restoreItemData } from '../../src/lib/shopping/items';

// Shopping on registered wall tablets (docs/modules/devices/README.md, "Device actions:
// shopping"; audit HP-33, HP-36, SH-11, SH-28; WT-6a, WT-11c, WT-18c, WT-20, WT-22d): the
// policy, what the tablet sends and how it reads the answers, the queue, and the entries an
// add may carry.

const ok = (data: unknown) => ({ ok: true as const, data });

describe('the shopping policy', () => {
  it('add and tick are face* with the personal permission (shopping.edit), queueable, and their Undo only for the original person', () => {
    for (const capability of ['shopping.add', 'shopping.tick'] as const) {
      const policy = DEVICE_ACTION_POLICY[capability];
      assert.equal(policy.section, 'shopping');
      assert.equal(policy.levelClass, 'face');
      assert.deepEqual(policy.permissions, ['shopping.edit']);
      assert.equal('points' in policy, false, 'never the points PIN (WT-22d)');
      assert.equal(policy.queueable, true);
      const undo = DEVICE_ACTION_POLICY[`${capability}.undo` as 'shopping.add.undo'];
      assert.equal(undo.levelClass, 'face');
      assert.equal(undo.actorRule, 'original-actor');
      assert.deepEqual(undo.permissions, ['shopping.edit']);
      assert.ok(UNDO_PROVEN.has(capability) && UNDO_PROVEN.has(`${capability}.undo` as 'shopping.add.undo'));
    }
    assert.deepEqual(UNDO_OF['shopping.add.undo'], ['shopping.add']);
    assert.deepEqual(UNDO_OF['shopping.tick.undo'], ['shopping.tick']);
  });

  it('removing, put-away, used-up and scanning stay off tablets', () => {
    for (const capability of ['shopping.remove', 'shopping.putAway', 'shopping.usedUp', 'shopping.scan', 'ai.categorize'] as const) {
      assert.equal(DEVICE_ACTION_POLICY[capability].levelClass, 'not_on_tablets', capability);
      assert.equal(SENDABLE_CAPABILITIES.has(capability), false, capability);
    }
  });

  it('face level for every adult and the points PIN never raises it; a face-level add or tick may wait in the queue', () => {
    for (const pointsPin of ['off', 'kids', 'everyone'] as const) {
      for (const actorRole of ['owner', 'member', 'child'] as const) {
        assert.equal(requiredLevel('shopping.add', { pointsPin, actorRole }), 'face');
        assert.equal(requiredLevel('shopping.tick', { pointsPin, actorRole }), 'face');
        assert.equal(queueAllowed('shopping.tick', { pointsPin, actorRole }), true);
      }
    }
  });
});

describe('what the tablet sends and how it reads the answers', () => {
  it('sends add and tick with their Undo; each offers the Undo the server maps back to it', () => {
    for (const capability of ['shopping.add', 'shopping.add.undo', 'shopping.tick', 'shopping.tick.undo'] as const) assert.ok(SENDABLE_CAPABILITIES.has(capability), capability);
    assert.equal(UNDO_CAPABILITY_OF['shopping.add'], 'shopping.add.undo');
    assert.equal(UNDO_CAPABILITY_OF['shopping.tick'], 'shopping.tick.undo');
    const runtime = readFileSync('src/components/devices/use-device-actions.tsx', 'utf8');
    for (const action of ['addShoppingItemsFromTabletAction', 'undoShoppingAddFromTabletAction', 'tickShoppingItemFromTabletAction', 'undoShoppingTickFromTabletAction']) {
      assert.match(runtime, new RegExp(action));
    }
  });

  it('an add names what it added and offers Undo; a tick says it is in the cart and offers Undo', () => {
    assert.deepEqual(choreAnswerMeaning('shopping.add', { result: { status: 'added', items: [{ name: 'Milk' }] } }, 'Add'), { undoable: true, message: 'Milk added.' });
    assert.equal(choreAnswerMeaning('shopping.add', { result: { status: 'added', items: [{ name: 'Milk' }, { name: 'Eggs' }, { name: 'Bread' }, { name: 'Tea' }] } }, 'Add').message, 'Milk, Eggs and 2 more added.');
    assert.deepEqual(choreAnswerMeaning('shopping.tick', { result: { status: 'ticked' } }, 'Milk'), { undoable: true, message: 'Milk is in the cart.' });
  });

  it('nothing changed reads as a plain notice without Undo, naming the earlier buyer without an email', () => {
    assert.deepEqual(choreAnswerMeaning('shopping.tick', { result: { status: 'already', byName: 'Sam' } }, 'Milk'), { undoable: false, notice: true, message: 'Already in the cart: Sam ticked it.' });
    assert.equal(choreAnswerMeaning('shopping.tick', { result: { status: 'already', byName: 'sam@example.test' } }, 'Milk').message, 'Already in the cart.');
    assert.equal(choreAnswerMeaning('shopping.tick', { result: { status: 'gone' } }, 'Milk').message, 'That item was removed meanwhile.');
    assert.equal(choreAnswerMeaning('shopping.add', { result: { status: 'gone' } }, 'Add').message, 'That list was removed meanwhile.');
    for (const status of ['undone', 'already', 'not_applied']) {
      assert.deepEqual(choreAnswerMeaning('shopping.tick.undo', { status }, 'Milk'), { undoable: false, message: 'Undone.' });
    }
  });

  it('a queued replay is kept only when it applied; a tick someone made first is dropped with why', () => {
    assert.deepEqual(queuedSendResult('shopping.add', ok({ result: { status: 'added', items: [] } })), { ok: true });
    assert.deepEqual(queuedSendResult('shopping.tick', ok({ result: { status: 'ticked' } })), { ok: true });
    assert.deepEqual(queuedSendResult('shopping.tick', ok({ result: { status: 'already', byName: 'Sam' } })), { ok: false, code: 'conflict', reason: 'already in the cart: Sam ticked it.' });
    assert.deepEqual(queuedSendResult('shopping.add', ok({ result: { status: 'gone' } })), { ok: false, code: 'invalid_input', reason: 'that list was removed meanwhile.' });
    for (const undo of ['shopping.add.undo', 'shopping.tick.undo'] as const) {
      for (const status of ['undone', 'already', 'not_applied']) assert.deepEqual(queuedSendResult(undo, ok({ status })), { ok: true });
      assert.deepEqual(queuedSendResult(undo, { ok: false, code: 'changed_since' }), { ok: false, code: 'changed_since' });
    }
    const entry = createQueuedAction({
      opId: '00000000-0000-4000-8000-000000000001', kind: 'action', householdId: 'H', deviceId: 'D'.repeat(20), generation: 1,
      capability: 'shopping.tick', actorUid: 'max', actorName: 'Max', intent: { listId: 'l', itemId: 'i' },
    }, new Date('2026-11-20T10:00:00Z'));
    assert.equal(dropNotice([{ entry, code: 'forbidden' }]), "1 change from this tablet couldn't be saved: Max can no longer tick shopping items here.");
  });

  it('addedNames', () => {
    assert.equal(addedNames([]), 'Items');
    assert.equal(addedNames([{ name: 'Milk' }, { name: 'Eggs' }]), 'Milk and Eggs');
  });
});

describe('the entries of an add (deviceAddEntries, checked again by the server)', () => {
  it('normalizes names as quick add does and adds up repeats', () => {
    assert.deepEqual(deviceAddEntries([{ name: '  milk ', quantity: 1 }, { name: 'Bread', quantity: 2 }, { name: 'MILK', quantity: 3 }]), [
      { name: 'Milk', quantity: 4 }, { name: 'Bread', quantity: 2 },
    ]);
    assert.deepEqual(deviceAddEntries([{ name: 'Tea', quantity: 999 }, { name: 'tea', quantity: 5 }]), [{ name: 'Tea', quantity: 999 }]);
  });

  it('refuses nothing, more than 20, an empty name, a quantity outside 1-999 or not whole', () => {
    assert.equal(deviceAddEntries([]), null);
    assert.equal(deviceAddEntries('milk'), null);
    assert.equal(deviceAddEntries(Array.from({ length: 21 }, (_, index) => ({ name: `n${index}`, quantity: 1 }))), null);
    assert.equal(deviceAddEntries([{ name: ' ', quantity: 1 }]), null);
    assert.equal(deviceAddEntries([{ name: 'x', quantity: 0 }]), null);
    assert.equal(deviceAddEntries([{ name: 'x', quantity: 1000 }]), null);
    assert.equal(deviceAddEntries([{ name: 'x', quantity: 1.5 }]), null);
    assert.equal(deviceAddEntries([{ name: 'x'.repeat(501), quantity: 1 }]), null);
  });
});

describe('a phone restoring a deleted item a tablet wrote', () => {
  it('restoreItemData drops the tablet fields (the rules refuse them from a phone)', () => {
    const restored = restoreItemData({ name: 'Milk', deviceAttribution: { deviceId: 'd' }, purchaseDeviceAttribution: { deviceId: 'd' }, addedByUid: 'max' }, 'olive', 'op') as Record<string, unknown>;
    assert.equal('deviceAttribution' in restored, false);
    assert.equal('purchaseDeviceAttribution' in restored, false);
    assert.equal(restored.addedByUid, 'max');
    assert.equal(restored.restoredByUid, 'olive');
  });
});

describe('kitchen mode on the tablet (SH-11)', () => {
  const lists = kitchenLists([
    { id: 'hardware', name: 'Hardware', type: 'Hardware' },
    { id: 'costco', name: 'Costco', type: 'Grocery', storeId: 'costco-store' },
    { id: 'weekly', name: 'Weekly', type: 'Grocery' },
  ]);

  it('lists by name, with their store', () => {
    assert.deepEqual(lists.map((list) => [list.id, list.storeId]), [['costco', 'costco-store'], ['hardware', null], ['weekly', null]]);
  });

  it('shows the list in the address, else the household default Grocery list, else the first Grocery list, else any list', () => {
    assert.equal(kitchenListChoice({ lists, pickedId: 'hardware', defaultListId: 'weekly', defaultKnown: true }).list?.id, 'hardware');
    assert.equal(kitchenListChoice({ lists, pickedId: null, defaultListId: 'weekly', defaultKnown: true }).list?.id, 'weekly');
    assert.equal(kitchenListChoice({ lists, pickedId: 'gone', defaultListId: null, defaultKnown: true }).list?.id, 'costco');
    assert.deepEqual(kitchenListChoice({ lists, pickedId: null, defaultListId: null, defaultKnown: false }), { list: null, waiting: true });
    const noGrocery = kitchenLists([{ id: 'hardware', name: 'Hardware', type: 'Hardware' }]);
    assert.equal(kitchenListChoice({ lists: noGrocery, pickedId: null, defaultListId: null, defaultKnown: false }).list?.id, 'hardware');
    assert.deepEqual(kitchenListChoice({ lists: [], pickedId: null, defaultListId: null, defaultKnown: true }), { list: null, waiting: false });
  });
});

describe('attribution and "is shopping" on the tablet (SH-28)', () => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  const names = rosterFirstNames([{ uid: 'sam', name: 'Sam Lee' }, { uid: 'alex', name: 'Alex' }]);
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);

  it('rows say who added an item by first name and how long ago; never "You"; an unknown adder is "Member"', () => {
    assert.equal(kitchenAttribution({ addedByUid: 'sam', createdAt: new Date(now - 2 * 86_400_000) }, names, now), 'Sam added · 2d');
    assert.equal(kitchenAttribution({ addedByUid: 'former', createdAt: minutesAgo(5) }, names, now), 'Member added · 5m');
    assert.equal(kitchenAttribution({ addedByUid: undefined, createdAt: minutesAgo(5) }, names, now), null);
  });

  it('a tablet tick is bound to its purchase: a later phone purchase of the same item is not a tablet tick', () => {
    const [own, later] = kitchenItems([
      { id: 'a', name: 'Milk', status: 'purchased', purchaseOpId: 'op-1', purchaseDeviceAttribution: { deviceId: 'd', purchaseOpId: 'op-1' } },
      { id: 'b', name: 'Eggs', status: 'purchased', purchaseOpId: 'phone-2', purchaseDeviceAttribution: { deviceId: 'd', purchaseOpId: 'op-0' } },
    ]);
    assert.equal(own.tickedOnTablet, true);
    assert.equal(later.tickedOnTablet, false);
  });

  it('"Alex is shopping · 1 left" from a member\'s ticks elsewhere in the last 10 minutes; ticks on a wall tablet never count', () => {
    const items = kitchenItems([
      { id: '1', name: 'Milk', status: 'purchased', purchasedByUid: 'alex', purchasedAt: minutesAgo(2), purchaseOpId: 'p1' },
      { id: '2', name: 'Eggs', status: 'purchased', purchasedByUid: 'alex', purchasedAt: minutesAgo(1), purchaseOpId: 'p2' },
      { id: '3', name: 'Tea', status: 'needed' },
      { id: '4', name: 'Rice', status: 'purchased', purchasedByUid: 'sam', purchasedAt: minutesAgo(1), purchaseOpId: 't1', purchaseDeviceAttribution: { purchaseOpId: 't1' } },
      { id: '5', name: 'Oats', status: 'purchased', purchasedByUid: 'sam', purchasedAt: minutesAgo(1), purchaseOpId: 't2', purchaseDeviceAttribution: { purchaseOpId: 't2' } },
    ]);
    assert.equal(kitchenActivity(items, names, now)?.label, 'Alex is shopping · 1 left');
    const kitchenOnly = items.filter((item) => item.id !== '1' && item.id !== '2');
    assert.equal(kitchenActivity(kitchenOnly, names, now), null);
    const old = kitchenItems([
      { id: '1', status: 'purchased', purchasedByUid: 'alex', purchasedAt: minutesAgo(30), purchaseOpId: 'p1' },
      { id: '2', status: 'purchased', purchasedByUid: 'alex', purchasedAt: minutesAgo(25), purchaseOpId: 'p2' },
    ]);
    assert.equal(kitchenActivity(old, names, now), null);
  });
});

describe('the tablet shell and dashboard', () => {
  const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

  it('the Shopping section grants the tile its Tick (shopping.edit) and takes it away when switched off', () => {
    const sections = { chores: true, shopping: true, pets: true, calendar: true, maintenance: true };
    assert.equal(devicePermissions(sections)['shopping.edit'], true);
    assert.equal(devicePermissions({ ...sections, shopping: false })['shopping.edit'], false);
    assert.equal(devicePermissions(sections)['shopping.delete'], false);
  });

  it('the dashboard tile ticks through the device action on a tablet, and hides its palette "+" there', () => {
    const tick = read('src/components/dashboard/shopping-tick.tsx');
    assert.match(tick, /tablet\.runAction\(\{ capability: 'shopping\.tick'/);
    assert.ok(tick.indexOf('if (tablet)') < tick.indexOf('if (!householdId || !uid'), 'the tablet branch comes before the signed-in check');
    assert.match(read('src/components/dashboard/bento-grid.tsx'), /permissions\['shopping\.edit'\] && scopeKind !== 'device'/);
  });

  it('the kitchen view writes only through device actions and reads only through the tablet listener', () => {
    const view = read('src/components/devices/tablet-shopping.tsx');
    assert.doesNotMatch(view, /\b(setDoc|updateDoc|addDoc|deleteDoc|runTransaction|writeBatch)\b/);
    assert.doesNotMatch(view, /@\/lib\/shopping\/(add-items|tick|tick-firestore|item-transactions|item-writes|live)'/);
    assert.match(view, /runAction\(\{ capability: 'shopping\.tick'/);
    assert.match(view, /runAction\(\{ capability: 'shopping\.add'/);
    assert.match(view, /tabletListener<Snapshot>\(/);
    assert.doesNotMatch(read('src/components/devices/tablet-views.tsx'), /read-only on wall tablets/);
  });
});

describe('the pantry from a tablet scan (BL-20, BL-21)', () => {
  it('Used up and Restock are face actions with their Undo proven; the points PIN never applies; they queue', () => {
    for (const capability of ['pantry.useUp', 'pantry.useUp.undo', 'pantry.restock', 'pantry.restock.undo'] as const) {
      assert.ok(UNDO_PROVEN.has(capability), capability);
      assert.ok(SENDABLE_CAPABILITIES.has(capability), capability);
      assert.equal(DEVICE_ACTION_POLICY[capability].section, 'shopping', capability);
      assert.deepEqual(DEVICE_ACTION_POLICY[capability].permissions, ['shopping.edit'], capability);
    }
    for (const pointsPin of ['off', 'kids', 'everyone'] as const) {
      for (const actorRole of ['member', 'child'] as const) {
        assert.equal(requiredLevel('pantry.useUp', { pointsPin, actorRole }), 'face');
        assert.equal(queueAllowed('pantry.restock', { pointsPin, actorRole }), true);
      }
    }
    assert.equal(UNDO_CAPABILITY_OF['pantry.useUp'], 'pantry.useUp.undo');
    assert.equal(UNDO_CAPABILITY_OF['pantry.restock'], 'pantry.restock.undo');
    assert.deepEqual(UNDO_OF['pantry.useUp.undo'], ['pantry.useUp']);
  });

  it('answers: one package used (the last one says so), restocked, and the no-ops say why without Undo', () => {
    assert.deepEqual(choreAnswerMeaning('pantry.useUp', { result: { status: 'used', name: 'Beans', remaining: 2 } }, 'Beans'), { undoable: true, message: 'Used one Beans. 2 left.' });
    assert.deepEqual(choreAnswerMeaning('pantry.useUp', { result: { status: 'used', name: 'Beans', remaining: 0 } }, 'Beans'), { undoable: true, message: 'Used the last Beans.' });
    assert.deepEqual(choreAnswerMeaning('pantry.restock', { result: { status: 'restocked', name: 'Beans', created: true } }, 'Beans'), { undoable: true, message: 'Beans is in the pantry (1).' });
    assert.deepEqual(choreAnswerMeaning('pantry.useUp', { result: { status: 'not_stocked', name: 'Beans' } }, 'Beans'), { undoable: false, notice: true, message: 'Beans is not in the pantry.' });
    assert.deepEqual(queuedSendResult('pantry.useUp', ok({ result: { status: 'used' } })), { ok: true });
    assert.deepEqual(queuedSendResult('pantry.useUp', ok({ result: { status: 'not_stocked', name: 'Beans' } })), { ok: false, code: 'invalid_input', reason: 'beans is not in the pantry.' });
    assert.deepEqual(queuedSendResult('pantry.restock.undo', ok({ status: 'undone' })), { ok: true });
    assert.deepEqual(queuedSendResult('pantry.restock.undo', ok({ status: 'other' })), { ok: false, code: 'changed_since' });
  });
});
