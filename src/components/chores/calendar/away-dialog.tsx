'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Plane } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { addDaysToKey, dayFromKey, isDayKey } from '@/lib/chores/dates';

// "We're away" (audit CA-27): pick the days and every repeating chore on them (planned
// or already on the chart, still open) is skipped, with Undo. Built on the skip mechanism
// of CH-3; members with chores.delete only (the rules' skip permission).

export function AwayDialog({ today, count, onSkip }: {
  today: string;
  /** How many repeating chores fall on `[from, to]`. */
  count: (from: string, to: string) => number;
  onSkip: (from: string, to: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDaysToKey(today, 3));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = isDayKey(from) && isDayKey(to) && from >= today && to >= from;
  const n = valid ? count(from, to) : 0;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isDayKey(from) || !isDayKey(to)) return setError('Pick both days.');
    if (from < today) return setError('Pick today or a later day.');
    if (to < from) return setError('The last day is before the first.');
    if (n === 0) return setError('No repeating chores fall on those days.');
    setBusy(true);
    const done = await onSkip(from, to);
    setBusy(false);
    if (done) setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) { setFrom(today); setTo(addDaysToKey(today, 3)); setError(''); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-[var(--target-min)]" data-testid="calendar-away">
          <Plane aria-hidden className="mr-2 h-4 w-4" /> We&apos;re away
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>We&apos;re away</DialogTitle>
            <DialogDescription>Skip every repeating chore on these days. One-time chores stay. You can undo it right after.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="away-from">From</Label>
              <Input id="away-from" type="date" min={today} value={from} onChange={(e) => { setFrom(e.target.value); setError(''); }} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="away-to">Until</Label>
              <Input type="date" min={from} value={to} {...fieldErrorProps('away-to', error)} onChange={(e) => { setTo(e.target.value); setError(''); }} />
            </div>
          </div>
          <FieldError id="away-to">{error}</FieldError>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {valid ? `${n} repeating chore${n === 1 ? '' : 's'} from ${format(dayFromKey(from), 'EEE, MMM d')} to ${format(dayFromKey(to), 'EEE, MMM d')}.` : ' '}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-[var(--target-min)]" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" className="min-h-[var(--target-min)]" disabled={busy}>Skip {n > 0 ? n : ''} chore{n === 1 ? '' : 's'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
