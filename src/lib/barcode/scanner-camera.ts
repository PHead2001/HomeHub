/**
 * Scanner camera choice, formats and scan pacing (BL-2, BL-7). Pure, no DOM;
 * unit tested in tests/unit/barcode-scanner-camera.test.ts.
 *
 * - A personal device remembers which way the camera it last switched to faces
 *   (local storage, `readCameraChoice` / `CAMERA_CHOICE_KEY`; never a device id,
 *   which can disappear or change between sessions and would leave the scanner
 *   with no camera); a registered wall tablet starts on the camera its device
 *   record names (front by default, WT-4) instead.
 * - `facingMode` is never `exact`: a device with one camera still opens it
 *   (an exact constraint would fail with OverconstrainedError).
 * - Only retail product formats are decoded (EAN-13, EAN-8, UPC-A, UPC-E and
 *   Code 128), and a decoded text that is not 6 to 32 digits (a QR URL, a
 *   lettered Code 128) is refused before any lookup.
 */

export type CameraFacing = 'environment' | 'user';

/** The camera to open: a specific device (after a switch) or a facing. */
export type CameraChoice = { deviceId: string | null; facing: CameraFacing };

export const CAMERA_CHOICE_KEY = 'homehub.scanner.camera';

/** Device record values (`DeviceSettings.camera`) as a facing. */
export const facingForDeviceCamera = (camera: 'front' | 'rear'): CameraFacing => (camera === 'front' ? 'user' : 'environment');

/** The stored facing as a choice (no device id), or the default (rear camera) for anything unreadable. */
export function readCameraChoice(raw: string | null | undefined, fallback: CameraFacing = 'environment'): CameraChoice {
  if (!raw) return { deviceId: null, facing: fallback };
  try {
    const parsed = JSON.parse(raw) as Partial<CameraChoice>;
    const facing: CameraFacing = parsed.facing === 'user' || parsed.facing === 'environment' ? parsed.facing : fallback;
    return { deviceId: null, facing };
  } catch {
    return { deviceId: null, facing: fallback };
  }
}

/** What is remembered: the facing only. */
export const serializeCameraChoice = (choice: CameraChoice): string => JSON.stringify({ facing: choice.facing });

/**
 * After a camera error: a chosen device that cannot be opened (gone, or its id
 * changed) falls back to its facing, so the scanner never stays without a camera.
 * Null when there is nothing to fall back to.
 */
export function fallbackAfterCameraError(choice: CameraChoice, kind: string): CameraChoice | null {
  return choice.deviceId && (kind === 'no-camera' || kind === 'camera-busy') ? { deviceId: null, facing: choice.facing } : null;
}

/** Constraints for react-zxing: a chosen device, else a preferred (never exact) facing. */
export function cameraConstraints(choice: CameraChoice): MediaStreamConstraints {
  if (choice.deviceId) return { video: { deviceId: { exact: choice.deviceId } }, audio: false };
  return { video: { facingMode: choice.facing }, audio: false };
}

export type VideoInput = { deviceId: string; label?: string };

/**
 * The camera "Switch camera" moves to: the next video input after the one in
 * use (wrapping round), labelled front or back when the label says so. With
 * fewer than two cameras there is nothing to switch to (null).
 */
export function nextCamera(inputs: readonly VideoInput[], current: CameraChoice, activeDeviceId: string | null): CameraChoice | null {
  const usable = inputs.filter((input) => input.deviceId);
  if (usable.length < 2) return null;
  const currentId = activeDeviceId ?? current.deviceId;
  const index = usable.findIndex((input) => input.deviceId === currentId);
  const next = usable[(index + 1) % usable.length];
  const label = (next.label ?? '').toLowerCase();
  const facing: CameraFacing = /front|user|face/.test(label) ? 'user' : /back|rear|environment/.test(label) ? 'environment' : current.facing === 'user' ? 'environment' : 'user';
  return { deviceId: next.deviceId, facing };
}

/** The formats the scanner decodes (names of @zxing/library's BarcodeFormat). */
export const SCAN_FORMATS = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128'] as const;

/** A decoded text as a barcode to look up (6 to 32 digits, spaces dropped), or null. */
export function scannedBarcode(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const compact = text.replace(/\s+/g, '');
  return /^\d{6,32}$/.test(compact) ? compact : null;
}

/** Ignore the same code read again within this window (the camera sees it many times a second). */
export const REPEAT_SCAN_WINDOW_MS = 3_000;

export type ScanPace = { code: string; at: number } | null;

/**
 * Whether a decoded code should be used now, and the pace after it: the same
 * code inside the window is a repeat (ignored, and the window starts again, so a
 * package held in view counts once however long it stays); a different code
 * always counts.
 */
export function paceScan(last: ScanPace, code: string, now: number, windowMs = REPEAT_SCAN_WINDOW_MS): { use: boolean; pace: ScanPace } {
  if (last && last.code === code && now - last.at < windowMs) return { use: false, pace: { code, at: now } };
  return { use: true, pace: { code, at: now } };
}

/** Polite status line read out while the scanner is open (BL-18). */
export function scannerStatus(state: 'starting' | 'ready' | 'error' | { scanned: string } | { refused: true }): string {
  if (state === 'starting') return 'Starting the camera…';
  if (state === 'ready') return 'Camera ready. Point it at a barcode.';
  if (state === 'error') return 'The camera is not available. Type the barcode number instead.';
  if ('refused' in state) return 'That code is not a product barcode. Try the barcode on the package.';
  return `Scanned ${state.scanned}`;
}
