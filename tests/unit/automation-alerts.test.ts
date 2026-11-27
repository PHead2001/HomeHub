import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HomeAssistantEntitySummary } from '../../src/lib/automation/entities';
import { evaluateAlerts, inRuleWindow } from '../../src/lib/automation/alerts';

const NOW = new Date('2026-11-27T22:30:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const entity = (entity_id: string, state: string, attributes: HomeAssistantEntitySummary['attributes'] = {}, last_changed?: string): HomeAssistantEntitySummary =>
  ({ entity_id, state, attributes, ...(last_changed ? { last_changed } : {}) });

describe('AU-16 and AU-17: alerts', () => {
  it('leaks and smoke are urgent; batteries and filters become monthly maintenance notices', () => {
    const notices = evaluateAlerts({
      entities: [
        entity('binary_sensor.laundry_leak', 'on', { device_class: 'moisture', friendly_name: 'Laundry' }, '2026-11-27T22:29:00Z'),
        entity('binary_sensor.smoke', 'on', { device_class: 'smoke', friendly_name: 'Hall smoke' }, '2026-11-27T22:00:00Z'),
        entity('sensor.smoke_battery', '9', { device_class: 'battery', friendly_name: 'Smoke detector' }),
        entity('binary_sensor.hvac_filter', 'on', { friendly_name: 'HVAC filter' }),
      ],
      rules: [], timeZone: 'America/Chicago', now: NOW,
    });
    assert.deepEqual(notices.map((n) => [n.id, n.category, n.urgent]), [
      [`ha-leak-binary_sensor_laundry_leak-${Date.parse('2026-11-27T22:29:00Z')}`, 'automation', true],
      [`ha-safety-binary_sensor_smoke-${Date.parse('2026-11-27T22:00:00Z')}`, 'automation', true],
      ['ha-battery-sensor_smoke_battery-2026-11', 'maintenance', false],
      ['ha-filter-binary_sensor_hvac_filter-2026-11', 'maintenance', false],
    ]);
    assert.ok(notices.every((n) => !n.id.includes('/')));
  });

  it('a rule fires once the entity has been open long enough inside its window, once per episode', () => {
    const garage = entity('cover.garage', 'open', { device_class: 'garage', friendly_name: 'Garage' }, ago(12));
    const rule = { id: 'g1', entityId: 'cover.garage', minutes: 10, from: '22:00', to: '06:00' };
    // 22:30 UTC is 16:30 in Chicago: outside the window.
    assert.deepEqual(evaluateAlerts({ entities: [garage], rules: [rule], timeZone: 'America/Chicago', now: NOW }), []);
    const fired = evaluateAlerts({ entities: [garage], rules: [rule], timeZone: 'UTC', now: NOW });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].id, `ha-rule-g1-${Date.parse(garage.last_changed!)}`);
    assert.match(fired[0].message, /open for 12 min \(alert between 22:00 and 06:00\)/);
    assert.deepEqual(evaluateAlerts({ entities: [{ ...garage, last_changed: ago(5) }], rules: [rule], timeZone: 'UTC', now: NOW }), [], 'not yet 10 minutes');
    assert.deepEqual(evaluateAlerts({ entities: [{ ...garage, state: 'closed' }], rules: [rule], timeZone: 'UTC', now: NOW }), []);
  });

  it('windows cross midnight and an all-day rule always matches', () => {
    assert.equal(inRuleWindow({ from: '22:00', to: '06:00' }, 'UTC', new Date('2026-11-27T03:00:00Z')), true);
    assert.equal(inRuleWindow({ from: '22:00', to: '06:00' }, 'UTC', new Date('2026-11-27T12:00:00Z')), false);
    assert.equal(inRuleWindow({ from: null, to: null }, 'UTC', NOW), true);
  });
});

describe('AU-11 in alerts', () => {
  it('people, cameras and locks never notify', () => {
    const list = [entity('lock.front', 'unlocked'), entity('person.alex', 'home')];
    assert.deepEqual(evaluateAlerts({ entities: list, rules: [{ id: 'x', entityId: 'lock.front', minutes: 0, from: null, to: null }], timeZone: 'UTC', now: NOW }), []);
  });
});
