'use client';

import { useEffect, useRef } from 'react';
import { browserBackStack } from '@/lib/shell/back-stack';

/**
 * Android Back (and the browser's Back) closes this dialog while it is the topmost open one,
 * instead of leaving the page (emulator evidence D4). Used by the wall tablet's dialogs and
 * sheets and by the Pets dialogs; other modules' dialogs are unchanged. `close` is the
 * dialog's own cancel path; it returns false when the dialog refuses to close (a save in
 * flight), and the dialog then keeps its Back entry.
 */
export function useBackCloses(open: boolean, close: () => boolean | void): void {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    if (!open) return;
    const handle = browserBackStack()?.open(() => closeRef.current());
    return () => handle?.release();
  }, [open]);
}
