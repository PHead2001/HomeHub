'use client';

import * as React from 'react';
import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { loggerName, petDay, parseLocalDate } from '@/lib/pets/care';
import { diffDays } from '../../../functions/src/shared/calendar';
import { dayLabel, scheduleSummary, type CourseView, type LegacyGroup } from '@/lib/pets/medication-course';
import { mayMedication } from '@/lib/pets/medication-permissions';
import { finishLegacy, mergeLegacy } from '@/lib/pets/medication-operation';
import { medicationRefusal } from './give-dose-dialog';
import { useNow } from './use-now';

/**
 * The D-P8 confirmation card for one legacy (name-keyed) medication that still
 * counts down: until a member acts, it keeps its legacy countdown and
 * reminders. A member who sets schedules confirms it (prefilled only when its
 * history is consistent), merges a typo into an existing course, or anyone who
 * logs finishes it ("no more doses"). Nothing is converted silently.
 */
export function LegacyMedicationCard({
  petId,
  group,
  courses,
  onConfirm,
}: {
  petId: string;
  group: LegacyGroup;
  courses: CourseView[];
  onConfirm: (group: LegacyGroup) => void;
}) {
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const now = useNow();
  const timeZone = household?.timeZone ?? null;
  const [confirmFinish, setConfirmFinish] = React.useState(false);
  const [mergeInto, setMergeInto] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const canConfirm = mayMedication('pets.medication.confirmLegacy', permissions);
  const canMerge = mayMedication('pets.course.edit', permissions);
  const canFinish = mayMedication('pets.course.finish', permissions);
  const active = courses.filter((course) => course.status === 'active');
  const due = parseLocalDate(group.dueDay);
  const days = diffDays(group.dueDay, petDay(now, timeZone));

  const run = async (action: () => Promise<unknown>, done: string, failed: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      toast({ title: done });
    } catch (error) {
      const refusal = medicationRefusal(error);
      if (refusal) toast({ variant: 'destructive', title: failed, description: refusal });
      else toastError(error, failed);
    } finally {
      setBusy(false);
    }
  };

  const householdId = currentUser?.householdId ?? null;
  const user = currentUser ? { uid: currentUser.uid, name: loggerName(currentUser) } : null;

  return (
    <div className="space-y-3 rounded-lg border border-warning/50 bg-warning/5 p-4 text-sm" data-testid="legacy-medication-card" data-legacy-key={group.key}>
      <div className="flex items-start gap-3">
        <History aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <p className="break-words font-semibold">{group.name || group.key}{group.dosage ? ` · ${group.dosage}` : ''}</p>
          <p className="text-muted-foreground">
            Logged without a schedule ({group.entries} {group.entries === 1 ? 'entry' : 'entries'}). Next dose was entered for {due ? due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : group.dueDay} ({dayLabel(days).toLowerCase()}). It keeps reminding as before until its schedule is confirmed or it is finished.
          </p>
          <p className="text-muted-foreground">
            {group.suggestion
              ? `From its history: ${scheduleSummary(group.suggestion).toLowerCase()} (a suggestion to check).`
              : 'Its history has different gaps between doses, so there is no suggestion.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canConfirm ? (
          <Button type="button" size="sm" onClick={() => onConfirm(group)} disabled={busy}>Confirm schedule</Button>
        ) : (
          <p className="text-xs text-muted-foreground">Someone who can log pet care can confirm its schedule.</p>
        )}
        {canFinish && (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmFinish(true)} disabled={busy}>No more doses</Button>
        )}
        {canMerge && active.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={mergeInto} onValueChange={setMergeInto}>
              <SelectTrigger className="h-9 w-[200px]" aria-label={`Merge ${group.name || group.key} into a course`}>
                <SelectValue placeholder="Same as a course…" />
              </SelectTrigger>
              <SelectContent>
                {active.map((course) => <SelectItem key={course.id} value={course.id}>{course.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!mergeInto || busy || !householdId || !user}
              onClick={() => void run(
                () => mergeLegacy({ householdId: householdId!, petId, key: group.key, courseId: mergeInto, user: user! }),
                `${group.name || group.key} merged into ${active.find((course) => course.id === mergeInto)?.name ?? 'the course'}`,
                "Couldn't merge",
              )}
            >
              Merge
            </Button>
          </div>
        )}
      </div>
      <AlertDialog open={confirmFinish} onOpenChange={setConfirmFinish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>No more doses of {group.name || group.key}?</AlertDialogTitle>
            <AlertDialogDescription>Its countdown and reminders stop. Every entry stays in the history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => householdId && user && void run(
                () => finishLegacy({ householdId, petId, key: group.key, name: group.name, dosage: group.dosage, user, timeZone }),
                `${group.name || group.key} finished`,
                "Couldn't finish it",
              )}
            >
              Finish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
