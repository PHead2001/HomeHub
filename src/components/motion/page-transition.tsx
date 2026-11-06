'use client';

import { useEffect, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { PAGE_ENTER } from '@/lib/motion';

// The first page of a session is never animated: content must not wait for
// hydration. Later navigations remount `src/app/template.tsx`, which crossfades.
let hasShownFirstPage = false;

/**
 * Crossfade with an 8 px settle (≤ 250 ms) for page content only. Mounted by the
 * root `template.tsx`, so the header and tab bar (in the layout) never re-animate.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const animate = hasShownFirstPage && !reduced;

  useEffect(() => {
    hasShownFirstPage = true;
  }, []);

  return (
    <motion.div
      initial={animate ? PAGE_ENTER.initial : false}
      animate={PAGE_ENTER.animate}
      transition={PAGE_ENTER.transition}
    >
      {children}
    </motion.div>
  );
}
