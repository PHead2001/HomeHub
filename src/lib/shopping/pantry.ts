/**
 * Pure pantry helpers: where a purchased item is stored, how a batch of purchases
 * merges into the pantry, expiry states for the shelves, tile emoji, and matching
 * recipe ingredients back to pantry items. Unit tested in
 * tests/unit/shopping-logic.test.ts.
 */

import type { PantryItem, PantryItemLocation, ShoppingListItem } from '@/lib/types';
import { itemNameKey } from './items';
import { daysUntilDay, householdToday, pantryMergeKey, readPantryBatch } from './pantry-batches';

export const PANTRY_LOCATIONS: readonly PantryItemLocation[] = ['Pantry', 'Fridge', 'Freezer'];

const FRIDGE_CATEGORIES = new Set(['dairy', 'meat', 'produce', 'deli', 'seafood', 'fish', 'eggs']);
const FREEZER_CATEGORIES = new Set(['frozen', 'freezer', 'ice cream']);

/** Produce kept at room temperature (SH-23c): these stay in the Pantry even though Produce goes to the Fridge. */
const SHELF_STABLE_PRODUCE = /\b(onions?|shallots?|garlic|potato(es)?|sweet potato(es)?|yams?|bananas?|plantains?|squash|pumpkins?)\b/i;

/**
 * Where a purchased item goes by its shopping category: Dairy -> Fridge, Frozen
 * -> Freezer, Produce -> Fridge except shelf-stable produce (onions, potatoes,
 * bananas...), which stays in the Pantry when its name is known.
 */
export function pantryLocationForCategory(category: string | undefined | null, name?: string | null): PantryItemLocation {
  const key = (category ?? '').trim().toLowerCase();
  if (FREEZER_CATEGORIES.has(key)) return 'Freezer';
  if (key === 'produce' && name && SHELF_STABLE_PRODUCE.test(name)) return 'Pantry';
  if (FRIDGE_CATEGORIES.has(key)) return 'Fridge';
  return 'Pantry';
}

export type PantryHandoffChoice = {
  /** The shopping item this purchase comes from (re-read inside the transaction). */
  itemId: string;
  item: Pick<ShoppingListItem, 'name' | 'quantity'>;
  location: PantryItemLocation;
};

/**
 * Keeps only the choices whose shopping item is confirmed still purchased by a
 * read inside the transaction, using the confirmed name and quantity. An item
 * someone un-ticked, deleted or already cleared (for example a second member
 * running "Add to pantry, then clear" at the same time) is skipped, so the pantry
 * is credited only for purchases this transaction confirms.
 */
export function confirmedHandoffChoices(
  choices: readonly PantryHandoffChoice[],
  confirmed: ReadonlyMap<string, { name?: unknown; quantity?: unknown; status?: unknown } | undefined>,
): { credited: PantryHandoffChoice[]; skipped: PantryHandoffChoice[] } {
  const credited: PantryHandoffChoice[] = [];
  const skipped: PantryHandoffChoice[] = [];
  const seen = new Set<string>();
  for (const choice of choices) {
    const data = confirmed.get(choice.itemId);
    if (seen.has(choice.itemId) || !data || data.status !== 'purchased') {
      skipped.push(choice);
      continue;
    }
    seen.add(choice.itemId);
    credited.push({
      ...choice,
      item: {
        name: typeof data.name === 'string' && data.name.trim() ? data.name : choice.item.name,
        quantity: Number(data.quantity) > 0 ? Number(data.quantity) : choice.item.quantity,
      },
    });
  }
  return { credited, skipped };
}

export type PantryWritePlan =
  /** Adds `add` to the existing entry with an atomic Firestore increment (never a read-then-write total). */
  | { kind: 'increment'; id: string; name: string; add: number; location: PantryItemLocation }
  | { kind: 'create'; name: string; quantity: number; location: PantryItemLocation };

/** The batch a purchase becomes: counted in `items`, no package size, no expiry (Pantry v2 merge key). */
const purchaseKey = (name: string, location: PantryItemLocation) =>
  pantryMergeKey({ nameKey: itemNameKey(name), location, packageSize: null, unit: 'items', expiryDate: null });

/**
 * Plans the pantry writes for a batch of purchased items. A purchase is a batch
 * counted in `items` with no package size and no expiry, so it merges only into
 * an existing batch with that same merge key (same name and shelf, unit `items`,
 * no size, no expiry: Pantry v2, SH-23a); its packages grow by an atomic
 * increment, so concurrent handoffs add up. Anything else becomes a new batch.
 * Two purchases of the same name and location in one batch are combined.
 */
export function planPantryHandoff(
  choices: readonly Pick<PantryHandoffChoice, 'item' | 'location'>[],
  existing: readonly (Pick<PantryItem, 'id' | 'name' | 'unit' | 'location'> & Partial<PantryItem>)[],
): PantryWritePlan[] {
  const combined = new Map<string, { name: string; quantity: number; location: PantryItemLocation }>();
  for (const { item, location } of choices) {
    const name = item.name.trim();
    if (!name) continue;
    const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
    const key = `${itemNameKey(name)}|${location}`;
    const entry = combined.get(key);
    if (entry) entry.quantity += quantity;
    else combined.set(key, { name, quantity, location });
  }

  const plans: PantryWritePlan[] = [];
  for (const entry of combined.values()) {
    const key = purchaseKey(entry.name, entry.location);
    const match = existing.find((pantryItem) => pantryMergeKey(readPantryBatch(pantryItem.id, pantryItem)) === key);
    if (match) {
      plans.push({ kind: 'increment', id: match.id, name: match.name, add: entry.quantity, location: entry.location });
    } else {
      plans.push({ kind: 'create', ...entry });
    }
  }
  return plans;
}

/**
 * Whether a planned pantry increment still applies to the entry as just read
 * inside a transaction: it must still exist with the purchase's merge key (same
 * name and shelf, unit `items`, no package size, no expiry). Otherwise the
 * purchase becomes a new batch.
 */
export function pantryMergeStillValid(
  data: Record<string, unknown> | undefined | null,
  plan: { name: string },
  location: PantryItemLocation,
): boolean {
  if (!data || typeof data.name !== 'string' || data.unit !== 'items' || data.location !== location) return false;
  return pantryMergeKey(readPantryBatch('', data)) === purchaseKey(plan.name, location);
}

export type ExpiryState = 'expired' | 'soon' | 'fresh' | 'none';

/**
 * Days from `now` to the expiry date; negative once past. Null without a valid date.
 * With a `timeZone` (the household's, D-6), both "today" and a legacy ISO expiry are
 * read as days in that zone, so the label rolls over at household midnight
 * (SH-10b). Without one, device-local days are used.
 */
export function daysUntilExpiry(expiryDate: string | null | undefined, now: Date = new Date(), timeZone?: string | null): number | null {
  if (!expiryDate) return null;
  if (timeZone !== undefined) return daysUntilDay(expiryDate, householdToday(now, timeZone), timeZone);
  // Date-only strings ("2026-08-04") are local calendar days; ISO timestamps are read as instants.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(expiryDate);
  const expiry = dateOnly ? new Date(`${expiryDate}T00:00:00`) : new Date(expiryDate);
  if (Number.isNaN(expiry.getTime())) return null;
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOf(expiry) - startOf(now)) / 86_400_000);
}

/** Shelf state for a day count: expired (past), soon (today to three days out), fresh, or none (no date). */
export function expiryStateForDays(days: number | null): ExpiryState {
  if (days === null) return 'none';
  if (days < 0) return 'expired';
  if (days <= 3) return 'soon';
  return 'fresh';
}

/** Shelf state: expired (past its date), soon (today to three days out), fresh, or none (no date). */
export function expiryState(expiryDate: string | null | undefined, now: Date = new Date(), timeZone?: string | null): ExpiryState {
  return expiryStateForDays(daysUntilExpiry(expiryDate, now, timeZone));
}

/** Short human label for a day count: "Expired", "Expires today", "2 days left". */
export function expiryLabelForDays(days: number | null): string | null {
  if (days === null) return null;
  if (days < -1) return `Expired ${-days} days ago`;
  if (days === -1) return 'Expired yesterday';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `${days} days left`;
}

/** Short human label for a tile: "Expired", "Expires today", "2 days left". */
export function expiryLabel(expiryDate: string | null | undefined, now: Date = new Date(), timeZone?: string | null): string | null {
  return expiryLabelForDays(daysUntilExpiry(expiryDate, now, timeZone));
}

const EMOJI_RULES: [RegExp, string][] = [
  [/\b(milk|cream|creamer)\b/, '🥛'],
  [/\b(yog(h)?urt|kefir)\b/, '🥣'],
  [/\b(cheese|cheddar|mozzarella|parmesan|brie)\b/, '🧀'],
  [/\b(butter)\b/, '🧈'],
  [/\b(eggs?)\b/, '🥚'],
  [/\b(bread|loaf|bagels?|baguette|buns?|rolls?)\b/, '🍞'],
  [/\b(rice)\b/, '🍚'],
  [/\b(pasta|spaghetti|noodles?|macaroni|penne)\b/, '🍝'],
  [/\b(flour|sugar|oats?|cereal|granola)\b/, '🌾'],
  [/\b(coffee|espresso)\b/, '☕'],
  [/\b(tea)\b/, '🍵'],
  [/\b(juice)\b/, '🧃'],
  [/\b(water|soda|sparkling|cola|seltzer)\b/, '🥤'],
  [/\b(wine)\b/, '🍷'],
  [/\b(beer)\b/, '🍺'],
  [/\b(apples?)\b/, '🍎'],
  [/\b(bananas?)\b/, '🍌'],
  [/\b(berries|berry|strawberr(y|ies)|blueberr(y|ies)|raspberr(y|ies))\b/, '🫐'],
  [/\b(grapes?)\b/, '🍇'],
  [/\b(lemons?|limes?)\b/, '🍋'],
  [/\b(oranges?|clementines?|mandarins?)\b/, '🍊'],
  [/\b(avocados?)\b/, '🥑'],
  [/\b(tomato(es)?)\b/, '🍅'],
  [/\b(carrots?)\b/, '🥕'],
  [/\b(potato(es)?)\b/, '🥔'],
  [/\b(onions?|garlic)\b/, '🧅'],
  [/\b(lettuce|spinach|salad|greens|kale|broccoli)\b/, '🥬'],
  [/\b(peppers?|chil(e|i|ies))\b/, '🌶️'],
  [/\b(corn)\b/, '🌽'],
  [/\b(chicken|turkey)\b/, '🍗'],
  [/\b(beef|steak|mince|burger)\b/, '🥩'],
  [/\b(bacon|ham|pork|sausages?)\b/, '🥓'],
  [/\b(fish|salmon|tuna|shrimp|prawns?)\b/, '🐟'],
  [/\b(ice cream|gelato)\b/, '🍨'],
  [/\b(pizza)\b/, '🍕'],
  [/\b(chocolate|candy|sweets)\b/, '🍫'],
  [/\b(cookies?|biscuits?)\b/, '🍪'],
  [/\b(chips|crisps|crackers|popcorn|pretzels?)\b/, '🍿'],
  [/\b(soup|broth|stock)\b/, '🥫'],
  [/\b(beans|lentils|chickpeas)\b/, '🫘'],
  [/\b(oil|vinegar)\b/, '🫒'],
  [/\b(salt|pepper|spice|seasoning|cumin|paprika)\b/, '🧂'],
  [/\b(honey|jam|syrup)\b/, '🍯'],
  [/\b(peas|frozen veg|vegetables)\b/, '🫛'],
];

const LOCATION_EMOJI: Record<PantryItemLocation, string> = { Pantry: '🫙', Fridge: '🥡', Freezer: '🧊' };

/** A food emoji for a pantry tile, from the item name, falling back to its shelf. */
export function pantryEmoji(name: string, location: PantryItemLocation): string {
  const key = name.toLowerCase();
  for (const [pattern, emoji] of EMOJI_RULES) {
    if (pattern.test(key)) return emoji;
  }
  return LOCATION_EMOJI[location] ?? '🫙';
}

/**
 * Pantry item ids a recipe uses. The model returns free-text ingredient lines
 * ("2 cups jasmine rice"), so an item matches when its whole name, or the last
 * word of three or more letters in it, appears in one ingredient line.
 */
export function matchRecipeIngredients(
  usedIngredients: readonly string[],
  items: readonly Pick<PantryItem, 'id' | 'name'>[],
): string[] {
  const lines = usedIngredients.map((line) => ` ${line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `);
  const matched: string[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!name) continue;
    // The last word is usually the food itself ("jasmine rice" -> rice, "frozen berries" -> berries).
    const head = name.split(' ').filter((word) => word.length >= 3).at(-1);
    const hit = lines.some((line) => line.includes(` ${name} `)
      || (head !== undefined && (line.includes(` ${head} `) || line.includes(` ${head}s `))));
    if (hit) matched.push(item.id);
  }
  return matched;
}

/** Finds a barcode-library product photo for a pantry item by exact (case-insensitive) name. */
export function productPhotoForName(name: string, library: readonly { name: string; imageUrl?: string }[]): string | undefined {
  const key = itemNameKey(name);
  return library.find((product) => product.imageUrl && itemNameKey(product.name) === key)?.imageUrl || undefined;
}
