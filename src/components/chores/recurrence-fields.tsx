'use client';

import { useCallback, useState } from 'react';
import { format, getDay, parseISO } from 'date-fns';
import { Calendar as CalendarIcon } from 'lucide-react';
import type { MonthlyNthWeekday, MonthlyRecurrenceMode, Recurrence, RecurrenceFrequency } from '@/lib/types';
import { weekStartOf } from '@functions/shared/recurrence';
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
  const stepped = normalized.frequency !== 'monthly' && (normalized.interval || 1) > 1;
  if (normalized.frequency === 'daily') normalized.dailyOptions = { excludeWeekends: Boolean(recurrence.dailyOptions?.excludeWeekends) };
  if (normalized.frequency === 'weekly' || normalized.frequency === 'biweekly') normalized.weeklyOptions = { daysOfWeek: getRecurringWeekdays(normalized) };
  if (normalized.frequency === 'biweekly' || stepped) normalized.startDate = recurrence.startDate || format(new Date(), 'yyyy-MM-dd');
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
  const interval = normalized.interval || 1;
  const until = normalized.endDate ? ` until ${format(parseISO(normalized.endDate), 'MMM d, yyyy')}` : '';
  const anchor = normalized.startDate ? ` from ${format(parseISO(normalized.startDate), 'MMM d, yyyy')}` : '';
  switch (normalized.frequency) {
    case 'daily':
      if (interval > 1) return `Every ${interval} days${anchor}${until}`;
      return `${normalized.dailyOptions?.excludeWeekends ? 'Weekdays' : 'Every day'}${until}`;
    case 'weekly':
      if (interval > 1) return `Every ${interval} weeks on ${days()}${anchor}${until}`;
      return `Weekly on ${days()}${until}`;
    case 'biweekly': {
      return `Every 2 weeks on ${days()}${anchor}${until}`;
    }
    case 'monthly':
      if (getMonthlyMode(normalized) === 'nthWeekday' && normalized.monthlyOptions?.nthWeekday) {
        const { week, dayOfWeek } = normalized.monthlyOptions.nthWeekday;
        return `Monthly on the ${ordinalLabels[week]} ${fullDayNames[dayOfWeek]}${until}`;
      }
      return `Monthly on day ${normalized.monthlyOptions?.dayOfMonth || 1}${until}`;
    default: return 'Invalid schedule';
  }
};

export type RecurrenceState = {
  frequency: RecurrenceFrequency;
  excludeWeekends: boolean;
  daysOfWeek: string[];
  /** The day it starts (any frequency; a stepped weekly schedule starts on that week). */
  biweeklyStartDate: Date | undefined;
  /** Every N days (daily) or N weeks (weekly); 1 by default (CH-10). */
  interval?: number;
  /** Last day it repeats; none repeats for good (CH-10). */
  endDate?: Date;
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
    interval: normalized.frequency === 'biweekly' ? 1 : (normalized.interval || 1),
    endDate: normalized.endDate ? parseISO(normalized.endDate) : undefined,
    monthlyMode: getMonthlyMode(normalized),
    dayOfMonth: normalized.monthlyOptions?.dayOfMonth || 1,
    nthWeek: normalized.monthlyOptions?.nthWeekday?.week || 1,
    nthWeekday: normalized.monthlyOptions?.nthWeekday?.dayOfWeek ?? 1,
  };
};

export type RecurrenceErrors = { daysOfWeek?: string; biweeklyStartDate?: string; endDate?: string };

/** Builds the stored recurrence, or the inline errors to show. */
export function buildRecurrence(state: RecurrenceState): { recurrence: Omit<Recurrence, 'assignedToEmail'> } | { errors: RecurrenceErrors } {
  const recurrence: Omit<Recurrence, 'assignedToEmail'> = { frequency: state.frequency, interval: 1 };
  const errors: RecurrenceErrors = {};
  const interval = state.frequency === 'daily' || state.frequency === 'weekly' ? Math.min(30, Math.max(1, Math.round(state.interval ?? 1))) : 1;
  if (state.frequency === 'daily') recurrence.dailyOptions = { excludeWeekends: interval === 1 && state.excludeWeekends };
  if (state.frequency === 'weekly' || state.frequency === 'biweekly') {
    if (state.daysOfWeek.length === 0) errors.daysOfWeek = 'Pick at least one day.';
    recurrence.weeklyOptions = { daysOfWeek: state.daysOfWeek.map(Number) };
  }
  // Every 2 weeks and every N weeks start on the Monday of the picked week, so a Mon and
  // Fri pair always lands in the same week; every N days counts from the picked day (CH-10).
  const weeksStepped = state.frequency === 'biweekly' || (state.frequency === 'weekly' && interval > 1);
  if (weeksStepped || (state.frequency === 'daily' && interval > 1)) {
    if (!state.biweeklyStartDate) errors.biweeklyStartDate = weeksStepped ? 'Pick the week to start from.' : 'Pick the day to start from.';
  }
  // A start of "today" is no start: it repeats from now. That also keeps a device whose
  // day differs from the household's from moving today's occurrence (occursOn compares
  // household days). A later start, or a stepped schedule's anchor, is stored.
  const stepped = weeksStepped || (state.frequency === 'daily' && interval > 1);
  if (state.biweeklyStartDate && state.frequency !== 'monthly') {
    const day = format(state.biweeklyStartDate, 'yyyy-MM-dd');
    if (stepped || day > format(new Date(), 'yyyy-MM-dd')) recurrence.startDate = weeksStepped ? weekStartOf(day) : day;
  }
  if (state.frequency === 'biweekly') recurrence.interval = 2;
  else if (interval > 1) recurrence.interval = interval;
  if (state.endDate) {
    const end = format(state.endDate, 'yyyy-MM-dd');
    if (state.biweeklyStartDate && end < format(state.biweeklyStartDate, 'yyyy-MM-dd')) errors.endDate = 'The end comes before the start.';
    else recurrence.endDate = end;
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

      {(state.frequency === 'daily' || state.frequency === 'weekly') && (
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-interval`}>Every</Label>
          <Select onValueChange={(v) => update('interval', Number(v))} value={String(state.interval ?? 1)}>
            <SelectTrigger id={`${idPrefix}-interval`} className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent>{Array.from({ length: state.frequency === 'daily' ? 14 : 8 }, (_, i) => i + 1).map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">{state.frequency === 'daily' ? ((state.interval ?? 1) === 1 ? 'day' : 'days') : ((state.interval ?? 1) === 1 ? 'week' : 'weeks')}</span>
        </div>
      )}

      {state.frequency === 'daily' && (state.interval ?? 1) === 1 && (
        <RadioGroup aria-label="Which days" value={state.excludeWeekends ? 'weekdays' : 'all'} onValueChange={(v) => update('excludeWeekends', v === 'weekdays')} className="flex gap-2">
          <Label htmlFor={`${idPrefix}-all-days`} className={chipClass}><RadioGroupItem value="all" id={`${idPrefix}-all-days`} className="mr-1" /> Every day</Label>
          <Label htmlFor={`${idPrefix}-weekdays-only`} className={chipClass}><RadioGroupItem value="weekdays" id={`${idPrefix}-weekdays-only`} className="mr-1" /> Weekdays only</Label>
        </RadioGroup>
      )}

      {(state.frequency === 'weekly' || state.frequency === 'biweekly') && (
        <div className="space-y-3">
          <div>
            <Label id={`${daysId}-label`}>{state.frequency === 'biweekly' ? 'Repeat every other week on' : (state.interval ?? 1) > 1 ? `Repeat every ${state.interval} weeks on` : 'Repeat weekly on'}</Label>
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
        </div>
      )}

      {/* A stepped schedule needs its start (the week or day it counts from). */}
      {(state.frequency === 'biweekly' || ((state.frequency === 'weekly' || state.frequency === 'daily') && (state.interval ?? 1) > 1)) && (
        <div>
          <Label htmlFor={anchorId}>{state.frequency === 'biweekly' || (state.frequency === 'weekly' && (state.interval ?? 1) > 1) ? 'Start from the week of' : 'Starts on'}</Label>
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

      {/* Start and end stay folded so the form stays short (5.6); open when set. */}
      <details className="rounded-md border px-3 py-2" open={Boolean(state.endDate) || (!(state.frequency === 'biweekly' || ((state.frequency === 'weekly' || state.frequency === 'daily') && (state.interval ?? 1) > 1)) && !!state.biweeklyStartDate && format(state.biweeklyStartDate, 'yyyy-MM-dd') > format(new Date(), 'yyyy-MM-dd'))}>
        <summary className="cursor-pointer select-none py-1 text-sm font-medium">Start and end</summary>
        <div className="space-y-3 pt-2">
          {!(state.frequency === 'biweekly' || ((state.frequency === 'weekly' || state.frequency === 'daily') && (state.interval ?? 1) > 1)) && state.frequency !== 'monthly' && (
            <div>
              <Label htmlFor={anchorId}>Starts on</Label>
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
          <div>
            <Label htmlFor={`${idPrefix}-end`}>Ends</Label>
            <div className="flex gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" {...fieldErrorProps(`${idPrefix}-end`, errors.endDate)} className={cn('flex-1 justify-start text-left font-normal', !state.endDate && 'text-muted-foreground')}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {state.endDate ? format(state.endDate, 'PPP') : <span>Never</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={state.endDate} onSelect={(date) => update('endDate', date)} initialFocus />
                </PopoverContent>
              </Popover>
              {state.endDate && <Button type="button" variant="ghost" onClick={() => update('endDate', undefined)}>Never ends</Button>}
            </div>
            <FieldError id={`${idPrefix}-end`} className="mt-1">{errors.endDate}</FieldError>
          </div>
    
        </div>
      </details>

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
