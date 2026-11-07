/**
 * Route view transitions (H12): one engine for every route change that animates
 * with the View Transitions API, used by plain link clicks (`RouteTransitionListener`
 * through `MorphRouteListener`) and by explicit shared-element morphs
 * (`useMorphNavigation`). No `motion` import, so it is safe on first-paint paths.
 *
 * While a transition runs, `<html>` carries `data-route-transition`. CSS keyed on
 * it names the page content (`page-content`, from `page-transition.module.css`),
 * the header and the phone tab bar (`globals.css`), so only page content
 * crossfades with an 8 px settle; the header and tab bar are captured on their own
 * and shown live, so they never re-animate. Named shared elements (`morphStyle`)
 * on both pages morph between their boxes. Outside a route transition nothing is
 * named, so the theme reveal (also a view transition) still clips the whole page.
 *
 * Where the API is missing, or motion is reduced (system or in-app), nothing is
 * held: the navigation runs as usual and `PageTransition` plays the CSS fallback
 * (or nothing, under reduced motion).
 */
import { ROUTE_TRANSITION } from '@/lib/motion';

type ViewTransitionLike = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone?: Promise<void> };
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void> | void) => ViewTransitionLike;
};

export type RouteTransitionOptions = {
  /** Longest time (ms) the old page is held while the next one commits. */
  maxWaitMs?: number;
  /**
   * Also wait (within `maxWaitMs`) until the destination is ready: a `data-morph`
   * name (see `morphProps`) that must be rendered, or a predicate.
   */
  waitFor?: string | (() => boolean);
};

let active = false;

/** True while a route view transition is holding or animating the page. */
export function isRouteTransitionActive(): boolean {
  return active;
}

/** Reduced motion from the system setting or the in-app switch (`data-motion`). */
export function prefersReducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True when this browser can run route view transitions. */
export function supportsRouteTransitions(): boolean {
  return typeof document !== 'undefined' && typeof (document as ViewTransitionDocument).startViewTransition === 'function';
}

/** The URL's route part (path and query, no hash), for "has the route committed?". */
export function routeKey(url: Pick<URL, 'pathname' | 'search'>): string {
  return `${url.pathname}${url.search}`;
}

const morphRendered = (name: string) => {
  const safe = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(name) : name.replace(/["\\]/g, '\\$&');
  return document.querySelector(`[data-morph="${safe}"]`) !== null;
};

/**
 * Runs `navigate` (usually `router.push(href)`) inside a view transition, or calls
 * it directly when transitions are unsupported, reduced or already running, or
 * when `href` is the current route. Pass `navigate = null` when the navigation is
 * already under way (a Next `<Link>` click). Returns true when a transition ran.
 */
export function runRouteTransition(href: string, navigate: (() => void) | null, options: RouteTransitionOptions = {}): boolean {
  if (typeof window === 'undefined') {
    navigate?.();
    return false;
  }
  const target = new URL(href, window.location.href);
  const doc = document as ViewTransitionDocument;
  if (
    active
    || prefersReducedMotion()
    || typeof doc.startViewTransition !== 'function'
    || target.origin !== window.location.origin
    || routeKey(target) === routeKey(window.location)
  ) {
    navigate?.();
    return false;
  }

  const maxWait = options.maxWaitMs ?? ROUTE_TRANSITION.morphMaxWaitMs;
  const { waitFor } = options;
  const destinationReady = () => {
    if (routeKey(window.location) !== routeKey(target)) return false;
    if (!waitFor) return true;
    return typeof waitFor === 'string' ? morphRendered(waitFor) : waitFor();
  };

  const root = document.documentElement;
  active = true;
  root.setAttribute('data-route-transition', '');
  const cleanup = () => {
    active = false;
    root.removeAttribute('data-route-transition');
  };

  try {
    const transition = doc.startViewTransition(() => new Promise<void>((resolve) => {
      const startedAt = Date.now();
      // setTimeout, not requestAnimationFrame: rendering (and rAF) is paused while
      // the browser holds the old snapshot.
      const check = () => {
        if (destinationReady() || Date.now() - startedAt >= maxWait) resolve();
        else window.setTimeout(check, ROUTE_TRANSITION.pollMs);
      };
      navigate?.();
      check();
    }));
    // A transition skipped by another one (a theme change) rejects `ready`; that is fine.
    transition.ready.catch(() => undefined);
    transition.finished.then(cleanup, cleanup);
    return true;
  } catch {
    cleanup();
    navigate?.();
    return false;
  }
}

/**
 * The internal route a click on a link will open, or null when the click is not a
 * plain same-origin navigation to another path. A link (or an ancestor) with
 * `data-route-transition="manual"` opts out: use it when the click handler delays
 * or replaces the navigation (for example a zoom before `useMorphNavigation`).
 */
export function routeTransitionTarget(event: MouseEvent): URL | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null;
  if (anchor.closest('[data-route-transition="manual"]')) return null;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) return null;
  // Only path changes crossfade the page; query-only changes (filters, tabs,
  // ?list=) stay in place unless a morph asks for a transition explicitly.
  if (url.pathname === window.location.pathname) return null;
  return url;
}
