import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defaultDeviceSettings,
  readDeviceSettings,
  readSectionsInput,
  readStartPage,
  startPageSection,
  validateDevicePatch,
} from '../../src/lib/devices/settings';
import { readDeviceClaims } from '../../src/lib/devices/types';
import { codeFromScan, codeFromSetupFragment, deviceSetupUrl, normalizeDeviceCode } from '../../src/lib/devices/device-codes';
import { clearPushState } from '../../src/lib/devices/push-clear';
import { DEVICE_GOOGLE_SIGN_IN_REFUSAL, devicePrincipalOf, looksLikeDevice } from '../../src/lib/devices/principal';

// Device record settings (docs/modules/devices/README.md, "Device record and settings"),
// the claims shape, the setup URL fragment, and push clearing before device sign-in.

const base = () => defaultDeviceSettings('Kitchen tablet', 'Kitchen');

const ok = (patch: unknown, current = base(), scope: 'admin' | 'comfort' = 'admin') => {
  const result = validateDevicePatch(patch, current, scope);
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  return result;
};
const refused = (patch: unknown, field: string, current = base(), scope: 'admin' | 'comfort' = 'admin', code = 'invalid_input') => {
  const result = validateDevicePatch(patch, current, scope);
  assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(patch)}`);
  if (!result.ok) {
    assert.equal(result.field, field);
    assert.equal(result.code, code);
  }
};

describe('device settings: defaults and stored records', () => {
  it('defaults: every section on, Home, 115% text, idle 2 and 10 minutes, front camera, weather off', () => {
    const settings = base();
    assert.deepEqual(settings.sections, { chores: true, shopping: true, pets: true, calendar: true, maintenance: true });
    assert.deepEqual(settings.startPage, { kind: 'home' });
    assert.deepEqual(settings.comfort, { theme: 'system', textScale: 115, motion: 'system', sound: true });
    assert.deepEqual(settings.display, { weather: false, weatherPlace: null, temperatureUnit: 'C', seasonal: true });
    assert.deepEqual(settings.idle, { homeAfterSec: 120, ambientAfterSec: 600 });
    assert.equal(settings.camera, 'front');
  });

  it('a stored record with missing or malformed fields reads as defaults', () => {
    const read = readDeviceSettings({ name: '  Hall  ', room: 'Hall', sections: { pets: false, bogus: true }, comfort: { textScale: 999 }, startPage: { kind: 'nowhere' }, idle: { homeAfterSec: 5 } });
    assert.equal(read.name, 'Hall');
    assert.equal(read.sections.pets, false);
    assert.equal(read.sections.chores, true);
    assert.equal(read.comfort.textScale, 115);
    assert.deepEqual(read.startPage, { kind: 'home' });
    assert.equal(read.idle.homeAfterSec, 120);
    assert.equal(readDeviceSettings(undefined).name, 'Wall tablet');
  });

  it('sections on a new code: booleans of known sections only, missing ones on', () => {
    assert.deepEqual(readSectionsInput(undefined), { chores: true, shopping: true, pets: true, calendar: true, maintenance: true });
    assert.equal(readSectionsInput({ pets: false })?.pets, false);
    assert.equal(readSectionsInput({ pets: 'no' }), null);
    assert.equal(readSectionsInput({ automation: true }), null);
    assert.equal(readSectionsInput([true]), null);
  });

  it('start pages: known kinds only, ids without slashes, the section each lives in', () => {
    assert.deepEqual(readStartPage({ kind: 'chores-room', roomId: 'r1' }), { kind: 'chores-room', roomId: 'r1' });
    assert.equal(readStartPage({ kind: 'chores-room', roomId: 'a/b' }), null);
    assert.equal(readStartPage({ kind: 'chores-room' }), null);
    assert.equal(readStartPage({ kind: 'home', extra: 1 }), null);
    assert.equal(readStartPage({ kind: 'settings' }), null);
    assert.equal(startPageSection({ kind: 'shopping-list', listId: 'l' }), 'shopping');
    assert.equal(startPageSection({ kind: 'chores-room', roomId: 'r' }), 'chores');
    assert.equal(startPageSection({ kind: 'home' }), null);
  });
});

describe('device settings: validating an edit', () => {
  it('writes only the fields that change, as dotted paths, and names the changed settings', () => {
    const result = ok({ name: ' Hall tablet ', sections: { pets: false, chores: true }, comfort: { theme: 'dark' } });
    assert.deepEqual(result.updates, { name: 'Hall tablet', 'sections.pets': false, 'comfort.theme': 'dark' });
    assert.deepEqual(result.changed.sort(), ['comfort', 'name', 'sections']);
  });

  it('an edit that changes nothing writes nothing', () => {
    const result = ok({ name: 'Kitchen tablet', comfort: { sound: true } });
    assert.deepEqual(result.updates, {});
    assert.deepEqual(result.changed, []);
  });

  it('names and rooms: 1 to 40 characters after trimming', () => {
    refused({ name: '   ' }, 'name');
    refused({ name: 'x'.repeat(41) }, 'name');
    refused({ room: '' }, 'room');
    refused({ room: 7 }, 'room');
    ok({ name: 'x'.repeat(40), room: 'y'.repeat(40) });
  });

  it('unknown or malformed fields are refused', () => {
    refused({ status: 'active' }, 'status');
    refused({ generation: 9 }, 'generation');
    refused({ lastSeenAt: 1 }, 'lastSeenAt');
    refused({ sections: { automation: true } }, 'sections');
    refused({ sections: { pets: 'off' } }, 'sections');
    refused({ comfort: { textScale: 120 } }, 'comfort.textScale');
    refused({ comfort: { theme: 'neon' } }, 'comfort.theme');
    refused({ comfort: { brightness: 1 } }, 'comfort.brightness');
    refused({ display: { temperatureUnit: 'K' } }, 'display.temperatureUnit');
    refused({ display: { weatherPlace: 'x'.repeat(81) } }, 'display.weatherPlace');
    refused({ camera: 'side' }, 'camera');
    refused({}, 'patch');
    refused(null, 'patch');
    refused([], 'patch');
  });

  it('weather place: trimmed, 1 to 80 characters, or cleared with null or an empty string', () => {
    assert.equal(ok({ display: { weatherPlace: ' Austin ' } }).next.display.weatherPlace, 'Austin');
    const withPlace = { ...base(), display: { ...base().display, weatherPlace: 'Austin' } };
    assert.equal(ok({ display: { weatherPlace: '' } }, withPlace).next.display.weatherPlace, null);
    assert.equal(ok({ display: { weatherPlace: null } }, withPlace).updates['display.weatherPlace'], null);
  });

  it('idle: home 30 s to 30 min; ambient no sooner than home and within 2 hours, against the resulting values', () => {
    refused({ idle: { homeAfterSec: 29 } }, 'idle.homeAfterSec');
    refused({ idle: { homeAfterSec: 1801 } }, 'idle.homeAfterSec');
    refused({ idle: { homeAfterSec: 60.5 } }, 'idle.homeAfterSec');
    refused({ idle: { ambientAfterSec: 60 } }, 'idle.ambientAfterSec');
    refused({ idle: { ambientAfterSec: 7201 } }, 'idle.ambientAfterSec');
    // Raising home above the stored ambient needs ambient raised too.
    refused({ idle: { homeAfterSec: 900 } }, 'idle.ambientAfterSec');
    assert.deepEqual(ok({ idle: { homeAfterSec: 900, ambientAfterSec: 900 } }).next.idle, { homeAfterSec: 900, ambientAfterSec: 900 });
  });

  it('start page in a section that is off is refused (D-T18)', () => {
    const petsOff = { ...base(), sections: { ...base().sections, pets: false } };
    refused({ startPage: { kind: 'pets' } }, 'startPage', petsOff, 'admin', 'start_page_section_off');
    refused({ startPage: { kind: 'pets' }, sections: { pets: false } }, 'startPage', base(), 'admin', 'start_page_section_off');
    assert.deepEqual(ok({ startPage: { kind: 'pets' }, sections: { pets: true } }, petsOff).next.startPage, { kind: 'pets' });
  });

  it('switching off the section that holds the start page resets it to Home in the same write', () => {
    const onShoppingList = { ...base(), startPage: { kind: 'shopping-list', listId: 'groceries' } as const };
    const result = ok({ sections: { shopping: false } }, onShoppingList);
    assert.deepEqual(result.updates, { 'sections.shopping': false, startPage: { kind: 'home' } });
    assert.ok(result.changed.includes('startPage'));
    // Another section going off leaves the start page alone.
    assert.deepEqual(ok({ sections: { pets: false } }, onShoppingList).next.startPage, { kind: 'shopping-list', listId: 'groceries' });
  });

  it('comfort scope (the tablet itself) accepts only the four comfort fields', () => {
    assert.deepEqual(ok({ comfort: { textScale: 130, sound: false } }, base(), 'comfort').updates, { 'comfort.textScale': 130, 'comfort.sound': false });
    refused({ name: 'Mine now' }, 'name', base(), 'comfort');
    refused({ sections: { pets: false } }, 'sections', base(), 'comfort');
    refused({ display: { weather: true } }, 'display', base(), 'comfort');
    refused({ comfort: { textScale: 130 }, camera: 'rear' }, 'camera', base(), 'comfort');
  });
});

describe('device claims', () => {
  const D = 'abcdefghij0123456789';
  const good = { uid: `device_${D}`, hh_kind: 'device', hh_household: 'house-1', hh_device: D, hh_gen: 2, signInProvider: 'custom' };

  it('a well-formed device token', () => {
    assert.deepEqual(readDeviceClaims(good), { hh_kind: 'device', hh_household: 'house-1', hh_device: D, hh_gen: 2 });
  });

  it('forged or malformed tokens are not devices', () => {
    assert.equal(readDeviceClaims({ ...good, email: 'x@example.test' }), null);
    assert.equal(readDeviceClaims({ ...good, uid: `device_${'z'.repeat(20)}` }), null);
    assert.equal(readDeviceClaims({ ...good, signInProvider: 'google.com' }), null);
    assert.equal(readDeviceClaims({ ...good, hh_gen: '2' }), null);
    assert.equal(readDeviceClaims({ ...good, hh_gen: 0 }), null);
    assert.equal(readDeviceClaims({ ...good, hh_gen: 1.5 }), null);
    assert.equal(readDeviceClaims({ ...good, hh_kind: 'person' }), null);
    assert.equal(readDeviceClaims({ ...good, hh_household: 'a/b' }), null);
    assert.equal(readDeviceClaims({ ...good, hh_device: 'short', uid: 'device_short' }), null);
  });
});

describe('setup URL and codes', () => {
  it('the code travels in the fragment and normalizes loosely typed input', () => {
    const url = deviceSetupUrl('https://homehub.example/', 'ABCD-EFGH-JK');
    assert.equal(url, 'https://homehub.example/setup#code=ABCD-EFGH-JK');
    assert.equal(new URL(url).search, '');
    assert.equal(codeFromSetupFragment('#code=abcd-efgh-jk'), 'ABCD-EFGH-JK');
    assert.equal(codeFromSetupFragment('#x=1&code=ABCDEFGHJK'), 'ABCD-EFGH-JK');
    assert.equal(codeFromSetupFragment('#code=ABC'), null);
    assert.equal(codeFromSetupFragment('#code=%E0%A4%A'), null);
    assert.equal(codeFromSetupFragment(''), null);
    assert.equal(normalizeDeviceCode(' abcd efgh jk '), 'ABCD-EFGH-JK');
  });

  it('a scan is accepted from this origin\'s setup link or as a bare code', () => {
    const origin = 'https://homehub.example';
    assert.equal(codeFromScan('https://homehub.example/setup#code=ABCD-EFGH-JK', origin), 'ABCD-EFGH-JK');
    assert.equal(codeFromScan('https://evil.example/setup#code=ABCD-EFGH-JK', origin), null);
    assert.equal(codeFromScan('https://homehub.example/other#code=ABCD-EFGH-JK', origin), null);
    assert.equal(codeFromScan('ABCD-EFGH-JK', origin), 'ABCD-EFGH-JK');
    assert.equal(codeFromScan('hello', origin), null);
  });
});

describe('push clearing before device sign-in', () => {
  it('deletes the FCM token, ends the subscription and drops the stored record', async () => {
    const calls: string[] = [];
    const result = await clearPushState({
      deleteFcmToken: async () => { calls.push('token'); },
      getSubscriptions: async () => [{ unsubscribe: async () => { calls.push('unsubscribe'); return true; } }],
      clearStoredRecord: () => { calls.push('record'); },
    });
    assert.deepEqual(calls, ['token', 'unsubscribe', 'record']);
    assert.deepEqual(result, { ok: true, unsubscribed: 1, errors: [] });
  });

  it('runs every step whatever fails, and reports not ok', async () => {
    const calls: string[] = [];
    const result = await clearPushState({
      deleteFcmToken: async () => { throw new Error('offline'); },
      getSubscriptions: async () => [{ unsubscribe: async () => { calls.push('unsubscribe'); return false; } }],
      clearStoredRecord: () => { calls.push('record'); },
    });
    assert.deepEqual(calls, ['unsubscribe', 'record']);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
  });
});

describe('principal switch (AuthProvider, S4)', () => {
  const D = 'abcdefghij0123456789';
  const user = (fields: { uid: string; email: string | null; claims?: Record<string, unknown>; provider?: string | null; fails?: boolean }) => {
    let reads = 0;
    return {
      uid: fields.uid,
      email: fields.email,
      reads: () => reads,
      getIdTokenResult: async () => {
        reads += 1;
        if (fields.fails) throw new Error('offline');
        return { claims: fields.claims ?? {}, signInProvider: fields.provider ?? null };
      },
    };
  };

  it('a device token becomes a device principal from its claims', async () => {
    const tablet = user({ uid: `device_${D}`, email: null, claims: { hh_kind: 'device', hh_household: 'h1', hh_device: D, hh_gen: 3 }, provider: 'custom' });
    assert.deepEqual(await devicePrincipalOf(tablet), { kind: 'device', deviceId: D, householdId: 'h1', generation: 3 });
  });

  it('a person (any user with an email) never waits for a token read and is never a device', async () => {
    const person = user({ uid: 'google-uid', email: 'p@example.test', claims: { hh_kind: 'device', hh_household: 'h1', hh_device: D, hh_gen: 3 } });
    assert.equal(await devicePrincipalOf(person), null);
    assert.equal(person.reads(), 0);
    assert.equal(looksLikeDevice(person), false);
  });

  it('a device_ user whose claims cannot be read is still a tablet (never the personal flow)', async () => {
    const offline = user({ uid: `device_${D}`, email: null, fails: true });
    assert.deepEqual(await devicePrincipalOf(offline), { kind: 'device', deviceId: D, householdId: '', generation: 0 });
    assert.equal(looksLikeDevice(offline), true);
  });

  it('a user without email or device claims and without the device_ prefix is not a device', async () => {
    assert.equal(await devicePrincipalOf(user({ uid: 'anon', email: null })), null);
    assert.equal(DEVICE_GOOGLE_SIGN_IN_REFUSAL.includes('wall tablet'), true);
  });
});
