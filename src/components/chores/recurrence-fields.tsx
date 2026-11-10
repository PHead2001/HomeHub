'use client';

import { useCallback, useState } from 'react';
import { format, getDay, parseISO } from 'date-fns';
import { Calendar as CalendarIcon } from 'lucide-react';
import type { MonthlyNthWeekday, MonthlyRecurrenceMode, Recurrence, RecurrenceFrequency } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { cn } from '@/lib/utils';

export const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const fullDayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const ordinalLabels: Record<MonthlyNthWeekday['week'], string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };

const isFrequency = (frequency: string): frequency is RecurrenceFrequency =>
  ['daily', 'weekly', 'biweekly', 'monthly'].includes(frequency);

export const getMonthlyMode = (recurrence: Recurrence): MonthlyRecurrenceMode => recurrence.monthlyOptions?.mode ?? 'dayOfMonth';

export const getRecurringWeekdays = (recurrence: Recurrence) => {
  const days = recurrence.weeklyOptions?.daysOfWeek?.filter(day => Number.isInteger(day) && day >= 0 && day <= 6) || [];
  if (days.length > 0) return days;
  const anchor = recurrence.startDate ? parseISO(recurrence.startDate) : new Date();
  return [Number.isNaN(anchor.getTime()) ? getDay(new Date()) : getDay(anchor)];
};

/** Supplies defaults for old recurrence records (interval, weekdays, anchors, monthly mode). */
export const normalizeRecurrence = (recurrence?: Recurrence | null): Recurrence | null => {
  if (!recurrence || !isFrequency(recurrence.frequency)) return null;
  const normalized: Recurrence = { ...recurrence, interval: recurrence.frequency === 'biweekly' ? 2 : (recurrence.interval || 1) };
  if (normalized.frequency === 'daily') normalized.dailyOptions = { excludeWeekends: Boolean(recurrence.dailyOptions?.excludeWeekends) };
  if (normalized.frequency === 'weekly' || normalized.frequency === 'biweekly') normalized.weeklyOptions = { daysOfWeek: getRecurringWeekdays(normalized) };
  if (normalized.frequency === 'biweekly') normalized.startDate = recurrence.startDate || format(new Date(), 'yyyy-MM-dd');
  if (normalized.frequency === 'monthly') {
    const mode = getMonthlyMode(normalized);
    normalized.monthlyOptions = mode === 'nthWeekday' && recurrence.monthlyOptions?.nthWeekday
      ? { mode: 'nthWeekday', nthWeekday: recurrence.monthlyOptions.nthWeekday }
      : { mode: 'dayOfMonth', dayOfMonth: recurrence.monthlyOptions?.dayOfMonth || 1 };
  }
  return normalized;
};

export const scheduleText = (recurrence: Recurrence | null | undefined) => {
  const normalized = normalizeRecurrence(recurrence);
  if (!normalized) return 'One-time';
  const days = () => [...getRecurringWeekdays(normalized)].sort().map(d => dayNames[d]).join(', ');
  switch (normalized.frequency) {
    case 'daily': return normalized.dailyOptions?.excludeWeekends ? 'Weekdays' : 'Every day';
    case 'weekly': return `Weekly on ${days()}`;
    case 'biweekly': {
      const anchor = normalized.startDate ? ` from ${format(parseISO(normalized.startDate), 'MMM d, yyyy')}` : '';
      return `Every 2 weeks on ${days()}${anchor}`;
    }
    case 'monthly':
      if (getMonthlyMode(normalized) === 'nthWeekday' && normalized.monthlyOptions?.nthWeekday) {
        const { week, dayOfWeek } = normalized.monthlyOptions.nthWeekday;
        return `Monthly on the ${ordinalLabels[week]} ${fullDayNames[dayOfWeek]}`;
      }
      return `Monthly on day ${normalized.monthlyOptions?.dayOfMonth || 1}`;
    default: return 'Invalid schedule';
  }
};

export type RecurrenceState = {
  frequency: RecurrenceFrequency;
  excludeWeekends: boolean;
  daysOfWeek: string[];
  biweeklyStartDate: Date | undefined;
  monthlyMode: MonthlyRecurrenceMode;
  dayOfMonth: number;
  nthWeek: MonthlyNthWeekday['week'];
  nthWeekday: number;
};

export const defaultRecurrenceState = (): RecurrenceState => ({
  frequency: 'weekly',
  excludeWeekends: false,
  daysOfWeek: [],
  biweeklyStartDate: new Date(),
  monthlyMode: 'dayOfMonth',
  dayOfMonth: 1,
  nthWeek: 1,
  nthWeekday: 1,
});

export const recurrenceStateFrom = (recurrence: Recurrence | null | undefined): RecurrenceState => {
  const normalized = normalizeRecurrence(recurrence);
  if (!normalized) return defaultRecurrenceState();
  return {
    frequency: normalized.frequency,
    excludeWeekends: normalized.dailyOptions?.excludeWeekends || false,
    daysOfWeek: getRecurringWeekdays(normalized).map(String),
    biweeklyStartDate: normalized.startDate ? parseISO(normalized.startDate) : new Date(),
    monthlyMode: getMonthlyMode(normalized),
    dayOfMonth: normalized.monthlyOptions?.dayOfMonth || 1,
    nthWeek: normalized.monthlyOptions?.nthWeekday?.week || 1,
    nthWeekday: normalized.monthlyOptions?.nthWeekday?.dayOfWeek ?? 1,
  };
};

export type RecurrenceErrors = { daysOfWeek?: string; biweeklyStartDate?: string };

/** Builds the stored recurrence, or the inline errors to show. */
export function buildRecurrence(state: RecurrenceState): { recurrence: Omit<Recurrence, 'assignedToEmail'> } | { errors: RecurrenceErrors } {
  const recurrence: Omit<Recurrence, 'assignedToEmail'> = { frequency: state.frequency, interval: 1 };
  const errors: RecurrenceErrors = {};
  if (state.frequency === 'daily') recurrence.dailyOptions = { excludeWeekends: state.excludeWeekends };
  if (state.frequency === 'weekly' || state.frequency === 'biweekly') {
    if (state.daysOfWeek.length === 0) errors.daysOfWeek = 'Pick at least one day.';
    recurrence.weeklyOptions = { daysOfWeek: state.daysOfWeek.map(Number) };
  }
  if (state.frequency === 'biweekly') {
    if (!state.biweeklyStartDate) errors.biweeklyStartDate = 'Pick the week to start from.';
    else recurrence.startDate = format(state.biweeklyStartDate, 'yyyy-MM-dd');
    recurrence.interval = 2;
  }
  if (state.frequency === 'monthly') {
    recurrence.monthlyOptions = state.monthlyMode === 'dayOfMonth'
      ? { mode: 'dayOfMonth', dayOfMonth: state.dayOfMonth }
      : { mode: 'nthWeekday', nthWeekday: { week: state.nthWeek, dayOfWeek: state.nthWeekday } };
  }
  return Object.keys(errors).length > 0 ? { errors } : { recurrence };
}

export function useRecurrenceState(initial: () => RecurrenceState = defaultRecurrenceState) {
  const [state, setState] = useState<RecurrenceState>(initial);
  const update = useCallback(<K extends keyof RecurrenceState>(key: K, value: RecurrenceState[K]) => {
    setState(previous => ({ ...previous, [key]: value }));
  }, []);
  return { state, setState, update };
}

const chipClass = 'text-xs p-2 border rounded-md cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/10';

/** Frequency, days and monthly options. Errors show inline next to their field. */
export function RecurrenceFields({
  idPrefix,
  state,
  update,
  errors,
}: {
  idPrefix: string;
  state: RecurrenceState;
  update: <K extends keyof RecurrenceState>(key: K, value: RecurrenceState[K]) => void;
  errors: RecurrenceErrors;
}) {
  const daysId = `${idPrefix}-days`;
  const anchorId = `${idPrefix}-anchor`;
  return (
    <div className="space-y-4">
      <RadioGroup aria-label="How often" value={state.frequency} onValueChange={(v) => update('frequency', v as RecurrenceFrequency)} className="flex flex-wrap gap-2">
        {(['daily', 'weekly', 'biweekly', 'monthly'] as const).map(value => (
          <Label key={value} htmlFor={`${idPrefix}-${value}`} className={chipClass}>
            <RadioGroupItem value={value} id={`${idPrefix}-${value}`} className="mr-1" />
            {{ daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' }[value]}
          </Label>
        ))}
      </RadioGroup>

      {state.frequency === 'daily' && (
        <RadioGroup aria-label="Which days" value={state.excludeWeekends ? 'weekdays' : 'all'} onValueChange={(v) => update('excludeWeekends', v === 'weekdays')} className="flex gap-2">
          <Label htmlFor={`${idPrefix}-all-days`} className={chipClass}><RadioGroupItem value="all" id={`${idPrefix}-all-days`} className="mr-1" /> Every day</Label>
          <Label htmlFor={`${idPrefix}-weekdays-only`} className={chipClass}><RadioGroupItem value="weekdays" id={`${idPrefix}-weekdays-only`} className="mr-1" /> Weekdays only</Label>
        </RadioGroup>
      )}

      {(state.frequency === 'weekly' || state.frequency === 'biweekly') && (
        <div className="space-y-3">
          <div>
            <Label id={`${daysId}-label`}>{state.frequency === 'biweekly' ? 'Repeat every other week on' : 'Repeat weekly on'}</Label>
            <ToggleGroup
              type="multiple"
              aria-labelledby={`${daysId}-label`}
              value={state.daysOfWeek}
              onValueChange={(value) => update('daysOfWeek', value)}
              className="flex flex-wrap justify-start gap-1 pt-2"
              {...fieldErrorProps(daysId, errors.daysOfWeek)}
            >
              {dayNames.map((day, i) => (
                <ToggleGroupItem
                  key={day}
                  value={String(i)}
                  aria-label={fullDayNames[i]}
                  className="h-[var(--target-min)] min-w-[var(--target-min)] rounded-full border border-input px-3 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  {day}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldError id={daysId} className="mt-1">{errors.daysOfWeek}</FieldError>
          </div>
          {state.frequency === 'biweekly' && (
            <div>
              <Label htmlFor={anchorId}>Start from the week of</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" {...fieldErrorProps(anchorId, errors.biweeklyStartDate)} className={cn('w-full justify-start text-left font-normal', !state.biweeklyStartDate && 'text-muted-foreground')}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {state.biweeklyStartDate ? format(state.biweeklyStartDate, 'PPP') : <span>Pick a start date</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={state.biweeklyStartDate} onSelect={(date) => update('biweeklyStartDate', date)} initialFocus />
                </PopoverContent>
              </Popover>
              <FieldError id={anchorId} className="mt-1">{errors.biweeklyStartDate}</FieldError>
            </div>
          )}
        </div>
      )}

      {state.frequency === 'monthly' && (
        <div className="space-y-3">
          <RadioGroup aria-label="Monthly by" value={state.monthlyMode} onValueChange={(v) => update('monthlyMode', v as MonthlyRecurrenceMode)} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Label htmlFor={`${idPrefix}-monthly-day-mode`} className={chipClass}><RadioGroupItem value="dayOfMonth" id={`${idPrefix}-monthly-day-mode`} className="mr-1" /> Day of month</Label>
            <Label htmlFor={`${idPrefix}-monthly-nth-mode`} className={chipClass}><RadioGroupItem value="nthWeekday" id={`${idPrefix}-monthly-nth-mode`} className="mr-1" /> Nth weekday</Label>
          </RadioGroup>
          {state.monthlyMode === 'dayOfMonth' ? (
            <div>
              <Label htmlFor={`${idPrefix}-day-of-month`}>Day of month</Label>
              <Select onValueChange={(v) => update('dayOfMonth', Number(v))} value={String(state.dayOfMonth)}>
                <SelectTrigger id={`${idPrefix}-day-of-month`}><SelectValue /></SelectTrigger>
                <SelectContent>{Array.from({ length: 28 }, (_, i) => i + 1).map(d => <SelectItem key={d} value={String(d)}>{d}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <Label htmlFor={`${idPrefix}-nth-week`}>Week</Label>
                <Select onValueChange={(v) => update('nthWeek', Number(v) as MonthlyNthWeekday['week'])} value={String(state.nthWeek)}>
                  <SelectTrigger id={`${idPrefix}-nth-week`}><SelectValue /></SelectTrigger>
                  <SelectContent>{([1, 2, 3, 4] as const).map(week => <SelectItem key={week} value={String(week)}>{ordinalLabels[week]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-nth-weekday`}>Weekday</Label>
                <Select onValueChange={(v) => update('nthWeekday', Number(v))} value={String(state.nthWeekday)}>
                  <SelectTrigger id={`${idPrefix}-nth-weekday`}><SelectValue /></SelectTrigger>
                  <SelectContent>{fullDayNames.map((day, i) => <SelectItem key={day} value={String(i)}>{day}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
