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
import { FEED_UNDO_MS, feedAgainPrompt, feedAgainReason } from '@/lib/pets/feed-decision';
import { feedPet, undoFeed, type FeedPetInput, type FeedPetResult } from '@/lib/pets/feed-operation';

/** A feeding request as an entry point describes it; who, where and the zone come from the session. */
export type FeedRequest = Pick<FeedPetInput, 'portion' | 'food' | 'comments' | 'backdatedAt' | 'known'>;

export type FeedSuccess = Extract<FeedPetResult, { status: 'saved' | 'queued' }>;

export type FeedAction = {
  /** The member may log feedings (`pets.addLogs`); they can then also Undo their own feed. */
  allowed: boolean;
  saving: boolean;
  /** "Sam fed Rex 12 min ago. Feed again?" while the member is being asked; null otherwise. */
  prompt: string | null;
  /** The reason alone ("Sam fed Rex 12 min ago."), for a dialog titled "Feed Rex again?". */
  reason: string | null;
  /** Logs (or asks first). Resolves with the result, or null when nothing was written. */
  run: (request: FeedRequest) => Promise<FeedPetResult | null>;
  /** "Feed again": logs the asked-about feeding anyway. */
  acceptPrompt: () => Promise<FeedPetResult | null>;
  cancelPrompt: () => void;
};

type Callbacks = {
  /** Called after a feeding is saved or queued (feedback, burst, closing a form). */
  onFed?: (result: FeedSuccess) => void;
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
 */
export function useFeedAction(petId: string, petName: string, callbacks: Callbacks = {}): FeedAction {
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const [asked, setAsked] = React.useState<{ request: FeedRequest; prompt: string; reason: string } | null>(null);
  const callbacksRef = React.useRef(callbacks);
  React.useEffect(() => { callbacksRef.current = callbacks; });
  const allowed = Boolean(permissions['pets.addLogs']);
  const householdId = currentUser?.householdId ?? null;
  const timeZone = household?.timeZone ?? null;

  // Retry from the failure toast runs the same request again.
  const retryRef = React.useRef<(request: FeedRequest, confirm: boolean) => void>(() => undefined);
  const execute = React.useCallback(async (request: FeedRequest, confirm: boolean): Promise<FeedPetResult | null> => {
    if (!allowed || !householdId || !currentUser || savingRef.current) return null;
    savingRef.current = true;
    setSaving(true);
    const lateError = (error: unknown) => toastError(error, `${petName}'s feeding didn't sync`);
    try {
      const result = await feedPet({
        ...request,
        householdId,
        petId,
        confirm,
        timeZone,
        user: { uid: currentUser.uid, name: loggerName(currentUser) },
        onLateError: lateError,
      });
      if (result.status === 'needsConfirm') {
        const now = new Date();
        setAsked({
          request,
          prompt: feedAgainPrompt(result, petName, now, currentUser.uid),
          reason: feedAgainReason(result, petName, now, currentUser.uid),
        });
        return result;
      }
      setAsked(null);
      callbacksRef.current.onFed?.(result);
      const described = callbacksRef.current.describe?.(result) ?? { title: `${petName} fed` };
      const { dismiss } = toast({
        duration: FEED_UNDO_MS,
        ...(result.status === 'queued'
          ? { title: 'Saved on this device', description: `Couldn't check whether someone else fed ${petName}.` }
          : described),
        action: (
          <ToastAction
            altText={`Undo feeding for ${petName}`}
            onClick={async () => {
              dismiss();
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
          <ToastAction altText={`Try logging ${petName}'s feeding again`} onClick={() => retryRef.current(request, confirm)}>
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
    retryRef.current = (request, confirm) => void execute(request, confirm);
  }, [execute]);

  const run = React.useCallback((request: FeedRequest) => execute(request, false), [execute]);
  const acceptPrompt = React.useCallback(async () => {
    if (!asked) return null;
    return execute(asked.request, true);
  }, [asked, execute]);
  const cancelPrompt = React.useCallback(() => setAsked(null), []);

  return { allowed, saving, prompt: asked?.prompt ?? null, reason: asked?.reason ?? null, run, acceptPrompt, cancelPrompt };
}

/** The "Feed again?" question as a dialog (Feed again / Cancel). */
export function FeedAgainDialog({ action, petName }: { action: Pick<FeedAction, 'prompt' | 'reason' | 'acceptPrompt' | 'cancelPrompt' | 'saving'>; petName: string }) {
  return (
    <AlertDialog open={action.prompt !== null} onOpenChange={(open) => !open && action.cancelPrompt()}>
      <AlertDialogContent data-testid="feed-again-dialog">
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
