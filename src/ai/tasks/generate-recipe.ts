import { z } from 'zod';
import { openAiModels } from '@/ai/model-config';
import { generateStructured, parseTaskInput, parseTaskOutput } from '@/ai/structured-generation';
import {
  normalizeRecipeIngredients, RECIPE_LINE_MAX, RECIPE_NAME_MAX, RECIPE_NEEDED_MAX, RECIPE_USED_MAX,
} from '@/lib/shopping/recipe';

const PantryItemSchema = z.object({
  name: z.string().trim().min(1).max(RECIPE_NAME_MAX),
  quantity: z.number().finite().nonnegative().max(100_000),
  unit: z.string().trim().min(1).max(40),
  // SH-31a: the soonest expiry of this stock (date-only, household day) and the
  // days left until it (0 = today). Optional so an older page's request still works.
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expiresInDays: z.number().int().min(0).max(36_500).nullable().optional(),
});

export const GenerateRecipeInputSchema = z.object({
  items: z.array(PantryItemSchema).min(2, 'Please add at least two items to your pantry to generate a recipe.').max(60),
});
export type GenerateRecipeInput = z.infer<typeof GenerateRecipeInputSchema>;

export const GenerateRecipeOutputSchema = z.object({
  recipeTitle: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(1_000),
  ingredients: z.object({
    /** From the pantry: `pantryItem` is a supplied item's exact name; `line` is the amount the recipe uses. */
    used: z.array(z.object({
      pantryItem: z.string().trim().min(1).max(RECIPE_NAME_MAX),
      line: z.string().trim().min(1).max(RECIPE_LINE_MAX),
    })).max(RECIPE_USED_MAX),
    /** Missing: `name` is a short shopping-list name with no amount; `line` is the amount the recipe uses. */
    needed: z.array(z.object({
      name: z.string().trim().min(1).max(RECIPE_NAME_MAX),
      line: z.string().trim().min(1).max(RECIPE_LINE_MAX),
    })).max(RECIPE_NEEDED_MAX),
  }),
  instructions: z.array(z.string().trim().min(1).max(1_000)).min(1).max(30),
  prepTime: z.string().trim().min(1).max(80),
  cookTime: z.string().trim().min(1).max(80),
});
export type GenerateRecipeOutput = z.infer<typeof GenerateRecipeOutputSchema>;

export async function generateRecipeFlow(candidateInput: GenerateRecipeInput): Promise<GenerateRecipeOutput> {
  const input = parseTaskInput(GenerateRecipeInputSchema, candidateInput);
  const result = await generateStructured({
    flowName: 'recipe',
    input,
    model: openAiModels.recipe,
    outputSchema: GenerateRecipeOutputSchema,
    timeoutMs: 25_000,
    maxOutputTokens: 1_600,
    taskInstruction: [
      'Create one practical home recipe primarily using the supplied pantry items.',
      'Items may carry expiresInDays (days until the item goes off; 0 means today) and expiresOn. Build the recipe around the items with the fewest days left first; items without an expiry keep longer.',
      'Under ingredients.used, list each supplied item the recipe uses: pantryItem is that item\'s name exactly as supplied, line is the amount the recipe needs.',
      'Under ingredients.needed, list only what the recipe needs that is not a supplied item: name is a short shopping-list name with no amount, line is the amount the recipe needs. Never list a supplied item there.',
      'Use conventional flavor pairings and keep needed items few and common.',
      'Return clear steps and only the requested structured output.',
    ].join('\n'),
  });
  // The model is untrusted: pantry claims must name supplied stock, and each name appears once.
  return parseTaskOutput(GenerateRecipeOutputSchema, {
    ...result.output,
    ingredients: normalizeRecipeIngredients(result.output.ingredients, input.items),
  });
}
