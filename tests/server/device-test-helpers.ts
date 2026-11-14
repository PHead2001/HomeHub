import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithCustomToken } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import { DeviceError } from '../../src/lib/server/device-management';
import { DeviceAuthError, verifyDevice } from '../../src/lib/server/device-identity';
import type { VerifiedCaller } from '../../src/lib/server/household-membership';

// Shared by the device server suites (not a test file itself). Real ID tokens from the
// Auth emulator: custom token -> accounts:signInWithCustomToken -> ID and refresh
// tokens; refresh through the emulator's securetoken endpoint.

process.env.HOMEHUB_DEVICES_ENABLED = 'true';

const authHost = () => process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-homehub-e2e';

export const nonce = () => randomBytes(32).toString('base64url');

export type Session = { idToken: string; refreshToken: string };

/** Exchanges a custom token for a real session. */
export const signIn = async (customToken: string): Promise<Session> => {
  const response = await fetch(`http://${authHost()}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const body = await response.json() as { idToken?: string; refreshToken?: string; error?: unknown };
  assert.ok(response.ok && body.idToken && body.refreshToken, `custom-token sign-in failed: ${JSON.stringify(body.error)}`);
  return { idToken: body.idToken!, refreshToken: body.refreshToken! };
};

/** A refresh-token exchange (securetoken endpoint). Null when it is refused. */
export const refresh = async (refreshToken: string): Promise<Session | null> => {
  const response = await fetch(`http://${authHost()}/securetoken.googleapis.com/v1/token?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  if (!response.ok) return null;
  const body = await response.json() as { id_token?: string; refresh_token?: string };
  return body.id_token && body.refresh_token ? { idToken: body.id_token, refreshToken: body.refresh_token } : null;
};

/**
 * An old credential after its device's generation moved on (re-pair) and its refresh
 * tokens were revoked. Production Firebase refuses the refresh-token exchange itself. The
 * Auth emulator does not check revocation on that exchange (only deleted or disabled
 * users), and re-stamps auth_time, so when it still answers, the ID token it returns must
 * carry the old generation and be refused by the server (`verifyDevice`) as revoked.
 */
export const oldCredentialRefused = async (refreshToken: string, householdId: string, oldGeneration: number): Promise<'refused' | 'old-generation'> => {
  const exchanged = await refresh(refreshToken);
  if (!exchanged) return 'refused';
  assert.equal(decodeJwt(exchanged.idToken).hh_gen, oldGeneration);
  await assert.rejects(verifyDevice(exchanged.idToken, householdId), (error: unknown) =>
    error instanceof DeviceAuthError && error.code === 'device_revoked');
  return 'old-generation';
};

/** When the Auth user's refresh tokens were last revoked (ms), or 0. */
export const tokensValidAfter = async (uid: string): Promise<number> => {
  const value = (await adminAuth.getUser(uid)).tokensValidAfterTime;
  return value ? new Date(value).getTime() : 0;
};

export const decodeJwt = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;

/** A personal account with an email, and its real ID token. */
export const personToken = async (person: { uid: string; email: string }): Promise<string> => {
  await adminAuth.deleteUser(person.uid).catch(() => undefined);
  await adminAuth.createUser({ uid: person.uid, email: person.email });
  return (await signIn(await adminAuth.createCustomToken(person.uid))).idToken;
};

export type Person = VerifiedCaller & { role: 'owner' | 'admin' | 'member' | 'child' | 'guest'; permissions?: Record<string, boolean> };

/** A household with members (and no legacy email fields). */
export const seedHousehold = async (householdId: string, people: Person[], extra: Record<string, unknown> = {}) => {
  const house = adminDb.collection('households').doc(householdId);
  await adminDb.recursiveDelete(house);
  const codes = await adminDb.collection('deviceCodes').where('householdId', '==', householdId).get();
  await Promise.all(codes.docs.map(d => d.ref.delete()));
  await house.set({ name: `House ${householdId}`, ownerUid: people[0]?.uid ?? 'nobody', createdAt: '2026-08-01T00:00:00.000Z', ...extra });
  for (const person of people) {
    await house.collection('members').doc(person.uid).set({
      uid: person.uid, role: person.role, status: 'active', displayName: person.displayName ?? person.uid, permissions: person.permissions ?? {},
    });
  }
  return house;
};

/** Removes every `device_` Auth user a suite created for these device ids. */
export const deleteDeviceUsers = async (deviceIds: string[]) => {
  await Promise.all(deviceIds.map(id => adminAuth.deleteUser(`device_${id}`).catch(() => undefined)));
};

/** Expects a DeviceError with this code. */
export const refusedWith = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error instanceof DeviceError, `expected DeviceError(${code}), got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
});

export const userState = async (uid: string): Promise<'missing' | 'disabled' | 'enabled'> => {
  try {
    const user = await adminAuth.getUser(uid);
    return user.disabled ? 'disabled' : 'enabled';
  } catch {
    return 'missing';
  }
};

let appCounter = 0;

/** A real client SDK session (Auth + Firestore emulators, firestore.rules applied). */
export const clientSession = async (customToken: string): Promise<{ app: FirebaseApp; db: Firestore; close: () => Promise<void> }> => {
  const app = initializeApp({ projectId, apiKey: 'fake-api-key' }, `device-client-${appCounter += 1}-${Date.now()}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${authHost()}`, { disableWarnings: true });
  const db = getFirestore(app);
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  connectFirestoreEmulator(db, host, Number(port));
  await signInWithCustomToken(auth, customToken);
  return { app, db, close: () => deleteApp(app) };
};
