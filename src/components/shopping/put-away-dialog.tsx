'use client';

import { useState } from 'react';
import { Loader2, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PantryItemLocation, ShoppingListItem } from '@/lib/types';
import { PANTRY_LOCATIONS, pantryLocationForCategory } from '@/lib/shopping/pantry';
import { pluralize } from '@/lib/shopping/items';
import { shortExpiryLabel } from '@/lib/shopping/pantry-batches';
import { newOpId } from '@/lib/shopping/undo';
import {
  EXPIRY_PICKS,
  MAX_TRIP_ITEMS,
  expiryForPick,
  pickAfterShelfChange,
  shelfDefaultPick,
  type ExpiryPick,
  type TripChoice,
  type TripMode,
} from '@/lib/shopping/trip-plan';

const NO_IDS: ReadonlySet<string> = new Set();

type Row = {
  item: ShoppingListItem;
  /** Put on a shelf (credited); unticked items are only cleared (or, without clear, left alone). */
  shelve: boolean;
  location: PantryItemLocation;
  pick: ExpiryPick;
  /** The member chose a chip, so a shelf change no longer resets it. */
  picked: boolean;
  /** This purchase is already on the shelves: it is only cleared, never credited again. */
  onShelves: boolean;
};

/**
 * Put away (S5: SH-2a, SH-30, SH-23b): the purchases of a finished trip go on
 * the pantry shelves, and with "Put away & clear" leave the list, as one trip
 * applied by the server (`putAwayAndClear` action). Every item starts ticked
 * with a shelf guessed from its category and that shelf's default expiry
 * (Fridge +1 w, Freezer +3 mo, Pantry no date); +3 d, +1 w, +3 mo and No date
 * chips change it. Dates stay editable afterwards on the pantry.
 *
 * The trip id is made when the dialog opens and kept for every attempt, so
 * pressing the button again after a failure or a lost response never puts the
 * same purchases away twice. Purchases already on the shelves (`shelvedIds`)
 * are shown as such and only cleared. One trip carries at most
 * `MAX_TRIP_ITEMS` purchases (`tripGroup`); the dialog says how many more
 * (`left`) stay on the list for another trip.
 */
export function PutAwayDialog({
  open,
  onOpenChange,
  items,
  shelvedIds = NO_IDS,
  left = 0,
  mode,
  today,
  offline,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ShoppingListItem[];
  /** Items whose purchase is already on the shelves. */
  shelvedIds?: ReadonlySet<string>;
  /** Purchases not in this trip; they stay on the list for another. */
  left?: number;
  mode: TripMode;
  /** Today in the household zone (`yyyy-MM-dd`); the chips count from it. */
  today: string;
  offline: boolean;
  /** Resolves true when the trip was applied (the dialog then closes). */
  onConfirm: (tripId: string, choices: TripChoice[]) => Promise<boolean>;
}) {
  // Mounted when opened, so the rows (and the trip id) start from that moment.
  const [tripId] = useState(() => newOpId());
  const [rows, setRows] = useState<Row[]>(() => [...items]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => {
      const location = pantryLocationForCategory(item.category, item.name);
      const onShelves = shelvedIds.has(item.id);
      return { item, shelve: !onShelves, location, pick: shelfDefaultPick(location), picked: false, onShelves };
    }));
  const [saving, setSaving] = useState(false);
  const shelved = rows.filter((row) => row.shelve).length;
  const clear = mode === 'putAwayAndClear';
  const count = clear ? rows.length : shelved;
  const action = clear ? (shelved > 0 ? 'Put away & clear' : 'Clear') : 'Put away';

  const update = (index: number, change: (row: Row) => Row) => setRows((previous) => previous.map((row, i) => (i === index ? change(row) : row)));

  const confirm = async () => {
    if (count === 0 || saving || offline) return;
    setSaving(true);
    try {
      const choices: TripChoice[] = rows
        .filter((row) => clear || row.shelve)
        .map(({ item, shelve, location, pick }) => ({
          itemId: item.id,
          seen: { name: item.name, quantity: Number(item.quantity), purchaseOpId: item.purchaseOpId ?? null },
          location: shelve ? location : null,
          expiryDate: shelve ? expiryForPick(pick, today) : null,
        }));
      if (await onConfirm(tripId, choices)) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent phoneSheet>
        <DialogHeader>
          <DialogTitle className="font-headline">Put away</DialogTitle>
          <DialogDescription>
            {clear
              ? 'Ticked items go on the shelves and everything here leaves the list. You can change dates later in the pantry.'
              : 'Ticked items go on the shelves and stay on the list as bought. You can change dates later in the pantry.'}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[55vh] space-y-2 overflow-y-auto py-1">
          {rows.map((row, index) => {
            const id = `put-away-${row.item.id}`;
            const expiry = expiryForPick(row.pick, today);
            return (
              <li key={row.item.id} className="rounded-md p-2 hover:bg-secondary" data-testid={`put-away-row-${row.item.id}`}>
                <div className="flex items-center gap-3">
                  <Checkbox
                    id={id}
                    checked={row.shelve}
                    disabled={row.onShelves}
                    onCheckedChange={(checked) => update(index, (r) => ({ ...r, shelve: Boolean(checked) }))}
                  />
                  <label htmlFor={id} className="min-w-0 flex-1 break-words text-sm font-medium">
                    {row.item.name} <span className="text-muted-foreground">(x{row.item.quantity})</span>
                    {row.onShelves && <span className="block text-xs font-normal text-muted-foreground">Already on the shelves</span>}
                  </label>
                  {!row.onShelves && <Select
                    value={row.location}
                    disabled={!row.shelve}
                    onValueChange={(value) => update(index, (r) => {
                      const location = value as PantryItemLocation;
                      return { ...r, location, pick: pickAfterShelfChange(location, r.pick, r.picked) };
                    })}
                  >
                    <SelectTrigger className="h-11 w-28 shrink-0 [@media(pointer:coarse)]:h-12" aria-label={`Shelf for ${row.item.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PANTRY_LOCATIONS.map((location) => (
                        <SelectItem key={location} value={location}>{location}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>}
                </div>
                {row.shelve && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7" role="group" aria-label={`Use by for ${row.item.name}`}>
                    {EXPIRY_PICKS.map((chip) => (
                      <Button
                        key={chip.id}
                        type="button"
                        size="sm"
                        variant={row.pick === chip.id ? 'default' : 'outline'}
                        aria-pressed={row.pick === chip.id}
                        className="h-11 rounded-full px-3 text-xs [@media(pointer:coarse)]:h-12"
                        onClick={() => update(index, (r) => ({ ...r, pick: chip.id, picked: true }))}
                      >
                        {chip.label}
                      </Button>
                    ))}
                    <span className="text-xs text-muted-foreground" data-testid={`put-away-expiry-${row.item.id}`}>
                      {expiry ? `Use by ${shortExpiryLabel(expiry, today)}` : 'No use-by date'}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {left > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="put-away-left">
            {pluralize(left, 'more purchase')} {left === 1 ? 'stays' : 'stay'} on the list for another trip (one trip carries up to {MAX_TRIP_ITEMS}).
          </p>
        )}
        {offline && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <WifiOff className="h-4 w-4 shrink-0" aria-hidden /> You are offline. Putting away needs a connection.
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving} className="min-h-11 [@media(pointer:coarse)]:min-h-12">Cancel</Button>
          <Button onClick={() => void confirm()} disabled={count === 0 || saving || offline} className="min-h-11 [@media(pointer:coarse)]:min-h-12">
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {action} ({pluralize(count, 'item')})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
