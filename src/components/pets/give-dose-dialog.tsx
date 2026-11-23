'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { ToastAction } from '@/components/ui/toast';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { playFeedback } from '@/lib/feedback';
import { loggerName } from '@/lib/pets/care';
import { FEED_UNDO_MS } from '@/lib/pets/feed-decision';
import {
  DOSE_BACKDATE_MAX_MS,
  DOSE_UNDO_COPY,
  coveredThrough,
  doseChoices,
  doseConfirmOf,
  doseQuestionApplies,
  doseRepeatReason,
  lastDoseLine,
  newDoseOpId,
  occurrenceId,
  occurrenceLabel,
  occurrencesAfter,
  petDoseToastGroup,
  type CourseView,
  type DoseCheck,
  type DoseConfirm,
} from '@/lib/pets/medication-course';
import { mayMedication } from '@/lib/pets/medication-permissions';
import { finishCourse, giveDose, MedicationActionError, resumeCourse, undoDose } from '@/lib/pets/medication-operation';
import { useNow } from './use-now';
import { TabletContext } from '@/components/devices/tablet-context';
import { backdatedCapability } from '@/lib/devices/action-policy';
import { useBackCloses } from '@/hooks/use-back-closes';

const INPUT_FORMAT = "yyyy-MM-dd'T'HH:mm";

const REFUSALS: Record<MedicationActionError['reason'], string> = {
  offline: 'Connect to the internet to do this. Offline, doses can be recorded only for courses already loaded on this device.',
  missing: 'This course was removed meanwhile.',
  finished: 'This course was finished meanwhile.',
  'not-active': 'This course was finished meanwhile.',
  changed: 'Someone else changed this course while you were editing. Close the form and open it again to see their changes.',
  occurrence: 'The schedule changed meanwhile. Pick the dose time again.',
  future: 'Pick a time that has already passed.',
  'too-old': 'Pick a time within the last 7 days.',
  conflict: 'Someone else recorded this dose already.',
  exists: 'This course already exists.',
};

export function medicationRefusal(error: unknown): string | null {
  return error instanceof MedicationActionError ? REFUSALS[error.reason] : null;
}

/**
 * Finish course and its Undo (10 s, the shared toast system). Finishing ends the
 * countdown on the card, the pet page and the Calendar and stops reminders (the
 * hourly upkeep resolves an open one); the history stays. Shared by Give dose
 * and the Medication tab.
 */
export function useFinishCourse(petId: string) {
  const { currentUser } = useAuth();
  const { toast, toastError } = useToast();
  // On a registered wall tablet Finish is a PIN-level device action (JC-14): the shell asks
  // "Who's here?" and the PIN; its resume is the course list's Resume (also PIN-level).
  const tablet = React.useContext(TabletContext);
  return React.useCallback(async (course: Pick<CourseView, 'id' | 'name'>): Promise<boolean> => {
    if (tablet) {
      const outcome = await tablet.runAction({ capability: 'pets.course.finish', label: `Finished ${course.name}`, intent: { petId, courseId: course.id } });
      const status = (outcome.data as { status?: string } | undefined)?.status;
      return outcome.ok && (status === 'saved' || status === 'already');
    }
    const householdId = currentUser?.householdId;
    if (!householdId || !currentUser) return false;
    try {
      await finishCourse({ householdId, petId, courseId: course.id, user: { uid: currentUser.uid, name: loggerName(currentUser) } });
      const { dismiss } = toast({
        group: petDoseToastGroup(petId, course.id),
        duration: FEED_UNDO_MS,
        title: `${course.name} finished`,
        description: 'No more doses are due and its reminders stop. Its history is kept.',
        action: (
          <ToastAction
            altText={`Undo finishing ${course.name}`}
            onClick={async () => {
              dismiss();
              try {
                await resumeCourse({ householdId, petId, courseId: course.id });
                toast({ title: `${course.name} is active again`, description: 'Its schedule and reminders are back.' });
              } catch (error) {
                toastError(error, "Couldn't undo finishing the course");
              }
            }}
          >
            Undo
          </ToastAction>
        ),
      });
      return true;
    } catch (error) {
      const refusal = medicationRefusal(error);
      if (refusal) toast({ variant: 'destructive', title: "Couldn't finish the course", description: refusal });
      else toastError(error, "Couldn't finish the course");
      return false;
    }
  }, [currentUser, petId, tablet, toast, toastError]);
}

/**
 * Give dose (PE-24b/c/d/k): opens prefilled from the saved course (dosage, the
 * scheduled occurrence, optional given-at time) from a card chip, the
 * Medication tab or a reminder link. It never suggests a dose or a schedule.
 * The occurrence a dose is for comes from the schedule (`doseChoices`); the
 * next dose after it is shown read-only (D-P7: the schedule decides, there is
 * no next-due field). Recording an occurrence that was already given asks
 * first, with the last-dose context, bound to the dose it names. One opening
 * is one press (`newDoseOpId`): a double tap, Retry and "Record again" reuse
 * its id, so a dose is recorded once. Finish course is here too (PE-24f).
 */
export function GiveDoseDialog({
  petId,
  petName,
  course,
  onOpenChange,
  onCloseAutoFocus,
}: {
  petId: string;
  petName: string;
  /** The course to give; null closes the dialog. */
  course: CourseView | null;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const now = useNow();
  // On a registered wall tablet Give dose is a device action for the person chosen in "Who's
  // here?" (F4b-2): the shell sends it through the gate, asks "Already given?" with the dose
  // the server named and offers its Undo; the server decides who may.
  const tablet = React.useContext(TabletContext);
  const timeZone = (tablet ? tablet.household?.timeZone : household?.timeZone) ?? null;
  const finish = useFinishCourse(petId);
  const canGive = tablet ? tablet.settings.sections.pets : mayMedication('pets.dose.give', permissions);
  const canFinish = tablet ? tablet.settings.sections.pets : mayMedication('pets.course.finish', permissions);

  const choices = React.useMemo(() => (course ? doseChoices(course, now, timeZone) : { prefill: null, choices: [] }), [course, now, timeZone]);
  const [shownFor, setShownFor] = React.useState<string | null>(null);
  const [opId, setOpId] = React.useState('');
  const [occurrenceKey, setOccurrenceKey] = React.useState('');
  const [when, setWhen] = React.useState<'now' | 'earlier'>('now');
  const [givenAt, setGivenAt] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [asked, setAsked] = React.useState<{ check: DoseCheck; confirm: DoseConfirm; stale: boolean } | null>(null);
  const [confirmFinish, setConfirmFinish] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const givenAtId = React.useId();
  const notesId = React.useId();
  const occurrenceLegendId = React.useId();

  // A new opening is a new press: reset (state adjusted during render, as the pet dialogs do).
  if ((course?.id ?? null) !== shownFor) {
    setShownFor(course?.id ?? null);
    setOpId(newDoseOpId());
    setOccurrenceKey(choices.prefill ? occurrenceId(choices.prefill) : '');
    setWhen('now');
    setGivenAt('');
    setNotes('');
    setError(null);
    setAsked(null);
    setConfirmFinish(false);
  }
  // The prefill can arrive a moment after the course (or change when the schedule changes,
  // or the minute clock drops the selected time). An open "already given?" question is
  // bound to the occurrence it asked about (`doseQuestionApplies`), so such a change hides it.
  if (course && occurrenceKey && !choices.choices.some((choice) => occurrenceId(choice) === occurrenceKey) && choices.prefill && !saving) {
    setOccurrenceKey(occurrenceId(choices.prefill));
  } else if (course && !occurrenceKey && choices.prefill) {
    setOccurrenceKey(occurrenceId(choices.prefill));
  }

  const selected = choices.choices.find((choice) => occurrenceId(choice) === occurrenceKey) ?? null;
  const nextAfter = course?.schedule && selected
    ? occurrencesAfter({ schedule: course.schedule, startDay: course.startDay, endDay: course.endDay }, Math.max(selected.at, coveredThrough(course) ?? -Infinity), timeZone ?? '', 1)[0] ?? null
    : null;
  const last = course ? lastDoseLine(course, now, timeZone, currentUser?.uid) : null;
  const question = asked && doseQuestionApplies(asked.check, selected) ? asked : null;
  const inactive = course !== null && course.status !== 'active';

  const record = async (confirm: DoseConfirm | null) => {
    const householdId = currentUser?.householdId;
    if (!course || !selected || savingRef.current) return;
    if (!tablet && (!householdId || !currentUser)) return;
    let chosen: Date | null = null;
    if (when === 'earlier') {
      chosen = givenAt ? new Date(givenAt) : null;
      if (!chosen || Number.isNaN(chosen.getTime())) { setError('Enter when the dose was given.'); return; }
      if (chosen.getTime() > Date.now() + 60_000) { setError(REFUSALS.future); return; }
      if (chosen.getTime() < Date.now() - DOSE_BACKDATE_MAX_MS) { setError(REFUSALS['too-old']); return; }
    }
    if (tablet) {
      savingRef.current = true;
      setSaving(true);
      setError(null);
      try {
        // The server picks a dose given more than 12 hours ago as the PIN-level .old capability (JC-27).
        const outcome = await tablet.runAction({
          // This opening's opId (one press): a retry after a lost answer replays on the server.
          opId,
          capability: chosen ? backdatedCapability('dose', chosen, new Date()) : 'pets.dose.give',
          label: `${course.name} for ${petName}`,
          subject: petName,
          // Each course keeps its own Undo toast (as the personal dialog's group).
          toastGroup: petDoseToastGroup(petId, course.id),
          // The occurrence (identity and instant), medication and dosage shown here travel with the
          // intent: a dose queued offline is recorded as given, even if the course's schedule or
          // dosage is edited before the tablet reconnects (Codex review of PR 190).
          intent: { petId, courseId: course.id, occurrenceKey: occurrenceId(selected), occurrenceAt: selected.at, givenAt: chosen ? chosen.toISOString() : null, notes: notes.trim(), medication: course.name, dosage: course.dosage },
        });
        const result = (outcome.data as { result?: { status?: string; reason?: string } } | undefined)?.result;
        // A refusal is shown whatever the runtime made of it (it reports a domain refusal as not ok, Codex 2).
        if (result?.status === 'refused') {
          setError(REFUSALS[result.reason as MedicationActionError['reason']] ?? "Couldn't record the dose. Try again.");
          return;
        }
        if (outcome.ok && (outcome.queued || result?.status === 'saved')) {
          playFeedback('complete');
          onOpenChange(false);
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
      return;
    }
    if (!householdId || !currentUser) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await giveDose({
        householdId, petId, courseId: course.id, opId, occurrenceKey: occurrenceId(selected), givenAt: chosen, notes, confirm, timeZone,
        user: { uid: currentUser.uid, name: loggerName(currentUser) },
        onLateError: (lateError) => toastError(lateError, `${course.name} for ${petName} didn't sync`),
      });
      if (result.status === 'needsConfirm') {
        setAsked({ check: result.check, confirm: doseConfirmOf(result.check), stale: result.staleConfirm });
        return;
      }
      playFeedback('complete');
      onOpenChange(false);
      const nextLine = result.nextAfter ? ` Next: ${occurrenceLabel(result.nextAfter, new Date(), timeZone)}.` : '';
      const { dismiss } = toast({
        group: petDoseToastGroup(petId, course.id),
        duration: FEED_UNDO_MS,
        ...(result.status === 'queued'
          ? { title: 'Saved on this device', description: `${course.name} for ${petName}. Couldn't check whether someone else already gave it.` }
          : { title: `${course.name} recorded`, description: `${course.dosage} for ${petName}, ${occurrenceLabel(selected, new Date(), timeZone)} dose.${nextLine}` }),
        action: (
          <ToastAction
            altText={`Remove the ${course.name} dose record`}
            onClick={async () => {
              dismiss();
              try {
                const undone = await undoDose({ householdId, petId, logId: result.logId, onLateError: (lateError) => toastError(lateError, "Removing the dose record didn't sync") });
                toast({ title: undone === 'queued' ? `${DOSE_UNDO_COPY.title} on this device` : DOSE_UNDO_COPY.title, description: DOSE_UNDO_COPY.description });
              } catch (undoError) {
                toastError(undoError, "Couldn't remove the dose record");
              }
            }}
          >
            Undo
          </ToastAction>
        ),
      });
    } catch (saveError) {
      const refusal = medicationRefusal(saveError);
      if (refusal) setError(refusal);
      // An uncertain failure: the same press can be retried safely (same operation id).
      else toastError(saveError, `Couldn't record ${course.name}. Try again: it won't be recorded twice.`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void record(null);
  };

  // Android Back closes this dialog first (emulator evidence D4).
  useBackCloses(course !== null, () => { if (saving) return false; onOpenChange(false); return true; });

  return (
    <Dialog open={course !== null} onOpenChange={(open) => { if (!saving) onOpenChange(open); }}>
      <DialogContent className="sm:max-w-[440px]" onCloseAutoFocus={onCloseAutoFocus} data-testid="give-dose-dialog">
        {course && confirmFinish ? (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">Finish {course.name}?</DialogTitle>
              <DialogDescription className="break-words">
                No more doses are due for {petName} and its reminders stop. The doses already recorded stay in the history.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setConfirmFinish(false)}>Back</Button>
              <Button
                type="button"
                variant="destructive"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  const done = await finish(course);
                  setSaving(false);
                  if (done) onOpenChange(false);
                }}
              >
                Finish course
              </Button>
            </DialogFooter>
          </>
        ) : course ? (
          <form onSubmit={submit} noValidate>
            <DialogHeader>
              <DialogTitle className="break-words">Give {course.name}</DialogTitle>
              <DialogDescription className="break-words">For {petName}, from the saved plan.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4 text-sm">
              <div className="rounded-md border bg-secondary/40 p-3">
                <p><span className="text-muted-foreground">Dose:</span> <span className="font-medium">{course.dosage || 'As planned'}</span></p>
                <p className="text-muted-foreground" data-testid="last-dose">{last ?? 'No dose recorded yet.'}</p>
              </div>

              <fieldset className="grid gap-2">
                <legend id={occurrenceLegendId} className="mb-1 font-medium">Which dose</legend>
                {choices.choices.length === 0 ? (
                  <p className="text-muted-foreground">No dose is scheduled.</p>
                ) : (
                  <RadioGroup value={occurrenceKey} onValueChange={(value) => { setOccurrenceKey(value); setAsked(null); setError(null); }} aria-labelledby={occurrenceLegendId}>
                    {choices.choices.map((choice) => (
                      <Label key={occurrenceId(choice)} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 font-normal coarse:min-h-12">
                        <RadioGroupItem value={occurrenceId(choice)} />
                        <span>
                          {occurrenceLabel(choice, now, timeZone)}
                          {choice.covered ? <span className="text-muted-foreground"> · already given</span> : choice.at > now.getTime() ? <span className="text-muted-foreground"> · early</span> : null}
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                )}
              </fieldset>

              <fieldset className="grid gap-2">
                <legend className="mb-1 font-medium">Given</legend>
                <RadioGroup value={when} onValueChange={(value) => { setWhen(value === 'earlier' ? 'earlier' : 'now'); setError(null); }} className="grid-cols-2">
                  <Label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 font-normal coarse:min-h-12">
                    <RadioGroupItem value="now" /> Just now
                  </Label>
                  <Label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 font-normal coarse:min-h-12">
                    <RadioGroupItem value="earlier" /> Earlier
                  </Label>
                </RadioGroup>
                {when === 'earlier' && (
                  <div className="grid gap-1">
                    <Label htmlFor={givenAtId}>Given at</Label>
                    <Input
                      type="datetime-local"
                      value={givenAt}
                      max={format(now, INPUT_FORMAT)}
                      min={format(new Date(now.getTime() - DOSE_BACKDATE_MAX_MS), INPUT_FORMAT)}
                      onChange={(event) => { setGivenAt(event.target.value); setError(null); }}
                      {...fieldErrorProps(givenAtId, error)}
                    />
                  </div>
                )}
              </fieldset>

              <div className="grid gap-1">
                <Label htmlFor={notesId}>Notes (optional)</Label>
                <Textarea id={notesId} rows={2} maxLength={500} placeholder="e.g. Hidden in cheese." value={notes} onChange={(event) => setNotes(event.target.value)} />
              </div>

              {nextAfter && <p className="text-muted-foreground" data-testid="next-after">Next dose after this: {occurrenceLabel(nextAfter, now, timeZone)} (from the schedule)</p>}

              {inactive && <p role="status" className="text-muted-foreground" data-testid="course-inactive">This course was finished, so no dose can be recorded for it.</p>}
              {question && (
                <div role="alert" className="rounded-md border border-warning/60 bg-warning/10 p-3 text-foreground" data-testid="dose-again">
                  <p className="font-medium">{question.stale ? 'Someone recorded a dose since you were asked. ' : ''}Already given?</p>
                  <p>{doseRepeatReason(question.check, now, timeZone, currentUser?.uid)} Record another dose anyway?</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" size="sm" disabled={saving} onClick={() => void record(question.confirm)}>Record again</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>Don&apos;t record</Button>
                  </div>
                </div>
              )}
              <FieldError id={givenAtId}>{error}</FieldError>
            </div>
            <DialogFooter className="flex-wrap gap-2 sm:justify-between">
              {canFinish ? (
                <Button type="button" variant="ghost" className="text-destructive" onClick={() => setConfirmFinish(true)}>Finish course</Button>
              ) : <span />}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
                {canGive && (
                  <Button type="submit" disabled={saving || !selected || inactive || Boolean(question)}>
                    {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
                    Record dose
                  </Button>
                )}
              </div>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
