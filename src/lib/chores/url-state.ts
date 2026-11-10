/**
 * The Chores page's URL state: `?room=<roomId>` opens the page filtered to that
 * room (`?room=general` for chores without a room); `?due=overdue` shows only
 * overdue work in To Do and `?who=me` only the reader's chores (GOAL-filters, HP-25:
 * the dashboard brief's overdue links). Filters are always derived from the current
 * search params (`useSearchParams`), so links from the dashboard, browser
 * Back/Forward, reload and client navigation all keep the filters and the address
 * bar in step. "All Rooms", every due date and everyone are the absence of the param.
 */

export const ALL_ROOMS = 'all';
export const GENERAL_ROOM = 'general';

type ParamsLike = Pick<URLSearchParams, 'get' | 'toString'>;

/** The room filter requested by the URL: a room id, `general`, or `all`. */
export function parseChoresRoom(params: ParamsLike | null | undefined): string {
  const room = params?.get('room')?.trim();
  if (!room || room === ALL_ROOMS) return ALL_ROOMS;
  return room;
}

/**
 * The filter actually applied once rooms are known: an unknown room id (a deleted
 * room, a stale link) falls back to All Rooms instead of showing an empty page.
 * While rooms are still loading (`knownRoomIds` null) the request is kept.
 */
export function effectiveChoresRoom(requested: string, knownRoomIds: ReadonlySet<string> | null): string {
  if (requested === ALL_ROOMS || requested === GENERAL_ROOM) return requested;
  if (!knownRoomIds) return requested;
  return knownRoomIds.has(requested) ? requested : ALL_ROOMS;
}

/** The href for a room filter on `pathname`, keeping unrelated params. */
export function choresRoomHref(pathname: string, current: ParamsLike | null | undefined, roomId: string): string {
  const params = new URLSearchParams(current?.toString() ?? '');
  if (!roomId || roomId === ALL_ROOMS) params.delete('room');
  else params.set('room', roomId);
  const search = params.toString();
  return `${pathname}${search ? `?${search}` : ''}`;
}

/**
 * Shared-element name for a room (H01 → Chores morph): `room-<roomId>`, sanitized
 * like `sharedId()` so it is a valid `view-transition-name`. The dashboard's room
 * and the filtered Chores page use the same name, so the View Transition morphs
 * the room into the page.
 */
export function roomSharedId(roomId: string): string {
  return `room-${roomId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** `?due=overdue`: To Do lists only overdue chores. */
export type ChoresDueFilter = 'all' | 'overdue';
/** `?who=me`: only the reader's chores. */
export type ChoresWhoFilter = 'all' | 'me';

export type ChoresFilters = { room: string; due: ChoresDueFilter; who: ChoresWhoFilter };

/** Every filter the URL asks for; unknown values mean "no filter". */
export function parseChoresFilters(params: ParamsLike | null | undefined): ChoresFilters {
  return {
    room: parseChoresRoom(params),
    due: params?.get('due')?.trim() === 'overdue' ? 'overdue' : 'all',
    who: params?.get('who')?.trim() === 'me' ? 'me' : 'all',
  };
}

/**
 * A key that changes whenever any filter changes. The To Do room groups open by default
 * only when they mount, so the page remounts them on this key: a group that a filter
 * change brings in (Mine off shows a housemate's room) opens like the others.
 */
export function choresFiltersKey(filters: ChoresFilters): string {
  return `${filters.room}|${filters.due}|${filters.who}`;
}

/**
 * The href with some filters changed, keeping the others and unrelated params, in a
 * stable order (room, due, who) so a link and the page's own write produce the same URL.
 */
export function choresFiltersHref(pathname: string, current: ParamsLike | null | undefined, change: Partial<ChoresFilters>): string {
  const params = new URLSearchParams(current?.toString() ?? '');
  const next = { ...parseChoresFilters(params), ...change };
  ['room', 'due', 'who'].forEach((key) => params.delete(key));
  if (next.room && next.room !== ALL_ROOMS) params.set('room', next.room);
  if (next.due === 'overdue') params.set('due', 'overdue');
  if (next.who === 'me') params.set('who', 'me');
  // Filters first, in their fixed order, then anything else the URL carried.
  const ordered = new URLSearchParams();
  ['room', 'due', 'who'].forEach((key) => { const value = params.get(key); if (value) ordered.set(key, value); });
  params.forEach((value, key) => { if (!['room', 'due', 'who'].includes(key)) ordered.append(key, value); });
  const search = ordered.toString();
  return `${pathname}${search ? `?${search}` : ''}`;
}
