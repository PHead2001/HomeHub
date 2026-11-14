// Tablet PINs (docs/modules/devices/README.md, "PINs"): the format rule and the
// lockout arithmetic. Pure (no Firebase): the server (`src/lib/server/pins.ts`) stores
// and enforces it, the Profile and Members forms reuse the format check.

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

export type PinFormatResult = { ok: true } | { ok: false; message: string };

/**
 * 4-6 digits; never all the same digit and never a straight run up or down
 * (`1234`, `987654`) (D-T11, JC-11). The value is never logged or echoed.
 */
export const validatePinFormat = (pin: unknown): PinFormatResult => {
  if (typeof pin !== 'string' || !/^[0-9]{4,6}$/.test(pin)) {
    return { ok: false, message: `Use ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits.` };
  }
  const digits = [...pin].map(Number);
  if (digits.every(d => d === digits[0])) return { ok: false, message: "Don't use the same digit for every number." };
  const steps = digits.slice(1).map((d, i) => d - digits[i]);
  if (steps.every(s => s === 1) || steps.every(s => s === -1)) {
    return { ok: false, message: "Don't use digits in a row, like 1234." };
  }
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Lockouts (D-T11, WT-9f). Times are milliseconds since the epoch (server clock).
// ---------------------------------------------------------------------------

/** Consecutive wrong PINs on one tablet before it locks that person's PIN there. */
export const DEVICE_FAILURES_BEFORE_LOCK = 5;
/** Lock lengths: 1, 2, 4, 8 minutes, then 15 (the cap). */
export const DEVICE_LOCK_CAP_MS = 15 * 60_000;
/** Wrong PINs for one person across tablets within an hour before a hard lock. */
export const MEMBER_FAILURES_BEFORE_LOCK = 20;
export const MEMBER_FAILURE_WINDOW_MS = 60 * 60_000;

export const deviceLockDuration = (lockouts: number): number =>
  Math.min(DEVICE_LOCK_CAP_MS, 60_000 * 2 ** Math.max(0, lockouts - 1));

/**
 * `devices/{d}/pinGuards/{memberUid}`. Every attempt is counted as a failure when it
 * is reserved (pessimistic counting) and carries a sequence number, so a correct PIN
 * removes only failures recorded at or before its own reservation, never those of
 * attempts that ran concurrently (re-review R2).
 */
export type DeviceGuard = {
  failures: number;
  attempts: Array<{ id: string; seq: number }>;
  seq: number;
  lockedUntil: number | null;
  /** The attempt whose provisional failure set the current lock. */
  lockedBySeq: number | null;
  lockouts: number;
};

export const emptyDeviceGuard = (): DeviceGuard => ({ failures: 0, attempts: [], seq: 0, lockedUntil: null, lockedBySeq: null, lockouts: 0 });

export type GuardRefusal = { refused: 'pin_locked'; retryAfterSec: number } | { refused: 'pin_locked_member' };

/** Reserve: refuse while locked, else count this attempt as a failure in advance. */
export const reserveDeviceGuard = (
  guard: DeviceGuard,
  attemptId: string,
  nowMs: number,
): { guard: DeviceGuard; seq: number } | GuardRefusal => {
  if (guard.lockedUntil !== null && guard.lockedUntil > nowMs) {
    return { refused: 'pin_locked', retryAfterSec: Math.max(1, Math.ceil((guard.lockedUntil - nowMs) / 1000)) };
  }
  const seq = guard.seq + 1;
  const attempts = [...guard.attempts, { id: attemptId, seq }];
  if (attempts.length >= DEVICE_FAILURES_BEFORE_LOCK) {
    const lockouts = guard.lockouts + 1;
    return {
      seq,
      guard: { failures: 0, attempts: [], seq, lockedUntil: nowMs + deviceLockDuration(lockouts), lockedBySeq: seq, lockouts },
    };
  }
  return { seq, guard: { ...guard, seq, attempts, failures: attempts.length, lockedUntil: guard.lockedUntil !== null && guard.lockedUntil > nowMs ? guard.lockedUntil : null } };
};

/**
 * A correct PIN: failures recorded at or before this attempt's reservation are
 * forgiven and the lockout schedule restarts, unless a later concurrent attempt
 * set a lock (then that lock and its schedule stay).
 */
export const settleDeviceGuardCorrect = (guard: DeviceGuard, seq: number): DeviceGuard => {
  const attempts = guard.attempts.filter(a => a.seq > seq);
  const laterLock = guard.lockedBySeq !== null && guard.lockedBySeq > seq;
  return {
    ...guard,
    attempts,
    failures: attempts.length,
    lockedUntil: laterLock ? guard.lockedUntil : null,
    lockedBySeq: laterLock ? guard.lockedBySeq : null,
    lockouts: laterLock ? guard.lockouts : 0,
  };
};

/**
 * Failures for one person since their last correct PIN, across tablets and without a
 * time window: at this count every PIN for them is refused until an owner or admin (or
 * they themselves, from their phone) clears it. This bounds slow guessing that stays
 * under the hourly limit and the tablet backoff.
 */
export const MEMBER_FAILURES_SINCE_SUCCESS_LOCK = 50;

/**
 * Failures for one person within any 24 hours, across tablets. A correct PIN never resets
 * this count (it only withdraws its own provisional entry), so regular correct use cannot
 * hide a steady trickle of wrong ones. At this count: hard lock (`lockedReason: 'day'`).
 */
export const MEMBER_FAILURES_PER_DAY_LOCK = 30;
export const MEMBER_DAY_WINDOW_MS = 24 * 60 * 60_000;

/** Owners and admins are told once when one person's PIN locks this many tablets within 24 hours. */
export const TABLET_LOCKS_ALERT_COUNT = 3;

/**
 * `members/{uid}/private/pinGuard`: failures across tablets in the last hour, and every
 * failure since the last correct PIN. Entries carry the attempt id and a monotonic
 * sequence number, so a correct PIN forgives only failures recorded at or before its own
 * reservation (re-review R2).
 */
export type MemberGuard = {
  recentFailures: Array<{ id: string; at: number }>;
  /** Every failure within the last 24 hours (at most MEMBER_FAILURES_PER_DAY_LOCK). */
  dayFailures: Array<{ id: string; at: number }>;
  /** Tablet-level locks of this person within the last 24 hours (attempt id, time). */
  tabletLocks: Array<{ id: string; at: number }>;
  /** When owners and admins were last told about repeated tablet locks. */
  repeatAlertAt: number | null;
  sinceSuccess: Array<{ id: string; seq: number }>;
  seq: number;
  lockedAt: number | null;
  /** The attempt whose provisional failure set the lock. */
  lockedByAttempt: string | null;
  /** Which limit set the lock: 20 within an hour, 30 within 24 hours, or 50 since the last correct PIN. */
  lockedReason: MemberLockReason | null;
};

export type MemberLockReason = 'hour' | 'day' | 'total';

export const emptyMemberGuard = (): MemberGuard => ({
  recentFailures: [], dayFailures: [], tabletLocks: [], repeatAlertAt: null, sinceSuccess: [], seq: 0,
  lockedAt: null, lockedByAttempt: null, lockedReason: null,
});

export const reserveMemberGuard = (
  guard: MemberGuard,
  attemptId: string,
  nowMs: number,
  options: { tabletLock?: boolean } = {},
): { guard: MemberGuard; locked: boolean; seq: number } | GuardRefusal => {
  if (guard.lockedAt !== null) return { refused: 'pin_locked_member' };
  const seq = guard.seq + 1;
  const recent = guard.recentFailures.filter(f => nowMs - f.at < MEMBER_FAILURE_WINDOW_MS);
  const recentFailures = [...recent, { id: attemptId, at: nowMs }].slice(-MEMBER_FAILURES_BEFORE_LOCK);
  const day = guard.dayFailures.filter(f => nowMs - f.at < MEMBER_DAY_WINDOW_MS);
  const dayFailures = [...day, { id: attemptId, at: nowMs }].slice(-MEMBER_FAILURES_PER_DAY_LOCK);
  const sinceSuccess = [...guard.sinceSuccess, { id: attemptId, seq }].slice(-MEMBER_FAILURES_SINCE_SUCCESS_LOCK);
  const lockedTablets = guard.tabletLocks.filter(l => nowMs - l.at < MEMBER_DAY_WINDOW_MS);
  const tabletLocks = options.tabletLock ? [...lockedTablets, { id: attemptId, at: nowMs }].slice(-20) : lockedTablets;
  const reason: MemberLockReason | null =
    recentFailures.length >= MEMBER_FAILURES_BEFORE_LOCK ? 'hour'
      : dayFailures.length >= MEMBER_FAILURES_PER_DAY_LOCK ? 'day'
        : sinceSuccess.length >= MEMBER_FAILURES_SINCE_SUCCESS_LOCK ? 'total' : null;
  const locked = reason !== null;
  return {
    locked,
    seq,
    guard: {
      ...guard,
      recentFailures,
      dayFailures,
      tabletLocks,
      sinceSuccess,
      seq,
      lockedAt: locked ? nowMs : null,
      lockedByAttempt: locked ? attemptId : null,
      lockedReason: reason,
    },
  };
};

/**
 * Whether owners and admins should now be told that this person's PIN keeps locking
 * tablets: TABLET_LOCKS_ALERT_COUNT tablet locks within 24 hours, and no such notice in
 * the last 24 hours (one notice per episode).
 */
export const repeatTabletLockAlertDue = (guard: MemberGuard, nowMs: number): boolean =>
  guard.tabletLocks.filter(l => nowMs - l.at < MEMBER_DAY_WINDOW_MS).length >= TABLET_LOCKS_ALERT_COUNT &&
  (guard.repeatAlertAt === null || nowMs - guard.repeatAlertAt >= MEMBER_DAY_WINDOW_MS);

/**
 * A correct PIN removes only its own provisional entries (hourly, daily and any tablet
 * lock it set), forgives the failures since the last correct PIN that were recorded at or
 * before its own reservation (never those of concurrent attempts; the 24-hour count is
 * never forgiven), and lifts the lock only if its own provisional failure set it.
 */
export const settleMemberGuardCorrect = (guard: MemberGuard, attemptId: string, seq: number): MemberGuard => {
  const own = guard.lockedByAttempt === attemptId;
  return {
    ...guard,
    recentFailures: guard.recentFailures.filter(f => f.id !== attemptId),
    dayFailures: guard.dayFailures.filter(f => f.id !== attemptId),
    tabletLocks: guard.tabletLocks.filter(l => l.id !== attemptId),
    sinceSuccess: guard.sinceSuccess.filter(f => f.seq > seq),
    lockedAt: own ? null : guard.lockedAt,
    lockedByAttempt: own ? null : guard.lockedByAttempt,
    lockedReason: own ? null : guard.lockedReason,
  };
};

/**
 * Clearing a lockout empties a guard but keeps its sequence number, so an attempt still in
 * flight (reserved before the clear) can never forgive a failure recorded after it.
 */
export const clearedDeviceGuard = (guard: DeviceGuard): DeviceGuard => ({ ...emptyDeviceGuard(), seq: guard.seq });
export const clearedMemberGuard = (guard: MemberGuard): MemberGuard => ({ ...emptyMemberGuard(), seq: guard.seq });

/** Idle length of a PIN session (D-T3, WT-5d, WT-22c). */
export const PIN_SESSION_IDLE_MS = 120_000;
/** Admin-PIN capabilities need a session at most this old (S9). */
export const ADMIN_PIN_FRESH_SEC = 30;
