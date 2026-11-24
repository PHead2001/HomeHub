import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMaintenanceReminders } from '../../functions/src/shared/maintenance-reminders';
import { needsDoing } from '../../src/lib/maintenance/needs-doing';
import { pageOfLog, paginateLogs } from '../../src/lib/maintenance/filters';
import { doneByLine, legacyReceiptHref, logDateLabel, UNDATED_LOG } from '../../src/lib/maintenance/display';
import { logMatchesSchedule, serviceHistoryLine, type HistoryLog } from '../../src/lib/maintenance/history-line';
import { reminderMileageEstimates } from '../../src/lib/maintenance/mileage-prediction';
import { warrantyCaption, warrantyCountdown } from '../../src/lib/maintenance/warranty';
import type { HomeAsset, MaintenanceLog, Vehicle } from '../../src/lib/types';

// M4: the Overview's Needs doing list, log pages, log display rules, the
// history line by completion schedule id, mileage estimates per reminder and
// the warranty caption.
const TZ = 'America/Chicago';
const TODAY = '2026-11-05';

const hvac: HomeAsset = {
  id: 'hvac', householdId: 'h', name: 'Main HVAC', category: 'HVAC', location: 'Basement', status: 'active', createdAt: '', updatedAt: '',
  warrantyExpiration: '2026-10-01', // ended: nothing to do
  schedules: [
    { id: 'filter', mode: 'scheduled', scheduleName: 'Replace filter', nextDueDate: '2026-10-01' }, // overdue
    { id: 'coils', mode: 'scheduled', scheduleName: 'Clean coils', nextDueDate: TODAY }, // today
    { id: 'duct', mode: 'scheduled', scheduleName: 'Check ducts', nextDueDate: '2026-11-12', snoozedUntil: '2026-11-12' }, // snoozed
    { id: 'tune', mode: 'scheduled', scheduleName: 'Tune-up', nextDueDate: '2026-11-15' }, // due soon
    { id: 'far', mode: 'scheduled', scheduleName: 'Replace unit', nextDueDate: '2027-01-20' }, // upcoming
  ],
};
const fridge: HomeAsset = {
  id: 'fridge', householdId: 'h', name: 'Fridge', category: 'Appliance', location: ' kitchen ', status: 'needs_attention', createdAt: '', updatedAt: '',
  warrantyExpiration: '2026-11-20', // ending soon: in
  schedules: [{ id: 'coils', mode: 'scheduled', scheduleName: 'Vacuum coils', nextDueDate: '2026-11-01' }],
};
const car: Vehicle = {
  id: 'car', householdId: 'h', nickname: 'Car', make: 'Honda', status: 'needs_attention', createdAt: '', updatedAt: '',
  registrationExpiration: '2026-10-30', // expired: in
  serviceSchedules: [],
};
const reminders = buildMaintenanceReminders([hvac, fridge], [car], TODAY, TZ);

describe('Needs doing (MA-12, MA-14)', () => {
  it('lists overdue and expired first, then due today, due soon and snoozed; never upcoming work or an ended warranty', () => {
    const list = needsDoing({ reminders, assets: [hvac, fridge], vehicles: [car] });
    assert.deepEqual(list.reminders.map((r) => r.title), [
      'Replace filter', 'Vehicle registration', 'Vacuum coils', 'Clean coils', 'Tune-up', 'Warranty', 'Check ducts',
    ]);
    const keys = list.reminders.map((r) => (r.snoozed && r.status !== 'overdue' && r.status !== 'due_today' ? 'snoozed' : r.status));
    const order = ['overdue', 'due_today', 'due_soon', 'snoozed'];
    assert.deepEqual([...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b)), keys, 'urgency order');
    assert.ok(!list.reminders.some((r) => r.title === 'Replace unit'), 'upcoming work is in Coming up, not here');
    assert.ok(!list.reminders.some((r) => r.group === 'warranty' && r.targetId === 'hvac'), 'an ended warranty has nothing to do');
    assert.ok(list.reminders.some((r) => r.group === 'warranty' && r.targetId === 'fridge'), 'an ending warranty is in');
    assert.ok(list.reminders.some((r) => r.group === 'vehicle_document' && r.status === 'overdue'), 'an expired registration is in');
    assert.equal(list.reminders.at(-1)?.title, 'Check ducts', 'snoozed last');
    assert.deepEqual(list.flagged.map((item) => [item.targetType, item.id, item.detail]), [
      ['home_asset', 'fridge', 'Appliance ·  kitchen '], ['vehicle', 'car', 'Honda'],
    ]);
    // The one attention number: everything except snoozed, plus the flags.
    assert.equal(list.count, list.reminders.length - 1 + 2);
  });

  it('a room keeps only the assets in it (case and spaces ignored); vehicles leave', () => {
    const kitchen = needsDoing({ reminders, assets: [hvac, fridge], vehicles: [car], roomName: 'KITCHEN' });
    assert.ok(kitchen.reminders.length > 0);
    assert.ok(kitchen.reminders.every((r) => r.targetId === 'fridge'));
    assert.deepEqual(kitchen.flagged.map((item) => item.id), ['fridge']);
    const nowhere = needsDoing({ reminders, assets: [hvac, fridge], vehicles: [car], roomName: 'Attic' });
    assert.deepEqual([nowhere.reminders.length, nowhere.flagged.length, nowhere.count], [0, 0, 0]);
    // "Unassigned" keeps the assets without a location.
    const shed: HomeAsset = { ...fridge, id: 'shed', name: 'Shed light', location: undefined, status: 'needs_attention', schedules: [] };
    const unassigned = needsDoing({ reminders, assets: [hvac, fridge, shed], vehicles: [car], roomName: 'unassigned' });
    assert.deepEqual([unassigned.reminders.length, unassigned.flagged.map((item) => item.id)], [0, ['shed']]);
    // A blank room is no filter.
    assert.equal(needsDoing({ reminders, assets: [hvac, fridge], vehicles: [car], roomName: '  ' }).count, needsDoing({ reminders, assets: [hvac, fridge], vehicles: [car] }).count);
  });
});

describe('log pages and display (MA-21, MA-11e, MA-20)', () => {
  const logs = Array.from({ length: 45 }, (_, index) => ({ id: `log-${String(index).padStart(2, '0')}`, date: `2026-0${1 + (index % 9)}-1${index % 10}` }));
  const undated = [{ id: 'undated', date: '' }, { id: 'garbled', date: 'soon' }];

  it('finds the page a log is on, in the paginated order; undated logs are kept, last', () => {
    const all = [...undated, ...logs];
    for (const log of all) {
      const page = pageOfLog(all, log.id)!;
      assert.ok(paginateLogs(all, page).items.some((item) => item.id === log.id), log.id);
    }
    assert.equal(pageOfLog(all, 'missing'), null);
    assert.equal(pageOfLog(all, null), null);
    const last = paginateLogs(all, 3);
    assert.deepEqual(last.items.slice(-2).map((item) => item.id).sort(), ['garbled', 'undated']);
    assert.equal(last.total, 47);
  });

  it('labels an unreadable date "Undated", never today', () => {
    assert.equal(logDateLabel('2026-03-03'), 'Mar 3, 2026');
    assert.equal(logDateLabel(''), UNDATED_LOG);
    assert.equal(logDateLabel(undefined), UNDATED_LOG);
    assert.equal(logDateLabel('soon'), UNDATED_LOG);
  });

  it('"Done by" only from doneByName, never an email or a guess', () => {
    assert.equal(doneByLine({ doneByName: ' Sam ' }), 'Done by Sam');
    assert.equal(doneByLine({ doneByName: 'sam@example.com' }), null);
    assert.equal(doneByLine({}), null);
  });

  it('a legacy receipt link must be http(s)', () => {
    assert.equal(legacyReceiptHref('https://example.test/r.pdf'), 'https://example.test/r.pdf');
    assert.equal(legacyReceiptHref('javascript:alert(1)'), null);
    assert.equal(legacyReceiptHref('not a url'), null);
    assert.equal(legacyReceiptHref(undefined), null);
  });
});

describe('history line by completion schedule id (MA-32)', () => {
  const log = (overrides: Partial<HistoryLog> & { id: string }): HistoryLog => ({ targetType: 'home_asset', assetId: 'hvac', date: '2026-10-20', ...overrides });
  const options = { today: TODAY, timeZone: TZ };

  it('a completion log matches by its schedule id, whatever its title; others by title', () => {
    const filter = { name: 'Replace filter', ids: ['filter', 'legacy-0-replace-filter'] };
    assert.equal(logMatchesSchedule(log({ id: 'a', title: 'Filter (edited)', completion: { scheduleId: 'filter' } }), filter), true);
    assert.equal(logMatchesSchedule(log({ id: 'b', title: 'Replace filter', completion: { scheduleId: 'coils' } }), filter), false);
    assert.equal(logMatchesSchedule(log({ id: 'c', title: ' replace  FILTER ' }), filter), true);
    assert.equal(logMatchesSchedule(log({ id: 'd', title: 'Replace filter', completion: { scheduleId: 'legacy-0-replace-filter' } }), filter), true);
    const logs = [
      log({ id: 'edited', title: 'Filter swap', date: '2026-11-01', doneByName: 'Ana', completion: { scheduleId: 'filter' } }),
      log({ id: 'other', title: 'Replace filter', date: '2026-11-04', completion: { scheduleId: 'coils' } }),
    ];
    assert.equal(serviceHistoryLine(logs, { type: 'home_asset', id: 'hvac' }, { ...options, scheduleName: 'Replace filter', scheduleIds: filter.ids }), 'Replace filter last done 4 days ago by Ana');
    // Without ids, the title rule alone (as before).
    assert.equal(serviceHistoryLine(logs, { type: 'home_asset', id: 'hvac' }, { ...options, scheduleName: 'Replace filter' }), 'Replace filter last done yesterday');
  });
});

describe('mileage estimates per reminder (MA-29)', () => {
  it('estimates a vehicle service with a due mileage from dated readings; others get none', () => {
    const suv: Vehicle = {
      id: 'suv', householdId: 'h', nickname: 'SUV', status: 'active', createdAt: '', updatedAt: '', currentMileage: 48_000,
      serviceSchedules: [{ id: 'oil', mode: 'scheduled', serviceName: 'Oil change', nextDueMileage: 49_000 }],
    };
    const logs: MaintenanceLog[] = [
      { id: 'a', targetType: 'vehicle', vehicleId: 'suv', date: '2026-07-01', mileage: 45_000 },
      { id: 'b', targetType: 'vehicle', vehicleId: 'suv', date: '2026-09-01', mileage: 46_500 },
      { id: 'c', targetType: 'vehicle', vehicleId: 'suv', date: '2026-11-01', mileage: 48_000 },
    ];
    const list = buildMaintenanceReminders([hvac], [suv], TODAY, TZ);
    const estimates = reminderMileageEstimates(list, [suv], logs, TODAY, TZ);
    const oil = list.find((r) => r.title === 'Oil change')!;
    assert.match(estimates[oil.id].text, /^Estimated around [A-Z][a-z]{2} \d{1,2}, based on 3 readings$/);
    assert.ok(estimates[oil.id].date > TODAY);
    assert.equal(Object.keys(estimates).length, 1);
    assert.deepEqual(reminderMileageEstimates(list, [suv], logs.slice(0, 2), TODAY, TZ), {}, 'too few readings: no estimate');
  });
});

describe('warranty caption (MA-17, MA-23)', () => {
  it('reads "Warranty · N days" in 14 px text, nothing for lifetime', () => {
    assert.equal(warrantyCaption(warrantyCountdown({ warrantyExpiration: '2027-05-22' }, TODAY)!), 'Warranty · 198 days');
    assert.equal(warrantyCaption(warrantyCountdown({ warrantyExpiration: '2026-11-06' }, TODAY)!), 'Warranty · 1 day');
    assert.equal(warrantyCaption(warrantyCountdown({ warrantyExpiration: TODAY }, TODAY)!), 'Warranty ends today');
    assert.equal(warrantyCaption(warrantyCountdown({ warrantyExpiration: '2026-01-01' }, TODAY)!), 'Warranty ended');
    assert.equal(warrantyCaption(warrantyCountdown({ warrantyLifetime: true }, TODAY)!), null);
  });
});
