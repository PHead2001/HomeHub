import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HomeAssistantEntitySummary } from '../../src/lib/automation/entities';
import { homeStatus, houseDevices, roomDevicesLabel } from '../../src/lib/automation/home-status';

const NOW = new Date('2026-11-27T22:30:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const entity = (entity_id: string, state: string, attributes: HomeAssistantEntitySummary['attributes'] = {}, last_changed?: string): HomeAssistantEntitySummary =>
  ({ entity_id, state, attributes, ...(last_changed ? { last_changed } : {}) });

describe('AU-15 home status and AU-13 house marks', () => {
  const list = [
    entity('light.kitchen', 'on', { friendly_name: 'Kitchen light' }),
    entity('light.hall', 'off'),
    entity('binary_sensor.back_door', 'on', { device_class: 'door', friendly_name: 'Back door' }, ago(14)),
    entity('binary_sensor.front_door', 'off', { device_class: 'door' }),
    entity('binary_sensor.laundry_leak', 'on', { device_class: 'moisture', friendly_name: 'Laundry' }, ago(1)),
    entity('sensor.smoke_battery', '12', { device_class: 'battery', friendly_name: 'Smoke detector' }),
    entity('climate.home', 'heat', { current_temperature: 71.4, unit_of_measurement: '°F' }),
    entity('sensor.outdoor_temp', '40', { device_class: 'temperature' }),
  ];

  it('summarises the house in one line with warnings worst first', () => {
    const status = homeStatus(list, NOW);
    assert.equal(status.line, '1 door or window open · 1 light on · 71 °F inside');
    assert.deepEqual(status.warnings, ['Leak: Laundry', 'Back door open 14 min', 'Low battery: Smoke detector (12%)']);
    assert.equal(homeStatus([entity('binary_sensor.d', 'off', { device_class: 'door' }), entity('light.x', 'off')], NOW).line, 'All doors closed · Lights off');
  });

  it('uses an indoor temperature sensor when there is no thermostat', () => {
    const status = homeStatus([entity('sensor.outdoor_temp', '40', { device_class: 'temperature', unit_of_measurement: '°F' }), entity('sensor.living_temp', '70.6', { device_class: 'temperature', unit_of_measurement: '°F' })], NOW);
    assert.equal(status.insideTemperature, '71 °F');
  });

  it('marks rooms from the household links', () => {
    const rooms = houseDevices(list, { 'light.kitchen': 'kitchen', 'binary_sensor.back_door': 'hall', 'binary_sensor.laundry_leak': 'laundry', 'light.gone': 'kitchen' });
    assert.deepEqual(rooms.kitchen, { lights: 1, lightsOn: 1, open: 0, leak: false, names: ['Kitchen light'] });
    assert.deepEqual(houseDevices([entity('light.k', 'off')], { 'light.k': 'kitchen' }).kitchen, { lights: 1, lightsOn: 0, open: 0, leak: false, names: [] }, 'a placed light that is off keeps the window dark');
    assert.equal(rooms.hall.open, 1);
    assert.equal(rooms.laundry.leak, true);
    assert.equal(roomDevicesLabel(rooms.laundry), 'leak detected');
    assert.equal(roomDevicesLabel(undefined), null);
  });
});

describe('AU-11 on the dashboard', () => {
  it('people, cameras and locks never reach the home status or the house', () => {
    const list = [entity('lock.front', 'unlocked'), entity('person.alex', 'home')];
    assert.equal(homeStatus(list, NOW).line, 'Connected');
    assert.deepEqual(houseDevices(list, { 'lock.front': 'kitchen' }), {});
  });
});
