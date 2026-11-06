/** Pure helpers for showing Home Assistant states (tests/unit/household-automation.test.ts). */

export type EntityStateTone = 'on' | 'off' | 'alert' | 'unavailable' | 'value';

const ON = new Set(['on', 'open', 'home', 'playing', 'unlocked', 'heat', 'cool', 'heat_cool', 'auto', 'armed_home', 'armed_away', 'armed_night', 'active']);
const OFF = new Set(['off', 'closed', 'not_home', 'away', 'idle', 'paused', 'standby', 'locked', 'disarmed', 'inactive']);
const ALERT = new Set(['triggered', 'problem', 'jammed', 'unlocking', 'locking', 'opening', 'closing', 'pending', 'arming']);
const UNAVAILABLE = new Set(['unavailable', 'unknown', 'none', '']);

/** Color tone for a state chip. Numbers and free text are neutral values. */
export function entityStateTone(state: string | null | undefined): EntityStateTone {
  const value = (state ?? '').trim().toLowerCase();
  if (UNAVAILABLE.has(value)) return 'unavailable';
  if (ON.has(value)) return 'on';
  if (OFF.has(value)) return 'off';
  if (ALERT.has(value)) return 'alert';
  return 'value';
}

/**
 * Human label for a state: "not_home" → "Not home", "unavailable" → "Unavailable",
 * "21.5" + "°C" → "21.5 °C". Timestamps and other free text are kept as they are.
 */
export function entityStateLabel(state: string | null | undefined, unit?: string | null): string {
  const raw = (state ?? '').trim();
  if (!raw || raw.toLowerCase() === 'none') return 'No state';
  const tone = entityStateTone(raw);
  if (tone !== 'value') {
    const words = raw.toLowerCase().replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return unit ? `${raw} ${unit}` : raw;
}
