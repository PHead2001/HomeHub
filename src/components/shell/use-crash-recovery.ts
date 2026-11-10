'use client';

import { useEffect, useRef, useState } from 'react';
import { isShellBusy } from '@/lib/shell/busy';
import { decideCrashRecovery, isStaleBuildError, storeCrash, type CrashRecovery } from '@/lib/shell/crash-guard';

export type CrashState = { recovery: CrashRecovery; at: Date } | null;

const sessionStore = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/**
 * Records a crash once per thrown value, decides whether one automatic reload
 * may fix it (`src/lib/shell/crash-guard.ts`) and, only then, reloads. Returns
 * null until the effect has run (the first paint shows the plain error).
 */
export function useCrashRecovery(error: unknown): CrashState {
  const [state, setState] = useState<CrashState>(null);
  const handled = useRef<unknown>(undefined);

  useEffect(() => {
    // Strict Mode runs effects twice in development; count each crash once.
    if (handled.current === error) return;
    handled.current = error;
    console.error(error);
    const now = Date.now();
    const { history, persisted } = storeCrash(sessionStore(), now);
    const recovery = decideCrashRecovery({
      history,
      now,
      persisted,
      busy: isShellBusy(),
      online: navigator.onLine !== false,
      recoverable: isStaleBuildError(error),
    });
    setState({ recovery, at: new Date(now) });
    if (recovery.action === 'auto-reload') window.location.reload();
  }, [error]);

  return state;
}

/** "3:42 PM" in the member's locale. */
export function crashTime(at: Date): string {
  return at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
