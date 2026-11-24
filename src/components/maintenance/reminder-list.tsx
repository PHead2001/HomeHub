'use client';

import { useRef, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'motion/react';
import { AlarmClock, ArrowUpRight, ClipboardPen, Gauge, Loader2 } from 'lucide-react';
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
import { reminderBadgeLabel, reminderDueDetail, reminderSnoozeLabel } from '@/lib/maintenance/reminder-copy';
import { canMarkReminderDone, canSnoozeReminder, reminderCycleKey, SNOOZE_DAYS } from '@/lib/maintenance/schedules';
import { cn } from '@/lib/utils';

export type ReminderBusy = { id: string; action: 'done' | 'snooze' } | null;

/** What Mark done did: completed in place, handed off to a dialog, or failed. */
export type MarkDoneResult = 'done' | 'deferred' | 'failed';

const badgeVariant = (status: MaintenanceReminder['status'], snoozed?: boolean) => {
  if (snoozed && (status === 'upcoming' || status === 'due_soon')) return 'outline' as const;
  if (status === 'overdue') return 'destructive' as const;
  if (status === 'due_today') return 'default' as const;
  if (status === 'due_soon') return 'outline' as const;
  return 'secondary' as const;
};

/** "Due soon" reads as a warning, not a neutral tag (MA-24): amber border and tint. */
const badgeClass = (status: MaintenanceReminder['status'], snoozed?: boolean) =>
  (status === 'due_soon' && !snoozed ? 'border-warning bg-warning/15 text-foreground' : undefined);

/**
 * What Log service and Snooze do, said once above a list of reminder cards, so it is visible
 * on touch screens too (MA-23: no hover-only text).
 */
export function ReminderActionsHint({ canLog, canSnooze, className }: { canLog: boolean; canSnooze: boolean; className?: string }) {
  if (!canLog && !canSnooze) return null;
  return (
    <p className={cn('text-sm text-muted-foreground', className)} data-testid="reminder-actions-hint">
      {canLog && 'Log service records the cost, provider and parts, and marks it done. '}
      {canSnooze && `Snooze moves a due date ${SNOOZE_DAYS} days later.`}
    </p>
  );
}

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
  estimates,
}: {
  reminders: MaintenanceReminder[];
  /** Mileage estimates by reminder id ("Estimated around Mar 12, based on 6 readings", MA-29). */
  estimates?: Readonly<Record<string, { text: string }>>;
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
            // MA-9: a snoozed reminder is muted and says until when; overdue work is never snoozed.
            const snoozeLine = reminderSnoozeLabel(reminder);
            const estimate = estimates?.[reminder.id]?.text;
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
                data-snoozed={snoozeLine ? 'true' : undefined}
                className={cn('rounded-lg border p-4', snoozeLine ? 'bg-muted/40 text-muted-foreground' : 'bg-card shadow-raised')}
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
                      <h3 className={cn('min-w-0 break-words font-headline text-base font-semibold transition-ui [overflow-wrap:anywhere]', isChecked && 'text-muted-foreground line-through')}>{reminder.title}</h3>
                      <Badge variant={badgeVariant(reminder.status, reminder.snoozed)} className={badgeClass(reminder.status, reminder.snoozed)}>{reminderBadgeLabel(reminder)}</Badge>
                      {isBusy && busy?.action === 'done' && <Loader2 role="status" aria-label="Saving" className="h-4 w-4 animate-spin text-muted-foreground" />}
                    </div>
                    <p className="mt-1 break-words text-sm [overflow-wrap:anywhere]">{reminder.relatedName}</p>
                    {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
                    {estimate && (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="mileage-estimate">
                        <Gauge aria-hidden className="h-3.5 w-3.5 shrink-0" />
                        <span>{estimate}. An estimate from past readings; the mileage above is what counts.</span>
                      </p>
                    )}
                    {snoozeLine && <p className="mt-1 text-xs text-muted-foreground">{snoozeLine}</p>}
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
