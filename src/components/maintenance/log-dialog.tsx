'use client';

import * as React from 'react';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MAX_MILEAGE } from '@/lib/maintenance/operations';
import type { ScheduleCompletionTarget } from '@/lib/maintenance/schedules';
import type { HomeAsset, MaintenanceLog, Vehicle } from '@/lib/types';
import { useAuth } from '@/hooks/use-auth';
import { detailsToggleLabel, emptyDetailFields, formIsDirty, visibleDetailFields } from '@/lib/maintenance/form-sections';
import { receiptFillPatch, type ReceiptFields } from '@/lib/maintenance/receipt-fill';
import { AutoResizeTextarea, MileageWarning, SaveNotice } from './page-parts';
import { FORM_FOOTER_CLASSES, MaintenanceFormDialog, useGuardedCancel, useReportDirty } from './form-shell';
import { DetailsToggle } from './form-fields';
import { ReceiptPicker } from './receipt-picker';
import { receiptStaging, type StagedReceipt } from './receipt-staging';
import {
  emptyLogForm, getScheduleCompletionName, humanizeLabel, logFormFromRecord, logSchema, logTypes, logValuesOf, toNumber,
  type LogFormValues, type LogPreset, type LogValues, type SaveNoticeState,
} from './page-model';

/** Lets the page put a server refusal under the right field. */
export type LogFormHandle = { setError: (field: keyof LogFormValues, message: string) => void };

/**
 * Add or edit a maintenance log; opened by Log service it also completes that schedule. What,
 * which item, date and cost up front (MA-15), the rest behind "More details"; "Receipt / photos"
 * stages files for the log and can read a receipt (MA-16, MA-30). The form is this dialog's own
 * state, initialised once per opening (see AssetDialog); unsaved changes ask before closing.
 */
export const LogDialog = React.memo(function LogDialog({
  open,
  session,
  onOpenChange,
  ...body
}: {
  open: boolean;
  session: number;
  onOpenChange: (open: boolean) => void;
} & LogDialogBodyProps) {
  return (
    <MaintenanceFormDialog open={open} busy={body.busy} onOpenChange={onOpenChange} className="max-w-2xl" testId="log-form">
      <LogDialogBody key={session} {...body} />
    </MaintenanceFormDialog>
  );
});

type LogDialogBodyProps = {
  record: MaintenanceLog | null;
  preset?: LogPreset;
  /** The schedule a "Log service" log completes when saved (D16). */
  scheduleTarget: ScheduleCompletionTarget | null;
  assets: HomeAsset[];
  vehicles: Vehicle[];
  /** The household's day: a new log defaults to it. */
  today: string;
  busy: boolean;
  notice?: SaveNoticeState;
  mileageMessage?: string;
  onSave: (save: { values: LogFormValues; base?: LogValues }, form: LogFormHandle) => void | Promise<void>;
};

function LogDialogBody({ record, preset, scheduleTarget, assets, vehicles, today, busy, notice, mileageMessage, onSave }: LogDialogBodyProps) {
  const cancel = useGuardedCancel();
  const { permissions } = useAuth();
  const [initial] = useState(() => {
    const form = record ? logFormFromRecord(record, today) : emptyLogForm(preset, today);
    return { form, base: record ? logValuesOf(form) : undefined };
  });
  const logForm = useForm<LogFormValues>({
    resolver: zodResolver(logSchema),
    defaultValues: initial.form,
  });
  const targetType = useWatch({ control: logForm.control, name: 'targetType' });
  const [expanded, setExpanded] = useState(false);
  const values = useWatch({ control: logForm.control }) as LogFormValues;
  const staged = useSyncExternalStore(receiptStaging.subscribe, receiptStaging.current, () => [] as readonly StagedReceipt[]);
  useReportDirty(formIsDirty(initial.form, values) || staged.length > 0);
  // A new log's files go up after it is saved (own log: allowed with maintenance.createLogs);
  // files on an existing log need maintenance.edit, as in the attachment panel.
  const canAttach = !record || permissions['maintenance.edit'];
  const vehicleLog = targetType === 'vehicle';
  // A vehicle log's mileage is always shown (the max rule and Log service need it; the page puts
  // refusals under it), so it is not one of the hidden details here.
  const shown = useMemo(() => new Set(visibleDetailFields('log', initial.form, expanded)), [initial.form, expanded]);
  const emptyCount = emptyDetailFields('log', initial.form).length;
  const allDetails = visibleDetailFields('log', initial.form, true).length;

  /** Fields the person changed since the form opened (a reading never overwrites them). */
  const editedFields = () => {
    const current = logForm.getValues();
    const changed = (field: 'cost' | 'serviceProvider' | 'partsUsed') => (current[field] ?? '').trim() !== (initial.form[field] ?? '').trim();
    return { cost: changed('cost'), serviceProvider: changed('serviceProvider'), partsUsed: changed('partsUsed') };
  };

  const applyReceipt = (fields: ReceiptFields, accepted: Record<keyof ReceiptFields, boolean>) => {
    const patch = receiptFillPatch(fields, editedFields(), accepted);
    for (const [field, value] of Object.entries(patch)) {
      logForm.setValue(field as 'cost' | 'serviceProvider' | 'partsUsed', value, { shouldValidate: true });
    }
    if (patch.serviceProvider || patch.partsUsed) setExpanded(true);
  };
  const handle: LogFormHandle = {
    setError: (field, message) => {
      // A refusal for a detail field that is not shown opens the details first, so it is seen.
      if (['type', 'serviceProvider', 'partsUsed', 'notes'].includes(field)) setExpanded(true);
      logForm.setError(field, { message }, { shouldFocus: true });
    },
  };

  const submit = async (values: LogFormValues) => {
    // Field problems are shown under the field (FormMessage), never as a toast.
    if (values.targetType === 'home_asset' && !values.assetId) {
      handle.setError('assetId', 'Choose a home asset or switch the log to general.');
      return;
    }
    if (values.targetType === 'vehicle' && !values.vehicleId) {
      handle.setError('vehicleId', 'Choose a vehicle or switch the log to general.');
      return;
    }
    const reading = values.targetType === 'vehicle' ? toNumber(values.mileage) : undefined;
    if (typeof reading === 'number' && (!Number.isInteger(reading) || reading < 0 || reading > MAX_MILEAGE)) {
      handle.setError('mileage', 'Enter the mileage as a whole number.');
      return;
    }
    await onSave({ values, base: initial.base }, handle);
  };

  return (
    <>
      <DialogHeader className="px-6 pb-0 pr-10 pt-6">
        <DialogTitle>{record ? 'Edit Maintenance Log' : 'Add Maintenance Log'}</DialogTitle>
        <DialogDescription>
          {scheduleTarget
            ? `Saving marks ${getScheduleCompletionName(scheduleTarget)} done for ${scheduleTarget.targetType === 'home_asset' ? scheduleTarget.asset.name : scheduleTarget.vehicle.nickname} and sets when it is next due.`
            : 'Link a log to a home asset, vehicle, or keep it general.'}
        </DialogDescription>
      </DialogHeader>
      <Form {...logForm}>
        <form onSubmit={logForm.handleSubmit(submit)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-4">
            <div className="grid gap-4 sm:grid-cols-2" id="log-details">
            <FormField control={logForm.control} name="title" render={({ field }) => (
              <FormItem className="sm:col-span-2"><FormLabel>Title</FormLabel><FormControl><Input placeholder="Replaced air filter" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={logForm.control} name="targetType" render={({ field }) => (
              <FormItem><FormLabel>Log For</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="general">General</SelectItem><SelectItem value="home_asset">Home Asset</SelectItem><SelectItem value="vehicle">Vehicle</SelectItem></SelectContent></Select><FormMessage /></FormItem>
            )} />
            {targetType === 'home_asset' && (
              <FormField control={logForm.control} name="assetId" render={({ field }) => (
                <FormItem><FormLabel>Home Asset</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Choose asset" /></SelectTrigger></FormControl><SelectContent>{assets.map(asset => <SelectItem key={asset.id} value={asset.id}>{asset.name}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
              )} />
            )}
            {targetType === 'vehicle' && (
              <FormField control={logForm.control} name="vehicleId" render={({ field }) => (
                <FormItem><FormLabel>Vehicle</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Choose vehicle" /></SelectTrigger></FormControl><SelectContent>{vehicles.map(vehicle => <SelectItem key={vehicle.id} value={vehicle.id}>{vehicle.nickname}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
              )} />
            )}
            <FormField control={logForm.control} name="date" render={({ field }) => (
              <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={logForm.control} name="cost" render={({ field }) => (
              <FormItem><FormLabel>Cost</FormLabel><FormControl><Input type="number" inputMode="decimal" min="0" step="0.01" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            {vehicleLog && (
              <FormField control={logForm.control} name="mileage" render={({ field }) => (
                <FormItem><FormLabel>Mileage</FormLabel><FormControl><Input type="number" inputMode="numeric" min="0" step="1" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            )}
            <MileageWarning message={mileageMessage} />
            {shown.has('type') && (
              <FormField control={logForm.control} name="type" render={({ field }) => (
                <FormItem><FormLabel>Type</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent>{logTypes.map(type => <SelectItem key={type} value={type}>{humanizeLabel(type)}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
              )} />
            )}
            {shown.has('serviceProvider') && (
              <FormField control={logForm.control} name="serviceProvider" render={({ field }) => (
                <FormItem><FormLabel>Service Provider</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            )}
            {shown.has('partsUsed') && (
              <FormField control={logForm.control} name="partsUsed" render={({ field }) => (
                <FormItem className="sm:col-span-2"><FormLabel>Parts Used</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            )}
            {shown.has('notes') && (
              <FormField control={logForm.control} name="notes" render={({ field }) => (
                <FormItem className="sm:col-span-2"><FormLabel>Notes</FormLabel><FormControl><AutoResizeTextarea rows={4} placeholder="Describe what happened, what was done, and any follow-up needed." {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            )}
            {!expanded && shown.size < allDetails && (
              <DetailsToggle label={detailsToggleLabel(!record, emptyCount)} controls="log-details" onClick={() => setExpanded(true)} />
            )}
            {canAttach && (
              <ReceiptPicker
                disabled={busy}
                editedFields={editedFields}
                onApply={applyReceipt}
              />
            )}
            </div>
          </div>
          <DialogFooter className={FORM_FOOTER_CLASSES}>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => cancel()}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              {mileageMessage ? 'Save anyway' : record ? 'Update Log' : 'Save Log'}
            </Button>
          </DialogFooter>
          <SaveNotice notice={notice} busy={busy} />
        </form>
      </Form>
    </>
  );
}
