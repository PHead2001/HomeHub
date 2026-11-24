"use client";

import * as React from 'react';
import { buildMaintenanceReminders, type MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { AlertCircle, Plus } from 'lucide-react';
import type { HomeAsset, MaintenanceLog, Vehicle } from '@/lib/types';
import { EmptyState } from '@/components/empty-state';
import { type MarkDoneResult, type ReminderBusy } from '@/components/maintenance/reminder-list';
import { useInPageMorph } from '@/components/shopping/use-in-page-morph';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { computeHomeHealth, type HealthDeduction } from '@/lib/maintenance/health';
import {
  findReminderSchedule, quickCompletionValues, reminderCycleKey, serviceCompletionValues, type ScheduleCompletionTarget,
} from '@/lib/maintenance/schedules';
import { ToastAction } from '@/components/ui/toast';
import { undoOfferMs } from '@/lib/maintenance/action-call';
import { saveHomeAsset, saveMaintenanceLog, saveVehicle as saveVehicleAction, snoozeMaintenanceSchedule } from '@/app/maintenance/actions';
import { CHANGED_MESSAGE, newOpId, refusalField, refusalMessage } from '@/components/maintenance/maintenance-action-client';
import { cycleOf, scheduleRef, type StoredSchedule } from '@/lib/maintenance/operations';
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
import { useMaintenanceLiveData } from '@/components/maintenance/use-maintenance-data';
import { useMaintenanceOps } from '@/components/maintenance/use-maintenance-ops';
import { useStableHandler } from '@/components/maintenance/use-stable-handler';
import { useMaintenanceNavigation } from '@/components/maintenance/use-maintenance-navigation';
import { useMaintenanceRecords } from '@/components/maintenance/use-maintenance-records';
import { householdDayZone, useHouseholdToday } from '@/lib/household-day';
import { recentLogSummary } from '@/lib/maintenance/recent';
import { comingUp, COMING_UP_DAYS } from '@/lib/maintenance/coming-up';
import {
  categoryChips, filterAssets, filterLogs, filterReminders, filterVehicles, hasActiveFilters, locationChips, sortLogs,
} from '@/lib/maintenance/filters';
import { reminderMileageEstimates } from '@/lib/maintenance/mileage-prediction';
import { needsDoing } from '@/lib/maintenance/needs-doing';
import { MaintenanceFilterBar } from '@/components/maintenance/maintenance-filters';
import { OVERVIEW_COMING_UP_DAYS } from '@/components/maintenance/overview-tab';
import { MaintenanceLoadingState } from '@/components/maintenance/maintenance-skeleton';
import {
  formatDate, getLogTargetType, logValuesOf, toNumber, trimOptional, type AssetValues, type LogFormValues, type LogPreset,
  type LogValues, getScheduleCompletionName, type ScheduleCompletionFormValues, type VehicleValues,
} from '@/components/maintenance/page-model';

/**
 * A vehicle service with a mileage interval asks for the odometer first (MA-6a). One with
 * only a set due mileage and no interval opens the completion dialog instead, where the
 * next due is typed (the server refuses it without a reading: `mileage_required`).
 */
const needsMileageReading = (target: ScheduleCompletionTarget) =>
  target.targetType === 'vehicle' && Boolean(target.schedule.intervalMiles);

export function MaintenanceLogClient() {
  const { currentUser, currentMember, household, permissions } = useAuth();
  const { toast } = useToast();
  const canEdit = permissions['maintenance.edit'];
  const canCreateLogs = permissions['maintenance.createLogs'];
  const canDelete = permissions['maintenance.delete'];
  // Completing a schedule writes a log and the schedule, so it needs both.
  const canComplete = canEdit && canCreateLogs;
  // Only decided once the membership has loaded, so nobody sees a flash of "no access".
  const accessDenied = Boolean(currentMember) && !permissions['maintenance.view'];
  // Live records of this household for this member (MA-2); null stops the listeners.
  const listenerKey = currentUser?.householdId && currentUser.uid && !accessDenied ? `${currentUser.householdId}|${currentUser.uid}` : null;
  const live = useMaintenanceLiveData(currentUser?.householdId, listenerKey);
  const { assets, vehicles, attachments } = live;
  // Read unordered (a log without a date is kept, MA-11e) and sorted here: newest first, undated last.
  const logs = useMemo(() => sortLogs(live.logs), [live.logs]);
  // Only the first load (per household) shows the skeleton; later changes arrive in place.
  const ready = listenerKey ? live.ready : true;
  const loading = Boolean(listenerKey) && !live.ready && !live.failure;
  const {
    activeTab, selectedAssetId, setSelectedAssetId, selectedVehicleId, setSelectedVehicleId,
    highlightedLogId, highlightedScheduleKey, deepLinkNotice, changeTab, openTarget, filters, setFilters, detailRequest,
  } = useMaintenanceNavigation({ ready, confirmed: listenerKey ? live.confirmed : true, assets, vehicles, logs });
  const {
    logToDelete, setLogToDelete, assetToDelete, setAssetToDelete, vehicleToDelete, setVehicleToDelete,
    attachmentToDelete, setAttachmentToDelete, deletingRecord, uploadingAttachmentTarget, deletingAttachmentId,
    summaries, loadingSummaries, uploadAttachment, deleteAttachment, deleteLog, deleteAsset, deleteVehicle, handleSummarize,
  } = useMaintenanceRecords({ currentUser, attachments, setSelectedAssetId, setSelectedVehicleId });
  const [reminderBusy, setReminderBusy] = useState<ReminderBusy>(null);
  // Card -> detail panel shared-element morphs (H12), within this page.
  const { morphName, run: runMorph, settle: settleMorph } = useInPageMorph();
  const detailMorph = useMemo(() => ({ morphName, run: runMorph, settle: settleMorph }), [morphName, runMorph, settleMorph]);
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const [vehicleDialogOpen, setVehicleDialogOpen] = useState(false);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<HomeAsset | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [editingLog, setEditingLog] = useState<MaintenanceLog | null>(null);
  const [scheduleCompletionTarget, setScheduleCompletionTarget] = useState<ScheduleCompletionTarget | null>(null);
  /** The schedule a "Log service" log completes when saved (D16). */
  const [logScheduleTarget, setLogScheduleTarget] = useState<ScheduleCompletionTarget | null>(null);
  const [logPreset, setLogPreset] = useState<LogPreset | undefined>(undefined);
  // Bumped on every dialog opening: the dialog's form starts over from the record as it is then.
  const [dialogSession, setDialogSession] = useState(0);
  const {
    inFlight, notices, clearNotice, mileageCheck, setMileageCheck, reminderListEpoch,
    runOp, closable, discardPending, mileageConfirmed, undoSnooze, completeSchedule, ownerIdOf, renewing, renewDocument,
  } = useMaintenanceOps({
    householdId: currentUser?.householdId,
    onTargetSettled: (target) => {
      if (target.targetType === 'home_asset') setSelectedAssetId(target.asset.id);
      else setSelectedVehicleId(target.vehicle.id);
    },
  });
  const [showInactiveVehicles, setShowInactiveVehicles] = useState(false);
  // Confirm mileage (MA-6a): Mark done on a service due by mileage asks for the odometer.
  const [mileageTarget, setMileageTarget] = useState<Extract<ScheduleCompletionTarget, { targetType: 'vehicle' }> | null>(null);



  // Same rules as the scheduled reminders, in the household's timezone (MA-1). "Today" is the
  // household's day, kept in state and rolled over at the household's midnight (and re-checked
  // when the page is shown again, regains focus or comes back online: useHouseholdToday).
  const timeZone = householdDayZone(household?.timeZone);
  const today = useHouseholdToday(timeZone);
  // Upcoming warranties, registrations and inspections are included 90 days ahead, so the
  // Reminders tab's Upcoming group and Coming up agree (none of them is notified).
  const reminders = useMemo(
    () => buildMaintenanceReminders(assets, vehicles, today, timeZone, { expiryLookaheadDays: COMING_UP_DAYS }),
    [assets, vehicles, today, timeZone],
  );
  const health = useMemo(
    () => computeHomeHealth({ assets, vehicles, logs, today, timeZone }),
    [assets, vehicles, logs, today, timeZone],
  );

  // Location, category and search from the URL (MA-21). Lists follow them; a record asked for
  // by a link is still shown when they would hide its card.
  const filtered = hasActiveFilters(filters);
  const filterContext = useMemo(() => ({ assets, vehicles }), [assets, vehicles]);
  const visibleAssets = useMemo(() => filterAssets(assets, filters), [assets, filters]);
  // Retired assets leave the main grid for a collapsed "Retired" section (MA-11j).
  const activeAssets = useMemo(() => visibleAssets.filter((asset) => asset.status !== 'retired'), [visibleAssets]);
  const retiredAssets = useMemo(() => visibleAssets.filter((asset) => asset.status === 'retired'), [visibleAssets]);
  const visibleVehicles = useMemo(() => filterVehicles(vehicles, filters), [vehicles, filters]);
  const activeVehicles = useMemo(
    () => visibleVehicles.filter((vehicle) => vehicle.status !== 'retired' && vehicle.status !== 'sold'),
    [visibleVehicles],
  );
  const inactiveVehicles = useMemo(
    () => visibleVehicles.filter((vehicle) => vehicle.status === 'retired' || vehicle.status === 'sold'),
    [visibleVehicles],
  );
  const visibleLogs = useMemo(() => filterLogs(logs, filters, filterContext), [logs, filters, filterContext]);
  const visibleReminders = useMemo(() => filterReminders(reminders, filters, filterContext), [reminders, filters, filterContext]);
  const filterLocationChips = useMemo(() => locationChips(assets.filter((asset) => asset.status !== 'retired')), [assets]);
  const filterCategoryChips = useMemo(() => categoryChips(assets, vehicles), [assets, vehicles]);
  const filterKey = `${filters.location ?? ''}|${filters.category ?? ''}|${filters.q}`;

  // Mileage estimates beside vehicle reminders (MA-29) and on the Coming up timeline.
  const estimates = useMemo(
    () => reminderMileageEstimates(reminders, vehicles, logs, today, timeZone),
    [reminders, vehicles, logs, today, timeZone],
  );
  const predictedDates = useMemo(() => {
    const dates: Record<string, string> = {};
    for (const reminder of reminders) {
      const estimate = estimates[reminder.id];
      if (estimate) dates[reminder.scheduleKey ?? reminder.id] = estimate.date;
    }
    return dates;
  }, [reminders, estimates]);
  const comingUpReminders = useMemo(
    () => comingUp(visibleReminders, today, COMING_UP_DAYS, { timeZone, predictedDates }),
    [visibleReminders, today, timeZone, predictedDates],
  );

  // Overview: Needs doing and the next 30 days, narrowed to a room by ?location= (MA-26).
  const room = filters.location;
  const roomReminders = useMemo(
    () => (room ? filterReminders(reminders, { location: room, category: null, q: '' }, filterContext) : reminders),
    [reminders, room, filterContext],
  );
  const needs = useMemo(() => needsDoing({ reminders, assets, vehicles, roomName: room }), [reminders, assets, vehicles, room]);
  const overviewComingUp = useMemo(
    () => comingUp(roomReminders, today, OVERVIEW_COMING_UP_DAYS, { timeZone, predictedDates }),
    [roomReminders, today, timeZone, predictedDates],
  );
  const setRoom = useStableHandler((location: string | null) => setFilters({ ...filters, location }));
  const recentLogs = useMemo(() => logs.slice(0, 5), [logs]);

  const selectedAsset = useMemo(() => {
    return assets.find((asset) => asset.id === selectedAssetId) || activeAssets[0] || null;
  }, [assets, activeAssets, selectedAssetId]);

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

  const renewingField = renewing && renewing.vehicleId === selectedVehicle?.id ? renewing.field : null;


  const openReminderTarget = openTarget as (reminder: MaintenanceReminder) => void;
  const openHealthDeduction = openTarget as (deduction: HealthDeduction) => void;


  // "Last 30 days" in household days (MA-11f).
  const summary = useMemo(() => recentLogSummary(logs, assets, vehicles, today, timeZone), [assets, logs, vehicles, today, timeZone]);

  const openAssetDialog = useStableHandler((asset?: HomeAsset) => {
    setEditingAsset(asset || null);
    clearNotice('asset');
    discardPending('asset');
    setDialogSession(session => session + 1);
    setAssetDialogOpen(true);
  });

  const openVehicleDialog = useStableHandler((vehicle?: Vehicle) => {
    setEditingVehicle(vehicle || null);
    clearNotice('vehicle');
    discardPending('vehicle');
    setMileageCheck(null);
    setDialogSession(session => session + 1);
    setVehicleDialogOpen(true);
  });

  const openLogDialog = useStableHandler((preset?: LogPreset, log?: MaintenanceLog, schedule: ScheduleCompletionTarget | null = null) => {
    setEditingLog(log || null);
    setLogPreset(preset);
    setLogScheduleTarget(log ? null : schedule);
    clearNotice('log');
    discardPending('log');
    setMileageCheck(null);
    setDialogSession(session => session + 1);
    setLogDialogOpen(true);
  });

  const openScheduleCompletionDialog = useStableHandler((target: ScheduleCompletionTarget) => {
    setMileageCheck(null);
    clearNotice('complete');
    discardPending('complete');
    setDialogSession(session => session + 1);
    setScheduleCompletionTarget(target);
  });



  const saveAsset = useStableHandler(async ({ base, values }: { base?: AssetValues; values: AssetValues }) => {
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
    }, 'dialog');
  });

  const saveVehicle = useStableHandler(async ({ base, values: vehicleValues }: { base?: VehicleValues; values: VehicleValues }) => {
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
    }, 'dialog');
  });

  const saveLog = useStableHandler(async ({ values, base }: { values: LogFormValues; base?: LogValues }, form: LogFormHandle) => {
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
    }, 'dialog');
  });

  const completeScheduledMaintenance = useStableHandler(async (values: ScheduleCompletionFormValues, form: CompletionFormHandle) => {
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
  });

  /**
   * One-tap Mark done from a reminder card. When the next due date or mileage
   * cannot be worked out (no interval), the completion dialog opens instead so
   * nothing is guessed; a service due by mileage opens Confirm mileage.
   */
  const reminderCompletesInPlace = useCallback((reminder: MaintenanceReminder) => {
    const target = findReminderSchedule(reminder, assets, vehicles);
    return Boolean(target && !needsMileageReading(target) && quickCompletionValues(target, today));
  }, [assets, vehicles, today]);

  const openMileageConfirm = useStableHandler((target: Extract<ScheduleCompletionTarget, { targetType: 'vehicle' }>) => {
    setMileageCheck(null);
    clearNotice('mileage');
    discardPending('mileage');
    setDialogSession(session => session + 1);
    setMileageTarget(target);
  });

  const markReminderDone = useStableHandler(async (reminder: MaintenanceReminder): Promise<MarkDoneResult> => {
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
  });

  const submitMileageConfirm = useStableHandler(async (reading: number, setMileageInputError: (message: string) => void) => {
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
  });

  /**
   * Log service (D16): the full log form, filled in for the reminder's asset or
   * vehicle and schedule (title, type, today, current mileage). Saving it records
   * the log and completes that schedule cycle, like Mark done but with the
   * details. A reminder without a schedule (it was removed) opens a plain log
   * for the same asset or vehicle.
   */
  const openLogService = useStableHandler((reminder: MaintenanceReminder) => {
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
  });

  /**
   * Snooze moves the schedule's next due date a week past the later of today and
   * the current due date, on the server, by the schedule's id and only while it is
   * still the cycle this card shows; the reminder is resolved after it. Undo for 10 s.
   */
  const snoozeReminder = useStableHandler(async (reminder: MaintenanceReminder) => {
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
          const title = 'Snoozed for a week';
          const description = `${reminder.title} for ${reminder.relatedName} is now due ${formatDate(result.nextDueDate)}.`;
          // Undo only for what is left of the window (a replayed or slow answer has less).
          const offer = undoOfferMs(result.undoMs);
          if (offer === null) {
            toast({ title, description });
            return;
          }
          const handle = toast({
            title,
            description,
            duration: offer,
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
      }, 'toast');
    } finally {
      setReminderBusy(null);
    }
  });


  const editLog = useStableHandler((log: MaintenanceLog) => openLogDialog(undefined, log));
  const logListProps = useMemo(() => ({
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
    onEdit: editLog,
    onDelete: setLogToDelete,
    onUploadAttachment: uploadAttachment,
    onDeleteAttachment: setAttachmentToDelete,
  }), [assets, vehicles, attachments, summaries, loadingSummaries, uploadingAttachmentTarget, deletingAttachmentId, canEdit, canDelete,
    handleSummarize, editLog, setLogToDelete, uploadAttachment, setAttachmentToDelete]);

  const snoozeFromCard = useStableHandler((reminder: MaintenanceReminder) => void snoozeReminder(reminder));
  const reminderListProps = useMemo(() => ({
    today,
    canComplete,
    canLog: canCreateLogs,
    canSnooze: canEdit,
    busy: reminderBusy,
    completesInPlace: reminderCompletesInPlace,
    onOpen: openReminderTarget,
    onMarkDone: markReminderDone,
    onLogService: openLogService,
    onSnooze: snoozeFromCard,
    estimates,
  }), [today, canComplete, canCreateLogs, canEdit, reminderBusy, reminderCompletesInPlace, openReminderTarget, markReminderDone, openLogService, snoozeFromCard, estimates]);

  // A dialog over the page: the phone detail sheet keeps its place under it (Back closes the dialog's own way).
  const dialogOpen = assetDialogOpen || vehicleDialogOpen || logDialogOpen || Boolean(scheduleCompletionTarget) || Boolean(mileageTarget)
    || Boolean(assetToDelete) || Boolean(vehicleToDelete) || Boolean(logToDelete) || Boolean(attachmentToDelete);

  // The phone's tab row scrolls sideways: keep the chosen tab in view.
  // Only the row scrolls (sideways), never the page.
  useEffect(() => {
    const list = document.querySelector<HTMLElement>('[data-maintenance-tabs]');
    const tab = list?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    list.scrollLeft = Math.max(0, tab.offsetLeft - (list.clientWidth - tab.offsetWidth) / 2);
  }, [activeTab]);

  // Dialog close requests: refused while the dialog's request is in flight (its outcome must be known).
  const assetDialogOpenChange = useStableHandler((open: boolean) => {
    if (!open && !closable('asset')) return;
    setAssetDialogOpen(open);
  });
  const vehicleDialogOpenChange = useStableHandler((open: boolean) => {
    if (!open && !closable('vehicle')) return;
    setVehicleDialogOpen(open);
  });
  const logDialogOpenChange = useStableHandler((open: boolean) => {
    if (!open && !closable('log')) return;
    setLogDialogOpen(open);
    if (!open) {
      setEditingLog(null);
      setLogScheduleTarget(null);
    }
  });
  const completionDialogOpenChange = useStableHandler((open: boolean) => {
    if (!open && !closable('complete')) return;
    if (!open) setScheduleCompletionTarget(null);
  });
  const mileageDialogOpenChange = useStableHandler((open: boolean) => {
    if (!open && !closable('mileage')) return;
    if (!open) {
      setMileageTarget(null);
      setMileageCheck(null);
    }
  });

  if (!currentUser) {
    return <SignInPrompt what="manage maintenance" />;
  }

  if (accessDenied || live.failure === 'unauthorized') {
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

  if (loading) return <MaintenanceLoadingState />;

  if (live.failure === 'retrying') {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="font-medium">Could not load maintenance data.</p>
          <Button onClick={live.retry}>Try again</Button>
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
          {canCreateLogs && (
            <Button onClick={() => openLogDialog()}>
              <Plus className="mr-2 h-4 w-4" />
              Add Log
            </Button>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={changeTab} className="w-full">
          {/* One row: on a phone it scrolls sideways instead of wrapping (MA-17). */}
          <TabsList data-maintenance-tabs className="relative flex h-auto w-full justify-start overflow-x-auto [scrollbar-width:none] md:grid md:grid-cols-5 [&>*]:shrink-0">
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

          {activeTab !== 'overview' && (
            <div className="mt-4">
              <MaintenanceFilterBar filters={filters} locationChips={filterLocationChips} categoryChips={filterCategoryChips} onChange={setFilters} />
            </div>
          )}

          <OverviewTab
            health={health}
            assets={assets}
            vehicles={vehicles}
            recentLogs={recentLogs}
            summary={summary}
            needs={needs}
            room={room}
            roomChips={filterLocationChips}
            onRoomChange={setRoom}
            comingUp={overviewComingUp}
            today={today}
            canEdit={canEdit}
            logListProps={logListProps}
            reminderListProps={reminderListProps}
            reminderListEpoch={reminderListEpoch}
            changeTab={changeTab}
            openAssetDialog={openAssetDialog}
            openVehicleDialog={openVehicleDialog}
            openTarget={openTarget}
            openReminder={openReminderTarget}
            openHealthDeduction={openHealthDeduction}
          />

          <AssetsTab
            assets={activeAssets}
            retiredAssets={retiredAssets}
            totalAssets={assets.length}
            filtered={filtered}
            attachments={attachments}
            health={health}
            today={today}
            timeZone={timeZone}
            selectedAsset={selectedAsset}
            logs={assetLogs}
            highlightedScheduleKey={highlightedScheduleKey}
            detailMorph={detailMorph}
            detailRequest={detailRequest}
            dialogOpen={dialogOpen}
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
            totalVehicles={vehicles.length}
            activeVehicles={activeVehicles}
            inactiveVehicles={inactiveVehicles}
            filtered={filtered}
            attachments={attachments}
            health={health}
            today={today}
            timeZone={timeZone}
            selectedVehicle={selectedVehicle}
            logs={vehicleLogs}
            highlightedScheduleKey={highlightedScheduleKey}
            detailMorph={detailMorph}
            detailRequest={detailRequest}
            dialogOpen={dialogOpen}
            renewing={renewingField}
            onRenew={renewDocument}
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
            reminders={visibleReminders}
            comingUp={comingUpReminders}
            today={today}
            reminderListProps={reminderListProps}
            reminderListEpoch={reminderListEpoch}
            onOpen={openReminderTarget}
          />

          <LogsTab
            logs={visibleLogs}
            filtered={filtered}
            filterKey={filterKey}
            highlightedLogId={highlightedLogId}
            canCreateLogs={canCreateLogs}
            logListProps={logListProps}
            openLogDialog={openLogDialog}
          />
        </Tabs>
      </div>

      <AssetDialog
        open={assetDialogOpen}
        session={dialogSession}
        record={editingAsset}
        busy={Boolean(inFlight.asset)}
        notice={notices.asset}
        onOpenChange={assetDialogOpenChange}
        onSave={saveAsset}
      />

      <VehicleDialog
        open={vehicleDialogOpen}
        session={dialogSession}
        record={editingVehicle}
        busy={Boolean(inFlight.vehicle)}
        notice={notices.vehicle}
        mileageMessage={mileageCheck?.key === 'vehicle' ? mileageCheck.message : undefined}
        onOpenChange={vehicleDialogOpenChange}
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
        onOpenChange={logDialogOpenChange}
        onSave={saveLog}
      />

      <ScheduleCompletionDialog
        target={scheduleCompletionTarget}
        session={dialogSession}
        today={today}
        busy={Boolean(inFlight.complete)}
        notice={notices.complete}
        mileageMessage={mileageCheck?.key === 'complete' ? mileageCheck.message : undefined}
        onOpenChange={completionDialogOpenChange}
        onSubmit={completeScheduledMaintenance}
      />

      <MileageDialog
        target={mileageTarget}
        session={dialogSession}
        busy={Boolean(inFlight.mileage)}
        notice={notices.mileage}
        mileageMessage={mileageCheck?.key === 'mileage' ? mileageCheck.message : undefined}
        onOpenChange={mileageDialogOpenChange}
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
