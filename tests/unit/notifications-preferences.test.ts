import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mutesCategory, readPushPrefs, validatePushPrefs } from '../../functions/src/shared/push-prefs';
import { pushHoldUntil } from '../../functions/src/shared/push-hold';
import { myPushDevices, nextPushDevices, pushDeviceKey, pushDeviceLabel } from '../../src/lib/push-tokens';

// NO-24 (per-member push preferences) and NO-26 (My devices).
describe('NO-24: push preferences', () => {
  test('stored preferences are read defensively', () => {
    assert.deepEqual(readPushPrefs(undefined), { mutedCategories: [], quietHours: null });
    assert.deepEqual(readPushPrefs({ mutedCategories: ['chores', 'nope', 'chores', 3], quietHours: { start: '21:00', end: '07:00' } }),
      { mutedCategories: ['chores'], quietHours: { start: '21:00', end: '07:00' } });
    assert.equal(readPushPrefs({ quietHours: { start: '9:00', end: '07:00' } }).quietHours, null);
  });

  test('what the Profile card may save', () => {
    assert.deepEqual(validatePushPrefs({ mutedCategories: ['pets'], quietHours: null }), { mutedCategories: ['pets'], quietHours: null });
    assert.equal(validatePushPrefs({ mutedCategories: ['secrets'], quietHours: null }), null);
    assert.equal(validatePushPrefs({ mutedCategories: [], quietHours: { start: '07:00', end: '07:00' } }), null);
    assert.equal(validatePushPrefs({ quietHours: null }), null);
  });

  test('a muted category gets no push; quiet hours hold it in the household zone (D-6)', () => {
    const prefs = readPushPrefs({ mutedCategories: ['maintenance'], quietHours: { start: '21:00', end: '07:30' } });
    assert.equal(mutesCategory(prefs, 'maintenance'), true);
    assert.equal(mutesCategory(prefs, 'chores'), false);
    // 22:00 in Chicago.
    const until = pushHoldUntil({ now: new Date('2026-11-13T04:00:00Z'), timeZone: 'America/Chicago', householdWide: false, morningHold: false, householdQuiet: null, memberQuiet: prefs.quietHours });
    assert.equal(until?.toISOString(), '2026-11-13T13:30:00.000Z');
  });
});

describe('NO-26: My devices', () => {
  test('device keys are stable, distinct and never contain the token', () => {
    const token = 'fcm-token-abc:APA91b_long_value';
    assert.equal(pushDeviceKey(token), pushDeviceKey(token));
    assert.notEqual(pushDeviceKey(token), pushDeviceKey(`${token}x`));
    assert.match(pushDeviceKey(token), /^d[0-9a-z]+$/);
    assert.equal(pushDeviceKey(token).includes('APA91b'), false);
  });

  test('labels say the browser and system only', () => {
    assert.equal(pushDeviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'), 'Chrome on Android');
    assert.equal(pushDeviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
    assert.equal(pushDeviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0'), 'Edge on Windows');
    assert.equal(pushDeviceLabel(''), 'Browser');
  });

  test('registering keeps the descriptions of kept tokens only and refreshes this one', () => {
    const stored = { [pushDeviceKey('old')]: { label: 'Gone', lastSeenAt: 1 }, [pushDeviceKey('kept')]: { label: 'Chrome on Mac', lastSeenAt: 2 } };
    const next = nextPushDevices(stored, ['kept', 'mine'], 'mine', { label: 'Safari on iPhone', lastSeenAt: 3 });
    assert.deepEqual(Object.keys(next).sort(), [pushDeviceKey('kept'), pushDeviceKey('mine')].sort());
    assert.equal(next[pushDeviceKey('mine')].label, 'Safari on iPhone');
  });

  test('the list has one entry per stored token, newest first, and marks this device', () => {
    const devices = { [pushDeviceKey('a')]: { label: 'Chrome on Mac', lastSeenAt: new Date('2026-11-01') }, [pushDeviceKey('b')]: { label: 'Safari on iPhone', lastSeenAt: new Date('2026-11-10') } };
    const list = myPushDevices(['a', 'b', 'c'], devices, 'a');
    assert.deepEqual(list.map((d) => d.label), ['Safari on iPhone', 'Chrome on Mac', 'Unknown device']);
    assert.equal(list.find((d) => d.token === 'a')?.thisDevice, true);
  });
});
