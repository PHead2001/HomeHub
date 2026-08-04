'use server';

import { executeAuthorizedAiAction, type AiActionContext } from '@/ai/action-auth';
import type { AiActionResult } from '@/ai/errors';
import {
  generateRecipeFlow,
} from '@/ai/tasks/generate-recipe';
import type {
  GenerateRecipeInput as TaskInput,
  GenerateRecipeOutput as TaskOutput,
} from '@/ai/tasks/generate-recipe';

export type GenerateRecipeInput = TaskInput;
export type GenerateRecipeOutput = TaskOutput;

export async function generateRecipe(
  input: GenerateRecipeInput,
  context: AiActionContext
): Promise<AiActionResult<GenerateRecipeOutput>> {
  return executeAuthorizedAiAction({
    context,
    permission: 'shopping.view',
    flowName: 'recipe',
    maxRequestsPerMinute: 20,
    task: () => generateRecipeFlow(input),
  });
}
