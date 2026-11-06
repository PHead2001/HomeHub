"use client";

import * as React from 'react';
import { buildMaintenanceReminders, type MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { localDay, safeTimeZone } from '@functions/shared/calendar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { format, isAfter, isValid, parseISO, subDays } from 'date-fns';
import {
  AlertCircle,
  CalendarDays,
  Car,
  ClipboardList,
  Download,
  DollarSign,
  Edit,
  FileText,
  Home,
  Loader2,
  PencilLine,
  Plus,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import { summarizeMaintenanceLog } from '@/ai/flows/summarize-maintenance-log';
import { AiClientError, getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import type {
  HomeAsset,
  HomeAssetCategory,
  HomeAssetSchedule,
  MaintenanceAttachment,
  MaintenanceAttachmentCategory,
  MaintenanceAttachmentTargetType,
  MaintenanceLog,
  MaintenanceLogType,
  MaintenanceScheduleMode,
  MaintenanceTargetType,
  Notification,
  Vehicle,
  VehicleServiceSchedule,
} from '@/lib/types';
import {
  createNotificationAction,
  parseNotificationDoc,
} from '@/lib/notifications';
import { EmptyState } from '@/components/empty-state';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { AssetCard } from '@/components/maintenance/asset-card';
import { HealthPanel } from '@/components/maintenance/health-panel';
import { HealthRing } from '@/components/maintenance/health-ring';
import { ReminderList, type ReminderBusy } from '@/components/maintenance/reminder-list';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { playFeedback } from '@/lib/feedback';
import { pickAssetPhoto, presentFields, shouldOfferAiSummary } from '@/lib/maintenance/display';
import { computeHomeHealth, healthKey, type HealthDeduction, type HealthResult } from '@/lib/maintenance/health';
import {
  calculateNextAssetDueDate,
  calculateNextVehicleDueDate,
  calculateNextVehicleMileage,
  completedAssetSchedule,
  completedVehicleSchedule,
  findReminderSchedule,
  getAssetScheduleMode,
  getVehicleScheduleMode,
  quickCompletionValues,
  scheduleKeyFor,
  snoozedDueDate,
  type ScheduleCompletionTarget,
} from '@/lib/maintenance/schedules';
import { cn, slugify, stableSlugify } from '@/lib/utils';
import { collection, deleteDoc, deleteField, doc, getDocs, orderBy, query, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';

const assetCategories = [
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

const assetStatuses = ['active', 'needs_attention', 'retired'] as const;
const vehicleStatuses = ['active', 'needs_attention', 'retired', 'sold'] as const;
const logTargetTypes = ['general', 'home_asset', 'vehicle'] as const;
const logTypes = ['repair', 'routine', 'inspection', 'cleaning', 'replacement', 'issue', 'other'] as const;
const frequencyTypes = ['days', 'weeks', 'months', 'years'] as const;
const attachmentCategories = ['photo', 'receipt', 'manual', 'warranty_document', 'invoice', 'other'] as const;
const REMINDER_DUE_SOON_DAYS = 14;
const MILEAGE_DUE_SOON_THRESHOLD = 500;

const assetSchema = z.object({
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
  status: z.enum(assetStatuses),
  notes: z.string().optional(),
  scheduleName: z.string().optional(),
  frequencyType: z.enum(frequencyTypes).optional(),
  intervalValue: z.string().optional(),
  lastCompletedDate: z.string().optional(),
  nextDueDate: z.string().optional(),
});

const vehicleSchema = z.object({
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

const logSchema = z.object({
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

const scheduleCompletionSchema = z.object({
  completedDate: z.string().min(1, 'Completed date is required.'),
  mileage: z.string().optional(),
  nextDueDate: z.string().optional(),
  nextDueMileage: z.string().optional(),
  notes: z.string().optional(),
});

type AssetFormValues = z.infer<typeof assetSchema>;
type VehicleFormValues = z.infer<typeof vehicleSchema>;
type LogFormValues = z.infer<typeof logSchema>;
type ScheduleCompletionFormValues = z.infer<typeof scheduleCompletionSchema>;

type LogPreset = {
  targetType?: MaintenanceTargetType;
  assetId?: string;
  vehicleId?: string;
};

type AssetScheduleForm = {
  id: string;
  mode: MaintenanceScheduleMode;
  scheduleName: string;
  frequencyType: HomeAssetSchedule['frequencyType'] | '';
  intervalValue: string;
  lastCompletedDate: string;
  nextDueDate: string;
};

type VehicleScheduleForm = {
  id: string;
  mode: MaintenanceScheduleMode;
  serviceName: string;
  intervalMiles: string;
  intervalMonths: string;
  lastCompletedMileage: string;
  lastCompletedDate: string;
  nextDueMileage: string;
  nextDueDate: string;
};

const todayInputValue = () => format(new Date(), 'yyyy-MM-dd');

const emptyAssetForm: AssetFormValues = {
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
  status: 'active',
  notes: '',
  scheduleName: '',
  frequencyType: undefined,
  intervalValue: '',
  lastCompletedDate: '',
  nextDueDate: '',
};

const emptyVehicleForm: VehicleFormValues = {
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

const emptyLogForm = (preset?: LogPreset): LogFormValues => ({
  targetType: preset?.targetType || 'general',
  assetId: preset?.assetId || '',
  vehicleId: preset?.vehicleId || '',
  title: '',
  date: todayInputValue(),
  type: 'routine',
  notes: '',
  cost: '',
  partsUsed: '',
  serviceProvider: '',
  mileage: '',
});

const emptyScheduleCompletionForm = (): ScheduleCompletionFormValues => ({
  completedDate: todayInputValue(),
  mileage: '',
  nextDueDate: '',
  nextDueMileage: '',
  notes: '',
});

const createLocalId = () => Math.random().toString(36).slice(2, 10);

const assetScheduleToForm = (schedule?: HomeAssetSchedule): AssetScheduleForm => ({
  id: schedule?.id || createLocalId(),
  mode: schedule ? getAssetScheduleMode(schedule) : 'scheduled',
  scheduleName: schedule?.scheduleName || '',
  frequencyType: schedule?.frequencyType || '',
  intervalValue: schedule?.intervalValue?.toString() || '',
  lastCompletedDate: schedule?.lastCompletedDate || '',
  nextDueDate: schedule?.nextDueDate || '',
});

const vehicleScheduleToForm = (schedule?: VehicleServiceSchedule): VehicleScheduleForm => ({
  id: schedule?.id || createLocalId(),
  mode: schedule ? getVehicleScheduleMode(schedule) : 'scheduled',
  serviceName: schedule?.serviceName || '',
  intervalMiles: schedule?.intervalMiles?.toString() || '',
  intervalMonths: schedule?.intervalMonths?.toString() || '',
  lastCompletedMileage: schedule?.lastCompletedMileage?.toString() || '',
  lastCompletedDate: schedule?.lastCompletedDate || '',
  nextDueMileage: schedule?.nextDueMileage?.toString() || '',
  nextDueDate: schedule?.nextDueDate || '',
});

const toNumber = (value?: string) => {
  if (!value || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const trimOptional = (value?: string) => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const removeUndefinedValues = (value: unknown): unknown => {
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

const cleanForFirestore = <T extends Record<string, unknown>>(data: T) => {
  return removeUndefinedValues(data) as T;
};

const formatCurrency = (value?: number) => {
  if (typeof value !== 'number') return 'Not recorded';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
};

const parseLogDate = (date: string) => {
  const parsed = parseISO(date);
  if (isValid(parsed)) return parsed;
  const fallback = new Date(date);
  return isValid(fallback) ? fallback : new Date();
};

const dateInputValue = (date?: string) => {
  if (!date) return todayInputValue();
  return format(parseLogDate(date), 'yyyy-MM-dd');
};

const formatDate = (date?: string) => {
  if (!date) return 'Not recorded';
  return format(parseLogDate(date), 'MMM d, yyyy');
};

/** For detail fields: undefined (hidden) when there is no value. */
const optionalDate = (date?: string) => (date ? formatDate(date) : undefined);
const optionalCurrency = (value?: number) => (typeof value === 'number' ? formatCurrency(value) : undefined);

const MAINTENANCE_TABS = ['overview', 'assets', 'vehicles', 'reminders', 'logs'] as const;
type MaintenanceTab = typeof MAINTENANCE_TABS[number];
const isMaintenanceTab = (value: string | null): value is MaintenanceTab =>
  Boolean(value && (MAINTENANCE_TABS as readonly string[]).includes(value));

const humanizeLabel = (status: string) => {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const getLogTitle = (log: MaintenanceLog) => log.title || log.item || 'Maintenance log';
const getLogType = (log: MaintenanceLog): MaintenanceLogType => log.type || 'other';
const getLogTargetType = (log: MaintenanceLog): MaintenanceTargetType => {
  if (log.targetType) return log.targetType;
  if (log.assetId) return 'home_asset';
  if (log.vehicleId) return 'vehicle';
  return 'general';
};

const getTargetName = (log: MaintenanceLog, assets: HomeAsset[], vehicles: Vehicle[]) => {
  const targetType = getLogTargetType(log);
  if (targetType === 'home_asset') {
    return assets.find((asset) => asset.id === log.assetId)?.name || 'Unlinked home asset';
  }
  if (targetType === 'vehicle') {
    return vehicles.find((vehicle) => vehicle.id === log.vehicleId)?.nickname || 'Unlinked vehicle';
  }
  return log.formerTargetName ? `General - formerly ${log.formerTargetName}` : 'General';
};

type ScheduleRemovalTarget =
  | { targetType: 'home_asset'; id: string; name: string }
  | { targetType: 'vehicle'; id: string; name: string };

const sanitizeFileName = (fileName: string) => {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
};

const formatFileSize = (size?: number) => {
  if (typeof size !== 'number') return 'Unknown size';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const getAttachmentsForTarget = (
  attachments: MaintenanceAttachment[],
  targetType: MaintenanceAttachmentTargetType,
  targetId: string
) => {
  return attachments.filter((attachment) => attachment.targetType === targetType && attachment.targetId === targetId);
};


function SummaryCard({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail: string;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

/** Detail fields that have a value; empty ones are left out instead of saying "Not recorded" (D15). */
function DetailGrid({ fields }: { fields: Array<{ label: string; value?: string | number | null }> }) {
  const present = presentFields(fields);
  if (present.length === 0) return null;
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {present.map((field) => (
        <div key={field.label}>
          <dt className="text-xs uppercase text-muted-foreground">{field.label}</dt>
          <dd className="text-sm">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AttachmentPanel({
  title = 'Attachments',
  attachments,
  targetType,
  targetId,
  uploading,
  deletingId,
  canUpload,
  canDelete,
  onUpload,
  onDelete,
}: {
  title?: string;
  attachments: MaintenanceAttachment[];
  targetType: MaintenanceAttachmentTargetType;
  targetId: string;
  uploading: boolean;
  deletingId?: string | null;
  canUpload: boolean;
  canDelete: boolean;
  onUpload: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  onDelete: (attachment: MaintenanceAttachment) => void;
}) {
  const [category, setCategory] = useState<MaintenanceAttachmentCategory>('photo');

  return (
    <div className="rounded-lg border p-3" data-testid={`attachments-${targetType}-${targetId}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-headline font-semibold">{title}</h3>
        </div>
        {canUpload && <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={category} onValueChange={(value) => setCategory(value as MaintenanceAttachmentCategory)}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {attachmentCategories.map((option) => (
                <SelectItem key={option} value={option}>{humanizeLabel(option)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button asChild variant="outline" size="sm" disabled={uploading}>
            <label className="relative cursor-pointer overflow-hidden">
              {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Upload
              {/* Plain input: the shared Input's w-full overrides sr-only and widened the page (B7). */}
              <input
                type="file"
                className="sr-only"
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUpload(targetType, targetId, category, file);
                  event.target.value = '';
                }}
              />
            </label>
          </Button>
        </div>}
      </div>

      {attachments.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No attachments yet.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium">{attachment.fileName}</p>
                  <Badge variant="secondary">{humanizeLabel(attachment.category)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatDate(attachment.createdAt)} - {formatFileSize(attachment.size)}
                  {attachment.uploadedByName ? ` - ${attachment.uploadedByName}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 self-start sm:self-center">
                {attachment.downloadUrl && (
                  <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                    <a href={attachment.downloadUrl} target="_blank" rel="noreferrer">
                      <Download className="h-4 w-4" />
                      <span className="sr-only">Open attachment {attachment.fileName}</span>
                    </a>
                  </Button>
                )}
                {canDelete && <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  disabled={deletingId === attachment.id}
                  onClick={() => onDelete(attachment)}
                  aria-label={`Delete attachment ${attachment.fileName}`}
                >
                  {deletingId === attachment.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  <span className="sr-only">Delete attachment</span>
                </Button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const AutoResizeTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentPropsWithoutRef<typeof Textarea>
>(({ className, onInput, value, ...props }, forwardedRef) => {
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  const resizeTextarea = useCallback((textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  React.useImperativeHandle(forwardedRef, () => localRef.current as HTMLTextAreaElement);

  useEffect(() => {
    if (localRef.current) {
      resizeTextarea(localRef.current);
    }
  }, [resizeTextarea, value]);

  return (
    <Textarea
      {...props}
      ref={localRef}
      value={value}
      className={cn('min-h-24 resize-none overflow-hidden', className)}
      onInput={(event) => {
        resizeTextarea(event.currentTarget);
        onInput?.(event);
      }}
    />
  );
});
AutoResizeTextarea.displayName = 'AutoResizeTextarea';

function LogList({
  logs,
  assets,
  vehicles,
  attachments,
  summaries,
  loadingSummaries,
  uploadingAttachmentTarget,
  deletingAttachmentId,
  onSummarize,
  onEdit,
  onDelete,
  onUploadAttachment,
  onDeleteAttachment,
  highlightedLogId,
  canEdit,
  canDelete,
  emptyTitle = 'No logs yet',
  emptyDescription = 'Record repairs, service and inspections here as they happen.',
}: {
  canEdit: boolean;
  canDelete: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  logs: MaintenanceLog[];
  assets: HomeAsset[];
  vehicles: Vehicle[];
  attachments: MaintenanceAttachment[];
  summaries: Record<string, string>;
  loadingSummaries: Record<string, boolean>;
  uploadingAttachmentTarget?: string | null;
  deletingAttachmentId?: string | null;
  onSummarize: (log: MaintenanceLog) => void;
  onEdit: (log: MaintenanceLog) => void;
  onDelete: (log: MaintenanceLog) => void;
  onUploadAttachment: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  onDeleteAttachment: (attachment: MaintenanceAttachment) => void;
  highlightedLogId?: string | null;
}) {
  if (logs.length === 0) {
    return <EmptyState compact headingLevel={3} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => (
        <Card
          key={log.id}
          id={`maintenance-log-${log.id}`}
          data-testid={`maintenance-log-${log.id}`}
          className={cn(highlightedLogId === log.id && 'ring-2 ring-primary')}
        >
          <CardContent className="p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-headline text-base font-semibold">{getLogTitle(log)}</h3>
                  <Badge variant="secondary">{getLogType(log)}</Badge>
                  <Badge variant="outline">{getTargetName(log, assets, vehicles)}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{formatDate(log.date)}</p>
              </div>
              <div className="flex items-center gap-2 self-start">
                {typeof log.cost === 'number' && (
                  <Badge variant="outline" className="w-fit">{formatCurrency(log.cost)}</Badge>
                )}
                {/* Edit and Delete are kept apart by a divider so a slip cannot hit Delete; Delete still confirms. */}
                {canEdit && (
                  <Button variant="ghost" size="icon" aria-label={`Edit maintenance log ${getLogTitle(log)}`} className="h-8 w-8" onClick={() => onEdit(log)}>
                    <Edit className="h-4 w-4" />
                  </Button>
                )}
                {canEdit && canDelete && <span aria-hidden className="mx-1 h-5 w-px bg-border" />}
                {canDelete && (
                  <Button variant="ghost" size="icon" aria-label={`Delete maintenance log ${getLogTitle(log)}`} className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onDelete(log)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {log.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{log.notes}</p>}

            <div className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
              {log.serviceProvider && <span>Provider: {log.serviceProvider}</span>}
              {log.partsUsed && <span>Parts: {log.partsUsed}</span>}
              {typeof log.mileage === 'number' && <span>Mileage: {log.mileage.toLocaleString()}</span>}
            </div>

            {summaries[log.id] && (
              <div className="mt-4 rounded-md border border-primary/20 bg-primary/10 p-3">
                <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-primary">
                  <Sparkles className="h-4 w-4" />
                  AI Summary
                </h4>
                <p className="text-sm">{summaries[log.id]}</p>
              </div>
            )}

            {shouldOfferAiSummary(log.notes) && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => onSummarize(log)}
                disabled={loadingSummaries[log.id]}
              >
                {loadingSummaries[log.id] ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating...</>
                ) : (
                  <><Sparkles className="mr-2 h-4 w-4" /> Summarize with AI</>
                )}
              </Button>
            )}

            <div className="mt-4">
              <AttachmentPanel
                title="Log Attachments"
                attachments={getAttachmentsForTarget(attachments, 'maintenance_log', log.id)}
                targetType="maintenance_log"
                targetId={log.id}
                uploading={uploadingAttachmentTarget === `maintenance_log:${log.id}`}
                deletingId={deletingAttachmentId}
                canUpload={canEdit}
                canDelete={canDelete}
                onUpload={onUploadAttachment}
                onDelete={onDeleteAttachment}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function MaintenanceLogClient() {
  const { currentUser, currentMember, household, permissions } = useAuth();
  const { toast, toastError } = useToast();
  const canEdit = permissions['maintenance.edit'];
  const canCreateLogs = permissions['maintenance.createLogs'];
  const canDelete = permissions['maintenance.delete'];
  // Completing a schedule writes a log and the schedule, so it needs both.
  const canComplete = canEdit && canCreateLogs;
  // Only decided once the membership has loaded, so nobody sees a flash of "no access".
  const accessDenied = Boolean(currentMember) && !permissions['maintenance.view'];
  const [assets, setAssets] = useState<HomeAsset[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [logs, setLogs] = useState<MaintenanceLog[]>([]);
  const [attachments, setAttachments] = useState<MaintenanceAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MaintenanceTab>('overview');
  const appliedSearch = useRef<string | null>(null);
  const [reminderBusy, setReminderBusy] = useState<ReminderBusy>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [highlightedLogId, setHighlightedLogId] = useState<string | null>(null);
  const [highlightedScheduleKey, setHighlightedScheduleKey] = useState<string | null>(null);
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null);
  const [locationSearch, setLocationSearch] = useState('');
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const [vehicleDialogOpen, setVehicleDialogOpen] = useState(false);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<HomeAsset | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [editingLog, setEditingLog] = useState<MaintenanceLog | null>(null);
  const [logToDelete, setLogToDelete] = useState<MaintenanceLog | null>(null);
  const [assetToDelete, setAssetToDelete] = useState<HomeAsset | null>(null);
  const [vehicleToDelete, setVehicleToDelete] = useState<Vehicle | null>(null);
  const [attachmentToDelete, setAttachmentToDelete] = useState<MaintenanceAttachment | null>(null);
  const [scheduleToRemove, setScheduleToRemove] = useState<ScheduleRemovalTarget | null>(null);
  const [deletingRecord, setDeletingRecord] = useState<string | null>(null);
  const [scheduleCompletionTarget, setScheduleCompletionTarget] = useState<ScheduleCompletionTarget | null>(null);
  const [assetScheduleForms, setAssetScheduleForms] = useState<AssetScheduleForm[]>([]);
  const [vehicleScheduleForms, setVehicleScheduleForms] = useState<VehicleScheduleForm[]>([]);
  const [assetScheduleErrors, setAssetScheduleErrors] = useState<Record<string, string>>({});
  const [vehicleScheduleErrors, setVehicleScheduleErrors] = useState<Record<string, string>>({});
  const [showInactiveVehicles, setShowInactiveVehicles] = useState(false);
  const [uploadingAttachmentTarget, setUploadingAttachmentTarget] = useState<string | null>(null);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [loadingSummaries, setLoadingSummaries] = useState<Record<string, boolean>>({});

  const assetForm = useForm<AssetFormValues>({
    resolver: zodResolver(assetSchema),
    defaultValues: emptyAssetForm,
  });

  const vehicleForm = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleSchema),
    defaultValues: emptyVehicleForm,
  });

  const logForm = useForm<LogFormValues>({
    resolver: zodResolver(logSchema),
    defaultValues: emptyLogForm(),
  });

  const scheduleCompletionForm = useForm<ScheduleCompletionFormValues>({
    resolver: zodResolver(scheduleCompletionSchema),
    defaultValues: emptyScheduleCompletionForm(),
  });

  const getCollectionRef = useCallback((collectionName: 'home-assets' | 'vehicles' | 'maintenance' | 'maintenance-attachments' | 'notifications') => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, collectionName);
  }, [currentUser?.householdId]);

  // `silent` refreshes after a change keep the page on screen (no skeleton), so
  // in-place actions stay in place; a failed silent refresh only toasts.
  const fetchMaintenanceData = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const assetsCollection = getCollectionRef('home-assets');
    const vehiclesCollection = getCollectionRef('vehicles');
    const logsCollection = getCollectionRef('maintenance');
    const attachmentsCollection = getCollectionRef('maintenance-attachments');

    if (!assetsCollection || !vehiclesCollection || !logsCollection || !attachmentsCollection) {
      setAssets([]);
      setVehicles([]);
      setLogs([]);
      setAttachments([]);
      setLoading(false);
      return;
    }

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    try {
      const [assetSnap, vehicleSnap, logSnap, attachmentSnap] = await Promise.all([
        getDocs(query(assetsCollection, orderBy('name', 'asc'))),
        getDocs(query(vehiclesCollection, orderBy('nickname', 'asc'))),
        getDocs(query(logsCollection, orderBy('date', 'desc'))),
        getDocs(query(attachmentsCollection, orderBy('createdAt', 'desc'))),
      ]);

      setAssets(assetSnap.docs.map((assetDoc) => ({ id: assetDoc.id, ...assetDoc.data() } as HomeAsset)));
      setVehicles(vehicleSnap.docs.map((vehicleDoc) => ({ id: vehicleDoc.id, ...vehicleDoc.data() } as Vehicle)));
      setLogs(logSnap.docs.map((logDoc) => ({ id: logDoc.id, ...logDoc.data() } as MaintenanceLog)));
      setAttachments(attachmentSnap.docs.map((attachmentDoc) => ({ id: attachmentDoc.id, ...attachmentDoc.data() } as MaintenanceAttachment)));
    } catch (fetchError) {
      console.error('Error fetching maintenance data:', fetchError);
      if (silent) {
        toastError(fetchError, 'Could not refresh maintenance');
      } else {
        setError('Could not load maintenance data.');
        toastError(fetchError, 'Could not load maintenance');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [getCollectionRef, toastError]);

  const refreshMaintenanceData = useCallback(() => fetchMaintenanceData({ silent: true }), [fetchMaintenanceData]);

  useEffect(() => {
    if (currentUser?.householdId && !accessDenied) {
      void fetchMaintenanceData();
    } else {
      setAssets([]);
      setVehicles([]);
      setLogs([]);
      setAttachments([]);
      setLoading(false);
    }
  }, [accessDenied, currentUser?.householdId, fetchMaintenanceData]);

  useEffect(() => {
    const syncLocation = () => setLocationSearch(window.location.search);
    syncLocation();
    window.addEventListener('popstate', syncLocation);
    return () => window.removeEventListener('popstate', syncLocation);
  }, []);

  // Deep links are applied once per URL, after data loads. Later refreshes (for
  // example after Mark done on the Reminders tab) must not pull the page back to
  // the linked record.
  useEffect(() => {
    if (loading) return;
    if (appliedSearch.current === locationSearch) return;
    appliedSearch.current = locationSearch;
    if (!locationSearch) {
      setDeepLinkNotice(null);
      setHighlightedLogId(null);
      setHighlightedScheduleKey(null);
      return;
    }
    const searchParams = new URLSearchParams(locationSearch);
    const tab = searchParams.get('tab');
    const assetId = searchParams.get('asset') || (searchParams.get('targetType') === 'home_asset' ? searchParams.get('targetId') : null);
    const vehicleId = searchParams.get('vehicle') || (searchParams.get('targetType') === 'vehicle' ? searchParams.get('targetId') : null);
    const logId = searchParams.get('log');
    const scheduleKey = searchParams.get('schedule');

    setDeepLinkNotice(null);
    setHighlightedLogId(null);
    setHighlightedScheduleKey(scheduleKey);

    if (assetId) {
      setActiveTab('assets');
      if (assets.some((asset) => asset.id === assetId)) {
        setSelectedAssetId(assetId);
        if (scheduleKey) requestAnimationFrame(() => document.getElementById(`maintenance-schedule-${stableSlugify(scheduleKey)}`)?.scrollIntoView({ block: 'center' }));
      } else {
        setDeepLinkNotice('The requested home asset is no longer available.');
      }
      return;
    }

    if (vehicleId) {
      setActiveTab('vehicles');
      if (vehicles.some((vehicle) => vehicle.id === vehicleId)) {
        setSelectedVehicleId(vehicleId);
        if (scheduleKey) requestAnimationFrame(() => document.getElementById(`maintenance-schedule-${stableSlugify(scheduleKey)}`)?.scrollIntoView({ block: 'center' }));
      } else {
        setDeepLinkNotice('The requested vehicle is no longer available.');
      }
      return;
    }

    if (logId) {
      setActiveTab('logs');
      if (logs.some((log) => log.id === logId)) {
        setHighlightedLogId(logId);
        requestAnimationFrame(() => document.getElementById(`maintenance-log-${logId}`)?.scrollIntoView({ block: 'center' }));
      } else {
        setDeepLinkNotice('The requested maintenance log is no longer available.');
      }
      return;
    }

    if (isMaintenanceTab(tab)) setActiveTab(tab);
  }, [assets, loading, locationSearch, logs, vehicles]);

  // Tabs are linkable (`/maintenance?tab=reminders`). Choosing a tab replaces the
  // URL so a refresh or Back keeps the tab, and drops any record link.
  const changeTab = (value: string) => {
    if (!isMaintenanceTab(value)) return;
    setActiveTab(value);
    const search = value === 'overview' ? '' : `?tab=${value}`;
    if (window.location.search !== search) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}`);
      appliedSearch.current = search;
      setLocationSearch(search);
      setDeepLinkNotice(null);
    }
  };

  // Same rules as the scheduled reminders, in the household's timezone. "Today"
  // is re-read whenever the data changes (every load and every save).
  const timeZone = safeTimeZone(household?.timeZone);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed with the data on purpose
  const today = useMemo(() => localDay(new Date(), timeZone), [timeZone, assets, vehicles, logs]);
  const reminders = useMemo(
    () => buildMaintenanceReminders(assets, vehicles, today, timeZone),
    [assets, vehicles, today, timeZone],
  );
  const health = useMemo(
    () => computeHomeHealth({ assets, vehicles, logs, today, timeZone }),
    [assets, vehicles, logs, today, timeZone],
  );
  const healthFor = (targetType: 'home_asset' | 'vehicle', id: string): HealthResult | undefined =>
    health.targets[healthKey(targetType, id)];

  const dueSoonReminders = useMemo(() => {
    return reminders.filter((reminder) => reminder.status === 'due_soon' || reminder.status === 'due_today');
  }, [reminders]);

  const overdueReminders = useMemo(() => {
    return reminders.filter((reminder) => reminder.status === 'overdue');
  }, [reminders]);

  const warrantyReminders = useMemo(() => {
    return reminders.filter((reminder) => reminder.group === 'warranty');
  }, [reminders]);

  const vehicleServiceReminders = useMemo(() => {
    return reminders.filter((reminder) => reminder.group === 'vehicle_service' || reminder.group === 'vehicle_document');
  }, [reminders]);

  const selectedAsset = useMemo(() => {
    return assets.find((asset) => asset.id === selectedAssetId) || assets[0] || null;
  }, [assets, selectedAssetId]);

  const activeVehicles = useMemo(() => {
    return vehicles.filter((vehicle) => vehicle.status !== 'retired' && vehicle.status !== 'sold');
  }, [vehicles]);

  const inactiveVehicles = useMemo(() => {
    return vehicles.filter((vehicle) => vehicle.status === 'retired' || vehicle.status === 'sold');
  }, [vehicles]);

  const selectedVehicle = useMemo(() => {
    return vehicles.find((vehicle) => vehicle.id === selectedVehicleId) || activeVehicles[0] || null;
  }, [activeVehicles, vehicles, selectedVehicleId]);

  const assetLogs = useMemo(() => {
    if (!selectedAsset) return [];
    return logs.filter((log) => getLogTargetType(log) === 'home_asset' && log.assetId === selectedAsset.id);
  }, [logs, selectedAsset]);

  const vehicleLogs = useMemo(() => {
    if (!selectedVehicle) return [];
    return logs.filter((log) => getLogTargetType(log) === 'vehicle' && log.vehicleId === selectedVehicle.id);
  }, [logs, selectedVehicle]);

  const openTarget = (target: { targetType: 'home_asset' | 'vehicle'; targetId: string; deepLink: string; scheduleKey?: string }) => {
    window.history.pushState({}, '', target.deepLink);
    const search = new URL(target.deepLink, window.location.origin).search;
    appliedSearch.current = search;
    setLocationSearch(search);
    setDeepLinkNotice(null);
    setHighlightedLogId(null);
    setHighlightedScheduleKey(target.scheduleKey || null);
    if (target.targetType === 'home_asset') {
      setSelectedAssetId(target.targetId);
      setActiveTab('assets');
    } else {
      setSelectedVehicleId(target.targetId);
      setActiveTab('vehicles');
    }
    if (target.scheduleKey) {
      const elementId = `maintenance-schedule-${stableSlugify(target.scheduleKey)}`;
      requestAnimationFrame(() => document.getElementById(elementId)?.scrollIntoView({ block: 'center' }));
    }
  };

  const openReminderTarget = (reminder: MaintenanceReminder) => openTarget(reminder);
  const openHealthDeduction = (deduction: HealthDeduction) => openTarget(deduction);

  // Maintenance reminder notifications are created by the server on a schedule
  // (functions/src/reminders.ts), not by whoever has this page open.

  const uploadAttachment = async (
    targetType: MaintenanceAttachmentTargetType,
    targetId: string,
    category: MaintenanceAttachmentCategory,
    file: File
  ) => {
    if (!currentUser?.householdId) return;
    const attachmentsCollection = getCollectionRef('maintenance-attachments');
    if (!attachmentsCollection) return;

    const attachmentId = `${Date.now()}-${createLocalId()}`;
    const safeFileName = sanitizeFileName(file.name);
    const filePath = `households/${currentUser.householdId}/maintenance/${targetType}/${targetId}/${attachmentId}-${safeFileName}`;
    const uploadTarget = `${targetType}:${targetId}`;

    setUploadingAttachmentTarget(uploadTarget);

    try {
      const storageRef = ref(getStorage(), filePath);
      await uploadBytes(storageRef, file, { contentType: file.type || undefined });
      const downloadUrl = await getDownloadURL(storageRef);
      const attachmentData: Omit<MaintenanceAttachment, 'id'> = {
        householdId: currentUser.householdId,
        targetType,
        targetId,
        category,
        fileName: file.name,
        filePath,
        downloadUrl,
        contentType: file.type || undefined,
        size: file.size,
        uploadedByUid: currentUser.uid,
        uploadedByName: currentUser.displayName || currentUser.email,
        createdAt: new Date().toISOString(),
      };

      await setDoc(doc(attachmentsCollection, attachmentId), cleanForFirestore(attachmentData));
      toast({ title: 'Attachment uploaded' });
      await refreshMaintenanceData();
    } catch (uploadError) {
      console.error('Error uploading maintenance attachment:', uploadError);
      toastError(uploadError, 'Upload failed');
    } finally {
      setUploadingAttachmentTarget(null);
    }
  };

  const deleteAttachment = async (attachment: MaintenanceAttachment) => {
    if (!currentUser?.householdId || deletingAttachmentId) return;
    const attachmentsCollection = getCollectionRef('maintenance-attachments');
    if (!attachmentsCollection) return;

    setDeletingAttachmentId(attachment.id);

    try {
      try {
        await deleteObject(ref(getStorage(), attachment.filePath));
      } catch (storageError) {
        const code = typeof storageError === 'object' && storageError && 'code' in storageError
          ? String((storageError as { code?: unknown }).code)
          : '';
        if (code !== 'storage/object-not-found') {
          throw storageError;
        }
      }

      await deleteDoc(doc(attachmentsCollection, attachment.id));
      setAttachmentToDelete(null);
      toast({ title: 'Attachment deleted' });
      await refreshMaintenanceData();
    } catch (deleteError) {
      console.error('Error deleting maintenance attachment:', deleteError);
      toastError(deleteError, 'Could not delete the attachment');
    } finally {
      setDeletingAttachmentId(null);
    }
  };

  const resolveMaintenanceNotifications = async (sourceType: string, sourceId: string, legacySourceId?: string) => {
    if (!currentUser?.householdId) return;
    const notificationsCollection = getCollectionRef('notifications');
    if (!notificationsCollection) return;

    const action = createNotificationAction(currentUser);
    const notificationSnap = await getDocs(notificationsCollection);
    const matchingNotifications = notificationSnap.docs.filter((notificationDoc) => {
      const data = notificationDoc.data();
      if (data.sourceType !== sourceType || data.resolvedAt) return false;
      if (data.sourceId === sourceId) return true;
      return legacySourceId
        ? (['due_soon', 'due_today', 'overdue'] as const).some((status) => data.sourceId === `${legacySourceId}:${status}`)
        : false;
    });

    await Promise.all(matchingNotifications.map(async (notificationDoc) => {
      await updateDoc(notificationDoc.ref, {
        resolvedAt: new Date(),
        resolvedBy: action,
      });
    }));
  };

  const summary = useMemo(() => {
    const recentCutoff = subDays(new Date(), 30);
    const recentLogs = logs.filter((log) => isAfter(parseLogDate(log.date), recentCutoff));
    const recentCost = recentLogs.reduce((total, log) => total + (typeof log.cost === 'number' ? log.cost : 0), 0);
    const needingAttention = assets.filter((asset) => asset.status === 'needs_attention').length +
      vehicles.filter((vehicle) => vehicle.status === 'needs_attention').length;

    return {
      recentLogs,
      recentCost,
      needingAttention,
    };
  }, [assets, logs, vehicles]);

  const openAssetDialog = (asset?: HomeAsset) => {
    setEditingAsset(asset || null);
    assetForm.reset(asset ? {
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
      status: asset.status,
      notes: asset.notes || '',
      scheduleName: '',
      frequencyType: undefined,
      intervalValue: '',
      lastCompletedDate: '',
      nextDueDate: '',
    } : emptyAssetForm);
    setAssetScheduleForms(asset?.schedules?.map(assetScheduleToForm) || []);
    setAssetScheduleErrors({});
    setAssetDialogOpen(true);
  };

  const openVehicleDialog = (vehicle?: Vehicle) => {
    setEditingVehicle(vehicle || null);
    vehicleForm.reset(vehicle ? {
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
    } : emptyVehicleForm);
    setVehicleScheduleForms(vehicle?.serviceSchedules?.map(vehicleScheduleToForm) || []);
    setVehicleScheduleErrors({});
    setVehicleDialogOpen(true);
  };

  const openLogDialog = (preset?: LogPreset, log?: MaintenanceLog) => {
    setEditingLog(log || null);
    logForm.reset(log ? {
      targetType: getLogTargetType(log),
      assetId: log.assetId || '',
      vehicleId: log.vehicleId || '',
      title: getLogTitle(log),
      date: dateInputValue(log.date),
      type: getLogType(log),
      notes: log.notes || '',
      cost: log.cost?.toString() || '',
      partsUsed: log.partsUsed || '',
      serviceProvider: log.serviceProvider || '',
      mileage: log.mileage?.toString() || '',
    } : emptyLogForm(preset));
    setLogDialogOpen(true);
  };

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
    if (scheduleToRemove.targetType === 'home_asset') removeAssetSchedule(scheduleToRemove.id);
    else removeVehicleSchedule(scheduleToRemove.id);
    setScheduleToRemove(null);
  };

  const getScheduleCompletionName = (target: ScheduleCompletionTarget) => {
    return target.targetType === 'home_asset'
      ? target.schedule.scheduleName || 'Scheduled maintenance'
      : target.schedule.serviceName || 'Scheduled maintenance';
  };

  const openScheduleCompletionDialog = (target: ScheduleCompletionTarget) => {
    const completedDate = todayInputValue();
    const completedMileage = target.targetType === 'vehicle'
      ? target.vehicle.currentMileage?.toString() || target.schedule.lastCompletedMileage?.toString() || ''
      : '';

    scheduleCompletionForm.reset({
      completedDate,
      mileage: completedMileage,
      nextDueDate: target.targetType === 'home_asset'
        ? calculateNextAssetDueDate(target.schedule, completedDate) || target.schedule.nextDueDate || ''
        : calculateNextVehicleDueDate(target.schedule, completedDate) || target.schedule.nextDueDate || '',
      nextDueMileage: target.targetType === 'vehicle'
        ? calculateNextVehicleMileage(target.schedule, toNumber(completedMileage))?.toString() || target.schedule.nextDueMileage?.toString() || ''
        : '',
      notes: '',
    });
    setScheduleCompletionTarget(target);
  };

  // Moves focus to the first schedule with a problem (its name field) on submit.
  const focusScheduleField = (kind: 'asset' | 'vehicle', scheduleId?: string) => {
    if (!scheduleId) return;
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-schedule-name="${kind}-${CSS.escape(scheduleId)}"]`)?.focus());
  };

  const saveAsset = async (values: AssetFormValues) => {
    if (!currentUser?.householdId) return;
    const assetsCollection = getCollectionRef('home-assets');
    if (!assetsCollection) return;

    const now = new Date().toISOString();
    const assetId = editingAsset?.id || slugify(values.name);
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
    const schedules = assetScheduleForms.reduce<HomeAssetSchedule[]>((nextSchedules, schedule) => {
      const scheduleName = trimOptional(schedule.scheduleName);
      if (!scheduleName) return nextSchedules;

      nextSchedules.push({
        id: schedule.id,
        mode: schedule.mode,
        scheduleName,
        frequencyType: schedule.frequencyType || undefined,
        intervalValue: toNumber(schedule.intervalValue),
        lastCompletedDate: trimOptional(schedule.lastCompletedDate),
        nextDueDate: trimOptional(schedule.nextDueDate),
      });
      return nextSchedules;
    }, []);
    const assetData: Omit<HomeAsset, 'id'> = {
      householdId: currentUser.householdId,
      name: values.name.trim(),
      category: values.category as HomeAssetCategory,
      location: trimOptional(values.location),
      brand: trimOptional(values.brand),
      model: trimOptional(values.model),
      serialNumber: trimOptional(values.serialNumber),
      purchaseDate: trimOptional(values.purchaseDate),
      purchasePrice: toNumber(values.purchasePrice),
      warrantyExpiration: trimOptional(values.warrantyExpiration),
      warrantyProvider: trimOptional(values.warrantyProvider),
      status: values.status,
      notes: trimOptional(values.notes),
      schedules,
      createdAt: editingAsset?.createdAt || now,
      updatedAt: now,
    };

    try {
      await setDoc(doc(assetsCollection, assetId), cleanForFirestore(assetData));
      setAssetDialogOpen(false);
      setSelectedAssetId(assetId);
      toast({ title: editingAsset ? 'Asset updated' : 'Asset added' });
      await refreshMaintenanceData();
    } catch (saveError) {
      console.error('Error saving asset:', saveError);
      toastError(saveError, 'Could not save the home asset');
    }
  };

  const saveVehicle = async (values: VehicleFormValues) => {
    if (!currentUser?.householdId) return;
    const vehiclesCollection = getCollectionRef('vehicles');
    if (!vehiclesCollection) return;

    const now = new Date().toISOString();
    const vehicleId = editingVehicle?.id || slugify(values.nickname);
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
    const serviceSchedules = vehicleScheduleForms.reduce<VehicleServiceSchedule[]>((schedules, schedule) => {
      const serviceName = trimOptional(schedule.serviceName);
      if (!serviceName) return schedules;

      schedules.push({
        id: schedule.id,
        mode: schedule.mode,
        serviceName,
        intervalMiles: toNumber(schedule.intervalMiles),
        intervalMonths: toNumber(schedule.intervalMonths),
        lastCompletedMileage: toNumber(schedule.lastCompletedMileage),
        lastCompletedDate: trimOptional(schedule.lastCompletedDate),
        nextDueMileage: toNumber(schedule.nextDueMileage),
        nextDueDate: trimOptional(schedule.nextDueDate),
      });
      return schedules;
    }, []);
    const vehicleData: Omit<Vehicle, 'id'> = {
      householdId: currentUser.householdId,
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
      serviceSchedules,
      createdAt: editingVehicle?.createdAt || now,
      updatedAt: now,
    };

    try {
      await setDoc(doc(vehiclesCollection, vehicleId), cleanForFirestore(vehicleData));
      setVehicleDialogOpen(false);
      setSelectedVehicleId(vehicleId);
      toast({ title: editingVehicle ? 'Vehicle updated' : 'Vehicle added' });
      await refreshMaintenanceData();
    } catch (saveError) {
      console.error('Error saving vehicle:', saveError);
      toastError(saveError, 'Could not save the vehicle');
    }
  };

  const saveLog = async (values: LogFormValues) => {
    if (!currentUser?.householdId) return;
    const logsCollection = getCollectionRef('maintenance');
    if (!logsCollection) return;

    // Field problems are shown under the field (FormMessage), never as a toast.
    if (values.targetType === 'home_asset' && !values.assetId) {
      logForm.setError('assetId', { message: 'Choose a home asset or switch the log to general.' }, { shouldFocus: true });
      return;
    }

    if (values.targetType === 'vehicle' && !values.vehicleId) {
      logForm.setError('vehicleId', { message: 'Choose a vehicle or switch the log to general.' }, { shouldFocus: true });
      return;
    }

    const now = new Date().toISOString();
    const logId = editingLog?.id || slugify(values.title);
    const logData: Omit<MaintenanceLog, 'id'> = {
      householdId: currentUser.householdId,
      targetType: values.targetType,
      assetId: values.targetType === 'home_asset' ? values.assetId : undefined,
      vehicleId: values.targetType === 'vehicle' ? values.vehicleId : undefined,
      title: values.title.trim(),
      item: values.title.trim(),
      date: values.date,
      type: values.type,
      notes: trimOptional(values.notes),
      cost: toNumber(values.cost),
      partsUsed: trimOptional(values.partsUsed),
      serviceProvider: trimOptional(values.serviceProvider),
      mileage: values.targetType === 'vehicle' ? toNumber(values.mileage) : undefined,
      createdAt: editingLog?.createdAt || now,
      updatedAt: now,
      summary: editingLog?.summary,
      receiptUrl: editingLog?.receiptUrl,
    };

    try {
      await setDoc(doc(logsCollection, logId), cleanForFirestore(logData));
      setLogDialogOpen(false);
      setEditingLog(null);
      toast({ title: editingLog ? 'Maintenance log updated' : 'Maintenance log added' });
      await refreshMaintenanceData();
    } catch (saveError) {
      console.error('Error saving maintenance log:', saveError);
      toastError(saveError, 'Could not save the maintenance log');
    }
  };

  const scheduleSourceFor = (target: ScheduleCompletionTarget) => {
    const ownerId = target.targetType === 'home_asset' ? target.asset.id : target.vehicle.id;
    return {
      sourceType: target.targetType === 'home_asset' ? 'maintenance_asset_schedule' : 'maintenance_vehicle_service',
      sourceId: scheduleKeyFor(ownerId, target.schedule, target.scheduleIndex, target.targetType),
      legacySourceId: `${ownerId}-${target.scheduleIndex}`,
    };
  };

  /**
   * Records a completion: a routine log, the advanced schedule, and the current
   * reminder cycle resolved (the server then creates the next cycle's reminder
   * when it comes due). Shared by the completion dialog and one-tap Mark done.
   */
  const applyScheduleCompletion = async (
    target: ScheduleCompletionTarget,
    values: { completedDate: string; mileage?: number; nextDueDate?: string; nextDueMileage?: number; notes?: string },
  ) => {
    const householdId = currentUser?.householdId;
    const logsCollection = getCollectionRef('maintenance');
    const assetsCollection = getCollectionRef('home-assets');
    const vehiclesCollection = getCollectionRef('vehicles');
    if (!householdId || !logsCollection || !assetsCollection || !vehiclesCollection) return false;

    const now = new Date().toISOString();
    const scheduleName = getScheduleCompletionName(target);
    const logId = `${slugify(`${scheduleName}-${values.completedDate}`)}-${Date.now()}`;
    const logData: Omit<MaintenanceLog, 'id'> = {
      householdId,
      targetType: target.targetType,
      assetId: target.targetType === 'home_asset' ? target.asset.id : undefined,
      vehicleId: target.targetType === 'vehicle' ? target.vehicle.id : undefined,
      title: scheduleName,
      item: scheduleName,
      date: values.completedDate,
      type: 'routine',
      notes: trimOptional(values.notes),
      mileage: target.targetType === 'vehicle' ? values.mileage : undefined,
      createdAt: now,
      updatedAt: now,
    };
    const source = scheduleSourceFor(target);

    if (target.targetType === 'home_asset') {
      const { asset, scheduleIndex, schedule } = target;
      const { id, ...assetFields } = asset;
      const schedules = [...(asset.schedules || [])];
      schedules[scheduleIndex] = completedAssetSchedule(schedule, values);
      await Promise.all([
        setDoc(doc(logsCollection, logId), cleanForFirestore(logData)),
        setDoc(doc(assetsCollection, id), cleanForFirestore({
          ...assetFields,
          householdId,
          schedules,
          updatedAt: now,
        })),
        resolveMaintenanceNotifications(source.sourceType, source.sourceId, source.legacySourceId),
      ]);
    } else {
      const { vehicle, scheduleIndex, schedule } = target;
      const { id, ...vehicleFields } = vehicle;
      const schedules = [...(vehicle.serviceSchedules || [])];
      schedules[scheduleIndex] = completedVehicleSchedule(schedule, values);
      await Promise.all([
        setDoc(doc(logsCollection, logId), cleanForFirestore(logData)),
        setDoc(doc(vehiclesCollection, id), cleanForFirestore({
          ...vehicleFields,
          householdId,
          currentMileage: typeof values.mileage === 'number' ? values.mileage : vehicle.currentMileage,
          serviceSchedules: schedules,
          updatedAt: now,
        })),
        resolveMaintenanceNotifications(source.sourceType, source.sourceId, source.legacySourceId),
      ]);
    }
    return true;
  };

  const completeScheduledMaintenance = async (values: ScheduleCompletionFormValues) => {
    if (!scheduleCompletionTarget) return;
    const target = scheduleCompletionTarget;
    try {
      const done = await applyScheduleCompletion(target, {
        completedDate: values.completedDate,
        mileage: target.targetType === 'vehicle' ? toNumber(values.mileage) : undefined,
        nextDueDate: trimOptional(values.nextDueDate),
        nextDueMileage: toNumber(values.nextDueMileage),
        notes: values.notes,
      });
      if (!done) return;
      if (target.targetType === 'home_asset') setSelectedAssetId(target.asset.id);
      else setSelectedVehicleId(target.vehicle.id);
      setScheduleCompletionTarget(null);
      scheduleCompletionForm.reset(emptyScheduleCompletionForm());
      playFeedback('complete');
      toast({ title: 'Scheduled maintenance completed' });
      await refreshMaintenanceData();
    } catch (saveError) {
      console.error('Error completing scheduled maintenance:', saveError);
      toastError(saveError, 'Could not complete maintenance');
    }
  };

  /**
   * One-tap Mark done from a reminder card. When the next due date or mileage
   * cannot be worked out (no interval, or no recorded mileage), the completion
   * dialog opens instead so nothing is guessed.
   */
  const markReminderDone = async (reminder: MaintenanceReminder) => {
    if (reminderBusy || !canComplete) return;
    const target = findReminderSchedule(reminder, assets, vehicles);
    if (!target) {
      openReminderTarget(reminder);
      return;
    }
    const values = quickCompletionValues(target, today);
    if (!values) {
      openScheduleCompletionDialog(target);
      return;
    }
    setReminderBusy({ id: reminder.id, action: 'done' });
    try {
      const done = await applyScheduleCompletion(target, values);
      if (!done) return;
      playFeedback('complete');
      toast({
        title: 'Marked done',
        description: `${reminder.title} for ${reminder.relatedName} is logged.${values.nextDueDate ? ` Next due ${formatDate(values.nextDueDate)}.` : ''}`,
      });
      await refreshMaintenanceData();
    } catch (saveError) {
      console.error('Error completing maintenance from a reminder:', saveError);
      toastError(saveError, 'Could not mark it done');
    } finally {
      setReminderBusy(null);
    }
  };

  /**
   * Snooze moves the schedule's next due date a week past the later of today and
   * the current due date. It is an ordinary schedule edit (maintenance.edit), so
   * the hourly server job and every device see the new date; the current
   * reminder cycle is resolved like a completion.
   */
  const snoozeReminder = async (reminder: MaintenanceReminder) => {
    if (reminderBusy || !canEdit) return;
    const target = findReminderSchedule(reminder, assets, vehicles);
    const assetsCollection = getCollectionRef('home-assets');
    const vehiclesCollection = getCollectionRef('vehicles');
    if (!target || !assetsCollection || !vehiclesCollection) return;
    const nextDueDate = snoozedDueDate(target.schedule.nextDueDate, today);
    const now = new Date().toISOString();
    setReminderBusy({ id: reminder.id, action: 'snooze' });
    try {
      if (target.targetType === 'home_asset') {
        const schedules = [...(target.asset.schedules || [])];
        schedules[target.scheduleIndex] = { ...target.schedule, nextDueDate };
        await updateDoc(doc(assetsCollection, target.asset.id), cleanForFirestore({ schedules, updatedAt: now }));
      } else {
        const serviceSchedules = [...(target.vehicle.serviceSchedules || [])];
        serviceSchedules[target.scheduleIndex] = { ...target.schedule, nextDueDate };
        await updateDoc(doc(vehiclesCollection, target.vehicle.id), cleanForFirestore({ serviceSchedules, updatedAt: now }));
      }
      const source = scheduleSourceFor(target);
      // Best effort: the schedule change is what matters, and the new due date
      // has its own reminder identity anyway.
      await resolveMaintenanceNotifications(source.sourceType, source.sourceId, source.legacySourceId)
        .catch((resolveError) => console.error('Could not resolve snoozed reminder notifications:', resolveError));
      toast({ title: 'Snoozed for a week', description: `${reminder.title} for ${reminder.relatedName} is now due ${formatDate(nextDueDate)}.` });
      await refreshMaintenanceData();
    } catch (snoozeError) {
      console.error('Error snoozing maintenance reminder:', snoozeError);
      toastError(snoozeError, 'Could not snooze');
    } finally {
      setReminderBusy(null);
    }
  };

  const deleteLog = async () => {
    if (!logToDelete || deletingRecord) return;
    const logsCollection = getCollectionRef('maintenance');
    if (!logsCollection) return;

    if (getAttachmentsForTarget(attachments, 'maintenance_log', logToDelete.id).length > 0) {
      toast({
        variant: 'destructive',
        title: 'Remove attachments first',
        description: 'Delete attachments for this log before deleting it.',
      });
      return;
    }

    setDeletingRecord(`log:${logToDelete.id}`);
    try {
      await deleteDoc(doc(logsCollection, logToDelete.id));
      setSummaries(prev => {
        const next = { ...prev };
        delete next[logToDelete.id];
        return next;
      });
      setLogToDelete(null);
      toast({ title: 'Maintenance log deleted' });
      await refreshMaintenanceData();
    } catch (deleteError) {
      console.error('Error deleting maintenance log:', deleteError);
      toastError(deleteError, 'Could not delete the maintenance log');
    } finally {
      setDeletingRecord(null);
    }
  };

  const notificationBelongsToRegistryRecord = (
    notification: Notification,
    targetType: 'home_asset' | 'vehicle',
    targetId: string
  ) => {
    const sourceTypes = targetType === 'home_asset'
      ? ['maintenance_asset_schedule', 'maintenance_asset_warranty']
      : ['maintenance_vehicle_service', 'maintenance_vehicle_registration', 'maintenance_vehicle_inspection'];
    return Boolean(
      notification.sourceType
      && sourceTypes.includes(notification.sourceType)
      && (notification.sourceId === targetId || notification.sourceId?.startsWith(`${targetId}:`))
    );
  };

  const deleteRegistryRecord = async (
    targetType: 'home_asset' | 'vehicle',
    target: HomeAsset | Vehicle
  ) => {
    if (!currentUser?.householdId || deletingRecord) return;
    const registryCollection = getCollectionRef(targetType === 'home_asset' ? 'home-assets' : 'vehicles');
    const logsCollection = getCollectionRef('maintenance');
    const notificationsCollection = getCollectionRef('notifications');
    if (!registryCollection || !logsCollection || !notificationsCollection) return;

    const directAttachments = getAttachmentsForTarget(attachments, targetType, target.id);
    if (directAttachments.length > 0) {
      toast({
        variant: 'destructive',
        title: 'Remove attachments first',
        description: `Delete ${directAttachments.length === 1 ? 'the attachment' : 'all attachments'} for this ${targetType === 'home_asset' ? 'asset' : 'vehicle'} before deleting it.`,
      });
      return;
    }

    setDeletingRecord(`${targetType}:${target.id}`);
    try {
      const [logsSnapshot, notificationsSnapshot] = await Promise.all([
        getDocs(logsCollection),
        getDocs(notificationsCollection),
      ]);
      const targetName = targetType === 'home_asset' ? (target as HomeAsset).name : (target as Vehicle).nickname;
      const linkedLogs = logsSnapshot.docs
        .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() } as MaintenanceLog))
        .filter((log) => targetType === 'home_asset'
          ? getLogTargetType(log) === 'home_asset' && log.assetId === target.id
          : getLogTargetType(log) === 'vehicle' && log.vehicleId === target.id);
      const relatedNotifications = notificationsSnapshot.docs
        .map(parseNotificationDoc)
        .filter((notification) => !notification.resolvedAt && notificationBelongsToRegistryRecord(notification, targetType, target.id));
      const action = createNotificationAction(currentUser);
      const now = new Date();
      const batch = writeBatch(db);

      batch.delete(doc(registryCollection, target.id));
      linkedLogs.forEach((log) => {
        batch.update(doc(logsCollection, log.id), {
          targetType: 'general',
          ...(targetType === 'home_asset' ? { assetId: deleteField() } : { vehicleId: deleteField() }),
          formerTargetType: targetType,
          formerTargetName: targetName,
          updatedAt: now.toISOString(),
        });
      });
      relatedNotifications.forEach((notification) => {
        batch.update(doc(notificationsCollection, notification.id), { resolvedAt: now, resolvedBy: action });
      });

      await batch.commit();
      if (targetType === 'home_asset') {
        setSelectedAssetId(previous => previous === target.id ? null : previous);
        setAssetToDelete(null);
      } else {
        setSelectedVehicleId(previous => previous === target.id ? null : previous);
        setVehicleToDelete(null);
      }
      toast({
        title: `${targetType === 'home_asset' ? 'Home asset' : 'Vehicle'} deleted`,
        description: linkedLogs.length > 0
          ? `${linkedLogs.length} historical ${linkedLogs.length === 1 ? 'log was' : 'logs were'} preserved as general maintenance.`
          : undefined,
      });
      await refreshMaintenanceData();
    } catch (deleteError) {
      console.error(`Error deleting ${targetType}:`, deleteError);
      toastError(deleteError, `Could not delete the ${targetType === 'home_asset' ? 'home asset' : 'vehicle'}`);
    } finally {
      setDeletingRecord(null);
    }
  };

  const deleteAsset = async () => {
    if (assetToDelete) await deleteRegistryRecord('home_asset', assetToDelete);
  };

  const deleteVehicle = async () => {
    if (vehicleToDelete) await deleteRegistryRecord('vehicle', vehicleToDelete);
  };

  const handleSummarize = async (log: MaintenanceLog) => {
    const householdId = currentUser?.householdId;
    if (!log.notes || !householdId) return;

    setLoadingSummaries(prev => ({ ...prev, [log.id]: true }));
    try {
      const result = unwrapAiActionResult(await summarizeMaintenanceLog(
        { log: log.notes },
        await getAiActionContext(householdId)
      ));
      setSummaries(prev => ({ ...prev, [log.id]: result.summary }));
    } catch (summaryError) {
      console.error('Maintenance summary failed', summaryError instanceof Error ? summaryError.message : 'unknown');
      // AI errors carry messages already written for people by the AI module;
      // anything else goes through friendlyError.
      if (summaryError instanceof AiClientError) {
        toast({ variant: 'destructive', title: 'Summary unavailable', description: summaryError.message });
      } else {
        toastError(summaryError, 'Summary unavailable');
      }
    } finally {
      setLoadingSummaries(prev => ({ ...prev, [log.id]: false }));
    }
  };

  if (!currentUser) {
    return <p className="py-8 text-center">Please log in to manage maintenance.</p>;
  }

  if (accessDenied) {
    return (
      <Card>
        <CardContent className="p-6">
          <EmptyState
            kind="assets"
            title="Maintenance isn't shared with you"
            description="Ask a household owner or admin for access to the Maintenance Center."
          />
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <Card key={item}>
              <CardHeader><Skeleton className="h-4 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-16" /></CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="space-y-3 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="font-medium">{error}</p>
          <Button onClick={() => fetchMaintenanceData()}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  const logListProps = {
    assets,
    vehicles,
    attachments,
    summaries,
    loadingSummaries,
    uploadingAttachmentTarget,
    deletingAttachmentId,
    canEdit,
    canDelete,
    onSummarize: handleSummarize,
    onEdit: (log: MaintenanceLog) => openLogDialog(undefined, log),
    onDelete: setLogToDelete,
    onUploadAttachment: uploadAttachment,
    onDeleteAttachment: setAttachmentToDelete,
  };

  const reminderListProps = {
    today,
    canComplete,
    canSnooze: canEdit,
    busy: reminderBusy,
    onOpen: openReminderTarget,
    onMarkDone: (reminder: MaintenanceReminder) => void markReminderDone(reminder),
    onSnooze: (reminder: MaintenanceReminder) => void snoozeReminder(reminder),
  };

  const flaggedAssets = assets.filter((asset) => asset.status === 'needs_attention');
  const flaggedVehicles = vehicles.filter((vehicle) => vehicle.status === 'needs_attention');

  const assetFields = (asset: HomeAsset) => [
    { label: 'Status', value: humanizeLabel(asset.status) },
    { label: 'Location', value: asset.location },
    { label: 'Brand', value: asset.brand },
    { label: 'Model', value: asset.model },
    { label: 'Serial Number', value: asset.serialNumber },
    { label: 'Purchase Price', value: optionalCurrency(asset.purchasePrice) },
    { label: 'Purchase Date', value: optionalDate(asset.purchaseDate) },
    { label: 'Warranty Ends', value: optionalDate(asset.warrantyExpiration) },
    { label: 'Warranty Provider', value: asset.warrantyProvider },
  ];

  const vehicleFields = (vehicle: Vehicle) => [
    { label: 'Status', value: humanizeLabel(vehicle.status) },
    { label: 'Mileage', value: typeof vehicle.currentMileage === 'number' ? vehicle.currentMileage.toLocaleString() : undefined },
    { label: 'VIN', value: vehicle.vin },
    { label: 'License Plate', value: vehicle.licensePlate },
    { label: 'Insurance', value: vehicle.insuranceProvider },
    { label: 'Purchase Price', value: optionalCurrency(vehicle.purchasePrice) },
    { label: 'Purchase Date', value: optionalDate(vehicle.purchaseDate) },
    { label: 'Registration Expires', value: optionalDate(vehicle.registrationExpiration) },
    { label: 'Inspection Expires', value: optionalDate(vehicle.inspectionExpiration) },
  ];

  const missingCount = (fields: Array<{ label: string; value?: string | number | null }>) => fields.length - presentFields(fields).length;

  /** One action row for a detail panel (D15): Edit and Add details on the left, Delete apart on the right. */
  const detailActions = ({
    name,
    kind,
    missing,
    onEdit,
    onDelete,
  }: {
    name: string;
    kind: 'home asset' | 'vehicle';
    missing: number;
    onEdit: () => void;
    onDelete: () => void;
  }) => (canEdit || canDelete) && (
    <div className="flex flex-wrap items-center gap-2 border-t pt-4">
      {canEdit && (
        <Button aria-label={`Edit ${kind} ${name}`} variant="outline" size="sm" onClick={onEdit}>
          <Edit className="mr-2 h-4 w-4" />
          Edit
        </Button>
      )}
      {canEdit && missing > 0 && (
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <PencilLine className="mr-2 h-4 w-4" />
          Add details
          <span className="ml-1 text-muted-foreground">({missing} empty)</span>
        </Button>
      )}
      {canDelete && (
        <Button
          aria-label={`Delete ${kind} ${name}`}
          variant="ghost"
          size="sm"
          className="ml-auto text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
      )}
    </div>
  );

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-headline text-3xl font-bold tracking-tight">Maintenance Center</h1>
            <p className="text-muted-foreground">Track home assets, vehicles, service history, and repair notes.</p>
          </div>
          {canCreateLogs && (
            <Button onClick={() => openLogDialog()}>
              <Plus className="mr-2 h-4 w-4" />
              Add Log
            </Button>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={changeTab} className="w-full">
          <TabsList className="grid h-auto w-full grid-cols-2 md:grid-cols-5">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="assets">Home Assets</TabsTrigger>
            <TabsTrigger value="vehicles">Vehicles</TabsTrigger>
            <TabsTrigger value="reminders">Reminders</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>

          {deepLinkNotice && (
            <div role="status" className="mt-4 flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
              {deepLinkNotice}
            </div>
          )}

          <TabsContent value="overview" className="space-y-6 pt-4">
            {health.overall && <HealthPanel health={health.overall} onOpen={openHealthDeduction} />}
            {assets.length === 0 && vehicles.length === 0 && (
              <Card>
                <CardContent className="p-6">
                  <EmptyState
                    kind="assets"
                    title="Start your home registry"
                    description="Add the furnace, the fridge or the family car, and HomeHub keeps track of when each needs care."
                    action={canEdit ? { label: 'Add home asset', icon: <Plus className="h-4 w-4" />, onClick: () => { changeTab('assets'); openAssetDialog(); } } : undefined}
                    secondaryAction={canEdit ? { label: 'Add vehicle', icon: <Car className="h-4 w-4" />, onClick: () => { changeTab('vehicles'); openVehicleDialog(); } } : undefined}
                  />
                </CardContent>
              </Card>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <SummaryCard title="Home Assets" value={assets.length.toString()} detail="Registered household assets" icon={Home} />
              <SummaryCard title="Vehicles" value={vehicles.length.toString()} detail="Registered vehicles" icon={Car} />
              <SummaryCard title="Logged, Last 30 Days" value={summary.recentLogs.length.toString()} detail="Logs dated in the last 30 days" icon={ClipboardList} />
              <SummaryCard title="Needs Attention" value={summary.needingAttention.toString()} detail="Assets or vehicles flagged" icon={AlertCircle} />
              <SummaryCard title="Spent, Last 30 Days" value={formatCurrency(summary.recentCost)} detail="Costs on logs from the last 30 days" icon={DollarSign} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="font-headline">Latest Logs</CardTitle>
                  <CardDescription>The five most recent entries, whatever their date.</CardDescription>
                </CardHeader>
                <CardContent>
                  <LogList {...logListProps} logs={logs.slice(0, 5)} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="font-headline">Attention Queue</CardTitle>
                  <CardDescription>Items currently marked as needing attention.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {flaggedAssets.length + flaggedVehicles.length === 0 ? (
                    <EmptyState compact headingLevel={3} title="Nothing flagged" description="Mark assets or vehicles as needing attention when they need follow-up." />
                  ) : (
                    <>
                      {flaggedAssets.map(asset => (
                        <button
                          key={asset.id}
                          type="button"
                          className="w-full rounded-lg border p-3 text-left transition-ui hover:bg-accent"
                          onClick={() => openTarget({ targetType: 'home_asset', targetId: asset.id, deepLink: `/maintenance?asset=${encodeURIComponent(asset.id)}` })}
                        >
                          <p className="font-medium">{asset.name}</p>
                          <p className="text-sm text-muted-foreground">{[asset.category, asset.location].filter(Boolean).join(' · ')}</p>
                        </button>
                      ))}
                      {flaggedVehicles.map(vehicle => (
                        <button
                          key={vehicle.id}
                          type="button"
                          className="w-full rounded-lg border p-3 text-left transition-ui hover:bg-accent"
                          onClick={() => openTarget({ targetType: 'vehicle', targetId: vehicle.id, deepLink: `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}` })}
                        >
                          <p className="font-medium">{vehicle.nickname}</p>
                          <p className="text-sm text-muted-foreground">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</p>
                        </button>
                      ))}
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="assets" className="space-y-4 pt-4">
            {canEdit && assets.length > 0 && (
              <div className="flex justify-end">
                <Button onClick={() => openAssetDialog()}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Home Asset
                </Button>
              </div>
            )}

            {assets.length === 0 ? (
              <EmptyState
                kind="assets"
                title="No home assets yet"
                description="Add HVAC, appliances, tools and other things you look after to build your registry."
                action={canEdit ? { label: 'Add Home Asset', icon: <Plus className="h-4 w-4" />, onClick: () => openAssetDialog() } : undefined}
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
                {/* content-start: cards keep their own height instead of stretching to the detail panel (B7). */}
                <div className="grid content-start gap-3 sm:grid-cols-2">
                  {assets.map((asset) => (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      photo={pickAssetPhoto(attachments, asset.id)}
                      health={healthFor('home_asset', asset.id)}
                      selected={selectedAsset?.id === asset.id}
                      onSelect={() => setSelectedAssetId(asset.id)}
                    />
                  ))}
                </div>

                {selectedAsset && (
                  <Card className="min-w-0">
                    <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                      <div className="min-w-0">
                        <CardTitle className="font-headline">{selectedAsset.name}</CardTitle>
                        <CardDescription>{selectedAsset.category}</CardDescription>
                      </div>
                      {healthFor('home_asset', selectedAsset.id) && (
                        <HealthRing
                          score={healthFor('home_asset', selectedAsset.id)!.score}
                          band={healthFor('home_asset', selectedAsset.id)!.band}
                          label={`${selectedAsset.name} health`}
                        />
                      )}
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <DetailGrid fields={assetFields(selectedAsset)} />
                      {selectedAsset.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{selectedAsset.notes}</p>}
                      {detailActions({
                        name: selectedAsset.name,
                        kind: 'home asset',
                        missing: missingCount(assetFields(selectedAsset)),
                        onEdit: () => openAssetDialog(selectedAsset),
                        onDelete: () => setAssetToDelete(selectedAsset),
                      })}
                      <AttachmentPanel
                        attachments={getAttachmentsForTarget(attachments, 'home_asset', selectedAsset.id)}
                        targetType="home_asset"
                        targetId={selectedAsset.id}
                        uploading={uploadingAttachmentTarget === `home_asset:${selectedAsset.id}`}
                        deletingId={deletingAttachmentId}
                        canUpload={canEdit}
                        canDelete={canDelete}
                        onUpload={uploadAttachment}
                        onDelete={setAttachmentToDelete}
                      />
                      {selectedAsset.schedules && selectedAsset.schedules.length > 0 && (
                        <div className="space-y-2">
                          <h3 className="font-headline font-semibold">Scheduled Maintenance</h3>
                          {selectedAsset.schedules.map((schedule, index) => {
                            const key = scheduleKeyFor(selectedAsset.id, schedule, index, 'home_asset');
                            return (
                              <div
                                key={`${schedule.scheduleName}-${index}`}
                                id={`maintenance-schedule-${stableSlugify(key)}`}
                                data-testid={`asset-schedule-${schedule.id || index}`}
                                className={cn('rounded-lg border p-3', highlightedScheduleKey === key && 'ring-2 ring-primary')}
                              >
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                  <div>
                                    <p className="text-sm font-medium">{schedule.scheduleName || 'Scheduled maintenance'}</p>
                                    {getAssetScheduleMode(schedule) === 'checklist' ? (
                                      <p className="text-sm text-muted-foreground">Unscheduled checklist item</p>
                                    ) : (
                                      <>
                                        <p className="text-sm text-muted-foreground">
                                          {schedule.nextDueDate ? `Next due ${formatDate(schedule.nextDueDate)}` : 'Next date will be set when completed'}
                                        </p>
                                        {schedule.frequencyType && schedule.intervalValue && (
                                          <p className="text-xs text-muted-foreground">
                                            Every {schedule.intervalValue} {schedule.frequencyType}
                                          </p>
                                        )}
                                      </>
                                    )}
                                  </div>
                                  {canComplete && getAssetScheduleMode(schedule) === 'scheduled' && <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => openScheduleCompletionDialog({
                                      targetType: 'home_asset',
                                      asset: selectedAsset,
                                      scheduleIndex: index,
                                      schedule,
                                    })}
                                  >
                                    Complete
                                  </Button>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div className="flex justify-between gap-2">
                        <h3 className="font-headline font-semibold">Linked Logs</h3>
                        {canCreateLogs && (
                          <Button variant="outline" size="sm" onClick={() => openLogDialog({ targetType: 'home_asset', assetId: selectedAsset.id })}>
                            Add Log
                          </Button>
                        )}
                      </div>
                      <LogList
                        {...logListProps}
                        logs={assetLogs}
                        emptyTitle="No logs for this asset"
                        emptyDescription="Repairs, service and inspections for it will show up here."
                      />
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="vehicles" className="space-y-4 pt-4">
            {canEdit && vehicles.length > 0 && (
              <div className="flex justify-end">
                <Button onClick={() => openVehicleDialog()}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Vehicle
                </Button>
              </div>
            )}

            {vehicles.length === 0 ? (
              <EmptyState
                kind="assets"
                title="No vehicles yet"
                description="Add household vehicles to track mileage, key dates and service."
                action={canEdit ? { label: 'Add Vehicle', icon: <Plus className="h-4 w-4" />, onClick: () => openVehicleDialog() } : undefined}
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
                <div className="space-y-4">
                  {activeVehicles.length > 0 ? (
                    <div className="grid content-start gap-3 sm:grid-cols-2">
                      {activeVehicles.map((vehicle) => {
                        const vehicleHealth = healthFor('vehicle', vehicle.id);
                        return (
                          <button
                            key={vehicle.id}
                            type="button"
                            onClick={() => setSelectedVehicleId(vehicle.id)}
                            aria-current={selectedVehicle?.id === vehicle.id ? 'true' : undefined}
                            className={cn(
                              'glow-card rounded-lg border bg-card p-4 text-left shadow-raised transition-ui hover:bg-accent',
                              selectedVehicle?.id === vehicle.id && 'border-primary'
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-headline font-semibold">{vehicle.nickname}</p>
                                <p className="text-sm text-muted-foreground">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</p>
                              </div>
                              {vehicleHealth && <HealthRing score={vehicleHealth.score} band={vehicleHealth.band} label={`${vehicle.nickname} health`} />}
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                              <span>{typeof vehicle.currentMileage === 'number' ? `${vehicle.currentMileage.toLocaleString()} miles` : 'Mileage not recorded'}</span>
                              {vehicle.status === 'needs_attention' && <Badge variant="destructive">Needs attention</Badge>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState compact headingLevel={3} title="No active vehicles" description="Sold and retired vehicles are kept out of the main vehicle list." />
                  )}

                  {inactiveVehicles.length > 0 && (
                    <div className="rounded-lg border p-3">
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full justify-between px-2"
                        aria-expanded={showInactiveVehicles}
                        onClick={() => setShowInactiveVehicles(prev => !prev)}
                      >
                        <span>Sold / retired vehicles ({inactiveVehicles.length})</span>
                        <span className="text-xs text-muted-foreground">{showInactiveVehicles ? 'Hide' : 'Show'}</span>
                      </Button>
                      {showInactiveVehicles && (
                        <div className="mt-3 grid content-start gap-3 sm:grid-cols-2">
                          {inactiveVehicles.map((vehicle) => (
                            <button
                              key={vehicle.id}
                              type="button"
                              onClick={() => setSelectedVehicleId(vehicle.id)}
                              aria-current={selectedVehicle?.id === vehicle.id ? 'true' : undefined}
                              className={cn(
                                'glow-card rounded-lg border bg-muted/30 p-4 text-left transition-ui hover:bg-accent',
                                selectedVehicle?.id === vehicle.id && 'border-primary'
                              )}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className="font-headline font-semibold">{vehicle.nickname}</p>
                                  <p className="text-sm text-muted-foreground">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</p>
                                </div>
                                <Badge variant="outline">{humanizeLabel(vehicle.status)}</Badge>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {selectedVehicle && (
                  <Card className="min-w-0">
                    <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                      <div className="min-w-0">
                        <CardTitle className="font-headline">{selectedVehicle.nickname}</CardTitle>
                        <CardDescription>{[selectedVehicle.year, selectedVehicle.make, selectedVehicle.model, selectedVehicle.trim].filter(Boolean).join(' ') || 'Vehicle details'}</CardDescription>
                      </div>
                      {healthFor('vehicle', selectedVehicle.id) && (
                        <HealthRing
                          score={healthFor('vehicle', selectedVehicle.id)!.score}
                          band={healthFor('vehicle', selectedVehicle.id)!.band}
                          label={`${selectedVehicle.nickname} health`}
                        />
                      )}
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <DetailGrid fields={vehicleFields(selectedVehicle)} />
                      {selectedVehicle.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{selectedVehicle.notes}</p>}
                      {detailActions({
                        name: selectedVehicle.nickname,
                        kind: 'vehicle',
                        missing: missingCount(vehicleFields(selectedVehicle)),
                        onEdit: () => openVehicleDialog(selectedVehicle),
                        onDelete: () => setVehicleToDelete(selectedVehicle),
                      })}
                      <AttachmentPanel
                        attachments={getAttachmentsForTarget(attachments, 'vehicle', selectedVehicle.id)}
                        targetType="vehicle"
                        targetId={selectedVehicle.id}
                        uploading={uploadingAttachmentTarget === `vehicle:${selectedVehicle.id}`}
                        deletingId={deletingAttachmentId}
                        canUpload={canEdit}
                        canDelete={canDelete}
                        onUpload={uploadAttachment}
                        onDelete={setAttachmentToDelete}
                      />
                      {selectedVehicle.serviceSchedules && selectedVehicle.serviceSchedules.length > 0 && (
                        <div className="space-y-2">
                          <h3 className="font-headline font-semibold">Scheduled Maintenance</h3>
                          {selectedVehicle.serviceSchedules.map((schedule, index) => {
                            const key = scheduleKeyFor(selectedVehicle.id, schedule, index, 'vehicle');
                            return (
                              <div
                                key={`${schedule.serviceName}-${index}`}
                                id={`maintenance-schedule-${stableSlugify(key)}`}
                                data-testid={`vehicle-schedule-${schedule.id || index}`}
                                className={cn('rounded-lg border p-3', highlightedScheduleKey === key && 'ring-2 ring-primary')}
                              >
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                  <div>
                                    <p className="text-sm font-medium">{schedule.serviceName || 'Scheduled maintenance'}</p>
                                    {getVehicleScheduleMode(schedule) === 'checklist' ? (
                                      <p className="text-sm text-muted-foreground">Unscheduled checklist item</p>
                                    ) : (
                                      <>
                                        <p className="text-sm text-muted-foreground">
                                          {schedule.nextDueDate ? `Next due ${formatDate(schedule.nextDueDate)}` : 'No next date set'}
                                          {typeof schedule.nextDueMileage === 'number' ? `${schedule.nextDueDate ? ' or ' : 'Next due '}${schedule.nextDueMileage.toLocaleString()} miles` : ''}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                          {schedule.intervalMiles ? `Every ${schedule.intervalMiles.toLocaleString()} miles` : ''}
                                          {schedule.intervalMiles && schedule.intervalMonths ? ' / ' : ''}
                                          {schedule.intervalMonths ? `Every ${schedule.intervalMonths} months` : ''}
                                        </p>
                                      </>
                                    )}
                                  </div>
                                  {canComplete && getVehicleScheduleMode(schedule) === 'scheduled' && <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => openScheduleCompletionDialog({
                                      targetType: 'vehicle',
                                      vehicle: selectedVehicle,
                                      scheduleIndex: index,
                                      schedule,
                                    })}
                                  >
                                    Complete
                                  </Button>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div className="flex justify-between gap-2">
                        <h3 className="font-headline font-semibold">Service Logs</h3>
                        {canCreateLogs && (
                          <Button variant="outline" size="sm" onClick={() => openLogDialog({ targetType: 'vehicle', vehicleId: selectedVehicle.id })}>
                            Add Log
                          </Button>
                        )}
                      </div>
                      <LogList
                        {...logListProps}
                        logs={vehicleLogs}
                        emptyTitle="No service logs yet"
                        emptyDescription="Oil changes, repairs and inspections for this vehicle will show up here."
                      />
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="reminders" className="space-y-4 pt-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard title="Due Soon" value={dueSoonReminders.length.toString()} detail={`Within ${REMINDER_DUE_SOON_DAYS} days or ${MILEAGE_DUE_SOON_THRESHOLD} miles`} icon={CalendarDays} />
              <SummaryCard title="Overdue" value={overdueReminders.length.toString()} detail="Past due date or mileage" icon={AlertCircle} />
              <SummaryCard title="Warranty Watch" value={warrantyReminders.length.toString()} detail="Warranties ending or ended" icon={FileText} />
              <SummaryCard title="Vehicle Service" value={vehicleServiceReminders.length.toString()} detail="Service, registration, and inspection" icon={Car} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card data-testid="reminders-due-soon">
                <CardHeader>
                  <CardTitle className="font-headline">Due Soon</CardTitle>
                  <CardDescription>Maintenance due today or within the default reminder window.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReminderList
                    {...reminderListProps}
                    reminders={dueSoonReminders}
                    emptyTitle="Nothing due soon"
                    emptyDescription="Date and mileage reminders will appear here when they are close."
                  />
                </CardContent>
              </Card>

              <Card data-testid="reminders-overdue">
                <CardHeader>
                  <CardTitle className="font-headline">Overdue</CardTitle>
                  <CardDescription>Items past their date or mileage threshold.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReminderList
                    {...reminderListProps}
                    reminders={overdueReminders}
                    emptyTitle="Nothing overdue"
                    emptyDescription="Overdue scheduled maintenance and vehicle requirements will appear here."
                  />
                </CardContent>
              </Card>

              <Card data-testid="reminders-warranty">
                <CardHeader>
                  <CardTitle className="font-headline">Warranty Watch</CardTitle>
                  <CardDescription>Home asset warranties ending soon or already ended.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReminderList
                    {...reminderListProps}
                    reminders={warrantyReminders}
                    emptyTitle="No warranty reminders"
                    emptyDescription="Warranties ending within the reminder window will appear here."
                  />
                </CardContent>
              </Card>

              <Card data-testid="reminders-vehicle">
                <CardHeader>
                  <CardTitle className="font-headline">Vehicle Service Due</CardTitle>
                  <CardDescription>Vehicle service, registration, and inspection reminders.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReminderList
                    {...reminderListProps}
                    reminders={vehicleServiceReminders}
                    emptyTitle="No vehicle reminders"
                    emptyDescription="Mileage and date-based vehicle reminders will appear here."
                  />
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="logs" className="space-y-4 pt-4">
            {canCreateLogs && (
              <div className="flex justify-end">
                <Button onClick={() => openLogDialog()}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Maintenance Log
                </Button>
              </div>
            )}
            <LogList {...logListProps} logs={logs} highlightedLogId={highlightedLogId} />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={assetDialogOpen} onOpenChange={(open) => {
        setAssetDialogOpen(open);
        if (!open) setAssetScheduleForms([]);
      }}>
        <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col overflow-hidden p-0">
          <DialogHeader className="px-6 pb-0 pr-10 pt-6">
            <DialogTitle>{editingAsset ? 'Edit Home Asset' : 'Add Home Asset'}</DialogTitle>
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
                <Button type="button" variant="secondary" onClick={() => setAssetDialogOpen(false)}>Cancel</Button>
                <Button type="submit">Save Asset</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={vehicleDialogOpen} onOpenChange={(open) => {
        setVehicleDialogOpen(open);
        if (!open) setVehicleScheduleForms([]);
      }}>
        <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col overflow-hidden p-0">
          <DialogHeader className="px-6 pb-0 pr-10 pt-6">
            <DialogTitle>{editingVehicle ? 'Edit Vehicle' : 'Add Vehicle'}</DialogTitle>
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
              <DialogFooter className="border-t px-6 py-4">
                <Button type="button" variant="secondary" onClick={() => setVehicleDialogOpen(false)}>Cancel</Button>
                <Button type="submit">Save Vehicle</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={logDialogOpen} onOpenChange={(open) => {
        setLogDialogOpen(open);
        if (!open) setEditingLog(null);
      }}>
        <DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col overflow-hidden p-0">
          <DialogHeader className="px-6 pb-0 pr-10 pt-6">
            <DialogTitle>{editingLog ? 'Edit Maintenance Log' : 'Add Maintenance Log'}</DialogTitle>
            <DialogDescription>Link a log to a home asset, vehicle, or keep it general.</DialogDescription>
          </DialogHeader>
          <Form {...logForm}>
            <form onSubmit={logForm.handleSubmit(saveLog)} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-4">
                <div className="grid gap-4 sm:grid-cols-2">
                <FormField control={logForm.control} name="targetType" render={({ field }) => (
                  <FormItem><FormLabel>Log For</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent><SelectItem value="general">General</SelectItem><SelectItem value="home_asset">Home Asset</SelectItem><SelectItem value="vehicle">Vehicle</SelectItem></SelectContent></Select><FormMessage /></FormItem>
                )} />
                {logForm.watch('targetType') === 'home_asset' && (
                  <FormField control={logForm.control} name="assetId" render={({ field }) => (
                    <FormItem><FormLabel>Home Asset</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Choose asset" /></SelectTrigger></FormControl><SelectContent>{assets.map(asset => <SelectItem key={asset.id} value={asset.id}>{asset.name}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
                  )} />
                )}
                {logForm.watch('targetType') === 'vehicle' && (
                  <FormField control={logForm.control} name="vehicleId" render={({ field }) => (
                    <FormItem><FormLabel>Vehicle</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Choose vehicle" /></SelectTrigger></FormControl><SelectContent>{vehicles.map(vehicle => <SelectItem key={vehicle.id} value={vehicle.id}>{vehicle.nickname}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
                  )} />
                )}
                <FormField control={logForm.control} name="title" render={({ field }) => (
                  <FormItem className={logForm.watch('targetType') === 'general' ? 'sm:col-span-1' : 'sm:col-span-2'}><FormLabel>Title</FormLabel><FormControl><Input placeholder="Replaced air filter" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={logForm.control} name="date" render={({ field }) => (
                  <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={logForm.control} name="type" render={({ field }) => (
                  <FormItem><FormLabel>Type</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl><SelectContent>{logTypes.map(type => <SelectItem key={type} value={type}>{humanizeLabel(type)}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
                )} />
                <FormField control={logForm.control} name="cost" render={({ field }) => (
                  <FormItem><FormLabel>Cost</FormLabel><FormControl><Input type="number" min="0" step="0.01" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={logForm.control} name="serviceProvider" render={({ field }) => (
                  <FormItem><FormLabel>Service Provider</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={logForm.control} name="partsUsed" render={({ field }) => (
                  <FormItem className={logForm.watch('targetType') === 'vehicle' ? '' : 'sm:col-span-2'}><FormLabel>Parts Used</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                {logForm.watch('targetType') === 'vehicle' && (
                  <FormField control={logForm.control} name="mileage" render={({ field }) => (
                    <FormItem><FormLabel>Mileage</FormLabel><FormControl><Input type="number" min="0" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                )}
                <FormField control={logForm.control} name="notes" render={({ field }) => (
                  <FormItem className="sm:col-span-2"><FormLabel>Notes</FormLabel><FormControl><AutoResizeTextarea rows={4} placeholder="Describe what happened, what was done, and any follow-up needed." {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                </div>
              </div>
              <DialogFooter className="border-t px-6 py-4">
                <Button type="button" variant="secondary" onClick={() => setLogDialogOpen(false)}>Cancel</Button>
                <Button type="submit">{editingLog ? 'Update Log' : 'Save Log'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!scheduleCompletionTarget} onOpenChange={(open) => {
        if (!open) {
          setScheduleCompletionTarget(null);
          scheduleCompletionForm.reset(emptyScheduleCompletionForm());
        }
      }}>
        <DialogContent className="flex max-h-[90dvh] max-w-xl flex-col overflow-hidden p-0">
          <DialogHeader className="px-6 pb-0 pr-10 pt-6">
            <DialogTitle>Complete Scheduled Maintenance</DialogTitle>
            <DialogDescription>
              Record the completed work and set when it should come up again.
            </DialogDescription>
          </DialogHeader>
          <Form {...scheduleCompletionForm}>
            <form onSubmit={scheduleCompletionForm.handleSubmit(completeScheduledMaintenance)} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-6 pb-4">
                {scheduleCompletionTarget && (
                  <div className="mb-4 rounded-lg border p-3">
                    <p className="text-sm font-medium">{getScheduleCompletionName(scheduleCompletionTarget)}</p>
                    <p className="text-sm text-muted-foreground">
                      {scheduleCompletionTarget.targetType === 'home_asset'
                        ? scheduleCompletionTarget.asset.name
                        : scheduleCompletionTarget.vehicle.nickname}
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
                            if (!scheduleCompletionTarget || !completedDate) return;
                            const nextDate = scheduleCompletionTarget.targetType === 'home_asset'
                              ? calculateNextAssetDueDate(scheduleCompletionTarget.schedule, completedDate)
                              : calculateNextVehicleDueDate(scheduleCompletionTarget.schedule, completedDate);
                            if (nextDate) {
                              scheduleCompletionForm.setValue('nextDueDate', nextDate);
                            }
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  {scheduleCompletionTarget?.targetType === 'vehicle' && (
                    <FormField control={scheduleCompletionForm.control} name="mileage" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Completed Mileage</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="0"
                            {...field}
                            onChange={(event) => {
                              field.onChange(event);
                              const nextMileage = scheduleCompletionTarget
                                ? calculateNextVehicleMileage(scheduleCompletionTarget.schedule, toNumber(event.target.value))
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
                  {scheduleCompletionTarget?.targetType === 'vehicle' && (
                    <FormField control={scheduleCompletionForm.control} name="nextDueMileage" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Next Due Mileage</FormLabel>
                        <FormControl><Input type="number" min="0" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  )}
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
                <Button type="button" variant="secondary" onClick={() => setScheduleCompletionTarget(null)}>Cancel</Button>
                <Button type="submit">Complete Maintenance</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!scheduleToRemove} onOpenChange={(open) => !open && setScheduleToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {scheduleToRemove?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the {scheduleToRemove?.targetType === 'home_asset' ? 'asset maintenance item' : 'vehicle service item'} from this edit form. Save the record to persist the change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={confirmScheduleRemoval}>
              Remove Item
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!attachmentToDelete} onOpenChange={(open) => !open && setAttachmentToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete attachment {attachmentToDelete?.fileName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the file and its maintenance attachment record. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deletingAttachmentId)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={Boolean(deletingAttachmentId)}
              onClick={() => attachmentToDelete && void deleteAttachment(attachmentToDelete)}
            >
              {deletingAttachmentId && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Attachment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!assetToDelete} onOpenChange={(open) => !open && setAssetToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete home asset {assetToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the asset and its schedules. Historical logs remain as general maintenance records, and active reminders for this asset are resolved. Remove direct attachments first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deletingRecord)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={Boolean(deletingRecord)}
              onClick={() => void deleteAsset()}
            >
              {deletingRecord?.startsWith('home_asset:') && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Home Asset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!logToDelete} onOpenChange={(open) => !open && setLogToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete maintenance log?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{logToDelete ? getLogTitle(logToDelete) : 'this log'}&quot;. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={Boolean(deletingRecord)}
              onClick={deleteLog}
            >
              {deletingRecord?.startsWith('log:') && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Log
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!vehicleToDelete} onOpenChange={(open) => !open && setVehicleToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete vehicle?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes &quot;{vehicleToDelete?.nickname || 'this vehicle'}&quot; and its schedules. Historical service logs remain as general maintenance records, and active reminders for this vehicle are resolved. Remove direct attachments first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deletingRecord)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={Boolean(deletingRecord)}
              onClick={deleteVehicle}
            >
              {deletingRecord?.startsWith('vehicle:') && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Vehicle
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
