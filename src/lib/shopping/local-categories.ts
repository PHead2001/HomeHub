/**
 * Category without a network (QA-6 / SH-16a): a remembered category for the name,
 * else a small keyword map, else `pending` (saved under Other while one batched AI
 * call is asked) or `fallback` (no AI will be asked, e.g. offline). Pure; unit
 * tested in tests/unit/shopping-categories.test.ts.
 */

import { itemNameKey } from './items';

/** Where an item's category came from. Stored as `categorySource` on new items. */
export type CategorySource = 'manual' | 'remembered' | 'local' | 'ai' | 'fallback' | 'pending';
export const CATEGORY_SOURCES: readonly CategorySource[] = ['manual', 'remembered', 'local', 'ai', 'fallback', 'pending'];

/** Sources a late AI answer may still overwrite (never a member's choice or a remembered one). */
export const AI_REPLACEABLE_SOURCES: readonly CategorySource[] = ['pending', 'local'];

/**
 * Keywords per default category. A name matches a keyword when the keyword is one of
 * its words (or a run of up to three words), singular or plural. The keyword nearest
 * the end of the name wins, then the longest: "orange juice" is Drinks, "coconut
 * milk" is Pantry and "ice cream" is Frozen.
 */
const KEYWORDS: Record<string, readonly string[]> = {
  Produce: [
    'apple', 'banana', 'orange', 'lemon', 'lime', 'grape', 'berry', 'strawberry', 'blueberry', 'raspberry',
    'pear', 'peach', 'plum', 'melon', 'watermelon', 'mango', 'pineapple', 'kiwi', 'avocado', 'tomato',
    'potato', 'onion', 'garlic', 'carrot', 'celery', 'lettuce', 'spinach', 'kale', 'cucumber', 'pepper',
    'broccoli', 'cauliflower', 'zucchini', 'mushroom', 'cabbage', 'herb', 'basil', 'cilantro', 'parsley',
    'ginger', 'salad', 'corn', 'squash', 'leek', 'radish', 'beet', 'cherry', 'fruit', 'vegetable', 'veg',
  ],
  Dairy: [
    'milk', 'cheese', 'yogurt', 'yoghurt', 'butter', 'cream', 'egg', 'sour cream', 'cream cheese',
    'cheddar', 'mozzarella', 'parmesan', 'feta', 'cottage cheese', 'half and half', 'creamer', 'kefir',
  ],
  Meat: [
    'chicken', 'beef', 'pork', 'bacon', 'sausage', 'ham', 'turkey', 'lamb', 'steak', 'mince',
    'ground beef', 'salmon', 'shrimp', 'prawn', 'fish', 'cod', 'tilapia', 'deli', 'salami', 'hot dog',
  ],
  Bakery: ['bread', 'bagel', 'bun', 'roll', 'croissant', 'muffin', 'tortilla', 'pita', 'baguette', 'cake', 'donut', 'loaf'],
  Frozen: ['frozen', 'ice cream', 'ice', 'pizza', 'popsicle', 'waffle'],
  Pantry: [
    'rice', 'pasta', 'spaghetti', 'noodle', 'flour', 'sugar', 'salt', 'oil', 'olive oil', 'vinegar', 'cereal',
    'oat', 'oatmeal', 'bean', 'lentil', 'canned', 'soup', 'sauce', 'ketchup', 'mustard', 'mayo',
    'mayonnaise', 'honey', 'jam', 'peanut butter', 'spice', 'coffee', 'tea', 'stock', 'broth', 'coconut milk',
    'baking soda', 'yeast', 'tuna', 'syrup',
  ],
  Snacks: ['chip', 'crisp', 'cracker', 'cookie', 'cookies', 'brownies', 'biscuit', 'chocolate', 'candy', 'popcorn', 'pretzel', 'nut', 'granola bar', 'snack'],
  Drinks: ['water', 'juice', 'soda', 'beer', 'wine', 'sparkling water', 'lemonade', 'cola', 'kombucha', 'drink'],
  Household: [
    'paper towel', 'toilet paper', 'toilet roll', 'tissue', 'detergent', 'soap', 'dish soap', 'sponge', 'trash bag', 'bin bag',
    'foil', 'cling film', 'plastic wrap', 'bleach', 'cleaner', 'shampoo', 'toothpaste', 'battery', 'light bulb',
    'napkin', 'laundry',
  ],
};

const singular = (word: string) => {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (word.endsWith('ches') || word.endsWith('shes') || word.endsWith('sses') || word.endsWith('xes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
};

/** Each word run (up to three words) of the name, with the index of its last word. */
const phrases = (name: string): Map<string, number> => {
  const words = itemNameKey(name).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).map(singular);
  const out = new Map<string, number>();
  for (let size = 1; size <= 3; size += 1) {
    for (let index = 0; index + size <= words.length; index += 1) out.set(words.slice(index, index + size).join(' '), index + size - 1);
  }
  return out;
};

const KEYWORD_INDEX: Array<{ keyword: string; category: string }> = Object.entries(KEYWORDS)
  .flatMap(([category, keywords]) => keywords.map((keyword) => ({ keyword: keyword.split(' ').map(singular).join(' '), category })));

/** The list's own spelling of `category`, or undefined when the list does not have it. */
export function matchListCategory(category: string | undefined | null, categories: readonly string[]): string | undefined {
  if (!category) return undefined;
  const wanted = category.trim().toLowerCase();
  return categories.find((candidate) => candidate.trim().toLowerCase() === wanted);
}

/** Keyword-map category for a name, only if the list has that category. */
export function localCategoryFor(name: string, categories: readonly string[]): string | undefined {
  const found = phrases(name);
  // The keyword nearest the end of the name wins (the head noun: "orange juice" is
  // a drink), then the longest ("coconut milk" over "milk").
  let best: { category: string; end: number; length: number } | undefined;
  for (const { keyword, category } of KEYWORD_INDEX) {
    const end = found.get(keyword);
    if (end === undefined) continue;
    if (!best || end > best.end || (end === best.end && keyword.length > best.length)) best = { category, end, length: keyword.length };
  }
  return best ? matchListCategory(best.category, categories) : undefined;
}

type CategorizedItem = { name: string; category?: string | null; categorySource?: string | null; nameKey?: string | null };

/**
 * Remembered categories by name key, from items already on a list (the open
 * list's live items, or the items a palette/share save read). A category counts
 * only when a person or the AI chose it (`manual`, `remembered`, `ai`), or on a
 * legacy item without `categorySource` that is not `Other`. Later items in the
 * input win.
 */
export function rememberedCategories(items: readonly CategorizedItem[]): Map<string, string> {
  const remembered = new Map<string, string>();
  for (const item of items) {
    const category = item.category?.trim();
    if (!category) continue;
    const source = item.categorySource ?? null;
    const counts = source === null
      ? category.toLowerCase() !== 'other'
      : source === 'manual' || source === 'remembered' || source === 'ai';
    if (!counts) continue;
    remembered.set(item.nameKey || itemNameKey(item.name), category);
  }
  return remembered;
}

/** The category a new item is saved with at once, and where it came from. Pure. */
export function initialCategory({
  name,
  categories,
  selectedCategory,
  remembered,
  aiAvailable,
}: {
  name: string;
  categories: readonly string[];
  selectedCategory?: string;
  remembered?: ReadonlyMap<string, string>;
  /** Whether a batched AI call will be asked for names nothing else knows (online). */
  aiAvailable: boolean;
}): { category: string; categorySource: CategorySource } {
  if (selectedCategory) return { category: selectedCategory, categorySource: 'manual' };
  const fromMemory = matchListCategory(remembered?.get(itemNameKey(name)), categories);
  if (fromMemory) return { category: fromMemory, categorySource: 'remembered' };
  const local = localCategoryFor(name, categories);
  if (local) return { category: local, categorySource: 'local' };
  return { category: matchListCategory('Other', categories) ?? 'Other', categorySource: aiAvailable ? 'pending' : 'fallback' };
}

/**
 * Whether a late AI category may be written onto an item, judged from the item
 * (and its list) as just read inside a transaction (SH-16c). Only when: the active
 * household and list are still the ones the submission was for, the list still
 * exists, the item exists with its name unchanged (same name key), its category
 * was not chosen since (source still `pending` or `local`), and the answer is one
 * of the list's categories. Pure.
 */
export function shouldApplyLateCategory({
  item,
  listExists,
  expectedNameKey,
  aiCategory,
  categories,
  target,
  active,
}: {
  item: CategorizedItem | undefined | null;
  listExists: boolean;
  expectedNameKey: string;
  aiCategory: string;
  categories: readonly string[];
  target: { householdId: string; listId: string };
  active: { householdId: string | null; listId: string | null } | null;
}): boolean {
  if (!active || active.householdId !== target.householdId || active.listId !== target.listId) return false;
  if (!listExists || !item) return false;
  const source = item.categorySource ?? null;
  if (!source || !(AI_REPLACEABLE_SOURCES as readonly string[]).includes(source)) return false;
  if ((item.nameKey || itemNameKey(item.name)) !== expectedNameKey) return false;
  return Boolean(matchListCategory(aiCategory, categories));
}
