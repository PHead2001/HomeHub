import { z } from 'zod';
import { openAiModels } from '@/ai/model-config';
import { generateStructured, parseTaskInput, parseTaskOutput } from '@/ai/structured-generation';

/** Most names one batched categorization call accepts (QA-6). */
export const MAX_CATEGORIZE_BATCH = 40;

export const CategorizeGroceryItemsInputSchema = z.object({
  itemNames: z.array(z.string().trim().min(1).max(120)).min(1).max(MAX_CATEGORIZE_BATCH),
  categories: z.array(z.string().trim().min(1).max(60)).min(1).max(40),
});
export type CategorizeGroceryItemsInput = z.infer<typeof CategorizeGroceryItemsInputSchema>;

/** What the model returns (sent as the strict JSON schema). */
export const CategorizeGroceryItemsModelOutputSchema = z.object({
  results: z.array(z.object({
    index: z.number().int().min(0).max(MAX_CATEGORIZE_BATCH - 1),
    category: z.string().trim().min(1).max(60),
  })).max(MAX_CATEGORIZE_BATCH),
});

export const CategorizeGroceryItemsOutputSchema = z.object({
  /** One category per input name, in input order; `Other` when the model gave none or one outside the list. */
  categories: z.array(z.string().trim().min(1).max(60)).max(MAX_CATEGORIZE_BATCH),
});
export type CategorizeGroceryItemsOutput = z.infer<typeof CategorizeGroceryItemsOutputSchema>;

/**
 * Categorizes up to {@link MAX_CATEGORIZE_BATCH} grocery names in one model call.
 * Every answer is checked against the supplied categories; missing, duplicate or
 * unknown answers become `Other`, so the output always has one entry per name.
 */
export async function categorizeGroceryItemsFlow(
  candidateInput: CategorizeGroceryItemsInput
): Promise<CategorizeGroceryItemsOutput> {
  const rawInput = parseTaskInput(CategorizeGroceryItemsInputSchema, candidateInput);
  const categories = rawInput.categories.includes('Other')
    ? [...rawInput.categories]
    : [...rawInput.categories, 'Other'];
  const input = { itemNames: rawInput.itemNames, categories };
  const result = await generateStructured({
    flowName: 'categorization-batch',
    input,
    model: openAiModels.categorization,
    outputSchema: CategorizeGroceryItemsModelOutputSchema,
    timeoutMs: 12_000,
    maxOutputTokens: 1_200,
    taskInstruction: [
      'Categorize each grocery item name using exactly one category from the supplied list.',
      'Return one result per item, with the item\'s zero-based index in itemNames.',
      'Use Other when none fits. Return only the requested structured output.',
    ].join('\n'),
  });

  const answers = new Map<number, string>();
  for (const { index, category } of result.output.results) {
    if (!answers.has(index) && categories.includes(category)) answers.set(index, category);
  }
  return parseTaskOutput(CategorizeGroceryItemsOutputSchema, {
    categories: input.itemNames.map((_, index) => answers.get(index) ?? 'Other'),
  });
}
