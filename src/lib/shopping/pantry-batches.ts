/**
 * Pantry v2 (audit 17.3, SH-23a, SH-22, SH-29, SH-10a/b): pure helpers for the
 * one-document-per-batch pantry. No Firebase imports, so they are unit tested
 * directly (tests/unit/pantry-batches.test.ts).
 *
 * A batch is one document: `packages` (how many), `packageSize` (the size of one
 * package in `unit`, or null), `unit`, `location` and a date-only `expiryDate` in
 * the household's zone. Two batches with a different merge key (nameKey +
 * location + packageSize + unit + expiryDate) never merge, so quantities never
 * mix across units, sizes or expiry dates. The tile groups a product's batches
 * (same name on one shelf) and "used up" removes ONE package from the
 * soonest-expiring batch; it never subtracts 1 from a measured amount.
 *
 * Documents written before v2 (`quantity` + an ISO `expiryDate`) are read through
 * `readPantryBatch`, and new writes dual-write `quantity` (`legacyQuantity`) so an
 * older page still open somewhere shows something sensible.
 */

import { addDays, diffDays, isDayString, localDay, localMinutes, safeTimeZone, toDay } from '../../../functions/src/shared/calendar';
import type { PantryItemLocation, PantryItemUnit } from '@/lib/types';
import { pantryItemUnitCategories } from '../types';
import { itemNameKey } from './items';

export const PANTRY_SCHEMA_VERSION = 2;
export const MAX_PACKAGES = 10_000;
export const MAX_PACKAGE_SIZE = 100_000;
/** An empty batch is deleted only once nobody has touched it for this long (an Undo or a +1 may still come). */
export const EMPTY_BATCH_GRACE_MS = 60_000;
/** How long the Undo of a used-up tap is offered (SH-29c). */
export const USED_UP_UNDO_MS = 10_000;

const LOCATIONS: readonly PantryItemLocation[] = ['Pantry', 'Fridge', 'Freezer'];
const COUNT_UNITS = new Set<string>(pantryItemUnitCategories.Count);
const ALL_UNITS = new Set<string>([
  ...pantryItemUnitCategories.Weight, ...pantryItemUnitCategories.Volume, ...pantryItemUnitCategories.Count,
]);

/** Counted units (items, cans, ...) hold whole packages; weights and volumes are measured. */
export const isCountUnit = (unit: string): boolean => COUNT_UNITS.has(unit);

export type PantryBatch = {
  id: string;
  name: string;
  nameKey: string;
  location: PantryItemLocation;
  unit: PantryItemUnit;
  /** Number of packages; 0 means used up (hidden, then deleted). */
  packages: number;
  /** Size of one package in `unit`, or null when unknown / not meaningful (count units). */
  packageSize: number | null;
  /** Date-only `yyyy-MM-dd` in the household zone, or null. */
  expiryDate: string | null;
  barcode: string | null;
  /** True when the stored document is still the pre-v2 shape (no `packages`). */
  legacy: boolean;
  /** Last write time in ms, or null when unknown (pending server timestamp, legacy document). */
  updatedAtMs: number | null;
};

const finiteNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const timestampMs = (value: unknown): number | null => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
};

const clampPackages = (value: number) => Math.min(MAX_PACKAGES, Math.max(0, value));
const validSize = (value: number | null) => (value !== null && value > 0 && value <= MAX_PACKAGE_SIZE ? value : null);

/**
 * Reads any stored pantry document as a v2 batch. Legacy documents derive their
 * values: a counted unit's `quantity` is the package count (`packageSize` null);
 * a measured unit's `quantity` is the size of one package (`packages` 1, or 0
 * when the quantity was 0). A legacy ISO expiry becomes its day in the household
 * zone (it was saved as the instant of local midnight).
 */
export function readPantryBatch(id: string, data: Record<string, unknown> | null | undefined, timeZone?: string | null): PantryBatch {
  const zone = safeTimeZone(timeZone);
  const record = data ?? {};
  const name = typeof record.name === 'string' ? record.name : '';
  const unit = (typeof record.unit === 'string' && ALL_UNITS.has(record.unit) ? record.unit : 'items') as PantryItemUnit;
  const location = (LOCATIONS as readonly unknown[]).includes(record.location) ? record.location as PantryItemLocation : 'Pantry';
  const storedPackages = finiteNumber(record.packages);
  const legacy = storedPackages === null;
  let packages: number;
  let packageSize: number | null;
  if (!legacy) {
    packages = clampPackages(storedPackages);
    packageSize = validSize(finiteNumber(record.packageSize));
  } else {
    const quantity = Math.max(0, finiteNumber(record.quantity) ?? 0);
    if (isCountUnit(unit)) {
      packages = clampPackages(quantity);
      packageSize = null;
    } else {
      packageSize = validSize(quantity);
      packages = packageSize === null ? 0 : 1;
    }
  }
  return {
    id,
    name,
    nameKey: itemNameKey(name),
    location,
    unit,
    packages,
    packageSize,
    expiryDate: toDay(record.expiryDate, zone),
    barcode: typeof record.barcode === 'string' && record.barcode ? record.barcode : null,
    legacy,
    updatedAtMs: timestampMs(record.updatedAt),
  };
}

/**
 * True for a used-up v2 batch (stored `packages` of 0 or less): hidden on the
 * Inventory tab and kept stored until an online member's idle-delete removes it
 * (regular members have no `shopping.delete`). Summaries that count stock (the
 * dashboard's `computePantryFacts`, the AI overview facts) skip it. A legacy
 * document (no numeric `packages`, the same test as `readPantryBatch`) is never
 * used up here: it keeps counting as before.
 */
export function isUsedUpPantryDoc(data: Record<string, unknown> | null | undefined): boolean {
  const packages = finiteNumber(data?.packages);
  return packages !== null && packages <= 0;
}

/**
 * Splits a package count into batches of at most `MAX_PACKAGES` each (the rules'
 * limit per batch), so a large purchase (shopping allows up to 100,000, and a
 * handoff combines same-name purchases) is stored in full instead of being
 * clamped to 10,000. `splitPackages(25_000)` is `[10_000, 10_000, 5_000]`.
 */
export function splitPackages(total: number): number[] {
  const whole = Math.max(0, Math.round(total));
  const parts: number[] = [];
  for (let left = whole; left > 0; left -= MAX_PACKAGES) parts.push(Math.min(MAX_PACKAGES, left));
  return parts;
}

/**
 * How `add` packages land when they merge into a batch that already holds
 * `currentPackages`: as many as fit under `MAX_PACKAGES` go to that batch
 * (`toTarget`, possibly 0), the rest become new batches (`newBatches`, each at
 * most `MAX_PACKAGES`). Nothing is dropped.
 */
export function fillBatch(add: number, currentPackages: number): { toTarget: number; newBatches: number[] } {
  const whole = Math.max(0, Math.round(add));
  const headroom = Math.max(0, MAX_PACKAGES - Math.max(0, currentPackages));
  const toTarget = Math.min(whole, headroom);
  return { toTarget, newBatches: splitPackages(whole - toTarget) };
}

/** The `quantity` a v2 write also stores, for older pages: packages for counted units, the package size for measured ones. */
export function legacyQuantity(batch: Pick<PantryBatch, 'unit' | 'packages' | 'packageSize'>): number {
  if (isCountUnit(batch.unit)) return batch.packages;
  return batch.packageSize ?? batch.packages;
}

export type PantryMergeFields = Pick<PantryBatch, 'nameKey' | 'location' | 'packageSize' | 'unit' | 'expiryDate'>;

/** Batches with the same key are the same stock and merge; any difference keeps them apart (SH-23a). */
export function pantryMergeKey(batch: PantryMergeFields): string {
  return JSON.stringify([batch.nameKey, batch.location, batch.packageSize ?? null, batch.unit, batch.expiryDate ?? null]);
}

/** The existing batch a new one merges into: same merge key. Prefers a batch that still has stock. */
export function findPantryMergeTarget<T extends PantryBatch>(batches: readonly T[], incoming: PantryMergeFields): T | undefined {
  const key = pantryMergeKey(incoming);
  const matches = batches.filter((batch) => pantryMergeKey(batch) === key);
  return matches.find((batch) => batch.packages > 0) ?? matches[0];
}

export type PantryMergeDecision =
  /** Add the packages to `target`, the batch as just re-read (inside the transaction). */
  | { kind: 'merge'; target: PantryBatch }
  /** Create a separate batch: offline, the target is gone, or its merge key changed. */
  | { kind: 'create' };

/**
 * Whether adding stock still merges into the batch the form matched (SH-23a). The
 * match was made from what was on screen; another member may since have changed
 * that batch's name, shelf, package size, unit or expiry, or deleted it. Online,
 * the caller re-reads the target inside a transaction and passes it as `stored`;
 * the packages merge only while its merge key still equals the incoming one.
 * Offline nothing can be verified (a queued increment would credit whatever the
 * batch has become by the time it syncs), so a separate batch is created; two
 * batches with the same key are shown on one tile anyway.
 */
export function decidePantryMerge({
  offline, targetId, stored, incoming, timeZone,
}: {
  offline: boolean;
  targetId: string;
  /** The target as read now, or null/undefined when it is missing or could not be read. */
  stored: Record<string, unknown> | null | undefined;
  incoming: PantryMergeFields;
  timeZone?: string | null;
}): PantryMergeDecision {
  if (offline || !stored) return { kind: 'create' };
  const target = readPantryBatch(targetId, stored, timeZone);
  if (!target.nameKey || pantryMergeKey(target) !== pantryMergeKey(incoming)) return { kind: 'create' };
  return { kind: 'merge', target };
}

/** A product on one shelf: the batches of one name in one location, shown as one tile. */
export type PantryProduct = {
  /** `nameKey|location`: stable across batches, used for the tile. */
  key: string;
  name: string;
  nameKey: string;
  location: PantryItemLocation;
  /** Visible batches (packages > 0), soonest expiry first. */
  batches: PantryBatch[];
  /** Total packages across the visible batches. */
  totalPackages: number;
  /** The soonest expiry among the visible batches, or null. */
  nextExpiry: string | null;
};

/** Soonest expiry first; undated batches last; then smaller batches, then id (stable). */
export function compareBatchesForUse(a: PantryBatch, b: PantryBatch): number {
  if (a.expiryDate !== b.expiryDate) {
    if (a.expiryDate === null) return 1;
    if (b.expiryDate === null) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  }
  if (a.packages !== b.packages) return a.packages - b.packages;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Groups visible batches (packages > 0) into products, sorted by name. Empty batches are hidden. */
export function groupPantryBatches(batches: readonly PantryBatch[]): PantryProduct[] {
  const groups = new Map<string, PantryProduct>();
  for (const batch of batches) {
    if (batch.packages <= 0 || !batch.nameKey) continue;
    const key = `${batch.nameKey}|${batch.location}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, name: batch.name, nameKey: batch.nameKey, location: batch.location, batches: [], totalPackages: 0, nextExpiry: null };
      groups.set(key, group);
    }
    group.batches.push(batch);
    group.totalPackages += batch.packages;
  }
  const products = [...groups.values()];
  for (const product of products) {
    product.batches.sort(compareBatchesForUse);
    product.nextExpiry = product.batches.find((batch) => batch.expiryDate !== null)?.expiryDate ?? null;
  }
  return products.sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location));
}

/** The batch "used one" takes a package from: the soonest-expiring batch that still has stock. */
export function chooseUsedUpBatch(batches: readonly PantryBatch[]): PantryBatch | undefined {
  return [...batches].filter((batch) => batch.packages > 0).sort(compareBatchesForUse)[0];
}

export type UsedUpOutcome = {
  batch: PantryBatch;
  /** Packages left across the product after this tap. */
  remaining: number;
  /** D-8: the product reached zero, so ask "Add to list?" (Add / Not now). Nothing is added without the tap. */
  askAddToList: boolean;
};

/** What one "used one" tap does to a product, or null when nothing is left to use. */
export function usedUpOutcome(product: Pick<PantryProduct, 'batches'>): UsedUpOutcome | null {
  const batch = chooseUsedUpBatch(product.batches);
  if (!batch) return null;
  const total = product.batches.reduce((sum, entry) => sum + Math.max(0, entry.packages), 0);
  const remaining = Math.max(0, total - 1);
  return { batch, remaining, askAddToList: remaining === 0 };
}

export type PackageChangeToast = {
  title: string;
  description: string;
  /** Whether the toast carries Undo: only once the server has acknowledged the change. */
  offerUndo: boolean;
};

/**
 * The toast after a "used one" / "Out of this" write (SH-29c). Undo is offered
 * only when the server acknowledged the write (`'saved'`). A write queued
 * offline cannot be cancelled, and an Undo queued after it is an independent
 * increment: on reconnect the server can refuse the decrement (the count was
 * already 0) yet accept the Undo's +1, creating a package nobody added. So an
 * offline change says honestly that it is saved on this device and offers no
 * Undo; "+1" corrects a mistaken tap once it has synced.
 */
export function packageChangeToast(outcome: 'saved' | 'queued', title: string, description: string): PackageChangeToast {
  if (outcome === 'saved') return { title, description, offerUndo: true };
  return {
    title: 'Saved on this device',
    description: `${title}. ${description} It syncs when you are back online; Undo is not available for offline changes.`,
    offerUndo: false,
  };
}

/** Whether a used-up batch may be deleted: no packages left and nobody touched it in the last minute. */
export function shouldDeleteEmptyBatch(batch: Pick<PantryBatch, 'packages' | 'updatedAtMs'>, nowMs: number): boolean {
  if (batch.packages > 0) return false;
  return batch.updatedAtMs === null || nowMs - batch.updatedAtMs >= EMPTY_BATCH_GRACE_MS;
}

// --- Household-zone days (SH-10a/b, D-6) ------------------------------------

/** Today in the household's zone (`yyyy-MM-dd`). */
export function householdToday(now: Date, timeZone?: string | null): string {
  return localDay(now, safeTimeZone(timeZone));
}

/** Milliseconds until the next household midnight (at least one second), for re-keying "today". */
export function msUntilHouseholdMidnight(now: Date, timeZone?: string | null): number {
  const minutes = localMinutes(now, safeTimeZone(timeZone));
  const msIntoMinute = now.getSeconds() * 1000 + now.getMilliseconds();
  return Math.max(1000, (24 * 60 - minutes) * 60_000 - msIntoMinute);
}

/**
 * The calendar day a date picker selected, as `yyyy-MM-dd`. The picker hands back
 * the device's local midnight of the chosen day, so its local calendar fields are
 * the day itself. Never `toISOString()`, which is a day late every evening in Texas.
 */
export function dayFromPicker(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The device-local Date a date picker shows for a stored day (inverse of `dayFromPicker`). */
export function pickerDateForDay(day: string | null | undefined): Date | undefined {
  if (!day || !isDayString(day)) return undefined;
  const [year, month, date] = day.split('-').map(Number);
  const local = new Date(year, month - 1, date);
  // "2026-11-31" would roll over to Dec 1: not a real day.
  return local.getMonth() === month - 1 && local.getDate() === date ? local : undefined;
}

/** Adds calendar months to a day, clamped to the end of a shorter month (Jan 31 + 1 mo = Feb 28/29). */
export function addMonthsToDay(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return target.toISOString().slice(0, 10);
}

export type ExpiryChip = '3d' | '1w' | '1mo' | 'freezer3mo';

export const EXPIRY_CHIPS: readonly { id: ExpiryChip; label: string }[] = [
  { id: '3d', label: '+3 d' },
  { id: '1w', label: '+1 w' },
  { id: '1mo', label: '+1 mo' },
  { id: 'freezer3mo', label: 'Freezer +3 mo' },
];

/** The expiry a quick chip sets, counted from the household's today. */
export function expiryFromChip(chip: ExpiryChip, now: Date, timeZone?: string | null): string {
  const today = householdToday(now, timeZone);
  switch (chip) {
    case '3d': return addDays(today, 3);
    case '1w': return addDays(today, 7);
    case '1mo': return addMonthsToDay(today, 1);
    case 'freezer3mo': return addMonthsToDay(today, 3);
  }
}

/** Days from the household's today to an expiry (date-only or legacy ISO); negative once past. */
export function daysUntilDay(expiryDate: string | null | undefined, today: string, timeZone?: string | null): number | null {
  const day = toDay(expiryDate, safeTimeZone(timeZone));
  return day === null ? null : diffDays(day, today);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short expiry for a tile: "expired", "today", "tomorrow", "Fri", "next Fri", or "Mar 4". */
export function shortExpiryLabel(day: string, today: string): string {
  const days = diffDays(day, today);
  if (days < 0) return 'expired';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = WEEKDAYS[date.getUTCDay()];
  if (days < 7) return weekday;
  if (days < 14) return `next ${weekday}`;
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/**
 * Rounds an amount for display or the recipe flow without losing small values:
 * two decimals from 1 up, three significant digits below 1 (0.004 stays 0.004,
 * 0.12345 becomes 0.123), so a valid tiny package never reads as 0.
 */
export function roundAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? Math.round(value * 100) / 100 : Number(value.toPrecision(3));
}

const formatAmount = (value: number) => String(roundAmount(value));

/** Units a recipe total below 1 kg or 1 L is restated in before rounding (0.004 kg is 4 g, 0.002 L is 2 ml). */
const SMALLER_UNIT: Partial<Record<PantryItemUnit, { unit: PantryItemUnit; factor: number }>> = {
  kg: { unit: 'g', factor: 1000 },
  L: { unit: 'ml', factor: 1000 },
};

const restateSmall = (quantity: number, unit: PantryItemUnit): { quantity: number; unit: PantryItemUnit } => {
  const smaller = SMALLER_UNIT[unit];
  return smaller && quantity > 0 && quantity < 1 ? { quantity: quantity * smaller.factor, unit: smaller.unit } : { quantity, unit };
};


/** One batch's amount: "3 cans", "2 × 450 g", or "1 pack (g)" when a measured size is unknown. */
export function batchAmountLabel(batch: Pick<PantryBatch, 'packages' | 'packageSize' | 'unit'>): string {
  const count = formatAmount(batch.packages);
  if (isCountUnit(batch.unit)) return `${count} ${batch.unit}`;
  if (batch.packageSize !== null) return `${count} × ${formatAmount(batch.packageSize)} ${batch.unit}`;
  return `${count} ${batch.packages === 1 ? 'pack' : 'packs'} (${batch.unit})`;
}

/** A tile's summary: each batch's amount with its expiry ("2 × 450 g · next Fri, 1 × 450 g"). */
export function productSummary(product: Pick<PantryProduct, 'batches'>, today: string): string {
  return product.batches
    .map((batch) => batch.expiryDate ? `${batchAmountLabel(batch)} · ${shortExpiryLabel(batch.expiryDate, today)}` : batchAmountLabel(batch))
    .join(', ');
}

/** One line of stock sent to the recipe flow. `unit` is free text there (a stored unit, or a pack label). */
export type RecipeStockItem = { name: string; quantity: number; unit: string };

/** The recipe unit for packages of a measured product whose size is unknown: "packs of unknown size (g)". */
export const unknownSizeRecipeUnit = (unit: PantryItemUnit, packages: number) =>
  `${packages === 1 ? 'pack' : 'packs'} of unknown size (${unit})`;

/**
 * Stock a recipe may use (SH-27e): products with packages left whose soonest
 * usable batch has not expired. Expired batches are left out. Counted units send
 * the package count; measured units with a known size send packages × size,
 * summed per unit. A measured batch with no package size has no amount in its
 * unit, so its packages are sent as their own line ("2 packs of unknown size
 * (g)") and never added to, or passed off as, grams or litres. Amounts keep
 * their precision: a total below 1 kg or 1 L is restated in g or ml, then joined
 * with any g/ml line and rounded by `roundAmount` (0.004 kg of yeast is sent as
 * 4 g, never 0), capped at the recipe flow's 100,000.
 */
export function usableRecipeItems(products: readonly PantryProduct[], today: string): RecipeStockItem[] {
  const items: RecipeStockItem[] = [];
  for (const product of products) {
    const measured = new Map<PantryItemUnit, number>();
    const unknownSize = new Map<PantryItemUnit, number>();
    for (const batch of product.batches) {
      if (batch.packages <= 0 || (batch.expiryDate !== null && batch.expiryDate < today)) continue;
      if (!isCountUnit(batch.unit) && batch.packageSize === null) {
        unknownSize.set(batch.unit, (unknownSize.get(batch.unit) ?? 0) + batch.packages);
        continue;
      }
      const amount = isCountUnit(batch.unit) ? batch.packages : batch.packages * batch.packageSize!;
      measured.set(batch.unit, (measured.get(batch.unit) ?? 0) + amount);
    }
    // A small kg/L total is restated in g/ml first, then joined with any g/ml line, then rounded.
    const lines = new Map<PantryItemUnit, number>();
    for (const [unit, quantity] of measured) {
      const restated = restateSmall(quantity, unit);
      lines.set(restated.unit, (lines.get(restated.unit) ?? 0) + restated.quantity);
    }
    for (const [unit, quantity] of lines) items.push({ name: product.name, quantity: Math.min(MAX_PACKAGE_SIZE, roundAmount(quantity)), unit });
    for (const [unit, packages] of unknownSize) {
      const quantity = Math.min(MAX_PACKAGE_SIZE, roundAmount(packages));
      items.push({ name: product.name, quantity, unit: unknownSizeRecipeUnit(unit, quantity) });
    }
  }
  return items;
}

// --- Where "Put on a shopping list" goes (SH-6) -------------------------

/** The household's default Grocery list: one named "Groceries", else the first Grocery list by name. */
export function defaultGroceryList<T extends { id: string; name: string; type?: string }>(lists: readonly T[]): T | undefined {
  const grocery = lists.filter((list) => list.type === 'Grocery').sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return grocery.find((list) => itemNameKey(list.name) === 'groceries') ?? grocery[0];
}

export type GroceryListChoice<T> =
  /** No Grocery list: create "Groceries" and add to it. */
  | { kind: 'create' }
  /** Exactly one Grocery list: add straight to it (one tap). */
  | { kind: 'direct'; list: T }
  /** Several: show the picker, preselecting the most recently used list, else the default. */
  | { kind: 'pick'; lists: T[]; preselectId: string };

/**
 * Where "Put on a shopping list" (SH-6) and the zero prompt's Add go. A list
 * remembered as most recently used wins over the default when it still exists.
 */
export function groceryListChoice<T extends { id: string; name: string; type?: string }>(
  lists: readonly T[],
  recentId?: string | null,
): GroceryListChoice<T> {
  const grocery = lists.filter((list) => list.type === 'Grocery').sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (grocery.length === 0) return { kind: 'create' };
  if (grocery.length === 1) return { kind: 'direct', list: grocery[0] };
  const recent = recentId ? grocery.find((list) => list.id === recentId) : undefined;
  return { kind: 'pick', lists: grocery, preselectId: (recent ?? defaultGroceryList(grocery)!).id };
}

// --- Write shapes (no Firebase types; the writer adds increments and server time) ---

export type PantryBatchInput = {
  name: string;
  location: PantryItemLocation;
  unit: PantryItemUnit;
  packages: number;
  packageSize: number | null;
  expiryDate: string | null;
  barcode?: string | null;
};

/** The longest pantry item name (the recipe flow accepts no more; the rules enforce it). */
export const PANTRY_NAME_MAX = 120;

/**
 * A pantry name as stored: whitespace collapsed, trimmed, and cut to
 * `PANTRY_NAME_MAX` UTF-16 units (never leaving half of a surrogate pair), so a
 * longer shopping item name still saves when it moves to the pantry.
 */
export function clampPantryName(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim();
  if (name.length <= PANTRY_NAME_MAX) return name;
  name = name.slice(0, PANTRY_NAME_MAX);
  if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
  return name.trimEnd();
}

/** The v2 fields of a batch, with the dual-written legacy `quantity`. Attribution and time are added by the writer. */
export function pantryBatchFields(input: PantryBatchInput) {
  const name = clampPantryName(input.name);
  const packages = clampPackages(Math.round(input.packages));
  const packageSize = isCountUnit(input.unit) ? null : validSize(input.packageSize);
  const expiryDate = input.expiryDate && isDayString(input.expiryDate) ? input.expiryDate : null;
  const fields = {
    name,
    nameKey: itemNameKey(name),
    location: input.location,
    unit: input.unit,
    packages,
    packageSize,
    expiryDate,
    quantity: legacyQuantity({ unit: input.unit, packages, packageSize }),
    schemaVersion: PANTRY_SCHEMA_VERSION,
  };
  return input.barcode ? { ...fields, barcode: input.barcode.slice(0, 128) } : fields;
}

/**
 * The absolute fields that upgrade a legacy document while changing its package
 * count by `delta` (a legacy document has no `packages` to increment). Used only
 * for the first write to a pre-v2 document; the migration removes this case.
 */
export function upgradeLegacyBatch(batch: PantryBatch, delta: number) {
  return pantryBatchFields({
    name: batch.name,
    location: batch.location,
    unit: batch.unit,
    packages: Math.max(0, batch.packages + delta),
    packageSize: batch.packageSize,
    expiryDate: batch.expiryDate,
    barcode: batch.barcode,
  });
}
