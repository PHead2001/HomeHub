// The tablet's durable face-action queue (docs/modules/devices/README.md, "Offline queue
// and Undo journal"; design 10.3, 11, re-review R1; WT-19e-g, PE-23l).
//
// - Only face-level, queueable capabilities queue (decided now from the same policy the
//   server uses; the server decides again at sync), plus Undo intents. Nothing PIN-level,
//   no PIN verification, no settings, no exits (WT-19f).
// - An entry is written to IndexedDB (`homehub-device`, store `queue`) before the UI says
//   "Saved on this tablet, will sync"; its intent is immutable: the original actor, level,
//   capability and payload never change. Only the send fields (attempts, state, last
//   error, next attempt) are updated.
// - Sync runs under the Web Lock `homehub-device-queue`, oldest first, through the same
//   device action a live call uses, with `queued: { createdAt }` and the entry's opId; the
//   server revalidates everything against current state (device, household, actor, role,
//   capability, section, level). Face memory is not re-checked (WT-19g).
// - Sync holds data only: it never opens dialogs, never asks "Feed again?", never shows an
//   Undo toast and never counts as a new face selection or consent.
// - An entry is removed locally only while it has never been sent (attempts 0, pending);
//   anything that may have reached the server is undone by sending an Undo intent by opId.
//
// F3 builds this infrastructure; F4's device actions plug in as the `send` function. Until
// then nothing is queued (every write on a tablet is refused).

import {
  isDeviceCapability,
  policyOf,
  requiredLevel,
  type DeviceCapability,
  type DeviceRefusal,
  type PointsPinPolicy,
  UNDO_PROVEN,
} from './action-policy';
import { withQueueLock, type RecordStore } from './device-store';
import type { HouseholdRole } from '@/lib/types';

export type QueueSendState = 'pending' | 'inflight' | 'uncertain';

export type QueuedDeviceAction = {
  readonly opId: string;
  readonly kind: 'action' | 'undo';
  readonly householdId: string;
  readonly deviceId: string;
  /** The credential generation the entry was made under. */
  readonly generation: number;
  readonly capability: DeviceCapability;
  /** The person chosen at the time (the server re-reads the name). */
  readonly actorUid: string;
  readonly actorName: string;
  readonly level: 'face';
  /** Capability-specific payload, validated by the server. */
  readonly intent: Readonly<Record<string, unknown>>;
  /** Undo intents: the original action and whether it was itself sent from this queue (R1). */
  readonly original: { readonly opId: string; readonly queued: boolean } | null;
  /** Device clock, ISO. */
  readonly createdAt: string;
  attempts: number;
  sendState: QueueSendState;
  lastError: DeviceRefusal | null;
  nextAttemptAt: number | null;
};

/** The only fields sync may change. */
export const SEND_FIELDS = ['attempts', 'sendState', 'lastError', 'nextAttemptAt'] as const;
type SendFields = Pick<QueuedDeviceAction, typeof SEND_FIELDS[number]>;

export const RETRY_BASE_MS = 5_000;
export const RETRY_CAP_MS = 5 * 60_000;
/** The Undo window on the device clock for an action sent live (UNDO_WINDOW_MS). */
export const LIVE_UNDO_WINDOW_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Backoff after a transient failure: 5 s doubling to 5 min. */
export const retryDelay = (attempts: number): number => Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

/**
 * Whether a capability may wait in the queue now: queueable in the policy and needing
 * only face level for this person under the household's points-PIN setting.
 */
export function queueAllowed(
  capability: DeviceCapability,
  context: { pointsPin: PointsPinPolicy; actorRole: HouseholdRole | null },
  undoProven: ReadonlySet<DeviceCapability> = UNDO_PROVEN,
): boolean {
  const policy = policyOf(capability);
  if (!policy.queueable) return false;
  return requiredLevel(capability, context, undoProven) === 'face';
}

const deepFreeze = <T,>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

export type NewQueuedAction = {
  opId: string;
  kind: 'action' | 'undo';
  householdId: string;
  deviceId: string;
  generation: number;
  capability: DeviceCapability;
  actorUid: string;
  actorName: string;
  intent: Record<string, unknown>;
  original?: { opId: string; queued: boolean } | null;
};

/** A new entry with a frozen copy of its intent. Throws on a malformed entry (a programming error). */
export function createQueuedAction(input: NewQueuedAction, now: Date): QueuedDeviceAction {
  if (!UUID.test(input.opId)) throw new Error('A queued action needs a UUID opId.');
  if (!isDeviceCapability(input.capability)) throw new Error('Unknown capability.');
  if (input.kind === 'undo' && (!input.original || !UUID.test(input.original.opId))) throw new Error('An Undo intent names its original opId.');
  const intent = deepFreeze(structuredClone(input.intent ?? {}));
  const original = input.original ? Object.freeze({ opId: input.original.opId.toLowerCase(), queued: Boolean(input.original.queued) }) : null;
  return {
    opId: input.opId.toLowerCase(),
    kind: input.kind,
    householdId: input.householdId,
    deviceId: input.deviceId,
    generation: input.generation,
    capability: input.capability,
    actorUid: input.actorUid,
    actorName: input.actorName,
    level: 'face',
    intent,
    original,
    createdAt: now.toISOString(),
    attempts: 0,
    sendState: 'pending',
    lastError: null,
    nextAttemptAt: null,
  };
}

/** The entry with new send fields; every other field is kept exactly (immutable intent). */
export function withSendFields(entry: QueuedDeviceAction, patch: Partial<SendFields>): QueuedDeviceAction {
  const next: QueuedDeviceAction = { ...entry };
  for (const key of SEND_FIELDS) {
    if (key in patch) (next as Record<string, unknown>)[key] = patch[key];
  }
  return next;
}

/** The tablet session an entry belongs to: the household, the device record and the credential generation. */
export type QueueSession = { householdId: string; deviceId: string; generation: number };

/**
 * An entry belongs to this session only when household, device and generation all match.
 * Generations restart at 1 for every new pairing, so the generation alone never identifies
 * the session: an entry left by another device record (even in the same household) is
 * discarded unsent.
 */
export const belongsToSession = (entry: Pick<QueuedDeviceAction, 'householdId' | 'deviceId' | 'generation'>, session: QueueSession): boolean =>
  entry.householdId === session.householdId && entry.deviceId === session.deviceId && entry.generation === session.generation;

/** Never sent: it can be dropped locally without the server ever knowing it. */
export const neverSent = (entry: QueuedDeviceAction): boolean => entry.attempts === 0 && entry.sendState === 'pending';

export const syncOrder = (entries: readonly QueuedDeviceAction[]): QueuedDeviceAction[] =>
  [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.opId.localeCompare(b.opId));

/**
 * A sync answer. `reason` (plain words, lower case, ending with a full stop) explains a
 * domain refusal the server answered successfully (for example "that chore isn't due yet."),
 * so the dropped-change notice can say why.
 */
export type SendResult = { ok: true } | { ok: false; code: DeviceRefusal; reason?: string };
export type QueueSender = (entry: QueuedDeviceAction) => Promise<SendResult>;

export type SyncOutcome = 'delete' | 'revoked' | 'drop' | 'retry';

const REVOKED: ReadonlySet<DeviceRefusal> = new Set(['device_revoked', 'wrong_household', 'household_deleting', 'unauthenticated', 'not_a_device']);
const TRANSIENT: ReadonlySet<DeviceRefusal> = new Set(['unavailable', 'rate_limited', 'busy', 'failed']);

/**
 * What a sync answer means for the entry (11.3): success, an idempotent replay,
 * `already_undone` and an Undo of something never applied delete it; a revocation code
 * stops sync and runs the revocation flow (the whole queue is discarded); an actor,
 * permission, section, level or staleness refusal drops it with one plain notice; an
 * outage keeps it for a retry with backoff.
 */
export function classifySyncResult(result: SendResult): SyncOutcome {
  if (result.ok) return 'delete';
  if (result.code === 'already_undone') return 'delete';
  if (REVOKED.has(result.code)) return 'revoked';
  if (TRANSIENT.has(result.code)) return 'retry';
  return 'drop';
}

const ACTION_WORDS: Partial<Record<DeviceCapability, string>> = {
  'pets.feed': 'feed pets',
  'pets.feed.backdated': 'feed pets',
  'pets.dose.give': 'give doses',
  'pets.care.add': 'log pet care',
  'pets.note.add': 'add pet notes',
  'pets.weight.add': 'log pet weights',
  'chores.complete': 'tick chores',
  'chores.take': 'take chores',
  'notifications.dismiss': 'dismiss notices',
};

/** The one plain notice for dropped entries ("1 change from this tablet couldn't be saved: …"). */
export function dropNotice(dropped: ReadonlyArray<{ entry: QueuedDeviceAction; code: DeviceRefusal; reason?: string }>): string | null {
  if (dropped.length === 0) return null;
  const count = dropped.length === 1 ? '1 change' : `${dropped.length} changes`;
  const first = dropped[0];
  const name = first.entry.actorName.trim() || 'Someone';
  const what = ACTION_WORDS[first.entry.capability] ?? 'do that';
  const reason = first.reason ?? (() => {
    switch (first.code) {
      case 'actor_not_member':
      case 'actor_inactive':
      case 'actor_guest':
      case 'forbidden':
        return `${name} can no longer ${what} here.`;
      case 'section_off':
        return "that part of HomeHub isn't on this tablet any more.";
      case 'pin_required':
      case 'pin_session_invalid':
      case 'pin_fresh_required':
      case 'no_pin_set':
        return 'it now needs a PIN.';
      case 'stale_intent':
        return 'it waited too long to sync.';
      case 'undo_expired':
        return 'it was too late to undo.';
      case 'changed_since':
      case 'not_undoable':
        return 'it changed since, so it was not undone.';
      default:
        return 'HomeHub refused it.';
    }
  })();
  return `${count} from this tablet couldn't be saved: ${reason}`;
}

export type UndoPlan =
  /** Never sent: removed from the queue together with its Undo; the server never knew. */
  | { kind: 'remove-locally' }
  /** Send the Undo intent by opId now. */
  | { kind: 'send'; originalQueued: boolean }
  /** Offline: queue the Undo intent (the server's tombstone makes the order irrelevant). */
  | { kind: 'queue'; originalQueued: boolean }
  | { kind: 'refuse'; code: 'undo_expired' };

/**
 * How to undo an action (10.3, R1). `queued` is the action's queue entry, if it is still
 * there; `sentAt` the device time a live action was answered. An Undo is always sent to
 * the server by opId unless the action never left the tablet. R1: an Undo is accepted late
 * only when the original was itself a queued replay, so for an action sent live the device
 * clock never extends the 10 s window.
 */
export function planUndo(input: {
  queued: QueuedDeviceAction | undefined;
  /** The original was sent from the queue (now or earlier). */
  originalViaQueue: boolean;
  /** Live actions: device time the server answered (or the send started, if unanswered). */
  sentAt: number | null;
  online: boolean;
  now: number;
}): UndoPlan {
  if (input.queued && neverSent(input.queued)) return { kind: 'remove-locally' };
  const originalQueued = Boolean(input.queued) || input.originalViaQueue;
  if (!originalQueued && input.sentAt !== null && input.now - input.sentAt > LIVE_UNDO_WINDOW_MS) return { kind: 'refuse', code: 'undo_expired' };
  return input.online ? { kind: 'send', originalQueued } : { kind: 'queue', originalQueued };
}

// ---------------------------------------------------------------------------
// Store operations (each under the queue lock)
// ---------------------------------------------------------------------------

type Lock = <R>(work: () => Promise<R>) => Promise<R>;
const defaultLock: Lock = (work) => withQueueLock(work);

/** Writes a new entry durably. Resolves only once stored (the UI then says "will sync"). */
export async function enqueue(store: RecordStore<QueuedDeviceAction>, entry: QueuedDeviceAction, lock: Lock = defaultLock): Promise<void> {
  await lock(async () => {
    if (await store.get(entry.opId)) throw new Error('That change is already queued.');
    await store.put(entry);
  });
}

/** Removes an entry only while it has never been sent. Returns whether it was removed. */
export async function removeIfNeverSent(store: RecordStore<QueuedDeviceAction>, opId: string, lock: Lock = defaultLock): Promise<boolean> {
  return lock(async () => {
    const entry = await store.get(opId.toLowerCase());
    if (!entry || !neverSent(entry)) return false;
    await store.delete(entry.opId);
    return true;
  });
}

export type SyncReport = {
  sent: number;
  deleted: number;
  /** Discarded unsent: made under another household, device record or credential generation. */
  discarded: number;
  dropped: Array<{ entry: QueuedDeviceAction; code: DeviceRefusal; reason?: string }>;
  /** A revocation code was answered: the caller runs the revocation flow. */
  revoked: boolean;
  /** Entries still waiting (backoff or after a transient failure). */
  waiting: number;
};

/**
 * Sends the queue oldest first (11.3). Entries of another session (household, device or
 * generation) are deleted unsent. Each entry is marked in flight (attempts + 1)
 * durably before it is sent, so a crash mid-send leaves it uncertain, and its resend
 * reuses the same opId (the server replays it). Stops at the first entry still in
 * backoff or failing transiently, so later entries never overtake it.
 */
export async function syncQueue(deps: {
  store: RecordStore<QueuedDeviceAction>;
  send: QueueSender;
  session: QueueSession;
  now: () => number;
  lock?: Lock;
}): Promise<SyncReport> {
  const lock = deps.lock ?? defaultLock;
  return lock(async () => {
    const report: SyncReport = { sent: 0, deleted: 0, discarded: 0, dropped: [], revoked: false, waiting: 0 };
    const entries = syncOrder(await deps.store.all());
    let stopped = false;
    for (const stored of entries) {
      if (!belongsToSession(stored, deps.session)) {
        await deps.store.delete(stored.opId);
        report.discarded += 1;
        continue;
      }
      if (stopped) {
        report.waiting += 1;
        continue;
      }
      if (stored.nextAttemptAt !== null && stored.nextAttemptAt > deps.now()) {
        stopped = true;
        report.waiting += 1;
        continue;
      }
      const inflight = withSendFields(stored, { attempts: stored.attempts + 1, sendState: 'inflight' });
      await deps.store.put(inflight);
      let result: SendResult;
      try {
        result = await deps.send(inflight);
      } catch {
        // No answer: it may or may not have reached the server.
        result = { ok: false, code: 'failed' };
      }
      report.sent += 1;
      const outcome = classifySyncResult(result);
      if (outcome === 'delete') {
        await deps.store.delete(inflight.opId);
        report.deleted += 1;
      } else if (outcome === 'drop') {
        await deps.store.delete(inflight.opId);
        const refused = result as { code: DeviceRefusal; reason?: string };
        report.dropped.push({ entry: inflight, code: refused.code, ...(refused.reason ? { reason: refused.reason } : {}) });
      } else if (outcome === 'revoked') {
        report.revoked = true;
        return report;
      } else {
        await deps.store.put(withSendFields(inflight, {
          sendState: 'uncertain',
          lastError: (result as { code: DeviceRefusal }).code,
          nextAttemptAt: deps.now() + retryDelay(inflight.attempts),
        }));
        stopped = true;
        report.waiting += 1;
      }
    }
    return report;
  });
}
