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
import { isAssignedTo, resolveAssigneeUid, type AssigneePerson } from '../../../functions/src/shared/assignee';
import { daysUntilExpiry } from '../shopping/pantry';
import { feedingCountLabel, feedingHeadline, feedingPlan, feedingStatus, knownFoodType, type FeedingEntry } from '../pets/care';
import { knownFromLogs, type KnownFeedings } from '../pets/feed-decision';
import type { FoodType, PetProfile, PortionUnit } from '../pets/types';
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

/** Open chores kept per room: the most the wide layout shows inline (HP-13a). */
export const ROOM_CHORES = 5;

export type RoomStatus = 'overdue' | 'due' | 'clear';

export type RoomState = {
  id: string;
  name: string;
  /** The room's icon name (Chores' `RoomIcon`), when the room document has one. */
  icon?: string;
  overdue: number;
  dueToday: number;
  /** Open chores due later than today. */
  upcoming: number;
  doneToday: number;
  status: RoomStatus;
  /**
   * Up to five open chores (`ROOM_CHORES`) for peeks, the room's label and the inline
   * touch lines (HP-10, HP-13a): overdue first (most
   * overdue first), then today's, then the soonest within the upcoming window; undated
   * chores last; anything beyond `UPCOMING_DAYS` is left out.
   */
  chores: Array<{ id: string; task: string; dueLabel: string; overdue: boolean }>;
};

/** An open chore as the dashboard lists it (next up, today's work). */
export type ChoreEntry = {
  id: string;
  task: string;
  dueLabel: string;
  overdue: boolean;
  mine: boolean;
  /**
   * HP-32a: the assignee's name (member record, else the chore's stored display name);
   * never an email. Null when unassigned or the name is unknown.
   */
  assignee?: string | null;
  /** Who it is assigned to, for grouping: a member uid, else the lower-cased email, else '' (unassigned). Never shown. */
  assigneeKey?: string;
  /** `overdue`, `today`, `later` (within or beyond the week) or `none` (no date). */
  due?: 'overdue' | 'today' | 'later' | 'none';
  /** The first room's name ("Kitchen", "Around the house"). */
  room?: string;
  /** Older missed instances of the same series folded into this one ("+2 earlier missed"). */
  missed?: number;
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
  /** Household next-up list (everyone's open chores, soonest first, yours first on a tie). */
  nextUp: ChoreEntry[];
  /** HP-11a: the reader's own open chores (overdue, today, then within the upcoming window), soonest first. */
  mineNext: ChoreEntry[];
  /**
   * HP-32a, HP-33b: every open chore that is overdue or due today, the household's work
   * for today (most overdue first, yours first on a tie), at most `TODAY_WORK_MAX`.
   */
  todayWork?: ChoreEntry[];
  /** Open overdue or due-today chores in all (`todayWork` may be capped). */
  todayWorkTotal?: number;
  /** Older missed instances of repeating chores, folded into their latest one (never counted as done). */
  missed?: number;
};

/** The most chores `todayWork` lists (the tile shows fewer; the rest is "+N more" to /chores). */
export const TODAY_WORK_MAX = 20;

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
  /** HP-8: active HVAC/heating/cooling assets; the house draws its outdoor unit only when there is one. */
  climateAssets: number;
  overdue: number;
  dueSoon: number;
  needsAttention: number;
  next: MaintenanceItem | null;
  items: MaintenanceItem[];
  vehicleDue: boolean;
  climateDue: boolean;
  vehicles: number;
};

/** What the dashboard's one-tap Fed (HP-33a) logs: the pet's usual portion and latest food type. */
export type PetFeed = {
  amount: number;
  unit: PortionUnit;
  /** Planned feedings per day (null when unknown). */
  perDay: number | null;
  /** The latest feeding's food type (`knownFoodType`), Dry without history. */
  foodType: FoodType;
  /** Last feed and today's count from the loaded logs (the duplicate check's fallback). */
  known: KnownFeedings;
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
  /** The one-tap feeding's request; absent when the feeding history could not be read. */
  feed?: PetFeed;
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
  /**
   * HP-11b: completed chores in the household, counted from the running completions
   * listener (the golden roof). Absent while loading or unreadable, never 0 for unknown.
   */
  completedChores?: number;
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

/**
 * A member's name for the dashboard (HP-32a): the display name, never an email. A
 * display name that is itself an email is not used.
 */
export function memberName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.includes('@')) return null;
  return name.slice(0, 60);
}

/** Approved members as the assignee helpers want them, with their names. */
function peopleFrom(members: readonly RawDoc[]): Array<AssigneePerson & { name: string | null }> {
  return members.flatMap((member) => {
    const status = typeof member.status === 'string' ? member.status : 'active';
    if (member.role === 'newuser' || status !== 'active') return [];
    const uid = typeof member.uid === 'string' && member.uid ? member.uid : member.id;
    const email = typeof member.email === 'string' ? member.email : null;
    return [{ uid, email, name: memberName(member.displayName) }];
  });
}

export function computeChoreFacts(
  chores: RawDoc[],
  rooms: RawDoc[],
  viewer: DashboardViewer,
  now: Date,
  recurringTemplateIds: ReadonlySet<string> = new Set(),
  timeZone?: string | null,
  /** Household membership records (names for HP-32a); without them the chore's stored name is used. */
  members: readonly RawDoc[] = [],
): ChoreFacts {
  // D-6: "today" and "completed today" are the household's day (device zone only when the
  // household has none); due dates are date-only keys and are compared as stored.
  const zone = householdDayZone(timeZone);
  const today = householdToday(zone, now);
  const records = chores as unknown as ChoreRecord[];
  // Same folding as the Chores page: only the latest instance of each recurring series counts.
  const dueByToday = records.filter((chore) => chore.isCompleted !== true && choreDueKey(chore) !== '' && choreDueKey(chore) <= today);
  const collapsed = collapseMissedRecurring(dueByToday, recurringTemplateIds);
  const folded = new Set(collapsed.flatMap((entry) => entry.missed.map((missed) => missed.id)));
  const missedBy = new Map(collapsed.filter((entry) => entry.missed.length > 0).map((entry) => [entry.chore.id, entry.missed.length]));
  const people = peopleFrom(members);
  const assigneeOf = (chore: ChoreRecord): { key: string; name: string | null } => {
    const record = chore as unknown as Record<string, unknown>;
    const uid = resolveAssigneeUid(record, people);
    const person = uid ? people.find((entry) => entry.uid === uid) : undefined;
    const email = typeof record.assignedToEmail === 'string' ? record.assignedToEmail.trim().toLowerCase() : '';
    const storedUid = typeof record.assignedToUid === 'string' ? record.assignedToUid.trim() : '';
    const key = person?.uid ?? (email || storedUid);
    if (!key) return { key: '', name: null };
    return { key, name: person?.name ?? memberName(record.assignedToDisplayName) };
  };

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
    .forEach((room) => {
      const state = ensureRoom(room.id, text(room.name, 'Room'));
      if (typeof room.icon === 'string' && room.icon) state.icon = room.icon;
    });

  let mineOpen = 0;
  let mineOverdue = 0;
  let mineDueToday = 0;
  let todayTotal = 0;
  let todayDone = 0;
  let overdueTotal = 0;
  const openWithDays: Array<{ entry: ChoreEntry; days: number }> = [];
  const roomOrder = new Map<string, Array<{ chore: RoomState['chores'][number]; days: number }>>();

  for (const chore of records) {
    if (folded.has(chore.id)) continue;
    const key = choreDueKey(chore);
    const days = key ? diffDayKeys(today, key) : null;
    const completed = chore.isCompleted === true;
    const finishedAt = completionInstant(chore);
    const completedToday = completed && finishedAt !== null && localDay(finishedAt, zone) === today;
    const isToday = key === today;
    const mine = isAssignedTo(chore, viewer);
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
      // HP-10b: generated occurrences beyond the upcoming window are not listed.
      if (days !== null && days > UPCOMING_DAYS) continue;
      const entries = roomOrder.get(room.id) ?? [];
      entries.push({ chore: { id: chore.id, task: text(chore.task, 'Chore'), dueLabel, overdue: days !== null && days < 0 }, days: days ?? Number.MAX_SAFE_INTEGER });
      roomOrder.set(room.id, entries);
    }

    if (completed) continue;
    if (mine) {
      // Open for you today: overdue or due today, not future generated occurrences.
      if (days !== null && days <= 0) mineOpen += 1;
      if (days !== null && days < 0) mineOverdue += 1;
      if (days === 0) mineDueToday += 1;
    }
    if (days !== null && days < 0) overdueTotal += 1;
    const assignee = assigneeOf(chore);
    const firstRoom = roomMap.get(roomIds[0]);
    openWithDays.push({
      entry: {
        id: chore.id,
        task: text(chore.task, 'Chore'),
        dueLabel,
        overdue: days !== null && days < 0,
        mine,
        assignee: assignee.name,
        assigneeKey: assignee.key,
        due: days === null ? 'none' : days < 0 ? 'overdue' : days === 0 ? 'today' : 'later',
        room: firstRoom?.name,
        missed: missedBy.get(chore.id) ?? 0,
      },
      days: days ?? Number.MAX_SAFE_INTEGER,
    });
  }

  for (const room of roomMap.values()) {
    room.status = room.overdue > 0 ? 'overdue' : room.dueToday > 0 ? 'due' : 'clear';
    // HP-10a: overdue (most overdue first), then today, then soonest; undated last. Stable
    // on ties, so chores keep their document order.
    room.chores = (roomOrder.get(room.id) ?? [])
      .sort((a, b) => a.days - b.days)
      .slice(0, ROOM_CHORES)
      .map((entry) => entry.chore);
  }

  // Drop the catch-all bucket when nothing lives in it.
  const general = roomMap.get(GENERAL_ROOM_ID);
  if (general && general.overdue + general.dueToday + general.upcoming + general.doneToday === 0 && !rooms.some((r) => r.id === GENERAL_ROOM_ID)) {
    roomMap.delete(GENERAL_ROOM_ID);
  }

  const sorted = openWithDays.sort((a, b) => a.days - b.days || Number(b.entry.mine) - Number(a.entry.mine));
  const todayWork = sorted.filter((item) => item.days <= 0);
  return {
    mineOpen,
    mineOverdue,
    mineDueToday,
    todayTotal,
    todayDone,
    overdueTotal,
    rooms: [...roomMap.values()],
    nextUp: sorted.slice(0, 5).map((item) => item.entry),
    mineNext: sorted
      .filter((item) => item.entry.mine && item.days <= UPCOMING_DAYS)
      .slice(0, 5)
      .map((item) => item.entry),
    todayWork: todayWork.slice(0, TODAY_WORK_MAX).map((item) => item.entry),
    todayWorkTotal: todayWork.length,
    missed: folded.size,
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

/** Pantry facts with the Shopping module's expiry day math (`daysUntilExpiry`). */
export function computePantryFacts(items: RawDoc[], now: Date): PantryFacts {
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
        // HP-22a: "expiring tomorrow" reads right after any item name ("eggs", "milk").
        label: `expiring ${relativeDays(entry.days)}`,
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
    climateAssets: activeAssets.filter((asset) => CLIMATE.test(`${asset.category ?? ''} ${asset.name ?? ''}`)).length,
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
export function computePetFacts(pets: RawDoc[], feedings: Record<string, FeedingEntry[] | null | undefined>, now: Date, timeZone?: string | null): PetFacts {
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
      const plan = feedingPlan(pet as unknown as PetProfile);
      const status = feedingStatus(logs, plan, now);
      // HP-33a: the same request as the Pets one-tap feed (usual portion, latest food type).
      const latest = [...logs].sort((a, b) => (toDateValue(b.date)?.getTime() ?? 0) - (toDateValue(a.date)?.getTime() ?? 0))[0] as (FeedingEntry & { foodType?: unknown }) | undefined;
      const feed: PetFeed = {
        amount: plan.amount,
        unit: plan.unit,
        perDay: plan.perDay,
        foodType: knownFoodType(latest?.foodType) ?? 'Dry',
        known: knownFromLogs(logs, now, timeZone),
      };
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
        feed,
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
