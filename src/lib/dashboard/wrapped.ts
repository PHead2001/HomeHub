/**
 * Home Wrapped (H23): a year in the household, from documents the viewer can read.
 * Pure aggregation; people appear by first name only.
 */
import { toDateValue } from './dates';
import type { RawDoc } from './facts';

export type WrappedSummary = {
  year: number;
  choresDone: number | null;
  champion: { name: string; count: number } | null;
  topItem: { name: string; count: number } | null;
  feedings: number | null;
  maintenanceSpend: number | null;
  maintenanceLogs: number | null;
};

export const firstNameOnly = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const base = trimmed.includes('@') ? trimmed.split('@')[0].split(/[._-]/)[0] : trimmed.split(/\s+/)[0];
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : null;
};

const inYear = (value: unknown, year: number) => toDateValue(value)?.getFullYear() === year;

export function summarizeChores(chores: RawDoc[], year: number): Pick<WrappedSummary, 'choresDone' | 'champion'> {
  const done = chores.filter((chore) => chore.isCompleted === true && inYear(chore.completedAt ?? chore.dueDate, year));
  const counts = new Map<string, number>();
  done.forEach((chore) => {
    const name = firstNameOnly(chore.assignedToDisplayName) ?? firstNameOnly(chore.assignedToEmail);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  });
  const champion = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return { choresDone: done.length, champion: champion ? { name: champion[0], count: champion[1] } : null };
}

export function topPurchasedItem(items: RawDoc[]): WrappedSummary['topItem'] {
  const counts = new Map<string, { name: string; count: number }>();
  items.filter((item) => item.status === 'purchased' && typeof item.name === 'string').forEach((item) => {
    const display = (item.name as string).trim();
    const key = display.toLowerCase();
    if (!key) return;
    const quantity = typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1;
    const current = counts.get(key);
    counts.set(key, { name: current?.name ?? display, count: (current?.count ?? 0) + quantity });
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0] ?? null;
}

export function maintenanceSpend(logs: RawDoc[], year: number): { spend: number; logs: number } {
  const thisYear = logs.filter((log) => inYear(log.date, year));
  const spend = thisYear.reduce((sum, log) => sum + (typeof log.cost === 'number' && Number.isFinite(log.cost) && log.cost > 0 ? log.cost : 0), 0);
  return { spend: Math.round(spend * 100) / 100, logs: thisYear.length };
}
