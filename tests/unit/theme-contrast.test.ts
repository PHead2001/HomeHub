import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blend, contrastRatio, hslTokenToRgb, tokenContrast } from '../../src/lib/theme/contrast';
import {
  COLOR_TOKEN_NAMES,
  MEMBER_COLOR_COUNT,
  PRESET_LIST,
  type ColorTokenName,
  type ThemePreset,
} from '../../src/lib/theme/tokens';

const TEXT_MIN = 4.5;
const UI_MIN = 3;

const SURFACES: ColorTokenName[] = ['background', 'card', 'popover'];
const members = Array.from({ length: MEMBER_COLOR_COUNT }, (_, i) => `member-${i + 1}` as ColorTokenName);

// [foreground, background] pairs that carry text.
const textPairs: Array<[ColorTokenName, ColorTokenName]> = [
  ...SURFACES.map((s) => ['foreground', s] as [ColorTokenName, ColorTokenName]),
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ...[...SURFACES, 'muted', 'secondary'].map(
    (s) => ['muted-foreground', s as ColorTokenName] as [ColorTokenName, ColorTokenName],
  ),
  ['foreground', 'muted'],
  ['foreground', 'accent'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['destructive-foreground', 'destructive'],
  ['success-foreground', 'success'],
  ['warning-foreground', 'warning'],
  ['info-foreground', 'info'],
  // Accent and status colors used as text (links, `text-primary`, error messages).
  ...(['primary', 'destructive', 'success', 'warning', 'info'] as ColorTokenName[]).flatMap((c) =>
    [...SURFACES, 'muted' as ColorTokenName].map((s) => [c, s] as [ColorTokenName, ColorTokenName]),
  ),
  // Member colors as text/rings on surfaces, and as chip fills.
  ...members.flatMap((m) => SURFACES.map((s) => [m, s] as [ColorTokenName, ColorTokenName])),
  ...members.map((m) => ['member-foreground', m] as [ColorTokenName, ColorTokenName]),
];

// Non-text UI boundaries.
const uiPairs: Array<[ColorTokenName, ColorTokenName]> = [
  ...(['border', 'input', 'ring', 'primary'] as ColorTokenName[]).flatMap((c) =>
    SURFACES.map((s) => [c, s] as [ColorTokenName, ColorTokenName]),
  ),
];

// Tinted surfaces built from a token at low alpha over a surface, with the token as text.
const tintPairs: Array<{ text: ColorTokenName; tint: ColorTokenName; alpha: number }> = [
  { text: 'primary', tint: 'primary', alpha: 0.1 },
  { text: 'destructive', tint: 'destructive', alpha: 0.1 },
  { text: 'success', tint: 'success', alpha: 0.1 },
  { text: 'warning', tint: 'warning', alpha: 0.1 },
  ...members.map((m) => ({ text: m, tint: m, alpha: 0.15 })),
];

function check(preset: ThemePreset) {
  const failures: string[] = [];
  for (const [fg, bg] of textPairs) {
    const ratio = tokenContrast(preset.colors[fg], preset.colors[bg]);
    if (ratio < TEXT_MIN) failures.push(`text ${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
  }
  for (const [fg, bg] of uiPairs) {
    const ratio = tokenContrast(preset.colors[fg], preset.colors[bg]);
    if (ratio < UI_MIN) failures.push(`ui ${fg} against ${bg}: ${ratio.toFixed(2)}:1`);
  }
  for (const { text, tint, alpha } of tintPairs) {
    for (const surface of SURFACES) {
      const bg = blend(hslTokenToRgb(preset.colors[tint]), hslTokenToRgb(preset.colors[surface]), alpha);
      const ratio = contrastRatio(hslTokenToRgb(preset.colors[text]), bg);
      if (ratio < TEXT_MIN) failures.push(`text ${text} on ${tint}/${alpha * 100} over ${surface}: ${ratio.toFixed(2)}:1`);
    }
  }
  return failures;
}

describe('theme presets meet WCAG AA', () => {
  for (const preset of PRESET_LIST) {
    it(`${preset.label} (${preset.kind})`, () => {
      for (const name of COLOR_TOKEN_NAMES) {
        assert.ok(preset.colors[name], `${preset.id} is missing --${name}`);
        hslTokenToRgb(preset.colors[name]);
      }
      assert.deepEqual(check(preset), []);
    });
  }

  it('raises each elevation level above the last in dark presets', () => {
    for (const preset of PRESET_LIST.filter((p) => p.kind === 'dark')) {
      const lum = (t: ColorTokenName) => contrastRatio(hslTokenToRgb(preset.colors[t]), [0, 0, 0]);
      assert.ok(lum('card') > lum('background'), `${preset.id}: card must be lighter than background`);
      assert.ok(lum('popover') > lum('card'), `${preset.id}: popover must be lighter than card`);
    }
  });

  it('keeps the D01 regression fixed: filled accent buttons are AA', () => {
    for (const preset of PRESET_LIST) {
      assert.ok(tokenContrast(preset.colors['primary-foreground'], preset.colors.primary) >= TEXT_MIN, preset.id);
    }
  });
});
