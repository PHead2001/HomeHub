'use client';

import * as React from 'react';
import { Loader2, Plus, X } from 'lucide-react';
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
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { loggerName, petDay } from '@/lib/pets/care';
import {
  MAX_DOSE_TIMES,
  courseFormValues,
  coveredUntilAfterSave,
  coveredThrough,
  legacyMedicationKey,
  newCourseId,
  occurrenceLabel,
  occurrencesAfter,
  scheduleSummary,
  validateCourseForm,
  type CourseFormErrors,
  type CourseFormValues,
  type CourseView,
  type LegacyGroup,
} from '@/lib/pets/medication-course';
import { confirmLegacy, saveCourse } from '@/lib/pets/medication-operation';
import { medicationRefusal } from './give-dose-dialog';
import { useNow } from './use-now';

export type CourseFormMode =
  | { kind: 'create' }
  | { kind: 'edit'; course: CourseView }
  /** D-P8: confirm a schedule for a legacy medication (prefilled from its history only when consistent). */
  | { kind: 'legacy'; group: LegacyGroup };

const modeKey = (mode: CourseFormMode | null) =>
  !mode ? null : mode.kind === 'edit' ? `edit:${mode.course.id}` : mode.kind === 'legacy' ? `legacy:${mode.group.key}` : 'create';

/**
 * Create a course, edit its name, dosage or schedule, or confirm a legacy
 * medication's schedule (D-P8). The schedule is what the member enters (from
 * the vet's instructions): several set times a day, every N days, or every N
 * hours, with a first and optional last day. The preview shows the doses it
 * gives; for a legacy medication with consistent history the interval it had
 * is offered as a suggestion, never applied without this confirmation. The
 * course id is created once per opening, so a retried save never creates a
 * second course; an edit keeps the id, so history stays attached.
 */
export function CourseFormDialog({
  petId,
  petName,
  mode,
  courses,
  onOpenChange,
  onCloseAutoFocus,
}: {
  petId: string;
  petName: string;
  mode: CourseFormMode | null;
  /** The pet's courses (name suggestions and the duplicate-name check). */
  courses: CourseView[];
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { currentUser, household } = useAuth();
  const { toast, toastError } = useToast();
  const now = useNow();
  const timeZone = household?.timeZone ?? null;
  const today = petDay(now, timeZone);
  const [shownFor, setShownFor] = React.useState<string | null>(null);
  const [values, setValues] = React.useState<CourseFormValues>(() => courseFormValues({}, today));
  const [errors, setErrors] = React.useState<CourseFormErrors>({});
  const [failure, setFailure] = React.useState<string | null>(null);
  const [courseId, setCourseId] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const ids = { name: React.useId(), dosage: React.useId(), everyDays: React.useId(), times: React.useId(), everyHours: React.useId(), firstTime: React.useId(), startDay: React.useId(), endDay: React.useId(), names: React.useId() };

  const key = modeKey(mode);
  if (key !== shownFor) {
    setShownFor(key);
    setErrors({});
    setFailure(null);
    setCourseId(newCourseId());
    if (mode?.kind === 'edit') setValues(courseFormValues(mode.course, today));
    else if (mode?.kind === 'legacy') {
      const { group } = mode;
      // Only a consistent history fills the schedule (as a suggestion); otherwise it starts empty.
      setValues({
        ...courseFormValues({ name: group.name, dosage: group.dosage, schedule: group.suggestion, startDay: group.dueDay }, today),
        ...(group.suggestion ? {} : { everyDays: '', times: [] }),
      });
    } else setValues(courseFormValues({}, today));
  }

  const editing = mode?.kind === 'edit' ? mode.course : null;
  const activeNames = courses.filter((course) => course.status === 'active' && course.id !== editing?.id).map((course) => legacyMedicationKey(course.name));
  const names = [...new Set(courses.map((course) => course.name))];
  const { fields } = validateCourseForm(values, activeNames);
  // The next doses this schedule gives (after the latest dose when editing).
  // Exactly what saving stores (`coveredUntilAfterSave`, as the transaction does).
  const covered = !fields || !editing ? -Infinity
    : coveredThrough({ ...editing, coveredUntil: coveredUntilAfterSave(editing, fields, timeZone) }) ?? -Infinity;
  const preview = fields ? occurrencesAfter(fields, Number.isFinite(covered) ? covered : null, timeZone ?? '', 3) : [];

  const set = (patch: Partial<CourseFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    setFailure(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const householdId = currentUser?.householdId;
    if (!mode || !householdId || !currentUser || saving) return;
    const result = validateCourseForm(values, activeNames);
    setErrors(result.errors);
    if (!result.fields) {
      const first = Object.keys(result.errors)[0] as keyof typeof ids | undefined;
      if (first) document.getElementById(ids[first])?.focus();
      return;
    }
    setSaving(true);
    const user = { uid: currentUser.uid, name: loggerName(currentUser) };
    try {
      if (mode.kind === 'legacy') {
        await confirmLegacy({ householdId, petId, key: mode.group.key, fields: result.fields, user });
        toast({ title: `${result.fields.name} schedule confirmed`, description: `${scheduleSummary(result.fields.schedule)}. Reminders now follow this schedule.` });
      } else {
        await saveCourse({ householdId, petId, courseId: editing?.id ?? courseId, create: !editing, fields: result.fields, user, timeZone });
        toast({ title: editing ? `${result.fields.name} updated` : `${result.fields.name} added`, description: scheduleSummary(result.fields.schedule) });
      }
      onOpenChange(false);
    } catch (saveError) {
      const refusal = medicationRefusal(saveError);
      if (refusal) setFailure(refusal);
      else toastError(saveError, "Couldn't save the course");
    } finally {
      setSaving(false);
    }
  };

  const title = mode?.kind === 'edit' ? `Edit ${mode.course.name}` : mode?.kind === 'legacy' ? `Confirm ${mode.group.name}'s schedule` : 'New medication course';

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => { if (!saving) onOpenChange(open); }}>
      <DialogContent className="sm:max-w-[480px]" onCloseAutoFocus={onCloseAutoFocus} data-testid="course-form-dialog">
        <form onSubmit={save} noValidate>
          <DialogHeader>
            <DialogTitle className="break-words">{title}</DialogTitle>
            <DialogDescription className="break-words">
              For {petName}. Enter the dose and schedule from the vet&apos;s instructions; HomeHub reminds from it and never suggests a dose.
            </DialogDescription>
          </DialogHeader>

          {mode?.kind === 'legacy' && (
            <p className="mt-3 rounded-md border bg-secondary/40 p-3 text-sm" data-testid="legacy-suggestion">
              {mode.group.suggestion
                ? `Suggested from what was entered before: ${scheduleSummary(mode.group.suggestion).toLowerCase()}, next on the day it was due. Check it before confirming.`
                : 'Doses were logged with different gaps, so there is no suggestion. Enter the schedule.'}
            </p>
          )}

          <div className="grid gap-4 py-4 text-sm">
            <div className="grid gap-1">
              <Label htmlFor={ids.name}>Medication</Label>
              <Input list={ids.names} maxLength={80} value={values.name} onChange={(event) => set({ name: event.target.value })} placeholder="e.g. Apoquel" {...fieldErrorProps(ids.name, errors.name)} />
              {/* Autocomplete from this pet's courses, so a typo does not start a new course (PE-4c). */}
              <datalist id={ids.names}>{names.map((name) => <option key={name} value={name} />)}</datalist>
              <FieldError id={ids.name}>{errors.name}</FieldError>
            </div>
            <div className="grid gap-1">
              <Label htmlFor={ids.dosage}>Dosage</Label>
              <Input maxLength={80} value={values.dosage} onChange={(event) => set({ dosage: event.target.value })} placeholder="e.g. 1 tablet" {...fieldErrorProps(ids.dosage, errors.dosage)} />
              <FieldError id={ids.dosage}>{errors.dosage}</FieldError>
            </div>

            <fieldset className="grid gap-2">
              <legend className="mb-1 font-medium">Schedule</legend>
              <RadioGroup value={values.kind} onValueChange={(value) => set({ kind: value === 'hours' ? 'hours' : 'days' })} className="grid-cols-1 sm:grid-cols-2">
                <Label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 font-normal coarse:min-h-12">
                  <RadioGroupItem value="days" /> Set times of day
                </Label>
                <Label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 font-normal coarse:min-h-12">
                  <RadioGroupItem value="hours" /> Every few hours
                </Label>
              </RadioGroup>

              {values.kind === 'days' ? (
                <div className="grid gap-3">
                  <div className="grid gap-1">
                    <Label htmlFor={ids.everyDays}>Every how many days</Label>
                    <Input type="number" inputMode="numeric" min={1} max={90} step={1} className="max-w-[140px]" value={values.everyDays} onChange={(event) => set({ everyDays: event.target.value })} {...fieldErrorProps(ids.everyDays, errors.everyDays)} />
                    <p className="text-xs text-muted-foreground">1 = every day, 7 = weekly, 30 = monthly.</p>
                    <FieldError id={ids.everyDays}>{errors.everyDays}</FieldError>
                  </div>
                  <div className="grid gap-2" role="group" aria-labelledby={`${ids.times}-label`}>
                    <span id={`${ids.times}-label`} className="font-medium">Times (household time)</span>
                    {values.times.length === 0 && <p className="text-xs text-muted-foreground">No set time: due any time that day.</p>}
                    {values.times.map((time, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          type="time"
                          aria-label={`Dose time ${index + 1}`}
                          className="max-w-[160px]"
                          value={time}
                          id={index === 0 ? ids.times : undefined}
                          aria-invalid={errors.times ? true : undefined}
                          onChange={(event) => set({ times: values.times.map((value, at) => (at === index ? event.target.value : value)) })}
                        />
                        <Button type="button" variant="ghost" size="icon" aria-label={`Remove dose time ${index + 1}`} onClick={() => set({ times: values.times.filter((_, at) => at !== index) })}>
                          <X aria-hidden className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    {values.times.length < MAX_DOSE_TIMES && (
                      <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => set({ times: [...values.times, ''] })}>
                        <Plus aria-hidden className="mr-2 h-4 w-4" /> Add a time
                      </Button>
                    )}
                    <FieldError id={ids.times}>{errors.times}</FieldError>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1">
                    <Label htmlFor={ids.everyHours}>Every how many hours</Label>
                    <Input type="number" inputMode="numeric" min={2} max={72} step={1} value={values.everyHours} onChange={(event) => set({ everyHours: event.target.value })} {...fieldErrorProps(ids.everyHours, errors.everyHours)} />
                    <FieldError id={ids.everyHours}>{errors.everyHours}</FieldError>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={ids.firstTime}>First dose at</Label>
                    <Input type="time" value={values.firstTime} onChange={(event) => set({ firstTime: event.target.value })} {...fieldErrorProps(ids.firstTime, errors.firstTime)} />
                    <FieldError id={ids.firstTime}>{errors.firstTime}</FieldError>
                  </div>
                </div>
              )}
            </fieldset>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Label htmlFor={ids.startDay}>First day</Label>
                <Input type="date" value={values.startDay} onChange={(event) => set({ startDay: event.target.value })} {...fieldErrorProps(ids.startDay, errors.startDay)} />
                <FieldError id={ids.startDay}>{errors.startDay}</FieldError>
              </div>
              <div className="grid gap-1">
                <Label htmlFor={ids.endDay}>Last day (optional)</Label>
                <Input type="date" min={values.startDay || undefined} value={values.endDay} onChange={(event) => set({ endDay: event.target.value })} {...fieldErrorProps(ids.endDay, errors.endDay)} />
                <FieldError id={ids.endDay}>{errors.endDay}</FieldError>
              </div>
            </div>

            {fields && (
              <div className="rounded-md bg-secondary/40 p-3" aria-live="polite" data-testid="course-preview">
                <p className="font-medium">{scheduleSummary(fields.schedule)}</p>
                <p className="text-muted-foreground">
                  {preview.length > 0 ? `Next: ${preview.map((occurrence) => occurrenceLabel(occurrence, now, timeZone)).join(', ')}` : 'No dose left in this schedule.'}
                </p>
              </div>
            )}
            {failure && <p role="alert" className="text-destructive">{failure}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              {mode?.kind === 'legacy' ? 'Confirm schedule' : editing ? 'Save' : 'Add course'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
