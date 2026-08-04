import { z } from 'genkit';
import { ai } from '@/ai/genkit';
import { openAiModels } from '@/ai/model-config';
import { generateStructured } from '@/ai/structured-generation';

export const CategorizeGroceryItemInputSchema = z.object({
  itemName: z.string().trim().min(1).max(120),
  categories: z.array(z.string().trim().min(1).max(60)).min(1).max(40),
});
export type CategorizeGroceryItemInput = z.infer<typeof CategorizeGroceryItemInputSchema>;

export const CategorizeGroceryItemOutputSchema = z.object({
  category: z.string().trim().min(1).max(60),
});
export type CategorizeGroceryItemOutput = z.infer<typeof CategorizeGroceryItemOutputSchema>;

export const categorizeGroceryItemFlow = ai.defineFlow(
  {
    name: 'categorizeGroceryItemFlow',
    inputSchema: CategorizeGroceryItemInputSchema,
    outputSchema: CategorizeGroceryItemOutputSchema,
  },
  async rawInput => {
    const categories = rawInput.categories.includes('Other')
      ? [...rawInput.categories]
      : [...rawInput.categories, 'Other'];
    const input = { ...rawInput, categories };
    const result = await generateStructured({
      flowName: 'categorization',
      input,
      model: openAiModels.categorization,
      outputSchema: CategorizeGroceryItemOutputSchema,
      timeoutMs: 8_000,
      maxOutputTokens: 200,
      taskInstruction: [
        'Categorize the grocery item using exactly one category from the supplied list.',
        'Use Other when none fits. Return only the requested structured output.',
      ].join('\n'),
    });

    if (!input.categories.includes(result.output.category)) return { category: 'Other' };
    return result.output;
  }
);
