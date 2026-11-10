import { hslTokenToHex } from './contrast';
import {
  DEFAULT_DARK_PRESET,
  DEFAULT_LIGHT_PRESET,
  PRESETS,
  PRESET_LIST,
  isDarkPresetId,
  isLightPresetId,
  isThemeMode,
  type DarkPresetId,
  type LightPresetId,
  type PresetId,
  type ThemeMode,
} from './tokens';

/**
 * Per-device text size (D-4 / PR-14): exactly three steps, applied to <html> as a
 * percentage font size before first paint. Device-local like sound and haptics (a
 * wall tablet and a phone differ), so it is never written to the profile.
 */
export const TEXT_SCALES = [100, 115, 130] as const;
export type TextScale = (typeof TEXT_SCALES)[number];
export const DEFAULT_TEXT_SCALE: TextScale = 100;

/**
 * Accepts anything (a stored number, a numeric string) and returns a valid step:
 * out-of-range values clamp to 100-130 and in-between values snap to the nearest
 * step (a tie goes to the smaller one). Anything non-numeric gives `fallback`.
 * Mirrored by the pre-paint script; tests keep the two in step.
 */
export function parseTextScale(value: unknown, fallback: TextScale = DEFAULT_TEXT_SCALE): TextScale {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.min(TEXT_SCALES[TEXT_SCALES.length - 1], Math.max(TEXT_SCALES[0], numeric));
  let best: TextScale = TEXT_SCALES[0];
  for (const step of TEXT_SCALES) {
    if (Math.abs(step - clamped) < Math.abs(best - clamped)) best = step;
  }
  return best;
}

/** Sets `data-text-scale` on <html> (absent at 100%); globals.css maps it to a font size. */
export function applyTextScaleToDocument(scale: TextScale, root: HTMLElement = document.documentElement) {
  if (scale === DEFAULT_TEXT_SCALE) root.removeAttribute('data-text-scale');
  else root.setAttribute('data-text-scale', String(scale));
}

/** Appearance preferences (Profile → Appearance). */
export type AppearancePreferences = {
  mode: ThemeMode;
  darkPreset: DarkPresetId;
  lightPreset: LightPresetId;
  /** In-app "Reduce motion"; combined with the system setting. */
  reduceMotion: boolean;
  /** Opt-in feedback sounds (device-local). */
  sound: boolean;
  /** Opt-in haptics (device-local). */
  haptics: boolean;
  /** Text size step in percent (device-local). */
  textScale: TextScale;
};

/**
 * The shape stored in the existing `users/{email}.theme` profile field. Sound,
 * haptics and text size stay device-local (a phone and a laptop differ), so they
 * are not synced.
 */
export type ProfileAppearance = {
  version: 2;
  mode: ThemeMode;
  darkPreset: DarkPresetId;
  lightPreset: LightPresetId;
  reduceMotion: boolean;
};

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  mode: 'dark',
  darkPreset: DEFAULT_DARK_PRESET,
  lightPreset: DEFAULT_LIGHT_PRESET,
  reduceMotion: false,
  sound: false,
  haptics: false,
  textScale: DEFAULT_TEXT_SCALE,
};

/** localStorage key read by the pre-paint script and the AppearanceProvider. */
export const APPEARANCE_STORAGE_KEY = 'homehub.appearance';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Accepts anything (stored JSON, a profile field) and returns valid preferences. */
export function parseAppearance(value: unknown, base: AppearancePreferences = DEFAULT_APPEARANCE): AppearancePreferences {
  if (!isRecord(value)) return { ...base };
  return {
    mode: isThemeMode(value.mode) ? value.mode : base.mode,
    darkPreset: isDarkPresetId(value.darkPreset) ? value.darkPreset : base.darkPreset,
    lightPreset: isLightPresetId(value.lightPreset) ? value.lightPreset : base.lightPreset,
    reduceMotion: typeof value.reduceMotion === 'boolean' ? value.reduceMotion : base.reduceMotion,
    sound: typeof value.sound === 'boolean' ? value.sound : base.sound,
    haptics: typeof value.haptics === 'boolean' ? value.haptics : base.haptics,
    textScale: parseTextScale(value.textScale, base.textScale),
  };
}

/**
 * Reads the synced part of a profile `theme` field. Legacy free-color themes
 * (`{ background, accent, backgroundHex, accentHex }`) are ignored: they are
 * replaced by curated presets.
 */
export function appearanceFromProfile(theme: unknown): Partial<AppearancePreferences> | null {
  if (!isRecord(theme) || theme.version !== 2) return null;
  const parsed = parseAppearance(theme);
  return {
    mode: parsed.mode,
    darkPreset: parsed.darkPreset,
    lightPreset: parsed.lightPreset,
    reduceMotion: parsed.reduceMotion,
  };
}

export function profileAppearance(prefs: AppearancePreferences): ProfileAppearance {
  return {
    version: 2,
    mode: prefs.mode,
    darkPreset: prefs.darkPreset,
    lightPreset: prefs.lightPreset,
    reduceMotion: prefs.reduceMotion,
  };
}

export function resolvePresetId(prefs: Pick<AppearancePreferences, 'mode' | 'darkPreset' | 'lightPreset'>, systemPrefersDark: boolean): PresetId {
  const dark = prefs.mode === 'dark' || (prefs.mode === 'system' && systemPrefersDark);
  return dark ? prefs.darkPreset : prefs.lightPreset;
}

/** Browser-chrome color per preset (the page background). */
export const THEME_COLORS: Record<PresetId, string> = Object.fromEntries(
  PRESET_LIST.map((preset) => [preset.id, hslTokenToHex(preset.colors.background)]),
) as Record<PresetId, string>;

/** Applies a preset to <html>: `data-theme`, the `dark`/`light` class and the theme-color meta. */
export function applyPresetToDocument(id: PresetId, root: HTMLElement = document.documentElement) {
  const kind = PRESETS[id].kind;
  root.setAttribute('data-theme', id);
  root.classList.remove(kind === 'dark' ? 'light' : 'dark');
  root.classList.add(kind);
  const meta = root.ownerDocument.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[id]);
}

/**
 * JSON for embedding in an inline <script>. `JSON.stringify` alone leaves `<`
 * (so a value containing `</script>` could close the tag) and U+2028/U+2029
 * (line terminators in older JavaScript) unescaped; escaping them keeps every
 * embedded value inert, whatever it contains.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

export function scriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .split(LINE_SEPARATOR).join('\\u2028')
    .split(PARAGRAPH_SEPARATOR).join('\\u2029');
}

/**
 * Inline script for <head>. Runs before first paint and before hydration: reads the
 * stored preferences and sets `data-theme`, the `dark`/`light` class,
 * `data-motion="reduce"` and `data-text-scale` on <html> so there is never a flash
 * of the wrong theme or text size.
 * Keep it dependency-free; it must never throw.
 */

export function themeBootstrapScript(): string {
  const kinds = Object.fromEntries(PRESET_LIST.map((preset) => [preset.id, preset.kind]));
  return `(function(){try{var d=document.documentElement,p={};try{p=JSON.parse(localStorage.getItem(${scriptLiteral(
    APPEARANCE_STORAGE_KEY,
  )})||"{}")||{}}catch(e){}var k=${scriptLiteral(kinds)},c=${scriptLiteral(THEME_COLORS)};var dk=k[p.darkPreset]==="dark"?p.darkPreset:${scriptLiteral(
    DEFAULT_DARK_PRESET,
  )};var lt=k[p.lightPreset]==="light"?p.lightPreset:${scriptLiteral(
    DEFAULT_LIGHT_PRESET,
  )};var m=p.mode==="light"||p.mode==="system"?p.mode:"dark";var mq=function(q){return window.matchMedia&&window.matchMedia(q).matches};var id=(m==="dark"||(m==="system"&&mq("(prefers-color-scheme: dark)")))?dk:lt;d.setAttribute("data-theme",id);d.classList.remove(k[id]==="dark"?"light":"dark");d.classList.add(k[id]);if(p.reduceMotion===true||mq("(prefers-reduced-motion: reduce)")){d.setAttribute("data-motion","reduce")}else{d.removeAttribute("data-motion")}var t=document.querySelector('meta[name="theme-color"]');if(t)t.setAttribute("content",c[id]);var S=${scriptLiteral(
    TEXT_SCALES,
  )},v=p.textScale,n=typeof v==="number"?v:(typeof v==="string"&&v.trim()!==""?Number(v):NaN),ts=${scriptLiteral(
    DEFAULT_TEXT_SCALE,
  )};if(isFinite(n)){n=Math.min(S[S.length-1],Math.max(S[0],n));ts=S[0];for(var i=0;i<S.length;i++){if(Math.abs(S[i]-n)<Math.abs(ts-n))ts=S[i]}}if(ts===${scriptLiteral(
    DEFAULT_TEXT_SCALE,
  )}){d.removeAttribute("data-text-scale")}else{d.setAttribute("data-text-scale",String(ts))}}catch(e){}})();`;
}
