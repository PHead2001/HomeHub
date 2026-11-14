import 'server-only';

import { randomUUID, randomBytes } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/firebase-admin';
import { rank } from '@/lib/household-policy';
import { POINTS_PIN_POLICIES, readPointsPinPolicy, type PointsPinPolicy } from '@/lib/devices/action-policy';
import {
  DEVICE_FAILURES_BEFORE_LOCK,
  TABLET_LOCKS_ALERT_COUNT,
  PIN_SESSION_IDLE_MS,
  clearedDeviceGuard,
  clearedMemberGuard,
  emptyDeviceGuard,
  emptyMemberGuard,
  reserveDeviceGuard,
  reserveMemberGuard,
  settleDeviceGuardCorrect,
  settleMemberGuardCorrect,
  validatePinFormat,
  repeatTabletLockAlertDue,
  type DeviceGuard,
  type MemberGuard,
  type MemberLockReason,
} from '@/lib/devices/pins';
import type { HouseholdRole } from '@/lib/types';
import { readDeviceSettings } from '@/lib/devices/settings';
import { deviceUid } from '@/lib/devices/types';
import { notificationAudience } from '@functions/shared/notification-audience';
import { devicesEnabled } from '@/lib/server/device-identity';
import { takeRateSlot } from '@/lib/server/device-management';
import { writeDeviceAudit } from '@/lib/server/device-audit';
import { DeviceActionError } from '@/lib/server/device-errors';
import {
  checkActorEligible,
  checkHouseholdAndRecord,
  deviceGuardRef,
  deviceRecordRef,
  endPinSessionRecord,
  hasPin,
  householdRefOf,
  memberGuardRef,
  pinRecordRef,
  pinSessionRef,
  publicName,
  preAuthAddressLimit,
  preAuthInstanceLimit,
  takeDeviceBudget,
  verifyDeviceToken,
} from '@/lib/server/device-gate';
import {
  PIN_SCRYPT_PARAMS,
  currentPepperId,
  hashPinValue,
  hashesEqual,
  newPinSalt,
  pepperFor,
  readPinParams,
} from '@/lib/server/pin-hash';
import type { VerifiedCaller } from '@/lib/server/household-membership';

// Tablet PINs (docs/modules/devices/README.md, "PINs"): setting and clearing them from
// personal sessions under the WT-17 authority matrix, lockout clearing, verification
// from a tablet with pessimistic counting and per-attempt ids (re-review R2), and PIN
// sessions. The PIN value is never logged, returned, stored in activity details or kept
// after hashing; `private/pin` and `private/pinGuard` are unreadable to every client.

type Tx = FirebaseFirestore.Transaction;
type DocRef = FirebaseFirestore.DocumentReference;
type Snap = FirebaseFirestore.DocumentSnapshot;

export type PinRefusal =
  | 'unauthenticated'
  | 'unavailable'
  | 'invalid_input'
  | 'not_found'
  | 'not_member'
  | 'forbidden'
  | 'household_deleting'
  | 'pin_unavailable'
  | 'busy'
  | 'failed';

export class PinError extends Error {
  constructor(readonly code: PinRefusal, message?: string) {
    super(message ?? code);
    this.name = 'PinError';
  }
}

const MEMBERS_LINK = '/household?tab=members';
const NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const requireFlag = () => {
  if (!devicesEnabled()) throw new PinError('unavailable', "Tablet PINs aren't available yet.");
};

const requireId = (value: unknown, message = 'That household or person was not found.'): string => {
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('/')) throw new PinError('invalid_input', message);
  return value;
};

// ---------------------------------------------------------------------------
// Hash work: separate pools per server instance, so PIN changes can never starve
// verification. A slot is held only around the scrypt call itself.
// ---------------------------------------------------------------------------

/** scrypt computations at once for verification, and for setting PINs. */
export const PIN_HASH_CONCURRENCY = 4;
export const PIN_SET_HASH_CONCURRENCY = 2;
/** PIN sets admitted at once per instance (running and waiting for a slot). */
export const PIN_SET_ADMISSION = 6;
/** Verifications admitted at once (waiting for a hash slot included); beyond this: `busy`. */
export const PIN_VERIFY_ADMISSION_FACTOR = 2;
/** PIN sets per person per minute (personal sessions). */
export const PIN_SET_LIMIT_PER_MINUTE = 10;

type Pool = { running: number; admitted: number; waiters: Array<() => void> };
type SlotState = typeof globalThis & { __homeHubPinPools?: { verify: Pool; set: Pool }; __homeHubPinInflight?: Set<string> };
const slotState = globalThis as SlotState;
const pools = slotState.__homeHubPinPools || {
  verify: { running: 0, admitted: 0, waiters: [] },
  set: { running: 0, admitted: 0, waiters: [] },
};
slotState.__homeHubPinPools = pools;
const inflight = slotState.__homeHubPinInflight || new Set<string>();
slotState.__homeHubPinInflight = inflight;

/** Runs `work` holding one of the pool's `limit` slots, waiting for one if needed. */
const withPoolSlot = async <T>(pool: Pool, limit: number, work: () => Promise<T>): Promise<T> => {
  while (pool.running >= limit) await new Promise<void>(resolve => pool.waiters.push(resolve));
  pool.running += 1;
  try {
    return await work();
  } finally {
    pool.running -= 1;
    pool.waiters.shift()?.();
  }
};

type StoredHash = { hash: string; salt: string; params: typeof PIN_SCRYPT_PARAMS; pepperId: string };

/** Hashes a new PIN with the current pepper (set pool); fails closed without one. */
const hashNewPin = async (pin: string): Promise<StoredHash> => {
  const pepperId = currentPepperId();
  const pepper = pepperId ? pepperFor(pepperId) : null;
  if (!pepperId || !pepper) throw new PinError('pin_unavailable', "PINs aren't working right now. Try again later.");
  // Running and waiting callers together are bounded; beyond that the answer is `busy`.
  if (pools.set.admitted >= PIN_SET_ADMISSION) throw new PinError('busy', 'One moment, try again.');
  pools.set.admitted += 1;
  try {
    const salt = newPinSalt();
    const hash = await withPoolSlot(pools.set, PIN_SET_HASH_CONCURRENCY, () => hashPinValue(pin, salt, pepper));
    return { hash: hash.toString('base64'), salt: salt.toString('base64'), params: PIN_SCRYPT_PARAMS, pepperId };
  } finally {
    pools.set.admitted -= 1;
  }
};

// ---------------------------------------------------------------------------
// Personal-session PIN management (WT-9a/b, WT-17)
// ---------------------------------------------------------------------------

type MemberView = { uid: string; role: HouseholdRole; status: string; kind: 'account' | 'identity'; name: string };

const memberView = (snap: Snap): MemberView | null => {
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    uid: snap.id,
    role: (['owner', 'admin', 'member', 'child', 'guest', 'newuser'].includes(data.role) ? data.role : 'newuser') as HouseholdRole,
    status: typeof data.status === 'string' ? data.status : 'active',
    kind: data.kind === 'identity' ? 'identity' : 'account',
    name: publicName(data.displayName),
  };
};

const isOwnerOrAdmin = (member: MemberView) => member.status === 'active' && (member.role === 'owner' || member.role === 'admin');

type CallerContext = { householdRef: DocRef; caller: MemberView };

/** The household (exists, not deleting) and the caller's own active membership, in the transaction. */
const loadCaller = async (tx: Tx, caller: VerifiedCaller, householdId: unknown): Promise<CallerContext> => {
  const householdRef = householdRefOf(requireId(householdId));
  const [household, member] = await Promise.all([tx.get(householdRef), tx.get(householdRef.collection('members').doc(caller.uid))]);
  if (!household.exists) throw new PinError('not_found', 'That household no longer exists.');
  if (household.get('deletingAt')) throw new PinError('household_deleting', 'This household is being deleted.');
  const view = memberView(member);
  if (!view || view.status !== 'active' || view.role === 'newuser') throw new PinError('not_member', 'You are not part of this household.');
  return { householdRef, caller: view };
};

const loadTarget = async (tx: Tx, householdRef: DocRef, targetUid: unknown): Promise<MemberView> => {
  const uid = requireId(targetUid, 'That person is no longer in this household.');
  const view = memberView(await tx.get(householdRef.collection('members').doc(uid)));
  if (!view || view.status !== 'active' || view.role === 'newuser') throw new PinError('not_found', 'That person is no longer in this household.');
  return view;
};

/**
 * The PIN document after a set: a new hash, `pinVersion + 1`, and a new random `pinId`
 * (every session of this person ends). `pinVersion` restarts at 1 when the document was
 * deleted (leaving, removal), so sessions are bound to `pinId`, which is never reused.
 */
const pinSetDoc = (stored: StoredHash, previous: Snap, by: string, how: 'self' | 'admin-for-child', now: Date) => ({
  pinId: randomUUID(),
  hash: stored.hash,
  salt: stored.salt,
  params: stored.params,
  pepperId: stored.pepperId,
  pinVersion: (typeof previous.get('pinVersion') === 'number' ? previous.get('pinVersion') as number : 0) + 1,
  setAt: Timestamp.fromDate(now),
  setByUid: by,
  setHow: how,
});

/** A clear keeps `pinVersion` (bumped), so sessions stay invalid. */
const pinClearDoc = (previous: Snap, by: string, now: Date) => ({
  pinId: null,
  hash: null,
  salt: null,
  params: null,
  pepperId: null,
  pinVersion: (typeof previous.get('pinVersion') === 'number' ? previous.get('pinVersion') as number : 0) + 1,
  clearedAt: Timestamp.fromDate(now),
  clearedByUid: by,
});

/** At most PIN_SET_LIMIT_PER_MINUTE PIN sets a minute per person (each costs a hash). */
const requireSetBudget = (caller: VerifiedCaller, now: Date) => {
  if (!takeRateSlot(`pin-set:${caller.uid}`, PIN_SET_LIMIT_PER_MINUTE, now.getTime())) {
    throw new PinError('busy', 'Too many PIN changes in a row. Try again in a minute.');
  }
};

const requirePinFormat = (pin: unknown): string => {
  const format = validatePinFormat(pin);
  if (!format.ok) throw new PinError('invalid_input', format.message);
  return pin as string;
};

/** Who may set their own PIN: an active owner, admin, member or child with an account. Guests may not. */
const requireOwnPinAllowed = (caller: MemberView) => {
  if (caller.role === 'guest') throw new PinError('forbidden', "Guests can't use tablet PINs.");
  if (caller.kind === 'identity') throw new PinError('forbidden', "Kid profiles can't sign in.");
};

/** Read-only pre-check so an unauthorized caller never costs a hash. */
const precheckOutsideTx = async (run: (tx: Tx) => Promise<unknown>) => {
  await adminDb.runTransaction(run, { readOnly: true });
};

/**
 * Set or change your own PIN from your own signed-in session (no old PIN needed: the
 * session is the proof). Ends your PIN sessions on every tablet.
 */
export const setMyPin = async (caller: VerifiedCaller, input: { householdId: unknown; pin: unknown }, now = new Date()) => {
  requireFlag();
  const pin = requirePinFormat(input?.pin);
  requireSetBudget(caller, now);
  await precheckOutsideTx(async tx => requireOwnPinAllowed((await loadCaller(tx, caller, input?.householdId)).caller));
  const stored = await hashNewPin(pin);
  await adminDb.runTransaction(async tx => {
    const context = await loadCaller(tx, caller, input?.householdId);
    requireOwnPinAllowed(context.caller);
    const ref = pinRecordRef(context.householdRef, caller.uid);
    const previous = await tx.get(ref);
    tx.set(ref, pinSetDoc(stored, previous, caller.uid, 'self', now));
    writeDeviceAudit(tx, context.householdRef, {
      action: 'pin.set', actorUid: caller.uid, actorName: context.caller.name, via: 'profile',
      targetUid: caller.uid, targetName: context.caller.name, details: { how: 'self' },
    }, now);
  });
  return { set: true };
};

/**
 * Clear an account member's PIN: yourself, or an owner/admin (role) for someone of
 * strictly lower rank (never set: WT-17a/b). The owner's PIN only by the owner (WT-17c).
 * Kid profiles are cleared through the same rule (they rank as Child).
 */
export const clearMemberPin = async (caller: VerifiedCaller, input: { householdId: unknown; targetUid: unknown }, now = new Date()) => {
  requireFlag();
  return adminDb.runTransaction(async tx => {
    const context = await loadCaller(tx, caller, input?.householdId);
    const target = await loadTarget(tx, context.householdRef, input?.targetUid);
    const self = target.uid === caller.uid;
    if (!self) {
      if (!isOwnerOrAdmin(context.caller)) throw new PinError('forbidden', 'Only owners and admins can clear PINs.');
      if (rank(context.caller.role) <= rank(target.role)) throw new PinError('forbidden', 'You can only clear the PIN of someone with a lower role than yours.');
    }
    const ref = pinRecordRef(context.householdRef, target.uid);
    const previous = await tx.get(ref);
    if (!hasPin(previous)) return { cleared: false };
    tx.set(ref, pinClearDoc(previous, caller.uid, now));
    writeDeviceAudit(tx, context.householdRef, {
      action: 'pin.cleared', actorUid: caller.uid, actorName: context.caller.name, via: self ? 'profile' : 'members',
      targetUid: target.uid, targetName: target.name,
    }, now);
    return { cleared: true };
  });
};

const requireChildIdentity = (target: MemberView) => {
  if (target.kind !== 'identity') {
    throw new PinError('forbidden', 'Only kid profiles get a PIN from someone else. Everyone with an account sets their own from their phone.');
  }
};

/** Set or change a kid profile's PIN (owner/admin role, from their own session; WT-9b, WT-17d). */
export const setChildPin = async (caller: VerifiedCaller, input: { householdId: unknown; childId: unknown; pin: unknown }, now = new Date()) => {
  requireFlag();
  const pin = requirePinFormat(input?.pin);
  requireSetBudget(caller, now);
  const authorize = async (tx: Tx) => {
    const context = await loadCaller(tx, caller, input?.householdId);
    if (!isOwnerOrAdmin(context.caller)) throw new PinError('forbidden', 'Only owners and admins can set kid profile PINs.');
    const target = await loadTarget(tx, context.householdRef, input?.childId);
    requireChildIdentity(target);
    return { context, target };
  };
  await precheckOutsideTx(authorize);
  const stored = await hashNewPin(pin);
  await adminDb.runTransaction(async tx => {
    const { context, target } = await authorize(tx);
    const ref = pinRecordRef(context.householdRef, target.uid);
    const previous = await tx.get(ref);
    tx.set(ref, pinSetDoc(stored, previous, caller.uid, 'admin-for-child', now));
    writeDeviceAudit(tx, context.householdRef, {
      action: 'pin.set', actorUid: caller.uid, actorName: context.caller.name, via: 'members',
      targetUid: target.uid, targetName: target.name, details: { how: 'admin-for-child' },
    }, now);
  });
  return { set: true };
};

/** Clear a kid profile's PIN (owner/admin role). */
export const clearChildPin = async (caller: VerifiedCaller, input: { householdId: unknown; childId: unknown }, now = new Date()) => {
  requireFlag();
  return adminDb.runTransaction(async tx => {
    const context = await loadCaller(tx, caller, input?.householdId);
    if (!isOwnerOrAdmin(context.caller)) throw new PinError('forbidden', 'Only owners and admins can clear kid profile PINs.');
    const target = await loadTarget(tx, context.householdRef, input?.childId);
    requireChildIdentity(target);
    const ref = pinRecordRef(context.householdRef, target.uid);
    const previous = await tx.get(ref);
    if (!hasPin(previous)) return { cleared: false };
    tx.set(ref, pinClearDoc(previous, caller.uid, now));
    writeDeviceAudit(tx, context.householdRef, {
      action: 'pin.cleared', actorUid: caller.uid, actorName: context.caller.name, via: 'members',
      targetUid: target.uid, targetName: target.name,
    }, now);
    return { cleared: true };
  });
};

/**
 * Clear a PIN lockout (the hard lock across tablets and every tablet's backoff): the
 * person themselves, or an owner/admin (role) above the target's rank.
 */
export const clearPinLockout = async (caller: VerifiedCaller, input: { householdId: unknown; targetUid: unknown }, now = new Date()) => {
  requireFlag();
  return adminDb.runTransaction(async tx => {
    const context = await loadCaller(tx, caller, input?.householdId);
    const target = await loadTarget(tx, context.householdRef, input?.targetUid);
    const self = target.uid === caller.uid;
    if (!self && (!isOwnerOrAdmin(context.caller) || rank(context.caller.role) <= rank(target.role))) {
      throw new PinError('forbidden', 'You can only unlock the PIN of someone with a lower role than yours.');
    }
    const devices = await tx.get(context.householdRef.collection('devices'));
    const guardRefs = devices.docs.map(d => deviceGuardRef(context.householdRef, d.id, target.uid));
    const [memberGuard, ...deviceGuards] = await Promise.all([
      tx.get(memberGuardRef(context.householdRef, target.uid)),
      ...guardRefs.map(ref => tx.get(ref)),
    ]);
    // Emptied, but each keeps its sequence number (an attempt in flight stays ordered).
    if (memberGuard.exists) tx.set(memberGuard.ref, storeMemberGuard(clearedMemberGuard(readMemberGuard(memberGuard))));
    deviceGuards.filter(g => g.exists).forEach(g => tx.set(g.ref, storeDeviceGuard(clearedDeviceGuard(readDeviceGuard(g)))));
    writeDeviceAudit(tx, context.householdRef, {
      action: 'pin.lockout_cleared', actorUid: caller.uid, actorName: context.caller.name, via: self ? 'profile' : 'members',
      targetUid: target.uid, targetName: target.name,
    }, now);
    return { cleared: true };
  });
};

export type PinStatus = { hasPin: boolean; locked: boolean };

/**
 * Whether people have a PIN and whether it is hard-locked (never any PIN material):
 * owners and admins see everyone; anyone else only themselves.
 */
export const pinStatuses = async (caller: VerifiedCaller, input: { householdId: unknown }): Promise<Record<string, PinStatus>> => {
  requireFlag();
  return adminDb.runTransaction(async tx => {
    const context = await loadCaller(tx, caller, input?.householdId);
    const uids = isOwnerOrAdmin(context.caller)
      ? (await tx.get(context.householdRef.collection('members'))).docs.map(d => d.id)
      : [caller.uid];
    const snaps = await Promise.all(uids.flatMap(uid => [tx.get(pinRecordRef(context.householdRef, uid)), tx.get(memberGuardRef(context.householdRef, uid))]));
    return Object.fromEntries(uids.map((uid, index) => [uid, {
      hasPin: hasPin(snaps[index * 2]),
      locked: Boolean(snaps[index * 2 + 1].get('lockedAt')),
    }]));
  }, { readOnly: true });
};

/** The household's points-PIN setting (WT-9d, WT-22, D-T10): owners and admins (role). */
export const updatePointsPinPolicy = async (caller: VerifiedCaller, input: { householdId: unknown; pointsPin: unknown }, now = new Date()) => {
  requireFlag();
  if (!POINTS_PIN_POLICIES.includes(input?.pointsPin as PointsPinPolicy)) throw new PinError('invalid_input', 'Choose Off, Kids only or Everyone.');
  const pointsPin = input.pointsPin as PointsPinPolicy;
  return adminDb.runTransaction(async tx => {
    const context = await loadCaller(tx, caller, input?.householdId);
    if (!isOwnerOrAdmin(context.caller)) throw new PinError('forbidden', 'Only owners and admins can change this.');
    const household = await tx.get(context.householdRef);
    const previous = readPointsPinPolicy(household.data());
    if (previous === pointsPin) return { pointsPin };
    tx.update(context.householdRef, {
      'devicePolicy.pointsPin': pointsPin,
      'devicePolicy.updatedAt': Timestamp.fromDate(now),
      'devicePolicy.updatedByUid': caller.uid,
    });
    writeDeviceAudit(tx, context.householdRef, {
      action: 'device.policy_changed', actorUid: caller.uid, actorName: context.caller.name, via: 'devices-list',
      details: { pointsPin, previous },
    }, now);
    return { pointsPin };
  });
};

// ---------------------------------------------------------------------------
// Guards as stored
// ---------------------------------------------------------------------------

const millisOf = (value: unknown): number | null => (value instanceof Timestamp ? value.toMillis() : null);

const readDeviceGuard = (snap: Snap): DeviceGuard => {
  if (!snap.exists) return emptyDeviceGuard();
  const d = snap.data() || {};
  const attempts = Array.isArray(d.attempts)
    ? d.attempts.filter((a: unknown): a is { id: string; seq: number } =>
      Boolean(a) && typeof (a as { id?: unknown }).id === 'string' && typeof (a as { seq?: unknown }).seq === 'number')
    : [];
  return {
    failures: attempts.length,
    attempts,
    seq: typeof d.seq === 'number' ? d.seq : 0,
    lockedUntil: millisOf(d.lockedUntil),
    lockedBySeq: typeof d.lockedBySeq === 'number' ? d.lockedBySeq : null,
    lockouts: typeof d.lockouts === 'number' ? d.lockouts : 0,
  };
};

const storeDeviceGuard = (guard: DeviceGuard) => ({
  failures: guard.attempts.length,
  attempts: guard.attempts,
  seq: guard.seq,
  lockedUntil: guard.lockedUntil === null ? null : Timestamp.fromMillis(guard.lockedUntil),
  lockedBySeq: guard.lockedBySeq,
  lockouts: guard.lockouts,
});

const readMemberGuard = (snap: Snap): MemberGuard => {
  if (!snap.exists) return emptyMemberGuard();
  const d = snap.data() || {};
  const recentFailures = Array.isArray(d.recentFailures)
    ? d.recentFailures.flatMap((f: unknown) => {
      const entry = f as { id?: unknown; at?: unknown };
      const at = millisOf(entry?.at);
      return typeof entry?.id === 'string' && at !== null ? [{ id: entry.id, at }] : [];
    })
    : [];
  const sinceSuccess = Array.isArray(d.sinceSuccess)
    ? d.sinceSuccess.filter((f: unknown): f is { id: string; seq: number } =>
      Boolean(f) && typeof (f as { id?: unknown }).id === 'string' && typeof (f as { seq?: unknown }).seq === 'number')
    : [];
  const timed = (value: unknown) => Array.isArray(value)
    ? value.flatMap((f: unknown) => {
      const entry = f as { id?: unknown; at?: unknown };
      const at = millisOf(entry?.at);
      return typeof entry?.id === 'string' && at !== null ? [{ id: entry.id, at }] : [];
    })
    : [];
  return {
    recentFailures,
    dayFailures: timed(d.dayFailures),
    tabletLocks: timed(d.tabletLocks),
    repeatAlertAt: millisOf(d.repeatAlertAt),
    sinceSuccess,
    seq: typeof d.seq === 'number' ? d.seq : 0,
    lockedAt: millisOf(d.lockedAt),
    lockedByAttempt: typeof d.lockedByAttempt === 'string' ? d.lockedByAttempt : null,
    lockedReason: d.lockedReason === 'hour' || d.lockedReason === 'day' || d.lockedReason === 'total' ? d.lockedReason : null,
  };
};

const storeMemberGuard = (guard: MemberGuard) => ({
  recentFailures: guard.recentFailures.map(f => ({ id: f.id, at: Timestamp.fromMillis(f.at) })),
  dayFailures: guard.dayFailures.map(f => ({ id: f.id, at: Timestamp.fromMillis(f.at) })),
  tabletLocks: guard.tabletLocks.map(l => ({ id: l.id, at: Timestamp.fromMillis(l.at) })),
  repeatAlertAt: guard.repeatAlertAt === null ? null : Timestamp.fromMillis(guard.repeatAlertAt),
  sinceSuccess: guard.sinceSuccess,
  seq: guard.seq,
  lockedAt: guard.lockedAt === null ? null : Timestamp.fromMillis(guard.lockedAt),
  lockedByAttempt: guard.lockedByAttempt,
  lockedReason: guard.lockedReason,
});

// ---------------------------------------------------------------------------
// Verification from a tablet (7.4) and PIN sessions (7.5)
// ---------------------------------------------------------------------------

export const PIN_VERIFY_LIMITS = { perDevicePerMinute: 10, concurrentHashes: PIN_HASH_CONCURRENCY };

export type VerifyPinResult = { ok: true; pinSessionId: string; expiresAt: string };

/**
 * Test seams: right after the compare (either outcome), inside B before it writes, and
 * inside a lock announcement before it writes.
 */
export type VerifyPinTestHooks = { afterCompare?: () => Promise<void>; duringSettle?: () => void; duringAnnounce?: () => void };

type Reserved = {
  hash: string;
  salt: string;
  params: unknown;
  pepperId: string;
  pinVersion: number;
  pinId: string | null;
  seq: number;
  memberSeq: number;
  memberLocked: boolean;
  memberLockReason: MemberLockReason | null;
  deviceGuard: DeviceGuard;
};

/**
 * Verifies a PIN typed on a tablet for `actorUid` and opens a PIN session. In order:
 * pre-auth limits (client address, instance); the token; the verified tablet's budget
 * and concurrency limits before any Firestore or hash work; the household,
 * registration and actor; transaction A counts the attempt as a failure in advance (so
 * the limits are exact under concurrency without hashing inside a transaction); the
 * async scrypt compare; transaction B re-reads the PIN record (pinVersion and hash must
 * equal A's), re-runs the gate checks, forgives only failures recorded at or before
 * this attempt, and creates the session. The answer is returned only after B commits.
 * Throws DeviceActionError (codes of section 8.5).
 */
export const verifyDevicePin = async (
  input: { idToken: unknown; householdId: unknown; actorUid: unknown; pin: unknown },
  options: { now?: Date; limits?: Partial<typeof PIN_VERIFY_LIMITS>; testHooks?: VerifyPinTestHooks; clientAddress?: string } = {},
): Promise<VerifyPinResult> => {
  const now = options.now ?? new Date();
  const limits = { ...PIN_VERIFY_LIMITS, ...options.limits };
  if (!devicesEnabled()) throw new DeviceActionError('unavailable');
  if (typeof input?.pin !== 'string' || !/^[0-9]{4,6}$/.test(input.pin)) throw new DeviceActionError('invalid_input');
  if (typeof input.actorUid !== 'string' || !input.actorUid || input.actorUid.length > 128 || input.actorUid.includes('/')) {
    throw new DeviceActionError('actor_required');
  }
  const pin = input.pin;
  const actorUid = input.actorUid;
  // 1. Pre-auth limits, never keyed by what the token claims: the client address before
  // anything, the per-instance bucket only once the token's signature checks out.
  preAuthAddressLimit('pin', options.clientAddress, now.getTime());
  // 2. Token (the verified device id keys everything after this).
  const claims = await verifyDeviceToken(input.idToken, input.householdId, {
    onSignatureVerified: () => preAuthInstanceLimit('pin', now.getTime()),
  });
  // 3. The tablet's own budget and admission, before any Firestore or hash work.
  takeDeviceBudget('pin-verify', claims, limits.perDevicePerMinute, now.getTime());
  const pairKey = `${claims.hh_device}:${actorUid}`;
  if (inflight.has(pairKey)) throw new DeviceActionError('busy');
  if (pools.verify.admitted >= limits.concurrentHashes * PIN_VERIFY_ADMISSION_FACTOR) throw new DeviceActionError('busy');
  pools.verify.admitted += 1;
  inflight.add(pairKey);
  try {
    const householdRef = householdRefOf(claims.hh_household);
    const recordRef = deviceRecordRef(householdRef, claims.hh_device);
    const memberRef = householdRef.collection('members').doc(actorUid);
    const pinRef = pinRecordRef(householdRef, actorUid);
    const mGuardRef = memberGuardRef(householdRef, actorUid);
    const dGuardRef = deviceGuardRef(householdRef, claims.hh_device, actorUid);
    const recheck = (household: Snap, record: Snap, member: Snap) => {
      checkHouseholdAndRecord(household, record, claims);
      return checkActorEligible(actorUid, member);
    };
    {
      const [household, record, member] = await Promise.all([householdRef.get(), recordRef.get(), memberRef.get()]);
      recheck(household, record, member);
    }
    const attemptId = randomUUID();
    const hash = (value: string, salt: Buffer, pepper: Buffer, params?: unknown) =>
      withPoolSlot(pools.verify, limits.concurrentHashes, () => hashPinValue(value, salt, pepper, params === undefined ? undefined : readPinParams(params)));

    // 4. Reserve (transaction A): count the attempt as a failure in advance. Nothing is
    // announced here: a lock this attempt sets is reported only once it proved wrong.
    const reserved = await adminDb.runTransaction(async tx => {
      const [household, record, member, pinSnap, mGuardSnap, dGuardSnap] = await Promise.all([
        tx.get(householdRef), tx.get(recordRef), tx.get(memberRef), tx.get(pinRef), tx.get(mGuardRef), tx.get(dGuardRef),
      ]);
      recheck(household, record, member);
      if (!hasPin(pinSnap)) throw new DeviceActionError('no_pin_set');
      const memberGuard = readMemberGuard(mGuardSnap);
      if (memberGuard.lockedAt !== null) throw new DeviceActionError('pin_locked_member');
      const deviceReservation = reserveDeviceGuard(readDeviceGuard(dGuardSnap), attemptId, now.getTime());
      if ('refused' in deviceReservation) {
        throw new DeviceActionError('pin_locked', deviceReservation.refused === 'pin_locked' ? deviceReservation.retryAfterSec : undefined);
      }
      // A tablet lock this attempt sets is also counted for the person (repeat-lock notice).
      const tabletLock = deviceReservation.guard.lockedBySeq === deviceReservation.seq;
      const memberReservation = reserveMemberGuard(memberGuard, attemptId, now.getTime(), { tabletLock });
      if ('refused' in memberReservation) throw new DeviceActionError('pin_locked_member');
      // Fail closed before counting anything when the pepper is missing.
      const pepperId = pinSnap.get('pepperId');
      if (!pepperFor(pepperId)) throw new DeviceActionError('pin_unavailable');
      tx.set(mGuardRef, storeMemberGuard(memberReservation.guard));
      tx.set(dGuardRef, storeDeviceGuard(deviceReservation.guard));
      const result: Reserved = {
        hash: pinSnap.get('hash'),
        salt: pinSnap.get('salt'),
        params: pinSnap.get('params'),
        pepperId,
        pinVersion: pinSnap.get('pinVersion'),
        pinId: typeof pinSnap.get('pinId') === 'string' ? pinSnap.get('pinId') : null,
        seq: deviceReservation.seq,
        memberSeq: memberReservation.seq,
        memberLocked: memberReservation.locked,
        memberLockReason: memberReservation.guard.lockedReason,
        deviceGuard: deviceReservation.guard,
      };
      return result;
    });

    // 5. Compare outside any transaction (async scrypt, run once; a hash slot is held only here).
    const pepper = pepperFor(reserved.pepperId);
    if (!pepper) throw new DeviceActionError('pin_unavailable');
    const presented = await hash(pin, Buffer.from(reserved.salt, 'base64'), pepper, reserved.params);
    const correct = hashesEqual(presented, Buffer.from(reserved.hash, 'base64'));
    await options.testHooks?.afterCompare?.();
    if (!correct) {
      // Already counted in A. A lock this attempt set is announced now that it proved wrong.
      const deviceLocked = reserved.deviceGuard.lockedBySeq === reserved.seq && reserved.deviceGuard.lockedUntil !== null;
      if (reserved.memberLocked || deviceLocked) {
        const announcement = {
          householdRef, recordRef, deviceId: claims.hh_device, actorUid, attemptId, seq: reserved.seq,
          member: reserved.memberLocked ? reserved.memberLockReason ?? 'hour' : null,
          deviceLockMinutes: deviceLocked ? Math.round((reserved.deviceGuard.lockedUntil! - now.getTime()) / 60_000) : null,
          now,
          duringAnnounce: options.testHooks?.duringAnnounce,
        };
        // One retry, then a structured error (ids and reason only, no names).
        await announceLocks(announcement)
          .catch(() => announceLocks(announcement))
          .catch(error => console.error(JSON.stringify({
            event: 'pin_lock_announcement_failed',
            householdId: householdRef.id,
            deviceId: claims.hh_device,
            reason: announcement.member ?? 'tablet',
            error: error instanceof Error ? error.name : 'unknown',
          })));
      }
      if (reserved.memberLocked) throw new DeviceActionError('pin_locked_member');
      if (deviceLocked) {
        throw new DeviceActionError('pin_locked', Math.max(1, Math.ceil((reserved.deviceGuard.lockedUntil! - now.getTime()) / 1000)));
      }
      throw new DeviceActionError('pin_wrong', undefined, Math.max(0, DEVICE_FAILURES_BEFORE_LOCK - reserved.deviceGuard.failures));
    }
    // A verify against an older pepper re-hashes with the current one (same pinVersion).
    const currentId = currentPepperId();
    let rehash: StoredHash | null = null;
    if (currentId && currentId !== reserved.pepperId) {
      const salt = newPinSalt();
      const value = await hash(pin, salt, pepperFor(currentId)!);
      rehash = { hash: value.toString('base64'), salt: salt.toString('base64'), params: PIN_SCRYPT_PARAMS, pepperId: currentId };
    }

    // 6. Settle (transaction B).
    const secret = randomBytes(32).toString('base64url');
    const sessionRef = pinSessionRef(householdRef, claims.hh_device, secret);
    try {
      await adminDb.runTransaction(async tx => {
        const [household, record, member, pinSnap, mGuardSnap, dGuardSnap] = await Promise.all([
          tx.get(householdRef), tx.get(recordRef), tx.get(memberRef), tx.get(pinRef), tx.get(mGuardRef), tx.get(dGuardRef),
        ]);
        const actor = recheck(household, record, member);
        // R2: the PIN must still be the one this attempt was compared against.
        if (!hasPin(pinSnap) || pinSnap.get('pinVersion') !== reserved.pinVersion || pinSnap.get('hash') !== reserved.hash ||
          (pinSnap.get('pinId') ?? null) !== reserved.pinId) {
          throw new DeviceActionError('pin_session_invalid');
        }
        options.testHooks?.duringSettle?.();
        tx.set(mGuardRef, storeMemberGuard(settleMemberGuardCorrect(readMemberGuard(mGuardSnap), attemptId, reserved.memberSeq)));
        tx.set(dGuardRef, storeDeviceGuard(settleDeviceGuardCorrect(readDeviceGuard(dGuardSnap), reserved.seq)));
        if (rehash) tx.update(pinRef, { hash: rehash.hash, salt: rehash.salt, params: rehash.params, pepperId: rehash.pepperId });
        tx.set(sessionRef, {
          memberUid: actor.uid,
          generation: claims.hh_gen,
          pinVersion: reserved.pinVersion,
          // The PIN's never-reused identity: a PIN set after the document was recreated
          // (rejoining) has a different one, so this session can never validate again.
          pinId: reserved.pinId,
          roleAtUnlock: actor.role,
          createdAt: Timestamp.fromDate(now),
          lastUsedAt: Timestamp.fromDate(now),
          expiresAt: Timestamp.fromMillis(now.getTime() + PIN_SESSION_IDLE_MS),
          endedAt: null,
          endedReason: null,
        });
      });
    } catch (error) {
      if (error instanceof DeviceActionError) throw error;
      console.error('PIN verification could not be settled', error instanceof Error ? error.message : String(error));
      throw new DeviceActionError('failed');
    }
    return { ok: true, pinSessionId: secret, expiresAt: new Date(now.getTime() + PIN_SESSION_IDLE_MS).toISOString() };
  } finally {
    inflight.delete(pairKey);
    pools.verify.admitted -= 1;
  }
};

/**
 * Activity (and, for a person-wide lock, a notice to every active owner and admin) for a
 * lock set by an attempt that proved wrong. Written by the tablet as the actor, about the
 * person; only if the lock this attempt set is still in place.
 */
const announceLocks = async (input: {
  householdRef: DocRef; recordRef: DocRef; deviceId: string; actorUid: string; attemptId: string; seq: number;
  member: MemberLockReason | null; deviceLockMinutes: number | null; now: Date; duringAnnounce?: () => void;
}) => {
  const { householdRef, now } = input;
  await adminDb.runTransaction(async tx => {
    const [household, record, person, mGuard, dGuard, admins] = await Promise.all([
      tx.get(householdRef),
      tx.get(input.recordRef),
      tx.get(householdRef.collection('members').doc(input.actorUid)),
      tx.get(memberGuardRef(householdRef, input.actorUid)),
      tx.get(deviceGuardRef(householdRef, input.deviceId, input.actorUid)),
      tx.get(householdRef.collection('members').where('role', 'in', ['owner', 'admin'])),
    ]);
    // Nothing is written for a household that is gone or being deleted.
    if (!household.exists || household.get('deletingAt')) return;
    input.duringAnnounce?.();
    const tabletName = readDeviceSettings(record.data()).name;
    const tablet = { actorUid: deviceUid(input.deviceId), actorName: tabletName, via: 'device' as const, deviceId: input.deviceId, deviceName: tabletName };
    const personName = publicName(person.get('displayName'));
    const memberGuard = readMemberGuard(mGuard);
    const recipients = admins.docs.filter(d => (d.get('status') ?? 'active') === 'active');
    const notify = (id: string, title: string, message: string, sourceType: string) => {
      for (const admin of recipients) {
        tx.set(householdRef.collection('notifications').doc(`${id}-${admin.id}`), {
          householdId: householdRef.id,
          category: 'system',
          title,
          message,
          createdAt: Timestamp.fromDate(now),
          expiresAt: Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS),
          deepLink: MEMBERS_LINK,
          sourceType,
          sourceId: input.actorUid,
          stateKey: String(now.getTime()),
          targetUserUid: admin.id,
          audience: notificationAudience({ targetUserUid: admin.id }),
          readBy: {},
          dismissedBy: {},
        });
      }
    };
    if (input.member && memberGuard.lockedByAttempt === input.attemptId) {
      writeDeviceAudit(tx, householdRef, {
        action: 'pin.locked', ...tablet, targetUid: input.actorUid, targetName: personName, details: { reason: input.member },
      }, now);
      notify(`pin-locked-${input.actorUid}-${now.getTime()}`, 'Tablet PIN locked',
        `${personName}'s tablet PIN is locked after too many wrong tries. Unlock it in Household, Members.`, 'pin-locked');
    }
    if (input.deviceLockMinutes !== null && readDeviceGuard(dGuard).lockedBySeq === input.seq) {
      writeDeviceAudit(tx, householdRef, {
        action: 'pin.device_locked', ...tablet, targetUid: input.actorUid, targetName: personName,
        details: { minutes: input.deviceLockMinutes },
      }, now);
      // Repeated tablet locks for one person: one notice per 24 hours.
      if (repeatTabletLockAlertDue(memberGuard, now.getTime())) {
        tx.set(mGuard.ref, { repeatAlertAt: Timestamp.fromDate(now) }, { merge: true });
        notify(`pin-tablet-locks-${input.actorUid}-${now.getTime()}`, 'Tablet PIN keeps locking',
          `${personName}'s tablet PIN locked ${TABLET_LOCKS_ALERT_COUNT} tablets within a day. Check in with them, or unlock it in Household, Members.`, 'pin-tablet-locks');
      }
    }
  });
};

/** "Done" or the tablet's idle timer: ends the session now (best effort; the server expiry stands). */
export const endPinSession = async (
  input: { idToken: unknown; householdId: unknown; pinSessionId: unknown },
  now = new Date(),
  options: { clientAddress?: string } = {},
) => {
  if (!devicesEnabled()) throw new DeviceActionError('unavailable');
  preAuthAddressLimit('pinEnd', options.clientAddress, now.getTime());
  const claims = await verifyDeviceToken(input?.idToken, input?.householdId, {
    onSignatureVerified: () => preAuthInstanceLimit('pinEnd', now.getTime()),
  });
  takeDeviceBudget('pin-end', claims, 30, now.getTime());
  return endPinSessionRecord(claims, input?.pinSessionId, now);
};
