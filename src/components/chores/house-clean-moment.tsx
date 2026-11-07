'use client';

import { useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { EASE, SPRING_UI } from '@/lib/motion';
import { HOUSE_CLEAN_MS, sparkleDelay, type CleanRoom } from '@/lib/chores/house-clean';
import { cn } from '@/lib/utils';
import { RoomIcon } from './room-icons';

export type { CleanRoom };

const STARS = [
  { left: '8%', top: '6%', size: 'h-3 w-3' },
  { left: '78%', top: '12%', size: 'h-2.5 w-2.5' },
  { left: '72%', top: '66%', size: 'h-2 w-2' },
];

/** Small four-point star, drawn in tokens. */
function Star({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('fill-warning', className)} style={style}>
      <path d="M12 0c.8 6.4 5.6 11.2 12 12-6.4.8-11.2 5.6-12 12-.8-6.4-5.6-11.2-12-12C6.4 11.2 11.2 6.4 12 0z" />
    </svg>
  );
}

/**
 * One room of the house. Its sparkle (a tile flash and stars popping in; opacity
 * and transform only) starts at `delay`; under reduced motion the room shows its
 * finished, sparkling state at once.
 */
function SparkleRoom({ room, delay, reduced }: { room: CleanRoom; delay: number; reduced: boolean }) {
  return (
    <li
      className="relative flex min-w-0 flex-col items-center gap-1 rounded-md border border-success/40 bg-success/10 px-1.5 py-2 text-center"
      data-room-id={room.id}
    >
      {!reduced && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-md bg-success/25"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ delay, duration: 0.35 }}
        />
      )}
      <RoomIcon name={room.icon} className="relative h-5 w-5 text-success" />
      <span className="relative w-full truncate text-xs font-medium text-foreground">{room.name}</span>
      {STARS.map((star, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="pointer-events-none absolute"
          style={{ left: star.left, top: star.top }}
          initial={reduced ? false : { opacity: 0, scale: 0.2, rotate: -30 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          transition={reduced ? { duration: 0 } : { delay: delay + i * 0.05, duration: 0.3, ease: EASE.standard }}
        >
          <Star className={star.size} />
        </motion.span>
      ))}
    </li>
  );
}

/**
 * "House is clean" (H05): shown once a day when the last chore due today is
 * completed. A small house drawn from the household's rooms sparkles room by
 * room, then the moment gets out of the way after 1.5 s, or at the first key
 * press, click, touch or scroll. It never takes focus or blocks clicks
 * (`pointer-events: none`); screen readers hear one polite status line. Under
 * reduced motion the finished, sparkling house shows without animation.
 *
 * Built here rather than reusing the dashboard's `LivingHouse`: that component is
 * a page hero with links, peeks, a seasonal toggle and a global key listener, and
 * it needs the dashboard's full facts; none of that belongs in a non-interactive
 * overlay, and it has no room-by-room sparkle sequence.
 */
export function HouseCleanMoment({ open, rooms, onDone }: { open: boolean; rooms: CleanRoom[]; onDone: () => void }) {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(onDone, HOUSE_CLEAN_MS);
    const skip = () => onDone();
    // Registered after the click that triggered the moment has finished.
    const attach = window.setTimeout(() => {
      window.addEventListener('pointerdown', skip, true);
      window.addEventListener('keydown', skip, true);
      window.addEventListener('wheel', skip, { capture: true, passive: true });
      window.addEventListener('touchstart', skip, { capture: true, passive: true });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(attach);
      window.removeEventListener('pointerdown', skip, true);
      window.removeEventListener('keydown', skip, true);
      window.removeEventListener('wheel', skip, true);
      window.removeEventListener('touchstart', skip, true);
    };
  }, [open, onDone]);

  if (typeof document === 'undefined') return null;
  const count = rooms.length;
  const columns = count <= 2 ? Math.max(1, count) : count <= 4 ? 2 : count <= 6 ? 3 : 4;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="house-clean"
          className="pointer-events-none fixed inset-0 z-[90] grid place-items-center bg-scrim/40 p-4"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: 0.2 } }}
          transition={{ duration: 0.15 }}
          data-testid="house-clean-moment"
        >
          <motion.div
            className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl border bg-popover px-6 py-5 text-center shadow-overlay"
            initial={reduced ? false : { scale: 0.9, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            transition={SPRING_UI}
          >
            <p role="status" aria-live="polite" className="flex items-center gap-2 font-headline text-2xl font-bold text-foreground">
              <Sparkles aria-hidden className="h-6 w-6 text-primary" />
              House is clean
            </p>
            <p className="text-sm text-muted-foreground">Everything due today is done.</p>
            {/* The house: a roof and chimney over the household's rooms. Decorative; the status line says it all. */}
            <div aria-hidden className="w-full pt-1">
              <svg viewBox="0 0 200 44" className="block h-11 w-full" preserveAspectRatio="none">
                <rect x="142" y="8" width="12" height="24" className="fill-secondary stroke-primary" strokeWidth="1.5" />
                <polygon points="100,3 197,43 3,43" className="fill-secondary stroke-primary" strokeWidth="2" strokeLinejoin="round" />
              </svg>
              <ul
                className="grid gap-1.5 rounded-b-lg border-2 border-t-0 border-primary bg-background p-2"
                style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                data-testid="house-clean-rooms"
              >
                {rooms.map((room, i) => (
                  <SparkleRoom key={room.id} room={room} delay={sparkleDelay(i, count)} reduced={reduced} />
                ))}
              </ul>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
