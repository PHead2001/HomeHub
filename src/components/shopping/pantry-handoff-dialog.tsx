'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PantryItemLocation, ShoppingListItem } from '@/lib/types';
import { PANTRY_LOCATIONS, pantryLocationForCategory, type PantryHandoffChoice } from '@/lib/shopping/pantry';
import { pluralize } from '@/lib/shopping/items';

type Row = { item: ShoppingListItem; include: boolean; location: PantryItemLocation };

/**
 * Batch "Add to pantry" for purchased Grocery items (replaces the old forced
 * per-item pantry form). Every item starts ticked with a shelf guessed from its
 * shopping category (Dairy -> Fridge, Frozen -> Freezer); the member can untick
 * items or change shelves, then confirms once.
 */
export function PantryHandoffDialog({
  open,
  onOpenChange,
  items,
  confirmLabel = 'Add to pantry',
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ShoppingListItem[];
  confirmLabel?: string;
  /**
   * Resolves true when the pantry was updated (the dialog then closes). `shownIds`
   * are every item listed in the dialog, ticked or not.
   */
  onConfirm: (choices: PantryHandoffChoice[], shownIds: string[]) => Promise<boolean>;
}) {
  // Mounted when opened, so the rows start from the items at that moment.
  const [rows, setRows] = useState<Row[]>(() => [...items]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => ({ item, include: true, location: pantryLocationForCategory(item.category) })));
  const [saving, setSaving] = useState(false);

  const chosen = rows.filter((row) => row.include);

  const confirm = async () => {
    if (chosen.length === 0 || saving) return;
    setSaving(true);
    try {
      const ok = await onConfirm(chosen.map(({ item, location }) => ({ itemId: item.id, item, location })), rows.map(({ item }) => item.id));
      if (ok) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-headline">Add to pantry</DialogTitle>
          <DialogDescription>Choose what goes on the shelves. Quantities add to anything already there.</DialogDescription>
        </DialogHeader>
        <ul className="max-h-[50vh] space-y-1 overflow-y-auto py-1">
          {rows.map((row, index) => {
            const id = `pantry-handoff-${row.item.id}`;
            return (
              <li key={row.item.id} className="flex items-center gap-3 rounded-md p-2 hover:bg-secondary">
                <Checkbox
                  id={id}
                  checked={row.include}
                  onCheckedChange={(checked) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, include: Boolean(checked) } : r)))}
                />
                <label htmlFor={id} className="min-w-0 flex-1 break-words text-sm font-medium">
                  {row.item.name} <span className="text-muted-foreground">(x{row.item.quantity})</span>
                </label>
                <Select
                  value={row.location}
                  disabled={!row.include}
                  onValueChange={(value) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, location: value as PantryItemLocation } : r)))}
                >
                  <SelectTrigger className="h-8 w-28 shrink-0" aria-label={`Shelf for ${row.item.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PANTRY_LOCATIONS.map((location) => (
                      <SelectItem key={location} value={location}>{location}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            );
          })}
        </ul>
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => void confirm()} disabled={chosen.length === 0 || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {confirmLabel} ({pluralize(chosen.length, 'item')})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
