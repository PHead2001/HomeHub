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
import { dayKey } from './dates';
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
};

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

  section('notifications', raw.unread !== undefined, () => {
    facts.notifications = { unread: raw.unread! };
  });

  if (unavailable.length > 0) facts.unavailable = unavailable;
  return { facts, loading };
}
