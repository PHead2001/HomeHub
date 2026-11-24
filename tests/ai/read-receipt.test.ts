import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

process.env.HOMEHUB_AI_TEST_MODE = 'deterministic';
process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS = 'true';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'demo-homehub-e2e';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
delete process.env.OPENAI_API_KEY;

// MA-30: the receipt reader's deterministic double, its input limits and its output contract.
let task: typeof import('../../src/ai/tasks/read-receipt');
let generation: typeof import('../../src/ai/structured-generation');
let fill: typeof import('../../src/lib/maintenance/receipt-fill');

before(async () => {
  [task, generation, fill] = await Promise.all([
    import('../../src/ai/tasks/read-receipt'),
    import('../../src/ai/structured-generation'),
    import('../../src/lib/maintenance/receipt-fill'),
  ]);
});

const PIXEL = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected);
  return true;
};

describe('read receipt (deterministic provider)', () => {
  test('returns cost, provider and parts; the file travels only as an attachment, never in the JSON block', async () => {
    const result = await task.readReceiptFlow({ fileName: 'receipt.jpg', contentType: 'image/jpeg', dataBase64: PIXEL });
    assert.equal(result.cost, 129.95);
    assert.equal(result.serviceProvider, 'Comfort Air Services');
    assert.equal(result.partsUsed, 'MERV 11 filter 16x25x1');
    assert.match(result.model, /^deterministic\//);
    const last = generation.getLastDeterministicGeneration();
    assert.equal(last?.flowName, 'maintenance-receipt');
    assert.deepEqual(last?.untrustedInput, { fileName: 'receipt.jpg', contentType: 'image/jpeg' });
    assert.doesNotMatch(String(last?.taskInstruction), /Comfort/);
  });

  test('hostile text comes back as data and the browser bounds it as plain text', async () => {
    const result = await task.readReceiptFlow({ fileName: 'ai-test:receipt-hostile.jpg', contentType: 'image/jpeg', dataBase64: PIXEL });
    const fields = fill.sanitizeReceiptFields(result);
    assert.equal(fields.cost, 42.5);
    assert.equal(fields.serviceProvider, '<img src=x onerror=alert(1)>Shady Repairs');
    assert.ok((fields.partsUsed ?? '').length <= fill.RECEIPT_TEXT_LIMITS.partsUsed);
  });

  test('nothing legible is all null', async () => {
    const result = await task.readReceiptFlow({ fileName: 'ai-test:receipt-empty.pdf', contentType: 'application/pdf', dataBase64: PIXEL });
    assert.deepEqual({ cost: result.cost, serviceProvider: result.serviceProvider, partsUsed: result.partsUsed }, { cost: null, serviceProvider: null, partsUsed: null });
  });

  test('provider failures are the safe AI errors', async () => {
    await assert.rejects(task.readReceiptFlow({ fileName: 'ai-test:timeout.jpg', contentType: 'image/jpeg', dataBase64: PIXEL }), code('timeout'));
    await assert.rejects(task.readReceiptFlow({ fileName: 'ai-test:malformed.jpg', contentType: 'image/jpeg', dataBase64: PIXEL }), code('invalid_response'));
  });

  test('input limits: type, size and base64 are checked before any model call', async () => {
    await assert.rejects(task.readReceiptFlow({ fileName: 'r.gif', contentType: 'image/gif' as 'image/jpeg', dataBase64: PIXEL }), code('invalid_input'));
    await assert.rejects(task.readReceiptFlow({ fileName: 'r.jpg', contentType: 'image/jpeg', dataBase64: 'not base64!!' }), code('invalid_input'));
    await assert.rejects(task.readReceiptFlow({ fileName: 'r.jpg', contentType: 'image/jpeg', dataBase64: 'A'.repeat(task.RECEIPT_MAX_BASE64_CHARS + 4) }), code('invalid_input'));
  });

  test('the output schema refuses invented numbers', () => {
    assert.equal(task.ReadReceiptOutputSchema.safeParse({ cost: -5, serviceProvider: null, partsUsed: null }).success, false);
    assert.equal(task.ReadReceiptOutputSchema.safeParse({ cost: 5, serviceProvider: 'x'.repeat(201), partsUsed: null }).success, false);
  });
});
