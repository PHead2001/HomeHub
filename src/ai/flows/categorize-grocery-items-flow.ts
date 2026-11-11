'use server';

import { executeAuthorizedAiAction, type AiActionContext } from '@/ai/action-auth';
import type { AiActionResult } from '@/ai/errors';
import { categorizeGroceryItemsFlow } from '@/ai/tasks/categorize-grocery-items';
import type {
  CategorizeGroceryItemsInput as TaskInput,
  CategorizeGroceryItemsOutput as TaskOutput,
} from '@/ai/tasks/categorize-grocery-items';

export type CategorizeGroceryItemsInput = TaskInput;
export type CategorizeGroceryItemsOutput = TaskOutput;

/**
 * One batched categorization per shopping submission (QA-6): up to 40 names, one
 * daily quota request. Items are already saved under a local category before this
 * runs, so a slow or failed call never blocks or loses anything.
 */
export async function categorizeGroceryItems(
  input: CategorizeGroceryItemsInput,
  context: AiActionContext
): Promise<AiActionResult<CategorizeGroceryItemsOutput>> {
  return executeAuthorizedAiAction({
    context,
    input,
    permission: 'shopping.edit',
    flowName: 'categorization-batch',
    maxRequestsPerMinute: 10,
    task: () => categorizeGroceryItemsFlow(input),
  });
}
