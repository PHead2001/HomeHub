'use server';
/**
 * @fileOverview Generates a recipe based on a list of available pantry items.
 *
 * - generateRecipe - A function that takes pantry items and returns a recipe.
 * - GenerateRecipeInput - The input type for the generateRecipe function.
 * - GenerateRecipeOutput - The return type for the generateRecipe function.
 */

import { ai } from '@/ai/genkit';
import { z } from 'genkit';

const PantryItemSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
});

const GenerateRecipeInputSchema = z.object({
  items: z.array(PantryItemSchema).describe('The list of items available in the user\'s pantry.'),
});
export type GenerateRecipeInput = z.infer<typeof GenerateRecipeInputSchema>;

const GenerateRecipeOutputSchema = z.object({
  recipeTitle: z.string().describe('A creative and appealing title for the recipe.'),
  description: z.string().describe('A short, enticing description of the dish.'),
  ingredients: z.object({
    used: z.array(z.string()).describe('List of ingredients from the pantry that are used in the recipe.'),
    needed: z.array(z.string()).describe('List of additional ingredients required to make the recipe.'),
  }),
  instructions: z.array(z.string()).describe('A step-by-step list of instructions to prepare the dish.'),
  prepTime: z.string().describe('Estimated preparation time.'),
  cookTime: z.string().describe('Estimated cooking time.'),
});
export type GenerateRecipeOutput = z.infer<typeof GenerateRecipeOutputSchema>;

export async function generateRecipe(input: GenerateRecipeInput): Promise<GenerateRecipeOutput> {
  return generateRecipeFlow(input);
}

const prompt = ai.definePrompt({
  name: 'generateRecipePrompt',
  input: { schema: GenerateRecipeInputSchema },
  output: { schema: GenerateRecipeOutputSchema },
  prompt: `You are an expert chef who excels at creating delicious and practical recipes from a limited set of ingredients. A user has provided a list of items from their pantry, fridge, and freezer.

Your task is to generate a single, creative, and coherent recipe that primarily uses these ingredients.

Available Ingredients:
{{#each items}}
- {{this.name}} ({{this.quantity}} {{this.unit}})
{{/each}}

Follow these instructions:
1.  **Analyze the ingredients**: Determine an appealing dish that can be made. Consider the quantities to ensure the recipe is feasible.
2.  **Flavor Combinations**: Prioritize recipes with conventional and delicious flavor pairings. Avoid unusual combinations that are not typically found in well-regarded cuisines (e.g., avoid combining baked beans and macaroni and cheese into a single dish). The goal is a tasty, reliable meal.
3.  **Primary Ingredients**: The recipe must use a significant portion of the provided ingredients.
4.  **Supplemental Ingredients**: If necessary, you can require a small number of common, essential ingredients that the user might have (e.g., salt, pepper, oil, water, a common spice). List these under "needed" ingredients.
5.  **Clarity**: Provide clear, concise, step-by-step instructions that are easy for a home cook to follow.
6.  **No-Go**: Do not invent ingredients the user does not have, unless they are common staples listed under "needed".
7.  **Output Format**: Structure your response strictly according to the output schema.
`,
});

const generateRecipeFlow = ai.defineFlow(
  {
    name: 'generateRecipeFlow',
    inputSchema: GenerateRecipeInputSchema,
    outputSchema: GenerateRecipeOutputSchema,
  },
  async input => {
    if (input.items.length < 2) {
        throw new Error('Please add at least two items to your pantry to generate a recipe.');
    }
    const { output } = await prompt(input);
    return output!;
  }
);
