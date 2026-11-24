'use client';

import { useEffect, useState } from 'react';
import { collection, deleteDoc, doc } from 'firebase/firestore';
import { deleteObject, getStorage, ref } from 'firebase/storage';
import { summarizeStoredMaintenanceLog } from '@/ai/flows/summarize-maintenance-log';
import { AiClientError, getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { deleteMaintenanceRecord, type DeleteRecordResult } from '@/app/maintenance/actions';
import { ToastAction } from '@/components/ui/toast';
import type { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { publicDisplayName } from '@/lib/member-directory';
import type {
  HomeAsset, MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType, MaintenanceLog, Vehicle,
} from '@/lib/types';
import { RECEIPT_ACCEPT, checkMaintenanceFile } from '@/lib/maintenance/attachments';
import { uploadMaintenanceFile } from './attachment-upload';
import { NO_ANSWER_MESSAGE, OFFLINE_MESSAGE, callMaintenanceAction } from './maintenance-action-client';
import { getAttachmentsForTarget } from './page-model';
import { receiptStaging } from './receipt-staging';
import { useStableHandler } from './use-stable-handler';

/** What a delete confirmation shows when the delete did not finish (MA-11a): it stays open. */
export type DeleteOutcome = { ok: true } | { ok: false; message: string };

type Setter<T> = (value: T | ((previous: T) => T)) => void;

/**
 * Attachments (upload, delete), record and log deletion, and AI summaries. Uploads are client
 * writes under the rules (checked, bounded and cleaned up: attachment-upload.ts); receipts staged
 * in the log form are uploaded here once the log is saved. Deleting an asset, vehicle or log is
 * one server operation with its own files (MA-22, MA-4c: deleteMaintenanceRecord); its
 * confirmation stays open with a spinner until it answers and shows a failure inline (MA-11a).
 * The live listeners show every result, so nothing re-reads after writing.
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

  const getCollectionRef = (collectionName: 'maintenance-attachments') => {
    if (!currentUser?.householdId) return null;
    return collection(db, 'households', currentUser.householdId, collectionName);
  };

  // Maintenance reminder notifications are created by the server on a schedule
  // (functions/src/reminders.ts), not by whoever has this page open.

  /** Uploads files to one record; returns how many were attached (failures are reported). */
  const uploadFiles = async (
    targetType: MaintenanceAttachmentTargetType,
    targetId: string,
    category: MaintenanceAttachmentCategory,
    files: File[],
  ): Promise<{ attached: number; failed: File[]; message?: string }> => {
    const attachmentsCollection = getCollectionRef('maintenance-attachments');
    if (!currentUser?.householdId || !currentUser.uid || !attachmentsCollection) return { attached: 0, failed: files };
    let attached = 0;
    const failed: File[] = [];
    let message: string | undefined;
    for (const file of files) {
      const outcome = await uploadMaintenanceFile({
        householdId: currentUser.householdId,
        uid: currentUser.uid,
        uploadedByName: publicDisplayName(currentUser.displayName),
        collection: attachmentsCollection,
        targetType,
        targetId,
        category,
        file,
      });
      if (outcome.ok) attached += 1;
      else {
        failed.push(file);
        message = outcome.message;
      }
    }
    return { attached, failed, message };
  };

  const uploadAttachment = async (
    targetType: MaintenanceAttachmentTargetType,
    targetId: string,
    category: MaintenanceAttachmentCategory,
    file: File
  ) => {
    if (!currentUser?.householdId || uploadingAttachmentTarget) return;
    setUploadingAttachmentTarget(`${targetType}:${targetId}`);
    try {
      const result = await uploadFiles(targetType, targetId, category, [file]);
      if (result.attached > 0) toast({ title: 'Attachment uploaded' });
      else toast({ variant: 'destructive', title: 'Upload failed', description: result.message });
    } finally {
      setUploadingAttachmentTarget(null);
    }
  };

  /** Receipts staged in the log form go to the log the server just saved (MA-16). */
  const attachReceipts = async (logId: string, files: File[]) => {
    const target = `maintenance_log:${logId}`;
    setUploadingAttachmentTarget(target);
    try {
      const result = await uploadFiles('maintenance_log', logId, 'receipt', files);
      if (result.failed.length === 0) {
        toast({ title: result.attached === 1 ? 'Receipt attached' : `${result.attached} files attached` });
        return;
      }
      const retryFiles = result.failed;
      const handle = toast({
        variant: 'destructive',
        title: result.attached > 0 ? `${result.failed.length} of ${files.length} files not attached` : 'Receipt not attached',
        description: `${result.message ?? 'Upload failed.'} The log is saved.`,
        action: (
          <ToastAction altText="Try attaching again" onClick={() => { handle.dismiss(); void attachReceipts(logId, retryFiles); }}>Try again</ToastAction>
        ),
      });
    } finally {
      setUploadingAttachmentTarget(previous => (previous === target ? null : previous));
    }
  };
  const stableAttachReceipts = useStableHandler(attachReceipts);

  /**
   * "Add photo" for the log-saved toast (MA-16): opens the camera/file picker (images and PDFs)
   * and attaches what is picked to that log as receipts. A file that fails the storage.rules
   * limits is reported and skipped.
   */
  const pickReceiptsFor = (logId: string) => {
    if (typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = RECEIPT_ACCEPT;
    input.multiple = true;
    input.onchange = () => {
      const picked = Array.from(input.files ?? []);
      const problems = picked.map(file => checkMaintenanceFile(file)).flatMap(check => (check.ok ? [] : [check.message]));
      if (problems.length > 0) toast({ variant: 'destructive', title: 'Some files were not attached', description: problems.join(' ') });
      const valid = picked.filter(file => checkMaintenanceFile(file).ok);
      if (valid.length > 0) void attachReceipts(logId, valid);
    };
    input.click();
  };
  const stablePickReceiptsFor = useStableHandler(pickReceiptsFor);
  /** The log-saved toast's action: `toast({ title, action: addPhotoAction(result.id) })`. */
  const addPhotoAction = (logId: string) => (
    <ToastAction altText="Add a receipt or photo to this log" onClick={() => stablePickReceiptsFor(logId)}>Add photo</ToastAction>
  );
  useEffect(() => {
    receiptStaging.setUploader(stableAttachReceipts);
    return () => receiptStaging.setUploader(null);
  }, [stableAttachReceipts]);

  const deleteAttachment = async (attachment: MaintenanceAttachment): Promise<DeleteOutcome> => {
    if (!currentUser?.householdId || deletingAttachmentId) return { ok: false, message: 'Another delete is still running.' };
    const attachmentsCollection = getCollectionRef('maintenance-attachments');
    if (!attachmentsCollection) return { ok: false, message: 'Not signed in.' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, message: OFFLINE_MESSAGE };

    setDeletingAttachmentId(attachment.id);

    try {
      // The file first, then its derived copies (best effort), then the metadata: a missing object is fine.
      for (const [index, path] of [attachment.filePath, attachment.displayPath, attachment.thumbnailPath].entries()) {
        if (!path) continue;
        try {
          await deleteObject(ref(getStorage(), path));
        } catch (storageError) {
          const code = typeof storageError === 'object' && storageError && 'code' in storageError
            ? String((storageError as { code?: unknown }).code)
            : '';
          if (code !== 'storage/object-not-found' && index === 0) throw storageError;
        }
      }

      await deleteDoc(doc(attachmentsCollection, attachment.id));
      setAttachmentToDelete(null);
      toast({ title: 'Attachment deleted' });
      return { ok: true };
    } catch (deleteError) {
      console.error('Error deleting maintenance attachment:', deleteError);
      toastError(deleteError, 'Could not delete the attachment');
      return { ok: false, message: 'Could not delete the attachment. Try again.' };
    } finally {
      setDeletingAttachmentId(null);
    }
  };

  /**
   * Deletes a record with its own files on the server (one confirmed operation). The confirmation
   * stays open with its spinner until the answer; a failure is returned for the dialog to show.
   */
  const deleteOnServer = async (
    targetType: 'home_asset' | 'vehicle' | 'maintenance_log',
    targetId: string,
  ): Promise<{ ok: true; data: DeleteRecordResult } | { ok: false; message: string }> => {
    const householdId = currentUser?.householdId;
    if (!householdId) return { ok: false, message: 'Not signed in.' };
    const outcome = await callMaintenanceAction(householdId, context => deleteMaintenanceRecord({ ...context, target: { targetType, targetId } }));
    if (outcome.kind === 'ok') return { ok: true, data: outcome.data };
    if (outcome.kind === 'offline') return { ok: false, message: OFFLINE_MESSAGE };
    if (outcome.kind === 'no_answer') return { ok: false, message: `${NO_ANSWER_MESSAGE} Delete again to finish it.` };
    return { ok: false, message: outcome.message };
  };

  const pendingNote = (result: DeleteRecordResult) => (result.pending
    ? 'Some files are still being removed; HomeHub finishes within the hour.'
    : undefined);

  const deleteLog = async (): Promise<DeleteOutcome> => {
    if (!logToDelete || deletingRecord) return { ok: false, message: 'Another delete is still running.' };
    const target = logToDelete;
    setDeletingRecord(`log:${target.id}`);
    try {
      const result = await deleteOnServer('maintenance_log', target.id);
      if (!result.ok) return result;
      setSummaries(prev => {
        const next = { ...prev };
        delete next[target.id];
        return next;
      });
      setLogToDelete(null);
      toast({
        title: result.data.attachments > 0 ? `Maintenance log and ${result.data.attachments} ${result.data.attachments === 1 ? 'file' : 'files'} deleted` : 'Maintenance log deleted',
        description: pendingNote(result.data),
      });
      return { ok: true };
    } finally {
      setDeletingRecord(null);
    }
  };

  const deleteRegistryRecord = async (
    targetType: 'home_asset' | 'vehicle',
    target: HomeAsset | Vehicle
  ): Promise<DeleteOutcome> => {
    if (!currentUser?.householdId || deletingRecord) return { ok: false, message: 'Another delete is still running.' };
    setDeletingRecord(`${targetType}:${target.id}`);
    try {
      const result = await deleteOnServer(targetType, target.id);
      if (!result.ok) return result;
      if (targetType === 'home_asset') {
        setSelectedAssetId(previous => previous === target.id ? null : previous);
        setAssetToDelete(null);
      } else {
        setSelectedVehicleId(previous => previous === target.id ? null : previous);
        setVehicleToDelete(null);
      }
      const { attachments: files, logs: kept } = result.data;
      const parts = [
        files > 0 ? `${files} ${files === 1 ? 'attachment was' : 'attachments were'} deleted.` : '',
        kept > 0 ? `${kept} historical ${kept === 1 ? 'log was' : 'logs were'} preserved as general maintenance.` : '',
        pendingNote(result.data) ?? '',
      ].filter(Boolean);
      toast({
        title: `${targetType === 'home_asset' ? 'Home asset' : 'Vehicle'} deleted`,
        description: parts.length > 0 ? parts.join(' ') : undefined,
      });
      return { ok: true };
    } finally {
      setDeletingRecord(null);
    }
  };

  const deleteAsset = async (): Promise<DeleteOutcome> => {
    if (!assetToDelete) return { ok: false, message: 'Nothing to delete.' };
    return deleteRegistryRecord('home_asset', assetToDelete);
  };

  const deleteVehicle = async (): Promise<DeleteOutcome> => {
    if (!vehicleToDelete) return { ok: false, message: 'Nothing to delete.' };
    return deleteRegistryRecord('vehicle', vehicleToDelete);
  };

  /**
   * The log's AI summary (MA-11d): stored on the log by the server with the hash of its notes; a
   * current stored summary comes back without an AI call. `regenerate` asks for a new one.
   */
  const handleSummarize = async (log: MaintenanceLog, regenerate = false) => {
    const householdId = currentUser?.householdId;
    if (!log.notes || !householdId) return;

    setLoadingSummaries(prev => ({ ...prev, [log.id]: true }));
    try {
      const result = unwrapAiActionResult(await summarizeStoredMaintenanceLog(
        { logId: log.id, regenerate },
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

  /** How many files a delete of this record removes with it (for its confirmation, MA-22). */
  const fileCountFor = (targetType: MaintenanceAttachmentTargetType, targetId: string) =>
    getAttachmentsForTarget(attachments, targetType, targetId).length;

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
    fileCountFor: useStableHandler(fileCountFor),
    addPhotoAction: useStableHandler(addPhotoAction),
  };
}
