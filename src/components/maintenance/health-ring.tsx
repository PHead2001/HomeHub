'use client';

import { motion } from 'motion/react';
import { NumberTicker } from '@/components/motion/number-ticker';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { HEALTH_BAND_LABELS, healthSummaryText, type HealthBand } from '@/lib/maintenance/health';

const BAND_TEXT: Record<HealthBand, string> = {
  good: 'text-success',
  fair: 'text-warning',
  poor: 'text-destructive',
};

const SIZES = {
  sm: { box: 40, stroke: 4, text: 'text-xs' },
  lg: { box: 132, stroke: 10, text: 'text-4xl' },
} as const;

/**
 * Progress ring for a 0-100 health score (H10). The arc sweeps up on mount and
 * to new values (550 ms, value only); reduced motion shows the end state at once. The ring has a fixed size
 * so nothing shifts while it fills.
 */
export function HealthRing({
  score,
  band,
  size = 'sm',
  label,
  className,
}: {
  score: number;
  band: HealthBand;
  size?: keyof typeof SIZES;
  /** Accessible name prefix, e.g. "Main HVAC System health". */
  label: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const { box, stroke, text } = SIZES[size];
  const radius = (box - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);

  return (
    <div
      role="img"
      aria-label={healthSummaryText(label, { score, band })}
      className={cn('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: box, height: box }}
      data-health-band={band}
    >
      <svg aria-hidden width={box} height={box} viewBox={`0 0 ${box} ${box}`} className="-rotate-90">
        <circle cx={box / 2} cy={box / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-muted" />
        <motion.circle
          cx={box / 2}
          cy={box / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={reduced ? false : { strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={reduced ? { duration: 0 } : { duration: DURATION.data, ease: EASE.standard }}
          className={BAND_TEXT[band]}
        />
      </svg>
      <span aria-hidden className={cn('absolute font-headline font-semibold tabular-nums', text)}>
        {size === 'lg' ? <NumberTicker value={score} /> : score}
      </span>
    </div>
  );
}

export function healthBandLabel(band: HealthBand) {
  return HEALTH_BAND_LABELS[band];
}

export const HEALTH_BAND_TEXT_CLASS = BAND_TEXT;
