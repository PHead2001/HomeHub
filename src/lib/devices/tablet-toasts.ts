// Toasts on a registered wall tablet (docs/modules/devices/README.md, "Tablet shell";
// emulator evidence D1, D2, D5). Pure, shared by the tablet's Toaster and the device action
// runtime, unit tested.
//
// - At most `TABLET_TOAST_LIMIT` toasts show, newest first, at the bottom right of the
//   screen; the viewport itself never takes a tap (only a toast card does), and the tablet's
//   main area keeps a scroll clearance at its end so its last controls can always be scrolled
//   above them.
// - A toast without an action (a notice, a refusal such as "Too late to undo.") leaves
//   after at most `TABLET_INFO_TOAST_MS`; an Undo toast stays for the time its window has left.
// - After the tablet comes back from the background, every offered Undo is measured again
//   from its journal entry: one whose window has passed is removed, another is offered again
//   for the time it really has left.

import { capToasts } from '@/lib/shell/toast-queue';

export const TABLET_TOAST_LIMIT = 2;
export const TABLET_INFO_TOAST_MS = 4_000;

type ShownToast = { id: string; open?: boolean; action?: unknown; duration?: number; holdsAction?: boolean };

/**
 * The toasts the tablet shows: open ones, newest first, at most the limit, chosen by the
 * shared store's own policy (`capToasts`, src/lib/shell/toast-queue.ts): a notice or refusal
 * never pushes an Undo off screen while its window is open (Codex review 4).
 */
export function tabletToasts<T extends ShownToast>(newestFirst: readonly T[]): T[] {
  return capToasts(newestFirst.filter((toast) => toast.open !== false), TABLET_TOAST_LIMIT);
}

/** How long a toast stays on the tablet: an informational one at most 4 s; an Undo its own (remaining-window) duration. */
export function tabletToastDuration(toast: Pick<ShownToast, 'action' | 'duration'>): number {
  if (toast.action) return toast.duration ?? TABLET_INFO_TOAST_MS;
  return Math.min(toast.duration ?? TABLET_INFO_TOAST_MS, TABLET_INFO_TOAST_MS);
}

export type ToastExpiry = { ms: number; expiresAt: number };

/**
 * Every open toast's absolute expiry, shown or not (Codex #190): the display limit never
 * pauses a toast, so one hidden behind two newer ones still leaves when its time is up and
 * never comes back with a full duration. An expiry is kept while the toast's duration is
 * unchanged; a new duration (an Undo offered again for the time it has left) counts from now.
 */
export function toastExpiries(
  previous: ReadonlyMap<string, ToastExpiry>,
  toasts: readonly Pick<ShownToast, 'id' | 'open' | 'action' | 'duration'>[],
  now: number,
): Map<string, ToastExpiry> {
  const next = new Map<string, ToastExpiry>();
  for (const toast of toasts) {
    if (toast.open === false) continue;
    const ms = tabletToastDuration(toast);
    const known = previous.get(toast.id);
    next.set(toast.id, known && known.ms === ms ? known : { ms, expiresAt: now + ms });
  }
  return next;
}

/** What to do with an offered Undo when the tablet returns from the background (D5). */
export function resumedUndo(remainingMs: number): { kind: 'remove' } | { kind: 'reoffer'; remainingMs: number } {
  return remainingMs <= 0 ? { kind: 'remove' } : { kind: 'reoffer', remainingMs };
}
