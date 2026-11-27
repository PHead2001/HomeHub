'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { PartyPopper } from 'lucide-react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { SPRING_UI } from '@/lib/motion';
import { PERSON_DONE_MS } from '@/lib/chores/house-clean';

/**
 * "Your chores are done, Sam!" (CH-22): a small pill when one person's list for
 * today clears while the rest of the house still has work ("House is clean" is the
 * bigger moment for the whole house). It never takes focus or blocks taps, leaves
 * after a few seconds, is announced once (polite status) and shows without motion
 * under reduced motion. It is separate from the toast stack, so a completion's
 * Undo toast stays.
 */
export function PersonDoneMoment({ title, onDone }: { title: string | null; onDone: () => void }) {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!title) return;
    const timer = window.setTimeout(onDone, PERSON_DONE_MS);
    return () => window.clearTimeout(timer);
  }, [title, onDone]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence>
      {title && (
        <motion.div
          key={title}
          className="pointer-events-none fixed inset-x-0 top-24 z-[90] flex justify-center px-4"
          initial={reduced ? false : { opacity: 0, y: -8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: 0.2 } }}
          transition={SPRING_UI}
          data-testid="person-done-moment"
        >
          <p role="status" aria-live="polite" className="flex items-center gap-2 rounded-full border bg-popover px-5 py-3 font-headline text-lg font-semibold text-foreground shadow-overlay">
            <PartyPopper aria-hidden className="h-5 w-5 text-primary" />
            {title}
          </p>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
