/**
 * Cross-device theme sync (PR-6). The synced part of Appearance (mode, presets,
 * Reduce motion) lives in the profile's `theme` field and follows the person to
 * every device. Two rules keep devices from reverting each other:
 *
 * - A change writes only the keys that changed (`themeWrite`), merged into the
 *   stored object, so a device with an older copy never writes its stale values
 *   for the other keys back.
 * - The open page follows the live profile (`reconcileProfileTheme`): a change
 *   made on another device is applied here, except for keys this device has just
 *   written and whose echo has not arrived yet (so a quick second change is never
 *   undone by the first one's echo).
 *
 * Pure; unit tested in tests/unit/profile-correctness.test.ts.
 */
import { isDarkPresetId, isLightPresetId, isThemeMode } from './tokens';
import type { AppearancePreferences, ProfileAppearance } from './appearance';

export const SYNCED_KEYS = ['mode', 'darkPreset', 'lightPreset', 'reduceMotion'] as const;
export type SyncedKey = (typeof SYNCED_KEYS)[number];
export type SyncedValues = Partial<Pick<AppearancePreferences, SyncedKey>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const VALID: Record<SyncedKey, (value: unknown) => boolean> = {
  mode: isThemeMode,
  darkPreset: isDarkPresetId,
  lightPreset: isLightPresetId,
  reduceMotion: (value) => typeof value === 'boolean',
};

/** The synced keys whose values differ between two preference sets. */
export function changedSyncedKeys(previous: AppearancePreferences, next: AppearancePreferences): SyncedKey[] {
  return SYNCED_KEYS.filter((key) => previous[key] !== next[key]);
}

/**
 * Only the valid synced values a stored profile `theme` actually holds. A legacy
 * free-colour theme (no `version: 2`) holds none. Missing keys are left out rather
 * than defaulted, so a partial object never resets a key.
 */
export function storedSyncedValues(theme: unknown): SyncedValues {
  if (!isRecord(theme) || theme.version !== 2) return {};
  const out: Record<string, unknown> = {};
  for (const key of SYNCED_KEYS) {
    if (key in theme && VALID[key](theme[key])) out[key] = theme[key];
  }
  return out as SyncedValues;
}

/**
 * What to merge into the profile `theme` for a change. With a stored version 2
 * theme that already holds every synced key, only the changed keys are written;
 * otherwise (no theme, a legacy one, or missing keys) the whole synced set is
 * written so the stored object is complete. Null when nothing changed.
 */
export function themeWrite(storedTheme: unknown, next: AppearancePreferences, changed: readonly SyncedKey[]): Partial<ProfileAppearance> | null {
  if (changed.length === 0) return null;
  const stored = storedSyncedValues(storedTheme);
  const complete = SYNCED_KEYS.every((key) => key in stored);
  const keys = complete ? changed : SYNCED_KEYS;
  const write: Record<string, unknown> = { version: 2 };
  for (const key of keys) write[key] = next[key];
  return write as Partial<ProfileAppearance>;
}

/**
 * Reconciles this device's preferences with the live profile `theme`.
 * `pending` holds the values this device wrote and has not seen echoed yet:
 * a key whose profile value matches its pending value is acknowledged (dropped
 * from pending); a key with a different pending value is left alone (our write
 * is still on its way). Every other stored key that differs from this device is
 * returned in `apply`.
 */
export function reconcileProfileTheme(
  local: AppearancePreferences,
  profileTheme: unknown,
  pending: SyncedValues,
): { apply: SyncedValues; pending: SyncedValues } {
  const stored = storedSyncedValues(profileTheme);
  const apply: Record<string, unknown> = {};
  const stillPending: Record<string, unknown> = { ...pending };
  for (const key of SYNCED_KEYS) {
    if (!(key in stored)) continue;
    const value = stored[key];
    if (key in stillPending) {
      if (stillPending[key] === value) delete stillPending[key];
      continue;
    }
    if (local[key] !== value) apply[key] = value;
  }
  return { apply: apply as SyncedValues, pending: stillPending as SyncedValues };
}

/** Drops pending keys after a failed write, but only those still holding the failed values. */
export function dropPending(pending: SyncedValues, failed: SyncedValues): SyncedValues {
  const out: Record<string, unknown> = { ...pending };
  for (const key of SYNCED_KEYS) {
    if (key in failed && out[key] === failed[key]) delete out[key];
  }
  return out as SyncedValues;
}
