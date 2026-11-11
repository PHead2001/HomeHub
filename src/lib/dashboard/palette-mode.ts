/**
 * Palette modes (QA-15): the dashboard tile "+" buttons, the N/A/F shortcuts and
 * the phone quick-add fan open the command palette in an explicit mode instead
 * of typing a text prefix into it. Feeding shows the household's pets as buttons
 * (one tap logs, no typing), Item is the shopping add with a list picker, Chore
 * is the chore add. Typed commands keep working; a bare command verb typed into
 * the palette ("fed", "add") offers the matching choices and never becomes an
 * entry (QA-1). Pure: no Firebase or React.
 */
import type { HouseholdPermission } from '@/lib/types';
import {
  bareCommandVerb,
  parseChore,
  splitItems,
  type ChoreIntent,
  type FeedingIntent,
  type QuickAddContext,
  type QuickAddList,
  type QuickAddPet,
  type ShoppingIntent,
} from './quick-add';

export type PaletteMode = 'feeding' | 'item' | 'chore';

/** The permission each mode writes with (the same as the typed quick add and the module screens). */
export const MODE_PERMISSION: Record<PaletteMode, HouseholdPermission> = {
  feeding: 'pets.addLogs',
  item: 'shopping.edit',
  chore: 'chores.create',
};

export const MODE_COPY: Record<PaletteMode, { title: string; denied: string }> = {
  feeding: {
    title: 'Log a feeding',
    denied: "You can't log feedings in this household. A household admin can give you permission to add pet logs.",
  },
  item: {
    title: 'Add a shopping item',
    denied: "You can't add shopping items in this household. A household admin can give you permission to edit shopping lists.",
  },
  chore: {
    title: 'Add a chore',
    denied: "You can't add chores in this household. A household admin can give you permission to create chores.",
  },
};

/** Why the mode cannot be used (shown in place of its controls), or null when it can. */
export function modeBlocker(mode: PaletteMode, permissions: Partial<Record<HouseholdPermission, boolean>>): string | null {
  return permissions[MODE_PERMISSION[mode]] ? null : MODE_COPY[mode].denied;
}

/**
 * What a bare command verb typed into the palette offers (QA-1). Null when the
 * text is more than a verb (the normal parser reads it). Otherwise never a
 * shopping item: "fed"/"feed" offers a feeding for each pet (one pet: just that
 * one; no pets or no permission: nothing), and "add"/"chore" offer to open the
 * Item or Chore mode when the member may use it.
 */
export type BareVerbOffer =
  | { kind: 'feed'; intents: FeedingIntent[] }
  | { kind: 'mode'; mode: Exclude<PaletteMode, 'feeding'> }
  | { kind: 'none' };

export function bareVerbOffer(
  text: string,
  pets: readonly QuickAddPet[],
  allowed: (mode: PaletteMode) => boolean,
): BareVerbOffer | null {
  const verb = bareCommandVerb(text);
  if (!verb) return null;
  if (!allowed(verb)) return { kind: 'none' };
  if (verb === 'feeding') {
    if (pets.length === 0) return { kind: 'none' };
    return { kind: 'feed', intents: pets.map((pet) => ({ kind: 'feeding', pet, amount: null, unit: null })) };
  }
  return { kind: 'mode', mode: verb };
}

/** The lists Item mode offers: the Grocery lists, or every list when there is none; the first is preselected. */
export function itemModeLists(lists: readonly QuickAddList[]): { choices: QuickAddList[]; initial: QuickAddList | null } {
  const grocery = lists.filter((list) => list.type === 'Grocery');
  const choices = grocery.length > 0 ? grocery : [...lists];
  return { choices, initial: choices[0] ?? null };
}

const SHOPPING_VERB = /^(?:please\s+)?(?:add|buy|get|grab|pick up|need|we need|i need|we're out of|out of)\s+/i;

/**
 * The shopping entry Item mode saves: the typed items (commas, "and", counts as
 * in Shopping's own quick add; a leading "add" is dropped) for the chosen list.
 * Null for nothing to add, a bare verb, or no list.
 */
export function itemModeIntent(text: string, list: QuickAddList | null): ShoppingIntent | null {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!list || !trimmed || bareCommandVerb(trimmed)) return null;
  const items = splitItems(trimmed.replace(SHOPPING_VERB, ''));
  if (items.length === 0) return null;
  return { kind: 'shopping', items, list, explicit: true };
}

const CHORE_PREFIX = /^(?:chore|task|todo|to do|remind (?:me|us) to)[:\s]/i;

/**
 * The chore Chore mode previews: the typed text read as a chore ("vacuum Friday
 * for Sam", with its date, repeat, assignee and room), without needing a chore
 * word. Null for nothing typed, a bare verb, or text the chore reader refuses.
 */
export function choreModeIntent(text: string, context: QuickAddContext): ChoreIntent | null {
  const trimmed = text.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  if (!trimmed || bareCommandVerb(trimmed)) return null;
  return parseChore(CHORE_PREFIX.test(trimmed) ? trimmed : `chore ${trimmed}`, context);
}

/** What Feeding mode shows, from the member's permissions and the palette index. */
export type FeedingModeState =
  | { status: 'denied'; message: string }
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'empty'; message: string }
  | { status: 'ready'; pets: QuickAddPet[] };

export function feedingModeState({
  canFeed,
  canViewPets,
  loading,
  failed,
  pets,
}: {
  canFeed: boolean;
  canViewPets: boolean;
  loading: boolean;
  failed: boolean;
  pets: readonly QuickAddPet[];
}): FeedingModeState {
  if (!canFeed) return { status: 'denied', message: MODE_COPY.feeding.denied };
  if (!canViewPets) return { status: 'denied', message: "Pets aren't shared with you, so there is no pet to log a feeding for." };
  if (loading) return { status: 'loading' };
  if (failed) return { status: 'failed', message: "Couldn't load your household's pets." };
  if (pets.length === 0) return { status: 'empty', message: 'No pets yet. Add one on the Pets page.' };
  return { status: 'ready', pets: [...pets] };
}

/** What Item mode shows, from the member's permissions and the palette index. */
export type ItemModeState =
  | { status: 'denied'; message: string }
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'empty'; message: string }
  | { status: 'ready'; choices: QuickAddList[]; initial: QuickAddList | null };

export function itemModeState({
  canAdd,
  canViewLists,
  loading,
  failed,
  lists,
}: {
  canAdd: boolean;
  canViewLists: boolean;
  loading: boolean;
  failed: boolean;
  lists: readonly QuickAddList[];
}): ItemModeState {
  if (!canAdd) return { status: 'denied', message: MODE_COPY.item.denied };
  if (!canViewLists) return { status: 'denied', message: "Shopping lists aren't shared with you, so there is no list to add to." };
  if (loading) return { status: 'loading' };
  if (failed) return { status: 'failed', message: "Couldn't load your shopping lists." };
  if (lists.length === 0) return { status: 'empty', message: 'No shopping list yet. Create one in Shopping first.' };
  return { status: 'ready', ...itemModeLists(lists) };
}
