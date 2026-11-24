'use client';

import { useState } from 'react';
import { collection, deleteDoc, deleteField, doc, getDocs, setDoc, writeBatch } from 'firebase/firestore';
import { deleteObject, getDownloadURL, getStorage, ref, uploadBytes } from 'firebase/storage';
import { summarizeMaintenanceLog } from '@/ai/flows/summarize-maintenance-log';
import { AiClientError, getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { notificationsBySourceQuery } from '@/app/notifications/notification-query';
import type { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { publicDisplayName } from '@/lib/member-directory';
import { createNotificationAction, parseNotificationDoc } from '@/lib/notifications';
import type {
  HomeAsset, MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType, MaintenanceLog, Notification,
  Vehicle,
} from '@/lib/types';
import { cleanForFirestore, createLocalId, getAttachmentsForTarget, getLogTargetType, sanitizeFileName } from './page-model';
import { useStableHandler } from './use-stable-handler';

type Setter<T> = (value: T | ((previous: T) => T)) => void;

/**
 * Attachments (upload, delete), log and registry deletion, and AI summaries: client writes
 * under the existing rules, unchanged by M1. The live listeners show their results, so none
 * re-reads after writing; registry deletion still reads the record's logs and reminders just
 * before its batch (that read decides what the batch changes).
 */
export function useMaintenanceRecords({ currentUser, attachments, setSelectedAssetId, setSelectedVehicleId }: {
  currentUser: ReturnType<typeof useAuth>['currentUser'];
  attachments: MaintenanceAttachment[];
  setSelectedAssetId: Setter<string | null>;
  setSelectedVehicleId: Setter<string | null>;
}) {
  const { toast, toastError } = useToast();
  const [logToDelete, setLogToDelete] = useState<MaintenanceLog | null>(null);
  const [assetToDelete, setAssetToDelete] = useState<HomeAsset | null>(null);
  const [vehicleToDelete, setVehicleToDelete] = useState<Vehicle | null>(null);
  const [attachmentToDelete, setAttachmentToDelete] = useState<MaintenanceAttachment | null>(null);
  const [deletingRecord, setDeletingRecord] = useState<string | null>(null);
  const [uploadingAttachmentTarget, setUploadingAttachmentTarget] = useState<string | null>(null);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [loadingSummaries, setLoadingSummaries] = useState<Record<string, boolean>>({});

  const getCollectionRef = (collectionName: 'home-assets' | 'vehicles' | 'maintenance' | 'maintenance-attachments' | 'notifications') => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, collectionName);
  };

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
    } catch (deleteError) {
      console.error('Error deleting maintenance attachment:', deleteError);
      toastError(deleteError, 'Could not delete the attachment');
    } finally {
      setDeletingAttachmentId(null);
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

  return {
    logToDelete, setLogToDelete,
    assetToDelete, setAssetToDelete,
    vehicleToDelete, setVehicleToDelete,
    attachmentToDelete, setAttachmentToDelete,
    deletingRecord, uploadingAttachmentTarget, deletingAttachmentId, summaries, loadingSummaries,
    uploadAttachment: useStableHandler(uploadAttachment),
    deleteAttachment: useStableHandler(deleteAttachment),
    deleteLog: useStableHandler(deleteLog),
    deleteAsset: useStableHandler(deleteAsset),
    deleteVehicle: useStableHandler(deleteVehicle),
    handleSummarize: useStableHandler(handleSummarize),
  };
}
