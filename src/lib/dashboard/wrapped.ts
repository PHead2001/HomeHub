/**
 * Home Wrapped (H23): a year in the household, from documents the viewer can read.
 * Pure aggregation; people appear by first name only.
 */
import { toDateValue } from './dates';
import { completionInstant, type ChoreRecord } from '../chores/dates';
import type { RawDoc } from './facts';
import { localDay, safeTimeZone, zonedMidnightIso } from '../../../functions/src/shared/calendar';
import { choreStatsAssigneeKey } from '../../../functions/src/shared/ids';
import { readChoreStats } from '../../../functions/src/shared/chore-stats';

export type WrappedSummary = {
  year: number;
  choresDone: number | null;
  /** `'year'` when removed chores were included (stats document found), else only the last 90 days. */
  choresWindow?: 'year' | 'last90days';
  champion: { name: string; count: number } | null;
  /**
   * Most-bought item among purchased items still on the lists. Shopping keeps no
   * dated purchase history, so this is not limited to `year`; the card says so.
   */
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

/**
 * Calendar year of a stored date in the household's timezone. Date-only strings
 * ("2026-03-01", as maintenance logs store them) are that calendar day; Timestamps,
 * Dates and ISO instants are read in the zone, like the chore stats.
 */
export function yearIn(value: unknown, timeZone?: string | null): number | null {
  const zone = safeTimeZone(timeZone);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return Number(value.slice(0, 4));
  const date = toDateValue(value);
  return date ? Number(localDay(date, zone).slice(0, 4)) : null;
}

/** The instants that start and end `year` in the household's timezone: [start, end). */
export function yearBounds(year: number, timeZone?: string | null): { start: Date; end: Date } {
  const zone = safeTimeZone(timeZone);
  return { start: new Date(zonedMidnightIso(`${year}-01-01`, zone)), end: new Date(zonedMidnightIso(`${year + 1}-01-01`, zone)) };
}

/** How many of `dates` (any shape: Timestamp, Date, ISO or date-only string) fall in `year` in the zone. */
export function countInYear(dates: readonly unknown[], year: number, timeZone?: string | null): number {
  return dates.filter((value) => yearIn(value, timeZone) === year).length;
}

/**
 * Chores completed in `year`, including the ones server upkeep has already
 * removed (completed chores are kept 90 days). Removed completions live in
 * `households/{id}/stats/chores-{year}` (`stats`), which upkeep fills in the same
 * transaction that deletes each chore, so a chore is counted either there or in
 * `chores` (still stored), never both. Retained completions use the Chores
 * module's `completionInstant`, read in the household's timezone, like the stats.
 *
 * Scores are grouped by the stable assignee key (`choreStatsAssigneeKey` of the
 * email), so two members who share a first name never pool their chores and a
 * renamed member keeps one score; only the winner's label is shortened to a first
 * name (member record, then the chore's display name, then the stats' name).
 *
 * Without a stats document (older households, or a failed read) only retained
 * chores can be counted: `choresWindow` is then `'last90days'` and the card says so.
 */
export function summarizeChores(
  chores: RawDoc[],
  year: number,
  options: { names?: ReadonlyMap<string, string>; stats?: unknown; timeZone?: string | null } = {},
): Pick<WrappedSummary, 'choresDone' | 'champion' | 'choresWindow'> {
  const zone = safeTimeZone(options.timeZone);
  const yearOf = (date: Date | null) => (date ? Number(localDay(date, zone).slice(0, 4)) : null);
  const stats = options.stats ? readChoreStats(options.stats, year) : null;
  const names = new Map<string, string>();
  options.names?.forEach((name, email) => names.set(choreStatsAssigneeKey(email), name));

  const counts = new Map<string, number>(Object.entries(stats?.byAssignee ?? {}));
  const labels = new Map<string, unknown>(Object.entries(stats?.names ?? {}));
  const emails = new Map<string, string>();
  let retained = 0;
  for (const chore of chores) {
    if (yearOf(completionInstant(chore as unknown as ChoreRecord)) !== year) continue;
    retained += 1;
    if (typeof chore.assignedToEmail !== 'string' || !chore.assignedToEmail.trim()) continue;
    const key = choreStatsAssigneeKey(chore.assignedToEmail);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!labels.has(key) && typeof chore.assignedToDisplayName === 'string' && chore.assignedToDisplayName.trim()) labels.set(key, chore.assignedToDisplayName);
    if (!emails.has(key)) emails.set(key, chore.assignedToEmail);
  }
  const winner = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const label = winner
    ? (firstNameOnly(names.get(winner[0])) ?? firstNameOnly(labels.get(winner[0])) ?? firstNameOnly(emails.get(winner[0])))
    : null;
  return {
    choresDone: (stats?.completed ?? 0) + retained,
    champion: winner && label ? { name: label, count: winner[1] } : null,
    choresWindow: stats ? 'year' : 'last90days',
  };
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

/** Upkeep spend for `year`, bucketed by each log's own `date` (the Maintenance log date) in the household's zone. */
export function maintenanceSpend(logs: RawDoc[], year: number, timeZone?: string | null): { spend: number; logs: number } {
  const thisYear = logs.filter((log) => yearIn(log.date, timeZone) === year);
  const spend = thisYear.reduce((sum, log) => sum + (typeof log.cost === 'number' && Number.isFinite(log.cost) && log.cost > 0 ? log.cost : 0), 0);
  return { spend: Math.round(spend * 100) / 100, logs: thisYear.length };
}
