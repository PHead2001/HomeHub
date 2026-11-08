'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void> | void) => { finished: Promise<void> };
};

/** Longest the old snapshot is held while the new view renders. */
const MAX_WAIT_MS = 800;

/** A click that should open in its usual way, not morph (new tab, new window, etc.). */
export const isModifiedClick = (event?: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button'>) =>
  Boolean(event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0));

/**
 * Shared-element morphs inside one route (H12): list card → open list on
 * `/shopping?list=`, asset card → asset detail on `/maintenance`. The same View
 * Transitions path as `useMorphNavigation`, but for views that change in place.
 *
 * `morphName` is the one `view-transition-name` in play: give it (via
 * `morphStyle`) to the source element before the change and to the target
 * after it. `run(name, update)` sets the name, captures the old view, applies
 * `update`, and holds the snapshot until `settle()` is called (call it from an
 * effect once the new view has rendered) or `sync: true` applies it at once.
 * Reduced motion, a missing API or a modified click just applies the update.
 */
export function useInPageMorph() {
  const reduced = useReducedMotion();
  const [morphName, setMorphName] = useState<string | null>(null);
  const pending = useRef<(() => void) | null>(null);

  const settle = useCallback(() => pending.current?.(), []);
  useEffect(() => () => pending.current?.(), []);

  const run = useCallback((name: string, update: () => void, options: { sync?: boolean; event?: MouseEvent } = {}) => {
    const doc = typeof document === 'undefined' ? null : (document as ViewTransitionDocument);
    if (reduced || !doc || typeof doc.startViewTransition !== 'function' || isModifiedClick(options.event)) {
      update();
      return;
    }
    pending.current?.();
    flushSync(() => setMorphName(name));
    const transition = doc.startViewTransition(() => {
      if (options.sync) {
        flushSync(update);
        return;
      }
      return new Promise<void>((resolve) => {
        const timeout = window.setTimeout(done, MAX_WAIT_MS);
        function done() {
          window.clearTimeout(timeout);
          if (pending.current === done) pending.current = null;
          // Let the new view paint before the browser captures it.
          requestAnimationFrame(() => resolve());
        }
        pending.current = done;
        update();
      });
    });
    void transition.finished
      .catch(() => undefined)
      .finally(() => setMorphName((current) => (current === name ? null : current)));
  }, [reduced]);

  return { morphName, run, settle };
}
