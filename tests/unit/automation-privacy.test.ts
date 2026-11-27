import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isSensitiveEntity,
  maySeeSensitive,
  visibleEntities,
  type HomeAssistantEntitySummary,
} from '../../src/lib/automation/entities';
import { EMPTY_AUTOMATION_CONFIG, applyConfigChange, configForViewer, readAutomationConfig, validateAutomationConfig } from '../../src/lib/automation/config';
import { decryptToken, encryptToken, readStoredToken, readTokenKey, storedTokenFields } from '../../src/lib/automation/token-crypto';
import { automationInHeader } from '../../src/lib/navigation';

const entity = (entity_id: string, state: string, attributes: HomeAssistantEntitySummary['attributes'] = {}): HomeAssistantEntitySummary =>
  ({ entity_id, state, attributes });

describe('AU-11: people, trackers, cameras and locks', () => {
  it('are sensitive', () => {
    for (const id of ['person.alex', 'device_tracker.phone', 'camera.door', 'lock.front']) assert.equal(isSensitiveEntity(id), true, id);
    assert.equal(isSensitiveEntity('light.kitchen'), false);
  });

  it('owners and admins see them; members only when allowed; children and guests never', () => {
    assert.equal(maySeeSensitive('owner', false), true);
    assert.equal(maySeeSensitive('admin', false), true);
    assert.equal(maySeeSensitive('member', false), false);
    assert.equal(maySeeSensitive('member', true), true);
    assert.equal(maySeeSensitive('child', true), false);
    assert.equal(maySeeSensitive('guest', true), false);
  });

  it('are withheld by the server filter for anyone who may not see them', () => {
    const list = [entity('light.k', 'on'), entity('person.alex', 'home'), entity('camera.door', 'idle'), entity('lock.front', 'locked'), entity('device_tracker.phone', 'home')];
    assert.deepEqual(visibleEntities(list, 'child', true), { entities: [list[0]], hidden: 4 });
    assert.deepEqual(visibleEntities(list, 'guest', false).hidden, 4);
    assert.deepEqual(visibleEntities(list, 'member', false).hidden, 4);
    assert.deepEqual(visibleEntities(list, 'member', true).hidden, 0);
    assert.deepEqual(visibleEntities(list, 'owner', false).hidden, 0);
  });


  it('a viewer gets the privacy choice only as a manager, and sensitive favourites only when allowed', () => {
    const config = { favorites: ['light.k', 'lock.front'], rooms: { 'light.k': 'r' }, showSensitiveToMembers: false };
    assert.deepEqual(configForViewer(config, { role: 'member', canManage: false }), { favorites: ['light.k'], rooms: { 'light.k': 'r' }, showSensitiveToMembers: false });
    assert.deepEqual(configForViewer(config, { role: 'owner', canManage: true }), config);
    assert.deepEqual(configForViewer({ ...config, showSensitiveToMembers: true }, { role: 'child', canManage: false }).favorites, ['light.k']);
  });
});

describe('automation settings', () => {
  const good = { favorites: ['light.k'], rooms: { 'light.k': 'kitchen', 'binary_sensor.back': 'hall' }, showSensitiveToMembers: false };

  it('accepts a valid config and refuses bad parts whole', () => {
    assert.deepEqual(validateAutomationConfig(good), { ok: true, value: good });
    assert.equal(validateAutomationConfig({ ...good, rooms: { 'lock.front': 'hall' } }).ok, false, 'locks never go on the house');
    assert.equal(validateAutomationConfig({ ...good, favorites: ['not an id'] }).ok, false);
    assert.equal(validateAutomationConfig({ ...good, showSensitiveToMembers: 'yes' }).ok, false);
    assert.equal(validateAutomationConfig(null).ok, false);
  });

  it('reads stored config tolerantly, with privacy off by default', () => {
    assert.deepEqual(readAutomationConfig(undefined), EMPTY_AUTOMATION_CONFIG);
    assert.equal(readAutomationConfig({}).showSensitiveToMembers, false);
    const read = readAutomationConfig({ favorites: ['light.k', 'bad', 'light.k'], rooms: { 'lock.x': 'a', 'light.k': 'b' } });
    assert.deepEqual(read.favorites, ['light.k']);
    assert.deepEqual(read.rooms, { 'light.k': 'b' });
  });
});

describe('AU-12: token at rest', () => {
  const key = readTokenKey(Buffer.alloc(32, 7).toString('base64'))!;

  it('encrypts with the key, bound to the household, and refuses tampering', () => {
    const text = encryptToken('secret-token-value', key, 'house-1');
    assert.ok(!text.includes('secret'));
    assert.equal(decryptToken(text, key, 'house-1'), 'secret-token-value');
    assert.equal(decryptToken(text, key, 'house-2'), null);
    assert.equal(decryptToken(text.slice(0, -4) + 'AAAA', key, 'house-1'), null);
    assert.equal(decryptToken('plain', key, 'house-1'), null);
  });

  it('falls back to the plain field without a key, and reads both forms', () => {
    assert.equal(readTokenKey(undefined), null);
    assert.equal(readTokenKey('c2hvcnQ='), null);
    assert.deepEqual(storedTokenFields('t', null, 'h'), { accessToken: 't' });
    const stored = storedTokenFields('t', key, 'h');
    assert.ok(stored.accessTokenEnc && !('accessToken' in stored));
    assert.equal(readStoredToken(stored, key, 'h'), 't');
    assert.equal(readStoredToken(stored, null, 'h'), null, 'an encrypted token needs the key');
    assert.equal(readStoredToken({ accessToken: 'legacy' }, key, 'h'), 'legacy');
  });
});

describe('AU-6: the header slot', () => {
  it('only when connected, or for people who can connect it', () => {
    assert.equal(automationInHeader({ connected: false, canManage: false }), false);
    assert.equal(automationInHeader({ connected: true, canManage: false }), true);
    assert.equal(automationInHeader({ connected: false, canManage: true }), true);
  });
});

describe('one settings change at a time', () => {
  const stored = { favorites: ['light.a'], rooms: {}, showSensitiveToMembers: false };

  it('pinning or unpinning a favourite changes only the favourites', () => {
    assert.deepEqual(applyConfigChange(stored, { kind: 'favorite', entityId: 'light.b', pinned: true }), { ok: true, value: { favorites: ['light.a', 'light.b'], rooms: {}, showSensitiveToMembers: false } });
    assert.deepEqual(applyConfigChange(stored, { kind: 'favorite', entityId: 'light.a', pinned: false }), { ok: true, value: { favorites: [], rooms: {}, showSensitiveToMembers: false } });
    assert.deepEqual(applyConfigChange(stored, { kind: 'favorite', entityId: 'light.a', pinned: true }), { ok: true, value: stored }, 'pinning twice keeps one');
  });

  it('placing a device in a room, or taking it off the house, changes only the rooms', () => {
    const placed = applyConfigChange(stored, { kind: 'room', entityId: 'light.a', roomId: 'kitchen' });
    assert.deepEqual(placed, { ok: true, value: { favorites: ['light.a'], rooms: { 'light.a': 'kitchen' }, showSensitiveToMembers: false } });
    assert.ok(placed.ok);
    assert.deepEqual(applyConfigChange(placed.value, { kind: 'room', entityId: 'light.a', roomId: null }), { ok: true, value: stored });
    assert.equal(applyConfigChange(stored, { kind: 'room', entityId: 'lock.front', roomId: 'hall' }).ok, false, 'locks never go on the house');
    assert.equal(applyConfigChange(stored, { kind: 'room', entityId: 'light.a', roomId: 'a/b' }).ok, false);
  });

  it('the privacy choice changes only itself', () => {
    assert.deepEqual(applyConfigChange(stored, { kind: 'showSensitiveToMembers', show: true }), { ok: true, value: { favorites: ['light.a'], rooms: {}, showSensitiveToMembers: true } });
  });

  it('refuses anything else, including a whole config', () => {
    for (const change of [null, [], { kind: 'favorite', entityId: 'nope', pinned: true }, { kind: 'favorite', entityId: 'light.a' }, { kind: 'showSensitiveToMembers', show: 1 }, { ...stored }, { kind: 'config', ...stored }]) {
      assert.equal(applyConfigChange(stored, change).ok, false, JSON.stringify(change));
    }
  });

  it('refuses a favourite past the limit', () => {
    const full = { favorites: Array.from({ length: 40 }, (_, i) => `light.l${i}`), rooms: {}, showSensitiveToMembers: false };
    assert.equal(applyConfigChange(full, { kind: 'favorite', entityId: 'light.extra', pinned: true }).ok, false);
  });
});
