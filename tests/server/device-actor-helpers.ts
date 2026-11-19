import { randomUUID } from 'node:crypto';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { createDeviceCode, redeemDeviceCode } from '../../src/lib/server/device-management';
import { nonce, signIn, type Person } from './device-test-helpers';

// Shared by the F2 server suites (pins, child identities, the device gate); not a test
// file. A test pepper is injected through the server environment the PIN code reads
// (HOMEHUB_PIN_PEPPER_CURRENT / HOMEHUB_PIN_PEPPER_<id>); no real secret is used.

export const TEST_PEPPER_ID = 'test1';
export const installTestPepper = (id = TEST_PEPPER_ID) => {
  process.env.HOMEHUB_PIN_PEPPER_CURRENT = id;
  process.env[`HOMEHUB_PIN_PEPPER_${id}`] = `test-pepper-${id}-`.padEnd(48, 'x');
};
installTestPepper();

export type Tablet = { deviceId: string; idToken: string; refreshToken: string; customToken: string };

/** Pairs a new tablet in `householdId` (the owner makes the code) and signs it in. */
export const pairTablet = async (householdId: string, owner: Person, created: Set<string>, name = 'Kitchen tablet'): Promise<Tablet> => {
  const { code } = await createDeviceCode(owner, { householdId, name, room: 'Kitchen' });
  const paired = await redeemDeviceCode({ code, nonce: nonce() });
  created.add(paired.deviceId);
  const session = await signIn(paired.customToken);
  return { deviceId: paired.deviceId, idToken: session.idToken, refreshToken: session.refreshToken, customToken: paired.customToken };
};

export const opId = () => randomUUID();

export const house = (householdId: string) => adminDb.collection('households').doc(householdId);

/** A kid profile record written directly (the child-identities suite covers the action). */
export const seedKid = async (householdId: string, uid: string, name: string) => {
  await house(householdId).collection('members').doc(uid).set({
    uid, kind: 'identity', role: 'child', status: 'active', displayName: name, permissions: {}, joinedAt: '2026-08-01T00:00:00.000Z',
  });
};

/** Every PIN session document of a tablet. */
export const sessionsOf = async (householdId: string, deviceId: string) =>
  (await house(householdId).collection('devices').doc(deviceId).collection('pinSessions').get()).docs;

/** A minute apart per call keeps every test under the per-tablet rate windows. */
export const clock = (start = Date.parse('2026-11-14T15:00:00Z')) => {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => { t += ms; return new Date(t); },
  };
};

/** The credential generation in a tablet's ID token (`hh_gen`), for queued replays. */
export const tokenGeneration = (idToken: string): number =>
  Number((JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')) as { hh_gen?: unknown }).hh_gen);
