import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { doc, writeBatch, type Firestore as ClientFirestore } from 'firebase/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { DeviceActionError } from '../../src/lib/server/device-gate';
import {
  completeFromTablet,
  deleteLogFromTablet,
  editSchedulesFromTablet,
  logFromTablet,
  snoozeFromTablet,
  undoCompleteFromTablet,
  undoLogFromTablet,
  undoSnoozeFromTablet,
  type DeviceMaintenanceRequest,
} from '../../src/lib/server/device-maintenance';
import {
  completeMaintenanceScheduleAs,
  saveHomeAssetAs,
  saveMaintenanceLogAs,
  snoozeMaintenanceScheduleAs,
  undoMaintenanceLogAs,
} from '../../src/lib/server/maintenance-operations';
import { personalOperationContext } from '../../src/lib/server/operation-context';
import { createDeviceRepairCode, redeemDeviceCode, removeDevice, updateDeviceSettings } from '../../src/lib/server/device-management';
import { setMyPin, verifyDevicePin } from '../../src/lib/server/pins';
import { UNDO_PROVEN } from '../../src/lib/devices/action-policy';
import { completeFromTabletAction } from '../../src/app/maintenance/device-actions';
import { completeMaintenanceSchedule, undoMaintenanceCompletion, undoMaintenanceLog, saveMaintenanceLog } from '../../src/app/maintenance/actions';
import { clientSession, deleteDeviceUsers, nonce, personToken, seedHousehold, signIn, type Person } from './device-test-helpers';
import { clock, house, opId, pairTablet, seedKid, tokenGeneration, type Tablet } from './device-actor-helpers';

// The Undo proof for maintenance on wall tablets (M8a; design 10.4, tracker WT-20f), with
// real ID tokens: for maintenance.complete (Done), maintenance.log (Log service) and
// maintenance.snooze: (1) a personal client and another tablet change the same thing in
// between: the Undo reverts only what it wrote (compare-and-revert, "kept") or refuses
// `changed_since`, (2) a reload Undoes by the journal's opId inside the window and is refused
// after it, (3) a dropped connection repeats the action (one write) and the Undo (then
// already undone), (4) action, Undo, late retry, (5) Undo before the action, (6) a queued
// send in flight with its Undo concurrently, both orders, (7) the wrong principal (another
// tablet, another person, an older credential generation, after the window). Plus the gate
// (section off, removed tablet, permissions one-of and all-of, guest, points PIN, PIN level,
// forged fields, other households, queued 24 h), the PIN-level schedule edit and log delete,
// and the server's writes replayed through the rules as the person (the client-writable
// part) or through the person's own server action (what only the server writes).

const H = 'dev-maint-house';
const HB = 'dev-maint-other';
const TZ = 'America/Chicago';
const owner: Person = { uid: 'dm-owner', email: 'dm.owner@example.test', displayName: 'Olive', role: 'owner' };
const member: Person = { uid: 'dm-member', email: 'dm.member@example.test', displayName: 'Max', role: 'member' };
const child: Person = { uid: 'dm-child', email: 'dm.child@example.test', displayName: 'Cleo', role: 'child' };
const guest: Person = { uid: 'dm-guest', email: 'dm.guest@example.test', displayName: 'Gus', role: 'guest' };
const limited: Person = { uid: 'dm-limited', email: 'dm.limited@example.test', displayName: 'Lee', role: 'member', permissions: { 'maintenance.edit': false } };
const logsOnly: Person = { uid: 'dm-logs', email: 'dm.logs@example.test', displayName: 'Lou', role: 'member', permissions: { 'maintenance.createLogs': false } };
const ownerB: Person = { uid: 'dm-owner-b', email: 'dm.ownerb@example.test', displayName: 'Bea', role: 'owner' };
const KID = 'kid_DevMaintKid000000000';
const created = new Set<string>();
const time = clock(Date.parse('2026-11-14T15:00:00Z'));
const TODAY = '2026-11-14';
const tablets: Record<'done' | 'log' | 'snooze' | 'other' | 'gate' | 'pin' | 'parity' | 'b', Tablet> = {} as never;
let memberDb: ClientFirestore;
let memberToken: string;
const closers: Array<() => Promise<void>> = [];

const assets = () => house(H).collection('home-assets');
const vehicles = () => house(H).collection('vehicles');
const logs = () => house(H).collection('maintenance');
const deviceOp = (t: Tablet, op: string) => house(H).collection('devices').doc(t.deviceId).collection('ops').doc(op);

const FILTER = { id: 'filter', mode: 'scheduled', scheduleName: 'Replace filter', frequencyType: 'months', intervalValue: 3, nextDueDate: TODAY };
const SEEN = { nextDueDate: TODAY, nextDueMileage: null };

/** A fresh minute for each test keeps every call inside the per-tablet rate windows. */
let at: Date;
const later = (ms: number) => new Date(at.getTime() + ms);
const noCleanup = async () => 0;
const opts = (now: Date) => ({ clock: () => now, cleanup: noCleanup });

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DeviceActionError, `expected DeviceActionError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const seedAsset = async (id: string, extra: Record<string, unknown> = {}) => {
  await assets().doc(id).set({ householdId: H, name: `Asset ${id}`, category: 'HVAC', status: 'active', schedules: [FILTER], createdAt: 'x', updatedAt: 'x', ...extra });
};
const seedVehicle = async (id: string, mileage = 50_000) => {
  await vehicles().doc(id).set({ householdId: H, nickname: `Car ${id}`, status: 'active', currentMileage: mileage, serviceSchedules: [], createdAt: 'x', updatedAt: 'x' });
};
const filterOf = async (id: string) => ((await assets().doc(id).get()).get('schedules') as Array<Record<string, unknown>>).find(s => s.id === 'filter')!;
const assetLogs = async (id: string) => (await logs().where('assetId', '==', id).get()).docs;

const req = (t: Tablet, actorUid: string, op: string, extra: Partial<DeviceMaintenanceRequest> & Record<string, unknown> = {}) => ({
  idToken: t.idToken, householdId: H, actorUid, opId: op, ...extra,
});
const queued = (t: Tablet, msAgo: number) => ({ queued: { createdAt: later(-msAgo).toISOString(), generation: tokenGeneration(t.idToken) } });

const done = (t: Tablet, actorUid: string, op: string, assetId: string, extra: Record<string, unknown> = {}, now = at) =>
  completeFromTablet({ ...req(t, actorUid, op), ownerType: 'home_asset', ownerId: assetId, scheduleId: 'filter', seen: SEEN, completedDate: TODAY, ...extra }, opts(now));
const undoDone = (t: Tablet, actorUid: string, op: string, now = at, extra: Record<string, unknown> = {}) =>
  undoCompleteFromTablet({ ...req(t, actorUid, op), ...extra }, opts(now));
const logValues = (assetId: string, title = 'Checked filter') => ({ targetType: 'home_asset', assetId, title, date: TODAY, type: 'inspection' });
const addLog = (t: Tablet, actorUid: string, op: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}, now = at) =>
  logFromTablet({ ...req(t, actorUid, op), values, ...extra }, opts(now));
const undoLog = (t: Tablet, actorUid: string, op: string, now = at, extra: Record<string, unknown> = {}) =>
  undoLogFromTablet({ ...req(t, actorUid, op), ...extra }, opts(now));
const snooze = (t: Tablet, actorUid: string, op: string, assetId: string, extra: Record<string, unknown> = {}, now = at) =>
  snoozeFromTablet({ ...req(t, actorUid, op), ownerType: 'home_asset', ownerId: assetId, scheduleId: 'filter', seen: SEEN, ...extra }, opts(now));
const undoSnooze = (t: Tablet, actorUid: string, op: string, now = at, extra: Record<string, unknown> = {}) =>
  undoSnoozeFromTablet({ ...req(t, actorUid, op), ...extra }, opts(now));
const personal = (uid: string, now = at) => personalOperationContext({ uid, name: '' }, now);

before(async () => {
  await seedHousehold(H, [owner, member, child, guest, limited, logsOnly], { timeZone: TZ });
  await seedHousehold(HB, [ownerB], { timeZone: TZ });
  await seedKid(H, KID, 'Mia');
  tablets.done = await pairTablet(H, owner, created, 'Kitchen tablet');
  tablets.log = await pairTablet(H, owner, created, 'Pantry tablet');
  tablets.snooze = await pairTablet(H, owner, created, 'Mudroom tablet');
  tablets.other = await pairTablet(H, owner, created, 'Hall tablet');
  tablets.gate = await pairTablet(H, owner, created, 'Den tablet');
  tablets.pin = await pairTablet(H, owner, created, 'Office tablet');
  tablets.parity = await pairTablet(H, owner, created, 'Porch tablet');
  tablets.b = await pairTablet(HB, ownerB, created, 'Other house tablet');
  memberToken = await personToken(member);
  const memberSession = await clientSession(await adminAuth.createCustomToken(member.uid));
  memberDb = memberSession.db;
  closers.push(memberSession.close);
});

beforeEach(async () => {
  at = time.advance(61_000);
  await house(H).update({ devicePolicy: { pointsPin: 'off' } });
});

after(async () => {
  await Promise.all(closers.map(close => close()));
  await deleteDeviceUsers([...created]);
  for (const id of [H, HB]) {
    await adminDb.recursiveDelete(house(id));
    const codes = await adminDb.collection('deviceCodes').where('householdId', '==', id).get();
    await Promise.all(codes.docs.map(d => d.ref.delete()));
  }
});

describe('maintenance Done, Log service and Snooze are face-level with their Undo proven', () => {
  test('UNDO_PROVEN holds the maintenance capabilities proven in this file', () => {
    for (const capability of ['maintenance.complete', 'maintenance.complete.undo', 'maintenance.log', 'maintenance.log.undo', 'maintenance.snooze', 'maintenance.snooze.undo'] as const) {
      assert.ok(UNDO_PROVEN.has(capability), capability);
    }
    for (const capability of ['maintenance.editSchedules', 'maintenance.log.delete', 'maintenance.record.delete', 'maintenance.attachment.delete'] as const) {
      assert.equal(UNDO_PROVEN.has(capability), false, capability);
    }
  });
});

describe('maintenance.complete (Done)', () => {
  const t = () => tablets.done;

  test('credited to the selected person; the log carries the tablet, person and level separately', async () => {
    await seedAsset('credit');
    const op = opId();
    const { result, level } = await done(t(), member.uid, op, 'credit');
    assert.equal(level, 'face');
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    const log = (await logs().doc(result.logId).get()).data()!;
    assert.equal(log.doneByUid, member.uid);
    assert.equal(log.doneByName, 'Max');
    assert.equal(log.opId, op);
    assert.deepEqual(log.deviceAttribution, { deviceId: t().deviceId, deviceName: 'Kitchen tablet', generation: 1, actorUid: member.uid, level: 'face' });
    const filter = await filterOf('credit');
    assert.equal((filter.lastCompletion as Record<string, unknown>).byUid, member.uid);
    assert.equal((filter.lastCompletion as Record<string, unknown>).opId, op);
    const ledger = (await deviceOp(t(), op).get()).data()!;
    assert.equal(ledger.state, 'applied');
    assert.equal(ledger.capability, 'maintenance.complete');
    assert.equal(ledger.actorUid, member.uid);
    // A face action is attributed on its record and the ledger only (JC-19): no activity entry.
    const audit = await house(H).collection('auditLogs').where('details.capability', '==', 'maintenance.complete').get();
    assert.equal(audit.size, 0);
  });

  test('case 1: a personal edit in between is kept and reported; another tablet completing the next cycle makes the Undo changed_since', async () => {
    await seedAsset('between');
    const op = opId();
    const first = await done(t(), member.uid, op, 'between');
    assert.ok(first.result.status === 'completed');
    // The owner edits the schedule's next due date on a phone.
    const stored = await filterOf('between');
    await saveHomeAssetAs(adminDb, H, { opId: opId(), id: 'between', base: { schedules: [stored] }, values: { schedules: [{ ...stored, nextDueDate: '2027-03-03' }] } }, personal(owner.uid));
    const undone = await undoDone(t(), member.uid, op, later(3000));
    assert.equal(undone.status, 'undone');
    if (undone.status === 'undone') assert.deepEqual(undone.kept, [{ field: 'nextDueDate', value: '2027-03-03' }]);
    assert.equal((await assetLogs('between')).length, 0);
    assert.equal((await filterOf('between')).nextDueDate, '2027-03-03', 'the later edit stays');

    await seedAsset('next-cycle');
    const mine = opId();
    const mineResult = await done(t(), member.uid, mine, 'next-cycle');
    assert.ok(mineResult.result.status === 'completed');
    const next = mineResult.result.status === 'completed' ? mineResult.result.next : null;
    const theirs = await done(tablets.other, owner.uid, opId(), 'next-cycle', { seen: next });
    assert.equal(theirs.result.status, 'completed');
    await refused(undoDone(t(), member.uid, mine, later(3000)), 'changed_since');
    assert.equal((await assetLogs('next-cycle')).length, 2, 'both completions stay');
  });

  test('case 2: after a reload the journal opId Undoes inside the window and is refused after it', async () => {
    await seedAsset('reload');
    const inside = opId();
    await done(t(), member.uid, inside, 'reload');
    assert.equal((await undoDone(t(), member.uid, inside, later(9000))).status, 'undone');
    assert.equal((await filterOf('reload')).nextDueDate, TODAY);
    const outside = opId();
    await done(t(), member.uid, outside, 'reload');
    await refused(undoDone(t(), member.uid, outside, later(15_500)), 'undo_expired');
    assert.equal((await assetLogs('reload')).length, 1);
  });

  test('case 3: a dropped connection repeats Done (one log) and the Undo (then already undone)', async () => {
    await seedAsset('dropped');
    const op = opId();
    await done(t(), member.uid, op, 'dropped');
    const repeat = await done(t(), member.uid, op, 'dropped');
    assert.equal(repeat.result.status, 'completed');
    assert.equal((await assetLogs('dropped')).length, 1);
    assert.equal((await undoDone(t(), member.uid, op)).status, 'undone');
    assert.equal((await undoDone(t(), member.uid, op)).status, 'already_undone');
    assert.equal((await assetLogs('dropped')).length, 0);
  });

  test('case 4: Done, Undo, then a late retry of Done is already undone', async () => {
    await seedAsset('late');
    const op = opId();
    await done(t(), member.uid, op, 'late');
    await undoDone(t(), member.uid, op);
    await refused(done(t(), member.uid, op, 'late'), 'already_undone');
    assert.equal((await assetLogs('late')).length, 0);
    assert.equal((await filterOf('late')).nextDueDate, TODAY);
  });

  test('case 5: the Undo arrives first (a tombstone), then Done is refused', async () => {
    await seedAsset('first');
    const op = opId();
    assert.equal((await undoDone(t(), member.uid, op)).status, 'not_applied');
    await refused(done(t(), member.uid, op, 'first'), 'already_undone');
    assert.equal((await assetLogs('first')).length, 0);
  });

  test('case 6: a queued Done in flight and its Undo at once, both orders, leave the cycle open and no log', async () => {
    for (const order of ['action-first', 'undo-first'] as const) {
      const id = `race-${order}`;
      await seedAsset(id);
      const op = opId();
      const action = done(t(), member.uid, op, id, queued(t(), 30_000)).catch(error => error);
      const undo = undoDone(t(), member.uid, op, at, queued(t(), 25_000)).catch(error => error);
      await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
      assert.equal((await assetLogs(id)).length, 0, order);
      assert.equal((await filterOf(id)).nextDueDate, TODAY, order);
      await refused(done(t(), member.uid, op, id), 'already_undone');
    }
  });

  test('case 7: another tablet, another person or after the window cannot Undo it', async () => {
    await seedAsset('principal');
    const op = opId();
    await done(t(), member.uid, op, 'principal');
    assert.equal((await undoDone(tablets.other, member.uid, op)).status, 'not_applied');
    await refused(undoDone(t(), owner.uid, op), 'forbidden');
    await refused(undoDone(t(), member.uid, op, later(16_000)), 'undo_expired');
    assert.equal((await assetLogs('principal')).length, 1);
  });

  test('case 7 (generation): a re-paired tablet cannot Undo what the older credential did', async () => {
    const spare = await pairTablet(H, owner, created, 'Spare tablet');
    await seedAsset('gen');
    const op = opId();
    await done(spare, member.uid, op, 'gen');
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    const fresh = { ...spare, idToken: (await signIn(repaired.customToken)).idToken };
    await refused(undoDone(fresh, member.uid, op), 'not_undoable');
    assert.equal((await assetLogs('gen')).length, 1);
  });

  test('a queued Done whose cycle moved meanwhile is answered changed and writes nothing; R1: its queued Undo within 10 minutes', async () => {
    await seedAsset('moved');
    // The due date was changed on a phone while the Done waited in the queue.
    await saveHomeAssetAs(adminDb, H, { opId: opId(), id: 'moved', base: { schedules: [FILTER] }, values: { schedules: [{ ...FILTER, nextDueDate: '2026-12-01' }] } }, personal(owner.uid));
    const op = opId();
    const answer = await done(t(), member.uid, op, 'moved', queued(t(), 60 * 60_000));
    assert.deepEqual(answer.result, { status: 'changed' });
    assert.equal((await assetLogs('moved')).length, 0);
    assert.equal((await deviceOp(t(), op).get()).exists, false, 'nothing recorded: a later attempt is evaluated again');
    // Completed on a phone meanwhile: "already done" with who and when, nothing written.
    await seedAsset('done-elsewhere');
    await completeMaintenanceScheduleAs(adminDb, H, { opId: opId(), ownerType: 'home_asset', ownerId: 'done-elsewhere', scheduleId: 'filter', seen: SEEN, completedDate: TODAY }, personal(owner.uid));
    const elsewhere = await done(t(), member.uid, opId(), 'done-elsewhere', queued(t(), 60 * 60_000));
    assert.equal(elsewhere.result.status, 'already_done');
    if (elsewhere.result.status === 'already_done') assert.equal(elsewhere.result.byName, 'Olive');
    assert.equal((await assetLogs('done-elsewhere')).length, 1, 'only the phone\'s completion');
    // A queued Done replayed late, and its queued Undo made right after it on the tablet.
    await seedAsset('r1');
    const late = opId();
    await done(t(), member.uid, late, 'r1', queued(t(), 60_000));
    const undo = await undoDone(t(), member.uid, late, later(5 * 60_000), { queued: { createdAt: later(-55_000).toISOString(), generation: tokenGeneration(t().idToken) } });
    assert.equal(undo.status, 'undone');
  });

  test('a log with files is not undone (has_attachments); nothing changes', async () => {
    await seedAsset('files');
    const op = opId();
    const { result } = await done(t(), member.uid, op, 'files');
    assert.ok(result.status === 'completed');
    if (result.status !== 'completed') return;
    await house(H).collection('maintenance-attachments').doc('file-1').set({ householdId: H, targetType: 'maintenance_log', targetId: result.logId, fileName: 'r.pdf' });
    assert.equal((await undoDone(t(), member.uid, op)).status, 'has_attachments');
    assert.equal((await logs().doc(result.logId).get()).exists, true);
  });
});

describe('maintenance.log (Log service)', () => {
  const t = () => tablets.log;

  test('a new log credited to the selected person with the tablet attribution; an id or base sent is never an edit', async () => {
    await seedAsset('log-credit');
    await logs().doc('existing-log').set({ householdId: H, targetType: 'home_asset', assetId: 'log-credit', title: 'Old', item: 'Old', date: '2026-01-01', type: 'other' });
    const op = opId();
    const { result, level } = await addLog(t(), member.uid, op, { ...logValues('log-credit'), id: 'existing-log', doneByUid: 'evil' }, { id: 'existing-log', base: { title: 'Old' } });
    assert.equal(level, 'face');
    assert.ok(result.status === 'saved' && result.created);
    if (result.status !== 'saved') return;
    assert.notEqual(result.id, 'existing-log');
    assert.equal((await logs().doc('existing-log').get()).get('title'), 'Old', 'no edit of another log');
    const log = (await logs().doc(result.id).get()).data()!;
    assert.equal(log.doneByUid, member.uid);
    assert.equal(log.doneByName, 'Max');
    assert.equal(log.deviceAttribution.actorUid, member.uid);
    assert.equal(log.deviceAttribution.deviceName, 'Pantry tablet');
    assert.equal(log.deviceAttribution.level, 'face');
  });

  test('case 1: another tablet logs meanwhile (kept); a log edited on a phone since is never undone; a later reading stays', async () => {
    await seedAsset('log-between');
    const op = opId();
    const mine = await addLog(t(), member.uid, op, logValues('log-between', 'Mine'));
    const theirs = await addLog(tablets.other, owner.uid, opId(), logValues('log-between', 'Theirs'));
    assert.equal((await undoLog(t(), member.uid, op)).status, 'undone');
    assert.equal((await assetLogs('log-between')).length, 1);
    assert.ok(theirs.result.status === 'saved' && (await logs().doc(theirs.result.id).get()).exists);
    assert.ok(mine.result.status === 'saved' && !(await logs().doc(mine.result.id).get()).exists);

    const edited = opId();
    const saved = await addLog(t(), member.uid, edited, logValues('log-between', 'Edited later'));
    assert.ok(saved.result.status === 'saved');
    if (saved.result.status !== 'saved') return;
    await saveMaintenanceLogAs(adminDb, H, { opId: opId(), id: saved.result.id, base: { ...logValues('log-between', 'Edited later') }, values: { ...logValues('log-between', 'Edited later'), notes: 'On a phone' } }, personal(owner.uid));
    await refused(undoLog(t(), member.uid, edited, later(2000)), 'changed_since');
    assert.equal((await logs().doc(saved.result.id).get()).get('notes'), 'On a phone');

    // The vehicle reading: the Undo takes back its own contribution; a later, higher reading stays.
    await seedVehicle('van', 50_000);
    const reading = opId();
    await addLog(t(), member.uid, reading, { targetType: 'vehicle', vehicleId: 'van', title: 'Fuel', date: TODAY, mileage: 51_000 });
    assert.equal((await vehicles().doc('van').get()).get('currentMileage'), 51_000);
    assert.equal((await undoLog(t(), member.uid, reading)).status, 'undone');
    assert.equal((await vehicles().doc('van').get()).get('currentMileage'), 50_000);
    const again = opId();
    await addLog(t(), member.uid, again, { targetType: 'vehicle', vehicleId: 'van', title: 'Fuel again', date: TODAY, mileage: 51_000 });
    await addLog(tablets.other, owner.uid, opId(), { targetType: 'vehicle', vehicleId: 'van', title: 'Trip', date: TODAY, mileage: 52_000 });
    const undone = await undoLog(t(), member.uid, again);
    assert.equal(undone.status, 'undone');
    if (undone.status === 'undone') assert.deepEqual(undone.kept, [{ field: 'currentMileage', value: 52_000 }]);
    assert.equal((await vehicles().doc('van').get()).get('currentMileage'), 52_000);
  });

  test('case 2: reload inside the window Undoes; outside it is refused', async () => {
    await seedAsset('log-reload');
    const inside = opId();
    await addLog(t(), member.uid, inside, logValues('log-reload'));
    assert.equal((await undoLog(t(), member.uid, inside, later(9000))).status, 'undone');
    const outside = opId();
    await addLog(t(), member.uid, outside, logValues('log-reload'));
    await refused(undoLog(t(), member.uid, outside, later(15_500)), 'undo_expired');
    assert.equal((await assetLogs('log-reload')).length, 1);
  });

  test('cases 3-5: dropped connection, late retry, Undo first', async () => {
    await seedAsset('log-cases');
    const dropped = opId();
    await addLog(t(), member.uid, dropped, logValues('log-cases'));
    const repeat = await addLog(t(), member.uid, dropped, logValues('log-cases'));
    assert.equal(repeat.result.status, 'saved');
    assert.equal((await assetLogs('log-cases')).length, 1);
    assert.equal((await undoLog(t(), member.uid, dropped)).status, 'undone');
    assert.equal((await undoLog(t(), member.uid, dropped)).status, 'already_undone');
    await refused(addLog(t(), member.uid, dropped, logValues('log-cases')), 'already_undone');
    const first = opId();
    assert.equal((await undoLog(t(), member.uid, first)).status, 'not_applied');
    await refused(addLog(t(), member.uid, first, logValues('log-cases')), 'already_undone');
    assert.equal((await assetLogs('log-cases')).length, 0);
  });

  test('case 6: a queued log in flight and its Undo at once, both orders, leave nothing', async () => {
    for (const order of ['action-first', 'undo-first'] as const) {
      const id = `log-race-${order}`;
      await seedAsset(id);
      const op = opId();
      const action = addLog(t(), member.uid, op, logValues(id), queued(t(), 30_000)).catch(error => error);
      const undo = undoLog(t(), member.uid, op, at, queued(t(), 25_000)).catch(error => error);
      await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
      assert.equal((await assetLogs(id)).length, 0, order);
    }
  });

  test('case 7: another tablet, another person, an older generation, after the window', async () => {
    await seedAsset('log-principal');
    const op = opId();
    await addLog(t(), member.uid, op, logValues('log-principal'));
    assert.equal((await undoLog(tablets.other, member.uid, op)).status, 'not_applied');
    await refused(undoLog(t(), owner.uid, op), 'forbidden');
    await refused(undoLog(t(), member.uid, op, later(16_000)), 'undo_expired');
    const spare = await pairTablet(H, owner, created, 'Spare log tablet');
    const old = opId();
    await addLog(spare, member.uid, old, logValues('log-principal'));
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    await refused(undoLog({ ...spare, idToken: (await signIn(repaired.customToken)).idToken }, member.uid, old), 'not_undoable');
    assert.equal((await assetLogs('log-principal')).length, 2);
  });

  test('a log recreated under the same id (someone deleted it and wrote another) is never undone', async () => {
    await seedAsset('log-recreated');
    const op = opId();
    const saved = await addLog(t(), member.uid, op, logValues('log-recreated'));
    assert.ok(saved.result.status === 'saved');
    if (saved.result.status !== 'saved') return;
    const original = (await logs().doc(saved.result.id).get()).data()!;
    await logs().doc(saved.result.id).delete();
    await logs().doc(saved.result.id).set({ ...original, deviceAttribution: { ...original.deviceAttribution, deviceId: tablets.other.deviceId } });
    await refused(undoLog(t(), member.uid, op), 'changed_since');
    assert.equal((await logs().doc(saved.result.id).get()).exists, true);
  });

  test('the personal Undo of a new log: the creator within the window; never an edit, another person or later', async () => {
    await seedAsset('log-personal');
    const op = opId();
    const created = await saveMaintenanceLogAs(adminDb, H, { opId: op, values: logValues('log-personal') }, personal(member.uid));
    await assert.rejects(undoMaintenanceLogAs(adminDb, H, { opId: op }, personal(owner.uid, later(1000))), /forbidden/);
    assert.equal((await undoMaintenanceLogAs(adminDb, H, { opId: op }, personal(member.uid, later(16_000)))).status, 'expired');
    assert.equal((await undoMaintenanceLogAs(adminDb, H, { opId: op }, personal(member.uid, later(2000)))).status, 'undone');
    assert.equal((await logs().doc(created.id).get()).exists, false);
    assert.equal((await undoMaintenanceLogAs(adminDb, H, { opId: op }, personal(member.uid, later(3000)))).status, 'already_undone');
    const editOp = opId();
    const again = await saveMaintenanceLogAs(adminDb, H, { opId: opId(), values: logValues('log-personal') }, personal(member.uid));
    await saveMaintenanceLogAs(adminDb, H, { opId: editOp, id: again.id, base: logValues('log-personal'), values: { ...logValues('log-personal'), notes: 'x' } }, personal(member.uid));
    await assert.rejects(undoMaintenanceLogAs(adminDb, H, { opId: editOp }, personal(member.uid)), /conflict/);
    // The personal action, with the member's own token and permissions (createLogs).
    const viaAction = await saveMaintenanceLog({ idToken: memberToken, householdId: H, save: { opId: opId(), values: logValues('log-personal', 'Via action') } });
    assert.ok(viaAction.ok && viaAction.data.created);
  });
});

describe('maintenance.snooze', () => {
  const t = () => tablets.snooze;
  const snoozedTo = '2026-11-21';

  test('a week later for the selected person; the ledger names them; no activity entry', async () => {
    await seedAsset('snooze-credit');
    const op = opId();
    const { result, level } = await snooze(t(), member.uid, op, 'snooze-credit');
    assert.equal(level, 'face');
    assert.equal(result.status, 'snoozed');
    const filter = await filterOf('snooze-credit');
    assert.equal(filter.nextDueDate, snoozedTo);
    assert.equal(filter.snoozedUntil, snoozedTo);
    assert.equal(filter.snoozedFrom, TODAY);
    assert.equal((await house(H).collection('maintenance-ops').doc(op).get()).get('actorUid'), member.uid);
    assert.equal((await deviceOp(t(), op).get()).get('actorUid'), member.uid);
  });

  test('case 1: a personal edit in between is kept; another tablet snoozing the next cycle keeps its own', async () => {
    await seedAsset('snooze-between');
    const op = opId();
    await snooze(t(), member.uid, op, 'snooze-between');
    const stored = await filterOf('snooze-between');
    await saveHomeAssetAs(adminDb, H, { opId: opId(), id: 'snooze-between', base: { schedules: [stored] }, values: { schedules: [{ ...stored, nextDueDate: '2026-12-01' }] } }, personal(owner.uid));
    const undone = await undoSnooze(t(), member.uid, op, later(2000));
    assert.equal(undone.status, 'undone');
    if (undone.status === 'undone') assert.ok(undone.kept.some(field => field.field === 'nextDueDate' && field.value === '2026-12-01'));
    assert.equal((await filterOf('snooze-between')).nextDueDate, '2026-12-01');
  });

  test('case 2: reload inside the window Undoes; outside it is refused', async () => {
    await seedAsset('snooze-reload');
    const inside = opId();
    await snooze(t(), member.uid, inside, 'snooze-reload');
    assert.equal((await undoSnooze(t(), member.uid, inside, later(9000))).status, 'undone');
    assert.equal((await filterOf('snooze-reload')).nextDueDate, TODAY);
    const outside = opId();
    await snooze(t(), member.uid, outside, 'snooze-reload');
    await refused(undoSnooze(t(), member.uid, outside, later(15_500)), 'undo_expired');
    assert.equal((await filterOf('snooze-reload')).nextDueDate, snoozedTo);
  });

  test('cases 3-5: dropped connection, late retry, Undo first', async () => {
    await seedAsset('snooze-cases');
    const dropped = opId();
    await snooze(t(), member.uid, dropped, 'snooze-cases');
    assert.equal((await snooze(t(), member.uid, dropped, 'snooze-cases')).result.status, 'snoozed');
    assert.equal((await undoSnooze(t(), member.uid, dropped)).status, 'undone');
    assert.equal((await undoSnooze(t(), member.uid, dropped)).status, 'already_undone');
    await refused(snooze(t(), member.uid, dropped, 'snooze-cases'), 'already_undone');
    const first = opId();
    assert.equal((await undoSnooze(t(), member.uid, first)).status, 'not_applied');
    await refused(snooze(t(), member.uid, first, 'snooze-cases'), 'already_undone');
    assert.equal((await filterOf('snooze-cases')).nextDueDate, TODAY);
  });

  test('case 6: a queued snooze in flight and its Undo at once, both orders, leave the due date', async () => {
    for (const order of ['action-first', 'undo-first'] as const) {
      const id = `snooze-race-${order}`;
      await seedAsset(id);
      const op = opId();
      const action = snooze(t(), member.uid, op, id, queued(t(), 30_000)).catch(error => error);
      const undo = undoSnooze(t(), member.uid, op, at, queued(t(), 25_000)).catch(error => error);
      await Promise.all(order === 'action-first' ? [action, undo] : [undo, action]);
      assert.equal((await filterOf(id)).nextDueDate, TODAY, order);
    }
  });

  test('case 7: another tablet, another person, an older generation, after the window', async () => {
    await seedAsset('snooze-principal');
    const op = opId();
    await snooze(t(), member.uid, op, 'snooze-principal');
    assert.equal((await undoSnooze(tablets.other, member.uid, op)).status, 'not_applied');
    await refused(undoSnooze(t(), owner.uid, op), 'forbidden');
    await refused(undoSnooze(t(), member.uid, op, later(16_000)), 'undo_expired');
    assert.equal((await filterOf('snooze-principal')).nextDueDate, snoozedTo);
    await seedAsset('snooze-gen');
    const spare = await pairTablet(H, owner, created, 'Spare snooze tablet');
    const old = opId();
    await snooze(spare, member.uid, old, 'snooze-gen');
    const { code } = await createDeviceRepairCode(owner, { householdId: H, deviceId: spare.deviceId });
    const repaired = await redeemDeviceCode({ code, nonce: nonce() });
    await refused(undoSnooze({ ...spare, idToken: (await signIn(repaired.customToken)).idToken }, member.uid, old), 'not_undoable');
    assert.equal((await filterOf('snooze-gen')).nextDueDate, snoozedTo);
  });
});

describe('the gate on maintenance', () => {
  const t = () => tablets.gate;

  test('permissions: Done needs maintenance.edit AND maintenance.createLogs; Snooze edit; Log service createLogs; a child and a guest', async () => {
    await seedAsset('perm');
    await refused(done(t(), limited.uid, opId(), 'perm'), 'forbidden');
    await refused(done(t(), logsOnly.uid, opId(), 'perm'), 'forbidden');
    await refused(snooze(t(), limited.uid, opId(), 'perm'), 'forbidden');
    assert.equal((await snooze(t(), logsOnly.uid, opId(), 'perm')).result.status, 'snoozed');
    assert.equal((await addLog(t(), limited.uid, opId(), logValues('perm'))).result.status, 'saved');
    await refused(addLog(t(), logsOnly.uid, opId(), logValues('perm')), 'forbidden');
    await refused(done(t(), child.uid, opId(), 'perm'), 'forbidden');
    await refused(done(t(), KID, opId(), 'perm'), 'forbidden');
    await refused(done(t(), guest.uid, opId(), 'perm'), 'actor_guest');
    assert.equal((await assetLogs('perm')).length, 1);
  });

  test('the points PIN set to Everyone never asks for a PIN for maintenance', async () => {
    await house(H).update({ devicePolicy: { pointsPin: 'everyone' } });
    await seedAsset('points');
    const op = opId();
    assert.equal((await done(t(), member.uid, op, 'points')).level, 'face');
    assert.equal((await undoDone(t(), member.uid, op)).status, 'undone');
    assert.equal((await snooze(t(), member.uid, opId(), 'points')).level, 'face');
    assert.equal((await addLog(t(), member.uid, opId(), logValues('points'))).level, 'face');
  });

  test('forged author, device and level fields are ignored', async () => {
    await seedAsset('forged');
    const forged = {
      doneByUid: 'evil', doneByName: 'Evil', level: 'pin', capability: 'maintenance.log', actorName: 'Evil',
      deviceAttribution: { deviceId: 'fake', deviceName: 'Fake', generation: 9, actorUid: 'evil', level: 'pin' },
      lastCompletion: { opId: 'x' }, createdAtServer: 'yesterday',
    };
    const { result, level } = await done(t(), member.uid, opId(), 'forged', forged);
    assert.equal(level, 'face');
    assert.ok(result.status === 'completed');
    if (result.status !== 'completed') return;
    const log = (await logs().doc(result.logId).get()).data()!;
    assert.equal(log.doneByUid, member.uid);
    assert.equal(log.doneByName, 'Max');
    assert.deepEqual(log.deviceAttribution, { deviceId: t().deviceId, deviceName: 'Den tablet', generation: 1, actorUid: member.uid, level: 'face' });
  });

  test('a queued replay older than 24 hours is refused (stale_intent); a personal token is not a tablet', async () => {
    await seedAsset('stale');
    await refused(done(t(), member.uid, opId(), 'stale', queued(t(), 25 * 60 * 60_000)), 'stale_intent');
    await refused(addLog(t(), member.uid, opId(), logValues('stale'), queued(t(), 25 * 60 * 60_000)), 'stale_intent');
    assert.equal((await assetLogs('stale')).length, 0);
    const answer = await completeFromTabletAction({ idToken: memberToken, householdId: H, actorUid: member.uid, opId: opId(), ownerType: 'home_asset', ownerId: 'stale', scheduleId: 'filter', seen: SEEN, completedDate: TODAY });
    assert.equal(answer.ok ? 'ok' : answer.code, 'not_a_device');
  });

  test('another household: its tablet cannot act here, and its own household has no such record', async () => {
    await seedAsset('cross');
    await refused(done(tablets.b, member.uid, opId(), 'cross'), 'wrong_household');
    const own = await completeFromTablet({ idToken: tablets.b.idToken, householdId: HB, actorUid: ownerB.uid, opId: opId(), ownerType: 'home_asset', ownerId: 'cross', scheduleId: 'filter', seen: SEEN, completedDate: TODAY }, opts(at));
    assert.deepEqual(own.result, { status: 'gone' });
    await refused(completeFromTablet({ idToken: tablets.b.idToken, householdId: HB, actorUid: member.uid, opId: opId(), ownerType: 'home_asset', ownerId: 'cross', scheduleId: 'filter', seen: SEEN, completedDate: TODAY }, opts(at)), 'actor_not_member');
    assert.equal((await filterOf('cross')).nextDueDate, TODAY);
  });

  test('an opId reused for another record is a conflict, never the first record\'s answer', async () => {
    await seedAsset('reuse-a');
    await seedAsset('reuse-b');
    const op = opId();
    await done(t(), member.uid, op, 'reuse-a');
    await refused(done(t(), member.uid, op, 'reuse-b'), 'conflict');
    assert.equal((await assetLogs('reuse-b')).length, 0);
    const again = await done(t(), member.uid, op, 'reuse-a');
    assert.ok(again.result.status === 'completed');
  });

  test('the request size is limited', async () => {
    await seedAsset('big');
    await refused(done(t(), member.uid, opId(), 'big', { notes: 'x'.repeat(17 * 1024) }), 'invalid_input');
  });

  test('a tablet with Maintenance switched off is refused (section_off); a removed tablet (device_revoked)', async () => {
    await seedAsset('section');
    const off = await pairTablet(H, owner, created, 'Laundry tablet');
    await updateDeviceSettings(owner, { householdId: H, deviceId: off.deviceId, patch: { sections: { maintenance: false } } });
    await refused(done(off, member.uid, opId(), 'section'), 'section_off');
    await refused(addLog(off, member.uid, opId(), logValues('section')), 'section_off');
    const gone = await pairTablet(H, owner, created, 'Garage tablet');
    await removeDevice(owner, { householdId: H, deviceId: gone.deviceId });
    await refused(snooze(gone, member.uid, opId(), 'section'), 'device_revoked');
    assert.equal((await filterOf('section')).nextDueDate, TODAY);
  });
});

describe('PIN level: editing schedules and deleting a log', () => {
  const t = () => tablets.pin;

  test('editing schedules needs a PIN session (never the points PIN), changes only the schedule list and is logged as device.action', async () => {
    await seedAsset('sched', { location: 'Attic' });
    const edit = (actorUid: string, extra: Record<string, unknown> = {}) => editSchedulesFromTablet({
      ...req(t(), actorUid, opId()), ownerType: 'home_asset', ownerId: 'sched', base: [FILTER], values: [{ ...FILTER, intervalValue: 6 }],
      name: 'Hacked', location: 'Hacked', ...extra,
    } as never, opts(at));
    await refused(edit(member.uid), 'no_pin_set');
    await setMyPin(member, { householdId: H, pin: '2580' });
    await refused(edit(member.uid), 'pin_required');
    const { pinSessionId } = await verifyDevicePin({ idToken: t().idToken, householdId: H, actorUid: member.uid, pin: '2580' });
    await refused(edit(member.uid, { pinSessionId: 'A'.repeat(43) }), 'pin_session_invalid');
    const { result, level } = await edit(member.uid, { pinSessionId });
    assert.equal(level, 'pin');
    assert.ok(result.status === 'saved');
    const stored = (await assets().doc('sched').get()).data()!;
    assert.equal(stored.name, 'Asset sched');
    assert.equal(stored.location, 'Attic');
    assert.equal(stored.schedules[0].intervalValue, 6);
    const audit = (await house(H).collection('auditLogs').where('action', '==', 'device.action').get()).docs.map(d => d.data());
    assert.ok(audit.some(entry => entry.details?.capability === 'maintenance.editSchedules' && entry.actorUid === member.uid && entry.level === 'pin' && entry.deviceId === t().deviceId));
    // The holder without maintenance.edit is refused before any PIN.
    await refused(edit(limited.uid), 'forbidden');
  });

  test('deleting a log needs maintenance.delete and a PIN; a log with files is kept', async () => {
    await seedAsset('del');
    const plain = await saveMaintenanceLogAs(adminDb, H, { opId: opId(), values: logValues('del', 'To delete') }, personal(owner.uid));
    const kept = await saveMaintenanceLogAs(adminDb, H, { opId: opId(), values: logValues('del', 'With files') }, personal(owner.uid));
    await house(H).collection('maintenance-attachments').doc('del-file').set({ householdId: H, targetType: 'maintenance_log', targetId: kept.id, fileName: 'a.pdf' });
    // A member has no maintenance.delete by default.
    await refused(deleteLogFromTablet({ ...req(t(), member.uid, opId()), logId: plain.id }, opts(at)), 'forbidden');
    await setMyPin(owner, { householdId: H, pin: '1470' });
    await refused(deleteLogFromTablet({ ...req(t(), owner.uid, opId()), logId: plain.id }, opts(at)), 'pin_required');
    const { pinSessionId } = await verifyDevicePin({ idToken: t().idToken, householdId: H, actorUid: owner.uid, pin: '1470' });
    const op = opId();
    const removed = await deleteLogFromTablet({ ...req(t(), owner.uid, op, { pinSessionId }), logId: plain.id }, opts(at));
    assert.deepEqual(removed.result, { status: 'deleted', replay: false });
    assert.equal((await logs().doc(plain.id).get()).exists, false);
    const replayed = await deleteLogFromTablet({ ...req(t(), owner.uid, op, { pinSessionId }), logId: plain.id }, opts(at));
    assert.equal(replayed.result.status, 'deleted');
    const blocked = await deleteLogFromTablet({ ...req(t(), owner.uid, opId(), { pinSessionId }), logId: kept.id }, opts(at));
    assert.deepEqual(blocked.result, { status: 'has_attachments' });
    assert.equal((await logs().doc(kept.id).get()).exists, true);
    const audit = (await house(H).collection('auditLogs').where('action', '==', 'device.action').get()).docs.map(d => d.data());
    assert.ok(audit.some(entry => entry.details?.capability === 'maintenance.log.delete' && entry.targetName === 'To delete'));
  });
});

describe('the server writes only what the person may write (replayed as their own client, or their own server action)', () => {
  const t = () => tablets.parity;
  /** Fields only the server writes (M1): the person's client may not set them, by design. */
  const SERVER_LOG_FIELDS = ['doneByUid', 'doneByName', 'createdAtServer', 'opId', 'completion', 'deviceAttribution'];
  const SERVER_VEHICLE_FIELDS = ['mileageUpdatedAt'];
  const strip = (data: Record<string, unknown>, fields: string[]) => Object.fromEntries(Object.entries(data).filter(([key]) => !fields.includes(key)));

  /** Puts the documents back as they were, then the member's client writes what the server wrote. */
  const replay = async (writes: Array<{ path: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; strip?: string[] }>) => {
    for (const write of writes) {
      const ref = adminDb.doc(write.path);
      if (write.before) await ref.set(write.before);
      else await ref.delete();
    }
    const batch = writeBatch(memberDb);
    for (const write of writes) {
      if (write.after) batch.set(doc(memberDb, write.path), strip(write.after, write.strip ?? []));
      else batch.delete(doc(memberDb, write.path));
    }
    await batch.commit();
  };

  test('Done on an asset: the log and the advanced schedule', async () => {
    await seedAsset('parity-done');
    const before = (await assets().doc('parity-done').get()).data()!;
    const { result } = await done(t(), member.uid, opId(), 'parity-done');
    assert.ok(result.status === 'completed');
    if (result.status !== 'completed') return;
    const log = (await logs().doc(result.logId).get()).data()!;
    assert.ok(log.deviceAttribution, 'the server stores the attribution');
    await replay([
      { path: assets().doc('parity-done').path, before, after: (await assets().doc('parity-done').get()).data()! },
      { path: logs().doc(result.logId).path, before: null, after: log, strip: SERVER_LOG_FIELDS },
    ]);
  });

  test('Log service with a vehicle reading: the log and the raised mileage', async () => {
    await seedVehicle('parity-car', 40_000);
    const before = (await vehicles().doc('parity-car').get()).data()!;
    const { result } = await addLog(t(), member.uid, opId(), { targetType: 'vehicle', vehicleId: 'parity-car', title: 'Tyres', date: TODAY, mileage: 41_000 });
    assert.ok(result.status === 'saved');
    if (result.status !== 'saved') return;
    await replay([
      { path: vehicles().doc('parity-car').path, before, after: (await vehicles().doc('parity-car').get()).data()!, strip: SERVER_VEHICLE_FIELDS },
      { path: logs().doc(result.id).path, before: null, after: (await logs().doc(result.id).get()).data()!, strip: SERVER_LOG_FIELDS },
    ]);
  });

  test('Snooze and the Undos\' schedule and mileage reverts', async () => {
    await seedAsset('parity-snooze');
    const before = (await assets().doc('parity-snooze').get()).data()!;
    const op = opId();
    await snooze(t(), member.uid, op, 'parity-snooze');
    const snoozed = (await assets().doc('parity-snooze').get()).data()!;
    await replay([{ path: assets().doc('parity-snooze').path, before, after: snoozed }]);
    // The Undo's revert of the schedule (maintenance.edit).
    await undoSnooze(t(), member.uid, op);
    const reverted = (await assets().doc('parity-snooze').get()).data()!;
    await replay([{ path: assets().doc('parity-snooze').path, before: snoozed, after: reverted }]);
    // A log Undo's mileage revert (maintenance.edit).
    await seedVehicle('parity-undo-car', 40_000);
    const logOp = opId();
    await addLog(t(), member.uid, logOp, { targetType: 'vehicle', vehicleId: 'parity-undo-car', title: 'Fuel', date: TODAY, mileage: 40_500 });
    const raised = (await vehicles().doc('parity-undo-car').get()).data()!;
    await undoLog(t(), member.uid, logOp);
    const lowered = (await vehicles().doc('parity-undo-car').get()).data()!;
    await replay([{ path: vehicles().doc('parity-undo-car').path, before: raised, after: lowered, strip: SERVER_VEHICLE_FIELDS }]);
  });

  test('the Undos\' log deletion is what the person\'s own server action does with their permissions (no maintenance.delete)', async () => {
    // The member has maintenance.edit and maintenance.createLogs but not maintenance.delete:
    // the rules would refuse a client delete, while the personal Undo actions (M1) delete the
    // log they created. The tablet's Undo needs the same permissions as those actions.
    await seedAsset('parity-own');
    const op = opId();
    // The personal actions run at the emulator's pinned HOMEHUB_TEST_NOW (2026-08-01): a day not after it.
    const completed = await completeMaintenanceSchedule({ idToken: memberToken, householdId: H, completion: { opId: op, ownerType: 'home_asset', ownerId: 'parity-own', scheduleId: 'filter', seen: SEEN, completedDate: '2026-08-01' } });
    assert.ok(completed.ok && completed.data.status === 'completed', JSON.stringify(completed));
    const undone = await undoMaintenanceCompletion({ idToken: memberToken, householdId: H, opId: op });
    assert.ok(undone.ok && undone.data.status === 'undone', JSON.stringify(undone));
    const logOp = opId();
    const saved = await saveMaintenanceLog({ idToken: memberToken, householdId: H, save: { opId: logOp, values: logValues('parity-own') } });
    assert.ok(saved.ok);
    const logUndone = await undoMaintenanceLog({ idToken: memberToken, householdId: H, opId: logOp });
    assert.ok(logUndone.ok && logUndone.data.status === 'undone', JSON.stringify(logUndone));
    assert.equal((await assetLogs('parity-own')).length, 0);
  });

  test('a snooze through the personal operation writes the same schedule as the tablet\'s', async () => {
    await seedAsset('parity-same-a');
    await seedAsset('parity-same-b');
    await snooze(t(), member.uid, opId(), 'parity-same-a');
    await snoozeMaintenanceScheduleAs(adminDb, H, { opId: opId(), ownerType: 'home_asset', ownerId: 'parity-same-b', scheduleId: 'filter', seen: SEEN }, personal(member.uid), { cleanup: noCleanup });
    assert.deepEqual(await filterOf('parity-same-a'), await filterOf('parity-same-b'));
  });
});
