import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { adminDb } from '../../src/lib/server/firebase-admin';
import { HomeHubAiError } from '../../src/ai/errors';
import { consumeAiQuota } from '../../src/lib/server/ai-quota';

// Durable daily AI quota against the Firestore emulator.
const NOW = new Date('2026-08-01T12:00:00Z');
const limits = { user: 3, household: 5 };
const take = (uid: string, householdId = 'house-q', now = NOW, flowName = 'recipe') =>
  consumeAiQuota({ uid, householdId, flowName }, now, limits);
const refused = (promise: Promise<unknown>) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error instanceof HomeHubAiError);
  assert.equal(error.code, 'quota_exceeded');
  return true;
});

const clear = async () => {
  const docs = await adminDb.collection('aiUsage').get();
  await Promise.all(docs.docs.map(d => d.ref.delete()));
};
beforeEach(clear);
after(clear);

describe('daily AI quota', () => {
  test('a person is stopped at their daily limit and nothing more is recorded', async () => {
    for (let i = 0; i < 3; i++) await take('alice');
    await refused(take('alice'));
    const usage = (await adminDb.collection('aiUsage').doc('user_alice_2026-08-01').get()).data();
    assert.equal(usage?.count, 3, 'a refused request is not counted');
    assert.equal(usage?.byFlow.recipe, 3);
    assert.ok(usage?.expiresAt.toDate() > NOW, 'usage expires (TTL) after the day');
  });

  test('the household limit applies across its members; other households are separate', async () => {
    for (let i = 0; i < 3; i++) await take('alice');
    for (let i = 0; i < 2; i++) await take('bob');
    await refused(take('carol'));
    await take('dave', 'other-house');
  });

  test('a new UTC day starts fresh', async () => {
    for (let i = 0; i < 3; i++) await take('alice');
    await refused(take('alice'));
    await take('alice', 'house-q', new Date('2026-08-02T00:00:01Z'));
  });

  test('concurrent requests never exceed the limit', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => take('erin', 'house-c')));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
    const usage = (await adminDb.collection('aiUsage').doc('user_erin_2026-08-01').get()).data();
    assert.equal(usage?.count, 3);
  });

  test('per-flow counts are kept for every flow used', async () => {
    await take('fay', 'house-f', NOW, 'categorization');
    await take('fay', 'house-f', NOW, 'recipe');
    const usage = (await adminDb.collection('aiUsage').doc('user_fay_2026-08-01').get()).data();
    assert.deepEqual(usage?.byFlow, { categorization: 1, recipe: 1 });
  });
});
