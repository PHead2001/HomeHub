import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { HomeAssistantError } from '../../src/lib/server/home-assistant';
import { changeConfig, deleteCredentials, persistCredentials, readConfig, readConnectedUrl, readCredentials, syncConnectedFlag } from '../../src/lib/server/home-assistant-store';

// Against the Firestore emulator: the write re-checks household and membership.
const HOUSE = 'ha-store-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const creds = () => house().collection('home-automation').doc('credentials');
const data = { url: 'https://ha.example.test', accessToken: 'x'.repeat(40) };
const audits = async () => (await house().collection('auditLogs').get()).docs.map((d) => d.data());

const refused = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error instanceof HomeAssistantError);
  assert.match(error.userMessage, pattern);
  return true;
});

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'HA Store' });
  await house().collection('members').doc('owner').set({ uid: 'owner', role: 'owner', status: 'active', displayName: 'Olive' });
  await house().collection('members').doc('member').set({ uid: 'member', role: 'member', status: 'active' });
});

afterEach(() => {
  delete process.env.HOMEHUB_HA_TOKEN_KEY;
});

after(() => adminDb.recursiveDelete(house()));

describe('Home Assistant credential storage', () => {
  test('an automation manager stores credentials', async () => {
    await persistCredentials(HOUSE, 'owner', data);
    assert.equal((await creds().get()).data()?.url, data.url);
  });

  test('a household being deleted, or gone, never gets credentials back', async () => {
    await house().update({ deletingAt: new Date() });
    await refused(persistCredentials(HOUSE, 'owner', data), /no longer available/);
    await adminDb.recursiveDelete(house());
    await refused(persistCredentials(HOUSE, 'owner', data), /no longer available/);
    assert.equal((await creds().get()).exists, false);
  });

  test('a caller who lost the permission or left is refused', async () => {
    await refused(persistCredentials(HOUSE, 'member', data), /no longer have permission/);
    await house().collection('members').doc('owner').update({ status: 'deleting' });
    await refused(persistCredentials(HOUSE, 'owner', data), /no longer have permission/);
    await refused(persistCredentials(HOUSE, 'stranger', data), /no longer have permission/);
    assert.equal((await creds().get()).exists, false);
  });

  test('AU-6, AU-12: connecting sets only a connected flag on the household and logs who did it, never the token', async () => {
    await persistCredentials(HOUSE, 'owner', data);
    assert.deepEqual((await house().get()).get('homeAssistant'), { connected: true }, 'no host: guests can read the household');
    const [entry] = await audits();
    assert.equal(entry.action, 'automation.connected');
    assert.equal(entry.actorUid, 'owner');
    assert.equal(entry.actorName, 'Olive');
    assert.equal(entry.actorEmail, null);
    assert.ok(!JSON.stringify(entry).includes(data.accessToken));
    assert.ok(!JSON.stringify((await house().get()).data()).includes(data.accessToken));
  });

  test('AU-12: with a key the token is stored encrypted, and read back', async () => {
    process.env.HOMEHUB_HA_TOKEN_KEY = Buffer.alloc(32, 3).toString('base64');
    await persistCredentials(HOUSE, 'owner', data);
    const stored = (await creds().get()).data()!;
    assert.equal(stored.accessToken, undefined);
    assert.match(stored.accessTokenEnc, /^v1:/);
    assert.ok(!JSON.stringify(stored).includes(data.accessToken));
    assert.equal((await readCredentials(HOUSE))?.token, data.accessToken);
    // Without the key the encrypted token can't be used, and says so; the address is still known.
    delete process.env.HOMEHUB_HA_TOKEN_KEY;
    await refused(readCredentials(HOUSE), /can no longer be read/);
    assert.equal(await readConnectedUrl(HOUSE), data.url);
  });

  test('AU-6: the flag follows the credentials read in the same transaction', async () => {
    await creds().set({ url: data.url, accessToken: data.accessToken });
    assert.equal(await syncConnectedFlag(HOUSE), true, 'a connection from before the flag gets it');
    assert.deepEqual((await house().get()).get('homeAssistant'), { connected: true });
    assert.equal(await syncConnectedFlag(HOUSE), false, 'nothing to change');
    // A disconnect that landed after a status request read the old address: the sync
    // decides from the credentials it reads itself, so the flag is cleared, not kept.
    await creds().delete();
    assert.equal(await syncConnectedFlag(HOUSE), true);
    assert.equal((await house().get()).get('homeAssistant'), undefined);
    assert.equal(await syncConnectedFlag(HOUSE), false, 'never set again without credentials');
    assert.equal((await house().get()).get('homeAssistant'), undefined);
  });

  test('AU-6: a sync racing a disconnect ends with no flag, whichever commits first', async () => {
    await persistCredentials(HOUSE, 'owner', data);
    await Promise.all([deleteCredentials(HOUSE, 'owner'), syncConnectedFlag(HOUSE), syncConnectedFlag(HOUSE)]);
    assert.equal((await creds().get()).exists, false);
    assert.equal((await house().get()).get('homeAssistant'), undefined);
  });

  test('a legacy plain token is still read', async () => {
    await creds().set({ url: data.url, accessToken: data.accessToken });
    assert.equal((await readCredentials(HOUSE))?.token, data.accessToken);
  });

  test('AU-9: replacing needs the same address still connected, and is logged', async () => {
    await refused(persistCredentials(HOUSE, 'owner', data, { mode: 'replace' }), /disconnected or changed/);
    await persistCredentials(HOUSE, 'owner', data);
    await persistCredentials(HOUSE, 'owner', { url: data.url, accessToken: 'y'.repeat(40) }, { mode: 'replace' });
    assert.equal((await readCredentials(HOUSE))?.token, 'y'.repeat(40));
    await refused(persistCredentials(HOUSE, 'owner', { url: 'https://other.example.test', accessToken: 'z'.repeat(40) }, { mode: 'replace' }), /disconnected or changed/);
    assert.ok((await audits()).some((entry) => entry.action === 'automation.token_replaced'));
  });

  test('disconnecting deletes the credentials, clears the flag and logs it; members cannot', async () => {
    await persistCredentials(HOUSE, 'owner', data);
    await refused(deleteCredentials(HOUSE, 'member'), /no longer have permission/);
    await deleteCredentials(HOUSE, 'owner');
    assert.equal((await creds().get()).exists, false);
    assert.equal((await house().get()).get('homeAssistant'), undefined);
    assert.ok((await audits()).some((entry) => entry.action === 'automation.disconnected'));
  });
});

describe('Home Assistant settings storage', () => {
  test('managers change one setting at a time; members cannot; the privacy choice is logged', async () => {
    await refused(changeConfig(HOUSE, 'member', { kind: 'favorite', entityId: 'light.k', pinned: true }), /no longer have permission/);
    assert.deepEqual(await changeConfig(HOUSE, 'owner', { kind: 'favorite', entityId: 'light.k', pinned: true }), { favorites: ['light.k'], rooms: {}, showSensitiveToMembers: false });
    await changeConfig(HOUSE, 'owner', { kind: 'showSensitiveToMembers', show: true });
    await changeConfig(HOUSE, 'owner', { kind: 'room', entityId: 'light.k', roomId: 'kitchen' });
    assert.deepEqual(await readConfig(HOUSE), { favorites: ['light.k'], rooms: { 'light.k': 'kitchen' }, showSensitiveToMembers: true });
    const entry = (await audits()).find((e) => e.action === 'automation.settings_changed');
    assert.equal(entry?.details.showSensitiveToMembers, true);
  });

  test('a favourite change never touches the privacy choice another manager made', async () => {
    await changeConfig(HOUSE, 'owner', { kind: 'showSensitiveToMembers', show: true });
    await changeConfig(HOUSE, 'owner', { kind: 'showSensitiveToMembers', show: false });
    // An older page pins a favourite: only the favourite changes.
    await changeConfig(HOUSE, 'owner', { kind: 'favorite', entityId: 'light.k', pinned: true });
    assert.equal((await readConfig(HOUSE)).showSensitiveToMembers, false);
    await changeConfig(HOUSE, 'owner', { kind: 'favorite', entityId: 'light.k', pinned: false });
    assert.deepEqual(await readConfig(HOUSE), { favorites: [], rooms: {}, showSensitiveToMembers: false });
  });

  test('concurrent changes from two pages both survive', async () => {
    await Promise.all([
      changeConfig(HOUSE, 'owner', { kind: 'favorite', entityId: 'light.a', pinned: true }),
      changeConfig(HOUSE, 'owner', { kind: 'favorite', entityId: 'light.b', pinned: true }),
      changeConfig(HOUSE, 'owner', { kind: 'showSensitiveToMembers', show: true }),
    ]);
    const config = await readConfig(HOUSE);
    assert.deepEqual([...config.favorites].sort(), ['light.a', 'light.b']);
    assert.equal(config.showSensitiveToMembers, true);
  });

  test('a malformed change is refused and nothing is written', async () => {
    await refused(changeConfig(HOUSE, 'owner', { kind: 'favorite', entityId: 'not an id', pinned: true }), /not a Home Assistant device/);
    await refused(changeConfig(HOUSE, 'owner', { kind: 'favorites', favorites: [] }), /could not be read/);
    await refused(changeConfig(HOUSE, 'owner', { kind: 'showSensitiveToMembers', show: 'yes' }), /privacy choice/);
    assert.equal((await house().collection('home-automation').doc('config').get()).exists, false);
  });

  test('no settings stored reads as privacy on', async () => {
    assert.equal((await readConfig(HOUSE)).showSensitiveToMembers, false);
  });
});
