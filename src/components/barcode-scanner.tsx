"use client";

import * as React from 'react';
import { useZxing } from 'react-zxing';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { SCANNER_ERROR_COPY, newScannerErrorSession, reportScannerError, scannerErrorKind, type ScannerErrorKind } from '@/lib/barcode/scanner-errors';

interface BarcodeScannerProps {
    onScan: (barcode: string) => void;
}

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const { toast } = useToast();
  const [manualBarcode, setManualBarcode] = React.useState('');
  const [manualError, setManualError] = React.useState<string | null>(null);
  // The latest camera problem, shown under the camera for as long as the scanner is
  // open (the toast goes after a few seconds; this says why nothing scans).
  const [cameraError, setCameraError] = React.useState<ScannerErrorKind | null>(null);
  // This open scanner's session: each kind of error toasts once (a screen reader
  // hears it once), never again on every retry; a remounted scanner starts afresh.
  const errorSession = React.useRef(newScannerErrorSession());

  const { ref } = useZxing({
    onDecodeResult(result) {
      setCameraError(null);
      onScan(result.getText());
    },
    onError(error) {
        const kind = scannerErrorKind(error);
        const report = reportScannerError(errorSession.current, kind);
        errorSession.current = report.session;
        setCameraError(kind);
        if (!report.toast) return;
        if (kind !== 'permission') console.error("Scanner Error:", error);
        toast({ variant: 'destructive', ...SCANNER_ERROR_COPY[kind] });
    },
  });

  // Release the camera when the scanner unmounts (its dialog closed, or the tab
  // that owns it was hidden): stop every track still attached to the video, in
  // addition to react-zxing's own reader reset.
  React.useEffect(() => {
    const video = ref.current as HTMLVideoElement | null;
    return () => {
      const stream = video?.srcObject;
      if (stream && typeof (stream as MediaStream).getTracks === 'function') {
        (stream as MediaStream).getTracks().forEach((track) => track.stop());
      }
      if (video) video.srcObject = null;
    };
  }, [ref]);

  return (
    <div className="space-y-4">
      <div className="relative aspect-video w-full overflow-hidden rounded-md">
        <video ref={ref as React.RefObject<HTMLVideoElement>} className="h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-1/3 w-3/4 rounded-lg border-2 border-destructive shadow-[0_0_0_9999px_hsl(var(--scrim)/0.5)]" />
        </div>
      </div>
      {cameraError && (
        // Not a live region: the first toast of this kind was already announced.
        <p className="text-sm text-destructive" data-testid="scanner-camera-error">
          {SCANNER_ERROR_COPY[cameraError].title}. {SCANNER_ERROR_COPY[cameraError].description}
        </p>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          // A field problem is shown inline under the field, never as a toast.
          if (!/^\d{6,32}$/.test(manualBarcode.trim())) {
            setManualError('Enter 6 to 32 digits.');
            return;
          }
          setManualError(null);
          onScan(manualBarcode.trim());
        }}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="manual-barcode">Barcode number</Label>
          <Input
            inputMode="numeric"
            autoComplete="off"
            value={manualBarcode}
            onChange={event => {
              setManualBarcode(event.target.value.replace(/\D/g, ''));
              setManualError(null);
            }}
            {...fieldErrorProps('manual-barcode', manualError)}
          />
        </div>
        <Button type="submit">Use barcode</Button>
      </form>
      <FieldError id="manual-barcode">{manualError}</FieldError>
    </div>
  );
};
