'use client';

import { forwardRef, useEffect, useRef } from 'react';
import { motion, useAnimationControls } from 'motion/react';
import { ShoppingCart } from 'lucide-react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';

type CartIndicatorProps = {
  count: number;
  /** Items still flying into the cart (H07); the visible count catches up as each lands. */
  inFlight?: number;
  onClick: () => void;
  className?: string;
};

/**
 * The trip's cart: a cart icon with the number of purchased items. When the
 * visible count grows (as a ticked item lands, see `useCartFlight`) it wobbles
 * once (350 ms, transform only; never under reduced motion). The accessible name
 * always carries the real count. Pressing it opens the Purchased section.
 */
export const CartIndicator = forwardRef<HTMLButtonElement, CartIndicatorProps>(function CartIndicator(
  { count, inFlight = 0, onClick, className },
  ref,
) {
  const controls = useAnimationControls();
  const reduced = useReducedMotion();
  const shown = Math.max(0, count - inFlight);
  const previous = useRef(shown);

  useEffect(() => {
    if (shown > previous.current && !reduced) {
      void controls.start({ rotate: [0, -14, 10, -6, 0], scale: [1, 1.12, 1], transition: { duration: 0.35, ease: 'easeOut' } });
    }
    previous.current = shown;
  }, [shown, controls, reduced]);

  return (
    <button
      ref={ref}
      type="button"
      data-testid="cart-indicator"
      data-count={shown}
      onClick={onClick}
      aria-label={count === 1 ? 'Show the 1 item in the cart' : `Show the ${count} items in the cart`}
      className={cn('relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border bg-card transition-ui hover:bg-accent [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12', className)}
    >
      <motion.span animate={controls} className="inline-flex" aria-hidden>
        <ShoppingCart className="h-5 w-5" />
      </motion.span>
      <span
        aria-hidden
        className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold tabular-nums text-primary-foreground"
      >
        {shown}
      </span>
    </button>
  );
});
