'use client';

/**
 * The one save path for new shopping items (QA-6, SH-4, SH-16, SH-28a, BL-1),
 * shared by the Shopping list (dialog, quick add, scan), the command palette, the
 * pantry's "Put on a list" and the share target:
 *
 * 1. Every entry saves at once with a category from the member's choice, else the
 *    name's remembered category, else the local keyword map, else `Other` marked
 *    `pending` (online) or `fallback` (offline). Nothing waits for AI.
 * 2. Online, a name still needed on the list merges into that item in a
 *    transaction (adds the entry's quantity; a scan adds 1). Offline nothing merges.
 * 3. Each write is classified by `trackWrite` (saved / stored-locally / sending /
 *    uncertain / failed), so the caller says only what is known.
 * 4. Then ONE batched AI call per submission (up to 40 names) for the `pending`
 *    items; each answer is written in a transaction only when the item is still
 *    `pending`/`local`, its name is unchanged and its household and list are still
 *    the active ones (`shouldApplyLateCategory`). A slow or failed call changes
 *    nothing: the items stay where they are.
 */

import { doc, getDocFromCache, runTransaction, setDoc } from 'firebase/firestore';
import { categorizeGroceryItems } from '@/ai/flows/categorize-grocery-items-flow';
import { MAX_CATEGORIZE_BATCH } from '@/ai/tasks/categorize-grocery-items';
import { getAiActionContext, unwrapAiActionResult } from '@/ai/client';
import { db, getLocalPersistence } from '@/lib/firebase';
import { isBrowserOffline } from '@/lib/firestore-offline';
import { buildShoppingListItem } from '@/lib/shopping-items';
import type { ShoppingListItem } from '@/lib/types';
import { mergeIntoNeededItem } from './item-transactions';
import { findMergeTarget, itemNameKey, type QuickAddEntry } from './items';
import { initialCategory, rememberedCategories, shouldApplyLateCategory, type CategorySource } from './local-categories';
import { trackWrite, type SaveState, type SettledState, type TrackWriteDeps } from './save-status';

export type AddEntry = QuickAddEntry & { size?: number; sizeUnit?: string };

export type EntryOutcome = {
  entry: AddEntry;
  /** Display name (the merged item's own name when merged). */
  name: string;
  merged: boolean;
  state: SaveState;
  category: string;
  categorySource?: CategorySource;
  error?: unknown;
  /** Final answer for entries that were still pending (resolves at once otherwise). */
  settled: Promise<SettledState>;
};

export type CategorizationReport = {
  /** Names sent to the model (0 when nothing needed it, offline, or no AI). */
  requested: number;
  /** Names whose category the answer changed. */
  applied: string[];
  /** Names left under Other because the call failed. */
  unavailable: string[];
  reason?: string;
};

export type ActiveTarget = { householdId: string | null; listId: string | null } | null;

type KnownItem = Pick<ShoppingListItem, 'id' | 'name' | 'status' | 'category'> & Partial<Pick<ShoppingListItem, 'categorySource' | 'nameKey'>>;

/** Categories remembered this session per household (AI answers and manual picks), on top of the list's items. */
const sessionMemory = new Map<string, Map<string, string>>();
const remember = (householdId: string, name: string, category: string) => {
  const memory = sessionMemory.get(householdId) ?? new Map<string, string>();
  memory.set(itemNameKey(name), category);
  sessionMemory.set(householdId, memory);
};

// One batched call at a time per page: the server allows one in-flight request per
// user and flow, so a second submission waits for the first instead of failing busy.
let aiQueue: Promise<unknown> = Promise.resolve();
const AI_CLIENT_TIMEOUT_MS = 20_000;

const trackDeps = (kind: TrackWriteDeps['kind'], cacheReflectsWrite?: () => Promise<boolean>): TrackWriteDeps => ({
  kind,
  persistence: getLocalPersistence,
  offline: isBrowserOffline,
  cacheReflectsWrite,
});

const aiReason = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : 'error';

export async function addItemsToList({
  householdId,
  listId,
  uid,
  entries,
  categories,
  knownItems = [],
  selectedCategory,
  imageUrl,
  barcode,
  sourceUrl,
  allowMerge = true,
  active,
  onLateError,
}: {
  householdId: string;
  listId: string;
  /** Signed-in uid, written as `addedByUid`. */
  uid: string | null | undefined;
  entries: readonly AddEntry[];
  categories: readonly string[];
  /** Items already on the list (merge targets and remembered categories). */
  knownItems?: readonly KnownItem[];
  selectedCategory?: string;
  imageUrl?: string;
  barcode?: string;
  sourceUrl?: string;
  /** The share target always creates (it may carry a link). */
  allowMerge?: boolean;
  /** The household and list a late AI answer may still touch. */
  active: () => ActiveTarget;
  /** A write that was still pending and later failed. */
  onLateError?: (name: string, error: unknown) => void;
}): Promise<{ outcomes: EntryOutcome[]; categorization: Promise<CategorizationReport> }> {
  const offline = isBrowserOffline();
  const remembered = rememberedCategories(knownItems);
  sessionMemory.get(householdId)?.forEach((category, key) => { if (!remembered.has(key)) remembered.set(key, category); });
  const itemsRef = (itemId: string) => doc(db, 'households', householdId, 'shopping-lists', listId, 'items', itemId);
  const toCategorize: Array<{ itemId: string; name: string; settled: Promise<SettledState> }> = [];

  const create = async (entry: AddEntry, aiAvailable: boolean): Promise<EntryOutcome> => {
    const { category, categorySource } = initialCategory({ name: entry.name, categories, selectedCategory, remembered, aiAvailable });
    if (categorySource === 'manual') remember(householdId, entry.name, category);
    const { itemId, data } = buildShoppingListItem({
      name: entry.name,
      quantity: entry.quantity,
      category,
      categorySource,
      addedByUid: uid,
      imageUrl,
      barcode,
      sourceUrl,
      size: entry.size,
      sizeUnit: entry.sizeUnit,
    });
    const ref = itemsRef(itemId);
    const tracked = await trackWrite(setDoc(ref, data), trackDeps('write', async () => {
      const cached = await getDocFromCache(ref);
      return cached.exists() && cached.get('nameKey') === data.nameKey;
    }));
    const settled = tracked.settled.then((result) => {
      if (result.state === 'failed' && tracked.state !== 'failed') onLateError?.(entry.name, result.error);
      return result.state;
    });
    if (categorySource === 'pending' && tracked.state !== 'failed') toCategorize.push({ itemId, name: entry.name, settled });
    return { entry, name: entry.name, merged: false, state: tracked.state, category, categorySource, error: tracked.error, settled };
  };

  const saveEntry = async (entry: AddEntry): Promise<EntryOutcome> => {
    const target = allowMerge && !offline ? findMergeTarget(knownItems, entry.name) : undefined;
    if (!target) return create(entry, !offline);
    const tracked = await trackWrite(mergeIntoNeededItem(itemsRef(target.id), entry.quantity), trackDeps('transaction'));
    if (tracked.state === 'saved' && tracked.value) {
      return { entry, name: target.name, merged: true, state: 'saved', category: target.category, settled: Promise.resolve('saved') };
    }
    if (tracked.state === 'saved') return create(entry, !offline); // bought or deleted meanwhile
    if (tracked.state === 'failed') {
      return { entry, name: entry.name, merged: false, state: 'failed', category: target.category, error: tracked.error, settled: Promise.resolve('failed') };
    }
    // No answer in time: show it pending; when it settles, a "not merged" answer
    // still creates the item (without asking the model again).
    const settled = tracked.settled.then(async (result): Promise<SettledState> => {
      if (result.state === 'failed') {
        onLateError?.(entry.name, result.error);
        return 'failed';
      }
      if (result.value) return 'saved';
      const late = await create(entry, false);
      return late.state === 'failed' ? 'failed' : late.settled;
    });
    return { entry, name: target.name, merged: true, state: tracked.state, category: target.category, settled };
  };

  // Each entry is its own write, so one failure never hides which were saved.
  const settledEntries = await Promise.allSettled(entries.map((entry) => saveEntry(entry)));
  const outcomes = settledEntries.map((result, index): EntryOutcome => result.status === 'fulfilled' ? result.value : {
    entry: entries[index], name: entries[index].name, merged: false, state: 'failed', category: 'Other', error: result.reason, settled: Promise.resolve('failed'),
  });

  const batch = toCategorize.slice(0, MAX_CATEGORIZE_BATCH);
  const categorization = batch.length === 0
    ? Promise.resolve<CategorizationReport>({ requested: 0, applied: [], unavailable: [] })
    : categorizeLater({ householdId, listId, categories, batch, active });
  return { outcomes, categorization };
}

async function categorizeLater({
  householdId,
  listId,
  categories,
  batch,
  active,
}: {
  householdId: string;
  listId: string;
  categories: readonly string[];
  batch: Array<{ itemId: string; name: string; settled: Promise<SettledState> }>;
  active: () => ActiveTarget;
}): Promise<CategorizationReport> {
  const names = batch.map((item) => item.name);
  const run = aiQueue.then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => unwrapAiActionResult(await categorizeGroceryItems(
          { itemNames: names, categories: [...categories] },
          await getAiActionContext(householdId),
        )))(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('categorization-timeout'), { code: 'timeout' })), AI_CLIENT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  aiQueue = run.catch(() => undefined);

  let answer: { categories: string[] };
  try {
    answer = await run;
  } catch (error) {
    return { requested: names.length, applied: [], unavailable: names, reason: aiReason(error) };
  }

  const listRef = doc(db, 'households', householdId, 'shopping-lists', listId);
  const applied: string[] = [];
  await Promise.all(batch.map(async ({ itemId, name, settled }, index) => {
    const aiCategory = answer.categories[index];
    if (!aiCategory) return;
    // The item must have reached the server before a transaction can read it.
    if (await settled !== 'saved') return;
    const itemRef = doc(listRef, 'items', itemId);
    const changed = await runTransaction(db, async (transaction) => {
      const [listSnapshot, itemSnapshot] = await Promise.all([transaction.get(listRef), transaction.get(itemRef)]);
      const item = itemSnapshot.exists() ? itemSnapshot.data() as ShoppingListItem : undefined;
      if (!shouldApplyLateCategory({
        item,
        listExists: listSnapshot.exists(),
        expectedNameKey: itemNameKey(name),
        aiCategory,
        categories,
        target: { householdId, listId },
        active: active(),
      })) return false;
      const category = categories.find((candidate) => candidate.toLowerCase() === aiCategory.toLowerCase()) ?? aiCategory;
      transaction.update(itemRef, { category, categorySource: 'ai' });
      return category !== item?.category;
    }).catch(() => false);
    if (aiCategory.toLowerCase() !== 'other') remember(householdId, name, aiCategory);
    if (changed) applied.push(name);
  }));
  return { requested: names.length, applied, unavailable: [] };
}
