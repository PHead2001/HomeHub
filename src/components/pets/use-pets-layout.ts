'use client';

import { useSyncExternalStore } from 'react';
import { BOARD_QUERY, ROWS_QUERY, petsLayoutFor, type PetsLayout } from '@/lib/pets/board';

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
