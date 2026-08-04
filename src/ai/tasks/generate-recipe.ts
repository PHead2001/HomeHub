import { z } from 'genkit';
import { ai } from '@/ai/genkit';
import { openAiModels } from '@/ai/model-config';
import { generateStructured } from '@/ai/structured-generation';

const PantryItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().finite().nonnegative().max(100_000),
  unit: z.string().trim().min(1).max(40),
});

export const GenerateRecipeInputSchema = z.object({
  items: z.array(PantryItemSchema).min(2, 'Please add at least two items to your pantry to generate a recipe.').max(60),
});
export type GenerateRecipeInput = z.infer<typeof GenerateRecipeInputSchema>;

export const GenerateRecipeOutputSchema = z.object({
  recipeTitle: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(1_000),
  ingredients: z.object({
    used: z.array(z.string().trim().min(1).max(200)).max(60),
    needed: z.array(z.string().trim().min(1).max(200)).max(30),
  }),
  instructions: z.array(z.string().trim().min(1).max(1_000)).min(1).max(30),
  prepTime: z.string().trim().min(1).max(80),
  cookTime: z.string().trim().min(1).max(80),
});
export type GenerateRecipeOutput = z.infer<typeof GenerateRecipeOutputSchema>;

export const generateRecipeFlow = ai.defineFlow(
  {
    name: 'generateRecipeFlow',
    inputSchema: GenerateRecipeInputSchema,
    outputSchema: GenerateRecipeOutputSchema,
  },
  async input => {
    const result = await generateStructured({
      flowName: 'recipe',
      input,
      model: openAiModels.recipe,
      outputSchema: GenerateRecipeOutputSchema,
      timeoutMs: 25_000,
      maxOutputTokens: 1_600,
      prompt: [
        'Create one practical home recipe primarily using the supplied pantry items.',
        'Use conventional flavor pairings. Put only common missing staples under needed.',
        'Return clear steps and only the requested structured output.',
        `Pantry items: ${JSON.stringify(input.items)}`,
      ].join('\n'),
    });
    return result.output;
  }
);
