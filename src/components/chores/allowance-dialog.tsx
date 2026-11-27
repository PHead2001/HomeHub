'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError } from '@/components/field-error';
import { formatPayout } from '@/lib/chores/stats';
import { parseCentsPerPoint } from '@/lib/chores/allowance';
import { MAX_CENTS_PER_POINT } from '../../../functions/src/shared/chore-points';

/**
 * Allowance from points (CH-29): owners and admins set how many cents one point is
 * worth (0 turns it off). The weekly podium then shows each person's payout for
 * the week that closed, at the rate upkeep recorded when it closed.
 */
export function AllowanceDialog({
  open,
  onOpenChange,
  centsPerPoint,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  centsPerPoint: number;
  onSave: (cents: number) => Promise<void>;
}) {
  const [value, setValue] = useState(String(centsPerPoint));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValue(String(centsPerPoint));
      setError(undefined);
      setSaving(false);
    }
  }

  const parsed = parseCentsPerPoint(value);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (parsed === null) {
      setError(`Enter whole cents from 0 to ${MAX_CENTS_PER_POINT}.`);
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
      onOpenChange(false);
    } catch {
      setError("Couldn't save the rate. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allowance</DialogTitle>
          <DialogDescription>Turn points into pocket money. Each Monday the podium shows what everyone earned last week.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-2">
          <Label htmlFor="allowance-cents">Cents per point</Label>
          <Input
            id="allowance-cents"
            inputMode="numeric"
            value={value}
            onChange={event => { setValue(event.target.value); setError(undefined); }}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? 'allowance-cents-error' : 'allowance-cents-hint'}
          />
          <FieldError id="allowance-cents">{error}</FieldError>
          <p id="allowance-cents-hint" className="text-sm text-muted-foreground" data-testid="allowance-preview">
            {parsed === null ? ' ' : parsed === 0 ? 'Off: no payouts are shown.' : `100 points pay ${formatPayout(parsed * 100)}.`}
          </p>
          <DialogFooter className="pt-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
