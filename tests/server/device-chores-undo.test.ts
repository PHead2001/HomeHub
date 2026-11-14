import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { DeviceActionError } from '../../src/lib/server/device-gate';
import {
  completeChoreFromTablet,
  takeChoreFromTablet,
  undoChoreCompletionFromTablet,
  undoTakeChoreFromTablet,
  type DeviceChoreRequest,
} from '../../src/lib/server/device-chores';
import { completeChoresAs, reopenChoreAs } from '../../src/lib/server/chore-completion';
import { createDeviceRepairCode, redeemDeviceCode } from '../../src/lib/server/device-management';
import { setMyPin, verifyDevicePin } from '../../src/lib/server/pins';
import { UNDO_PROVEN } from '../../src/lib/devices/action-policy';
import { completeChoreFromTabletAction } from '../../src/app/chores/device-actions';
import { deleteDeviceUsers, nonce, personToken, seedHousehold, signIn, type Person } from './device-test-helpers';
import { clock, house, opId, pairTablet, seedKid, tokenGeneration, type Tablet } from './device-actor-helpers';

// The Undo proof for chores on wall tablets (design 10.4; tracker WT-20f): for
// `chores.complete` and `chores.take`, with real ID tokens: (1) another device or a
// personal client edits in between, (2) a reload Undoes by the journal's opId inside and
// outside the window, (3) a dropped connection repeats the action and the Undo, (4)
// action, Undo, late retry, (5) Undo before the action, (6) a queued send in flight with
// its Undo concurrently, both orders, (7) the wrong principal. Plus points to the selected
// person (CH-12b), the points-PIN policy, R1 (late queued Undo) and R3 (no-op take).

const H = 'dev-chores-house';
const owner: Person = { uid: 'dc-owner', email: 'dc.owner@example.test', displayName: 'Olive', role: 'owner' };
const member: Person = { uid: 'dc-member', email: 'dc.member@example.test', displayName: 'Max', role: 'member' };
const child: Person = { uid: 'dc-child', email: 'dc.child@example.test', displayName: 'Cleo', role: 'child' };
const KID = 'kid_DevChoresKid00000000';
const created = new Set<string>();
const time = clock(Date.parse('2026-11-14T15:00:00Z'));
let tablet: Tablet;
let other: Tablet;

const chore = (id: string) => house(H).collection('chores').doc(id);
const read = async (id: string) => (await chore(id).get()).data()!;

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeviceActionError, `expected DeviceActionError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const request = (t: Tablet, actorUid: string, op: string, extra: Partial<DeviceChoreRequest> = {}): DeviceChoreRequest => ({
  idToken: t.idToken, householdId: H, actorUid, opId: op, ...extra,
});

/** A fresh minute for each test keeps every call inside the per-tablet rate windows. */
let at: Date;
const later = (ms: number) => new Date(at.getTime() + ms);

const seedChore = (id: string, fields: Record<string, unknown> = {}) => chore(id).set({
  task: `Task ${id}`, dueDate: '2026-11-14T06:00:00.000Z', isCompleted: false, subTasks: [], completedSubTasks: [], roomIds: [],
  assignedToUid: '', assignedToDisplayName: 'Unassigned', ...fields,
});

before(async () => {
  await seedHousehold(H, [owner, member, child], { timeZone: 'America/Chicago' });
  await seedKid(H, KID, 'Mia');
  tablet = await pairTablet(H, owner, created, 'Kitchen tablet');
  other = await pairTablet(H, owner, created, 'Hall tablet');
});

beforeEach(async () => {
  at = time.advance(61_000);
  await house(H).update({ devicePolicy: { pointsPin: 'off' } });
});

after(async () => {
  await deleteDeviceUsers([...created]);
  await adminDb.recursiveDelete(house(H));
  const codes = await adminDb.collection('deviceCodes').where('householdId', '==', H).get();
  await Promise.all(codes.docs.map(d => d.ref.delete()));
});

describe('chores on tablets are face-level with their Undo proven', () => {
  test('UNDO_PROVEN holds the four chore capabilities proven in this file', () => {
    for (const capability of ['chores.complete', 'chores.complete.undo', 'chores.take', 'chores.take.undo'] as const) {
      assert.ok(UNDO_PROVEN.has(capability), capability);
    }
  });
});

describe('chores.complete', () => {
  test('points go to the selected person (CH-12b); the completion carries the tablet attribution and completionId == opId', async () => {
    await seedChore('c-credit');
    const op = opId();
    const { outcome, level } = await completeChoreFromTablet({ ...request(tablet, KID, op), choreId: 'c-credit' }, { now: at });
    assert.equal(outcome.status, 'completed');
    assert.equal(level, 'face');
    const stored = await read('c-credit');
    assert.equal(stored.completedByUid, KID);
    assert.equal(stored.completedByName, 'Mia');
    assert.equal(stored.completionId, op);
    assert.deepEqual(stored.deviceAttribution, { deviceId: tablet.deviceId, deviceName: 'Kitchen tablet', generation: 1, actorUid: KID, level: 'face' });
    const ledger = (await house(H).collection('devices').doc(tablet.deviceId).collection('ops').doc(op).get()).data()!;
    assert.equal(ledger.state, 'applied');
    assert.equal(ledger.actorUid, KID);
  });

  test('case 1: a personal client or another tablet changed it in between, so the Undo leaves it alone', async () => {
    await seedChore('c-personal');
    const op = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-personal' }, { now: at });
    // A personal reopen and a new completion: a new completionId.
    await reopenChoreAs(adminDb, H, { choreId: 'c-personal' });
    await completeChoresAs(adminDb, owner, H, { choreIds: ['c-personal'] }, at);
    await refused(undoChoreCompletionFromTablet(request(tablet, member.uid, op), { now: later(2000) }), 'changed_since');
    assert.equal((await read('c-personal')).completedByUid, owner.uid);

    await seedChore('c-other-tablet');
    const first = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, first), choreId: 'c-other-tablet' }, { now: at });
    await reopenChoreAs(adminDb, H, { choreId: 'c-other-tablet' });
    const second = opId();
    await completeChoreFromTablet({ ...request(other, child.uid, second), choreId: 'c-other-tablet' }, { now: at });
    await refused(undoChoreCompletionFromTablet(request(tablet, member.uid, first), { now: later(2000) }), 'changed_since');
    const stored = await read('c-other-tablet');
    assert.equal(stored.completedByUid, child.uid);
    assert.equal(stored.completionId, second);
  });

  test('case 2: after a reload the journal opId Undoes inside the window and is refused after it', async () => {
    await seedChore('c-reload-in');
    const inside = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, inside), choreId: 'c-reload-in' }, { now: at });
    // A new call (as after a reload) with the same device credential and the journal's opId.
    const undone = await undoChoreCompletionFromTablet(request(tablet, member.uid, inside), { now: later(9000) });
    assert.equal(undone.status, 'undone');
    assert.equal((await read('c-reload-in')).isCompleted, false);
    assert.equal((await read('c-reload-in')).deviceAttribution, undefined);

    await seedChore('c-reload-out');
    const outside = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, outside), choreId: 'c-reload-out' }, { now: at });
    await refused(undoChoreCompletionFromTablet(request(tablet, member.uid, outside), { now: later(15_001) }), 'undo_expired');
    assert.equal((await read('c-reload-out')).isCompleted, true);
  });

  test('case 3: a dropped connection repeats the action (one completion) and the Undo (then already)', async () => {
    await seedChore('c-dropped', { subTasks: ['Rinse', 'Dry'], completedSubTasks: ['Rinse'] });
    const op = opId();
    const first = await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-dropped' }, { now: at });
    const repeat = await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-dropped' }, { now: later(1000) });
    assert.deepEqual(repeat.outcome, first.outcome);
    assert.equal((await read('c-dropped')).completionId, op);
    assert.deepEqual((await read('c-dropped')).completedSubTasks, ['Rinse', 'Dry']);
    assert.equal((await undoChoreCompletionFromTablet(request(tablet, member.uid, op), { now: later(2000) })).status, 'undone');
    // The steps it ticked go back from the ledger's stored outcome.
    assert.deepEqual((await read('c-dropped')).completedSubTasks, ['Rinse']);
    assert.equal((await undoChoreCompletionFromTablet(request(tablet, member.uid, op), { now: later(3000) })).status, 'already');
    assert.equal((await read('c-dropped')).isCompleted, false);
  });

  test('case 4: action, Undo, then a late retry of the action is already undone', async () => {
    await seedChore('c-late');
    const op = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-late' }, { now: at });
    await undoChoreCompletionFromTablet(request(tablet, member.uid, op), { now: later(1000) });
    await refused(completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-late' }, { now: later(2000) }), 'already_undone');
    assert.equal((await read('c-late')).isCompleted, false);
  });

  test('case 5: the Undo arrives first (a tombstone), then the action is refused', async () => {
    await seedChore('c-first');
    const op = opId();
    assert.equal((await undoChoreCompletionFromTablet(request(tablet, member.uid, op), { now: at })).status, 'not_applied');
    await refused(completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-first' }, { now: later(1000) }), 'already_undone');
    assert.equal((await read('c-first')).isCompleted, false);
  });

  test('case 6: a queued send in flight and its Undo at once, both orders, leave nothing done', async () => {
    for (const order of ['action-first', 'undo-first'] as const) {
      const id = `c-race-${order}`;
      await seedChore(id);
      const op = opId();
      const queued = { createdAt: later(-30_000).toISOString(), generation: tokenGeneration(tablet.idToken) };
      const action = completeChoreFromTablet({ ...request(tablet, member.uid, op, { queued }), choreId: id }, { now: at }).catch(error => error);
      const undo = undoChoreCompletionFromTablet(request(tablet, member.uid, op, { queued: { createdAt: later(-25_000).toISOString(), generation: tokenGeneration(tablet.idToken) } }), { now: at }).catch(error => error);
      await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
      assert.equal((await read(id)).isCompleted, false, order);
      // Whatever the order, the opId can never complete it afterwards.
      await refused(completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: id }, { now: later(1000) }), 'already_undone');
    }
  });

  test('case 7: another tablet, an older generation, another person, or after the window cannot Undo it', async () => {
    await seedChore('c-principal');
    const op = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-principal' }, { now: at });
    // Another tablet's ledger never held this opId: nothing is reverted.
    assert.equal((await undoChoreCompletionFromTablet(request(other, member.uid, op), { now: later(1000) })).status, 'not_applied');
    // Another person on the same tablet.
    await refused(undoChoreCompletionFromTablet(request(tablet, child.uid, op), { now: later(1000) }), 'forbidden');
    // After the window.
    await refused(undoChoreCompletionFromTablet(request(tablet, member.uid, op), { now: later(16_000) }), 'undo_expired');
    assert.equal((await read('c-principal')).isCompleted, true);

    // A re-paired tablet (new generation) cannot Undo what the older credential did.
    const spare = await pairTablet(H, owner, created, 'Spare tablet');
    await seedChore('c-generation');
    const sparedOp = opId();
    await completeChoreFromTablet({ ...request(spare, member.uid, sparedOp), choreId: 'c-generation' }, { now: at });
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    const fresh = { ...spare, idToken: (await signIn(repaired.customToken)).idToken };
    await refused(undoChoreCompletionFromTablet(request(fresh, member.uid, sparedOp), { now: later(1000) }), 'not_undoable');
    assert.equal((await read('c-generation')).isCompleted, true);
  });

  test('R1: a queued Undo of a queued action is accepted late (bounded by the stored time); a live one is not', async () => {
    await seedChore('c-r1-queued');
    const queuedOp = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, queuedOp, { queued: { createdAt: later(-60_000).toISOString(), generation: tokenGeneration(tablet.idToken) } }), choreId: 'c-r1-queued' }, { now: at });
    const queuedUndo = { queued: { createdAt: later(-55_000).toISOString(), generation: tokenGeneration(tablet.idToken) } };
    assert.equal((await undoChoreCompletionFromTablet(request(tablet, member.uid, queuedOp, queuedUndo), { now: later(5 * 60_000) })).status, 'undone');

    await seedChore('c-r1-live');
    const liveOp = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, liveOp), choreId: 'c-r1-live' }, { now: at });
    // A queued Undo of an action that was sent live: the device clock never extends the window.
    await refused(undoChoreCompletionFromTablet(request(tablet, member.uid, liveOp, { queued: { createdAt: at.toISOString(), generation: tokenGeneration(tablet.idToken) } }), { now: later(60_000) }), 'undo_expired');

    await seedChore('c-r1-bound');
    const boundOp = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, boundOp, { queued: { createdAt: later(-60_000).toISOString(), generation: tokenGeneration(tablet.idToken) } }), choreId: 'c-r1-bound' }, { now: at });
    await refused(undoChoreCompletionFromTablet(request(tablet, member.uid, boundOp, queuedUndo), { now: later(11 * 60_000) }), 'undo_expired');

    // JC-17: the queued Undo must have been made within 15 s of the queued action, on the same
    // device clock; a claim of "queued" alone never extends the window.
    await seedChore('c-r1-gap');
    const gapOp = opId();
    await completeChoreFromTablet({ ...request(tablet, member.uid, gapOp, { queued: { createdAt: later(-60_000).toISOString(), generation: tokenGeneration(tablet.idToken) } }), choreId: 'c-r1-gap' }, { now: at });
    const lateUndo = { queued: { createdAt: later(-40_000).toISOString(), generation: tokenGeneration(tablet.idToken) } };
    await refused(undoChoreCompletionFromTablet(request(tablet, member.uid, gapOp, lateUndo), { now: later(5 * 60_000) }), 'undo_expired');
    assert.equal((await read('c-r1-gap')).isCompleted, true);
  });

  test('the points-PIN policy decides the level: Kids only asks a child for a PIN; with it, PIN level and an activity entry', async () => {
    await house(H).update({ devicePolicy: { pointsPin: 'kids' } });
    await seedChore('c-pin');
    await refused(completeChoreFromTablet({ ...request(tablet, KID, opId()), choreId: 'c-pin' }, { now: at }), 'no_pin_set');
    await setMyPin(owner, { householdId: H, pin: '2580' });
    const { setChildPin } = await import('../../src/lib/server/pins');
    await setChildPin(owner, { householdId: H, childId: KID, pin: '9314' });
    await refused(completeChoreFromTablet({ ...request(tablet, KID, opId()), choreId: 'c-pin' }, { now: at }), 'pin_required');
    const { pinSessionId } = await verifyDevicePin({ idToken: tablet.idToken, householdId: H, actorUid: KID, pin: '9314' }, { now: at });
    const op = opId();
    const { level } = await completeChoreFromTablet({ ...request(tablet, KID, op, { pinSessionId }), choreId: 'c-pin' }, { now: at });
    assert.equal(level, 'pin');
    assert.equal((await read('c-pin')).deviceAttribution.level, 'pin');
    const entries = (await house(H).collection('auditLogs').where('action', '==', 'device.action').get()).docs.map(d => d.data());
    assert.ok(entries.some(entry => entry.details?.capability === 'chores.complete' && entry.actorUid === KID && entry.targetName === 'Task c-pin'));
    // An adult stays face-level under Kids only.
    await seedChore('c-adult');
    assert.equal((await completeChoreFromTablet({ ...request(tablet, member.uid, opId()), choreId: 'c-adult' }, { now: at })).level, 'face');
  });

  test('a chore due after the household day is refused, recorded as a no-op (a retry replays the refusal); a personal token is not a tablet', async () => {
    await seedChore('c-early', { dueDate: '2026-11-20T06:00:00.000Z' });
    const op = opId();
    const { outcome } = await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-early' }, { now: at });
    assert.equal(outcome.status, 'refused');
    const ledger = (await house(H).collection('devices').doc(tablet.deviceId).collection('ops').doc(op).get()).data()!;
    assert.equal(ledger.summary.noop, true);
    // Now due: the same opId still replays the refusal and completes nothing.
    await chore('c-early').update({ dueDate: '2026-11-14T06:00:00.000Z' });
    assert.equal((await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-early' }, { now: later(1000) })).outcome.status, 'refused');
    assert.equal((await read('c-early')).isCompleted, false);
    const personal = await completeChoreFromTabletAction({ idToken: await personToken(owner), householdId: H, actorUid: member.uid, opId: opId(), choreId: 'c-early' });
    assert.equal(personal.ok ? 'ok' : personal.code, 'not_a_device');
  });
});

describe('review fixes (PR #181)', () => {
  test('B: a completion that found the chore already done is recorded; a retry after a reopen replays it; its Undo never reverses a completion it did not make', async () => {
    await seedChore('c-noop');
    await completeChoresAs(adminDb, owner, H, { choreIds: ['c-noop'] }, at);
    const op = opId();
    assert.equal((await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-noop' }, { now: at })).outcome.status, 'already');
    const ledger = (await house(H).collection('devices').doc(tablet.deviceId).collection('ops').doc(op).get()).data()!;
    assert.equal(ledger.state, 'applied');
    assert.equal(ledger.summary.noop, true);
    // The answer was lost; someone reopens the chore; the queued retry arrives.
    await reopenChoreAs(adminDb, H, { choreId: 'c-noop' });
    assert.equal((await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-noop' }, { now: later(1000) })).outcome.status, 'already');
    assert.equal((await read('c-noop')).isCompleted, false, 'the retry did not complete it again');
    // Completed again by someone else: the no-op's Undo leaves that completion alone, even after the window.
    await completeChoresAs(adminDb, owner, H, { choreIds: ['c-noop'] }, later(2000));
    assert.equal((await undoChoreCompletionFromTablet(request(tablet, member.uid, op), { now: later(3000) })).status, 'already');
    assert.equal((await undoChoreCompletionFromTablet(request(tablet, member.uid, op), { now: later(60_000) })).status, 'already');
    const stored = await read('c-noop');
    assert.equal(stored.isCompleted, true);
    assert.equal(stored.completedByUid, owner.uid);
  });

  test('2: answers to a tablet carry no email, replays included', async () => {
    await seedChore('c-email', { isCompleted: true, completedByUid: 'someone', completedByEmail: 'someone@example.test', completedByName: 'someone@example.test', completedAt: '2026-11-14T10:00:00.000Z', completionId: 'x' });
    const op = opId();
    const first = await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-email' }, { now: at });
    const replay = await completeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 'c-email' }, { now: later(1000) });
    for (const answer of [first, replay]) {
      assert.equal(answer.outcome.status, 'already');
      assert.equal(JSON.stringify(answer).includes('@'), false, JSON.stringify(answer));
    }
  });

  test('3: a take\'s Undo leaves a newer assignment alone, even to the same person under another name', async () => {
    await seedChore('t-newer');
    const op = opId();
    await takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-newer' }, { now: at });
    await chore('t-newer').update({ assignedToDisplayName: 'Max (reassigned)' });
    await refused(undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: later(2000) }), 'changed_since');
    assert.equal((await read('t-newer')).assignedToDisplayName, 'Max (reassigned)');
  });

  test('4 (R3): a no-op take\'s Undo answers already even after the window', async () => {
    await seedChore('t-noop-late', { assignedToUid: member.uid, assignedToDisplayName: 'Max' });
    const op = opId();
    await takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-noop-late' }, { now: at });
    assert.equal((await undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: later(60_000) })).status, 'already');
  });

  test('7: an operation reads the time its latest gate check used', async () => {
    const { deviceOperationContext } = await import('../../src/lib/server/operation-context');
    const authority = { actor: { uid: 'a', name: 'A' }, attribution: null, opId: null, hooks: {}, now: new Date('2026-11-14T15:00:00Z') } as unknown as Parameters<typeof deviceOperationContext>[0];
    const ctx = deviceOperationContext(authority);
    (authority as { now: Date }).now = new Date('2026-11-14T15:00:05Z');
    assert.equal(ctx.now.toISOString(), '2026-11-14T15:00:05.000Z');
  });
});

describe('chores.take', () => {
  test('takes an unassigned chore; the Undo puts the previous assignment back exactly', async () => {
    await seedChore('t-basic');
    const op = opId();
    assert.equal((await takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-basic' }, { now: at })).status, 'taken');
    const stored = await read('t-basic');
    assert.equal(stored.assignedToUid, member.uid);
    assert.equal(stored.assignedToDisplayName, 'Max');
    // R4: a take's attribution lives in the op ledger, not on the chore.
    assert.equal(stored.deviceAttribution, undefined);
    assert.equal((await house(H).collection('devices').doc(tablet.deviceId).collection('ops').doc(op).get()).get('actorUid'), member.uid);
    assert.equal((await undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: later(2000) })).status, 'untaken');
    const back = await read('t-basic');
    assert.equal(back.assignedToUid, '');
    assert.equal(back.assignedToDisplayName, 'Unassigned');
  });

  test('R3: taking a chore that is already yours is a no-op whose Undo answers already', async () => {
    await seedChore('t-noop', { assignedToUid: member.uid, assignedToDisplayName: 'Max' });
    const op = opId();
    assert.equal((await takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-noop' }, { now: at })).status, 'already_yours');
    assert.equal((await undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: later(1000) })).status, 'already');
    assert.equal((await read('t-noop')).assignedToUid, member.uid);
  });

  test('someone else\'s chore is a reassignment, which tablets do not offer; a member without chores.assign cannot take', async () => {
    await seedChore('t-theirs', { assignedToUid: member.uid, assignedToDisplayName: 'Max' });
    await refused(takeChoreFromTablet({ ...request(tablet, child.uid, opId()), choreId: 't-theirs' }, { now: at }), 'forbidden');
    await refused(takeChoreFromTablet({ ...request(tablet, owner.uid, opId()), choreId: 't-theirs' }, { now: at }), 'not_on_tablets');
    await seedChore('t-legacy', { assignedToUid: '', assignedToEmail: 'someone@example.test' });
    await refused(takeChoreFromTablet({ ...request(tablet, owner.uid, opId()), choreId: 't-legacy' }, { now: at }), 'not_on_tablets');
    assert.equal((await read('t-theirs')).assignedToUid, member.uid);
  });

  test('case 1: a personal reassignment in between: the Undo leaves it alone', async () => {
    await seedChore('t-personal');
    const op = opId();
    await takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-personal' }, { now: at });
    await chore('t-personal').update({ assignedToUid: owner.uid, assignedToDisplayName: 'Olive' });
    await refused(undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: later(1000) }), 'changed_since');
    assert.equal((await read('t-personal')).assignedToUid, owner.uid);
  });

  test('case 2: reload with the journal opId inside and outside the window', async () => {
    await seedChore('t-reload-in');
    const inside = opId();
    await takeChoreFromTablet({ ...request(tablet, member.uid, inside), choreId: 't-reload-in' }, { now: at });
    assert.equal((await undoTakeChoreFromTablet(request(tablet, member.uid, inside), { now: later(9000) })).status, 'untaken');
    await seedChore('t-reload-out');
    const outside = opId();
    await takeChoreFromTablet({ ...request(tablet, member.uid, outside), choreId: 't-reload-out' }, { now: at });
    await refused(undoTakeChoreFromTablet(request(tablet, member.uid, outside), { now: later(15_001) }), 'undo_expired');
    assert.equal((await read('t-reload-out')).assignedToUid, member.uid);
  });

  test('case 3: a dropped connection repeats the take (one change) and the Undo (then already)', async () => {
    await seedChore('t-dropped');
    const op = opId();
    await takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-dropped' }, { now: at });
    assert.equal((await takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-dropped' }, { now: later(500) })).status, 'taken');
    assert.equal((await undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: later(1000) })).status, 'untaken');
    assert.equal((await undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: later(2000) })).status, 'already');
    assert.equal((await read('t-dropped')).assignedToUid, '');
  });

  test('case 4: take, Undo, late retry: already undone', async () => {
    await seedChore('t-late');
    const op = opId();
    await takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-late' }, { now: at });
    await undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: later(1000) });
    await refused(takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-late' }, { now: later(2000) }), 'already_undone');
    assert.equal((await read('t-late')).assignedToUid, '');
  });

  test('case 5: the Undo first, then the take is refused', async () => {
    await seedChore('t-first');
    const op = opId();
    assert.equal((await undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: at })).status, 'not_applied');
    await refused(takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-first' }, { now: later(1000) }), 'already_undone');
    assert.equal((await read('t-first')).assignedToUid, '');
  });

  test('case 6: a queued take in flight and its Undo at once, both orders, leave it unassigned', async () => {
    for (const order of ['action-first', 'undo-first'] as const) {
      const id = `t-race-${order}`;
      await seedChore(id);
      const op = opId();
      const take = takeChoreFromTablet({ ...request(tablet, member.uid, op, { queued: { createdAt: later(-30_000).toISOString(), generation: tokenGeneration(tablet.idToken) } }), choreId: id }, { now: at }).catch(error => error);
      const undo = undoTakeChoreFromTablet(request(tablet, member.uid, op, { queued: { createdAt: later(-25_000).toISOString(), generation: tokenGeneration(tablet.idToken) } }), { now: at }).catch(error => error);
      await Promise.all(order === 'action-first' ? [take, undo] : [undo, take]);
      assert.equal((await read(id)).assignedToUid, '', order);
    }
  });

  test('case 7: another tablet, another person, after the window', async () => {
    await seedChore('t-principal');
    const op = opId();
    await takeChoreFromTablet({ ...request(tablet, member.uid, op), choreId: 't-principal' }, { now: at });
    assert.equal((await undoTakeChoreFromTablet(request(other, member.uid, op), { now: later(1000) })).status, 'not_applied');
    await refused(undoTakeChoreFromTablet(request(tablet, owner.uid, op), { now: later(1000) }), 'forbidden');
    await refused(undoTakeChoreFromTablet(request(tablet, member.uid, op), { now: later(16_000) }), 'undo_expired');
    assert.equal((await read('t-principal')).assignedToUid, member.uid);
  });
});
