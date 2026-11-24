import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ASSET_SCHEDULE_FIELDS,
  VEHICLE_SCHEDULE_FIELDS,
  mergeSchedules,
  planCompletion,
  planMileageUpdate,
  planUndoMileage,
  type StoredSchedule,
} from '../../src/lib/maintenance/operations';
import { quickCompletionValues, serviceCompletionValues } from '../../src/lib/maintenance/schedules';
import type { HomeAsset, HomeAssetSchedule, Vehicle, VehicleServiceSchedule } from '../../src/lib/types';

// M5/M6: calendar anchoring through completion (MA-11g end-to-end) and Update mileage (MA-19).
const who = (opId: string) => ({ opId, byUid: 'u1', byName: 'Sam', completedDate: '', at: '2026-11-24T15:00:00.000Z' });
const GUTTERS: StoredSchedule = {
  id: 'gutters', mode: 'scheduled', scheduleName: 'Clean gutters', frequencyType: 'years', intervalValue: 1,
  anchor: 'calendar', anchorMonth: 10, anchorDay: 1, nextDueDate: '2026-10-01',
};

describe('calendar anchoring through completion (MA-11g)', () => {
  test('the server plan keeps a calendar schedule on its day, early or late', () => {
    for (const completedDate of ['2026-11-05', '2026-09-20']) {
      const plan = planCompletion({
        ownerType: 'home_asset', schedule: GUTTERS, seen: { nextDueDate: '2026-10-01', nextDueMileage: null },
        values: { completedDate }, today: '2026-11-24', completion: who('op-1'),
      });
      assert.equal(plan.kind, 'apply');
      if (plan.kind === 'apply') assert.equal(plan.next.nextDueDate, '2027-10-01');
    }
  });

  test('a snoozed calendar schedule steps from the cycle it was snoozed from, and the snooze ends', () => {
    const snoozed = { ...GUTTERS, nextDueDate: '2026-10-08', snoozedUntil: '2026-10-08', snoozedFrom: '2026-10-01' };
    const plan = planCompletion({
      ownerType: 'home_asset', schedule: snoozed, seen: { nextDueDate: '2026-10-08', nextDueMileage: null },
      values: { completedDate: '2026-09-30' }, today: '2026-09-30', completion: who('op-2'),
    });
    assert.equal(plan.kind, 'apply');
    if (plan.kind !== 'apply') return;
    assert.equal(plan.next.nextDueDate, '2027-10-01');
    assert.equal(plan.schedule.snoozedUntil, undefined);
    assert.equal(plan.schedule.snoozedFrom, undefined);
  });

  test('completion-anchored schedules keep the old advancement', () => {
    const plan = planCompletion({
      ownerType: 'home_asset', schedule: { ...GUTTERS, anchor: 'completion' }, seen: { nextDueDate: '2026-10-01', nextDueMileage: null },
      values: { completedDate: '2026-11-05' }, today: '2026-11-24', completion: who('op-3'),
    });
    assert.ok(plan.kind === 'apply' && plan.next.nextDueDate === '2027-11-05');
  });

  test('Mark done and Log service send the anchored next due (the payload the page really sends)', () => {
    const asset = { id: 'house', name: 'House', schedules: [GUTTERS as HomeAssetSchedule] } as HomeAsset;
    const target = { targetType: 'home_asset' as const, asset, scheduleIndex: 0, schedule: GUTTERS as HomeAssetSchedule };
    assert.deepEqual(quickCompletionValues(target, '2026-11-05'), { completedDate: '2026-11-05', nextDueDate: '2027-10-01' });
    const tires: VehicleServiceSchedule = { id: 'tires', serviceName: 'Tires', intervalMonths: 12, anchor: 'calendar', anchorMonth: 4, anchorDay: 15, nextDueDate: '2026-04-15' };
    const vehicle = { id: 'car', nickname: 'Car', currentMileage: 40000, serviceSchedules: [tires] } as Vehicle;
    const values = serviceCompletionValues({ targetType: 'vehicle', vehicle, scheduleIndex: 0, schedule: tires }, '2026-05-01', 40000);
    assert.equal(values?.nextDueDate, '2027-04-15');
  });

  test('anchor fields are editable schedule fields, so an edit keeps and merges them', () => {
    for (const field of ['anchor', 'anchorMonth', 'anchorDay']) {
      assert.ok((ASSET_SCHEDULE_FIELDS as readonly string[]).includes(field));
      assert.ok((VEHICLE_SCHEDULE_FIELDS as readonly string[]).includes(field));
    }
    const stored = [{ ...GUTTERS }];
    const merged = mergeSchedules(stored, stored, [{ ...GUTTERS, anchorMonth: 11 }], ASSET_SCHEDULE_FIELDS);
    assert.equal(merged[0].anchorMonth, 11);
    const added = mergeSchedules([], [], [{ id: 'new', scheduleName: 'Gutters', anchor: 'calendar', anchorMonth: 10, anchorDay: 1 }], ASSET_SCHEDULE_FIELDS);
    assert.equal(added[0].anchor, 'calendar');
  });
});

describe('Update mileage (MA-19)', () => {
  test('a reading at or above the recorded one is written with today', () => {
    const plan = planMileageUpdate({ vehicle: { currentMileage: 48000, mileageUpdatedAt: '2026-10-01' }, reading: 48750, correction: false, today: '2026-11-24' });
    assert.ok(plan.kind === 'apply');
    assert.deepEqual(plan.patch, { currentMileage: 48750, mileageUpdatedAt: '2026-11-24' });
    assert.deepEqual(plan.before, { currentMileage: 48000, mileageUpdatedAt: '2026-10-01' });
    const same = planMileageUpdate({ vehicle: { currentMileage: 48000, mileageUpdatedAt: '2026-10-01' }, reading: 48000, correction: false, today: '2026-11-24' });
    assert.ok(same.kind === 'apply');
    assert.deepEqual(same.patch, { mileageUpdatedAt: '2026-11-24' });
  });

  test('a first reading starts the odometer', () => {
    const plan = planMileageUpdate({ vehicle: {}, reading: 1200, correction: false, today: '2026-11-24' });
    assert.ok(plan.kind === 'apply');
    assert.deepEqual(plan.patch, { currentMileage: 1200, mileageUpdatedAt: '2026-11-24' });
  });

  test('a lower reading needs the explicit correction', () => {
    assert.deepEqual(planMileageUpdate({ vehicle: { currentMileage: 48000 }, reading: 47000, correction: false, today: '2026-11-24' }),
      { kind: 'refused', reason: 'lower_needs_correction' });
    const corrected = planMileageUpdate({ vehicle: { currentMileage: 48000 }, reading: 47000, correction: true, today: '2026-11-24' });
    assert.ok(corrected.kind === 'apply' && corrected.patch.currentMileage === 47000);
  });

  test('invalid readings are refused', () => {
    for (const reading of [-1, 1.5, 2_000_001, '48000', null, Number.NaN]) {
      assert.deepEqual(planMileageUpdate({ vehicle: {}, reading, correction: false, today: '2026-11-24' }), { kind: 'refused', reason: 'invalid_mileage' });
    }
  });

  test('Undo reverts only fields that still hold the update; a later higher reading stays', () => {
    const before = { currentMileage: 48000, mileageUpdatedAt: '2026-10-01' };
    const after = { currentMileage: 48750, mileageUpdatedAt: '2026-11-24' };
    assert.deepEqual(planUndoMileage({ ...after }, before, after), { patch: before, kept: [] });
    const later = planUndoMileage({ currentMileage: 49000, mileageUpdatedAt: '2026-11-24' }, before, after);
    assert.deepEqual(later.patch, {});
    assert.deepEqual(later.kept, [{ field: 'currentMileage', value: 49000 }]);
    // A first reading undone removes the mileage again.
    assert.deepEqual(planUndoMileage({ currentMileage: 1200, mileageUpdatedAt: '2026-11-24' }, { currentMileage: null, mileageUpdatedAt: null }, { currentMileage: 1200, mileageUpdatedAt: '2026-11-24' }).patch,
      { currentMileage: null, mileageUpdatedAt: null });
  });
});
