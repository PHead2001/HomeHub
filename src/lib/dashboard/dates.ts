/**
 * Local-calendar date helpers for the dashboard. Everything here is pure and works
 * on the viewer's local day, which is what "today" means on a dashboard.
 */

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses Firestore Timestamps, Dates, ISO strings, `yyyy-MM-dd` (as local midnight) and epoch numbers. */
export function toDateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate: unknown }).toDate === 'function') {
    const parsed = (value as { toDate: () => Date }).toDate();
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed : null;
  }
  if (typeof value === 'string') {
    const match = DATE_ONLY.exec(value.trim());
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `yyyy-MM-dd` of the local calendar day. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole local days from `now` to `date` (negative when `date` is in the past). */
export function daysBetween(date: Date, now: Date): number {
  return Math.round((startOfLocalDay(date).getTime() - startOfLocalDay(now).getTime()) / DAY_MS);
}

/** "today", "tomorrow", "in 3 days", "yesterday", "3 days ago". */
export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export function addLocalDays(date: Date, days: number): Date {
  const next = startOfLocalDay(date);
  next.setDate(next.getDate() + days);
  return next;
}
