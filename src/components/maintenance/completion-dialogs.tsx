'use client';

import * as React from 'react';
import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MAX_MILEAGE } from '@/lib/maintenance/operations';
import {
  calculateNextAssetDueDate,
  calculateNextVehicleDueDate,
  calculateNextVehicleMileage,
  type ScheduleCompletionTarget,
} from '@/lib/maintenance/schedules';
import { AutoResizeTextarea, MileageWarning, SaveNotice } from './page-parts';
import {
  completionFormValues, getScheduleCompletionName, scheduleCompletionSchema, toNumber,
  type SaveNoticeState, type ScheduleCompletionFormValues,
} from './page-model';

/** The latest non-null value (state, not a ref, so it is safe to read while rendering). */
function useLastValue<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

export type CompletionFormHandle = { setError: (field: keyof ScheduleCompletionFormValues, message: string) => void };

/** Complete Scheduled Maintenance: record the work and set when it is next due. */
export const ScheduleCompletionDialog = React.memo(function ScheduleCompletionDialog({
  target,
  session,
  onOpenChange,
  ...body
}: {
  target: ScheduleCompletionTarget | null;
  session: number;
  onOpenChange: (open: boolean) => void;
} & Omit<CompletionBodyProps, 'onCancel' | 'target'>) {
  const cancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  // Keeps the last target on screen while the dialog animates closed.
  const shown = useLastValue(target);
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))] max-w-xl flex-col overflow-hidden p-0">
        {shown && <ScheduleCompletionBody key={session} target={shown} {...body} onCancel={cancel} />}
      </DialogContent>
    </Dialog>
  );
});

type CompletionBodyProps = {
  target: ScheduleCompletionTarget;
  today: string;
  busy: boolean;
  notice?: SaveNoticeState;
  mileageMessage?: string;
  onCancel: () => void;
  onSubmit: (values: ScheduleCompletionFormValues, form: CompletionFormHandle) => void | Promise<void>;
};

function ScheduleCompletionBody({ target, today, busy, notice, mileageMessage, onCancel, onSubmit }: CompletionBodyProps) {
  const [initial] = useState(() => completionFormValues(target, today));
  const scheduleCompletionForm = useForm<ScheduleCompletionFormValues>({
    resolver: zodResolver(scheduleCompletionSchema),
    defaultValues: initial,
  });
  const submit = async (values: ScheduleCompletionFormValues) => {
    const handle: CompletionFormHandle = {
      setError: (field, message) => scheduleCompletionForm.setError(field, { message }, { shouldFocus: true }),
    };
    const mileage = target.targetType === 'vehicle' ? toNumber(values.mileage) : undefined;
    if (typeof mileage === 'number' && (!Number.isInteger(mileage) || mileage < 0 || mileage > MAX_MILEAGE)) {
      handle.setError('mileage', 'Enter the mileage as a whole number.');
      return;
    }
    await onSubmit(values, handle);
  };

  return (
    <>
      <DialogHeader className="px-6 pb-0 pr-10 pt-6">
        <DialogTitle>Complete Scheduled Maintenance</DialogTitle>
        <DialogDescription>
          Record the completed work and set when it should come up again.
        </DialogDescription>
      </DialogHeader>
      <Form {...scheduleCompletionForm}>
        <form onSubmit={scheduleCompletionForm.handleSubmit(submit)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-4">
            {target && (
              <div className="mb-4 rounded-lg border p-3">
                <p className="text-sm font-medium">{getScheduleCompletionName(target)}</p>
                <p className="text-sm text-muted-foreground">
                  {target.targetType === 'home_asset'
                    ? target.asset.name
                    : target.vehicle.nickname}
                </p>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField control={scheduleCompletionForm.control} name="completedDate" render={({ field }) => (
                <FormItem>
                  <FormLabel>Completed Date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      {...field}
                      onChange={(event) => {
                        field.onChange(event);
                        const completedDate = event.target.value;
                        if (!target || !completedDate) return;
                        const nextDate = target.targetType === 'home_asset'
                          ? calculateNextAssetDueDate(target.schedule, completedDate)
                          : calculateNextVehicleDueDate(target.schedule, completedDate);
                        if (nextDate) {
                          scheduleCompletionForm.setValue('nextDueDate', nextDate);
                        }
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              {target?.targetType === 'vehicle' && (
                <FormField control={scheduleCompletionForm.control} name="mileage" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Completed Mileage</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min="0"
                        step="1"
                        {...field}
                        onChange={(event) => {
                          field.onChange(event);
                          const nextMileage = target
                            ? calculateNextVehicleMileage(target.schedule, toNumber(event.target.value))
                            : undefined;
                          if (typeof nextMileage === 'number') {
                            scheduleCompletionForm.setValue('nextDueMileage', nextMileage.toString());
                          }
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              )}
              <FormField control={scheduleCompletionForm.control} name="nextDueDate" render={({ field }) => (
                <FormItem>
                  <FormLabel>Next Due Date</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              {target?.targetType === 'vehicle' && (
                <FormField control={scheduleCompletionForm.control} name="nextDueMileage" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Next Due Mileage</FormLabel>
                    <FormControl><Input type="number" min="0" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              )}
              <MileageWarning message={mileageMessage} />
              <FormField control={scheduleCompletionForm.control} name="notes" render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Log Notes</FormLabel>
                  <FormControl><AutoResizeTextarea rows={3} placeholder="What was completed, parts used, or follow-up notes." {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
          </div>
          <DialogFooter className="border-t px-6 py-4">
            <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              {mileageMessage ? 'Save anyway' : 'Complete Maintenance'}
            </Button>
          </DialogFooter>
          <SaveNotice notice={notice} busy={busy} />
        </form>
      </Form>
    </>
  );
}

/** Confirm mileage (MA-6a): Mark done on a service due by mileage asks for the odometer first. */
export const MileageDialog = React.memo(function MileageDialog({
  target,
  session,
  onOpenChange,
  ...body
}: {
  target: Extract<ScheduleCompletionTarget, { targetType: 'vehicle' }> | null;
  session: number;
  onOpenChange: (open: boolean) => void;
} & Omit<MileageBodyProps, 'onCancel' | 'target'>) {
  const cancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  const shown = useLastValue(target);
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {shown && <MileageBody key={session} target={shown} {...body} onCancel={cancel} />}
      </DialogContent>
    </Dialog>
  );
});

type MileageBodyProps = {
  target: Extract<ScheduleCompletionTarget, { targetType: 'vehicle' }>;
  busy: boolean;
  notice?: SaveNoticeState;
  mileageMessage?: string;
  onCancel: () => void;
  /** `setError` puts a message under the reading (a refusal, or no next service computable). */
  onSubmit: (reading: number, setError: (message: string) => void) => void | Promise<void>;
};

function MileageBody({ target, busy, notice, mileageMessage, onCancel, onSubmit }: MileageBodyProps) {
  const [mileageInput, setMileageInput] = useState(() => (typeof target.vehicle.currentMileage === 'number' ? String(target.vehicle.currentMileage) : ''));
  const [mileageInputError, setMileageInputError] = useState<string | null>(null);
  const submit = async () => {
    const reading = Number(mileageInput.trim());
    if (!mileageInput.trim() || !Number.isInteger(reading) || reading < 0 || reading > MAX_MILEAGE) {
      setMileageInputError('Enter the odometer reading as a whole number.');
      return;
    }
    setMileageInputError(null);
    await onSubmit(reading, setMileageInputError);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Confirm mileage</DialogTitle>
        <DialogDescription>
          {target
            ? `${getScheduleCompletionName(target)} for ${target.vehicle.nickname}: the odometer reading now, so the next service is scheduled from it.`
            : null}
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="maintenance-confirm-mileage">Odometer (miles)</Label>
          <Input
            id="maintenance-confirm-mileage"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={mileageInput}
            aria-invalid={Boolean(mileageInputError)}
            aria-describedby={mileageInputError ? 'maintenance-confirm-mileage-error' : undefined}
            onChange={(event) => {
              setMileageInput(event.target.value.replace(/[^0-9]/g, ''));
              setMileageInputError(null);
            }}
          />
          {mileageInputError && <p id="maintenance-confirm-mileage-error" className="text-sm font-medium text-destructive">{mileageInputError}</p>}
        </div>
        <MileageWarning message={mileageMessage} />
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
            {mileageMessage ? 'Save anyway' : 'Mark done'}
          </Button>
        </DialogFooter>
      </form>
      <SaveNotice notice={notice} busy={busy} />
    </>
  );
}
