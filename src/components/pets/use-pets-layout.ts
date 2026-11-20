'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { BOARD_QUERY, HOLD_CAPTION_KEY, ROWS_QUERY, petsLayoutFor, type PetsLayout } from '@/lib/pets/board';

const FINE_QUERY = '(hover: hover) and (pointer: fine)';

function mediaStore(query: string, serverValue: boolean) {
  return {
    subscribe: (listener: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    snapshot: () => (typeof window === 'undefined' || !window.matchMedia ? serverValue : window.matchMedia(query).matches),
    server: () => serverValue,
  };
}

const board = mediaStore(BOARD_QUERY, false);
const rows = mediaStore(ROWS_QUERY, false);
const fine = mediaStore(FINE_QUERY, true);

/** The Pets view for this screen (D-P1, PE-13a): `board`, `rows` or `grid`; follows resizes and rotation. */
export function usePetsLayout(): PetsLayout {
  const isBoard = useSyncExternalStore(board.subscribe, board.snapshot, board.server);
  const isRows = useSyncExternalStore(rows.subscribe, rows.snapshot, rows.server);
  return petsLayoutFor({ board: isBoard, rows: isRows });
}

/** True with a mouse or trackpad (hover and a fine pointer); false on touch screens (D-P2, PE-12d). */
export function usePointerFine(): boolean {
  return useSyncExternalStore(fine.subscribe, fine.snapshot, fine.server);
}

/* ------------------------------------------------------------------------- */
/* Hold caption, remembered per browser (PE-12a, D-P17)                       */
/* ------------------------------------------------------------------------- */

const captionListeners = new Set<() => void>();

function readCaptionDone(): boolean {
  try {
    return window.localStorage.getItem(HOLD_CAPTION_KEY) === '1';
  } catch {
    // Storage blocked (private mode, a preview): show the caption, never fail.
    return false;
  }
}

/** Marks the hold caption done in this browser (first successful hold or dismiss). */
export function markHoldCaptionDone(): void {
  try {
    window.localStorage.setItem(HOLD_CAPTION_KEY, '1');
  } catch {
    // Not remembered; the caption hides for this page anyway.
  }
  captionDoneInPage = true;
  for (const listener of captionListeners) listener();
}

let captionDoneInPage = false;

/** Whether the one-time hold caption is done (stored per browser, or dismissed on this page). */
export function useHoldCaptionDone(): [boolean, () => void] {
  const subscribe = useCallback((listener: () => void) => {
    captionListeners.add(listener);
    const onStorage = (event: StorageEvent) => { if (event.key === HOLD_CAPTION_KEY) listener(); };
    window.addEventListener('storage', onStorage);
    return () => {
      captionListeners.delete(listener);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const done = useSyncExternalStore(subscribe, () => captionDoneInPage || readCaptionDone(), () => true);
  return [done, markHoldCaptionDone];
}
