/**
 * Pure pieces of the AI home overview aggregation (`./overview-facts`, which is
 * server-only). Kept here so they are unit tested (tests/unit/overview-facts.test.ts).
 */
import type { HomeOverviewFacts } from '@/ai/overview-types';
import { redactEmails } from '@/ai/redact';
import { isUsedUpPantryDoc } from '@/lib/shopping/pantry-batches';

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
 * The overview's pantry facts. Used-up v2 batches (`packages` 0, kept stored
 * until an idle-delete removes them) are not stock, so they are left out of the
 * total and every expiry count; legacy documents without `packages` still count.
 */
export function summarizeOverviewPantry(docs: ReadonlyArray<Record<string, unknown>>, now: Date): NonNullable<HomeOverviewFacts['pantry']> {
  const pantry = docs.filter(item => !isUsedUpPantryDoc(item));
  const expirations = pantry.map(item => ({ item, date: toDate(item.expiryDate) })).filter(item => item.date);
  return {
    totalItems: pantry.length,
    expired: expirations.filter(item => dayDistance(item.date!, now) < 0).length,
    expiringWithinSevenDays: expirations.filter(item => {
      const distance = dayDistance(item.date!, now);
      return distance >= 0 && distance <= 7;
    }).length,
    expiringWithinThirtyDays: expirations.filter(item => {
      const distance = dayDistance(item.date!, now);
      return distance >= 0 && distance <= 30;
    }).length,
    nearestExpirations: expirations
      .sort((left, right) => left.date!.getTime() - right.date!.getTime())
      .slice(0, 5)
      .map(item => ({ label: label(item.item.name, 'Pantry item'), due: item.date!.toISOString().slice(0, 10) })),
  };
}
