'use client';

import { useEffect, useRef } from 'react';
import { motion, useAnimationControls } from 'motion/react';
import { ShoppingCart } from 'lucide-react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';

/**
 * The trip's cart: a cart icon with the number of purchased items. When the count
 * grows it wobbles once (350 ms, transform only; never under reduced motion).
 * Pressing it opens the Purchased section.
 */
export function CartIndicator({ count, onClick, className }: { count: number; onClick: () => void; className?: string }) {
  const controls = useAnimationControls();
  const reduced = useReducedMotion();
  const previous = useRef(count);

  useEffect(() => {
    if (count > previous.current && !reduced) {
      void controls.start({ rotate: [0, -14, 10, -6, 0], scale: [1, 1.12, 1], transition: { duration: 0.35, ease: 'easeOut' } });
    }
    previous.current = count;
  }, [count, controls, reduced]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={count === 1 ? 'Show the 1 item in the cart' : `Show the ${count} items in the cart`}
      className={cn('relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border bg-card transition-ui hover:bg-accent', className)}
    >
      <motion.span animate={controls} className="inline-flex" aria-hidden>
        <ShoppingCart className="h-5 w-5" />
      </motion.span>
      <span
        aria-hidden
        className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold tabular-nums text-primary-foreground"
      >
        {count}
      </span>
    </button>
  );
}
