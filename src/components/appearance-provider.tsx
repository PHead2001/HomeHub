'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { useAuth } from '@/hooks/use-auth';
import { configureFeedback } from '@/lib/feedback';
import { DURATION } from '@/lib/motion';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  appearanceFromProfile,
  applyPresetToDocument,
  parseAppearance,
  profileAppearance,
  resolvePresetId,
  type AppearancePreferences,
} from '@/lib/theme/appearance';
import type { PresetId } from '@/lib/theme/tokens';

type RevealOrigin = { x: number; y: number } | HTMLElement | null | undefined;

type AppearanceContextValue = {
  preferences: AppearancePreferences;
  /** The preset currently applied (after resolving System mode). */
  activePreset: PresetId;
  /** System `prefers-reduced-motion` OR the in-app switch. */
  reducedMotion: boolean;
  systemReducedMotion: boolean;
  /**
   * Updates preferences, applies them and persists them (localStorage and, for
   * signed-in members, the profile `theme` field). Theme changes reveal in an
   * expanding circle from `origin` where View Transitions are supported and
   * motion is allowed; otherwise they switch instantly.
   */
  setPreferences: (patch: Partial<AppearancePreferences>, origin?: RevealOrigin) => void;
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

const SYNCED_KEYS = ['mode', 'darkPreset', 'lightPreset', 'reduceMotion'] as const;

/* ---------------------------------------------------------------------------
 * Preference store: localStorage-backed, shared by every tab via `storage`.
 * ------------------------------------------------------------------------- */

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedPrefs: AppearancePreferences = DEFAULT_APPEARANCE;
let memoryFallback: AppearancePreferences | null = null;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getStoredPreferences(): AppearancePreferences {
  if (memoryFallback) return memoryFallback;
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cachedPrefs = parseAppearance(JSON.parse(raw || '{}'));
    } catch {
      cachedPrefs = { ...DEFAULT_APPEARANCE };
    }
  }
  return cachedPrefs;
}

function storePreferences(prefs: AppearancePreferences) {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(prefs));
    memoryFallback = null;
  } catch {
    // Private mode or blocked storage: preferences still apply for this session.
    memoryFallback = prefs;
  }
  listeners.forEach((listener) => listener());
}

function subscribeStore(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

const getServerPreferences = () => DEFAULT_APPEARANCE;

function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

const noopSubscribe = () => () => undefined;
/** False during server render and hydration, true afterwards. */
const useHydrated = () => useSyncExternalStore(noopSubscribe, () => true, () => false);

/* ---------------------------------------------------------------------------
 * Circular reveal
 * ------------------------------------------------------------------------- */

function originPoint(origin: RevealOrigin): { x: number; y: number } {
  if (origin && 'getBoundingClientRect' in origin) {
    const rect = origin.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  if (origin) return origin;
  return { x: window.innerWidth / 2, y: 0 };
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

/** Applies a preset with the circular reveal when possible, otherwise instantly. */
function revealPreset(id: PresetId, origin: RevealOrigin, allowMotion: boolean) {
  const doc = document as ViewTransitionDocument;
  if (document.documentElement.getAttribute('data-theme') === id) return;
  if (!allowMotion || typeof doc.startViewTransition !== 'function') {
    applyPresetToDocument(id);
    return;
  }
  const { x, y } = originPoint(origin);
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  try {
    const transition = doc.startViewTransition(() => applyPresetToDocument(id));
    transition.ready
      .then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: DURATION.theme * 1000, easing: 'cubic-bezier(0.2, 0, 0, 1)', pseudoElement: '::view-transition-new(root)' },
        );
      })
      .catch(() => undefined);
  } catch {
    applyPresetToDocument(id);
  }
}

/* ---------------------------------------------------------------------------
 * Provider
 * ------------------------------------------------------------------------- */

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { currentUser, updateUser } = useAuth();
  const hydrated = useHydrated();
  const preferences = useSyncExternalStore(subscribeStore, getStoredPreferences, getServerPreferences);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const systemReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const activePreset = resolvePresetId(preferences, systemDark);
  const reducedMotion = preferences.reduceMotion || systemReducedMotion;

  // A signed-in member's synced profile preferences win over this device's copy
  // (once per sign-in; later changes on this device are written back to the profile).
  const syncedProfileFor = useRef<string | null>(null);
  useEffect(() => {
    if (!currentUser?.email) {
      syncedProfileFor.current = null;
      return;
    }
    if (syncedProfileFor.current === currentUser.email) return;
    syncedProfileFor.current = currentUser.email;
    const fromProfile = appearanceFromProfile(currentUser.theme);
    if (fromProfile) storePreferences({ ...getStoredPreferences(), ...fromProfile });
  }, [currentUser?.email, currentUser?.theme]);

  // Keep <html> in sync after hydration (the pre-paint script handled first paint):
  // System mode following the OS, profile sync, and changes from other tabs.
  useEffect(() => {
    if (hydrated && document.documentElement.getAttribute('data-theme') !== activePreset) {
      applyPresetToDocument(activePreset);
    }
  }, [activePreset, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const root = document.documentElement;
    if (reducedMotion) root.setAttribute('data-motion', 'reduce');
    else root.removeAttribute('data-motion');
  }, [reducedMotion, hydrated]);

  useEffect(() => {
    configureFeedback({ sound: preferences.sound, haptics: preferences.haptics });
  }, [preferences.sound, preferences.haptics]);

  // Ambient effects pause while the tab is hidden.
  useEffect(() => {
    const root = document.documentElement;
    const update = () => root.setAttribute('data-visibility', document.hidden ? 'hidden' : 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const setPreferences = useCallback(
    (patch: Partial<AppearancePreferences>, origin?: RevealOrigin) => {
      const previous = getStoredPreferences();
      const next = parseAppearance({ ...previous, ...patch });
      const allowMotion = !(next.reduceMotion || systemReducedMotion);
      revealPreset(resolvePresetId(next, systemDark), origin, allowMotion);
      storePreferences(next);

      const syncedChanged = SYNCED_KEYS.some((key) => previous[key] !== next[key]);
      if (syncedChanged && currentUser?.email) {
        void updateUser({ theme: profileAppearance(next) }, undefined, { silent: true });
      }
    },
    [currentUser?.email, systemDark, systemReducedMotion, updateUser],
  );

  const value = useMemo<AppearanceContextValue>(
    () => ({ preferences, activePreset, reducedMotion, systemReducedMotion, setPreferences }),
    [preferences, activePreset, reducedMotion, systemReducedMotion, setPreferences],
  );

  return (
    <AppearanceContext.Provider value={value}>
      <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'} transition={reducedMotion ? { duration: 0 } : undefined}>
        {children}
      </MotionConfig>
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error('useAppearance must be used inside AppearanceProvider');
  return context;
}

/** Nullable variant for components that may render outside the provider. */
export function useOptionalAppearance(): AppearanceContextValue | null {
  return useContext(AppearanceContext);
}
