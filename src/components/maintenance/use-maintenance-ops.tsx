'use client';

import * as React from 'react';
import { useCallback, useRef, useState } from 'react';
import type { MaintenanceLog } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { playFeedback } from '@/lib/feedback';
import { ToastAction } from '@/components/ui/toast';
import { UNDO_WINDOW_MS } from '@/lib/undo-window';
import {
  completeMaintenanceSchedule, undoMaintenanceCompletion, undoMaintenanceSnooze, type MaintenanceActionResult,
} from '@/app/maintenance/actions';
import {
  CHANGED_MESSAGE, UNDO_HAS_ATTACHMENTS_MESSAGE, NO_ANSWER_MESSAGE, OFFLINE_MESSAGE, alreadyDoneMessage, callMaintenanceAction, keptMessage,
  mileageWarningMessage, newOpId,
} from './maintenance-action-client';
import { cycleOf, mileageWarning, scheduleRef, type CompletionRefusal, type StoredSchedule } from '@/lib/maintenance/operations';
import type { ScheduleCompletionTarget } from '@/lib/maintenance/schedules';
import type { MarkDoneResult } from './reminder-list';
import { formatDate, getScheduleCompletionName, trimOptional, type SaveNoticeState } from './page-model';
import { useStableHandler } from './use-stable-handler';
import { createPendingRequests } from '@/lib/maintenance/action-call';

/** An unanswered request kept for the next press: same op id, same call, same handling. */
type HeldRequest<T, R> = {
  opId: string;
  call: (context: { idToken: string; householdId: string }) => Promise<MaintenanceActionResult<T>>;
  handle: (data: T) => Promise<R> | R;
};

/**
 * The page's server operations (M1): requests in flight and their dialog notices, the one-time
 * odometer warning, completion with its 10 s Undo, and Undo of a snooze. Results arrive through
 * the page's live listeners (MA-2), so nothing here re-reads after a write.
 */
export function useMaintenanceOps({ householdId, onTargetSettled }: {
  householdId: string | null | undefined;
  /** Called when a completion's outcome is final: the page selects that asset or vehicle. */
  onTargetSettled: (target: ScheduleCompletionTarget) => void;
}) {
  const { toast } = useToast();
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
  // Bumped by a successful Undo: the reminder lists start over, so the reopened cycle's
  // card (same cycle key as the one that was checked) shows unchecked with its actions.
  const [reminderListEpoch, setReminderListEpoch] = useState(0);

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
  };

  const undoSnooze = async (opId: string) => {
    
    if (!householdId) return;
    const outcome = await callMaintenanceAction(householdId, context => undoMaintenanceSnooze({ ...context, opId }));
    if (outcome.kind !== 'ok') {
      toast({ variant: 'destructive', title: "Couldn't undo", description: outcome.kind === 'failed' ? outcome.message : outcome.kind === 'offline' ? OFFLINE_MESSAGE : NO_ANSWER_MESSAGE });
    } else if (outcome.data.status === 'undone') {
      toast({ title: 'Snooze undone', description: keptMessage(outcome.data.kept, 'snoozed it') || undefined });
    } else if (outcome.data.status === 'expired') {
      toast({ title: "Can't undo", description: 'The time to undo has passed.' });
    }
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
      onTargetSettled(target);
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
      return result.status === 'completed' || result.status === 'already_done' ? 'done' : 'failed';
    }, options.surface);
  };

  return {
    inFlight,
    notices,
    clearNotice,
    mileageCheck,
    setMileageCheck,
    reminderListEpoch,
    runOp: useStableHandler(runOp),
    closable: useStableHandler(closable),
    discardPending: useStableHandler(discardPending),
    mileageConfirmed: useStableHandler(mileageConfirmed),
    undoSnooze: useStableHandler(undoSnooze),
    completeSchedule: useStableHandler(completeSchedule),
    ownerIdOf,
  };
}
