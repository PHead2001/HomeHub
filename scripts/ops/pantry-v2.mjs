// Pure mapping for migrate-pantry-v2.mjs (Pantry v2, audit 17.3). No Firebase
// imports, so tests/unit/pantry-v2-migration.test.ts can cover it. This is the
// plain-JavaScript twin of `readPantryBatch` + `pantryBatchFields` in
// src/lib/shopping/pantry-batches.ts (these scripts run without a TypeScript
// loader); that test checks the two agree case by case.

export const PANTRY_SCHEMA_VERSION = 2;
export const DEFAULT_TIME_ZONE = 'America/Chicago';

const LOCATIONS = ['Pantry', 'Fridge', 'Freezer'];
const COUNT_UNITS = ['items', 'cans', 'bottles', 'pieces', 'slices'];
const UNITS = ['g', 'kg', 'oz', 'lbs', 'ml', 'L', 'fl oz', ...COUNT_UNITS];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PACKAGES = 10_000;
const MAX_PACKAGE_SIZE = 100_000;

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const clampPackages = value => Math.min(MAX_PACKAGES, Math.max(0, value));
const validSize = value => (value !== null && value > 0 && value <= MAX_PACKAGE_SIZE ? value : null);
const isDay = value => typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/**
 * An IANA zone the runtime knows, else the household default.
 * @param {unknown} timeZone
 * @returns {string}
 */
export function safeTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * A stored expiry as its `yyyy-MM-dd` day in the household zone: a day string
 * stays as it is; a legacy ISO instant (local midnight) becomes its local day.
 * @param {unknown} value
 * @param {string} timeZone
 * @returns {string | null}
 */
export function expiryDay(value, timeZone) {
  if (typeof value !== 'string' || !value) return null;
  if (isDay(value)) return value;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Same as `itemNameKey` in src/lib/shopping/items.ts. */
export const nameKeyOf = name => String(name).replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/**
 * The v2 values of any stored pantry document (`readPantryBatch`).
 * @param {Record<string, unknown> | null | undefined} data
 * @param {unknown} timeZone Household zone.
 */
export function pantryV2Values(data, timeZone) {
  const zone = safeTimeZone(timeZone);
  const record = data ?? {};
  const name = typeof record.name === 'string' ? record.name : '';
  const unit = typeof record.unit === 'string' && UNITS.includes(record.unit) ? record.unit : 'items';
  const location = LOCATIONS.includes(record.location) ? record.location : 'Pantry';
  const stored = finite(record.packages);
  let packages;
  let packageSize;
  if (stored !== null) {
    packages = clampPackages(stored);
    packageSize = validSize(finite(record.packageSize));
  } else {
    const quantity = Math.max(0, finite(record.quantity) ?? 0);
    if (COUNT_UNITS.includes(unit)) {
      packages = clampPackages(quantity);
      packageSize = null;
    } else {
      packageSize = validSize(quantity);
      packages = packageSize === null ? 0 : 1;
    }
  }
  const quantity = COUNT_UNITS.includes(unit) ? packages : packageSize ?? packages;
  return {
    name,
    nameKey: nameKeyOf(name),
    location,
    unit,
    packages,
    packageSize,
    expiryDate: expiryDay(record.expiryDate, zone),
    quantity,
    schemaVersion: PANTRY_SCHEMA_VERSION,
  };
}

/**
 * What the migration does with one pantry document.
 * - `current`: already v2 with a date-only (or no) expiry; left alone.
 * - `legacy`: no `packages` yet; every v2 field is written (derived values,
 *   nameKey, the ISO expiry as a household-zone day, the dual-written quantity).
 * - `expiry`: v2 already, but an older page wrote an ISO expiry; only that is rewritten.
 * @param {Record<string, unknown> | null | undefined} data
 * @param {unknown} timeZone
 * @returns {{ kind: 'current' } | { kind: 'legacy' | 'expiry', update: Record<string, unknown> }}
 */
export function pantryMigrationDecision(data, timeZone) {
  const record = data ?? {};
  const values = pantryV2Values(record, timeZone);
  if (finite(record.packages) === null) {
    // The name is kept as stored; nameKey is derived from it.
    const update = { ...values };
    delete update.name;
    return { kind: 'legacy', update };
  }
  const expiryOk = record.expiryDate == null || isDay(record.expiryDate);
  if (record.schemaVersion === PANTRY_SCHEMA_VERSION && expiryOk && typeof record.nameKey === 'string') return { kind: 'current' };
  return {
    kind: 'expiry',
    update: { expiryDate: values.expiryDate, nameKey: values.nameKey, schemaVersion: PANTRY_SCHEMA_VERSION },
  };
}
