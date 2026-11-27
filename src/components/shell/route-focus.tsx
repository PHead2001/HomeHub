'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import {
  ROUTE_FOCUS_STEP_MS,
  ROUTE_FOCUS_UPGRADE_MS,
  ROUTE_FOCUS_WAIT_MS,
  SHELL_NAV_SELECTOR,
  overlayShown,
  shouldMoveRouteFocus,
  type FocusSnapshot,
} from '@/lib/shell/route-focus';

function snapshot(): FocusSnapshot {
  const active = document.activeElement;
  return {
    onBody: !active || active === document.body || active === document.documentElement,
    inShellNav: Boolean(active?.closest(SHELL_NAV_SELECTOR)),
    overlayOpen: overlayShown(),
  };
}

function focusTarget(): HTMLElement | null {
  const main = document.getElementById('main');
  if (!main) return null;
  const heading = main.querySelector<HTMLElement>('h1');
  return heading ?? null;
}

/**
 * SL-18: moves focus to the new page's h1 after a client navigation (see
 * `src/lib/shell/route-focus.ts` for when). Waits up to 1.5 s for the heading to
 * render, then falls back to `<main id="main">` and hands focus on to the heading if it
 * renders within 6 s; gives up as soon as the person moves focus themselves.
 */
export function RouteFocus() {
  const pathname = usePathname() || '/';
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = pathname;
    if (!shouldMoveRouteFocus({ previousPath: before, path: pathname, focus: snapshot() })) return;
    let waited = 0;
    let timer: number | null = null;
    const attempt = () => {
      timer = null;
      const now = snapshot();
      const main = document.getElementById('main');
      // Focus went to <main> while the heading was still loading: hand it to the heading
      // when it renders, unless the person moved on.
      if (main && document.activeElement === main) {
        const heading = focusTarget();
        if (heading) {
          if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
          heading.focus({ preventScroll: true });
          return;
        }
        if (waited >= ROUTE_FOCUS_UPGRADE_MS) return;
        waited += ROUTE_FOCUS_STEP_MS;
        timer = window.setTimeout(attempt, ROUTE_FOCUS_STEP_MS);
        return;
      }
      // The person took focus into the page (or a field) meanwhile: leave it there.
      if (!now.onBody && !now.inShellNav) return;
      // A closing sheet (the phone's More) or a dialog still open: wait for it.
      const ready = !now.overlayOpen;
      const heading = ready ? focusTarget() : null;
      const target = heading ?? (ready && waited >= ROUTE_FOCUS_WAIT_MS ? document.getElementById('main') : null);
      if (!ready && waited >= ROUTE_FOCUS_WAIT_MS) return;
      if (target) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        if (target !== main) return;
      }
      waited += ROUTE_FOCUS_STEP_MS;
      timer = window.setTimeout(attempt, ROUTE_FOCUS_STEP_MS);
    };
    timer = window.setTimeout(attempt, 0);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pathname]);

  return null;
}
