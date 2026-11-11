/**
 * A pending "move focus into this field" request made from a menu item (H02: turning
 * live weather on, or "Change weather city", opens the city field on the house).
 *
 * The menu keeps moving focus after the selection: while it closes, a pointer leaving
 * a disabled item focuses the menu itself (Radix `onItemLeave`), and when it finally
 * unmounts it returns focus to its trigger unless told not to. How long the close
 * takes, and whether the field mounts before or after those moves, depends on frame
 * timing and save latency. So the request stays pending until the menu has closed:
 * the field takes focus as soon as it is ready (and again if it re-mounts), and the
 * menu's close puts focus back in the field if anything moved it meanwhile.
 *
 * Pure (no DOM): `focus` callbacks return whether the field now has focus.
 */
export type FocusIntent = {
  /** Asked for at the menu selection, before any await. */
  request: () => void;
  /** Dropped (the field will not show, or the save failed). */
  cancel: () => void;
  isPending: () => boolean;
  /** The field mounted or re-mounted: focus it if asked for. */
  fieldReady: (focus: () => boolean) => void;
  /**
   * Focus left the field. `toElsewhere` is true when the member moved it somewhere
   * outside the closing menu, which ends the request.
   */
  fieldBlurred: (toElsewhere: boolean) => void;
  /**
   * The menu finished closing and is about to choose where focus goes. Focuses the
   * field when asked for; returns true when the menu must leave focus alone.
   */
  menuClosed: (focus: () => boolean) => boolean;
};

export function createFocusIntent(): FocusIntent {
  let pending = false;
  let menuClosing = false;
  return {
    request() {
      pending = true;
      menuClosing = true;
    },
    cancel() {
      pending = false;
    },
    isPending: () => pending,
    fieldReady(focus) {
      if (!pending) return;
      // Settled only once the menu can no longer move focus.
      if (focus() && !menuClosing) pending = false;
    },
    fieldBlurred(toElsewhere) {
      if (pending && toElsewhere) pending = false;
    },
    menuClosed(focus) {
      menuClosing = false;
      if (!pending) return false;
      // Not mounted yet (the form shows after this): stay pending, `fieldReady` finishes.
      if (focus()) pending = false;
      return true;
    },
  };
}
