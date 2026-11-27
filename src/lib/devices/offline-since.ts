'use client';

import { useSyncExternalStore } from 'react';

/**
 * HP-17: when this tablet last had a connection. While online it is null; when the
 * browser goes offline it is the moment the connection dropped, which is the last
 * moment the tablet's live listeners could have been current ("Offline since 9:41").
 * A page that loads offline has no such moment, and says only "Offline".
 */
let since: number | null = null;

const subscribe = (onChange: () => void) => {
  const onOffline = () => { since = Date.now(); onChange(); };
  const onOnline = () => { since = null; onChange(); };
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);
  return () => {
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('online', onOnline);
  };
};

const snapshot = () => (navigator.onLine === false ? since : null);

export function useOfflineSince(): number | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** Resets the module state between tests. */
export function resetOfflineSinceForTests() {
  since = null;
}
