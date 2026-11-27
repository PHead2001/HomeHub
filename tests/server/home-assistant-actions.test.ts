import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { adminAuth, adminDb } from '../../src/lib/server/firebase-admin';
import {
  controlHomeAssistantEntity,
  disconnectHomeAssistant,
  getHomeAssistantStatus,
  getHomeStatus,
  addAutomationAlert,
  removeAutomationAlert,
  setAutomationFavorite,
  setAutomationRoom,
  setMembersSeeSensitive,
} from '../../src/app/automation/actions';
import { runAlerts } from '../../src/lib/server/home-assistant-snapshot';
import type { HomeAssistantEntitySummary } from '../../src/lib/automation/entities';

// The automation server actions against the Auth and Firestore emulators. Home Assistant
// itself is never contacted here (the transport only reaches public addresses): every
// path tested decides before any request. AU-4, AU-6, AU-11, AU-13, AU-14, AU-15, AU-16, AU-17.
const HOUSE = 'ha-actions-house';
const house = adminDb.collection('households').doc(HOUSE);

const CALLERS = {
  owner: { uid: 'ha-owner', email: 'ha.owner@example.test', role: 'owner', permissions: {} },
  member: { uid: 'ha-member', email: 'ha.member@example.test', role: 'member', permissions: {} },
  controller: { uid: 'ha-controller', email: 'ha.controller@example.test', role: 'member', permissions: { 'automation.control': true } },
  child: { uid: 'ha-child', email: 'ha.child@example.test', role: 'child', permissions: { 'automation.view': true } },
  childManager: { uid: 'ha-child-manager', email: 'ha.child.manager@example.test', role: 'child', permissions: { 'automation.view': true, 'automation.manage': true } },
  guestManager: { uid: 'ha-guest-manager', email: 'ha.guest.manager@example.test', role: 'guest', permissions: { 'automation.view': true, 'automation.manage': true } },
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
  rooms: { 'light.k': 'kitchen' },
  showSensitiveToMembers: false,
  alerts: [{ id: 'garage', entityId: 'cover.garage', minutes: 10, from: null, to: null }],
};
const configDoc = () => house.collection('home-automation').doc('config');
/** Stored settings as a manager left them (written directly, as setup). */
const seedConfig = (value: Record<string, unknown>) => configDoc().set(value);

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

describe('AU-14: controls are enforced on the server', () => {
  test('a member without automation.control is refused before anything else', async () => {
    const result = await controlHomeAssistantEntity(as('member'), { entityId: 'light.k', desired: 'on' });
    assert.deepEqual(result, { ok: false, message: 'You do not have permission to do that in this household.' });
  });

  test('locks, alarms, garage doors, covers and cameras are refused even with the permission', async () => {
    for (const entityId of ['lock.front', 'alarm_control_panel.home', 'cover.garage', 'camera.door', 'switch.heater', 'script.open']) {
      const result = await controlHomeAssistantEntity(as('controller'), { entityId, desired: 'off' });
      assert.equal(result.ok, false, entityId);
      assert.match((result as { message: string }).message, /only switch lights, fans and scenes/, entityId);
    }
  });

  test('a light when Home Assistant is not connected says so', async () => {
    const result = await controlHomeAssistantEntity(as('controller'), { entityId: 'light.k', desired: 'on' });
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /not connected/);
  });
});

describe('settings and what each person is sent', () => {
  test('AU-11: a settings change answers with what the caller may see, never sensitive favourites for a child or guest manager', async () => {
    await seedConfig({ ...config, favorites: ['light.k'], showSensitiveToMembers: true });
    for (const caller of ['childManager', 'guestManager'] as const) {
      const pinned = await setAutomationFavorite(as(caller), { entityId: 'lock.front', pinned: true });
      assert.ok(pinned.ok, caller);
      assert.deepEqual(pinned.data.favorites, ['light.k'], `${caller}: the lock is stored but not sent back`);
      const privacy = await setMembersSeeSensitive(as(caller), { show: true });
      assert.ok(privacy.ok && !privacy.data.favorites.includes('lock.front'), caller);
      const room = await setAutomationRoom(as(caller), { entityId: 'light.k', roomId: 'kitchen' });
      assert.ok(room.ok && !room.data.favorites.includes('lock.front'), caller);
      const rule = { id: `r-${caller}`, entityId: 'cover.garage', minutes: 5, from: null, to: null };
      const added = await addAutomationAlert(as(caller), { rule });
      assert.ok(added.ok && !added.data.favorites.includes('lock.front'), caller);
      const removed = await removeAutomationAlert(as(caller), { id: rule.id });
      assert.ok(removed.ok && !removed.data.favorites.includes('lock.front'), caller);
    }
    assert.deepEqual((await configDoc().get()).get('favorites'), ['light.k', 'lock.front']);
    // The owner's answer to the same kind of change still lists it.
    const owner = await setAutomationFavorite(as('owner'), { entityId: 'light.x', pinned: true });
    assert.ok(owner.ok && owner.data.favorites.includes('lock.front'));
  });

  test('only managers change settings; a bad change is refused', async () => {
    assert.equal((await setAutomationFavorite(as('member'), { entityId: 'light.k', pinned: true })).ok, false);
    assert.equal((await setMembersSeeSensitive(as('member'), { show: true })).ok, false);
    assert.equal((await setAutomationFavorite(as('owner'), { entityId: 'not an id', pinned: true })).ok, false);
    assert.equal((await setMembersSeeSensitive(as('owner'), { show: 'yes' as unknown as boolean })).ok, false);
    const saved = await setAutomationFavorite(as('owner'), { entityId: 'light.k', pinned: true });
    assert.deepEqual(saved, { ok: true, data: { favorites: ['light.k'], rooms: {}, showSensitiveToMembers: false, alerts: [] } });
    assert.equal((await configDoc().get()).exists, true);
  });

  test('pinning a favourite never turns member access back on (an older page)', async () => {
    await seedConfig({ favorites: [], rooms: {}, showSensitiveToMembers: true, alerts: [] });
    // Another manager turns member access off...
    assert.equal((await setMembersSeeSensitive(as('owner'), { show: false })).ok, true);
    // ...then a page loaded while it was on pins a favourite.
    const pinned = await setAutomationFavorite(as('owner'), { entityId: 'light.k', pinned: true });
    assert.ok(pinned.ok);
    assert.equal(pinned.data.showSensitiveToMembers, false);
    assert.equal((await configDoc().get()).get('showSensitiveToMembers'), false);
  });

  test('AU-11: members and children get no privacy choice, no alert rules and no sensitive favourites', async () => {
    await seedConfig(config);
    const owner = await getHomeAssistantStatus(as('owner'));
    const member = await getHomeAssistantStatus(as('member'));
    const child = await getHomeAssistantStatus(as('child'));
    assert.ok(owner.ok && member.ok && child.ok);
    assert.deepEqual(owner.data.config.favorites, config.favorites);
    assert.equal(owner.data.canSeeSensitive, true);
    assert.deepEqual(member.data.config, { favorites: ['light.k'], rooms: config.rooms, showSensitiveToMembers: false, alerts: [] });
    assert.equal(member.data.canSeeSensitive, false);
    assert.equal(child.data.canSeeSensitive, false);
    assert.equal((await setMembersSeeSensitive(as('owner'), { show: true })).ok, true);
    const allowed = await getHomeAssistantStatus(as('member'));
    assert.ok(allowed.ok && allowed.data.canSeeSensitive);
    const stillChild = await getHomeAssistantStatus(as('child'));
    assert.ok(stillChild.ok && !stillChild.data.canSeeSensitive, 'children never, whatever the setting');
  });

  test('AU-13: managers place one device at a time; other settings are kept', async () => {
    await seedConfig({ favorites: ['light.k'], rooms: {}, showSensitiveToMembers: false, alerts: [] });
    assert.equal((await setAutomationRoom(as('member'), { entityId: 'light.k', roomId: 'kitchen' })).ok, false);
    assert.equal((await setAutomationRoom(as('owner'), { entityId: 'lock.front', roomId: 'hall' })).ok, false, 'locks never go on the house');
    const placed = await setAutomationRoom(as('owner'), { entityId: 'light.k', roomId: 'kitchen' });
    assert.deepEqual(placed, { ok: true, data: { favorites: ['light.k'], rooms: { 'light.k': 'kitchen' }, showSensitiveToMembers: false, alerts: [] } });
    const removed = await setAutomationRoom(as('owner'), { entityId: 'light.k', roomId: null });
    assert.ok(removed.ok && Object.keys(removed.data.rooms).length === 0);
  });

  test('AU-17: alert rules are added and removed one at a time; other settings are kept', async () => {
    await seedConfig({ favorites: ['light.k'], rooms: {}, showSensitiveToMembers: true, alerts: [] });
    const rule = { id: 'garage', entityId: 'cover.garage', minutes: 10, from: '22:00', to: '06:00' };
    assert.equal((await addAutomationAlert(as('member'), { rule })).ok, false);
    assert.equal((await addAutomationAlert(as('owner'), { rule: { ...rule, entityId: 'person.alex' } })).ok, false, 'never on people');
    const added = await addAutomationAlert(as('owner'), { rule });
    assert.deepEqual(added, { ok: true, data: { favorites: ['light.k'], rooms: {}, showSensitiveToMembers: true, alerts: [rule] } });
    assert.equal((await addAutomationAlert(as('owner'), { rule })).ok, false, 'the same id twice');
    assert.equal((await removeAutomationAlert(as('member'), { id: 'garage' })).ok, false);
    const removed = await removeAutomationAlert(as('owner'), { id: 'garage' });
    assert.ok(removed.ok && removed.data.alerts.length === 0 && removed.data.showSensitiveToMembers === true);
  });

  test('not connected: the status and the dashboard card say so without contacting anything', async () => {
    const status = await getHomeAssistantStatus(as('member'));
    assert.ok(status.ok && status.data.configured === false);
    assert.deepEqual(await getHomeStatus(as('member')), { ok: true, data: { connected: false } });
  });

  test('opening the status backfills the connected flag for an older connection', async () => {
    await house.collection('home-automation').doc('credentials').set({ url: 'https://ha.example.test', accessToken: 'x'.repeat(40) });
    const status = await getHomeAssistantStatus(as('member'));
    assert.ok(status.ok && status.data.configured && status.data.host === 'ha.example.test');
    assert.deepEqual((await house.get()).get('homeAssistant'), { connected: true });
  });

  test('a scene can only be turned on', async () => {
    const result = await controlHomeAssistantEntity(as('controller'), { entityId: 'scene.movie', desired: 'off' });
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, /only switch lights, fans and scenes/);
  });

  test('members cannot disconnect', async () => {
    await house.collection('home-automation').doc('credentials').set({ url: 'https://ha.example.test', accessToken: 'x'.repeat(40) });
    assert.equal((await disconnectHomeAssistant(as('member'))).ok, false);
    assert.equal((await house.collection('home-automation').doc('credentials').get()).exists, true);
    assert.equal((await disconnectHomeAssistant(as('owner'))).ok, true);
    assert.equal((await house.collection('home-automation').doc('credentials').get()).exists, false);
  });
});

describe('AU-16, AU-17: alerts written from fresh states', () => {
  const entity = (entity_id: string, state: string, attributes: HomeAssistantEntitySummary['attributes'], last_changed?: string): HomeAssistantEntitySummary =>
    ({ entity_id, state, attributes, ...(last_changed ? { last_changed } : {}) });
  const now = new Date('2026-11-27T23:30:00Z');
  const snapshot = {
    total: 4,
    truncated: false,
    entities: [
      entity('cover.garage', 'open', { device_class: 'garage', friendly_name: 'Garage' }, '2026-11-27T23:00:00Z'),
      entity('binary_sensor.leak', 'on', { device_class: 'moisture', friendly_name: 'Laundry' }, '2026-11-27T23:29:00Z'),
      entity('sensor.smoke_battery', '8', { device_class: 'battery', friendly_name: 'Smoke detector' }),
      entity('person.alex', 'not_home', {}),
    ],
  };
  const notices = async () => (await house.collection('notifications').get()).docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>);

  test('one household-wide notice per event, muted in quiet hours except urgent ones, never twice', async () => {
    await seedConfig(config);
    await house.update({ quietHours: { start: '22:00', end: '07:00' } });
    assert.equal(await runAlerts(HOUSE, snapshot, now), 3);
    const written = await notices();
    const byType = Object.fromEntries(written.map((n) => [n.sourceType, n]));
    assert.equal(byType['ha-leak'].category, 'automation');
    assert.equal(byType['ha-leak'].silent, undefined, 'a leak pushes even in quiet hours');
    assert.equal(byType['ha-rule'].silent, true);
    assert.equal(byType['ha-battery'].category, 'maintenance');
    assert.equal(byType['ha-battery'].silent, true);
    for (const notice of written) assert.deepEqual(notice.audience, ['*']);
    assert.ok(!written.some((n) => JSON.stringify(n).includes('person.alex')), 'people never notify');
    assert.equal(await runAlerts(HOUSE, snapshot, new Date(now.getTime() + 60_000)), 0, 'the same events never notify twice');
    assert.equal((await notices()).length, 3);
  });

  test('outside quiet hours notices push', async () => {
    assert.equal(await runAlerts(HOUSE, snapshot, new Date('2026-11-27T12:00:00Z')), 2);
    assert.ok((await notices()).every((n) => n.silent === undefined));
  });
});
