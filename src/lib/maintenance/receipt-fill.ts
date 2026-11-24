// Reading a receipt with AI (MA-30), the browser's rules, pure for unit tests. The model's answer is
// untrusted data: it is validated again here, shown for correction, and only fills fields the person
// has not typed in, and only after they confirm. A late answer (the receipt was changed or cleared,
// or the dialog closed) is ignored.

/** What a receipt reading may fill in the log form. */
export type ReceiptFields = {
  cost?: number;
  serviceProvider?: string;
  partsUsed?: string;
};

export const RECEIPT_FIELD_LABELS: Record<keyof ReceiptFields, string> = {
  cost: 'Cost',
  serviceProvider: 'Service provider',
  partsUsed: 'Parts used',
};

export const RECEIPT_TEXT_LIMITS = { serviceProvider: 120, partsUsed: 500 } as const;
export const RECEIPT_MAX_COST = 1_000_000;

// Control characters, zero-width and bidirectional overrides.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]+/gu;

/** Removes control characters, collapses spaces and bounds the length; never HTML (rendered as text). */
export const cleanReceiptText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

/** A cost: a finite, non-negative amount up to RECEIPT_MAX_COST, rounded to cents. */
export const cleanReceiptCost = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > RECEIPT_MAX_COST) return undefined;
  return Math.round(value * 100) / 100;
};

/** The model's answer as fields the form can use (anything else is dropped). */
export const sanitizeReceiptFields = (raw: unknown): ReceiptFields => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const fields: ReceiptFields = {};
  const cost = cleanReceiptCost(source.cost);
  if (cost !== undefined) fields.cost = cost;
  const provider = cleanReceiptText(source.serviceProvider, RECEIPT_TEXT_LIMITS.serviceProvider);
  if (provider) fields.serviceProvider = provider;
  const parts = cleanReceiptText(source.partsUsed, RECEIPT_TEXT_LIMITS.partsUsed);
  if (parts) fields.partsUsed = parts;
  return fields;
};

export type ReceiptFormValues = { cost: string; serviceProvider: string; partsUsed: string };

/**
 * The form changes a confirmed reading makes: only fields the person has not edited
 * (`edited`: react-hook-form's dirty fields, or edits made after the reading started) and
 * that the person kept in the confirmation (`accepted`). A field the person typed in is never
 * overwritten.
 */
export const receiptFillPatch = (
  fields: ReceiptFields,
  edited: Partial<Record<keyof ReceiptFormValues, boolean>>,
  accepted: Partial<Record<keyof ReceiptFields, boolean>> = { cost: true, serviceProvider: true, partsUsed: true },
): Partial<ReceiptFormValues> => {
  const patch: Partial<ReceiptFormValues> = {};
  if (fields.cost !== undefined && accepted.cost && !edited.cost) patch.cost = fields.cost.toFixed(2);
  if (fields.serviceProvider && accepted.serviceProvider && !edited.serviceProvider) patch.serviceProvider = fields.serviceProvider;
  if (fields.partsUsed && accepted.partsUsed && !edited.partsUsed) patch.partsUsed = fields.partsUsed;
  return patch;
};

/** Fields the reading found that the person has already filled themselves (shown as "kept yours"). */
export const receiptFieldsKept = (fields: ReceiptFields, edited: Partial<Record<keyof ReceiptFormValues, boolean>>) =>
  (Object.keys(fields) as (keyof ReceiptFields)[]).filter(field => fields[field] !== undefined && edited[field]);

/**
 * One reading at a time per dialog: `start` names the receipt it reads; a newer start, `cancel`
 * (the receipt was changed or cleared) or `close` (the dialog closed) make every earlier answer
 * stale, so `isCurrent` is false and the answer is ignored.
 */
export const createReceiptReadGuard = () => {
  let generation = 0;
  let closed = false;
  return {
    start(): number {
      generation += 1;
      return generation;
    },
    cancel() {
      generation += 1;
    },
    close() {
      closed = true;
      generation += 1;
    },
    isCurrent(token: number) {
      return !closed && token === generation;
    },
  };
};

/** The largest file sent to the reader (the browser downsizes photos first; Next's 1 MB body limit). */
export const RECEIPT_READ_MAX_BYTES = 512 * 1024;
/** The receipt photo is redrawn to this longer edge before reading (legible, small). */
export const RECEIPT_READ_MAX_EDGE = 1600;
/** Types the reader accepts. HEIC is read only after the browser converted it to JPEG. */
export const RECEIPT_READ_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
