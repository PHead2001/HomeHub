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
import { householdDayZone, householdToday } from '../household-day';
import type { Notification } from '../types';
import type { ViewPermission } from '@functions/shared/push-audience';
import { unreadBellCount } from './notification-display';
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
  /** The notification window's documents, merged with `deduplicateNotifications` (counted at `now`). */
  notifications?: Notification[];
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
  context: {
    viewer: DashboardViewer;
    now: Date;
    timeZone?: string | null;
    recentFeedings: number;
    /** The member's view permissions, for the bell's category check (none: every category). */
    canView?: (permission: ViewPermission) => boolean;
  },
): { facts: DashboardFacts; loading: boolean } {
  const facts: DashboardFacts = {};
  // D-6: one household day for chores, maintenance and home health (device zone only
  // when the household has none).
  const zone = householdDayZone(context.timeZone);
  const today = householdToday(zone, context.now);
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
    facts.chores = computeChoreFacts([...merged.values()], raw.rooms!, context.viewer, context.now, recurringTemplateIdsFrom(raw.templates!, today), zone, raw.members);
  });

  const listsReady = Boolean(raw.lists && raw.lists.every((list) => raw.items?.[list.id] !== undefined));
  section('shopping', listsReady, () => {
    facts.shopping = computeShoppingFacts(raw.lists!, raw.items ?? {});
  });

  section('pantry', raw.pantry !== undefined, () => {
    facts.pantry = computePantryFacts(raw.pantry!, context.now);
  });

  section('maintenance', Boolean(raw.assets && raw.vehicles), () => {
    facts.maintenance = computeMaintenanceFacts(raw.assets!, raw.vehicles!, context.now, zone);
  });

  section('pets', raw.pets !== undefined, () => {
    const feedings = Object.fromEntries(raw.pets!.map((pet) => {
      const shapes = raw.feedings?.[pet.id];
      // Both date shapes must have answered, and neither may have failed.
      if (failed.has(feedingFailureKey(pet.id)) || !shapes?.timestamp || !shapes.string) return [pet.id, null];
      return [pet.id, newestFirst([shapes.timestamp, shapes.string] as Array<Array<RawDoc & { date: unknown }>>, context.recentFeedings)];
    }));
    facts.pets = computePetFacts(raw.pets!, feedings, context.now, zone);
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

  // HP-11b: the golden roof counts the same completions listener, so it turns gold live.
  if (access.chores && !failed.has(STREAKS_FAILURE) && raw.completedChores) facts.completedChores = raw.completedChores.length;

  // Home health: Maintenance's own score, in the household's time zone.
  if (access.maintenance && !failed.has('maintenance') && !failed.has(HEALTH_FAILURE) && raw.assets && raw.vehicles && raw.logs) {
    facts.health = computeHomeHealth({
      assets: raw.assets as unknown as HomeAsset[],
      vehicles: raw.vehicles as unknown as Vehicle[],
      logs: raw.logs as unknown as MaintenanceLog[],
      today,
      timeZone: zone,
    }).overall;
  }

  // Counted here from the documents at `now` (expiry and the 7-day window move with time),
  // exactly as the bell counts them, never a number frozen at the last snapshot.
  section('notifications', raw.notifications !== undefined, () => {
    facts.notifications = { unread: unreadBellCount(raw.notifications!, { ...context.viewer, canView: context.canView }, context.now) };
  });

  if (unavailable.length > 0) facts.unavailable = unavailable;
  return { facts, loading };
}
