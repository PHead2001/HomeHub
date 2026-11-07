import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { exceedsPayloadBudget, executeAuthorizedAiAction, MAX_AI_ACTION_PAYLOAD_BYTES } from '../../src/ai/action-auth';

// Oversized payloads are rejected before authorization or any schema validation,
// so that work stays bounded to small inputs. This was added for the zod 3
// advisory GHSA-mrhx-c7xc-m3w5 (fixed by zod 4.6.6+) and stays as defense in depth.
describe('AI action payload limit', () => {
  const context = { idToken: 'not-a-real-token', householdId: 'the-foxy-residence-e2e' };

  test('rejects an oversized payload before authorization and never runs the task', async () => {
    let ran = false;
    const items = Array.from({ length: 5_000 }, (_, index) => ({ name: `Item ${index} with a padded name`, quantity: 1 }));
    assert.ok(JSON.stringify(items).length > MAX_AI_ACTION_PAYLOAD_BYTES);
    const result = await executeAuthorizedAiAction({
      context,
      input: { items },
      permission: 'shopping.view',
      flowName: 'recipe',
      maxRequestsPerMinute: 20,
      task: async () => { ran = true; return 'unreachable'; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'invalid_input');
    assert.equal(ran, false);
  });

  test('a normal-sized payload reaches authorization (the size check comes first, not instead)', async () => {
    let ran = false;
    const result = await executeAuthorizedAiAction({
      context,
      input: { items: [{ name: 'Rice', quantity: 1 }, { name: 'Beans', quantity: 2 }] },
      permission: 'shopping.view',
      flowName: 'recipe',
      maxRequestsPerMinute: 20,
      task: async () => { ran = true; return 'unreachable'; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'unauthenticated');
    assert.equal(ran, false);
  });

  test('the limit leaves ample room for the largest real input', () => {
    // A full recipe request: 60 pantry items with long names, units and locations.
    const items = Array.from({ length: 60 }, (_, index) => ({ name: `Pantry item number ${index} with a long name`, quantity: 12, unit: 'items', location: 'Pantry' }));
    assert.ok(JSON.stringify({ context, input: { items } }).length < MAX_AI_ACTION_PAYLOAD_BYTES / 4);
  });
  test('shared references cannot blow up the check (bounded work, no expansion)', () => {
    // Server Actions can transport shared references. 40 doublings would be ~10^12
    // nodes if expanded; the check must stop at the budget almost immediately.
    let graph: unknown = 'x';
    for (let level = 0; level < 40; level += 1) graph = [graph, graph];
    const started = performance.now();
    assert.equal(exceedsPayloadBudget({ input: graph }, MAX_AI_ACTION_PAYLOAD_BYTES), true);
    assert.ok(performance.now() - started < 250, 'the check stays fast');
  });

  test('cycles are rejected, not looped on', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    assert.equal(exceedsPayloadBudget({ input: cyclic }, MAX_AI_ACTION_PAYLOAD_BYTES), true);
  });

  test('ordinary inputs are measured close to their JSON size', () => {
    const input = { items: Array.from({ length: 60 }, (_, index) => ({ name: `Item ${index}`, quantity: 2 })) };
    const json = JSON.stringify(input).length;
    assert.equal(exceedsPayloadBudget(input, json * 2), false);
    assert.equal(exceedsPayloadBudget(input, Math.floor(json / 4)), true);
  });
});
