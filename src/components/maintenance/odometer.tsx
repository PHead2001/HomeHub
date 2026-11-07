'use client';

import { motion } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE, staggerDelay } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { mileageText, odometerDigits, wheelOffset } from '@/lib/maintenance/odometer';

const STRIP = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Vehicle mileage as a car odometer (H10): one wheel per digit, each rolling to
 * its digit (transform only, 550 ms, wheels a few ms apart) on mount and when
 * the mileage changes. Reduced motion shows the final digits at once. Screen
 * readers get the plain value ("48,750 miles"); the wheels are aria-hidden.
 */
export function Odometer({ miles, className }: { miles: number; className?: string }) {
  const reduced = useReducedMotion();
  const digits = odometerDigits(miles);
  const delay = staggerDelay(digits.length);

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} data-testid="odometer" data-value={Math.max(0, Math.floor(miles))}>
      <span className="sr-only">{mileageText(miles)}</span>
      <span aria-hidden className="inline-flex overflow-hidden rounded border border-border bg-foreground px-0.5 font-mono text-sm font-semibold leading-5 text-background">
        {digits.map((digit, i) => (
          // Keyed from the right, so a wheel keeps its place when the mileage gains a digit.
          <span key={digits.length - i} className="relative inline-block h-5 w-[1ch] overflow-hidden" data-digit={digit}>
            <motion.span
              className="absolute inset-x-0 top-0 flex flex-col"
              initial={reduced ? false : { y: '0%' }}
              animate={{ y: `${wheelOffset(digit)}%` }}
              transition={reduced ? { duration: 0 } : { duration: DURATION.data, ease: EASE.standard, delay: i * delay }}
            >
              {STRIP.map((n) => <span key={n} className="block h-5 text-center">{n}</span>)}
            </motion.span>
          </span>
        ))}
      </span>
      <span aria-hidden className="text-sm text-muted-foreground">mi</span>
    </span>
  );
}
