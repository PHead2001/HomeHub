'use client';

import { useSyncExternalStore } from 'react';

/**
 * True on touch-first devices (`pointer: coarse`). One media query listener for
 * the whole page, shared by every subscriber (SH-27c: no per-row listener).
 */
const listeners = new Set<() => void>();
let query: MediaQueryList | null = null;

const onChange = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  listeners.add(listener);
  if (!query) {
    query = window.matchMedia('(pointer: coarse)');
    query.addEventListener('change', onChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && query) {
      query.removeEventListener('change', onChange);
      query = null;
    }
  };
}

const snapshot = () => (query ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null))?.matches ?? false;

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
