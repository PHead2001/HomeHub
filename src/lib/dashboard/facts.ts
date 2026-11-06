/**
 * Exact dashboard facts, computed in the browser from the household documents the
 * viewer is allowed to read. Pure: the caller loads the documents (only for
 * sections the member can view) and passes them in. Counts mirror the server
 * overview aggregation (`src/ai/overview-facts.ts`) so the dashboard and the AI
 * Overview agree, but nothing here calls a model or uses the AI quota.
 */
import { daysBetween, dayKey, relativeDays, toDateValue } from './dates';

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
  days: number | null;
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
  /** Fed within the last `FED_WINDOW_HOURS`. */
  fed: boolean;
};

export type PetFacts = { pets: PetState[]; hungry: number };

export type DashboardFacts = {
  chores?: ChoreFacts;
  shopping?: ShoppingFacts;
  pantry?: PantryFacts;
  maintenance?: MaintenanceFacts;
  pets?: PetFacts;
  notifications?: { unread: number };
};

export const FED_WINDOW_HOURS = 12;
const SOON_DAYS = 7;
const GENERAL_ROOM_ID = 'general';

const text = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, 100) : fallback;

const choreDue = (chore: RawDoc): Date | null => toDateValue(chore.dueDate) ?? toDateValue(chore.originalDueDate);

export function computeChoreFacts(chores: RawDoc[], rooms: RawDoc[], viewer: DashboardViewer, now: Date): ChoreFacts {
  const today = dayKey(now);
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

  for (const chore of chores) {
    const due = choreDue(chore);
    const days = due ? daysBetween(due, now) : null;
    const completed = chore.isCompleted === true;
    const completedToday = completed && (() => {
      const at = toDateValue(chore.completedAt);
      return at ? dayKey(at) === today : false;
    })();
    const isToday = due ? dayKey(due) === today : false;
    const mine = chore.assignedToEmail === viewer.email;
    const roomIds = Array.isArray(chore.roomIds) && chore.roomIds.length > 0
      ? chore.roomIds.filter((id): id is string => typeof id === 'string')
      : [GENERAL_ROOM_ID];

    if (isToday) {
      todayTotal += 1;
      if (completed) todayDone += 1;
    } else if (completedToday) {
      // An overdue chore finished today still counts toward today's progress.
      todayTotal += 1;
      todayDone += 1;
    }

    for (const roomId of roomIds) {
      const room = roomMap.get(roomId) ?? (roomId === GENERAL_ROOM_ID ? ensureRoom(GENERAL_ROOM_ID, 'Around the house') : null);
      if (!room) continue;
      if (completed) {
        if (completedToday) room.doneToday += 1;
        continue;
      }
      if (days !== null && days < 0) room.overdue += 1;
      else if (days === 0) room.dueToday += 1;
      else room.upcoming += 1;
      room.chores.push({
        id: chore.id,
        task: text(chore.task, 'Chore'),
        dueLabel: days === null ? 'no date' : `due ${relativeDays(days)}`,
        overdue: days !== null && days < 0,
      });
    }

    if (completed) continue;
    if (mine) {
      mineOpen += 1;
      if (days !== null && days < 0) mineOverdue += 1;
      if (days === 0) mineDueToday += 1;
    }
    if (days !== null && days < 0) overdueTotal += 1;
    const entry = {
      id: chore.id,
      task: text(chore.task, 'Chore'),
      dueLabel: days === null ? 'no date' : `due ${relativeDays(days)}`,
      overdue: days !== null && days < 0,
      mine,
    };
    openWithDays.push({ entry, days: days ?? Number.MAX_SAFE_INTEGER });
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

export function computePantryFacts(items: RawDoc[], now: Date): PantryFacts {
  const dated = items
    .map((item) => ({ item, date: toDateValue(item.expiryDate) }))
    .filter((entry): entry is { item: RawDoc; date: Date } => entry.date !== null)
    .map((entry) => ({ ...entry, days: daysBetween(entry.date, now) }));
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

export function computeMaintenanceFacts(assets: RawDoc[], vehicles: RawDoc[], now: Date): MaintenanceFacts {
  const items: MaintenanceItem[] = [];
  const push = (item: Omit<MaintenanceItem, 'overdue' | 'dueSoon'> & { overdue?: boolean; dueSoon?: boolean }) => {
    const overdue = item.overdue ?? (item.days !== null && item.days < 0);
    const dueSoon = item.dueSoon ?? (item.days !== null && item.days >= 0 && item.days <= SOON_DAYS);
    items.push({ ...item, overdue, dueSoon: !overdue && dueSoon });
  };

  for (const asset of assets) {
    const name = text(asset.name, 'Home asset');
    const climate = CLIMATE.test(`${asset.category ?? ''} ${name}`);
    const href = `/maintenance?asset=${encodeURIComponent(asset.id)}`;
    for (const schedule of Array.isArray(asset.schedules) ? asset.schedules as Array<Record<string, unknown>> : []) {
      if (schedule?.mode === 'checklist') continue;
      const due = toDateValue(schedule?.nextDueDate);
      if (!due) continue;
      push({ label: text(schedule.scheduleName, name), kind: 'asset', climate, days: daysBetween(due, now), href });
    }
    const warranty = toDateValue(asset.warrantyExpiration);
    if (warranty) {
      const days = daysBetween(warranty, now);
      // A warranty expires; it is never "overdue". Only upcoming expirations are surfaced.
      if (days >= 0 && days <= 30) push({ label: `${name} warranty ends`, kind: 'asset', climate: false, days, href, overdue: false, dueSoon: true });
    }
  }

  for (const vehicle of vehicles) {
    const nickname = text(vehicle.nickname, 'Vehicle');
    const href = `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}`;
    const mileage = typeof vehicle.currentMileage === 'number' ? vehicle.currentMileage : null;
    for (const schedule of Array.isArray(vehicle.serviceSchedules) ? vehicle.serviceSchedules as Array<Record<string, unknown>> : []) {
      if (schedule?.mode === 'checklist') continue;
      const due = toDateValue(schedule?.nextDueDate);
      const days = due ? daysBetween(due, now) : null;
      const nextMileage = typeof schedule?.nextDueMileage === 'number' ? schedule.nextDueMileage : null;
      const remaining = mileage !== null && nextMileage !== null ? nextMileage - mileage : null;
      const overdue = (days !== null && days < 0) || (remaining !== null && remaining <= 0);
      const dueSoon = (days !== null && days >= 0 && days <= SOON_DAYS) || (remaining !== null && remaining > 0 && remaining <= 500);
      if (!overdue && !dueSoon && days === null) continue;
      push({ label: text(schedule.serviceName, `${nickname} service`), kind: 'vehicle', climate: false, days, href, overdue, dueSoon });
    }
    for (const [value, suffix] of [[vehicle.registrationExpiration, 'registration'], [vehicle.inspectionExpiration, 'inspection']] as const) {
      const due = toDateValue(value);
      if (!due) continue;
      const days = daysBetween(due, now);
      if (days <= 30) push({ label: `${nickname} ${suffix}`, kind: 'vehicle', climate: false, days, href, dueSoon: days >= 0 && days <= 30 });
    }
  }

  const active = items.filter((item) => item.overdue || item.dueSoon);
  const upcoming = [...items].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return (a.days ?? Number.MAX_SAFE_INTEGER) - (b.days ?? Number.MAX_SAFE_INTEGER);
  });

  return {
    overdue: items.filter((item) => item.overdue).length,
    dueSoon: items.filter((item) => item.dueSoon).length,
    needsAttention: assets.filter((asset) => asset.status === 'needs_attention').length
      + vehicles.filter((vehicle) => vehicle.status === 'needs_attention').length,
    next: upcoming[0] ?? null,
    items: upcoming.slice(0, 6),
    vehicleDue: active.some((item) => item.kind === 'vehicle')
      || vehicles.some((vehicle) => vehicle.status === 'needs_attention'),
    climateDue: active.some((item) => item.climate)
      || assets.some((asset) => asset.status === 'needs_attention' && CLIMATE.test(`${asset.category ?? ''} ${asset.name ?? ''}`)),
    vehicles: vehicles.filter((vehicle) => vehicle.status !== 'sold' && vehicle.status !== 'retired').length,
  };
}

export function computePetFacts(pets: RawDoc[], lastFeeding: Record<string, unknown>, now: Date): PetFacts {
  const states = [...pets]
    .sort((a, b) => text(a.name, a.id).localeCompare(text(b.name, b.id)))
    .map<PetState>((pet) => {
      const lastFedAt = toDateValue(lastFeeding[pet.id]);
      const fed = lastFedAt !== null && now.getTime() - lastFedAt.getTime() <= FED_WINDOW_HOURS * 3_600_000 && lastFedAt.getTime() <= now.getTime() + 60_000;
      return {
        id: pet.id,
        name: text(pet.name, 'Pet'),
        type: text(pet.type, 'Other'),
        photoUrl: typeof pet.photoUrl === 'string' && pet.photoUrl ? pet.photoUrl : undefined,
        lastFedAt,
        fed,
      };
    });
  return { pets: states, hungry: states.filter((pet) => !pet.fed).length };
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
