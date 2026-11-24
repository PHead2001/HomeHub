'use client';

import * as React from 'react';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { format } from 'date-fns';
import { CalendarDays, Loader2, Plus, Wrench } from 'lucide-react';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { firstCalendarDue } from '@functions/shared/maintenance-schedule';
import {
  detailsToggleLabel, emptyDetailFields, formIsDirty, visibleDetailFields,
} from '@/lib/maintenance/form-sections';
import { presetSchedulesFor, schedulePresetsFor } from '@/lib/maintenance/presets';
import type { HomeAsset, HomeAssetCategory, Vehicle } from '@/lib/types';
import { MileageWarning, SaveNotice, focusScheduleField } from './page-parts';
import {
  assetCategories, assetFormFromRecord, assetSchema, assetScheduleToForm, assetStatuses, assetValuesOf, emptyAssetForm, emptyVehicleForm,
  frequencyTypes, humanizeLabel, toNumber, vehicleFormFromRecord, vehicleSchema, vehicleScheduleToForm, vehicleStatuses, vehicleValuesOf,
  type AssetFormValues, type AssetScheduleForm, type AssetValues, type SaveNoticeState, type ScheduleRemovalTarget,
  type VehicleFormValues, type VehicleScheduleForm, type VehicleValues,
} from './page-model';
import { ScheduleRemovalDialog } from './schedule-removal-dialog';
import { FORM_FOOTER_CLASSES, MaintenanceFormDialog, useGuardedCancel, useReportDirty } from './form-shell';
import { AnchorControl, DetailsToggle, NotesField, SelectField, TextField } from './form-fields';

type AssetSave = { base?: AssetValues; values: AssetValues };

const localToday = () => format(new Date(), 'yyyy-MM-dd');

/** A calendar-anchored schedule without a due day gets its first anchor day (M3 `firstCalendarDue`). */
const withFirstCalendarDue = <S extends { anchor: string; anchorMonth: string; anchorDay: string; nextDueDate: string }>(
  schedule: S, unit: 'days' | 'weeks' | 'months' | 'years' | undefined, value: number | undefined, today: string,
): S => {
  if (schedule.anchor !== 'calendar' || schedule.nextDueDate || !unit || !value) return schedule;
  const due = firstCalendarDue({
    unit, value, anchor: 'calendar', anchorMonth: toNumber(schedule.anchorMonth), anchorDay: toNumber(schedule.anchorDay),
  }, today);
  return due ? { ...schedule, nextDueDate: due } : schedule;
};

/**
 * Add or edit a home asset (MA-15): name, room, category, warranty (end date or Lifetime) and
 * schedules from presets up front; everything else behind "More details" ("Add details (N empty)"
 * on an edit, which also shows every detail that already has a value). The form and its schedule
 * rows are this dialog's own state, initialised once per opening from the record as it was then;
 * that is also the `base` the server compares with. Unsaved changes ask before closing (MA-24f).
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
} & AssetDialogBodyProps) {
  return (
    <MaintenanceFormDialog open={open} busy={body.busy} onOpenChange={onOpenChange} className="max-w-3xl" testId="asset-form">
      <AssetDialogBody key={session} {...body} />
    </MaintenanceFormDialog>
  );
});

type AssetDialogBodyProps = {
  record: HomeAsset | null;
  busy: boolean;
  notice?: SaveNoticeState;
  /** The household's day (presets' first due days); the device's day when not given. */
  today?: string;
  onSave: (save: AssetSave) => void | Promise<void>;
};

function AssetDialogBody({ record, busy, notice, today: givenToday, onSave }: AssetDialogBodyProps) {
  const today = givenToday || localToday();
  const cancel = useGuardedCancel();
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
  const values = useWatch({ control: assetForm.control }) as AssetFormValues;
  const [assetScheduleForms, setAssetScheduleForms] = useState<AssetScheduleForm[]>(initial.schedules);
  const [assetScheduleErrors, setAssetScheduleErrors] = useState<Record<string, string>>({});
  const [scheduleToRemove, setScheduleToRemove] = useState<ScheduleRemovalTarget | null>(null);
  const [expanded, setExpanded] = useState(false);
  useReportDirty(formIsDirty({ form: initial.form, schedules: initial.schedules }, { form: values, schedules: assetScheduleForms }));

  const shown = useMemo(() => new Set(visibleDetailFields('asset', initial.form, expanded)), [initial.form, expanded]);
  const emptyCount = useMemo(() => emptyDetailFields('asset', initial.form).length, [initial.form]);
  const category = (values.category || 'Other') as HomeAssetCategory;
  const presets = schedulePresetsFor(category);
  const lifetime = Boolean(values.warrantyLifetime);

  const addAssetSchedule = () => {
    setAssetScheduleForms(prev => [...prev, assetScheduleToForm()]);
  };

  /** A preset becomes an ordinary, editable schedule row (M3 presets, MA-27b). */
  const addPreset = (key: string) => {
    const draft = presetSchedulesFor(category, { today }).find(schedule => schedule.id?.startsWith(`${key}-`));
    if (!draft) return;
    setAssetScheduleForms(prev => [...prev, assetScheduleToForm(draft)]);
  };

  const updateAssetSchedule = (id: string, patch: Partial<Omit<AssetScheduleForm, 'id'>>) => {
    setAssetScheduleForms(prev => prev.map(schedule => {
      if (schedule.id !== id) return schedule;
      const next = { ...schedule, ...patch };
      return withFirstCalendarDue(next, next.frequencyType || undefined, toNumber(next.intervalValue), today);
    }));
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

  const saveAsset = async (formValues: AssetFormValues) => {
    const nextAssetScheduleErrors = Object.fromEntries(assetScheduleForms.flatMap((schedule) => {
      if (!schedule.scheduleName.trim()) return [[schedule.id, 'Enter a name for this maintenance item.']];
      if (schedule.mode === 'checklist') return [];
      if (!(schedule.frequencyType && toNumber(schedule.intervalValue)) && !schedule.nextDueDate) {
        return [[schedule.id, 'Scheduled maintenance needs a frequency interval or next due date.']];
      }
      const day = toNumber(schedule.anchorDay);
      if (schedule.anchor === 'calendar' && schedule.anchorDay && (!day || !Number.isInteger(day) || day < 1 || day > 31)) {
        return [[schedule.id, 'Enter a day of the month from 1 to 31.']];
      }
      return [];
    }));
    if (Object.keys(nextAssetScheduleErrors).length > 0) {
      setAssetScheduleErrors(nextAssetScheduleErrors);
      focusScheduleField('asset', Object.keys(nextAssetScheduleErrors)[0]);
      return;
    }
    // A lifetime warranty has no end date (M3).
    const cleaned = formValues.warrantyLifetime ? { ...formValues, warrantyExpiration: '' } : formValues;
    await onSave({ base: initial.base, values: assetValuesOf(cleaned, assetScheduleForms) });
  };

  const control = assetForm.control;
  return (
    <>
      <DialogHeader className="px-6 pb-0 pr-10 pt-6">
        <DialogTitle>{record ? 'Edit Home Asset' : 'Add Home Asset'}</DialogTitle>
        <DialogDescription>{record ? 'Update this asset and its maintenance.' : 'The essentials now; add details any time.'}</DialogDescription>
      </DialogHeader>
      <Form {...assetForm}>
        <form onSubmit={assetForm.handleSubmit(saveAsset)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-4">
            <div className="grid gap-4 pb-2 sm:grid-cols-2" id="asset-details">
              <TextField control={control} name="name" label="Name" placeholder="Dishwasher" />
              <TextField control={control} name="location" label="Location / Room" placeholder="Kitchen" />
              <SelectField control={control} name="category" label="Category" options={assetCategories.map(option => ({ value: option, label: option }))} />
              <div className="space-y-2">
                <TextField control={control} name="warrantyExpiration" label="Warranty Expiration" type="date" className={lifetime ? 'opacity-60' : undefined} />
                <FormField control={control} name="warrantyLifetime" render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox checked={field.value === true} onCheckedChange={(checked) => field.onChange(checked === true)} />
                    </FormControl>
                    <FormLabel className="font-normal">Lifetime warranty</FormLabel>
                  </FormItem>
                )} />
              </div>
              {shown.has('status') && <SelectField control={control} name="status" label="Status" options={assetStatuses.map(status => ({ value: status, label: humanizeLabel(status) }))} />}
              {shown.has('brand') && <TextField control={control} name="brand" label="Brand" />}
              {shown.has('model') && <TextField control={control} name="model" label="Model" />}
              {shown.has('serialNumber') && <TextField control={control} name="serialNumber" label="Serial Number" />}
              {shown.has('purchasePrice') && <TextField control={control} name="purchasePrice" label="Purchase Price" type="number" min="0" step="0.01" inputMode="decimal" />}
              {shown.has('purchaseDate') && <TextField control={control} name="purchaseDate" label="Purchase Date" type="date" />}
              {shown.has('warrantyProvider') && <TextField control={control} name="warrantyProvider" label="Warranty Provider" className="sm:col-span-2" />}
              {shown.has('notes') && <NotesField control={control} name="notes" placeholder="Install details, filters, shutoff location, or service context." />}
              {!expanded && shown.size < visibleDetailFields('asset', initial.form, true).length && (
                <DetailsToggle label={detailsToggleLabel(!record, emptyCount)} controls="asset-details" onClick={() => setExpanded(true)} />
              )}
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
              {presets.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Suggested schedules">
                  {presets.map(preset => (
                    <Button key={preset.key} type="button" variant="secondary" size="sm" onClick={() => addPreset(preset.key)} title={preset.summary}>
                      <Plus aria-hidden className="mr-1 h-3.5 w-3.5" />
                      {preset.label}
                      <span className="sr-only">, {preset.summary}</span>
                    </Button>
                  ))}
                </div>
              )}
              {assetScheduleForms.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  No scheduled maintenance yet. Pick a suggestion above or add your own.
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
                              onChange={(event) => updateAssetSchedule(schedule.id, { scheduleName: event.target.value })}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Maintenance Type</FormLabel>
                          <Select onValueChange={(value) => updateAssetSchedule(schedule.id, { mode: value as AssetScheduleForm['mode'] })} value={schedule.mode}>
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
                              <Select onValueChange={(value) => updateAssetSchedule(schedule.id, { frequencyType: value as AssetScheduleForm['frequencyType'] })} value={schedule.frequencyType}>
                                <FormControl><SelectTrigger><SelectValue placeholder="Select frequency" /></SelectTrigger></FormControl>
                                <SelectContent>{frequencyTypes.map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
                              </Select>
                            </FormItem>
                            <FormItem>
                              <FormLabel>Interval Value</FormLabel>
                              <FormControl>
                                <Input type="number" inputMode="numeric" min="1" value={schedule.intervalValue} onChange={(event) => updateAssetSchedule(schedule.id, { intervalValue: event.target.value })} />
                              </FormControl>
                            </FormItem>
                            <FormItem>
                              <FormLabel>Last Completed</FormLabel>
                              <FormControl>
                                <Input type="date" value={schedule.lastCompletedDate} onChange={(event) => updateAssetSchedule(schedule.id, { lastCompletedDate: event.target.value })} />
                              </FormControl>
                            </FormItem>
                            <FormItem>
                              <FormLabel>Next Due</FormLabel>
                              <FormControl>
                                <Input type="date" value={schedule.nextDueDate} onChange={(event) => updateAssetSchedule(schedule.id, { nextDueDate: event.target.value })} />
                              </FormControl>
                            </FormItem>
                            {(schedule.frequencyType === 'months' || schedule.frequencyType === 'years') && (
                              <AnchorControl
                                id={schedule.id}
                                anchor={schedule.anchor}
                                anchorMonth={schedule.anchorMonth}
                                anchorDay={schedule.anchorDay}
                                yearly={schedule.frequencyType === 'years' || [3, 4, 6, 12].includes(toNumber(schedule.intervalValue) ?? 0)}
                                onChange={(patch) => updateAssetSchedule(schedule.id, patch)}
                              />
                            )}
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
          <DialogFooter className={FORM_FOOTER_CLASSES}>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => cancel()}>Cancel</Button>
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
 * Add or edit a vehicle (MA-15): nickname, make/model/year, current mileage and services from
 * presets up front; everything else behind "More details". See AssetDialog.
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
} & VehicleDialogBodyProps) {
  return (
    <MaintenanceFormDialog open={open} busy={body.busy} onOpenChange={onOpenChange} className="max-w-3xl" testId="vehicle-form">
      <VehicleDialogBody key={session} {...body} />
    </MaintenanceFormDialog>
  );
});

type VehicleDialogBodyProps = {
  record: Vehicle | null;
  busy: boolean;
  notice?: SaveNoticeState;
  /** The one-time unusual-odometer warning (MA-6d); the submit button then reads "Save anyway". */
  mileageMessage?: string;
  today?: string;
  onSave: (save: VehicleSave) => void | Promise<void>;
};

function VehicleDialogBody({ record, busy, notice, mileageMessage, today: givenToday, onSave }: VehicleDialogBodyProps) {
  const today = givenToday || localToday();
  const cancel = useGuardedCancel();
  const [initial] = useState(() => {
    const form = record ? vehicleFormFromRecord(record) : emptyVehicleForm;
    const schedules = record?.serviceSchedules?.map(vehicleScheduleToForm) || [];
    return { form, schedules, base: record ? vehicleValuesOf(form, schedules) : undefined };
  });
  const vehicleForm = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleSchema),
    defaultValues: initial.form,
  });
  const values = useWatch({ control: vehicleForm.control }) as VehicleFormValues;
  const [vehicleScheduleForms, setVehicleScheduleForms] = useState<VehicleScheduleForm[]>(initial.schedules);
  const [vehicleScheduleErrors, setVehicleScheduleErrors] = useState<Record<string, string>>({});
  const [scheduleToRemove, setScheduleToRemove] = useState<ScheduleRemovalTarget | null>(null);
  const [expanded, setExpanded] = useState(false);
  useReportDirty(formIsDirty({ form: initial.form, schedules: initial.schedules }, { form: values, schedules: vehicleScheduleForms }));

  const shown = useMemo(() => new Set(visibleDetailFields('vehicle', initial.form, expanded)), [initial.form, expanded]);
  const emptyCount = useMemo(() => emptyDetailFields('vehicle', initial.form).length, [initial.form]);
  const presets = schedulePresetsFor('Vehicle');

  const addVehicleSchedule = () => {
    setVehicleScheduleForms(prev => [...prev, vehicleScheduleToForm()]);
  };

  const addPreset = (key: string) => {
    const draft = presetSchedulesFor('Vehicle', { today, currentMileage: toNumber(values.currentMileage) })
      .find(schedule => schedule.id?.startsWith(`${key}-`));
    if (!draft) return;
    setVehicleScheduleForms(prev => [...prev, vehicleScheduleToForm(draft)]);
  };

  const updateVehicleSchedule = (id: string, patch: Partial<Omit<VehicleScheduleForm, 'id'>>) => {
    setVehicleScheduleForms(prev => prev.map(schedule => {
      if (schedule.id !== id) return schedule;
      const next = { ...schedule, ...patch };
      return withFirstCalendarDue(next, toNumber(next.intervalMonths) ? 'months' : undefined, toNumber(next.intervalMonths), today);
    }));
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

  const saveVehicle = async (formValues: VehicleFormValues) => {
    const nextVehicleScheduleErrors = Object.fromEntries(vehicleScheduleForms.flatMap((schedule) => {
      if (!schedule.serviceName.trim()) return [[schedule.id, 'Enter a name for this service item.']];
      if (schedule.mode === 'checklist') return [];
      if (!toNumber(schedule.intervalMiles) && !toNumber(schedule.intervalMonths) && !toNumber(schedule.nextDueMileage) && !schedule.nextDueDate) {
        return [[schedule.id, 'Scheduled maintenance needs a mileage, month interval, next due mileage, or next due date.']];
      }
      const day = toNumber(schedule.anchorDay);
      if (schedule.anchor === 'calendar' && schedule.anchorDay && (!day || !Number.isInteger(day) || day < 1 || day > 31)) {
        return [[schedule.id, 'Enter a day of the month from 1 to 31.']];
      }
      return [];
    }));
    if (Object.keys(nextVehicleScheduleErrors).length > 0) {
      setVehicleScheduleErrors(nextVehicleScheduleErrors);
      focusScheduleField('vehicle', Object.keys(nextVehicleScheduleErrors)[0]);
      return;
    }
    await onSave({ base: initial.base, values: vehicleValuesOf(formValues, vehicleScheduleForms) });
  };

  const control = vehicleForm.control;
  return (
    <>
      <DialogHeader className="px-6 pb-0 pr-10 pt-6">
        <DialogTitle>{record ? 'Edit Vehicle' : 'Add Vehicle'}</DialogTitle>
        <DialogDescription>{record ? 'Update this vehicle and its services.' : 'The essentials now; add details any time.'}</DialogDescription>
      </DialogHeader>
      <Form {...vehicleForm}>
        <form onSubmit={vehicleForm.handleSubmit(saveVehicle)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-4">
            <div className="grid gap-4 pb-2 sm:grid-cols-2" id="vehicle-details">
              <TextField control={control} name="nickname" label="Nickname" placeholder="Family SUV" />
              <TextField control={control} name="make" label="Make" />
              <TextField control={control} name="model" label="Model" />
              <TextField control={control} name="year" label="Year" type="number" min="1900" inputMode="numeric" />
              <TextField control={control} name="currentMileage" label="Current Mileage" type="number" min="0" inputMode="numeric" />
              {shown.has('status') && <SelectField control={control} name="status" label="Status" options={vehicleStatuses.map(status => ({ value: status, label: humanizeLabel(status) }))} />}
              {shown.has('trim') && <TextField control={control} name="trim" label="Trim" />}
              {shown.has('vin') && <TextField control={control} name="vin" label="VIN" />}
              {shown.has('licensePlate') && <TextField control={control} name="licensePlate" label="License Plate" />}
              {shown.has('purchasePrice') && <TextField control={control} name="purchasePrice" label="Purchase Price" type="number" min="0" step="0.01" inputMode="decimal" />}
              {shown.has('purchaseDate') && <TextField control={control} name="purchaseDate" label="Purchase Date" type="date" />}
              {shown.has('insuranceProvider') && <TextField control={control} name="insuranceProvider" label="Insurance Provider" />}
              {shown.has('registrationExpiration') && <TextField control={control} name="registrationExpiration" label="Registration Expiration" type="date" />}
              {shown.has('inspectionExpiration') && <TextField control={control} name="inspectionExpiration" label="Inspection Expiration" type="date" />}
              {shown.has('notes') && <NotesField control={control} name="notes" placeholder="Service preferences, tire size, warranty notes, or ownership context." />}
              {!expanded && shown.size < visibleDetailFields('vehicle', initial.form, true).length && (
                <DetailsToggle label={detailsToggleLabel(!record, emptyCount)} controls="vehicle-details" onClick={() => setExpanded(true)} />
              )}
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
              <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Suggested services">
                {presets.map(preset => (
                  <Button key={preset.key} type="button" variant="secondary" size="sm" onClick={() => addPreset(preset.key)} title={preset.summary}>
                    <Plus aria-hidden className="mr-1 h-3.5 w-3.5" />
                    {preset.label}
                    <span className="sr-only">, {preset.summary}</span>
                  </Button>
                ))}
              </div>
              {vehicleScheduleForms.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  No scheduled maintenance yet. Pick a suggestion above or add your own.
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
                              onChange={(event) => updateVehicleSchedule(schedule.id, { serviceName: event.target.value })}
                            />
                          </FormControl>
                        </FormItem>
                        <FormItem>
                          <FormLabel>Maintenance Type</FormLabel>
                          <Select onValueChange={(value) => updateVehicleSchedule(schedule.id, { mode: value as VehicleScheduleForm['mode'] })} value={schedule.mode}>
                            <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="scheduled">Scheduled maintenance</SelectItem>
                              <SelectItem value="checklist">Unscheduled checklist</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItem>
                        {schedule.mode === 'scheduled' && (
                          <>
                            {([
                              ['intervalMiles', 'Interval Miles', 'number'],
                              ['intervalMonths', 'Interval Months', 'number'],
                              ['lastCompletedMileage', 'Last Completed Mileage', 'number'],
                              ['lastCompletedDate', 'Last Completed Date', 'date'],
                              ['nextDueMileage', 'Next Due Mileage', 'number'],
                              ['nextDueDate', 'Next Due Date', 'date'],
                            ] as const).map(([field, label, type]) => (
                              <FormItem key={field}>
                                <FormLabel>{label}</FormLabel>
                                <FormControl>
                                  <Input
                                    type={type}
                                    min={type === 'number' ? '0' : undefined}
                                    inputMode={type === 'number' ? 'numeric' : undefined}
                                    value={schedule[field]}
                                    onChange={(event) => updateVehicleSchedule(schedule.id, { [field]: event.target.value })}
                                  />
                                </FormControl>
                              </FormItem>
                            ))}
                            {Boolean(toNumber(schedule.intervalMonths)) && (
                              <AnchorControl
                                id={schedule.id}
                                anchor={schedule.anchor}
                                anchorMonth={schedule.anchorMonth}
                                anchorDay={schedule.anchorDay}
                                yearly={[3, 4, 6, 12, 24, 36].includes(toNumber(schedule.intervalMonths) ?? 0)}
                                onChange={(patch) => updateVehicleSchedule(schedule.id, patch)}
                              />
                            )}
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
          <DialogFooter className={FORM_FOOTER_CLASSES}>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => cancel()}>Cancel</Button>
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
