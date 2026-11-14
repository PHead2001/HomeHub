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
    default:
      return null;
  }
};

/** What a listener or an action answer tells the tablet about its session. */
export type SessionSignal =
  | { kind: 'record'; fromCache: boolean; exists: boolean; status?: unknown; generation?: unknown }
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
  'sign-out',
  'set-note',
  'navigate',
];

export type ClearDeps = Record<ClearStep, () => unknown | Promise<unknown>>;

/**
 * Clears this browser's tablet session, in order (section 13): unsubscribe every
 * listener; end the in-memory PIN session and face memory; delete `homehub-device`
 * (queue and Undo journal); forget the household's local data; terminate Firestore and
 * clear its cache; clear push state; sign out; leave the one-shot note; hard-navigate.
 * Every step runs even when an earlier one fails (each is best effort), and navigation
 * always happens last. Returns the steps that failed.
 */
export async function clearTabletSession(deps: ClearDeps): Promise<ClearStep[]> {
  const failed: ClearStep[] = [];
  for (const step of CLEAR_ORDER) {
    try {
      await deps[step]();
    } catch {
      failed.push(step);
    }
  }
  return failed;
}

/** Where the tablet goes once cleared: the sign-in screen for a personal sign-in, else setup. */
export const destinationAfter = (end: SessionEnd): string => (end === 'personal-sign-in' ? '/' : '/setup');

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
