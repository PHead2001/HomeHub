'use client';

import { useCallback } from 'react';
import { deleteField, doc, writeBatch } from 'firebase/firestore';
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { awaitWriteUnlessOffline } from '@/lib/firestore-offline';
import { createNotificationAction } from '@/lib/notifications';

/** How long the Undo action stays available after a dismissal. */
export const DISMISS_UNDO_MS = 5000;

/** Toast copy for a dismissal of `count` notifications. */
export function dismissedToastText(count: number): string {
  return count === 1 ? 'Notification dismissed' : `${count} notifications dismissed`;
}

/**
 * Dismisses notifications for the signed-in member and offers Undo for five
 * seconds. Both writes touch only `dismissedBy.<own uid>` (set, then removed),
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
    const handle = toast({
      title: dismissedToastText(ids.length),
      duration: DISMISS_UNDO_MS,
      action: (
        <ToastAction
          altText={ids.length === 1 ? 'Undo dismissing the notification' : 'Undo dismissing the notifications'}
          onClick={() => {
            handle.dismiss();
            void write(ids, true);
          }}
        >
          Undo
        </ToastAction>
      ),
    });
  }, [toast, write]);
}
