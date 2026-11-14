'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserQRCodeSvgWriter } from '@zxing/library';
import { CheckCircle2, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { copyText } from '@/lib/utils';
import { DEVICE_CODE_TTL_MINUTES, deviceSetupUrl } from '@/lib/devices/device-codes';
import { relativeTime } from '@/components/household/household-model';

// The code an owner or admin just created, as a QR (the setup link, code in the URL
// fragment) and as text, with live status from its `deviceCodes/{code}` document: the
// creator sees at once when a tablet used it (S15), and who it says it is.

export type ShownDeviceCode = { code: string; expiresAt: string; kind: 'pair' | 'repair'; name: string };

type CodeStatus =
  | { state: 'waiting' }
  | { state: 'used'; deviceName: string; at: string | null }
  | { state: 'revoked' };

const toIso = (value: unknown): string | null => {
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
};

function QrCode({ value }: { value: string }) {
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const svg = new BrowserQRCodeSvgWriter().write(value, 240, 240);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code with the tablet setup link');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    host.replaceChildren(svg);
    return () => host.replaceChildren();
  }, [value]);
  // Dark modules on white in every theme: scanners need the contrast.
  return <div ref={container} className="mx-auto aspect-square w-60 max-w-full rounded-md bg-white p-2 text-black" />;
}

export function DeviceCodeDialog({ shown, onClose }: { shown: ShownDeviceCode | null; onClose: () => void }) {
  // The status belongs to the code it was read for; another code starts as waiting.
  const [observed, setObserved] = useState<{ code: string; status: CodeStatus } | null>(null);
  const [origin] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin));
  const code = shown?.code ?? null;
  const status: CodeStatus = observed && observed.code === code ? observed.status : { state: 'waiting' };

  useEffect(() => {
    if (!code) return;
    let stop: (() => void) | null = null;
    let stopped = false;
    void Promise.all([import('@/lib/firebase'), import('firebase/firestore')]).then(([{ db }, { doc, onSnapshot }]) => {
      if (stopped) return;
      stop = onSnapshot(doc(db, 'deviceCodes', code), snapshot => {
        const data = snapshot.data();
        if (!data) return;
        if (data.usedAt) setObserved({ code, status: { state: 'used', deviceName: typeof data.usedDeviceName === 'string' ? data.usedDeviceName : 'A tablet', at: toIso(data.usedAt) } });
        else if (data.revokedAt) setObserved({ code, status: { state: 'revoked' } });
      }, error => console.warn('Code status listener stopped.', error.message));
    });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [code]);

  const setupUrl = shown && origin ? deviceSetupUrl(origin, shown.code) : '';

  return (
    <Dialog open={Boolean(shown)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline">{shown?.kind === 'repair' ? `Re-pair ${shown.name}` : `Set up ${shown?.name ?? 'the tablet'}`}</DialogTitle>
          <DialogDescription>
            On the tablet, open HomeHub and choose Set up a wall tablet. Scan this QR code or type the code. It works once and lasts {DEVICE_CODE_TTL_MINUTES} minutes.
          </DialogDescription>
        </DialogHeader>
        {shown && (
          <div className="space-y-4">
            {status.state === 'used' ? (
              <div role="status" className="space-y-2 rounded-md border border-success/50 bg-success/10 p-4">
                <p className="flex items-center gap-2 font-medium">
                  <CheckCircle2 aria-hidden className="h-5 w-5 text-success" />
                  Paired: {status.deviceName}, {status.at ? relativeTime(status.at) : 'just now'}
                </p>
                <p className="text-sm text-muted-foreground">If that wasn&apos;t the tablet in front of you, remove it from Devices.</p>
              </div>
            ) : status.state === 'revoked' ? (
              <p role="status" className="rounded-md border p-3 text-sm">This code was cancelled.</p>
            ) : (
              <>
                {setupUrl && <QrCode value={setupUrl} />}
                <p data-testid="device-code-value" className="text-center font-code text-3xl font-semibold tracking-widest" aria-label={`Code ${shown.code.split('').join(' ')}`}>{shown.code}</p>
                <p className="text-center text-sm text-muted-foreground" aria-live="polite">Waiting for the tablet · expires {relativeTime(shown.expiresAt)}</p>
              </>
            )}
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          {shown && status.state === 'waiting' && (
            <Button variant="outline" className="min-h-12" onClick={async () => { await copyText(shown.code); }}>
              <Copy aria-hidden className="mr-2 h-4 w-4" /> Copy code
            </Button>
          )}
          <Button className="min-h-12" onClick={onClose}>{status.state === 'used' ? 'Done' : 'Close'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
