/**
 * The Chores page's URL state: `?room=<roomId>` opens the page filtered to that
 * room (`?room=general` for chores without a room). The filter is always derived
 * from the current search params (`useSearchParams`), so links from the
 * dashboard's living house, browser Back/Forward and client navigation all keep
 * the filter and the address bar in step. "All Rooms" is the absence of the param.
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
