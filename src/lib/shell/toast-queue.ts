/**
 * Which toasts stay on screen (pure, unit tested). Up to `TOAST_LIMIT` toasts
 * show at once, newest first. When a new toast would exceed the limit, the one
 * dropped is, in order: the oldest closed toast (already leaving), then the
 * oldest open toast without a held action, and only when every open toast holds
 * one (e.g. three Undo toasts), the oldest of those. So a push, error or update
 * toast never pushes an Undo off screen before its window ends.
 */

export const TOAST_LIMIT = 3;

export type QueuedToast = { id: string; open?: boolean; holdsAction?: boolean; group?: string };

/**
 * Adds `toast` newest first. A toast with a `group` (one per kind of Undo, e.g.
 * `notification-dismiss`) replaces every earlier toast of that group at once:
 * the older one leaves the store immediately (no exit animation), so exactly
 * one Undo of that kind is ever on screen. Then the limit applies.
 */
export function addToast<T extends QueuedToast>(newestFirst: readonly T[], toast: T, limit = TOAST_LIMIT): T[] {
  const rest = toast.group ? newestFirst.filter((existing) => existing.group !== toast.group) : newestFirst;
  return capToasts([toast, ...rest], limit);
}

export function capToasts<T extends QueuedToast>(newestFirst: readonly T[], limit = TOAST_LIMIT): T[] {
  const kept = [...newestFirst];
  const dropOldest = (match: (toast: T) => boolean) => {
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      if (match(kept[index])) {
        kept.splice(index, 1);
        return true;
      }
    }
    return false;
  };
  while (kept.length > limit) {
    if (dropOldest((toast) => toast.open === false)) continue;
    if (dropOldest((toast) => !toast.holdsAction)) continue;
    kept.pop();
  }
  return kept;
}

/** True when an open toast holds an action (an Undo): the shell counts as busy. */
export function toastsHoldShell(toasts: readonly QueuedToast[]): boolean {
  return toasts.some((toast) => toast.open !== false && toast.holdsAction === true);
}
