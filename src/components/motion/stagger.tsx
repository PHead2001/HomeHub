'use client';

import { useEffect, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';
import { STAGGER_WINDOW_MS } from '@/lib/motion';
import styles from './stagger.module.css';

type StaggerTag = 'div' | 'ul' | 'ol' | 'section';

type StaggerProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  /** Element to render (`ul`/`ol` for lists, with `li` children). Default `div`. */
  as?: StaggerTag;
  children: ReactNode;
};

/**
 * Staggered entrance for lists and card grids (H12): each direct child fades in
 * with a 6 px settle, the first at once and each next one 30 ms later; from the
 * 12th child on they share the last delay, so the spread never exceeds 330 ms
 * (budget: 30 ms per item, 400 ms total; `staggerItemDelayMs` in `@/lib/motion`).
 * Pure CSS keyed by position: children keep their own classes (grid spans, list
 * semantics), nothing loads `motion`, and it is safe in first-paint files. Under
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
export function Stagger({ as = 'div', className, children, ...props }: StaggerProps) {
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

type StaggerItemProps = ComponentPropsWithoutRef<'div'> & { as?: 'div' | 'li' };

/**
 * Optional wrapper for a stagger child. Any direct child of `Stagger` already
 * enters in turn; use this only when a child needs its own element.
 */
export function StaggerItem({ as = 'div', ...props }: StaggerItemProps) {
  const Component = as as 'div';
  return <Component {...props} />;
}
