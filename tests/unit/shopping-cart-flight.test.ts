import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cartFlightPath, FLIGHT_COPY } from '../../src/lib/shopping/cart-flight';

const viewport = { width: 1000, height: 800 };

describe('into the cart flight path', () => {
  it('starts over the item name and ends on the cart centre', () => {
    const source = { left: 100, top: 400, width: 120, height: 20 };
    const cart = { left: 600, top: 100, width: 40, height: 40 };
    const path = cartFlightPath(source, cart, viewport)!;
    assert.deepEqual(path.start, { x: 100, y: 396 });
    // Copy centre (100 + 60, 396 + 14) to cart centre (620, 120).
    assert.equal(path.dx, 460);
    assert.equal(path.dy, -290);
  });

  it('caps the copy width for long names', () => {
    const path = cartFlightPath({ left: 0, top: 0, width: 600, height: 28 }, { left: 500, top: 0, width: 40, height: 28 }, viewport)!;
    assert.equal(path.dx, 520 - FLIGHT_COPY.maxWidth / 2);
  });

  it('does not fly when either end is off screen or hidden', () => {
    const cart = { left: 600, top: 100, width: 40, height: 40 };
    assert.equal(cartFlightPath({ left: 10, top: -100, width: 100, height: 20 }, cart, viewport), null);
    assert.equal(cartFlightPath({ left: 10, top: 10, width: 100, height: 20 }, { ...cart, top: 900 }, viewport), null);
    assert.equal(cartFlightPath({ left: 10, top: 10, width: 0, height: 0 }, cart, viewport), null);
  });
});
