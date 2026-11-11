/*
 * Touch target geometry (D-2, WT-26, WT-28), shared by e2e specs and unit-tested on
 * its own (tests/unit/hit-areas.test.ts). The page reports raw measurements (each
 * control's box and the computed style of its `::after`); these pure helpers turn
 * them into effective hit areas and find the controls that are too small or whose
 * hit areas overlap. A control's effective hit area is the union of its own box and
 * its `::after` box: `.hit-slop` centres an invisible area of at least the target on
 * the control, and a stretched link's `::after` covers its whole card.
 */

export type Box = { x: number; y: number; width: number; height: number };

/** The computed `::after` of a control: offsets in px (null for `auto`), size and translation. */
export type PseudoStyle = {
  left: number | null;
  top: number | null;
  right: number | null;
  bottom: number | null;
  width: number;
  height: number;
  /** The translation of its `transform` (hit-slop uses translate(-50%, -50%)). */
  tx: number;
  ty: number;
};

/** One interactive control as measured in the page. */
export type ControlMeasure = {
  id: number;
  name: string;
  own: Box;
  /** The absolutely positioned `::after`, when it has one. */
  after: PseudoStyle | null;
  /** The padding box of the `::after`'s containing block. */
  containingBlock: Box | null;
  /** The box of a label the control sits inside (its hit area when the control itself is visually hidden or small). */
  label: Box | null;
  /** Ids of the other controls inside this one (nested controls are not an overlap). */
  contains: number[];
  /** An `<a>` laid out inline inside a paragraph: a text link, sized by the text around it. */
  inlineTextLink: boolean;
  /** Visually hidden (1 px, sr-only): its hit area is its label's. */
  visuallyHidden: boolean;
};

export type HitArea = { id: number; name: string; box: Box; contains: number[] };

/** The translation of a computed `transform` (`none`, `matrix(...)` or `matrix3d(...)`). */
export function parseTranslate(transform: string): { tx: number; ty: number } {
  const match = /^matrix(3d)?\(([^)]*)\)$/.exec(transform.trim());
  if (!match) return { tx: 0, ty: 0 };
  const values = match[2].split(',').map((value) => Number.parseFloat(value));
  if (match[1]) return { tx: values[12] ?? 0, ty: values[13] ?? 0 };
  return { tx: values[4] ?? 0, ty: values[5] ?? 0 };
}

/** A computed offset (`12px`, `auto`) in px, or null for `auto`. */
export function parseOffset(value: string): number | null {
  if (!value || value === 'auto') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Where an absolutely positioned `::after` lands, from its computed style and its containing block. */
export function pseudoBox(after: PseudoStyle, containingBlock: Box): Box | null {
  const { width, height } = after;
  if (!(width > 0) || !(height > 0)) return null;
  const x = after.left !== null
    ? containingBlock.x + after.left
    : after.right !== null ? containingBlock.x + containingBlock.width - after.right - width : containingBlock.x;
  const y = after.top !== null
    ? containingBlock.y + after.top
    : after.bottom !== null ? containingBlock.y + containingBlock.height - after.bottom - height : containingBlock.y;
  return { x: x + after.tx, y: y + after.ty, width, height };
}

export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** The control's effective hit area: its own box, grown by its `::after`, or its label's box when it is visually hidden. */
export function effectiveBox(control: ControlMeasure): Box {
  if (control.visuallyHidden && control.label) return control.label;
  const pseudo = control.after && control.containingBlock ? pseudoBox(control.after, control.containingBlock) : null;
  return pseudo ? union(control.own, pseudo) : control.own;
}

/** Why a small control is allowed (the explicit allowlist), or null when it must meet the minimum itself. */
export function allowedSmall(control: ControlMeasure, min: number): string | null {
  // A text link inside a sentence is sized by the text around it (WCAG 2.5.8 inline exception).
  if (control.inlineTextLink) return 'inline text link in a paragraph';
  // A radio or checkbox inside a label: the whole label is the hit area (a tap on it toggles the control).
  if (control.label && meetsMinimum(control.label, min)) return 'control inside a larger label';
  return null;
}

export function meetsMinimum(box: Box, min: number, tolerance = 0.5): boolean {
  return box.width >= min - tolerance && box.height >= min - tolerance;
}

/** True when the boxes share more than `tolerance` px on both axes (touching edges are fine). */
export function intersects(a: Box, b: Box, tolerance = 1): boolean {
  return a.x < b.x + b.width - tolerance && b.x < a.x + a.width - tolerance
    && a.y < b.y + b.height - tolerance && b.y < a.y + a.height - tolerance;
}

export function containsBox(outer: Box, inner: Box, tolerance = 1): boolean {
  return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

export type Overlap = {
  a: HitArea;
  b: HitArea;
  /**
   * `contained`: one hit area lies wholly inside the other (a control on a card
   * whose stretched link or block link is the card); it is fine only when the inner
   * control is on top and owns its whole area, which the page must confirm.
   * `partial`: two neighbours share part of their areas, so one steals the other's taps.
   */
  kind: 'contained' | 'partial';
  /** For `contained`, the inner (smaller) area. */
  inner?: HitArea;
};

/** Every pair of hit areas that overlap, except a control and a control nested inside it. */
export function findOverlaps(areas: HitArea[]): Overlap[] {
  const overlaps: Overlap[] = [];
  for (let i = 0; i < areas.length; i += 1) {
    for (let j = i + 1; j < areas.length; j += 1) {
      const a = areas[i];
      const b = areas[j];
      if (a.contains.includes(b.id) || b.contains.includes(a.id)) continue;
      if (!intersects(a.box, b.box)) continue;
      if (containsBox(a.box, b.box)) overlaps.push({ a, b, kind: 'contained', inner: b });
      else if (containsBox(b.box, a.box)) overlaps.push({ a, b, kind: 'contained', inner: a });
      else overlaps.push({ a, b, kind: 'partial' });
    }
  }
  return overlaps;
}

/** Points to hit-test inside a box: its centre and each corner, `inset` px in. */
export function samplePoints(box: Box, inset = 3): Array<{ x: number; y: number }> {
  const left = box.x + Math.min(inset, box.width / 2);
  const right = box.x + box.width - Math.min(inset, box.width / 2);
  const top = box.y + Math.min(inset, box.height / 2);
  const bottom = box.y + box.height - Math.min(inset, box.height / 2);
  return [
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ];
}
