'use client';

import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import Link from 'next/link';
import { signInWithCustomToken } from 'firebase/auth';
import { useZxing } from 'react-zxing';
import { Camera, CameraOff, Loader2, MonitorSmartphone, SwitchCamera } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { auth } from '@/lib/firebase-app';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { formatInviteInput } from '@/components/household/household-model';
import { redeemDeviceCodeAction } from '@/app/household/device-actions';
import { REDEEM_REFUSAL_COPY, codeFromScan, codeFromSetupFragment, normalizeDeviceCode } from '@/lib/devices/device-codes';
import { browserPushClearDeps, clearPushState } from '@/lib/devices/push-clear';
import { keepPendingAfter, pendingFor, type PendingRedemption } from '@/lib/devices/setup-pending';
import { SCANNER_ERROR_COPY, scannerErrorKind, type ScannerErrorKind } from '@/lib/barcode/scanner-errors';
import { DEVICE_ENDED_KEY, endedNote } from '@/lib/devices/device-session';
import { hasTabletMarker, recoverFormerTabletHere, shouldStripSetupFragment } from '@/lib/devices/former-tablet';

// "Set up a wall tablet" (docs/modules/devices/README.md, "QR and the setup screen"):
// the code typed or scanned from the creator's QR (whose setup link carries the code in
// the URL fragment, read here and removed from the address bar). Redemption returns a
// one-time custom token; leftover push state is cleared, then this browser signs in as
// the tablet. Only reachable signed out: a personal session is asked to sign out first,
// and a device session never renders this screen (the auth provider shows the tablet).

const PENDING_KEY = 'homehub.device-setup';

type Pending = PendingRedemption;

const readPending = (): Pending | null => {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) ?? 'null') as Pending | null;
    return parsed && typeof parsed.code === 'string' && typeof parsed.nonce === 'string' ? parsed : null;
  } catch {
    return null;
  }
};

const writePending = (pending: Pending | null) => {
  try {
    if (pending) window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage blocked: a retry after an uncertain answer then gets "used".
  }
};

/** 32 random bytes, base64url: makes a retry after an uncertain answer idempotent. */
const newNonce = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A limited-use App Check token when App Check runs on this page (never in emulator mode). */
const limitedUseAppCheckToken = async (): Promise<string | null> => {
  try {
    const { appCheck } = await import('@/lib/firebase');
    if (!appCheck) return null;
    const { getLimitedUseToken } = await import('firebase/app-check');
    return (await getLimitedUseToken(appCheck)).token;
  } catch (error) {
    console.warn('App Check token unavailable.', error instanceof Error ? error.message : String(error));
    return null;
  }
};


function QrScanner({ onCode, onClose }: { onCode: (text: string) => void; onClose: () => void }) {
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [problem, setProblem] = useState<ScannerErrorKind | null>(null);
  const { ref } = useZxing({
    constraints: { video: { facingMode: facing }, audio: false },
    onDecodeResult(result) {
      onCode(result.getText());
    },
    onError(error) {
      setProblem(scannerErrorKind(error));
    },
  });
  useEffect(() => {
    const video = ref.current;
    return () => {
      const stream = video?.srcObject;
      if (stream && typeof (stream as MediaStream).getTracks === 'function') (stream as MediaStream).getTracks().forEach(track => track.stop());
    };
  }, [ref]);
  return (
    <div className="space-y-3">
      <video ref={ref as RefObject<HTMLVideoElement>} className="aspect-video w-full rounded-md bg-black object-cover" muted playsInline aria-label="Camera view for the setup QR code" />
      {problem && (
        <p role="status" className="text-sm text-destructive">
          {SCANNER_ERROR_COPY[problem].title}. {SCANNER_ERROR_COPY[problem].description} You can type the code instead.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="min-h-12" onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')}>
          <SwitchCamera aria-hidden className="mr-2 h-4 w-4" /> Switch camera
        </Button>
        <Button type="button" variant="outline" className="min-h-12" onClick={onClose}>
          <CameraOff aria-hidden className="mr-2 h-4 w-4" /> Type the code instead
        </Button>
      </div>
    </div>
  );
}

const readEndedNote = () => {
  try {
    return endedNote(window.sessionStorage.getItem(DEVICE_ENDED_KEY));
  } catch {
    return null;
  }
};

export function SetupScreen() {
  const { currentUser, loading, principal } = useAuth();
  // The setup link's code: in the fragment only, never sent to a server. Read once on the
  // client (the form renders only after Auth has answered, so first paint is the same).
  const [code, setCode] = useState(() => (typeof window === 'undefined' ? '' : codeFromSetupFragment(window.location.hash) ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  // The one-shot note after a removal.
  const [note] = useState(() => (typeof window === 'undefined' ? null : readEndedNote()));
  const submitting = useRef(false);
  // The code as the page opened, before anything strips it from the address bar.
  const initialCode = useRef<string | null>(typeof window === 'undefined' ? null : codeFromSetupFragment(window.location.hash));

  // A browser that was a tablet whose session ended while the shell was not running: its
  // data is cleared first (then the setup screen loads again).
  // The setup link's code (read into `code` above, before anything strips it) is carried
  // through that reload.
  // Only once Auth has answered and nobody is signed in (recovery also re-checks before each step).
  const recoveryTried = useRef(false);
  useEffect(() => {
    if (loading || currentUser || principal.kind !== 'personal' || recoveryTried.current) return;
    recoveryTried.current = true;
    if (hasTabletMarker()) void recoverFormerTabletHere(initialCode.current);
  }, [currentUser, loading, principal.kind]);

  // Then the address bar loses the code (only once no recovery is owed: recovery reloads the
  // page with the code), and the note is not shown again.
  useEffect(() => {
    if (window.location.hash && shouldStripSetupFragment(hasTabletMarker())) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    try {
      window.sessionStorage.removeItem(DEVICE_ENDED_KEY);
    } catch {
      // Storage blocked: nothing to remove.
    }
  }, []);

  const redeem = async (raw: string) => {
    const normalized = normalizeDeviceCode(raw);
    if (!normalized) {
      setError(REDEEM_REFUSAL_COPY.invalid_input);
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const pending = pendingFor(readPending(), normalized, newNonce);
      writePending(pending);
      const result = await redeemDeviceCodeAction({ code: pending.code, nonce: pending.nonce, appCheckToken: await limitedUseAppCheckToken() });
      if (!result.ok) {
        // A retryable refusal keeps the code and nonce: the redemption may have committed
        // without its credential (`failed`), and only the same nonce can recover it.
        if (!keepPendingAfter({ kind: 'refused', code: result.code })) writePending(null);
        setError(result.message);
        return;
      }
      const cleared = await clearPushState(browserPushClearDeps());
      if (!cleared.ok) console.warn('Leftover push state could not be fully cleared; the tablet retries at start.', cleared.errors.join('; '));
      await signInWithCustomToken(auth, result.data.customToken);
      if (!keepPendingAfter({ kind: 'signed-in' })) writePending(null);
    } catch (failure) {
      // Uncertain (network) or sign-in failed: the same code and nonce retry safely.
      console.warn('Tablet setup did not finish.', failure instanceof Error ? failure.message : String(failure));
      setError("Couldn't finish setting up. Check the connection and try again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void redeem(code);
  };

  const onScan = (text: string) => {
    const scanned = codeFromScan(text, window.location.origin);
    if (!scanned) {
      setError("That QR code isn't a HomeHub tablet code.");
      return;
    }
    setScanning(false);
    setCode(scanned);
    void redeem(scanned);
  };

  if (loading || principal.kind !== 'personal') {
    return (
      <div className="flex flex-1 items-center justify-center p-6" role="status" aria-live="polite">
        <Loader2 aria-hidden className="mr-2 h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  if (currentUser) {
    return (
      <div className="mx-auto w-full max-w-lg p-4 md:p-8">
        <Card>
          <CardHeader>
            <CardTitle className="font-headline">Sign out first</CardTitle>
            <CardDescription>
              Sign out first to set this browser up as a wall tablet. A wall tablet has no personal account; it acts as whoever is standing at it.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild variant="outline" className="min-h-12"><Link href="/">Back to HomeHub</Link></Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg p-4 md:p-8">
      <Card>
        <form noValidate onSubmit={onSubmit}>
          <CardHeader>
            <MonitorSmartphone aria-hidden className="h-8 w-8 text-primary" />
            <CardTitle className="font-headline text-2xl">Set up a wall tablet</CardTitle>
            <CardDescription>
              An owner or admin creates a tablet code in Household, Devices. Scan its QR code with this tablet&apos;s camera or type the code. No Google account is needed.
            </CardDescription>
            {note && <p role="status" className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">{note}</p>}
          </CardHeader>
          <CardContent className="space-y-3">
            {scanning ? (
              <QrScanner onCode={onScan} onClose={() => setScanning(false)} />
            ) : (
              <Button type="button" variant="outline" className="min-h-12 w-full" onClick={() => { setError(null); setScanning(true); }} disabled={busy}>
                <Camera aria-hidden className="mr-2 h-4 w-4" /> Scan the QR code
              </Button>
            )}
            <div className="space-y-2">
              <Label htmlFor="deviceCode">Tablet code</Label>
              <Input
                {...fieldErrorProps('deviceCode', error)}
                placeholder="ABCD-EFGH-JK"
                value={code}
                onChange={(event) => { setCode(formatInviteInput(event.target.value)); setError(null); }}
                disabled={busy}
                maxLength={12}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                enterKeyHint="go"
                className="min-h-12 font-code text-lg tracking-widest"
              />
              <FieldError id="deviceCode">{error}</FieldError>
              <p className="text-xs text-muted-foreground">Codes work once and last 15 minutes.</p>
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="min-h-12 w-full" disabled={busy}>
              {busy && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
              Set up this tablet
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
