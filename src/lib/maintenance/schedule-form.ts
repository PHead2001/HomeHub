// One schedule row of the asset and vehicle forms: how an edit changes its next due date (M3
// anchoring, PR #211 review), pure for unit tests. A due date the form suggested (a preset's first
// due day, or the first calendar day of a calendar-anchored schedule) is "generated" and follows
// later changes of the anchor and interval; a date the person typed is never overwritten.
import { firstCalendarDue, nextDueDay } from '../../../functions/src/shared/maintenance-schedule';

export type CalendarDueRow = {
  anchor: '' | 'completion' | 'calendar';
  anchorMonth: string;
  anchorDay: string;
  nextDueDate: string;
  /** True while nextDueDate is one the form suggested (not typed). */
  nextDueGenerated?: boolean;
};

export type RowInterval = { unit: 'days' | 'weeks' | 'months' | 'years' | undefined; value: number | undefined };

/** Fields whose change makes a generated due date be worked out again. */
export const DUE_INPUT_FIELDS = ['anchor', 'anchorMonth', 'anchorDay', 'frequencyType', 'intervalValue', 'intervalMonths'] as const;

const toNumber = (value: string) => {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Applies one edit to a schedule row. A typed due date is kept as typed (and marks the date as
 * the person's); clearing it lets the form suggest one again. When the anchor or interval changes,
 * a generated (or empty, for a calendar schedule) due date is worked out again: the first anchor
 * day on or after today for a calendar schedule (`firstCalendarDue`), else today plus the
 * interval; with nothing to work it out from, a generated date is cleared.
 */
export function applyScheduleRowEdit<S extends CalendarDueRow>(
  row: S, patch: Partial<S>, intervalOf: (row: S) => RowInterval, today: string,
): S {
  const next = { ...row, ...patch } as S;
  if ('nextDueDate' in patch) {
    next.nextDueGenerated = false;
    if (next.nextDueDate) return next;
  }
  const dueInputChanged = DUE_INPUT_FIELDS.some(field => field in patch) || 'nextDueDate' in patch;
  if (!dueInputChanged) return next;
  const generated = next.nextDueGenerated === true;
  const calendar = next.anchor === 'calendar';
  if (!generated && !(calendar && !next.nextDueDate)) return next;
  const { unit, value } = intervalOf(next);
  const due = unit && value
    ? calendar
      ? firstCalendarDue({ unit, value, anchor: 'calendar', anchorMonth: toNumber(next.anchorMonth), anchorDay: toNumber(next.anchorDay) }, today)
      : nextDueDay({ unit, value }, today)
    : undefined;
  if (due) return { ...next, nextDueDate: due, nextDueGenerated: true };
  return generated ? { ...next, nextDueDate: '', nextDueGenerated: false } : next;
}
