'use client';

import { useEffect, useRef } from 'react';

/** How long the calendar waits without input before it shows Today again (CA-12; WT-4's default idle time). */
export const IDLE_RETURN_MS = 2 * 60 * 1000;

/**
 * Calls `onIdle` once after `ms` without a pointer, key, wheel or touch on the page
 * (audit CA-12: a swipe by one child leaves a shared screen on another week). The
 * caller decides whether returning is safe (no open panel or Undo). Registered wall
 * tablets have their own idle return to their start page (WT-14).
 */
export function useIdleReturn(enabled: boolean, onIdle: () => void, ms = IDLE_RETURN_MS): void {
  const latest = useRef(onIdle);
  useEffect(() => { latest.current = onIdle; }, [onIdle]);
  useEffect(() => {
    if (!enabled) return;
    let timer = window.setTimeout(() => latest.current(), ms);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => latest.current(), ms);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach(name => window.addEventListener(name, reset, { passive: true, capture: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach(name => window.removeEventListener(name, reset, { capture: true }));
    };
  }, [enabled, ms]);
}
