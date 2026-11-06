'use client';

import { Children, createContext, useContext, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { motion, stagger, type Variants } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE, staggerDelay } from '@/lib/motion';

const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: { duration: DURATION.ui, ease: EASE.standard } },
};

const StaggerContext = createContext(false);

type StaggerProps = Omit<ComponentPropsWithoutRef<typeof motion.div>, 'initial' | 'animate' | 'variants'> & {
  /** Number of items, when children are not direct `StaggerItem`s (e.g. fragments). */
  count?: number;
  /** Render as a list (`ul`) instead of a `div`. Use `StaggerItem as="li"` inside. */
  as?: 'div' | 'ul' | 'ol';
  children: ReactNode;
};

/**
 * Staggered entrance for lists and card grids (≤ 30 ms per item, ≤ 400 ms total).
 * Mount it when the data is ready (not around a loading state). Under reduced motion
 * items render in place immediately. Items never delay focus or clicks: they are
 * interactive from the first frame.
 *
 *   <Stagger className="grid gap-4 sm:grid-cols-2">
 *     {pets.map((pet) => <StaggerItem key={pet.id}><PetCard pet={pet} /></StaggerItem>)}
 *   </Stagger>
 */
export function Stagger({ count, as = 'div', children, ...props }: StaggerProps) {
  const reduced = useReducedMotion();
  const items = count ?? Children.count(children);
  // The list variants share div props; cast keeps one prop type for all three.
  const Component = (as === 'ul' ? motion.ul : as === 'ol' ? motion.ol : motion.div) as typeof motion.div;
  const variants: Variants = {
    hidden: {},
    shown: { transition: { delayChildren: stagger(staggerDelay(items)) } },
  };
  return (
    <StaggerContext.Provider value={!reduced}>
      <Component
        {...props}
        variants={variants}
        initial={reduced ? false : 'hidden'}
        animate="shown"
      >
        {children}
      </Component>
    </StaggerContext.Provider>
  );
}

type StaggerItemProps = Omit<ComponentPropsWithoutRef<typeof motion.div>, 'variants'> & { as?: 'div' | 'li' };

export function StaggerItem({ as = 'div', ...props }: StaggerItemProps) {
  const animated = useContext(StaggerContext);
  const Component = (as === 'li' ? motion.li : motion.div) as typeof motion.div;
  return <Component {...props} variants={animated ? ITEM_VARIANTS : undefined} />;
}
