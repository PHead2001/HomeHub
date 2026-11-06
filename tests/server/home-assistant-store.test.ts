import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { HomeAssistantError } from '../../src/lib/server/home-assistant';
import { persistCredentials } from '../../src/lib/server/home-assistant-store';

// Against the Firestore emulator: the write re-checks household and membership.
const HOUSE = 'ha-store-house';
const house = () => adminDb.collection('households').doc(HOUSE);
const creds = () => house().collection('home-automation').doc('credentials');
const data = { url: 'https://ha.example.test', accessToken: 'x'.repeat(40) };

const refused = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error instanceof HomeAssistantError);
  assert.match(error.userMessage, pattern);
  return true;
});

beforeEach(async () => {
  await adminDb.recursiveDelete(house());
  await house().set({ name: 'HA Store' });
  await house().collection('members').doc('owner').set({ uid: 'owner', role: 'owner', status: 'active' });
  await house().collection('members').doc('member').set({ uid: 'member', role: 'member', status: 'active' });
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
});
