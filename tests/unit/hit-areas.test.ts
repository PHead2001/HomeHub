import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allowedSmall, containsBox, effectiveBox, findOverlaps, intersects, meetsMinimum, parseOffset, parseTranslate, pseudoBox, samplePoints, union,
  type ControlMeasure, type HitArea,
} from '../e2e/hit-areas';

const control = (overrides: Partial<ControlMeasure>): ControlMeasure => ({
  id: 1,
  name: 'control',
  own: { x: 100, y: 100, width: 40, height: 40 },
  after: null,
  containingBlock: null,
  label: null,
  contains: [],
  inlineTextLink: false,
  visuallyHidden: false,
  ...overrides,
});

describe('hit areas (D-2, WT-28)', () => {
  it('reads the translation of a computed transform', () => {
    assert.deepEqual(parseTranslate('none'), { tx: 0, ty: 0 });
    assert.deepEqual(parseTranslate('matrix(1, 0, 0, 1, -24, -20)'), { tx: -24, ty: -20 });
    assert.deepEqual(parseTranslate('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 0, 1)'), { tx: 5, ty: 6 });
  });

  it('reads computed offsets, auto as null', () => {
    assert.equal(parseOffset('auto'), null);
    assert.equal(parseOffset('12.5px'), 12.5);
    assert.equal(parseOffset(''), null);
  });

  it('places a centred hit-slop ::after around a small control', () => {
    // A 40 px button with `.hit-slop`: left/top 50%, 48 px square, translate(-50%, -50%).
    const own = { x: 100, y: 100, width: 40, height: 40 };
    const box = pseudoBox({ left: 20, top: 20, right: null, bottom: null, width: 48, height: 48, tx: -24, ty: -24 }, own);
    assert.deepEqual(box, { x: 96, y: 96, width: 48, height: 48 });
    assert.deepEqual(effectiveBox(control({ own, after: { left: 20, top: 20, right: null, bottom: null, width: 48, height: 48, tx: -24, ty: -24 }, containingBlock: own })), box);
  });

  it('places a stretched link ::after over its card', () => {
    const card = { x: 10, y: 20, width: 280, height: 420 };
    const link = control({ own: { x: 30, y: 300, width: 90, height: 26 }, after: { left: 0, top: 0, right: 0, bottom: 0, width: 280, height: 420, tx: 0, ty: 0 }, containingBlock: card });
    assert.deepEqual(effectiveBox(link), card);
  });

  it('places a ::after anchored by right and bottom', () => {
    const box = pseudoBox({ left: null, top: null, right: 10, bottom: 5, width: 20, height: 10, tx: 0, ty: 0 }, { x: 0, y: 0, width: 100, height: 50 });
    assert.deepEqual(box, { x: 70, y: 35, width: 20, height: 10 });
  });

  it('ignores an empty ::after', () => {
    assert.equal(pseudoBox({ left: 0, top: 0, right: null, bottom: null, width: 0, height: 0, tx: 0, ty: 0 }, { x: 0, y: 0, width: 10, height: 10 }), null);
  });

  it('uses the label of a visually hidden control', () => {
    const label = { x: 0, y: 0, width: 116, height: 84 };
    assert.deepEqual(effectiveBox(control({ own: { x: 5, y: 5, width: 1, height: 1 }, visuallyHidden: true, label })), label);
  });

  it('allows only inline text links and controls inside a large label', () => {
    assert.equal(allowedSmall(control({ inlineTextLink: true }), 48), 'inline text link in a paragraph');
    assert.equal(allowedSmall(control({ label: { x: 0, y: 0, width: 300, height: 56 } }), 48), 'control inside a larger label');
    assert.equal(allowedSmall(control({ label: { x: 0, y: 0, width: 300, height: 40 } }), 48), null);
    assert.equal(allowedSmall(control({}), 48), null);
  });

  it('measures the minimum with a half-pixel tolerance', () => {
    assert.equal(meetsMinimum({ x: 0, y: 0, width: 47.6, height: 48 }, 48), true);
    assert.equal(meetsMinimum({ x: 0, y: 0, width: 47, height: 48 }, 48), false);
  });

  it('treats touching edges as no overlap', () => {
    const a = { x: 0, y: 0, width: 48, height: 48 };
    assert.equal(intersects(a, { x: 48, y: 0, width: 48, height: 48 }), false);
    assert.equal(intersects(a, { x: 47.5, y: 0, width: 48, height: 48 }), false);
    assert.equal(intersects(a, { x: 44, y: 0, width: 48, height: 48 }), true);
  });

  it('unions and contains boxes', () => {
    assert.deepEqual(union({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: -5, width: 10, height: 10 }), { x: 0, y: -5, width: 15, height: 15 });
    assert.equal(containsBox({ x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 10, width: 48, height: 48 }), true);
    assert.equal(containsBox({ x: 0, y: 0, width: 100, height: 100 }, { x: 60, y: 10, width: 48, height: 48 }), false);
  });

  it('finds partial and contained overlaps, never nested controls', () => {
    const area = (id: number, box: HitArea['box'], contains: number[] = []): HitArea => ({ id, name: `c${id}`, box, contains });
    // Two 40 px icon buttons 4 px apart, each with a 48 px hit-slop: the areas overlap by 4 px.
    const previous = area(1, { x: 96, y: 96, width: 48, height: 48 });
    const next = area(2, { x: 140, y: 96, width: 48, height: 48 });
    // A card link and the menu button on top of it.
    const card = area(3, { x: 0, y: 300, width: 280, height: 400 });
    const menu = area(4, { x: 224, y: 308, width: 48, height: 48 });
    // A button with an inner control (nested): not an overlap.
    const outer = area(5, { x: 400, y: 0, width: 200, height: 60 }, [6]);
    const inner = area(6, { x: 410, y: 6, width: 48, height: 48 });
    const overlaps = findOverlaps([previous, next, card, menu, outer, inner]);
    assert.equal(overlaps.length, 2);
    assert.equal(overlaps[0].kind, 'partial');
    assert.deepEqual([overlaps[0].a.id, overlaps[0].b.id], [1, 2]);
    assert.equal(overlaps[1].kind, 'contained');
    assert.equal(overlaps[1].inner?.id, 4);
  });

  it('samples the centre and the inset corners', () => {
    const points = samplePoints({ x: 0, y: 0, width: 48, height: 48 });
    assert.deepEqual(points, [{ x: 24, y: 24 }, { x: 3, y: 3 }, { x: 45, y: 3 }, { x: 3, y: 45 }, { x: 45, y: 45 }]);
  });
});
