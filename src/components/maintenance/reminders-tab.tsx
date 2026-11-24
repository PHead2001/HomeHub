'use client';

import * as React from 'react';
import type { MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { EXPIRY_WARNING_DAYS, MILEAGE_DUE_SOON_THRESHOLD, REMINDER_DUE_SOON_DAYS } from '@functions/shared/maintenance-reminders';
import { EmptyState } from '@/components/empty-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import type { ComingUp as ComingUpData } from '@/lib/maintenance/coming-up';
import { COMING_UP_DAYS } from '@/lib/maintenance/coming-up';
import type { FilterChip } from '@/lib/maintenance/filters';
import {
  REMINDER_KIND_LABELS, REMINDER_KIND_ORDER, reminderGroups, type ReminderGroupKey, type ReminderKind,
} from '@/lib/maintenance/reminder-groups';
import { ComingUp } from './coming-up';
import { FilterChips } from './filter-chips';
import { ReminderActionsHint, ReminderList } from './reminder-list';

export type ReminderListShared = Omit<React.ComponentProps<typeof ReminderList>, 'reminders' | 'emptyTitle' | 'emptyDescription'>;

type RemindersTabProps = {
  /** Every reminder that passes the page filters (upcoming expiries included, 90 days ahead). */
  reminders: MaintenanceReminder[];
  comingUp: ComingUpData;
  today: string;
  reminderListProps: ReminderListShared;
  /** Bumped by a successful Undo: the lists start over (see the page). */
  reminderListEpoch: number;
  onOpen: (reminder: MaintenanceReminder) => void;
};

const GROUP_HINTS: Record<ReminderGroupKey, string> = {
  overdue: 'Past their date or mileage, or expired.',
  due_today: 'Due or expiring today.',
  due_soon: `Due in the next ${REMINDER_DUE_SOON_DAYS} days or ${MILEAGE_DUE_SOON_THRESHOLD} miles; warranties, registrations and inspections expiring in the next ${EXPIRY_WARNING_DAYS} days.`,
  snoozed: 'Moved a week later. They come back on their new date.',
  upcoming: 'Later on. Nothing to do yet.',
};

/**
 * Reminders (MA-13): one list grouped by urgency (Overdue or expired, Due today, Due soon,
 * Snoozed, Upcoming), each reminder exactly once, with kind chips and their counts
 * (`reminderGroups`), the in-place actions, and the 90-day Coming up beside it (MA-27a).
 */
export const RemindersTab = React.memo(function RemindersTab({
  reminders, comingUp, today, reminderListProps, reminderListEpoch, onOpen,
}: RemindersTabProps) {
  const [kind, setKind] = React.useState<ReminderKind | 'all'>('all');
  const view = React.useMemo(() => reminderGroups(reminders, kind), [reminders, kind]);
  const chips = React.useMemo<FilterChip[]>(
    () => REMINDER_KIND_ORDER.filter((value) => view.kinds[value] > 0 || value === kind)
      .map((value) => ({ value, label: REMINDER_KIND_LABELS[value], count: view.kinds[value] })),
    [view.kinds, kind],
  );
  const shown = view.groups.filter((group) => group.reminders.length > 0);

  return (
    <TabsContent value="reminders" className="pt-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
        <Card className="min-w-0" data-testid="reminders-list">
          <CardHeader className="space-y-3">
            <div>
              <CardTitle className="font-headline">Reminders</CardTitle>
              <CardDescription>
                {view.counts.overdue} overdue or expired · {view.counts.dueToday} due today · {view.counts.dueSoon} due soon
                {view.counts.snoozed > 0 ? ` · ${view.counts.snoozed} snoozed` : ''}
              </CardDescription>
            </div>
            <FilterChips
              label="Kind of reminder"
              chips={chips}
              selected={kind === 'all' ? null : kind}
              allLabel={`All ${view.kinds.all}`}
              onSelect={(value) => setKind((value as ReminderKind | null) ?? 'all')}
            />
            <ReminderActionsHint canLog={reminderListProps.canLog} canSnooze={reminderListProps.canSnooze} />
          </CardHeader>
          <CardContent className="space-y-6">
            {shown.length === 0 ? (
              <EmptyState
                compact
                headingLevel={3}
                title="No reminders"
                description={kind === 'all' ? 'Add schedules, warranty dates or vehicle dates and their reminders will show here.' : 'Nothing of this kind right now.'}
              />
            ) : shown.map((group) => (
              <section key={group.key} aria-labelledby={`reminders-group-${group.key}-title`} data-testid={`reminders-group-${group.key}`} className="space-y-3">
                <div>
                  <h3 id={`reminders-group-${group.key}-title`} className="font-headline text-base font-semibold">
                    {group.label} <span className="tabular-nums text-muted-foreground">({group.reminders.length})</span>
                  </h3>
                  <p className="text-xs text-muted-foreground">{GROUP_HINTS[group.key]}</p>
                </div>
                <ReminderList
                  key={reminderListEpoch}
                  {...reminderListProps}
                  reminders={group.reminders}
                  emptyTitle=""
                  emptyDescription=""
                />
              </section>
            ))}
          </CardContent>
        </Card>

        <Card className="min-w-0 self-start" data-testid="reminders-coming-up">
          <CardHeader>
            <CardTitle className="font-headline">Coming up</CardTitle>
            <CardDescription>The next {COMING_UP_DAYS} days, then services due by mileage.</CardDescription>
          </CardHeader>
          <CardContent>
            <ComingUp data={comingUp} today={today} days={COMING_UP_DAYS} onOpen={onOpen} />
          </CardContent>
        </Card>
      </div>
    </TabsContent>
  );
});
