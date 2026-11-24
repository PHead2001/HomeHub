import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  actionableReminders,
  buildMaintenanceReminders,
  EXPIRY_WARNING_DAYS,
  REMINDER_DUE_SOON_DAYS,
} from '../../functions/src/shared/maintenance-reminders';
import { comingUp, comingUpByMonth, COMING_UP_DAYS } from '../../src/lib/maintenance/coming-up';
import { presetSchedulesFor, schedulePresetsFor, ASSET_SCHEDULE_PRESETS } from '../../src/lib/maintenance/presets';
import { reminderBadgeLabel, reminderSnoozeLabel } from '../../src/lib/maintenance/reminder-copy';
import { reminderGroupKey, reminderGroups } from '../../src/lib/maintenance/reminder-groups';
import { canSnoozeReminder, completedAssetSchedule } from '../../src/lib/maintenance/schedules';
import { warrantyClaimChecklist } from '../../src/lib/maintenance/warranty-claim';
import { warrantyCountdown, warrantyCountdownText, warrantyRingLabel } from '../../src/lib/maintenance/warranty';
import { computeMaintenanceFacts } from '../../src/lib/dashboard/facts';
import { summarizeOverviewMaintenance } from '../../src/ai/overview-fact-helpers';
import type { HomeAsset, MaintenanceAttachment, Vehicle } from '../../src/lib/types';

const TZ = 'America/Chicago';
const TODAY = '2026-11-05';

const hvac: HomeAsset = {
  id: 'hvac', householdId: 'h', name: 'Main HVAC', category: 'HVAC', status: 'active', createdAt: '', updatedAt: '',
  warrantyExpiration: '2026-12-01', // 26 days: inside the 30-day window
  schedules: [
    { id: 'filter', mode: 'scheduled', scheduleName: 'Replace filter', nextDueDate: '2026-10-01' }, // overdue
    { id: 'coils', mode: 'scheduled', scheduleName: 'Clean coils', nextDueDate: TODAY }, // today
    { id: 'duct', mode: 'scheduled', scheduleName: 'Check ducts', nextDueDate: '2026-11-12', snoozedUntil: '2026-11-12' }, // snoozed
    { id: 'tune', mode: 'scheduled', scheduleName: 'Tune-up', nextDueDate: '2026-11-15' }, // due soon
    { id: 'far', mode: 'scheduled', scheduleName: 'Replace unit', nextDueDate: '2027-01-20' }, // upcoming
  ],
};
const suv: Vehicle = {
  id: 'suv', householdId: 'h', nickname: 'Family SUV', status: 'active', createdAt: '', updatedAt: '',
  currentMileage: 48_000,
  registrationExpiration: '2026-11-30', // 25 days
  inspectionExpiration: '2027-01-15', // 71 days: upcoming, only with a lookahead
  serviceSchedules: [
    { id: 'oil', mode: 'scheduled', serviceName: 'Oil change', nextDueMileage: 48_300, nextDueDate: '2026-11-12', snoozedUntil: '2026-11-12' }, // mileage due soon: not snoozed
    { id: 'tires', mode: 'scheduled', serviceName: 'Tire rotation', nextDueMileage: 51_000 }, // mileage only, upcoming
  ],
};

const all = buildMaintenanceReminders([hvac], [suv], TODAY, TZ);
const withLookahead = buildMaintenanceReminders([hvac], [suv], TODAY, TZ, { expiryLookaheadDays: COMING_UP_DAYS });

describe('warning windows (MA-11h)', () => {
  it('expiries warn 30 days out; schedules keep 14', () => {
    assert.equal(EXPIRY_WARNING_DAYS, 30);
    assert.equal(REMINDER_DUE_SOON_DAYS, 14);
    assert.equal(all.find((r) => r.group === 'warranty')?.status, 'due_soon');
    assert.equal(all.find((r) => r.title === 'Vehicle registration')?.status, 'due_soon');
    assert.equal(all.find((r) => r.title === 'Replace unit')?.status, 'upcoming');
    // Upcoming expiries are reported only with a lookahead, and never notified.
    assert.equal(all.find((r) => r.title === 'Vehicle inspection'), undefined);
    const inspection = withLookahead.find((r) => r.title === 'Vehicle inspection');
    assert.equal(inspection?.status, 'upcoming');
    assert.ok(!actionableReminders(withLookahead).includes(inspection!));
    assert.equal(buildMaintenanceReminders([], [{ ...suv, inspectionExpiration: '2027-06-01' }], TODAY, TZ, { expiryLookaheadDays: 90 })
      .find((r) => r.title === 'Vehicle inspection'), undefined);
  });

  it('a lifetime warranty never reminds and its ring reads Lifetime', () => {
    const lifetime = { ...hvac, warrantyLifetime: true };
    assert.equal(buildMaintenanceReminders([lifetime], [], TODAY, TZ, { expiryLookaheadDays: 90 }).find((r) => r.group === 'warranty'), undefined);
    const ring = warrantyCountdown({ warrantyLifetime: true }, TODAY)!;
    assert.equal(ring.lifetime, true);
    assert.equal(ring.expired, false);
    assert.equal(ring.fraction, 1);
    assert.equal(warrantyRingLabel(ring), 'Lifetime');
    assert.equal(warrantyCountdownText(ring), 'Lifetime warranty');
    assert.equal(warrantyCountdown({ warrantyExpiration: '2026-12-01' }, TODAY)?.lifetime, undefined);
  });
});

describe('snooze (MA-9)', () => {
  const duct = all.find((r) => r.title === 'Check ducts')!;
  const oil = all.find((r) => r.title === 'Oil change')!;

  it('says until when, is muted in its own group, and is not due', () => {
    assert.equal(duct.snoozed, true);
    assert.equal(duct.snoozedUntil, '2026-11-12');
    assert.equal(reminderSnoozeLabel(duct), 'Snoozed until Nov 12, 2026');
    assert.equal(reminderBadgeLabel(duct), 'Snoozed');
    assert.equal(reminderGroupKey(duct), 'snoozed');
  });

  it('never quiets a mileage obligation or overdue work', () => {
    assert.equal(oil.status, 'due_soon');
    assert.equal(oil.snoozed, false);
    assert.equal(oil.snoozedUntil, undefined);
    assert.equal(reminderSnoozeLabel(oil), null);
    assert.equal(reminderGroupKey(oil), 'due_soon');
    // Overdue by mileage while the date is snoozed: overdue.
    const over = buildMaintenanceReminders([], [{ ...suv, currentMileage: 48_400 }], TODAY, TZ).find((r) => r.title === 'Oil change')!;
    assert.equal(over.status, 'overdue');
    assert.equal(reminderGroupKey(over), 'overdue');
    assert.equal(reminderGroupKey({ status: 'overdue', snoozed: true }), 'overdue');
    assert.equal(reminderBadgeLabel({ group: 'scheduled', status: 'due_today', snoozed: true }), 'Due today');
  });

  it('completion clears the snooze', () => {
    const done = completedAssetSchedule(hvac.schedules![2], { completedDate: TODAY, nextDueDate: '2026-11-12' });
    assert.equal('snoozedUntil' in done, false);
    assert.equal(canSnoozeReminder(duct), true);
  });
});

describe('reminder groups (MA-13)', () => {
  it('puts every reminder in exactly one urgency group, in order', () => {
    const { groups, counts, kinds } = reminderGroups(all);
    assert.deepEqual(groups.map((g) => g.key), ['overdue', 'due_today', 'due_soon', 'snoozed', 'upcoming']);
    const titles = Object.fromEntries(groups.map((g) => [g.key, g.reminders.map((r) => r.title)]));
    assert.deepEqual(titles, {
      overdue: ['Replace filter'],
      due_today: ['Clean coils'],
      due_soon: ['Oil change', 'Tune-up', 'Vehicle registration', 'Warranty'],
      snoozed: ['Check ducts'],
      upcoming: ['Replace unit', 'Tire rotation'],
    });
    const flat = groups.flatMap((g) => g.reminders);
    assert.equal(flat.length, all.length);
    assert.equal(new Set(flat).size, all.length);
    assert.deepEqual(counts, { overdue: 1, dueToday: 1, dueSoon: 4, snoozed: 1, upcoming: 2, dueNow: 5 });
    assert.deepEqual(kinds, { all: 9, schedule: 5, vehicle_service: 2, warranty: 1, document: 1 });
  });

  it('filters by kind without changing the chip counts', () => {
    const vehicles = reminderGroups(all, 'vehicle_service');
    assert.deepEqual(vehicles.groups.flatMap((g) => g.reminders).map((r) => r.title), ['Oil change', 'Tire rotation']);
    assert.equal(vehicles.kinds.all, all.length);
    assert.equal(vehicles.counts.dueNow, 1);
  });

  it('the dashboard counts and orders the same way (snoozed is not due)', () => {
    const facts = computeMaintenanceFacts([hvac as never], [suv as never], new Date('2026-11-05T18:00:00Z'), TZ);
    assert.equal(facts.overdue, 1);
    assert.equal(facts.dueSoon, 5);
    assert.deepEqual(facts.items.slice(0, 2).map((item) => item.label), ['Replace filter', 'Clean coils']);
    assert.equal(facts.next?.label, 'Replace filter');
    const fullFacts = computeMaintenanceFacts([hvac as never], [suv as never], new Date('2026-11-05T18:00:00Z'), TZ, { maintenanceItems: Infinity } as never);
    const snoozed = fullFacts.items.find((item) => item.label === 'Check ducts')!;
    assert.equal(snoozed.snoozed, true);
    assert.equal(snoozed.dueSoon, false);
    assert.equal(snoozed.statusLabel, 'Snoozed');
    // Snoozed comes after everything due, before upcoming.
    const labels = fullFacts.items.map((item) => item.label);
    assert.ok(labels.indexOf('Check ducts') > labels.indexOf('Main HVAC warranty ends'));
    assert.ok(labels.indexOf('Check ducts') < labels.indexOf('Replace unit'));
  });

  it('the AI overview uses the same counts (no own 7-day rule, snoozed not due, lifetime ignored)', () => {
    const sold = { id: 'old', nickname: 'Old', status: 'sold', registrationExpiration: '2020-01-01' };
    const lifetime = { ...hvac, id: 'tv', name: 'TV', warrantyLifetime: true, schedules: [{ id: 'c', mode: 'checklist', scheduleName: 'Dust' }] };
    const overview = summarizeOverviewMaintenance([hvac as never, lifetime as never], [suv as never, sold as never], new Date('2026-11-05T18:00:00Z'), TZ);
    assert.equal(overview.overdue, 1);
    assert.equal(overview.dueSoon, 5);
    assert.equal(overview.checklistItems, 1);
    assert.deepEqual(overview.urgent.map((item) => `${item.label} ${item.due ?? '-'}`), [
      'Replace filter 2026-10-01',
      'Clean coils 2026-11-05',
      'Oil change 2026-11-12',
      'Tune-up 2026-11-15',
      'Family SUV registration 2026-11-30',
      'Main HVAC warranty ends 2026-12-01',
    ]);
  });
});

describe('coming up (MA-27a)', () => {
  it('lists the next 90 days by date, then mileage services by miles left', () => {
    const result = comingUp(withLookahead, TODAY);
    assert.deepEqual(result.dated.map((e) => `${e.date} ${e.reminder.title}`), [
      '2026-11-05 Clean coils',
      '2026-11-12 Check ducts',
      '2026-11-12 Oil change',
      '2026-11-15 Tune-up',
      '2026-11-30 Vehicle registration',
      '2026-12-01 Warranty',
      '2027-01-15 Vehicle inspection',
      '2027-01-20 Replace unit',
    ]);
    assert.equal(result.dated.some((e) => e.reminder.status === 'overdue'), false);
    assert.deepEqual(result.byMileage.map((e) => `${e.reminder.title} ${e.milesLeft}`), ['Tire rotation 3000']);
    assert.deepEqual(comingUpByMonth(result.dated).map((m) => `${m.label}: ${m.entries.length}`), ['November 2026: 5', 'December 2026: 1', 'January 2027: 2']);
  });

  it('places a mileage service on a supplied predicted date', () => {
    const tires = withLookahead.find((r) => r.title === 'Tire rotation')!;
    const result = comingUp(withLookahead, TODAY, 90, { predictedDates: { [tires.scheduleKey!]: '2026-12-20' } });
    const entry = result.dated.find((e) => e.reminder.title === 'Tire rotation')!;
    assert.equal(entry.predicted, true);
    assert.equal(entry.date, '2026-12-20');
    assert.equal(result.byMileage.length, 0);
    // A prediction beyond the window drops it from both lists.
    assert.equal(comingUp(withLookahead, TODAY, 30, { predictedDates: { [tires.scheduleKey!]: '2027-03-01' } }).byMileage.length, 0);
  });

  it('respects a shorter window', () => {
    assert.deepEqual(comingUp(withLookahead, TODAY, 7).dated.map((e) => e.reminder.title), ['Clean coils', 'Check ducts', 'Oil change']);
  });
});

describe('schedule presets (MA-27b)', () => {
  it('offers editable drafts with new ids, calendar anchors and suggested first dues', () => {
    let n = 0;
    const newId = () => String(++n);
    const outdoor = presetSchedulesFor('Lawn / Outdoor', { today: '2026-11-24', newId });
    const gutters = outdoor.find((s) => s.scheduleName === 'Clean gutters')!;
    assert.deepEqual(gutters, {
      id: 'gutters-1', mode: 'scheduled', scheduleName: 'Clean gutters', frequencyType: 'years', intervalValue: 1,
      anchor: 'calendar', anchorMonth: 10, anchorDay: 1, nextDueDate: '2027-10-01',
    });
    const hvacFilter = presetSchedulesFor('HVAC', { today: '2026-11-24', newId })[0];
    assert.deepEqual(hvacFilter, { id: 'hvac-filter-3', mode: 'scheduled', scheduleName: 'Replace HVAC filter', frequencyType: 'months', intervalValue: 3, nextDueDate: '2027-02-24' });
    assert.ok(presetSchedulesFor('Electrical').some((s) => s.scheduleName === 'Replace smoke-alarm batteries' && s.frequencyType === 'years'));
    assert.ok(presetSchedulesFor('Plumbing').some((s) => s.scheduleName === 'Flush water heater' && s.intervalValue === 1));
    // Without today: no date is invented.
    assert.equal(presetSchedulesFor('HVAC')[0].nextDueDate, undefined);
    // Ids are unique by default.
    const ids = presetSchedulesFor('HVAC').map((s) => s.id);
    assert.equal(new Set([...ids, ...presetSchedulesFor('HVAC').map((s) => s.id)]).size, ids.length * 2);
  });

  it('vehicle presets carry miles and months, and the next due mileage when known', () => {
    const drafts = presetSchedulesFor('Vehicle', { today: '2026-11-24', currentMileage: 48_000, newId: () => 'x' });
    assert.deepEqual(drafts.find((s) => s.serviceName === 'Oil change'), {
      id: 'oil-change-x', mode: 'scheduled', serviceName: 'Oil change', intervalMiles: 5000, intervalMonths: 6, nextDueDate: '2027-05-24', nextDueMileage: 53_000,
    });
    assert.deepEqual(drafts.find((s) => s.serviceName === 'Tire rotation'), {
      id: 'tire-rotation-x', mode: 'scheduled', serviceName: 'Tire rotation', intervalMiles: 7500, nextDueMileage: 55_500,
    });
    assert.equal(schedulePresetsFor('Vehicle').length, drafts.length);
  });

  it('every category has a catalog and calendar presets name their month', () => {
    for (const [category, presets] of Object.entries(ASSET_SCHEDULE_PRESETS)) {
      assert.ok(presets.length > 0, category);
      for (const preset of presets) {
        if (preset.anchor === 'calendar') assert.ok(preset.anchorMonth && preset.anchorMonth >= 1 && preset.anchorMonth <= 12, preset.key);
      }
    }
  });
});

describe('warranty claim checklist (MA-33c)', () => {
  const attachments = [
    { targetType: 'home_asset', targetId: 'hvac', category: 'receipt' },
    { targetType: 'home_asset', targetId: 'hvac', category: 'photo' },
    { targetType: 'home_asset', targetId: 'other', category: 'invoice' },
  ] as Pick<MaintenanceAttachment, 'targetType' | 'targetId' | 'category'>[];

  it('lists what HomeHub has and flags what is missing', () => {
    const list = warrantyClaimChecklist({ id: 'hvac', warrantyProvider: 'Acme', serialNumber: 'SN-1', purchaseDate: '2024-05-01', warrantyExpiration: '2027-05-01' }, attachments, TODAY);
    assert.deepEqual(list.items.map((i) => `${i.key}:${i.have ? 'have' : 'missing'}`), [
      'provider:have', 'serialNumber:have', 'model:missing', 'purchaseDate:have', 'purchasePrice:missing', 'receipt:have', 'warrantyEnd:have',
    ]);
    assert.equal(list.missing, 2);
    assert.equal(list.status, 'active');
    assert.equal(list.items.find((i) => i.key === 'receipt')?.value, '1 file attached');
    assert.equal(list.summary, 'Covered until May 1, 2027.');
  });

  it('knows lifetime, ended and unknown warranties', () => {
    assert.equal(warrantyClaimChecklist({ id: 'x', warrantyLifetime: true }, [], TODAY).status, 'lifetime');
    assert.equal(warrantyClaimChecklist({ id: 'x', warrantyLifetime: true }, [], TODAY).items.find((i) => i.key === 'warrantyEnd')?.value, 'Lifetime');
    assert.equal(warrantyClaimChecklist({ id: 'x', warrantyExpiration: '2026-01-01' }, [], TODAY).status, 'ended');
    const unknown = warrantyClaimChecklist({ id: 'x', purchasePrice: 1299 }, attachments, TODAY);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.items.find((i) => i.key === 'purchasePrice')?.value, '$1,299.00');
    assert.equal(unknown.items.find((i) => i.key === 'receipt')?.have, false);
  });
});
