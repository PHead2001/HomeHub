// A member's own push preferences (NO-24), stored with their push tokens in
// the owner-only users/{email}/private/push document as
// `prefs: { mutedCategories: string[], quietHours: {start, end} | null }`.
// Pure: read by the push function and validated by the Profile card; the
// rules check the same shape.
import {readLocalWindow, type LocalWindow} from "./push-hold";

export const PUSH_PREF_CATEGORIES = [
  "chores", "pets", "shopping", "maintenance", "automation", "system",
  "general",
] as const;

export type PushPrefs = {
  /** Categories never pushed to this member (still in their bell). */
  mutedCategories: string[];
  /** No pushes to this member in these hours (household time, D-6). */
  quietHours: LocalWindow | null;
};

/**
 * The stored preferences, defaulting to none.
 * @param {unknown} value Stored `prefs`.
 * @return {PushPrefs} Preferences.
 */
export const readPushPrefs = (value: unknown): PushPrefs => {
  const raw = value && typeof value === "object" && !Array.isArray(value) ?
    value as Record<string, unknown> : {};
  const muted = Array.isArray(raw.mutedCategories) ?
    raw.mutedCategories.filter((c): c is string => typeof c === "string" &&
      (PUSH_PREF_CATEGORIES as readonly string[]).includes(c)) : [];
  return {
    mutedCategories: [...new Set(muted)],
    quietHours: readLocalWindow(raw.quietHours),
  };
};

/**
 * Preferences as the Profile card saves them: known categories only, two
 * different "HH:mm" times or none. Returns null when invalid.
 * @param {unknown} input Candidate.
 * @return {PushPrefs | null} Clean preferences, or null.
 */
export const validatePushPrefs = (input: unknown): PushPrefs | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.mutedCategories)) return null;
  if (raw.mutedCategories.some((c) => typeof c !== "string" ||
    !(PUSH_PREF_CATEGORIES as readonly string[]).includes(c))) return null;
  if (raw.quietHours !== null && !readLocalWindow(raw.quietHours)) return null;
  return readPushPrefs(raw);
};

/**
 * Whether this member mutes the notification's category.
 * @param {PushPrefs} prefs Preferences.
 * @param {unknown} category The notification's category.
 * @return {boolean} True when muted.
 */
export const mutesCategory = (prefs: PushPrefs, category: unknown): boolean =>
  typeof category === "string" && prefs.mutedCategories.includes(category);
