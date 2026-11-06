'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { SPRING_UI } from '@/lib/motion';
import { RoomIcon } from './room-icons';

export type CleanRoom = { id: string; name: string; icon: string };

const DURATION_MS = 1500;

/**
 * "House is clean" (H05): shown once when the last chore due today is completed.
 * Each room sparkles in turn, then the moment gets out of the way after 1.5 s, or
 * at the first key press, click, touch or scroll. It never takes focus or blocks
 * clicks (`pointer-events: none`); screen readers hear one polite status line.
 * Under reduced motion the finished card shows without animation.
 */
export function HouseCleanMoment({ open, rooms, onDone }: { open: boolean; rooms: CleanRoom[]; onDone: () => void }) {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(onDone, DURATION_MS);
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
  const shown = rooms.slice(0, 6);
  const perRoom = shown.length > 0 ? Math.min(0.12, 0.6 / shown.length) : 0;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="house-clean"
          className="pointer-events-none fixed inset-0 z-[90] grid place-items-center bg-scrim/40 p-4"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <motion.div
            role="status"
            aria-live="polite"
            className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border bg-popover px-8 py-6 text-center shadow-overlay"
            initial={reduced ? false : { scale: 0.9, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            transition={SPRING_UI}
          >
            <Sparkles aria-hidden className="h-8 w-8 text-primary" />
            <p className="font-headline text-2xl font-bold text-foreground">House is clean</p>
            <p className="text-sm text-muted-foreground">Everything due today is done.</p>
            {shown.length > 0 && (
              <ul aria-hidden className="flex flex-wrap justify-center gap-2 pt-1">
                {shown.map((room, i) => (
                  <motion.li
                    key={room.id}
                    className="flex items-center gap-1 rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success"
                    initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: [0.6, 1.12, 1] }}
                    transition={{ delay: 0.15 + i * perRoom, duration: 0.35 }}
                  >
                    <RoomIcon name={room.icon} className="h-3.5 w-3.5" />
                    {room.name}
                  </motion.li>
                ))}
              </ul>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
