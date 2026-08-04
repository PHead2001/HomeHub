'use server';

import { executeAuthorizedAiAction, type AiActionContext } from '@/ai/action-auth';
import type { AiActionResult } from '@/ai/errors';
import {
  categorizeGroceryItemFlow,
} from '@/ai/tasks/categorize-grocery-item';
import type {
  CategorizeGroceryItemInput as TaskInput,
  CategorizeGroceryItemOutput as TaskOutput,
} from '@/ai/tasks/categorize-grocery-item';

export type CategorizeGroceryItemInput = TaskInput;
export type CategorizeGroceryItemOutput = TaskOutput;

export async function categorizeGroceryItem(
  input: CategorizeGroceryItemInput,
  context: AiActionContext
): Promise<AiActionResult<CategorizeGroceryItemOutput>> {
  return executeAuthorizedAiAction({
    context,
    permission: 'shopping.edit',
    flowName: 'categorization',
    maxRequestsPerMinute: 20,
    task: () => categorizeGroceryItemFlow(input),
  });
}
