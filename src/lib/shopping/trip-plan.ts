/**
 * Put away and clear as one trip (S5: SH-2, SH-17, SH-3, SH-30, SH-32): the pure
 * planning half. No Firebase imports, so the decisions are unit tested directly
 * (tests/unit/shopping-trips.test.ts); the Admin SDK transaction that applies
 * them is `src/lib/server/shopping-trips.ts`.
 *
 * A trip has a client-generated id (`tripId`). The server applies it at most
 * once: the trip document is read first in the transaction and, once written,
 * every retry of the same id returns what was applied. An item is credited and
 * cleared only when it is still the purchase the member confirmed (same name,
 * quantity and `purchaseOpId`, still purchased); anything changed or added
 * meanwhile stays on the list.
 */

import type { PantryItemLocation } from '@/lib/types';
import { addDays, isDayString } from '../../../functions/src/shared/calendar';
import { itemNameKey } from './items';
import { addMonthsToDay, clampPantryName, fillBatch, pantryMergeKey, readPantryBatch, splitPackages } from './pantry-batches';

export const TRIP_LOCATIONS: readonly PantryItemLocation[] = ['Pantry', 'Fridge', 'Freezer'];

/** The most items one trip may carry. */
export const MAX_TRIP_ITEMS = 200;
/** The most document writes one trip's transaction may make (pantry, items, usuals and the trip itself). */
export const MAX_TRIP_WRITES = 450;
/**
 * The most a new trip document may be, in Firestore's storage size
 * (`firestoreDocumentBytes`). Firestore refuses documents over 1,048,576 bytes;
 * this leaves room for the Undo summary written onto the trip later (its
 * `kept` names are at most one 120-character pantry name per effect, about
 * 216,000 bytes at the very most) and for any error in the estimate.
 */
export const MAX_TRIP_DOCUMENT_BYTES = 760_000;
const utf8 = new TextEncoder();
const utf8Bytes = (value: string) => utf8.encode(value).length;

/**
 * A value's size as Firestore counts it for the document limit: a string is its
 * UTF-8 bytes + 1, a number, timestamp or server-value sentinel 8, a boolean
 * or null 1, an array the sum of its elements, a map the sum of its field names
 * (UTF-8 + 1) and values; plus `allowance` per value as a margin for encoding
 * overhead the published rules do not list.
 */
export function firestoreValueBytes(value: unknown, allowance = 2): number {
  if (value === null || value === undefined || typeof value === 'boolean') return 1 + allowance;
  if (typeof value === 'number' || typeof value === 'bigint') return 8 + allowance;
  if (typeof value === 'string') return utf8Bytes(value) + 1 + allowance;
  if (value instanceof Date) return 8 + allowance;
  if (Array.isArray(value)) return value.reduce((sum: number, entry) => sum + firestoreValueBytes(entry, allowance), allowance);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.toMillis === 'function') return 8 + allowance;
    if (typeof record.latitude === 'number' && typeof record.longitude === 'number') return 16 + allowance;
    const prototype = Object.getPrototypeOf(value);
    // A FieldValue sentinel (server time, increment): counted as the value it becomes.
    if (prototype !== Object.prototype && prototype !== null) return 8 + allowance;
    return Object.entries(record).reduce((sum, [key, entry]) => sum + utf8Bytes(key) + 1 + firestoreValueBytes(entry, allowance), allowance);
  }
  return 8 + allowance;
}

/** A document's size as Firestore counts it: its name (each path segment's UTF-8 + 1, + 16), its fields, + 32. */
export function firestoreDocumentBytes(path: string, data: Record<string, unknown>): number {
  const name = path.split('/').reduce((sum, segment) => sum + utf8Bytes(segment) + 1, 16);
  return name + firestoreValueBytes(data) + 32;
}

/** Purchase ids per `array-contains-any` lookup of earlier trips (Firestore allows 30). */
export const CREDITED_LOOKUP_CHUNK = 30;
/** How long after it was applied a trip can still be undone (the server's window). */
export const TRIP_UNDO_WINDOW_MS = 15 * 60_000;
/** How many recent trip dates a usual keeps for its cadence. */
export const USUAL_RECENT_LIMIT = 12;

export type TripMode =
  /** Credit the pantry and clear the items (needs `shopping.edit` and `shopping.delete`). */
  | 'putAwayAndClear'
  /** Credit the pantry and keep the items on the list as purchased, stamped as credited (`shopping.edit`). */
  | 'putAway';

/** What the member confirmed for one purchased item. */
export type TripChoice = {
  itemId: string;
  /** The item as the dialog showed it; a different stored item is "changed meanwhile" and left alone. */
  seen: { name: string; quantity: number; purchaseOpId: string | null };
  /** The shelf, or null to clear the item without putting it in the pantry. */
  location: PantryItemLocation | null;
  /** Date-only expiry in the household zone (`yyyy-MM-dd`), or null. */
  expiryDate: string | null;
};

export type TripInput = { listId: string; tripId: string; mode: TripMode; items: TripChoice[] };

// --- Input validation (the server action's boundary) --------------------------

/** A Firestore document id a client may name: 1–1500 characters, no `/`, not `.`/`..` or `__…__`. */
export const isDocId = (value: unknown, max = 1500): value is string => typeof value === 'string'
  && value.length > 0
  && value.length <= max
  && !value.includes('/')
  && value !== '.'
  && value !== '..'
  && !/^__.*__$/.test(value);

/** A trip id: 8 to 64 letters, digits or dashes (a UUID from `newOpId`). */
export const isTripId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value);

/** A real calendar day `yyyy-MM-dd` (not "2026-02-30"). */
export function isRealDay(value: unknown): value is string {
  if (!isDayString(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The trip a client sent, checked field by field, or null when anything is malformed. */
export function parseTripInput(raw: unknown): TripInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (!isDocId(input.listId) || !isTripId(input.tripId)) return null;
  if (input.mode !== 'putAwayAndClear' && input.mode !== 'putAway') return null;
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_TRIP_ITEMS) return null;
  const items: TripChoice[] = [];
  const ids = new Set<string>();
  for (const entry of input.items as unknown[]) {
    if (!entry || typeof entry !== 'object') return null;
    const choice = entry as Record<string, unknown>;
    const seen = choice.seen as Record<string, unknown> | undefined;
    if (!isDocId(choice.itemId) || ids.has(choice.itemId)) return null;
    if (!seen || typeof seen !== 'object' || typeof seen.name !== 'string' || seen.name.length > 500) return null;
    if (typeof seen.quantity !== 'number' || !Number.isFinite(seen.quantity)) return null;
    if (seen.purchaseOpId !== null && (typeof seen.purchaseOpId !== 'string' || seen.purchaseOpId.length > 64)) return null;
    if (choice.location !== null && !(TRIP_LOCATIONS as readonly unknown[]).includes(choice.location)) return null;
    if (choice.expiryDate !== null && !isRealDay(choice.expiryDate)) return null;
    ids.add(choice.itemId);
    items.push({
      itemId: choice.itemId,
      seen: { name: seen.name, quantity: seen.quantity, purchaseOpId: seen.purchaseOpId as string | null },
      location: choice.location as PantryItemLocation | null,
      // An expiry belongs to a shelf: an item that is not put away has none.
      expiryDate: choice.location === null ? null : choice.expiryDate as string | null,
    });
  }
  return { listId: input.listId, tripId: input.tripId, mode: input.mode, items };
}

// --- Which items the trip applies to ------------------------------------------

const millis = (value: unknown): number | null => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  return null;
};

/**
 * True when the stored item's current purchase is already in the pantry: it has
 * `pantryCreditedAt` and was not bought again after it (a new tick sets a later
 * `purchasedAt`). Only a "Put away" trip (no clear) leaves such items on a list.
 */
export function isAlreadyCredited(data: { pantryCreditedAt?: unknown; purchasedAt?: unknown }): boolean {
  const credited = millis(data.pantryCreditedAt);
  if (credited === null) return false;
  const purchased = millis(data.purchasedAt);
  return purchased === null || purchased <= credited;
}

/**
 * The purchases (`purchaseOpId`s) among `wanted` that an earlier trip still in
 * force (not undone) already put in the pantry: each trip records the purchase
 * ids it credited (`creditedPurchaseOpIds`). This survives what the item's own
 * credit stamp does not: deleting a put-away item and undoing the delete puts
 * the purchase back without its server-only stamp, under the same purchase id.
 */
export function purchasesCreditedBy(
  trips: ReadonlyArray<{ undoneAt?: unknown; creditedPurchaseOpIds?: unknown }>,
  wanted: Iterable<string>,
): Set<string> {
  const want = new Set(wanted);
  const found = new Set<string>();
  for (const trip of trips) {
    if (trip.undoneAt || !Array.isArray(trip.creditedPurchaseOpIds)) continue;
    for (const opId of trip.creditedPurchaseOpIds) if (typeof opId === 'string' && want.has(opId)) found.add(opId);
  }
  return found;
}

/** `values` in groups of at most `size` (for `array-contains-any`). */
export function chunked<T>(values: readonly T[], size = CREDITED_LOOKUP_CHUNK): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

/**
 * The purchases one put-away trip offers, in the dialog's order (by name):
 * "Put away" leaves out purchases already on the shelves (a credit stamp, or a
 * purchase id in `creditedPurchases`); "Put away & clear" offers them to clear
 * only (`shelvedIds`). At most `MAX_TRIP_ITEMS` go in one trip; `left` more stay
 * on the list for another.
 */
export function tripGroup<T extends { id: string; name: string; purchaseOpId?: string | null; pantryCreditedAt?: unknown; purchasedAt?: unknown }>(
  items: readonly T[],
  mode: TripMode,
  creditedPurchases: ReadonlySet<string>,
): { items: T[]; shelvedIds: Set<string>; left: number } {
  const shelved = (item: T) => isAlreadyCredited(item) || (typeof item.purchaseOpId === 'string' && creditedPurchases.has(item.purchaseOpId));
  const offered = (mode === 'putAway' ? items.filter((item) => !shelved(item)) : [...items])
    .sort((a, b) => a.name.localeCompare(b.name));
  const group = offered.slice(0, MAX_TRIP_ITEMS);
  return { items: group, shelvedIds: new Set(group.filter(shelved).map((item) => item.id)), left: offered.length - group.length };
}

export type SkipReason = 'gone' | 'not-purchased' | 'changed';

export type TripItemDecision = {
  /**
   * Items the trip applies to: credited (when they have a shelf and their
   * purchase is not yet in the pantry) and, with clear, cleared.
   * `alreadyCredited`: an earlier trip already put this purchase away (and
   * counted it in the usuals), so this trip neither credits nor counts it.
   */
  apply: Array<{ choice: TripChoice; data: Record<string, unknown>; credit: boolean; alreadyCredited: boolean }>;
  /** Items left exactly as they are. */
  skipped: Array<{ itemId: string; name: string; reason: SkipReason }>;
};

/**
 * Decides, from the items as just read inside the transaction, what the trip
 * does with each confirmed choice. An item that is gone, no longer purchased,
 * renamed, re-counted or bought again (a new `purchaseOpId`) since the member
 * confirmed is skipped: the trip neither credits nor clears it. An item whose
 * current purchase is already in the pantry (its credit stamp, or its purchase
 * id in `creditedPurchases`, see `purchasesCreditedBy`) is cleared (with clear)
 * but not credited again.
 */
export function decideTripItems(
  choices: readonly TripChoice[],
  read: ReadonlyMap<string, Record<string, unknown> | undefined>,
  creditedPurchases: ReadonlySet<string> = new Set(),
): TripItemDecision {
  const apply: TripItemDecision['apply'] = [];
  const skipped: TripItemDecision['skipped'] = [];
  for (const choice of choices) {
    const data = read.get(choice.itemId);
    const name = typeof data?.name === 'string' && data.name ? data.name : choice.seen.name;
    if (!data) {
      skipped.push({ itemId: choice.itemId, name, reason: 'gone' });
    } else if (data.status !== 'purchased') {
      skipped.push({ itemId: choice.itemId, name, reason: 'not-purchased' });
    } else if (
      data.name !== choice.seen.name
      || Number(data.quantity) !== choice.seen.quantity
      || (typeof data.purchaseOpId === 'string' ? data.purchaseOpId : null) !== choice.seen.purchaseOpId
    ) {
      skipped.push({ itemId: choice.itemId, name, reason: 'changed' });
    } else {
      const alreadyCredited = isAlreadyCredited(data) || (choice.seen.purchaseOpId !== null && creditedPurchases.has(choice.seen.purchaseOpId));
      apply.push({ choice, data, credit: choice.location !== null && !alreadyCredited, alreadyCredited });
    }
  }
  return { apply, skipped };
}

// --- Pantry credit --------------------------------------------------------------

/** The batch a purchase becomes: counted in `items`, no package size, the chosen shelf and expiry. */
export type PurchaseBatchKey = { name: string; location: PantryItemLocation; expiryDate: string | null };

// The pantry stores a name cut to 120 characters (`clampPantryName`); a longer
// shopping name is keyed (and recorded on the trip) as it is stored.
const purchaseMergeKey = (key: PurchaseBatchKey) => pantryMergeKey({
  nameKey: itemNameKey(clampPantryName(key.name)),
  location: key.location,
  packageSize: null,
  unit: 'items',
  expiryDate: key.expiryDate,
});

export type TripPantryPlan = PurchaseBatchKey & {
  packages: number;
  /** An existing batch with the same merge key, to re-read and top up inside the transaction. */
  targetId: string | null;
};

/**
 * Plans the pantry credit of a trip: one batch per name, shelf and expiry
 * (same-name purchases with the same shelf and expiry are combined), merging
 * into an existing batch only with the same merge key (Pantry v2: name, shelf,
 * unit `items`, no package size, same expiry). `existing` comes from a read
 * made just before the transaction; each target is re-checked inside it.
 * Each plan carries the name as the pantry stores it (`clampPantryName`), so
 * the trip's recorded effects match the batch they changed.
 */
export function planTripPantry(
  credits: ReadonlyArray<PurchaseBatchKey & { quantity: number }>,
  existing: ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
  timeZone: string,
): TripPantryPlan[] {
  const combined = new Map<string, TripPantryPlan>();
  for (const credit of credits) {
    const name = clampPantryName(credit.name);
    if (!name) continue;
    const packages = Math.max(1, Math.round(Number(credit.quantity) || 1));
    const key = purchaseMergeKey({ ...credit, name });
    const entry = combined.get(key);
    if (entry) entry.packages += packages;
    else combined.set(key, { name, location: credit.location, expiryDate: credit.expiryDate, packages, targetId: null });
  }
  const batches = existing.map(({ id, data }) => readPantryBatch(id, data, timeZone)).filter((batch) => !batch.needsRepair);
  for (const [key, plan] of combined) {
    const matches = batches.filter((batch) => pantryMergeKey(batch) === key);
    const target = matches.find((batch) => batch.packages < 10_000) ?? matches[0];
    plan.targetId = target?.id ?? null;
  }
  return [...combined.values()];
}

/** Whether a planned target, as re-read inside the transaction, still has the purchase's merge key. */
export function tripTargetStillValid(data: Record<string, unknown> | undefined, plan: PurchaseBatchKey, timeZone: string): boolean {
  if (!data || typeof data.name !== 'string' || data.unit !== 'items') return false;
  const batch = readPantryBatch('', data, timeZone);
  return !batch.needsRepair && pantryMergeKey(batch) === purchaseMergeKey(plan);
}

/** How one plan lands: packages topped up on the target (possibly 0) and new batches of at most 10,000. */
export function tripPlanWrites(plan: TripPantryPlan, target: { packages: number } | null): { toTarget: number; newBatches: number[] } {
  if (!target) return { toTarget: 0, newBatches: splitPackages(plan.packages) };
  return fillBatch(plan.packages, target.packages);
}

// --- Pantry effects and their reversal -----------------------------------------

/** One pantry document the trip changed, recorded on the trip for Undo. */
export type PantryEffect = PurchaseBatchKey & {
  pantryId: string;
  /** `create`: a new batch; `increment`: packages added to a v2 batch; `upgrade`: a legacy batch upgraded with them. */
  kind: 'create' | 'increment' | 'upgrade';
  /** Packages this trip added to that document. */
  packages: number;
};

export type PantryReversal =
  | { kind: 'skip'; reason: 'gone' | 'changed' }
  | { kind: 'set'; packages: number; clamped: boolean }
  | { kind: 'delete' };

/**
 * How Undo reverses one pantry effect on the document as just read: subtract
 * what the trip added, never below zero (`clamped` when some of it was already
 * used). A batch someone renamed, moved, re-dated or re-unitted since is a newer
 * edit and is left alone (`changed`), as is one that is gone. A batch this trip
 * created that nobody has touched since (`untouched`) is deleted when it would
 * be empty.
 */
export function planPantryReversal(effect: PantryEffect, current: Record<string, unknown> | undefined, untouched: boolean, timeZone: string): PantryReversal {
  if (!current) return { kind: 'skip', reason: 'gone' };
  if (!tripTargetStillValid(current, effect, timeZone)) return { kind: 'skip', reason: 'changed' };
  const batch = readPantryBatch('', current, timeZone);
  const left = batch.packages - effect.packages;
  if (left <= 0 && effect.kind === 'create' && untouched) return { kind: 'delete' };
  return { kind: 'set', packages: Math.max(0, left), clamped: left < 0 };
}

/**
 * Whether the trip applied at `appliedAtMs` may still be undone at `nowMs`: at
 * most `TRIP_UNDO_WINDOW_MS` later. A clock slightly behind the commit time
 * (a device) still counts as inside the window.
 */
export function tripUndoOpen(appliedAtMs: number | null, nowMs: number): boolean {
  return appliedAtMs !== null && nowMs - appliedAtMs <= TRIP_UNDO_WINDOW_MS;
}

// --- Usuals (SH-32) ---------------------------------------------------------------

// The usual's document id is `usualId` in `./usual-id.ts` (server-only: SHA-256).

export type UsualRecent = { tripId: string; atMs: number };

export type UsualFields = {
  name: string;
  nameKey: string;
  category: string;
  count: number;
  recent: UsualRecent[];
  lastBoughtAtMs: number | null;
  cadenceDays: number | null;
};

/** Median days between the recent trips (at least two), rounded; null with fewer than two. */
export function cadenceDays(recent: readonly UsualRecent[]): number | null {
  const times = [...recent].map((entry) => entry.atMs).sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((time, index) => (time - times[index]) / 86_400_000).sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
  return Math.max(1, Math.round(median));
}

const readRecent = (value: unknown): UsualRecent[] => (Array.isArray(value) ? value : [])
  .filter((entry): entry is UsualRecent => Boolean(entry) && typeof entry.tripId === 'string' && typeof entry.atMs === 'number');

/**
 * A usual after one more trip bought it. The category follows the item unless a
 * member corrected it on the usual (`categoryUpdatedAt`). A trip counts once.
 */
export function usualAfterTrip(
  previous: Record<string, unknown> | undefined,
  bought: { name: string; category: string; tripId: string; atMs: number },
): UsualFields {
  const recent = readRecent(previous?.recent).filter((entry) => entry.tripId !== bought.tripId);
  const counted = readRecent(previous?.recent).some((entry) => entry.tripId === bought.tripId);
  const nextRecent = [...recent, { tripId: bought.tripId, atMs: bought.atMs }].slice(-USUAL_RECENT_LIMIT);
  const corrected = Boolean(previous?.categoryUpdatedAt);
  const count = (typeof previous?.count === 'number' ? previous.count : 0) + (counted ? 0 : 1);
  return {
    name: corrected && typeof previous?.name === 'string' ? previous.name : bought.name,
    nameKey: itemNameKey(bought.name),
    category: corrected && typeof previous?.category === 'string' ? previous.category : bought.category,
    count,
    recent: nextRecent,
    lastBoughtAtMs: Math.max(...nextRecent.map((entry) => entry.atMs)),
    cadenceDays: cadenceDays(nextRecent),
  };
}

export type UsualReversal = { action: 'keep' } | { action: 'delete' } | { action: 'set'; fields: UsualFields };

/**
 * A usual with one trip taken back (Undo): unchanged when that trip is not in
 * its recent trips, deleted when it was the only one, otherwise recounted.
 */
export function usualWithoutTrip(previous: Record<string, unknown> | undefined, tripId: string): UsualReversal {
  if (!previous) return { action: 'keep' };
  const all = readRecent(previous.recent);
  if (!all.some((entry) => entry.tripId === tripId)) return { action: 'keep' };
  const recent = all.filter((entry) => entry.tripId !== tripId);
  const count = Math.max(0, (typeof previous.count === 'number' ? previous.count : 1) - 1);
  if (count === 0 || recent.length === 0) return { action: 'delete' };
  return {
    action: 'set',
    fields: {
      name: typeof previous.name === 'string' ? previous.name : '',
      nameKey: typeof previous.nameKey === 'string' ? previous.nameKey : '',
      category: typeof previous.category === 'string' ? previous.category : 'Other',
      count,
      recent,
      lastBoughtAtMs: Math.max(...recent.map((entry) => entry.atMs)),
      cadenceDays: cadenceDays(recent),
    },
  };
}

export type UsualSuggestion = { key: string; name: string; label: string };

/**
 * Quick-add suggestion chips (SH-32b): usuals bought at least twice with a
 * cadence, due within a day (`last bought + cadence`), not already needed on
 * the list; most overdue first, at most `limit`. "Milk · every ~6 days".
 */
export function usualSuggestions(
  usuals: ReadonlyArray<{ id: string; name?: unknown; count?: unknown; cadenceDays?: unknown; lastBoughtAtMs?: unknown }>,
  neededNames: readonly string[],
  nowMs: number,
  limit = 5,
): UsualSuggestion[] {
  const needed = new Set(neededNames.map(itemNameKey));
  return usuals
    .flatMap((usual) => {
      const name = typeof usual.name === 'string' ? usual.name.trim() : '';
      const cadence = typeof usual.cadenceDays === 'number' && usual.cadenceDays > 0 ? usual.cadenceDays : null;
      const last = typeof usual.lastBoughtAtMs === 'number' ? usual.lastBoughtAtMs : null;
      if (!name || cadence === null || last === null || Number(usual.count) < 2 || needed.has(itemNameKey(name))) return [];
      const dueInDays = (last + cadence * 86_400_000 - nowMs) / 86_400_000;
      if (dueInDays > 1) return [];
      return [{ key: usual.id, name, label: `${name} · every ~${cadence} ${cadence === 1 ? 'day' : 'days'}`, dueInDays }];
    })
    .sort((a, b) => a.dueInDays - b.dueInDays || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ key, name, label }) => ({ key, name, label }));
}

// --- Put-away expiry (SH-30) -------------------------------------------------------

export type ExpiryPick = '3d' | '1w' | '3mo' | 'none';

/** The put-away expiry chips (SH-30b), in the order shown. */
export const EXPIRY_PICKS: readonly { id: ExpiryPick; label: string }[] = [
  { id: '3d', label: '+3 d' },
  { id: '1w', label: '+1 w' },
  { id: '3mo', label: '+3 mo' },
  { id: 'none', label: 'No date' },
];

/** The per-shelf default (SH-30a): Fridge +7 days, Freezer +3 months, Pantry no date. */
export function shelfDefaultPick(location: PantryItemLocation): ExpiryPick {
  if (location === 'Fridge') return '1w';
  if (location === 'Freezer') return '3mo';
  return 'none';
}

/** The expiry a chip sets, counted from the household's today (`yyyy-MM-dd`). */
export function expiryForPick(pick: ExpiryPick, today: string): string | null {
  switch (pick) {
    case '3d': return addDays(today, 3);
    case '1w': return addDays(today, 7);
    case '3mo': return addMonthsToDay(today, 3);
    case 'none': return null;
  }
}

/** The per-shelf default expiry as a day. */
export function shelfDefaultExpiry(location: PantryItemLocation, today: string): string | null {
  return expiryForPick(shelfDefaultPick(location), today);
}

/**
 * A row's chip after its shelf changed: it follows the new shelf's default
 * unless the member picked a chip themselves (`picked`).
 */
export function pickAfterShelfChange(location: PantryItemLocation, current: ExpiryPick, picked: boolean): ExpiryPick {
  return picked ? current : shelfDefaultPick(location);
}

// --- Receipt and the empty-list prompt (SH-17, SH-3) ---------------------------------

export type AfterTrip = 'putAwayAndClear' | 'done';

/** The remembered receipt choice, or the default ("Put away & clear") when none is stored or it is unknown. */
export function readAfterTrip(value: unknown): AfterTrip {
  return value === 'done' ? 'done' : 'putAwayAndClear';
}

/**
 * Whether the "Delete empty list?" prompt is offered after a clear (SH-3a): only
 * when the server says the list is empty, and never for Grocery lists (the
 * weekly list is meant to be reused).
 */
export function offerEmptyListDelete(listType: string | undefined, remaining: number | null): boolean {
  return remaining === 0 && listType !== 'Grocery';
}

/**
 * The most items (a prefix of `count`) for which `fits` holds, by binary search;
 * `fits` must hold for every prefix of a fitting one (more items never need
 * fewer writes or less room). 0 when not even one fits.
 */
export function largestFittingCount(count: number, fits: (size: number) => boolean): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** "Put away and cleared 3 items" style summary of a trip's outcome for the toast. */
export function tripOutcomeText(outcome: {
  mode: TripMode;
  credited: number;
  cleared: number;
  skipped: ReadonlyArray<{ name: string; reason: SkipReason }>;
  /** Purchases left on the list for another trip (more than one trip can carry). */
  remaining?: number;
}): { title: string; description: string } {
  const items = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`;
  const title = outcome.mode === 'putAwayAndClear'
    ? (outcome.cleared > 0 ? 'Put away and cleared' : 'Nothing to put away')
    : (outcome.credited > 0 ? 'Put away' : 'Nothing to put away');
  const parts: string[] = [];
  if (outcome.credited > 0) parts.push(`${items(outcome.credited)} on the shelves.`);
  if (outcome.mode === 'putAwayAndClear' && outcome.cleared > outcome.credited) parts.push(`${items(outcome.cleared - outcome.credited)} cleared without the pantry.`);
  if (outcome.skipped.length > 0) {
    parts.push(`Left on the list: ${outcome.skipped.map((entry) => entry.name).join(', ')} (changed or no longer bought).`);
  }
  const remaining = outcome.remaining ?? 0;
  if (remaining > 0) parts.push(`${items(remaining)} still on the list: put ${remaining === 1 ? 'it' : 'them'} away in another trip.`);
  if (parts.length === 0) parts.push('Someone else already put these away.');
  return { title, description: parts.join(' ') };
}

/**
 * The trip the history may offer to undo: the newest one, only if it is not
 * undone and still inside the 15-minute window by this device's clock (the
 * server checks again with its own clock).
 */
export function undoableTripId(
  trips: ReadonlyArray<{ id: string; appliedAtMs: number | null; undoneAtMs: number | null }>,
  nowMs: number,
): string | null {
  const latest = trips[0];
  if (!latest || latest.undoneAtMs !== null || !tripUndoOpen(latest.appliedAtMs, nowMs)) return null;
  return latest.id;
}
