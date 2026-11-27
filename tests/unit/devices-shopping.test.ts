import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEVICE_ACTION_POLICY, UNDO_OF, UNDO_PROVEN, requiredLevel } from '../../src/lib/devices/action-policy';
import { addedNames, choreAnswerMeaning, queuedSendResult, SENDABLE_CAPABILITIES, UNDO_CAPABILITY_OF } from '../../src/lib/devices/device-action-answers';
import { dropNotice, createQueuedAction, queueAllowed } from '../../src/lib/devices/offline-queue';
import { deviceAddEntries } from '../../src/lib/devices/tablet-shopping';
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
