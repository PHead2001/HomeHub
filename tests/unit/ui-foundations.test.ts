import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  TEXT_SCALES,
  appearanceFromProfile,
  parseAppearance,
  parseTextScale,
  profileAppearance,
  themeBootstrapScript,
} from '../../src/lib/theme/appearance';
import { fittingLinkCount } from '../../src/lib/navigation';

/** Runs the pre-paint script with `raw` as the stored localStorage value; returns <html>'s data-text-scale. */
function bootstrapTextScale(raw: string | null): string | undefined {
  const attrs = new Map<string, string>();
  const document = {
    documentElement: {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
      classList: { add: () => undefined, remove: () => undefined },
    },
    querySelector: () => null,
  };
  const localStorage = { getItem: (key: string) => (key === APPEARANCE_STORAGE_KEY ? raw : null) };
  const window = { matchMedia: () => ({ matches: false }) };
  new Function('document', 'localStorage', 'window', themeBootstrapScript())(document, localStorage, window);
  return attrs.get('data-text-scale');
}

const expectedAttr = (value: unknown) => {
  const scale = parseTextScale(value);
  return scale === 100 ? undefined : String(scale);
};

describe('text size (D-4)', () => {
  it('has exactly the three steps and defaults to 100%', () => {
    assert.deepEqual([...TEXT_SCALES], [100, 115, 130]);
    assert.equal(DEFAULT_APPEARANCE.textScale, 100);
  });

  const cases: Array<[unknown, number]> = [
    [100, 100],
    [115, 115],
    [130, 130],
    ['115', 115],
    [' 130 ', 130],
    [50, 100],
    [0, 100],
    [-20, 100],
    [400, 130],
    [Number.POSITIVE_INFINITY, 100],
    [107, 100],
    [108, 115],
    [107.5, 100],
    [110, 115],
    [123, 130],
    [122.5, 115],
    [Number.NaN, 100],
    ['', 100],
    ['large', 100],
    [null, 100],
    [undefined, 100],
    [true, 100],
    [{}, 100],
  ];

  for (const [value, expected] of cases) {
    it(`parses ${String(typeof value === 'string' ? JSON.stringify(value) : value)} as ${expected}`, () => {
      assert.equal(parseTextScale(value), expected);
    });
  }

  it('falls back to the given step for non-numeric values only', () => {
    assert.equal(parseTextScale('big', 130), 130);
    assert.equal(parseTextScale(90, 130), 100);
  });

  it('stays on the device: never part of the synced profile shape', () => {
    const prefs = parseAppearance({ textScale: 130 });
    assert.equal(prefs.textScale, 130);
    assert.equal('textScale' in profileAppearance(prefs), false);
    assert.equal('textScale' in (appearanceFromProfile({ version: 2, textScale: 115 }) ?? {}), false);
  });

  it('the pre-paint script applies the same step as parseTextScale', () => {
    for (const [value] of cases) {
      if (typeof value === 'number' && !Number.isFinite(value)) continue; // JSON cannot store these
      const raw = JSON.stringify({ textScale: value });
      assert.equal(bootstrapTextScale(raw), expectedAttr(JSON.parse(raw).textScale), raw);
    }
  });

  it('the pre-paint script leaves the default size for missing or broken storage', () => {
    for (const raw of [null, '', '{', 'null', '"text"', '[]', '{"textScale":{"a":1}}']) {
      assert.equal(bootstrapTextScale(raw), undefined, String(raw));
    }
  });
});

describe('header links that fit (SL-7)', () => {
  const widths = [90, 60, 120, 70, 90, 110];
  const total = widths.reduce((a, b) => a + b, 0) + 5 * 4;

  it('shows every link when they fit without the More menu', () => {
    assert.equal(fittingLinkCount(widths, total, 80, 4), widths.length);
  });

  it('keeps the leading links that fit next to More', () => {
    // 90 + 4 + 60 + 4 + More 80 = 238; the third link would need 362.
    assert.equal(fittingLinkCount(widths, 238, 80, 4), 2);
    assert.equal(fittingLinkCount(widths, 237, 80, 4), 1);
    assert.equal(fittingLinkCount(widths, total - 1, 80, 4), 5);
  });

  it('puts everything in More when nothing else fits, and handles no links', () => {
    assert.equal(fittingLinkCount(widths, 100, 80, 4), 0);
    assert.equal(fittingLinkCount(widths, 0, 80, 4), 0);
    assert.equal(fittingLinkCount([], 0, 80, 4), 0);
  });
});
