'use server';
/**
 * @fileOverview Categorizes a grocery item into a predefined category using AI.
 *
 * - categorizeGroceryItem - A function that takes a grocery item name and returns its category.
 * - CategorizeGroceryItemInput - The input type for the categorizeGroceryItem function.
 * - CategorizeGroceryItemOutput - The return type for the categorizeGroceryItem function.
 */

import { ai } from '@/ai/genkit';
import { z } from 'genkit';

const CategorizeGroceryItemInputSchema = z.object({
  itemName: z.string().describe('The name of the grocery item to categorize.'),
  categories: z.array(z.string()).describe('The list of available categories to choose from.'),
});
export type CategorizeGroceryItemInput = z.infer<typeof CategorizeGroceryItemInputSchema>;

const CategorizeGroceryItemOutputSchema = z.object({
  category: z.string().describe('The determined category for the grocery item, chosen from the provided list.'),
});
export type CategorizeGroceryItemOutput = z.infer<typeof CategorizeGroceryItemOutputSchema>;

export async function categorizeGroceryItem(input: CategorizeGroceryItemInput): Promise<CategorizeGroceryItemOutput> {
  // Ensure the 'Other' category exists as a fallback.
  if (!input.categories.includes('Other')) {
    input.categories.push('Other');
  }
  return categorizeGroceryItemFlow(input);
}

const prompt = ai.definePrompt({
  name: 'categorizeGroceryItemPrompt',
  input: { schema: CategorizeGroceryItemInputSchema },
  output: { schema: CategorizeGroceryItemOutputSchema },
  prompt: `You are an expert grocery assistant. Your task is to categorize a grocery item into one of the following predefined categories.

Categories:
{{#each categories}}
- {{{this}}}
{{/each}}

Please categorize the following item: {{{itemName}}}

Choose only one category from the list provided. If the item doesn't fit well into any category, use 'Other'.`,
});

const categorizeGroceryItemFlow = ai.defineFlow(
  {
    name: 'categorizeGroceryItemFlow',
    inputSchema: CategorizeGroceryItemInputSchema,
    outputSchema: CategorizeGroceryItemOutputSchema,
  },
  async input => {
    const { output } = await prompt(input);
    
    // Fallback logic in case the model returns a category not in the list.
    if (output && !input.categories.includes(output.category)) {
        return { category: 'Other' };
    }

    return output!;
  }
);
