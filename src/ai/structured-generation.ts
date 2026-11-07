import type OpenAI from 'openai';
import { z } from 'zod';
import { HomeHubAiError, normalizeAiError } from '@/ai/errors';
import { getOpenAiClient } from '@/ai/openai-client';
import { toStrictOutputSchema } from '@/ai/strict-output-schema';
import { buildUntrustedDataPrompt, HOMEHUB_AI_SYSTEM_INSTRUCTION } from '@/ai/system-instruction';

export type ModelBackedFlowName = 'categorization' | 'recipe' | 'maintenance-summary' | 'overview';
export type AiReasoningEffort = 'low' | 'medium' | 'high';

export type AiGenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type StructuredGenerationResult<T> = {
  output: T;
  model: string;
  usage?: AiGenerationUsage;
};

export type DeterministicGenerationMetadata = {
  flowName: ModelBackedFlowName;
  model: string;
  system: string;
  taskInstruction: string;
  untrustedInput: unknown;
  reasoningEffort?: AiReasoningEffort;
};

type GenerationState = typeof globalThis & {
  __homeHubLastDeterministicGeneration?: DeterministicGenerationMetadata;
};

const generationState = globalThis as GenerationState;
export const getLastDeterministicGeneration = () => generationState.__homeHubLastDeterministicGeneration;

const deterministicModeName = 'deterministic';
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/;

const isDeterministicMode = () => {
  if (process.env.HOMEHUB_AI_TEST_MODE !== deterministicModeName) return false;

  const safe = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true'
    && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === 'demo-homehub-e2e'
    && loopbackHost.test(process.env.FIREBASE_AUTH_EMULATOR_HOST || '')
    && loopbackHost.test(process.env.FIRESTORE_EMULATOR_HOST || '')
    && process.env.NODE_ENV !== 'production';

  if (!safe) {
    throw new Error('Deterministic AI mode requires the HomeHub demo emulator environment.');
  }
  return true;
};

const getScenario = (input: unknown) => {
  const serialized = JSON.stringify(input).toLowerCase();
  const match = serialized.match(/ai-test:(success|outside-category|timeout|rate-limit|provider-error|malformed|refusal|incomplete)/);
  return match?.[1] || 'success';
};

const throwDeterministicFailure = (scenario: string) => {
  if (scenario === 'timeout') throw new HomeHubAiError('timeout');
  if (scenario === 'rate-limit') throw new HomeHubAiError('rate_limited');
  if (scenario === 'provider-error') throw new HomeHubAiError('unavailable');
  if (scenario === 'refusal') throw new HomeHubAiError('refused');
  if (scenario === 'incomplete') throw new HomeHubAiError('invalid_response');
};

const deterministicOutput = (flowName: ModelBackedFlowName, input: unknown) => {
  const scenario = getScenario(input);
  throwDeterministicFailure(scenario);
  if (scenario === 'malformed') return { malformed: true };

  if (flowName === 'categorization') {
    const categoryInput = input as { itemName: string; categories: string[] };
    if (scenario === 'outside-category') return { category: 'Not A Supplied Category' };
    const itemName = categoryInput.itemName.toLowerCase();
    const preferred = itemName.includes('milk') ? 'Dairy'
      : itemName.includes('apple') ? 'Produce'
        : categoryInput.categories.find(category => category !== 'Other');
    return { category: preferred && categoryInput.categories.includes(preferred) ? preferred : 'Other' };
  }

  if (flowName === 'recipe') {
    const recipeInput = input as { items: Array<{ name: string }> };
    const first = recipeInput.items[0]?.name || 'Pantry ingredient';
    const second = recipeInput.items[1]?.name || 'Kitchen staple';
    return {
      recipeTitle: `${first} and ${second} Skillet`,
      description: `A simple skillet meal built around ${first} and ${second}.`,
      ingredients: {
        used: [first, second],
        needed: ['Salt', 'Pepper', 'Cooking oil'],
      },
      instructions: [
        'Prepare the pantry ingredients.',
        'Cook them together in a lightly oiled skillet until heated through.',
        'Season to taste and serve.',
      ],
      prepTime: '10 minutes',
      cookTime: '15 minutes',
    };
  }

  if (flowName === 'overview') {
    return {
      headline: 'Your home at a glance',
      summary: 'Review the exact household facts below and start with the most time-sensitive items.',
      priorities: [
        {
          level: 'urgent',
          title: 'Review due work',
          explanation: 'Some supplied household facts are due or overdue.',
          sourceSection: 'maintenance',
        },
        {
          level: 'soon',
          title: 'Check your tasks',
          explanation: 'Your assigned chore facts include upcoming work.',
          sourceSection: 'chores',
        },
      ],
      sectionSummaries: {},
    };
  }

  const summaryInput = input as { log: string };
  const cleanLog = summaryInput.log.replace(/ai-test:[a-z-]+/gi, '').trim();
  return { summary: `Maintenance summary: ${cleanLog.slice(0, 220)}` };
};

const withTimeout = async <T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number) => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new HomeHubAiError('timeout', { cause: error });
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

/**
 * Reads the JSON payload of a structured-output completion. A refusal or a
 * content-filter stop is `refused`; a missing, truncated (`finish_reason:
 * 'length'`) or unparseable payload is `invalid_response`.
 */
export const readCompletionOutput = (completion: OpenAI.Chat.Completions.ChatCompletion): unknown => {
  const choice = completion.choices[0];
  if (!choice) throw new HomeHubAiError('invalid_response');
  if (choice.message.refusal || choice.finish_reason === 'content_filter') throw new HomeHubAiError('refused');
  if (choice.finish_reason !== 'stop' || !choice.message.content) throw new HomeHubAiError('invalid_response');
  try {
    return JSON.parse(choice.message.content);
  } catch (error) {
    throw new HomeHubAiError('invalid_response', { cause: error });
  }
};

export const toUsage = (usage: OpenAI.Completions.CompletionUsage | undefined): AiGenerationUsage | undefined => usage
  ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens }
  : undefined;

export const generateStructured = async <Schema extends z.ZodType>({
  flowName,
  input,
  model,
  outputSchema,
  taskInstruction,
  timeoutMs,
  maxOutputTokens,
  reasoningEffort,
}: {
  flowName: ModelBackedFlowName;
  input: unknown;
  model: string;
  outputSchema: Schema;
  taskInstruction: string;
  timeoutMs: number;
  maxOutputTokens: number;
  reasoningEffort?: AiReasoningEffort;
}): Promise<StructuredGenerationResult<z.output<Schema>>> => {
  const startedAt = Date.now();
  let outcome = 'success';

  try {
    // Converted (and cached) in every mode so deterministic runs also exercise the wire schema.
    const strictSchema = toStrictOutputSchema(outputSchema);
    if (isDeterministicMode()) {
      generationState.__homeHubLastDeterministicGeneration = {
        flowName,
        model,
        system: HOMEHUB_AI_SYSTEM_INSTRUCTION,
        taskInstruction,
        untrustedInput: input,
        reasoningEffort,
      };
      const output = outputSchema.parse(strictSchema.decode(deterministicOutput(flowName, input)));
      return { output, model: `deterministic/${model}` };
    }
    const client = getOpenAiClient();
    if (!client) throw new HomeHubAiError('configuration');

    const completion = await withTimeout(signal => client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: HOMEHUB_AI_SYSTEM_INSTRUCTION },
        { role: 'user', content: buildUntrustedDataPrompt(taskInstruction, input) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'output', schema: strictSchema.wireSchema, strict: true },
      },
      max_completion_tokens: maxOutputTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }, { signal }), timeoutMs);

    const wireOutput = readCompletionOutput(completion);
    const parsed = outputSchema.safeParse(strictSchema.decode(wireOutput));
    if (!parsed.success) throw new HomeHubAiError('invalid_response', { cause: parsed.error });

    return {
      output: parsed.data,
      model,
      usage: toUsage(completion.usage),
    };
  } catch (error) {
    const normalized = normalizeAiError(error);
    outcome = normalized.code;
    throw normalized;
  } finally {
    console.info('[ai] request', {
      flow: flowName,
      model,
      durationMs: Date.now() - startedAt,
      outcome,
    });
  }
};

/**
 * Validates a task's input the way Genkit's `defineFlow` did: a schema failure is
 * reported as `invalid_input` before any model call. Returns the parsed value.
 */
export const parseTaskInput = <Schema extends z.ZodType>(schema: Schema, input: unknown): z.output<Schema> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HomeHubAiError('invalid_input', { cause: parsed.error });
  return parsed.data;
};

/** Validates a task's final output (after any post-processing) against its schema. */
export const parseTaskOutput = <Schema extends z.ZodType>(schema: Schema, output: unknown): z.output<Schema> => {
  const parsed = schema.safeParse(output);
  if (!parsed.success) throw new HomeHubAiError('invalid_response', { cause: parsed.error });
  return parsed.data;
};
