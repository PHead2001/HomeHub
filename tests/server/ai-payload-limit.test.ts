import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { executeAuthorizedAiAction, MAX_AI_ACTION_PAYLOAD_BYTES } from '../../src/ai/action-auth';

// Genkit validates AI inputs with its pinned zod 3, which is affected by
// GHSA-mrhx-c7xc-m3w5 (memory use when validating oversized constrained
// collections). Oversized payloads are rejected before authorization or any
// validation, so that work stays bounded to small inputs.
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
});
