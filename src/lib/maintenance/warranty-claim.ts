// Warranty-claim checklist (MA-33c): what a claim usually needs and what
// HomeHub already holds for one asset, with the gaps flagged. Pure. Reads only
// the asset's own fields and its attachment categories (no other people's data).
import { format } from 'date-fns';
import { diffDays, isDayString } from '../../../functions/src/shared/calendar';
import type { HomeAsset, MaintenanceAttachment } from '../types';

export type WarrantyClaimItemKey =
  | 'provider'
  | 'serialNumber'
  | 'model'
  | 'purchaseDate'
  | 'purchasePrice'
  | 'receipt'
  | 'warrantyEnd';

export type WarrantyClaimItem = {
  key: WarrantyClaimItemKey;
  label: string;
  /** True when HomeHub already has it. */
  have: boolean;
  /** What HomeHub has (e.g. the serial number, "Lifetime", "2 files"), when it has it. */
  value?: string;
  /** What to add when it is missing. */
  hint: string;
};

export type WarrantyClaimStatus = 'active' | 'lifetime' | 'ended' | 'unknown';

export type WarrantyClaimChecklist = {
  items: WarrantyClaimItem[];
  missing: number;
  status: WarrantyClaimStatus;
  /** One plain sentence about whether the warranty still covers a claim. */
  summary: string;
};

const RECEIPT_CATEGORIES = new Set<MaintenanceAttachment['category']>(['receipt', 'invoice', 'warranty_document']);

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const dayOf = (value?: string) => {
  const day = value?.slice(0, 10);
  return day && isDayString(day) ? day : undefined;
};
const longDate = (day: string) => format(new Date(`${day}T12:00:00`), 'MMM d, yyyy');

/**
 * The checklist for a claim on `asset`: provider, serial number, model, purchase
 * date, purchase price, a receipt or invoice (or warranty document) attached to
 * the asset, and the warranty end (or Lifetime). `attachments` may be the whole
 * household's list: only the asset's own are read.
 */
export const warrantyClaimChecklist = (
  asset: Pick<HomeAsset, 'id' | 'warrantyProvider' | 'serialNumber' | 'model' | 'brand' | 'purchaseDate' | 'purchasePrice' | 'warrantyExpiration' | 'warrantyLifetime'>,
  attachments: readonly Pick<MaintenanceAttachment, 'targetType' | 'targetId' | 'category'>[],
  today: string,
): WarrantyClaimChecklist => {
  const provider = text(asset.warrantyProvider);
  const serial = text(asset.serialNumber);
  const model = text(asset.model);
  const purchased = dayOf(asset.purchaseDate);
  const price = typeof asset.purchasePrice === 'number' && Number.isFinite(asset.purchasePrice) ? asset.purchasePrice : undefined;
  const receipts = attachments.filter((item) => item.targetType === 'home_asset' && item.targetId === asset.id && RECEIPT_CATEGORIES.has(item.category)).length;
  const end = dayOf(asset.warrantyExpiration);
  const lifetime = asset.warrantyLifetime === true;

  const items: WarrantyClaimItem[] = [
    { key: 'provider', label: 'Warranty provider', have: Boolean(provider), value: provider, hint: 'Add who honors the warranty (the maker or a plan).' },
    { key: 'serialNumber', label: 'Serial number', have: Boolean(serial), value: serial, hint: 'Usually on a label inside the door or on the back.' },
    { key: 'model', label: 'Model', have: Boolean(model), value: model, hint: 'Usually printed next to the serial number.' },
    { key: 'purchaseDate', label: 'Purchase date', have: Boolean(purchased), value: purchased ? longDate(purchased) : undefined, hint: 'Shown on the receipt.' },
    {
      key: 'purchasePrice', label: 'Purchase price', have: price !== undefined,
      value: price !== undefined ? price.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : undefined,
      hint: 'Shown on the receipt.',
    },
    {
      key: 'receipt', label: 'Receipt or invoice', have: receipts > 0,
      value: receipts > 0 ? `${receipts} ${receipts === 1 ? 'file' : 'files'} attached` : undefined,
      hint: 'Upload a photo or PDF of the receipt, invoice or warranty document.',
    },
    {
      key: 'warrantyEnd', label: 'Warranty end', have: lifetime || Boolean(end),
      value: lifetime ? 'Lifetime' : end ? longDate(end) : undefined,
      hint: 'Add the end date, or mark it Lifetime.',
    },
  ];

  let status: WarrantyClaimStatus = 'unknown';
  let summary = 'HomeHub does not know when this warranty ends.';
  if (lifetime) {
    status = 'lifetime';
    summary = 'Lifetime warranty: covered as long as the provider honors it.';
  } else if (end) {
    const left = diffDays(end, today);
    status = left >= 0 ? 'active' : 'ended';
    summary = left >= 0 ? `Covered until ${longDate(end)}.` : `The warranty ended ${longDate(end)}; a claim may be refused.`;
  }
  return { items, missing: items.filter((item) => !item.have).length, status, summary };
};
