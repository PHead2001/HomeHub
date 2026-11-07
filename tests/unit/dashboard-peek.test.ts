import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { placePeek } from '../../src/lib/dashboard/peek';

const viewport = { width: 1280, height: 800 };

describe('peek card placement (H26)', () => {
  it('opens below the anchor when there is room', () => {
    const placement = placePeek({ left: 100, right: 300, top: 200, bottom: 260 }, viewport);
    assert.equal(placement.above, false);
    assert.equal(placement.top, 268);
    assert.equal(placement.left, 100);
  });

  it('opens above an anchor near the bottom of the viewport (bottom-row rooms)', () => {
    const placement = placePeek({ left: 100, right: 300, top: 640, bottom: 700 }, viewport);
    assert.equal(placement.above, true);
    assert.equal(placement.bottom, 800 - 640 + 8);
    assert.equal(placement.top, undefined);
  });

  it('stays inside the viewport near the right edge and on narrow phones', () => {
    const right = placePeek({ left: 1200, right: 1260, top: 100, bottom: 140 }, viewport);
    assert.ok(right.left + 256 <= viewport.width - 16);
    const phone = placePeek({ left: 10, right: 100, top: 100, bottom: 140 }, { width: 320, height: 600 });
    assert.equal(phone.left, 16);
  });
});
