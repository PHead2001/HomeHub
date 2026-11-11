import { Pill } from 'lucide-react';
import { cn } from '@/lib/utils';
import { chipOverflow, type MedicationDue } from '@/lib/pets/care';

const STATE_CLASSES: Record<MedicationDue['state'], string> = {
  overdue: 'border-destructive/40 bg-destructive/10 text-destructive',
  due: 'border-warning/40 bg-warning/15 text-warning',
  soon: 'border-warning/40 bg-warning/10 text-warning',
  upcoming: 'border-border bg-muted/60 text-muted-foreground',
};

/** Countdown chip for one medication's next dose; amber when due, red when overdue. */
export function MedicationChip({ due, className }: { due: MedicationDue; className?: string }) {
  return (
    <span
      className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium coarse:text-sm', STATE_CLASSES[due.state], className)}
      title={`${due.medication}: next dose ${due.due.toLocaleDateString()}`}
      data-medication-state={due.state}
    >
      <Pill aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        <span className="font-semibold">{due.medication}</span>
        <span aria-hidden> · </span>
        <span className="sr-only">, </span>
        {due.label}
      </span>
    </span>
  );
}

/**
 * One countdown chip per current medication (H09), most urgent first (the order
 * of `currentMedications`). Past `max`, the rest fold into a "+N" chip whose
 * title and screen-reader text name them.
 */
export function MedicationChips({ dues, max = 2, className }: { dues: MedicationDue[]; max?: number; className?: string }) {
  if (dues.length === 0) return null;
  const { shown, hidden } = chipOverflow(dues, max);
  const rest = dues.slice(shown.length);
  return (
    <ul className={cn('flex min-w-0 flex-wrap gap-1.5', className)} aria-label="Medication countdowns" data-testid="medication-chips">
      {shown.map((due) => (
        <li key={due.medication.trim().toLowerCase()} className="min-w-0 max-w-full">
          <MedicationChip due={due} />
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
