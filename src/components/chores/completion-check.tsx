'use client';

import { forwardRef } from 'react';
import { motion } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';

type CompletionCheckProps = {
  checked: boolean;
  /** Accessible name, e.g. "Mark Reset the kitchen done". */
  label: string;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
};

/**
 * The "done" checkbox (H05): the box fills and a check draws itself (≤ 150 ms).
 * A 40 px hit area around a 24 px box; the box never moves. Under reduced motion
 * the end state shows instantly.
 */
export const CompletionCheck = forwardRef<HTMLButtonElement, CompletionCheckProps>(function CompletionCheck(
  { checked, label, disabled, onToggle, className },
  ref,
) {
  const reduced = useReducedMotion();
  return (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn('group grid h-10 w-10 shrink-0 place-items-center rounded-md disabled:cursor-not-allowed', className)}
    >
      <span
        aria-hidden
        className={cn(
          'grid h-6 w-6 place-items-center rounded-md border-2 transition-ui',
          checked ? 'border-success bg-success text-success-foreground' : 'border-border bg-background text-transparent',
          !checked && !disabled && 'group-hover:border-primary',
          disabled && !checked && 'opacity-50',
        )}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4">
          <motion.path
            d="M5 12.5l4.5 4.5L19 7.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={false}
            animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.15, ease: 'easeOut' }}
          />
        </svg>
      </span>
    </button>
  );
});
