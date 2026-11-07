/** Bento tilt (H22). Max tilt toward the cursor, in degrees. */
export const TILT_DEG = 4;

/**
 * Tilt angles toward a pointer at (x, y) inside a w×h box: up to ±TILT_DEG, 0 at
 * the center. `x` is the rotateY angle, `y` the rotateX angle. Applied only to a
 * tile's visual layer, never to the link (the click target).
 */
export function tiltFor(x: number, y: number, w: number, h: number): { x: number; y: number } {
  if (!(w > 0) || !(h > 0)) return { x: 0, y: 0 };
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const round = (value: number) => Math.round(value * 100) / 100 || 0;
  return { x: round(clamp((x / w) * 2 - 1) * TILT_DEG), y: round(-clamp((y / h) * 2 - 1) * TILT_DEG) };
}
