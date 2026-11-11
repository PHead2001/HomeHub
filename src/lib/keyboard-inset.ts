/**
 * Pixels the on-screen keyboard (or other browser UI) covers at the bottom of the
 * layout viewport, from the visual viewport: 0 when there is no visual viewport
 * or nothing is covered. Phone bottom sheets (SH-19b) sit this far above the
 * bottom, so their fields and buttons stay above the keyboard.
 */
export function keyboardInset(layoutHeight: number, visual: { height: number; offsetTop: number } | null | undefined): number {
  if (!visual || !Number.isFinite(layoutHeight) || !Number.isFinite(visual.height)) return 0;
  const covered = layoutHeight - visual.height - (Number.isFinite(visual.offsetTop) ? visual.offsetTop : 0);
  return covered > 1 ? Math.round(covered) : 0;
}

/** Bottom sheets open at once (nested sheets share one `--keyboard-inset`). */
let activeSheets = 0;
let detach: (() => void) | null = null;

/**
 * Keeps `--keyboard-inset` on <html> up to date while at least one phone bottom
 * sheet is open (one visual viewport listener for all of them). Returns the
 * release for this sheet.
 */
export function trackKeyboardInset(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  activeSheets += 1;
  if (activeSheets === 1) {
    const root = document.documentElement;
    const visual = window.visualViewport ?? null;
    const update = () => root.style.setProperty('--keyboard-inset', `${keyboardInset(window.innerHeight, visual)}px`);
    update();
    visual?.addEventListener('resize', update);
    visual?.addEventListener('scroll', update);
    detach = () => {
      visual?.removeEventListener('resize', update);
      visual?.removeEventListener('scroll', update);
      root.style.removeProperty('--keyboard-inset');
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSheets -= 1;
    if (activeSheets === 0) {
      detach?.();
      detach = null;
    }
  };
}
