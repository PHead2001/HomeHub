/**
 * Turns the dashboard's raw listener results into facts, keeping "still loading"
 * and "could not be read" apart from "empty". Pure (no Firebase), so the
 * readiness rules are unit tested:
 * - a section's facts exist only when every listener it needs has answered;
 * - a section whose listener failed is reported in `unavailable` and has no facts,
 *   so nothing ever shows a failed read as "nothing due", "all fed" or 0;
 * - a pet's feeding claim needs both feeding date-shape queries to have answered
 *   without error; otherwise the pet's `fed` is null ("unavailable").
 */
import { newestFirst } from '../pets/care';
import { computeChoreStats } from '../chores/stats';
import type { ChoreRecord } from '../chores/dates';
import { computeHomeHealth } from '../maintenance/health';
import type { HomeAsset, MaintenanceLog, Vehicle } from '../types';
import { localDay, safeTimeZone } from '../../../functions/src/shared/calendar';
import { dayKey } from './dates';
import { mayShowRanking, streakMembersFrom, streakTileModel } from './streaks';
import {
  computeChoreFacts,
  computeMaintenanceFacts,
  computePantryFacts,
  computePetFacts,
  computeShoppingFacts,
  recurringTemplateIdsFrom,
  type DashboardFacts,
  type DashboardSection,
  type DashboardViewer,
  type RawDoc,
} from './facts';

export type FeedingShape = 'timestamp' | 'string';

/** Raw listener results; a key stays undefined until its listener first answers. */
export type DashboardRaw = {
  rooms?: RawDoc[];
  templates?: RawDoc[];
  openChores?: RawDoc[];
  todayChores?: RawDoc[];
  /** Completed today by the legacy client `completedAt` string. */
  doneToday?: RawDoc[];
  /** Completed today by the authoritative server stamp `completedAtServer`. */
  doneTodayServer?: RawDoc[];
  lists?: RawDoc[];
  /** Items per list id; a list without an entry has not answered yet. */
  items?: Record<string, RawDoc[]>;
  pantry?: RawDoc[];
  assets?: RawDoc[];
  vehicles?: RawDoc[];
  pets?: RawDoc[];
  /** Recent feedings per pet and date shape; a missing shape has not answered yet. */
  feedings?: Record<string, Partial<Record<FeedingShape, RawDoc[]>>>;
  unread?: number;
  /** Completed chores (every retained completion), for streaks. */
  completedChores?: RawDoc[];
  /**
   * The household's "Show leaderboard" setting (`chore-settings/preferences`);
   * undefined until read. Off hides the comparative streaks tile entirely.
   */
  leaderboard?: 'on' | 'off';
  /** Household membership records, for streaks. */
  members?: RawDoc[];
  /** Maintenance logs from the last 90+ days, for the home health score. */
  logs?: RawDoc[];
};

/** Extra failure keys: these hide one tile or badge and never make a section unavailable. */
export const STREAKS_FAILURE = 'streaks';
/** The leaderboard setting could not be read: the ranking stays hidden. */
export const LEADERBOARD_FAILURE = 'leaderboard';
export const HEALTH_FAILURE = 'health';

export type DashboardAccess = Record<DashboardSection, boolean>;

/** Failure keys: section names, plus `feed:<petId>` for one pet's feeding history. */
export const feedingFailureKey = (petId: string) => `feed:${petId}`;

export function assembleDashboardFacts(
  raw: DashboardRaw,
  failed: ReadonlySet<string>,
  access: DashboardAccess,
  context: { viewer: DashboardViewer; now: Date; timeZone?: string | null; recentFeedings: number },
): { facts: DashboardFacts; loading: boolean } {
  const facts: DashboardFacts = {};
  const unavailable: DashboardSection[] = [];
  let loading = false;
  const section = (name: DashboardSection, ready: boolean, build: () => void) => {
    if (!access[name]) return;
    if (failed.has(name)) unavailable.push(name);
    else if (ready) build();
    else loading = true;
  };

  section('chores', Boolean(raw.rooms && raw.templates && raw.openChores && raw.todayChores && raw.doneToday && raw.doneTodayServer), () => {
    // Merged by document id: a chore found by more than one query counts once
    // (computeChoreFacts then reads its completion with `completionInstant`).
    const merged = new Map<string, RawDoc>();
    [...raw.openChores!, ...raw.todayChores!, ...raw.doneToday!, ...raw.doneTodayServer!].forEach((chore) => merged.set(chore.id, chore));
    facts.chores = computeChoreFacts([...merged.values()], raw.rooms!, context.viewer, context.now, recurringTemplateIdsFrom(raw.templates!, dayKey(context.now)));
  });

  const listsReady = Boolean(raw.lists && raw.lists.every((list) => raw.items?.[list.id] !== undefined));
  section('shopping', listsReady, () => {
    facts.shopping = computeShoppingFacts(raw.lists!, raw.items ?? {});
  });

  section('pantry', raw.pantry !== undefined, () => {
    facts.pantry = computePantryFacts(raw.pantry!, context.now);
  });

  section('maintenance', Boolean(raw.assets && raw.vehicles), () => {
    facts.maintenance = computeMaintenanceFacts(raw.assets!, raw.vehicles!, context.now, context.timeZone);
  });

  section('pets', raw.pets !== undefined, () => {
    const feedings = Object.fromEntries(raw.pets!.map((pet) => {
      const shapes = raw.feedings?.[pet.id];
      // Both date shapes must have answered, and neither may have failed.
      if (failed.has(feedingFailureKey(pet.id)) || !shapes?.timestamp || !shapes.string) return [pet.id, null];
      return [pet.id, newestFirst([shapes.timestamp, shapes.string] as Array<Array<RawDoc & { date: unknown }>>, context.recentFeedings)];
    }));
    facts.pets = computePetFacts(raw.pets!, feedings, context.now);
    // A feeding history still loading (not failed) keeps the brief waiting.
    if (raw.pets!.some((pet) => !failed.has(feedingFailureKey(pet.id)) && !(raw.feedings?.[pet.id]?.timestamp && raw.feedings?.[pet.id]?.string))) loading = true;
  });

  // Streaks: Chores' own stats over every retained completion and the approved members.
  // The tile compares members, so it follows the Chores leaderboard setting: shown
  // only when the setting is known to be on, never while it is loading or unreadable.
  const leaderboard = failed.has(LEADERBOARD_FAILURE) ? 'unknown' : raw.leaderboard ?? 'unknown';
  if (access.chores && (raw.leaderboard === 'off' || failed.has(LEADERBOARD_FAILURE))) facts.streaksHidden = true;
  if (access.chores && mayShowRanking(leaderboard) && !failed.has('chores') && !failed.has(STREAKS_FAILURE) && raw.completedChores && raw.members) {
    facts.streaks = streakTileModel(computeChoreStats(raw.completedChores as unknown as ChoreRecord[], streakMembersFrom(raw.members), context.now));
  }

  // Home health: Maintenance's own score, in the household's time zone.
  if (access.maintenance && !failed.has('maintenance') && !failed.has(HEALTH_FAILURE) && raw.assets && raw.vehicles && raw.logs) {
    const timeZone = safeTimeZone(context.timeZone);
    facts.health = computeHomeHealth({
      assets: raw.assets as unknown as HomeAsset[],
      vehicles: raw.vehicles as unknown as Vehicle[],
      logs: raw.logs as unknown as MaintenanceLog[],
      today: localDay(context.now, timeZone),
      timeZone,
    }).overall;
  }

  section('notifications', raw.unread !== undefined, () => {
    facts.notifications = { unread: raw.unread! };
  });

  if (unavailable.length > 0) facts.unavailable = unavailable;
  return { facts, loading };
}
