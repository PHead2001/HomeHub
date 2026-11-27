import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { DeviceActionError } from '../../src/lib/server/device-gate';
import {
  restockPantryItemFromTablet,
  takePantryItemFromTablet,
  undoPantryRestockFromTablet,
  undoPantryTakeFromTablet,
  type DevicePantryRequest,
} from '../../src/lib/server/device-pantry';
import { createDeviceRepairCode, redeemDeviceCode, removeDevice, updateDeviceSettings } from '../../src/lib/server/device-management';
import { UNDO_PROVEN } from '../../src/lib/devices/action-policy';
import { takePantryItemFromTabletAction } from '../../src/app/shopping/device-actions';
import { deleteDeviceUsers, nonce, personToken, seedHousehold, signIn, type Person } from './device-test-helpers';
import { clock, house, opId, pairTablet, seedKid, tokenGeneration, type Tablet } from './device-actor-helpers';

// The Undo proof for the pantry on wall tablets (design 10.4; tracker WT-20f; audit BL-20,
// BL-21, 17.3, D-8), with real ID tokens: for pantry.useUp (one package out) and
// pantry.restock (one package added, and a batch created): (1) a personal client or another
// tablet changes the same batch in between, so the Undo leaves it alone (`changed_since`),
// (2) a reload Undoes by the journal's opId inside the window and is refused after it, (3) a
// dropped connection repeats the action (one change) and the Undo (then already), (4) action,
// Undo, late retry, (5) Undo before the action, (6) a queued send in flight and its Undo at
// once, both orders, (7) the wrong principal (another tablet, person, generation, after the
// window). Plus: ONE package used (never 1 g of a measured amount), the soonest expiry first,
// a product found by barcode in either form, then by name; "Add to list?" asked only at zero
// (nothing added); the shopping.edit permission; Shopping switched off (section_off); no
// points PIN; an opId reused for another product; older batches left to a phone; no emails.

const H = 'dev-pantry-house';
const owner: Person = { uid: 'dp-owner', email: 'dp.owner@example.test', displayName: 'Olive Stone', role: 'owner' };
const member: Person = { uid: 'dp-member', email: 'dp.member@example.test', displayName: 'Max', role: 'member' };
const child: Person = { uid: 'dp-child', email: 'dp.child@example.test', displayName: 'Cleo', role: 'child' };
const noEdit: Person = { uid: 'dp-noedit', email: 'dp.noedit@example.test', displayName: 'Nell', role: 'member', permissions: { 'shopping.edit': false } };
const KID = 'kid_DevPantryKid00000000';
// A UPC-A with a valid check digit; the pantry stores its 13-digit form.
const UPC = '036000291452';
const EAN = '0036000291452';
const created = new Set<string>();
const time = clock(Date.parse('2026-11-21T15:00:00Z'));
let tablet: Tablet;
let other: Tablet;
let memberToken: string;

const pantry = () => house(H).collection('pantry-inventory');
const batch = (id: string) => pantry().doc(id);
const packagesOf = async (id: string) => (await batch(id).get()).get('packages') as number | undefined;
const named = async (name: string) => (await pantry().where('name', '==', name).get()).docs;

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeviceActionError, `expected DeviceActionError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const request = (t: Tablet, actorUid: string, op: string, extra: Partial<DevicePantryRequest> = {}): DevicePantryRequest => ({
  idToken: t.idToken, householdId: H, actorUid, opId: op, ...extra,
});

let at: Date;
const later = (ms: number) => new Date(at.getTime() + ms);
const opts = (when: Date = at) => ({ clock: () => when });
const queued = (t: Tablet, agoMs: number) => ({ queued: { createdAt: later(-agoMs).toISOString(), generation: tokenGeneration(t.idToken) } });

type Scan = { barcode?: string; name?: string };
const takeOne = (t: Tablet, actorUid: string, op: string, scan: Scan = {}, extra: Partial<DevicePantryRequest> = {}, when: Date = at) =>
  takePantryItemFromTablet({ ...request(t, actorUid, op, extra), barcode: scan.barcode ?? UPC, name: scan.name ?? 'Beans' }, opts(when));
const restock = (t: Tablet, actorUid: string, op: string, scan: Scan = {}, extra: Partial<DevicePantryRequest> = {}, when: Date = at) =>
  restockPantryItemFromTablet({ ...request(t, actorUid, op, extra), barcode: scan.barcode ?? UPC, name: scan.name ?? 'Beans' }, opts(when));
const undoTake = (t: Tablet, actorUid: string, op: string, extra: Partial<DevicePantryRequest> = {}, when: Date = later(2000)) =>
  undoPantryTakeFromTablet(request(t, actorUid, op, extra), opts(when));
const undoRestock = (t: Tablet, actorUid: string, op: string, extra: Partial<DevicePantryRequest> = {}, when: Date = later(2000)) =>
  undoPantryRestockFromTablet(request(t, actorUid, op, extra), opts(when));

/** A Pantry v2 batch, as the personal page writes it. */
const seedBatch = (id: string, fields: Record<string, unknown> = {}) => {
  const name = (fields.name as string | undefined) ?? 'Beans';
  return batch(id).set({
    name, nameKey: name.toLowerCase(), location: 'Pantry', unit: 'items', packages: 3, packageSize: null, expiryDate: null, quantity: 3,
    schemaVersion: 2, barcode: EAN, addedByUid: owner.uid, ...fields,
  });
};

/** A phone's "One more" on the same batch (an increment, as the personal page writes it). */
const phoneAddsOne = async (id: string) => {
  const current = (await packagesOf(id)) ?? 0;
  await batch(id).update({ packages: current + 1, quantity: current + 1, updatedByUid: owner.uid });
};

before(async () => {
  await seedHousehold(H, [owner, member, child, noEdit], { timeZone: 'America/Chicago' });
  await seedKid(H, KID, 'Mia');
  tablet = await pairTablet(H, owner, created, 'Kitchen tablet');
  other = await pairTablet(H, owner, created, 'Hall tablet');
  memberToken = await personToken(member);
});

beforeEach(async () => {
  at = time.advance(61_000);
  await house(H).update({ devicePolicy: { pointsPin: 'off' } });
  await adminDb.recursiveDelete(pantry());
});

after(async () => {
  await deleteDeviceUsers([...created]);
  await adminDb.recursiveDelete(house(H));
  const codes = await adminDb.collection('deviceCodes').where('householdId', '==', H).get();
  await Promise.all(codes.docs.map(d => d.ref.delete()));
});

describe('the pantry on tablets is face-level with its Undo proven', () => {
  test('UNDO_PROVEN holds the four pantry capabilities proven in this file', () => {
    for (const capability of ['pantry.useUp', 'pantry.useUp.undo', 'pantry.restock', 'pantry.restock.undo'] as const) {
      assert.ok(UNDO_PROVEN.has(capability), capability);
    }
  });
});

describe('pantry.useUp', () => {
  test('one package from the soonest-expiring batch, found by either barcode form, for the selected person', async () => {
    await seedBatch('beans-later', { packages: 2, quantity: 2, expiryDate: '2027-02-01' });
    await seedBatch('beans-soon', { packages: 1, quantity: 1, expiryDate: '2026-12-01' });
    const answer = await takeOne(tablet, member.uid, opId());
    assert.equal(answer.level, 'face');
    assert.deepEqual(answer.result, { status: 'used', itemId: 'beans-soon', name: 'Beans', before: 1, after: 0, remaining: 2, askAddToList: false });
    const soon = (await batch('beans-soon').get()).data()!;
    assert.equal(soon.packages, 0);
    assert.equal(soon.quantity, 0);
    assert.equal(soon.updatedByUid, member.uid);
    assert.equal(soon.deviceAttribution, undefined, 'pantry documents carry no device fields');
    assert.equal(await packagesOf('beans-later'), 2);
  });

  test('a measured batch loses one package, never 1 g; the last package asks "Add to list?" and adds nothing', async () => {
    await seedBatch('flour', { name: 'Flour', unit: 'g', packageSize: 1000, packages: 1, quantity: 1000 });
    const { result } = await takeOne(tablet, member.uid, opId(), { name: 'Flour' });
    assert.ok(result.status === 'used');
    assert.equal(result.askAddToList, true);
    const flour = (await batch('flour').get()).data()!;
    assert.equal(flour.packages, 0);
    assert.equal(flour.packageSize, 1000);
    assert.equal(flour.quantity, 1000, 'a measured batch keeps its size as quantity');
    assert.equal((await house(H).collection('shopping-lists').get()).size, 0, 'nothing is put on a list');
  });

  test('found by name when no batch stores the barcode; not stocked is a no-op whose Undo answers already', async () => {
    await seedBatch('rice', { name: 'Rice', barcode: null });
    const byName = await takeOne(tablet, member.uid, opId(), { barcode: '4006381333931', name: ' rice ' });
    assert.equal(byName.result.status, 'used');
    assert.equal(await packagesOf('rice'), 2);
    const op = opId();
    assert.deepEqual((await takeOne(tablet, member.uid, op, { barcode: '4006381333931', name: 'Pasta' })).result, { status: 'not_stocked', name: 'Pasta' });
    assert.equal((await undoTake(tablet, member.uid, op)).status, 'already');
  });

  test('an older batch is left to a phone; an opId sent again for another product is a conflict; bad input is invalid', async () => {
    await batch('legacy').set({ name: 'Beans', location: 'Pantry', unit: 'items', quantity: 4, barcode: EAN });
    assert.equal((await takeOne(tablet, member.uid, opId())).result.status, 'needs_phone');
    assert.equal((await batch('legacy').get()).get('quantity'), 4);
    await seedBatch('beans');
    const op = opId();
    await takeOne(tablet, member.uid, op, { barcode: '4006381333931', name: 'Beans' });
    await refused(takeOne(tablet, member.uid, op, { barcode: '96385074', name: 'Beans' }, {}, later(1000)), 'conflict');
    await refused(takeOne(tablet, member.uid, opId(), { barcode: '12ab' }), 'invalid_input');
    await refused(takeOne(tablet, member.uid, opId(), { name: '   ' }), 'invalid_input');
  });

  test('case 1: a personal client or another tablet changed the batch in between, so the Undo leaves it alone', async () => {
    await seedBatch('beans', { packages: 5, quantity: 5 });
    const op = opId();
    await takeOne(tablet, member.uid, op);
    await phoneAddsOne('beans');
    await refused(undoTake(tablet, member.uid, op), 'changed_since');
    assert.equal(await packagesOf('beans'), 5);

    const first = opId();
    await takeOne(tablet, member.uid, first, {}, {}, later(3000));
    await takeOne(other, owner.uid, opId(), {}, {}, later(4000));
    assert.equal(await packagesOf('beans'), 3);
    await refused(undoTake(tablet, member.uid, first, {}, later(5000)), 'changed_since');
    assert.equal(await packagesOf('beans'), 3, 'the other tablet\'s use stays');
  });

  test('case 2: after a reload the journal opId Undoes inside the window and is refused after it', async () => {
    await seedBatch('beans');
    const inside = opId();
    await takeOne(tablet, member.uid, inside);
    assert.equal((await undoTake(tablet, member.uid, inside, {}, later(9000))).status, 'undone');
    assert.equal(await packagesOf('beans'), 3);
    const outside = opId();
    await takeOne(tablet, member.uid, outside, {}, {}, later(10_000));
    await refused(undoTake(tablet, member.uid, outside, {}, later(10_000 + 15_001)), 'undo_expired');
    assert.equal(await packagesOf('beans'), 2);
  });

  test('case 3: a dropped connection repeats the use (one package) and the Undo (then already)', async () => {
    await seedBatch('beans');
    const op = opId();
    const first = await takeOne(tablet, member.uid, op);
    const repeat = await takeOne(tablet, member.uid, op, {}, {}, later(1000));
    assert.deepEqual(repeat.result, first.result);
    assert.equal(await packagesOf('beans'), 2);
    assert.equal((await undoTake(tablet, member.uid, op)).status, 'undone');
    assert.equal((await undoTake(tablet, member.uid, op, {}, later(3000))).status, 'already');
    assert.equal(await packagesOf('beans'), 3);
  });

  test('case 4: use, Undo, then a late retry of the use is already undone', async () => {
    await seedBatch('beans');
    const op = opId();
    await takeOne(tablet, member.uid, op);
    await undoTake(tablet, member.uid, op, {}, later(1000));
    await refused(takeOne(tablet, member.uid, op, {}, {}, later(2000)), 'already_undone');
    assert.equal(await packagesOf('beans'), 3);
  });

  test('case 5: the Undo arrives first (a tombstone), then the use is refused', async () => {
    await seedBatch('beans');
    const op = opId();
    assert.equal((await undoTake(tablet, member.uid, op, {}, at)).status, 'not_applied');
    await refused(takeOne(tablet, member.uid, op, {}, {}, later(1000)), 'already_undone');
    assert.equal(await packagesOf('beans'), 3);
  });

  test('case 6: a queued use in flight and its Undo at once, both orders, leave the stock as it was', async () => {
    await seedBatch('beans');
    for (const order of ['action-first', 'undo-first'] as const) {
      const op = opId();
      const action = takeOne(tablet, member.uid, op, {}, queued(tablet, 30_000)).catch(error => error);
      const undo = undoTake(tablet, member.uid, op, queued(tablet, 25_000), at).catch(error => error);
      await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
      assert.equal(await packagesOf('beans'), 3, order);
      await refused(takeOne(tablet, member.uid, op, {}, {}, later(1000)), 'already_undone');
    }
  });

  test('case 7: another tablet, another person, an older generation, or after the window cannot Undo it', async () => {
    await seedBatch('beans', { packages: 9, quantity: 9 });
    const op = opId();
    await takeOne(tablet, member.uid, op);
    assert.equal((await undoTake(other, member.uid, op, {}, later(1000))).status, 'not_applied');
    await refused(undoTake(tablet, owner.uid, op, {}, later(1000)), 'forbidden');
    await refused(undoTake(tablet, member.uid, op, {}, later(16_000)), 'undo_expired');
    assert.equal(await packagesOf('beans'), 8);

    const spare = await pairTablet(H, owner, created, 'Spare tablet');
    const spareOp = opId();
    await takeOne(spare, member.uid, spareOp);
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    const fresh = { ...spare, idToken: (await signIn(repaired.customToken)).idToken };
    await refused(undoTake(fresh, member.uid, spareOp, {}, later(1000)), 'not_undoable');
    assert.equal(await packagesOf('beans'), 7);
  });

  test('R1: a queued Undo of a queued use is accepted late (bounded); a live use is not', async () => {
    await seedBatch('beans');
    const queuedOp = opId();
    await takeOne(tablet, member.uid, queuedOp, {}, queued(tablet, 60_000));
    assert.equal((await undoTake(tablet, member.uid, queuedOp, queued(tablet, 55_000), later(5 * 60_000))).status, 'undone');
    assert.equal(await packagesOf('beans'), 3);
    const liveOp = opId();
    await takeOne(tablet, member.uid, liveOp, {}, {}, later(1000));
    await refused(undoTake(tablet, member.uid, liveOp, { queued: { createdAt: later(1000).toISOString(), generation: tokenGeneration(tablet.idToken) } }, later(61_000)), 'undo_expired');
    assert.equal(await packagesOf('beans'), 2);
  });
});

describe('pantry.restock', () => {
  test('one more package of the soonest batch; its Undo takes it off', async () => {
    await seedBatch('beans', { packages: 2, quantity: 2 });
    const op = opId();
    const { result, level } = await restock(tablet, member.uid, op);
    assert.equal(level, 'face');
    assert.deepEqual(result, { status: 'restocked', itemId: 'beans', name: 'Beans', created: false, before: 2, after: 3 });
    assert.equal((await batch('beans').get()).get('updatedByUid'), member.uid);
    assert.equal((await undoRestock(tablet, member.uid, op)).status, 'undone');
    assert.equal(await packagesOf('beans'), 2);
  });

  test('nothing stocked: a new one-item batch on the Pantry shelf with the barcode and the person; its Undo deletes it', async () => {
    const op = opId();
    const { result } = await restock(tablet, member.uid, op, { name: 'Oat drink' });
    assert.ok(result.status === 'restocked' && result.created);
    const [doc] = await named('Oat drink');
    assert.deepEqual(
      { packages: doc.get('packages'), location: doc.get('location'), unit: doc.get('unit'), barcode: doc.get('barcode'), addedByUid: doc.get('addedByUid') },
      { packages: 1, location: 'Pantry', unit: 'items', barcode: EAN, addedByUid: member.uid },
    );
    assert.equal((await undoRestock(tablet, member.uid, op)).status, 'undone');
    assert.equal((await named('Oat drink')).length, 0);
  });

  test('case 1: a created batch edited by a phone, or an added package followed by another tablet\'s, is left alone', async () => {
    const createOp = opId();
    const { result } = await restock(tablet, member.uid, createOp, { name: 'Tea', barcode: '96385074' });
    assert.ok(result.status === 'restocked');
    await phoneAddsOne(result.itemId);
    await refused(undoRestock(tablet, member.uid, createOp), 'changed_since');
    assert.equal(await packagesOf(result.itemId), 2);

    await seedBatch('beans');
    const first = opId();
    await restock(tablet, member.uid, first, {}, {}, later(3000));
    await restock(other, owner.uid, opId(), {}, {}, later(4000));
    await refused(undoRestock(tablet, member.uid, first, {}, later(5000)), 'changed_since');
    assert.equal(await packagesOf('beans'), 5);
  });

  test('case 2: after a reload the journal opId Undoes inside the window and is refused after it', async () => {
    await seedBatch('beans');
    const inside = opId();
    await restock(tablet, member.uid, inside);
    assert.equal((await undoRestock(tablet, member.uid, inside, {}, later(9000))).status, 'undone');
    const outside = opId();
    await restock(tablet, member.uid, outside, {}, {}, later(10_000));
    await refused(undoRestock(tablet, member.uid, outside, {}, later(10_000 + 15_001)), 'undo_expired');
    assert.equal(await packagesOf('beans'), 4);
  });

  test('case 3: a dropped connection repeats the restock (one batch) and the Undo (then already)', async () => {
    const op = opId();
    const first = await restock(tablet, member.uid, op, { name: 'Dropped tin' });
    const repeat = await restock(tablet, member.uid, op, { name: 'Dropped tin' }, {}, later(1000));
    assert.deepEqual(repeat.result, first.result);
    assert.equal((await named('Dropped tin')).length, 1);
    assert.equal((await undoRestock(tablet, member.uid, op)).status, 'undone');
    assert.equal((await undoRestock(tablet, member.uid, op, {}, later(3000))).status, 'already');
    assert.equal((await named('Dropped tin')).length, 0);
  });

  test('case 4: restock, Undo, then a late retry is already undone', async () => {
    const op = opId();
    await restock(tablet, member.uid, op, { name: 'Late tin' });
    await undoRestock(tablet, member.uid, op, {}, later(1000));
    await refused(restock(tablet, member.uid, op, { name: 'Late tin' }, {}, later(2000)), 'already_undone');
    assert.equal((await named('Late tin')).length, 0);
  });

  test('case 5: the Undo arrives first (a tombstone), then the restock is refused', async () => {
    const op = opId();
    assert.equal((await undoRestock(tablet, member.uid, op, {}, at)).status, 'not_applied');
    await refused(restock(tablet, member.uid, op, { name: 'First tin' }, {}, later(1000)), 'already_undone');
    assert.equal((await named('First tin')).length, 0);
  });

  test('case 6: a queued restock in flight and its Undo at once, both orders, leave nothing added', async () => {
    for (const order of ['action-first', 'undo-first'] as const) {
      const name = `Race ${order}`;
      const op = opId();
      const action = restock(tablet, member.uid, op, { name, barcode: order === 'action-first' ? '96385074' : '4006381333931' }, queued(tablet, 30_000)).catch(error => error);
      const undo = undoRestock(tablet, member.uid, op, queued(tablet, 25_000), at).catch(error => error);
      await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
      assert.equal((await named(name)).length, 0, order);
    }
  });

  test('case 7: another tablet, another person, an older generation, or after the window cannot Undo it', async () => {
    const op = opId();
    await restock(tablet, member.uid, op, { name: 'Principal tin' });
    assert.equal((await undoRestock(other, member.uid, op, {}, later(1000))).status, 'not_applied');
    await refused(undoRestock(tablet, owner.uid, op, {}, later(1000)), 'forbidden');
    await refused(undoRestock(tablet, member.uid, op, {}, later(16_000)), 'undo_expired');
    assert.equal((await named('Principal tin')).length, 1);

    const spare = await pairTablet(H, owner, created, 'Spare restock tablet');
    const spareOp = opId();
    await restock(spare, member.uid, spareOp, { name: 'Generation tin', barcode: '96385074' });
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    const fresh = { ...spare, idToken: (await signIn(repaired.customToken)).idToken };
    await refused(undoRestock(fresh, member.uid, spareOp, {}, later(1000)), 'not_undoable');
    assert.equal((await named('Generation tin')).length, 1);
  });
});

describe('who may, and where', () => {
  test('shopping.edit decides, as on a phone: a child, a kid profile and a member without it are refused', async () => {
    await seedBatch('beans');
    for (const uid of [child.uid, KID, noEdit.uid]) {
      await refused(takeOne(tablet, uid, opId()), 'forbidden');
      await refused(restock(tablet, uid, opId()), 'forbidden');
    }
    await refused(takeOne(tablet, 'not-a-member', opId()), 'actor_not_member');
    await refused(takeOne(tablet, '', opId()), 'actor_required');
    assert.equal(await packagesOf('beans'), 3);
  });

  test('the points PIN never applies to the pantry', async () => {
    await house(H).update({ devicePolicy: { pointsPin: 'everyone' } });
    await seedBatch('beans');
    assert.equal((await takeOne(tablet, member.uid, opId())).level, 'face');
    assert.equal((await restock(tablet, member.uid, opId())).level, 'face');
  });

  test('a tablet with Shopping switched off is refused (section_off); a removed tablet (device_revoked)', async () => {
    await seedBatch('beans');
    const off = await pairTablet(H, owner, created, 'Garage pantry tablet');
    await updateDeviceSettings(owner, { householdId: H, deviceId: off.deviceId, patch: { sections: { shopping: false } } });
    await refused(takeOne(off, member.uid, opId()), 'section_off');
    await refused(restock(off, member.uid, opId()), 'section_off');
    await refused(undoTake(off, member.uid, opId(), {}, at), 'section_off');
    const gone = await pairTablet(H, owner, created, 'Shed pantry tablet');
    await removeDevice(owner, { householdId: H, deviceId: gone.deviceId });
    await refused(takeOne(gone, member.uid, opId()), 'device_revoked');
    assert.equal(await packagesOf('beans'), 3);
  });

  test('answers carry no email; a personal token is not a tablet; a queued replay older than 24 hours is stale', async () => {
    await seedBatch('beans', { name: 'someone@example.test' });
    const answer = await takeOne(tablet, member.uid, opId(), { name: 'someone@example.test' });
    assert.equal(JSON.stringify(answer).includes('@'), false, JSON.stringify(answer));
    const personal = await takePantryItemFromTabletAction({ idToken: memberToken, householdId: H, actorUid: member.uid, opId: opId(), barcode: UPC, name: 'Beans' });
    assert.equal(personal.ok ? 'ok' : personal.code, 'not_a_device');
    await refused(takeOne(tablet, member.uid, opId(), {}, queued(tablet, 25 * 60 * 60_000)), 'stale_intent');
  });
});
