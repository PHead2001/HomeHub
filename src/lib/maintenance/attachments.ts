// Maintenance attachment rules in the browser (MA-11b, MA-11c, MA-25d), pure for unit tests.
// The limits mirror storage.rules (validMaintenanceFile): under 15 MiB, and only the types below.
import type { MaintenanceAttachment, MaintenanceAttachmentCategory, MaintenanceAttachmentTargetType } from '../types';

/** storage.rules: `request.resource.size <= 15 * 1024 * 1024`. */
export const MAINTENANCE_FILE_MAX_BYTES = 15 * 1024 * 1024;
/** The display copy's longer edge (MA-25d) and the thumbnail's. */
export const DISPLAY_MAX_EDGE = 1024;
export const THUMBNAIL_MAX_EDGE = 256;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif'] as const;
const DOCUMENT_TYPES = [
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
/** Exactly the content types storage.rules accepts. */
export const MAINTENANCE_FILE_TYPES: readonly string[] = [...IMAGE_TYPES, ...DOCUMENT_TYPES];

const BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  pdf: 'application/pdf', txt: 'text/plain', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The "accept" list for pickers: the rules' types plus their extensions (HEIC often has no type). */
export const MAINTENANCE_FILE_ACCEPT = [...MAINTENANCE_FILE_TYPES, ...Object.keys(BY_EXTENSION).map(extension => `.${extension}`)].join(',');
/** The receipt picker (MA-16): images (camera on phones) and PDFs. */
export const RECEIPT_ACCEPT = 'image/*,application/pdf,.heic,.heif,.pdf';

const extensionOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();

/**
 * The content type to upload with: the browser's type when it is one the rules accept, else
 * the extension's (phones often report HEIC with an empty type, or `image/heic-sequence`).
 * `image/jpg` is read as JPEG. Null: not a type HomeHub stores.
 */
export const inferContentType = (file: { name: string; type?: string | null }): string | null => {
  const type = (file.type || '').toLowerCase().trim();
  const normalized = type === 'image/jpg' || type === 'image/pjpeg' ? 'image/jpeg' : type;
  if (MAINTENANCE_FILE_TYPES.includes(normalized)) return normalized;
  const byExtension = BY_EXTENSION[extensionOf(file.name)];
  if (byExtension && (!normalized || normalized === 'application/octet-stream' || normalized.startsWith('image/'))) return byExtension;
  return null;
};

export const isHeicType = (contentType: string | null | undefined) => contentType === 'image/heic' || contentType === 'image/heif';
export const isImageType = (contentType: string | null | undefined) => Boolean(contentType && (IMAGE_TYPES as readonly string[]).includes(contentType));

export type FileCheck =
  | { ok: true; contentType: string; image: boolean; heic: boolean }
  | { ok: false; reason: 'empty' | 'too_large' | 'type'; message: string };

/** Checks a picked file in the browser with the same limits as storage.rules (MA-11c). */
export const checkMaintenanceFile = (file: { name: string; type?: string | null; size: number }): FileCheck => {
  if (!(file.size > 0)) return { ok: false, reason: 'empty', message: `${file.name || 'This file'} is empty. Choose another file.` };
  if (file.size > MAINTENANCE_FILE_MAX_BYTES) {
    return { ok: false, reason: 'too_large', message: `${file.name} is larger than 15 MB. Choose a smaller file or a photo.` };
  }
  const contentType = inferContentType(file);
  if (!contentType) {
    return { ok: false, reason: 'type', message: `${file.name} can't be attached. Use a photo, PDF, text, Word or Excel file.` };
  }
  return { ok: true, contentType, image: isImageType(contentType), heic: isHeicType(contentType) };
};

/**
 * The category a new upload starts with (MA-11b). A log's file is a receipt; on an asset or
 * vehicle a picture starts as a photo and a document as a manual, never as a photo, so a PDF
 * never becomes the card picture. The person can change it before uploading.
 */
export const defaultAttachmentCategory = (targetType: MaintenanceAttachmentTargetType, contentType: string | null): MaintenanceAttachmentCategory => {
  if (targetType === 'maintenance_log') return 'receipt';
  return isImageType(contentType) ? 'photo' : 'manual';
};

/** Categories that are evidence of a purchase: never a card picture (MA-11b). */
export const PROOF_CATEGORIES: readonly MaintenanceAttachmentCategory[] = ['receipt', 'invoice'];

/**
 * Where an attachment's derived copies live: siblings of the file in the record's own folder
 * (storage.rules matches one file name per record folder), named by the attachment id. The
 * original is `{attachmentId}-{sanitized name}`, and a sanitized name never contains `~`
 * (`sanitizeFileName` keeps only letters, digits, `.`, `_` and `-`), so `{attachmentId}~display.jpg`
 * can never be an original's path, whatever the file was called (a photo named "display.jpg"
 * included). Attachments stored before this keep their older `-display.jpg`/`-thumb.jpg` paths in
 * their metadata, which are read and deleted as they are.
 */
export const originalFilePath = (folder: string, attachmentId: string, fileName: string) =>
  `${folder}${attachmentId}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '-')}`;

export const derivedFilePaths = (folder: string, attachmentId: string) => ({
  displayPath: `${folder}${attachmentId}~display.jpg`,
  thumbnailPath: `${folder}${attachmentId}~thumb.jpg`,
});

export const attachmentFolder = (householdId: string, targetType: MaintenanceAttachmentTargetType, targetId: string) =>
  `households/${householdId}/maintenance/${targetType}/${targetId}/`;

/** The URL to show an attachment as a picture: its display copy, else the file itself. */
export const attachmentImageUrl = (attachment: Pick<MaintenanceAttachment, 'downloadUrl' | 'displayUrl'>) =>
  attachment.displayUrl || attachment.downloadUrl || null;

/** The small picture for lists: the thumbnail, else the display copy, else the file. */
export const attachmentThumbnailUrl = (attachment: Pick<MaintenanceAttachment, 'downloadUrl' | 'displayUrl' | 'thumbnailUrl' | 'contentType'>) =>
  attachment.thumbnailUrl || attachment.displayUrl || (isHeicType(attachment.contentType) ? null : attachment.downloadUrl) || null;

/** "Delete Kitchen fridge and its 3 attachments" (MA-22): the confirmation's action label. */
export const deleteActionLabel = (kind: 'home_asset' | 'vehicle' | 'maintenance_log', name: string, files: number) => {
  if (files <= 0) return kind === 'maintenance_log' ? 'Delete Log' : kind === 'vehicle' ? 'Delete Vehicle' : 'Delete Home Asset';
  const what = name || (kind === 'vehicle' ? 'vehicle' : 'asset');
  if (kind === 'maintenance_log') return `Delete log and its ${files} ${files === 1 ? 'file' : 'files'}`;
  return `Delete ${what} and its ${files} ${files === 1 ? 'attachment' : 'attachments'}`;
};
