import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

process.env.HOMEHUB_AI_TEST_MODE = 'deterministic';
process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS = 'true';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'demo-homehub-e2e';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_DEFAULT_MODEL;

type Task = typeof import('../../src/ai/tasks/parse-command');
let task: Task;
let generation: typeof import('../../src/ai/structured-generation');
let strict: typeof import('../../src/ai/strict-output-schema');

before(async () => {
  [task, generation, strict] = await Promise.all([
    import('../../src/ai/tasks/parse-command'),
    import('../../src/ai/structured-generation'),
    import('../../src/ai/strict-output-schema'),
  ]);
});

const baseInput = {
  today: '2026-08-01',
  members: [{ ref: 'm1', name: 'Alex Owner' }, { ref: 'm2', name: 'Sam Member' }],
  rooms: [{ ref: 'r1', name: 'Kitchen' }],
  pets: [{ ref: 'p1', name: 'Maple' }],
  lists: [{ ref: 'l1', name: 'Weekly Groceries' }],
  vehicles: [{ ref: 'v1', name: 'Family Civic · Honda Civic' }],
};
const ALL = ['chore', 'maintenance', 'shopping', 'feeding'] as const;

const assertAiCode = (code: string) => (error: unknown) => {
  assert.equal(error && typeof error === 'object' && 'code' in error ? error.code : undefined, code);
  return true;
};

describe('parse-command AI task (deterministic provider)', () => {
  test('its output schema converts to an OpenAI strict schema', () => {
    const { wireSchema } = strict.toStrictOutputSchema(task.ParseCommandOutputSchema);
    assert.equal(wireSchema.type, 'object');
    assert.deepEqual(wireSchema.required, ['kind', 'chore', 'maintenance', 'shopping', 'feeding']);
  });

  test('reads a sentence the deterministic parser cannot, using the default model and untrusted-data framing', async () => {
    const output = await task.parseCommandFlow({ ...baseInput, text: 'the civic had its oil changed, odometer says 48,200' }, ALL);
    assert.deepEqual(output, { kind: 'maintenance', maintenance: { title: 'Oil change', mileage: 48_200, vehicleRef: 'v1' } });
    const metadata = generation.getLastDeterministicGeneration();
    assert.equal(metadata?.flowName, 'command-parse');
    assert.equal(metadata?.model, 'gpt-6-luna');
    assert.ok(metadata?.system.includes('private, untrusted data'));
    assert.deepEqual((metadata?.untrustedInput as { allowedKinds: string[] }).allowedKinds, [...ALL]);
  });

  test('a repeating chore keeps known references and drops unknown ones', async () => {
    const forSam = await task.parseCommandFlow({ ...baseInput, text: 'sam takes the trash out on tuesday' }, ALL);
    assert.deepEqual(forSam, { kind: 'chore', chore: { task: 'Trash', repeat: { frequency: 'weekly', dayOfWeek: 2 }, assigneeRef: 'm2' } });
    // The provider answers m99 when no member is named: not a supplied reference, so dropped.
    const nobody = await task.parseCommandFlow({ ...baseInput, text: 'recycling goes out each tuesday' }, ALL);
    assert.deepEqual(nobody, { kind: 'chore', chore: { task: 'Recycling', repeat: { frequency: 'weekly', dayOfWeek: 2 } } });
  });

  test('answers only with kinds the member may create', async () => {
    const output = await task.parseCommandFlow({ ...baseInput, text: 'oil changed at 48200 on the civic' }, ['chore']);
    assert.deepEqual(output, { kind: 'none' });
    assert.deepEqual(await task.parseCommandFlow({ ...baseInput, text: 'anything at all' }, []), { kind: 'none' });
  });

  test('never keeps a mileage the sentence does not contain', async () => {
    const output = await task.parseCommandFlow({ ...baseInput, text: 'oil done on the civic ai-test:invented-mileage' }, ALL);
    assert.deepEqual(output, { kind: 'maintenance', maintenance: { title: 'Oil change', vehicleRef: 'v1' } });
  });

  test('validates input before any model call and maps provider failures', async () => {
    await assert.rejects(task.parseCommandFlow({ ...baseInput, text: 'x' }, ALL), assertAiCode('invalid_input'));
    await assert.rejects(task.parseCommandFlow({ ...baseInput, text: 'hello', members: [{ ref: 'alex@example.test', name: 'Alex' }] }, ALL), assertAiCode('invalid_input'));
    await assert.rejects(task.parseCommandFlow({ ...baseInput, text: 'trash tuesday ai-test:timeout' }, ALL), assertAiCode('timeout'));
    await assert.rejects(task.parseCommandFlow({ ...baseInput, text: 'trash tuesday ai-test:malformed' }, ALL), assertAiCode('invalid_response'));
  });

  test('the sanitizer drops invalid dates, half repeats and unknown pets', () => {
    const input = { ...baseInput, text: 'feed rex' };
    assert.deepEqual(task.sanitizeParseCommandOutput({ kind: 'feeding', feeding: { petRef: 'p7' } }, input, ALL), { kind: 'none' });
    assert.deepEqual(
      task.sanitizeParseCommandOutput({ kind: 'chore', chore: { task: 'Call', dueDate: '2026-02-30', repeat: { frequency: 'weekly' }, roomRef: 'r1' } }, input, ALL),
      { kind: 'chore', chore: { task: 'Call', roomRef: 'r1' } },
    );
    assert.deepEqual(
      task.sanitizeParseCommandOutput({ kind: 'shopping', shopping: { items: [{ name: 'Milk', quantity: 1 }], listRef: 'l9' }, chore: { task: 'stray' } }, input, ALL),
      { kind: 'shopping', shopping: { items: [{ name: 'Milk', quantity: 1 }] } },
    );
  });

});
