'use client';

import * as React from 'react';
import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AutoResizeTextarea } from './page-parts';

/** One text, number or date field of a maintenance form (react-hook-form). */
export function TextField<T extends FieldValues>({
  control, name, label, type = 'text', placeholder, className, inputMode, min, step,
}: {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  type?: 'text' | 'number' | 'date';
  placeholder?: string;
  className?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  min?: string;
  step?: string;
}) {
  return (
    <FormField control={control} name={name} render={({ field }) => (
      <FormItem className={className}>
        <FormLabel>{label}</FormLabel>
        <FormControl>
          <Input type={type} placeholder={placeholder} inputMode={inputMode} min={min} step={step} {...field} value={(field.value as string | undefined) ?? ''} />
        </FormControl>
        <FormMessage />
      </FormItem>
    )} />
  );
}

export function NotesField<T extends FieldValues>({ control, name, placeholder }: { control: Control<T>; name: FieldPath<T>; placeholder: string }) {
  return (
    <FormField control={control} name={name} render={({ field }) => (
      <FormItem className="sm:col-span-2">
        <FormLabel>Notes</FormLabel>
        <FormControl><AutoResizeTextarea rows={3} placeholder={placeholder} {...field} value={(field.value as string | undefined) ?? ''} /></FormControl>
        <FormMessage />
      </FormItem>
    )} />
  );
}

export function SelectField<T extends FieldValues>({
  control, name, label, options, className,
}: {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <FormField control={control} name={name} render={({ field }) => (
      <FormItem className={className}>
        <FormLabel>{label}</FormLabel>
        <Select onValueChange={field.onChange} value={field.value as string}>
          <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
          <SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
        <FormMessage />
      </FormItem>
    )} />
  );
}

/** "More details" / "Add details (N empty)": reveals the form's other fields (MA-15). */
export function DetailsToggle({ label, onClick, controls }: { label: string; onClick: () => void; controls: string }) {
  return (
    <Button type="button" variant="outline" size="sm" className="sm:col-span-2 justify-self-start" aria-expanded={false} aria-controls={controls} onClick={onClick}>
      <ChevronDown aria-hidden className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Calendar anchoring of one schedule (MA-11g): "Keep it on a calendar day" with the month (or any
 * month) and the day. Off: the next due counts from the day it was done (the default).
 */
export function AnchorControl({
  id, anchor, anchorMonth, anchorDay, onChange, yearly,
}: {
  id: string;
  anchor: '' | 'completion' | 'calendar';
  anchorMonth: string;
  anchorDay: string;
  onChange: (patch: { anchor?: '' | 'completion' | 'calendar'; anchorMonth?: string; anchorDay?: string }) => void;
  /** Month only makes sense for intervals of a year or months that divide one. */
  yearly: boolean;
}) {
  const on = anchor === 'calendar';
  return (
    <div className="space-y-2 sm:col-span-2" data-testid={`anchor-${id}`}>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`anchor-${id}`}
          checked={on}
          onCheckedChange={(checked) => onChange({ anchor: checked === true ? 'calendar' : anchor === 'calendar' ? 'completion' : anchor })}
        />
        <Label htmlFor={`anchor-${id}`} className="text-sm font-normal">Keep it on a calendar day (e.g. gutters every October)</Label>
      </div>
      {on && (
        <div className="grid gap-3 sm:grid-cols-2">
          {yearly && (
            <div className="space-y-1">
              <Label htmlFor={`anchor-month-${id}`}>Month</Label>
              <Select value={anchorMonth || 'any'} onValueChange={(value) => onChange({ anchorMonth: value === 'any' ? '' : value })}>
                <SelectTrigger id={`anchor-month-${id}`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Same month as the due date</SelectItem>
                  {MONTHS.map((month, index) => <SelectItem key={month} value={String(index + 1)}>{month}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`anchor-day-${id}`}>Day of the month</Label>
            <Input
              id={`anchor-day-${id}`}
              type="number"
              inputMode="numeric"
              min="1"
              max="31"
              value={anchorDay}
              placeholder="1"
              onChange={(event) => onChange({ anchorDay: event.target.value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
