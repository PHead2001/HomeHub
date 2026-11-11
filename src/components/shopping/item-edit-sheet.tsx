'use client';

import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2, Minus, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import {
  MAX_EDIT_QUANTITY as MAX_QUANTITY,
  MAX_ITEM_NAME as MAX_NAME,
  CLOSED_EDIT,
  nextEditOpening,
  planItemEdit,
  saveMayComplete,
  settleItemSave,
  type ItemEditChanges,
  type ItemEditDraft,
  type ItemSaveResult,
} from '@/lib/shopping/edit';
import { saveStateLabel, type SaveState } from '@/lib/shopping/save-status';
import type { ShoppingListCategory, ShoppingListItem } from '@/lib/types';

/**
 * The item edit sheet (SH-8a/b): name, quantity −/+ and category, then Save; Delete
 * lives here (SH-13b). It opens from a row's Edit control or a long-press. It
 * follows the live item (if it disappears meanwhile, deleted elsewhere, the owner
 * closes it), but Save writes only the fields the member changed from what the
 * sheet showed when it opened, so someone else's change to another field is kept.
 * Each open is a session: a slow save's completion closes only its own session, and
 * only once the edit is confirmed or verified on this device, and nothing was typed
 * while it waited (`settleItemSave`). Until then the draft stays, with a status
 * line ("Still sending…", or "Not saved" after a rejection). Every control is at least 44 px (48 px on touch, D-2); the
 * close button is this sheet's own, since the dialog's built-in one is smaller.
 */
export function ItemEditSheet({
  item,
  categories,
  canEdit,
  canDelete,
  onOpenChange,
  onSave,
  onDelete,
  onCloseAutoFocus,
}: {
  item: ShoppingListItem | null;
  categories: ShoppingListCategory[];
  canEdit: boolean;
  canDelete: boolean;
  onOpenChange: (open: boolean) => void;
  /** Writes the changes; reports the save's state when the wait ended and its final answer. */
  onSave: (item: ShoppingListItem, changes: ItemEditChanges) => Promise<ItemSaveResult>;
  onDelete: (item: ShoppingListItem) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const formId = useId();
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [category, setCategory] = useState('');
  const [error, setError] = useState<{ field: 'name' | 'quantity'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [opening, setOpening] = useState(CLOSED_EDIT);

  // Start from the item each time the sheet opens for it (not on every live update,
  // so typing is never overwritten by someone else's change), and keep that opening
  // snapshot as the baseline Save compares to. Adjusted during render, not in an effect.
  const nextOpening = nextEditOpening(opening, item);
  if (nextOpening !== opening) {
    setOpening(nextOpening);
    if (item) {
      setName(item.name);
      setQuantity(String(item.quantity));
      setCategory(item.category);
      setError(null);
      setSaving(false);
      setSaveNote(null);
    }
  }
  // The committed opening and draft, for a save that completes later.
  const openingRef = useRef(opening);
  const draft: ItemEditDraft = { name, quantity, category };
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    openingRef.current = opening;
    draftRef.current = draft;
  });

  const quantityNumber = Number(quantity);
  const step = (amount: number) => {
    const current = Number.isFinite(quantityNumber) ? quantityNumber : 1;
    setQuantity(String(Math.min(MAX_QUANTITY, Math.max(1, Math.round(current) + amount))));
    if (error?.field === 'quantity') setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!item || !canEdit || saving) return;
    if (!opening.baseline) return;
    const plan = planItemEdit(opening.baseline, { name, quantity: quantityNumber, category });
    if ('error' in plan) {
      setError(plan.error);
      return;
    }
    if (Object.keys(plan.changes).length === 0) {
      onOpenChange(false);
      return;
    }
    const session = opening.session;
    const baseline = opening.baseline;
    const submitted = draft;
    setSaving(true);
    setSaveNote(null);
    const result = await onSave(item, plan.changes);
    // Acts on a state of this save. Closed (or reopened, perhaps for another item)
    // while saving: that later sheet is not this save's to close or to update.
    const apply = (state: SaveState) => {
      if (!saveMayComplete(session, openingRef.current)) return 'gone' as const;
      const outcome = settleItemSave(baseline, plan.changes, submitted, draftRef.current, state);
      if (outcome.kind === 'pending') {
        // Not confirmed, and not known to survive a reload: keep the draft and wait.
        setSaveNote(saveStateLabel(state));
        return outcome.kind;
      }
      setSaving(false);
      if (outcome.kind === 'close') {
        onOpenChange(false);
      } else if (outcome.kind === 'failed') {
        setSaveNote('Not saved. Your changes are still here; Save to try again.');
      } else {
        // Input typed while the save waited stays in the sheet; the saved values
        // become the baseline, so the next Save writes only that newer change.
        setSaveNote(null);
        setOpening((current) => (current.session === session ? { ...current, baseline: outcome.baseline } : current));
      }
      return outcome.kind;
    };
    if (apply(result.state) === 'pending') apply(await result.settled);
  };

  const categoryOptions = item && item.category && !categories.includes(item.category) ? [...categories, item.category] : categories;
  const touch = 'h-11 [@media(pointer:coarse)]:h-12';
  const iconTouch = 'h-11 w-11 shrink-0 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12';

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent phoneSheet hideClose onCloseAutoFocus={onCloseAutoFocus} data-testid="item-edit-sheet">
        <DialogHeader className="pr-12">
          <DialogTitle className="font-headline">Edit {item?.name}</DialogTitle>
          <DialogDescription>Change the name, quantity or category. Delete removes it for everyone, with 10 seconds to undo.</DialogDescription>
        </DialogHeader>
        <form id={formId} onSubmit={(event) => void submit(event)} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-name`}>Item name</Label>
            <Input
              value={name}
              maxLength={MAX_NAME}
              disabled={!canEdit}
              onChange={(event) => { setName(event.target.value); if (error?.field === 'name') setError(null); }}
              className={touch}
              {...fieldErrorProps(`${formId}-name`, error?.field === 'name' ? error.message : null)}
            />
            <FieldError id={`${formId}-name`}>{error?.field === 'name' ? error.message : null}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-quantity`}>Quantity</Label>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="icon" aria-label="Decrease quantity" className={iconTouch} disabled={!canEdit || quantityNumber <= 1} onClick={() => step(-1)}>
                <Minus className="h-4 w-4" aria-hidden />
              </Button>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_QUANTITY}
                value={quantity}
                disabled={!canEdit}
                onChange={(event) => { setQuantity(event.target.value); if (error?.field === 'quantity') setError(null); }}
                className={`${touch} text-center`}
                {...fieldErrorProps(`${formId}-quantity`, error?.field === 'quantity' ? error.message : null)}
              />
              <Button type="button" variant="outline" size="icon" aria-label="Increase quantity" className={iconTouch} disabled={!canEdit || quantityNumber >= MAX_QUANTITY} onClick={() => step(1)}>
                <Plus className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <FieldError id={`${formId}-quantity`}>{error?.field === 'quantity' ? error.message : null}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-category`}>Category</Label>
            <Select value={category || undefined} onValueChange={setCategory} disabled={!canEdit}>
              <SelectTrigger id={`${formId}-category`} className={touch}><SelectValue placeholder="Choose a category" /></SelectTrigger>
              <SelectContent>
                {categoryOptions.map((option) => (
                  <SelectItem key={option} value={option}>{option}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </form>
        <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground" data-testid="item-edit-status">{saveNote}</p>
        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          {canDelete && item ? (
            <Button type="button" variant="outline" className={`${touch} text-destructive hover:text-destructive`} onClick={() => onDelete(item)}>
              <Trash2 className="mr-2 h-4 w-4" aria-hidden /> Delete
            </Button>
          ) : <span />}
          {canEdit && (
            <Button type="submit" form={formId} className={touch} disabled={saving}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              Save
            </Button>
          )}
        </DialogFooter>
        {/* Last in the tab order, so the dialog opens with focus in the name field. */}
        <DialogClose asChild>
          <Button variant="ghost" size="icon" aria-label="Close" className={`absolute right-2 top-2 ${iconTouch}`}>
            <X className="h-5 w-5" aria-hidden />
          </Button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
