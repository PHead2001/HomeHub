/**
 * Recipe helpers (SH-31a, SH-22c/d, SH-31b): pure, no Firebase imports, so the
 * AI task (server) and the recipe dialog (client) share them and they are unit
 * tested directly (tests/unit/pantry-recipe.test.ts).
 *
 * The model is untrusted. Its ingredient lists are normalised against the stock
 * HomeHub sent (`normalizeRecipeIngredients`): a "from your pantry" entry must
 * name a supplied item exactly (case and spacing aside), anything else is a
 * missing ingredient, and amounts the member has are shown from HomeHub's own
 * data, never from the model's text.
 */
import { itemNameKey } from './items';
import type { SaveState } from './save-status';

/** Longest pantry or shopping name the recipe flow accepts (the pantry's own limit). */
export const RECIPE_NAME_MAX = 120;
export const RECIPE_LINE_MAX = 200;
export const RECIPE_USED_MAX = 60;
export const RECIPE_NEEDED_MAX = 30;

/** An ingredient the recipe takes from the pantry: `pantryItem` is a supplied item's exact name. */
export type RecipeUsedIngredient = { pantryItem: string; line: string };
/** An ingredient the household does not have: `name` is what goes on the shopping list. */
export type RecipeNeededIngredient = { name: string; line: string };
export type RecipeIngredients = { used: RecipeUsedIngredient[]; needed: RecipeNeededIngredient[] };

/** Whitespace collapsed and cut to `max` characters without splitting a surrogate pair. */
export function cleanRecipeText(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return Array.from(collapsed).slice(0, max).join('').trim();
}

/**
 * Checks the model's ingredient lists against the supplied stock:
 * - a used entry whose `pantryItem` is not a supplied item is moved to needed
 *   (the household does not have it as usable stock);
 * - a needed entry that names a supplied item exactly is moved to used;
 * - names are cleaned, entries without a name or line are dropped, each name is
 *   kept once (used first), and the lists are capped (60 used, 30 needed).
 * The used entry's `pantryItem` becomes HomeHub's own spelling of the name.
 */
export function normalizeRecipeIngredients(
  ingredients: { used: readonly RecipeUsedIngredient[]; needed: readonly RecipeNeededIngredient[] },
  stock: readonly { name: string }[],
): RecipeIngredients {
  const stockNames = new Map<string, string>();
  for (const item of stock) {
    const key = itemNameKey(item.name);
    if (key && !stockNames.has(key)) stockNames.set(key, item.name);
  }
  const used: RecipeUsedIngredient[] = [];
  const needed: RecipeNeededIngredient[] = [];
  const seen = new Set<string>();
  const place = (rawName: string, rawLine: string) => {
    const name = cleanRecipeText(rawName, RECIPE_NAME_MAX);
    const key = itemNameKey(name);
    const line = cleanRecipeText(rawLine, RECIPE_LINE_MAX) || name;
    if (!key || seen.has(key)) return;
    const pantryName = stockNames.get(key);
    if (pantryName !== undefined) {
      if (used.length >= RECIPE_USED_MAX) return;
      used.push({ pantryItem: pantryName, line });
    } else {
      if (needed.length >= RECIPE_NEEDED_MAX) return;
      needed.push({ name, line });
    }
    seen.add(key);
  };
  // Pantry claims first, so a name in both lists counts as used when it is in stock.
  for (const entry of ingredients.used) place(entry.pantryItem, entry.line);
  for (const entry of ingredients.needed) place(entry.name, entry.line);
  return { used, needed };
}

/** Keys of the products a recipe uses: every shelf's tile of each used name (exact name match). */
export function recipeProductKeys(
  used: readonly RecipeUsedIngredient[],
  products: readonly { key: string; nameKey: string }[],
): string[] {
  const names = new Set(used.map((entry) => itemNameKey(entry.pantryItem)));
  return products.filter((product) => names.has(product.nameKey)).map((product) => product.key);
}

// --- Missing ingredients onto the Grocery list (SH-22c/d, SH-31b) ------------

/** Per-ingredient state in the recipe card: nothing yet, saving, or the write's honest outcome. */
export type MissingAddState = 'idle' | 'saving' | SaveState;

/** True once an ingredient needs no further add from this recipe (it reached or is reaching the list). */
export const isMissingAdded = (state: MissingAddState | undefined) =>
  state === 'saved' || state === 'stored-locally' || state === 'sending' || state === 'uncertain';

/**
 * The names "Add all missing" writes: every missing ingredient not already added
 * or being added from this recipe, each name once (by name key). A failed one is
 * tried again.
 */
export function planMissingAdds(
  needed: readonly RecipeNeededIngredient[],
  states: Readonly<Record<string, MissingAddState | undefined>>,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of needed) {
    const key = itemNameKey(entry.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const state = states[key];
    if (state === 'saving' || isMissingAdded(state)) continue;
    names.push(entry.name);
  }
  return names;
}

/**
 * Add states per destination list (by list id), each keyed by ingredient name
 * key: an ingredient added to one Grocery list is still missing from another,
 * so each list shows, and "Add all missing" plans from, its own states only.
 */
export type MissingAddStates = Readonly<Record<string, Readonly<Record<string, MissingAddState>>>>;

const NO_STATES: Readonly<Record<string, MissingAddState>> = Object.freeze({});

/** The ingredient states on one destination list (empty when nothing was added there). */
export function missingAddStatesOn(states: MissingAddStates, listKey: string): Readonly<Record<string, MissingAddState>> {
  return states[listKey] ?? NO_STATES;
}

/** `states` with one ingredient's state on one destination list replaced; other lists are untouched. */
export function withMissingAddState(states: MissingAddStates, listKey: string, name: string, state: MissingAddState): MissingAddStates {
  return { ...states, [listKey]: { ...missingAddStatesOn(states, listKey), [itemNameKey(name)]: state } };
}

export type MissingAddResult = {
  /** The ingredient's name as asked. */
  name: string;
  state: SaveState;
  /** It raised an item already needed on the list instead of adding a second one. */
  merged: boolean;
};

export type MissingAddsSummary = { title: string; description: string; failed: boolean };

const joinNames = (names: readonly string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * The one toast after "Add all missing": how many reached the list (and how
 * many of those raised an item already needed there), what is saved on this
 * device or still sending, and which failed, by name.
 */
export function summarizeMissingAdds(results: readonly MissingAddResult[], listName: string): MissingAddsSummary {
  const saved = results.filter((result) => result.state === 'saved');
  const merged = saved.filter((result) => result.merged);
  const local = results.filter((result) => result.state === 'stored-locally');
  const pending = results.filter((result) => result.state === 'sending' || result.state === 'uncertain');
  const failed = results.filter((result) => result.state === 'failed');
  const parts: string[] = [];
  if (saved.length > 0) {
    const count = saved.length === 1 ? '1 ingredient is' : `${saved.length} ingredients are`;
    parts.push(merged.length > 0
      ? `${count} on ${listName} (${joinNames(merged.map((result) => result.name))} already needed, now one more).`
      : `${count} on ${listName}.`);
  }
  if (local.length > 0) parts.push(`${joinNames(local.map((result) => result.name))} saved on this device; will sync when the connection is back.`);
  if (pending.length > 0) parts.push(`${joinNames(pending.map((result) => result.name))} not confirmed yet; an error shows here if it fails.`);
  if (failed.length > 0) parts.push(`Could not add ${joinNames(failed.map((result) => result.name))}. Try again.`);
  const title = failed.length === results.length
    ? 'Could not add the missing ingredients'
    : failed.length > 0
      ? 'Some ingredients were not added'
      : saved.length === results.length
        ? 'Missing ingredients added'
        : local.length > 0
          ? 'Saved, will sync'
          : 'Still sending…';
  return { title, description: parts.join(' '), failed: failed.length > 0 };
}
