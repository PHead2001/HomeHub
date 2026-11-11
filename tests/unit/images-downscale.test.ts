import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_MAX_EDGE,
  PRODUCT_PHOTO_MAX_BYTES,
  QUALITY_STEPS,
  downscaleErrorCopy,
  fitsLimit,
  outputType,
  planDownscale,
  qualitySteps,
  targetSize,
} from '../../src/lib/images/downscale';

const MB = 1024 * 1024;

describe('image downscale decisions (BL-11)', () => {
  test('the longer edge becomes at most 1024 px and the ratio is kept', () => {
    assert.deepEqual(targetSize(4032, 3024), { width: 1024, height: 768, scaled: true });
    assert.deepEqual(targetSize(3024, 4032), { width: 768, height: 1024, scaled: true });
    assert.deepEqual(targetSize(3000, 3000), { width: 1024, height: 1024, scaled: true });
    // A panorama never collapses below 1 px.
    assert.deepEqual(targetSize(100000, 10), { width: 1024, height: 1, scaled: true });
  });

  test('small photos are never enlarged; bad sizes are not drawn', () => {
    assert.deepEqual(targetSize(800, 600), { width: 800, height: 600, scaled: false });
    assert.deepEqual(targetSize(DEFAULT_MAX_EDGE, 10), { width: DEFAULT_MAX_EDGE, height: 10, scaled: false });
    assert.deepEqual(targetSize(0, 600), { width: 0, height: 0, scaled: false });
    assert.deepEqual(targetSize(Number.NaN, 600), { width: 0, height: 0, scaled: false });
  });

  test('a custom edge (e.g. a profile photo) is honoured', () => {
    assert.deepEqual(targetSize(2000, 1000, 512), { width: 512, height: 256, scaled: true });
  });

  test('output format: PNG and WebP keep theirs, everything else is JPEG', () => {
    assert.equal(outputType('image/png'), 'image/png');
    assert.equal(outputType('image/webp'), 'image/webp');
    assert.equal(outputType('image/jpeg'), 'image/jpeg');
    assert.equal(outputType('image/heic'), 'image/jpeg');
    assert.equal(outputType('image/gif'), 'image/jpeg');
    assert.equal(outputType(''), 'image/jpeg');
    assert.deepEqual(qualitySteps('image/png'), [1]);
    assert.deepEqual(qualitySteps('image/jpeg'), QUALITY_STEPS);
    assert.ok(QUALITY_STEPS.every((quality, index) => index === 0 || quality < QUALITY_STEPS[index - 1]));
  });

  test('a phone photo is redrawn at 1024 px', () => {
    assert.deepEqual(planDownscale({ width: 4032, height: 3024, type: 'image/jpeg', bytes: 9 * MB }), {
      action: 'redraw', width: 1024, height: 768, type: 'image/jpeg', qualities: QUALITY_STEPS,
    });
    // Large in pixels but small in bytes is still shrunk (tiles never need more).
    assert.equal(planDownscale({ width: 4032, height: 3024, type: 'image/jpeg', bytes: 2 * MB }).action, 'redraw');
  });

  test('a photo already small enough is kept untouched', () => {
    assert.deepEqual(planDownscale({ width: 900, height: 900, type: 'image/jpeg', bytes: 300_000 }), { action: 'keep' });
    // A large GIF that fits is kept, so its animation survives.
    assert.deepEqual(planDownscale({ width: 2000, height: 2000, type: 'image/gif', bytes: 2 * MB }), { action: 'keep' });
  });

  test('a small-pixel photo over the byte limit is re-encoded at its size', () => {
    assert.deepEqual(planDownscale({ width: 1000, height: 800, type: 'image/png', bytes: 6 * MB }), {
      action: 'redraw', width: 1000, height: 800, type: 'image/png', qualities: [1],
    });
  });

  test('the byte limit is 5 MB for product photos', () => {
    assert.equal(PRODUCT_PHOTO_MAX_BYTES, 5 * MB);
    assert.equal(fitsLimit(5 * MB), true);
    assert.equal(fitsLimit(5 * MB + 1), false);
    assert.equal(fitsLimit(0), false);
    assert.equal(fitsLimit(2 * MB, 1 * MB), false);
  });

  test('inline copy names the limit', () => {
    assert.match(downscaleErrorCopy('too-large'), /still larger than 5 MB/);
    assert.match(downscaleErrorCopy('unreadable'), /could not be read and is larger than 5 MB/);
  });
});
