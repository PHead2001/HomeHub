import { cn } from '@/lib/utils';
import type { FeedingStatus } from '@/lib/pets/care';
import styles from './pets.module.css';

const R = 20;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * Ring that fills per feeding today ("1 of 2"). The fill animates as a data
 * change (500 ms) and is static under reduced motion. Decorative: the same
 * information is printed next to it.
 */
export function FeedingRing({ status, className }: { status: FeedingStatus; className?: string }) {
  const offset = CIRCUMFERENCE * (1 - status.progress);
  return (
    <div className={cn('relative h-12 w-12 shrink-0', className)} aria-hidden>
      <svg viewBox="0 0 48 48" className="h-full w-full -rotate-90">
        <circle cx="24" cy="24" r={R} fill="none" strokeWidth="4" className="stroke-muted" />
        <circle
          cx="24"
          cy="24"
          r={R}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          className={cn(styles.ringFill, status.complete ? 'stroke-success' : 'stroke-primary', status.progress === 0 && 'opacity-0')}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-headline text-xs font-semibold tabular-nums text-foreground">
        {status.perDay ? `${status.fedToday}/${status.perDay}` : status.fedToday}
      </span>
    </div>
  );
}
