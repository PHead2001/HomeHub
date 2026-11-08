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

/**
 * Staggered entrance: ≤ 30 ms per item and ≤ 400 ms total. `Stagger` animates the
 * first `maxIndexed` items in turn; later items share the last delay (330 ms).
 */
export const STAGGER = { perItem: 0.03, maxTotal: 0.4, maxIndexed: 12 } as const;

/** Milliseconds after `Stagger` mounts during which new children still enter. */
export const STAGGER_WINDOW_MS = 1200;

/** Delay (ms) `Stagger` gives its n-th child (0-based): first at once, capped. */
export function staggerItemDelayMs(index: number): number {
  const position = Math.min(Math.max(0, Math.floor(index)), STAGGER.maxIndexed - 1);
  return Math.round(position * STAGGER.perItem * 1000);
}

/** Per-item delay for `count` items within the stagger budget. */
export function staggerDelay(count: number): number {
  if (count <= 1) return 0;
  return Math.min(STAGGER.perItem, STAGGER.maxTotal / (count - 1));
}

/**
 * Tab panel enter (D09): a 150 ms fade (micro budget), opacity only, because the
 * panel's buttons and links are clickable from the first frame and clickable
 * targets never move. CSS in `tabs.module.css`.
 */
export const TAB_ENTER = { durationMs: 150, offsetPx: 0 } as const;

/**
 * What a tab panel does with its entrance marker when its `data-state` changes:
 * play it only on a switch from inactive to active (never for the panel active on
 * first render, which has no previous state), clear it when the panel is hidden.
 */
export function tabEnterChange(previous: string | null, next: string | null): 'add' | 'remove' | 'keep' {
  if (next === previous) return 'keep';
  if (next === 'active') return previous === 'inactive' ? 'add' : 'keep';
  return 'remove';
}

/**
 * Route view transitions (H12). Longest time the old page is held while the next
 * route commits: a link click (navigation already under way) and an explicit
 * morph (`useMorphNavigation`, which may also wait for its target element).
 */
export const ROUTE_TRANSITION = { linkMaxWaitMs: 500, morphMaxWaitMs: 800, pollMs: 16 } as const;

/* NumberTicker frames (pure, unit-tested; used by src/components/motion/number-ticker.tsx). */
/** Figure space: as wide as a digit in tabular figures. */
const FIGURE_SPACE = '\u2007';
/** Punctuation space: as wide as a period or comma. */
const PUNCTUATION_SPACE = '\u2008';

/**
 * The string drawn while counting: `current` padded at the start to the final
 * value's length, so it occupies exactly the final text's width. Null when the
 * count cannot be drawn in that width (a start value with more characters than
 * the final one, e.g. counting down from 12 to 9): then the value changes at once.
 */
export function tickerFrame(current: string, final: string, start: string): string | null {
  if (start.length > final.length || current.length > final.length) return null;
  // Pad with a space as wide as the final character it stands in for (a digit,
  // or a separator such as "," or "."), so the drawn string is exactly as wide.
  const missing = final.length - current.length;
  const pad = Array.from(final.slice(0, missing), (char) => (/\d/.test(char) ? FIGURE_SPACE : PUNCTUATION_SPACE)).join('');
  return pad + current;
}

/**
 * Page content enter (the CSS fallback): a fade, opacity only, because real page
 * content is clickable at once. The 8 px settle exists only on the view-transition
 * snapshot (globals.css), which takes no input.
 */
export const PAGE_ENTER = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
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
 * Transitions API (see `useMorphNavigation`). Works for any pair of elements (pet
 * photo → pet hero, list card → open list, asset card → detail): give both ends
 * the same name. Names must be unique on the page at each end of the transition,
 * so when the source stays mounted next to its detail (same-route detail panels),
 * pass `null` for the source while its detail is open.
 */
export function morphStyle(name: string | null | undefined): CSSProperties | undefined {
  return name ? ({ viewTransitionName: name } as CSSProperties) : undefined;
}

/**
 * `morphStyle` plus a `data-morph` marker, so `useMorphNavigation().navigate(href,
 * { waitFor: name })` can hold the transition until the destination element has
 * rendered (detail views that render after their data loads).
 *
 *   <img {...morphProps(sharedId('pet', pet.id, 'photo'))} … />
 */
export function morphProps(name: string | null | undefined): { style?: CSSProperties; 'data-morph'?: string } {
  return name ? { style: morphStyle(name), 'data-morph': name } : {};
}
