'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getLocalPersistence } from '@/lib/firebase';
import { isBrowserOffline } from '@/lib/firestore-offline';
import { trackWrite, type TrackedWrite, type WriteKind } from '@/lib/shopping/save-status';
import { saveLineText, type SaveLineState } from '@/lib/shopping/save-line';

type Line = { id: number; state: SaveLineState; subject: string };

/**
 * Tracks a dialog's writes through the S2 save path (`trackWrite`) and keeps one
 * honest status line for the latest one. A write that fails (at once or later)
 * also raises `onFail` (a `toastError`), so a failure is never silent even after
 * a newer write took over the line.
 */
export function useSaveLine(onFail: (error: unknown, title: string) => void) {
  const [line, setLine] = useState<Line | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const track = useCallback(async <T,>(
    write: Promise<T>,
    { kind, subject, failTitle, cacheReflectsWrite }: { kind: WriteKind; subject: string; failTitle: string; cacheReflectsWrite?: () => Promise<boolean> },
  ): Promise<TrackedWrite<T>> => {
    const id = ++seq.current;
    const show = (state: SaveLineState) => {
      if (mounted.current) setLine((current) => (current === null || current.id <= id ? { id, state, subject } : current));
    };
    show('waiting');
    const tracked = await trackWrite(write, { kind, persistence: getLocalPersistence, offline: isBrowserOffline, cacheReflectsWrite });
    show(tracked.state);
    if (tracked.state === 'failed') {
      onFail(tracked.error, failTitle);
    } else if (tracked.state !== 'saved') {
      void tracked.settled.then((final) => {
        if (final.state === 'failed') onFail(final.error, failTitle);
        show(final.state);
      });
    }
    return tracked;
  }, [onFail]);

  const clear = useCallback(() => setLine(null), []);

  return { text: line ? saveLineText(line.state, line.subject) : '', state: line?.state ?? null, track, clear };
}
