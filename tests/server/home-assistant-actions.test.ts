import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import {
  disconnectHomeAssistant,
  getHomeAssistantStatus,
  saveAutomationSettings,
} from '../../src/app/automation/actions';

// The automation server actions against the Auth and Firestore emulators. Home Assistant
// itself is never contacted here (the transport only reaches public addresses): every
// path tested decides before any request. AU-6, AU-11.
const HOUSE = 'ha-actions-house';
const house = adminDb.collection('households').doc(HOUSE);

const CALLERS = {
  owner: { uid: 'ha-owner', email: 'ha.owner@example.test', role: 'owner', permissions: {} },
  member: { uid: 'ha-member', email: 'ha.member@example.test', role: 'member', permissions: {} },
  controller: { uid: 'ha-controller', email: 'ha.controller@example.test', role: 'member', permissions: { 'automation.control': true } },
  child: { uid: 'ha-child', email: 'ha.child@example.test', role: 'child', permissions: { 'automation.view': true } },
} as const;
type Caller = keyof typeof CALLERS;
const tokens = new Map<Caller, string>();

async function idTokenFor(caller: Caller) {
  const { uid, email } = CALLERS[caller];
  await adminAuth.deleteUser(uid).catch(() => undefined);
  await adminAuth.createUser({ uid, email });
  const customToken = await adminAuth.createCustomToken(uid);
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  assert.ok(response.ok, `emulator sign-in for ${caller}`);
  return ((await response.json()) as { idToken: string }).idToken;
}

const as = (caller: Caller) => ({ idToken: tokens.get(caller)!, householdId: HOUSE });
const config = {
  favorites: ['light.k', 'lock.front'],
  showSensitiveToMembers: false,
};

before(async () => {
  for (const caller of Object.keys(CALLERS) as Caller[]) tokens.set(caller, await idTokenFor(caller));
});

beforeEach(async () => {
  await adminDb.recursiveDelete(house);
  await house.set({ name: 'HA Actions', timeZone: 'UTC' });
  for (const { uid, email, role, permissions } of Object.values(CALLERS)) {
    await house.collection('members').doc(uid).set({ uid, email, role, status: 'active', permissions, displayName: role });
  }
});

after(() => adminDb.recursiveDelete(house));

describe('settings and what each person is sent', () => {
  test('only managers save; invalid settings are refused whole', async () => {
    assert.equal((await saveAutomationSettings(as('member'), config)).ok, false);
    assert.equal((await saveAutomationSettings(as('owner'), { ...config, favorites: ['not an id'] })).ok, false);
    const saved = await saveAutomationSettings(as('owner'), config);
    assert.equal(saved.ok, true);
    assert.deepEqual((await house.collection('home-automation').doc('config').get()).get('favorites'), config.favorites);
  });

  test('AU-11: members and children get no privacy choice and no sensitive favourites', async () => {
    await saveAutomationSettings(as('owner'), config);
    const owner = await getHomeAssistantStatus(as('owner'));
    const member = await getHomeAssistantStatus(as('member'));
    const child = await getHomeAssistantStatus(as('child'));
    assert.ok(owner.ok && member.ok && child.ok);
    assert.deepEqual(owner.data.config.favorites, config.favorites);
    assert.equal(owner.data.canSeeSensitive, true);
    assert.deepEqual(member.data.config, { favorites: ['light.k'], showSensitiveToMembers: false });
    assert.equal(member.data.canSeeSensitive, false);
    assert.equal(child.data.canSeeSensitive, false);
    await saveAutomationSettings(as('owner'), { ...config, showSensitiveToMembers: true });
    const allowed = await getHomeAssistantStatus(as('member'));
    assert.ok(allowed.ok && allowed.data.canSeeSensitive);
    const stillChild = await getHomeAssistantStatus(as('child'));
    assert.ok(stillChild.ok && !stillChild.data.canSeeSensitive, 'children never, whatever the setting');
  });

  test('not connected: the status says so without contacting anything', async () => {
    const status = await getHomeAssistantStatus(as('member'));
    assert.ok(status.ok && status.data.configured === false);
  });

  test('opening the status backfills the connected flag for an older connection', async () => {
    await house.collection('home-automation').doc('credentials').set({ url: 'https://ha.example.test', accessToken: 'x'.repeat(40) });
    const status = await getHomeAssistantStatus(as('member'));
    assert.ok(status.ok && status.data.configured && status.data.host === 'ha.example.test');
    assert.deepEqual((await house.get()).get('homeAssistant'), { connected: true });
  });

  test('members cannot disconnect', async () => {
    await house.collection('home-automation').doc('credentials').set({ url: 'https://ha.example.test', accessToken: 'x'.repeat(40) });
    assert.equal((await disconnectHomeAssistant(as('member'))).ok, false);
    assert.equal((await house.collection('home-automation').doc('credentials').get()).exists, true);
    assert.equal((await disconnectHomeAssistant(as('owner'))).ok, true);
    assert.equal((await house.collection('home-automation').doc('credentials').get()).exists, false);
  });
});
