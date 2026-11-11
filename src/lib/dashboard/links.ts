/**
 * Deep links into other modules, built with each module's own URL scheme so the
 * dashboard, palette and tab bar always open the right screen:
 * Shopping `?list=<id>` / `?tab=pantry` (`src/lib/shopping/url-state.ts`),
 * Maintenance `?tab=reminders|logs` (record links come from its reminders),
 * Pets `/pets/<id>?tab=feeding`.
 */
import { shoppingHref } from '../shopping/url-state';
import { choresFiltersHref } from '../chores/url-state';

export const PANTRY_HREF = shoppingHref('/shopping', null, { tab: 'inventory', listId: null });
export const shoppingListHref = (listId: string) => shoppingHref('/shopping', null, { tab: 'lists', listId });
export const MAINTENANCE_REMINDERS_HREF = '/maintenance?tab=reminders';
export const MAINTENANCE_LOGS_HREF = '/maintenance?tab=logs';
export const petFeedingHref = (petId: string) => `/pets/${encodeURIComponent(petId)}?tab=feeding`;

/**
 * Chores filtered to one room: `/chores?room=<roomId>` (the Chores module's room
 * filter contract). Chores without a room use `general`, as on the Chores page.
 * The dashboard's "Unknown Room" bucket is not a Firestore room, so it opens the
 * unfiltered list.
 */
export const choresRoomHref = (roomId: string) =>
  roomId === 'unknown-room' ? '/chores' : `/chores?room=${encodeURIComponent(roomId)}`;

/**
 * View-transition name of a room, shared with the Chores page's room container
 * (`roomSharedId` in `src/lib/chores/url-state.ts`): `room-<roomId>`, sanitized
 * exactly like `sharedId` but with no part suffix. Keep both in sync.
 */
export const roomMorphName = (roomId: string) => `room-${roomId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

export const MAINTENANCE_OVERVIEW_HREF = '/maintenance?tab=overview';

/**
 * Chores filtered for the brief (HP-25, GOAL-filters): `/chores?due=overdue` for the
 * household's overdue work, `&who=me` for the reader's own; `/chores?who=me` for the
 * reader's chores today. The Chores page keeps these filters in the URL.
 */
export const choresFilteredHref = (filters: { overdue?: boolean; mine?: boolean }) =>
  choresFiltersHref('/chores', null, { due: filters.overdue ? 'overdue' : 'all', who: filters.mine ? 'me' : 'all' });
