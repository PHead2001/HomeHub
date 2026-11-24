'use client';

import { useEffect, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { CalendarPlus, QrCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { maintenanceDeepLink, type LabelTarget } from '@/lib/maintenance/qr-label';
import { cn, stableSlugify } from '@/lib/utils';

// The label (QR drawing and print rules) loads only when someone opens it (MA-31, MA-25).
const PrintLabel = dynamic(() => import('./print-label').then((module) => module.PrintLabel), { ssr: false });

/** Scrolls a highlighted schedule into view once its row exists (also inside the phone sheet). */
export function useScrollToSchedule(scheduleKey: string | null, present: boolean) {
  useEffect(() => {
    if (!scheduleKey || !present) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(`maintenance-schedule-${stableSlugify(scheduleKey)}`)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [scheduleKey, present]);
}

/**
 * One schedule of an asset or vehicle: its name, when it is next due, how often, and its
 * service history line ("Replace filter last done 3 months ago by Sam", MA-32). A checklist
 * item has no due date: it says so and offers "Add a due date" (the record's edit form).
 */
export function ScheduleRow({
  scheduleKey,
  testId,
  highlighted,
  name,
  checklist,
  dueLine,
  repeatLine,
  historyLine,
  completeLabel,
  onComplete,
  onAddDueDate,
}: {
  scheduleKey: string;
  testId: string;
  highlighted: boolean;
  name: string;
  checklist: boolean;
  dueLine?: string;
  repeatLine?: string;
  historyLine?: string | null;
  /** Accessible name of Complete; omitted when the member cannot complete. */
  completeLabel?: string;
  onComplete?: () => void;
  /** Opens the record's edit form; omitted when the member cannot edit. */
  onAddDueDate?: () => void;
}) {
  return (
    <div
      id={`maintenance-schedule-${stableSlugify(scheduleKey)}`}
      data-testid={testId}
      className={cn('rounded-lg border p-3', highlighted && 'ring-2 ring-primary')}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{name}</p>
          {checklist ? (
            <p className="text-sm text-muted-foreground">No due date yet. Add one to get reminders.</p>
          ) : (
            <>
              {dueLine && <p className="text-sm text-muted-foreground">{dueLine}</p>}
              {repeatLine && <p className="text-xs text-muted-foreground">{repeatLine}</p>}
            </>
          )}
          {historyLine && <p className="mt-1 text-xs text-muted-foreground" data-testid="schedule-history">{historyLine}</p>}
        </div>
        {checklist
          ? onAddDueDate && (
            <Button type="button" variant="outline" size="sm" className="shrink-0" aria-label={`Add a due date: ${name}`} onClick={onAddDueDate}>
              <CalendarPlus aria-hidden className="mr-2 h-4 w-4" />
              Add a due date
            </Button>
          )
          : onComplete && (
            <Button type="button" variant="outline" size="sm" className="shrink-0" aria-label={completeLabel} onClick={onComplete}>
              Complete
            </Button>
          )}
      </div>
    </div>
  );
}

/** A titled block of the detail panel. */
export function DetailSection({ title, children, className, testId }: { title: string; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={cn('space-y-2', className)} data-testid={testId}>
      <h3 className="font-headline font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * "Print label" (MA-31): shows the record's QR label (`PrintLabel`, loaded on first open) with
 * its own Print button. The QR holds `maintenanceDeepLink(window.location.origin, …)` only.
 */
export function LabelSection({ target, name, location }: { target: LabelTarget; name: string; location?: string | null }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const toggle = () => {
    if (!open) setUrl(maintenanceDeepLink(window.location.origin, target));
    setOpen((value) => !value);
  };
  return (
    <div className="space-y-3" data-testid="maintenance-print-label">
      <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={toggle}>
        <QrCode aria-hidden className="mr-2 h-4 w-4" />
        {open ? 'Hide label' : 'Print label'}
      </Button>
      {open && url && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Stick it on the {target.type === 'vehicle' ? 'vehicle' : 'item'}: scanning it opens this page in HomeHub.</p>
          <PrintLabel name={name} location={location} url={url} />
        </div>
      )}
    </div>
  );
}
