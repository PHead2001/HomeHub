/**
 * Camera scanner errors (`BarcodeScanner`): what kind each is, how it reads, and
 * whether it should raise a toast. A scanner can report the same failure over and
 * over while it stays open (the decoder retrying a camera it cannot start), so
 * each kind toasts once per open session and is otherwise shown inline in the
 * scanner; a different kind toasts once more; a newly opened scanner is a new
 * session. Pure, no DOM.
 */

export type ScannerErrorKind = 'permission' | 'no-camera' | 'camera-busy' | 'not-supported' | 'scan';

/** The kind of a scanner error, from its DOMException-style `name`. */
export function scannerErrorKind(error: unknown): ScannerErrorKind {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'permission';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'no-camera';
    case 'NotReadableError':
    case 'AbortError':
      return 'camera-busy';
    case 'NotSupportedError':
      return 'not-supported';
    default:
      return 'scan';
  }
}

export const SCANNER_ERROR_COPY: Record<ScannerErrorKind, { title: string; description: string }> = {
  permission: {
    title: 'Camera Access Denied',
    description: 'Please enable camera permissions in your browser settings to use the scanner.',
  },
  'no-camera': {
    title: 'No camera found',
    description: 'This device has no camera the scanner can use. Type the barcode number instead.',
  },
  'camera-busy': {
    title: 'Camera unavailable',
    description: 'The camera is in use by another app or could not start. Close it there, or type the barcode number instead.',
  },
  'not-supported': {
    title: 'Camera not supported',
    description: 'This browser cannot use the camera for scanning. Type the barcode number instead.',
  },
  scan: {
    title: 'Scan Error',
    description: 'Could not decode the barcode. Please try again.',
  },
};

/** One open scanner's record of the error kinds it has already toasted. */
export type ScannerErrorSession = { readonly toasted: ReadonlySet<ScannerErrorKind> };

export const newScannerErrorSession = (): ScannerErrorSession => ({ toasted: new Set() });

/**
 * Whether an error of `kind` should toast in `session`, and the session after it:
 * the first of each kind does, repeats do not.
 */
export function reportScannerError(session: ScannerErrorSession, kind: ScannerErrorKind): { toast: boolean; session: ScannerErrorSession } {
  if (session.toasted.has(kind)) return { toast: false, session };
  return { toast: true, session: { toasted: new Set([...session.toasted, kind]) } };
}
