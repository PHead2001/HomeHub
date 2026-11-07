'use client';

import { useEffect, type ReactNode } from 'react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import styles from './page-transition.module.css';

// The first page of a session is never animated: content must not wait for
// hydration. Later navigations remount `src/app/template.tsx`, which crossfades.
let hasShownFirstPage = false;

/**
 * Crossfade with an 8 px settle (≤ 250 ms) for page content only. Mounted by the
 * root `template.tsx`, so the header and tab bar (in the layout) never re-animate.
 * Pure CSS (same values as `PAGE_ENTER`), so the first page loads no animation
 * library; reduced motion (system or in-app) shows content at once.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  // Decided once per mount: a later state change never replays the entrance.
  const animate = hasShownFirstPage && !reduced;

  useEffect(() => {
    hasShownFirstPage = true;
  }, []);

  return <div className={animate ? styles.enter : undefined}>{children}</div>;
}
