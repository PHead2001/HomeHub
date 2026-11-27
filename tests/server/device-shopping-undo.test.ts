import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { DeviceActionError } from '../../src/lib/server/device-gate';
import {
  addShoppingItemsFromTablet,
  tickShoppingItemFromTablet,
  undoShoppingAddFromTablet,
  undoShoppingTickFromTablet,
  type DeviceShoppingRequest,
} from '../../src/lib/server/device-shopping';
import { createDeviceRepairCode, redeemDeviceCode, removeDevice, updateDeviceSettings } from '../../src/lib/server/device-management';
import { UNDO_PROVEN } from '../../src/lib/devices/action-policy';
import { tickShoppingItemFromTabletAction } from '../../src/app/shopping/device-actions';
import { deleteDeviceUsers, nonce, personToken, seedHousehold, signIn, type Person } from './device-test-helpers';
import { clock, house, opId, pairTablet, seedKid, tokenGeneration, type Tablet } from './device-actor-helpers';

// The Undo proof for shopping on wall tablets (design 10.4; tracker WT-20f; audit HP-33,
// HP-36, SH-11, SH-28), with real ID tokens: for shopping.add (a new item, and an addition
// merged into a needed item) and shopping.tick: (1) a personal client or another tablet
// changes the same item in between, so the Undo leaves it alone (`changed_since`), (2) a
// reload Undoes by the journal's opId inside the window and is refused after it, (3) a
// dropped connection repeats the action (one write) and the Undo (then already), (4) action,
// Undo, late retry, (5) Undo before the action, (6) a queued send in flight and its Undo at
// once, both orders, (7) the wrong principal (another tablet, person, generation, after the
// window). Plus WT-18c (the selected person as adder and buyer, the tablet recorded), WT-11c
// (Shopping switched off on the tablet), the shopping.edit permission (a child, a kid
// profile, a guest, a member without it), forged fields ignored, no points PIN, an opId
// reused for another target, answers without emails, R1 and a personal token refused.

const H = 'dev-shopping-house';
const owner: Person = { uid: 'ds-owner', email: 'ds.owner@example.test', displayName: 'Olive Stone', role: 'owner' };
const member: Person = { uid: 'ds-member', email: 'ds.member@example.test', displayName: 'Max', role: 'member' };
const child: Person = { uid: 'ds-child', email: 'ds.child@example.test', displayName: 'Cleo', role: 'child' };
const guest: Person = { uid: 'ds-guest', email: 'ds.guest@example.test', displayName: 'Gus', role: 'guest' };
const noEdit: Person = { uid: 'ds-noedit', email: 'ds.noedit@example.test', displayName: 'Nell', role: 'member', permissions: { 'shopping.edit': false } };
const KID = 'kid_DevShoppingKid0000000';
const LIST = 'groceries';
const created = new Set<string>();
const time = clock(Date.parse('2026-11-20T15:00:00Z'));
let tablet: Tablet;
let other: Tablet;
let memberToken: string;

const list = (id = LIST) => house(H).collection('shopping-lists').doc(id);
const item = (id: string, listId = LIST) => list(listId).collection('items').doc(id);
const read = async (id: string, listId = LIST) => (await item(id, listId).get()).data();
const itemsNamed = async (name: string, listId = LIST) => (await list(listId).collection('items').where('name', '==', name).get()).docs;

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeviceActionError, `expected DeviceActionError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const request = (t: Tablet, actorUid: string, op: string, extra: Partial<DeviceShoppingRequest> = {}): DeviceShoppingRequest => ({
  idToken: t.idToken, householdId: H, actorUid, opId: op, ...extra,
});

/** A fresh minute for each test keeps every call inside the per-tablet rate windows. */
let at: Date;
const later = (ms: number) => new Date(at.getTime() + ms);
const opts = (when: Date = at) => ({ clock: () => when });
const queued = (t: Tablet, agoMs: number) => ({ queued: { createdAt: later(-agoMs).toISOString(), generation: tokenGeneration(t.idToken) } });

const add = (t: Tablet, actorUid: string, op: string, names: Array<string | [string, number]>, extra: Partial<DeviceShoppingRequest> & { listId?: string } = {}, when: Date = at) =>
  addShoppingItemsFromTablet({
    ...request(t, actorUid, op, extra),
    listId: extra.listId ?? LIST,
    entries: names.map((entry) => (Array.isArray(entry) ? { name: entry[0], quantity: entry[1] } : { name: entry, quantity: 1 })),
  }, opts(when));

const tick = (t: Tablet, actorUid: string, op: string, itemId: string, extra: Partial<DeviceShoppingRequest> & { listId?: string } = {}, when: Date = at) =>
  tickShoppingItemFromTablet({ ...request(t, actorUid, op, extra), listId: extra.listId ?? LIST, itemId }, opts(when));

const seedItem = (id: string, fields: Record<string, unknown> = {}, listId = LIST) => item(id, listId).set({
  name: `Item ${id}`, nameKey: `item ${id}`, quantity: 1, category: 'Other', status: 'needed', createdAt: Timestamp.fromDate(new Date('2026-11-18T10:00:00Z')), addedByUid: owner.uid, ...fields,
});

/** A phone's tick and un-tick (the fields tickUpdate / untickUpdate write, as the rules allow them). */
const personalTick = (id: string, uid: string, purchaseOpId: string) => item(id).update({ status: 'purchased', purchasedByUid: uid, purchasedAt: Timestamp.fromDate(at), purchaseOpId });
const personalUntick = (id: string) => item(id).update({ status: 'needed', purchasedByUid: null, purchasedAt: null });

before(async () => {
  await seedHousehold(H, [owner, member, child, guest, noEdit], { timeZone: 'America/Chicago' });
  await seedKid(H, KID, 'Mia');
  tablet = await pairTablet(H, owner, created, 'Kitchen tablet');
  other = await pairTablet(H, owner, created, 'Hall tablet');
  memberToken = await personToken(member);
});

beforeEach(async () => {
  at = time.advance(61_000);
  await house(H).update({ devicePolicy: { pointsPin: 'off' } });
  await list().set({ name: 'Groceries', type: 'Grocery', description: '', icon: 'ShoppingCart' });
});

after(async () => {
  await deleteDeviceUsers([...created]);
  await adminDb.recursiveDelete(house(H));
  const codes = await adminDb.collection('deviceCodes').where('householdId', '==', H).get();
  await Promise.all(codes.docs.map(d => d.ref.delete()));
});

describe('shopping on tablets is face-level with its Undo proven', () => {
  test('UNDO_PROVEN holds the four shopping capabilities proven in this file', () => {
    for (const capability of ['shopping.add', 'shopping.add.undo', 'shopping.tick', 'shopping.tick.undo'] as const) {
      assert.ok(UNDO_PROVEN.has(capability), capability);
    }
  });
});

describe('shopping.add', () => {
  test('WT-18c: new items are added by the selected person with the tablet recorded; the category is local (no AI)', async () => {
    const op = opId();
    const { result, level } = await add(tablet, member.uid, op, ['milk', ['Bread', 2], 'Saffron threads']);
    assert.equal(level, 'face');
    assert.equal(result.status, 'added');
    assert.ok(result.status === 'added');
    assert.deepEqual(result.items.map((entry) => [entry.name, entry.quantity, entry.created]), [['Milk', 1, true], ['Bread', 2, true], ['Saffron threads', 1, true]]);
    const [milk] = await itemsNamed('Milk');
    const stored = milk.data();
    assert.equal(stored.addedByUid, member.uid);
    assert.equal(stored.status, 'needed');
    assert.equal(stored.nameKey, 'milk');
    assert.equal(stored.category, 'Dairy');
    assert.equal(stored.categorySource, 'local');
    assert.ok(stored.createdAt instanceof Timestamp);
    assert.equal(stored.createdAt.toMillis(), at.getTime());
    assert.deepEqual(stored.deviceAttribution, { deviceId: tablet.deviceId, deviceName: 'Kitchen tablet', generation: 1, actorUid: member.uid, level: 'face' });
    const [saffron] = await itemsNamed('Saffron threads');
    assert.equal(saffron.get('category'), 'Other');
    assert.equal(saffron.get('categorySource'), 'fallback');
    const ledger = (await house(H).collection('devices').doc(tablet.deviceId).collection('ops').doc(op).get()).data()!;
    assert.equal(ledger.state, 'applied');
    assert.equal(ledger.actorUid, member.uid);
    assert.equal(ledger.targetPath, list().path);
  });

  test('a name still needed merges into that item (its quantity raised); its Undo puts the quantity back', async () => {
    await seedItem('eggs', { name: 'Eggs', nameKey: 'eggs', quantity: 2, category: 'Dairy', categorySource: 'manual' });
    await seedItem('eggs-bought', { name: 'Eggs', nameKey: 'eggs', quantity: 6, status: 'purchased', purchasedByUid: owner.uid, purchaseOpId: 'p-1' });
    const op = opId();
    const { result } = await add(tablet, member.uid, op, [['eggs', 3]]);
    assert.ok(result.status === 'added');
    assert.deepEqual(result.items, [{ itemId: 'eggs', name: 'Eggs', quantity: 3, created: false, before: 2, after: 5 }]);
    assert.equal((await read('eggs'))!.quantity, 5);
    assert.equal((await read('eggs'))!.addedByUid, owner.uid, 'the adder of a merged item stays');
    assert.equal((await read('eggs-bought'))!.quantity, 6, 'a purchased item is never merged into');
    assert.equal((await undoShoppingAddFromTablet(request(tablet, member.uid, op), opts(later(2000)))).status, 'undone');
    assert.equal((await read('eggs'))!.quantity, 2);
  });

  test('a merged item changed since in any way (renamed, or a quantity changed and back) keeps its change', async () => {
    await seedItem('pears', { name: 'Apples', nameKey: 'apples', quantity: 1, category: 'Produce', categorySource: 'manual' });
    const renamed = opId();
    await add(tablet, member.uid, renamed, [['apples', 2]]);
    await item('pears').update({ name: 'Pears', nameKey: 'pears' });
    await refused(undoShoppingAddFromTablet(request(tablet, member.uid, renamed), opts(later(2000))), 'changed_since');
    assert.equal((await read('pears'))!.quantity, 3, 'the rename keeps the three');

    await seedItem('kiwi', { name: 'Kiwi', nameKey: 'kiwi', quantity: 2, category: 'Produce', categorySource: 'manual' });
    const flip = opId();
    await add(tablet, member.uid, flip, [['kiwi', 1]]);
    const kiwi = item('kiwi');
    await kiwi.update({ quantity: 4 });
    await kiwi.update({ quantity: 3 });
    await refused(undoShoppingAddFromTablet(request(tablet, member.uid, flip), opts(later(2000))), 'changed_since');
    assert.equal((await read('kiwi'))!.quantity, 3);
  });

  test('a remembered category on the list wins over the keyword map', async () => {
    await seedItem('old-oat', { name: 'Oat milk', nameKey: 'oat milk', status: 'purchased', category: 'Drinks', categorySource: 'manual' });
    await add(tablet, member.uid, opId(), ['oat milk']);
    const needed = (await itemsNamed('Oat milk')).find((doc) => doc.get('status') === 'needed')!;
    assert.equal(needed.get('category'), 'Drinks');
    assert.equal(needed.get('categorySource'), 'remembered');
  });

  test('case 1: a personal client or another tablet changed it in between, so the Undo leaves it alone', async () => {
    const op = opId();
    const { result } = await add(tablet, member.uid, op, ['Apples']);
    assert.ok(result.status === 'added');
    const appleId = result.items[0].itemId;
    await personalTick(appleId, owner.uid, 'phone-tick');
    await refused(undoShoppingAddFromTablet(request(tablet, member.uid, op), opts(later(2000))), 'changed_since');
    assert.equal((await read(appleId))!.status, 'purchased');

    await seedItem('rice', { name: 'Rice', nameKey: 'rice', quantity: 1 });
    const first = opId();
    await add(tablet, member.uid, first, ['rice']);
    await add(other, owner.uid, opId(), ['Rice']);
    assert.equal((await read('rice'))!.quantity, 3);
    await refused(undoShoppingAddFromTablet(request(tablet, member.uid, first), opts(later(2000))), 'changed_since');
    assert.equal((await read('rice'))!.quantity, 3, 'the other tablet\'s addition stays');
  });

  test('case 2: after a reload the journal opId Undoes inside the window and is refused after it', async () => {
    const inside = opId();
    await add(tablet, member.uid, inside, ['Reload in']);
    assert.equal((await undoShoppingAddFromTablet(request(tablet, member.uid, inside), opts(later(9000)))).status, 'undone');
    assert.equal((await itemsNamed('Reload in')).length, 0);
    const outside = opId();
    await add(tablet, member.uid, outside, ['Reload out']);
    await refused(undoShoppingAddFromTablet(request(tablet, member.uid, outside), opts(later(15_001))), 'undo_expired');
    assert.equal((await itemsNamed('Reload out')).length, 1);
  });

  test('case 3: a dropped connection repeats the add (one item) and the Undo (then already)', async () => {
    const op = opId();
    const first = await add(tablet, member.uid, op, ['Dropped']);
    const repeat = await add(tablet, member.uid, op, ['Dropped'], {}, later(1000));
    assert.deepEqual(repeat.result, first.result);
    assert.equal((await itemsNamed('Dropped')).length, 1);
    assert.equal((await undoShoppingAddFromTablet(request(tablet, member.uid, op), opts(later(2000)))).status, 'undone');
    assert.equal((await undoShoppingAddFromTablet(request(tablet, member.uid, op), opts(later(3000)))).status, 'already');
    assert.equal((await itemsNamed('Dropped')).length, 0);
  });

  test('case 4: add, Undo, then a late retry of the add is already undone', async () => {
    const op = opId();
    await add(tablet, member.uid, op, ['Late']);
    await undoShoppingAddFromTablet(request(tablet, member.uid, op), opts(later(1000)));
    await refused(add(tablet, member.uid, op, ['Late'], {}, later(2000)), 'already_undone');
    assert.equal((await itemsNamed('Late')).length, 0);
  });

  test('case 5: the Undo arrives first (a tombstone), then the add is refused', async () => {
    const op = opId();
    assert.equal((await undoShoppingAddFromTablet(request(tablet, member.uid, op), opts())).status, 'not_applied');
    await refused(add(tablet, member.uid, op, ['First'], {}, later(1000)), 'already_undone');
    assert.equal((await itemsNamed('First')).length, 0);
  });

  test('case 6: a queued add in flight and its Undo at once, both orders, leave nothing added', async () => {
    for (const order of ['action-first', 'undo-first'] as const) {
      const name = `Race ${order}`;
      const op = opId();
      const action = add(tablet, member.uid, op, [name], queued(tablet, 30_000)).catch(error => error);
      const undo = undoShoppingAddFromTablet(request(tablet, member.uid, op, queued(tablet, 25_000)), opts()).catch(error => error);
      await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
      assert.equal((await itemsNamed(name)).length, 0, order);
      await refused(add(tablet, member.uid, op, [name], {}, later(1000)), 'already_undone');
    }
  });

  test('case 7: another tablet, another person, an older generation, or after the window cannot Undo it', async () => {
    const op = opId();
    await add(tablet, member.uid, op, ['Principal']);
    assert.equal((await undoShoppingAddFromTablet(request(other, member.uid, op), opts(later(1000)))).status, 'not_applied');
    await refused(undoShoppingAddFromTablet(request(tablet, owner.uid, op), opts(later(1000))), 'forbidden');
    await refused(undoShoppingAddFromTablet(request(tablet, member.uid, op), opts(later(16_000))), 'undo_expired');
    assert.equal((await itemsNamed('Principal')).length, 1);

    const spare = await pairTablet(H, owner, created, 'Spare tablet');
    const spareOp = opId();
    await add(spare, member.uid, spareOp, ['Generation']);
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    const fresh = { ...spare, idToken: (await signIn(repaired.customToken)).idToken };
    await refused(undoShoppingAddFromTablet(request(fresh, member.uid, spareOp), opts(later(1000))), 'not_undoable');
    assert.equal((await itemsNamed('Generation')).length, 1);
  });

  test('R1: a queued Undo of a queued add is accepted late (bounded); a live add is not', async () => {
    const queuedOp = opId();
    await add(tablet, member.uid, queuedOp, ['R1 queued'], queued(tablet, 60_000));
    assert.equal((await undoShoppingAddFromTablet(request(tablet, member.uid, queuedOp, queued(tablet, 55_000)), opts(later(5 * 60_000)))).status, 'undone');
    const liveOp = opId();
    await add(tablet, member.uid, liveOp, ['R1 live']);
    await refused(undoShoppingAddFromTablet(request(tablet, member.uid, liveOp, { queued: { createdAt: at.toISOString(), generation: tokenGeneration(tablet.idToken) } }), opts(later(60_000))), 'undo_expired');
    assert.equal((await itemsNamed('R1 live')).length, 1);
  });

  test('a list deleted meanwhile is gone (nothing written); its Undo answers already; the opId for another list is a conflict', async () => {
    const op = opId();
    const { result } = await add(tablet, member.uid, op, ['Nowhere'], { listId: 'deleted-list' });
    assert.deepEqual(result, { status: 'gone', listId: 'deleted-list' });
    assert.equal((await list('deleted-list').collection('items').get()).size, 0);
    assert.equal((await undoShoppingAddFromTablet(request(tablet, member.uid, op), opts(later(1000)))).status, 'already');

    const reused = opId();
    await add(tablet, member.uid, reused, ['Bound']);
    await list('hardware').set({ name: 'Hardware', type: 'Hardware', description: '', icon: 'Wrench' });
    await refused(add(tablet, member.uid, reused, ['Bound'], { listId: 'hardware' }, later(1000)), 'conflict');
    assert.equal((await list('hardware').collection('items').get()).size, 0);
  });

  test('forged fields are ignored: the adder, status and attribution come from the server', async () => {
    const forged = {
      ...request(tablet, member.uid, opId()),
      listId: LIST,
      entries: [{ name: 'Forged', quantity: 1, addedByUid: owner.uid, status: 'purchased', deviceAttribution: { deviceId: 'x' } }],
      addedByUid: owner.uid,
      deviceAttribution: { deviceId: 'nope', level: 'pin' },
      level: 'pin',
    } as unknown as Parameters<typeof addShoppingItemsFromTablet>[0];
    await addShoppingItemsFromTablet(forged, opts());
    const [stored] = await itemsNamed('Forged');
    assert.equal(stored.get('addedByUid'), member.uid);
    assert.equal(stored.get('status'), 'needed');
    assert.equal(stored.get('deviceAttribution.deviceId'), tablet.deviceId);
    assert.equal(stored.get('deviceAttribution.level'), 'face');
  });

  test('bad entries are invalid input: none, more than 20, an empty name, a quantity of 0 or 1000', async () => {
    for (const entries of [[], Array.from({ length: 21 }, (_, index) => ({ name: `n${index}`, quantity: 1 })), [{ name: '   ', quantity: 1 }], [{ name: 'Zero', quantity: 0 }], [{ name: 'Lots', quantity: 1000 }], [{ name: 'Half', quantity: 1.5 }]]) {
      await refused(addShoppingItemsFromTablet({ ...request(tablet, member.uid, opId()), listId: LIST, entries }, opts()), 'invalid_input');
    }
    await refused(addShoppingItemsFromTablet({ ...request(tablet, member.uid, opId()), listId: 'a/b', entries: [{ name: 'x', quantity: 1 }] }, opts()), 'invalid_input');
  });
});

describe('shopping.tick', () => {
  test('WT-18c: the selected person is the buyer, the server\'s time, the opId as purchaseOpId, the tablet recorded', async () => {
    await seedItem('t-credit', { undoOpId: 'older-undo' });
    const op = opId();
    const { result, level } = await tick(tablet, member.uid, op, 't-credit');
    assert.equal(level, 'face');
    assert.deepEqual(result, { status: 'ticked', listId: LIST, itemId: 't-credit', name: 'Item t-credit' });
    const stored = (await read('t-credit'))!;
    assert.equal(stored.status, 'purchased');
    assert.equal(stored.purchasedByUid, member.uid);
    assert.equal(stored.purchaseOpId, op);
    assert.equal(stored.purchasedAt.toMillis(), at.getTime());
    assert.equal(stored.undoOpId, undefined);
    assert.equal(stored.addedByUid, owner.uid);
    assert.deepEqual(stored.purchaseDeviceAttribution, { deviceId: tablet.deviceId, deviceName: 'Kitchen tablet', generation: 1, actorUid: member.uid, level: 'face', purchaseOpId: op });
    assert.equal(stored.deviceAttribution, undefined, 'the add\'s attribution is a separate field');
  });

  test('an item someone ticked first keeps its buyer (already, named without an email); its Undo answers already', async () => {
    await seedItem('t-already', { status: 'purchased', purchasedByUid: owner.uid, purchaseOpId: 'phone-1', purchasedAt: Timestamp.fromDate(at) });
    const op = opId();
    const { result } = await tick(tablet, member.uid, op, 't-already');
    assert.deepEqual(result, { status: 'already', listId: LIST, itemId: 't-already', name: 'Item t-already', byName: 'Olive Stone' });
    assert.equal((await undoShoppingTickFromTablet(request(tablet, member.uid, op), opts(later(1000)))).status, 'already');
    assert.equal((await read('t-already'))!.purchasedByUid, owner.uid);
    assert.equal((await read('t-already'))!.purchaseOpId, 'phone-1');
  });

  test('an item removed meanwhile is gone; the opId for another item is a conflict', async () => {
    assert.deepEqual((await tick(tablet, member.uid, opId(), 'never-there')).result, { status: 'gone', listId: LIST, itemId: 'never-there' });
    await seedItem('t-bound-a');
    await seedItem('t-bound-b');
    const op = opId();
    await tick(tablet, member.uid, op, 't-bound-a');
    await refused(tick(tablet, member.uid, op, 't-bound-b', {}, later(1000)), 'conflict');
    assert.equal((await read('t-bound-b'))!.status, 'needed');
  });

  test('the Undo puts it back to needed with the undo stamp and without the purchase or its attribution', async () => {
    await seedItem('t-undo');
    const op = opId();
    await tick(tablet, member.uid, op, 't-undo');
    assert.equal((await undoShoppingTickFromTablet(request(tablet, member.uid, op), opts(later(2000)))).status, 'undone');
    const stored = (await read('t-undo'))!;
    assert.equal(stored.status, 'needed');
    assert.equal(stored.undoOpId, op);
    assert.equal(stored.purchasedByUid, null);
    assert.equal(stored.purchasedAt, null);
    assert.equal(stored.purchaseDeviceAttribution, undefined);
  });

  test('case 1: a personal client or another tablet ticked it again in between, so the Undo leaves it alone', async () => {
    await seedItem('t-personal');
    const op = opId();
    await tick(tablet, member.uid, op, 't-personal');
    await personalUntick('t-personal');
    await personalTick('t-personal', owner.uid, 'phone-again');
    await refused(undoShoppingTickFromTablet(request(tablet, member.uid, op), opts(later(2000))), 'changed_since');
    assert.equal((await read('t-personal'))!.purchaseOpId, 'phone-again');

    await seedItem('t-other');
    const first = opId();
    await tick(tablet, member.uid, first, 't-other');
    await personalUntick('t-other');
    const second = opId();
    await tick(other, owner.uid, second, 't-other');
    await refused(undoShoppingTickFromTablet(request(tablet, member.uid, first), opts(later(2000))), 'changed_since');
    const stored = (await read('t-other'))!;
    assert.equal(stored.purchasedByUid, owner.uid);
    assert.equal(stored.purchaseOpId, second);

    // Un-ticked on a phone: nothing of this tick is left to undo.
    await seedItem('t-unticked');
    const third = opId();
    await tick(tablet, member.uid, third, 't-unticked');
    await personalUntick('t-unticked');
    await refused(undoShoppingTickFromTablet(request(tablet, member.uid, third), opts(later(2000))), 'changed_since');
    assert.equal((await read('t-unticked'))!.status, 'needed');
  });

  test('case 2: after a reload the journal opId Undoes inside the window and is refused after it', async () => {
    await seedItem('t-reload-in');
    const inside = opId();
    await tick(tablet, member.uid, inside, 't-reload-in');
    assert.equal((await undoShoppingTickFromTablet(request(tablet, member.uid, inside), opts(later(9000)))).status, 'undone');
    assert.equal((await read('t-reload-in'))!.status, 'needed');
    await seedItem('t-reload-out');
    const outside = opId();
    await tick(tablet, member.uid, outside, 't-reload-out');
    await refused(undoShoppingTickFromTablet(request(tablet, member.uid, outside), opts(later(15_001))), 'undo_expired');
    assert.equal((await read('t-reload-out'))!.status, 'purchased');
  });

  test('case 3: a dropped connection repeats the tick (one purchase) and the Undo (then already)', async () => {
    await seedItem('t-dropped');
    const op = opId();
    const first = await tick(tablet, member.uid, op, 't-dropped');
    const repeat = await tick(tablet, member.uid, op, 't-dropped', {}, later(1000));
    assert.deepEqual(repeat.result, first.result);
    assert.equal((await read('t-dropped'))!.purchasedAt.toMillis(), at.getTime(), 'the replay wrote nothing');
    assert.equal((await undoShoppingTickFromTablet(request(tablet, member.uid, op), opts(later(2000)))).status, 'undone');
    assert.equal((await undoShoppingTickFromTablet(request(tablet, member.uid, op), opts(later(3000)))).status, 'already');
    assert.equal((await read('t-dropped'))!.status, 'needed');
  });

  test('case 4: tick, Undo, then a late retry of the tick is already undone', async () => {
    await seedItem('t-late');
    const op = opId();
    await tick(tablet, member.uid, op, 't-late');
    await undoShoppingTickFromTablet(request(tablet, member.uid, op), opts(later(1000)));
    await refused(tick(tablet, member.uid, op, 't-late', {}, later(2000)), 'already_undone');
    assert.equal((await read('t-late'))!.status, 'needed');
  });

  test('case 5: the Undo arrives first (a tombstone), then the tick is refused', async () => {
    await seedItem('t-first');
    const op = opId();
    assert.equal((await undoShoppingTickFromTablet(request(tablet, member.uid, op), opts())).status, 'not_applied');
    await refused(tick(tablet, member.uid, op, 't-first', {}, later(1000)), 'already_undone');
    assert.equal((await read('t-first'))!.status, 'needed');
  });

  test('case 6: a queued tick in flight and its Undo at once, both orders, leave it needed', async () => {
    for (const order of ['action-first', 'undo-first'] as const) {
      const id = `t-race-${order}`;
      await seedItem(id);
      const op = opId();
      const action = tick(tablet, member.uid, op, id, queued(tablet, 30_000)).catch(error => error);
      const undo = undoShoppingTickFromTablet(request(tablet, member.uid, op, queued(tablet, 25_000)), opts()).catch(error => error);
      await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
      assert.equal((await read(id))!.status, 'needed', order);
      await refused(tick(tablet, member.uid, op, id, {}, later(1000)), 'already_undone');
    }
  });

  test('case 7: another tablet, another person, an older generation, or after the window cannot Undo it', async () => {
    await seedItem('t-principal');
    const op = opId();
    await tick(tablet, member.uid, op, 't-principal');
    assert.equal((await undoShoppingTickFromTablet(request(other, member.uid, op), opts(later(1000)))).status, 'not_applied');
    await refused(undoShoppingTickFromTablet(request(tablet, owner.uid, op), opts(later(1000))), 'forbidden');
    await refused(undoShoppingTickFromTablet(request(tablet, member.uid, op), opts(later(16_000))), 'undo_expired');
    assert.equal((await read('t-principal'))!.status, 'purchased');

    const spare = await pairTablet(H, owner, created, 'Pantry tablet');
    await seedItem('t-generation');
    const spareOp = opId();
    await tick(spare, member.uid, spareOp, 't-generation');
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    const fresh = { ...spare, idToken: (await signIn(repaired.customToken)).idToken };
    await refused(undoShoppingTickFromTablet(request(fresh, member.uid, spareOp), opts(later(1000))), 'not_undoable');
    assert.equal((await read('t-generation'))!.status, 'purchased');
  });
});

describe('who may, and where', () => {
  test('shopping.edit decides, as on a phone: a child, a kid profile and a member without it are refused; a guest is never an actor', async () => {
    await seedItem('w-perm');
    for (const uid of [child.uid, KID, noEdit.uid]) {
      await refused(tick(tablet, uid, opId(), 'w-perm'), 'forbidden');
      await refused(add(tablet, uid, opId(), ['Perm']), 'forbidden');
    }
    await refused(tick(tablet, guest.uid, opId(), 'w-perm'), 'actor_guest');
    await refused(tick(tablet, 'not-a-member', opId(), 'w-perm'), 'actor_not_member');
    await refused(tick(tablet, '', opId(), 'w-perm'), 'actor_required');
    assert.equal((await read('w-perm'))!.status, 'needed');
    assert.equal((await itemsNamed('Perm')).length, 0);
  });

  test('the points PIN never applies to shopping (WT-22d)', async () => {
    await house(H).update({ devicePolicy: { pointsPin: 'everyone' } });
    await seedItem('w-points');
    assert.equal((await tick(tablet, member.uid, opId(), 'w-points')).level, 'face');
    assert.equal((await add(tablet, member.uid, opId(), ['Points'])).level, 'face');
  });

  test('WT-11c: a tablet with Shopping switched off is refused (section_off); a removed tablet (device_revoked)', async () => {
    await seedItem('w-section');
    const off = await pairTablet(H, owner, created, 'Garage tablet');
    await updateDeviceSettings(owner, { householdId: H, deviceId: off.deviceId, patch: { sections: { shopping: false } } });
    await refused(tick(off, member.uid, opId(), 'w-section'), 'section_off');
    await refused(add(off, member.uid, opId(), ['Section']), 'section_off');
    await refused(undoShoppingTickFromTablet(request(off, member.uid, opId()), opts()), 'section_off');
    const gone = await pairTablet(H, owner, created, 'Shed tablet');
    await removeDevice(owner, { householdId: H, deviceId: gone.deviceId });
    await refused(tick(gone, member.uid, opId(), 'w-section'), 'device_revoked');
    assert.equal((await read('w-section'))!.status, 'needed');
    assert.equal((await itemsNamed('Section')).length, 0);
  });

  test('answers carry no email, replays included; a personal token is not a tablet', async () => {
    await house(H).collection('members').doc('ds-emailname').set({ uid: 'ds-emailname', role: 'member', status: 'active', displayName: 'someone@example.test', permissions: {} });
    await seedItem('w-email', { status: 'purchased', purchasedByUid: 'ds-emailname', purchaseOpId: 'x', purchasedAt: Timestamp.fromDate(at) });
    const op = opId();
    const first = await tick(tablet, member.uid, op, 'w-email');
    const replay = await tick(tablet, member.uid, op, 'w-email', {}, later(1000));
    for (const answer of [first, replay]) {
      assert.equal(answer.result.status, 'already');
      assert.equal(JSON.stringify(answer).includes('@'), false, JSON.stringify(answer));
    }
    const answer = await tickShoppingItemFromTabletAction({ idToken: memberToken, householdId: H, actorUid: member.uid, opId: opId(), listId: LIST, itemId: 'w-email' });
    assert.equal(answer.ok ? 'ok' : answer.code, 'not_a_device');
  });

  test('a queued replay older than 24 hours is refused (stale_intent)', async () => {
    await seedItem('w-stale');
    await refused(tick(tablet, member.uid, opId(), 'w-stale', queued(tablet, 25 * 60 * 60_000)), 'stale_intent');
    assert.equal((await read('w-stale'))!.status, 'needed');
  });
});
