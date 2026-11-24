'use client';

import * as React from 'react';
import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarDays, Loader2, Plus, Wrench } from 'lucide-react';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { HomeAsset, Vehicle } from '@/lib/types';
import { AutoResizeTextarea, MileageWarning, SaveNotice, focusScheduleField } from './page-parts';
import {
  assetCategories, assetFormFromRecord, assetSchema, assetScheduleToForm, assetStatuses, assetValuesOf, emptyAssetForm, emptyVehicleForm,
  frequencyTypes, humanizeLabel, toNumber, vehicleFormFromRecord, vehicleSchema, vehicleScheduleToForm, vehicleStatuses, vehicleValuesOf,
  type AssetFormValues, type AssetScheduleForm, type AssetValues, type SaveNoticeState, type ScheduleRemovalTarget,
  type VehicleFormValues, type VehicleScheduleForm, type VehicleValues,
} from './page-model';
import { ScheduleRemovalDialog } from './schedule-removal-dialog';

type AssetSave = { base?: AssetValues; values: AssetValues };

/**
 * Add or edit a home asset. The form and its schedule rows are this dialog's own state (typing re-renders
 * only the dialog), initialised once per opening from the record as it was then; that is also the
 * `base` the server compares with, so a snapshot arriving while the form is open never resets it.
 */
export const AssetDialog = React.memo(function AssetDialog({
  open,
  session,
  onOpenChange,
  ...body
}: {
  open: boolean;
  /** Changes on every opening: the form starts over. */
  session: number;
  onOpenChange: (open: boolean) => void;
} & Omit<AssetDialogBodyProps, 'onCancel'>) {
  const cancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))] max-w-3xl flex-col overflow-hidden p-0">
        <AssetDialogBody key={session} {...body} onCancel={cancel} />
      </DialogContent>
    </Dialog>
  );
});

type AssetDialogBodyProps = {
  record: HomeAsset | null;
  busy: boolean;
  notice?: SaveNoticeState;
  onCancel: () => void;
  onSave: (save: AssetSave) => void | Promise<void>;
};

function AssetDialogBody({ record, busy, notice, onCancel, onSave }: AssetDialogBodyProps) {
  const [initial] = useState(() => {
    const form = record ? assetFormFromRecord(record) : emptyAssetForm;
    const schedules = record?.schedules?.map(assetScheduleToForm) || [];
    // What the form showed when it opened: only fields that differ from it are saved (MA-3c).
    return { form, schedules, base: record ? assetValuesOf(form, schedules) : undefined };
  });
  const assetForm = useForm<AssetFormValues>({
    resolver: zodResolver(assetSchema),
    defaultValues: initial.form,
  });
  const [assetScheduleForms, setAssetScheduleForms] = useState<AssetScheduleForm[]>(initial.schedules);
  const [assetScheduleErrors, setAssetScheduleErrors] = useState<Record<string, string>>({});
  const [scheduleToRemove, setScheduleToRemove] = useState<ScheduleRemovalTarget | null>(null);

  const addAssetSchedule = () => {
    setAssetScheduleForms(prev => [...prev, assetScheduleToForm()]);
  };

  const updateAssetSchedule = (id: string, field: keyof Omit<AssetScheduleForm, 'id'>, value: string) => {
    setAssetScheduleForms(prev => prev.map(schedule => (
      schedule.id === id ? { ...schedule, [field]: value } : schedule
    )));
    setAssetScheduleErrors(prev => ({ ...prev, [id]: '' }));
  };

  const removeAssetSchedule = (id: string) => {
    setAssetScheduleForms(prev => prev.filter(schedule => schedule.id !== id));
    setAssetScheduleErrors(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const requestAssetScheduleRemoval = (schedule: AssetScheduleForm) => {
    setScheduleToRemove({
      targetType: 'home_asset',
      id: schedule.id,
      name: schedule.scheduleName.trim() || 'this maintenance item',
    });
  };

  const confirmScheduleRemoval = () => {
    if (!scheduleToRemove) return;
    removeAssetSchedule(scheduleToRemove.id);
    setScheduleToRemove(null);
  };

  const saveAsset = async (values: AssetFormValues) => {
    const nextAssetScheduleErrors = Object.fromEntries(assetScheduleForms.flatMap((schedule) => {
      if (!schedule.scheduleName.trim()) return [[schedule.id, 'Enter a name for this maintenance item.']];
      if (schedule.mode === 'checklist') return [];
      if (!(schedule.frequencyType && toNumber(schedule.intervalValue)) && !schedule.nextDueDate) {
        return [[schedule.id, 'Scheduled maintenance needs a frequency interval or next due date.']];
      }
      return [];
    }));
    if (Object.keys(nextAssetScheduleErrors).length > 0) {
      setAssetScheduleErrors(nextAssetScheduleErrors);
      focusScheduleField('asset', Object.keys(nextAssetScheduleErrors)[0]);
      return;
    }
    await onSave({ base: initial.base, values: assetValuesOf(values, assetScheduleForms) });
  };

  return (
    <>
      <DialogHeader className="px-6 pb-0 pr-10 pt-6">
        <DialogTitle>{record ? 'Edit Home Asset' : 'Add Home Asset'}</DialogTitle>
        <DialogDescription>Track core asset details and schedule-ready maintenance metadata.</DialogDescription>
      </DialogHeader>
      <Form {...assetForm}>
        <form onSubmit={assetForm.handleSubmit(saveAsset)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-4">
            <div className="grid gap-4 pb-2 sm:grid-cols-2">
              <FormField control={assetForm.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Name</FormLabel><FormControl><Input placeholder="Dishwasher" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="category" render={({ field }) => (
                <FormItem><FormLabel>Category</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent>{assetCategories.map(category => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="location" render={({ field }) => (
                <FormItem><FormLabel>Location / Room</FormLabel><FormControl><Input placeholder="Kitchen" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent>{assetStatuses.map(status => <SelectItem key={status} value={status}>{humanizeLabel(status)}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="brand" render={({ field }) => (
                <FormItem><FormLabel>Brand</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="model" render={({ field }) => (
                <FormItem><FormLabel>Model</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="serialNumber" render={({ field }) => (
                <FormItem><FormLabel>Serial Number</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="purchasePrice" render={({ field }) => (
                <FormItem><FormLabel>Purchase Price</FormLabel><FormControl><Input type="number" min="0" step="0.01" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="purchaseDate" render={({ field }) => (
                <FormItem><FormLabel>Purchase Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="warrantyExpiration" render={({ field }) => (
                <FormItem><FormLabel>Warranty Expiration</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="warrantyProvider" render={({ field }) => (
                <FormItem className="sm:col-span-2"><FormLabel>Warranty Provider</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={assetForm.control} name="notes" render={({ field }) => (
                <FormItem className="sm:col-span-2"><FormLabel>Notes</FormLabel><FormControl><AutoResizeTextarea rows={3} placeholder="Install details, filters, shutoff location, or service context." {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <div className="mt-3 rounded-lg border p-3">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CalendarDays className="h-4 w-4" />
                  Scheduled maintenance
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addAssetSchedule}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add scheduled maintenance
                </Button>
              </div>
              {assetScheduleForms.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  No scheduled maintenance yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {assetScheduleForms.map((schedule, index) => (
                    <div key={schedule.id} className="rounded-md border p-3">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">Maintenance item #{index + 1}</p>
                        <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" aria-label={`Remove asset maintenance ${schedule.scheduleName || `item ${index + 1}`}`} onClick={() => requestAssetScheduleRemoval(schedule)}>
                          Remove
                        </Button>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <FormItem>
                          <FormLabel>Schedule Name</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="Filter replacement"
                              data-schedule-name={`asset-${schedule.id}`}
                              aria-invalid={assetScheduleErrors[schedule.id] ? true : undefined}
                              aria-describedby={assetScheduleErrors[schedule.id] ? fieldErrorProps(`asset-schedule-${schedule.id}`, true)['aria-describedby'] : undefined}
                              value={schedule.scheduleName}
                              onChange={(event) => updateAssetSchedule(schedule.id, 'scheduleName', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Maintenance Type</FormLabel>
                          <Select
                            onValueChange={(value) => updateAssetSchedule(schedule.id, 'mode', value)}
                            value={schedule.mode}
                          >
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="scheduled">Scheduled maintenance</SelectItem>
                              <SelectItem value="checklist">Unscheduled checklist</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItem>
                        {schedule.mode === 'scheduled' && (
                          <>
                        <FormItem>
                          <FormLabel>Frequency Type</FormLabel>
                          <Select
                            onValueChange={(value) => updateAssetSchedule(schedule.id, 'frequencyType', value)}
                            value={schedule.frequencyType}
                          >
                            <FormControl>
                              <SelectTrigger><SelectValue placeholder="Select frequency" /></SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {frequencyTypes.map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Interval Value</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="1"
                              value={schedule.intervalValue}
                              onChange={(event) => updateAssetSchedule(schedule.id, 'intervalValue', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Last Completed</FormLabel>
                          <FormControl>
                            <Input
                              type="date"
                              value={schedule.lastCompletedDate}
                              onChange={(event) => updateAssetSchedule(schedule.id, 'lastCompletedDate', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Next Due</FormLabel>
                          <FormControl>
                            <Input
                              type="date"
                              value={schedule.nextDueDate}
                              onChange={(event) => updateAssetSchedule(schedule.id, 'nextDueDate', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                          </>
                        )}
                      </div>
                      <FieldError id={`asset-schedule-${schedule.id}`} className="mt-3">{assetScheduleErrors[schedule.id]}</FieldError>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="border-t px-6 py-4">
            <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Save Asset
            </Button>
          </DialogFooter>
          <SaveNotice notice={notice} busy={busy} />
        </form>
      </Form>
      <ScheduleRemovalDialog scheduleToRemove={scheduleToRemove} setScheduleToRemove={setScheduleToRemove} confirmScheduleRemoval={confirmScheduleRemoval} />
    </>
  );
}

type VehicleSave = { base?: VehicleValues; values: VehicleValues };

/**
 * Add or edit a vehicle. The form and its schedule rows are this dialog's own state (typing re-renders
 * only the dialog), initialised once per opening from the record as it was then; that is also the
 * `base` the server compares with, so a snapshot arriving while the form is open never resets it.
 */
export const VehicleDialog = React.memo(function VehicleDialog({
  open,
  session,
  onOpenChange,
  ...body
}: {
  open: boolean;
  /** Changes on every opening: the form starts over. */
  session: number;
  onOpenChange: (open: boolean) => void;
} & Omit<VehicleDialogBodyProps, 'onCancel'>) {
  const cancel = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))] max-w-3xl flex-col overflow-hidden p-0">
        <VehicleDialogBody key={session} {...body} onCancel={cancel} />
      </DialogContent>
    </Dialog>
  );
});

type VehicleDialogBodyProps = {
  record: Vehicle | null;
  busy: boolean;
  notice?: SaveNoticeState;
  /** The one-time unusual-odometer warning (MA-6d); the submit button then reads "Save anyway". */
  mileageMessage?: string;
  onCancel: () => void;
  onSave: (save: VehicleSave) => void | Promise<void>;
};

function VehicleDialogBody({ record, busy, notice, mileageMessage, onCancel, onSave }: VehicleDialogBodyProps) {
  const [initial] = useState(() => {
    const form = record ? vehicleFormFromRecord(record) : emptyVehicleForm;
    const schedules = record?.serviceSchedules?.map(vehicleScheduleToForm) || [];
    // What the form showed when it opened: only fields that differ from it are saved (MA-3c).
    return { form, schedules, base: record ? vehicleValuesOf(form, schedules) : undefined };
  });
  const vehicleForm = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleSchema),
    defaultValues: initial.form,
  });
  const [vehicleScheduleForms, setVehicleScheduleForms] = useState<VehicleScheduleForm[]>(initial.schedules);
  const [vehicleScheduleErrors, setVehicleScheduleErrors] = useState<Record<string, string>>({});
  const [scheduleToRemove, setScheduleToRemove] = useState<ScheduleRemovalTarget | null>(null);

  const addVehicleSchedule = () => {
    setVehicleScheduleForms(prev => [...prev, vehicleScheduleToForm()]);
  };

  const updateVehicleSchedule = (id: string, field: keyof Omit<VehicleScheduleForm, 'id'>, value: string) => {
    setVehicleScheduleForms(prev => prev.map(schedule => (
      schedule.id === id ? { ...schedule, [field]: value } : schedule
    )));
    setVehicleScheduleErrors(prev => ({ ...prev, [id]: '' }));
  };

  const removeVehicleSchedule = (id: string) => {
    setVehicleScheduleForms(prev => prev.filter(schedule => schedule.id !== id));
    setVehicleScheduleErrors(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const requestVehicleScheduleRemoval = (schedule: VehicleScheduleForm) => {
    setScheduleToRemove({
      targetType: 'vehicle',
      id: schedule.id,
      name: schedule.serviceName.trim() || 'this service item',
    });
  };

  const confirmScheduleRemoval = () => {
    if (!scheduleToRemove) return;
    removeVehicleSchedule(scheduleToRemove.id);
    setScheduleToRemove(null);
  };

  const saveVehicle = async (values: VehicleFormValues) => {
    const nextVehicleScheduleErrors = Object.fromEntries(vehicleScheduleForms.flatMap((schedule) => {
      if (!schedule.serviceName.trim()) return [[schedule.id, 'Enter a name for this service item.']];
      if (schedule.mode === 'checklist') return [];
      const hasDueMechanism = Boolean(
        toNumber(schedule.intervalMiles)
        || toNumber(schedule.intervalMonths)
        || toNumber(schedule.nextDueMileage)
        || schedule.nextDueDate
      );
      if (!hasDueMechanism) return [[schedule.id, 'Scheduled service needs a date, mileage, or interval.']];
      return [];
    }));
    if (Object.keys(nextVehicleScheduleErrors).length > 0) {
      setVehicleScheduleErrors(nextVehicleScheduleErrors);
      focusScheduleField('vehicle', Object.keys(nextVehicleScheduleErrors)[0]);
      return;
    }
    await onSave({ base: initial.base, values: vehicleValuesOf(values, vehicleScheduleForms) });
  };

  return (
    <>
      <DialogHeader className="px-6 pb-0 pr-10 pt-6">
        <DialogTitle>{record ? 'Edit Vehicle' : 'Add Vehicle'}</DialogTitle>
        <DialogDescription>Track vehicle details and schedule-ready service metadata.</DialogDescription>
      </DialogHeader>
      <Form {...vehicleForm}>
        <form onSubmit={vehicleForm.handleSubmit(saveVehicle)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-4">
            <div className="grid gap-4 pb-2 sm:grid-cols-2">
              <FormField control={vehicleForm.control} name="nickname" render={({ field }) => (
                <FormItem><FormLabel>Nickname</FormLabel><FormControl><Input placeholder="Family SUV" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent>{vehicleStatuses.map(status => <SelectItem key={status} value={status}>{humanizeLabel(status)}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="year" render={({ field }) => (
                <FormItem><FormLabel>Year</FormLabel><FormControl><Input type="number" min="1900" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="make" render={({ field }) => (
                <FormItem><FormLabel>Make</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="model" render={({ field }) => (
                <FormItem><FormLabel>Model</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="trim" render={({ field }) => (
                <FormItem><FormLabel>Trim</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="vin" render={({ field }) => (
                <FormItem><FormLabel>VIN</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="licensePlate" render={({ field }) => (
                <FormItem><FormLabel>License Plate</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="currentMileage" render={({ field }) => (
                <FormItem><FormLabel>Current Mileage</FormLabel><FormControl><Input type="number" min="0" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="purchasePrice" render={({ field }) => (
                <FormItem><FormLabel>Purchase Price</FormLabel><FormControl><Input type="number" min="0" step="0.01" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="purchaseDate" render={({ field }) => (
                <FormItem><FormLabel>Purchase Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="insuranceProvider" render={({ field }) => (
                <FormItem><FormLabel>Insurance Provider</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="registrationExpiration" render={({ field }) => (
                <FormItem><FormLabel>Registration Expiration</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="inspectionExpiration" render={({ field }) => (
                <FormItem><FormLabel>Inspection Expiration</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={vehicleForm.control} name="notes" render={({ field }) => (
                <FormItem className="sm:col-span-2"><FormLabel>Notes</FormLabel><FormControl><AutoResizeTextarea rows={3} placeholder="Service preferences, tire size, warranty notes, or ownership context." {...field} /></FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <div className="mt-3 rounded-lg border p-3">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Wrench className="h-4 w-4" />
                  Scheduled maintenance
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addVehicleSchedule}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add scheduled maintenance
                </Button>
              </div>
              {vehicleScheduleForms.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  No scheduled maintenance yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {vehicleScheduleForms.map((schedule, index) => (
                    <div key={schedule.id} className="rounded-md border p-3">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">Service item #{index + 1}</p>
                        <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" aria-label={`Remove vehicle service ${schedule.serviceName || `item ${index + 1}`}`} onClick={() => requestVehicleScheduleRemoval(schedule)}>
                          Remove
                        </Button>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <FormItem>
                          <FormLabel>Service Name</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="Brake fluid flush"
                              data-schedule-name={`vehicle-${schedule.id}`}
                              aria-invalid={vehicleScheduleErrors[schedule.id] ? true : undefined}
                              aria-describedby={vehicleScheduleErrors[schedule.id] ? fieldErrorProps(`vehicle-schedule-${schedule.id}`, true)['aria-describedby'] : undefined}
                              value={schedule.serviceName}
                              onChange={(event) => updateVehicleSchedule(schedule.id, 'serviceName', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Maintenance Type</FormLabel>
                          <Select
                            onValueChange={(value) => updateVehicleSchedule(schedule.id, 'mode', value)}
                            value={schedule.mode}
                          >
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="scheduled">Scheduled maintenance</SelectItem>
                              <SelectItem value="checklist">Unscheduled checklist</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItem>
                        {schedule.mode === 'scheduled' && (
                          <>
                        <FormItem>
                          <FormLabel>Interval Miles</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="0"
                              value={schedule.intervalMiles}
                              onChange={(event) => updateVehicleSchedule(schedule.id, 'intervalMiles', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Interval Months</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="0"
                              value={schedule.intervalMonths}
                              onChange={(event) => updateVehicleSchedule(schedule.id, 'intervalMonths', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Last Completed Mileage</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="0"
                              value={schedule.lastCompletedMileage}
                              onChange={(event) => updateVehicleSchedule(schedule.id, 'lastCompletedMileage', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Last Completed Date</FormLabel>
                          <FormControl>
                            <Input
                              type="date"
                              value={schedule.lastCompletedDate}
                              onChange={(event) => updateVehicleSchedule(schedule.id, 'lastCompletedDate', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Next Due Mileage</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="0"
                              value={schedule.nextDueMileage}
                              onChange={(event) => updateVehicleSchedule(schedule.id, 'nextDueMileage', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Next Due Date</FormLabel>
                          <FormControl>
                            <Input
                              type="date"
                              value={schedule.nextDueDate}
                              onChange={(event) => updateVehicleSchedule(schedule.id, 'nextDueDate', event.target.value)}
                            />
                          </FormControl>
                        </FormItem>
                          </>
                        )}
                      </div>
                      <FieldError id={`vehicle-schedule-${schedule.id}`} className="mt-3">{vehicleScheduleErrors[schedule.id]}</FieldError>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {mileageMessage && (
            <div className="px-6 pb-3">
              <MileageWarning message={mileageMessage} />
            </div>
          )}
          <DialogFooter className="border-t px-6 py-4">
            <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              {mileageMessage ? 'Save anyway' : 'Save Vehicle'}
            </Button>
          </DialogFooter>
          <SaveNotice notice={notice} busy={busy} />
        </form>
      </Form>
      <ScheduleRemovalDialog scheduleToRemove={scheduleToRemove} setScheduleToRemove={setScheduleToRemove} confirmScheduleRemoval={confirmScheduleRemoval} />
    </>
  );
}
