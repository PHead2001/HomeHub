/**
 * Exact dashboard facts, computed in the browser from the household documents the
 * viewer is allowed to read. Pure: the caller loads the documents (only for
 * sections the member can view) and passes them in. Counts mirror the server
 * overview aggregation (`src/ai/overview-facts.ts`) so the dashboard and the AI
 * Overview agree, but nothing here calls a model or uses the AI quota.
 */
import { relativeDays, toDateValue } from './dates';
import { choreDueKey, completionInstant, diffDayKeys, type ChoreRecord } from '../chores/dates';
import { collapseMissedRecurring } from '../chores/list';
import { daysUntilExpiry } from '../shopping/pantry';
import { isUsedUpPantryDoc } from '../shopping/pantry-batches';
import { feedingCountLabel, feedingHeadline, feedingPlan, feedingStatus, type FeedingEntry } from '../pets/care';
import type { PetProfile } from '../pets/types';
import type { HealthResult } from '../maintenance/health';
import type { StreakTileModel } from './streaks';
import {
  buildMaintenanceReminders,
  dateStatus,
  mileageStatus,
  type AssetInput,
  type MaintenanceReminder,
  type ReminderStatus,
  type VehicleInput,
} from '../../../functions/src/shared/maintenance-reminders';
import { reminderDueDetail, reminderStatusLabel } from '../maintenance/reminder-copy';
import { diffDays, localDay, safeTimeZone, toDay } from '../../../functions/src/shared/calendar';
import { householdDayZone, householdToday } from '../household-day';
import { normalizeRecurrence, type RecurrenceInput } from '../../../functions/src/shared/recurrence';

export type RawDoc = Record<string, unknown> & { id: string };

export type DashboardViewer = { uid: string; email: string };

export type RoomStatus = 'overdue' | 'due' | 'clear';

export type RoomState = {
  id: string;
  name: string;
  overdue: number;
  dueToday: number;
  /** Open chores due later than today. */
  upcoming: number;
  doneToday: number;
  status: RoomStatus;
  /** Up to three open chores, soonest first, for peeks and the room's label. */
  chores: Array<{ id: string; task: string; dueLabel: string; overdue: boolean }>;
};

export type ChoreFacts = {
  mineOpen: number;
  mineOverdue: number;
  mineDueToday: number;
  /** Household-wide chores scheduled for today (done or not). */
  todayTotal: number;
  todayDone: number;
  overdueTotal: number;
  rooms: RoomState[];
  nextUp: Array<{ id: string; task: string; dueLabel: string; overdue: boolean; mine: boolean }>;
};

export type ShoppingFacts = {
  activeLists: number;
  neededItems: number;
  firstItems: Array<{ id: string; name: string; listId: string; listName: string }>;
  lists: Array<{ id: string; name: string; needed: number }>;
};

export type PantryFacts = {
  total: number;
  fridgeItems: number;
  expired: number;
  expiringSoon: number;
  nearest: Array<{ name: string; days: number; label: string }>;
};

export type MaintenanceItem = {
  label: string;
  kind: 'asset' | 'vehicle';
  /** HVAC/heating/cooling assets, used by the living house's outdoor unit. */
  climate: boolean;
  /** Whole days to the due date (negative when past); null without a date. Not the trigger: see `trigger`. */
  days: number | null;
  /** The reminder's own status from `buildMaintenanceReminders`. */
  status: ReminderStatus;
  /** What set the status: the due date, or the mileage threshold (vehicle services). */
  trigger: 'date' | 'mileage';
  /** Maintenance's badge text: "Overdue", "Due today", "Expires soon"... (`reminderStatusLabel`). */
  statusLabel: string;
  /** Maintenance's "when" line: "Due Aug 1, 2026", "At 49,000 mi · 250 mi over" (`reminderDueDetail`). */
  detail: string;
  overdue: boolean;
  dueSoon: boolean;
  href: string;
};

export type MaintenanceFacts = {
  overdue: number;
  dueSoon: number;
  needsAttention: number;
  next: MaintenanceItem | null;
  items: MaintenanceItem[];
  vehicleDue: boolean;
  climateDue: boolean;
  vehicles: number;
};

export type PetState = {
  id: string;
  name: string;
  type: string;
  photoUrl?: string;
  lastFedAt: Date | null;
  lastFedBy: string | null;
  /**
   * Today's feeding target is met (Pets' `feedingStatus(...).complete`), or null
   * when the feeding history could not be read (still loading or a query failed):
   * then nothing is claimed, neither fed nor hungry.
   */
  fed: boolean | null;
  /** "1 of 2 today", "Not fed today" (Pets' `feedingCountLabel`), or the unavailable line. */
  countLabel: string;
  /** "Fed 2 h ago by Sam", "No feedings logged yet" (Pets' `feedingHeadline`), or the unavailable line. */
  headline: string;
  /** Set when the feeding history is stale (kept while reconnecting, or cached offline): "Reconnecting…", "Updated 9:41". */
  feedingHint?: string;
};

/** Pets with an unreadable feeding history (`fed === null`) count in neither number. */
export type PetFacts = { pets: PetState[]; hungry: number; unknown: number };

/** Same wording as the Pets module's `PetCareSummary` when a history cannot be read. */
export const FEEDING_UNAVAILABLE = 'Feeding status is unavailable right now.';

/** A dashboard section whose data could not be read; it is shown as unavailable, never as empty. */
export type DashboardSection = 'chores' | 'shopping' | 'pantry' | 'maintenance' | 'pets' | 'notifications';

export type DashboardFacts = {
  /** Sections whose listener failed. Their facts are absent and the UI says "unavailable". */
  unavailable?: DashboardSection[];
  chores?: ChoreFacts;
  shopping?: ShoppingFacts;
  pantry?: PantryFacts;
  maintenance?: MaintenanceFacts;
  pets?: PetFacts;
  notifications?: { unread: number };
  /**
   * Home health (H10) from Maintenance's `computeHomeHealth`; null when there is
   * nothing to score. Absent while loading or when the logs could not be read.
   */
  health?: HealthResult | null;
  /** Household streaks (H06) from Chores' `computeChoreStats`; absent while loading or unreadable. */
  streaks?: StreakTileModel;
  /**
   * True when the household turned "Show leaderboard" off (or the setting could not
   * be read): the streaks tile is not rendered at all.
   */
  streaksHidden?: boolean;
};

/** Pantry items expiring within this many days count as "expiring soon". */
const SOON_DAYS = 7;
/** Bucket for chores without a room ("Around the house"). */
export const GENERAL_ROOM_ID = 'general';
/** Bucket for chores whose room id no longer matches a room. */
export const UNKNOWN_ROOM_ID = 'unknown-room';
/** Same label the Chores page uses for a missing room. */
export const UNKNOWN_ROOM_NAME = 'Unknown Room';

const text = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, 100) : fallback;

/**
 * Template ids whose recurrence is valid, for folding missed instances the way the
 * Chores page does (`collapseMissedRecurring`).
 */
export function recurringTemplateIdsFrom(templates: RawDoc[], today: string): Set<string> {
  return new Set(templates
    .filter((template) => normalizeRecurrence(template.recurrence as RecurrenceInput | null | undefined, today) !== null)
    .map((template) => template.id));
}

/**
 * Chore facts with the Chores module's own day logic (`choreDueKey`, day keys,
 * `completionInstant`), in the household's day (`householdToday`, D-6), and its folding of missed recurring instances: an
 * older missed instance of a series that has a newer one due counts once, as on
 * the Chores page.
 */
/** How far ahead a room's "coming up" count looks. */
export const UPCOMING_DAYS = 7;

export function computeChoreFacts(
  chores: RawDoc[],
  rooms: RawDoc[],
  viewer: DashboardViewer,
  now: Date,
  recurringTemplateIds: ReadonlySet<string> = new Set(),
  timeZone?: string | null,
): ChoreFacts {
  // D-6: "today" and "completed today" are the household's day (device zone only when the
  // household has none); due dates are date-only keys and are compared as stored.
  const zone = householdDayZone(timeZone);
  const today = householdToday(zone, now);
  const records = chores as unknown as ChoreRecord[];
  // Same folding as the Chores page: only the latest instance of each recurring series counts.
  const dueByToday = records.filter((chore) => chore.isCompleted !== true && choreDueKey(chore) !== '' && choreDueKey(chore) <= today);
  const folded = new Set(collapseMissedRecurring(dueByToday, recurringTemplateIds).flatMap((entry) => entry.missed.map((missed) => missed.id)));

  const roomMap = new Map<string, RoomState>();
  const ensureRoom = (id: string, name: string) => {
    let state = roomMap.get(id);
    if (!state) {
      state = { id, name, overdue: 0, dueToday: 0, upcoming: 0, doneToday: 0, status: 'clear', chores: [] };
      roomMap.set(id, state);
    }
    return state;
  };
  [...rooms]
    .sort((a, b) => text(a.name, a.id).localeCompare(text(b.name, b.id)))
    .forEach((room) => ensureRoom(room.id, text(room.name, 'Room')));

  let mineOpen = 0;
  let mineOverdue = 0;
  let mineDueToday = 0;
  let todayTotal = 0;
  let todayDone = 0;
  let overdueTotal = 0;
  const openWithDays: Array<{ entry: ChoreFacts['nextUp'][number]; days: number }> = [];

  for (const chore of records) {
    if (folded.has(chore.id)) continue;
    const key = choreDueKey(chore);
    const days = key ? diffDayKeys(today, key) : null;
    const completed = chore.isCompleted === true;
    const finishedAt = completionInstant(chore);
    const completedToday = completed && finishedAt !== null && localDay(finishedAt, zone) === today;
    const isToday = key === today;
    const mine = chore.assignedToEmail === viewer.email;
    const listed = Array.isArray(chore.roomIds) ? chore.roomIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
    // A room that no longer exists (deleted, or not readable) keeps its chores in an
    // "Unknown Room" bucket, as the Chores page labels them, so their work is never
    // dropped from the house. Each chore counts once per bucket.
    const roomIds = listed.length > 0
      ? [...new Set(listed.map((id) => (id === GENERAL_ROOM_ID || roomMap.has(id) ? id : UNKNOWN_ROOM_ID)))]
      : [GENERAL_ROOM_ID];

    if (isToday) {
      todayTotal += 1;
      if (completed) todayDone += 1;
    } else if (completedToday) {
      // An overdue chore finished today still counts toward today's progress.
      todayTotal += 1;
      todayDone += 1;
    }

    const dueLabel = days === null ? 'no date' : `due ${relativeDays(days)}`;
    for (const roomId of roomIds) {
      const room = roomMap.get(roomId)
        ?? (roomId === GENERAL_ROOM_ID ? ensureRoom(GENERAL_ROOM_ID, 'Around the house') : ensureRoom(UNKNOWN_ROOM_ID, UNKNOWN_ROOM_NAME));
      if (completed) {
        if (completedToday) room.doneToday += 1;
        continue;
      }
      if (days !== null && days < 0) room.overdue += 1;
      else if (days === 0) room.dueToday += 1;
      // "Coming up" means the next week: the server generates 30 occurrences of each
      // repeating chore ahead of time, which are not work anyone needs to see yet.
      else if (days !== null && days <= UPCOMING_DAYS) room.upcoming += 1;
      room.chores.push({ id: chore.id, task: text(chore.task, 'Chore'), dueLabel, overdue: days !== null && days < 0 });
    }

    if (completed) continue;
    if (mine) {
      // Open for you today: overdue or due today, not future generated occurrences.
      if (days !== null && days <= 0) mineOpen += 1;
      if (days !== null && days < 0) mineOverdue += 1;
      if (days === 0) mineDueToday += 1;
    }
    if (days !== null && days < 0) overdueTotal += 1;
    openWithDays.push({
      entry: { id: chore.id, task: text(chore.task, 'Chore'), dueLabel, overdue: days !== null && days < 0, mine },
      days: days ?? Number.MAX_SAFE_INTEGER,
    });
  }

  for (const room of roomMap.values()) {
    room.status = room.overdue > 0 ? 'overdue' : room.dueToday > 0 ? 'due' : 'clear';
    room.chores.sort((a, b) => Number(b.overdue) - Number(a.overdue));
    room.chores = room.chores.slice(0, 3);
  }

  // Drop the catch-all bucket when nothing lives in it.
  const general = roomMap.get(GENERAL_ROOM_ID);
  if (general && general.overdue + general.dueToday + general.upcoming + general.doneToday === 0 && !rooms.some((r) => r.id === GENERAL_ROOM_ID)) {
    roomMap.delete(GENERAL_ROOM_ID);
  }

  return {
    mineOpen,
    mineOverdue,
    mineDueToday,
    todayTotal,
    todayDone,
    overdueTotal,
    rooms: [...roomMap.values()],
    nextUp: openWithDays
      .sort((a, b) => a.days - b.days || Number(b.entry.mine) - Number(a.entry.mine))
      .slice(0, 5)
      .map((item) => item.entry),
  };
}

export function computeShoppingFacts(lists: RawDoc[], itemsByList: Record<string, RawDoc[]>): ShoppingFacts {
  const sortedLists = [...lists].sort((a, b) => text(a.name, a.id).localeCompare(text(b.name, b.id)));
  const firstItems: ShoppingFacts['firstItems'] = [];
  let neededItems = 0;
  const summary = sortedLists.map((list) => {
    const needed = (itemsByList[list.id] ?? []).filter((item) => item.status !== 'purchased');
    neededItems += needed.length;
    const listName = text(list.name, 'Shopping list');
    [...needed]
      .sort((a, b) => (toDateValue(a.createdAt)?.getTime() ?? 0) - (toDateValue(b.createdAt)?.getTime() ?? 0))
      .forEach((item) => {
        if (firstItems.length < 3) firstItems.push({ id: item.id, name: text(item.name, 'Item'), listId: list.id, listName });
      });
    return { id: list.id, name: listName, needed: needed.length };
  });
  return { activeLists: lists.length, neededItems, firstItems, lists: summary };
}

/**
 * Pantry facts with the Shopping module's expiry day math (`daysUntilExpiry`).
 * Used-up v2 batches (`packages` 0, still stored until deleted) are not stock and
 * are left out of every count; legacy documents without `packages` still count.
 */
export function computePantryFacts(allItems: RawDoc[], now: Date): PantryFacts {
  const items = allItems.filter((item) => !isUsedUpPantryDoc(item));
  const dated = items
    .map((item) => ({ item, days: daysUntilExpiry(typeof item.expiryDate === 'string' ? item.expiryDate : null, now) }))
    .filter((entry): entry is { item: RawDoc; days: number } => entry.days !== null);
  return {
    total: items.length,
    fridgeItems: items.filter((item) => item.location === 'Fridge').length,
    expired: dated.filter((entry) => entry.days < 0).length,
    expiringSoon: dated.filter((entry) => entry.days >= 0 && entry.days <= SOON_DAYS).length,
    nearest: dated
      .filter((entry) => entry.days >= 0)
      .sort((a, b) => a.days - b.days)
      .slice(0, 3)
      .map((entry) => ({
        name: text(entry.item.name, 'Pantry item'),
        days: entry.days,
        label: entry.days === 0 ? 'expires today' : `expires ${relativeDays(entry.days)}`,
      })),
  };
}

const CLIMATE = /hvac|furnace|air ?condition|heat ?pump|boiler|a\/c|\bac\b/i;

/**
 * Which threshold set a reminder's status. A vehicle service is due by date or by
 * mileage, whichever is more urgent (`buildMaintenanceReminders`); when the mileage
 * status is the reminder's status and the date status is not, mileage is the trigger.
 */
export function reminderTrigger(
  reminder: Pick<MaintenanceReminder, 'status' | 'dueDate' | 'dueMileage' | 'currentMileage'>,
  today: string,
  timeZone: string,
): 'date' | 'mileage' {
  const byMiles = mileageStatus(reminder.dueMileage, reminder.currentMileage);
  if (byMiles !== reminder.status) return 'date';
  return dateStatus(reminder.dueDate, today, timeZone) === reminder.status ? 'date' : 'mileage';
}

/**
 * Maintenance facts from the Maintenance module's own reminder rules
 * (`buildMaintenanceReminders`, shared with the Maintenance page and the hourly
 * reminders): retired assets and retired or sold vehicles are excluded, "soon"
 * means within 14 days or 500 miles, and deep links are the module's own.
 * An expired warranty is not a task and is left out.
 */
export function computeMaintenanceFacts(assets: RawDoc[], vehicles: RawDoc[], now: Date, timeZone?: string | null): MaintenanceFacts {
  const zone = safeTimeZone(timeZone);
  const today = localDay(now, zone);
  const activeAssets = assets.filter((asset) => asset.status !== 'retired');
  const activeVehicles = vehicles.filter((vehicle) => vehicle.status !== 'retired' && vehicle.status !== 'sold');
  const assetsById = new Map(activeAssets.map((asset) => [asset.id, asset]));
  const reminders = buildMaintenanceReminders(
    activeAssets as unknown as AssetInput[],
    activeVehicles as unknown as VehicleInput[],
    today,
    zone,
  ).filter((reminder) => !(reminder.group === 'warranty' && reminder.status === 'overdue'));

  const items: MaintenanceItem[] = reminders.map((reminder) => {
    const dueDay = toDay(reminder.dueDate, zone);
    const asset = reminder.targetType === 'home_asset' ? assetsById.get(reminder.targetId) : undefined;
    const label = reminder.group === 'warranty'
      ? `${reminder.relatedName} warranty ends`
      : reminder.group === 'vehicle_document'
        ? `${reminder.relatedName} ${reminder.title.replace(/^Vehicle\s+/i, '')}`
        : reminder.title;
    return {
      label: text(label, 'Maintenance'),
      kind: reminder.targetType === 'vehicle' ? 'vehicle' : 'asset',
      climate: Boolean(asset && CLIMATE.test(`${asset.category ?? ''} ${asset.name ?? ''}`)),
      days: dueDay ? diffDays(dueDay, today) : null,
      status: reminder.status,
      trigger: reminderTrigger(reminder, today, zone),
      statusLabel: reminderStatusLabel(reminder.group, reminder.status),
      detail: reminderDueDetail(reminder, today),
      overdue: reminder.status === 'overdue',
      dueSoon: reminder.status === 'due_today' || reminder.status === 'due_soon',
      href: reminder.deepLink,
    };
  });
  const active = items.filter((item) => item.overdue || item.dueSoon);

  return {
    overdue: items.filter((item) => item.overdue).length,
    dueSoon: items.filter((item) => item.dueSoon).length,
    needsAttention: activeAssets.filter((asset) => asset.status === 'needs_attention').length
      + activeVehicles.filter((vehicle) => vehicle.status === 'needs_attention').length,
    // Reminders arrive most urgent first (overdue, today, soon, upcoming; then by date).
    next: items[0] ?? null,
    items: items.slice(0, 6),
    vehicleDue: active.some((item) => item.kind === 'vehicle')
      || activeVehicles.some((vehicle) => vehicle.status === 'needs_attention'),
    climateDue: active.some((item) => item.climate)
      || activeAssets.some((asset) => asset.status === 'needs_attention' && CLIMATE.test(`${asset.category ?? ''} ${asset.name ?? ''}`)),
    vehicles: activeVehicles.length,
  };
}

/**
 * Pet facts with the Pets module's own feeding model: `feedingPlan` (structured
 * fields, else the parsed schedule) and `feedingStatus` (today's feedings against
 * the plan). A pet counts as fed when today's target is met, as on its card.
 * `feedings` holds each pet's recent feeding entries in either date shape.
 */
export function computePetFacts(pets: RawDoc[], feedings: Record<string, FeedingEntry[] | null | undefined>, now: Date): PetFacts {
  const states = [...pets]
    .sort((a, b) => text(a.name, a.id).localeCompare(text(b.name, b.id)))
    .map<PetState>((pet) => {
      const logs = feedings[pet.id];
      // Missing or null: the history has not loaded or failed. Never read that as "not fed".
      if (!Array.isArray(logs)) {
        return {
          id: pet.id,
          name: text(pet.name, 'Pet'),
          type: text(pet.type, 'Other'),
          photoUrl: typeof pet.photoUrl === 'string' && pet.photoUrl ? pet.photoUrl : undefined,
          lastFedAt: null,
          lastFedBy: null,
          fed: null,
          countLabel: 'Unavailable',
          headline: FEEDING_UNAVAILABLE,
        };
      }
      const status = feedingStatus(logs, feedingPlan(pet as unknown as PetProfile), now);
      return {
        id: pet.id,
        name: text(pet.name, 'Pet'),
        type: text(pet.type, 'Other'),
        photoUrl: typeof pet.photoUrl === 'string' && pet.photoUrl ? pet.photoUrl : undefined,
        lastFedAt: status.last?.date ?? null,
        lastFedBy: status.last?.by ?? null,
        fed: status.complete,
        countLabel: feedingCountLabel(status),
        headline: feedingHeadline(status, now),
      };
    });
  return {
    pets: states,
    hungry: states.filter((pet) => pet.fed === false).length,
    unknown: states.filter((pet) => pet.fed === null).length,
  };
}

/** A room's text summary, used as its link name: "1 overdue, 2 due today", "All clear"... */
export function roomSummary(room: RoomState): string {
  const parts: string[] = [];
  if (room.overdue) parts.push(`${room.overdue} overdue`);
  if (room.dueToday) parts.push(`${room.dueToday} due today`);
  if (!parts.length && room.upcoming) parts.push(`${room.upcoming} coming up`);
  if (!parts.length) parts.push(room.doneToday ? 'All done today' : 'All clear');
  return parts.join(', ');
}

/** "2h ago", "35m ago", "yesterday", "3d ago". */
export function timeAgo(date: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
