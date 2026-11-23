// Radix dialogs decide whether a touch landed "outside" them only at the click that follows
// the touch (a mouse press is decided at once). By that click, a tap that picked something in
// a dialog stacked above (the wall tablet's "Who's here?" over a pet sheet; emulator, 2026-11-23)
// has already closed that dialog, so the dialog underneath would read the same tap as an
// outside tap and close too. A target that has left the page, or that sits inside another
// dialog, never counts as outside; the dialog's own overlay still does.

/** The part of a DOM node this check reads (Element and Node satisfy it). */
export type TapTarget = { isConnected: boolean; closest?: (selector: string) => unknown };

const OTHER_DIALOG = '[role="dialog"], [role="alertdialog"]';

/** True when an outside tap on `target` must not dismiss the dialog underneath. */
export function tapBelongsToAnotherLayer(target: unknown): boolean {
  if (!target || typeof target !== 'object' || !('isConnected' in target)) return true;
  const node = target as TapTarget;
  if (!node.isConnected) return true;
  return typeof node.closest === 'function' && node.closest(OTHER_DIALOG) != null;
}
