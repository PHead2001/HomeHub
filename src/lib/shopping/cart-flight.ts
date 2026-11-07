/**
 * Geometry for the "into the cart" flight (H07): where the flying copy of a
 * ticked item starts (over the item's name) and how far it travels to land on
 * the cart icon's centre. Pure, so it is unit tested.
 */

export type RectLike = { left: number; top: number; width: number; height: number };
export type CartFlightPath = { start: { x: number; y: number }; dx: number; dy: number };

/** The copy's assumed size: names longer than 12rem are truncated in it. */
export const FLIGHT_COPY = { maxWidth: 192, height: 28 } as const;

const visible = (rect: RectLike, viewport: { width: number; height: number }) =>
  rect.width > 0 && rect.height > 0
  && rect.left < viewport.width && rect.left + rect.width > 0
  && rect.top < viewport.height && rect.top + rect.height > 0;

/**
 * The flight from `source` (the item's name) to `cart`, or null when either end is
 * not on screen (nothing would be seen, so nothing flies).
 */
export function cartFlightPath(source: RectLike, cart: RectLike, viewport: { width: number; height: number }): CartFlightPath | null {
  if (!visible(source, viewport) || !visible(cart, viewport)) return null;
  const width = Math.min(source.width, FLIGHT_COPY.maxWidth);
  const start = { x: Math.round(source.left), y: Math.round(source.top + source.height / 2 - FLIGHT_COPY.height / 2) };
  const fromCentre = { x: start.x + width / 2, y: start.y + FLIGHT_COPY.height / 2 };
  const toCentre = { x: cart.left + cart.width / 2, y: cart.top + cart.height / 2 };
  return { start, dx: Math.round(toCentre.x - fromCentre.x), dy: Math.round(toCentre.y - fromCentre.y) };
}
