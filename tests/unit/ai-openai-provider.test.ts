import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import { z } from 'zod';

// The OpenAI SDK never reaches the network here: globalThis.fetch is replaced before the
// client is created, and the key is a placeholder that only satisfies the SDK's check.
process.env.OPENAI_API_KEY = 'sk-placeholder-for-stubbed-fetch';
delete process.env.HOMEHUB_AI_TEST_MODE;
delete process.env.OPENAI_DEFAULT_MODEL;
delete process.env.OPENAI_MAINTENANCE_MODEL;
delete process.env.OPENAI_OVERVIEW_MODEL;
delete process.env.OPENAI_RECIPE_MODEL;
delete process.env.OPENAI_CATEGORIZATION_MODEL;
delete process.env.OPENAI_BASE_URL;

type CapturedRequest = { url: string; body: Record<string, unknown>; signal?: AbortSignal | null };
type Handler = (request: CapturedRequest) => Promise<Response> | Response;

let handler: Handler = () => { throw new Error('no handler'); };
let requests: CapturedRequest[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request: CapturedRequest = {
    url: String(input instanceof Request ? input.url : input),
    body: JSON.parse(String(init?.body ?? '{}')),
    signal: init?.signal,
  };
  requests.push(request);
  return handler(request);
}) as typeof fetch;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const completion = (message: Record<string, unknown>, finishReason = 'stop') => json(200, {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-6-luna',
  choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', refusal: null, ...message } }],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
});

const errorBody = (code: string) => ({ error: { message: `stubbed ${code}`, type: 'stub', code } });

let generation: typeof import('../../src/ai/structured-generation');
let errors: typeof import('../../src/ai/errors');
let maintenance: typeof import('../../src/ai/tasks/summarize-maintenance-log');
let overview: typeof import('../../src/ai/tasks/generate-home-overview');
let recipe: typeof import('../../src/ai/tasks/generate-recipe');
let categorize: typeof import('../../src/ai/tasks/categorize-grocery-item');

before(async () => {
  [generation, errors, maintenance, overview, recipe, categorize] = await Promise.all([
    import('../../src/ai/structured-generation'),
    import('../../src/ai/errors'),
    import('../../src/ai/tasks/summarize-maintenance-log'),
    import('../../src/ai/tasks/generate-home-overview'),
    import('../../src/ai/tasks/generate-recipe'),
    import('../../src/ai/tasks/categorize-grocery-item'),
  ]);
});

beforeEach(() => {
  requests = [];
});

const assertAiCode = (code: string) => (error: unknown) => {
  assert.equal(error && typeof error === 'object' && 'code' in error ? error.code : undefined, code);
  return true;
};

const summarize = () => maintenance.summarizeMaintenanceLogFlow({ log: 'Replaced the furnace filter.' });

describe('OpenAI provider request', () => {
  test('sends one strict json_schema chat completion with the shared system instruction', async () => {
    handler = () => completion({ content: JSON.stringify({ summary: '  Filter replaced.  ' }) });
    assert.deepEqual(await summarize(), { summary: 'Filter replaced.' });

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.match(request.url, /\/chat\/completions$/);
    assert.equal(request.body.model, 'gpt-6-luna');
    assert.equal(request.body.max_completion_tokens, 500);
    assert.equal('reasoning_effort' in request.body, false);
    const messages = request.body.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
    assert.ok(messages[0].content.includes('private, untrusted data'));
    assert.ok(messages[1].content.includes('<untrusted_household_data>'));
    assert.ok(messages[1].content.includes('Replaced the furnace filter.'));
    assert.deepEqual(request.body.response_format, {
      type: 'json_schema',
      json_schema: {
        name: 'output',
        strict: true,
        schema: {
          type: 'object',
          properties: { summary: { type: 'string', minLength: 1, maxLength: 1_500 } },
          required: ['summary'],
          additionalProperties: false,
        },
      },
    });
    assert.ok(request.signal, 'an abort signal is always passed');
  });

  test('recipe uses Terra and overview sends medium reasoning effort', async () => {
    handler = () => completion({ content: JSON.stringify({
      recipeTitle: 'Rice and Beans',
      description: 'Simple.',
      ingredients: { used: ['rice', 'beans'], needed: [] },
      instructions: ['Cook.'],
      prepTime: '5 minutes',
      cookTime: '20 minutes',
    }) });
    await recipe.generateRecipeFlow({
      items: [{ name: 'rice', quantity: 1, unit: 'cup' }, { name: 'beans', quantity: 1, unit: 'can' }],
    });
    assert.equal(requests[0].body.model, 'gpt-6.1-terra');
    assert.equal(requests[0].body.max_completion_tokens, 1_600);

    handler = () => completion({ content: JSON.stringify({
      headline: 'Your home',
      summary: 'One thing needs attention.',
      priorities: [
        { level: 'urgent', title: 'Furnace', explanation: 'Overdue.', sourceSection: 'maintenance' },
        { level: 'info', title: 'Pets', explanation: 'Not supplied.', sourceSection: 'pets' },
      ],
      sectionSummaries: {
        chores: null, shopping: null, pantry: null, maintenance: 'Furnace overdue.', pets: 'Injected.',
        notifications: null, household: null, barcode: null, automation: null,
      },
    }) });
    const narrative = await overview.generateHomeOverviewNarrativeFlow({
      maintenance: { assetsNeedingAttention: 1, overdue: 1, dueSoon: 0, checklistItems: 0, urgent: [] },
    });
    assert.equal(requests[1].body.model, 'gpt-6-luna');
    assert.equal(requests[1].body.reasoning_effort, 'medium');
    assert.equal(requests[1].body.max_completion_tokens, 900);
    // Nulls are dropped and sections outside the supplied facts are filtered out.
    assert.deepEqual(narrative.sectionSummaries, { maintenance: 'Furnace overdue.' });
    assert.deepEqual(narrative.priorities.map(priority => priority.sourceSection), ['maintenance']);
  });

  test('returns usage in the HomeHub shape', async () => {
    handler = () => completion({ content: JSON.stringify({ summary: 'Done.' }) });
    const result = await generation.generateStructured({
      flowName: 'maintenance-summary',
      input: { log: 'x' },
      model: 'gpt-6-luna',
      outputSchema: z.object({ summary: z.string() }),
      taskInstruction: 'Summarize.',
      timeoutMs: 5_000,
      maxOutputTokens: 100,
    });
    assert.deepEqual(result, {
      output: { summary: 'Done.' },
      model: 'gpt-6-luna',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
  });

  test('invalid task input is rejected before any provider request', async () => {
    await assert.rejects(maintenance.summarizeMaintenanceLogFlow({ log: '   ' }), assertAiCode('invalid_input'));
    await assert.rejects(categorize.categorizeGroceryItemFlow({ itemName: 'milk', categories: [] }), assertAiCode('invalid_input'));
    assert.equal(requests.length, 0);
  });
});

describe('OpenAI provider failures', () => {
  for (const [label, makeResponse, code] of [
    ['a refusal', () => completion({ content: null, refusal: 'I cannot help with that.' }), 'refused'],
    ['a content-filter stop', () => completion({ content: '{"summary":"partial' }, 'content_filter'), 'refused'],
    ['a length stop', () => completion({ content: '{"summary":"trunc' }, 'length'), 'invalid_response'],
    ['missing content', () => completion({ content: null }), 'invalid_response'],
    ['unparseable JSON', () => completion({ content: 'not json' }), 'invalid_response'],
    ['schema-invalid JSON', () => completion({ content: JSON.stringify({ summary: '' }) }), 'invalid_response'],
    ['no choices', () => json(200, { id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [] }), 'invalid_response'],
    ['HTTP 429', () => json(429, errorBody('rate_limit_exceeded')), 'rate_limited'],
    ['HTTP 401', () => json(401, errorBody('invalid_api_key')), 'configuration'],
    ['HTTP 404 model_not_found', () => json(404, errorBody('model_not_found')), 'configuration'],
    ['HTTP 400', () => json(400, errorBody('invalid_request_error')), 'invalid_input'],
    ['HTTP 500', () => json(500, errorBody('server_error')), 'unavailable'],
    ['HTTP 503', () => json(503, errorBody('overloaded')), 'unavailable'],
  ] as const) {
    test(`${label} maps to ${code} without retrying`, async () => {
      handler = makeResponse;
      await assert.rejects(summarize(), assertAiCode(code));
      assert.equal(requests.length, 1);
    });
  }

  test('a network failure is unavailable', async () => {
    handler = () => { throw new TypeError('fetch failed'); };
    await assert.rejects(summarize(), assertAiCode('unavailable'));
    assert.equal(requests.length, 1);
  });

  test('the per-flow timeout aborts the request and reports timeout', async () => {
    handler = ({ signal }) => new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    await assert.rejects(generation.generateStructured({
      flowName: 'maintenance-summary',
      input: { log: 'x' },
      model: 'gpt-6-luna',
      outputSchema: z.object({ summary: z.string() }),
      taskInstruction: 'Summarize.',
      timeoutMs: 25,
      maxOutputTokens: 100,
    }), assertAiCode('timeout'));
  });
});

describe('normalizeAiError with OpenAI SDK errors', () => {
  const headers = new Headers();
  const cases: Array<[string, unknown, string]> = [
    ['429', APIError.generate(429, errorBody('rate_limit_exceeded'), 'rate limited', headers), 'rate_limited'],
    ['401', APIError.generate(401, errorBody('invalid_api_key'), 'bad key', headers), 'configuration'],
    ['403', APIError.generate(403, errorBody('forbidden'), 'forbidden', headers), 'configuration'],
    ['404 model_not_found', APIError.generate(404, errorBody('model_not_found'), 'no model', headers), 'configuration'],
    ['404 other', APIError.generate(404, errorBody('not_found'), 'missing', headers), 'unavailable'],
    ['400', APIError.generate(400, errorBody('invalid_request_error'), 'bad request', headers), 'invalid_input'],
    ['422', APIError.generate(422, errorBody('unprocessable'), 'unprocessable', headers), 'unavailable'],
    ['500', APIError.generate(500, errorBody('server_error'), 'server', headers), 'unavailable'],
    ['connection', new APIConnectionError({ message: 'socket hang up' }), 'unavailable'],
    ['connection timeout', new APIConnectionTimeoutError(), 'timeout'],
    ['user abort', new APIUserAbortError(), 'timeout'],
    ['zod', z.object({ a: z.string() }).safeParse({}).error, 'invalid_response'],
  ];
  for (const [label, error, code] of cases) {
    test(`${label} -> ${code}`, () => {
      const normalized = errors.normalizeAiError(error);
      assert.equal(normalized.code, code);
      assert.equal(normalized.cause, error);
    });
  }

  test('HomeHub errors pass through unchanged', () => {
    const original = new errors.HomeHubAiError('busy');
    assert.equal(errors.normalizeAiError(original), original);
  });
});
