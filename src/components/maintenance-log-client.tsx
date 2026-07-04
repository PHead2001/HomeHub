"use client";

import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { add, differenceInCalendarDays, format, isAfter, isBefore, isSameDay, isValid, parseISO, startOfToday, subDays } from 'date-fns';
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
  Plus,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import { summarizeMaintenanceLog } from '@/ai/flows/summarize-maintenance-log';
import type {
  HomeAsset,
  HomeAssetCategory,
  HomeAssetSchedule,
  MaintenanceAttachment,
  MaintenanceAttachmentCategory,
  MaintenanceAttachmentTargetType,
  MaintenanceLog,
  MaintenanceLogType,
  MaintenanceTargetType,
  Notification,
  Vehicle,
  VehicleServiceSchedule,
} from '@/lib/types';
import { buildNotificationDocument, createNotificationAction, isNotificationExpired, parseNotificationDoc } from '@/lib/notifications';
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
import { cn, slugify } from '@/lib/utils';
import { collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc } from 'firebase/firestore';
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
  scheduleName: string;
  frequencyType: HomeAssetSchedule['frequencyType'] | '';
  intervalValue: string;
  lastCompletedDate: string;
  nextDueDate: string;
};

type VehicleScheduleForm = {
  id: string;
  serviceName: string;
  intervalMiles: string;
  intervalMonths: string;
  lastCompletedMileage: string;
  lastCompletedDate: string;
  nextDueMileage: string;
  nextDueDate: string;
};

type ScheduleCompletionTarget =
  | {
      targetType: 'home_asset';
      asset: HomeAsset;
      scheduleIndex: number;
      schedule: HomeAssetSchedule;
    }
  | {
      targetType: 'vehicle';
      vehicle: Vehicle;
      scheduleIndex: number;
      schedule: VehicleServiceSchedule;
    };

type MaintenanceReminderStatus = 'upcoming' | 'due_soon' | 'due_today' | 'overdue';
type MaintenanceReminderGroup = 'scheduled' | 'warranty' | 'vehicle_service' | 'vehicle_document';

type MaintenanceReminder = {
  id: string;
  group: MaintenanceReminderGroup;
  status: MaintenanceReminderStatus;
  title: string;
  relatedName: string;
  targetType: 'home_asset' | 'vehicle';
  targetId: string;
  sourceType: string;
  sourceId: string;
  dueDate?: string;
  dueMileage?: number;
  currentMileage?: number;
  message: string;
  deepLink: string;
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
  id: createLocalId(),
  scheduleName: schedule?.scheduleName || '',
  frequencyType: schedule?.frequencyType || '',
  intervalValue: schedule?.intervalValue?.toString() || '',
  lastCompletedDate: schedule?.lastCompletedDate || '',
  nextDueDate: schedule?.nextDueDate || '',
});

const vehicleScheduleToForm = (schedule?: VehicleServiceSchedule): VehicleScheduleForm => ({
  id: createLocalId(),
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

const calculateNextAssetDueDate = (schedule: HomeAssetSchedule, completedDate: string) => {
  if (!schedule.frequencyType || !schedule.intervalValue) return undefined;
  const completed = parseLogDate(completedDate);
  const interval = schedule.intervalValue;

  const nextDue = add(completed, {
    days: schedule.frequencyType === 'days' ? interval : 0,
    weeks: schedule.frequencyType === 'weeks' ? interval : 0,
    months: schedule.frequencyType === 'months' ? interval : 0,
    years: schedule.frequencyType === 'years' ? interval : 0,
  });

  return format(nextDue, 'yyyy-MM-dd');
};

const calculateNextVehicleDueDate = (schedule: VehicleServiceSchedule, completedDate: string) => {
  if (!schedule.intervalMonths) return undefined;
  return format(add(parseLogDate(completedDate), { months: schedule.intervalMonths }), 'yyyy-MM-dd');
};

const calculateNextVehicleMileage = (schedule: VehicleServiceSchedule, completedMileage?: number) => {
  if (!schedule.intervalMiles || typeof completedMileage !== 'number') return undefined;
  return completedMileage + schedule.intervalMiles;
};

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
  return 'General';
};

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

const parseDueDate = (date?: string) => {
  if (!date) return null;
  const parsed = parseISO(date);
  return isValid(parsed) ? parsed : null;
};

const getDateReminderStatus = (date?: string): MaintenanceReminderStatus | null => {
  const dueDate = parseDueDate(date);
  if (!dueDate) return null;

  const today = startOfToday();
  if (isBefore(dueDate, today)) return 'overdue';
  if (isSameDay(dueDate, today)) return 'due_today';
  const daysUntilDue = differenceInCalendarDays(dueDate, today);
  if (daysUntilDue <= REMINDER_DUE_SOON_DAYS) return 'due_soon';
  return 'upcoming';
};

const getMileageReminderStatus = (nextDueMileage?: number, currentMileage?: number): MaintenanceReminderStatus | null => {
  if (typeof nextDueMileage !== 'number' || typeof currentMileage !== 'number') return null;
  if (currentMileage >= nextDueMileage) return 'overdue';
  if (nextDueMileage - currentMileage <= MILEAGE_DUE_SOON_THRESHOLD) return 'due_soon';
  return 'upcoming';
};

const getReminderBadgeVariant = (status: MaintenanceReminderStatus) => {
  if (status === 'overdue') return 'destructive';
  if (status === 'due_today') return 'default';
  return 'secondary';
};

const buildMaintenanceReminders = (assets: HomeAsset[], vehicles: Vehicle[]): MaintenanceReminder[] => {
  const reminders: MaintenanceReminder[] = [];

  assets.forEach((asset) => {
    asset.schedules?.forEach((schedule, index) => {
      const status = getDateReminderStatus(schedule.nextDueDate);
      if (!status) return;
      const title = schedule.scheduleName || 'Scheduled maintenance';
      reminders.push({
        id: `asset-schedule-${asset.id}-${index}-${status}`,
        group: 'scheduled',
        status,
        title,
        relatedName: asset.name,
        targetType: 'home_asset',
        targetId: asset.id,
        sourceType: 'maintenance_asset_schedule',
        sourceId: `${asset.id}-${index}`,
        dueDate: schedule.nextDueDate,
        message: `${title} for ${asset.name} is ${humanizeLabel(status).toLowerCase()}.`,
        deepLink: `/maintenance?targetType=home_asset&targetId=${asset.id}`,
      });
    });

    const warrantyStatus = getDateReminderStatus(asset.warrantyExpiration);
    if (warrantyStatus && warrantyStatus !== 'upcoming') {
      reminders.push({
        id: `asset-warranty-${asset.id}-${warrantyStatus}`,
        group: 'warranty',
        status: warrantyStatus,
        title: 'Warranty expiration',
        relatedName: asset.name,
        targetType: 'home_asset',
        targetId: asset.id,
        sourceType: 'maintenance_asset_warranty',
        sourceId: asset.id,
        dueDate: asset.warrantyExpiration,
        message: `${asset.name} warranty is ${humanizeLabel(warrantyStatus).toLowerCase()}.`,
        deepLink: `/maintenance?targetType=home_asset&targetId=${asset.id}`,
      });
    }
  });

  vehicles.forEach((vehicle) => {
    vehicle.serviceSchedules?.forEach((schedule, index) => {
      const dateStatus = getDateReminderStatus(schedule.nextDueDate);
      const mileageStatus = getMileageReminderStatus(schedule.nextDueMileage, vehicle.currentMileage);
      const status = dateStatus === 'overdue' || mileageStatus === 'overdue'
        ? 'overdue'
        : dateStatus === 'due_today'
          ? 'due_today'
          : dateStatus === 'due_soon' || mileageStatus === 'due_soon'
            ? 'due_soon'
            : dateStatus || mileageStatus;

      if (!status) return;
      const title = schedule.serviceName || 'Scheduled service';
      reminders.push({
        id: `vehicle-service-${vehicle.id}-${index}-${status}`,
        group: 'vehicle_service',
        status,
        title,
        relatedName: vehicle.nickname,
        targetType: 'vehicle',
        targetId: vehicle.id,
        sourceType: 'maintenance_vehicle_service',
        sourceId: `${vehicle.id}-${index}`,
        dueDate: schedule.nextDueDate,
        dueMileage: schedule.nextDueMileage,
        currentMileage: vehicle.currentMileage,
        message: `${title} for ${vehicle.nickname} is ${humanizeLabel(status).toLowerCase()}.`,
        deepLink: `/maintenance?targetType=vehicle&targetId=${vehicle.id}`,
      });
    });

    ([
      ['Vehicle registration', vehicle.registrationExpiration, 'maintenance_vehicle_registration'],
      ['Vehicle inspection', vehicle.inspectionExpiration, 'maintenance_vehicle_inspection'],
    ] as const).forEach(([title, dueDate, sourceType]) => {
      const status = getDateReminderStatus(dueDate);
      if (!status || status === 'upcoming') return;
      reminders.push({
        id: `${sourceType}-${vehicle.id}-${status}`,
        group: 'vehicle_document',
        status,
        title,
        relatedName: vehicle.nickname,
        targetType: 'vehicle',
        targetId: vehicle.id,
        sourceType,
        sourceId: vehicle.id,
        dueDate,
        message: `${title} for ${vehicle.nickname} is ${humanizeLabel(status).toLowerCase()}.`,
        deepLink: `/maintenance?targetType=vehicle&targetId=${vehicle.id}`,
      });
    });
  });

  return reminders.sort((a, b) => {
    const statusWeight: Record<MaintenanceReminderStatus, number> = {
      overdue: 0,
      due_today: 1,
      due_soon: 2,
      upcoming: 3,
    };
    if (statusWeight[a.status] !== statusWeight[b.status]) {
      return statusWeight[a.status] - statusWeight[b.status];
    }
    return parseLogDate(a.dueDate || '2999-12-31').getTime() - parseLogDate(b.dueDate || '2999-12-31').getTime();
  });
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

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value?: string | number }) {
  return (
    <div>
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="text-sm">{value || 'Not recorded'}</p>
    </div>
  );
}

function AttachmentPanel({
  title = 'Attachments',
  attachments,
  targetType,
  targetId,
  uploading,
  deletingId,
  onUpload,
  onDelete,
}: {
  title?: string;
  attachments: MaintenanceAttachment[];
  targetType: MaintenanceAttachmentTargetType;
  targetId: string;
  uploading: boolean;
  deletingId?: string | null;
  onUpload: (targetType: MaintenanceAttachmentTargetType, targetId: string, category: MaintenanceAttachmentCategory, file: File) => void;
  onDelete: (attachment: MaintenanceAttachment) => void;
}) {
  const [category, setCategory] = useState<MaintenanceAttachmentCategory>('photo');

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-headline font-semibold">{title}</h3>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
            <label className="cursor-pointer">
              {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Upload
              <Input
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
        </div>
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
                      <span className="sr-only">Open attachment</span>
                    </a>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  disabled={deletingId === attachment.id}
                  onClick={() => onDelete(attachment)}
                >
                  {deletingId === attachment.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  <span className="sr-only">Delete attachment</span>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReminderList({
  reminders,
  emptyTitle,
  emptyDescription,
  onOpen,
}: {
  reminders: MaintenanceReminder[];
  emptyTitle: string;
  emptyDescription: string;
  onOpen: (reminder: MaintenanceReminder) => void;
}) {
  if (reminders.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="space-y-3">
      {reminders.map((reminder) => (
        <Card key={reminder.id}>
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-headline text-base font-semibold">{reminder.title}</h3>
                <Badge variant={getReminderBadgeVariant(reminder.status)}>{humanizeLabel(reminder.status)}</Badge>
                <Badge variant="outline">{reminder.relatedName}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{reminder.message}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {reminder.dueDate && <span>Due date: {formatDate(reminder.dueDate)}</span>}
                {typeof reminder.dueMileage === 'number' && <span>Due mileage: {reminder.dueMileage.toLocaleString()}</span>}
                {typeof reminder.currentMileage === 'number' && <span>Current mileage: {reminder.currentMileage.toLocaleString()}</span>}
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => onOpen(reminder)}>
              Open Related
            </Button>
          </CardContent>
        </Card>
      ))}
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
}: {
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
}) {
  if (logs.length === 0) {
    return <EmptyState title="No logs yet" description="Maintenance records will appear here after they are added." />;
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => (
        <Card key={log.id}>
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
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEdit(log)}>
                  <Edit className="h-4 w-4" />
                  <span className="sr-only">Edit log</span>
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onDelete(log)}>
                  <Trash2 className="h-4 w-4" />
                  <span className="sr-only">Delete log</span>
                </Button>
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

            {log.notes && (
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
  const { currentUser } = useAuth();
  const { toast } = useToast();
  const [assets, setAssets] = useState<HomeAsset[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [logs, setLogs] = useState<MaintenanceLog[]>([]);
  const [attachments, setAttachments] = useState<MaintenanceAttachment[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const [vehicleDialogOpen, setVehicleDialogOpen] = useState(false);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<HomeAsset | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [editingLog, setEditingLog] = useState<MaintenanceLog | null>(null);
  const [logToDelete, setLogToDelete] = useState<MaintenanceLog | null>(null);
  const [vehicleToDelete, setVehicleToDelete] = useState<Vehicle | null>(null);
  const [scheduleCompletionTarget, setScheduleCompletionTarget] = useState<ScheduleCompletionTarget | null>(null);
  const [assetScheduleForms, setAssetScheduleForms] = useState<AssetScheduleForm[]>([]);
  const [vehicleScheduleForms, setVehicleScheduleForms] = useState<VehicleScheduleForm[]>([]);
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

  const fetchMaintenanceData = useCallback(async () => {
    const assetsCollection = getCollectionRef('home-assets');
    const vehiclesCollection = getCollectionRef('vehicles');
    const logsCollection = getCollectionRef('maintenance');
    const attachmentsCollection = getCollectionRef('maintenance-attachments');
    const notificationsCollection = getCollectionRef('notifications');

    if (!assetsCollection || !vehiclesCollection || !logsCollection || !attachmentsCollection || !notificationsCollection) {
      setAssets([]);
      setVehicles([]);
      setLogs([]);
      setAttachments([]);
      setNotifications([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [assetSnap, vehicleSnap, logSnap, attachmentSnap, notificationSnap] = await Promise.all([
        getDocs(query(assetsCollection, orderBy('name', 'asc'))),
        getDocs(query(vehiclesCollection, orderBy('nickname', 'asc'))),
        getDocs(query(logsCollection, orderBy('date', 'desc'))),
        getDocs(query(attachmentsCollection, orderBy('createdAt', 'desc'))),
        getDocs(query(notificationsCollection, orderBy('createdAt', 'desc'))),
      ]);

      setAssets(assetSnap.docs.map((assetDoc) => ({ id: assetDoc.id, ...assetDoc.data() } as HomeAsset)));
      setVehicles(vehicleSnap.docs.map((vehicleDoc) => ({ id: vehicleDoc.id, ...vehicleDoc.data() } as Vehicle)));
      setLogs(logSnap.docs.map((logDoc) => ({ id: logDoc.id, ...logDoc.data() } as MaintenanceLog)));
      setAttachments(attachmentSnap.docs.map((attachmentDoc) => ({ id: attachmentDoc.id, ...attachmentDoc.data() } as MaintenanceAttachment)));
      setNotifications(notificationSnap.docs.map(parseNotificationDoc));
    } catch (fetchError) {
      console.error('Error fetching maintenance data:', fetchError);
      setError('Could not load maintenance data.');
      toast({ variant: 'destructive', title: 'Error', description: 'Could not fetch maintenance data.' });
    } finally {
      setLoading(false);
    }
  }, [getCollectionRef, toast]);

  useEffect(() => {
    if (currentUser?.householdId) {
      void fetchMaintenanceData();
    } else {
      setAssets([]);
      setVehicles([]);
      setLogs([]);
      setAttachments([]);
      setNotifications([]);
      setLoading(false);
    }
  }, [currentUser?.householdId, fetchMaintenanceData]);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const targetType = searchParams.get('targetType');
    const targetId = searchParams.get('targetId');
    if (!targetType || !targetId) return;

    if (targetType === 'home_asset') {
      setSelectedAssetId(targetId);
      setActiveTab('assets');
    }
    if (targetType === 'vehicle') {
      setSelectedVehicleId(targetId);
      setActiveTab('vehicles');
    }
  }, []);

  const reminders = useMemo(() => buildMaintenanceReminders(assets, vehicles), [assets, vehicles]);

  const actionableReminders = useMemo(() => {
    return reminders.filter((reminder) => reminder.status !== 'upcoming');
  }, [reminders]);

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

  const openReminderTarget = (reminder: MaintenanceReminder) => {
    if (reminder.targetType === 'home_asset') {
      setSelectedAssetId(reminder.targetId);
      setActiveTab('assets');
    } else {
      setSelectedVehicleId(reminder.targetId);
      setActiveTab('vehicles');
    }
  };

  const notificationSyncKey = useMemo(() => {
    return actionableReminders.map((reminder) => `${reminder.sourceType}:${reminder.sourceId}:${reminder.status}`).join('|');
  }, [actionableReminders]);

  useEffect(() => {
    if (!currentUser?.householdId || actionableReminders.length === 0) return;

    const syncMaintenanceNotifications = async () => {
      const notificationsCollection = getCollectionRef('notifications');
      if (!notificationsCollection) return;

      await Promise.all(actionableReminders.map(async (reminder) => {
        const notificationId = slugify(`${reminder.sourceType}-${reminder.sourceId}-${reminder.status}`);
        const existingNotification = notifications.find((notification) => notification.id === notificationId);
        if (existingNotification && !isNotificationExpired(existingNotification)) return;

        const notificationRef = doc(notificationsCollection, notificationId);
        const notificationSnap = await getDoc(notificationRef);
        if (notificationSnap.exists()) return;

        await setDoc(notificationRef, buildNotificationDocument({
          householdId: currentUser.householdId!,
          category: 'maintenance',
          title: reminder.title,
          message: reminder.message,
          deepLink: reminder.deepLink,
          sourceType: reminder.sourceType,
          sourceId: `${reminder.sourceId}:${reminder.status}`,
        }));
      }));
    };

    void syncMaintenanceNotifications().catch((notificationError) => {
      console.error('Error syncing maintenance notifications:', notificationError);
    });
  }, [actionableReminders, currentUser?.householdId, getCollectionRef, notificationSyncKey, notifications]);

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
      await fetchMaintenanceData();
    } catch (uploadError) {
      console.error('Error uploading maintenance attachment:', uploadError);
      toast({ variant: 'destructive', title: 'Upload failed', description: 'Could not upload the attachment.' });
    } finally {
      setUploadingAttachmentTarget(null);
    }
  };

  const deleteAttachment = async (attachment: MaintenanceAttachment) => {
    if (!currentUser?.householdId) return;
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
      toast({ title: 'Attachment deleted' });
      await fetchMaintenanceData();
    } catch (deleteError) {
      console.error('Error deleting maintenance attachment:', deleteError);
      toast({ variant: 'destructive', title: 'Delete failed', description: 'The attachment could not be fully deleted.' });
    } finally {
      setDeletingAttachmentId(null);
    }
  };

  const resolveMaintenanceNotifications = async (sourceType: string, sourceId: string) => {
    if (!currentUser?.householdId) return;
    const notificationsCollection = getCollectionRef('notifications');
    if (!notificationsCollection) return;

    const action = createNotificationAction(currentUser);
    await Promise.all((['due_soon', 'due_today', 'overdue'] as const).map(async (status) => {
      const notificationRef = doc(notificationsCollection, slugify(`${sourceType}-${sourceId}-${status}`));
      const notificationSnap = await getDoc(notificationRef);
      if (!notificationSnap.exists() || notificationSnap.data().resolvedAt) return;

      await updateDoc(notificationRef, {
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
  };

  const removeAssetSchedule = (id: string) => {
    setAssetScheduleForms(prev => prev.filter(schedule => schedule.id !== id));
  };

  const addVehicleSchedule = () => {
    setVehicleScheduleForms(prev => [...prev, vehicleScheduleToForm()]);
  };

  const updateVehicleSchedule = (id: string, field: keyof Omit<VehicleScheduleForm, 'id'>, value: string) => {
    setVehicleScheduleForms(prev => prev.map(schedule => (
      schedule.id === id ? { ...schedule, [field]: value } : schedule
    )));
  };

  const removeVehicleSchedule = (id: string) => {
    setVehicleScheduleForms(prev => prev.filter(schedule => schedule.id !== id));
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

  const saveAsset = async (values: AssetFormValues) => {
    if (!currentUser?.householdId) return;
    const assetsCollection = getCollectionRef('home-assets');
    if (!assetsCollection) return;

    const now = new Date().toISOString();
    const assetId = editingAsset?.id || slugify(values.name);
    const schedules = assetScheduleForms.reduce<HomeAssetSchedule[]>((nextSchedules, schedule) => {
      const scheduleName = trimOptional(schedule.scheduleName);
      if (!scheduleName) return nextSchedules;

      nextSchedules.push({
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
      await fetchMaintenanceData();
    } catch (saveError) {
      console.error('Error saving asset:', saveError);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not save home asset.' });
    }
  };

  const saveVehicle = async (values: VehicleFormValues) => {
    if (!currentUser?.householdId) return;
    const vehiclesCollection = getCollectionRef('vehicles');
    if (!vehiclesCollection) return;

    const now = new Date().toISOString();
    const vehicleId = editingVehicle?.id || slugify(values.nickname);
    const serviceSchedules = vehicleScheduleForms.reduce<VehicleServiceSchedule[]>((schedules, schedule) => {
      const serviceName = trimOptional(schedule.serviceName);
      if (!serviceName) return schedules;

      schedules.push({
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
      await fetchMaintenanceData();
    } catch (saveError) {
      console.error('Error saving vehicle:', saveError);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not save vehicle.' });
    }
  };

  const saveLog = async (values: LogFormValues) => {
    if (!currentUser?.householdId) return;
    const logsCollection = getCollectionRef('maintenance');
    if (!logsCollection) return;

    if (values.targetType === 'home_asset' && !values.assetId) {
      toast({ variant: 'destructive', title: 'Missing home asset', description: 'Choose a home asset or switch the log to general.' });
      return;
    }

    if (values.targetType === 'vehicle' && !values.vehicleId) {
      toast({ variant: 'destructive', title: 'Missing vehicle', description: 'Choose a vehicle or switch the log to general.' });
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
      await fetchMaintenanceData();
    } catch (saveError) {
      console.error('Error saving maintenance log:', saveError);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not save maintenance log.' });
    }
  };

  const completeScheduledMaintenance = async (values: ScheduleCompletionFormValues) => {
    if (!scheduleCompletionTarget || !currentUser?.householdId) return;

    const logsCollection = getCollectionRef('maintenance');
    const assetsCollection = getCollectionRef('home-assets');
    const vehiclesCollection = getCollectionRef('vehicles');
    if (!logsCollection || !assetsCollection || !vehiclesCollection) return;

    const now = new Date().toISOString();
    const scheduleName = getScheduleCompletionName(scheduleCompletionTarget);
    const completedDate = values.completedDate;
    const completedMileage = scheduleCompletionTarget.targetType === 'vehicle' ? toNumber(values.mileage) : undefined;
    const logId = `${slugify(`${scheduleName}-${completedDate}`)}-${Date.now()}`;
    const logData: Omit<MaintenanceLog, 'id'> = {
      householdId: currentUser.householdId,
      targetType: scheduleCompletionTarget.targetType,
      assetId: scheduleCompletionTarget.targetType === 'home_asset' ? scheduleCompletionTarget.asset.id : undefined,
      vehicleId: scheduleCompletionTarget.targetType === 'vehicle' ? scheduleCompletionTarget.vehicle.id : undefined,
      title: scheduleName,
      item: scheduleName,
      date: completedDate,
      type: 'routine',
      notes: trimOptional(values.notes),
      mileage: scheduleCompletionTarget.targetType === 'vehicle' ? completedMileage : undefined,
      createdAt: now,
      updatedAt: now,
    };

    try {
      if (scheduleCompletionTarget.targetType === 'home_asset') {
        const { asset, scheduleIndex, schedule } = scheduleCompletionTarget;
        const { id, ...assetFields } = asset;
        const schedules = [...(asset.schedules || [])];
        schedules[scheduleIndex] = {
          ...schedule,
          lastCompletedDate: completedDate,
          nextDueDate: trimOptional(values.nextDueDate) || calculateNextAssetDueDate(schedule, completedDate),
        };

        await Promise.all([
          setDoc(doc(logsCollection, logId), cleanForFirestore(logData)),
          setDoc(doc(assetsCollection, id), cleanForFirestore({
            ...assetFields,
            householdId: currentUser.householdId,
            schedules,
            updatedAt: now,
          })),
          resolveMaintenanceNotifications('maintenance_asset_schedule', `${id}-${scheduleIndex}`),
        ]);
        setSelectedAssetId(id);
      } else {
        const { vehicle, scheduleIndex, schedule } = scheduleCompletionTarget;
        const { id, ...vehicleFields } = vehicle;
        const schedules = [...(vehicle.serviceSchedules || [])];
        schedules[scheduleIndex] = {
          ...schedule,
          lastCompletedMileage: completedMileage,
          lastCompletedDate: completedDate,
          nextDueMileage: toNumber(values.nextDueMileage) || calculateNextVehicleMileage(schedule, completedMileage),
          nextDueDate: trimOptional(values.nextDueDate) || calculateNextVehicleDueDate(schedule, completedDate),
        };

        await Promise.all([
          setDoc(doc(logsCollection, logId), cleanForFirestore(logData)),
          setDoc(doc(vehiclesCollection, id), cleanForFirestore({
            ...vehicleFields,
            householdId: currentUser.householdId,
            currentMileage: typeof completedMileage === 'number' ? completedMileage : vehicle.currentMileage,
            serviceSchedules: schedules,
            updatedAt: now,
          })),
          resolveMaintenanceNotifications('maintenance_vehicle_service', `${id}-${scheduleIndex}`),
        ]);
        setSelectedVehicleId(id);
      }

      setScheduleCompletionTarget(null);
      scheduleCompletionForm.reset(emptyScheduleCompletionForm());
      toast({ title: 'Scheduled maintenance completed' });
      await fetchMaintenanceData();
    } catch (saveError) {
      console.error('Error completing scheduled maintenance:', saveError);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not complete scheduled maintenance.' });
    }
  };

  const deleteLog = async () => {
    if (!logToDelete) return;
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

    try {
      await deleteDoc(doc(logsCollection, logToDelete.id));
      setSummaries(prev => {
        const next = { ...prev };
        delete next[logToDelete.id];
        return next;
      });
      setLogToDelete(null);
      toast({ title: 'Maintenance log deleted' });
      await fetchMaintenanceData();
    } catch (deleteError) {
      console.error('Error deleting maintenance log:', deleteError);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not delete maintenance log.' });
    }
  };

  const deleteVehicle = async () => {
    if (!vehicleToDelete) return;
    const vehiclesCollection = getCollectionRef('vehicles');
    if (!vehiclesCollection) return;

    if (getAttachmentsForTarget(attachments, 'vehicle', vehicleToDelete.id).length > 0) {
      toast({
        variant: 'destructive',
        title: 'Remove attachments first',
        description: 'Delete attachments for this vehicle before deleting it.',
      });
      return;
    }

    try {
      await deleteDoc(doc(vehiclesCollection, vehicleToDelete.id));
      setSelectedVehicleId(prev => prev === vehicleToDelete.id ? null : prev);
      setVehicleToDelete(null);
      toast({ title: 'Vehicle deleted' });
      await fetchMaintenanceData();
    } catch (deleteError) {
      console.error('Error deleting vehicle:', deleteError);
      toast({ variant: 'destructive', title: 'Error', description: 'Could not delete vehicle.' });
    }
  };

  const handleSummarize = async (log: MaintenanceLog) => {
    if (!log.notes) return;

    setLoadingSummaries(prev => ({ ...prev, [log.id]: true }));
    try {
      const result = await summarizeMaintenanceLog({ log: log.notes });
      setSummaries(prev => ({ ...prev, [log.id]: result.summary }));
    } catch (summaryError) {
      console.error(summaryError);
      toast({ variant: 'destructive', title: 'Error', description: 'Failed to generate summary.' });
    } finally {
      setLoadingSummaries(prev => ({ ...prev, [log.id]: false }));
    }
  };

  if (!currentUser) {
    return <p className="py-8 text-center">Please log in to manage maintenance.</p>;
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

  return (
    <>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-headline text-3xl font-bold tracking-tight">Maintenance Center</h1>
            <p className="text-muted-foreground">Track home assets, vehicles, service history, and repair notes.</p>
          </div>
          <Button onClick={() => openLogDialog()}>
            <Plus className="mr-2 h-4 w-4" />
            Add Log
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid h-auto w-full grid-cols-2 md:grid-cols-5">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="assets">Home Assets</TabsTrigger>
            <TabsTrigger value="vehicles">Vehicles</TabsTrigger>
            <TabsTrigger value="reminders">Reminders</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6 pt-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <SummaryCard title="Home Assets" value={assets.length.toString()} detail="Registered household assets" icon={Home} />
              <SummaryCard title="Vehicles" value={vehicles.length.toString()} detail="Registered vehicles" icon={Car} />
              <SummaryCard title="Recent Logs" value={summary.recentLogs.length.toString()} detail="Logged in the last 30 days" icon={ClipboardList} />
              <SummaryCard title="Needs Attention" value={summary.needingAttention.toString()} detail="Assets or vehicles flagged" icon={AlertCircle} />
              <SummaryCard title="Recent Costs" value={formatCurrency(summary.recentCost)} detail="Recorded in the last 30 days" icon={DollarSign} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="font-headline">Recent Maintenance</CardTitle>
                  <CardDescription>Latest household maintenance activity.</CardDescription>
                </CardHeader>
                <CardContent>
                  <LogList
                    logs={logs.slice(0, 5)}
                    assets={assets}
                    vehicles={vehicles}
                    attachments={attachments}
                    summaries={summaries}
                    loadingSummaries={loadingSummaries}
                    uploadingAttachmentTarget={uploadingAttachmentTarget}
                    deletingAttachmentId={deletingAttachmentId}
                    onSummarize={handleSummarize}
                    onEdit={(log) => openLogDialog(undefined, log)}
                    onDelete={setLogToDelete}
                    onUploadAttachment={uploadAttachment}
                    onDeleteAttachment={deleteAttachment}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="font-headline">Attention Queue</CardTitle>
                  <CardDescription>Items currently marked as needing attention.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {[...assets.filter(asset => asset.status === 'needs_attention'), ...vehicles.filter(vehicle => vehicle.status === 'needs_attention')].length === 0 ? (
                    <EmptyState title="Nothing flagged" description="Mark assets or vehicles as needing attention when they need follow-up." />
                  ) : (
                    <>
                      {assets.filter(asset => asset.status === 'needs_attention').map(asset => (
                        <div key={asset.id} className="rounded-lg border p-3">
                          <p className="font-medium">{asset.name}</p>
                          <p className="text-sm text-muted-foreground">{asset.category} {asset.location ? `- ${asset.location}` : ''}</p>
                        </div>
                      ))}
                      {vehicles.filter(vehicle => vehicle.status === 'needs_attention').map(vehicle => (
                        <div key={vehicle.id} className="rounded-lg border p-3">
                          <p className="font-medium">{vehicle.nickname}</p>
                          <p className="text-sm text-muted-foreground">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</p>
                        </div>
                      ))}
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="assets" className="space-y-4 pt-4">
            <div className="flex justify-end">
              <Button onClick={() => openAssetDialog()}>
                <Plus className="mr-2 h-4 w-4" />
                Add Home Asset
              </Button>
            </div>

            {assets.length === 0 ? (
              <EmptyState title="No home assets yet" description="Add HVAC, appliances, tools, and other assets to build your registry." />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
                <div className="grid gap-3 sm:grid-cols-2">
                  {assets.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => setSelectedAssetId(asset.id)}
                      className={cn(
                        'rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent',
                        selectedAsset?.id === asset.id && 'border-primary'
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-headline font-semibold">{asset.name}</p>
                          <p className="text-sm text-muted-foreground">{asset.category}</p>
                        </div>
                        <Badge variant={asset.status === 'needs_attention' ? 'destructive' : 'outline'}>{humanizeLabel(asset.status)}</Badge>
                      </div>
                      <p className="mt-3 text-sm text-muted-foreground">{asset.location || 'No room recorded'}</p>
                    </button>
                  ))}
                </div>

                {selectedAsset && (
                  <Card>
                    <CardHeader className="flex flex-row items-start justify-between gap-3">
                      <div>
                        <CardTitle className="font-headline">{selectedAsset.name}</CardTitle>
                        <CardDescription>{selectedAsset.category}</CardDescription>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => openAssetDialog(selectedAsset)}>
                        <Edit className="mr-2 h-4 w-4" />
                        Edit
                      </Button>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <DetailRow label="Status" value={humanizeLabel(selectedAsset.status)} />
                        <DetailRow label="Location" value={selectedAsset.location} />
                        <DetailRow label="Brand" value={selectedAsset.brand} />
                        <DetailRow label="Model" value={selectedAsset.model} />
                        <DetailRow label="Serial Number" value={selectedAsset.serialNumber} />
                        <DetailRow label="Purchase Price" value={formatCurrency(selectedAsset.purchasePrice)} />
                        <DetailRow label="Purchase Date" value={formatDate(selectedAsset.purchaseDate)} />
                        <DetailRow label="Warranty Ends" value={formatDate(selectedAsset.warrantyExpiration)} />
                        <DetailRow label="Warranty Provider" value={selectedAsset.warrantyProvider} />
                      </div>
                      {selectedAsset.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{selectedAsset.notes}</p>}
                      <AttachmentPanel
                        attachments={getAttachmentsForTarget(attachments, 'home_asset', selectedAsset.id)}
                        targetType="home_asset"
                        targetId={selectedAsset.id}
                        uploading={uploadingAttachmentTarget === `home_asset:${selectedAsset.id}`}
                        deletingId={deletingAttachmentId}
                        onUpload={uploadAttachment}
                        onDelete={deleteAttachment}
                      />
                      {selectedAsset.schedules && selectedAsset.schedules.length > 0 && (
                        <div className="space-y-2">
                          <h3 className="font-headline font-semibold">Scheduled Maintenance</h3>
                          {selectedAsset.schedules.map((schedule, index) => (
                            <div key={`${schedule.scheduleName}-${index}`} className="rounded-lg border p-3">
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                  <p className="text-sm font-medium">{schedule.scheduleName || 'Scheduled maintenance'}</p>
                                  <p className="text-sm text-muted-foreground">
                                    Next due {formatDate(schedule.nextDueDate)}
                                  </p>
                                  {schedule.frequencyType && schedule.intervalValue && (
                                    <p className="text-xs text-muted-foreground">
                                      Every {schedule.intervalValue} {schedule.frequencyType}
                                    </p>
                                  )}
                                </div>
                                <Button
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
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex justify-between gap-2">
                        <h3 className="font-headline font-semibold">Linked Logs</h3>
                        <Button variant="outline" size="sm" onClick={() => openLogDialog({ targetType: 'home_asset', assetId: selectedAsset.id })}>
                          Add Log
                        </Button>
                      </div>
                      <LogList
                        logs={assetLogs}
                        assets={assets}
                        vehicles={vehicles}
                        attachments={attachments}
                        summaries={summaries}
                        loadingSummaries={loadingSummaries}
                        uploadingAttachmentTarget={uploadingAttachmentTarget}
                        deletingAttachmentId={deletingAttachmentId}
                        onSummarize={handleSummarize}
                        onEdit={(log) => openLogDialog(undefined, log)}
                        onDelete={setLogToDelete}
                        onUploadAttachment={uploadAttachment}
                        onDeleteAttachment={deleteAttachment}
                      />
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="vehicles" className="space-y-4 pt-4">
            <div className="flex justify-end">
              <Button onClick={() => openVehicleDialog()}>
                <Plus className="mr-2 h-4 w-4" />
                Add Vehicle
              </Button>
            </div>

            {vehicles.length === 0 ? (
              <EmptyState title="No vehicles yet" description="Add household vehicles to track mileage, key dates, and service logs." />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
                <div className="space-y-4">
                  {activeVehicles.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {activeVehicles.map((vehicle) => (
                        <button
                          key={vehicle.id}
                          type="button"
                          onClick={() => setSelectedVehicleId(vehicle.id)}
                          className={cn(
                            'rounded-lg border bg-card p-4 text-left transition-colors hover:bg-accent',
                            selectedVehicle?.id === vehicle.id && 'border-primary'
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="font-headline font-semibold">{vehicle.nickname}</p>
                              <p className="text-sm text-muted-foreground">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</p>
                            </div>
                            <Badge variant={vehicle.status === 'needs_attention' ? 'destructive' : 'outline'}>{humanizeLabel(vehicle.status)}</Badge>
                          </div>
                          <p className="mt-3 text-sm text-muted-foreground">
                            {typeof vehicle.currentMileage === 'number' ? `${vehicle.currentMileage.toLocaleString()} miles` : 'Mileage not recorded'}
                          </p>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <EmptyState title="No active vehicles" description="Sold and retired vehicles are kept out of the main vehicle list." />
                  )}

                  {inactiveVehicles.length > 0 && (
                    <div className="rounded-lg border p-3">
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full justify-between px-2"
                        onClick={() => setShowInactiveVehicles(prev => !prev)}
                      >
                        <span>Sold / retired vehicles ({inactiveVehicles.length})</span>
                        <span className="text-xs text-muted-foreground">{showInactiveVehicles ? 'Hide' : 'Show'}</span>
                      </Button>
                      {showInactiveVehicles && (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          {inactiveVehicles.map((vehicle) => (
                            <button
                              key={vehicle.id}
                              type="button"
                              onClick={() => setSelectedVehicleId(vehicle.id)}
                              className={cn(
                                'rounded-lg border bg-muted/30 p-4 text-left transition-colors hover:bg-accent',
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
                  <Card>
                    <CardHeader className="flex flex-row items-start justify-between gap-3">
                      <div>
                        <CardTitle className="font-headline">{selectedVehicle.nickname}</CardTitle>
                        <CardDescription>{[selectedVehicle.year, selectedVehicle.make, selectedVehicle.model, selectedVehicle.trim].filter(Boolean).join(' ') || 'Vehicle details'}</CardDescription>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => openVehicleDialog(selectedVehicle)}>
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </Button>
                        <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setVehicleToDelete(selectedVehicle)}>
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <DetailRow label="Status" value={humanizeLabel(selectedVehicle.status)} />
                        <DetailRow label="Mileage" value={typeof selectedVehicle.currentMileage === 'number' ? selectedVehicle.currentMileage.toLocaleString() : undefined} />
                        <DetailRow label="VIN" value={selectedVehicle.vin} />
                        <DetailRow label="License Plate" value={selectedVehicle.licensePlate} />
                        <DetailRow label="Insurance" value={selectedVehicle.insuranceProvider} />
                        <DetailRow label="Purchase Price" value={formatCurrency(selectedVehicle.purchasePrice)} />
                        <DetailRow label="Registration Expires" value={formatDate(selectedVehicle.registrationExpiration)} />
                        <DetailRow label="Inspection Expires" value={formatDate(selectedVehicle.inspectionExpiration)} />
                      </div>
                      {selectedVehicle.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{selectedVehicle.notes}</p>}
                      <AttachmentPanel
                        attachments={getAttachmentsForTarget(attachments, 'vehicle', selectedVehicle.id)}
                        targetType="vehicle"
                        targetId={selectedVehicle.id}
                        uploading={uploadingAttachmentTarget === `vehicle:${selectedVehicle.id}`}
                        deletingId={deletingAttachmentId}
                        onUpload={uploadAttachment}
                        onDelete={deleteAttachment}
                      />
                      {selectedVehicle.serviceSchedules && selectedVehicle.serviceSchedules.length > 0 && (
                        <div className="space-y-2">
                          <h3 className="font-headline font-semibold">Scheduled Maintenance</h3>
                          {selectedVehicle.serviceSchedules.map((schedule, index) => (
                            <div key={`${schedule.serviceName}-${index}`} className="rounded-lg border p-3">
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                  <p className="text-sm font-medium">{schedule.serviceName || 'Scheduled maintenance'}</p>
                                  <p className="text-sm text-muted-foreground">
                                    Next due {formatDate(schedule.nextDueDate)}
                                    {typeof schedule.nextDueMileage === 'number' ? ` or ${schedule.nextDueMileage.toLocaleString()} miles` : ''}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {schedule.intervalMiles ? `Every ${schedule.intervalMiles.toLocaleString()} miles` : ''}
                                    {schedule.intervalMiles && schedule.intervalMonths ? ' / ' : ''}
                                    {schedule.intervalMonths ? `Every ${schedule.intervalMonths} months` : ''}
                                  </p>
                                </div>
                                <Button
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
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex justify-between gap-2">
                        <h3 className="font-headline font-semibold">Service Logs</h3>
                        <Button variant="outline" size="sm" onClick={() => openLogDialog({ targetType: 'vehicle', vehicleId: selectedVehicle.id })}>
                          Add Log
                        </Button>
                      </div>
                      <LogList
                        logs={vehicleLogs}
                        assets={assets}
                        vehicles={vehicles}
                        attachments={attachments}
                        summaries={summaries}
                        loadingSummaries={loadingSummaries}
                        uploadingAttachmentTarget={uploadingAttachmentTarget}
                        deletingAttachmentId={deletingAttachmentId}
                        onSummarize={handleSummarize}
                        onEdit={(log) => openLogDialog(undefined, log)}
                        onDelete={setLogToDelete}
                        onUploadAttachment={uploadAttachment}
                        onDeleteAttachment={deleteAttachment}
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
              <SummaryCard title="Warranty Watch" value={warrantyReminders.length.toString()} detail="Expiring warranties" icon={FileText} />
              <SummaryCard title="Vehicle Service" value={vehicleServiceReminders.length.toString()} detail="Service, registration, and inspection" icon={Car} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="font-headline">Due Soon</CardTitle>
                  <CardDescription>Maintenance due today or within the default reminder window.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReminderList
                    reminders={dueSoonReminders}
                    emptyTitle="Nothing due soon"
                    emptyDescription="Date and mileage reminders will appear here when they are close."
                    onOpen={openReminderTarget}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="font-headline">Overdue</CardTitle>
                  <CardDescription>Items past their date or mileage threshold.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReminderList
                    reminders={overdueReminders}
                    emptyTitle="Nothing overdue"
                    emptyDescription="Overdue scheduled maintenance and vehicle requirements will appear here."
                    onOpen={openReminderTarget}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="font-headline">Warranty Watch</CardTitle>
                  <CardDescription>Home asset warranties expiring within the reminder window.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReminderList
                    reminders={warrantyReminders}
                    emptyTitle="No warranty reminders"
                    emptyDescription="Warranty expirations within the reminder window will appear here."
                    onOpen={openReminderTarget}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="font-headline">Vehicle Service Due</CardTitle>
                  <CardDescription>Vehicle service, registration, and inspection reminders.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReminderList
                    reminders={vehicleServiceReminders}
                    emptyTitle="No vehicle reminders"
                    emptyDescription="Mileage and date-based vehicle reminders will appear here."
                    onOpen={openReminderTarget}
                  />
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="logs" className="space-y-4 pt-4">
            <div className="flex justify-end">
              <Button onClick={() => openLogDialog()}>
                <Plus className="mr-2 h-4 w-4" />
                Add Maintenance Log
              </Button>
            </div>
            <LogList
              logs={logs}
              assets={assets}
              vehicles={vehicles}
              attachments={attachments}
              summaries={summaries}
              loadingSummaries={loadingSummaries}
              uploadingAttachmentTarget={uploadingAttachmentTarget}
              deletingAttachmentId={deletingAttachmentId}
              onSummarize={handleSummarize}
              onEdit={(log) => openLogDialog(undefined, log)}
              onDelete={setLogToDelete}
              onUploadAttachment={uploadAttachment}
              onDeleteAttachment={deleteAttachment}
            />
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
                            <p className="text-sm font-medium">Scheduled maintenance #{index + 1}</p>
                            <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => removeAssetSchedule(schedule.id)}>
                              Remove
                            </Button>
                          </div>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <FormItem>
                              <FormLabel>Schedule Name</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="Filter replacement"
                                  value={schedule.scheduleName}
                                  onChange={(event) => updateAssetSchedule(schedule.id, 'scheduleName', event.target.value)}
                                />
                              </FormControl>
                            </FormItem>
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
                          </div>
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
                            <p className="text-sm font-medium">Scheduled maintenance #{index + 1}</p>
                            <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => removeVehicleSchedule(schedule.id)}>
                              Remove
                            </Button>
                          </div>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <FormItem>
                              <FormLabel>Service Name</FormLabel>
                              <FormControl>
                                <Input
                                  placeholder="Brake fluid flush"
                                  value={schedule.serviceName}
                                  onChange={(event) => updateVehicleSchedule(schedule.id, 'serviceName', event.target.value)}
                                />
                              </FormControl>
                            </FormItem>
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
                          </div>
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
              onClick={deleteLog}
            >
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
              This will remove &quot;{vehicleToDelete?.nickname || 'this vehicle'}&quot; from the vehicle registry. Existing service logs will remain in maintenance history as unlinked vehicle logs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={deleteVehicle}
            >
              Delete Vehicle
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
