import { Pill } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MedicationDue } from '@/lib/pets/care';

const STATE_CLASSES: Record<MedicationDue['state'], string> = {
  overdue: 'border-destructive/40 bg-destructive/10 text-destructive',
  due: 'border-warning/40 bg-warning/15 text-warning',
  soon: 'border-warning/40 bg-warning/10 text-warning',
  upcoming: 'border-border bg-muted/60 text-muted-foreground',
};

/** Countdown chip for the next medication dose; amber when due, red when overdue. */
export function MedicationChip({ due, className }: { due: MedicationDue; className?: string }) {
  return (
    <span
      className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', STATE_CLASSES[due.state], className)}
      title={`${due.medication}: next dose ${due.due.toLocaleDateString()}`}
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
