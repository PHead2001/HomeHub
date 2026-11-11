'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { History, Loader2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { pluralize } from '@/lib/shopping/items';
import { useRecentTrips } from '@/lib/shopping/trip-live';
import { undoableTripId } from '@/lib/shopping/trip-plan';
import { useOnTabDeactivate } from './tab-activity';

/**
 * Receipt history (SH-32c): the household's last ten trips, newest first, with
 * the list, when, who put them away, what went on which shelf and what was
 * cleared. The newest trip can be undone here for 15 minutes (the server's
 * window), also after a reload, by members who can edit, while online. The
 * trips are read only while the dialog is open.
 */
export function TripHistoryButton({
  householdId,
  memberNames,
  currentUid,
  canUndo,
  onUndo,
  open: openProp,
  onOpenChange,
  showTrigger = true,
}: {
  householdId: string;
  memberNames: ReadonlyMap<string, string>;
  currentUid: string | null;
  /** `shopping.edit` and online. */
  canUndo: boolean;
  onUndo: (tripId: string) => Promise<void>;
  /** Controlled open state (the open list's overflow menu opens it, S8b). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Draws the "Trips" button (off when a menu item opens the history instead). */
  showTrigger?: boolean;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => (onOpenChange ? onOpenChange(next) : setOwnOpen(next));
  useOnTabDeactivate(() => setOpen(false));
  return (
    <>
      {showTrigger && (
        <Button variant="outline" onClick={() => setOpen(true)} className="min-h-11 [@media(pointer:coarse)]:min-h-12">
          <History className="mr-2 h-4 w-4" aria-hidden /> Trips
        </Button>
      )}
      {open && (
        <TripHistoryDialog
          householdId={householdId}
          memberNames={memberNames}
          currentUid={currentUid}
          canUndo={canUndo}
          onUndo={onUndo}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function TripHistoryDialog({
  householdId, memberNames, currentUid, canUndo, onUndo, onClose,
}: {
  householdId: string;
  memberNames: ReadonlyMap<string, string>;
  currentUid: string | null;
  canUndo: boolean;
  onUndo: (tripId: string) => Promise<void>;
  onClose: () => void;
}) {
  const trips = useRecentTrips(householdId);
  const [now, setNow] = useState(() => Date.now());
  const [undoing, setUndoing] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const undoable = canUndo ? undoableTripId(trips.value, now) : null;
  const who = (uid: string | null) => (uid && uid === currentUid ? 'You' : (uid && memberNames.get(uid)) || 'Member');

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent phoneSheet className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline">Recent trips</DialogTitle>
          <DialogDescription>What was put away after each trip. The latest trip can be undone for 15 minutes.</DialogDescription>
        </DialogHeader>
        {trips.status === 'loading' ? (
          <p className="py-6 text-center text-sm text-muted-foreground" role="status">Loading trips…</p>
        ) : trips.value.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No trips yet. Finish a Grocery list and put it away to see it here.</p>
        ) : (
          <ol className="max-h-[60vh] space-y-3 overflow-y-auto" aria-label="Recent trips">
            {trips.value.map((trip) => {
              const shelved = trip.items.filter((item) => item.credited).length;
              const cleared = trip.items.filter((item) => item.cleared).length;
              return (
                <li key={trip.id} className="rounded-lg border bg-popover p-3 font-mono text-sm" data-testid={`trip-${trip.id}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold">{trip.listName || 'Shopping list'}</span>
                    <span className="text-xs text-muted-foreground">
                      {trip.appliedAtMs !== null ? format(new Date(trip.appliedAtMs), 'PPp') : 'Saving…'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {who(trip.appliedByUid)} · {pluralize(shelved, 'item')} on the shelves{trip.mode === 'putAwayAndClear' ? ` · ${pluralize(cleared, 'item')} cleared` : ''}
                    {trip.undoneAtMs !== null && ' · Undone'}
                  </p>
                  <ul className="mt-2 space-y-0.5">
                    {trip.items.map((item) => (
                      <li key={item.itemId} className="flex justify-between gap-3">
                        <span className="min-w-0 break-words">{item.name}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          x{item.quantity}{item.location ? ` · ${item.location}` : ''}{item.expiryDate ? ` · ${item.expiryDate}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {undoable === trip.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 min-h-11 [@media(pointer:coarse)]:min-h-12"
                      disabled={undoing !== null}
                      onClick={() => {
                        setUndoing(trip.id);
                        void onUndo(trip.id).finally(() => setUndoing(null));
                      }}
                    >
                      {undoing === trip.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Undo2 className="mr-2 h-4 w-4" aria-hidden />}
                      Undo this trip
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
