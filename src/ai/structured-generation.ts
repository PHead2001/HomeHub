import { openAI } from '@genkit-ai/compat-oai/openai';
import { z } from 'genkit';
import { ai } from '@/ai/genkit';
import { HomeHubAiError, normalizeAiError } from '@/ai/errors';
import { hasOpenAiApiKey } from '@/ai/model-config';
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

export const generateStructured = async <Schema extends z.ZodTypeAny>({
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
}): Promise<StructuredGenerationResult<z.infer<Schema>>> => {
  const startedAt = Date.now();
  let outcome = 'success';

  try {
    if (isDeterministicMode()) {
      generationState.__homeHubLastDeterministicGeneration = {
        flowName,
        model,
        system: HOMEHUB_AI_SYSTEM_INSTRUCTION,
        taskInstruction,
        untrustedInput: input,
        reasoningEffort,
      };
      const output = outputSchema.parse(deterministicOutput(flowName, input));
      return { output, model: `deterministic/${model}` };
    }
    if (!hasOpenAiApiKey) throw new HomeHubAiError('configuration');

    const response = await withTimeout(signal => ai.generate({
      model: openAI.model(model),
      system: HOMEHUB_AI_SYSTEM_INSTRUCTION,
      prompt: buildUntrustedDataPrompt(taskInstruction, input),
      output: { schema: outputSchema },
      config: {
        max_completion_tokens: maxOutputTokens,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
      abortSignal: signal,
    }), timeoutMs);

    if (!response.output) {
      throw new HomeHubAiError(response.finishReason === 'blocked' ? 'refused' : 'invalid_response');
    }

    return {
      output: outputSchema.parse(response.output),
      model,
      usage: response.usage,
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
