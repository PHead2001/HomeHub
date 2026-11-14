'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { loggerName } from '@/lib/pets/care';
import { CORRECTION_FUTURE_MARGIN_MS, checkFeedCorrection } from '@/lib/pets/feed-plan';
import { correctFeedTime, FeedCorrectionError } from '@/lib/pets/feed-operation';
import { isBrowserOffline } from '@/lib/firestore-offline';

const INPUT_FORMAT = "yyyy-MM-dd'T'HH:mm";

const REASONS: Record<FeedCorrectionError['reason'], string> = {
  offline: 'Connect to the internet to change the time, so everyone sees the same feeding.',
  missing: 'This feeding was removed meanwhile.',
  'not-allowed': 'Only whoever logged it can change the time, in the first 10 minutes; after that someone who can delete logs can.',
  future: 'Pick a time that has already passed.',
  unchanged: 'That is already the feeding’s time.',
  invalid: 'Enter a date and time.',
};

export type CorrectableFeeding = {
  id: string;
  date: Date | null;
  loggedByUid?: string;
  loggedAt?: unknown;
};

/**
 * "Change time" for a saved feeding (PE-5e): corrects when the pet ate (the
 * feeding's effective time), for example an entry from a device whose clock ran
 * ahead. The server-recorded time stays as it was, and history shows both. Its
 * author may do this for 10 minutes after logging, members with
 * `pets.deleteLogs` at any time (the rules enforce both). Online only.
 */
export function CorrectFeedTimeDialog({
  petId,
  petName,
  log,
  onOpenChange,
  onCloseAutoFocus,
}: {
  petId: string;
  petName: string;
  log: CorrectableFeeding | null;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { currentUser, permissions, household } = useAuth();
  const { toast, toastError } = useToast();
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [shownFor, setShownFor] = React.useState<string | null>(null);
  const inputId = React.useId();
  // Reset on every opening (state adjusted during render, as the pet dialogs do).
  if ((log?.id ?? null) !== shownFor) {
    setShownFor(log?.id ?? null);
    setValue(log?.date ? format(log.date, INPUT_FORMAT) : '');
    setError(null);
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const householdId = currentUser?.householdId;
    if (!log || !householdId || !currentUser || saving) return;
    const chosen = value ? new Date(value) : new Date(Number.NaN);
    const canDeleteLogs = Boolean(permissions['pets.deleteLogs']);
    // The form is stricter than the rules: no more than a minute ahead of this device.
    const check = checkFeedCorrection({
      log,
      viewerUid: currentUser.uid,
      canDeleteLogs,
      newDate: chosen,
      now: new Date(),
      futureMarginMs: CORRECTION_FUTURE_MARGIN_MS,
    });
    if (!check.ok) {
      setError(REASONS[check.reason]);
      return;
    }
    if (isBrowserOffline()) {
      setError(REASONS.offline);
      return;
    }
    setSaving(true);
    try {
      await correctFeedTime({
        householdId,
        petId,
        logId: log.id,
        date: chosen,
        user: { uid: currentUser.uid, name: loggerName(currentUser) },
        canDeleteLogs,
        timeZone: household?.timeZone ?? null,
      });
      toast({ title: 'Feeding time changed', description: `${petName} was fed ${format(chosen, 'PPP p')}.` });
      onOpenChange(false);
    } catch (saveError) {
      if (saveError instanceof FeedCorrectionError) setError(REASONS[saveError.reason]);
      else toastError(saveError, "Couldn't change the feeding time");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={log !== null} onOpenChange={(open) => { if (!saving) onOpenChange(open); }}>
      <DialogContent className="sm:max-w-[400px]" onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={save} noValidate>
          <DialogHeader>
            <DialogTitle className="break-words">Change feeding time</DialogTitle>
            <DialogDescription className="break-words">
              When {petName} actually ate. The time it was saved stays in the history.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor={inputId}>Fed at</Label>
            <Input
              type="datetime-local"
              value={value}
              max={format(new Date(), INPUT_FORMAT)}
              onChange={(event) => { setValue(event.target.value); setError(null); }}
              {...fieldErrorProps(inputId, error)}
            />
            <FieldError id={inputId}>{error}</FieldError>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Save time
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
