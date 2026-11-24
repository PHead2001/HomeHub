// Shorter forms (MA-15) and the unsaved-changes guard (MA-24f), pure for unit tests. Each form
// shows its essentials; the other fields sit behind "More details" (a new record) or "Add details
// (N empty)" (an existing one, which also shows every detail field that already has a value).

export type FormKind = 'asset' | 'vehicle' | 'log';

/** Always shown. The asset's warranty (end date or Lifetime) and the first schedule are essentials too. */
export const ESSENTIAL_FIELDS: Record<FormKind, readonly string[]> = {
  asset: ['name', 'location', 'category', 'warrantyExpiration', 'warrantyLifetime'],
  vehicle: ['nickname', 'make', 'model', 'year', 'currentMileage'],
  log: ['title', 'targetType', 'assetId', 'vehicleId', 'date', 'cost'],
};

/** Behind "More details", in display order. */
export const DETAIL_FIELDS: Record<FormKind, readonly string[]> = {
  asset: ['status', 'brand', 'model', 'serialNumber', 'purchaseDate', 'purchasePrice', 'warrantyProvider', 'notes'],
  vehicle: ['status', 'trim', 'vin', 'licensePlate', 'purchaseDate', 'purchasePrice', 'insuranceProvider', 'registrationExpiration', 'inspectionExpiration', 'notes'],
  log: ['type', 'serviceProvider', 'partsUsed', 'mileage', 'notes'],
};

/** Detail fields whose value is the default: an untouched status or log type counts as empty. */
const DEFAULTS: Record<string, unknown> = { status: 'active', type: 'routine' };

export const isEmptyValue = (field: string, value: unknown) =>
  value === undefined || value === null || value === false || (typeof value === 'string' && value.trim() === '')
  || (field in DEFAULTS && value === DEFAULTS[field]);

/** Detail fields with no value yet (what "Add details (N empty)" opens). */
export const emptyDetailFields = (kind: FormKind, values: Record<string, unknown>, options: { vehicleLog?: boolean } = {}) =>
  DETAIL_FIELDS[kind].filter(field => (kind !== 'log' || field !== 'mileage' || options.vehicleLog) && isEmptyValue(field, values[field]));

/**
 * Which detail fields to show: every detail field when expanded; otherwise only the ones that
 * already had a value when the form opened (so an edit never hides what is recorded).
 */
export const visibleDetailFields = (kind: FormKind, initial: Record<string, unknown>, expanded: boolean, options: { vehicleLog?: boolean } = {}) => {
  const fields = DETAIL_FIELDS[kind].filter(field => kind !== 'log' || field !== 'mileage' || options.vehicleLog);
  if (expanded) return fields;
  const empty = new Set(emptyDetailFields(kind, initial, options));
  return fields.filter(field => !empty.has(field));
};

/** The disclosure's label: "More details" for a new record, "Add details (3 empty)" for an edit. */
export const detailsToggleLabel = (isNew: boolean, emptyCount: number) =>
  isNew ? 'More details' : `Add details (${emptyCount} empty)`;

const stable = (value: unknown): string => {
  if (value === undefined || value === null || value === '' || value === false) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, stable((value as Record<string, unknown>)[key])])
      .filter(([, entry]) => entry !== 'null')
      .map(([key, entry]) => `${JSON.stringify(key)}:${entry}`).join(',')}}`;
  }
  return JSON.stringify(typeof value === 'string' ? value.trim() : value);
};

/**
 * Whether a form has unsaved changes (MA-24f): its current state differs from what it showed when
 * it opened. Empty, absent, false and surrounding spaces count as the same; key order does not
 * matter. Staged files count as a change.
 */
export const formIsDirty = (initial: unknown, current: unknown) => stable(initial) !== stable(current);

export const DISCARD_TITLE = 'Discard your changes?';
export const DISCARD_DESCRIPTION = "What you entered in this form hasn't been saved.";
