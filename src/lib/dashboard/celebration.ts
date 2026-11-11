/**
 * HP-34: when the dashboard may celebrate "House is clean". Pure, so it is unit tested.
 *
 * Only on live data: the chores section is `ready` and none of its listeners answered
 * from the device cache (a cached or failed read could hide work), today has work
 * (`todayTotal > 0`; an empty day is not a celebration), all of it is done, nothing is
 * overdue and no missed instance of a repeating chore was folded away. At most once per
 * household per day on a device (`houseCleanStorageKey`, shared with the Chores page).
 */
import type { SectionState } from './dashboard-store';
import type { ChoreFacts } from './facts';

export function houseCleanReady(
  state: SectionState | undefined,
  chores: Pick<ChoreFacts, 'todayTotal' | 'todayDone' | 'overdueTotal' | 'missed'> | undefined,
): boolean {
  if (!state || state.status !== 'ready' || state.cached) return false;
  if (!chores) return false;
  if (chores.todayTotal <= 0) return false;
  if (chores.todayDone < chores.todayTotal) return false;
  if (chores.overdueTotal > 0) return false;
  // Undefined means the facts predate the count (a saved snapshot): not known, so no celebration.
  if (chores.missed === undefined || chores.missed > 0) return false;
  return true;
}
