// The setup screen's pending redemption (docs/modules/devices/README.md, "Pairing and
// redemption"): the code and nonce kept in sessionStorage until the tablet has signed in.
// The server treats a second redemption with the same nonce as the same tablet retrying,
// so the nonce must survive every outcome that may have committed or may still succeed:
// it is dropped only after the sign-in, or after a refusal that no retry can change.
import type { RedeemRefusal } from './types';

export type PendingRedemption = { code: string; nonce: string };

/** The same code keeps its nonce (a retry); another code starts a new redemption. */
export const pendingFor = (previous: PendingRedemption | null, code: string, makeNonce: () => string): PendingRedemption =>
  previous && previous.code === code ? previous : { code, nonce: makeNonce() };

/**
 * Refusals a retry with the same code and nonce may still turn into a pairing: the
 * redemption may have committed with the credential not issued (`failed`), or the request
 * never reached the redemption (rate limit, App Check, server flag).
 */
export const RETRYABLE_REDEEM_REFUSALS: ReadonlySet<RedeemRefusal> = new Set<RedeemRefusal>([
  'failed',
  'rate_limited',
  'app_check_failed',
  'unavailable',
]);

export type RedeemOutcome =
  | { kind: 'signed-in' }
  | { kind: 'refused'; code: RedeemRefusal }
  /** No answer, or an answer whose sign-in did not finish (network, timeout, sign-in error). */
  | { kind: 'uncertain' };

/** Whether the pending code and nonce are kept for the next attempt. */
export const keepPendingAfter = (outcome: RedeemOutcome): boolean =>
  outcome.kind === 'uncertain' || (outcome.kind === 'refused' && RETRYABLE_REDEEM_REFUSALS.has(outcome.code));
