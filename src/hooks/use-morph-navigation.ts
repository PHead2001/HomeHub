'use client';

import { useCallback, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void> | void) => { finished: Promise<void> };
};

/** Longest we hold the old snapshot while the next route loads. */
const MAX_WAIT_MS = 800;

// Module-level because the component that starts a morph usually unmounts with
// its route; the persistent <MorphRouteListener /> in the root layout resolves it.
let pending: { target: string; resolve: () => void } | null = null;

/** Mounted once in the root layout: tells a pending morph that its route committed. */
export function MorphRouteListener() {
  const pathname = usePathname();
  useEffect(() => {
    if (pending && pathname === pending.target) {
      pending.resolve();
      pending = null;
    }
  }, [pathname]);
  return null;
}

/**
 * Cross-route shared-element morphs (H12), e.g. pet card photo → pet page hero.
 *
 * 1. Give the element on both pages the same name:
 *      <Image style={morphStyle(sharedId('pet', pet.id, 'photo'))} … />
 * 2. Navigate with `navigate(href)` from this hook instead of a plain push:
 *      const { navigate } = useMorphNavigation();
 *      <Link href={href} onClick={(e) => { e.preventDefault(); navigate(href); }}>
 *
 * Uses the View Transitions API: the browser morphs every element whose
 * `view-transition-name` exists on both pages. Where the API is missing or motion
 * is reduced it is a normal `router.push`. Within one route (list → open list,
 * asset card → detail panel) use motion `layoutId={sharedId(…)}` instead.
 */
export function useMorphNavigation() {
  const router = useRouter();
  const reduced = useReducedMotion();

  const navigate = useCallback(
    (href: string) => {
      const doc = document as ViewTransitionDocument;
      const target = new URL(href, window.location.href).pathname;
      if (reduced || typeof doc.startViewTransition !== 'function' || target === window.location.pathname) {
        router.push(href);
        return;
      }
      doc.startViewTransition(
        () =>
          new Promise<void>((resolve) => {
            const timeout = window.setTimeout(resolve, MAX_WAIT_MS);
            pending = {
              target,
              resolve: () => {
                window.clearTimeout(timeout);
                // Let the new route paint before the browser captures it.
                requestAnimationFrame(() => resolve());
              },
            };
            router.push(href);
          }),
      );
    },
    [reduced, router],
  );

  return { navigate };
}
