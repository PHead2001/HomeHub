'use client';

import { useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  isRouteTransitionActive,
  routeTransitionTarget,
  runRouteTransition,
  type RouteTransitionOptions,
} from '@/components/motion/route-transition';
import { ROUTE_TRANSITION } from '@/lib/motion';

/**
 * Mounted once in the root layout. Turns plain internal link clicks into route
 * view transitions (H12): it runs after `next/link` has started the navigation
 * (window bubble phase, like `NavigationProgress`), so it never changes where a
 * link goes or which handlers run. Skipped when a handler already started a
 * transition (a morph), for links marked `data-route-transition="manual"`, for
 * query-only changes, and wherever `runRouteTransition` declines (reduced motion,
 * no API). Plain anchors that did a full page load (`defaultPrevented` false) are
 * left alone.
 */
export function MorphRouteListener() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!event.defaultPrevented || isRouteTransitionActive()) return;
      const target = routeTransitionTarget(event);
      if (target) runRouteTransition(target.href, null, { maxWaitMs: ROUTE_TRANSITION.linkMaxWaitMs });
    };
    window.addEventListener('click', onClick);
    return () => window.removeEventListener('click', onClick);
  }, []);
  return null;
}

export type MorphNavigateOptions = Pick<RouteTransitionOptions, 'waitFor'> & {
  /** Replace the history entry instead of pushing one. */
  replace?: boolean;
};

/**
 * Shared-element morphs between any two elements (H12), across routes or within
 * one route when the URL changes (a query such as `?list=` or `?asset=`).
 *
 * 1. Give both ends the same name (`sharedId(kind, id, part)` from `@/lib/motion`):
 *      card:   <img {...morphProps(sharedId('pet', pet.id, 'photo'))} … />
 *      detail: <img {...morphProps(sharedId('pet', pet.id, 'photo'))} … />
 *    (`morphStyle(name)` alone also works; `morphProps` adds the `data-morph`
 *    marker that `waitFor` looks for.) Each name must be unique on the page at
 *    both ends: when the card stays mounted beside its open detail, give the card
 *    `null` while the detail is open.
 * 2. Navigate with this hook instead of a plain push, in the click handler:
 *      const { navigate } = useMorphNavigation();
 *      <Link href={href} onClick={(e) => { e.preventDefault(); navigate(href, { waitFor: name }); }}>
 *    `waitFor` (a `data-morph` name or a predicate) holds the old snapshot until
 *    the destination element has rendered, at most 800 ms in total.
 *
 * The page content crossfades around the morph exactly like a plain route change
 * (same engine, `runRouteTransition`). Where the API is missing or motion is
 * reduced it is a normal `router.push`/`replace`. If the click handler delays the
 * navigation (an animation first), mark the link `data-route-transition="manual"`.
 */
export function useMorphNavigation() {
  const router = useRouter();

  const navigate = useCallback(
    (href: string, options: MorphNavigateOptions = {}) => {
      const go = () => (options.replace ? router.replace(href) : router.push(href));
      runRouteTransition(href, go, { maxWaitMs: ROUTE_TRANSITION.morphMaxWaitMs, waitFor: options.waitFor });
    },
    [router],
  );

  return { navigate };
}
