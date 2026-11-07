'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { isRouteTransitionActive } from './route-transition';
import styles from './page-transition.module.css';

// The first page of a session is never animated: content must not wait for
// hydration. Later navigations remount `src/app/template.tsx`, which crossfades.
let hasShownFirstPage = false;

/**
 * Route transition for page content only (H12). Mounted by the root
 * `template.tsx`, so the header and tab bar (in the layout) never re-animate.
 *
 * - With the View Transitions API, `runRouteTransition` (link clicks and
 *   `useMorphNavigation`) names this wrapper `page-content` and the browser
 *   crossfades old and new page with an 8 px settle (globals.css), morphing any
 *   shared elements on the way. This component then adds no animation of its own.
 * - Without it (or for back/forward), the new page fades in with the same 8 px
 *   settle in CSS (`PAGE_ENTER` values), so the first page loads no animation
 *   library.
 * - Reduced motion (system or in-app) shows content at once, and the first page
 *   of a session is never animated.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  // Decided once per mount: a later state change never replays the entrance.
  const [animate] = useState(() => hasShownFirstPage && !reduced && !isRouteTransitionActive());

  useEffect(() => {
    hasShownFirstPage = true;
  }, []);

  return <div className={animate ? `${styles.page} ${styles.enter}` : styles.page}>{children}</div>;
}
