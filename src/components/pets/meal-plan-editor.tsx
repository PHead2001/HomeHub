'use client';

import * as React from 'react';
import { Plus, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { formatPortion, PORTION_MAX, UNIT_LABELS, type FeedingPlan } from '@/lib/pets/care';
import {
  MEAL_SLOT_NAME_MAX,
  MEAL_SLOTS_MAX,
  draftFromSuggestion,
  formatSlotTime,
  newMealSlotId,
  readsAs,
  type MealSlotDraft,
  type MealSlotErrors,
} from '@/lib/pets/meal-plan';
import { parseSchedule } from '@/lib/pets/schedule-parser';
import { PORTION_UNITS, type PortionUnit } from '@/lib/pets/types';
import { cn } from '@/lib/utils';

const WEEKDAYS = [
  { short: 'Su', long: 'Sunday' },
  { short: 'Mo', long: 'Monday' },
  { short: 'Tu', long: 'Tuesday' },
  { short: 'We', long: 'Wednesday' },
  { short: 'Th', long: 'Thursday' },
  { short: 'Fr', long: 'Friday' },
  { short: 'Sa', long: 'Saturday' },
];

/** The id of a meal row's field, for labels, errors and focus (`focusFirstError`). */
export function mealFieldId(idPrefix: string, index: number, field: keyof MealSlotErrors): string {
  return `${idPrefix}-meal-${index}-${field}`;
}

/**
 * The meal plan part of the pet form (PE-22k, PE-6f, PE-6g): one row per meal
 * (name, household-local time, portion, days it is skipped), at most six. With
 * no rows yet, the free-text schedule is read and its interpretation shown
 * ("Reads as: 2 feedings of 1 cup") with **Use these meal times**, which only
 * fills the rows: nothing is saved until the member saves the form (the
 * confirmation). Ambiguous, non-daily or unreadable text gets no suggestion,
 * only "add them below". Every control is a labelled native or shared control
 * (48 px on touch through `--target-min`), with no motion.
 */
export function MealPlanEditor({
  idPrefix,
  rows,
  errors,
  planError,
  schedule,
  legacy,
  confirmed,
  onChange,
}: {
  idPrefix: string;
  rows: MealSlotDraft[];
  errors: MealSlotErrors[];
  planError: string | null;
  /** The free-text schedule, read for a suggestion while there are no rows. */
  schedule: string;
  /** The legacy target the pet keeps until meal times are saved (null for a new pet). */
  legacy: FeedingPlan | null;
  /** The pet already has confirmed meal times. */
  confirmed: boolean;
  onChange: (rows: MealSlotDraft[]) => void;
}) {
  const update = (index: number, patch: Partial<MealSlotDraft>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const remove = (index: number) => onChange(rows.filter((_row, at) => at !== index));
  const add = () => {
    const last = rows[rows.length - 1];
    onChange([...rows, { id: newMealSlotId(), name: '', time: '', amount: last?.amount ?? '1', unit: last?.unit ?? 'Cups', offDays: [] }]);
  };
  const filled = rows.filter((row) => Number(row.amount) > 0).map((row) => ({ amount: Number(row.amount), unit: row.unit }));

  return (
    <fieldset className="grid gap-3 rounded-lg border p-3" data-testid="meal-plan-editor">
      <legend className="px-1 text-sm font-medium">Meal times</legend>
      {rows.length === 0 && <Suggestion schedule={schedule} legacy={legacy} confirmed={confirmed} onUse={(next) => onChange(next)} />}
      {rows.length > 0 && (
        <ol className="grid gap-3" aria-label="Meals">
          {rows.map((row, index) => (
            <li key={row.id}>
              <MealRow idPrefix={idPrefix} index={index} row={row} errors={errors[index] ?? {}} onChange={(patch) => update(index, patch)} onRemove={() => remove(index)} />
            </li>
          ))}
        </ol>
      )}
      {rows.length > 0 && (
        <p className="text-sm text-foreground" aria-live="polite" data-testid="meal-plan-reads-as">{readsAs(filled)}</p>
      )}
      {planError && <p className="text-sm text-destructive" role="alert">{planError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {rows.length < MEAL_SLOTS_MAX && (
          <Button type="button" variant="outline" size="sm" onClick={add} data-testid="meal-plan-add">
            <Plus aria-hidden className="mr-2 h-4 w-4" /> {rows.length === 0 ? 'Add meal times' : 'Add a meal'}
          </Button>
        )}
        {confirmed && rows.length === 0 && (
          <p className="text-xs text-muted-foreground">Meal times can&apos;t be removed, only changed. Add at least one meal.</p>
        )}
      </div>
      {rows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Times are in the household&apos;s time zone. Saving starts this plan today; earlier days keep the plan they had.
        </p>
      )}
    </fieldset>
  );
}

function Suggestion({ schedule, legacy, confirmed, onUse }: { schedule: string; legacy: FeedingPlan | null; confirmed: boolean; onUse: (rows: MealSlotDraft[]) => void }) {
  const parsed = parseSchedule(schedule);
  const keeps = legacy && !confirmed
    ? `Until meal times are saved, it keeps its daily count${legacy.perDay ? ` (${legacy.perDay} a day)` : ''} and never shows a meal as due.`
    : null;
  if (parsed.kind === 'plan') {
    return (
      <div className="space-y-2 rounded-md bg-muted/60 p-3 text-sm" data-testid="meal-plan-suggestion">
        <p className="font-medium text-foreground">{readsAs(parsed.meals)}</p>
        <ul className="space-y-0.5 text-muted-foreground">
          {parsed.meals.map((meal) => (
            <li key={meal.time}>{meal.name} · {formatSlotTime(meal.time)} · {formatPortion(meal.amount, meal.unit)}</li>
          ))}
        </ul>
        {(parsed.timesGuessed || parsed.portionGuessed) && (
          <p className="text-xs text-muted-foreground">
            {parsed.timesGuessed && parsed.portionGuessed
              ? 'The times and portion are a guess: check them before saving.'
              : parsed.timesGuessed ? 'The times are a guess: check them before saving.' : 'The portion is a guess: check it before saving.'}
          </p>
        )}
        <Button type="button" size="sm" variant="secondary" onClick={() => onUse(draftFromSuggestion(parsed))} data-testid="meal-plan-use-suggestion">
          <Wand2 aria-hidden className="mr-2 h-4 w-4" /> Use these meal times
        </Button>
        {keeps && <p className="text-xs text-muted-foreground">{keeps}</p>}
      </div>
    );
  }
  const message = parsed.kind === 'ambiguous'
    ? `The schedule can't be read as meal times (${parsed.reason.replace(/\.$/, '').toLowerCase()}). Add them below.`
    : parsed.kind === 'nonDaily'
      ? 'The schedule is not daily, so no meal times are suggested. Add them below if the meals have fixed times.'
      : schedule.trim()
        ? 'No meal times were found in the schedule. Add them below.'
        : 'Add meal times so everyone sees which meal is next.';
  return (
    <div className="space-y-1 text-sm text-muted-foreground" data-testid="meal-plan-no-suggestion" data-parsed={parsed.kind}>
      <p>{message}</p>
      {keeps && <p className="text-xs">{keeps}</p>}
    </div>
  );
}

function MealRow({
  idPrefix,
  index,
  row,
  errors,
  onChange,
  onRemove,
}: {
  idPrefix: string;
  index: number;
  row: MealSlotDraft;
  errors: MealSlotErrors;
  onChange: (patch: Partial<MealSlotDraft>) => void;
  onRemove: () => void;
}) {
  const id = (field: keyof MealSlotErrors) => mealFieldId(idPrefix, index, field);
  const label = row.name.trim() || `meal ${index + 1}`;
  const toggleDay = (day: number) => onChange({ offDays: row.offDays.includes(day) ? row.offDays.filter((value) => value !== day) : [...row.offDays, day].sort() });
  return (
    <div className="grid gap-2 rounded-md border bg-background p-3" data-testid={`meal-row-${index}`}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_8rem]">
        <div className="grid gap-1">
          <Label htmlFor={id('name')}>Meal</Label>
          <Input
            value={row.name}
            maxLength={MEAL_SLOT_NAME_MAX + 5}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="Breakfast"
            autoComplete="off"
            {...fieldErrorProps(id('name'), errors.name)}
          />
          <FieldError id={id('name')}>{errors.name}</FieldError>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={id('time')}>Time</Label>
          <Input type="time" step={60} value={row.time} onChange={(event) => onChange({ time: event.target.value.slice(0, 5) })} {...fieldErrorProps(id('time'), errors.time)} />
          <FieldError id={id('time')}>{errors.time}</FieldError>
        </div>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={id('amount')}>Portion</Label>
        <div className="flex gap-2">
          <Input
            type="number"
            inputMode="decimal"
            min={0.01}
            max={PORTION_MAX}
            step="any"
            value={row.amount}
            onChange={(event) => onChange({ amount: event.target.value })}
            className="min-w-0"
            {...fieldErrorProps(id('amount'), errors.amount)}
          />
          <Select value={row.unit} onValueChange={(unit) => onChange({ unit: unit as PortionUnit })}>
            <SelectTrigger className="w-28 shrink-0" aria-label={`Portion unit for ${label}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PORTION_UNITS.map((unit) => (
                <SelectItem key={unit} value={unit}>{UNIT_LABELS[unit]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <FieldError id={id('amount')}>{errors.amount}</FieldError>
      </div>
      <div className="grid gap-1">
        <span id={id('offDays')} className="text-sm font-medium leading-none">Skip on</span>
        <div className="flex flex-wrap gap-1" role="group" aria-labelledby={id('offDays')}>
          {WEEKDAYS.map((day, value) => {
            const skipped = row.offDays.includes(value);
            return (
              <button
                key={day.short}
                type="button"
                aria-pressed={skipped}
                aria-label={`Skip ${label} on ${day.long}`}
                onClick={() => toggleDay(value)}
                className={cn(
                  'inline-flex min-h-[var(--target-min)] min-w-[var(--target-min)] items-center justify-center rounded-md border text-sm transition-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  skipped ? 'border-foreground bg-muted text-foreground line-through' : 'border-input bg-background text-foreground hover:bg-muted',
                )}
              >
                {day.short}
              </button>
            );
          })}
        </div>
        <FieldError id={id('offDays')}>{errors.offDays}</FieldError>
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${label}`}>
          <Trash2 aria-hidden className="mr-2 h-4 w-4" /> Remove
        </Button>
      </div>
    </div>
  );
}
