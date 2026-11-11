/**
 * Focus after a dashboard one-tap action (Done, Fed, Tick) whose control leaves its tile
 * (`keepFocusInTile` in `src/components/dashboard/focus-after-action.ts`). Pure decisions,
 * so they are unit tested without a DOM.
 */

/**
 * The actions to try, in order, once the action `key` has left: the next visible one in
 * the tile, then the previous one. Empty when it was the only one (the tile link is next).
 */
export function focusCandidates(visibleKeys: readonly string[], key: string): string[] {
  const index = visibleKeys.indexOf(key);
  if (index === -1) return [];
  return [visibleKeys[index + 1], visibleKeys[index - 1]].filter((candidate): candidate is string => candidate !== undefined);
}

/** The first of `focusCandidates`, or null for the tile link. */
export function nextActionKey(visibleKeys: readonly string[], key: string): string | null {
  return focusCandidates(visibleKeys, key)[0] ?? null;
}

/**
 * The action to focus once the pressed one (at `position` among the visible actions) has
 * left, from the tile's visible, enabled actions now (`nowKeys`): the first candidate still
 * there; else the one that moved into its place, or the one before it (beside the house a
 * tile shows its first row only, so the next row takes the departed row's place); else
 * null, for the tile link.
 */
export function actionAfterLeave(candidates: readonly string[], position: number, nowKeys: readonly string[]): string | null {
  const kept = candidates.find((key) => nowKeys.includes(key));
  if (kept) return kept;
  if (position < 0) return null;
  return nowKeys[position] ?? nowKeys[position - 1] ?? null;
}

export type RowFocusFrame = {
  /** The pressed control is still in the document. */
  connected: boolean;
  /** It is disabled (saving, or done until its row leaves). */
  disabled: boolean;
  /** Focus is nowhere (on the page body): nobody has moved it since. */
  focusLost: boolean;
  /** It was disabled in an earlier frame (focus was lost to that, not moved by the member). */
  wasDisabled: boolean;
  /** The wait is over. */
  expired: boolean;
  /**
   * Focus has been seen on another element (not the pressed control, not the page body)
   * in this frame or any earlier one: the member moved on, so the watch is over for good.
   */
  movedAway: boolean;
  /** A newer one-tap press (in this tile or another) started its own watch. */
  superseded: boolean;
};

/**
 * One animation frame of the watch that starts when a focused action control is pressed:
 * - `move`: the control has left and focus is on the body: focus the next action, else
 *   the previous one, else the tile link (or the tile, when it has become a link);
 * - `refocus`: the control is back from saving (it failed, was refused, or the row stays,
 *   as a pet fed once of twice a day does) and the disabling lost focus: back onto it;
 * - `wait`: still saving, or listed and working;
 * - `stop`: focus was seen on another control since the press (even if it later fell
 *   to the body), a newer press took over, or the wait is over. Only focus that stayed
 *   on the pressed control or the body the whole time keeps the watch alive.
 */
export function rowFocusStep(frame: RowFocusFrame): 'move' | 'refocus' | 'wait' | 'stop' {
  if (frame.movedAway || frame.superseded) return 'stop';
  if (!frame.connected) return frame.focusLost ? 'move' : 'stop';
  if (frame.expired) return 'stop';
  if (!frame.disabled && frame.wasDisabled && frame.focusLost) return 'refocus';
  return 'wait';
}
