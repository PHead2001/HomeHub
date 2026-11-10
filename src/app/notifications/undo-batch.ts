import { UNDO_WINDOW_MS } from '../../lib/undo-window';

/**
 * Pending dismissals that one Undo restores.
 *
 * Each dismissal's toast replaces the previous dismissal toast (toast group
 * `notification-dismiss` removes the older one at once; other toasts may still show beside it, up to `TOAST_LIMIT`). To
 * keep every recent dismissal undoable, dismissals made within the Undo window
 * of each other accumulate: the newest toast counts all of them and its Undo
 * restores all of them. The window runs
 * from the latest dismissal; once it passes (or Undo runs) the batch starts
 * over. Batches are per household and member.
 */

/** How long the Undo action stays available after the latest dismissal. */
export const DISMISS_UNDO_MS = UNDO_WINDOW_MS;

/** Toast copy for a dismissal of `count` notifications. */
export function dismissedToastText(count: number): string {
  return count === 1 ? 'Notification dismissed' : `${count} notifications dismissed`;
}

export type UndoBatch = {
  /** Adds dismissed ids and returns everything the next Undo would restore. */
  add: (scope: string, ids: string[], at?: number) => string[];
  /**
   * Returns and clears what Undo restores. Undo is only reachable from the
   * newest toast, which lives exactly as long as the window, so no time check
   * is needed here (a click during the toast's exit must still work).
   */
  take: (scope: string) => string[];
};

export function createUndoBatch(windowMs = DISMISS_UNDO_MS, clock: () => number = Date.now): UndoBatch {
  let scope: string | null = null;
  let pending: string[] = [];
  let expiresAt = 0;

  return {
    add(nextScope, ids, at = clock()) {
      if (scope !== nextScope || at >= expiresAt) pending = [];
      scope = nextScope;
      pending = [...new Set([...pending, ...ids])];
      expiresAt = at + windowMs;
      return [...pending];
    },
    take(takeScope) {
      const restore = scope === takeScope ? pending : [];
      pending = [];
      expiresAt = 0;
      return restore;
    },
  };
}

/** One batch for the whole app, shared by the bell and the notification center. */
export const notificationUndoBatch = createUndoBatch();
