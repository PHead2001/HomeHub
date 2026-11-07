/** Fixed-position placement for dashboard peek cards (H26), kept inside the viewport. */

const CARD_WIDTH = 256;
const GAP = 8;
const EDGE = 16;
/** Room the card needs below the anchor before it opens above instead. */
const MIN_SPACE_BELOW = 220;

export type PeekPlacement = { left: number; top?: number; bottom?: number; above: boolean };

/** Fixed-position placement for a card next to `rect`, kept inside the viewport. */
export function placePeek(rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, viewport: { width: number; height: number }): PeekPlacement {
  const width = Math.min(CARD_WIDTH, viewport.width - EDGE * 2);
  const preferredLeft = rect.left + width > viewport.width - EDGE ? rect.right - width : rect.left;
  const left = Math.max(EDGE, Math.min(preferredLeft, viewport.width - EDGE - width));
  const spaceBelow = viewport.height - rect.bottom;
  const above = spaceBelow < MIN_SPACE_BELOW && rect.top > spaceBelow;
  return above
    ? { left, bottom: viewport.height - rect.top + GAP, above }
    : { left, top: rect.bottom + GAP, above };
}
