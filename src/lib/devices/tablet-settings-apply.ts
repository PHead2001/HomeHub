// Where each device-record setting is applied on the tablet (docs/modules/devices/README.md,
// "Tablet shell"). Pure: the shell feeds these values to the appearance provider, the
// weather client, the dashboard scope, the state machine's timers, navigation and the
// notice listeners. Every value comes from the device record (or, for quiet hours, the
// household document); none from a personal session's local storage. A previous personal
// session's colour preset, haptics, seasonal or weather choices on the same browser never
// carry over (tests/unit/devices-settings-apply.test.ts covers every setting).

import { DEFAULT_DARK_PRESET, DEFAULT_LIGHT_PRESET, type DarkPresetId, type LightPresetId, type ThemeMode } from '@/lib/theme/tokens';
import { householdPermissions } from '@/lib/permissions';
import type { HouseholdPermission } from '@/lib/types';
import type { TemperatureUnit } from '@/lib/dashboard/weather';
import { shellTimersFrom, type ShellTimers } from './shell-state';
import { startView, tabletNavItems, type TabletNavItem, type TabletView } from './start-page';
import { deviceNotificationCategories, type DeviceNotificationCategory } from './device-session';
import type { DeviceSettings } from './types';

export type TabletAppearance = {
  mode: ThemeMode;
  darkPreset: DarkPresetId;
  lightPreset: LightPresetId;
  textScale: 100 | 115 | 130;
  reduceMotion: boolean;
  sound: boolean;
  haptics: boolean;
};

/** Comfort (D-T2) for the appearance provider; presets and haptics fixed, never a person's. */
export const appearanceFromRecord = (comfort: DeviceSettings['comfort']): TabletAppearance => ({
  mode: comfort.theme,
  darkPreset: DEFAULT_DARK_PRESET,
  lightPreset: DEFAULT_LIGHT_PRESET,
  textScale: comfort.textScale,
  reduceMotion: comfort.motion === 'reduced',
  sound: comfort.sound,
  haptics: false,
});

/** Weather (S12, HP-18b) for the weather client: the record's place and unit. */
export const weatherFromRecord = (display: DeviceSettings['display']): { enabled: boolean; city: string | null; unit: TemperatureUnit } => ({
  enabled: display.weather,
  city: display.weatherPlace,
  unit: display.temperatureUnit === 'F' ? 'fahrenheit' : 'celsius',
});

/**
 * What the tablet's views offer, from the record's sections: viewing, and Done on chores
 * (sent as a device action; the server decides for the person chosen in "Who's here?").
 * Nothing else is offered as writable (Pets follow in F4b).
 */
export function devicePermissions(sections: DeviceSettings['sections']): Record<HouseholdPermission, boolean> {
  const permissions = Object.fromEntries(householdPermissions.map((permission) => [permission, false])) as Record<HouseholdPermission, boolean>;
  permissions['chores.view'] = sections.chores;
  permissions['chores.complete'] = sections.chores;
  permissions['shopping.view'] = sections.shopping;
  permissions['pets.view'] = sections.pets;
  permissions['maintenance.view'] = sections.maintenance;
  return permissions;
}

export type TabletApplication = {
  topBar: { name: string; room: string };
  appearance: TabletAppearance;
  weather: ReturnType<typeof weatherFromRecord>;
  /** The house's seasonal touches (the dashboard scope; the house's own toggle is hidden). */
  seasonal: boolean;
  timers: ShellTimers;
  start: TabletView;
  rail: { rail: TabletNavItem[]; more: TabletNavItem[] };
  noticeCategories: DeviceNotificationCategory[];
  permissions: Record<HouseholdPermission, boolean>;
  /** Scanning camera: no scanning on the tablet shell yet (kitchen scan station is out of scope). */
  camera: 'not-used';
};

export const tabletApplication = (settings: DeviceSettings): TabletApplication => ({
  topBar: { name: settings.name, room: settings.room },
  appearance: appearanceFromRecord(settings.comfort),
  weather: weatherFromRecord(settings.display),
  seasonal: settings.display.seasonal,
  timers: shellTimersFrom(settings.idle),
  start: startView(settings.startPage, settings.sections).view,
  rail: tabletNavItems(settings.sections),
  noticeCategories: deviceNotificationCategories(settings.sections),
  permissions: devicePermissions(settings.sections),
  camera: 'not-used',
});
