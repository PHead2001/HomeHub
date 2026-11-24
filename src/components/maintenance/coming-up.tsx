'use client';

import { useId } from 'react';
import { format } from 'date-fns';
import { Car, ChevronRight, FileText, Gauge, ShieldCheck, Wrench } from 'lucide-react';
import type { MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { diffDays } from '@functions/shared/calendar';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { comingUpByMonth, COMING_UP_DAYS, type ComingUp as ComingUpData, type ComingUpEntry } from '@/lib/maintenance/coming-up';
import { reminderBadgeLabel, spanLabel } from '@/lib/maintenance/reminder-copy';
import { cn } from '@/lib/utils';

const ICONS = {
  scheduled: Wrench,
  vehicle_service: Car,
  warranty: ShieldCheck,
  vehicle_document: FileText,
} as const;

const verbFor = (reminder: MaintenanceReminder) => (reminder.group === 'warranty' || reminder.group === 'vehicle_document' ? 'Expires' : 'Due');

const whenText = (entry: ComingUpEntry, today: string) => {
  if (!entry.date) return '';
  const days = diffDays(entry.date, today);
  const relative = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${spanLabel(days)}`;
  const day = format(new Date(`${entry.date}T12:00:00`), 'EEE, MMM d');
  return `${entry.predicted ? 'Expected' : verbFor(entry.reminder)} ${day} · ${relative}`;
};

function EntryButton({ entry, line, onOpen }: { entry: ComingUpEntry; line: string; onOpen: (reminder: MaintenanceReminder) => void }) {
  const { reminder } = entry;
  const Icon = ICONS[reminder.group];
  const badge = reminder.snoozed ? reminderBadgeLabel(reminder) : null;
  return (
    <button
      type="button"
      onClick={() => onOpen(reminder)}
      className={cn(
        'flex min-h-[var(--target-min)] w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-ui hover:bg-accent',
        reminder.snoozed && 'text-muted-foreground',
      )}
    >
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
        <span className="font-medium">{reminder.title}</span>
        <span className="text-muted-foreground"> · {reminder.relatedName}</span>
        <span className="block text-xs text-muted-foreground">{line}</span>
      </span>
      {badge && <Badge variant="outline">{badge}</Badge>}
      <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * Coming up (MA-27a): a timeline of the next `days` days, grouped by month, then
 * services due by mileage with no date, by miles left. Each row opens its asset
 * or vehicle (a full-width button at least `--target-min` tall: 44 px, 48 px on
 * touch screens). Static: no motion, so reduced motion needs nothing.
 * Build `data` with `comingUp(reminders, today)`.
 */
export function ComingUp({
  data,
  today,
  days = COMING_UP_DAYS,
  onOpen,
  className,
}: {
  data: ComingUpData;
  today: string;
  days?: number;
  onOpen: (reminder: MaintenanceReminder) => void;
  className?: string;
}) {
  const baseId = useId();
  const months = comingUpByMonth(data.dated);
  if (months.length === 0 && data.byMileage.length === 0) {
    return (
      <EmptyState
        compact
        headingLevel={3}
        title="Nothing coming up"
        description={`Nothing is due or expiring in the next ${days} days.`}
      />
    );
  }
  return (
    <div data-testid="maintenance-coming-up" className={cn('space-y-4', className)}>
      {months.map((month) => (
        <section key={month.month} aria-labelledby={`${baseId}-${month.month}`}>
          <h3 id={`${baseId}-${month.month}`} className="mb-1 font-headline text-sm font-semibold">{month.label}</h3>
          <ol className="space-y-1 border-l pl-3">
            {month.entries.map((entry) => (
              <li key={`${entry.reminder.id}-${entry.date}`}>
                <EntryButton entry={entry} line={whenText(entry, today)} onOpen={onOpen} />
              </li>
            ))}
          </ol>
        </section>
      ))}
      {data.byMileage.length > 0 && (
        <section aria-labelledby={`${baseId}-miles`}>
          <h3 id={`${baseId}-miles`} className="mb-1 flex items-center gap-2 font-headline text-sm font-semibold">
            <Gauge aria-hidden className="h-4 w-4 text-muted-foreground" />
            By mileage
          </h3>
          <ol className="space-y-1 border-l pl-3">
            {data.byMileage.map((entry) => (
              <li key={entry.reminder.id}>
                <EntryButton
                  entry={entry}
                  line={`At ${entry.reminder.dueMileage?.toLocaleString('en-US')} mi · ${entry.milesLeft?.toLocaleString('en-US')} mi to go`}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
