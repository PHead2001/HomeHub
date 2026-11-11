"use client";

import * as React from 'react';
import { useZxing } from 'react-zxing';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';

interface BarcodeScannerProps {
    onScan: (barcode: string) => void;
}

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const { toast } = useToast();
  const [manualBarcode, setManualBarcode] = React.useState('');
  const [manualError, setManualError] = React.useState<string | null>(null);
  
  const { ref } = useZxing({
    onDecodeResult(result) {
      onScan(result.getText());
    },
    onError(error) {
        if (error instanceof Error && error.name === 'NotAllowedError') {
             toast({
                variant: 'destructive',
                title: 'Camera Access Denied',
                description: 'Please enable camera permissions in your browser settings to use the scanner.',
            });
            return;
        }

        console.error("Scanner Error:", error);
        toast({
            variant: 'destructive',
            title: 'Scan Error',
            description: 'Could not decode the barcode. Please try again.',
        });
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
