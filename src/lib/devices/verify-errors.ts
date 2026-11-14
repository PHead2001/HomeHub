// How a failed device-credential check is read (docs/modules/devices/README.md,
// "Device identity"). Only a verdict about the credential itself ends a tablet's session;
// an outage of the verifier (network, 5xx, timeouts, internal errors, quota) is "try again
// later", so a transient Auth problem never forces a re-pair. Pure: shared by the server
// and the tablet screen.

/** Firebase Admin `verifyIdToken` codes that mean the credential is revoked or its user gone. */
const REVOKED = new Set(['auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found']);

/** Codes that mean the token itself is not a valid, current ID token. */
const INVALID = new Set([
  'auth/argument-error',
  'auth/invalid-argument',
  'auth/invalid-id-token',
  'auth/id-token-expired',
  'auth/invalid-credential',
]);

export type VerifyFailure = 'revoked' | 'invalid' | 'transient';

/**
 * Classifies an error thrown by `verifyIdToken(token, true)`. Anything not known to be a
 * verdict on the credential (no code, `auth/internal-error`, `app/network-error`, quota,
 * timeouts, unknown codes) is transient.
 */
export const classifyVerifyError = (error: unknown): VerifyFailure => {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string') return 'transient';
  if (REVOKED.has(code)) return 'revoked';
  if (INVALID.has(code)) return 'invalid';
  return 'transient';
};

/**
 * Whether a server answer to the tablet ends its session (sign out, clear, back to setup).
 * Only verdicts about this tablet do: revoked or replaced, its household being deleted, or
 * a credential that is not a valid tablet token. `unavailable`, `rate_limited`, `failed`
 * and anything else mean "try again later".
 */
export const endsTabletSession = (code: string): boolean =>
  code === 'device_revoked' || code === 'household_deleting' || code === 'unauthenticated';
