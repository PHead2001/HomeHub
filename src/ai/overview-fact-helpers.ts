/**
 * Pure pieces of the AI home overview aggregation (`./overview-facts`, which is
 * server-only). Kept here so they are unit tested (tests/unit/overview-facts.test.ts).
 */
import type { HomeOverviewFacts } from '@/ai/overview-types';
import { redactEmails } from '@/ai/redact';
import { householdToday, isUsedUpPantryDoc } from '@/lib/shopping/pantry-batches';
import { diffDays, localDay, safeTimeZone, toDay } from '@functions/shared/calendar';

export const DAY_MS = 86_400_000;

// Free-text labels (notification titles, item names) can contain an email
// address; it is replaced before the facts go to the model.
export const label = (value: unknown, fallback: string) => typeof value === 'string'
  ? redactEmails(value.trim()).replace(/\s+/g, ' ').slice(0, 100) || fallback
  : fallback;

export const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate();
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const startOfUtcDay = (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
export const dayDistance = (date: Date, now: Date) => Math.round((startOfUtcDay(date).getTime() - startOfUtcDay(now).getTime()) / DAY_MS);

/**
 * A pantry expiry as a household calendar day: a v2 date-only `yyyy-MM-dd` is
 * that day as stored; a legacy ISO timestamp (or Firestore Timestamp) is its day
 * in the household zone. Null when there is no readable expiry.
 */
const pantryExpiryDay = (value: unknown, timeZone: string): string | null => {
  if (typeof value === 'string') return toDay(value, timeZone);
  const date = toDate(value);
  return date ? localDay(date, timeZone) : null;
};

/**
 * The overview's pantry facts. Used-up v2 batches (`packages` 0, kept stored
 * until an idle-delete removes them) are not stock, so they are left out of the
 * total and every expiry count; legacy documents without `packages` still count.
 * Expiry is compared as household calendar days (`timeZone`, the household's
 * zone; the app default when unset or invalid), so a batch that expired
 * yesterday in Tokyo counts as expired even while it is still that day in UTC.
 */
export function summarizeOverviewPantry(
  docs: ReadonlyArray<Record<string, unknown>>,
  now: Date,
  timeZone?: string | null,
): NonNullable<HomeOverviewFacts['pantry']> {
  const zone = safeTimeZone(timeZone);
  const today = householdToday(now, zone);
  const pantry = docs.filter(item => !isUsedUpPantryDoc(item));
  const expirations = pantry
    .map(item => {
      const day = pantryExpiryDay(item.expiryDate, zone);
      return day ? { item, day, distance: diffDays(day, today) } : null;
    })
    .filter((entry): entry is { item: Record<string, unknown>; day: string; distance: number } => entry !== null);
  return {
    totalItems: pantry.length,
    expired: expirations.filter(entry => entry.distance < 0).length,
    expiringWithinSevenDays: expirations.filter(entry => entry.distance >= 0 && entry.distance <= 7).length,
    expiringWithinThirtyDays: expirations.filter(entry => entry.distance >= 0 && entry.distance <= 30).length,
    nearestExpirations: expirations
      .sort((left, right) => left.day.localeCompare(right.day))
      .slice(0, 5)
      .map(entry => ({ label: label(entry.item.name, 'Pantry item'), due: entry.day })),
  };
}
