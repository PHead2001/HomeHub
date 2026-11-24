'use client';

import * as React from 'react';
import { useRef, useState } from 'react';
import { Gauge, Loader2 } from 'lucide-react';
import { undoVehicleMileage, updateVehicleMileage, type MaintenanceActionResult } from '@/app/maintenance/actions';
import type { MileageResult, UndoResult } from '@/lib/server/maintenance-operations';
import { FieldError } from '@/components/field-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToastAction } from '@/components/ui/toast';
import { useAuth } from '@/hooks/use-auth';
import { useBackCloses } from '@/hooks/use-back-closes';
import { useToast } from '@/hooks/use-toast';
import { mileageFreshness } from '@/lib/maintenance/mileage-freshness';
import { parseMileageInput } from '@/lib/maintenance/mileage-freshness';
import { mileageWarning } from '@/lib/maintenance/operations';
import { undoOfferMs } from '@/lib/maintenance/action-call';
import { cn } from '@/lib/utils';
import type { Vehicle } from '@/lib/types';
import {
  NO_ANSWER_MESSAGE, OFFLINE_MESSAGE, callMaintenanceAction, keptMessage, mileageWarningMessage, newOpId,
} from './maintenance-action-client';

const mi = (value: number) => `${value.toLocaleString('en-US')} mi`;

/**
 * "Last updated N days ago" under a vehicle's odometer (MA-19, MA-6e), with a nudge when it is
 * older than 30 days, unknown, or missing (no mileage: reminders by mileage cannot start).
 */
export function MileageFreshnessNote({ vehicle, today, className }: { vehicle: Pick<Vehicle, 'currentMileage' | 'mileageUpdatedAt'>; today: string; className?: string }) {
  const freshness = mileageFreshness(vehicle, today);
  return (
    <p
      className={cn('text-xs', freshness.state === 'fresh' ? 'text-muted-foreground' : 'font-medium text-foreground', className)}
      data-testid="mileage-freshness"
      data-state={freshness.state}
    >
      {freshness.message}
    </p>
  );
}

/**
 * The quick "Update mileage" action for a vehicle card or detail panel (MA-19): a button that
 * opens a small numeric dialog prefilled with the recorded mileage. A vehicle without mileage
 * gets "Add mileage". Needs `maintenance.edit` (hidden otherwise).
 */
export function UpdateMileageButton({
  vehicle, today, size = 'sm', variant = 'outline', className, showFreshness = false,
}: {
  vehicle: Vehicle;
  today: string;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'secondary' | 'ghost';
  className?: string;
  /** Also show "last updated" under the button. */
  showFreshness?: boolean;
}) {
  const { permissions } = useAuth();
  const [open, setOpen] = useState(false);
  if (!permissions['maintenance.edit']) return showFreshness ? <MileageFreshnessNote vehicle={vehicle} today={today} /> : null;
  const missing = typeof vehicle.currentMileage !== 'number';
  return (
    <div className={cn('space-y-1', className)}>
      <Button type="button" size={size} variant={variant} onClick={(event) => { event.stopPropagation(); setOpen(true); }} aria-label={`${missing ? 'Add mileage' : 'Update mileage'} for ${vehicle.nickname}`}>
        <Gauge aria-hidden className="mr-2 h-4 w-4" />
        {missing ? 'Add mileage' : 'Update mileage'}
      </Button>
      {showFreshness && <MileageFreshnessNote vehicle={vehicle} today={today} />}
      <UpdateMileageDialog vehicle={open ? vehicle : null} today={today} onOpenChange={setOpen} />
    </div>
  );
}

type Held = { opId: string; reading: number; correction: boolean };

/**
 * The Update mileage dialog. A reading at or above the recorded one is saved as the current
 * mileage; a lower one asks first with the correction copy and is then saved as a correction; a
 * jump of more than 20,000 asks once. Saving keeps the dialog open with a spinner until the server
 * answers; offline it says so and keeps the entry. The "Mileage updated" toast offers Undo for 10 s
 * (compare-and-revert on the server). A retry after no answer resends the same op id.
 */
export function UpdateMileageDialog({ vehicle, today, onOpenChange }: { vehicle: Vehicle | null; today: string; onOpenChange: (open: boolean) => void }) {
  const open = Boolean(vehicle);
  const busyRef = useRef(false);
  const close = () => {
    if (busyRef.current) return false;
    onOpenChange(false);
    return true;
  };
  useBackCloses(open, close);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-w-md" phoneSheet data-testid="update-mileage-dialog" onClick={(event) => event.stopPropagation()}>
        {vehicle && <UpdateMileageBody key={vehicle.id} vehicle={vehicle} today={today} busyRef={busyRef} close={close} onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

function UpdateMileageBody({ vehicle, today, busyRef, close, onOpenChange }: {
  vehicle: Vehicle;
  today: string;
  busyRef: React.MutableRefObject<boolean>;
  close: () => boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  // The recorded mileage when the dialog opened (a snapshot arriving meanwhile does not reset it).
  const [current] = useState(() => (typeof vehicle.currentMileage === 'number' ? vehicle.currentMileage : undefined));
  const [input, setInput] = useState(() => (current !== undefined ? String(current) : ''));
  const [error, setError] = useState('');
  const [warning, setWarning] = useState<{ reading: number; kind: 'lower' | 'jump'; message: string } | null>(null);
  const [busy, setBusyState] = useState(false);
  const setBusy = (value: boolean) => { busyRef.current = value; setBusyState(value); };
  const held = useRef<Held | null>(null);

  const undo = async (opId: string) => {
    const householdId = currentUser?.householdId;
    if (!householdId) return;
    const outcome = await callMaintenanceAction<UndoResult>(householdId, context => undoVehicleMileage({ ...context, opId }));
    if (outcome.kind !== 'ok') {
      toast({ variant: 'destructive', title: "Couldn't undo", description: outcome.kind === 'failed' ? outcome.message : outcome.kind === 'offline' ? OFFLINE_MESSAGE : NO_ANSWER_MESSAGE });
    } else if (outcome.data.status === 'undone') {
      toast({ title: 'Mileage update undone', description: keptMessage(outcome.data.kept, 'updated it') || undefined });
    } else if (outcome.data.status === 'expired') {
      toast({ title: "Can't undo", description: 'The time to undo has passed.' });
    }
  };

  const save = async () => {
    if (busy) return;
    const householdId = currentUser?.householdId;
    if (!householdId) return;
    const reading = parseMileageInput(input);
    if (reading === null) {
      setError('Enter the odometer reading as a whole number.');
      return;
    }
    setError('');
    const kind = mileageWarning(reading, current);
    if (kind && current !== undefined && warning?.reading !== reading) {
      setWarning({ reading, kind, message: mileageWarningMessage(kind, current, reading, 'correction') });
      return;
    }
    const correction = kind === 'lower';
    const request: Held = held.current && held.current.reading === reading && held.current.correction === correction
      ? held.current
      : { opId: newOpId(), reading, correction };
    held.current = request;
    setBusy(true);
    try {
      const outcome = await callMaintenanceAction<MileageResult>(householdId, context => updateVehicleMileage({
        ...context,
        mileage: { opId: request.opId, vehicleId: vehicle.id, reading: request.reading, correction: request.correction },
      }) as Promise<MaintenanceActionResult<MileageResult>>);
      if (outcome.kind === 'offline') { setError(OFFLINE_MESSAGE); return; }
      if (outcome.kind === 'no_answer') { setError(`${NO_ANSWER_MESSAGE} Save again to retry.`); return; }
      held.current = null;
      if (outcome.kind === 'failed') { setError(outcome.message); return; }
      const result = outcome.data;
      if (result.status === 'gone') { setError('This vehicle no longer exists.'); return; }
      if (result.status === 'refused') {
        setError(result.reason === 'lower_needs_correction'
          ? 'That is lower than the recorded mileage. Confirm the correction to save it.'
          : 'Enter the odometer reading as a whole number.');
        return;
      }
      onOpenChange(false);
      const title = 'Mileage updated';
      const description = `${vehicle.nickname} is at ${mi(result.currentMileage)}.`;
      // Undo only for what is left of the window, as for completions (undoMs from the server).
      const offer = undoOfferMs(result.undoMs);
      if (offer === null) {
        toast({ title, description });
        return;
      }
      const handle = toast({
        title,
        description,
        duration: offer,
        action: (
          <ToastAction altText={`Undo the mileage update for ${vehicle.nickname}`} onClick={() => { handle.dismiss(); void undo(result.opId); }}>Undo</ToastAction>
        ),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
        <DialogHeader>
          <DialogTitle>{current === undefined ? 'Add mileage' : 'Update mileage'}</DialogTitle>
          <DialogDescription>
            {`${vehicle.nickname}: the odometer reading now${current === undefined ? ', so mileage reminders can start' : ''}.`}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="space-y-1">
            <Label htmlFor="update-mileage-input">Odometer (miles)</Label>
            <Input
              id="update-mileage-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9,]*"
              autoComplete="off"
              value={input}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'update-mileage-error' : undefined}
              onChange={(event) => { setInput(event.target.value); setWarning(null); setError(''); }}
              autoFocus
            />
            <MileageFreshnessNote vehicle={vehicle} today={today} />
          </div>
          {warning && <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm" role="alert">{warning.message}</p>}
          <FieldError id="update-mileage-error">{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => close()}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              {warning ? (warning.kind === 'lower' ? 'Save correction' : 'Save anyway') : 'Save mileage'}
            </Button>
          </DialogFooter>
        </form>
    </>
  );
}
