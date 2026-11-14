"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { format } from 'date-fns';
import { Loader2, MoreVertical, Pencil, Pill, PlusCircle, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { loggerName, readableLogDate, toDate } from '@/lib/pets/care';
import {
  DOSE_BACKDATE_MAX_MS,
  DOSE_UNDO_COPY,
  courseDue,
  lastDoseLine,
  legacyMedicationKey,
  newDoseOpId,
  occurrenceLabel,
  scheduleSummary,
  type CourseView,
} from '@/lib/pets/medication-course';
import { mayMedication } from '@/lib/pets/medication-permissions';
import { logOneOffDose, undoDose } from '@/lib/pets/medication-operation';
import type { PetMedicationLog } from '@/lib/pets/types';
import { Skeleton } from './ui/skeleton';
import { PetLogDeleteAlert } from './pet-log-delete-alert';
import { LoggedBy } from './pets/logged-by';
import { MedicationChip, MedicationChips } from './pets/medication-chip';
import { CourseFormDialog, type CourseFormMode } from './pets/course-form-dialog';
import { GiveDoseDialog, medicationRefusal, useFinishCourse } from './pets/give-dose-dialog';
import { LegacyMedicationCard } from './pets/legacy-medication-card';
import { useSharedPetCare } from './pets/care-store';
import { usePetLogs } from './pets/pet-log-api';
import { useNow } from './pets/use-now';
import { unavailableText } from '@/lib/pets/live-listener';

const AUTHOR_WINDOW_MS = 10 * 60_000;
const INPUT_FORMAT = "yyyy-MM-dd'T'HH:mm";

interface MedicationLogProps {
  petId: string;
  petName?: string;
  /** `?dose=<courseId>` (a reminder's link): opens Give dose for that course once loaded. */
  doseCourseId?: string | null;
  /** Called once the `?dose=` request was handled (opened, or the course is not active). */
  onDoseHandled?: () => void;
}

/**
 * The Medication tab (P3): the pet's courses with Give dose, Edit and Finish,
 * the D-P8 confirmation cards for legacy medications, one-off doses, and the
 * history (course doses show the occurrence they covered, and when they were
 * given and recorded). Every action's permission comes from the shared table
 * (`MEDICATION_ACTION_PERMISSIONS`); the rules enforce the same.
 */
export function MedicationLogClient({ petId, petName = 'this pet', doseCourseId = null, onDoseHandled }: MedicationLogProps) {
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const now = useNow();
  const timeZone = household?.timeZone ?? null;
  const householdId = currentUser?.householdId ?? null;
  const canGive = mayMedication('pets.dose.give', permissions);
  const canEdit = mayMedication('pets.course.edit', permissions);
  const canFinish = mayMedication('pets.course.finish', permissions);
  const canOneOff = mayMedication('pets.dose.oneOff', permissions);
  const canDeleteAny = Boolean(permissions['pets.deleteLogs']);
  const { logs, loading, error, failure } = usePetLogs<PetMedicationLog>(householdId, petId, 'medication-logs', 100);
  // Courses and countdowns from the household's care store (PE-21a): shared with the summary card.
  const state = useSharedPetCare(householdId, petId).medications;
  const finish = useFinishCourse(petId);
  const [logToDelete, setLogToDelete] = useState<string | null>(null);
  // The course Give dose is open for, by id, so the dialog always sees the live course.
  const [givingId, setGivingId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<CourseFormMode | null>(null);
  const [oneOffOpen, setOneOffOpen] = useState(false);
  const [finishing, setFinishing] = useState<CourseView | null>(null);
  // `?dose=` handled for this course id (null once the param is gone, so the same reminder opens again).
  const [seenDose, setSeenDose] = useState<string | null>(null);
  const notifiedDose = useRef<string | null>(null);

  const active = state.courses.filter((course) => course.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
  const finished = state.courses.filter((course) => course.status === 'finished').sort((a, b) => a.name.localeCompare(b.name));
  const coursesById = new Map(state.courses.map((course) => [course.id, course]));
  const giving = givingId ? active.find((course) => course.id === givingId) ?? null : null;

  // A reminder's link (`?dose=`): open Give dose for that course once the courses are
  // loaded (state adjusted during render), then drop the param (effect below).
  const doseCourse = doseCourseId ? state.courses.find((entry) => entry.id === doseCourseId && entry.status === 'active') ?? null : null;
  if (doseCourseId !== seenDose && (!doseCourseId || !state.loading)) {
    setSeenDose(doseCourseId);
    if (doseCourse) setGivingId(doseCourse.id);
  }
  useEffect(() => {
    if (!seenDose || notifiedDose.current === seenDose) {
      if (!seenDose) notifiedDose.current = null;
      return;
    }
    notifiedDose.current = seenDose;
    if (!doseCourse && !state.error) toast({ title: 'This course is no longer active', description: 'It may have been finished. Its history is below.' });
    onDoseHandled?.();
  }, [seenDose, doseCourse, state.error, onDoseHandled, toast]);

  const mayDelete = (log: PetMedicationLog) => {
    if (canDeleteAny) return true;
    const loggedAt = toDate(log.loggedAt);
    return Boolean(canGive && log.loggedByUid === currentUser?.uid && loggedAt && now.getTime() - loggedAt.getTime() < AUTHOR_WINDOW_MS && (log.courseId || log.oneOff));
  };

  const deleteLog = async (logId: string) => {
    if (!householdId) return;
    try {
      const undone = await undoDose({ householdId, petId, logId, onLateError: (lateError) => toastError(lateError, "Removing the dose record didn't sync") });
      toast({ title: undone === 'queued' ? `${DOSE_UNDO_COPY.title} on this device` : DOSE_UNDO_COPY.title, description: DOSE_UNDO_COPY.description });
    } catch (deleteError) {
      const refusal = medicationRefusal(deleteError);
      if (refusal) toast({ variant: 'destructive', title: "Couldn't remove the record", description: refusal });
      else toastError(deleteError, "Couldn't remove the record");
    }
  };

  return (
    <>
    <PetLogDeleteAlert
      open={!!logToDelete}
      logType="medication"
      onCancel={() => setLogToDelete(null)}
      onConfirm={() => {
        if (!logToDelete) return;
        void deleteLog(logToDelete);
        setLogToDelete(null);
      }}
    />
    <GiveDoseDialog petId={petId} petName={petName} course={giving} onOpenChange={(open) => { if (!open) setGivingId(null); }} />
    <CourseFormDialog petId={petId} petName={petName} mode={formMode} courses={state.courses} onOpenChange={(open) => { if (!open) setFormMode(null); }} />
    <OneOffDoseDialog petId={petId} petName={petName} open={oneOffOpen} courses={state.courses} onOpenChange={setOneOffOpen} />
    <Dialog open={finishing !== null} onOpenChange={(open) => { if (!open) setFinishing(null); }}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="break-words">Finish {finishing?.name}?</DialogTitle>
          <DialogDescription>No more doses are due and its reminders stop. The doses already recorded stay in the history.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => setFinishing(null)}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={async () => { const course = finishing; setFinishing(null); if (course) await finish(course); }}>Finish course</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="font-headline">Medication</CardTitle>
          <CardDescription>Courses follow the schedule you enter. Give a dose from here, the pet&apos;s card or a reminder.</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={() => setFormMode({ kind: 'create' })}>
              <PlusCircle className="mr-2 h-4 w-4" /> New course
            </Button>
          )}
          {canOneOff && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setOneOffOpen(true)}>One-off dose</Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {state.error ? <p className="text-sm text-muted-foreground">{unavailableText('Medication courses', state.failure ?? 'retrying')}</p> : null}
        {state.loading ? <Skeleton className="h-20 w-full" /> : null}
        {state.dues.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{state.dues.length === 1 ? 'Next dose:' : 'Next doses:'}</span>
            {/* Every current countdown here, courses and legacy, most urgent first: this tab is the full view. */}
            <MedicationChips
              dues={state.dues}
              max={state.dues.length}
              onSelect={canGive ? (due) => {
                // A course chip opens Give dose; a legacy one opens its schedule confirmation (D-P8).
                if (due.courseId) setGivingId(due.courseId);
                else {
                  const group = state.legacy.find((entry) => entry.key === due.legacyKey);
                  if (group) setFormMode({ kind: 'legacy', group });
                }
              } : undefined}
            />
          </div>
        )}

        {state.legacy.length > 0 && (
          <section className="space-y-3" aria-label="Medications to confirm">
            {state.legacy.map((group) => (
              <LegacyMedicationCard key={group.key} petId={petId} group={group} courses={state.courses} onConfirm={(entry) => setFormMode({ kind: 'legacy', group: entry })} />
            ))}
          </section>
        )}

        {!state.loading && !state.error && (
          <section className="space-y-3" aria-labelledby={`medication-courses-${petId}`}>
            <h3 id={`medication-courses-${petId}`} className="font-semibold">Courses</h3>
            {active.length === 0 && <p className="text-sm text-muted-foreground">No active course.{canEdit ? ' Add one with New course.' : ''}</p>}
            {active.map((course) => {
              const due = courseDue(course, now, timeZone ?? '');
              const last = lastDoseLine(course, now, timeZone, currentUser?.uid);
              return (
                <div key={course.id} className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3 text-sm" data-testid="medication-course" data-course-id={course.id}>
                  <div className="min-w-0 space-y-1">
                    <p className="break-words"><span className="font-semibold">{course.name}</span>{course.dosage ? ` · ${course.dosage}` : ''}</p>
                    <p className="text-muted-foreground">
                      {course.schedule ? scheduleSummary(course.schedule) : ''}
                      {course.endDay ? `, until ${format(new Date(`${course.endDay}T12:00:00`), 'MMM d')}` : ''}
                    </p>
                    {due ? (
                      <MedicationChip due={{ medication: course.name, dosage: course.dosage, due: new Date(due.occurrence.at), dueDay: due.occurrence.day, days: due.days, state: due.state, label: due.label, courseId: course.id }} />
                    ) : (
                      <p className="text-muted-foreground">No more doses scheduled.</p>
                    )}
                    {last && <p className="text-xs text-muted-foreground">{last}</p>}
                  </div>
                  <div className="flex items-center gap-1">
                    {canGive && due && (
                      <Button type="button" size="sm" onClick={() => setGivingId(course.id)} data-give-dose={course.id}>
                        <Pill aria-hidden className="mr-2 h-4 w-4" /> Give dose
                      </Button>
                    )}
                    {(canEdit || canFinish) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" aria-label={`More actions for ${course.name}`}>
                            <MoreVertical aria-hidden className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {canEdit && (
                            <DropdownMenuItem onSelect={() => setFormMode({ kind: 'edit', course })}>
                              <Pencil aria-hidden className="mr-2 h-4 w-4" /> Edit course
                            </DropdownMenuItem>
                          )}
                          {canFinish && (
                            <DropdownMenuItem onSelect={() => setFinishing(course)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                              <Square aria-hidden className="mr-2 h-4 w-4" /> Finish course
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              );
            })}
            {finished.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">Finished courses ({finished.length})</summary>
                <ul className="mt-2 space-y-1">
                  {finished.map((course) => (
                    <li key={course.id} className="break-words text-muted-foreground">{course.name}{course.dosage ? ` · ${course.dosage}` : ''}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        <section className="space-y-3" aria-labelledby={`medication-history-${petId}`}>
          <h3 id={`medication-history-${petId}`} className="font-semibold">History</h3>
          {loading && (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {!loading && error ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{unavailableText('Medication history', failure ?? 'retrying')}</p>
          ) : null}
          {!loading && !error && logs.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No medication logged yet.</p>
          )}
          {!loading && logs.map((log) => {
            // A blank or unreadable legacy date renders as unknown, never a crash (PE-8b).
            const given = readableLogDate(log.date);
            const recorded = readableLogDate(log.loggedAt);
            const course = log.courseId ? coursesById.get(log.courseId) : undefined;
            const occurrence = log.occurrence ? { day: log.occurrence.slice(0, 10), time: log.occurrence.slice(11) || null } : null;
            const nextDue = log.nextDueDate && !log.courseId ? new Date(`${log.nextDueDate}T12:00:00`) : null;
            return (
              <div key={log.id} className="flex items-start justify-between gap-3 rounded-md bg-secondary/50 p-3 text-sm" data-testid="medication-entry">
                <div className="min-w-0 space-y-0.5">
                  <p className="break-words text-foreground">
                    <span className="font-semibold">{log.medication}</span> · {log.dosage}
                    {course && legacyMedicationKey(course.name) !== legacyMedicationKey(log.medication) ? <span className="text-muted-foreground"> (now {course.name})</span> : null}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                    <span>{given ? `Given ${format(given, 'PPP p')}` : 'Unknown time'}</span>
                    <LoggedBy entry={log} />
                  </p>
                  {occurrence && <p className="text-muted-foreground">For the {occurrenceLabel(occurrence, now, timeZone)} dose{log.repeat === 'confirmed' ? ' (recorded again)' : ''}</p>}
                  {log.oneOff && <p className="text-muted-foreground">One-off dose</p>}
                  {log.backdated && recorded && <p className="text-xs text-muted-foreground">Recorded {format(recorded, 'PPP p')}</p>}
                  {nextDue && !Number.isNaN(nextDue.getTime()) && <p className="text-muted-foreground">Next dose {format(nextDue, 'PPP')}</p>}
                  {log.notes && <p className="mt-1 text-muted-foreground">{log.notes}</p>}
                </div>
                {mayDelete(log) && (
                  <Button variant="ghost" size="icon" aria-label={`Delete ${log.medication} medication log`} className="h-8 w-8 flex-shrink-0" onClick={() => setLogToDelete(log.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            );
          })}
        </section>
      </CardContent>
    </Card>
    </>
  );
}

/** A dose outside any course: no schedule and no reminders (history only). One opening is one press. */
function OneOffDoseDialog({ petId, petName, open, courses, onOpenChange }: { petId: string; petName: string; open: boolean; courses: CourseView[]; onOpenChange: (open: boolean) => void }) {
  const { currentUser } = useAuth();
  const { toast, toastError } = useToast();
  const now = useNow();
  const [opId, setOpId] = useState('');
  const [wasOpen, setWasOpen] = useState(false);
  const [medication, setMedication] = useState('');
  const [dosage, setDosage] = useState('');
  const [givenAt, setGivenAt] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<{ medication?: string; dosage?: string; givenAt?: string }>({});
  const [saving, setSaving] = useState(false);
  const ids = { medication: useId(), dosage: useId(), givenAt: useId(), notes: useId(), names: useId() };
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setOpId(newDoseOpId());
      setMedication('');
      setDosage('');
      setGivenAt('');
      setNotes('');
      setErrors({});
    }
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const householdId = currentUser?.householdId;
    if (!householdId || !currentUser || saving) return;
    const next: typeof errors = {};
    if (!medication.trim()) next.medication = 'Enter the medication name.';
    if (!dosage.trim()) next.dosage = 'Enter the dosage.';
    const chosen = givenAt ? new Date(givenAt) : null;
    if (chosen && (Number.isNaN(chosen.getTime()) || chosen.getTime() > Date.now() + 60_000)) next.givenAt = 'Pick a time that has already passed.';
    else if (chosen && chosen.getTime() < Date.now() - DOSE_BACKDATE_MAX_MS) next.givenAt = 'Pick a time within the last 7 days.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    try {
      const status = await logOneOffDose({
        householdId, petId, opId, medication, dosage, notes, givenAt: chosen, user: { uid: currentUser.uid, name: loggerName(currentUser) },
        onLateError: (lateError) => toastError(lateError, "The one-off dose didn't sync"),
      });
      toast({ title: status === 'queued' ? 'Saved on this device' : 'Dose recorded', description: `${medication.trim()}, ${dosage.trim()} for ${petName}.` });
      onOpenChange(false);
    } catch (saveError) {
      toastError(saveError, "Couldn't record the dose. Try again: it won't be recorded twice.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-[420px]">
        <form onSubmit={save} noValidate>
          <DialogHeader>
            <DialogTitle>One-off dose</DialogTitle>
            <DialogDescription>A single dose outside any course: it is kept in the history and sets no reminder.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4 text-sm">
            <div className="grid gap-1">
              <Label htmlFor={ids.medication}>Medication</Label>
              <Input list={ids.names} maxLength={80} value={medication} onChange={(event) => setMedication(event.target.value)} {...fieldErrorProps(ids.medication, errors.medication)} />
              <datalist id={ids.names}>{courses.map((course) => <option key={course.id} value={course.name} />)}</datalist>
              <FieldError id={ids.medication}>{errors.medication}</FieldError>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={ids.dosage}>Dosage</Label>
              <Input maxLength={80} value={dosage} onChange={(event) => setDosage(event.target.value)} {...fieldErrorProps(ids.dosage, errors.dosage)} />
              <FieldError id={ids.dosage}>{errors.dosage}</FieldError>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={ids.givenAt}>Given at (leave empty for now)</Label>
              <Input type="datetime-local" max={format(now, INPUT_FORMAT)} value={givenAt} onChange={(event) => setGivenAt(event.target.value)} {...fieldErrorProps(ids.givenAt, errors.givenAt)} />
              <FieldError id={ids.givenAt}>{errors.givenAt}</FieldError>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={ids.notes}>Notes (optional)</Label>
              <Textarea id={ids.notes} rows={2} maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Record dose
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
