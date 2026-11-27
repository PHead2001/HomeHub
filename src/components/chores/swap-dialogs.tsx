'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { ArrowLeftRight, Loader2 } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { db } from '@/lib/firebase';
import { choreDueKey, dayFromKey, type ChoreRecord } from '@/lib/chores/dates';
import { readSwapOffer, type SwapOffer } from '@/lib/chores/swap';
import type { HouseholdPerson } from '@/lib/member-directory';
import { memberName } from './assignee-select';

const dayLabel = (chore: ChoreRecord) => {
  const day = choreDueKey(chore);
  return day ? format(dayFromKey(day), 'EEE, MMM d') : 'No date';
};

/** CH-31: offer one of your chores for a housemate's; they get a notification. */
export function OfferSwapDialog({ chore, targets, usersByUid, onClose, onOffer }: {
  chore: ChoreRecord | null;
  targets: readonly ChoreRecord[];
  usersByUid: Map<string, HouseholdPerson>;
  onClose: () => void;
  onOffer: (mine: ChoreRecord, theirs: ChoreRecord) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [openFor, setOpenFor] = useState<string | null>(null);
  if ((chore?.id ?? null) !== openFor) {
    setOpenFor(chore?.id ?? null);
    setPicked('');
  }
  const send = async () => {
    const theirs = targets.find(target => target.id === picked);
    if (!chore || !theirs) return;
    setBusy(true);
    try {
      if (await onOffer(chore, theirs)) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={chore !== null} onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Offer a swap</DialogTitle>
          <DialogDescription>{chore ? `Pick a chore to do instead of ${chore.task}. They get a notification and can say yes or no.` : null}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody else has an open chore to swap right now.</p>
          ) : (
            <RadioGroup aria-label="Chore to do instead" value={picked} onValueChange={setPicked} className="space-y-2">
              {targets.map(target => {
                const person = target.assignedToUid ? usersByUid.get(target.assignedToUid) : undefined;
                return (
                  <Label key={target.id} htmlFor={`swap-${target.id}`} className="flex min-h-[var(--target-min)] cursor-pointer items-center gap-3 rounded-md border p-3 font-normal has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                    <RadioGroupItem value={target.id} id={`swap-${target.id}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{target.task}</span>
                      <span className="text-xs text-muted-foreground">{person ? memberName(person) : 'Someone'} · {dayLabel(target)}</span>
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void send()} disabled={busy || !picked}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowLeftRight className="mr-2 h-4 w-4" />}Offer swap</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** CH-31: the deep link of a swap notification (`/chores?swap=<offerId>`) opens this. */
export function SwapAnswerDialog({ householdId, offerId, currentUid, onClose, onAnswer }: {
  householdId: string;
  offerId: string | null;
  currentUid: string;
  onClose: () => void;
  onAnswer: (offerId: string, answer: 'accept' | 'decline' | 'cancel') => Promise<boolean>;
}) {
  const [offer, setOffer] = useState<SwapOffer | null | 'missing'>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!offerId) return;
    let live = true;
    getDoc(doc(db, 'households', householdId, 'chore-swaps', offerId))
      .then(snap => { if (live) setOffer(snap.exists() ? readSwapOffer(snap.data()) ?? 'missing' : 'missing'); })
      .catch(() => { if (live) setOffer('missing'); });
    return () => { live = false; setOffer(null); };
  }, [householdId, offerId]);
  const answer = async (value: 'accept' | 'decline' | 'cancel') => {
    if (!offerId) return;
    setBusy(true);
    try {
      if (await onAnswer(offerId, value)) onClose();
    } finally {
      setBusy(false);
    }
  };
  const details = offer && offer !== 'missing' ? offer : null;
  const forMe = details?.toUid === currentUid;
  const mine = details?.fromUid === currentUid;
  return (
    <Dialog open={offerId !== null} onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Chore swap</DialogTitle>
          <DialogDescription>
            {offer === null ? 'Loading…'
              : offer === 'missing' ? 'This swap is gone, or it is not for you.'
                : forMe ? `${details!.fromName || 'Someone'} does ${details!.toTask} if you do ${details!.fromTask}.`
                  : `You offered ${details!.fromTask} for ${details!.toTask} (${details!.toName || 'them'}).`}
          </DialogDescription>
        </DialogHeader>
        {details && details.status !== 'pending' && <p className="text-sm text-muted-foreground">This swap was {details.status}.</p>}
        <DialogFooter className="gap-2">
          {details?.status === 'pending' && forMe && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void answer('decline')}>No thanks</Button>
              <Button disabled={busy} onClick={() => void answer('accept')}>Swap</Button>
            </>
          )}
          {details?.status === 'pending' && mine && <Button variant="outline" disabled={busy} onClick={() => void answer('cancel')}>Withdraw offer</Button>}
          {!(details?.status === 'pending' && (forMe || mine)) && <Button variant="outline" onClick={onClose}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
