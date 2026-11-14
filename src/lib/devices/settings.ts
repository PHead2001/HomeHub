// Device record settings: defaults, reading a stored record, and validating an edit.
// Pure and shared by the server (src/lib/server/device-management.ts) and the forms
// (src/components/household/device-settings-form.tsx). See docs/modules/devices/README.md.
import {
  DEVICE_SECTIONS,
  type DeviceComfort,
  type DeviceDisplay,
  type DeviceIdle,
  type DeviceSectionKey,
  type DeviceSections,
  type DeviceSettings,
  type DeviceStartPage,
} from './types';

export const DEVICE_NAME_MAX = 40;
export const DEVICE_ROOM_MAX = 40;
export const WEATHER_PLACE_MAX = 80;
export const IDLE_HOME_MIN_SEC = 30;
export const IDLE_HOME_MAX_SEC = 1800;
export const IDLE_AMBIENT_MAX_SEC = 7200;
export const TEXT_SCALES = [100, 115, 130] as const;

export const DEVICE_SECTION_LABELS: Record<DeviceSectionKey, string> = {
  chores: 'Chores',
  shopping: 'Shopping',
  pets: 'Pets',
  calendar: 'Calendar',
  maintenance: 'Maintenance',
};

export const defaultSections = (): DeviceSections => ({ chores: true, shopping: true, pets: true, calendar: true, maintenance: true });
export const defaultComfort = (): DeviceComfort => ({ theme: 'system', textScale: 115, motion: 'system', sound: true });
export const defaultDisplay = (): DeviceDisplay => ({ weather: false, weatherPlace: null, temperatureUnit: 'C', seasonal: true });
export const defaultIdle = (): DeviceIdle => ({ homeAfterSec: 120, ambientAfterSec: 600 });

export const defaultDeviceSettings = (name: string, room: string, sections?: DeviceSections): DeviceSettings => ({
  name,
  room,
  sections: sections ? { ...sections } : defaultSections(),
  startPage: { kind: 'home' },
  comfort: defaultComfort(),
  display: defaultDisplay(),
  idle: defaultIdle(),
  camera: 'front',
});

/** The section a start page lives in (`null` for Home). */
export const startPageSection = (page: DeviceStartPage): DeviceSectionKey | null => {
  switch (page.kind) {
    case 'chores':
    case 'chores-room':
      return 'chores';
    case 'shopping':
    case 'shopping-list':
      return 'shopping';
    case 'pets':
    case 'calendar':
    case 'maintenance':
      return page.kind;
    default:
      return null;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Trimmed label of 1..max characters, or null. */
export const readLabel = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
};

const readRefId = (value: unknown): string | null =>
  typeof value === 'string' && value.length >= 1 && value.length <= 200 && !value.includes('/') ? value : null;

/** A valid stored or submitted start page, or null. */
export const readStartPage = (value: unknown): DeviceStartPage | null => {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  switch (value.kind) {
    case 'home':
    case 'chores':
    case 'shopping':
    case 'pets':
    case 'calendar':
    case 'maintenance':
      return keys.length === 1 ? { kind: value.kind } : null;
    case 'chores-room': {
      const roomId = readRefId(value.roomId);
      return roomId && keys.length === 2 ? { kind: 'chores-room', roomId } : null;
    }
    case 'shopping-list': {
      const listId = readRefId(value.listId);
      return listId && keys.length === 2 ? { kind: 'shopping-list', listId } : null;
    }
    default:
      return null;
  }
};

const pick = <T,>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;

const intIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;

/**
 * The full settings of a stored record. Missing or malformed fields read as their
 * defaults, so a record written by an older server stays usable.
 */
export const readDeviceSettings = (data: Record<string, unknown> | undefined): DeviceSettings => {
  const source = data ?? {};
  const sections = defaultSections();
  if (isPlainObject(source.sections)) {
    for (const key of DEVICE_SECTIONS) {
      if (typeof source.sections[key] === 'boolean') sections[key] = source.sections[key] as boolean;
    }
  }
  const comfortIn = isPlainObject(source.comfort) ? source.comfort : {};
  const displayIn = isPlainObject(source.display) ? source.display : {};
  const idleIn = isPlainObject(source.idle) ? source.idle : {};
  const comfort = defaultComfort();
  const display = defaultDisplay();
  const idle = defaultIdle();
  const homeAfterSec = intIn(idleIn.homeAfterSec, IDLE_HOME_MIN_SEC, IDLE_HOME_MAX_SEC) ?? idle.homeAfterSec;
  const ambientAfterSec = intIn(idleIn.ambientAfterSec, homeAfterSec, IDLE_AMBIENT_MAX_SEC) ?? Math.max(idle.ambientAfterSec, homeAfterSec);
  return {
    name: readLabel(source.name, DEVICE_NAME_MAX) ?? 'Wall tablet',
    room: readLabel(source.room, DEVICE_ROOM_MAX) ?? '',
    sections,
    startPage: readStartPage(source.startPage) ?? { kind: 'home' },
    comfort: {
      theme: pick(comfortIn.theme, ['system', 'light', 'dark'] as const, comfort.theme),
      textScale: pick(comfortIn.textScale, TEXT_SCALES, comfort.textScale),
      motion: pick(comfortIn.motion, ['system', 'reduced', 'full'] as const, comfort.motion),
      sound: typeof comfortIn.sound === 'boolean' ? comfortIn.sound : comfort.sound,
    },
    display: {
      weather: typeof displayIn.weather === 'boolean' ? displayIn.weather : display.weather,
      weatherPlace: readLabel(displayIn.weatherPlace, WEATHER_PLACE_MAX),
      temperatureUnit: pick(displayIn.temperatureUnit, ['C', 'F'] as const, display.temperatureUnit),
      seasonal: typeof displayIn.seasonal === 'boolean' ? displayIn.seasonal : display.seasonal,
    },
    idle: { homeAfterSec, ambientAfterSec },
    camera: pick(source.camera, ['front', 'rear'] as const, 'front'),
  };
};

/** Sections submitted on a new device code: every key a boolean, missing keys on. */
export const readSectionsInput = (value: unknown): DeviceSections | null => {
  if (value === undefined || value === null) return defaultSections();
  if (!isPlainObject(value)) return null;
  const sections = defaultSections();
  for (const [key, flag] of Object.entries(value)) {
    if (!(DEVICE_SECTIONS as readonly string[]).includes(key) || typeof flag !== 'boolean') return null;
    sections[key as DeviceSectionKey] = flag;
  }
  return sections;
};

export type DevicePatchScope = 'admin' | 'comfort';

export type DevicePatchResult =
  | {
    ok: true;
    /** Dotted field paths and values to write; only fields whose value changes. */
    updates: Record<string, unknown>;
    /** Top-level settings that changed (for the activity log). */
    changed: string[];
    next: DeviceSettings;
  }
  | { ok: false; code: 'invalid_input' | 'start_page_section_off'; field: string; message: string };

const fail = (field: string, message: string, code: 'invalid_input' | 'start_page_section_off' = 'invalid_input'): DevicePatchResult =>
  ({ ok: false, code, field, message });

const ADMIN_KEYS = ['name', 'room', 'sections', 'startPage', 'comfort', 'display', 'idle', 'camera'] as const;
const COMFORT_KEYS = ['theme', 'textScale', 'motion', 'sound'] as const;
const DISPLAY_KEYS = ['weather', 'weatherPlace', 'temperatureUnit', 'seasonal'] as const;
const IDLE_KEYS = ['homeAfterSec', 'ambientAfterSec'] as const;

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Validates a partial edit of a device record against its current settings. Every
 * named field is checked; nothing else is accepted. `comfort` scope (the tablet's
 * own comfort settings, D-T2) accepts only `comfort`. The start page may never point
 * into a section that is off (D-T18): naming such a start page is refused, and
 * switching off the section that holds the current start page resets it to Home in
 * the same write, so the record never holds an invalid pair.
 */
export const validateDevicePatch = (patch: unknown, current: DeviceSettings, scope: DevicePatchScope = 'admin'): DevicePatchResult => {
  if (!isPlainObject(patch)) return fail('patch', 'Nothing to save.');
  const allowedKeys: readonly string[] = scope === 'comfort' ? ['comfort'] : ADMIN_KEYS;
  const keys = Object.keys(patch);
  if (keys.length === 0) return fail('patch', 'Nothing to save.');
  for (const key of keys) {
    if (!allowedKeys.includes(key)) return fail(key, scope === 'comfort' ? 'Only comfort settings can be changed here.' : 'That setting is not known.');
  }

  const next: DeviceSettings = JSON.parse(JSON.stringify(current)) as DeviceSettings;

  if ('name' in patch) {
    const name = readLabel(patch.name, DEVICE_NAME_MAX);
    if (!name) return fail('name', `Give the tablet a name of 1 to ${DEVICE_NAME_MAX} characters.`);
    next.name = name;
  }
  if ('room' in patch) {
    const room = readLabel(patch.room, DEVICE_ROOM_MAX);
    if (!room) return fail('room', `Give the room a name of 1 to ${DEVICE_ROOM_MAX} characters.`);
    next.room = room;
  }
  if ('sections' in patch) {
    if (!isPlainObject(patch.sections) || Object.keys(patch.sections).length === 0) return fail('sections', 'Choose which sections the tablet shows.');
    for (const [key, flag] of Object.entries(patch.sections)) {
      if (!(DEVICE_SECTIONS as readonly string[]).includes(key) || typeof flag !== 'boolean') return fail('sections', 'Choose which sections the tablet shows.');
      next.sections[key as DeviceSectionKey] = flag;
    }
  }
  if ('startPage' in patch) {
    const page = readStartPage(patch.startPage);
    if (!page) return fail('startPage', 'Choose a start page.');
    next.startPage = page;
  }
  if ('comfort' in patch) {
    const comfort = patch.comfort;
    if (!isPlainObject(comfort) || Object.keys(comfort).length === 0) return fail('comfort', 'Nothing to save.');
    for (const [key, value] of Object.entries(comfort)) {
      if (!(COMFORT_KEYS as readonly string[]).includes(key)) return fail(`comfort.${key}`, 'That setting is not known.');
      if (key === 'theme' && !['system', 'light', 'dark'].includes(value as string)) return fail('comfort.theme', 'Choose a theme.');
      if (key === 'textScale' && !(TEXT_SCALES as readonly unknown[]).includes(value)) return fail('comfort.textScale', 'Choose a text size.');
      if (key === 'motion' && !['system', 'reduced', 'full'].includes(value as string)) return fail('comfort.motion', 'Choose a motion setting.');
      if (key === 'sound' && typeof value !== 'boolean') return fail('comfort.sound', 'Choose whether sounds play.');
      (next.comfort as Record<string, unknown>)[key] = value;
    }
  }
  if ('display' in patch) {
    const display = patch.display;
    if (!isPlainObject(display) || Object.keys(display).length === 0) return fail('display', 'Nothing to save.');
    for (const [key, value] of Object.entries(display)) {
      if (!(DISPLAY_KEYS as readonly string[]).includes(key)) return fail(`display.${key}`, 'That setting is not known.');
      if ((key === 'weather' || key === 'seasonal') && typeof value !== 'boolean') return fail(`display.${key}`, 'Choose on or off.');
      if (key === 'temperatureUnit' && value !== 'C' && value !== 'F') return fail('display.temperatureUnit', 'Choose °C or °F.');
      if (key === 'weatherPlace') {
        if (value === null || (typeof value === 'string' && value.trim() === '')) {
          next.display.weatherPlace = null;
          continue;
        }
        const place = readLabel(value, WEATHER_PLACE_MAX);
        if (!place) return fail('display.weatherPlace', `Enter a place of up to ${WEATHER_PLACE_MAX} characters.`);
        next.display.weatherPlace = place;
        continue;
      }
      (next.display as Record<string, unknown>)[key] = value;
    }
  }
  if ('idle' in patch) {
    const idle = patch.idle;
    if (!isPlainObject(idle) || Object.keys(idle).length === 0) return fail('idle', 'Nothing to save.');
    for (const [key, value] of Object.entries(idle)) {
      if (!(IDLE_KEYS as readonly string[]).includes(key)) return fail(`idle.${key}`, 'That setting is not known.');
      if (typeof value !== 'number' || !Number.isInteger(value)) return fail(`idle.${key}`, 'Enter a whole number of seconds.');
      (next.idle as Record<string, number>)[key] = value;
    }
    if (next.idle.homeAfterSec < IDLE_HOME_MIN_SEC || next.idle.homeAfterSec > IDLE_HOME_MAX_SEC) {
      return fail('idle.homeAfterSec', 'Return to the start page after 30 seconds to 30 minutes.');
    }
    if (next.idle.ambientAfterSec < next.idle.homeAfterSec || next.idle.ambientAfterSec > IDLE_AMBIENT_MAX_SEC) {
      return fail('idle.ambientAfterSec', 'The ambient screen comes on no sooner than the return to the start page, and within 2 hours.');
    }
  }
  if ('camera' in patch) {
    if (patch.camera !== 'front' && patch.camera !== 'rear') return fail('camera', 'Choose the front or rear camera.');
    next.camera = patch.camera;
  }

  const pageSection = startPageSection(next.startPage);
  if (pageSection && !next.sections[pageSection]) {
    if ('startPage' in patch) {
      return fail('startPage', `The start page is in ${DEVICE_SECTION_LABELS[pageSection]}, which is off on this tablet.`, 'start_page_section_off');
    }
    next.startPage = { kind: 'home' };
  }

  const updates: Record<string, unknown> = {};
  const changed = new Set<string>();
  const compare = (path: string, top: string, before: unknown, after: unknown) => {
    if (sameValue(before, after)) return;
    updates[path] = after;
    changed.add(top);
  };
  compare('name', 'name', current.name, next.name);
  compare('room', 'room', current.room, next.room);
  for (const key of DEVICE_SECTIONS) compare(`sections.${key}`, 'sections', current.sections[key], next.sections[key]);
  compare('startPage', 'startPage', current.startPage, next.startPage);
  for (const key of COMFORT_KEYS) compare(`comfort.${key}`, 'comfort', current.comfort[key], next.comfort[key]);
  for (const key of DISPLAY_KEYS) compare(`display.${key}`, 'display', current.display[key], next.display[key]);
  for (const key of IDLE_KEYS) compare(`idle.${key}`, 'idle', current.idle[key], next.idle[key]);
  compare('camera', 'camera', current.camera, next.camera);
  return { ok: true, updates, changed: [...changed], next };
};
