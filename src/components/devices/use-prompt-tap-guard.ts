'use client';

// The browser binding of the prompts' tap guard (`promptTapAllowed`, src/lib/devices/tap-guard.ts).

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { PROMPT_TAP_GUARD_MS, promptTapAllowed } from '@/lib/devices/tap-guard';

type Activation = { detail: number; preventDefault: () => void };

/**
 * For a prompt mounted when it opens. `allow(event)` answers whether a click on a choice counts
 * (a refused one is `preventDefault`ed, so a Radix Action or Cancel does not close either);
 * `ready` turns true once the guard has passed (`data-tap-ready` on the prompt).
 */
export function usePromptTapGuard() {
  const openedAt = useRef<number | null>(null);
  const pressStartedAt = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    openedAt.current = performance.now();
    pressStartedAt.current = null;
    const down = () => {
      pressStartedAt.current = performance.now();
    };
    document.addEventListener('pointerdown', down, true);
    const timer = window.setTimeout(() => setReady(true), PROMPT_TAP_GUARD_MS);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.clearTimeout(timer);
    };
  }, []);
  const allow = useCallback((event: Activation) => {
    const ok = promptTapAllowed({ openedAt: openedAt.current, pressStartedAt: pressStartedAt.current, keyboard: event.detail === 0 });
    if (!ok) event.preventDefault();
    return ok;
  }, []);
  return { allow, ready };
}
