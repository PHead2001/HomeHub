"use client";

import * as React from 'react';
import { DecodeHintType, useZxing } from 'react-zxing';
import { BarcodeFormat } from '@zxing/library';
import { Check, Flashlight, FlashlightOff, SwitchCamera } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldError, fieldErrorProps } from '@/components/field-error';
import { playFeedback } from '@/lib/feedback';
import { SCANNER_ERROR_COPY, newScannerErrorSession, reportScannerError, scannerErrorKind, type ScannerErrorKind } from '@/lib/barcode/scanner-errors';
import {
  CAMERA_CHOICE_KEY,
  fallbackAfterCameraError,
  SCAN_FORMATS,
  cameraConstraints,
  facingForDeviceCamera,
  nextCamera,
  paceScan,
  readCameraChoice,
  scannedBarcode,
  scannerStatus,
  serializeCameraChoice,
  type CameraChoice,
  type ScanPace,
} from '@/lib/barcode/scanner-camera';

interface BarcodeScannerProps {
  onScan: (barcode: string) => void;
  /**
   * A registered wall tablet's camera from its device record (WT-4, BL-2): the
   * scanner starts on it and a switch is not remembered. Personal devices omit
   * it and start on the camera they last switched to (rear by default).
   */
  deviceCamera?: 'front' | 'rear';
  /** Keep scanning after a read (the kitchen scan station); a repeat of the same code within 3 s is ignored. */
  continuous?: boolean;
}

// Only retail product formats (BL-7): fewer formats decode faster on slow tablets.
const SCAN_HINTS = new Map<DecodeHintType, unknown[]>([
  [DecodeHintType.POSSIBLE_FORMATS, SCAN_FORMATS.map((name) => BarcodeFormat[name])],
]);

const readStoredChoice = (): CameraChoice => {
  try {
    return readCameraChoice(window.localStorage.getItem(CAMERA_CHOICE_KEY));
  } catch {
    return readCameraChoice(null);
  }
};

/** Stops every track of the video's stream and detaches it. */
function stopVideoStream(video: HTMLVideoElement | null) {
  const stream = video?.srcObject;
  if (stream && typeof (stream as MediaStream).getTracks === 'function') {
    (stream as MediaStream).getTracks().forEach((track) => track.stop());
  }
  if (video) video.srcObject = null;
}

export function BarcodeScanner({ onScan, deviceCamera, continuous = false }: BarcodeScannerProps) {
  const { toast } = useToast();
  const manualRef = React.useRef<HTMLInputElement>(null);
  const [manualBarcode, setManualBarcode] = React.useState('');
  const [manualError, setManualError] = React.useState<string | null>(null);
  // The latest camera problem, shown over the camera for as long as the scanner is
  // open (the toast goes after a few seconds; this says why nothing scans).
  const [cameraError, setCameraError] = React.useState<ScannerErrorKind | null>(null);
  const [ready, setReady] = React.useState(false);
  const [status, setStatus] = React.useState(scannerStatus('starting'));
  const [flash, setFlash] = React.useState(0);
  const [switchable, setSwitchable] = React.useState(false);
  const [choice, setChoice] = React.useState<CameraChoice>(() => (
    deviceCamera ? { deviceId: null, facing: facingForDeviceCamera(deviceCamera) } : (typeof window === 'undefined' ? readCameraChoice(null) : readStoredChoice())
  ));
  const constraints = React.useMemo(() => cameraConstraints(choice), [choice]);
  const pace = React.useRef<ScanPace>(null);
  // This open scanner's session: each kind of error toasts once (a screen reader
  // hears it once), never again on every retry; a remounted scanner starts afresh.
  const errorSession = React.useRef(newScannerErrorSession());
  // Mounted = open. A camera start that fails after the scanner was closed (the
  // browser answers getUserMedia late) reports into a closed scanner: stay quiet.
  const open = React.useRef(true);
  React.useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const accept = (code: string) => {
    setCameraError(null);
    setStatus(scannerStatus({ scanned: code }));
    setFlash((value) => value + 1);
    playFeedback('add');
    onScan(code);
  };

  const { ref, torch } = useZxing({
    constraints,
    hints: SCAN_HINTS,
    onDecodeResult(result) {
      if (!open.current) return;
      const code = scannedBarcode(result.getText());
      if (!code) {
        setStatus(scannerStatus({ refused: true }));
        return;
      }
      const next = paceScan(pace.current, code, Date.now());
      pace.current = next.pace;
      if (!next.use) return;
      accept(code);
    },
    onError(error) {
      if (!open.current) return;
      const kind = scannerErrorKind(error);
      const report = reportScannerError(errorSession.current, kind);
      errorSession.current = report.session;
      // A switched-to camera that cannot be opened: back to its facing, quietly.
      const fallback = fallbackAfterCameraError(choice, kind);
      if (fallback) {
        setChoice(fallback);
        return;
      }
      setCameraError(kind);
      setReady(false);
      setStatus(scannerStatus('error'));
      // The camera cannot help: the number field is the way on (BL-6).
      if (kind !== 'scan') manualRef.current?.focus();
      if (!report.toast) return;
      if (kind !== 'permission') console.error("Scanner Error:", error);
      toast({ variant: 'destructive', ...SCANNER_ERROR_COPY[kind] });
    },
  });

  // Camera ready: say so, and find out whether there is another camera to switch to.
  React.useEffect(() => {
    const video = ref.current as HTMLVideoElement | null;
    if (!video) return;
    const onPlaying = () => {
      if (!open.current) return;
      setReady(true);
      setCameraError(null);
      setStatus(scannerStatus('ready'));
      void navigator.mediaDevices?.enumerateDevices?.().then((devices) => {
        if (!open.current) return;
        setSwitchable(devices.filter((device) => device.kind === 'videoinput').length > 1);
      }).catch(() => undefined);
    };
    video.addEventListener('playing', onPlaying);
    return () => video.removeEventListener('playing', onPlaying);
  }, [ref]);

  // Release the camera when the scanner unmounts (its dialog closed, or the tab
  // that owns it was hidden): stop every track still attached to the video, in
  // addition to react-zxing's own reader reset. A camera that starts only after
  // the scanner closed (getUserMedia answering late, BL-8) attaches to the
  // detached video: it is stopped as soon as it shows up.
  React.useEffect(() => {
    const video = ref.current as HTMLVideoElement | null;
    return () => {
      stopVideoStream(video);
      if (!video) return;
      // Only while closed: a remount (React Strict Mode runs cleanups once in development) owns the camera again.
      const late = () => {
        if (!open.current) stopVideoStream(video);
      };
      video.addEventListener('loadstart', late);
      video.addEventListener('loadedmetadata', late);
      video.addEventListener('playing', late);
      const timers = [250, 1_000, 3_000, 8_000].map((ms) => window.setTimeout(late, ms));
      window.setTimeout(() => {
        timers.forEach((timer) => window.clearTimeout(timer));
        video.removeEventListener('loadstart', late);
        video.removeEventListener('loadedmetadata', late);
        video.removeEventListener('playing', late);
      }, 10_000);
    };
  }, [ref]);

  // The check mark shows for a moment (a single-scan host usually closes the scanner first).
  React.useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(0), 900);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const switchCamera = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const video = ref.current as HTMLVideoElement | null;
      const track = (video?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
      const active = track?.getSettings?.().deviceId ?? null;
      const next = nextCamera(devices.filter((device) => device.kind === 'videoinput'), choice, active);
      if (!next) return;
      setReady(false);
      setStatus(scannerStatus('starting'));
      setChoice(next);
      // Remembered on this device; a wall tablet's camera is managed on its device record.
      if (!deviceCamera) {
        try {
          window.localStorage.setItem(CAMERA_CHOICE_KEY, serializeCameraChoice(next));
        } catch {
          // Storage is optional.
        }
      }
    } catch {
      // No camera list: nothing to switch to.
    }
  };

  const errorCopy = cameraError ? SCANNER_ERROR_COPY[cameraError] : null;

  return (
    <div className="space-y-4">
      <div className="relative aspect-video w-full overflow-hidden rounded-md bg-muted">
        <video ref={ref as React.RefObject<HTMLVideoElement>} className="h-full w-full object-cover" muted playsInline />
        {!errorCopy && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2">
            <div
              data-testid="scanner-frame"
              className="h-1/3 w-3/4 rounded-lg border-2 border-primary shadow-[0_0_0_9999px_hsl(var(--scrim)/0.5)]"
            />
            {ready && <p className="rounded bg-background/80 px-2 py-0.5 text-xs font-medium text-foreground">Point the camera at a barcode</p>}
          </div>
        )}
        {flash > 0 && (
          <div key={flash} data-testid="scanner-scanned" className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/20 motion-safe:animate-in motion-safe:fade-in">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
              <Check className="h-9 w-9" aria-hidden />
            </span>
          </div>
        )}
        {errorCopy && (
          // Over the camera area (BL-6). Not a live region: the first toast of this kind was already announced.
          <div className="absolute inset-0 flex items-center justify-center bg-card/95 p-4 text-center" data-testid="scanner-camera-error">
            <p className="max-w-sm text-sm">
              <span className="block font-medium">{errorCopy.title}</span>
              <span className="text-muted-foreground">{errorCopy.description}</span>
            </p>
          </div>
        )}
        {(switchable || torch.isAvailable) && !errorCopy && (
          <div className="absolute bottom-2 right-2 flex gap-2">
            {torch.isAvailable && (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="h-11 w-11 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12"
                aria-pressed={torch.isOn}
                aria-label={torch.isOn ? 'Turn the light off' : 'Turn the light on'}
                onClick={() => void (torch.isOn ? torch.off() : torch.on())}
              >
                {torch.isOn ? <FlashlightOff aria-hidden /> : <Flashlight aria-hidden />}
              </Button>
            )}
            {switchable && (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="h-11 w-11 [@media(pointer:coarse)]:h-12 [@media(pointer:coarse)]:w-12"
                aria-label="Switch camera"
                onClick={() => void switchCamera()}
              >
                <SwitchCamera aria-hidden />
              </Button>
            )}
          </div>
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only" data-testid="scanner-status">{status}</p>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          // A field problem is shown inline under the field, never as a toast.
          const code = scannedBarcode(manualBarcode);
          if (!code) {
            setManualError('Enter 6 to 32 digits.');
            return;
          }
          setManualError(null);
          if (continuous) setManualBarcode('');
          accept(code);
        }}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="manual-barcode">Barcode number</Label>
          <Input
            ref={manualRef}
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
