'use client';

import { useEffect, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { motion, type HTMLMotionProps } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';
import { STAGGER_WINDOW_MS } from '@/lib/motion';
import styles from './stagger.module.css';

type StaggerTag = 'div' | 'ul' | 'ol' | 'section';

type StaggerProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  /** Element to render (`ul`/`ol` for lists, with `li` children). Default `div`. */
  as?: StaggerTag;
  /**
   * @deprecated Accepted for callers written against the earlier motion-based
   * Stagger and ignored: the CSS stagger keys delays by position and caps them
   * itself, so it needs no item count.
   */
  count?: number;
  children: ReactNode;
};

/**
 * Staggered entrance for lists and card grids (H12): each direct child fades in
 * with a 6 px settle, the first at once and each next one 30 ms later; from the
 * 12th child on they share the last delay, so the spread never exceeds 330 ms
 * (budget: 30 ms per item, 400 ms total; `staggerItemDelayMs` in `@/lib/motion`).
 * Pure CSS keyed by position: children keep their own classes (grid spans, list
 * semantics) and the entrance needs no animation library (`StaggerItem` uses
 * `motion` only for callers' own layout and exit animations). Under
 * reduced motion (system or in-app) children render in place at once. Items are
 * interactive from the first frame and never take or delay focus; transforms
 * never change layout.
 *
 * Mount it with the content (not around a loading spinner). Children that mount
 * within `STAGGER_WINDOW_MS` of it enter; later ones (new rows) just appear.
 *
 *   <Stagger className="grid gap-4 sm:grid-cols-2">
 *     {pets.map((pet) => <PetCard key={pet.id} pet={pet} />)}
 *   </Stagger>
 *
 *   <Stagger as="ul" className="space-y-2">
 *     {items.map((item) => <li key={item.id}>…</li>)}
 *   </Stagger>
 */
export function Stagger({ as = 'div', className, children, count: _count, ...props }: StaggerProps) {
  void _count;
  const reduced = useReducedMotion();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(true), STAGGER_WINDOW_MS);
    return () => window.clearTimeout(id);
  }, []);
  const Component = as as 'div';
  const still = reduced || settled;
  return (
    <Component
      {...props}
      data-stagger={still ? 'settled' : 'entering'}
      className={cn(!reduced && styles.stagger, still && styles.settled, className)}
    >
      {children}
    </Component>
  );
}

/** Props that only a motion element understands (layout and exit animations). */
const MOTION_PROPS = ['layout', 'layoutId', 'exit', 'transition', 'initial', 'animate', 'variants', 'whileHover', 'whileTap', 'whileInView', 'onAnimationComplete'] as const;

type StaggerItemProps = Omit<HTMLMotionProps<'div'>, 'ref'> & { as?: 'div' | 'li' };

/**
 * Optional wrapper for a stagger child. Any direct child of `Stagger` already
 * enters in turn; use this when a child needs its own element.
 *
 * It renders a plain element, or a motion element when it is given motion props
 * (`layout`, `exit`, `transition`, ...), so rows inside `AnimatePresence` keep
 * their exit and layout animations (Chores' rows leave with a short slide). The
 * entrance itself is always the CSS stagger; under reduced motion `MotionConfig`
 * and the global CSS make every one of these instant. `data-*` and other DOM
 * props pass through.
 */
export function StaggerItem({ as = 'div', ...props }: StaggerItemProps) {
  const usesMotion = MOTION_PROPS.some((name) => (props as Record<string, unknown>)[name] !== undefined);
  if (usesMotion) {
    const Component = (as === 'li' ? motion.li : motion.div) as typeof motion.div;
    return <Component {...props} />;
  }
  const Component = as as 'div';
  return <Component {...(props as ComponentPropsWithoutRef<'div'>)} />;
}
