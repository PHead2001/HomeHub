// Who a Firebase Auth user is to HomeHub: a person, or a registered wall tablet
// (docs/modules/devices/README.md, "Principal switch"). Pure apart from the token read
// it is given, so AuthProvider's decision is unit-tested.
import { DEVICE_UID_PREFIX, readDeviceClaims } from './types';

export type Principal =
  | { kind: 'personal' }
  | { kind: 'device'; deviceId: string; householdId: string; generation: number }
  /**
   * A tablet (no email, `device_` uid) whose claims could not be read yet (an offline
   * restore with an expired ID token). Never the personal flow, never a settled device:
   * AuthProvider retries the claims on reconnect, on every ID-token change and on a timer.
   */
  | { kind: 'device-unresolved'; deviceId: string };

export type DevicePrincipal = Extract<Principal, { kind: 'device' }>;

export const PERSONAL_PRINCIPAL: Principal = { kind: 'personal' };

/** Shown when Google sign-in is attempted while this browser is a wall tablet. */
export const DEVICE_GOOGLE_SIGN_IN_REFUSAL = 'This browser is a wall tablet. An owner or admin can switch it from Tablet settings.';

type AuthUserLike = {
  uid: string;
  email: string | null;
  getIdTokenResult: () => Promise<{ claims: Record<string, unknown>; signInProvider: string | null }>;
};

/** A user that can only be a tablet: no email and a `device_` uid. */
export const looksLikeDevice = (user: { uid: string; email: string | null } | null | undefined): boolean =>
  Boolean(user && !user.email && user.uid.startsWith(DEVICE_UID_PREFIX));

/**
 * The device principal of a signed-in user, or null for a person. A user with an email
 * is always a person (a device token never carries one), so personal sign-ins never wait
 * for a token read. Otherwise the ID token's claims decide; a `device_` user whose claims
 * cannot be read right now (offline restore) is `device-unresolved`: still a tablet, never
 * the personal flow, and never published with an empty household.
 */
export const devicePrincipalOf = async (user: AuthUserLike): Promise<Principal | null> => {
  if (user.email) return null;
  try {
    const result = await user.getIdTokenResult();
    const claims = readDeviceClaims({ ...result.claims, uid: user.uid, email: result.claims.email, signInProvider: result.signInProvider ?? undefined });
    if (claims) return { kind: 'device', deviceId: claims.hh_device, householdId: claims.hh_household, generation: claims.hh_gen };
  } catch (error) {
    console.warn('The sign-in claims could not be read.', error instanceof Error ? error.message : String(error));
  }
  return looksLikeDevice(user) ? { kind: 'device-unresolved', deviceId: user.uid.slice(DEVICE_UID_PREFIX.length) } : null;
};

/** Subscribes `retry` to one trigger (reconnect, ID-token change, a timer); returns the unsubscribe. */
export type ClaimRetryTrigger = (retry: () => void) => () => void;

/**
 * While a tablet's claims are unresolved: re-reads them on every trigger, one read at a
 * time (a trigger during a read runs one more read after it), until they resolve to a
 * settled device principal, then stops every trigger and hands it over. Returns a stop.
 */
export const retryDeviceClaims = (deps: {
  resolve: () => Promise<Principal | null>;
  onResolved: (principal: DevicePrincipal) => void;
  triggers: ClaimRetryTrigger[];
}): (() => void) => {
  let stopped = false;
  let running = false;
  let again = false;
  let unsubscribes: Array<() => void> = [];
  const stop = () => {
    stopped = true;
    unsubscribes.forEach(unsubscribe => unsubscribe());
    unsubscribes = [];
  };
  const attempt = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const principal = await deps.resolve().catch(() => null);
      if (!stopped && principal?.kind === 'device') {
        stop();
        deps.onResolved(principal);
      }
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        void attempt();
      }
    }
  };
  unsubscribes = deps.triggers.map(trigger => trigger(() => { void attempt(); }));
  if (stopped) unsubscribes.forEach(unsubscribe => unsubscribe());
  return stop;
};
