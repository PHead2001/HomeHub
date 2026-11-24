'use client';

import { useSyncExternalStore } from 'react';

/**
 * The width from which Home Assets and Vehicles show the detail as a sticky column beside
 * the cards (Tailwind's `lg`, 1024 px). Below it, a phone or a narrow window, tapping a
 * card opens the detail in a full-height sheet (MA-17). The tabs' CSS uses the same `lg:`
 * breakpoint, so the column and the sheet never both render.
 */
export const WIDE_LAYOUT_QUERY = '(min-width: 1024px)';

const subscribe = (onChange: () => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const list = window.matchMedia(WIDE_LAYOUT_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
};

const snapshot = () => (typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? true : window.matchMedia(WIDE_LAYOUT_QUERY).matches);

/** True at `lg` and wider (the detail column), false below (the detail sheet). */
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
