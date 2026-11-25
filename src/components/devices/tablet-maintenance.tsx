'use client';

// Maintenance on a registered wall tablet (M8b; docs/modules/devices/README.md, "Maintenance on
// the tablet"; audit 15, 16, 17.2; WT-4, WT-6, WT-18, WT-20, WT-22; MA-26). The personal page's
// own pieces: the live listeners (`useMaintenanceLiveData`, through the device read rules, with
// the tablet's denied-listener recovery), the reminder builder, `needsDoing` and the shared
// Needs doing panel and reminder cards. Every write is a device action through the shell
// (`runAction`: "Who's here?", the person's own permissions, the Undo journal and toast, the
// offline queue): Done, Snooze and Log service are face-level with Undo and never ask for the
// chore points PIN; a schedule edit and a delete ask for the person's PIN. Nothing here writes
// with the client SDK. Record forms, attachments (upload and delete), receipts, the AI summary,
// QR labels, renewals and Update mileage stay on phones.

import { useCallback, useMemo, useState } from 'react';
import { Wrench } from 'lucide-react';
import { buildMaintenanceReminders, type MaintenanceReminder } from '@functions/shared/maintenance-reminders';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NeedsDoingPanel } from '@/components/maintenance/needs-doing-panel';
import type { MarkDoneResult, ReminderBusy } from '@/components/maintenance/reminder-list';
import { useMaintenanceLiveData } from '@/components/maintenance/use-maintenance-data';
import { formatDate, getLogTitle } from '@/components/maintenance/page-model';
import { useBackCloses } from '@/hooks/use-back-closes';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { COMING_UP_DAYS } from '@/lib/maintenance/coming-up';
import { householdDayZone, useHouseholdToday } from '@/lib/household-day';
import { needsDoing } from '@/lib/maintenance/needs-doing';
import { findReminderSchedule, quickCompletionValues, type ScheduleCompletionTarget } from '@/lib/maintenance/schedules';
import { TABLET_DENIED_RECOVERY_MS } from '@/lib/devices/tablet-listener';
import {
  completeIntentOf, deleteConfirmation, latestLogsOf, maintenanceRoomView, ownFileCount, needsMileageReading, reminderSubject, scheduleEditIntentOf, scheduleNameOf, snoozeIntentOf, type RoomChoice,
} from '@/lib/devices/tablet-maintenance';
import type { HomeAsset, MaintenanceAttachment, MaintenanceLog, Vehicle } from '@/lib/types';
import { useTablet } from './tablet-context';
import { useTabletSubmit } from './use-tablet-submit';

const BUTTON = 'inline-flex min-h-12 min-w-12 items-center justify-center gap-2 rounded-lg border border-border px-4 text-base font-medium disabled:opacity-60';
const PRIMARY = 'min-h-12 rounded-lg bg-primary px-4 text-base font-medium text-primary-foreground disabled:opacity-60';

type RecordRef = { targetType: 'home_asset' | 'vehicle'; targetId: string };

/** Log service on the tablet: a reminder's completion with details, or a plain log for a record. */
type LogTarget = { reminder: MaintenanceReminder | null; target: ScheduleCompletionTarget | null; record: RecordRef | null; askMileage: boolean };

export function TabletMaintenanceView() {
  const { householdId, deviceId, generation, settings, household, runAction } = useTablet();
  // The personal page's listeners, keyed by this tablet's session; a refusal recovers every minute.
  const live = useMaintenanceLiveData(householdId, `device:${deviceId}:${generation}`, { recoverUnauthorizedAfterMs: TABLET_DENIED_RECOVERY_MS });
  const timeZone = householdDayZone(household?.timeZone);
  const today = useHouseholdToday(timeZone);
  const { assets, vehicles, logs, attachments } = live;
  const reminders = useMemo(
    () => buildMaintenanceReminders(assets, vehicles, today, timeZone, { expiryLookaheadDays: COMING_UP_DAYS }),
    [assets, vehicles, today, timeZone],
  );
  // MA-26: the record's room (applied live from the Devices list), or every room when asked.
  const [choice, setChoice] = useState<RoomChoice>(null);
  const roomView = maintenanceRoomView(settings.room, choice);
  const recordRoom = settings.room?.trim() ?? '';
  const needs = useMemo(() => needsDoing({ reminders, assets, vehicles, roomName: roomView.room }), [reminders, assets, vehicles, roomView.room]);
  const [busy, setBusy] = useState<ReminderBusy>(null);
  // Bumped when an action is taken back (Undo, or a queued one dropped): the cards start over.
  const [epoch, setEpoch] = useState(0);
  const reverted = useCallback(() => setEpoch((value) => value + 1), []);
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null);
  const [open, setOpen] = useState<RecordRef | null>(null);

  const completesInPlace = useCallback((reminder: MaintenanceReminder) => {
    const target = findReminderSchedule(reminder, assets, vehicles);
    return Boolean(target && !needsMileageReading(target) && quickCompletionValues(target, today));
  }, [assets, vehicles, today]);

  const markDone = useCallback(async (reminder: MaintenanceReminder): Promise<MarkDoneResult> => {
    if (busy) return 'failed';
    const target = findReminderSchedule(reminder, assets, vehicles);
    if (!target) return 'failed';
    const intent = needsMileageReading(target) ? null : completeIntentOf(target, today);
    if (!intent) {
      // The odometer first (or the next due can't be worked out): the tablet's Log service form.
      setLogTarget({ reminder, target, record: null, askMileage: target.targetType === 'vehicle' });
      return 'deferred';
    }
    setBusy({ id: reminder.id, action: 'done' });
    try {
      const outcome = await runAction({ capability: 'maintenance.complete', label: reminderSubject(reminder), intent, onReverted: reverted });
      return outcome.ok ? 'done' : 'failed';
    } finally {
      setBusy(null);
    }
  }, [assets, busy, reverted, runAction, today, vehicles]);

  const snooze = useCallback(async (reminder: MaintenanceReminder) => {
    if (busy) return;
    const target = findReminderSchedule(reminder, assets, vehicles);
    if (!target) return;
    setBusy({ id: reminder.id, action: 'snooze' });
    try {
      await runAction({ capability: 'maintenance.snooze', label: reminderSubject(reminder), intent: snoozeIntentOf(target), onReverted: reverted });
    } finally {
      setBusy(null);
    }
  }, [assets, busy, reverted, runAction, vehicles]);

  const logService = (reminder: MaintenanceReminder) => {
    const target = findReminderSchedule(reminder, assets, vehicles);
    setLogTarget({ reminder, target, record: target ? null : { targetType: reminder.targetType === 'vehicle' ? 'vehicle' : 'home_asset', targetId: reminder.targetId }, askMileage: reminder.targetType === 'vehicle' });
  };

  const reminderListProps = {
    today,
    // The person is chosen after the tap; the shell offers a face only what their permissions allow and the server decides.
    canComplete: true,
    canLog: true,
    canSnooze: true,
    busy,
    completesInPlace,
    onOpen: (reminder: MaintenanceReminder) => setOpen({ targetType: reminder.targetType === 'vehicle' ? 'vehicle' : 'home_asset', targetId: reminder.targetId }),
    onMarkDone: markDone,
    onLogService: logService,
    onSnooze: (reminder: MaintenanceReminder) => void snooze(reminder),
  };

  const status = live.failure === 'unauthorized'
    ? "This couldn't be loaded right now. It tries again on its own."
    : live.ready ? null : 'Loading…';

  return (
    <section className="mx-auto max-w-5xl space-y-4 p-6" data-testid="tablet-view-maintenance" aria-labelledby="tablet-view-maintenance-title">
      <h1 id="tablet-view-maintenance-title" className="flex items-center gap-3 font-headline text-3xl font-bold">
        <Wrench aria-hidden className="h-7 w-7 text-primary" />
        Maintenance
      </h1>
      {status ? <p className="text-lg text-muted-foreground">{status}</p> : (
        <div className="[&_button]:min-h-12 [&_button]:min-w-12" data-testid="tablet-maintenance-needs" data-room={roomView.room ?? ''}>
          <NeedsDoingPanel
            needs={needs}
            room={roomView.room}
            roomChips={recordRoom ? [{ value: recordRoom, label: recordRoom, count: needsDoing({ reminders, assets, vehicles, roomName: recordRoom }).count }] : []}
            onRoomChange={(value) => setChoice(value ? null : { room: recordRoom, all: true })}
            reminderListProps={reminderListProps}
            reminderListEpoch={epoch}
            peekFor={(item) => <span>{item.detail}</span>}
            openTarget={(target) => setOpen({ targetType: target.targetType, targetId: target.targetId })}
          />
        </div>
      )}
      <p className="text-sm text-muted-foreground">Adding or editing records, files, receipts and summaries stay in HomeHub on a phone.</p>
      {logTarget && (
        <TabletLogServiceDialog
          key={logTarget.reminder?.id ?? logTarget.record?.targetId ?? 'log'}
          entry={logTarget}
          assets={assets}
          vehicles={vehicles}
          today={today}
          onReverted={reverted}
          onClose={() => setLogTarget(null)}
        />
      )}
      {open && (
        <TabletMaintenanceRecordSheet
          record={open}
          assets={assets}
          vehicles={vehicles}
          logs={logs}
          attachments={attachments}
          onLog={(record) => setLogTarget({ reminder: null, target: null, record, askMileage: record.targetType === 'vehicle' })}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

/**
 * Log service on the tablet: for a reminder, its completion with the details typed (as the
 * personal Log service: `maintenance.complete`); for a record without a schedule to complete, a
 * plain log (`maintenance.log`). The person is chosen after Save; Undo for 10 s.
 */
function TabletLogServiceDialog({ entry, assets, vehicles, today, onReverted, onClose }: {
  entry: LogTarget; assets: HomeAsset[]; vehicles: Vehicle[]; today: string; onReverted: () => void; onClose: () => void;
}) {
  const { runAction } = useTablet();
  const record = entry.target
    ? { targetType: entry.target.targetType, targetId: entry.target.targetType === 'home_asset' ? entry.target.asset.id : entry.target.vehicle.id }
    : entry.record;
  const vehicle = record?.targetType === 'vehicle' ? vehicles.find((item) => item.id === record.targetId) : undefined;
  const asset = record?.targetType === 'home_asset' ? assets.find((item) => item.id === record.targetId) : undefined;
  const [title, setTitle] = useState(entry.target ? scheduleNameOf(entry.target) : '');
  const [notes, setNotes] = useState('');
  const [cost, setCost] = useState('');
  const [provider, setProvider] = useState('');
  const [mileage, setMileage] = useState(typeof vehicle?.currentMileage === 'number' ? String(vehicle.currentMileage) : '');
  const [error, setError] = useState<string | null>(null);
  const form = useTabletSubmit();
  useUnsavedInput(notes.trim().length > 0 || cost.trim().length > 0 || provider.trim().length > 0);
  useBackCloses(true, onClose);
  const name = asset?.name ?? vehicle?.nickname ?? 'General';
  const save = async () => {
    setError(null);
    const reading = mileage.trim() ? Number(mileage) : undefined;
    if (reading !== undefined && (!Number.isInteger(reading) || reading < 0 || reading > 2_000_000)) {
      setError('Enter the mileage as a whole number.');
      return;
    }
    const costValue = cost.trim() ? Number(cost) : undefined;
    if (costValue !== undefined && !Number.isFinite(costValue)) {
      setError('Enter the cost as a number.');
      return;
    }
    if (!title.trim()) {
      setError('Give it a title.');
      return;
    }
    await form.submit(async (opId) => {
      if (entry.target) {
        const intent = completeIntentOf(entry.target, today, { mileage: reading, details: { title, notes, cost: costValue, serviceProvider: provider } });
        if (!intent) {
          setError(needsMileageReading(entry.target) ? 'Enter the odometer reading so the next service can be scheduled.' : 'This needs a next due date. Mark it done on a phone.');
          return { ok: false };
        }
        const outcome = await runAction({ capability: 'maintenance.complete', opId, label: `${title.trim()} for ${name}`, intent, onReverted });
        if (outcome.ok) onClose();
        return outcome;
      }
      const values = {
        targetType: record?.targetType ?? 'general',
        ...(record?.targetType === 'home_asset' ? { assetId: record.targetId } : {}),
        ...(record?.targetType === 'vehicle' ? { vehicleId: record.targetId, ...(reading !== undefined ? { mileage: reading } : {}) } : {}),
        title: title.trim(),
        date: today,
        type: 'routine',
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(costValue !== undefined ? { cost: costValue } : {}),
        ...(provider.trim() ? { serviceProvider: provider.trim() } : {}),
      };
      const outcome = await runAction({ capability: 'maintenance.log', opId, label: `${title.trim()} for ${name}`, intent: { values }, onReverted });
      if (outcome.ok) onClose();
      return outcome;
    });
  };
  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-w-xl overflow-y-auto" data-testid="tablet-maintenance-log">
        <DialogHeader>
          <DialogTitle className="font-headline text-2xl">{entry.target ? `Log service: ${name}` : `Log maintenance: ${name}`}</DialogTitle>
          <DialogDescription>
            {entry.target ? 'Records what was done today and marks it done. ' : 'Records what was done today. '}
            It is saved for the person you choose next.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" maxLength={1000} className="min-h-12 text-lg" data-testid="tablet-maintenance-log-title" />
          {entry.askMileage && (
            <Input value={mileage} onChange={(event) => setMileage(event.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" aria-label="Odometer reading (miles)" placeholder="Odometer reading" className="min-h-12 text-lg" data-testid="tablet-maintenance-log-mileage" />
          )}
          <Input value={provider} onChange={(event) => setProvider(event.target.value)} aria-label="Done by (company or person, optional)" placeholder="Done by (optional)" maxLength={1000} className="min-h-12 text-base" />
          <Input value={cost} onChange={(event) => setCost(event.target.value)} inputMode="decimal" aria-label="Cost (optional)" placeholder="Cost (optional)" className="min-h-12 text-base" />
          <Textarea value={notes} onChange={(event) => setNotes(event.target.value)} aria-label="Notes (optional)" placeholder="Notes (optional)" maxLength={20000} className="min-h-24 text-base" />
          {error && <p role="alert" className="text-sm font-medium text-destructive" data-testid="tablet-maintenance-log-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
            <button type="submit" className={PRIMARY} disabled={form.busy} data-testid="tablet-maintenance-log-save">{entry.target ? 'Save and mark done' : 'Save'}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One asset or vehicle on the tablet (read-only details): its schedules with **Edit schedule**
 * (PIN), its latest logs with **Delete** (PIN), **Log maintenance** (face) and **Delete** the record
 * (PIN; its logs stay as history and its own files go). Nothing else of the record is editable here.
 */
function TabletMaintenanceRecordSheet({ record, assets, vehicles, logs, attachments, onLog, onClose }: {
  record: RecordRef; assets: HomeAsset[]; vehicles: Vehicle[]; logs: MaintenanceLog[]; attachments: MaintenanceAttachment[]; onLog: (record: RecordRef) => void; onClose: () => void;
}) {
  const { runAction } = useTablet();
  const asset = record.targetType === 'home_asset' ? assets.find((item) => item.id === record.targetId) : undefined;
  const vehicle = record.targetType === 'vehicle' ? vehicles.find((item) => item.id === record.targetId) : undefined;
  const [editing, setEditing] = useState<ScheduleCompletionTarget | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // A permanent delete is confirmed first, naming the record and its files (as the personal
  // page's DeleteDialogs), every time: a PIN session still open proves who, not that the tap was meant.
  const [confirming, setConfirming] = useState<{ key: string; text: ReturnType<typeof deleteConfirmation>; request: Parameters<typeof runAction>[0]; after?: () => void } | null>(null);
  useBackCloses(!editing && !confirming, onClose);
  const name = asset?.name ?? vehicle?.nickname ?? null;
  const schedules: ScheduleCompletionTarget[] = asset
    ? (asset.schedules ?? []).map((schedule, scheduleIndex) => ({ targetType: 'home_asset' as const, asset, schedule, scheduleIndex }))
    : vehicle ? (vehicle.serviceSchedules ?? []).map((schedule, scheduleIndex) => ({ targetType: 'vehicle' as const, vehicle, schedule, scheduleIndex })) : [];
  // The latest five by date (the listener reads logs unordered).
  const ownLogs = latestLogsOf(logs, record);
  const run = async (key: string, request: Parameters<typeof runAction>[0], after?: () => void) => {
    if (pending) return;
    setPending(key);
    try {
      const outcome = await runAction(request);
      if (outcome.ok) after?.();
    } finally {
      setPending(null);
    }
  };
  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-w-2xl overflow-y-auto" data-testid="tablet-maintenance-record">
        <DialogHeader>
          <DialogTitle className="font-headline text-2xl">{name ?? 'Removed'}</DialogTitle>
          <DialogDescription>
            {name ? [asset?.category, asset?.location, vehicle && [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'Maintenance' : 'This was removed meanwhile.'}
          </DialogDescription>
        </DialogHeader>
        {name && (
          <div className="space-y-5">
            <section className="space-y-2" aria-label="Schedules">
              <h2 className="font-headline text-lg font-semibold">Schedules</h2>
              {schedules.length === 0 ? <p className="text-muted-foreground">No schedules.</p> : (
                <ul className="space-y-2">
                  {schedules.map((target) => (
                    <li key={`${target.scheduleIndex}`} className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border px-4 py-2">
                      <span className="min-w-0">
                        <span className="block text-base font-medium">{scheduleNameOf(target)}</span>
                        <span className="block text-sm text-muted-foreground">{target.schedule.nextDueDate ? `Next due ${formatDate(target.schedule.nextDueDate)}` : 'No due date'}</span>
                      </span>
                      <button type="button" className={BUTTON} onClick={() => setEditing(target)} data-testid="tablet-maintenance-edit-schedule">Edit schedule</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="space-y-2" aria-label="Latest logs">
              <h2 className="font-headline text-lg font-semibold">Latest logs</h2>
              {ownLogs.length === 0 ? <p className="text-muted-foreground">No logs yet.</p> : (
                <ul className="space-y-2">
                  {ownLogs.map((log) => (
                    <li key={log.id} className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border px-4 py-2" data-testid={`tablet-maintenance-log-${log.id}`}>
                      <span className="min-w-0">
                        <span className="block text-base font-medium">{getLogTitle(log)}</span>
                        <span className="block text-sm text-muted-foreground">{[formatDate(log.date), log.doneByName].filter(Boolean).join(' · ')}</span>
                      </span>
                      <button type="button" className={BUTTON} disabled={pending !== null} onClick={() => setConfirming({ key: `log:${log.id}`, text: deleteConfirmation({ kind: 'log', name: getLogTitle(log), files: ownFileCount(attachments, 'maintenance_log', log.id) }), request: { capability: 'maintenance.log.delete', label: `Deleted ${getLogTitle(log)}`, intent: { logId: log.id } } })} data-testid={`tablet-maintenance-delete-log-${log.id}`}>Delete</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <div className="flex flex-wrap justify-between gap-2">
              <button type="button" className={BUTTON} disabled={pending !== null} onClick={() => setConfirming({
                key: 'record',
                text: deleteConfirmation({ kind: record.targetType, name, files: ownFileCount(attachments, record.targetType, record.targetId) }),
                request: { capability: 'maintenance.record.delete', label: `Deleted ${name}`, intent: { targetType: record.targetType, targetId: record.targetId } },
                after: onClose,
              })} data-testid="tablet-maintenance-delete-record">
                Delete {record.targetType === 'vehicle' ? 'vehicle' : 'asset'}
              </button>
              <span className="flex gap-2">
                <button type="button" className={BUTTON} onClick={onClose}>Close</button>
                <button type="button" className={PRIMARY} onClick={() => { onLog(record); onClose(); }} data-testid="tablet-maintenance-log-record">Log maintenance</button>
              </span>
            </div>
            <p className="text-sm text-muted-foreground">Deleting and editing schedules ask for your PIN.</p>
          </div>
        )}
        {editing && <TabletScheduleEditDialog target={editing} onClose={() => setEditing(null)} />}
        <AlertDialog open={confirming !== null} onOpenChange={(value) => { if (!value) setConfirming(null); }}>
          <AlertDialogContent data-testid="tablet-maintenance-delete-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>{confirming?.text.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirming?.text.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-12">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="min-h-12 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                data-testid="tablet-maintenance-delete-confirm-button"
                onClick={() => {
                  const chosen = confirming;
                  setConfirming(null);
                  if (chosen) void run(chosen.key, chosen.request, chosen.after);
                }}
              >
                {confirming?.text.confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

/** Edit one schedule (PIN, `maintenance.editSchedules`): its name, repeat and next due. */
function TabletScheduleEditDialog({ target, onClose }: { target: ScheduleCompletionTarget; onClose: () => void }) {
  const { runAction } = useTablet();
  const schedule = target.schedule as Record<string, unknown>;
  const asset = target.targetType === 'home_asset';
  const [name, setName] = useState(scheduleNameOf(target));
  const [interval, setRepeat] = useState(String((asset ? schedule.intervalValue : schedule.intervalMonths) ?? ''));
  const [frequency, setFrequency] = useState(String(schedule.frequencyType ?? 'months'));
  const [miles, setMiles] = useState(String(schedule.intervalMiles ?? ''));
  const [nextDue, setNextDue] = useState(String(schedule.nextDueDate ?? ''));
  const [error, setError] = useState<string | null>(null);
  const form = useTabletSubmit();
  useBackCloses(true, onClose);
  // Unsaved edits keep the tablet from idle-returning or reloading under the form (PR #212 review).
  const [initial] = useState(() => ({ name, interval, frequency, miles, nextDue }));
  const dirty = name !== initial.name || interval !== initial.interval || frequency !== initial.frequency
    || miles !== initial.miles || nextDue !== initial.nextDue;
  useUnsavedInput(dirty);
  const whole = (value: string) => (value.trim() ? Number(value) : null);
  const save = async () => {
    setError(null);
    const repeat = whole(interval);
    const repeatMiles = whole(miles);
    if (!name.trim()) return setError('Give it a name.');
    if ((repeat !== null && (!Number.isInteger(repeat) || repeat < 1)) || (repeatMiles !== null && (!Number.isInteger(repeatMiles) || repeatMiles < 1))) {
      return setError('Repeat values are whole numbers above zero.');
    }
    if (nextDue && !/^\d{4}-\d{2}-\d{2}$/.test(nextDue)) return setError('Pick the next due date.');
    const changes: Record<string, unknown> = asset
      ? { scheduleName: name.trim(), intervalValue: repeat, frequencyType: frequency, nextDueDate: nextDue || null }
      : { serviceName: name.trim(), intervalMonths: repeat, intervalMiles: repeatMiles, nextDueDate: nextDue || null };
    await form.submit(async (opId) => {
      const outcome = await runAction({ capability: 'maintenance.editSchedules', opId, label: `Saved ${name.trim()}`, intent: scheduleEditIntentOf(target, changes) });
      if (outcome.ok) onClose();
      return outcome;
    });
  };
  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-w-xl" data-testid="tablet-maintenance-schedule">
        <DialogHeader>
          <DialogTitle className="font-headline text-2xl">Edit schedule</DialogTitle>
          <DialogDescription>Saving asks for your PIN.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" maxLength={1000} className="min-h-12 text-lg" />
          <div className="flex gap-2">
            <Input value={interval} onChange={(event) => setRepeat(event.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" aria-label={asset ? 'Repeat every' : 'Repeat every (months)'} placeholder={asset ? 'Every' : 'Months'} className="min-h-12 text-base" data-testid="tablet-maintenance-schedule-interval" />
            {asset ? (
              <select value={frequency} onChange={(event) => setFrequency(event.target.value)} aria-label="Unit" className="min-h-12 rounded-md border border-input bg-background px-3 text-base">
                <option value="days">days</option>
                <option value="weeks">weeks</option>
                <option value="months">months</option>
                <option value="years">years</option>
              </select>
            ) : (
              <Input value={miles} onChange={(event) => setMiles(event.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" aria-label="Repeat every (miles)" placeholder="Miles" className="min-h-12 text-base" />
            )}
          </div>
          <Input type="date" value={nextDue} onChange={(event) => setNextDue(event.target.value)} aria-label="Next due" className="min-h-12 text-base" />
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
            <button type="submit" className={PRIMARY} disabled={form.busy} data-testid="tablet-maintenance-schedule-save">Save</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

