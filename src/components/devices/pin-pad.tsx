'use client';

// The tablet's PIN pad (WT-9, D-T11; design 7.4, 8.5). Verifies online only (a PIN is
// never queued, WT-19f) through `verifyDevicePinAction`; the server counts every attempt
// before it hashes and locks a person's PIN on this tablet after five wrong tries (1 min,
// doubling to 15) and on every tablet after twenty in an hour. The typed digits never
// leave this dialog except in that one request, and nothing is stored; the session secret
// the server returns stays in memory.

import { useCallback, useEffect, useState } from 'react';
import { Delete, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { verifyDevicePinAction } from '@/app/devices/actions';
import { auth } from '@/lib/firebase-app';
import { deviceRefusalResponse, type DeviceRefusal } from '@/lib/devices/action-policy';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@/lib/devices/pins';
import type { RosterPerson } from '@/lib/devices/roster';
import { whileBusy } from '@/lib/shell/busy';
import { cn } from '@/lib/utils';
import { useTablet } from './tablet-context';
import { PersonFace } from './who-is-here';

const REVOKED: ReadonlySet<DeviceRefusal> = new Set(['device_revoked', 'unauthenticated', 'wrong_household', 'not_a_device', 'household_deleting']);

/** Copy for a refused PIN (8.5), with how many tries are left before a pause. */
export function pinRefusalMessage(code: DeviceRefusal, person: Pick<RosterPerson, 'name' | 'role'>, extra: { retryAfterSec?: number; attemptsLeft?: number } = {}): string {
  if (code === 'pin_wrong') {
    const left = extra.attemptsLeft;
    return typeof left === 'number' && left > 0 && left <= 3
      ? `That PIN isn't right. ${left} more ${left === 1 ? 'try' : 'tries'} before a short pause.`
      : "That PIN isn't right.";
  }
  const response = deviceRefusalResponse(code, { name: person.name, kid: person.role === 'child', retryAfterSec: extra.retryAfterSec });
  if (response.kind === 'message') return response.message;
  if (response.kind === 'pin-pad' && response.message) return response.message;
  return "Couldn't check that PIN. Try again.";
}

export function PinPadDialog({
  person,
  onVerified,
  onCancel,
  onRevoked,
}: {
  person: RosterPerson;
  onVerified: (sessionId: string) => void;
  onCancel: () => void;
  onRevoked: (code: DeviceRefusal) => void;
}) {
  const { householdId } = useTablet();
  const [digits, setDigits] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const press = useCallback((digit: string) => {
    setError(null);
    setDigits((current) => (current.length >= PIN_MAX_LENGTH ? current : current + digit));
  }, []);
  const back = useCallback(() => setDigits((current) => current.slice(0, -1)), []);

  const submit = useCallback(async () => {
    if (checking || digits.length < PIN_MIN_LENGTH) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError('PINs need a connection. Try again when the tablet is back online.');
      return;
    }
    setChecking(true);
    try {
      const user = auth.currentUser;
      if (!user) return onRevoked('unauthenticated');
      const result = await whileBusy('save', async () => verifyDevicePinAction({ idToken: await user.getIdToken(), householdId, actorUid: person.uid, pin: digits }));
      setDigits('');
      if (result.ok) return onVerified(result.data.pinSessionId);
      if (REVOKED.has(result.code)) return onRevoked(result.code);
      setError(pinRefusalMessage(result.code, person, result));
    } catch {
      setDigits('');
      setError("Can't reach HomeHub right now. Try again in a moment.");
    } finally {
      setChecking(false);
    }
  }, [checking, digits, householdId, onRevoked, onVerified, person]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key)) press(event.key);
      else if (event.key === 'Backspace') back();
      else if (event.key === 'Enter') void submit();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back, press, submit]);

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const keyClass = 'flex min-h-16 items-center justify-center rounded-2xl border border-border bg-card font-headline text-2xl font-semibold disabled:opacity-50';

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !checking) onCancel(); }}>
      <DialogContent className="max-w-md" data-testid="pin-pad">
        <DialogHeader className="items-center text-center">
          <PersonFace person={person} size="md" />
          <DialogTitle className="font-headline text-2xl">{person.name}&apos;s PIN</DialogTitle>
          <DialogDescription>Type your tablet PIN.</DialogDescription>
        </DialogHeader>
        <div className="flex justify-center gap-3 py-2" aria-label={`${digits.length} digits typed`} role="img" data-testid="pin-dots">
          {Array.from({ length: Math.max(PIN_MIN_LENGTH, digits.length) }, (_, index) => (
            <span key={index} className={cn('h-4 w-4 rounded-full border-2 border-primary', index < digits.length && 'bg-primary')} />
          ))}
        </div>
        <div role="alert" aria-live="assertive" className="min-h-6 text-center text-sm font-medium text-destructive" data-testid="pin-error">{error}</div>
        <div className="grid grid-cols-3 gap-3">
          {keys.map((key) => (
            <button key={key} type="button" className={keyClass} onClick={() => press(key)} disabled={checking} data-testid={`pin-key-${key}`}>{key}</button>
          ))}
          <button type="button" className={keyClass} onClick={back} disabled={checking || digits.length === 0} aria-label="Delete the last digit" data-testid="pin-key-back">
            <Delete aria-hidden className="h-6 w-6" />
          </button>
          <button type="button" className={keyClass} onClick={() => press('0')} disabled={checking} data-testid="pin-key-0">0</button>
          <button
            type="button"
            className={cn(keyClass, 'bg-primary text-lg text-primary-foreground')}
            onClick={() => void submit()}
            disabled={checking || digits.length < PIN_MIN_LENGTH}
            data-testid="pin-key-ok"
          >
            {checking ? <Loader2 aria-hidden className="h-6 w-6 animate-spin" /> : 'OK'}
          </button>
        </div>
        <Button type="button" variant="ghost" className="min-h-12" onClick={onCancel} disabled={checking}>Cancel</Button>
      </DialogContent>
    </Dialog>
  );
}
