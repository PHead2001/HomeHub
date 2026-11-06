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
};

/**
 * The shape stored in the existing `users/{email}.theme` profile field. Sound and
 * haptics stay device-local (a phone and a laptop differ), so they are not synced.
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
 * Inline script for <head>. Runs before first paint and before hydration: reads the
 * stored preferences and sets `data-theme`, the `dark`/`light` class and
 * `data-motion="reduce"` on <html> so there is never a flash of the wrong theme.
 * Keep it dependency-free; it must never throw.
 */
export function themeBootstrapScript(): string {
  const kinds = Object.fromEntries(PRESET_LIST.map((preset) => [preset.id, preset.kind]));
  return `(function(){try{var d=document.documentElement,p={};try{p=JSON.parse(localStorage.getItem(${JSON.stringify(
    APPEARANCE_STORAGE_KEY,
  )})||"{}")||{}}catch(e){}var k=${JSON.stringify(kinds)},c=${JSON.stringify(THEME_COLORS)};var dk=k[p.darkPreset]==="dark"?p.darkPreset:${JSON.stringify(
    DEFAULT_DARK_PRESET,
  )};var lt=k[p.lightPreset]==="light"?p.lightPreset:${JSON.stringify(
    DEFAULT_LIGHT_PRESET,
  )};var m=p.mode==="light"||p.mode==="system"?p.mode:"dark";var mq=function(q){return window.matchMedia&&window.matchMedia(q).matches};var id=(m==="dark"||(m==="system"&&mq("(prefers-color-scheme: dark)")))?dk:lt;d.setAttribute("data-theme",id);d.classList.remove(k[id]==="dark"?"light":"dark");d.classList.add(k[id]);if(p.reduceMotion===true||mq("(prefers-reduced-motion: reduce)")){d.setAttribute("data-motion","reduce")}else{d.removeAttribute("data-motion")}var t=document.querySelector('meta[name="theme-color"]');if(t)t.setAttribute("content",c[id])}catch(e){}})();`;
}
