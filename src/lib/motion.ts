/**
 * Motion tokens and conventions (H12). `motion` (motion.dev) is the only animation
 * library. Import components from `motion/react`; take timing from here so every
 * module stays inside the audit's motion budgets.
 *
 * Reduced motion: read `useReducedMotion()` from `@/hooks/use-reduced-motion`
 * (system setting OR the in-app switch). When it is true, render end states with
 * no transition. `<MotionConfig>` in the AppearanceProvider already disables
 * transform/layout animation and zeroes default transitions, and CSS honors
 * `:root[data-motion="reduce"]`.
 */

import type { CSSProperties } from 'react';
import type { Transition } from 'motion/react';

/** Seconds, for motion. Mirrors the CSS custom properties in globals.css. */
export const DURATION = {
  /** Hover, press, toggles, glow (≤ 150 ms). */
  micro: 0.15,
  /** Route crossfade, dialogs, sheets, toasts, list→detail (≤ 250 ms). */
  ui: 0.22,
  /** Disclosures: accordions, groups (≤ 250 ms). */
  disclosure: 0.22,
  /** Number tickers and progress (400–700 ms). */
  data: 0.55,
  /** Circular theme reveal (450–600 ms). */
  theme: 0.52,
} as const;

export const EASE = {
  standard: [0.2, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
} as const satisfies Record<string, [number, number, number, number]>;

/** Default UI spring: settles visually in 250 ms with a small bounce. */
export const SPRING_UI: Transition = { type: 'spring', visualDuration: 0.25, bounce: 0.2 };
/** Snappier spring for small elements (chips, checkmarks, the nav underline). */
export const SPRING_SNAPPY: Transition = { type: 'spring', visualDuration: 0.2, bounce: 0.15 };

/** Staggered entrance: ≤ 30 ms per item and ≤ 400 ms total. */
export const STAGGER = { perItem: 0.03, maxTotal: 0.4 } as const;

/** Per-item delay for `count` items within the stagger budget. */
export function staggerDelay(count: number): number {
  if (count <= 1) return 0;
  return Math.min(STAGGER.perItem, STAGGER.maxTotal / (count - 1));
}

/** Page content enter: crossfade with an 8 px settle. */
export const PAGE_ENTER = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: DURATION.ui, ease: EASE.standard },
} as const;

/* ------------------------------------------------------------------------- */
/* Shared-element morphs                                                      */
/* ------------------------------------------------------------------------- */

/** Kinds of shared elements; extend as modules add morphs. */
export type SharedElementKind = 'pet' | 'list' | 'asset' | 'vehicle' | 'chore' | 'member' | (string & {});

/**
 * Stable name for a shared element: `${kind}-${id}-${part}`, sanitized to a valid
 * CSS identifier so the same value works as a motion `layoutId` and as a
 * `view-transition-name`.
 *
 *   sharedId('pet', pet.id, 'photo')   → "pet-abc123-photo"
 */
export function sharedId(kind: SharedElementKind, id: string, part = 'card'): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${clean(kind)}-${clean(id)}-${clean(part)}`;
}

/**
 * Style for an element that should morph across a route change via the View
 * Transitions API (see `useMorphNavigation`). Names must be unique on the page.
 */
export function morphStyle(name: string | null | undefined): CSSProperties | undefined {
  return name ? ({ viewTransitionName: name } as CSSProperties) : undefined;
}
