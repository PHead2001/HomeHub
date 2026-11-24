'use client';

// Uploading a maintenance attachment (MA-11c, MA-11k, MA-25d): checked in the browser with the
// same limits as storage.rules, uploaded with a stall watchdog (never hangs offline), with a
// 1024 px display copy and a 256 px thumbnail of a picture (the shared downscale helper), and
// the metadata written last. If the metadata is refused, every object just uploaded is removed
// again on the server (any uploader may ask; see cleanupMaintenanceUpload).
import { doc, setDoc, type CollectionReference } from 'firebase/firestore';
import { getDownloadURL, getStorage, ref, uploadBytesResumable, type UploadTask } from 'firebase/storage';
import { cleanupMaintenanceUpload } from '@/app/maintenance/actions';
import { auth } from '@/lib/firebase';
import { downscaleImage } from '@/lib/images/downscale';
import {
  DISPLAY_MAX_EDGE, MAINTENANCE_FILE_MAX_BYTES, THUMBNAIL_MAX_EDGE, attachmentFolder, checkMaintenanceFile, derivedFilePaths,
} from '@/lib/maintenance/attachments';
import type { MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType } from '@/lib/types';
import { OFFLINE_MESSAGE } from './maintenance-action-client';
import { cleanForFirestore, createLocalId, sanitizeFileName } from './page-model';

/** No upload progress for this long: the upload is cancelled and reported (never hangs). */
export const UPLOAD_STALL_MS = 30_000;
/** The metadata write and URL lookups wait this long at most. */
export const UPLOAD_STEP_DEADLINE_MS = 20_000;

export type UploadOutcome =
  | { ok: true; attachment: Omit<MaintenanceAttachment, 'id'> & { id: string } }
  | { ok: false; kind: 'invalid' | 'offline' | 'stalled' | 'refused' | 'failed' | 'no_answer'; message: string };

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

class StepTimeout extends Error {}

const withDeadline = async <T,>(work: Promise<T>, ms = UPLOAD_STEP_DEADLINE_MS): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StepTimeout()), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Uploads one object; cancelled when no bytes move for UPLOAD_STALL_MS or the browser goes offline. */
const uploadWatched = (path: string, data: Blob, contentType: string, uploadedByUid: string) => new Promise<void>((resolve, reject) => {
  const task: UploadTask = uploadBytesResumable(ref(getStorage(), path), data, { contentType, customMetadata: { uploadedByUid } });
  let stall: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => { reason = 'stalled'; task.cancel(); }, UPLOAD_STALL_MS);
  };
  let reason: 'stalled' | 'offline' | null = null;
  const onOffline = () => { reason = 'offline'; task.cancel(); };
  window.addEventListener('offline', onOffline);
  const done = () => { if (stall) clearTimeout(stall); window.removeEventListener('offline', onOffline); };
  arm();
  task.on('state_changed', arm, (error) => {
    done();
    reject(reason ? new Error(reason) : error);
  }, () => {
    done();
    resolve();
  });
});

const codeOf = (error: unknown) => (typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '');

/** Asks the server to remove objects this person just uploaded whose metadata never landed. */
export async function cleanupUploadedObjects(householdId: string, paths: string[]) {
  if (paths.length === 0) return;
  try {
    const user = auth.currentUser;
    if (!user) return;
    await withDeadline(cleanupMaintenanceUpload({ idToken: await user.getIdToken(), householdId, paths }));
  } catch (error) {
    // Left for the record's own delete (its folder is swept) or a later cleanup.
    console.error('Could not remove the uploaded file:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * Uploads one file to a record (asset, vehicle or log) and writes its metadata. Pictures get a
 * display copy and a thumbnail when the browser can decode them (HEIC usually only in Safari;
 * otherwise the HEIC file is stored as it is and shown with a "preview not available" tile).
 */
export async function uploadMaintenanceFile(input: {
  householdId: string;
  uid: string;
  uploadedByName: string;
  collection: CollectionReference;
  targetType: MaintenanceAttachmentTargetType;
  targetId: string;
  category: MaintenanceAttachmentCategory;
  file: File;
}): Promise<UploadOutcome> {
  const { householdId, uid, targetType, targetId, category, file } = input;
  const check = checkMaintenanceFile(file);
  if (!check.ok) return { ok: false, kind: 'invalid', message: check.message };
  if (offline()) return { ok: false, kind: 'offline', message: OFFLINE_MESSAGE };

  const attachmentId = `${Date.now()}-${createLocalId()}`;
  const folder = attachmentFolder(householdId, targetType, targetId);
  const filePath = `${folder}${attachmentId}-${sanitizeFileName(file.name)}`;
  const uploaded: string[] = [];
  try {
    await uploadWatched(filePath, file, check.contentType, uid);
    uploaded.push(filePath);
    const extra: Partial<MaintenanceAttachment> = {};
    if (check.image) {
      // MA-25d: a display copy and a thumbnail (JPEG). A file the browser cannot decode (HEIC
      // outside Safari) has neither; the original is kept and the card never breaks.
      const { displayPath, thumbnailPath } = derivedFilePaths(folder, attachmentId);
      const display = await downscaleImage(file, { maxEdge: DISPLAY_MAX_EDGE, maxBytes: MAINTENANCE_FILE_MAX_BYTES });
      if (display.ok && display.resized) {
        await uploadWatched(displayPath, display.file, display.file.type || 'image/jpeg', uid);
        uploaded.push(displayPath);
        extra.displayPath = displayPath;
        extra.displayUrl = await withDeadline(getDownloadURL(ref(getStorage(), displayPath)));
      }
      const thumbnail = await downscaleImage(display.ok && display.resized ? display.file : file, { maxEdge: THUMBNAIL_MAX_EDGE, maxBytes: MAINTENANCE_FILE_MAX_BYTES });
      if (thumbnail.ok && thumbnail.resized) {
        await uploadWatched(thumbnailPath, thumbnail.file, thumbnail.file.type || 'image/jpeg', uid);
        uploaded.push(thumbnailPath);
        extra.thumbnailPath = thumbnailPath;
        extra.thumbnailUrl = await withDeadline(getDownloadURL(ref(getStorage(), thumbnailPath)));
      }
    }
    const downloadUrl = await withDeadline(getDownloadURL(ref(getStorage(), filePath)));
    const attachment: Omit<MaintenanceAttachment, 'id'> = {
      householdId,
      targetType,
      targetId,
      category,
      fileName: file.name,
      filePath,
      downloadUrl,
      contentType: check.contentType,
      size: file.size,
      uploadedByUid: uid,
      // Every member who can see maintenance reads it: never the email.
      uploadedByName: input.uploadedByName,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    try {
      await withDeadline(setDoc(doc(input.collection, attachmentId), cleanForFirestore(attachment)));
    } catch (metadataError) {
      if (metadataError instanceof StepTimeout) {
        // The write may still land (queued): the files stay so it never points at nothing.
        return { ok: false, kind: 'no_answer', message: 'No answer from HomeHub. The file may have been attached.' };
      }
      // Refused (the record was deleted, or the receipt window passed): remove what was uploaded.
      await cleanupUploadedObjects(householdId, uploaded);
      return {
        ok: false,
        kind: codeOf(metadataError) === 'permission-denied' ? 'refused' : 'failed',
        message: codeOf(metadataError) === 'permission-denied'
          ? "This file couldn't be attached: the record may have been deleted, or you can't add files to it."
          : "This file couldn't be attached. Try again.",
      };
    }
    return { ok: true, attachment: { ...attachment, id: attachmentId } };
  } catch (error) {
    // An upload that failed part-way: remove the parts that did upload.
    await cleanupUploadedObjects(householdId, uploaded);
    const message = error instanceof Error ? error.message : '';
    if (message === 'offline' || offline()) return { ok: false, kind: 'offline', message: OFFLINE_MESSAGE };
    if (message === 'stalled' || error instanceof StepTimeout) {
      return { ok: false, kind: 'stalled', message: 'The upload stopped. Check the connection and try again. Your entries are kept.' };
    }
    if (codeOf(error) === 'storage/unauthorized') {
      return { ok: false, kind: 'refused', message: "You can't add files here." };
    }
    return { ok: false, kind: 'failed', message: 'Upload failed. Try again.' };
  }
}
