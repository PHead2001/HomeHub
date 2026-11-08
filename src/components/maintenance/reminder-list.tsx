'use client';

import { useRef, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'motion/react';
import { AlarmClock, ArrowUpRight, ClipboardPen, Loader2 } from 'lucide-react';
import type { MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { CompletionCheck } from '@/components/chores/completion-check';
import { useConfetti } from '@/components/chores/confetti';
import { PeekCard } from '@/components/dashboard/peek-card';
import { EmptyState } from '@/components/empty-state';
import { Stagger } from '@/components/motion/stagger';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { DURATION, EASE } from '@/lib/motion';
import { reminderDueDetail, reminderStatusLabel } from '@/lib/maintenance/reminder-copy';
import { canMarkReminderDone, canSnoozeReminder, reminderCycleKey, SNOOZE_DAYS } from '@/lib/maintenance/schedules';
import { cn } from '@/lib/utils';

export type ReminderBusy = { id: string; action: 'done' | 'snooze' } | null;

/** What Mark done did: completed in place, handed off to a dialog, or failed. */
export type MarkDoneResult = 'done' | 'deferred' | 'failed';

const badgeVariant = (status: MaintenanceReminder['status']) => {
  if (status === 'overdue') return 'destructive' as const;
  if (status === 'due_today') return 'default' as const;
  return 'secondary' as const;
};

// The StaggerItem entrance, on the list item itself: AnimatePresence needs the
// exit on its direct child.
const ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: { duration: DURATION.ui, ease: EASE.standard } },
};

/** Confetti pieces for a finished reminder: a small burst, like a one-step chore. */
const REMINDER_CONFETTI = 12;

/**
 * Reminder cards with in-place actions (D16): Mark done, Log service and Snooze
 * 1 week, plus Open for the asset or vehicle. Mark done is the H05 completion
 * check (`CompletionCheck` + `useConfetti` from Chores): the box fills, the
 * check draws itself and a small burst fires from it, then the card leaves the
 * list. Log service opens the log form filled in for that schedule. Actions a
 * member may not take are not shown. Cards enter with the shared stagger; under
 * reduced motion everything is instant and there is no confetti.
 */
export function ReminderList({
  reminders,
  today,
  emptyTitle,
  emptyDescription,
  canComplete,
  canLog,
  canSnooze,
  busy,
  completesInPlace,
  onOpen,
  onMarkDone,
  onLogService,
  onSnooze,
}: {
  reminders: MaintenanceReminder[];
  today: string;
  emptyTitle: string;
  emptyDescription: string;
  canComplete: boolean;
  canLog: boolean;
  canSnooze: boolean;
  busy: ReminderBusy;
  /** True when Mark done finishes without asking, so the check can draw at once. */
  completesInPlace: (reminder: MaintenanceReminder) => boolean;
  onOpen: (reminder: MaintenanceReminder) => void;
  onMarkDone: (reminder: MaintenanceReminder) => Promise<MarkDoneResult>;
  onLogService: (reminder: MaintenanceReminder) => void;
  onSnooze: (reminder: MaintenanceReminder) => void;
}) {
  const reduced = useReducedMotion();
  const { burst, layer } = useConfetti();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const celebrated = useRef(new Set<string>());
  const checkRefs = useRef(new Map<string, HTMLButtonElement>());

  if (reminders.length === 0) {
    return <EmptyState compact headingLevel={3} title={emptyTitle} description={emptyDescription} />;
  }

  // Keyed by cycle, not reminder id: a schedule completed early can show its next
  // cycle under the same id, and that card must start unchecked.
  const markDone = async (reminder: MaintenanceReminder) => {
    const cycle = reminderCycleKey(reminder);
    if (completesInPlace(reminder)) {
      setChecked((previous) => new Set(previous).add(cycle));
      // Never twice for one cycle, even if a retry is needed.
      if (!celebrated.current.has(cycle)) {
        celebrated.current.add(cycle);
        burst(checkRefs.current.get(reminder.id)?.getBoundingClientRect(), REMINDER_CONFETTI);
      }
    }
    const result = await onMarkDone(reminder);
    if (result !== 'done') {
      setChecked((previous) => {
        const next = new Set(previous);
        next.delete(cycle);
        return next;
      });
    }
  };

  return (
    <>
      {layer}
      <Stagger as="ul" count={reminders.length} className="space-y-3">
        <AnimatePresence>
          {reminders.map((reminder) => {
            const subject = `${reminder.title} for ${reminder.relatedName}`;
            const isBusy = busy?.id === reminder.id;
            const completable = canMarkReminderDone(reminder);
            const showDone = canComplete && completable;
            const showLog = canLog && completable;
            const showSnooze = canSnooze && canSnoozeReminder(reminder);
            const detail = reminderDueDetail(reminder, today);
            const isChecked = checked.has(reminderCycleKey(reminder));
            return (
              <motion.li
                key={reminder.id}
                variants={ITEM_VARIANTS}
                layout={reduced ? false : 'position'}
                exit={reduced
                  ? { opacity: 0, transition: { duration: 0 } }
                  : { opacity: 0, scale: 0.98, transition: { duration: DURATION.ui, ease: EASE.exit, delay: isChecked ? DURATION.micro : 0 } }}
                data-testid={`maintenance-reminder-${reminder.id}`}
                data-done={isChecked ? 'true' : undefined}
                className="rounded-lg border bg-card p-4 shadow-raised"
              >
                <div className="flex items-start gap-2">
                  {showDone && (
                    <CompletionCheck
                      ref={(node) => {
                        if (node) checkRefs.current.set(reminder.id, node);
                        else checkRefs.current.delete(reminder.id);
                      }}
                      checked={isChecked}
                      label={`Mark done: ${subject}`}
                      disabled={Boolean(busy) || isChecked}
                      className="-my-2 -ml-2"
                      onToggle={() => void markDone(reminder)}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className={cn('font-headline text-base font-semibold transition-ui', isChecked && 'text-muted-foreground line-through')}>{reminder.title}</h3>
                      <Badge variant={badgeVariant(reminder.status)}>{reminderStatusLabel(reminder.group, reminder.status)}</Badge>
                      {isBusy && busy?.action === 'done' && <Loader2 role="status" aria-label="Saving" className="h-4 w-4 animate-spin text-muted-foreground" />}
                    </div>
                    <p className="mt-1 text-sm">{reminder.relatedName}</p>
                    {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {showLog && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy) || isChecked}
                      aria-label={`Log service: ${subject}`}
                      title="Record cost, provider and parts, and mark it done"
                      onClick={() => onLogService(reminder)}
                    >
                      <ClipboardPen aria-hidden className="mr-2 h-4 w-4" />
                      Log service
                    </Button>
                  )}
                  {showSnooze && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={Boolean(busy) || isChecked}
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
                  <PeekCard
                    className={cn((showLog || showSnooze) && 'sm:ml-auto')}
                    peek={(
                      <div className="space-y-1">
                        <p className="font-headline font-semibold">{reminder.relatedName}</p>
                        <p className="text-muted-foreground">{reminder.title}</p>
                        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
                        <p className="text-xs text-muted-foreground">{reminder.targetType === 'vehicle' ? 'Opens the vehicle' : 'Opens the home asset'}</p>
                      </div>
                    )}
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Open: ${subject}`}
                      onClick={() => onOpen(reminder)}
                    >
                      Open
                      <ArrowUpRight aria-hidden className="ml-1 h-4 w-4" />
                    </Button>
                  </PeekCard>
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </Stagger>
    </>
  );
}
