'use client';

import { useEffect, useState } from 'react';
import { useOptionalAppearance } from '@/components/appearance-provider';

/**
 * True when motion should be reduced: the system `prefers-reduced-motion` setting
 * OR the in-app Profile → Appearance → Reduce motion switch. When true, render end
 * states instantly (no drift, stagger, ticker, confetti or camera moves).
 *
 * The same state is exposed to CSS as `<html data-motion="reduce">`.
 */
export function useReducedMotion(): boolean {
  const appearance = useOptionalAppearance();
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (appearance || typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setFallback(list.matches || document.documentElement.getAttribute('data-motion') === 'reduce');
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [appearance]);

  return appearance ? appearance.reducedMotion : fallback;
}
