import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { buildMaintenanceReminders } from '../../functions/src/shared/maintenance-reminders';
import { pickAssetPhoto, presentFields, shouldOfferAiSummary } from '../../src/lib/maintenance/display';
import { reminderDueDetail, reminderStatusLabel, spanLabel } from '../../src/lib/maintenance/reminder-copy';
import {
  canMarkReminderDone,
  canSnoozeReminder,
  completedAssetSchedule,
  completedVehicleSchedule,
  findReminderSchedule,
  quickCompletionValues,
  reminderCycleKey,
  scheduleKeyFor,
  serviceCompletionValues,
  snoozedDueDate,
} from '../../src/lib/maintenance/schedules';
import type { HomeAsset, HomeAssetSchedule, MaintenanceAttachment, Vehicle } from '../../src/lib/types';

const TZ = 'America/Chicago';
const TODAY = '2026-08-01';

const hvac: HomeAsset = {
  id: 'hvac-main',
  householdId: 'h',
  name: 'Main HVAC System',
  category: 'HVAC',
  status: 'active',
  warrantyExpiration: '2026-07-20',
  schedules: [
    { id: 'filter', mode: 'scheduled', scheduleName: 'Replace air filter', frequencyType: 'months', intervalValue: 3, nextDueDate: '2026-07-01' },
    { mode: 'scheduled', scheduleName: 'Legacy coil clean', nextDueDate: '2026-08-05' },
  ],
  createdAt: '',
  updatedAt: '',
};

const suv: Vehicle = {
  id: 'family-suv',
  householdId: 'h',
  nickname: 'Family SUV',
  status: 'active',
  currentMileage: 48_750,
  registrationExpiration: '2026-08-12',
  serviceSchedules: [
    { id: 'tires', mode: 'scheduled', serviceName: 'Tire rotation', intervalMiles: 6000, nextDueMileage: 49_000, nextDueDate: '2026-08-15' },
    { id: 'brakes', mode: 'scheduled', serviceName: 'Brake fluid', intervalMonths: 24, nextDueDate: '2026-08-20' },
  ],
  createdAt: '',
  updatedAt: '',
};

const reminders = buildMaintenanceReminders([hvac], [suv], TODAY, TZ);
const find = (title: string) => {
  const reminder = reminders.find((item) => item.title === title);
  assert.ok(reminder, `missing reminder ${title}`);
  return reminder;
};

describe('reminder copy (D16)', () => {
  it('never says "overdue" for a warranty or document', () => {
    assert.equal(reminderStatusLabel('warranty', 'overdue'), 'Expired');
    assert.equal(reminderStatusLabel('vehicle_document', 'due_soon'), 'Expires soon');
    assert.equal(reminderStatusLabel('scheduled', 'overdue'), 'Overdue');
    assert.equal(reminderStatusLabel('vehicle_service', 'due_today'), 'Due today');
  });

  it('gives the when, not the status again', () => {
    const filter = reminderDueDetail(find('Replace air filter'), TODAY);
    assert.equal(filter, 'Due Jul 1, 2026 · 4 weeks ago');
    assert.doesNotMatch(filter, /overdue/i);
    assert.equal(reminderDueDetail(find('Warranty'), TODAY), 'Expired Jul 20, 2026 · 12 days ago');
    assert.equal(reminderDueDetail(find('Tire rotation'), TODAY), 'Due Aug 15, 2026 · in 2 weeks or At 49,000 mi · 250 mi to go');
    assert.equal(reminderDueDetail({ group: 'scheduled', status: 'due_today', dueDate: TODAY }, TODAY), 'Due Aug 1, 2026');
    assert.equal(reminderDueDetail({ group: 'vehicle_service', status: 'overdue', dueMileage: 49_000, currentMileage: 50_000 }, TODAY), 'At 49,000 mi · 1,000 mi over');
  });

  it('spans read at a glance', () => {
    assert.equal(spanLabel(1), '1 day');
    assert.equal(spanLabel(-13), '13 days');
    assert.equal(spanLabel(20), '2 weeks');
    assert.equal(spanLabel(92), '3 months');
    assert.equal(spanLabel(800), '2 years');
  });
});

describe('reminder actions', () => {
  it('matches reminders back to their schedules, including legacy keys', () => {
    const filter = findReminderSchedule(find('Replace air filter'), [hvac], [suv]);
    assert.equal(filter?.targetType, 'home_asset');
    assert.equal(filter?.scheduleIndex, 0);
    const legacy = findReminderSchedule(find('Legacy coil clean'), [hvac], [suv]);
    assert.equal(legacy?.scheduleIndex, 1);
    assert.equal(scheduleKeyFor('hvac-main', hvac.schedules![1], 1, 'home_asset'), 'hvac-main:legacy-1-legacy-coil-clean');
    assert.equal(find('Legacy coil clean').scheduleKey, 'hvac-main:legacy-1-legacy-coil-clean');
    const brakes = findReminderSchedule(find('Brake fluid'), [hvac], [suv]);
    assert.equal(brakes?.targetType, 'vehicle');
    assert.equal(brakes?.scheduleIndex, 1);
    assert.equal(findReminderSchedule(find('Warranty'), [hvac], [suv]), null);
  });

  it('offers Mark done for schedules and services only', () => {
    assert.equal(canMarkReminderDone(find('Replace air filter')), true);
    assert.equal(canMarkReminderDone(find('Tire rotation')), true);
    assert.equal(canMarkReminderDone(find('Warranty')), false);
    assert.equal(canMarkReminderDone(find('Vehicle registration')), false);
  });

  it('offers Snooze only when the date drives the reminder', () => {
    assert.equal(canSnoozeReminder(find('Replace air filter')), true);
    assert.equal(canSnoozeReminder({ ...find('Brake fluid'), status: 'due_soon' }), true);
    // Upcoming reminders are not in the actionable lists.
    assert.equal(canSnoozeReminder(find('Brake fluid')), false);
    // Due soon by mileage: moving the date would not help.
    assert.equal(canSnoozeReminder(find('Tire rotation')), false);
    assert.equal(canSnoozeReminder(find('Warranty')), false);
    assert.equal(canSnoozeReminder(find('Vehicle registration')), false);
  });

  it('snoozes a week past the later of today and the due date', () => {
    assert.equal(snoozedDueDate('2026-07-01', TODAY), '2026-08-08');
    assert.equal(snoozedDueDate('2026-08-10', TODAY), '2026-08-17');
    assert.equal(snoozedDueDate(undefined, TODAY), '2026-08-08');
    // A snoozed overdue item leaves the overdue list.
    const snoozed = { ...hvac, schedules: [{ ...hvac.schedules![0], nextDueDate: snoozedDueDate('2026-07-01', TODAY) }] };
    const after = buildMaintenanceReminders([snoozed], [], TODAY, TZ).find((item) => item.title === 'Replace air filter');
    assert.equal(after?.status, 'due_soon');
  });

  it('works out one-tap completion values, or asks when it cannot', () => {
    const filter = findReminderSchedule(find('Replace air filter'), [hvac], [suv])!;
    assert.deepEqual(quickCompletionValues(filter, TODAY), { completedDate: TODAY, nextDueDate: '2026-11-01' });
    const legacy = findReminderSchedule(find('Legacy coil clean'), [hvac], [suv])!;
    assert.equal(quickCompletionValues(legacy, TODAY), null);
    const tires = findReminderSchedule(find('Tire rotation'), [hvac], [suv])!;
    assert.deepEqual(quickCompletionValues(tires, TODAY), { completedDate: TODAY, mileage: 48_750, nextDueDate: undefined, nextDueMileage: 54_750 });
    const noMiles = findReminderSchedule(find('Tire rotation'), [hvac], [{ ...suv, currentMileage: undefined }]);
    // Without a recorded mileage the reminder is date-only, and the mileage interval cannot advance.
    if (noMiles) assert.equal(quickCompletionValues(noMiles, TODAY), null);
  });

  it('keys reminder UI state by cycle: an early completion shows the next cycle unchecked (Codex 4503879033)', () => {
    // A weekly schedule due in 3 days is completed today; the next cycle (due in 7 days) is
    // still in the due-soon window and the builder gives it the same reminder id.
    const weekly: HomeAsset = { ...hvac, schedules: [{ id: 'weekly', mode: 'scheduled', scheduleName: 'Wipe filter', frequencyType: 'days', intervalValue: 7, nextDueDate: '2026-08-04' }] };
    const before = buildMaintenanceReminders([weekly], [], TODAY, TZ).find((item) => item.title === 'Wipe filter')!;
    const target = findReminderSchedule(before, [weekly], [])!;
    const done = completedAssetSchedule(target.schedule as HomeAssetSchedule, quickCompletionValues(target, TODAY)!);
    const after = buildMaintenanceReminders([{ ...weekly, schedules: [done] }], [], TODAY, TZ).find((item) => item.title === 'Wipe filter')!;
    assert.equal(after.id, before.id);
    assert.notEqual(reminderCycleKey(after), reminderCycleKey(before));
    // The same cycle keeps its key as its status changes.
    assert.equal(reminderCycleKey({ ...before, status: 'overdue' } as typeof before), reminderCycleKey(before));
    assert.notEqual(reminderCycleKey({ ...before, dueMileage: 50_000 }), reminderCycleKey({ ...before, dueMileage: 56_000 }));
  });

  it('never completes a schedule into one with no next due (Codex 4503879037)', () => {
    const oneOff = { targetType: 'home_asset' as const, asset: hvac, scheduleIndex: 0, schedule: { id: 'x', mode: 'scheduled' as const, scheduleName: 'One-off', nextDueDate: '2026-08-05' } };
    assert.equal(serviceCompletionValues(oneOff, TODAY), null);
    const byMileageOnly = { targetType: 'vehicle' as const, vehicle: suv, scheduleIndex: 0, schedule: { id: 'y', mode: 'scheduled' as const, serviceName: 'Timing belt', nextDueMileage: 60_000 } };
    assert.equal(serviceCompletionValues(byMileageOnly, TODAY, 48_750), null);
    const dateOnly = { ...byMileageOnly, schedule: { id: 'z', mode: 'scheduled' as const, serviceName: 'Inspection', nextDueDate: '2026-09-01' } };
    assert.equal(serviceCompletionValues(dateOnly, TODAY), null);
    // A mileage interval needs the mileage from the log.
    const tires = findReminderSchedule(find('Tire rotation'), [hvac], [suv])!;
    assert.equal(serviceCompletionValues(tires, '2026-07-30'), null);
    assert.deepEqual(serviceCompletionValues(tires, '2026-07-30', 49_100), { completedDate: '2026-07-30', mileage: 49_100, nextDueDate: undefined, nextDueMileage: 55_100 });
    // Mark done uses the same rule at today's date and the recorded mileage.
    assert.deepEqual(quickCompletionValues(tires, TODAY), serviceCompletionValues(tires, TODAY, 48_750));
  });

  it('advances schedules the same way as the completion dialog', () => {
    assert.deepEqual(completedAssetSchedule(hvac.schedules![0], { completedDate: TODAY }), {
      ...hvac.schedules![0], lastCompletedDate: TODAY, nextDueDate: '2026-11-01',
    });
    assert.equal(completedAssetSchedule(hvac.schedules![0], { completedDate: TODAY, nextDueDate: '2026-09-01' }).nextDueDate, '2026-09-01');
    const tires = completedVehicleSchedule(suv.serviceSchedules![0], { completedDate: TODAY, mileage: 48_750 });
    assert.equal(tires.nextDueMileage, 54_750);
    assert.equal(tires.lastCompletedMileage, 48_750);
    const brakes = completedVehicleSchedule(suv.serviceSchedules![1], { completedDate: TODAY });
    assert.equal(brakes.nextDueDate, '2028-08-01');



    // Completion ends a snooze even when the new cycle lands on the snoozed date (snooze + done the same day).
    const snoozed = { ...hvac.schedules![0], nextDueDate: '2026-08-08', snoozedUntil: '2026-08-08' };
    const done = completedAssetSchedule(snoozed, { completedDate: TODAY, nextDueDate: '2026-08-08' });
    assert.equal(done.nextDueDate, '2026-08-08');
    assert.equal('snoozedUntil' in done, false);
    const doneVehicle = completedVehicleSchedule({ ...suv.serviceSchedules![1], snoozedUntil: '2026-08-08' }, { completedDate: TODAY });
    assert.equal('snoozedUntil' in doneVehicle, false);
  });
});

describe('maintenance display rules', () => {
  it('offers an AI summary only for notes worth summarizing', () => {
    assert.equal(shouldOfferAiSummary(undefined), false);
    assert.equal(shouldOfferAiSummary('Synthetic oil service completed.'), false);
    assert.equal(shouldOfferAiSummary('Replaced filter'), false);
    assert.equal(shouldOfferAiSummary('System operational; filter replacement due soon.'), true);
    assert.equal(shouldOfferAiSummary('Tech came out.\nFound a leak at the valve.'), true);
    assert.equal(shouldOfferAiSummary(Array.from({ length: 40 }, () => 'word').join(' ')), true);
  });

  it('drops empty detail fields instead of printing "Not recorded" (D15)', () => {
    assert.deepEqual(presentFields([
      { label: 'Brand', value: 'Carrier' },
      { label: 'Model', value: '' },
      { label: 'Serial', value: '   ' },
      { label: 'Price', value: undefined },
      { label: 'Year', value: 0 },
    ]), [{ label: 'Brand', value: 'Carrier' }, { label: 'Year', value: '0' }]);
  });

  it('picks the newest photo for an asset card (H30)', () => {
    const base = { householdId: 'h', targetType: 'home_asset', targetId: 'hvac-main', filePath: 'x', downloadUrl: 'https://example.test/x' } as const;
    const attachments: MaintenanceAttachment[] = [
      { ...base, id: 'receipt', category: 'receipt', fileName: 'receipt.jpg', contentType: 'image/jpeg', createdAt: '2026-07-03' },
      { ...base, id: 'old', category: 'photo', fileName: 'old.png', contentType: 'image/png', createdAt: '2026-07-01' },
      { ...base, id: 'new', category: 'photo', fileName: 'new.webp', contentType: 'image/webp', createdAt: '2026-07-02' },
      { ...base, id: 'pdf', category: 'photo', fileName: 'scan.pdf', contentType: 'application/pdf', createdAt: '2026-07-04' },
      { ...base, id: 'svg', category: 'photo', fileName: 'logo.svg', contentType: 'image/svg+xml', createdAt: '2026-07-05' },
      { ...base, id: 'other', targetId: 'dishwasher', category: 'photo', fileName: 'd.jpg', contentType: 'image/jpeg', createdAt: '2026-07-06' },
      { ...base, id: 'nourl', downloadUrl: undefined, category: 'photo', fileName: 'n.jpg', contentType: 'image/jpeg', createdAt: '2026-07-07' },
    ];
    assert.equal(pickAssetPhoto(attachments, 'hvac-main')?.id, 'new');
    assert.equal(pickAssetPhoto(attachments.filter((item) => item.category !== 'photo'), 'hvac-main')?.id, 'receipt');
    assert.equal(pickAssetPhoto([], 'hvac-main'), null);
  });
});

describe('maintenance components use tokens only', () => {
  it('has no raw color literals', () => {
    for (const file of ['asset-card.tsx', 'health-panel.tsx', 'health-ring.tsx', 'reminder-list.tsx']) {
      const source = readFileSync(resolve(process.cwd(), 'src/components/maintenance', file), 'utf8');
      assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\((?!var)/i, file);
    }
  });
});
