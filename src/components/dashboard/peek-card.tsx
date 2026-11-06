'use client';

/**
 * Peek cards (H26): resting on (or keyboard-focusing) a link for 400 ms shows a
 * small card with its key facts. Pointer peeks run only on devices with a fine,
 * hovering pointer; touch never sees them. The card is supplementary (the link's
 * own name carries the same facts), never takes focus, and closes on Escape.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { SPRING_SNAPPY } from '@/lib/motion';
import { cn } from '@/lib/utils';

const PEEK_DELAY_MS = 400;
const CARD_WIDTH = 256;

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
  const [alignRight, setAlignRight] = useState(false);
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
      setAlignRight(Boolean(rect && rect.left + CARD_WIDTH > window.innerWidth - 16));
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
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      <AnimatePresence>
        {open && (
          <motion.div
            aria-hidden
            initial={{ opacity: 0, y: 4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97 }}
            transition={SPRING_SNAPPY}
            className={cn(
              'pointer-events-none absolute top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-3 text-left text-sm text-popover-foreground shadow-overlay',
              alignRight ? 'right-0' : 'left-0',
            )}
          >
            {peek}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
