'use client';

/**
 * Peek cards (H26): resting on (or keyboard-focusing) a link for 400 ms shows a
 * small card with its key facts. Pointer peeks run only on devices with a fine,
 * hovering pointer; touch never sees them. The card is supplementary (the link's
 * own name carries the same facts), never takes focus, and closes on Escape.
 * The card renders in a portal on document.body with fixed positioning, so no
 * clipping ancestor (the living house, bento tiles) can cut it off; it opens
 * below the anchor, or above it when there is not enough room below.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { SPRING_SNAPPY } from '@/lib/motion';
import { isComposingKey } from '@/lib/dashboard/shortcuts';
import { cn } from '@/lib/utils';
import { placePeek, type PeekPlacement } from '@/lib/dashboard/peek';

const PEEK_DELAY_MS = 400;
const canHover = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

export function PeekCard({
  peek,
  children,
  className,
}: {
  /** Card content; when null the wrapper renders children only. */
  peek: ReactNode | null;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PeekPlacement | null>(null);
  const timer = useRef<number | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const schedule = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => {
      const rect = wrapper.current?.getBoundingClientRect();
      if (!rect) return;
      setPlacement(placePeek(rect, { width: window.innerWidth, height: window.innerHeight }));
      setOpen(true);
    }, PEEK_DELAY_MS);
  }, []);
  const close = useCallback(() => {
    clear();
    setOpen(false);
  }, []);

  useEffect(() => () => clear(), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isComposingKey(event)) close();
    };
    // A fixed card would drift from its anchor on scroll or resize; close instead.
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  if (!peek) return <div className={className}>{children}</div>;

  return (
    <div
      ref={wrapper}
      className={cn('relative', className)}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse' && canHover()) schedule();
      }}
      onPointerLeave={close}
      onPointerDown={close}
      onFocus={(event) => {
        // Only keyboard focus (focus-visible) peeks; a click focuses too.
        if ((event.target as HTMLElement).matches?.(':focus-visible')) schedule();
      }}
      onBlur={close}
    >
      {children}
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {open && placement && (
            <motion.div
              aria-hidden
              data-peek-card
              initial={{ opacity: 0, y: placement.above ? -4 : 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: placement.above ? -4 : 4, scale: 0.97 }}
              transition={SPRING_SNAPPY}
              style={{ left: placement.left, top: placement.top, bottom: placement.bottom }}
              className="pointer-events-none fixed z-50 w-64 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-3 text-left text-sm text-popover-foreground shadow-overlay"
            >
              {peek}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
