"use client";

import * as React from 'react';
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
  DollarSign,
  Edit,
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
  MaintenanceLog,
  MaintenanceLogType,
  MaintenanceTargetType,
  Vehicle,
} from '@/lib/types';
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
import { collection, deleteDoc, doc, getDocs, orderBy, query, setDoc } from 'firebase/firestore';

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

type AssetFormValues = z.infer<typeof assetSchema>;
type VehicleFormValues = z.infer<typeof vehicleSchema>;
type LogFormValues = z.infer<typeof logSchema>;

type LogPreset = {
  targetType?: MaintenanceTargetType;
  assetId?: string;
  vehicleId?: string;
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
  summaries,
  loadingSummaries,
  onSummarize,
  onEdit,
  onDelete,
}: {
  logs: MaintenanceLog[];
  assets: HomeAsset[];
  vehicles: Vehicle[];
  summaries: Record<string, string>;
  loadingSummaries: Record<string, boolean>;
  onSummarize: (log: MaintenanceLog) => void;
  onEdit: (log: MaintenanceLog) => void;
  onDelete: (log: MaintenanceLog) => void;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const [vehicleDialogOpen, setVehicleDialogOpen] = useState(false);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<HomeAsset | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [editingLog, setEditingLog] = useState<MaintenanceLog | null>(null);
  const [logToDelete, setLogToDelete] = useState<MaintenanceLog | null>(null);
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

  const getCollectionRef = useCallback((collectionName: 'home-assets' | 'vehicles' | 'maintenance') => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, collectionName);
  }, [currentUser?.householdId]);

  const fetchMaintenanceData = useCallback(async () => {
    const assetsCollection = getCollectionRef('home-assets');
    const vehiclesCollection = getCollectionRef('vehicles');
    const logsCollection = getCollectionRef('maintenance');

    if (!assetsCollection || !vehiclesCollection || !logsCollection) {
      setAssets([]);
      setVehicles([]);
      setLogs([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [assetSnap, vehicleSnap, logSnap] = await Promise.all([
        getDocs(query(assetsCollection, orderBy('name', 'asc'))),
        getDocs(query(vehiclesCollection, orderBy('nickname', 'asc'))),
        getDocs(query(logsCollection, orderBy('date', 'desc'))),
      ]);

      setAssets(assetSnap.docs.map((assetDoc) => ({ id: assetDoc.id, ...assetDoc.data() } as HomeAsset)));
      setVehicles(vehicleSnap.docs.map((vehicleDoc) => ({ id: vehicleDoc.id, ...vehicleDoc.data() } as Vehicle)));
      setLogs(logSnap.docs.map((logDoc) => ({ id: logDoc.id, ...logDoc.data() } as MaintenanceLog)));
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
      setLoading(false);
    }
  }, [currentUser?.householdId, fetchMaintenanceData]);

  const selectedAsset = useMemo(() => {
    return assets.find((asset) => asset.id === selectedAssetId) || assets[0] || null;
  }, [assets, selectedAssetId]);

  const selectedVehicle = useMemo(() => {
    return vehicles.find((vehicle) => vehicle.id === selectedVehicleId) || vehicles[0] || null;
  }, [vehicles, selectedVehicleId]);

  const assetLogs = useMemo(() => {
    if (!selectedAsset) return [];
    return logs.filter((log) => getLogTargetType(log) === 'home_asset' && log.assetId === selectedAsset.id);
  }, [logs, selectedAsset]);

  const vehicleLogs = useMemo(() => {
    if (!selectedVehicle) return [];
    return logs.filter((log) => getLogTargetType(log) === 'vehicle' && log.vehicleId === selectedVehicle.id);
  }, [logs, selectedVehicle]);

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
      scheduleName: asset.schedules?.[0]?.scheduleName || '',
      frequencyType: asset.schedules?.[0]?.frequencyType,
      intervalValue: asset.schedules?.[0]?.intervalValue?.toString() || '',
      lastCompletedDate: asset.schedules?.[0]?.lastCompletedDate || '',
      nextDueDate: asset.schedules?.[0]?.nextDueDate || '',
    } : emptyAssetForm);
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
      serviceName: vehicle.serviceSchedules?.[0]?.serviceName || '',
      intervalMiles: vehicle.serviceSchedules?.[0]?.intervalMiles?.toString() || '',
      intervalMonths: vehicle.serviceSchedules?.[0]?.intervalMonths?.toString() || '',
      lastCompletedMileage: vehicle.serviceSchedules?.[0]?.lastCompletedMileage?.toString() || '',
      lastCompletedDate: vehicle.serviceSchedules?.[0]?.lastCompletedDate || '',
      nextDueMileage: vehicle.serviceSchedules?.[0]?.nextDueMileage?.toString() || '',
      nextDueDate: vehicle.serviceSchedules?.[0]?.nextDueDate || '',
    } : emptyVehicleForm);
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

  const saveAsset = async (values: AssetFormValues) => {
    if (!currentUser?.householdId) return;
    const assetsCollection = getCollectionRef('home-assets');
    if (!assetsCollection) return;

    const now = new Date().toISOString();
    const assetId = editingAsset?.id || slugify(values.name);
    const scheduleName = trimOptional(values.scheduleName);
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
      schedules: scheduleName ? [{
        scheduleName,
        frequencyType: values.frequencyType,
        intervalValue: toNumber(values.intervalValue),
        lastCompletedDate: trimOptional(values.lastCompletedDate),
        nextDueDate: trimOptional(values.nextDueDate),
      }] : [],
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
    const serviceName = trimOptional(values.serviceName);
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
      serviceSchedules: serviceName ? [{
        serviceName,
        intervalMiles: toNumber(values.intervalMiles),
        intervalMonths: toNumber(values.intervalMonths),
        lastCompletedMileage: toNumber(values.lastCompletedMileage),
        lastCompletedDate: trimOptional(values.lastCompletedDate),
        nextDueMileage: toNumber(values.nextDueMileage),
        nextDueDate: trimOptional(values.nextDueDate),
      }] : [],
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

  const deleteLog = async () => {
    if (!logToDelete) return;
    const logsCollection = getCollectionRef('maintenance');
    if (!logsCollection) return;

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

        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid h-auto w-full grid-cols-2 md:grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="assets">Home Assets</TabsTrigger>
            <TabsTrigger value="vehicles">Vehicles</TabsTrigger>
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
                    summaries={summaries}
                    loadingSummaries={loadingSummaries}
                    onSummarize={handleSummarize}
                    onEdit={(log) => openLogDialog(undefined, log)}
                    onDelete={setLogToDelete}
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
                      {selectedAsset.schedules?.[0]?.scheduleName && (
                        <div className="rounded-lg border p-3">
                          <p className="text-sm font-medium">{selectedAsset.schedules[0].scheduleName}</p>
                          <p className="text-sm text-muted-foreground">
                            Next due {formatDate(selectedAsset.schedules[0].nextDueDate)}
                          </p>
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
                        summaries={summaries}
                        loadingSummaries={loadingSummaries}
                        onSummarize={handleSummarize}
                        onEdit={(log) => openLogDialog(undefined, log)}
                        onDelete={setLogToDelete}
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
                <div className="grid gap-3 sm:grid-cols-2">
                  {vehicles.map((vehicle) => (
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

                {selectedVehicle && (
                  <Card>
                    <CardHeader className="flex flex-row items-start justify-between gap-3">
                      <div>
                        <CardTitle className="font-headline">{selectedVehicle.nickname}</CardTitle>
                        <CardDescription>{[selectedVehicle.year, selectedVehicle.make, selectedVehicle.model, selectedVehicle.trim].filter(Boolean).join(' ') || 'Vehicle details'}</CardDescription>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => openVehicleDialog(selectedVehicle)}>
                        <Edit className="mr-2 h-4 w-4" />
                        Edit
                      </Button>
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
                      {selectedVehicle.serviceSchedules?.[0]?.serviceName && (
                        <div className="rounded-lg border p-3">
                          <p className="text-sm font-medium">{selectedVehicle.serviceSchedules[0].serviceName}</p>
                          <p className="text-sm text-muted-foreground">
                            Next due {formatDate(selectedVehicle.serviceSchedules[0].nextDueDate)}
                            {typeof selectedVehicle.serviceSchedules[0].nextDueMileage === 'number' ? ` or ${selectedVehicle.serviceSchedules[0].nextDueMileage.toLocaleString()} miles` : ''}
                          </p>
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
                        summaries={summaries}
                        loadingSummaries={loadingSummaries}
                        onSummarize={handleSummarize}
                        onEdit={(log) => openLogDialog(undefined, log)}
                        onDelete={setLogToDelete}
                      />
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
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
              summaries={summaries}
              loadingSummaries={loadingSummaries}
              onSummarize={handleSummarize}
              onEdit={(log) => openLogDialog(undefined, log)}
              onDelete={setLogToDelete}
            />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={assetDialogOpen} onOpenChange={setAssetDialogOpen}>
        <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col overflow-hidden p-0">
          <DialogHeader className="px-6 pb-0 pr-10 pt-6">
            <DialogTitle>{editingAsset ? 'Edit Home Asset' : 'Add Home Asset'}</DialogTitle>
            <DialogDescription>Track core asset details. Uploads and manuals are intentionally deferred.</DialogDescription>
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
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                    <CalendarDays className="h-4 w-4" />
                    Future schedule fields
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField control={assetForm.control} name="scheduleName" render={({ field }) => (
                      <FormItem><FormLabel>Schedule Name</FormLabel><FormControl><Input placeholder="Filter replacement" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={assetForm.control} name="frequencyType" render={({ field }) => (
                      <FormItem><FormLabel>Frequency Type</FormLabel><Select onValueChange={field.onChange} value={field.value}><FormControl><SelectTrigger><SelectValue placeholder="Select frequency" /></SelectTrigger></FormControl><SelectContent>{frequencyTypes.map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select><FormMessage /></FormItem>
                    )} />
                    <FormField control={assetForm.control} name="intervalValue" render={({ field }) => (
                      <FormItem><FormLabel>Interval Value</FormLabel><FormControl><Input type="number" min="1" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={assetForm.control} name="lastCompletedDate" render={({ field }) => (
                      <FormItem><FormLabel>Last Completed</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={assetForm.control} name="nextDueDate" render={({ field }) => (
                      <FormItem><FormLabel>Next Due</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
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

      <Dialog open={vehicleDialogOpen} onOpenChange={setVehicleDialogOpen}>
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
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                    <Wrench className="h-4 w-4" />
                    Future service schedule fields
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField control={vehicleForm.control} name="serviceName" render={({ field }) => (
                      <FormItem><FormLabel>Service Name</FormLabel><FormControl><Input placeholder="Oil change" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={vehicleForm.control} name="intervalMiles" render={({ field }) => (
                      <FormItem><FormLabel>Interval Miles</FormLabel><FormControl><Input type="number" min="0" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={vehicleForm.control} name="intervalMonths" render={({ field }) => (
                      <FormItem><FormLabel>Interval Months</FormLabel><FormControl><Input type="number" min="0" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={vehicleForm.control} name="lastCompletedMileage" render={({ field }) => (
                      <FormItem><FormLabel>Last Completed Mileage</FormLabel><FormControl><Input type="number" min="0" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={vehicleForm.control} name="lastCompletedDate" render={({ field }) => (
                      <FormItem><FormLabel>Last Completed Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={vehicleForm.control} name="nextDueMileage" render={({ field }) => (
                      <FormItem><FormLabel>Next Due Mileage</FormLabel><FormControl><Input type="number" min="0" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={vehicleForm.control} name="nextDueDate" render={({ field }) => (
                      <FormItem><FormLabel>Next Due Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
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
    </>
  );
}
