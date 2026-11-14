'use client';

// "Who's here?" (WT-8a/b/e, WT-21a): one prompt for every action credited to a person.
// Large faces of the active owners, admins, members and children of the household, kid
// profiles included; never guests, pending or removed people, or the tablet itself
// (the live roster, `rosterFrom`). The choice is attribution, not proof: the server
// re-checks the person on every action.

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { deviceRefusalResponse } from '@/lib/devices/action-policy';
import { initialsOf, isOwnerOrAdmin, type RosterPerson } from '@/lib/devices/roster';
import { cn } from '@/lib/utils';

export function PersonFace({ person, size = 'lg' }: { person: RosterPerson; size?: 'lg' | 'md' }) {
  const box = size === 'lg' ? 'h-20 w-20 text-2xl' : 'h-14 w-14 text-lg';
  return person.avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- Storage download URLs, sized here.
    <img src={person.avatarUrl} alt="" className={cn(box, 'rounded-full object-cover')} />
  ) : (
    <span aria-hidden className={cn(box, 'inline-flex items-center justify-center rounded-full bg-primary/15 font-headline font-bold text-primary')}>
      {initialsOf(person.name)}
    </span>
  );
}

export function WhoIsHereDialog({
  purpose,
  title,
  people,
  onPick,
}: {
  purpose: 'admin' | 'action';
  title: string;
  people: RosterPerson[];
  onPick: (person: RosterPerson | null) => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const adminNeeded = deviceRefusalResponse('admin_pin_required');
  const pick = (person: RosterPerson) => {
    if (purpose === 'admin' && !isOwnerOrAdmin(person)) {
      setNote(adminNeeded.kind === 'message' ? adminNeeded.message : 'An owner or admin PIN is needed.');
      return;
    }
    onPick(person);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onPick(null); }}>
      <DialogContent className="max-w-3xl" data-testid="who-is-here">
        <DialogHeader>
          <DialogTitle className="font-headline text-2xl">Who&apos;s here?</DialogTitle>
          <DialogDescription>
            {title}
            {purpose === 'admin' ? ' An owner or admin PIN is needed.' : ''}
          </DialogDescription>
        </DialogHeader>
        {people.length === 0 ? (
          <p className="text-muted-foreground">Nobody in this household can act here yet.</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3">
            {people.map((person) => (
              <li key={person.uid}>
                <button
                  type="button"
                  onClick={() => pick(person)}
                  className="flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-card p-3 text-center"
                  data-testid={`who-person-${person.uid}`}
                >
                  <PersonFace person={person} />
                  <span className="text-base font-semibold">{person.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {person.kind === 'identity' ? 'Kid profile' : person.role === 'owner' ? 'Owner' : person.role === 'admin' ? 'Admin' : person.role === 'child' ? 'Child' : 'Member'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div role="status" aria-live="polite" className="min-h-6 text-sm font-medium text-destructive" data-testid="who-note">{note}</div>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" className="min-h-12 px-6" onClick={() => onPick(null)}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
