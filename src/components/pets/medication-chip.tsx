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

/**
 * Countdown chip for one medication's next dose; amber when due, red when
 * overdue. With `onSelect` it is a button (P3, PE-24b): a course's chip opens
 * Give dose, a legacy one its confirmation on the Medication tab.
 */
export function MedicationChip({ due, className, onSelect }: { due: MedicationDue; className?: string; onSelect?: (due: MedicationDue) => void }) {
  const classes = cn('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium coarse:text-sm', STATE_CLASSES[due.state], className);
  const content = (
    <>
      <Pill aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        <span className="font-semibold">{due.medication}</span>
        <span aria-hidden> · </span>
        <span className="sr-only">, </span>
        {due.label}
      </span>
    </>
  );
  if (onSelect) {
    return (
      <button
        type="button"
        className={cn(classes, 'relative z-10 text-left coarse:min-h-12 [@media(hover:hover)_and_(pointer:fine)]:hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
        title={due.courseId ? `Give ${due.medication}` : `${due.medication}: confirm its schedule`}
        aria-label={due.courseId ? `Give ${due.medication}, ${due.label}` : `${due.medication}, ${due.label}. Confirm its schedule`}
        data-medication-state={due.state}
        data-course-id={due.courseId}
        onClick={(event) => {
          // The card's stretched link sits under the chip: the chip's tap is its own.
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
    <span className={classes} title={`${due.medication}: next dose ${due.due.toLocaleDateString()}`} data-medication-state={due.state}>
      {content}
    </span>
  );
}

/**
 * One countdown chip per current medication (H09), most urgent first (the order
 * of `currentMedications`). Past `max`, the rest fold into a "+N" chip whose
 * title and screen-reader text name them.
 */
export function MedicationChips({ dues, max = 2, className, onSelect }: { dues: MedicationDue[]; max?: number; className?: string; onSelect?: (due: MedicationDue) => void }) {
  if (dues.length === 0) return null;
  const { shown, hidden } = chipOverflow(dues, max);
  const rest = dues.slice(shown.length);
  return (
    <ul className={cn('flex min-w-0 flex-wrap gap-1.5', className)} aria-label="Medication countdowns" data-testid="medication-chips">
      {shown.map((due) => (
        <li key={due.courseId ?? `legacy:${due.legacyKey ?? due.medication.trim().toLowerCase()}`} className="min-w-0 max-w-full">
          <MedicationChip due={due} onSelect={onSelect} />
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <span
            className="inline-flex items-center rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground"
            title={rest.map((due) => `${due.medication}: ${due.label}`).join('\n')}
            data-testid="medication-chips-more"
          >
            <span aria-hidden>+{hidden}</span>
            <span className="sr-only">
              and {hidden} more: {rest.map((due) => `${due.medication}, ${due.label}`).join('; ')}
            </span>
          </span>
        </li>
      )}
    </ul>
  );
}
