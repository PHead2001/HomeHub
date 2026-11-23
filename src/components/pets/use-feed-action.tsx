'use client';

import * as React from 'react';
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
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { loggerName } from '@/lib/pets/care';
import { FEED_UNDO_MS, feedAgainPrompt, feedAgainReason, petFeedToastGroup } from '@/lib/pets/feed-decision';
import { feedConfirmOf, newFeedOpId, type FeedConfirm } from '@/lib/pets/feed-plan';
import { formatClock } from '@/lib/pets/meal-plan';
import { feedPet, undoFeed, type FeedPetInput, type FeedPetResult } from '@/lib/pets/feed-operation';
import { TabletContext } from '@/components/devices/tablet-context';
import { backdatedCapability } from '@/lib/devices/action-policy';
import { PET_PERMISSIONS } from '@/lib/permissions';
import { useBackCloses } from '@/hooks/use-back-closes';

/** A feeding request as an entry point describes it; who, where and the zone come from the session. */
export type FeedRequest = Pick<FeedPetInput, 'portion' | 'portionFromSlot' | 'food' | 'comments' | 'backdatedAt' | 'known'>;

export type FeedSuccess = Extract<FeedPetResult, { status: 'saved' | 'queued' }>;

/** One press: its request, its operation id, and the "Feed again?" answer it carries (if any). */
type FeedAttempt = { request: FeedRequest; opId: string; confirm: FeedConfirm | null };

export type FeedAction = {
  /** The member may log feedings (`pets.addLogs`); they can then also Undo their own feed. */
  allowed: boolean;
  saving: boolean;
  /** "Sam fed Rex 12 min ago. Feed again?" while the member is being asked; null otherwise. */
  prompt: string | null;
  /** The reason alone ("Sam fed Rex 12 min ago."), for a dialog titled "Feed Rex again?". */
  reason: string | null;
  /**
   * Logs (or asks first). Resolves with the result, or null when nothing was written.
   * `opId`: the press's operation id when the caller keeps one across its own retries
   * (the earlier-time dialog: one dialog is one feeding, PE-23h); a new one otherwise.
   * On a tablet the device runtime makes it.
   */
  run: (request: FeedRequest, options?: { opId?: string }) => Promise<FeedPetResult | null>;
  /** "Feed again": logs the asked-about feeding anyway. */
  acceptPrompt: () => Promise<FeedPetResult | null>;
  cancelPrompt: () => void;
};

type Callbacks = {
  /** Called after a feeding is saved or queued (feedback, burst, closing a form). */
  onFed?: (result: FeedSuccess) => void;
  /**
   * Where focus goes once the toast's Undo ran (PE-20e), usually the control
   * that fed (the toast's own button disappears with it).
   */
  returnFocus?: () => void;
  /** Toast title and description for a saved feeding. */
  describe?: (result: FeedSuccess) => { title: string; description?: string };
};

/**
 * The UI side of the shared feed operation, used by every feeding entry point:
 * a spinner state while saving, the "Feed again?" question when the operation
 * asks for it, a toast with Undo for 10 s for everyone who can log (the rules let
 * the author delete their own feeding for 10 minutes), the honest offline copy
 * ("Saved on this device…", only once the write is queued), and a failure toast
 * with Retry. A call while a feeding is saving is ignored.
 *
 * One press is one intent (PE-23h): `run` takes a new operation id, and "Feed
 * again" and Retry reuse it, so a retry after an uncertain response finds the
 * first write instead of adding a second. "Feed again" sends the state the
 * question was shown for (PE-23g); if someone fed since, the operation asks
 * again with the new feeder. Each pet's Undo toast has its own group (PE-8i), so
 * feeding a second pet keeps the first pet's Undo.
 */
export function useFeedAction(petId: string, petName: string, callbacks: Callbacks = {}): FeedAction {
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const [asked, setAsked] = React.useState<{ attempt: FeedAttempt; prompt: string; reason: string } | null>(null);
  const callbacksRef = React.useRef(callbacks);
  React.useEffect(() => { callbacksRef.current = callbacks; });
  // On a registered wall tablet every feeding entry point is a device action (PE-17a): the
  // shell asks "Who's here?" (and a PIN when the level needs one), shows "Feed again?" and the
  // Undo toast; the server decides for the chosen person. Offered while Pets is on.
  const tablet = React.useContext(TabletContext);
  const allowed = tablet ? tablet.settings.sections.pets : Boolean(permissions[PET_PERMISSIONS.addLogs]);
  const householdId = currentUser?.householdId ?? null;
  const timeZone = household?.timeZone ?? null;

  // Retry from the failure toast runs the same request again.
  const retryRef = React.useRef<(attempt: FeedAttempt) => void>(() => undefined);
  const execute = React.useCallback(async (attempt: FeedAttempt): Promise<FeedPetResult | null> => {
    const { request, opId, confirm } = attempt;
    if (!allowed || !householdId || !currentUser || savingRef.current) return null;
    savingRef.current = true;
    setSaving(true);
    const lateError = (error: unknown) => toastError(error, `${petName}'s feeding didn't sync`);
    try {
      const result = await feedPet({
        ...request,
        householdId,
        petId,
        opId,
        confirm,
        timeZone,
        user: { uid: currentUser.uid, name: loggerName(currentUser) },
        onLateError: lateError,
      });
      if (result.status === 'needsConfirm') {
        const now = new Date();
        // The next answer is bound to this state; a stale one is asked again, naming the new feeder.
        const since = result.staleConfirm ? 'Someone fed since you were asked. ' : '';
        setAsked({
          attempt: { request, opId, confirm: feedConfirmOf(result) },
          prompt: `${since}${feedAgainPrompt(result, petName, now, currentUser.uid, timeZone)}`,
          reason: `${since}${feedAgainReason(result, petName, now, currentUser.uid, timeZone)}`,
        });
        return result;
      }
      setAsked(null);
      callbacksRef.current.onFed?.(result);
      const described = callbacksRef.current.describe?.(result) ?? { title: `${petName} fed` };
      const { dismiss } = toast({
        group: petFeedToastGroup(petId),
        duration: FEED_UNDO_MS,
        ...(result.status === 'queued'
          ? { title: 'Saved on this device', description: `Couldn't check whether someone else fed ${petName}.` }
          : described),
        action: (
          <ToastAction
            altText={`Undo feeding for ${petName}`}
            onClick={async () => {
              dismiss();
              callbacksRef.current.returnFocus?.();
              try {
                await undoFeed({ householdId, petId, logId: result.logId, timeZone, onLateError: lateError });
              } catch (error) {
                toastError(error, "Couldn't undo the feeding");
              }
            }}
          >
            Undo
          </ToastAction>
        ),
      });
      return result;
    } catch (error) {
      toastError(error, `Couldn't log ${petName}'s feeding`, {
        action: (
          <ToastAction altText={`Try logging ${petName}'s feeding again`} onClick={() => retryRef.current(attempt)}>
            Retry
          </ToastAction>
        ),
      });
      return null;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [allowed, householdId, currentUser, petId, petName, timeZone, toast, toastError]);

  React.useEffect(() => {
    // Retry runs the same press again: the same operation id and the same answer.
    retryRef.current = (attempt) => void execute(attempt);
  }, [execute]);

  const runOnTablet = React.useCallback(async (request: FeedRequest, opId?: string): Promise<FeedPetResult | null> => {
    if (!tablet || !allowed || savingRef.current) return null;
    savingRef.current = true;
    setSaving(true);
    try {
      const capability = request.backdatedAt ? backdatedCapability('feed', request.backdatedAt, new Date()) : 'pets.feed';
      const outcome = await tablet.runAction({
        capability,
        // A form's opId (the earlier-time dialog keeps one across its retries); else the runtime makes one.
        ...(opId ? { opId } : {}),
        // A chosen earlier time names it ("Fed Maple at 7:30 am"), household zone.
        label: request.backdatedAt ? `Fed ${petName} at ${formatClock(request.backdatedAt, tablet.household?.timeZone)}` : `Fed ${petName}`,
        subject: petName,
        // Each pet keeps its own Undo (PE-8i), as on the personal path.
        toastGroup: petFeedToastGroup(petId),
        intent: {
          petId,
          portion: request.portion,
          portionFromSlot: Boolean(request.portionFromSlot),
          food: request.food,
          ...(request.comments ? { comments: request.comments } : {}),
          ...(request.backdatedAt ? { backdatedAt: request.backdatedAt.toISOString() } : {}),
        },
      });
      if (!outcome.ok) return null;
      const data = (outcome.data as { result?: Partial<FeedSuccess> } | undefined)?.result;
      const success: FeedSuccess = outcome.queued
        ? { status: 'queued', logId: '', countToday: 0, perDay: null }
        : { status: 'saved', logId: data?.logId ?? '', countToday: data?.countToday ?? 0, perDay: data?.perDay ?? null, slot: data?.slot ?? null, ...(data?.portion ? { portion: data.portion } : {}), mealsComplete: Boolean(data?.mealsComplete) };
      callbacksRef.current.onFed?.(success);
      return success;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [allowed, petId, petName, tablet]);

  // A new press: a new operation id (on a tablet, the device runtime makes it).
  // A caller that keeps its own press id (the earlier-time dialog) passes it; on a tablet the runtime makes it.
  const run = React.useCallback((request: FeedRequest, options?: { opId?: string }) => (options?.opId
    ? (tablet ? runOnTablet(request, options.opId) : execute({ request, opId: options.opId, confirm: null }))
    : tablet ? runOnTablet(request) : execute({ request, opId: newFeedOpId(), confirm: null })), [execute, runOnTablet, tablet]);
  const acceptPrompt = React.useCallback(async () => {
    if (!asked) return null;
    return execute(asked.attempt);
  }, [asked, execute]);
  const cancelPrompt = React.useCallback(() => setAsked(null), []);

  return { allowed, saving, prompt: asked?.prompt ?? null, reason: asked?.reason ?? null, run, acceptPrompt, cancelPrompt };
}

/**
 * The "Feed again?" question as a dialog (Feed again / Cancel). It opens without
 * a trigger, so `returnFocus` names where focus goes when it closes (PE-20e).
 */
export function FeedAgainDialog({
  action,
  petName,
  returnFocus,
}: {
  action: Pick<FeedAction, 'prompt' | 'reason' | 'acceptPrompt' | 'cancelPrompt' | 'saving'>;
  petName: string;
  returnFocus?: () => void;
}) {
  // Android Back closes this dialog first (emulator evidence D4).
  useBackCloses(action.prompt !== null, action.cancelPrompt);

  return (
    <AlertDialog open={action.prompt !== null} onOpenChange={(open) => !open && action.cancelPrompt()}>
      <AlertDialogContent
        data-testid="feed-again-dialog"
        onCloseAutoFocus={returnFocus ? (event) => { event.preventDefault(); returnFocus(); } : undefined}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Feed {petName} again?</AlertDialogTitle>
          <AlertDialogDescription>{action.reason}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={action.saving} onClick={() => void action.acceptPrompt()}>
            Feed again
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
