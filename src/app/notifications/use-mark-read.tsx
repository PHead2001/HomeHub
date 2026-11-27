'use client';

import { useCallback } from 'react';
import { doc, writeBatch } from 'firebase/firestore';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { awaitWriteUnlessOffline } from '@/lib/firestore-offline';
import { createNotificationAction } from '@/lib/notifications';

/** Firestore allows 500 writes per batch. */
const BATCH = 400;

/**
 * NO-14: "Mark all read". Writes only the member's own `readBy.<uid>` entry, which
 * `notifications.view` allows (NO-8), so guests can clear their badge too. Offline,
 * the writes queue and sync on reconnect. Resolves how many were marked.
 */
export function useMarkRead() {
  const { currentUser } = useAuth();
  const { toast, toastError } = useToast();
  return useCallback(async (ids: string[]) => {
    if (!currentUser?.householdId || !currentUser.uid || ids.length === 0) return 0;
    const action = createNotificationAction(currentUser);
    try {
      for (let start = 0; start < ids.length; start += BATCH) {
        const batch = writeBatch(db);
        ids.slice(start, start + BATCH).forEach((id) => {
          batch.update(doc(db, 'households', currentUser.householdId!, 'notifications', id), { [`readBy.${currentUser.uid}`]: action });
        });
        await awaitWriteUnlessOffline(batch.commit(), (error) => toastError(error, 'Could not mark notifications read'));
      }
      toast({ title: ids.length === 1 ? 'Marked as read' : `${ids.length} notifications marked as read` });
      return ids.length;
    } catch (error) {
      console.error('Error marking notifications read:', error);
      toastError(error, 'Could not mark notifications read');
      return 0;
    }
  }, [currentUser, toast, toastError]);
}
