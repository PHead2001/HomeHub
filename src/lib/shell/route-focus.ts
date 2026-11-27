/**
 * SL-18: after a client-side navigation, focus moves to the new page's main heading
 * (or to `<main>` while the page has none yet), so screen readers announce the page
 * and the next Tab starts in its content. Focus is only moved when nothing better
 * holds it: the page body, or a control in the shell's navigation (the header, the
 * phone tab bar) that started the navigation. Never while a dialog or the palette is
 * open, never from a field, and never on the first load (the browser starts there).
 *
 * Pure; unit tested in tests/unit/shell-section-11.test.ts.
 */

export type FocusSnapshot = {
  /** The focused element is the body (or nothing). */
  onBody: boolean;
  /** The focused element sits in the header or the phone tab bar. */
  inShellNav: boolean;
  /** An open dialog, alert dialog or menu is on screen. */
  overlayOpen: boolean;
};

export function shouldMoveRouteFocus(input: {
  previousPath: string | null;
  path: string;
  focus: FocusSnapshot;
}): boolean {
  const { previousPath, path, focus } = input;
  if (previousPath === null || previousPath === path) return false;
  if (focus.overlayOpen) return false;
  return focus.onBody || focus.inShellNav;
}

/** How long the new page may take to render its heading before focus goes to `main` (checked every `ROUTE_FOCUS_STEP_MS`). */
export const ROUTE_FOCUS_WAIT_MS = 1500;
/** A heading that renders later (data still loading) still takes focus from `main` until then. */
export const ROUTE_FOCUS_UPGRADE_MS = 6000;
export const ROUTE_FOCUS_STEP_MS = 100;

/** Shell navigation containers: a focused control inside one may hand focus to the page. */
export const SHELL_NAV_SELECTOR = '[data-site-header], [data-shell-nav]';
/** Anything that owns focus on its own, when shown. */
export const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/**
 * Whether an overlay is shown. Some stay in the DOM while closed (the account menu is
 * force-mounted; the tab bar's quick-add fan is aria-hidden and hidden), so only a
 * visible one outside an aria-hidden subtree counts (the same test as the shortcuts in
 * `command-center.tsx`).
 */
export function overlayShown(root: Pick<Document, 'querySelectorAll'> = document): boolean {
  for (const element of root.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    if (element.closest('[aria-hidden="true"]')) continue;
    if (element.getAttribute('data-state') === 'closed') continue;
    const visible = typeof element.checkVisibility === 'function'
      ? element.checkVisibility({ checkVisibilityCSS: true } as CheckVisibilityOptions)
      : element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
    if (visible) return true;
  }
  return false;
}
