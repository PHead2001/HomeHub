/** The item edit sheet's pure logic (S3, SH-8a): what an edit writes. Unit tested in tests/unit/shopping-undo.test.ts. */
import { itemNameKey, normalizeItemName } from './items';
import type { ShoppingListItem } from '@/lib/types';

/** The fields an edit changes (only those that differ from the item). */
export type ItemEditChanges = {
  name?: string;
  nameKey?: string;
  quantity?: number;
  category?: string;
  categorySource?: 'manual';
};

export const MAX_ITEM_NAME = 120;
export const MAX_EDIT_QUANTITY = 999;

/**
 * What an edit writes: only the fields that differ, so another member's change to
 * a field this edit did not touch is kept. A new name gets its `nameKey`; a new
 * category is the member's choice (`categorySource: 'manual'`, so a late AI answer
 * never overrides it). Returns an error message instead when a value is invalid.
 */
export function planItemEdit(
  item: Pick<ShoppingListItem, 'name' | 'quantity' | 'category'>,
  draft: { name: string; quantity: number; category: string },
): { changes: ItemEditChanges } | { error: { field: 'name' | 'quantity'; message: string } } {
  const name = normalizeItemName(draft.name);
  if (!name) return { error: { field: 'name', message: 'Item name is required.' } };
  if (name.length > MAX_ITEM_NAME) return { error: { field: 'name', message: `Keep the name under ${MAX_ITEM_NAME} characters.` } };
  if (!Number.isInteger(draft.quantity) || draft.quantity < 1) return { error: { field: 'quantity', message: 'Quantity must be a whole number, at least 1.' } };
  if (draft.quantity > MAX_EDIT_QUANTITY) return { error: { field: 'quantity', message: `Quantity must be ${MAX_EDIT_QUANTITY} or less.` } };
  const changes: ItemEditChanges = {};
  if (name !== item.name) {
    changes.name = name;
    changes.nameKey = itemNameKey(name);
  }
  if (draft.quantity !== item.quantity) changes.quantity = draft.quantity;
  if (draft.category && draft.category !== item.category) {
    changes.category = draft.category;
    changes.categorySource = 'manual';
  }
  return { changes };
}

/** What the sheet showed when it opened: the baseline an edit is compared to. */
export type ItemEditBaseline = Pick<ShoppingListItem, 'name' | 'quantity' | 'category'>;

/**
 * The opening snapshot of an item (S3 review). Save compares the draft to this,
 * never to the live item: a field the member did not touch is not written, even if
 * someone else changed it while the sheet was open (their change is kept).
 */
export function editBaseline(item: ItemEditBaseline): ItemEditBaseline {
  return { name: item.name, quantity: item.quantity, category: item.category };
}

/** The sheet's current opening: which item, which session, and its baseline. */
export type EditOpening = { itemId: string | null; session: number; baseline: ItemEditBaseline | null };
export const CLOSED_EDIT: EditOpening = { itemId: null, session: 0, baseline: null };

/**
 * Opening sessions of the edit sheet: every open (or reopen) is a new session with
 * its own baseline; live updates of the open item keep it (the same object comes
 * back). Closing is a new session too, so nothing from before stays current.
 */
export function nextEditOpening(previous: EditOpening, item: (ItemEditBaseline & { id: string }) | null): EditOpening {
  const itemId = item?.id ?? null;
  if (itemId === previous.itemId) return previous;
  return { itemId, session: previous.session + 1, baseline: item ? editBaseline(item) : null };
}

/**
 * A save's completion (close the sheet, clear its spinner) acts only while the
 * session that submitted it is still the open one, so a slow save never closes a
 * later sheet opened for another item (or for the same item again).
 */
export function saveMayComplete(submittedSession: number, current: EditOpening): boolean {
  return current.itemId !== null && current.session === submittedSession;
}

/** The sheet's fields as the member typed them (quantity is the raw input text). */
export type ItemEditDraft = { name: string; quantity: string; category: string };

/**
 * What a save's completion does with the sheet (S3 review). The fields stay
 * editable while a save waits, so the member may change something meanwhile:
 * closing then would drop that newer input. So the sheet closes only when the save
 * succeeded and the draft is still the one submitted. If it changed, the sheet
 * stays open with the newer input, and its baseline becomes the values just saved,
 * so the next Save writes only what changed after the submit. A failed save keeps
 * the sheet and its baseline as they were.
 */
export function settleItemSave(
  baseline: ItemEditBaseline,
  changes: ItemEditChanges,
  submitted: ItemEditDraft,
  current: ItemEditDraft,
  saved: boolean,
): { close: true } | { close: false; baseline: ItemEditBaseline } {
  if (!saved) return { close: false, baseline };
  const unchanged = submitted.name === current.name && submitted.quantity === current.quantity && submitted.category === current.category;
  if (unchanged) return { close: true };
  return {
    close: false,
    baseline: {
      name: changes.name ?? baseline.name,
      quantity: changes.quantity ?? baseline.quantity,
      category: changes.category ?? baseline.category,
    },
  };
}
