"use client";

import * as React from 'react';
import { buildMaintenanceReminders, type MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { localDay, safeTimeZone } from '@functions/shared/calendar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { isAfter, subDays } from 'date-fns';
import {
  AlertCircle,
  CalendarDays,
  Car,
  ClipboardList,
  DollarSign,
  Edit,
  FileText,
  Home,
  Loader2,
  PencilLine,
  Plus,
  Trash2,
  Wrench,
} from 'lucide-react';
import { summarizeMaintenanceLog } from '@/ai/flows/summarize-maintenance-log';
import { AiClientError, getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import type {
  HomeAsset,
  MaintenanceAttachment,
  MaintenanceAttachmentCategory,
  MaintenanceAttachmentTargetType,
  MaintenanceLog,
  Notification,
  Vehicle,
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
import { ReminderList, type MarkDoneResult, type ReminderBusy } from '@/components/maintenance/reminder-list';
import { VehicleCard } from '@/components/maintenance/vehicle-card';
import { BrandLogo } from '@/components/brand/brand-logo';
import { PeekCard } from '@/components/dashboard/peek-card';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { useInPageMorph } from '@/components/shopping/use-in-page-morph';
import { morphStyle, sharedId } from '@/lib/motion';
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
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { notificationsBySourceQuery } from '@/app/notifications/notification-query';
import { playFeedback } from '@/lib/feedback';
import { pickAssetPhoto, pickVehiclePhoto, presentFields } from '@/lib/maintenance/display';
import { computeHomeHealth, healthKey, type HealthDeduction, type HealthResult } from '@/lib/maintenance/health';
import { warrantyCountdown } from '@/lib/maintenance/warranty';
import {
  calculateNextAssetDueDate,
  calculateNextVehicleDueDate,
  calculateNextVehicleMileage,
  findReminderSchedule,
  getAssetScheduleMode,
  getVehicleScheduleMode,
  quickCompletionValues,
  reminderCycleKey,
  serviceCompletionValues,
  scheduleKeyFor,
  type ScheduleCompletionTarget,
} from '@/lib/maintenance/schedules';
import { cn, stableSlugify } from '@/lib/utils';
import { ToastAction } from '@/components/ui/toast';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import {
  completeMaintenanceSchedule,
  saveHomeAsset,
  saveMaintenanceLog,
  saveVehicle as saveVehicleAction,
  snoozeMaintenanceSchedule,
  undoMaintenanceCompletion,
  undoMaintenanceSnooze,
  type MaintenanceActionResult,
} from '@/app/maintenance/actions';
import {
  CHANGED_MESSAGE,
  NO_ANSWER_MESSAGE,
  OFFLINE_MESSAGE,
  UNDO_HAS_ATTACHMENTS_MESSAGE,
  alreadyDoneMessage,
  callMaintenanceAction,
  keptMessage,
  mileageWarningMessage,
  newOpId,
  refusalField,
  refusalMessage,
} from '@/components/maintenance/maintenance-action-client';
import { createPendingRequests } from '@/lib/maintenance/action-call';
import { MAX_MILEAGE, cycleOf, mileageWarning, scheduleRef, type CompletionRefusal, type StoredSchedule } from '@/lib/maintenance/operations';
import { publicDisplayName } from '@/lib/member-directory';
import { collection, deleteDoc, deleteField, doc, getDocs, orderBy, query, setDoc, writeBatch } from 'firebase/firestore';
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';
import { AttachmentPanel } from '@/components/maintenance/attachment-panel';
import { LogList } from '@/components/maintenance/log-list';
import { AutoResizeTextarea, DetailGrid, MileageWarning, SaveNotice, SummaryCard } from '@/components/maintenance/page-parts';
import {
  assetCategories, assetFormFromRecord, assetScheduleToForm, assetStatuses, assetValuesOf, emptyAssetForm, emptyLogForm,
  emptyScheduleCompletionForm, emptyVehicleForm, formatDate, frequencyTypes, getAttachmentsForTarget, getLogTargetType, getLogTitle,
  humanizeLabel, isMaintenanceTab, logFormFromRecord, logSchema, logTypes, logValuesOf, MILEAGE_DUE_SOON_THRESHOLD, optionalCurrency,
  optionalDate, REMINDER_DUE_SOON_DAYS, assetSchema, scheduleCompletionSchema, vehicleFormFromRecord, vehicleScheduleToForm, vehicleSchema,
  vehicleStatuses, vehicleValuesOf, createLocalId, sanitizeFileName, cleanForFirestore, parseLogDate, toNumber, trimOptional, todayInputValue,
  type AssetFormValues, type AssetScheduleForm, type AssetValues, type LogFormValues, type LogPreset, type LogValues, type MaintenanceTab,
  type SaveNoticeState, type ScheduleCompletionFormValues, type ScheduleRemovalTarget, type VehicleFormValues, type VehicleScheduleForm,
  type VehicleValues,
} from '@/components/maintenance/page-model';

/** An unanswered request kept for the next press: same op id, same call, same handling. */
type HeldRequest<T, R> = {
  opId: string;
  call: (context: { idToken: string; householdId: string }) => Promise<MaintenanceActionResult<T>>;
  handle: (data: T) => Promise<R> | R;
};


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
  // Card -> detail panel shared-element morphs (H12), within this page.
  const detailMorph = useInPageMorph();
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
  /** The schedule a "Log service" log completes when saved (D16). */
  const [logScheduleTarget, setLogScheduleTarget] = useState<ScheduleCompletionTarget | null>(null);
  const [assetScheduleForms, setAssetScheduleForms] = useState<AssetScheduleForm[]>([]);
  const [vehicleScheduleForms, setVehicleScheduleForms] = useState<VehicleScheduleForm[]>([]);
  const [assetScheduleErrors, setAssetScheduleErrors] = useState<Record<string, string>>({});
  const [vehicleScheduleErrors, setVehicleScheduleErrors] = useState<Record<string, string>>({});
  const [showInactiveVehicles, setShowInactiveVehicles] = useState(false);
  const [uploadingAttachmentTarget, setUploadingAttachmentTarget] = useState<string | null>(null);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [loadingSummaries, setLoadingSummaries] = useState<Record<string, boolean>>({});
  // What each edit form showed when it opened (`base`): the server writes only what differs.
  const [assetBase, setAssetBase] = useState<AssetValues | null>(null);
  const [vehicleBase, setVehicleBase] = useState<VehicleValues | null>(null);
  const [logBase, setLogBase] = useState<LogValues | null>(null);
  // Requests in flight, by form or card action: their buttons are disabled with a spinner.
  const [inFlight, setInFlight] = useState<Record<string, boolean>>({});
  const inFlightRef = useRef(new Set<string>());
  // Requests with no answer yet, by form or card action (see createPendingRequests).
  const pendingRef = useRef(createPendingRequests<HeldRequest<unknown, unknown>>());
  // Offline / no answer / failure notes shown inside a dialog (with Retry when unknown).
  const [notices, setNotices] = useState<Record<string, SaveNoticeState | undefined>>({});
  const setNotice = useCallback((key: string, notice: SaveNoticeState) => setNotices(previous => ({ ...previous, [key]: notice })), []);
  const clearNotice = useCallback((key: string) => setNotices(previous => (previous[key] ? { ...previous, [key]: undefined } : previous)), []);
  // A reading lower than, or far above, the vehicle's asks once before it is saved (MA-6d).
  const [mileageCheck, setMileageCheck] = useState<{ key: string; reading: number; message: string } | null>(null);
  // Confirm mileage (MA-6a): Mark done on a service due by mileage asks for the odometer.
  const [mileageTarget, setMileageTarget] = useState<Extract<ScheduleCompletionTarget, { targetType: 'vehicle' }> | null>(null);
  const [mileageInput, setMileageInput] = useState('');
  const [mileageInputError, setMileageInputError] = useState<string | null>(null);
  // Bumped by a successful Undo: the reminder lists start over, so the reopened cycle's
  // card (same cycle key as the one that was checked) shows unchecked with its actions.
  const [reminderListEpoch, setReminderListEpoch] = useState(0);

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
    const storageRef = ref(getStorage(), filePath);
    let uploaded = false;

    try {
      await uploadBytes(storageRef, file, { contentType: file.type || undefined });
      uploaded = true;
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
        // Every member who can see maintenance reads it: never the email.
        uploadedByName: publicDisplayName(currentUser.displayName),
        createdAt: new Date().toISOString(),
      };

      try {
        await setDoc(doc(attachmentsCollection, attachmentId), cleanForFirestore(attachmentData));
      } catch (metadataError) {
        // Refused (for example the record was deleted, or a completion's log was undone,
        // meanwhile): the file just uploaded would be orphaned, so it is removed again.
        if (uploaded) await deleteObject(storageRef).catch((cleanupError) => console.error('Could not remove the uploaded file:', cleanupError));
        throw metadataError;
      }
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
    const form = asset ? assetFormFromRecord(asset) : emptyAssetForm;
    const scheduleForms = asset?.schedules?.map(assetScheduleToForm) || [];
    assetForm.reset(form);
    setAssetScheduleForms(scheduleForms);
    // What the form showed when it opened: only fields that differ from it are saved (MA-3c).
    setAssetBase(asset ? assetValuesOf(form, scheduleForms) : null);
    setAssetScheduleErrors({});
    clearNotice('asset');
    discardPending('asset');
    setAssetDialogOpen(true);
  };

  const openVehicleDialog = (vehicle?: Vehicle) => {
    setEditingVehicle(vehicle || null);
    const form = vehicle ? vehicleFormFromRecord(vehicle) : emptyVehicleForm;
    const scheduleForms = vehicle?.serviceSchedules?.map(vehicleScheduleToForm) || [];
    vehicleForm.reset(form);
    setVehicleScheduleForms(scheduleForms);
    setVehicleBase(vehicle ? vehicleValuesOf(form, scheduleForms) : null);
    setVehicleScheduleErrors({});
    clearNotice('vehicle');
    discardPending('vehicle');
    setMileageCheck(null);
    setVehicleDialogOpen(true);
  };

  const openLogDialog = (preset?: LogPreset, log?: MaintenanceLog, schedule: ScheduleCompletionTarget | null = null) => {
    setEditingLog(log || null);
    setLogScheduleTarget(log ? null : schedule);
    const form = log ? logFormFromRecord(log) : emptyLogForm(preset);
    logForm.reset(form);
    setLogBase(log ? logValuesOf(form) : null);
    clearNotice('log');
    discardPending('log');
    setMileageCheck(null);
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
    setMileageCheck(null);
    clearNotice('complete');
    discardPending('complete');
    setScheduleCompletionTarget(target);
  };

  // Moves focus to the first schedule with a problem (its name field) on submit.
  const focusScheduleField = (kind: 'asset' | 'vehicle', scheduleId?: string) => {
    if (!scheduleId) return;
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-schedule-name="${kind}-${CSS.escape(scheduleId)}"]`)?.focus());
  };

  /* ------------------------------------------------------------------------ */
  /* Server operations (M1): every save, completion and snooze goes through    */
  /* src/app/maintenance/actions.ts. One op id per press; Retry reuses it.      */
  /* ------------------------------------------------------------------------ */

  const runOp = async <T, R>(
    key: string,
    freshOpId: string,
    freshCall: (context: { idToken: string; householdId: string }) => Promise<MaintenanceActionResult<T>>,
    freshHandle: (data: T) => Promise<R> | R,
    surface: 'dialog' | 'toast',
  ): Promise<{ kind: 'ok'; value: R } | { kind: 'failed' | 'offline' | 'no_answer' | 'busy' }> => {
    const householdId = currentUser?.householdId;
    if (!householdId) return { kind: 'failed' };
    // A second press while the first is in flight does nothing (the button is disabled too).
    if (inFlightRef.current.has(key)) return { kind: 'busy' };
    // An earlier request of this form or card had no answer: it may have been saved, so this
    // press sends that same request again (same op id, same values), never a new one.
    const held = pendingRef.current.get(key) as HeldRequest<T, R> | undefined;
    const opId = held?.opId ?? freshOpId;
    const call = held?.call ?? freshCall;
    const handle = held?.handle ?? freshHandle;
    inFlightRef.current.add(key);
    setInFlight(previous => ({ ...previous, [key]: true }));
    clearNotice(key);
    try {
      const outcome = await callMaintenanceAction(householdId, call);
      if (outcome.kind === 'ok') {
        pendingRef.current.settle(key);
        return { kind: 'ok', value: await handle(outcome.data) };
      }
      if (outcome.kind === 'failed') {
        pendingRef.current.settle(key);
        if (surface === 'dialog') setNotice(key, { message: outcome.message });
        else toast({ variant: 'destructive', title: outcome.message });
        return { kind: 'failed' };
      }
      if (outcome.kind === 'offline') {
        if (surface === 'dialog') setNotice(key, { message: OFFLINE_MESSAGE });
        else toast({ title: OFFLINE_MESSAGE });
        return { kind: 'offline' };
      }
      // No answer: it may have been saved. Retry (or Save again) sends the same request.
      pendingRef.current.hold(key, { opId, call, handle } as HeldRequest<unknown, unknown>);
      const retry = () => { void runOp(key, opId, call, handle, surface); };
      if (surface === 'dialog') setNotice(key, { message: NO_ANSWER_MESSAGE, retry });
      else {
        const handleToast = toast({
          title: NO_ANSWER_MESSAGE,
          action: (
            <ToastAction altText="Retry" onClick={() => { handleToast.dismiss(); retry(); }}>Retry</ToastAction>
          ),
        });
      }
      return { kind: 'no_answer' };
    } finally {
      inFlightRef.current.delete(key);
      setInFlight(previous => ({ ...previous, [key]: false }));
    }
  };

  /** A dialog opened afresh: an unresolved request of its earlier form is discarded. */
  const discardPending = (key: string) => pendingRef.current.settle(key);

  /** Blocks closing a dialog while its request is in flight (the outcome must be known). */
  const closable = (key: string) => !inFlightRef.current.has(key);

  const ownerIdOf = (target: ScheduleCompletionTarget) => (target.targetType === 'home_asset' ? target.asset.id : target.vehicle.id);
  const ownerNameOf = (target: ScheduleCompletionTarget) => (target.targetType === 'home_asset' ? target.asset.name : target.vehicle.nickname);

  /** Asks once before saving an unusual reading; returns true when it may be saved. */
  const mileageConfirmed = (key: string, reading: number | undefined, current: number | undefined) => {
    const warning = mileageWarning(reading, current);
    if (!warning || typeof reading !== 'number' || typeof current !== 'number') return true;
    if (mileageCheck?.key === key && mileageCheck.reading === reading) return true;
    // The vehicle form's odometer is a correction (written as entered); everything else is a
    // reading under the max rule.
    setMileageCheck({ key, reading, message: mileageWarningMessage(warning, current, reading, key === 'vehicle' ? 'correction' : 'reading') });
    return false;
  };

  const undoCompletion = async (opId: string, title: string) => {
    const householdId = currentUser?.householdId;
    if (!householdId) return;
    const outcome = await callMaintenanceAction(householdId, context => undoMaintenanceCompletion({ ...context, opId }));
    if (outcome.kind !== 'ok') {
      toast({ variant: 'destructive', title: "Couldn't undo", description: outcome.kind === 'failed' ? outcome.message : outcome.kind === 'offline' ? OFFLINE_MESSAGE : NO_ANSWER_MESSAGE });
    } else if (outcome.data.status === 'undone') {
      setReminderListEpoch(epoch => epoch + 1);
      const kept = keptMessage(outcome.data.kept, 'marked it done');
      toast({ title: 'Undone', description: kept || `${title} is no longer marked done.` });
    } else if (outcome.data.status === 'superseded') {
      toast({ title: "Can't undo", description: 'It was marked done again since, so it stays done.' });
    } else if (outcome.data.status === 'has_attachments') {
      toast({ title: "Can't undo", description: UNDO_HAS_ATTACHMENTS_MESSAGE });
    } else if (outcome.data.status === 'expired') {
      toast({ title: "Can't undo", description: 'The time to undo has passed.' });
    }
    await refreshMaintenanceData();
  };

  const undoSnooze = async (opId: string) => {
    const householdId = currentUser?.householdId;
    if (!householdId) return;
    const outcome = await callMaintenanceAction(householdId, context => undoMaintenanceSnooze({ ...context, opId }));
    if (outcome.kind !== 'ok') {
      toast({ variant: 'destructive', title: "Couldn't undo", description: outcome.kind === 'failed' ? outcome.message : outcome.kind === 'offline' ? OFFLINE_MESSAGE : NO_ANSWER_MESSAGE });
    } else if (outcome.data.status === 'undone') {
      toast({ title: 'Snooze undone', description: keptMessage(outcome.data.kept, 'snoozed it') || undefined });
    } else if (outcome.data.status === 'expired') {
      toast({ title: "Can't undo", description: 'The time to undo has passed.' });
    }
    await refreshMaintenanceData();
  };

  /** The "done" toast with a 10 s Undo (the shared window). */
  const completedToast = (title: string, description: string, opId: string, undoLabel: string) => {
    const handle = toast({
      title,
      description,
      duration: UNDO_WINDOW_MS,
      action: (
        <ToastAction altText={`Undo marking ${undoLabel} done`} onClick={() => { handle.dismiss(); void undoCompletion(opId, undoLabel); }}>
          Undo
        </ToastAction>
      ),
    });
  };

  /**
   * Completes one cycle of a schedule on the server: one log, the schedule advanced by
   * its id, the vehicle's mileage (max rule) and the reminder resolved. The request names
   * the cycle this page showed, so a second session (or a double tap) cannot complete it
   * twice. Shared by the completion dialog, Log service, Mark done and Confirm mileage.
   */
  const completeSchedule = (
    key: string,
    target: ScheduleCompletionTarget,
    values: { completedDate: string; mileage?: number; nextDueDate?: string; nextDueMileage?: number; notes?: string },
    options: {
      details?: Pick<MaintenanceLog, 'title' | 'type' | 'cost' | 'partsUsed' | 'serviceProvider'>;
      surface: 'dialog' | 'toast';
      /** Runs once the outcome is final (closes the dialog). */
      settled?: () => void;
      onRefused: (reason: CompletionRefusal) => void;
      toastTitle: string;
    },
  ) => {
    const opId = newOpId();
    const completion = {
      opId,
      ownerType: target.targetType,
      ownerId: ownerIdOf(target),
      scheduleId: scheduleRef(target.schedule as StoredSchedule, target.scheduleIndex, target.targetType),
      seen: cycleOf(target.schedule as StoredSchedule),
      completedDate: values.completedDate,
      mileage: values.mileage,
      nextDueDate: values.nextDueDate,
      nextDueMileage: values.nextDueMileage,
      notes: trimOptional(values.notes),
      details: options.details,
    };
    const name = getScheduleCompletionName(target);
    return runOp(key, opId, context => completeMaintenanceSchedule({ ...context, completion }), async (result): Promise<MarkDoneResult> => {
      if (result.status === 'refused') {
        options.onRefused(result.reason);
        return 'failed';
      }
      options.settled?.();
      if (target.targetType === 'home_asset') setSelectedAssetId(target.asset.id);
      else setSelectedVehicleId(target.vehicle.id);
      if (result.status === 'completed') {
        playFeedback('complete');
        const next = result.next.nextDueDate ? ` Next due ${formatDate(result.next.nextDueDate)}.` : '';
        completedToast(options.toastTitle, `${name} for ${ownerNameOf(target)} is logged.${next}`, result.opId, name);
        if (result.cleanup === 'pending') console.info('Reminder cleanup is pending; the hourly upkeep finishes it.');
      } else if (result.status === 'already_done') {
        toast({ title: alreadyDoneMessage(result) });
      } else {
        toast({ title: CHANGED_MESSAGE });
      }
      await refreshMaintenanceData();
      return result.status === 'completed' || result.status === 'already_done' ? 'done' : 'failed';
    }, options.surface);
  };

  const saveAsset = async (values: AssetFormValues) => {
    if (!currentUser?.householdId) return;
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
    const editing = editingAsset;
    const save: { opId: string; id?: string; base?: AssetValues; values: AssetValues } = {
      opId: newOpId(),
      ...(editing ? { id: editing.id, base: assetBase ?? undefined } : {}),
      values: assetValuesOf(values, assetScheduleForms),
    };
    await runOp('asset', save.opId, context => saveHomeAsset({ ...context, save }), async (result) => {
      setAssetDialogOpen(false);
      setSelectedAssetId(result.id);
      toast({ title: editing ? 'Asset updated' : 'Asset added' });
      await refreshMaintenanceData();
    }, 'dialog');
  };

  const saveVehicle = async (values: VehicleFormValues) => {
    if (!currentUser?.householdId) return;
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
    const editing = editingVehicle;
    const vehicleValues = vehicleValuesOf(values, vehicleScheduleForms);
    // An edited odometer below (or far above) the recorded one asks first.
    if (editing && vehicleValues.currentMileage !== editing.currentMileage
      && !mileageConfirmed('vehicle', vehicleValues.currentMileage, editing.currentMileage)) return;
    const save: { opId: string; id?: string; base?: VehicleValues; values: VehicleValues } = {
      opId: newOpId(),
      ...(editing ? { id: editing.id, base: vehicleBase ?? undefined } : {}),
      values: vehicleValues,
    };
    await runOp('vehicle', save.opId, context => saveVehicleAction({ ...context, save }), async (result) => {
      setVehicleDialogOpen(false);
      setMileageCheck(null);
      setSelectedVehicleId(result.id);
      toast({ title: editing ? 'Vehicle updated' : 'Vehicle added' });
      await refreshMaintenanceData();
    }, 'dialog');
  };

  const saveLog = async (values: LogFormValues) => {
    if (!currentUser?.householdId) return;

    // Field problems are shown under the field (FormMessage), never as a toast.
    if (values.targetType === 'home_asset' && !values.assetId) {
      logForm.setError('assetId', { message: 'Choose a home asset or switch the log to general.' }, { shouldFocus: true });
      return;
    }

    if (values.targetType === 'vehicle' && !values.vehicleId) {
      logForm.setError('vehicleId', { message: 'Choose a vehicle or switch the log to general.' }, { shouldFocus: true });
      return;
    }

    const reading = values.targetType === 'vehicle' ? toNumber(values.mileage) : undefined;
    if (typeof reading === 'number' && (!Number.isInteger(reading) || reading < 0 || reading > MAX_MILEAGE)) {
      logForm.setError('mileage', { message: 'Enter the mileage as a whole number.' }, { shouldFocus: true });
      return;
    }
    const logVehicle = values.targetType === 'vehicle' ? vehicles.find(vehicle => vehicle.id === values.vehicleId) : undefined;
    const readingChanged = !editingLog || reading !== editingLog.mileage;
    if (readingChanged && !mileageConfirmed('log', reading, logVehicle?.currentMileage)) return;

    // Log service: a new log for the reminder's own asset or vehicle also
    // completes that schedule cycle. Switching the form to another target makes it
    // an ordinary log.
    const linked = !editingLog && logScheduleTarget && (
      logScheduleTarget.targetType === 'home_asset'
        ? values.targetType === 'home_asset' && values.assetId === logScheduleTarget.asset.id
        : values.targetType === 'vehicle' && values.vehicleId === logScheduleTarget.vehicle.id
    ) ? logScheduleTarget : null;
    if (linked) {
      // Never write a schedule without a next due: the advanced values must be
      // computable from the log (Log service opens only for such schedules, so
      // the only way to miss is a cleared mileage on a mileage-interval service).
      const completion = serviceCompletionValues(linked, values.date, linked.targetType === 'vehicle' ? reading : undefined);
      if (!completion) {
        logForm.setError('mileage', { message: 'Enter the mileage so the next service can be scheduled.' }, { shouldFocus: true });
        return;
      }
      await completeSchedule('log', linked, { ...completion, notes: values.notes }, {
        details: {
          title: values.title.trim(),
          type: values.type,
          cost: toNumber(values.cost),
          partsUsed: trimOptional(values.partsUsed),
          serviceProvider: trimOptional(values.serviceProvider),
        },
        surface: 'dialog',
        toastTitle: 'Service logged',
        settled: () => {
          setLogDialogOpen(false);
          setLogScheduleTarget(null);
          setMileageCheck(null);
        },
        onRefused: reason => {
          const field = refusalField(reason);
          logForm.setError(field === 'completedDate' ? 'date' : 'mileage', { message: refusalMessage(reason) }, { shouldFocus: true });
        },
      });
      return;
    }

    const editing = editingLog;
    const save: { opId: string; id?: string; base?: LogValues; values: LogValues } = {
      opId: newOpId(),
      ...(editing ? { id: editing.id, base: logBase ?? undefined } : {}),
      values: logValuesOf(values),
    };
    await runOp('log', save.opId, context => saveMaintenanceLog({ ...context, save }), async () => {
      setLogDialogOpen(false);
      setEditingLog(null);
      setMileageCheck(null);
      toast({ title: editing ? 'Maintenance log updated' : 'Maintenance log added' });
      await refreshMaintenanceData();
    }, 'dialog');
  };

  const completeScheduledMaintenance = async (values: ScheduleCompletionFormValues) => {
    if (!scheduleCompletionTarget) return;
    const target = scheduleCompletionTarget;
    const mileage = target.targetType === 'vehicle' ? toNumber(values.mileage) : undefined;
    if (typeof mileage === 'number' && (!Number.isInteger(mileage) || mileage < 0 || mileage > MAX_MILEAGE)) {
      scheduleCompletionForm.setError('mileage', { message: 'Enter the mileage as a whole number.' }, { shouldFocus: true });
      return;
    }
    if (target.targetType === 'vehicle' && !mileageConfirmed('complete', mileage, target.vehicle.currentMileage)) return;
    await completeSchedule('complete', target, {
      completedDate: values.completedDate,
      mileage,
      nextDueDate: trimOptional(values.nextDueDate),
      nextDueMileage: toNumber(values.nextDueMileage),
      notes: values.notes,
    }, {
      surface: 'dialog',
      toastTitle: 'Scheduled maintenance completed',
      settled: () => {
        setScheduleCompletionTarget(null);
        scheduleCompletionForm.reset(emptyScheduleCompletionForm());
        setMileageCheck(null);
      },
      onRefused: reason => scheduleCompletionForm.setError(refusalField(reason), { message: refusalMessage(reason) }, { shouldFocus: true }),
    });
  };

  /**
   * A vehicle service with a mileage interval asks for the odometer first (MA-6a). One with
   * only a set due mileage and no interval opens the completion dialog instead, where the
   * next due is typed (the server refuses it without a reading: `mileage_required`).
   */
  const needsMileageReading = (target: ScheduleCompletionTarget) =>
    target.targetType === 'vehicle' && Boolean(target.schedule.intervalMiles);

  /**
   * One-tap Mark done from a reminder card. When the next due date or mileage
   * cannot be worked out (no interval), the completion dialog opens instead so
   * nothing is guessed; a service due by mileage opens Confirm mileage.
   */
  const reminderCompletesInPlace = (reminder: MaintenanceReminder) => {
    const target = findReminderSchedule(reminder, assets, vehicles);
    return Boolean(target && !needsMileageReading(target) && quickCompletionValues(target, today));
  };

  const openMileageConfirm = (target: Extract<ScheduleCompletionTarget, { targetType: 'vehicle' }>) => {
    setMileageCheck(null);
    clearNotice('mileage');
    discardPending('mileage');
    setMileageInput(typeof target.vehicle.currentMileage === 'number' ? String(target.vehicle.currentMileage) : '');
    setMileageInputError(null);
    setMileageTarget(target);
  };

  const markReminderDone = async (reminder: MaintenanceReminder): Promise<MarkDoneResult> => {
    if (reminderBusy || !canComplete) return 'failed';
    const target = findReminderSchedule(reminder, assets, vehicles);
    if (!target) {
      openReminderTarget(reminder);
      return 'deferred';
    }
    if (target.targetType === 'vehicle' && needsMileageReading(target)) {
      openMileageConfirm(target);
      return 'deferred';
    }
    const values = quickCompletionValues(target, today);
    if (!values) {
      openScheduleCompletionDialog(target);
      return 'deferred';
    }
    setReminderBusy({ id: reminder.id, action: 'done' });
    try {
      const outcome = await completeSchedule(`done:${reminderCycleKey(reminder)}`, target, values, {
        surface: 'toast',
        toastTitle: 'Marked done',
        onRefused: reason => toast({ variant: 'destructive', title: refusalMessage(reason) }),
      });
      return outcome.kind === 'ok' ? outcome.value : 'failed';
    } finally {
      setReminderBusy(null);
    }
  };

  const submitMileageConfirm = async () => {
    const target = mileageTarget;
    if (!target) return;
    const reading = Number(mileageInput.trim());
    if (!mileageInput.trim() || !Number.isInteger(reading) || reading < 0 || reading > MAX_MILEAGE) {
      setMileageInputError('Enter the odometer reading as a whole number.');
      return;
    }
    setMileageInputError(null);
    if (!mileageConfirmed('mileage', reading, target.vehicle.currentMileage)) return;
    const values = serviceCompletionValues(target, today, reading);
    if (!values) {
      setMileageInputError('Enter the odometer reading so the next service can be scheduled.');
      return;
    }
    await completeSchedule('mileage', target, values, {
      surface: 'dialog',
      toastTitle: 'Marked done',
      settled: () => {
        setMileageTarget(null);
        setMileageCheck(null);
      },
      onRefused: reason => setMileageInputError(refusalMessage(reason)),
    });
  };

  /**
   * Log service (D16): the full log form, filled in for the reminder's asset or
   * vehicle and schedule (title, type, today, current mileage). Saving it records
   * the log and completes that schedule cycle, like Mark done but with the
   * details. A reminder without a schedule (it was removed) opens a plain log
   * for the same asset or vehicle.
   */
  const openLogService = (reminder: MaintenanceReminder) => {
    if (!canCreateLogs) return;
    const target = findReminderSchedule(reminder, assets, vehicles);
    // Like Mark done: a schedule whose next due cannot be advanced from its
    // interval (an explicit date or mileage with no repeat) is completed in the
    // completion dialog, where the next due values are entered.
    if (target && canComplete && !quickCompletionValues(target, today) && !needsMileageReading(target)) {
      openScheduleCompletionDialog(target);
      return;
    }
    const vehicle = reminder.targetType === 'vehicle' ? vehicles.find((item) => item.id === reminder.targetId) : undefined;
    openLogDialog({
      targetType: reminder.targetType,
      assetId: reminder.targetType === 'home_asset' ? reminder.targetId : undefined,
      vehicleId: reminder.targetType === 'vehicle' ? reminder.targetId : undefined,
      title: target ? getScheduleCompletionName(target) : reminder.title,
      mileage: typeof vehicle?.currentMileage === 'number' ? vehicle.currentMileage.toString() : undefined,
    }, undefined, canComplete ? target : null);
  };

  /**
   * Snooze moves the schedule's next due date a week past the later of today and
   * the current due date, on the server, by the schedule's id and only while it is
   * still the cycle this card shows; the reminder is resolved after it. Undo for 10 s.
   */
  const snoozeReminder = async (reminder: MaintenanceReminder) => {
    if (reminderBusy || !canEdit) return;
    const target = findReminderSchedule(reminder, assets, vehicles);
    if (!target) return;
    const opId = newOpId();
    const snooze = {
      opId,
      ownerType: target.targetType,
      ownerId: ownerIdOf(target),
      scheduleId: scheduleRef(target.schedule as StoredSchedule, target.scheduleIndex, target.targetType),
      seen: cycleOf(target.schedule as StoredSchedule),
    };
    setReminderBusy({ id: reminder.id, action: 'snooze' });
    try {
      await runOp(`snooze:${reminderCycleKey(reminder)}`, opId, context => snoozeMaintenanceSchedule({ ...context, snooze }), async (result) => {
        if (result.status === 'snoozed') {
          const handle = toast({
            title: 'Snoozed for a week',
            description: `${reminder.title} for ${reminder.relatedName} is now due ${formatDate(result.nextDueDate)}.`,
            duration: UNDO_WINDOW_MS,
            action: (
              <ToastAction altText={`Undo snoozing ${reminder.title}`} onClick={() => { handle.dismiss(); void undoSnooze(result.opId); }}>
                Undo
              </ToastAction>
            ),
          });
        } else if (result.status === 'refused') {
          toast({ title: "This can't be snoozed", description: 'Only date-driven reminders that are due soon or overdue can be snoozed.' });
        } else {
          toast({ title: CHANGED_MESSAGE });
        }
        await refreshMaintenanceData();
      }, 'toast');
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

  const registrySourceTypes = (targetType: 'home_asset' | 'vehicle') => targetType === 'home_asset'
    ? ['maintenance_asset_schedule', 'maintenance_asset_warranty']
    : ['maintenance_vehicle_service', 'maintenance_vehicle_registration', 'maintenance_vehicle_inspection'];

  const notificationBelongsToRegistryRecord = (
    notification: Notification,
    targetType: 'home_asset' | 'vehicle',
    targetId: string
  ) => {
    const sourceTypes = registrySourceTypes(targetType);
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
    if (!currentUser?.householdId || !currentUser.uid || deletingRecord) return;
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
        // Household-wide reminders (audience ['*']) of this record's source types;
        // the source id prefix match stays below.
        getDocs(notificationsBySourceQuery(notificationsCollection, currentUser.uid, registrySourceTypes(targetType))),
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
    return <SignInPrompt what="manage maintenance" />;
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
    canLog: canCreateLogs,
    canSnooze: canEdit,
    busy: reminderBusy,
    completesInPlace: reminderCompletesInPlace,
    onOpen: openReminderTarget,
    onMarkDone: markReminderDone,
    onLogService: openLogService,
    onSnooze: (reminder: MaintenanceReminder) => void snoozeReminder(reminder),
  };

  // Peek cards (H26) for links that leave the current view: key facts at a glance.
  const healthLine = (result?: HealthResult) => (result ? `Health ${result.score}` : null);
  const assetPeek = (asset: HomeAsset) => {
    const facts = [healthLine(healthFor('home_asset', asset.id)), asset.location].filter(Boolean).join(' · ');
    return (
      <div className="space-y-1">
        <p className="font-headline font-semibold">{asset.name}</p>
        <p className="text-muted-foreground">{[asset.brand, asset.model].filter(Boolean).join(' ') || asset.category}</p>
        {facts && <p className="text-xs text-muted-foreground">{facts}</p>}
      </div>
    );
  };
  const vehiclePeek = (vehicle: Vehicle) => {
    const mileage = typeof vehicle.currentMileage === 'number' ? `${vehicle.currentMileage.toLocaleString('en-US')} mi` : null;
    const facts = [healthLine(healthFor('vehicle', vehicle.id)), mileage].filter(Boolean).join(' · ');
    return (
      <div className="space-y-1">
        <p className="font-headline font-semibold">{vehicle.nickname}</p>
        <p className="text-muted-foreground">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</p>
        {facts && <p className="text-xs text-muted-foreground">{facts}</p>}
      </div>
    );
  };

  const renderVehicleCard = (vehicle: Vehicle, inactive: boolean) => {
    const morph = sharedId('vehicle', vehicle.id);
    const selected = selectedVehicle?.id === vehicle.id;
    return (
      <VehicleCard
        vehicle={vehicle}
        photo={pickVehiclePhoto(attachments, vehicle.id)}
        health={healthFor('vehicle', vehicle.id)}
        selected={selected}
        inactive={inactive}
        statusLabel={inactive ? humanizeLabel(vehicle.status) : undefined}
        style={morphStyle(detailMorph.morphName === morph && !selected ? morph : null)}
        onSelect={(event) => {
          if (selected) return;
          detailMorph.run(morph, () => setSelectedVehicleId(vehicle.id), { sync: true, event });
        }}
      />
    );
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
    // Fits one row in the 320-420 px detail column; wraps only on very narrow screens.
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2 border-t pt-4">
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
          <span className="sr-only">({missing} empty)</span>
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
              <SummaryCard title="Home Assets" value={assets.length} detail="Registered household assets" icon={Home} />
              <SummaryCard title="Vehicles" value={vehicles.length} detail="Registered vehicles" icon={Car} />
              <SummaryCard title="Logged, Last 30 Days" value={summary.recentLogs.length} detail="Logs dated in the last 30 days" icon={ClipboardList} />
              <SummaryCard title="Needs Attention" value={summary.needingAttention} detail="Assets or vehicles flagged" icon={AlertCircle} />
              <SummaryCard title="Spent, Last 30 Days" value={summary.recentCost} format={{ style: 'currency', currency: 'USD' }} detail="Costs on logs from the last 30 days" icon={DollarSign} />
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
                        <PeekCard key={asset.id} peek={assetPeek(asset)}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-ui hover:bg-accent"
                            onClick={() => openTarget({ targetType: 'home_asset', targetId: asset.id, deepLink: `/maintenance?asset=${encodeURIComponent(asset.id)}` })}
                          >
                            <BrandLogo brand={asset.brand} size="sm" className="text-muted-foreground" />
                            <span className="min-w-0">
                              <span className="block font-medium">{asset.name}</span>
                              <span className="block text-sm text-muted-foreground">{[asset.category, asset.location].filter(Boolean).join(' · ')}</span>
                            </span>
                          </button>
                        </PeekCard>
                      ))}
                      {flaggedVehicles.map(vehicle => (
                        <PeekCard key={vehicle.id} peek={vehiclePeek(vehicle)}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-ui hover:bg-accent"
                            onClick={() => openTarget({ targetType: 'vehicle', targetId: vehicle.id, deepLink: `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}` })}
                          >
                            <BrandLogo brand={vehicle.make} size="sm" decorative className="text-muted-foreground" />
                            <span className="min-w-0">
                              <span className="block font-medium">{vehicle.nickname}</span>
                              <span className="block text-sm text-muted-foreground">{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</span>
                            </span>
                          </button>
                        </PeekCard>
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
                <Stagger className="grid content-start gap-3 sm:grid-cols-2">
                  {assets.map((asset) => {
                    const morph = sharedId('asset', asset.id);
                    const selected = selectedAsset?.id === asset.id;
                    return (
                      <StaggerItem key={asset.id} className="flex" style={morphStyle(detailMorph.morphName === morph && !selected ? morph : null)}>
                        <AssetCard
                          asset={asset}
                          photo={pickAssetPhoto(attachments, asset.id)}
                          health={healthFor('home_asset', asset.id)}
                          warranty={warrantyCountdown(asset, today)}
                          selected={selected}
                          onSelect={(event) => {
                            if (selected) return;
                            detailMorph.run(morph, () => setSelectedAssetId(asset.id), { sync: true, event });
                          }}
                        />
                      </StaggerItem>
                    );
                  })}
                </Stagger>

                {selectedAsset && (
                  <Card className="min-w-0" data-testid="asset-detail" style={morphStyle(detailMorph.morphName === sharedId('asset', selectedAsset.id) ? sharedId('asset', selectedAsset.id) : null)}>
                    <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                      {/* The brand is listed as text in the details below, so the mark is decorative. */}
                      <BrandLogo brand={selectedAsset.brand} size="md" decorative className="text-primary" />
                      <div className="min-w-0 flex-1">
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
                    <Stagger className="grid content-start gap-3 sm:grid-cols-2">
                      {activeVehicles.map((vehicle) => (
                        <StaggerItem key={vehicle.id} className="flex">
                          {renderVehicleCard(vehicle, false)}
                        </StaggerItem>
                      ))}
                    </Stagger>
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
                            <div key={vehicle.id} className="flex">{renderVehicleCard(vehicle, true)}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {selectedVehicle && (
                  <Card className="min-w-0" data-testid="vehicle-detail" style={morphStyle(detailMorph.morphName === sharedId('vehicle', selectedVehicle.id) ? sharedId('vehicle', selectedVehicle.id) : null)}>
                    <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                      {/* The make is part of the description below, so the mark is decorative. */}
                      <BrandLogo brand={selectedVehicle.make} size="md" decorative className="text-primary" />
                      <div className="min-w-0 flex-1">
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
              <SummaryCard title="Due Soon" value={dueSoonReminders.length} detail={`Within ${REMINDER_DUE_SOON_DAYS} days or ${MILEAGE_DUE_SOON_THRESHOLD} miles`} icon={CalendarDays} />
              <SummaryCard title="Overdue" value={overdueReminders.length} detail="Past due date or mileage" icon={AlertCircle} />
              <SummaryCard title="Warranty Watch" value={warrantyReminders.length} detail="Warranties ending or ended" icon={FileText} />
              <SummaryCard title="Vehicle Service" value={vehicleServiceReminders.length} detail="Service, registration, and inspection" icon={Car} />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card data-testid="reminders-due-soon">
                <CardHeader>
                  <CardTitle className="font-headline">Due Soon</CardTitle>
                  <CardDescription>Maintenance due today or within the default reminder window.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ReminderList
                    key={reminderListEpoch}
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
                    key={reminderListEpoch}
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
                    key={reminderListEpoch}
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
                    key={reminderListEpoch}
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
        if (!open && !closable('asset')) return;
        setAssetDialogOpen(open);
        if (!open) setAssetScheduleForms([]);
      }}>
        <DialogContent className="flex max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))] max-w-3xl flex-col overflow-hidden p-0">
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
                <Button type="button" variant="secondary" disabled={Boolean(inFlight.asset)} onClick={() => setAssetDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={Boolean(inFlight.asset)}>
                  {inFlight.asset && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
                  Save Asset
                </Button>
              </DialogFooter>
              <SaveNotice notice={notices.asset} busy={Boolean(inFlight.asset)} />
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={vehicleDialogOpen} onOpenChange={(open) => {
        if (!open && !closable('vehicle')) return;
        setVehicleDialogOpen(open);
        if (!open) setVehicleScheduleForms([]);
      }}>
        <DialogContent className="flex max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))] max-w-3xl flex-col overflow-hidden p-0">
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
              {mileageCheck?.key === 'vehicle' && (
                <div className="px-6 pb-3">
                  <MileageWarning message={mileageCheck.message} />
                </div>
              )}
              <DialogFooter className="border-t px-6 py-4">
                <Button type="button" variant="secondary" disabled={Boolean(inFlight.vehicle)} onClick={() => setVehicleDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={Boolean(inFlight.vehicle)}>
                  {inFlight.vehicle && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
                  {mileageCheck?.key === 'vehicle' ? 'Save anyway' : 'Save Vehicle'}
                </Button>
              </DialogFooter>
              <SaveNotice notice={notices.vehicle} busy={Boolean(inFlight.vehicle)} />
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={logDialogOpen} onOpenChange={(open) => {
        if (!open && !closable('log')) return;
        setLogDialogOpen(open);
        if (!open) {
          setEditingLog(null);
          setLogScheduleTarget(null);
        }
      }}>
        <DialogContent className="flex max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))] max-w-2xl flex-col overflow-hidden p-0">
          <DialogHeader className="px-6 pb-0 pr-10 pt-6">
            <DialogTitle>{editingLog ? 'Edit Maintenance Log' : 'Add Maintenance Log'}</DialogTitle>
            <DialogDescription>
              {logScheduleTarget
                ? `Saving marks ${getScheduleCompletionName(logScheduleTarget)} done for ${logScheduleTarget.targetType === 'home_asset' ? logScheduleTarget.asset.name : logScheduleTarget.vehicle.nickname} and sets when it is next due.`
                : 'Link a log to a home asset, vehicle, or keep it general.'}
            </DialogDescription>
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
                    <FormItem><FormLabel>Mileage</FormLabel><FormControl><Input type="number" inputMode="numeric" min="0" step="1" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                )}
                <MileageWarning message={mileageCheck?.key === 'log' ? mileageCheck.message : undefined} />
                <FormField control={logForm.control} name="notes" render={({ field }) => (
                  <FormItem className="sm:col-span-2"><FormLabel>Notes</FormLabel><FormControl><AutoResizeTextarea rows={4} placeholder="Describe what happened, what was done, and any follow-up needed." {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                </div>
              </div>
              <DialogFooter className="border-t px-6 py-4">
                <Button type="button" variant="secondary" disabled={Boolean(inFlight.log)} onClick={() => setLogDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={Boolean(inFlight.log)}>
                  {inFlight.log && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
                  {mileageCheck?.key === 'log' ? 'Save anyway' : editingLog ? 'Update Log' : 'Save Log'}
                </Button>
              </DialogFooter>
              <SaveNotice notice={notices.log} busy={Boolean(inFlight.log)} />
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!scheduleCompletionTarget} onOpenChange={(open) => {
        if (!open && !closable('complete')) return;
        if (!open) {
          setScheduleCompletionTarget(null);
          scheduleCompletionForm.reset(emptyScheduleCompletionForm());
        }
      }}>
        <DialogContent className="flex max-h-[min(90vh,calc(var(--dialog-max-h)_-_var(--keyboard-inset,0px)))] max-w-xl flex-col overflow-hidden p-0">
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
                            inputMode="numeric"
                            min="0"
                            step="1"
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
                  <MileageWarning message={mileageCheck?.key === 'complete' ? mileageCheck.message : undefined} />
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
                <Button type="button" variant="secondary" disabled={Boolean(inFlight.complete)} onClick={() => setScheduleCompletionTarget(null)}>Cancel</Button>
                <Button type="submit" disabled={Boolean(inFlight.complete)}>
                  {inFlight.complete && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
                  {mileageCheck?.key === 'complete' ? 'Save anyway' : 'Complete Maintenance'}
                </Button>
              </DialogFooter>
              <SaveNotice notice={notices.complete} busy={Boolean(inFlight.complete)} />
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!mileageTarget} onOpenChange={(open) => {
        if (!open && !closable('mileage')) return;
        if (!open) {
          setMileageTarget(null);
          setMileageCheck(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm mileage</DialogTitle>
            <DialogDescription>
              {mileageTarget
                ? `${getScheduleCompletionName(mileageTarget)} for ${mileageTarget.vehicle.nickname}: the odometer reading now, so the next service is scheduled from it.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitMileageConfirm();
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
            <MileageWarning message={mileageCheck?.key === 'mileage' ? mileageCheck.message : undefined} />
            <DialogFooter>
              <Button type="button" variant="secondary" disabled={Boolean(inFlight.mileage)} onClick={() => { setMileageTarget(null); setMileageCheck(null); }}>Cancel</Button>
              <Button type="submit" disabled={Boolean(inFlight.mileage)}>
                {inFlight.mileage && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
                {mileageCheck?.key === 'mileage' ? 'Save anyway' : 'Mark done'}
              </Button>
            </DialogFooter>
          </form>
          <SaveNotice notice={notices.mileage} busy={Boolean(inFlight.mileage)} />
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
