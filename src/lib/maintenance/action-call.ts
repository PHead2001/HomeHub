import { UNDO_WINDOW_MS } from '../undo-window';
// Pure pieces of how the Maintenance Center calls its server actions (M1), kept free of
// Firebase imports so tests/unit/maintenance-operations.test.ts covers them.

/** The answer of a server action (see src/app/maintenance/actions.ts). */
export type ActionAnswer<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export type MaintenanceCallOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'failed'; message: string }
  | { kind: 'offline' }
  /** No answer in time, or the request failed in transit: it may have been saved. */
  | { kind: 'no_answer' };

/**
 * Runs one authenticated call under a single deadline that starts before the ID token is
 * fetched: a token refresh that hangs counts against the same 20 s as the call itself.
 */
export async function callWithDeadline<T>(
  getIdToken: () => Promise<string>,
  call: (idToken: string) => Promise<ActionAnswer<T>>,
  deadlineMs: number,
  isOffline: () => boolean = () => false,
): Promise<MaintenanceCallOutcome<T>> {
  if (isOffline()) return { kind: 'offline' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), deadlineMs); });
  try {
    const result = await Promise.race([getIdToken().then(call), deadline]);
    if (result === 'deadline') return { kind: 'no_answer' };
    return result.ok ? { kind: 'ok', data: result.data } : { kind: 'failed', message: result.message };
  } catch {
    return isOffline() ? { kind: 'offline' } : { kind: 'no_answer' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A request the page may have to send again exactly: at least its op id. */
export type PendingRequest = { opId: string };

/**
 * Requests whose outcome is unknown (no answer, or failed in transit), by form or card
 * action. While one is unresolved, pressing Save again sends that same request with the
 * same op id, never a new one, so an uncertain save can never be duplicated. It is
 * forgotten on a definite answer, or when its dialog is opened afresh (the person
 * discarded it by closing the dialog).
 */
export function createPendingRequests<R extends PendingRequest = PendingRequest>() {
  const unresolved = new Map<string, R>();
  return {
    /** The unresolved request for this key, if any (send it instead of a new one). */
    get: (key: string) => unresolved.get(key),
    /** The outcome is unknown: keep the request for the next press. */
    hold: (key: string, request: R) => { unresolved.set(key, request); },
    /** A definite answer, or the form was discarded. */
    settle: (key: string) => { unresolved.delete(key); },
  };
}

const mi = (value: number) => `${value.toLocaleString('en-US')} mi`;

/**
 * Asked once before saving an unusual odometer value (MA-6d). A service or log reading
 * never lowers the vehicle (`reading`: the max rule keeps the higher one); the vehicle
 * form's odometer is a correction and is written as entered (`correction`).
 */
export const mileageWarningMessage = (warning: 'lower' | 'jump', current: number, reading: number, kind: 'reading' | 'correction') => {
  if (kind === 'correction') {
    return warning === 'lower'
      ? `That is lower than the recorded ${mi(current)}. Saving corrects the vehicle's odometer down to ${mi(reading)}. Save anyway?`
      : `That is more than 20,000 mi above the recorded ${mi(current)}. Saving sets the vehicle's odometer to ${mi(reading)}. Save anyway?`;
  }
  return warning === 'lower'
    ? `That is lower than the recorded ${mi(current)}. The vehicle keeps the higher reading; this entry keeps ${mi(reading)}. Save anyway?`
    : `That is more than 20,000 mi above the recorded ${mi(current)}. Save anyway?`;
};


/** Below this much time left, the Undo button is not offered (it could not be pressed in time). */
export const MIN_UNDO_OFFER_MS = 1500;

/**
 * How long a result's Undo may be offered: what the server says is left of the window
 * (`undoMs`; a replayed or slow answer has less), less half a second for the trip back, at most
 * the shared window. Null when too little is left to press it; an answer from an older
 * server without `undoMs` gets the whole window.
 */
export const undoOfferMs = (undoMs: number | undefined): number | null => {
  if (typeof undoMs !== 'number' || !Number.isFinite(undoMs)) return UNDO_WINDOW_MS;
  const offer = Math.min(UNDO_WINDOW_MS, undoMs - 500);
  return offer >= MIN_UNDO_OFFER_MS ? offer : null;
};
