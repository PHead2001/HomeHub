// Small presentation rules for the Maintenance Center, kept pure for unit tests.
import type { MaintenanceAttachment } from '../types';

/**
 * "Summarize with AI" only appears when there is something to summarize: notes
 * with at least two statements (split on . ! ? ; or line breaks, each at least
 * two words) or at least 40 words. A one-sentence note is already its summary.
 */
export const shouldOfferAiSummary = (notes?: string | null) => {
  const text = notes?.trim();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words >= 40) return true;
  const statements = text
    .split(/[.!?;]+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).filter(Boolean).length >= 2);
  return statements.length >= 2;
};

const IMAGE_TYPE = /^image\/(png|jpe?g|webp|gif|avif)$/i;
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|avif)$/i;

/** True for an attachment that can be shown as a picture. */
export const isImageAttachment = (attachment: Pick<MaintenanceAttachment, 'contentType' | 'fileName' | 'downloadUrl'>) =>
  Boolean(attachment.downloadUrl) && (
    attachment.contentType ? IMAGE_TYPE.test(attachment.contentType) : IMAGE_NAME.test(attachment.fileName)
  );

/**
 * The picture for an asset or vehicle card (H30): the newest image attached to
 * it, preferring the "photo" category over receipts or manuals that happen to be
 * images. Null means the card shows the brand logo or category art instead.
 */
export const pickTargetPhoto = (
  attachments: MaintenanceAttachment[],
  targetType: 'home_asset' | 'vehicle',
  targetId: string,
): MaintenanceAttachment | null => {
  const images = attachments
    .filter((attachment) => attachment.targetType === targetType && attachment.targetId === targetId && isImageAttachment(attachment))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return images.find((attachment) => attachment.category === 'photo') || images[0] || null;
};

export const pickAssetPhoto = (attachments: MaintenanceAttachment[], assetId: string) => pickTargetPhoto(attachments, 'home_asset', assetId);
export const pickVehiclePhoto = (attachments: MaintenanceAttachment[], vehicleId: string) => pickTargetPhoto(attachments, 'vehicle', vehicleId);

export type DetailField = { label: string; value: string };

/** Keeps only fields that have a value, so the detail panel never says "Not recorded" (D15). */
export const presentFields = (fields: Array<{ label: string; value?: string | number | null }>): DetailField[] =>
  fields.flatMap(({ label, value }) => {
    if (value === undefined || value === null) return [];
    const text = String(value).trim();
    return text ? [{ label, value: text }] : [];
  });
