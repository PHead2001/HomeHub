'use client';

// One pending action at a time for a tablet form or a row of buttons (Codex review 6): a second
// tap while the first is in flight does nothing, and a form keeps one opId from when it opens
// until an attempt is applied or saved on the tablet, so a retry after a lost answer replays on
// the server instead of adding a second record (`formOpAfter`).

import { useCallback, useRef, useState } from 'react';
import { formOpAfter } from '@/lib/devices/device-action-answers';
import type { TabletActionOutcome } from './tablet-context';

const newOpId = () => globalThis.crypto.randomUUID();

export function useTabletSubmit() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [opId, setOpId] = useState(newOpId);
  const guard = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, []);
  /** A form submit: the form's opId, renewed once the attempt was applied (or saved on the tablet). */
  const submit = useCallback((work: (opId: string) => Promise<TabletActionOutcome>) => guard(async () => {
    const outcome = await work(opId);
    if (formOpAfter(outcome) === 'renew') setOpId(newOpId());
    return outcome;
  }), [guard, opId]);
  /** A one-tap action (each tap its own intent and opId), guarded against a double tap. */
  const run = useCallback((work: () => Promise<TabletActionOutcome | undefined | void>) => guard(work), [guard]);
  return { busy, opId, submit, run, renew: () => setOpId(newOpId()) };
}
