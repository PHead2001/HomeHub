'use client';

import { AnimatePresence, motion } from 'motion/react';
import { AlarmClock, ArrowUpRight, Check, Loader2 } from 'lucide-react';
import type { MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE } from '@/lib/motion';
import { reminderDueDetail, reminderStatusLabel } from '@/lib/maintenance/reminder-copy';
import { canMarkReminderDone, canSnoozeReminder, SNOOZE_DAYS } from '@/lib/maintenance/schedules';
import { cn } from '@/lib/utils';

export type ReminderBusy = { id: string; action: 'done' | 'snooze' } | null;

const badgeVariant = (status: MaintenanceReminder['status']) => {
  if (status === 'overdue') return 'destructive' as const;
  if (status === 'due_today') return 'default' as const;
  return 'secondary' as const;
};

/**
 * Reminder cards with in-place actions (D16): Mark done, Snooze 1 week and Open.
 * Actions a member is not allowed to take are not shown. A card that leaves the
 * list (done, snoozed out of the window) fades out in 200 ms; under reduced
 * motion it is removed at once.
 */
export function ReminderList({
  reminders,
  today,
  emptyTitle,
  emptyDescription,
  canComplete,
  canSnooze,
  busy,
  onOpen,
  onMarkDone,
  onSnooze,
}: {
  reminders: MaintenanceReminder[];
  today: string;
  emptyTitle: string;
  emptyDescription: string;
  canComplete: boolean;
  canSnooze: boolean;
  busy: ReminderBusy;
  onOpen: (reminder: MaintenanceReminder) => void;
  onMarkDone: (reminder: MaintenanceReminder) => void;
  onSnooze: (reminder: MaintenanceReminder) => void;
}) {
  const reduced = useReducedMotion();

  if (reminders.length === 0) {
    return <EmptyState compact headingLevel={3} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <ul className="space-y-3">
      <AnimatePresence initial={false}>
        {reminders.map((reminder) => {
          const subject = `${reminder.title} for ${reminder.relatedName}`;
          const isBusy = busy?.id === reminder.id;
          const showDone = canComplete && canMarkReminderDone(reminder);
          const showSnooze = canSnooze && canSnoozeReminder(reminder);
          const detail = reminderDueDetail(reminder, today);
          return (
            <motion.li
              key={reminder.id}
              layout={reduced ? false : 'position'}
              exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.98, transition: { duration: DURATION.ui, ease: EASE.exit } }}
              data-testid={`maintenance-reminder-${reminder.id}`}
              className="rounded-lg border bg-card p-4 shadow-raised"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-headline text-base font-semibold">{reminder.title}</h3>
                <Badge variant={badgeVariant(reminder.status)}>{reminderStatusLabel(reminder.group, reminder.status)}</Badge>
              </div>
              <p className="mt-1 text-sm">{reminder.relatedName}</p>
              {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {showDone && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy)}
                    aria-label={`Mark done: ${subject}`}
                    onClick={() => onMarkDone(reminder)}
                  >
                    {isBusy && busy?.action === 'done'
                      ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
                      : <Check aria-hidden className="mr-2 h-4 w-4" />}
                    Mark done
                  </Button>
                )}
                {showSnooze && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={Boolean(busy)}
                    aria-label={`Snooze 1 week: ${subject}`}
                    title={`Move the due date ${SNOOZE_DAYS} days later`}
                    onClick={() => onSnooze(reminder)}
                  >
                    {isBusy && busy?.action === 'snooze'
                      ? <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />
                      : <AlarmClock aria-hidden className="mr-2 h-4 w-4" />}
                    Snooze 1 week
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn((showDone || showSnooze) && 'sm:ml-auto')}
                  aria-label={`Open: ${subject}`}
                  onClick={() => onOpen(reminder)}
                >
                  Open
                  <ArrowUpRight aria-hidden className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
