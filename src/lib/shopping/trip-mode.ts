/**
 * Pure helpers for the open list's trip mode (S8b: SH-12, SH-18, SH-33): the
 * "n left" pill, the aisle chips and the "type to find or add" filter.
 */
import { itemNameKey, parseQuickAdd, type AisleGroup } from './items';

/** The pill in the compact header: "5 left", "All in the cart", or nothing for an empty list. */
export function leftLabel(needed: number, total: number): string | null {
  if (needed > 0) return `${needed} left`;
  return total > 0 ? 'All in the cart' : null;
}

export type AisleChip = { key: string; label: string; count: number; targetId: string };

const slug = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'aisle';

/** The heading id of every aisle group, unique even when two category names slug the same. */
export function aisleTargetIds<T>(groups: readonly AisleGroup<T>[], idPrefix = 'aisle'): string[] {
  const used = new Set<string>();
  return groups.map((group) => {
    const base = `${idPrefix}-${slug(group.category)}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return id;
  });
}

/**
 * One chip per aisle group, in walk order, each pointing at its group's heading
 * (`aisleTargetIds`). No chips for fewer than two groups: there is nowhere to jump.
 */
export function aisleChips<T>(groups: readonly AisleGroup<T>[], idPrefix = 'aisle'): AisleChip[] {
  if (groups.length < 2) return [];
  const ids = aisleTargetIds(groups, idPrefix);
  return groups.map((group, index) => ({ key: ids[index], label: group.category, count: group.items.length, targetId: ids[index] }));
}

/**
 * What the quick-add field's text means for the list (SH-18c): a single typed
 * name filters the needed items (by a case-insensitive "contains" on the name,
 * ignoring a leading or trailing quantity); several comma-separated items, or
 * nothing, do not filter. Enter always adds through the normal save path.
 */
export function findQuery(text: string): string | null {
  if (!text.trim()) return null;
  const entries = parseQuickAdd(text);
  if (entries.length !== 1) return null;
  const key = itemNameKey(entries[0].name);
  return key || null;
}

/** The groups narrowed to items whose name contains `query`; empty groups are dropped. */
export function filterAisleGroups<T extends { name: string }>(groups: readonly AisleGroup<T>[], query: string | null): AisleGroup<T>[] {
  if (!query) return groups as AisleGroup<T>[];
  return groups
    .map((group) => ({ category: group.category, items: group.items.filter((item) => itemNameKey(item.name).includes(query)) }))
    .filter((group) => group.items.length > 0);
}

/** The line under the field while it filters: how many needed items match, and what Enter does. */
export function findHint(query: string | null, matches: number, typed: string): string | null {
  if (!query) return null;
  const name = typed.trim();
  if (matches === 0) return `No needed item matches. Press Enter to add ${name}.`;
  return `${matches === 1 ? '1 needed item matches' : `${matches} needed items match`}. Press Enter to add ${name}.`;
}

/**
 * State that belongs to one opening of one list (the find text, the dialog the
 * actions menu opened): kept while the same list stays open, reset to `empty`
 * whenever the open list changes or closes, so going back to all lists and
 * reopening the same list starts clean.
 */
export type ListScoped<T> = { listId: string | null; value: T };

export function scopeToList<T>(state: ListScoped<T>, listId: string | null, empty: T): ListScoped<T> {
  return state.listId === listId ? state : { listId, value: empty };
}

/**
 * The needed rows' focus order after a tick: the rows on screen, in walk order.
 * With a find filter active that is the narrowed groups, never every needed item
 * (a hidden row cannot take focus).
 */
export function neededFocusOrder<T extends { id: string }>(shownGroups: readonly AisleGroup<T>[]): string[] {
  return shownGroups.flatMap((group) => group.items.map((item) => item.id));
}

/** The accordion's open sections with `section` open too (unchanged, same array, when it already is). */
export function withSectionOpen(open: readonly string[], section: string): string[] {
  return open.includes(section) ? (open as string[]) : [...open, section];
}
