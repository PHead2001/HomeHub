import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HomeAssistantEntitySummary } from '../../src/lib/automation/entities';
import { controlFor, controlService, isControllable, isSafeScene } from '../../src/lib/automation/controls';

const entity = (entity_id: string, state: string, attributes: HomeAssistantEntitySummary['attributes'] = {}): HomeAssistantEntitySummary =>
  ({ entity_id, state, attributes });

describe('AU-14: safe controls', () => {
  it('only lights, fans and scenes, with explicit on or off', () => {
    assert.deepEqual(controlService('light.kitchen', 'on'), { domain: 'light', service: 'turn_on', entityId: 'light.kitchen' });
    assert.deepEqual(controlService('fan.bedroom', 'off'), { domain: 'fan', service: 'turn_off', entityId: 'fan.bedroom' });
    assert.deepEqual(controlService('scene.movie', 'on'), { domain: 'scene', service: 'turn_on', entityId: 'scene.movie' });
    for (const [id, desired] of [
      ['scene.movie', 'off'], ['lock.front', 'off'], ['alarm_control_panel.home', 'off'], ['cover.garage', 'on'],
      ['camera.door', 'on'], ['switch.heater', 'on'], ['script.unlock', 'on'], ['light.x', 'toggle'],
      ['light.kitchen/../lock', 'on'], ['Light.Kitchen', 'on'], ['homeassistant.restart', 'on'],
    ] as const) {
      assert.equal(controlService(id, desired), null, `${id} ${desired}`);
    }
    assert.equal(controlService(42, 'on'), null);
    assert.equal(isControllable('light.ok_1'), true);
  });

  it('offers a switch for lights and fans, Activate for scenes, nothing for unavailable or other domains', () => {
    assert.deepEqual(controlFor(entity('light.k', 'on')), { kind: 'switch', on: true });
    assert.deepEqual(controlFor(entity('scene.s', 'scening', { entity_id: ['light.a', 'fan.b'] })), { kind: 'scene' });
    assert.equal(controlFor(entity('scene.s', 'scening')), null, 'a scene that does not list its members is never run');
    assert.equal(controlFor(entity('scene.s', 'scening', { entity_id: ['light.a', 'lock.front'] })), null, 'a scene that unlocks is never run');
    assert.equal(isSafeScene(entity('scene.s', 'x', { entity_id: ['cover.garage'] })), false);
    assert.equal(isSafeScene(entity('light.a', 'on', { entity_id: ['light.a'] })), false);
    assert.equal(controlFor(entity('light.k', 'unavailable')), null);
    assert.equal(controlFor(entity('lock.front', 'locked')), null);
  });
});
