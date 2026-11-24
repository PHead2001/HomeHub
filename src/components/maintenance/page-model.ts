/**
 * The Maintenance Center page's model (MA-25b): form schemas and values, the record <-> form
 * mappers whose output is the `base`/`values` the server operations compare, and display
 * formatters shared by the page's panels and dialogs. No React.
 */
import { z } from 'zod';
import { format, isValid, parseISO } from 'date-fns';
import type {
  HomeAsset, HomeAssetSchedule, MaintenanceAttachment, MaintenanceAttachmentTargetType, MaintenanceLog, MaintenanceLogType,
  MaintenanceScheduleMode, MaintenanceTargetType, Vehicle, VehicleServiceSchedule,
} from '@/lib/types';
import {
  calculateNextVehicleMileage, getAssetScheduleMode, getVehicleScheduleMode, nextDueAfterCompletion,
  type ScheduleCompletionTarget,
} from '@/lib/maintenance/schedules';
import { scheduleRef, type StoredSchedule } from '@/lib/maintenance/operations';

export const assetCategories = [
  'HVAC',
  'Appliance',
  'Plumbing',
  'Electrical',
  'Network',
  'Smart Home',
  'Lawn / Outdoor',
  'Tool',
  'Other',
] as const;

export const assetStatuses = ['active', 'needs_attention', 'retired'] as const;
export const vehicleStatuses = ['active', 'needs_attention', 'retired', 'sold'] as const;
export const logTargetTypes = ['general', 'home_asset', 'vehicle'] as const;
export const logTypes = ['repair', 'routine', 'inspection', 'cleaning', 'replacement', 'issue', 'other'] as const;
export const frequencyTypes = ['days', 'weeks', 'months', 'years'] as const;
export const attachmentCategories = ['photo', 'receipt', 'manual', 'warranty_document', 'invoice', 'other'] as const;

export const assetSchema = z.object({
  name: z.string().min(1, 'Asset name is required.'),
  category: z.enum(assetCategories),
  location: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  serialNumber: z.string().optional(),
  purchaseDate: z.string().optional(),
  purchasePrice: z.string().optional(),
  warrantyExpiration: z.string().optional(),
  warrantyProvider: z.string().optional(),
  /** Lifetime warranty (M3): no end date and no expiry reminders. */
  warrantyLifetime: z.boolean().optional(),
  status: z.enum(assetStatuses),
  notes: z.string().optional(),
  scheduleName: z.string().optional(),
  frequencyType: z.enum(frequencyTypes).optional(),
  intervalValue: z.string().optional(),
  lastCompletedDate: z.string().optional(),
  nextDueDate: z.string().optional(),
});

export const vehicleSchema = z.object({
  nickname: z.string().min(1, 'Vehicle nickname is required.'),
  year: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  trim: z.string().optional(),
  vin: z.string().optional(),
  licensePlate: z.string().optional(),
  currentMileage: z.string().optional(),
  purchaseDate: z.string().optional(),
  purchasePrice: z.string().optional(),
  insuranceProvider: z.string().optional(),
  registrationExpiration: z.string().optional(),
  inspectionExpiration: z.string().optional(),
  status: z.enum(vehicleStatuses),
  notes: z.string().optional(),
  serviceName: z.string().optional(),
  intervalMiles: z.string().optional(),
  intervalMonths: z.string().optional(),
  lastCompletedMileage: z.string().optional(),
  lastCompletedDate: z.string().optional(),
  nextDueMileage: z.string().optional(),
  nextDueDate: z.string().optional(),
});

export const logSchema = z.object({
  targetType: z.enum(logTargetTypes),
  assetId: z.string().optional(),
  vehicleId: z.string().optional(),
  title: z.string().min(1, 'Log title is required.'),
  date: z.string().min(1, 'Date is required.'),
  type: z.enum(logTypes),
  notes: z.string().optional(),
  cost: z.string().optional(),
  partsUsed: z.string().optional(),
  serviceProvider: z.string().optional(),
  mileage: z.string().optional(),
});

export const scheduleCompletionSchema = z.object({
  completedDate: z.string().min(1, 'Completed date is required.'),
  mileage: z.string().optional(),
  nextDueDate: z.string().optional(),
  nextDueMileage: z.string().optional(),
  notes: z.string().optional(),
});

export type AssetFormValues = z.infer<typeof assetSchema>;
export type VehicleFormValues = z.infer<typeof vehicleSchema>;
export type LogFormValues = z.infer<typeof logSchema>;
export type ScheduleCompletionFormValues = z.infer<typeof scheduleCompletionSchema>;

export type LogPreset = {
  targetType?: MaintenanceTargetType;
  assetId?: string;
  vehicleId?: string;
  title?: string;
  mileage?: string;
};

export type AssetScheduleForm = {
  id: string;
  mode: MaintenanceScheduleMode;
  scheduleName: string;
  frequencyType: HomeAssetSchedule['frequencyType'] | '';
  intervalValue: string;
  lastCompletedDate: string;
  nextDueDate: string;
  /** Not editable: kept so saving unrelated edits does not cancel a snooze. */
  snoozedUntil: string;
  snoozedFrom: string;
} & ScheduleAnchorForm;

/** Calendar anchoring in the forms (MA-11g): '' keeps the stored default (completion). */
export type ScheduleAnchorForm = {
  anchor: '' | 'completion' | 'calendar';
  anchorMonth: string;
  anchorDay: string;
  /** The form suggested nextDueDate (a preset or a calendar anchor); never sent to the server. */
  nextDueGenerated?: boolean;
};

export type VehicleScheduleForm = {
  id: string;
  mode: MaintenanceScheduleMode;
  serviceName: string;
  intervalMiles: string;
  intervalMonths: string;
  lastCompletedMileage: string;
  lastCompletedDate: string;
  nextDueMileage: string;
  nextDueDate: string;
  /** Not editable: kept so saving unrelated edits does not cancel a snooze. */
  snoozedUntil: string;
  snoozedFrom: string;
} & ScheduleAnchorForm;

const anchorToForm = (schedule?: { anchor?: string; anchorMonth?: number; anchorDay?: number }): ScheduleAnchorForm => ({
  anchor: schedule?.anchor === 'calendar' || schedule?.anchor === 'completion' ? schedule.anchor : '',
  anchorMonth: schedule?.anchorMonth?.toString() || '',
  anchorDay: schedule?.anchorDay?.toString() || '',
});

/** The anchor fields a form sends (absent unless calendar-anchored or stored). */
const anchorValuesOf = (schedule: ScheduleAnchorForm) => ({
  anchor: schedule.anchor || undefined,
  anchorMonth: schedule.anchor === 'calendar' ? toNumber(schedule.anchorMonth) : undefined,
  anchorDay: schedule.anchor === 'calendar' ? toNumber(schedule.anchorDay) : undefined,
});

export const emptyAssetForm: AssetFormValues = {
  name: '',
  category: 'Appliance',
  location: '',
  brand: '',
  model: '',
  serialNumber: '',
  purchaseDate: '',
  purchasePrice: '',
  warrantyExpiration: '',
  warrantyProvider: '',
  warrantyLifetime: false,
  status: 'active',
  notes: '',
  scheduleName: '',
  frequencyType: undefined,
  intervalValue: '',
  lastCompletedDate: '',
  nextDueDate: '',
};

export const emptyVehicleForm: VehicleFormValues = {
  nickname: '',
  year: '',
  make: '',
  model: '',
  trim: '',
  vin: '',
  licensePlate: '',
  currentMileage: '',
  purchaseDate: '',
  purchasePrice: '',
  insuranceProvider: '',
  registrationExpiration: '',
  inspectionExpiration: '',
  status: 'active',
  notes: '',
  serviceName: '',
  intervalMiles: '',
  intervalMonths: '',
  lastCompletedMileage: '',
  lastCompletedDate: '',
  nextDueMileage: '',
  nextDueDate: '',
};

export const emptyLogForm = (preset: LogPreset | undefined, today: string): LogFormValues => ({
  targetType: preset?.targetType || 'general',
  assetId: preset?.assetId || '',
  vehicleId: preset?.vehicleId || '',
  title: preset?.title || '',
  date: today,
  type: 'routine',
  notes: '',
  cost: '',
  partsUsed: '',
  serviceProvider: '',
  mileage: preset?.mileage || '',
});

export const createLocalId = () => Math.random().toString(36).slice(2, 10);

// A stored schedule keeps its id; one without an id is named by its legacy key, which
// the server assigns as its id on save (M1), so the form and the server agree.
export const assetScheduleToForm = (schedule?: HomeAssetSchedule, index = -1): AssetScheduleForm => ({
  id: schedule ? scheduleRef(schedule as StoredSchedule, index, 'home_asset') : createLocalId(),
  mode: schedule ? getAssetScheduleMode(schedule) : 'scheduled',
  scheduleName: schedule?.scheduleName || '',
  frequencyType: schedule?.frequencyType || '',
  intervalValue: schedule?.intervalValue?.toString() || '',
  lastCompletedDate: schedule?.lastCompletedDate || '',
  nextDueDate: schedule?.nextDueDate || '',
  snoozedUntil: schedule?.snoozedUntil || '',
  snoozedFrom: schedule?.snoozedFrom || '',
  ...anchorToForm(schedule),
});

export const vehicleScheduleToForm = (schedule?: VehicleServiceSchedule, index = -1): VehicleScheduleForm => ({
  id: schedule ? scheduleRef(schedule as StoredSchedule, index, 'vehicle') : createLocalId(),
  mode: schedule ? getVehicleScheduleMode(schedule) : 'scheduled',
  serviceName: schedule?.serviceName || '',
  intervalMiles: schedule?.intervalMiles?.toString() || '',
  intervalMonths: schedule?.intervalMonths?.toString() || '',
  lastCompletedMileage: schedule?.lastCompletedMileage?.toString() || '',
  lastCompletedDate: schedule?.lastCompletedDate || '',
  nextDueMileage: schedule?.nextDueMileage?.toString() || '',
  nextDueDate: schedule?.nextDueDate || '',
  snoozedUntil: schedule?.snoozedUntil || '',
  snoozedFrom: schedule?.snoozedFrom || '',
  ...anchorToForm(schedule),
});

export const toNumber = (value?: string) => {
  if (!value || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const trimOptional = (value?: string) => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

export const removeUndefinedValues = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedValues);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([entryKey, entryValue]) => [entryKey, removeUndefinedValues(entryValue)])
    );
  }

  return value;
};

export const cleanForFirestore = <T extends Record<string, unknown>>(data: T) => {
  return removeUndefinedValues(data) as T;
};

// The values a form sends to the server (and, built from the record when the form
// opens, the `base` it is compared with): only fields that differ are written.
export const assetValuesOf = (values: AssetFormValues, schedules: AssetScheduleForm[]) => ({
  name: values.name.trim(),
  category: values.category,
  location: trimOptional(values.location),
  brand: trimOptional(values.brand),
  model: trimOptional(values.model),
  serialNumber: trimOptional(values.serialNumber),
  purchaseDate: trimOptional(values.purchaseDate),
  purchasePrice: toNumber(values.purchasePrice),
  warrantyExpiration: trimOptional(values.warrantyExpiration),
  warrantyProvider: trimOptional(values.warrantyProvider),
  warrantyLifetime: values.warrantyLifetime ? true : undefined,
  status: values.status,
  notes: trimOptional(values.notes),
  schedules: schedules.filter(schedule => schedule.scheduleName.trim()).map(schedule => ({
    id: schedule.id,
    mode: schedule.mode,
    scheduleName: schedule.scheduleName.trim(),
    frequencyType: schedule.frequencyType || undefined,
    intervalValue: toNumber(schedule.intervalValue),
    lastCompletedDate: trimOptional(schedule.lastCompletedDate),
    nextDueDate: trimOptional(schedule.nextDueDate),
    // Carried through unchanged (never sent as a change): it only applies while it
    // equals nextDueDate, so editing the due date ends the snooze on its own.
    snoozedUntil: trimOptional(schedule.snoozedUntil),
    snoozedFrom: trimOptional(schedule.snoozedFrom),
    ...anchorValuesOf(schedule),
  })),
});

export const vehicleValuesOf = (values: VehicleFormValues, schedules: VehicleScheduleForm[]) => ({
  nickname: values.nickname.trim(),
  year: toNumber(values.year),
  make: trimOptional(values.make),
  model: trimOptional(values.model),
  trim: trimOptional(values.trim),
  vin: trimOptional(values.vin),
  licensePlate: trimOptional(values.licensePlate),
  currentMileage: toNumber(values.currentMileage),
  purchaseDate: trimOptional(values.purchaseDate),
  purchasePrice: toNumber(values.purchasePrice),
  insuranceProvider: trimOptional(values.insuranceProvider),
  registrationExpiration: trimOptional(values.registrationExpiration),
  inspectionExpiration: trimOptional(values.inspectionExpiration),
  status: values.status,
  notes: trimOptional(values.notes),
  serviceSchedules: schedules.filter(schedule => schedule.serviceName.trim()).map(schedule => ({
    id: schedule.id,
    mode: schedule.mode,
    serviceName: schedule.serviceName.trim(),
    intervalMiles: toNumber(schedule.intervalMiles),
    intervalMonths: toNumber(schedule.intervalMonths),
    lastCompletedMileage: toNumber(schedule.lastCompletedMileage),
    lastCompletedDate: trimOptional(schedule.lastCompletedDate),
    nextDueMileage: toNumber(schedule.nextDueMileage),
    nextDueDate: trimOptional(schedule.nextDueDate),
    snoozedUntil: trimOptional(schedule.snoozedUntil),
    snoozedFrom: trimOptional(schedule.snoozedFrom),
    ...anchorValuesOf(schedule),
  })),
});

export const logValuesOf = (values: LogFormValues) => ({
  targetType: values.targetType,
  assetId: values.targetType === 'home_asset' ? values.assetId || undefined : undefined,
  vehicleId: values.targetType === 'vehicle' ? values.vehicleId || undefined : undefined,
  title: values.title.trim(),
  date: values.date,
  type: values.type,
  notes: trimOptional(values.notes),
  cost: toNumber(values.cost),
  partsUsed: trimOptional(values.partsUsed),
  serviceProvider: trimOptional(values.serviceProvider),
  mileage: values.targetType === 'vehicle' ? toNumber(values.mileage) : undefined,
});

export type AssetValues = ReturnType<typeof assetValuesOf>;
export type VehicleValues = ReturnType<typeof vehicleValuesOf>;
export type LogValues = ReturnType<typeof logValuesOf>;

export const formatCurrency = (value?: number) => {
  if (typeof value !== 'number') return 'Not recorded';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
};

export const parseLogDate = (date: string) => {
  const parsed = parseISO(date);
  if (isValid(parsed)) return parsed;
  const fallback = new Date(date);
  return isValid(fallback) ? fallback : new Date();
};

export const dateInputValue = (date: string | undefined, today: string) => {
  if (!date) return today;
  return format(parseLogDate(date), 'yyyy-MM-dd');
};

export const formatDate = (date?: string) => {
  if (!date) return 'Not recorded';
  return format(parseLogDate(date), 'MMM d, yyyy');
};

/** For detail fields: undefined (hidden) when there is no value. */
export const optionalDate = (date?: string) => (date ? formatDate(date) : undefined);
export const optionalCurrency = (value?: number) => (typeof value === 'number' ? formatCurrency(value) : undefined);

export { MAINTENANCE_TABS, isMaintenanceTab, type MaintenanceTab } from '@/lib/maintenance/deep-link';

export const humanizeLabel = (status: string) => {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
};

export const getLogTitle = (log: MaintenanceLog) => log.title || log.item || 'Maintenance log';
export const getLogType = (log: MaintenanceLog): MaintenanceLogType => log.type || 'other';
export const getLogTargetType = (log: MaintenanceLog): MaintenanceTargetType => {
  if (log.targetType) return log.targetType;
  if (log.assetId) return 'home_asset';
  if (log.vehicleId) return 'vehicle';
  return 'general';
};

export const getTargetName = (log: MaintenanceLog, assets: HomeAsset[], vehicles: Vehicle[]) => {
  const targetType = getLogTargetType(log);
  if (targetType === 'home_asset') {
    return assets.find((asset) => asset.id === log.assetId)?.name || 'Unlinked home asset';
  }
  if (targetType === 'vehicle') {
    return vehicles.find((vehicle) => vehicle.id === log.vehicleId)?.nickname || 'Unlinked vehicle';
  }
  return log.formerTargetName ? `General - formerly ${log.formerTargetName}` : 'General';
};

export type ScheduleRemovalTarget =
  | { targetType: 'home_asset'; id: string; name: string }
  | { targetType: 'vehicle'; id: string; name: string };

export const sanitizeFileName = (fileName: string) => {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
};

export const formatFileSize = (size?: number) => {
  if (typeof size !== 'number') return 'Unknown size';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

export const getAttachmentsForTarget = (
  attachments: MaintenanceAttachment[],
  targetType: MaintenanceAttachmentTargetType,
  targetId: string
) => {
  return attachments.filter((attachment) => attachment.targetType === targetType && attachment.targetId === targetId);
};


export const assetFormFromRecord = (asset: HomeAsset): AssetFormValues => ({
  name: asset.name,
  category: asset.category,
  location: asset.location || '',
  brand: asset.brand || '',
  model: asset.model || '',
  serialNumber: asset.serialNumber || '',
  purchaseDate: asset.purchaseDate || '',
  purchasePrice: asset.purchasePrice?.toString() || '',
  warrantyExpiration: asset.warrantyExpiration || '',
  warrantyProvider: asset.warrantyProvider || '',
  warrantyLifetime: asset.warrantyLifetime === true,
  status: asset.status,
  notes: asset.notes || '',
  scheduleName: '',
  frequencyType: undefined,
  intervalValue: '',
  lastCompletedDate: '',
  nextDueDate: '',
});

export const vehicleFormFromRecord = (vehicle: Vehicle): VehicleFormValues => ({
  nickname: vehicle.nickname,
  year: vehicle.year?.toString() || '',
  make: vehicle.make || '',
  model: vehicle.model || '',
  trim: vehicle.trim || '',
  vin: vehicle.vin || '',
  licensePlate: vehicle.licensePlate || '',
  currentMileage: vehicle.currentMileage?.toString() || '',
  purchaseDate: vehicle.purchaseDate || '',
  purchasePrice: vehicle.purchasePrice?.toString() || '',
  insuranceProvider: vehicle.insuranceProvider || '',
  registrationExpiration: vehicle.registrationExpiration || '',
  inspectionExpiration: vehicle.inspectionExpiration || '',
  status: vehicle.status,
  notes: vehicle.notes || '',
  serviceName: '',
  intervalMiles: '',
  intervalMonths: '',
  lastCompletedMileage: '',
  lastCompletedDate: '',
  nextDueMileage: '',
  nextDueDate: '',
});

export const logFormFromRecord = (log: MaintenanceLog, today: string): LogFormValues => ({
  targetType: getLogTargetType(log),
  assetId: log.assetId || '',
  vehicleId: log.vehicleId || '',
  title: getLogTitle(log),
  date: dateInputValue(log.date, today),
  type: getLogType(log),
  notes: log.notes || '',
  cost: log.cost?.toString() || '',
  partsUsed: log.partsUsed || '',
  serviceProvider: log.serviceProvider || '',
  mileage: log.mileage?.toString() || '',
});

export type SaveNoticeState = { message: string; retry?: () => void };

export const getScheduleCompletionName = (target: ScheduleCompletionTarget) => {
  return target.targetType === 'home_asset'
    ? target.schedule.scheduleName || 'Scheduled maintenance'
    : target.schedule.serviceName || 'Scheduled maintenance';
};

/** The completion form's first values: done today (the household's), next due advanced by the interval. */
export function completionFormValues(target: ScheduleCompletionTarget, today: string): ScheduleCompletionFormValues {
  const completedDate = today;
  const completedMileage = target.targetType === 'vehicle'
    ? target.vehicle.currentMileage?.toString() || target.schedule.lastCompletedMileage?.toString() || ''
    : '';
  return {
    completedDate,
    mileage: completedMileage,
    // Anchor-aware (MA-11g): a calendar schedule stays on its day.
    nextDueDate: nextDueAfterCompletion(target.schedule, completedDate) || target.schedule.nextDueDate || '',
    nextDueMileage: target.targetType === 'vehicle'
      ? calculateNextVehicleMileage(target.schedule, toNumber(completedMileage))?.toString() || target.schedule.nextDueMileage?.toString() || ''
      : '',
    notes: '',
  };
}
