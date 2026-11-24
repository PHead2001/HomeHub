import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { legacyScheduleKey as twinKey, withScheduleIds as twinIds } from '../../scripts/ops/maintenance-schedule-ids.mjs';
import { legacyScheduleKey, withScheduleIds } from '../../src/lib/maintenance/operations';
import { buildMaintenanceReminders } from '../../functions/src/shared/maintenance-reminders';

// The pure mapping of scripts/ops/backfill-maintenance-schedule-ids.mjs (no emulator
// needed), and its agreement with the server's first-touch assignment.
const KIND = { 'home-assets': 'home_asset', vehicles: 'vehicle' } as const;

describe('maintenance schedule id backfill mapping', () => {
  test('id-less schedules get their legacy key; ids and non-objects are untouched', () => {
    const list = [{ scheduleName: 'Clean coils' }, { id: 'kept', scheduleName: 'x' }, { scheduleName: 'Änderung & Co' }];
    const { list: next, assigned } = twinIds(list, 'home-assets');
    assert.equal(assigned, 2);
    assert.deepEqual(next.map(s => (s as { id: string }).id), ['legacy-0-clean-coils', 'kept', 'legacy-2-anderung-and-co']);
    assert.deepEqual(twinIds(next, 'home-assets').assigned, 0, 'idempotent');
    assert.deepEqual(twinIds(undefined, 'vehicles'), { list: [], assigned: 0 });
    assert.equal(twinKey({}, 3, 'vehicles'), 'legacy-3-scheduled-service');
  });

  test('the reminder sourceId of a schedule is the same before and after the backfill', () => {
    const asset = { id: 'hvac', name: 'HVAC', status: 'active', schedules: [{ scheduleName: 'Replace filter', nextDueDate: '2026-03-01' }] };
    const before = buildMaintenanceReminders([asset], [], '2026-03-01', 'America/Chicago')[0];
    const after = buildMaintenanceReminders([{ ...asset, schedules: twinIds(asset.schedules, 'home-assets').list as never }], [], '2026-03-01', 'America/Chicago')[0];
    assert.equal(after.sourceId, before.sourceId);
    assert.equal(after.deepLink, before.deepLink);
  });

  test('the script and the server assign the same ids', () => {
    const cases: unknown[][] = [
      [{ scheduleName: 'A' }, { scheduleName: 'A' }],
      [{ id: 'legacy-1-a', scheduleName: 'b' }, { scheduleName: 'a' }],
      [{ serviceName: 'Oil change' }, { id: 'x' }, {}],
      [{ scheduleName: 'Tür / Fenster' }],
    ];
    for (const list of cases) {
      for (const collection of ['home-assets', 'vehicles'] as const) {
        assert.deepEqual(twinIds(list, collection), withScheduleIds(list, KIND[collection]));
        list.forEach((schedule, index) => {
          if (schedule && typeof schedule === 'object') assert.equal(twinKey(schedule as Record<string, unknown>, index, collection), legacyScheduleKey(schedule as never, index, KIND[collection]));
        });
      }
    }
  });
});
