'use client';

import { useEffect } from 'react';
import { createWakeLockController, wakeLockWanted, WAKE_LOCK_MEDIA, type WakeLockApi } from '@/lib/shopping/wake-lock';

/**
 * Keeps the screen on while `listOpen` on a personal phone (SH-33a): requested
 * when the list opens and whenever the page becomes visible again, released when
 * the list closes, the page is hidden or the component unmounts. Feature-detected
 * (`navigator.wakeLock`); does nothing on wide screens such as the wall tablet.
 */
export function useTripWakeLock(listOpen: boolean) {
  useEffect(() => {
    if (!listOpen || typeof navigator === 'undefined') return;
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!api || typeof api.request !== 'function') return;
    const controller = createWakeLockController(api);
    const phone = () => typeof window.matchMedia === 'function' && window.matchMedia(WAKE_LOCK_MEDIA).matches;
    const update = () => controller.set(wakeLockWanted({
      listOpen: true,
      visible: document.visibilityState === 'visible',
      phone: phone(),
      supported: true,
    }));
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      controller.dispose();
    };
  }, [listOpen]);
}
