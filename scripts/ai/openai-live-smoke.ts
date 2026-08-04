import { config } from 'dotenv';

config({ path: '.env.local', override: false });

if (!process.env.OPENAI_API_KEY?.trim()) {
  throw new Error('OPENAI_API_KEY is required for the manual live smoke test.');
}
if (process.env.CI && process.env.RUN_OPENAI_LIVE_SMOKE !== 'true') {
  throw new Error('Live OpenAI smoke testing is disabled in CI unless RUN_OPENAI_LIVE_SMOKE=true.');
}
if (process.env.HOMEHUB_AI_TEST_MODE) {
  throw new Error('Disable HOMEHUB_AI_TEST_MODE before running the live OpenAI smoke test.');
}

const run = async () => {
  const [modelConfig, categorizationTask, recipeTask, maintenanceTask] = await Promise.all([
    import('../../src/ai/model-config'),
    import('../../src/ai/tasks/categorize-grocery-item'),
    import('../../src/ai/tasks/generate-recipe'),
    import('../../src/ai/tasks/summarize-maintenance-log'),
  ]);

  const categorization = await categorizationTask.categorizeGroceryItemFlow({
    itemName: 'whole milk',
    categories: ['Produce', 'Dairy', 'Other'],
  });
  categorizationTask.CategorizeGroceryItemOutputSchema.parse(categorization);
  console.log(`categorization: PASS model=${modelConfig.openAiModels.categorization} usage=not-exposed-by-flow`);

  const recipe = await recipeTask.generateRecipeFlow({
    items: [
      { name: 'rice', quantity: 1, unit: 'cup' },
      { name: 'black beans', quantity: 1, unit: 'can' },
    ],
  });
  recipeTask.GenerateRecipeOutputSchema.parse(recipe);
  console.log(`recipe: PASS model=${modelConfig.openAiModels.recipe} usage=not-exposed-by-flow`);

  const summary = await maintenanceTask.summarizeMaintenanceLogFlow({
    log: 'Replaced the HVAC filter and confirmed normal airflow. No follow-up issue was found.',
  });
  maintenanceTask.SummarizeMaintenanceLogOutputSchema.parse(summary);
  console.log(`maintenance-summary: PASS model=${modelConfig.openAiModels.maintenance} usage=not-exposed-by-flow`);
};

await run();
