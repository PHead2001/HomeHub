/**
 * Category order and per-store aisle order (S6: SH-10c/d, SH-34a/b, SH-20b).
 * No Firebase imports: the writers in `./category-writes.ts` turn these plans
 * into `arrayUnion` / `arrayRemove` writes and transactions, so the decisions are
 * unit tested under Node (tests/unit/shopping-category-order.test.ts).
 *
 * Model (`households/{h}/shopping-lists/{listId}/config/categories`):
 * - `ordered`: the list's categories in the member's aisle order. Adds and
 *   removes are `arrayUnion` / `arrayRemove` on it, a move is a transaction that
 *   rewrites it from the order the server holds at that moment.
 * - `list`: which categories the list has. Older clients rewrite it whole
 *   (sorted); this release changes it with the same `arrayUnion` / `arrayRemove`
 *   values as `ordered`. Once `list` exists it is the authority for membership:
 *   `ordered` only supplies the order, an `ordered` entry missing from `list` is
 *   ignored, and a `list` name missing from `ordered` (an older client's add) is
 *   shown after the ordered ones. So a stale `ordered` seed can never bring back
 *   a category another member removed.
 * - Without `ordered` (older documents, and the defaults when there is no
 *   document) categories are shown in store-walk order. The first add or remove
 *   that introduces `ordered` (or the document) runs online in a transaction
 *   that re-reads the document and writes both fields from what is stored then
 *   (`planSeededChange`), so two members' first edits both land. Offline it falls
 *   back to the `arrayUnion` seed; with `list` as the authority that is safe for
 *   an existing document, and for a missing one two offline first edits on
 *   different devices may bring back a default the other removed. The first
 *   move is a transaction anyway.
 * - Categories are one aisle regardless of case and spacing ("dairy" = "Dairy",
 *   SH-10d): the first spelling wins. Entries are strings of at most
 *   {@link MAX_STORED_CATEGORY} characters (the rules cannot check list entries).
 * - `Other` is always last and cannot be moved or removed.
 * - A store (`stores/{storeId}`) has `aisleOrder`, category names in walk order,
 *   shared by every list that names it in `storeId`. A list at a store groups its
 *   items in the store's order, then its own categories the store has not placed.
 */

export const OTHER_CATEGORY = 'Other';
export const MAX_CATEGORY_NAME = 60;
/** Longest entry written to `list`, `ordered` or `aisleOrder` (the item category bound). */
export const MAX_STORED_CATEGORY = 100;
/** The rules' bound on `config/categories.list` / `.ordered` and on a store's `aisleOrder`. */
export const MAX_LIST_CATEGORIES = 200;
export const MAX_STORE_AISLES = 200;
export const MAX_STORE_NAME = 60;

/** The departments of a supermarket walk, in order (the order for lists without `ordered`). */
export const STORE_WALK_ORDER = ['Produce', 'Bakery', 'Meat', 'Dairy', 'Frozen', 'Pantry', 'Snacks', 'Drinks', 'Household'] as const;

/** A category name as stored: spaces collapsed and trimmed. */
export const cleanCategoryName = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Comparison key for a category or a list/store name: case and spacing ignored. */
export const categoryKey = (value: string): string => cleanCategoryName(value).toLowerCase();

export const isOtherCategory = (value: string): boolean => categoryKey(value) === 'other';

const walkIndex = (category: string): number => {
  const key = categoryKey(category);
  return STORE_WALK_ORDER.findIndex((known) => known.toLowerCase() === key);
};

/**
 * Cleaned names, without empties, overlong entries and case/spacing duplicates
 * (first spelling kept).
 */
export function dedupeCategories(list: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const name = cleanCategoryName(entry);
    const key = name.toLowerCase();
    if (!name || name.length > MAX_STORED_CATEGORY || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

/**
 * The order a list's categories are shown and grouped in, always ending with
 * `Other`. `ordered`: the stored order. Otherwise (older, sorted documents and
 * the defaults): store-walk departments first, then the rest in stored order.
 */
export function effectiveCategoryOrder(stored: readonly unknown[], ordered: boolean): string[] {
  const names = dedupeCategories(stored);
  const other = names.find(isOtherCategory) ?? OTHER_CATEGORY;
  const rest = names.filter((name) => !isOtherCategory(name));
  if (ordered) return [...rest, other];
  const walked = rest
    .map((name, index) => ({ name, index, walk: walkIndex(name) }))
    .sort((a, b) => {
      const ga = a.walk >= 0 ? 0 : 1;
      const gb = b.walk >= 0 ? 0 : 1;
      return ga - gb || (ga === 0 ? a.walk - b.walk : a.index - b.index);
    })
    .map((entry) => entry.name);
  return [...walked, other];
}

/** A list's category configuration as the screens use it. */
export type CategoryConfig = {
  /** Display and grouping order, deduplicated, `Other` last. */
  list: string[];
  /** `list` exactly as stored (spellings to remove); empty when absent. */
  rawList: string[];
  /** `ordered` exactly as stored; empty when absent. */
  rawOrdered: string[];
  /** Whether `ordered` exists (the member's order is kept). */
  ordered: boolean;
  /** Whether `config/categories` exists (false: the defaults are shown). */
  exists: boolean;
};

const withoutOther = (names: readonly string[]) => names.filter((name) => !isOtherCategory(name));

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Reads `config/categories` (absent: the defaults, in store-walk order). */
export function readCategoryConfig(data: unknown, exists: boolean, defaults: readonly string[]): CategoryConfig {
  if (!exists || !data || typeof data !== 'object') {
    return { list: effectiveCategoryOrder(defaults, false), rawList: [], rawOrdered: [], ordered: false, exists: false };
  }
  const record = data as { list?: unknown; ordered?: unknown };
  const rawList = stringsOf(record.list);
  const rawOrdered = stringsOf(record.ordered);
  const ordered = Array.isArray(record.ordered);
  let list: string[];
  if (!ordered) {
    list = effectiveCategoryOrder(rawList, false);
  } else if (!Array.isArray(record.list)) {
    list = effectiveCategoryOrder(rawOrdered, true);
  } else {
    // `list` says which categories exist; `ordered` only says in which order.
    const members = dedupeCategories(rawList);
    const memberKeys = new Set(members.map(categoryKey));
    const kept = dedupeCategories(rawOrdered).filter((name) => memberKeys.has(categoryKey(name)));
    const keptKeys = new Set(kept.map(categoryKey));
    list = effectiveCategoryOrder([...kept, ...members.filter((name) => !keptKeys.has(categoryKey(name)))], true);
  }
  return { list, rawList, rawOrdered, ordered, exists: true };
}

/** An add or a remove, as the category dialog asks for it. */
export type CategoryChange = { kind: 'add'; name: string } | { kind: 'remove'; category: string };

/**
 * Whether a change would introduce `ordered` (or the document itself): such a
 * change runs online as a transaction (`planSeededChange`) instead of a seed
 * by `arrayUnion` from the screen's possibly stale copy.
 */
export const changeSeedsOrder = (config: CategoryConfig): boolean => !config.exists || !config.ordered;

/**
 * Whether an add must rewrite (compact) the stored arrays instead of appending:
 * `ordered` or `list` already holds {@link MAX_LIST_CATEGORIES} entries, some of
 * them stale (an `ordered` entry an older client removed from `list`, or a second
 * spelling), so one more `arrayUnion` value would exceed the rules' bound although
 * fewer categories are shown. Such an add runs online as the same transaction as
 * a seed (`planSeededChange`), which writes both fields from the shown order.
 */
export const addNeedsCompaction = (config: CategoryConfig): boolean =>
  config.rawOrdered.length >= MAX_LIST_CATEGORIES || config.rawList.length >= MAX_LIST_CATEGORIES;

/** Whether an add or remove runs as a transaction (`planSeededChange`) rather than one arrayUnion/arrayRemove write. */
export const changeNeedsTransaction = (config: CategoryConfig, change: CategoryChange['kind']): boolean =>
  changeSeedsOrder(config) || (change === 'add' && addNeedsCompaction(config));

/**
 * The first add or remove that introduces `ordered`, planned inside a
 * transaction from the document as stored now (a removal or add another member
 * made meanwhile is respected): both fields are written with the resulting
 * order. Null: nothing to write (already added, already gone, `Other`, or full).
 */
export function planSeededChange(
  server: { data: unknown; exists: boolean },
  defaults: readonly string[],
  change: CategoryChange,
): { list: string[]; ordered: string[] } | null {
  const fresh = readCategoryConfig(server.data, server.exists, defaults);
  if (change.kind === 'add') {
    const name = cleanCategoryName(change.name);
    if (!name || name.length > MAX_CATEGORY_NAME) return null;
    if (fresh.list.some((entry) => categoryKey(entry) === categoryKey(name))) return null;
    if (fresh.list.length >= MAX_LIST_CATEGORIES) return null;
    const next = [...withoutOther(fresh.list), name, OTHER_CATEGORY];
    return { list: next, ordered: next };
  }
  const key = categoryKey(change.category);
  if (isOtherCategory(change.category) || !fresh.list.some((entry) => categoryKey(entry) === key)) return null;
  const next = fresh.list.filter((entry) => categoryKey(entry) !== key);
  return { list: next, ordered: next };
}

/**
 * A category write that never rewrites a whole list from a stale copy (SH-10c):
 * each field is an `arrayUnion` or an `arrayRemove` of these values. Two members
 * adding (or one adding while another removes) both land.
 */
export type CategoryWritePlan = {
  unionList?: string[];
  removeList?: string[];
  unionOrdered?: string[];
  removeOrdered?: string[];
};

export type CategoryAddResult = { ok: true; name: string; plan: CategoryWritePlan } | { ok: false; error: string };

export function planCategoryAdd(input: string, config: CategoryConfig): CategoryAddResult {
  const name = cleanCategoryName(input);
  if (!name) return { ok: false, error: 'Type a category name.' };
  if (name.length > MAX_CATEGORY_NAME) return { ok: false, error: `Keep the name under ${MAX_CATEGORY_NAME} characters.` };
  const existing = config.list.find((category) => categoryKey(category) === categoryKey(name));
  if (existing) return { ok: false, error: `${existing} is already a category.` };
  if (config.list.length >= MAX_LIST_CATEGORIES) return { ok: false, error: `A list can have at most ${MAX_LIST_CATEGORIES} categories.` };
  // The order on screen with the new category just before Other.
  const seeded = [...withoutOther(config.list), name, OTHER_CATEGORY];
  if (!config.exists) return { ok: true, name, plan: { unionList: seeded, unionOrdered: seeded } };
  if (!config.ordered) return { ok: true, name, plan: { unionList: [name], unionOrdered: seeded } };
  return { ok: true, name, plan: { unionList: [name], unionOrdered: [name] } };
}

/** Removing a category: every stored spelling of it (null for `Other` or an unknown name). */
export function planCategoryRemove(category: string, config: CategoryConfig): CategoryWritePlan | null {
  if (isOtherCategory(category)) return null;
  const key = categoryKey(category);
  if (!config.list.some((entry) => categoryKey(entry) === key)) return null;
  const rest = config.list.filter((entry) => categoryKey(entry) !== key);
  if (!config.exists) return { unionList: rest, unionOrdered: rest };
  const plan: CategoryWritePlan = {};
  const inList = config.rawList.filter((entry) => categoryKey(entry) === key);
  if (inList.length > 0) plan.removeList = inList;
  if (config.ordered) {
    const inOrdered = config.rawOrdered.filter((entry) => categoryKey(entry) === key);
    if (inOrdered.length > 0) plan.removeOrdered = inOrdered;
  } else {
    plan.unionOrdered = rest;
  }
  return Object.keys(plan).length > 0 ? plan : null;
}

export type MoveDirection = -1 | 1;

/**
 * Moves one category a step up (-1) or down (+1) in a display order ending with
 * `Other`. Null when it cannot move (unknown, `Other`, already at that end).
 */
export function moveCategory(order: readonly string[], category: string, direction: MoveDirection): string[] | null {
  const rest = withoutOther(order);
  const other = order.find(isOtherCategory) ?? OTHER_CATEGORY;
  const index = rest.findIndex((entry) => categoryKey(entry) === categoryKey(category));
  const target = index + direction;
  if (index < 0 || target < 0 || target >= rest.length) return null;
  const next = [...rest];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return [...next, other];
}

/**
 * The reorder written in a transaction (merged, so `list` is kept): the move
 * applied to the order the server holds now (re-read), so a reorder never writes
 * back a stale copy of someone else's adds or moves. Null: nothing to write (the
 * category is gone or already at that end).
 */
export function planListReorder(
  server: { data: unknown; exists: boolean },
  defaults: readonly string[],
  category: string,
  direction: MoveDirection,
): { ordered: string[]; list?: string[] } | null {
  const config = readCategoryConfig(server.data, server.exists, defaults);
  const next = moveCategory(config.list, category, direction);
  if (!next) return null;
  // A new document also gets `list`, so older readers see the categories.
  return config.exists ? { ordered: next } : { ordered: next, list: next };
}

/**
 * A store's full walk order for a list: the store's aisles (without `Other`),
 * then the list's own categories the store has not placed yet, in list order.
 */
export function storeWalkFor(aisleOrder: readonly unknown[], listOrder: readonly string[]): string[] {
  const aisles = dedupeCategories(aisleOrder).filter((name) => !isOtherCategory(name));
  const placed = new Set(aisles.map(categoryKey));
  const extra = listOrder.filter((name) => !isOtherCategory(name) && !placed.has(categoryKey(name)));
  return [...aisles, ...extra];
}

/**
 * The list's categories in the store's order (the list's spellings), `Other`
 * last: what the category dialog shows while the list is at a store.
 */
export function listOrderAtStore(aisleOrder: readonly unknown[], listOrder: readonly string[]): string[] {
  const byKey = new Map(listOrder.filter((name) => !isOtherCategory(name)).map((name) => [categoryKey(name), name]));
  const visible = storeWalkFor(aisleOrder, listOrder)
    .map((name) => byKey.get(categoryKey(name)))
    .filter((name): name is string => Boolean(name));
  return [...visible, listOrder.find(isOtherCategory) ?? OTHER_CATEGORY];
}

/**
 * Moves a category one step among the list's categories inside the store's full
 * order. Aisles of the store this list does not use keep their places, so
 * another list at the same store keeps its order. Returns the new `aisleOrder`,
 * null when it cannot move, or 'too-many' above {@link MAX_STORE_AISLES}.
 */
export function planStoreReorder(
  aisleOrder: readonly unknown[],
  listOrder: readonly string[],
  category: string,
  direction: MoveDirection,
): string[] | null | 'too-many' {
  const full = storeWalkFor(aisleOrder, listOrder);
  const visible = new Set(listOrder.filter((name) => !isOtherCategory(name)).map(categoryKey));
  const key = categoryKey(category);
  const index = full.findIndex((name) => categoryKey(name) === key);
  if (index < 0 || !visible.has(key)) return null;
  let neighbour = index + direction;
  while (neighbour >= 0 && neighbour < full.length && !visible.has(categoryKey(full[neighbour]))) neighbour += direction;
  if (neighbour < 0 || neighbour >= full.length) return null;
  const next = [...full];
  const [moved] = next.splice(index, 1);
  // Up: inserted at the neighbour's index (just before it). Down: once `moved` is
  // out, the neighbour sits one index earlier, so the same index is just after it.
  next.splice(neighbour, 0, moved);
  if (next.length > MAX_STORE_AISLES) return 'too-many';
  return next;
}

/**
 * The order the open list groups its needed items in: the store's walk when the
 * list is at a store, else the list's own order.
 */
export function groupingOrder(listOrder: readonly string[], store: { aisleOrder: readonly unknown[] } | null): string[] {
  return store ? [...storeWalkFor(store.aisleOrder, listOrder), OTHER_CATEGORY] : [...listOrder];
}

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** A new store's name: required, bounded, and not a second store of the same name. */
export function checkStoreName(input: string, stores: readonly { name: string }[]): NameCheck {
  const name = cleanCategoryName(input);
  if (!name) return { ok: false, error: 'Give the store a name.' };
  if (name.length > MAX_STORE_NAME) return { ok: false, error: `Keep the name under ${MAX_STORE_NAME} characters.` };
  const existing = stores.find((store) => categoryKey(store.name ?? '') === categoryKey(name));
  if (existing) return { ok: false, error: `You already have a store called ${existing.name}. Pick it from the list.` };
  return { ok: true, name };
}

/** The first store aisle order for a new store: the list's order on screen, without `Other`. */
export function initialAisleOrder(listOrder: readonly string[]): string[] {
  return listOrder.filter((name) => !isOtherCategory(name)).slice(0, MAX_STORE_AISLES);
}

/** The list already called `name` (case and spacing ignored), other than `exceptId` (SH-20b). */
export function findListNamed<T extends { id: string; name?: string }>(name: string, lists: readonly T[], exceptId?: string | null): T | null {
  const key = categoryKey(name);
  if (!key) return null;
  return lists.find((list) => list.id !== exceptId && categoryKey(String(list.name ?? '')) === key) ?? null;
}

/** The store a list follows, when that store still exists. */
export function storeForList<T extends { id: string }>(storeId: unknown, stores: readonly T[]): T | null {
  return typeof storeId === 'string' && storeId ? stores.find((store) => store.id === storeId) ?? null : null;
}
