'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Pill } from 'lucide-react';
import { cn } from '@/lib/utils';
import { chipOverflow, type MedicationDue } from '@/lib/pets/care';

const STATE_CLASSES: Record<MedicationDue['state'], string> = {
  overdue: 'border-destructive/40 bg-destructive/10 text-destructive',
  // Warning text stays on a 10% tint, the strength the AA preset check covers (PE-20c); "due" is told apart by its border.
  due: 'border-warning/80 bg-warning/10 text-warning',
  soon: 'border-warning/40 bg-warning/10 text-warning',
  upcoming: 'border-border bg-muted/60 text-muted-foreground',
};

/** "Nov 17": the due day, shown inline on touch screens where no hover title exists (PE-16b). */
export function chipDueDate(due: Pick<MedicationDue, 'due'>): string {
  return due.due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const interactive = 'relative z-10 text-left coarse:min-h-12 [@media(hover:hover)_and_(pointer:fine)]:hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Countdown chip for one medication's next dose; amber when due, red when
 * overdue. The whole status always shows and only the name truncates (PE-16a);
 * on touch the due date shows inline (PE-16b). With `onSelect` it is a button
 * (P3, PE-24b: a course's chip opens Give dose, a legacy one its confirmation on
 * the Medication tab); with `href` a link to the same.
 */
export function MedicationChip({ due, className, onSelect, href }: { due: MedicationDue; className?: string; onSelect?: (due: MedicationDue) => void; href?: string }) {
  const classes = cn('inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium coarse:text-sm', STATE_CLASSES[due.state], className);
  const content = (
    <>
      <Pill aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate font-semibold" data-testid="chip-name">{due.medication}</span>
      <span aria-hidden className="shrink-0">·</span>
      <span className="sr-only">, </span>
      <span className="shrink-0 whitespace-nowrap" data-testid="chip-status">{due.label}</span>
      <span className="hidden shrink-0 whitespace-nowrap coarse:inline" data-testid="chip-date">({chipDueDate(due)})</span>
    </>
  );
  const label = due.courseId ? `Give ${due.medication}, ${due.label}` : `${due.medication}, ${due.label}. Confirm its schedule`;
  const title = due.courseId ? `Give ${due.medication} (next dose ${chipDueDate(due)})` : `${due.medication}: confirm its schedule (next dose ${chipDueDate(due)})`;
  if (href) {
    return (
      <Link href={href} className={cn(classes, interactive)} title={title} aria-label={label} data-medication-state={due.state} data-course-id={due.courseId}>
        {content}
      </Link>
    );
  }
  if (onSelect) {
    return (
      <button
        type="button"
        className={cn(classes, interactive)}
        title={title}
        aria-label={label}
        data-medication-state={due.state}
        data-course-id={due.courseId}
        onClick={(event) => {
          // The chip's tap is its own (never the card's or a parent link's).
          event.preventDefault();
          event.stopPropagation();
          onSelect(due);
        }}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={classes} title={`${due.medication}: next dose ${chipDueDate(due)}`} data-medication-state={due.state}>
      {content}
    </span>
  );
}

/**
 * One countdown chip per current medication (H09), most urgent first (the order
 * of `currentMedications`). Past `max`, the rest fold into a "+N" chip; it is a
 * button that shows them all (PE-16c: reachable on touch, where its title
 * tooltip never appears), and its screen-reader text names them.
 */
export function MedicationChips({ dues, max = 2, className, onSelect, hrefFor }: {
  dues: MedicationDue[];
  max?: number;
  className?: string;
  onSelect?: (due: MedicationDue) => void;
  hrefFor?: (due: MedicationDue) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (dues.length === 0) return null;
  const { shown, hidden } = expanded ? { shown: dues, hidden: 0 } : chipOverflow(dues, max);
  const rest = dues.slice(shown.length);
  return (
    <ul className={cn('flex min-w-0 max-w-full flex-wrap gap-1.5', className)} aria-label="Medication countdowns" data-testid="medication-chips">
      {shown.map((due) => (
        <li key={due.courseId ?? `legacy:${due.legacyKey ?? due.medication.trim().toLowerCase()}`} className="min-w-0 max-w-full">
          <MedicationChip due={due} onSelect={onSelect} href={hrefFor?.(due)} />
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <button
            type="button"
            className={cn('inline-flex items-center rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground coarse:text-sm', interactive)}
            title={rest.map((due) => `${due.medication}: ${due.label}`).join('\n')}
            aria-expanded={false}
            data-testid="medication-chips-more"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(true);
            }}
          >
            <span aria-hidden>+{hidden}</span>
            <span className="sr-only">
              Show {hidden} more: {rest.map((due) => `${due.medication}, ${due.label}`).join('; ')}
            </span>
          </button>
        </li>
      )}
    </ul>
  );
}
