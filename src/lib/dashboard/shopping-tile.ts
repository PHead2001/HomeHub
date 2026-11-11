/**
 * The dashboard Shopping tile's rows (HP-33c, HP-36a/b). Pure, so it is unit tested
 * (tests/unit/dashboard-shopping-tile.test.ts); the tick itself is Shopping's shared
 * operation (`src/lib/shopping/tick.ts`).
 */
import type { ShoppingTileItem } from './facts';
import { reconcileDoneStates, type DoneTracking } from './done-states';

/** One row's key: items are unique per list, not per household. */
export const shoppingRowKey = (item: Pick<ShoppingTileItem, 'listId' | 'id'>) => `${item.listId}/${item.id}`;

export type ShoppingTileRows = {
  rows: ShoppingTileItem[];
  /** Needed items not listed ("+N more", to /shopping). */
  more: number;
  /** Name each row's list only when the rows come from more than one list. */
  showLists: boolean;
};

/** The rows the tile lists (stacked layouts: all of `items`, at most `SHOPPING_TILE_ITEMS`). */
export function shoppingTileRows(items: readonly ShoppingTileItem[], neededTotal: number): ShoppingTileRows {
  const rows = [...items];
  return {
    rows,
    more: Math.max(0, neededTotal - rows.length),
    showLists: new Set(rows.map((row) => row.listId)).size > 1,
  };
}

/**
 * Tick rows shown beside the house (HP-12d: the wide layout is one screen at 100% text),
 * by screen height in rem (the CSS in `dashboard.module.css` applies the same steps).
 *
 * The first row takes the place of the old item chips: with a 48 px tick it keeps the
 * Shopping tile no taller than its row neighbour, the Chores tile with its Done row
 * (160 px at 1280x800, 154 px at 1024x768). Each further row adds 3.25rem (the 48 px
 * control and a 0.25rem gap) to that first tile row. The right pane gains every rem of
 * screen height above 50rem while the inline detail rows use at most 3rem of it (the
 * second detail row from 54rem), so a second tick row needs at least 56.25rem and a third
 * 59.5rem; the steps below keep a margin of 3.75rem and more.
 */
export const WIDE_TICK_ROW_STEPS: ReadonlyArray<{ minHeightRem: number; rows: number }> = [
  { minHeightRem: 0, rows: 1 },
  { minHeightRem: 60, rows: 2 },
  { minHeightRem: 66, rows: 3 },
];

export function wideTickRows(screenHeightPx: number, remPx = 16): number {
  const rem = screenHeightPx / remPx;
  let rows = 0;
  for (const step of WIDE_TICK_ROW_STEPS) if (rem >= step.minHeightRem) rows = step.rows;
  return rows;
}

export type TickRowState = 'saving' | 'done' | 'failed';

/**
 * Reconciles the tile's local tick states with the live list (HP-33d), with the
 * dashboard's `done-states` rule: a row ticked here reads "done" until it leaves the
 * live list; once it has left, seeing it again means someone un-ticked it (or Undo
 * restored it), so the local state is dropped and its tick works again. `liveKeys` are
 * the listed rows' keys. Unlike a chore, a ticked item usually leaves the list before the
 * tick is acknowledged (the listener shows a queued write at once), so this runs on
 * state changes too, not only on list changes.
 */
export function reconcileTickStates(tracking: DoneTracking<TickRowState>, liveKeys: Iterable<string>): DoneTracking<TickRowState> {
  return reconcileDoneStates(tracking, liveKeys, 'done');
}

/**
 * Where focus goes after the row `key` leaves (its tick button had focus): the next
 * visible row's tick, else the previous one, else null (the tile link).
 */
export function focusAfterTick(visibleKeys: readonly string[], key: string): string | null {
  const index = visibleKeys.indexOf(key);
  if (index === -1) return null;
  return visibleKeys[index + 1] ?? visibleKeys[index - 1] ?? null;
}
