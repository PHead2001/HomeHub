/**
 * HomeHub color tokens: the single source of every color in the app.
 *
 * Each preset is a complete set of HSL channel tokens ("h s% l%"), emitted as CSS
 * custom properties by `themeCss()` (rendered in the root layout's <head>) and
 * consumed through Tailwind (`bg-card`, `text-primary`, `border-border`, ...).
 * Non-color tokens (radius, shadows, motion durations, focus ring) live in
 * `src/app/globals.css`.
 *
 * Every preset is contrast-checked by `tests/unit/theme-contrast.test.ts`:
 * text pairs ≥ 4.5:1 and UI boundaries (border, input, ring, filled controls) ≥ 3:1.
 * Foregrounds on filled colors are chosen per preset: bright accents in dark
 * presets carry dark text; deep accents in light presets carry white text.
 */

export const THEME_MODES = ['dark', 'light', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const DARK_PRESET_IDS = ['midnight', 'hearth', 'forest'] as const;
export const LIGHT_PRESET_IDS = ['light', 'sunrise'] as const;
export type DarkPresetId = (typeof DARK_PRESET_IDS)[number];
export type LightPresetId = (typeof LIGHT_PRESET_IDS)[number];
export type PresetId = DarkPresetId | LightPresetId;

export const DEFAULT_DARK_PRESET: DarkPresetId = 'midnight';
export const DEFAULT_LIGHT_PRESET: LightPresetId = 'light';

/** Number of per-member colors (`--member-1` … `--member-8`). */
export const MEMBER_COLOR_COUNT = 8;

export const COLOR_TOKEN_NAMES = [
  // Surfaces (elevation): base page → raised (cards) → overlay (dialogs, popovers, sheets).
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  // Brand accent for fills, links and selection.
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  // Subtle interactive hover/selected surface (not the brand color).
  'accent',
  'accent-foreground',
  // Status colors: usable as text on any surface and as fills with their foreground.
  'destructive',
  'destructive-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'info',
  'info-foreground',
  // Lines: `border` and `input` identify components (≥ 3:1); `border-subtle` is decorative.
  'border',
  'border-subtle',
  'input',
  'ring',
  // Effects.
  'scrim',
  'shadow',
  'highlight',
  'ambient-1',
  'ambient-2',
  // Charts.
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  // Per-member colors (text-safe on surfaces) and the text color for filled member chips.
  ...Array.from({ length: MEMBER_COLOR_COUNT }, (_, i) => `member-${i + 1}`),
  'member-foreground',
] as const;

export type ColorTokenName = (typeof COLOR_TOKEN_NAMES)[number];

export type ThemePreset = {
  id: PresetId;
  label: string;
  description: string;
  kind: 'dark' | 'light';
  colors: Record<ColorTokenName, string>;
  /** Opacity of the ambient aurora blobs (one intensity token per theme). */
  ambientIntensity: number;
  /** Opacity of the shadow color in elevation shadows. */
  shadowOpacity: number;
  /** Opacity of the 1px inner top highlight on raised/overlay surfaces. */
  highlightOpacity: number;
};

// Member hues shared by every preset; lightness is tuned per theme kind for AA.
const MEMBER_HUES = [172, 205, 238, 272, 322, 8, 36, 96] as const;

// Lightness per hue: blues/violets are darker at equal lightness, greens/ambers brighter.
const DARK_MEMBER_LIGHTNESS = [62, 70, 80, 80, 74, 74, 64, 58] as const;
const LIGHT_MEMBER_LIGHTNESS = [25, 32, 44, 42, 34, 36, 27, 23] as const;

const members = (sat: number, lightness: readonly number[]) =>
  Object.fromEntries(MEMBER_HUES.map((h, i) => [`member-${i + 1}`, `${h} ${sat}% ${lightness[i]}%`])) as Record<
    `member-${number}`,
    string
  >;
const darkMembers = () => members(72, DARK_MEMBER_LIGHTNESS);
const lightMembers = () => members(70, LIGHT_MEMBER_LIGHTNESS);

const DARK_CHARTS = {
  'chart-1': '220 70% 62%',
  'chart-2': '160 60% 50%',
  'chart-3': '30 80% 60%',
  'chart-4': '280 65% 68%',
  'chart-5': '340 75% 65%',
};

const LIGHT_CHARTS = {
  'chart-1': '12 76% 45%',
  'chart-2': '173 58% 32%',
  'chart-3': '197 37% 24%',
  'chart-4': '43 74% 40%',
  'chart-5': '27 87% 45%',
};

export const PRESETS: Record<PresetId, ThemePreset> = {
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    description: 'Deep navy with a teal accent. The HomeHub default.',
    kind: 'dark',
    ambientIntensity: 0.07,
    shadowOpacity: 0.55,
    highlightOpacity: 0.06,
    colors: {
      background: '224 64% 5%',
      foreground: '210 40% 98%',
      card: '223 44% 9%',
      'card-foreground': '210 40% 98%',
      popover: '222 38% 12.5%',
      'popover-foreground': '210 40% 98%',
      primary: '172 58% 52%',
      'primary-foreground': '224 64% 6%',
      secondary: '222 32% 18%',
      'secondary-foreground': '210 40% 98%',
      muted: '222 32% 15%',
      'muted-foreground': '215 25% 72%',
      accent: '196 34% 18%',
      'accent-foreground': '210 40% 98%',
      destructive: '0 84% 70%',
      'destructive-foreground': '224 64% 6%',
      success: '150 55% 55%',
      'success-foreground': '224 64% 6%',
      warning: '38 92% 62%',
      'warning-foreground': '224 64% 6%',
      info: '210 90% 70%',
      'info-foreground': '224 64% 6%',
      border: '218 20% 45%',
      'border-subtle': '222 30% 18%',
      input: '218 20% 45%',
      ring: '172 58% 52%',
      scrim: '224 64% 3%',
      shadow: '224 80% 2%',
      highlight: '210 40% 98%',
      'ambient-1': '172 70% 45%',
      'ambient-2': '240 70% 62%',
      ...DARK_CHARTS,
      ...darkMembers(),
      'member-foreground': '224 64% 6%',
    },
  },
  hearth: {
    id: 'hearth',
    label: 'Hearth',
    description: 'Warm charcoal with an ember accent.',
    kind: 'dark',
    ambientIntensity: 0.07,
    shadowOpacity: 0.55,
    highlightOpacity: 0.06,
    colors: {
      background: '20 16% 6%',
      foreground: '30 33% 95%',
      card: '20 14% 9.5%',
      'card-foreground': '30 33% 95%',
      popover: '20 12% 13%',
      'popover-foreground': '30 33% 95%',
      primary: '28 88% 62%',
      'primary-foreground': '20 30% 7%',
      secondary: '20 12% 18%',
      'secondary-foreground': '30 33% 95%',
      muted: '20 12% 15.5%',
      'muted-foreground': '30 16% 72%',
      accent: '24 22% 18%',
      'accent-foreground': '30 33% 95%',
      destructive: '0 84% 70%',
      'destructive-foreground': '20 30% 7%',
      success: '150 50% 55%',
      'success-foreground': '20 30% 7%',
      warning: '45 92% 60%',
      'warning-foreground': '20 30% 7%',
      info: '205 85% 70%',
      'info-foreground': '20 30% 7%',
      border: '24 10% 42%',
      'border-subtle': '20 12% 18%',
      input: '24 10% 42%',
      ring: '28 88% 62%',
      scrim: '20 20% 3%',
      shadow: '20 40% 2%',
      highlight: '30 60% 96%',
      'ambient-1': '24 90% 55%',
      'ambient-2': '340 70% 55%',
      ...DARK_CHARTS,
      ...darkMembers(),
      'member-foreground': '20 30% 7%',
    },
  },
  forest: {
    id: 'forest',
    label: 'Forest',
    description: 'Evergreen dark with a fresh green accent.',
    kind: 'dark',
    ambientIntensity: 0.07,
    shadowOpacity: 0.55,
    highlightOpacity: 0.06,
    colors: {
      background: '160 32% 5%',
      foreground: '140 25% 95%',
      card: '158 26% 8.5%',
      'card-foreground': '140 25% 95%',
      popover: '156 22% 12%',
      'popover-foreground': '140 25% 95%',
      primary: '146 52% 54%',
      'primary-foreground': '160 40% 5%',
      secondary: '156 20% 17%',
      'secondary-foreground': '140 25% 95%',
      muted: '156 20% 14.5%',
      'muted-foreground': '145 14% 72%',
      accent: '160 24% 17%',
      'accent-foreground': '140 25% 95%',
      destructive: '0 84% 70%',
      'destructive-foreground': '160 40% 5%',
      success: '146 52% 54%',
      'success-foreground': '160 40% 5%',
      warning: '42 90% 60%',
      'warning-foreground': '160 40% 5%',
      info: '200 80% 68%',
      'info-foreground': '160 40% 5%',
      border: '150 12% 40%',
      'border-subtle': '156 20% 17%',
      input: '150 12% 40%',
      ring: '146 52% 54%',
      scrim: '160 40% 2%',
      shadow: '160 60% 2%',
      highlight: '140 40% 96%',
      'ambient-1': '150 60% 42%',
      'ambient-2': '190 70% 45%',
      ...DARK_CHARTS,
      ...darkMembers(),
      'member-foreground': '160 40% 5%',
    },
  },
  light: {
    id: 'light',
    label: 'Light',
    description: 'Clean and bright with a deep teal accent.',
    kind: 'light',
    ambientIntensity: 0.05,
    shadowOpacity: 0.12,
    highlightOpacity: 0.7,
    colors: {
      background: '220 20% 96%',
      foreground: '222 47% 11%',
      card: '0 0% 100%',
      'card-foreground': '222 47% 11%',
      popover: '0 0% 100%',
      'popover-foreground': '222 47% 11%',
      primary: '174 74% 24%',
      'primary-foreground': '0 0% 100%',
      secondary: '220 16% 90%',
      'secondary-foreground': '222 47% 11%',
      muted: '220 16% 92%',
      'muted-foreground': '220 12% 36%',
      accent: '178 28% 90%',
      'accent-foreground': '222 47% 11%',
      destructive: '0 72% 42%',
      'destructive-foreground': '0 0% 100%',
      success: '152 70% 25%',
      'success-foreground': '0 0% 100%',
      warning: '28 90% 32%',
      'warning-foreground': '0 0% 100%',
      info: '212 80% 38%',
      'info-foreground': '0 0% 100%',
      border: '220 9% 55%',
      'border-subtle': '220 14% 87%',
      input: '220 9% 55%',
      ring: '174 74% 24%',
      scrim: '222 47% 11%',
      shadow: '222 47% 11%',
      highlight: '0 0% 100%',
      'ambient-1': '172 70% 45%',
      'ambient-2': '240 70% 62%',
      ...LIGHT_CHARTS,
      ...lightMembers(),
      'member-foreground': '0 0% 100%',
    },
  },
  sunrise: {
    id: 'sunrise',
    label: 'Sunrise',
    description: 'Warm cream with a terracotta accent.',
    kind: 'light',
    ambientIntensity: 0.05,
    shadowOpacity: 0.12,
    highlightOpacity: 0.7,
    colors: {
      background: '32 45% 95%',
      foreground: '20 30% 12%',
      card: '36 60% 99%',
      'card-foreground': '20 30% 12%',
      popover: '0 0% 100%',
      'popover-foreground': '20 30% 12%',
      primary: '12 68% 40%',
      'primary-foreground': '0 0% 100%',
      secondary: '30 30% 89%',
      'secondary-foreground': '20 30% 12%',
      muted: '30 30% 91%',
      'muted-foreground': '20 14% 36%',
      accent: '24 60% 91%',
      'accent-foreground': '20 30% 12%',
      destructive: '0 72% 40%',
      'destructive-foreground': '0 0% 100%',
      success: '152 70% 24%',
      'success-foreground': '0 0% 100%',
      warning: '28 90% 30%',
      'warning-foreground': '0 0% 100%',
      info: '212 80% 36%',
      'info-foreground': '0 0% 100%',
      border: '25 12% 52%',
      'border-subtle': '30 25% 86%',
      input: '25 12% 52%',
      ring: '12 68% 40%',
      scrim: '20 30% 12%',
      shadow: '20 40% 20%',
      highlight: '0 0% 100%',
      'ambient-1': '24 90% 60%',
      'ambient-2': '330 70% 65%',
      ...LIGHT_CHARTS,
      ...lightMembers(),
      'member-foreground': '0 0% 100%',
    },
  },
};

export const PRESET_LIST: ThemePreset[] = [...DARK_PRESET_IDS, ...LIGHT_PRESET_IDS].map((id) => PRESETS[id]);

export const isDarkPresetId = (value: unknown): value is DarkPresetId =>
  typeof value === 'string' && (DARK_PRESET_IDS as readonly string[]).includes(value);
export const isLightPresetId = (value: unknown): value is LightPresetId =>
  typeof value === 'string' && (LIGHT_PRESET_IDS as readonly string[]).includes(value);
export const isThemeMode = (value: unknown): value is ThemeMode =>
  typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);

function presetDeclarations(preset: ThemePreset): string {
  const colors = COLOR_TOKEN_NAMES.map((name) => `--${name}:${preset.colors[name]};`).join('');
  return `${colors}--ambient-intensity:${preset.ambientIntensity};--shadow-opacity:${preset.shadowOpacity};--highlight-opacity:${preset.highlightOpacity};color-scheme:${preset.kind};`;
}

/**
 * CSS for every preset, keyed by `<html data-theme="…">`. Midnight is also the
 * `:root` fallback so the page is styled even before the theme script runs.
 */
export function themeCss(): string {
  return PRESET_LIST.map((preset) => {
    const selector =
      preset.id === DEFAULT_DARK_PRESET ? `:root,:root[data-theme="${preset.id}"]` : `:root[data-theme="${preset.id}"]`;
    return `${selector}{${presetDeclarations(preset)}}`;
  }).join('\n');
}
