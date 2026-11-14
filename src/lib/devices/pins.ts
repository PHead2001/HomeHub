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

/** `members/{uid}/private/pinGuard`: failures across tablets in the last hour. */
export type MemberGuard = {
  recentFailures: Array<{ id: string; at: number }>;
  lockedAt: number | null;
  /** The attempt whose provisional failure set the lock. */
  lockedByAttempt: string | null;
};

export const emptyMemberGuard = (): MemberGuard => ({ recentFailures: [], lockedAt: null, lockedByAttempt: null });

export const reserveMemberGuard = (
  guard: MemberGuard,
  attemptId: string,
  nowMs: number,
): { guard: MemberGuard; locked: boolean } | GuardRefusal => {
  if (guard.lockedAt !== null) return { refused: 'pin_locked_member' };
  const recent = guard.recentFailures.filter(f => nowMs - f.at < MEMBER_FAILURE_WINDOW_MS);
  const recentFailures = [...recent, { id: attemptId, at: nowMs }].slice(-MEMBER_FAILURES_BEFORE_LOCK);
  const locked = recentFailures.length >= MEMBER_FAILURES_BEFORE_LOCK;
  return {
    locked,
    guard: { recentFailures, lockedAt: locked ? nowMs : null, lockedByAttempt: locked ? attemptId : null },
  };
};

/** A correct PIN removes only its own provisional entry, and the lock only if it set it. */
export const settleMemberGuardCorrect = (guard: MemberGuard, attemptId: string): MemberGuard => {
  const own = guard.lockedByAttempt === attemptId;
  return {
    recentFailures: guard.recentFailures.filter(f => f.id !== attemptId),
    lockedAt: own ? null : guard.lockedAt,
    lockedByAttempt: own ? null : guard.lockedByAttempt,
  };
};

/** Idle length of a PIN session (D-T3, WT-5d, WT-22c). */
export const PIN_SESSION_IDLE_MS = 120_000;
/** Admin-PIN capabilities need a session at most this old (S9). */
export const ADMIN_PIN_FRESH_SEC = 30;
