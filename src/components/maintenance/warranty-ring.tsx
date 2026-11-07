'use client';

import { motion } from 'motion/react';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { warrantyCountdownText, warrantyRingLabel, type WarrantyCountdown } from '@/lib/maintenance/warranty';

const BOX = 40;
const STROKE = 4;
const RADIUS = (BOX - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Under a month left the ring turns amber. */
const SOON_DAYS = 30;

/**
 * Warranty countdown ring (H10): the share of the warranty term still left, with
 * the days left inside. It sweeps down from full on mount (550 ms, value only);
 * reduced motion shows the end state at once. Fixed size, so nothing shifts.
 */
export function WarrantyRing({ countdown, name, className }: { countdown: WarrantyCountdown; name: string; className?: string }) {
  const reduced = useReducedMotion();
  const offset = CIRCUMFERENCE * (1 - countdown.fraction);
  const tone = countdown.expired ? 'text-muted-foreground' : countdown.daysLeft <= SOON_DAYS ? 'text-warning' : 'text-primary';
  const text = warrantyCountdownText(countdown);

  return (
    <div
      role="img"
      aria-label={`${name}: ${text}`}
      title={text}
      className={cn('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: BOX, height: BOX }}
      data-testid="warranty-ring"
      data-days-left={countdown.daysLeft}
      data-term-days={countdown.termDays}
    >
      <svg aria-hidden width={BOX} height={BOX} viewBox={`0 0 ${BOX} ${BOX}`} className="-rotate-90">
        <circle cx={BOX / 2} cy={BOX / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-muted" />
        <motion.circle
          cx={BOX / 2}
          cy={BOX / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          initial={reduced ? false : { strokeDashoffset: 0 }}
          animate={{ strokeDashoffset: offset }}
          transition={reduced ? { duration: 0 } : { duration: DURATION.data, ease: EASE.standard }}
          className={cn(tone, countdown.fraction === 0 && 'opacity-0')}
        />
      </svg>
      <span aria-hidden className="absolute font-headline text-[10px] font-semibold tabular-nums text-foreground">
        {warrantyRingLabel(countdown)}
      </span>
    </div>
  );
}
