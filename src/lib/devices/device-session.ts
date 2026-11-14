// The tablet session: revocation observation and clearing, and the household-wide
// notification listeners (docs/modules/devices/README.md, "Revocation on the tablet";
// design 5.6, 13, WT-19b-d, SL-3b, S3). Pure decisions plus a clearing routine with
// injected steps, so the order and the "every step runs" rule are unit-tested.

import { endsTabletSession } from './verify-errors';
import type { DeviceRefusal } from './action-policy';
import type { DeviceSections } from './types';

/** One-shot note for the setup screen after the session ended (read once, then cleared). */
export const DEVICE_ENDED_KEY = 'homehub.device-ended';

export type SessionEnd = 'removed' | 'repaired' | 'household-deleted' | 'new-code' | 'personal-sign-in';

/** The setup screen's note for how the last session ended (null: nothing to say). */
export const endedNote = (value: string | null): string | null => {
  switch (value) {
    case 'removed':
      return 'This tablet was removed.';
    case 'repaired':
      return 'This tablet was set up again on another screen.';
    case 'household-deleted':
      return 'This household was deleted, so this tablet was signed out.';
    case 'new-code':
      return 'This tablet was signed out. Enter a new code to set it up again.';
    case 'personal-sign-in':
      return 'This tablet was signed out. Sign in with your personal account.';
    default:
      return null;
  }
};

/** What a listener or an action answer tells the tablet about its session. */
export type SessionSignal =
  | { kind: 'record'; fromCache: boolean; exists: boolean; status?: unknown; generation?: unknown; endedReason?: unknown }
  | { kind: 'household'; fromCache: boolean; exists: boolean; deleting: boolean }
  | { kind: 'denied'; target: 'record' | 'household' }
  | { kind: 'signed-out' }
  | { kind: 'refusal'; code: DeviceRefusal | string };

/**
 * Whether a signal ends this tablet's session, and how (section 13). Only the server
 * decides: a cached snapshot never does. Removed when the record is missing, not active,
 * at another generation (re-paired elsewhere), unreadable, the household is gone or being
 * deleted, the Auth user signed out, or an action answered a revocation code. A verifier
 * outage (`unavailable`), rate limits and network errors never end it.
 */
export function decideSessionEnd(signal: SessionSignal, tokenGeneration: number): SessionEnd | null {
  switch (signal.kind) {
    case 'record':
      if (signal.fromCache) return null;
      if (!signal.exists) return 'removed';
      // A record kept for a re-pair says which exit ended it (only the tablet's own exits write these).
      if (signal.status === 'unpaired' && (signal.endedReason === 'new-code' || signal.endedReason === 'personal-sign-in')) return signal.endedReason;
      if (signal.status !== 'active') return 'removed';
      if (signal.generation !== tokenGeneration) return 'repaired';
      return null;
    case 'household':
      if (signal.fromCache) return null;
      if (!signal.exists || signal.deleting) return 'household-deleted';
      return null;
    case 'denied':
      return 'removed';
    case 'signed-out':
      return 'removed';
    case 'refusal':
      if (signal.code === 'household_deleting') return 'household-deleted';
      // 8.5: these all mean "this token is not this household's active tablet".
      if (signal.code === 'wrong_household' || signal.code === 'not_a_device') return 'removed';
      return endsTabletSession(signal.code) ? 'removed' : null;
    default:
      return null;
  }
}

export type ClearStep =
  | 'stop-listeners'
  | 'end-pin-and-face'
  | 'delete-device-database'
  | 'forget-household'
  | 'clear-firestore'
  | 'clear-push'
  | 'forget-tablet-marker'
  | 'sign-out'
  | 'set-note'
  | 'navigate';

export const CLEAR_ORDER: readonly ClearStep[] = [
  'stop-listeners',
  'end-pin-and-face',
  'delete-device-database',
  'forget-household',
  'clear-firestore',
  'clear-push',
  'forget-tablet-marker',
  'sign-out',
  'set-note',
  'navigate',
];

export type ClearDeps = Record<ClearStep, () => unknown | Promise<unknown>>;

/** Each clearing step gets at most this long; a step that hangs counts as failed and the rest still run. */
export const CLEAR_STEP_TIMEOUT_MS = 2_500;
/** A tablet exit call gets at most this long; a timeout counts as a failed exit. */
export const EXIT_TIMEOUT_MS = 30_000;

export class TimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out`);
    this.name = 'TimeoutError';
  }
}

/** `work`, or a TimeoutError after `ms` (the work itself is not cancelled; its result is ignored). */
export function withTimeout<T>(work: Promise<T>, ms: number, label = 'work', timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = timers.set(() => reject(new TimeoutError(label)), ms);
    work.then(
      (value) => { timers.clear(id); resolve(value); },
      (error) => { timers.clear(id); reject(error); },
    );
  });
}

/**
 * Clears this browser's tablet session, in order (section 13): unsubscribe every
 * listener; end the in-memory PIN session and face memory; delete `homehub-device`
 * (queue and Undo journal); forget the household's local data; terminate Firestore and
 * clear its cache; clear push state; remove the "this browser was a tablet" marker; sign out; leave the one-shot note; hard-navigate.
 * Every step runs even when an earlier one fails or hangs (each is best effort and gets at
 * most `stepTimeoutMs`), and navigation always happens last. Returns the steps that failed
 * or timed out.
 */
export async function clearTabletSession(deps: ClearDeps, options: { stepTimeoutMs?: number } = {}): Promise<ClearStep[]> {
  const stepTimeoutMs = options.stepTimeoutMs ?? CLEAR_STEP_TIMEOUT_MS;
  const failed: ClearStep[] = [];
  for (const step of CLEAR_ORDER) {
    try {
      await withTimeout(Promise.resolve().then(() => deps[step]()), stepTimeoutMs, step);
    } catch {
      failed.push(step);
    }
  }
  return failed;
}

/** The tablet's protected exits (design 14.6). */
export type TabletExitKind = 'remove' | 'personal-sign-in' | 'new-code';

/**
 * How a session ended by this tablet's own exit ends, decided from the exit itself (never
 * from the revocation signal that races it): Remove is a removal; the two exits that keep
 * the record for a re-pair are sign-outs.
 */
export const exitSessionEnd = (exit: TabletExitKind): SessionEnd =>
  exit === 'remove' ? 'removed' : exit;

/**
 * While this tablet's own exit is in flight, session ends from listeners and answers wait:
 * the exit's result decides (success: the exit's end; failure: whatever signal arrived
 * meanwhile, if any). Pure state for the shell.
 */
export type ExitGate = { inFlight: SessionEnd | null; deferred: SessionEnd | null };

export const exitGateSignal = (gate: ExitGate, end: SessionEnd): { gate: ExitGate; endNow: SessionEnd | null } =>
  gate.inFlight ? { gate: { ...gate, deferred: gate.deferred ?? end }, endNow: null } : { gate, endNow: end };

export const exitGateSettle = (gate: ExitGate, ok: boolean): { gate: ExitGate; endNow: SessionEnd | null } => {
  const endNow = ok ? gate.inFlight : gate.deferred;
  return { gate: { inFlight: null, deferred: null }, endNow };
};

/** Where the tablet goes once cleared: the sign-in screen for a personal sign-in, else setup. */
export const destinationAfter = (end: SessionEnd): string => (end === 'personal-sign-in' ? '/' : '/setup');

/** A household-wide notice as the tablet shows it. */
export type DeviceNotice = {
  id: string;
  category: string;
  title: string;
  message: string;
  createdAt: Date | null;
  deepLink: string | null;
};

/** Household-wide notices never show an email on a tablet (WT-10e): anything email-shaped is replaced. */
export const redactEmails = (value: string): string => value.replace(/[^\s@]+@[^\s@]+/g, 'a member');

const millisOf = (value: unknown): number | null => {
  if (value && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') return (value as { toMillis: () => number }).toMillis();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** A notice document for the tablet: expired ones are dropped, text is capped and email-free. */
export function parseDeviceNotice(id: string, data: Record<string, unknown>, nowMs: number): DeviceNotice | null {
  const expires = millisOf(data.expiresAt);
  if (expires !== null && expires < nowMs) return null;
  const created = millisOf(data.createdAt);
  return {
    id,
    category: typeof data.category === 'string' ? data.category : 'general',
    title: typeof data.title === 'string' ? redactEmails(data.title).slice(0, 120) : 'Household notice',
    message: typeof data.message === 'string' ? redactEmails(data.message).slice(0, 400) : '',
    createdAt: created === null ? null : new Date(created),
    deepLink: typeof data.deepLink === 'string' ? data.deepLink : null,
  };
}

export type DeviceNotificationCategory = 'chores' | 'pets' | 'shopping' | 'maintenance' | 'system' | 'general';

/** At most this many notices per listener (as the rules tests issue the query). */
export const DEVICE_NOTICES_LIMIT = 50;

/**
 * The household-wide notification listeners a tablet opens (5.6, JC-23): one per enabled
 * source, `system` and `general` always. Each is exactly
 * `where('audience','array-contains','*'), where('category','==',c), orderBy('createdAt','desc'), limit(50)`;
 * no other notification query is allowed for a device.
 */
export function deviceNotificationCategories(sections: DeviceSections): DeviceNotificationCategory[] {
  const out: DeviceNotificationCategory[] = [];
  if (sections.chores) out.push('chores');
  if (sections.pets) out.push('pets');
  if (sections.shopping) out.push('shopping');
  if (sections.maintenance) out.push('maintenance');
  out.push('system', 'general');
  return out;
}
