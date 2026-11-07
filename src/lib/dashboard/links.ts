/**
 * Deep links into other modules, built with each module's own URL scheme so the
 * dashboard, palette and tab bar always open the right screen:
 * Shopping `?list=<id>` / `?tab=pantry` (`src/lib/shopping/url-state.ts`),
 * Maintenance `?tab=reminders|logs` (record links come from its reminders),
 * Pets `/pets/<id>?tab=feeding`.
 */
import { shoppingHref } from '../shopping/url-state';

export const PANTRY_HREF = shoppingHref('/shopping', null, { tab: 'inventory', listId: null });
export const shoppingListHref = (listId: string) => shoppingHref('/shopping', null, { tab: 'lists', listId });
export const MAINTENANCE_REMINDERS_HREF = '/maintenance?tab=reminders';
export const MAINTENANCE_LOGS_HREF = '/maintenance?tab=logs';
export const petFeedingHref = (petId: string) => `/pets/${encodeURIComponent(petId)}?tab=feeding`;
