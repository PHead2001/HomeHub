import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ASSET_SCHEDULE_FIELDS,
  cycleOf,
  isRealDay,
  legacyScheduleKey,
  mergeSchedules,
  mileagePatch,
  mileageWarning,
  planCompletion,
  planRecordEdit,
  planSnooze,
  planUndoCompletion,
  planUndoSnooze,
  sameCycle,
  sameValue,
  scheduleRef,
  withScheduleIds,
  type MaintenanceCycle,
  type StoredSchedule,
} from '../../src/lib/maintenance/operations';
import { callWithDeadline, createPendingRequests, mileageWarningMessage, undoOfferMs, MIN_UNDO_OFFER_MS } from '../../src/lib/maintenance/action-call';

// M1: the maintenance completion contract, as pure plans (the server applies them
// in one transaction: src/lib/server/maintenance-operations.ts).
const TZ = 'America/Chicago';
const who = (opId: string) => ({ opId, byUid: 'u1', byName: 'Sam', completedDate: '', at: '2026-03-01T15:00:00.000Z' });
const filter = (extra: Partial<StoredSchedule> = {}): StoredSchedule => ({
  id: 'filter', mode: 'scheduled', scheduleName: 'Replace filter', frequencyType: 'months', intervalValue: 3, nextDueDate: '2026-03-01', ...extra,
});
const oil = (extra: Partial<StoredSchedule> = {}): StoredSchedule => ({
  id: 'oil', mode: 'scheduled', serviceName: 'Oil change', intervalMiles: 5000, intervalMonths: 6, nextDueMileage: 50000, nextDueDate: '2026-06-01', ...extra,
});

describe('schedule identity', () => {
  test('legacy schedules get their legacy key as a durable id, idempotently', () => {
    const { list, assigned } = withScheduleIds([{ scheduleName: 'Clean coils' }, { id: 'kept', scheduleName: 'x' }, { scheduleName: 'Clean coils' }], 'home_asset');
    assert.equal(assigned, 2);
    assert.deepEqual(list.map(s => s.id), ['legacy-0-clean-coils', 'kept', 'legacy-2-clean-coils']);
    assert.equal(list[0].id, legacyScheduleKey({ scheduleName: 'Clean coils' }, 0, 'home_asset'));
    assert.equal(withScheduleIds(list, 'home_asset').assigned, 0);
    // The client names an id-less schedule by the same key.
    assert.equal(scheduleRef({ scheduleName: 'Clean coils' }, 2, 'home_asset'), 'legacy-2-clean-coils');
    // An unnamed vehicle service uses the reminder builder's default title.
    assert.equal(withScheduleIds([{}], 'vehicle').list[0].id, 'legacy-0-scheduled-service');
  });

  test('a taken legacy key gets a suffix', () => {
    const { list } = withScheduleIds([{ id: 'legacy-1-a', scheduleName: 'b' }, { scheduleName: 'a' }], 'home_asset');
    assert.equal(list[1].id, 'legacy-1-a-2');
  });

  test('real days only', () => {
    assert.equal(isRealDay('2026-02-28'), true);
    assert.equal(isRealDay('2026-02-30'), false);
    assert.equal(isRealDay('2026-2-3'), false);
    assert.equal(isRealDay(20260101), false);
  });
});

describe('completion plan', () => {
  const seen: MaintenanceCycle = { nextDueDate: '2026-03-01', nextDueMileage: null };

  test('advances by the interval, ends a snooze and records exactly what changed', () => {
    const plan = planCompletion({ ownerType: 'home_asset', schedule: filter({ snoozedUntil: '2026-03-01', lastCompletedDate: '2025-12-01' }), seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op1') });
    assert.equal(plan.kind, 'apply');
    if (plan.kind !== 'apply') return;
    assert.equal(plan.schedule.nextDueDate, '2026-06-01');
    assert.equal(plan.schedule.lastCompletedDate, '2026-03-01');
    assert.equal('snoozedUntil' in plan.schedule, false);
    assert.equal(plan.schedule.scheduleName, 'Replace filter');
    assert.deepEqual(Object.keys(plan.record.after).sort(), ['lastCompletedDate', 'lastCompletion', 'nextDueDate', 'snoozedUntil']);
    assert.equal(plan.record.before.snoozedUntil, '2026-03-01');
    assert.equal(plan.record.after.snoozedUntil, null);
    assert.deepEqual(plan.record.cycle, seen);
    assert.deepEqual(plan.next, { nextDueDate: '2026-06-01', nextDueMileage: null });
  });

  test('a cycle is completed once: the second request learns who did it', () => {
    const first = planCompletion({ ownerType: 'home_asset', schedule: filter(), seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op1') });
    assert.ok(first.kind === 'apply');
    const second = planCompletion({ ownerType: 'home_asset', schedule: first.schedule, seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op2') });
    assert.equal(second.kind, 'already_done');
    if (second.kind === 'already_done') assert.equal(second.lastCompletion.byName, 'Sam');
  });

  test('a completion that leaves the due date as it was still counts once', () => {
    // The completion dialog prefills the current due date when there is no interval.
    const schedule = filter({ frequencyType: undefined, intervalValue: undefined });
    const first = planCompletion({ ownerType: 'home_asset', schedule, seen, values: { completedDate: '2026-03-01', nextDueDate: '2026-03-01' }, today: '2026-03-01', completion: who('op1') });
    assert.ok(first.kind === 'apply');
    assert.ok(sameCycle(cycleOf(first.schedule), seen));
    const second = planCompletion({ ownerType: 'home_asset', schedule: first.schedule, seen, values: { completedDate: '2026-03-01', nextDueDate: '2026-03-01' }, today: '2026-03-01', completion: who('op2') });
    assert.equal(second.kind, 'already_done');
  });

  test('a cycle that moved on otherwise is "changed"', () => {
    const plan = planCompletion({ ownerType: 'home_asset', schedule: filter({ nextDueDate: '2026-04-01' }), seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op1') });
    assert.equal(plan.kind, 'changed');
  });

  test('validation: real day, not after today, next due required', () => {
    const base = { ownerType: 'home_asset' as const, schedule: filter(), seen, today: '2026-03-01', completion: who('op1') };
    assert.deepEqual(planCompletion({ ...base, values: { completedDate: '2026-02-30' } }), { kind: 'refused', reason: 'invalid_date' });
    assert.deepEqual(planCompletion({ ...base, values: { completedDate: '2026-03-02' } }), { kind: 'refused', reason: 'future_date' });
    const noInterval = { ...base, schedule: filter({ frequencyType: undefined, intervalValue: undefined }) };
    assert.deepEqual(planCompletion({ ...noInterval, values: { completedDate: '2026-03-01' } }), { kind: 'refused', reason: 'next_due_required' });
    assert.equal(planCompletion({ ...noInterval, values: { completedDate: '2026-03-01', nextDueDate: '2027-01-01' } }).kind, 'apply');
    assert.deepEqual(planCompletion({ ...noInterval, values: { completedDate: '2026-03-01', nextDueDate: '2027-13-01' } }), { kind: 'refused', reason: 'invalid_next_due' });
  });

  test('a mileage-driven service needs a reading; next due mileage must be ahead of it', () => {
    const base = { ownerType: 'vehicle' as const, schedule: oil(), seen: { nextDueDate: '2026-06-01', nextDueMileage: 50000 }, today: '2026-03-01', completion: who('op1'), vehicle: { currentMileage: 49000 } };
    assert.deepEqual(planCompletion({ ...base, values: { completedDate: '2026-03-01' } }), { kind: 'refused', reason: 'mileage_required' });
    assert.deepEqual(planCompletion({ ...base, values: { completedDate: '2026-03-01', mileage: 49000.5 } }), { kind: 'refused', reason: 'invalid_mileage' });
    assert.deepEqual(planCompletion({ ...base, values: { completedDate: '2026-03-01', mileage: 2_000_001 } }), { kind: 'refused', reason: 'invalid_mileage' });
    assert.deepEqual(planCompletion({ ...base, values: { completedDate: '2026-03-01', mileage: 49500, nextDueMileage: 49500 } }), { kind: 'refused', reason: 'next_due_mileage_low' });
    const plan = planCompletion({ ...base, values: { completedDate: '2026-03-01', mileage: 49500 } });
    assert.ok(plan.kind === 'apply');
    assert.deepEqual(plan.next, { nextDueDate: '2026-09-01', nextDueMileage: 54500 });
    assert.equal(plan.schedule.lastCompletedMileage, 49500);
    assert.deepEqual(plan.vehiclePatch, { currentMileage: 49500, mileageUpdatedAt: '2026-03-01' });
    assert.equal(plan.record.before.currentMileage, 49000);
    assert.equal(plan.record.after.currentMileage, 49500);
  });

  test('a lower reading never rolls the vehicle back (the log keeps its own reading)', () => {
    const plan = planCompletion({ ownerType: 'vehicle', schedule: oil(), seen: { nextDueDate: '2026-06-01', nextDueMileage: 50000 }, values: { completedDate: '2026-02-01', mileage: 47000 }, today: '2026-03-01', completion: who('op1'), vehicle: { currentMileage: 49000 } });
    assert.ok(plan.kind === 'apply');
    assert.deepEqual(plan.vehiclePatch, {});
    assert.equal('currentMileage' in plan.record.after, false);
    assert.deepEqual(mileagePatch({ currentMileage: 49000 }, 49000, '2026-03-01'), { mileageUpdatedAt: '2026-03-01' });
    assert.deepEqual(mileagePatch({}, 10, '2026-03-01'), { currentMileage: 10, mileageUpdatedAt: '2026-03-01' });
  });

  test('mileage warnings: lower, or more than 20,000 above', () => {
    assert.equal(mileageWarning(48000, 49000), 'lower');
    assert.equal(mileageWarning(69001, 49000), 'jump');
    assert.equal(mileageWarning(69000, 49000), null);
    assert.equal(mileageWarning(undefined, 49000), null);
  });
});

describe('undo plan (compare-and-revert)', () => {
  const seen: MaintenanceCycle = { nextDueDate: '2026-03-01', nextDueMileage: null };
  const completed = () => {
    const plan = planCompletion({ ownerType: 'home_asset', schedule: filter(), seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op1') });
    assert.ok(plan.kind === 'apply');
    return plan;
  };

  test('a rename made after the completion is kept; the due values go back', () => {
    const plan = completed();
    const renamed = { ...plan.schedule, scheduleName: 'Swap filter' };
    const undo = planUndoCompletion({ opId: 'op1', schedule: renamed, record: plan.record });
    assert.ok(undo.kind === 'apply');
    assert.equal(undo.schedule!.scheduleName, 'Swap filter');
    assert.equal(undo.schedule!.nextDueDate, '2026-03-01');
    assert.equal('lastCompletion' in undo.schedule!, false);
    assert.deepEqual(undo.kept, []);
  });

  test('a due date changed after the completion stays and is reported', () => {
    const plan = completed();
    const moved = { ...plan.schedule, nextDueDate: '2026-07-15' };
    const undo = planUndoCompletion({ opId: 'op1', schedule: moved, record: plan.record });
    assert.ok(undo.kind === 'apply');
    assert.equal(undo.schedule!.nextDueDate, '2026-07-15');
    assert.deepEqual(undo.kept, [{ field: 'nextDueDate', value: '2026-07-15' }]);
    assert.equal('lastCompletedDate' in undo.schedule!, false, 'the other fields still revert');
  });

  test('a schedule completed again since is left alone (superseded)', () => {
    const plan = completed();
    const again = planCompletion({ ownerType: 'home_asset', schedule: plan.schedule, seen: cycleOf(plan.schedule), values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op2') });
    assert.ok(again.kind === 'apply');
    assert.deepEqual(planUndoCompletion({ opId: 'op1', schedule: again.schedule, record: plan.record }), { kind: 'superseded' });
  });

  test('a deleted schedule stays deleted; a vehicle reading raised later stays', () => {
    const plan = planCompletion({ ownerType: 'vehicle', schedule: oil(), seen: { nextDueDate: '2026-06-01', nextDueMileage: 50000 }, values: { completedDate: '2026-03-01', mileage: 49500 }, today: '2026-03-01', completion: who('op1'), vehicle: { currentMileage: 49000 } });
    assert.ok(plan.kind === 'apply');
    const undo = planUndoCompletion({ opId: 'op1', schedule: null, vehicle: { currentMileage: 52000, mileageUpdatedAt: '2026-03-02' }, record: plan.record });
    assert.ok(undo.kind === 'apply');
    assert.equal(undo.schedule, null);
    assert.deepEqual(undo.vehiclePatch, {});
    assert.deepEqual(undo.kept, [{ field: 'currentMileage', value: 52000 }]);
    const untouched = planUndoCompletion({ opId: 'op1', schedule: plan.schedule, vehicle: { currentMileage: 49500, mileageUpdatedAt: '2026-03-01' }, record: plan.record });
    assert.ok(untouched.kind === 'apply');
    assert.deepEqual(untouched.vehiclePatch, { currentMileage: 49000, mileageUpdatedAt: null });
  });
});

describe('snooze plan', () => {
  test('moves a date-driven schedule a week and is undone by compare-and-revert', () => {
    const schedule = filter({ nextDueDate: '2026-03-05' });
    const plan = planSnooze({ ownerType: 'home_asset', owner: { id: 'hvac', name: 'HVAC' }, schedule, seen: cycleOf(schedule), today: '2026-03-01', timeZone: TZ });
    assert.ok(plan.kind === 'apply');
    assert.equal(plan.nextDueDate, '2026-03-12');
    assert.deepEqual(plan.after, { nextDueDate: '2026-03-12', snoozedUntil: '2026-03-12', snoozedFrom: '2026-03-05' });
    assert.deepEqual(plan.before, { nextDueDate: '2026-03-05', snoozedUntil: null, snoozedFrom: null });
    const undone = planUndoSnooze(plan.schedule, plan.before, plan.after);
    assert.deepEqual(undone.schedule, schedule);
    // Renamed meanwhile: the name stays, the snooze goes.
    const renamed = planUndoSnooze({ ...plan.schedule, scheduleName: 'New' }, plan.before, plan.after);
    assert.equal(renamed.schedule.scheduleName, 'New');
    assert.equal(renamed.schedule.nextDueDate, '2026-03-05');
  });

  test('upcoming reminders and mileage-due services cannot be snoozed; a stale cycle is "changed"', () => {
    const far = filter({ nextDueDate: '2026-09-01' });
    assert.deepEqual(planSnooze({ ownerType: 'home_asset', owner: { id: 'hvac', name: 'HVAC' }, schedule: far, seen: cycleOf(far), today: '2026-03-01', timeZone: TZ }), { kind: 'refused', reason: 'not_snoozable' });
    const service = oil({ nextDueDate: '2026-03-05' });
    assert.deepEqual(planSnooze({ ownerType: 'vehicle', owner: { id: 'car', nickname: 'Car', currentMileage: 49800 }, schedule: service, seen: cycleOf(service), today: '2026-03-01', timeZone: TZ }), { kind: 'refused', reason: 'not_snoozable' });
    assert.equal(planSnooze({ ownerType: 'vehicle', owner: { id: 'car', nickname: 'Car', currentMileage: 40000 }, schedule: service, seen: cycleOf(service), today: '2026-03-01', timeZone: TZ }).kind, 'apply');
    assert.deepEqual(planSnooze({ ownerType: 'home_asset', owner: { id: 'hvac', name: 'HVAC' }, schedule: far, seen: { nextDueDate: '2026-03-05', nextDueMileage: null }, today: '2026-03-01', timeZone: TZ }), { kind: 'changed' });
  });
});

describe('snoozedFrom (M3, PR #209)', () => {
  test('a snooze records the due date it moved from, and Undo reverts all three fields', () => {
    const schedule = filter({ nextDueDate: '2026-03-05' });
    const plan = planSnooze({ ownerType: 'home_asset', owner: { id: 'hvac', name: 'HVAC' }, schedule, seen: cycleOf(schedule), today: '2026-03-01', timeZone: TZ });
    assert.ok(plan.kind === 'apply');
    assert.equal(plan.schedule.snoozedFrom, '2026-03-05');
    const undone = planUndoSnooze(plan.schedule, plan.before, plan.after);
    assert.deepEqual(undone.schedule, schedule, 'no snoozedFrom left behind');
    // A field changed since keeps its value (compare-and-revert).
    const edited = planUndoSnooze({ ...plan.schedule, snoozedFrom: '2026-03-04' }, plan.before, plan.after);
    assert.equal(edited.schedule.snoozedFrom, '2026-03-04');
    assert.deepEqual(edited.kept.map(entry => entry.field), ['snoozedFrom']);
  });

  test('a snooze still in effect keeps the date it was first snoozed from', () => {
    const snoozed = filter({ nextDueDate: '2026-03-02', snoozedUntil: '2026-03-02', snoozedFrom: '2026-02-23' });
    const plan = planSnooze({ ownerType: 'home_asset', owner: { id: 'hvac', name: 'HVAC' }, schedule: snoozed, seen: cycleOf(snoozed), today: '2026-03-02', timeZone: TZ });
    if (plan.kind !== 'apply') return; // not snoozable again: nothing to check
    assert.equal(plan.schedule.snoozedFrom, '2026-02-23');
  });

  test('completion removes snoozedFrom and records it in before/after; Undo puts it back', () => {
    const schedule = filter({ nextDueDate: '2026-03-08', snoozedUntil: '2026-03-08', snoozedFrom: '2026-03-01' });
    const seen = cycleOf(schedule);
    const plan = planCompletion({ ownerType: 'home_asset', schedule, seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op1') });
    assert.ok(plan.kind === 'apply');
    assert.equal(plan.schedule.snoozedFrom, undefined);
    assert.equal(plan.schedule.snoozedUntil, undefined);
    assert.equal(plan.record.before.snoozedFrom, '2026-03-01');
    assert.equal(plan.record.after.snoozedFrom, null);
    const undo = planUndoCompletion({ opId: 'op1', schedule: plan.schedule, vehicle: null, record: plan.record });
    assert.ok(undo.kind === 'apply');
    assert.equal(undo.schedule?.snoozedFrom, '2026-03-01');
  });

  test('edit forms carry snoozedFrom through: an unrelated edit never sends it', () => {
    assert.ok((ASSET_SCHEDULE_FIELDS as readonly string[]).includes('snoozedFrom'));
    const stored = [filter({ nextDueDate: '2026-03-08', snoozedUntil: '2026-03-08', snoozedFrom: '2026-03-01' })];
    const base = stored;
    const values = [{ ...stored[0], scheduleName: 'Renamed' }];
    const merged = mergeSchedules(stored, base, values, ASSET_SCHEDULE_FIELDS);
    assert.deepEqual({ ...merged[0] }, { ...stored[0], scheduleName: 'Renamed' });
  });
});

describe('edits merge by id', () => {
  const stored = [filter(), { id: 'coils', mode: 'checklist', scheduleName: 'Clean coils' }];

  test('two people editing different fields both survive', () => {
    const base = stored.map(s => ({ ...s }));
    const alex = base.map(s => (s.id === 'filter' ? { ...s, scheduleName: 'Swap filter' } : s));
    const afterAlex = mergeSchedules(stored, base, alex, ASSET_SCHEDULE_FIELDS);
    const sam = base.map(s => (s.id === 'filter' ? { ...s, intervalValue: 6 } : s));
    const afterSam = mergeSchedules(afterAlex, base, sam, ASSET_SCHEDULE_FIELDS);
    assert.equal(afterSam[0].scheduleName, 'Swap filter');
    assert.equal(afterSam[0].intervalValue, 6);
  });

  test('a completion meanwhile survives an unrelated edit; removed stays removed; added meanwhile is kept', () => {
    const base = stored.map(s => ({ ...s }));
    const meanwhile = [
      { ...stored[0], nextDueDate: '2026-06-01', lastCompletedDate: '2026-03-01', lastCompletion: { opId: 'x', cycle: { nextDueDate: '2026-03-01', nextDueMileage: null } } },
      { id: 'drain', scheduleName: 'Drain pan', mode: 'checklist' },
    ];
    // The form renamed the filter and removed the coils (already removed meanwhile).
    const values = [{ ...base[0], scheduleName: 'Swap filter' }, { id: 'new1', mode: 'checklist', scheduleName: 'Check belt', nextDueDate: null }];
    const merged = mergeSchedules(meanwhile, base, values, ASSET_SCHEDULE_FIELDS);
    assert.deepEqual(merged.map(s => s.id), ['filter', 'drain', 'new1']);
    assert.equal(merged[0].nextDueDate, '2026-06-01');
    assert.equal(merged[0].scheduleName, 'Swap filter');
    assert.ok(merged[0].lastCompletion);
    assert.equal('nextDueDate' in merged[2], false, 'no nulls stored');
  });

  test('record edits patch only what the form changed', () => {
    const plan = planRecordEdit({
      stored: { name: 'HVAC', notes: 'changed by someone else', location: 'Attic' },
      base: { name: 'HVAC', notes: 'old', location: 'Attic' },
      values: { name: 'HVAC', notes: 'old', location: '' },
      fields: ['name', 'notes', 'location'],
    });
    assert.deepEqual(plan.patch, { location: null });
    assert.equal(planRecordEdit({ stored: {}, base: { a: 1 }, values: { a: 1 }, fields: ['a'] }).changed, false);
  });
});

describe('randomized interleavings', () => {
  // A tiny deterministic generator, so a failure is reproducible from its seed.
  const rng = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const days = ['2026-03-01', '2026-03-05', '2026-03-20', '2026-04-10', '2026-06-01'];

  for (let seed = 1; seed <= 40; seed += 1) {
    test(`sequence ${seed}`, () => {
      const random = rng(seed);
      const pickOne = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
      let schedule: StoredSchedule = filter();
      let today = days[0];
      // Occurrences: a cycle is identified by its due values, so the model numbers each
      // state a session can see; a completion completes the occurrence it saw.
      let occurrence = 0;
      const seenOccurrences: Array<{ occurrence: number; cycle: MaintenanceCycle }> = [{ occurrence, cycle: cycleOf(schedule) }];
      const advance = () => {
        occurrence += 1;
        seenOccurrences.push({ occurrence, cycle: cycleOf(schedule) });
      };
      const completedOccurrences = new Map<string, number>();
      type Entry = { opId: string; kind: 'complete' | 'snooze'; occurrence: number; seen: MaintenanceCycle; record?: { before: Record<string, unknown>; after: Record<string, unknown> }; before?: Record<string, unknown>; after?: Record<string, unknown>; undone: boolean };
      const ledger: Entry[] = [];
      // Fields edited by someone after each op: an undo must never revert them.
      const editedSince = new Map<string, Map<string, unknown>>();
      for (let step = 0; step < 60; step += 1) {
        const roll = random();
        if (roll < 0.1) today = days[Math.min(days.indexOf(today) + 1, days.length - 1)];
        if (roll < 0.45) {
          // Complete what some session saw (maybe stale), with a fresh op id.
          const opId = `c${step}`;
          const seen = pickOne(seenOccurrences);
          const plan = planCompletion({ ownerType: 'home_asset', schedule, seen: seen.cycle, values: { completedDate: today }, today, completion: { ...who(opId), byName: 'P' } });
          if (plan.kind === 'apply') {
            // The values matched, so the current occurrence is the one completed.
            assert.equal([...completedOccurrences.values()].includes(occurrence), false, 'never two completions of one occurrence');
            const completedOccurrence = occurrence;
            schedule = plan.schedule;
            completedOccurrences.set(opId, completedOccurrence);
            ledger.push({ opId, kind: 'complete', occurrence: completedOccurrence, seen: seen.cycle, record: plan.record, undone: false });
            editedSince.set(opId, new Map());
            const next = cycleOf(schedule);
            assert.ok(next.nextDueDate !== null || next.nextDueMileage !== null, 'next due always present');
            // A second session completing the same cycle together gets "already done".
            const twin = planCompletion({ ownerType: 'home_asset', schedule, seen: seen.cycle, values: { completedDate: today }, today, completion: who(`${opId}-twin`) });
            assert.equal(twin.kind, 'already_done');
            advance();
          }
        } else if (roll < 0.65) {
          // Someone edits the name or the due date through the form (merge by id).
          const field = random() < 0.5 ? 'scheduleName' : 'nextDueDate';
          const value = field === 'scheduleName' ? `Name ${step}` : pickOne(days);
          const base = [{ ...schedule }];
          const values = [{ ...schedule, [field]: value }];
          const previous = cycleOf(schedule);
          [schedule] = mergeSchedules([schedule], base, values, ASSET_SCHEDULE_FIELDS);
          for (const edits of editedSince.values()) edits.set(field, value);
          if (!sameCycle(previous, cycleOf(schedule))) advance();
        } else if (roll < 0.8) {
          const opId = `s${step}`;
          const plan = planSnooze({ ownerType: 'home_asset', owner: { id: 'hvac', name: 'HVAC' }, schedule, seen: cycleOf(schedule), today, timeZone: TZ });
          if (plan.kind === 'apply') {
            schedule = plan.schedule;
            ledger.push({ opId, kind: 'snooze', occurrence, seen: cycleOf(schedule), before: plan.before, after: plan.after, undone: false });
            editedSince.set(opId, new Map());
            advance();
          }
        } else {
          const open = ledger.filter(entry => !entry.undone);
          if (open.length === 0) continue;
          const entry = pickOne(open);
          const before = { ...schedule };
          if (entry.kind === 'complete') {
            const plan = planUndoCompletion({ opId: entry.opId, schedule, record: entry.record! });
            if (plan.kind === 'superseded') {
              assert.deepEqual(schedule, before, 'a superseded undo changes nothing');
              continue;
            }
            schedule = plan.schedule!;
            completedOccurrences.delete(entry.opId);
          } else {
            schedule = planUndoSnooze(schedule, entry.before!, entry.after!).schedule;
          }
          entry.undone = true;
          // A later edit is never lost (compare-and-revert compares values: an edit back to
          // exactly the value the operation wrote is indistinguishable from no edit).
          const wrote = entry.kind === 'complete' ? entry.record!.after : entry.after!;
          for (const [field, value] of editedSince.get(entry.opId)!) {
            if (sameValue(before[field], value) && !(field in wrote && sameValue(wrote[field], value))) assert.ok(sameValue(schedule[field], value), `seed ${seed}: undo kept the later edit of ${field}`);
          }
          assert.equal(schedule.scheduleName, before.scheduleName, 'undo never renames');
          // A clean undo of a completion returns to the occurrence it completed (now open again).
          if (entry.kind === 'complete' && sameCycle(cycleOf(schedule), entry.seen)) {
            occurrence = entry.occurrence;
            seenOccurrences.push({ occurrence, cycle: cycleOf(schedule) });
          } else if (!sameCycle(cycleOf(before), cycleOf(schedule))) advance();
        }
      }
    });
  }
});

describe('calling the server (review of PR #210)', () => {
  const answer = <T,>(data: T) => ({ ok: true as const, data });
  const never = () => new Promise<never>(() => undefined);

  test('the deadline covers fetching the ID token: a hanging token is "no answer"', async () => {
    const started = Date.now();
    let called = false;
    const outcome = await callWithDeadline(never, async () => { called = true; return answer(1); }, 40);
    assert.deepEqual(outcome, { kind: 'no_answer' });
    assert.equal(called, false);
    assert.ok(Date.now() - started < 1000);
  });

  test('token time and call time share one deadline', async () => {
    const slow = (ms: number) => new Promise<string>(resolve => setTimeout(() => resolve('token'), ms));
    // 30 ms for the token plus 30 ms for the call: over a 45 ms deadline, under neither alone.
    const outcome = await callWithDeadline(() => slow(30), async () => { await slow(30); return answer(1); }, 45);
    assert.deepEqual(outcome, { kind: 'no_answer' });
    assert.deepEqual(await callWithDeadline(async () => 't', async () => answer(2), 45), { kind: 'ok', data: 2 });
    assert.deepEqual(await callWithDeadline(async () => 't', async () => ({ ok: false as const, code: 'invalid', message: 'No.' }), 45), { kind: 'failed', message: 'No.' });
    assert.deepEqual(await callWithDeadline(async () => { throw new Error('network'); }, async () => answer(3), 45), { kind: 'no_answer' });
    assert.deepEqual(await callWithDeadline(async () => 't', async () => answer(4), 45, () => true), { kind: 'offline' });
  });

  test('after no answer, saving again reuses the same op id until a definite answer or a fresh form', () => {
    const pending = createPendingRequests<{ opId: string; values: string }>();
    // Mirrors runOp: a held request wins over the fresh one.
    const press = (fresh: { opId: string; values: string }) => pending.get('log') ?? fresh;
    const first = press({ opId: 'op-1', values: 'Oil change' });
    pending.hold('log', first); // no answer
    const second = press({ opId: 'op-2', values: 'Oil change (edited)' });
    assert.equal(second.opId, 'op-1', 'never a second op id for an uncertain save');
    assert.equal(second.values, 'Oil change', 'the same request, so a replay cannot drop the edit silently');
    pending.settle('log'); // a definite answer (or the dialog opened afresh)
    assert.equal(press({ opId: 'op-3', values: 'x' }).opId, 'op-3');
    pending.hold('done:a', { opId: 'card', values: '' });
    assert.equal(pending.get('done:b'), undefined, 'per form or card');
  });

  test('odometer copy: a reading keeps the higher value; a vehicle correction lowers it', () => {
    assert.match(mileageWarningMessage('lower', 48750, 40000, 'reading'), /keeps the higher reading/);
    const correction = mileageWarningMessage('lower', 48750, 40000, 'correction');
    assert.match(correction, /corrects the vehicle's odometer down to 40,000 mi/);
    assert.doesNotMatch(correction, /keeps the higher/);
    assert.match(mileageWarningMessage('jump', 48750, 80000, 'correction'), /sets the vehicle's odometer to 80,000 mi/);
  });
});

describe('an explicit new due date starts a new occurrence (PR #210 review)', () => {
  const seen: MaintenanceCycle = { nextDueDate: '2026-03-01', nextDueMileage: null };

  test('editing the due date back to the completed cycle clears the completion marker', () => {
    const first = planCompletion({ ownerType: 'home_asset', schedule: filter(), seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op1') });
    assert.ok(first.kind === 'apply');
    const base = [first.schedule];
    // The member explicitly schedules the same date again.
    const values = [{ ...first.schedule, nextDueDate: '2026-03-01' }];
    const [edited] = mergeSchedules([first.schedule], base, values, ASSET_SCHEDULE_FIELDS);
    // The marker stays (Undo still recognises its own completion) but no longer covers the cycle.
    assert.equal((edited.lastCompletion as { replaced?: boolean }).replaced, true);
    assert.equal((edited.lastCompletion as { opId: string }).opId, 'op1');
    const again = planCompletion({ ownerType: 'home_asset', schedule: edited, seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op2') });
    assert.equal(again.kind, 'apply');
  });

  test('Undo after another member replaced the due date in the window is not "superseded"', () => {
    const first = planCompletion({ ownerType: 'home_asset', schedule: filter(), seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op1') });
    assert.ok(first.kind === 'apply');
    const [edited] = mergeSchedules([first.schedule], [first.schedule], [{ ...first.schedule, nextDueDate: '2026-07-15' }], ASSET_SCHEDULE_FIELDS);
    const undo = planUndoCompletion({ opId: 'op1', schedule: edited, record: first.record });
    assert.equal(undo.kind, 'apply');
    if (undo.kind !== 'apply') return;
    // The edited due date is kept and reported; the completion itself is taken back.
    assert.equal(undo.schedule?.nextDueDate, '2026-07-15');
    assert.ok(undo.kept.some(entry => entry.field === 'nextDueDate'));
    assert.equal(undo.schedule?.lastCompletedDate, filter().lastCompletedDate);
    assert.equal('lastCompletion' in (undo.schedule ?? {}), false);
  });

  test('an edit that leaves the due values alone keeps the marker', () => {
    const first = planCompletion({ ownerType: 'home_asset', schedule: filter(), seen, values: { completedDate: '2026-03-01' }, today: '2026-03-01', completion: who('op1') });
    assert.ok(first.kind === 'apply');
    const values = [{ ...first.schedule, scheduleName: 'Replace HVAC filter' }];
    const [edited] = mergeSchedules([first.schedule], [first.schedule], values, ASSET_SCHEDULE_FIELDS);
    assert.deepEqual(edited.lastCompletion, first.schedule.lastCompletion);
    assert.equal(edited.scheduleName, 'Replace HVAC filter');
  });
});

describe('the Undo offer follows the server window (PR #210 review)', () => {
  test('a fresh answer offers the window less the trip back; never more than 10 s', () => {
    assert.equal(undoOfferMs(9800), 9300);
    assert.equal(undoOfferMs(20_000), 10_000);
  });
  test('a replayed or slow answer offers what is left, or no Undo at all', () => {
    assert.equal(undoOfferMs(3000), 2500);
    assert.equal(undoOfferMs(MIN_UNDO_OFFER_MS + 499), null);
    assert.equal(undoOfferMs(0), null);
  });
  test('an answer without undoMs (an older server) keeps the whole window', () => {
    assert.equal(undoOfferMs(undefined), 10_000);
  });
});
