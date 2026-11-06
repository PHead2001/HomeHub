/**
 * Day math for chores, on local "YYYY-MM-DD" keys. Pure (no Firebase), so the
 * Chores page, the calendar and unit tests share one definition of "the day a
 * chore is due" and "the day it was completed".
 */
import type { Chore } from '../types';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day of an instant, as `YYYY-MM-DD`. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Midnight (local) of a `YYYY-MM-DD` key. */
export function dayFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && DAY_KEY.test(value);
}

export function addDaysToKey(key: string, days: number): string {
  const date = dayFromKey(key);
  date.setDate(date.getDate() + days);
  return dayKey(date);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function diffDayKeys(a: string, b: string): number {
  const ms = dayFromKey(b).getTime() - dayFromKey(a).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * The day a chore is due. Recurring and temporary chores store their calendar day
 * (`originalDueDate`, in the household's timezone); reading it as a local date keeps
 * Thursday's chore on Thursday for every viewer. Older chores fall back to `dueDate`.
 */
export function choreDueKey(chore: Pick<Chore, 'originalDueDate' | 'dueDate'>): string {
  if (isDayKey(chore.originalDueDate)) return chore.originalDueDate;
  if (isDayKey(chore.dueDate)) return chore.dueDate;
  const parsed = new Date(chore.dueDate);
  return Number.isNaN(parsed.getTime()) ? '' : dayKey(parsed);
}

/** Firestore Timestamp-like values without importing the SDK. */
type TimestampLike = { toDate: () => Date } | { seconds: number; nanoseconds?: number };

const fromTimestampLike = (value: unknown): Date | null => {
  if (!value || typeof value !== 'object') return null;
  if ('toDate' in value && typeof (value as { toDate: unknown }).toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if ('seconds' in value && typeof (value as { seconds: unknown }).seconds === 'number') {
    return new Date((value as { seconds: number }).seconds * 1000);
  }
  return null;
};

/** A chore as read from Firestore, including the server-stamped completion time. */
export type ChoreRecord = Chore & {
  /**
   * Set with `serverTimestamp()` when a chore is completed; the rules require it
   * to equal the request time, so it cannot be backdated. Older completions only
   * have the client-written `completedAt` string.
   */
  completedAtServer?: TimestampLike | null;
};

/** When a chore was completed: the server time when present, else `completedAt`. */
export function completionInstant(chore: Pick<ChoreRecord, 'isCompleted' | 'completedAt' | 'completedAtServer'>): Date | null {
  if (!chore.isCompleted) return null;
  const server = fromTimestampLike(chore.completedAtServer);
  if (server) return server;
  if (typeof chore.completedAt !== 'string' || !chore.completedAt) return null;
  const parsed = new Date(chore.completedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Monday of the week containing `key`. */
export function weekStartKey(key: string): string {
  const date = dayFromKey(key);
  const offset = (date.getDay() + 6) % 7; // Monday = 0
  return addDaysToKey(key, -offset);
}

/** Milliseconds from `now` until the next local midnight (at least 1 s). */
export function msUntilNextMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1000, next.getTime() - now.getTime());
}
