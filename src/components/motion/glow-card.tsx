'use client';

import { forwardRef, useEffect, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const FINE_HOVER = '(hover: hover) and (pointer: fine)';

/**
 * Drives every `.glow-card` on the page (H15) with one delegated listener, mounted
 * once in the root layout. On pointer move it writes `--glow-x`/`--glow-y` on the
 * nearest `.glow-card` (no React re-render). It only listens on devices that hover
 * with a fine pointer, and only the CSS pseudo-element layers react: the card and
 * its click targets never move.
 */
export function GlowPointerTracker() {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(FINE_HOVER);
    let frame = 0;
    let latest: PointerEvent | null = null;

    const update = () => {
      frame = 0;
      const event = latest;
      if (!event) return;
      const card = (event.target as Element | null)?.closest?.('.glow-card') as HTMLElement | null;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--glow-x', `${event.clientX - rect.left}px`);
      card.style.setProperty('--glow-y', `${event.clientY - rect.top}px`);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      latest = event;
      if (!frame) frame = requestAnimationFrame(update);
    };

    const attach = () => {
      document.removeEventListener('pointermove', onMove);
      if (media.matches) document.addEventListener('pointermove', onMove, { passive: true });
    };
    attach();
    media.addEventListener('change', attach);
    return () => {
      media.removeEventListener('change', attach);
      document.removeEventListener('pointermove', onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}

/**
 * A raised surface with the pointer-following glow border and spotlight. Any element
 * can opt in with `className="glow-card"` instead (e.g. a Card or a card-like button).
 */
export const GlowCard = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('glow-card rounded-lg border bg-card text-card-foreground shadow-raised', className)} {...props} />
));
GlowCard.displayName = 'GlowCard';
