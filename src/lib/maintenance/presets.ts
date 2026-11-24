// Schedule presets (MA-27b): a small catalog of common maintenance by asset
// category, plus vehicle services, turned into editable schedule drafts for the
// add/edit forms. Pure (ids come from an injectable factory). Calendar-anchored
// presets carry `anchor: 'calendar'` and their month, so they stay on the
// calendar however early or late they are done.
import { isDayString } from '../../../functions/src/shared/calendar';
import { firstCalendarDue, nextDueDay } from '../../../functions/src/shared/maintenance-schedule';
import type { HomeAssetCategory, HomeAssetSchedule, VehicleServiceSchedule } from '../types';

export type AssetSchedulePreset = {
  key: string;
  label: string;
  /** Plain-language interval, e.g. "Every 3 months". */
  summary: string;
  frequencyType: NonNullable<HomeAssetSchedule['frequencyType']>;
  intervalValue: number;
  anchor?: 'calendar';
  anchorMonth?: number;
  anchorDay?: number;
};

export type VehicleSchedulePreset = {
  key: string;
  label: string;
  summary: string;
  intervalMiles?: number;
  intervalMonths?: number;
};

export type PresetCategory = HomeAssetCategory | 'Vehicle';

const SMOKE_ALARMS: AssetSchedulePreset = {
  key: 'smoke-alarm-batteries', label: 'Replace smoke-alarm batteries', summary: 'Every year', frequencyType: 'years', intervalValue: 1,
};

export const ASSET_SCHEDULE_PRESETS: Readonly<Record<HomeAssetCategory, readonly AssetSchedulePreset[]>> = {
  HVAC: [
    { key: 'hvac-filter', label: 'Replace HVAC filter', summary: 'Every 3 months', frequencyType: 'months', intervalValue: 3 },
    { key: 'hvac-tune-up', label: 'HVAC tune-up', summary: 'Every year, in April', frequencyType: 'years', intervalValue: 1, anchor: 'calendar', anchorMonth: 4, anchorDay: 1 },
  ],
  Appliance: [
    { key: 'dryer-vent', label: 'Clean dryer vent', summary: 'Every year', frequencyType: 'years', intervalValue: 1 },
    { key: 'fridge-coils', label: 'Clean refrigerator coils', summary: 'Every year', frequencyType: 'years', intervalValue: 1 },
    { key: 'dishwasher-filter', label: 'Clean dishwasher filter', summary: 'Every month', frequencyType: 'months', intervalValue: 1 },
  ],
  Plumbing: [
    { key: 'water-heater-flush', label: 'Flush water heater', summary: 'Every year', frequencyType: 'years', intervalValue: 1 },
    { key: 'softener-salt', label: 'Check water-softener salt', summary: 'Every month', frequencyType: 'months', intervalValue: 1 },
  ],
  Electrical: [
    SMOKE_ALARMS,
    { key: 'gfci-test', label: 'Test GFCI outlets', summary: 'Every month', frequencyType: 'months', intervalValue: 1 },
  ],
  Network: [
    { key: 'router-firmware', label: 'Check router firmware', summary: 'Every 3 months', frequencyType: 'months', intervalValue: 3 },
  ],
  'Smart Home': [
    { key: 'smart-batteries', label: 'Replace sensor batteries', summary: 'Every year', frequencyType: 'years', intervalValue: 1 },
  ],
  'Lawn / Outdoor': [
    { key: 'gutters', label: 'Clean gutters', summary: 'Every year, in October', frequencyType: 'years', intervalValue: 1, anchor: 'calendar', anchorMonth: 10, anchorDay: 1 },
    { key: 'sprinkler-winterize', label: 'Winterize sprinklers', summary: 'Every year, in November', frequencyType: 'years', intervalValue: 1, anchor: 'calendar', anchorMonth: 11, anchorDay: 1 },
  ],
  Tool: [
    { key: 'mower-blade', label: 'Sharpen mower blade', summary: 'Every year, in March', frequencyType: 'years', intervalValue: 1, anchor: 'calendar', anchorMonth: 3, anchorDay: 1 },
  ],
  Other: [SMOKE_ALARMS],
};

export const VEHICLE_SCHEDULE_PRESETS: readonly VehicleSchedulePreset[] = [
  { key: 'oil-change', label: 'Oil change', summary: 'Every 5,000 miles or 6 months', intervalMiles: 5000, intervalMonths: 6 },
  { key: 'tire-rotation', label: 'Tire rotation', summary: 'Every 7,500 miles', intervalMiles: 7500 },
  { key: 'engine-air-filter', label: 'Engine air filter', summary: 'Every 15,000 miles or 12 months', intervalMiles: 15000, intervalMonths: 12 },
  { key: 'cabin-air-filter', label: 'Cabin air filter', summary: 'Every 15,000 miles or 12 months', intervalMiles: 15000, intervalMonths: 12 },
  { key: 'brake-inspection', label: 'Brake inspection', summary: 'Every 12 months', intervalMonths: 12 },
  { key: 'wiper-blades', label: 'Replace wiper blades', summary: 'Every 12 months', intervalMonths: 12 },
];

/** The presets offered for a category (assets) or 'Vehicle'. */
export function schedulePresetsFor(category: 'Vehicle'): readonly VehicleSchedulePreset[];
export function schedulePresetsFor(category: HomeAssetCategory): readonly AssetSchedulePreset[];
export function schedulePresetsFor(category: PresetCategory): readonly (AssetSchedulePreset | VehicleSchedulePreset)[];
export function schedulePresetsFor(category: PresetCategory) {
  if (category === 'Vehicle') return VEHICLE_SCHEDULE_PRESETS;
  return ASSET_SCHEDULE_PRESETS[category] ?? [];
}

export type PresetDraftContext = {
  /** Household day; when given, drafts get a first due date. */
  today?: string;
  /** The vehicle's mileage; when given, mileage presets get a first due mileage. */
  currentMileage?: number;
  /** New id suffix (default: random); injectable for tests. */
  newId?: () => string;
};

const randomSuffix = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 10);

/**
 * Editable schedule drafts for a category, in catalog order: each has a new id
 * (`{presetKey}-{suffix}`, stable once saved), `mode: 'scheduled'` and the
 * preset's interval. With `today`, a first due date is suggested: the next anchor
 * day for calendar presets (gutters in October), otherwise today + interval
 * (as if done today). With `currentMileage`, vehicle presets get the next due
 * mileage. Everything stays editable in the form.
 */
export function presetSchedulesFor(category: 'Vehicle', context?: PresetDraftContext): VehicleServiceSchedule[];
export function presetSchedulesFor(category: HomeAssetCategory, context?: PresetDraftContext): HomeAssetSchedule[];
export function presetSchedulesFor(category: PresetCategory, context: PresetDraftContext = {}): Array<HomeAssetSchedule | VehicleServiceSchedule> {
  const newId = context.newId ?? randomSuffix;
  const today = context.today && isDayString(context.today) ? context.today : undefined;
  if (category === 'Vehicle') {
    return VEHICLE_SCHEDULE_PRESETS.map((preset): VehicleServiceSchedule => ({
      id: `${preset.key}-${newId()}`,
      mode: 'scheduled',
      serviceName: preset.label,
      ...(preset.intervalMiles ? { intervalMiles: preset.intervalMiles } : {}),
      ...(preset.intervalMonths ? { intervalMonths: preset.intervalMonths } : {}),
      ...(today && preset.intervalMonths ? { nextDueDate: nextDueDay({ unit: 'months', value: preset.intervalMonths }, today) } : {}),
      ...(preset.intervalMiles && typeof context.currentMileage === 'number' ? { nextDueMileage: context.currentMileage + preset.intervalMiles } : {}),
    }));
  }
  return (ASSET_SCHEDULE_PRESETS[category] ?? []).map((preset): HomeAssetSchedule => {
    const anchored = preset.anchor === 'calendar'
      ? { anchor: 'calendar' as const, anchorMonth: preset.anchorMonth, ...(preset.anchorDay ? { anchorDay: preset.anchorDay } : {}) }
      : {};
    const interval = { unit: preset.frequencyType, value: preset.intervalValue, ...anchored };
    const nextDueDate = today
      ? preset.anchor === 'calendar' ? firstCalendarDue(interval, today) : nextDueDay(interval, today)
      : undefined;
    return {
      id: `${preset.key}-${newId()}`,
      mode: 'scheduled',
      scheduleName: preset.label,
      frequencyType: preset.frequencyType,
      intervalValue: preset.intervalValue,
      ...anchored,
      ...(nextDueDate ? { nextDueDate } : {}),
    };
  });
}
