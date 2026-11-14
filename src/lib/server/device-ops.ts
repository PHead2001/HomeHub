import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { undoAccepts, type DeviceCapability } from '@/lib/devices/action-policy';
import { DeviceActionError } from '@/lib/server/device-errors';
import { queuedUndoInTime } from '@/lib/devices/queued-undo';

// The server op ledger (docs/modules/devices/README.md, "Undo, idempotency and the op
// ledger"; design B1): `households/{h}/devices/{d}/ops/{opId}`, written only by the
// server inside the action's own transaction (DeviceTxHooks.finalize), read by the
// next attempt with the same opId (DeviceTxHooks.precheck). Clients read nothing under
// `devices/*/`. Replays return the stored summary; Undo leaves the entry `undone` (or a
// tombstone when the Undo arrives first), so a late retry can never bring an undone
// action back. Times are the server's clock, stored in the action's transaction:
// Admin SDK transactions return no commit time, so nothing is read back afterwards.

export const OP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The Undo window (16.3) and the server's latency grace (JC-16). */
export const UNDO_WINDOW_MS = 10_000;
export const UNDO_GRACE_MS = 5_000;
/**
 * R1: an Undo sent from the tablet's offline queue for an action that was itself a queued
 * replay is accepted up to this long after the action's stored `appliedAt` (server time).
 * Device clocks never extend a window on their own.
 */
export const QUEUED_UNDO_WINDOW_MS = 10 * 60_000;

export type DeviceOpState = 'applied' | 'undone';

export type DeviceOp = {
  capability: DeviceCapability | string;
  actorUid: string;
  generation: number;
  targetPath: string | null;
  state: DeviceOpState;
  appliedAt: Timestamp | null;
  undoneAt: Timestamp | null;
  tombstone: boolean;
  summary: Record<string, unknown>;
  deviceCreatedAt: string | null;
  expireAt: Timestamp;
};

/** What a replay returns: the stored result, marked idempotent. */
export type DeviceOpReplay = { idempotent: true; summary: Record<string, unknown>; targetPath: string | null };

export const opRef = (householdRef: FirebaseFirestore.DocumentReference, deviceId: string, opId: string) =>
  householdRef.collection('devices').doc(deviceId).collection('ops').doc(opId);

export const readDeviceOp = (snapshot: FirebaseFirestore.DocumentSnapshot): DeviceOp | null => {
  if (!snapshot.exists) return null;
  const data = snapshot.data() || {};
  return {
    capability: typeof data.capability === 'string' ? data.capability : '',
    actorUid: typeof data.actorUid === 'string' ? data.actorUid : '',
    generation: typeof data.generation === 'number' ? data.generation : 0,
    targetPath: typeof data.targetPath === 'string' ? data.targetPath : null,
    state: data.state === 'undone' ? 'undone' : 'applied',
    appliedAt: data.appliedAt instanceof Timestamp ? data.appliedAt : null,
    undoneAt: data.undoneAt instanceof Timestamp ? data.undoneAt : null,
    tombstone: data.tombstone === true,
    summary: data.summary && typeof data.summary === 'object' ? data.summary as Record<string, unknown> : {},
    deviceCreatedAt: typeof data.deviceCreatedAt === 'string' ? data.deviceCreatedAt : null,
    expireAt: data.expireAt instanceof Timestamp ? data.expireAt : Timestamp.fromMillis(0),
  };
};

/** Does a ledger entry record an action this Undo capability reverses (`UNDO_OF`, no prefixes)? */
export const undoMatches = (undoCapability: DeviceCapability, entry: DeviceOp): boolean =>
  undoAccepts(undoCapability, entry.capability);

/**
 * An action's attempt against its ledger entry: none → apply; `applied` by the same
 * capability, actor and credential generation → replay (write nothing); `applied` by
 * anything else → `conflict`; `undone` (tombstones included) → `already_undone`.
 */
export const classifyActionAttempt = (
  entry: DeviceOp | null,
  attempt: { capability: DeviceCapability; actorUid: string; generation: number },
): { kind: 'apply' } | { kind: 'replay'; replay: DeviceOpReplay } => {
  if (!entry) return { kind: 'apply' };
  // A tombstone records the Undo capability that wrote it: only an action that Undo
  // reverses is "already undone"; anything else under the same opId is a conflict.
  if (entry.tombstone && !undoAccepts(entry.capability, attempt.capability)) throw new DeviceActionError('conflict');
  // A tombstone suppresses only the original of the same actor at the same credential
  // generation; anything else under that opId is a conflict.
  if (entry.tombstone && (entry.actorUid !== attempt.actorUid || entry.generation !== attempt.generation)) {
    throw new DeviceActionError('conflict');
  }
  if (entry.state === 'undone') throw new DeviceActionError('already_undone');
  if (entry.capability !== attempt.capability || entry.actorUid !== attempt.actorUid || entry.generation !== attempt.generation) {
    throw new DeviceActionError('conflict');
  }
  return { kind: 'replay', replay: { idempotent: true, summary: entry.summary, targetPath: entry.targetPath } };
};

/**
 * An Undo against the original's ledger entry: none → write a tombstone (the original,
 * if it arrives later, is refused); `undone` → already; `applied` → the operation runs
 * `assertUndoable` and reverses only the action's own effect.
 */
export const classifyUndoAttempt = (
  entry: DeviceOp | null,
  undoCapability: DeviceCapability,
): { kind: 'tombstone' } | { kind: 'already' } | { kind: 'applied'; entry: DeviceOp } => {
  if (!entry) return { kind: 'tombstone' };
  // The same Undo arriving again after its own tombstone.
  if (entry.tombstone) {
    if (entry.capability === undoCapability) return { kind: 'already' };
    throw new DeviceActionError('conflict');
  }
  if (!undoMatches(undoCapability, entry)) throw new DeviceActionError('conflict');
  if (entry.state === 'undone') return { kind: 'already' };
  return { kind: 'applied', entry };
};

/** `serverNow ≤ appliedAt + 10 s + 5 s grace`; `appliedAt` is the stored server time. */
export const undoWindowOpen = (appliedAt: Timestamp | null, now: Date, options: { queuedReplay?: boolean } = {}): boolean =>
  Boolean(appliedAt) && now.getTime() <= appliedAt!.toMillis() + (options.queuedReplay ? QUEUED_UNDO_WINDOW_MS : UNDO_WINDOW_MS + UNDO_GRACE_MS);

/**
 * The checks every Undo of an `applied` entry makes inside its transaction: the entry
 * was written by this device at its current credential generation, the actor is the
 * original one (or `actorRuleAllows`, e.g. a PIN holder with pets.deleteLogs), and the
 * window is open.
 */
export const assertUndoable = (
  entry: DeviceOp,
  context: { generation: number; actorUid: string; now: Date; actorRuleAllows?: boolean; queuedUndo?: boolean; queuedUndoCreatedAt?: string | null },
) => {
  if (entry.generation !== context.generation) throw new DeviceActionError('not_undoable');
  if (entry.actorUid !== context.actorUid && !context.actorRuleAllows) throw new DeviceActionError('forbidden');
  // R1: the longer window only when this Undo came from the queue, the action it reverses
  // was itself a queued replay (its ledger entry carries the device's creation time), and
  // the Undo was made within 15 s of that action on the same device clock (JC-17).
  const queuedReplay = Boolean(context.queuedUndo) && entry.deviceCreatedAt !== null && queuedUndoInTime(entry.deviceCreatedAt, context.queuedUndoCreatedAt);
  if (!undoWindowOpen(entry.appliedAt, context.now, { queuedReplay })) throw new DeviceActionError('undo_expired');
};

/** A record the action created is unchanged since: no write after its creation. */
export const createdRecordUnchanged = (snapshot: FirebaseFirestore.DocumentSnapshot): boolean =>
  Boolean(snapshot.exists && snapshot.createTime && snapshot.updateTime && snapshot.updateTime.isEqual(snapshot.createTime));

export const appliedEntry = (input: {
  capability: DeviceCapability;
  actorUid: string;
  generation: number;
  targetPath: string;
  summary: Record<string, unknown>;
  deviceCreatedAt: string | null;
  now: Date;
}): DeviceOp => ({
  capability: input.capability,
  actorUid: input.actorUid,
  generation: input.generation,
  targetPath: input.targetPath,
  state: 'applied',
  appliedAt: Timestamp.fromDate(input.now),
  undoneAt: null,
  tombstone: false,
  summary: input.summary,
  deviceCreatedAt: input.deviceCreatedAt,
  expireAt: Timestamp.fromMillis(input.now.getTime() + OP_TTL_MS),
});

export const tombstoneEntry = (input: {
  undoCapability: DeviceCapability;
  actorUid: string;
  generation: number;
  deviceCreatedAt: string | null;
  now: Date;
}): DeviceOp => ({
  // The Undo capability itself, so a later action is matched through UNDO_OF.
  capability: input.undoCapability,
  actorUid: input.actorUid,
  generation: input.generation,
  targetPath: null,
  state: 'undone',
  appliedAt: null,
  undoneAt: Timestamp.fromDate(input.now),
  tombstone: true,
  summary: {},
  deviceCreatedAt: input.deviceCreatedAt,
  expireAt: Timestamp.fromMillis(input.now.getTime() + OP_TTL_MS),
});

export const undoneUpdate = (now: Date) => ({
  state: 'undone' as const,
  undoneAt: Timestamp.fromDate(now),
  expireAt: Timestamp.fromMillis(now.getTime() + OP_TTL_MS),
});
