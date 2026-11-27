import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  arrangeEntities,
  describeEntityState,
  entityGroup,
  isNoiseEntity,
  sinceLabel,
  type HomeAssistantEntitySummary,
} from '../../src/lib/automation/entities';
import { SnapshotCache } from '../../src/lib/automation/snapshot-cache';
import { pollDue, updatedLabel } from '../../src/lib/automation/refresh';

const NOW = new Date('2026-11-27T22:30:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const entity = (entity_id: string, state: string, attributes: HomeAssistantEntitySummary['attributes'] = {}, last_changed?: string): HomeAssistantEntitySummary =>
  ({ entity_id, state, attributes, ...(last_changed ? { last_changed } : {}) });

describe('AU-2: noise and grouping', () => {
  it('hides Home Assistant plumbing and diagnostic sensors, keeps devices and low batteries', () => {
    for (const id of ['update.core', 'sun.sun', 'zone.home', 'automation.night', 'script.x', 'button.reboot', 'number.volume']) {
      assert.equal(isNoiseEntity(entity(id, 'on')), true, id);
    }
    assert.equal(isNoiseEntity(entity('sensor.wifi', '-60', { device_class: 'signal_strength' })), true);
    assert.equal(isNoiseEntity(entity('sensor.plug_rssi', '-60')), true);
    assert.equal(isNoiseEntity(entity('sensor.door_battery', '80', { device_class: 'battery' })), true);
    assert.equal(isNoiseEntity(entity('sensor.smoke_battery', '12', { device_class: 'battery' })), false, 'a low battery always shows');
    assert.equal(isNoiseEntity(entity('light.kitchen', 'on')), false);
  });

  it('groups by device class and maps more domains', () => {
    assert.equal(entityGroup(entity('binary_sensor.front', 'on', { device_class: 'door' })), 'Doors and windows');
    assert.equal(entityGroup(entity('binary_sensor.hall', 'off', { device_class: 'motion' })), 'Motion');
    assert.equal(entityGroup(entity('binary_sensor.sink', 'off', { device_class: 'moisture' })), 'Leaks');
    assert.equal(entityGroup(entity('sensor.lr_temp', '21', { device_class: 'temperature' })), 'Climate');
    assert.equal(entityGroup(entity('cover.garage', 'open', { device_class: 'garage' })), 'Doors and windows');
    assert.equal(entityGroup(entity('scene.movie', 'scening')), 'Scenes');
    assert.equal(entityGroup(entity('update.core', 'off')), 'Updates');
  });

  it('puts favourites first, counts what is hidden, and Show all brings it back', () => {
    const list = [entity('light.b', 'on', { friendly_name: 'B light' }), entity('update.core', 'off'), entity('light.a', 'off', { friendly_name: 'A light' })];
    const arranged = arrangeEntities(list, { showAll: false, search: '', favorites: ['light.b'] });
    assert.deepEqual(arranged.favorites.map((e) => e.entity_id), ['light.b']);
    assert.deepEqual(arranged.groups.map(([label, items]) => [label, items.map((e) => e.entity_id)]), [['Lights', ['light.a']]]);
    assert.equal(arranged.hiddenCount, 1);
    assert.equal(arrangeEntities(list, { showAll: true, search: '' }).groups.flatMap(([, items]) => items).length, 3);
    assert.equal(arrangeEntities(list, { showAll: true, search: 'a light' }).groups.flatMap(([, items]) => items).length, 1);
  });
});

describe('AU-3: states in plain words', () => {
  it('binary sensors use their device class', () => {
    assert.deepEqual(describeEntityState(entity('binary_sensor.front', 'on', { device_class: 'door' })), { label: 'Open', tone: 'on' });
    assert.deepEqual(describeEntityState(entity('binary_sensor.front', 'off', { device_class: 'door' })), { label: 'Closed', tone: 'off' });
    assert.deepEqual(describeEntityState(entity('binary_sensor.sink', 'on', { device_class: 'moisture' })), { label: 'Wet', tone: 'alert' });
    assert.deepEqual(describeEntityState(entity('binary_sensor.x', 'on')), { label: 'On', tone: 'on' });
  });

  it('timestamps are formatted in the household zone, numbers keep units, unavailable is plain', () => {
    const view = describeEntityState(entity('sensor.last_boot', '2026-11-27T14:05:00+00:00', { device_class: 'timestamp' }), 'America/Chicago');
    assert.match(view.label, /27 Nov.*08:05/);
    assert.equal(describeEntityState(entity('sensor.t', '21.5', { unit_of_measurement: '°C' })).label, '21.5 °C');
    assert.equal(describeEntityState(entity('sensor.b', '12', { device_class: 'battery', unit_of_measurement: '%' })).tone, 'alert');
    assert.equal(describeEntityState(entity('light.x', 'unavailable')).label, 'Unavailable');
  });

  it('says how long a state has held', () => {
    assert.equal(sinceLabel(ago(3), NOW), '3 min');
    assert.equal(sinceLabel(ago(0.2), NOW), 'just now');
    assert.equal(sinceLabel(ago(150), NOW), '2 h');
    assert.equal(sinceLabel(ago(60 * 24 * 3), NOW), '3 days');
    assert.equal(sinceLabel(undefined, NOW), null);
  });
});

describe('AU-10: one Home Assistant read per household per window', () => {
  it('serves concurrent and repeated callers from one load until the window passes', async () => {
    let clock = 0;
    let loads = 0;
    const cache = new SnapshotCache<number>(15_000, () => clock);
    const load = async () => ++loads;
    const [a, b] = await Promise.all([cache.get('h', 'v1', load), cache.get('h', 'v1', load)]);
    assert.equal(loads, 1);
    assert.equal(a.fresh, true);
    assert.equal(b.fresh, false);
    clock = 14_000;
    assert.equal((await cache.get('h', 'v1', load)).value, 1);
    clock = 15_000;
    assert.equal((await cache.get('h', 'v1', load)).value, 2);
    assert.equal((await cache.get('h', 'v2', load)).value, 3, 'new credentials never get the old answer');
    assert.equal((await cache.get('other', 'v1', load)).value, 4, 'households are separate');
    cache.invalidate('h');
    assert.equal((await cache.get('h', 'v2', load)).value, 5);
  });

  it('caches a failure too, so a failing Home Assistant is not hammered', async () => {
    let clock = 0;
    let loads = 0;
    const cache = new SnapshotCache<number>(15_000, () => clock);
    const load = async () => { loads += 1; throw new Error('down'); };
    await assert.rejects(cache.get('h', 'v', load));
    await assert.rejects(cache.get('h', 'v', load));
    assert.equal(loads, 1);
    clock = 20_000;
    await assert.rejects(cache.get('h', 'v', load));
    assert.equal(loads, 2);
  });
});

describe('AU-1: refresh', () => {
  it('labels the age of the data', () => {
    assert.equal(updatedLabel(1_000, 3_000), 'Updated just now');
    assert.equal(updatedLabel(0, 12_000), 'Updated 12 s ago');
    assert.equal(updatedLabel(0, 180_000), 'Updated 3 min ago');
    assert.equal(updatedLabel(null, 0), null);
  });

  it('polls only while visible and idle, every interval', () => {
    assert.equal(pollDue({ visible: true, inFlight: false, lastAttempt: null, now: 0 }), true);
    assert.equal(pollDue({ visible: false, inFlight: false, lastAttempt: null, now: 0 }), false);
    assert.equal(pollDue({ visible: true, inFlight: true, lastAttempt: null, now: 0 }), false);
    assert.equal(pollDue({ visible: true, inFlight: false, lastAttempt: 0, now: 29_999 }), false);
    assert.equal(pollDue({ visible: true, inFlight: false, lastAttempt: 0, now: 30_000 }), true);
  });
});
