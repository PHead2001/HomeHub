// Who a Firebase Auth user is to HomeHub: a person, or a registered wall tablet
// (docs/modules/devices/README.md, "Principal switch"). Pure apart from the token read
// it is given, so AuthProvider's decision is unit-tested.
import { DEVICE_UID_PREFIX, readDeviceClaims } from './types';

export type Principal =
  | { kind: 'personal' }
  | { kind: 'device'; deviceId: string; householdId: string; generation: number };

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
 * cannot be read right now (offline restore) is still a tablet, with an empty household
 * and generation 0, and never the personal flow.
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
  return looksLikeDevice(user)
    ? { kind: 'device', deviceId: user.uid.slice(DEVICE_UID_PREFIX.length), householdId: '', generation: 0 }
    : null;
};
