import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clampText, safeDeepLink, selectRecipientEmails } from '../../functions/src/push-policy';

const members = [
  { uid: 'owner', email: 'owner@example.test', role: 'owner', status: 'active' },
  { uid: 'kid', email: 'kid@example.test', role: 'child', status: 'active' },
  { uid: 'pending', email: 'pending@example.test', role: 'newuser', status: 'pending' },
  { uid: 'odd', email: 'odd@example.test', role: 'super-admin', status: 'active' },
];

describe('push recipients', () => {
  test('untargeted notifications reach approved members only', () => {
    assert.deepEqual(selectRecipientEmails(members, {}).sort(), ['kid@example.test', 'owner@example.test']);
  });

  test('targets outside the approved membership receive nothing', () => {
    assert.deepEqual(selectRecipientEmails(members, { targetUserEmail: 'victim@gmail.com' }), []);
    assert.deepEqual(selectRecipientEmails(members, { targetUserUid: 'stranger' }), []);
    assert.deepEqual(selectRecipientEmails(members, { targetUserUid: 'pending' }), []);
  });

  test('targets that are approved members receive the push', () => {
    assert.deepEqual(selectRecipientEmails(members, { targetUserUid: 'kid' }), ['kid@example.test']);
    assert.deepEqual(selectRecipientEmails(members, { targetUserEmail: 'OWNER@example.test' }), ['owner@example.test']);
  });
});

describe('push content', () => {
  test('only in-app paths are opened', () => {
    assert.equal(safeDeepLink('/chores'), '/chores');
    assert.equal(safeDeepLink('/household?tab=members'), '/household?tab=members');
    for (const link of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 42, undefined]) {
      assert.equal(safeDeepLink(link), '/');
    }
  });

  test('titles and bodies are bounded with sensible fallbacks', () => {
    assert.equal(clampText('', 'HomeHub', 10), 'HomeHub');
    assert.equal(clampText('x'.repeat(20), 'HomeHub', 10).length, 10);
  });
});
