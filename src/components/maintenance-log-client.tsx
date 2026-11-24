"use client";

import * as React from 'react';
import { buildMaintenanceReminders, type MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { localDay, safeTimeZone } from '@functions/shared/calendar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAfter, subDays } from 'date-fns';
import {
  AlertCircle,
  
  
  
  
  
  
  
  
  
  Plus,
  
  
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
import {  type MarkDoneResult, type ReminderBusy } from '@/components/maintenance/reminder-list';
import { useInPageMorph } from '@/components/shopping/use-in-page-morph';
import { Button } from '@/components/ui/button';
import { Card, CardContent,  CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs,  TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { notificationsBySourceQuery } from '@/app/notifications/notification-query';
import { playFeedback } from '@/lib/feedback';
import { computeHomeHealth,  type HealthDeduction } from '@/lib/maintenance/health';
import {
  
  
  
  findReminderSchedule,
  
  
  quickCompletionValues,
  reminderCycleKey,
  serviceCompletionValues,
  
  type ScheduleCompletionTarget,
} from '@/lib/maintenance/schedules';
import {  stableSlugify } from '@/lib/utils';
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
import { cycleOf, mileageWarning, scheduleRef, type CompletionRefusal, type StoredSchedule } from '@/lib/maintenance/operations';
import { publicDisplayName } from '@/lib/member-directory';
import { collection, deleteDoc, deleteField, doc, getDocs, orderBy, query, setDoc, writeBatch } from 'firebase/firestore';
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { SignInPrompt } from '@/components/profile/sign-in-prompt';
import { AssetsTab } from '@/components/maintenance/assets-tab';
import { LogsTab } from '@/components/maintenance/logs-tab';
import { OverviewTab } from '@/components/maintenance/overview-tab';
import { RemindersTab } from '@/components/maintenance/reminders-tab';
import { VehiclesTab } from '@/components/maintenance/vehicles-tab';
import { AssetDialog, VehicleDialog } from '@/components/maintenance/record-dialogs';
import { LogDialog, type LogFormHandle } from '@/components/maintenance/log-dialog';
import { MileageDialog, ScheduleCompletionDialog, type CompletionFormHandle } from '@/components/maintenance/completion-dialogs';
import { DeleteDialogs } from '@/components/maintenance/delete-dialogs';
import {
        
   formatDate,  getAttachmentsForTarget, getLogTargetType, 
   isMaintenanceTab,    logValuesOf,  
        
    createLocalId, sanitizeFileName, cleanForFirestore, parseLogDate, toNumber, trimOptional,
    type AssetValues, type LogFormValues, type LogPreset, type LogValues, type MaintenanceTab,
  type SaveNoticeState, getScheduleCompletionName, type ScheduleCompletionFormValues,   
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
  const [deletingRecord, setDeletingRecord] = useState<string | null>(null);
  const [scheduleCompletionTarget, setScheduleCompletionTarget] = useState<ScheduleCompletionTarget | null>(null);
  /** The schedule a "Log service" log completes when saved (D16). */
  const [logScheduleTarget, setLogScheduleTarget] = useState<ScheduleCompletionTarget | null>(null);
  const [logPreset, setLogPreset] = useState<LogPreset | undefined>(undefined);
  // Bumped on every dialog opening: the dialog's form starts over from the record as it is then.
  const [dialogSession, setDialogSession] = useState(0);
  const [showInactiveVehicles, setShowInactiveVehicles] = useState(false);
  const [uploadingAttachmentTarget, setUploadingAttachmentTarget] = useState<string | null>(null);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [loadingSummaries, setLoadingSummaries] = useState<Record<string, boolean>>({});
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
  // Bumped by a successful Undo: the reminder lists start over, so the reopened cycle's
  // card (same cycle key as the one that was checked) shows unchecked with its actions.
  const [reminderListEpoch, setReminderListEpoch] = useState(0);





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
      recentLogs: recentLogs.length,
      recentCost,
      needingAttention,
    };
  }, [assets, logs, vehicles]);

  const openAssetDialog = (asset?: HomeAsset) => {
    setEditingAsset(asset || null);
    clearNotice('asset');
    discardPending('asset');
    setDialogSession(session => session + 1);
    setAssetDialogOpen(true);
  };

  const openVehicleDialog = (vehicle?: Vehicle) => {
    setEditingVehicle(vehicle || null);
    clearNotice('vehicle');
    discardPending('vehicle');
    setMileageCheck(null);
    setDialogSession(session => session + 1);
    setVehicleDialogOpen(true);
  };

  const openLogDialog = (preset?: LogPreset, log?: MaintenanceLog, schedule: ScheduleCompletionTarget | null = null) => {
    setEditingLog(log || null);
    setLogPreset(preset);
    setLogScheduleTarget(log ? null : schedule);
    clearNotice('log');
    discardPending('log');
    setMileageCheck(null);
    setDialogSession(session => session + 1);
    setLogDialogOpen(true);
  };











  const openScheduleCompletionDialog = (target: ScheduleCompletionTarget) => {
    setMileageCheck(null);
    clearNotice('complete');
    discardPending('complete');
    setDialogSession(session => session + 1);
    setScheduleCompletionTarget(target);
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

  const saveAsset = async ({ base, values }: { base?: AssetValues; values: AssetValues }) => {
    if (!currentUser?.householdId) return;
    const editing = editingAsset;
    const save: { opId: string; id?: string; base?: AssetValues; values: AssetValues } = {
      opId: newOpId(),
      ...(editing ? { id: editing.id, base } : {}),
      values,
    };
    await runOp('asset', save.opId, context => saveHomeAsset({ ...context, save }), async (result) => {
      setAssetDialogOpen(false);
      setSelectedAssetId(result.id);
      toast({ title: editing ? 'Asset updated' : 'Asset added' });
      await refreshMaintenanceData();
    }, 'dialog');
  };

  const saveVehicle = async ({ base, values: vehicleValues }: { base?: VehicleValues; values: VehicleValues }) => {
    if (!currentUser?.householdId) return;
    const editing = editingVehicle;
    // An edited odometer below (or far above) the recorded one asks first.
    if (editing && vehicleValues.currentMileage !== editing.currentMileage
      && !mileageConfirmed('vehicle', vehicleValues.currentMileage, editing.currentMileage)) return;
    const save: { opId: string; id?: string; base?: VehicleValues; values: VehicleValues } = {
      opId: newOpId(),
      ...(editing ? { id: editing.id, base } : {}),
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

  const saveLog = async ({ values, base }: { values: LogFormValues; base?: LogValues }, form: LogFormHandle) => {
    if (!currentUser?.householdId) return;

    const reading = values.targetType === 'vehicle' ? toNumber(values.mileage) : undefined;
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
        form.setError('mileage', 'Enter the mileage so the next service can be scheduled.');
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
          form.setError(field === 'completedDate' ? 'date' : 'mileage', refusalMessage(reason));
        },
      });
      return;
    }

    const editing = editingLog;
    const save: { opId: string; id?: string; base?: LogValues; values: LogValues } = {
      opId: newOpId(),
      ...(editing ? { id: editing.id, base } : {}),
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

  const completeScheduledMaintenance = async (values: ScheduleCompletionFormValues, form: CompletionFormHandle) => {
    if (!scheduleCompletionTarget) return;
    const target = scheduleCompletionTarget;
    const mileage = target.targetType === 'vehicle' ? toNumber(values.mileage) : undefined;
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
        setMileageCheck(null);
      },
      onRefused: reason => form.setError(refusalField(reason), refusalMessage(reason)),
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
    setDialogSession(session => session + 1);
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

  const submitMileageConfirm = async (reading: number, setMileageInputError: (message: string) => void) => {
    const target = mileageTarget;
    if (!target) return;
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

          <OverviewTab
            health={health}
            assets={assets}
            vehicles={vehicles}
            logs={logs}
            summary={summary}
            canEdit={canEdit}
            logListProps={logListProps}
            changeTab={changeTab}
            openAssetDialog={openAssetDialog}
            openVehicleDialog={openVehicleDialog}
            openTarget={openTarget}
            openHealthDeduction={openHealthDeduction}
          />

          <AssetsTab
            assets={assets}
            attachments={attachments}
            health={health}
            today={today}
            selectedAsset={selectedAsset}
            assetLogs={assetLogs}
            highlightedScheduleKey={highlightedScheduleKey}
            detailMorph={detailMorph}
            canEdit={canEdit}
            canDelete={canDelete}
            canComplete={canComplete}
            canCreateLogs={canCreateLogs}
            uploadingAttachmentTarget={uploadingAttachmentTarget}
            deletingAttachmentId={deletingAttachmentId}
            logListProps={logListProps}
            setSelectedAssetId={setSelectedAssetId}
            openAssetDialog={openAssetDialog}
            setAssetToDelete={setAssetToDelete}
            uploadAttachment={uploadAttachment}
            setAttachmentToDelete={setAttachmentToDelete}
            openScheduleCompletionDialog={openScheduleCompletionDialog}
            openLogDialog={openLogDialog}
          />

          <VehiclesTab
            vehicles={vehicles}
            activeVehicles={activeVehicles}
            inactiveVehicles={inactiveVehicles}
            attachments={attachments}
            health={health}
            selectedVehicle={selectedVehicle}
            vehicleLogs={vehicleLogs}
            highlightedScheduleKey={highlightedScheduleKey}
            detailMorph={detailMorph}
            showInactiveVehicles={showInactiveVehicles}
            canEdit={canEdit}
            canDelete={canDelete}
            canComplete={canComplete}
            canCreateLogs={canCreateLogs}
            uploadingAttachmentTarget={uploadingAttachmentTarget}
            deletingAttachmentId={deletingAttachmentId}
            logListProps={logListProps}
            setShowInactiveVehicles={setShowInactiveVehicles}
            setSelectedVehicleId={setSelectedVehicleId}
            openVehicleDialog={openVehicleDialog}
            setVehicleToDelete={setVehicleToDelete}
            uploadAttachment={uploadAttachment}
            setAttachmentToDelete={setAttachmentToDelete}
            openScheduleCompletionDialog={openScheduleCompletionDialog}
            openLogDialog={openLogDialog}
          />

          <RemindersTab
            dueSoonReminders={dueSoonReminders}
            overdueReminders={overdueReminders}
            warrantyReminders={warrantyReminders}
            vehicleServiceReminders={vehicleServiceReminders}
            reminderListProps={reminderListProps}
            reminderListEpoch={reminderListEpoch}
          />

          <LogsTab logs={logs} highlightedLogId={highlightedLogId} canCreateLogs={canCreateLogs} logListProps={logListProps} openLogDialog={openLogDialog} />
        </Tabs>
      </div>

      <AssetDialog
        open={assetDialogOpen}
        session={dialogSession}
        record={editingAsset}
        busy={Boolean(inFlight.asset)}
        notice={notices.asset}
        onOpenChange={(open) => {
          if (!open && !closable('asset')) return;
          setAssetDialogOpen(open);
        }}
        onSave={saveAsset}
      />

      <VehicleDialog
        open={vehicleDialogOpen}
        session={dialogSession}
        record={editingVehicle}
        busy={Boolean(inFlight.vehicle)}
        notice={notices.vehicle}
        mileageMessage={mileageCheck?.key === 'vehicle' ? mileageCheck.message : undefined}
        onOpenChange={(open) => {
          if (!open && !closable('vehicle')) return;
          setVehicleDialogOpen(open);
        }}
        onSave={saveVehicle}
      />

      <LogDialog
        open={logDialogOpen}
        session={dialogSession}
        record={editingLog}
        preset={logPreset}
        scheduleTarget={logScheduleTarget}
        assets={assets}
        vehicles={vehicles}
        today={today}
        busy={Boolean(inFlight.log)}
        notice={notices.log}
        mileageMessage={mileageCheck?.key === 'log' ? mileageCheck.message : undefined}
        onOpenChange={(open) => {
          if (!open && !closable('log')) return;
          setLogDialogOpen(open);
          if (!open) {
            setEditingLog(null);
            setLogScheduleTarget(null);
          }
        }}
        onSave={saveLog}
      />

      <ScheduleCompletionDialog
        target={scheduleCompletionTarget}
        session={dialogSession}
        today={today}
        busy={Boolean(inFlight.complete)}
        notice={notices.complete}
        mileageMessage={mileageCheck?.key === 'complete' ? mileageCheck.message : undefined}
        onOpenChange={(open) => {
          if (!open && !closable('complete')) return;
          if (!open) setScheduleCompletionTarget(null);
        }}
        onSubmit={completeScheduledMaintenance}
      />

      <MileageDialog
        target={mileageTarget}
        session={dialogSession}
        busy={Boolean(inFlight.mileage)}
        notice={notices.mileage}
        mileageMessage={mileageCheck?.key === 'mileage' ? mileageCheck.message : undefined}
        onOpenChange={(open) => {
          if (!open && !closable('mileage')) return;
          if (!open) {
            setMileageTarget(null);
            setMileageCheck(null);
          }
        }}
        onSubmit={submitMileageConfirm}
      />

      <DeleteDialogs
        attachmentToDelete={attachmentToDelete}
        setAttachmentToDelete={setAttachmentToDelete}
        deleteAttachment={deleteAttachment}
        deletingAttachmentId={deletingAttachmentId}
        assetToDelete={assetToDelete}
        setAssetToDelete={setAssetToDelete}
        deleteAsset={deleteAsset}
        logToDelete={logToDelete}
        setLogToDelete={setLogToDelete}
        deleteLog={deleteLog}
        vehicleToDelete={vehicleToDelete}
        setVehicleToDelete={setVehicleToDelete}
        deleteVehicle={deleteVehicle}
        deletingRecord={deletingRecord}
      />
    </>
  );
}
