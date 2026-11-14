'use client';

import { useSyncExternalStore } from 'react';
import { createMinuteClock, type MinuteClock } from '@/lib/pets/minute-clock';

let clock: MinuteClock | null = null;

function sharedClock(): MinuteClock {
  clock ??= createMinuteClock({
    now: () => new Date(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    window: typeof window === 'undefined' ? undefined : window,
    document: typeof document === 'undefined' ? undefined : document,
  });
  return clock;
}

const subscribe = (listener: () => void) => sharedClock().subscribe(listener);
const snapshot = () => sharedClock().now();

/**
 * The current time, refreshed on each minute boundary by one clock shared by
 * every Pets consumer (PE-21c, instead of an interval per card), so "2 h ago"
 * and the household "today" stay right and roll over at household midnight
 * without a reload (PE-7d).
 */
export function useNow(): Date {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
