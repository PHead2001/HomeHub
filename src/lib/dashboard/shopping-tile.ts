/**
 * The dashboard Shopping tile's rows (HP-33c, HP-36a/b). Pure, so it is unit tested
 * (tests/unit/dashboard-shopping-tile.test.ts); the tick itself is Shopping's shared
 * operation (`src/lib/shopping/tick.ts`).
 */
import type { ShoppingTileItem } from './facts';
import { reconcileDoneStates, type DoneStateNames, type DoneTracking } from './done-states';

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
 * Tick rows shown beside the house, by screen height in rem (the CSS in
 * `dashboard.module.css` applies the same steps), on the height model of HP-12e: the
 * panes are one screen tall, tile rows are as tall as their content and share what is
 * left, and the inline detail rows of the other tiles show from 50rem (one) and 54rem
 * (two).
 *
 * With tick rows the Shopping tile shows no item chips and no inline detail rows. Its
 * first row (a 48 px tick) keeps the tile no taller than the Chores tile beside it (title,
 * ring and Done row), so below 50rem, where the right pane has the least height to spare
 * (about 60 px of shared slack at 1263x722 with the seed), one row costs nothing. From
 * 50rem, where the detail rows start, a second row shows: two rows are about 30 px taller
 * than the chips and list row the tile showed there before, against more than 70 px of
 * slack from 800 px of height up. A third row adds another 3.25rem (the control and its
 * 0.25rem gap) and shows from 60rem, with the second detail rows already placed.
 */
export const WIDE_TICK_ROW_STEPS: ReadonlyArray<{ minHeightRem: number; rows: number }> = [
  { minHeightRem: 0, rows: 1 },
  { minHeightRem: 50, rows: 2 },
  { minHeightRem: 60, rows: 3 },
];

export function wideTickRows(screenHeightPx: number, remPx = 16): number {
  const rem = screenHeightPx / remPx;
  let rows = 0;
  for (const step of WIDE_TICK_ROW_STEPS) if (rem >= step.minHeightRem) rows = step.rows;
  return rows;
}

export type TickRowState = 'saving' | 'done' | 'failed';

/**
 * The tile's tick states follow the live list with the dashboard's `done-states` rule
 * (HP-33d): a row ticked here reads "done" until it leaves the live list; once it has
 * left (while saving too: the listener shows a queued write at once, usually before the
 * tick is acknowledged), seeing it again means someone un-ticked it (or Undo restored
 * it), so the local state is dropped and its tick works again.
 */
export const TICK_DONE_STATES = { saving: 'saving', done: 'done' } as const satisfies DoneStateNames<TickRowState>;

export function reconcileTickStates(tracking: DoneTracking<TickRowState>, liveKeys: Iterable<string>): DoneTracking<TickRowState> {
  return reconcileDoneStates(tracking, liveKeys, TICK_DONE_STATES);
}

/**
 * Where focus goes after the row `key` leaves (its tick button had focus): the next
 * visible row's tick, else the previous one, else null (the tile link). The dashboard's
 * one rule for every one-tap action (`src/lib/dashboard/row-focus.ts`).
 */
export { nextActionKey as focusAfterTick } from './row-focus';
