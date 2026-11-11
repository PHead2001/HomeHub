'use client';

import { actionAfterLeave, focusCandidates, rowFocusStep } from '@/lib/dashboard/row-focus';

/** On a tile's card when it has one-tap actions (`Tile` in bento-grid.tsx); its `data-testid` names the tile. */
const ACTION_TILE_ATTR = 'data-action-tile';

/** How long a pressed control is watched: a server completion and its snapshot can take a while. */
const WATCH_MS = 10_000;

/** The newest press's watch: a newer press supersedes every older watch. */
let latestWatch = 0;

/** The tile's action controls that are on screen (rows hidden beside the house are skipped), in order. */
function visibleActions(tile: Element): HTMLButtonElement[] {
  return [...tile.querySelectorAll<HTMLButtonElement>('[data-action-key]')]
    .filter((control) => control.getClientRects().length > 0);
}

const keyOf = (control: HTMLElement) => control.dataset.actionKey ?? '';

/**
 * The control to focus once the pressed one has left (`actionAfterLeave`), else the tile
 * link. Resolved from the tile mounted now, not the one seen at the press: the last row's
 * departure re-mounts the tile (with rows it is a card around a link, without them the
 * tile is the link itself).
 */
function focusTarget(tileId: string, candidates: readonly string[], position: number): HTMLElement | null {
  const tile = document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(tileId)}"]`);
  if (!tile) return null;
  const enabled = visibleActions(tile).filter((control) => !control.disabled);
  const key = actionAfterLeave(candidates, position, enabled.map(keyOf));
  const action = key === null ? undefined : enabled.find((control) => keyOf(control) === key);
  return action ?? tile.querySelector<HTMLElement>(`[data-testid="${CSS.escape(`${tileId}-link`)}"]`) ?? (tile.matches('a[href]') ? tile : null);
}

/**
 * Keeps keyboard focus in the tile after a one-tap action (Done, Fed, Tick; SH-26a on the
 * dashboard). Call it as the focused control is pressed. Once the control has left (its
 * row left, or a fed pet's Fed went), focus goes to the next action in the tile, else the
 * previous one, else the action that took its place, else the tile link; if the control
 * comes back from saving (failed, refused, or still needed), focus returns to it.
 * Only while focus has stayed on the pressed control or the page body since the press:
 * once it has been seen on any other element the watch ends for good, and a newer press
 * (in any tile) ends every older watch, so only the newest action places focus. The Undo
 * toast keeps its own keyboard route (F8 or Tab into the notifications region).
 */
export function keepFocusInTile(button: HTMLButtonElement) {
  // Any newer press ends older watches, whether or not it starts one itself.
  const watch = ++latestWatch;
  if (document.activeElement !== button) return;
  const tile = button.closest<HTMLElement>(`[${ACTION_TILE_ATTR}]`);
  const tileId = tile?.dataset.testid;
  const key = button.dataset.actionKey;
  if (!tile || !tileId || !key) return;
  const keys = visibleActions(tile).map(keyOf);
  const candidates = focusCandidates(keys, key);
  const position = keys.indexOf(key);
  const deadline = performance.now() + WATCH_MS;
  let wasDisabled = false;
  let movedAway = false;
  const frame = () => {
    const active = document.activeElement;
    movedAway ||= Boolean(active && active !== document.body && active !== button);
    const step = rowFocusStep({
      connected: button.isConnected,
      disabled: button.disabled,
      focusLost: !active || active === document.body,
      wasDisabled,
      expired: performance.now() > deadline,
      movedAway,
      superseded: watch !== latestWatch,
    });
    wasDisabled ||= button.disabled;
    if (step === 'move') {
      focusTarget(tileId, candidates, position)?.focus({ preventScroll: true });
    } else if (step === 'refocus') {
      wasDisabled = false;
      button.focus({ preventScroll: true });
      requestAnimationFrame(frame);
    } else if (step === 'wait') {
      requestAnimationFrame(frame);
    }
  };
  requestAnimationFrame(frame);
}
