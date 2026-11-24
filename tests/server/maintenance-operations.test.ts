import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { personalOperationContext } from '../../src/lib/server/operation-context';
import {
  MaintenanceOperationError,
  completeMaintenanceScheduleAs,
  saveHomeAssetAs,
  saveMaintenanceLogAs,
  saveVehicleAs,
  snoozeMaintenanceScheduleAs,
  undoMaintenanceCompletionAs,
  undoMaintenanceSnoozeAs,
} from '../../src/lib/server/maintenance-operations';
import { completeMaintenanceSchedule, snoozeMaintenanceSchedule } from '../../src/app/maintenance/actions';

// M1: the maintenance completion contract through the Admin SDK, against the
// Firestore and Auth emulators (audit 17.3: MA-3 to MA-8, MA-20).
const HOUSE = 'maint-ops-house';
const OTHER = 'maint-ops-other';
const house = () => adminDb.collection('households').doc(HOUSE);
const assets = () => house().collection('home-assets');
const vehicles = () => house().collection('vehicles');
const logs = () => house().collection('maintenance');
const notes = () => house().collection('notifications');

// Noon on Sun Mar 1 2026 in Chicago.
const NOW = new Date('2026-03-01T18:00:00Z');
const ctx = (uid: string, now = NOW) => personalOperationContext({ uid, name: '' }, now);
const SAM = 'mo-sam';
const ALEX = 'mo-alex';

const FILTER = { id: 'filter', mode: 'scheduled', scheduleName: 'Replace filter', frequencyType: 'months', intervalValue: 3, nextDueDate: '2026-03-01' };
const COILS = { scheduleName: 'Clean coils', frequencyType: 'months', intervalValue: 6, nextDueDate: '2026-02-20' };
const OIL = { id: 'oil', mode: 'scheduled', serviceName: 'Oil change', intervalMiles: 5000, intervalMonths: 6, nextDueMileage: 50000, nextDueDate: '2026-06-01' };
const SEEN_FILTER = { nextDueDate: '2026-03-01', nextDueMileage: null };

const complete = (extra: Record<string, unknown> = {}) => ({
  opId: randomUUID(), ownerType: 'home_asset', ownerId: 'hvac', scheduleId: 'filter', seen: SEEN_FILTER, completedDate: '2026-03-01', ...extra,
});
const asset = async () => (await assets().doc('hvac').get()).data()!;
const filterOf = async () => (await asset()).schedules.find((s: { id: string }) => s.id === 'filter');
const hvacLogs = async () => (await logs().where('assetId', '==', 'hvac').get()).docs;

const seed = async () => {
  for (const id of [HOUSE, OTHER]) await adminDb.recursiveDelete(adminDb.collection('households').doc(id));
  await house().set({ name: 'Maintenance ops', ownerUid: SAM, timeZone: 'America/Chicago', memberEmails: [] });
  await house().collection('members').doc(SAM).set({ uid: SAM, role: 'owner', status: 'active', displayName: 'Sam' });
  // A display name that is an email is never stored as the completer (MA-20).
  await house().collection('members').doc(ALEX).set({ uid: ALEX, role: 'member', status: 'active', displayName: 'alex@example.test' });
  await assets().doc('hvac').set({ householdId: HOUSE, name: 'HVAC', category: 'HVAC', status: 'active', schedules: [FILTER, COILS], createdAt: 'x', updatedAt: 'x' });
  await vehicles().doc('car').set({ householdId: HOUSE, nickname: 'Car', status: 'active', currentMileage: 49000, serviceSchedules: [OIL], createdAt: 'x', updatedAt: 'x' });
};

beforeEach(seed);
after(async () => {
  for (const id of [HOUSE, OTHER]) await adminDb.recursiveDelete(adminDb.collection('households').doc(id));
});

describe('completing a schedule', () => {
  test('two sessions with different op ids completing the same cycle together make one log', async () => {
    const [a, b] = await Promise.all([
      completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM)),
      completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(ALEX)),
    ]);
    assert.deepEqual([a.status, b.status].sort(), ['already_done', 'completed']);
    assert.equal((await hvacLogs()).length, 1);
    const loser = a.status === 'already_done' ? a : b;
    assert.ok(loser.status === 'already_done');
    assert.equal(loser.completedDate, '2026-03-01');
    assert.ok(['Sam', 'Member'].includes(loser.byName), 'a name, never an email');
    assert.equal((await filterOf()).nextDueDate, '2026-06-01');
  });

  test('a retry with the same op id replays the stored result and writes nothing', async () => {
    const input = complete();
    const first = await completeMaintenanceScheduleAs(adminDb, HOUSE, input, ctx(SAM));
    const second = await completeMaintenanceScheduleAs(adminDb, HOUSE, input, ctx(SAM));
    assert.ok(first.status === 'completed' && second.status === 'completed');
    assert.equal(first.replay, false);
    assert.equal(second.replay, true);
    assert.equal(second.logId, first.logId);
    assert.equal((await hvacLogs()).length, 1);
    // The same op id from someone else, or for another kind of action, is refused.
    await assert.rejects(completeMaintenanceScheduleAs(adminDb, HOUSE, input, ctx(ALEX)), (error: unknown) => error instanceof MaintenanceOperationError && error.code === 'conflict');
    await assert.rejects(snoozeMaintenanceScheduleAs(adminDb, HOUSE, { opId: input.opId, ownerType: 'home_asset', ownerId: 'hvac', scheduleId: 'filter', seen: SEEN_FILTER }, ctx(SAM)), /conflict/);
  });

  test('the log records the verified actor, server time and the completion; client-sent author fields are ignored', async () => {
    const forged = complete({ doneByUid: 'evil', doneByName: 'Evil', createdAtServer: 'yesterday', lastCompletion: { opId: 'x' }, at: '1999-01-01' });
    const result = await completeMaintenanceScheduleAs(adminDb, HOUSE, forged as never, ctx(ALEX));
    assert.ok(result.status === 'completed');
    const log = (await logs().doc(result.logId).get()).data()!;
    assert.ok(result.logId.endsWith(forged.opId), 'the log id derives from the op id');
    assert.equal(log.doneByUid, ALEX);
    assert.equal(log.doneByName, 'Member', 'an email-like name is never stored');
    assert.ok(log.createdAtServer instanceof Timestamp);
    assert.equal(log.opId, forged.opId);
    assert.equal(log.type, 'routine');
    assert.equal(log.date, '2026-03-01');
    assert.deepEqual(log.completion.cycle, SEEN_FILTER);
    assert.equal(log.completion.scheduleId, 'filter');
    assert.equal(log.completion.after.nextDueDate, '2026-06-01');
    assert.equal(log.completion.before.nextDueDate, '2026-03-01');
    const stored = await filterOf();
    assert.equal(stored.lastCompletion.byUid, ALEX);
    assert.equal(stored.lastCompletion.opId, forged.opId);
    const ledger = (await house().collection('maintenance-ops').doc(forged.opId).get()).data()!;
    assert.equal(ledger.kind, 'complete');
    assert.equal(ledger.actorUid, ALEX);
    assert.ok(ledger.appliedAt instanceof Timestamp);
  });

  test('a stale cycle is "changed"; a future day, no next due and a missing reading are refused', async () => {
    assert.deepEqual(await completeMaintenanceScheduleAs(adminDb, HOUSE, complete({ seen: { nextDueDate: '2026-02-01', nextDueMileage: null } }), ctx(SAM)), { status: 'changed' });
    assert.deepEqual(await completeMaintenanceScheduleAs(adminDb, HOUSE, complete({ completedDate: '2026-03-02' }), ctx(SAM)), { status: 'refused', reason: 'future_date' });
    // 23:30 Mar 1 in Chicago is already Mar 2 in UTC: Mar 2 is still the future.
    assert.deepEqual(await completeMaintenanceScheduleAs(adminDb, HOUSE, complete({ completedDate: '2026-03-02' }), ctx(SAM, new Date('2026-03-02T05:30:00Z'))), { status: 'refused', reason: 'future_date' });
    const oil = { opId: randomUUID(), ownerType: 'vehicle', ownerId: 'car', scheduleId: 'oil', seen: { nextDueDate: '2026-06-01', nextDueMileage: 50000 }, completedDate: '2026-03-01' };
    assert.deepEqual(await completeMaintenanceScheduleAs(adminDb, HOUSE, oil, ctx(SAM)), { status: 'refused', reason: 'mileage_required' });
    await assets().doc('hvac').update({ schedules: [{ ...FILTER, frequencyType: null, intervalValue: null }] });
    assert.deepEqual(await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM)), { status: 'refused', reason: 'next_due_required' });
    assert.equal((await hvacLogs()).length, 0);
    await assert.rejects(completeMaintenanceScheduleAs(adminDb, HOUSE, complete({ opId: 'x' }), ctx(SAM)), /invalid/);
    await assert.rejects(completeMaintenanceScheduleAs(adminDb, HOUSE, complete({ ownerId: 'a/b' }), ctx(SAM)), /invalid/);
  });

  test('a legacy schedule without an id gets its legacy key as a durable id', async () => {
    const result = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete({ scheduleId: 'legacy-1-clean-coils', seen: { nextDueDate: '2026-02-20', nextDueMileage: null } }), ctx(SAM));
    assert.equal(result.status, 'completed');
    const schedules = (await asset()).schedules;
    assert.deepEqual(schedules.map((s: { id: string }) => s.id), ['filter', 'legacy-1-clean-coils']);
    assert.equal(schedules[1].nextDueDate, '2026-09-01');
    assert.equal(schedules[0].nextDueDate, '2026-03-01', 'the other schedule is untouched');
  });

  test('vehicle mileage follows the max rule; ordinary vehicle logs count too', async () => {
    const done = await completeMaintenanceScheduleAs(adminDb, HOUSE, {
      opId: randomUUID(), ownerType: 'vehicle', ownerId: 'car', scheduleId: 'oil', seen: { nextDueDate: '2026-06-01', nextDueMileage: 50000 }, completedDate: '2026-03-01', mileage: 49500,
    }, ctx(SAM));
    assert.ok(done.status === 'completed');
    assert.deepEqual(done.next, { nextDueDate: '2026-09-01', nextDueMileage: 54500 });
    let car = (await vehicles().doc('car').get()).data()!;
    assert.equal(car.currentMileage, 49500);
    assert.equal(car.mileageUpdatedAt, '2026-03-01');
    const lower = await saveMaintenanceLogAs(adminDb, HOUSE, { opId: randomUUID(), values: { targetType: 'vehicle', vehicleId: 'car', title: 'Wipers', date: '2026-02-01', type: 'repair', mileage: 47000 } }, ctx(SAM));
    car = (await vehicles().doc('car').get()).data()!;
    assert.equal(car.currentMileage, 49500, 'a backdated lower reading never rolls it back');
    assert.equal((await logs().doc(lower.id).get()).get('mileage'), 47000, 'the log keeps its own reading');
    await saveMaintenanceLogAs(adminDb, HOUSE, { opId: randomUUID(), values: { targetType: 'vehicle', vehicleId: 'car', title: 'Tires', date: '2026-03-01', type: 'repair', mileage: 52000 } }, ctx(SAM));
    assert.equal((await vehicles().doc('car').get()).get('currentMileage'), 52000);
  });
});

describe('notification cleanup', () => {
  const reminder = (id: string, sourceId: string, stateKey: string) => notes().doc(id).set({
    householdId: HOUSE, category: 'maintenance', title: 'Due', message: 'Due', deepLink: '/maintenance', sourceType: 'maintenance_asset_schedule',
    sourceId, stateKey, audience: ['*'], readBy: {}, dismissedBy: {}, createdAt: Timestamp.fromDate(NOW), expiresAt: Timestamp.fromDate(new Date(NOW.getTime() + 7 * 86400000)),
  });

  test('resolves the completed cycle only, after the commit', async () => {
    await reminder('filter-today', 'hvac:filter', 'due_today|2026-03-01');
    await reminder('filter-legacy', 'hvac-0:due_today', 'due_today|2026-03-01');
    await reminder('coils', 'hvac:legacy-1-clean-coils', 'overdue|2026-02-20');
    const result = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM));
    assert.ok(result.status === 'completed');
    assert.equal(result.cleanup, 'done');
    assert.ok((await notes().doc('filter-today').get()).get('resolvedAt'));
    assert.ok((await notes().doc('filter-legacy').get()).get('resolvedAt'));
    assert.equal((await notes().doc('coils').get()).get('resolvedAt'), undefined, 'another schedule stays open');
    assert.equal((await notes().doc('filter-today').get()).get('resolvedBy').uid, SAM);
  });

  test('a cleanup failure never turns a saved completion into a failure', async () => {
    await reminder('filter-today', 'hvac:filter', 'due_today|2026-03-01');
    const result = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM), {
      cleanup: async () => { throw new Error('notifications unavailable'); },
    });
    assert.ok(result.status === 'completed');
    assert.equal(result.cleanup, 'pending');
    assert.equal((await hvacLogs()).length, 1);
    assert.equal((await filterOf()).nextDueDate, '2026-06-01');
    assert.equal((await notes().doc('filter-today').get()).get('resolvedAt'), undefined, 'left for upkeep');
  });
});

describe('undo', () => {
  test('a rename made after the completion is kept; the due values revert and the log goes', async () => {
    const before = await asset();
    const done = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM));
    assert.ok(done.status === 'completed');
    // Another session, loaded before the completion, renames the schedule.
    const base = { ...before, schedules: [FILTER, { ...COILS, id: 'legacy-1-clean-coils' }] };
    const values = { ...base, schedules: [{ ...FILTER, scheduleName: 'Swap filter' }, base.schedules[1]] };
    await saveHomeAssetAs(adminDb, HOUSE, { opId: randomUUID(), id: 'hvac', base, values }, ctx(ALEX));
    const renamed = await filterOf();
    assert.equal(renamed.scheduleName, 'Swap filter');
    assert.equal(renamed.nextDueDate, '2026-06-01', 'the edit kept the completion');
    const undo = await undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: done.opId }, ctx(SAM));
    assert.deepEqual(undo, { status: 'undone', kept: [] });
    const reverted = await filterOf();
    assert.equal(reverted.scheduleName, 'Swap filter');
    assert.equal(reverted.nextDueDate, '2026-03-01');
    assert.equal('lastCompletion' in reverted, false);
    assert.equal('lastCompletedDate' in reverted, false);
    assert.equal((await hvacLogs()).length, 0);
    assert.deepEqual(await undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: done.opId }, ctx(SAM)), { status: 'already_undone' });
  });

  test('a due date changed since stays and is reported', async () => {
    const done = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM));
    assert.ok(done.status === 'completed');
    const now = await asset();
    const values = { ...now, schedules: now.schedules.map((s: { id: string }) => (s.id === 'filter' ? { ...s, nextDueDate: '2026-07-15' } : s)) };
    await saveHomeAssetAs(adminDb, HOUSE, { opId: randomUUID(), id: 'hvac', base: now, values }, ctx(ALEX));
    const undo = await undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: done.opId }, ctx(SAM));
    assert.deepEqual(undo, { status: 'undone', kept: [{ field: 'nextDueDate', value: '2026-07-15' }] });
    assert.equal((await filterOf()).nextDueDate, '2026-07-15');
  });

  test('completed again since: the first undo is refused (superseded) and changes nothing', async () => {
    const first = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM));
    assert.ok(first.status === 'completed');
    const second = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete({ seen: { nextDueDate: '2026-06-01', nextDueMileage: null } }), ctx(ALEX));
    assert.equal(second.status, 'completed');
    const after = await asset();
    assert.deepEqual(await undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: first.opId }, ctx(SAM)), { status: 'superseded' });
    assert.deepEqual(await asset(), after);
    assert.equal((await hvacLogs()).length, 2);
  });

  test('a schedule deleted meanwhile is not resurrected', async () => {
    const done = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM));
    assert.ok(done.status === 'completed');
    const now = await asset();
    await saveHomeAssetAs(adminDb, HOUSE, { opId: randomUUID(), id: 'hvac', base: now, values: { ...now, schedules: now.schedules.filter((s: { id: string }) => s.id !== 'filter') } }, ctx(ALEX));
    const undo = await undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: done.opId }, ctx(SAM));
    assert.equal(undo.status, 'undone');
    assert.deepEqual((await asset()).schedules.map((s: { id: string }) => s.id), ['legacy-1-clean-coils']);
    assert.equal((await hvacLogs()).length, 0);
  });

  test('only the original actor, only within the window', async () => {
    const done = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM));
    assert.ok(done.status === 'completed');
    await assert.rejects(undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: done.opId }, ctx(ALEX)), /forbidden/);
    assert.deepEqual(await undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: done.opId }, ctx(SAM, new Date(NOW.getTime() + 16_000))), { status: 'expired' });
    assert.equal((await undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: done.opId }, ctx(SAM, new Date(NOW.getTime() + 14_000)))).status, 'undone');
    await assert.rejects(undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: randomUUID() }, ctx(SAM)), /not_found/);
  });
});

describe('snooze', () => {
  test('moves only nextDueDate and snoozedUntil of that schedule; undo reverts it', async () => {
    await assets().doc('hvac').update({ schedules: [{ ...FILTER, nextDueDate: '2026-03-05' }, COILS] });
    const opId = randomUUID();
    const seen = { nextDueDate: '2026-03-05', nextDueMileage: null };
    const result = await snoozeMaintenanceScheduleAs(adminDb, HOUSE, { opId, ownerType: 'home_asset', ownerId: 'hvac', scheduleId: 'filter', seen }, ctx(SAM));
    assert.ok(result.status === 'snoozed');
    assert.equal(result.nextDueDate, '2026-03-12');
    const snoozed = await filterOf();
    assert.deepEqual({ next: snoozed.nextDueDate, until: snoozed.snoozedUntil, name: snoozed.scheduleName }, { next: '2026-03-12', until: '2026-03-12', name: 'Replace filter' });
    // Snoozing the same cycle again (a stale card) is "changed".
    assert.deepEqual(await snoozeMaintenanceScheduleAs(adminDb, HOUSE, { opId: randomUUID(), ownerType: 'home_asset', ownerId: 'hvac', scheduleId: 'filter', seen }, ctx(SAM)), { status: 'changed' });
    const undo = await undoMaintenanceSnoozeAs(adminDb, HOUSE, { opId }, ctx(SAM));
    assert.deepEqual(undo, { status: 'undone', kept: [] });
    const back = await filterOf();
    assert.equal(back.nextDueDate, '2026-03-05');
    assert.equal('snoozedUntil' in back, false);
  });

  test('a mileage-due service cannot be snoozed', async () => {
    await vehicles().doc('car').update({ currentMileage: 49800, serviceSchedules: [{ ...OIL, nextDueDate: '2026-03-05' }] });
    const result = await snoozeMaintenanceScheduleAs(adminDb, HOUSE, { opId: randomUUID(), ownerType: 'vehicle', ownerId: 'car', scheduleId: 'oil', seen: { nextDueDate: '2026-03-05', nextDueMileage: 50000 } }, ctx(SAM));
    assert.deepEqual(result, { status: 'refused', reason: 'not_snoozable' });
  });
});

describe('edits', () => {
  test('two people editing different fields of the same asset both survive', async () => {
    const base = { ...(await asset()), schedules: [FILTER, { ...COILS, id: 'legacy-1-clean-coils' }] };
    await saveHomeAssetAs(adminDb, HOUSE, { opId: randomUUID(), id: 'hvac', base, values: { ...base, name: 'Main HVAC' } }, ctx(SAM));
    await saveHomeAssetAs(adminDb, HOUSE, { opId: randomUUID(), id: 'hvac', base, values: { ...base, schedules: [{ ...FILTER, intervalValue: 6 }, base.schedules[1]] } }, ctx(ALEX));
    const stored = await asset();
    assert.equal(stored.name, 'Main HVAC');
    assert.equal(stored.schedules[0].intervalValue, 6);
    assert.equal(stored.schedules[1].id, 'legacy-1-clean-coils', 'legacy ids assigned on first touch');
  });

  test('new records get ids that cannot collide, and a retry does not duplicate them', async () => {
    const opId = randomUUID();
    const values = { name: 'Water heater', category: 'Plumbing', status: 'active', schedules: [] };
    const a = await saveHomeAssetAs(adminDb, HOUSE, { opId, values }, ctx(SAM));
    const again = await saveHomeAssetAs(adminDb, HOUSE, { opId, values }, ctx(SAM));
    const b = await saveHomeAssetAs(adminDb, HOUSE, { opId: randomUUID(), values }, ctx(SAM));
    assert.equal(again.id, a.id);
    assert.equal(again.replay, true);
    assert.notEqual(a.id, b.id);
    assert.match(a.id, /^water-heater-[a-z0-9]{10}$/);
    const vehicle = await saveVehicleAs(adminDb, HOUSE, { opId: randomUUID(), values: { nickname: 'Van', status: 'active', currentMileage: 1000, serviceSchedules: [] } }, ctx(SAM));
    assert.equal((await vehicles().doc(vehicle.id).get()).get('mileageUpdatedAt'), '2026-03-01');
  });

  test('a log edit never changes its author or completion record; a deleted record is not recreated', async () => {
    const done = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM));
    assert.ok(done.status === 'completed');
    const log = (await logs().doc(done.logId).get()).data()!;
    const base = { targetType: 'home_asset', assetId: 'hvac', title: log.title, date: log.date, type: log.type };
    await saveMaintenanceLogAs(adminDb, HOUSE, { opId: randomUUID(), id: done.logId, base, values: { ...base, notes: 'Used MERV 11', doneByUid: 'evil', completion: null } as never }, ctx(ALEX));
    const edited = (await logs().doc(done.logId).get()).data()!;
    assert.equal(edited.notes, 'Used MERV 11');
    assert.equal(edited.doneByUid, SAM);
    assert.deepEqual(edited.completion, log.completion);
    await logs().doc(done.logId).delete();
    await assert.rejects(saveMaintenanceLogAs(adminDb, HOUSE, { opId: randomUUID(), id: done.logId, base, values: { ...base, notes: 'x' } }, ctx(ALEX)), /not_found/);
    await assets().doc('gone').delete();
    await assert.rejects(saveHomeAssetAs(adminDb, HOUSE, { opId: randomUUID(), id: 'gone', base: { name: 'x' }, values: { name: 'y' } }, ctx(ALEX)), /not_found/);
  });
});

describe('review of PR #210', () => {
  test('a mileage edit counts for the vehicle the log points at now, not the one the form showed', async () => {
    await vehicles().doc('van').set({ householdId: HOUSE, nickname: 'Van', status: 'active', currentMileage: 10000, serviceSchedules: [] });
    const created = await saveMaintenanceLogAs(adminDb, HOUSE, { opId: randomUUID(), values: { targetType: 'vehicle', vehicleId: 'car', title: 'Wipers', date: '2026-03-01', type: 'repair', mileage: 48000 } }, ctx(SAM));
    const base = { targetType: 'vehicle', vehicleId: 'car', title: 'Wipers', date: '2026-03-01', type: 'repair', mileage: 48000 };
    // Alex moves the log to the van; Sam, whose form still shows the car, corrects the reading.
    await saveMaintenanceLogAs(adminDb, HOUSE, { opId: randomUUID(), id: created.id, base, values: { ...base, vehicleId: 'van' } }, ctx(ALEX));
    await saveMaintenanceLogAs(adminDb, HOUSE, { opId: randomUUID(), id: created.id, base, values: { ...base, mileage: 60000 } }, ctx(SAM));
    const log = (await logs().doc(created.id).get()).data()!;
    assert.deepEqual({ vehicleId: log.vehicleId, mileage: log.mileage }, { vehicleId: 'van', mileage: 60000 });
    assert.equal((await vehicles().doc('car').get()).get('currentMileage'), 49000, "the car's odometer is untouched");
    assert.equal((await vehicles().doc('van').get()).get('currentMileage'), 60000, 'the van gets the reading');
  });

  test('a completion whose log has attached files cannot be undone; nothing changes', async () => {
    const done = await completeMaintenanceScheduleAs(adminDb, HOUSE, complete(), ctx(SAM));
    assert.ok(done.status === 'completed');
    await house().collection('maintenance-attachments').doc('receipt').set({
      householdId: HOUSE, targetType: 'maintenance_log', targetId: done.logId, category: 'receipt', fileName: 'r.pdf',
      filePath: `households/${HOUSE}/maintenance/maintenance_log/${done.logId}/r.pdf`, uploadedByUid: SAM, createdAt: 'x',
    });
    const before = await asset();
    assert.deepEqual(await undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: done.opId }, ctx(SAM)), { status: 'has_attachments' });
    assert.deepEqual(await asset(), before);
    assert.ok((await logs().doc(done.logId).get()).exists, 'the log and its files stay');
    assert.equal((await house().collection('maintenance-ops').doc(done.opId).get()).get('undoneAt'), null);
    // Files of another log do not block it.
    await house().collection('maintenance-attachments').doc('receipt').update({ targetId: 'other-log' });
    assert.equal((await undoMaintenanceCompletionAs(adminDb, HOUSE, { opId: done.opId }, ctx(SAM))).status, 'undone');
  });
});

describe('server actions', () => {
  const USERS = {
    editor: { uid: 'mo-editor', email: 'mo.editor@example.test' },
    viewer: { uid: 'mo-viewer', email: 'mo.viewer@example.test' },
    outsider: { uid: 'mo-outsider', email: 'mo.outsider@example.test' },
  } as const;
  const tokens = new Map<string, string>();
  const idTokenFor = async (uid: string, email: string) => {
    await adminAuth.deleteUser(uid).catch(() => undefined);
    await adminAuth.createUser({ uid, email });
    const customToken = await adminAuth.createCustomToken(uid);
    const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    return ((await response.json()) as { idToken: string }).idToken;
  };
  before(async () => {
    for (const { uid, email } of Object.values(USERS)) tokens.set(uid, await idTokenFor(uid, email));
  });
  // The server actions run at the e2e pinned instant (HOMEHUB_TEST_NOW, Aug 1 2026).
  const seedMembers = async () => {
    await house().collection('members').doc(USERS.editor.uid).set({
      uid: USERS.editor.uid, role: 'member', status: 'active', displayName: 'Eddie',
      permissions: { 'maintenance.edit': true, 'maintenance.createLogs': true, 'notifications.view': false },
    });
    await house().collection('members').doc(USERS.viewer.uid).set({
      uid: USERS.viewer.uid, role: 'member', status: 'active', displayName: 'Vic', permissions: { 'maintenance.edit': false },
    });
    await adminDb.collection('households').doc(OTHER).set({ name: 'Other', ownerUid: USERS.outsider.uid, timeZone: 'America/Chicago' });
    await adminDb.collection('households').doc(OTHER).collection('members').doc(USERS.outsider.uid).set({ uid: USERS.outsider.uid, role: 'owner', status: 'active', displayName: 'Out' });
    await assets().doc('hvac').update({ schedules: [{ ...FILTER, nextDueDate: '2026-08-01' }] });
    await notes().doc('filter-today').set({
      householdId: HOUSE, category: 'maintenance', title: 'Due', message: 'Due', deepLink: '/maintenance', sourceType: 'maintenance_asset_schedule',
      sourceId: 'hvac:filter', stateKey: 'due_today|2026-08-01', audience: ['*'], readBy: {}, dismissedBy: {},
      createdAt: Timestamp.fromDate(new Date('2026-08-01T08:00:00Z')), expiresAt: Timestamp.fromDate(new Date('2026-08-08T08:00:00Z')),
    });
  };
  const completion = () => ({ opId: randomUUID(), ownerType: 'home_asset', ownerId: 'hvac', scheduleId: 'filter', seen: { nextDueDate: '2026-08-01', nextDueMileage: null }, completedDate: '2026-08-01' });

  test('a member with edit and createLogs but no notifications.view completes, and the reminder resolves', async () => {
    await seedMembers();
    const result = await completeMaintenanceSchedule({ idToken: tokens.get(USERS.editor.uid)!, householdId: HOUSE, completion: completion() });
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.data.status === 'completed');
    assert.equal(result.data.cleanup, 'done');
    assert.ok((await notes().doc('filter-today').get()).get('resolvedAt'));
    const log = (await logs().doc(result.data.logId).get()).data()!;
    assert.equal(log.doneByUid, USERS.editor.uid);
    assert.equal(log.doneByName, 'Eddie');
  });

  test('a member without maintenance.edit, an outsider and a bad token are refused', async () => {
    await seedMembers();
    const viewer = await completeMaintenanceSchedule({ idToken: tokens.get(USERS.viewer.uid)!, householdId: HOUSE, completion: completion() });
    assert.deepEqual(viewer.ok ? null : viewer.code, 'forbidden');
    const snooze = await snoozeMaintenanceSchedule({ idToken: tokens.get(USERS.viewer.uid)!, householdId: HOUSE, snooze: { opId: randomUUID(), ownerType: 'home_asset', ownerId: 'hvac', scheduleId: 'filter', seen: { nextDueDate: '2026-08-01', nextDueMileage: null } } });
    assert.equal(snooze.ok ? null : snooze.code, 'forbidden');
    const outsider = await completeMaintenanceSchedule({ idToken: tokens.get(USERS.outsider.uid)!, householdId: HOUSE, completion: completion() });
    assert.equal(outsider.ok ? null : outsider.code, 'forbidden');
    // Their own household has no such asset: nothing leaks across households.
    const own = await completeMaintenanceSchedule({ idToken: tokens.get(USERS.outsider.uid)!, householdId: OTHER, completion: completion() });
    assert.ok(own.ok && own.data.status === 'gone');
    const forged = await completeMaintenanceSchedule({ idToken: 'not-a-token', householdId: HOUSE, completion: completion() });
    assert.equal(forged.ok ? null : forged.code, 'unauthenticated');
    const huge = await completeMaintenanceSchedule({ idToken: tokens.get(USERS.editor.uid)!, householdId: HOUSE, completion: { ...completion(), notes: 'x'.repeat(200_000) } });
    assert.equal(huge.ok ? null : huge.code, 'invalid');
    assert.equal((await hvacLogs()).length, 0);
  });
});
