'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { useUnsavedInput } from '@/hooks/use-shell-busy';
import { auth } from '@/lib/firebase-app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { validatePinFormat } from '@/lib/devices/pins';
import { clearMemberPinAction, clearPinLockoutAction, pinStatusAction, setMyPinAction } from '@/app/household/pin-actions';

// Profile "Tablet PIN" (docs/modules/devices/README.md, "PINs"; WT-9a): each person
// sets their own PIN here, from their own signed-in session, never on a tablet. Shown
// only with the wall-tablet flag on, to active owners, admins, members and children
// with an account (guests never get a PIN). The server enforces every rule; this card
// never sees a stored PIN, only whether one is set and whether it is locked.

const devicesEnabled = process.env.NEXT_PUBLIC_HOMEHUB_DEVICES === 'true';

type Status = { hasPin: boolean; locked: boolean } | null;

export function TabletPinCard() {
  const { currentUser, household, currentMember } = useAuth();
  const { toast, toastError } = useToast();
  const formId = useId();
  const householdId = household?.id ?? null;
  const eligible = devicesEnabled && Boolean(householdId) && Boolean(currentMember) &&
    (currentMember!.status ?? 'active') === 'active' && ['owner', 'admin', 'member', 'child'].includes(currentMember!.role);
  const [status, setStatus] = useState<Status>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<'save' | 'clear' | 'unlock' | null>(null);
  useUnsavedInput(editing && (pin.length > 0 || confirm.length > 0 || busy !== null));

  const [tick, setTick] = useState(0);
  const loadStatus = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => {
    if (!eligible || !householdId) return;
    let cancelled = false;
    void (async () => {
      const user = auth.currentUser;
      if (!user) return;
      try {
        const result = await pinStatusAction({ idToken: await user.getIdToken(), householdId });
        if (cancelled) return;
        if (result.ok) setStatus(result.data[user.uid] ?? { hasPin: false, locked: false });
        setStatusFailed(!result.ok);
      } catch {
        if (!cancelled) setStatusFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [eligible, householdId, tick]);

  if (!eligible || !currentUser || !householdId) return null;

  const formatError = submitted ? (validatePinFormat(pin).ok ? null : (validatePinFormat(pin) as { message: string }).message) : null;
  const confirmError = submitted && !formatError && confirm !== pin ? "The two PINs don't match." : null;

  const reset = () => {
    setPin('');
    setConfirm('');
    setSubmitted(false);
    setEditing(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!validatePinFormat(pin).ok || confirm !== pin || !auth.currentUser) return;
    setBusy('save');
    try {
      const result = await setMyPinAction({ idToken: await auth.currentUser.getIdToken(), householdId, pin });
      if (!result.ok) {
        toast({ variant: 'destructive', title: "Couldn't save your PIN", description: result.message });
        return;
      }
      toast({ title: status?.hasPin ? 'Tablet PIN changed' : 'Tablet PIN set', description: 'Any tablet unlocked with your old PIN is locked again.' });
      reset();
      loadStatus();
    } catch (error) {
      toastError(error, "Couldn't save your PIN");
    } finally {
      setBusy(null);
    }
  };

  const run = async (kind: 'clear' | 'unlock') => {
    if (!auth.currentUser) return;
    setBusy(kind);
    try {
      const input = { idToken: await auth.currentUser.getIdToken(), householdId, targetUid: auth.currentUser.uid };
      const result = kind === 'clear' ? await clearMemberPinAction(input) : await clearPinLockoutAction(input);
      if (!result.ok) {
        toast({ variant: 'destructive', title: kind === 'clear' ? "Couldn't remove your PIN" : "Couldn't unlock your PIN", description: result.message });
        return;
      }
      toast({ title: kind === 'clear' ? 'Tablet PIN removed' : 'Tablet PIN unlocked' });
      loadStatus();
    } catch (error) {
      toastError(error, kind === 'clear' ? "Couldn't remove your PIN" : "Couldn't unlock your PIN");
    } finally {
      setBusy(null);
    }
  };

  const statusText = status === null
    ? (statusFailed ? "We couldn't check your PIN right now." : 'Checking…')
    : status.locked
      ? 'Your PIN is locked after too many wrong tries on a tablet.'
      : status.hasPin ? 'Your PIN is set.' : 'You have no PIN yet.';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-headline flex items-center gap-2"><KeyRound aria-hidden /> Tablet PIN</CardTitle>
        <CardDescription>
          Wall tablets ask for your PIN before anything that needs more than a tap of your face. Set it here, never on a tablet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p role="status" className="text-sm">{statusText}</p>
        {status?.locked && (
          <Button type="button" variant="outline" onClick={() => void run('unlock')} disabled={busy !== null}>
            {busy === 'unlock' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Unlock my PIN
          </Button>
        )}
        {editing ? (
          <form id={formId} noValidate onSubmit={(event) => void save(event)} className="space-y-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-pin`}>New PIN (4 to 6 digits)</Label>
              <Input
                {...fieldErrorProps(`${formId}-pin`, formatError)}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <FieldError id={`${formId}-pin`}>{formatError}</FieldError>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-confirm`}>Type it again</Label>
              <Input
                {...fieldErrorProps(`${formId}-confirm`, confirmError)}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <FieldError id={`${formId}-confirm`}>{confirmError}</FieldError>
            </div>
            <p className="text-xs text-muted-foreground">Not the same digit four times, and not digits in a row like 1234.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy !== null}>
                {busy === 'save' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save PIN
              </Button>
              <Button type="button" variant="ghost" onClick={reset} disabled={busy !== null}>Cancel</Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setEditing(true)} disabled={busy !== null || status === null}>
              {status?.hasPin ? 'Change PIN' : 'Set a PIN'}
            </Button>
            {status?.hasPin && (
              <Button type="button" variant="outline" onClick={() => void run('clear')} disabled={busy !== null}>
                {busy === 'clear' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Remove PIN
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
