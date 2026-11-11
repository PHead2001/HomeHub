'use client';

import { useEffect } from 'react';
import { WAKE_LOCK_MEDIA, watchTripWakeLock, type WakeLockApi } from '@/lib/shopping/wake-lock';

/**
 * Keeps the screen on while `listOpen` on a personal phone (SH-33a): requested
 * when the list opens, whenever the page becomes visible again and whenever the
 * screen starts matching the phone query (turned to portrait); released when the
 * list closes, the page is hidden, the screen stops matching or the component
 * unmounts. Feature-detected (`navigator.wakeLock`); never on wide screens such as
 * the wall tablet.
 */
export function useTripWakeLock(listOpen: boolean) {
  useEffect(() => {
    if (!listOpen || typeof navigator === 'undefined') return;
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!api || typeof api.request !== 'function') return;
    const phone = typeof window.matchMedia === 'function' ? window.matchMedia(WAKE_LOCK_MEDIA) : null;
    return watchTripWakeLock({ api, page: document, phone });
  }, [listOpen]);
}
