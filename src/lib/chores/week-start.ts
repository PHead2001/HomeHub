/**
 * The household's "Week starts on" setting (CA-16; the household settings row HO-19
 * reuses it): `households/{h}.weekStartsOn`, 0 for Sunday or 1 for Monday. Absent or
 * unreadable means Monday, the rule every week view and the leaderboard used before
 * the setting existed. Owners and admins change it from Household, Overview (rules:
 * the household update rule allows this field only with a valid value). Pure.
 */

export type WeekStartsOn = 0 | 1;

export const DEFAULT_WEEK_STARTS_ON: WeekStartsOn = 1;

export const WEEK_START_OPTIONS: ReadonlyArray<{ value: WeekStartsOn; label: string }> = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
];

/** The stored value, or Monday when it is missing or not one of the allowed days. */
export function readWeekStartsOn(value: unknown): WeekStartsOn {
  return value === 0 || value === 1 ? value : DEFAULT_WEEK_STARTS_ON;
}

/** True for a value the household document may store. */
export function isWeekStartsOn(value: unknown): value is WeekStartsOn {
  return value === 0 || value === 1;
}

/** Short weekday names in week order ("Sun", "Mon", ... or "Mon", ... "Sun"). */
export function weekdayLabels(weekStartsOn: WeekStartsOn = DEFAULT_WEEK_STARTS_ON): string[] {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return Array.from({ length: 7 }, (_, i) => names[(weekStartsOn + i) % 7]);
}

/** The JavaScript weekday (0 = Sunday) a week ends on: the leaderboard's podium day. */
export function lastWeekday(weekStartsOn: WeekStartsOn = DEFAULT_WEEK_STARTS_ON): number {
  return (weekStartsOn + 6) % 7;
}
