'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import type { HouseholdPerson } from '@/lib/member-directory';
import { MAX_PAUSE_DAYS } from '@/lib/chores/pause';
import { addDaysToKey } from '@/lib/chores/dates';
import { AssigneeSelect } from './assignee-select';

type PauseDialogProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Who can be paused: everyone for members who may delete chores, else only yourself. */
  people: HouseholdPerson[];
  currentUserUid: string;
  today: string;
  onSubmit: (request: { memberUid: string; from: string; to: string; resume: boolean }) => Promise<boolean>;
};

/**
 * "Away or sick" (CH-32): pause someone's repeating chores from one day to another
 * (at most 31 days), or resume them for those days.
 */
export function PauseChoresDialog({ isOpen, onOpenChange, people, currentUserUid, today, onSubmit }: PauseDialogProps) {
  const [memberUid, setMemberUid] = useState(currentUserUid);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setMemberUid(people.some(person => person.uid === currentUserUid) ? currentUserUid : people[0]?.uid ?? '');
      setFrom(today);
      setTo(today);
      setError(null);
    }
  }
  const submit = async (resume: boolean) => {
    if (!from || !to || to < from) return setError('The last day must be on or after the first.');
    if (to < today) return setError('Those days are over.');
    if (addDaysToKey(from, MAX_PAUSE_DAYS - 1) < to) return setError(`Pause at most ${MAX_PAUSE_DAYS} days at a time.`);
    setBusy(true);
    try {
      if (await onSubmit({ memberUid, from, to, resume })) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={isOpen} onOpenChange={open => !busy && onOpenChange(open)}>
      <DialogContent className="flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Away or sick</DialogTitle>
          <DialogDescription>
            Skip someone&apos;s repeating chores on these days. Nothing is missed and no points are lost; one-time chores stay.
          </DialogDescription>
        </DialogHeader>
        <form className="min-h-0 flex-1 space-y-4 overflow-y-auto" onSubmit={event => { event.preventDefault(); void submit(false); }} noValidate>
          <div className="space-y-2">
            <Label htmlFor="pause-member">Who</Label>
            <AssigneeSelect id="pause-member" users={people} value={memberUid} onChange={setMemberUid} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pause-from">First day</Label>
              <Input type="date" {...fieldErrorProps('pause-from', error)} min={today} value={from} onChange={event => { setFrom(event.target.value); setError(null); if (event.target.value > to) setTo(event.target.value); }} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pause-to">Last day</Label>
              <Input type="date" id="pause-to" min={from || today} value={to} onChange={event => { setTo(event.target.value); setError(null); }} />
            </div>
          </div>
          <FieldError id="pause-from">{error}</FieldError>
          <p className="text-xs text-muted-foreground">{from && to ? `${format(new Date(`${from}T12:00:00`), 'EEE, MMM d')} to ${format(new Date(`${to}T12:00:00`), 'EEE, MMM d')}` : null}</p>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => void submit(true)}>Resume these days</Button>
            <Button type="submit" disabled={busy || !memberUid}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Pause chores</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
