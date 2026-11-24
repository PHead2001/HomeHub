import { useCallback, useInsertionEffect, useRef } from 'react';

/**
 * A handler with a stable identity that always runs the latest `fn` (for event handlers only,
 * never during rendering). The page passes these to memoized panels and dialogs, so a state
 * change elsewhere (typing in a form, a toast) does not re-render them.
 */
export function useStableHandler<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useInsertionEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
