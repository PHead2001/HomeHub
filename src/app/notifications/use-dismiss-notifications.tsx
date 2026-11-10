'use client';

import { useCallback } from 'react';
import { deleteField, doc, writeBatch } from 'firebase/firestore';
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { awaitWriteUnlessOffline } from '@/lib/firestore-offline';
import { createNotificationAction } from '@/lib/notifications';
import { DISMISS_UNDO_MS, dismissedToastText, notificationUndoBatch } from './undo-batch';

export { DISMISS_UNDO_MS, dismissedToastText } from './undo-batch';

/**
 * Dismisses notifications for the signed-in member and offers Undo for the
 * shared Undo window (`UNDO_WINDOW_MS`, 10 seconds). Both writes touch only `dismissedBy.<own uid>` (set, then removed),
 * which is the one per-member change the notification rules allow. Offline,
 * the writes queue and sync on reconnect.
 */
export function useDismissNotifications() {
  const { currentUser } = useAuth();
  const { toast, toastError } = useToast();

  const write = useCallback(async (ids: string[], undo: boolean) => {
    if (!currentUser?.householdId || !currentUser.uid) return false;
    const batch = writeBatch(db);
    const value = undo ? deleteField() : createNotificationAction(currentUser);
    ids.forEach((id) => {
      batch.update(doc(db, 'households', currentUser.householdId!, 'notifications', id), {
        [`dismissedBy.${currentUser.uid}`]: value,
      });
    });
    const title = undo ? 'Could not restore notifications' : 'Could not dismiss notifications';
    try {
      await awaitWriteUnlessOffline(batch.commit(), (error) => toastError(error, title));
      return true;
    } catch (error) {
      console.error(undo ? 'Error restoring notifications:' : 'Error dismissing notifications:', error);
      toastError(error, title);
      return false;
    }
  }, [currentUser, toastError]);

  return useCallback(async (ids: string[]) => {
    if (ids.length === 0 || !(await write(ids, false))) return;
    // One dismissal toast at a time: the newest toast's Undo restores every
    // dismissal made within the window, not just this one, so it replaces the
    // older dismissal toast at once (`group`; no second Undo, even mid-exit).
    const scope = `${currentUser?.householdId}|${currentUser?.uid}`;
    const pending = notificationUndoBatch.add(scope, ids);
    const handle = toast({
      group: 'notification-dismiss',
      title: dismissedToastText(pending.length),
      duration: DISMISS_UNDO_MS,
      action: (
        <ToastAction
          altText={pending.length === 1 ? 'Undo dismissing the notification' : `Undo dismissing ${pending.length} notifications`}
          onClick={() => {
            handle.dismiss();
            const restore = notificationUndoBatch.take(scope);
            if (restore.length > 0) void write(restore, true);
          }}
        >
          Undo
        </ToastAction>
      ),
    });
  }, [currentUser?.householdId, currentUser?.uid, toast, write]);
}
