'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { isShellBusy, markBusy, subscribeShellBusy, type BusyReason } from '@/lib/shell/busy';

/**
 * Holds the shell busy while `dirty` is true, so nothing reloads the page on its
 * own while a form has unsaved input (see `src/lib/shell/busy.ts`).
 *
 *   const form = useForm(...);
 *   useUnsavedInput(form.formState.isDirty);
 */
export function useUnsavedInput(dirty: boolean, reason: BusyReason = 'unsaved-input'): void {
  useEffect(() => {
    if (!dirty) return;
    return markBusy(reason);
  }, [dirty, reason]);
}

/** True while anything holds the shell busy (a save, an Undo toast, unsaved input). */
export function useShellBusy(): boolean {
  return useSyncExternalStore(subscribeShellBusy, isShellBusy, () => false);
}
