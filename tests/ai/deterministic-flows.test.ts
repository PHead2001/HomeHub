import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

process.env.HOMEHUB_AI_TEST_MODE = 'deterministic';
process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS = 'true';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'demo-homehub-e2e';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
delete process.env.OPENAI_API_KEY;

type Tasks = {
  categorize: typeof import('../../src/ai/tasks/categorize-grocery-item');
  recipe: typeof import('../../src/ai/tasks/generate-recipe');
  maintenance: typeof import('../../src/ai/tasks/summarize-maintenance-log');
};

let tasks: Tasks;

before(async () => {
  const [categorize, recipe, maintenance] = await Promise.all([
    import('../../src/ai/tasks/categorize-grocery-item'),
    import('../../src/ai/tasks/generate-recipe'),
    import('../../src/ai/tasks/summarize-maintenance-log'),
  ]);
  tasks = { categorize, recipe, maintenance };
});

const assertAiCode = (code: string) => (error: unknown) => {
  assert.equal(error && typeof error === 'object' && 'code' in error ? error.code : undefined, code);
  return true;
};

describe('deterministic OpenAI task provider', () => {
  test('categorization validates allowed output and safe fallbacks', async () => {
    assert.deepEqual(await tasks.categorize.categorizeGroceryItemFlow({
      itemName: 'Milk',
      categories: ['Dairy', 'Other'],
    }), { category: 'Dairy' });
    assert.deepEqual(await tasks.categorize.categorizeGroceryItemFlow({
      itemName: 'AI-TEST:outside-category mystery item',
      categories: ['Dairy', 'Other'],
    }), { category: 'Other' });
    assert.deepEqual(await tasks.categorize.categorizeGroceryItemFlow({
      itemName: 'Apples',
      categories: ['Produce'],
    }), { category: 'Produce' });
  });

  for (const [scenario, code] of [
    ['timeout', 'timeout'],
    ['rate-limit', 'rate_limited'],
    ['provider-error', 'unavailable'],
    ['malformed', 'invalid_response'],
    ['refusal', 'refused'],
    ['incomplete', 'invalid_response'],
  ] as const) {
    test(`categorization reports ${scenario} safely`, async () => {
      await assert.rejects(tasks.categorize.categorizeGroceryItemFlow({
        itemName: `AI-TEST:${scenario} item`,
        categories: ['Other'],
      }), assertAiCode(code));
    });
  }

  test('recipe generation keeps its structured contract', async () => {
    const output = await tasks.recipe.generateRecipeFlow({
      items: [
        { name: 'Rice', quantity: 2, unit: 'cups' },
        { name: 'Beans', quantity: 1, unit: 'can' },
      ],
    });
    assert.equal(output.recipeTitle, 'Rice and Beans Skillet');
    assert.equal(output.instructions.length, 3);
    tasks.recipe.GenerateRecipeOutputSchema.parse(output);
  });

  test('recipe generation rejects too few items and provider failures', async () => {
    await assert.rejects(tasks.recipe.generateRecipeFlow({
      items: [{ name: 'Rice', quantity: 1, unit: 'cup' }],
    }));
    await assert.rejects(tasks.recipe.generateRecipeFlow({
      items: [
        { name: 'AI-TEST:malformed rice', quantity: 1, unit: 'cup' },
        { name: 'Beans', quantity: 1, unit: 'can' },
      ],
    }), assertAiCode('invalid_response'));
    await assert.rejects(tasks.recipe.generateRecipeFlow({
      items: [
        { name: 'AI-TEST:rate-limit rice', quantity: 1, unit: 'cup' },
        { name: 'Beans', quantity: 1, unit: 'can' },
      ],
    }), assertAiCode('rate_limited'));
  });

  test('maintenance summaries are bounded and failures are sanitized', async () => {
    const output = await tasks.maintenance.summarizeMaintenanceLogFlow({
      log: 'Replaced the furnace filter and confirmed normal airflow.',
    });
    assert.match(output.summary, /^Maintenance summary:/);
    tasks.maintenance.SummarizeMaintenanceLogOutputSchema.parse(output);

    await assert.rejects(tasks.maintenance.summarizeMaintenanceLogFlow({
      log: 'AI-TEST:refusal maintenance content',
    }), assertAiCode('refused'));
    await assert.rejects(tasks.maintenance.summarizeMaintenanceLogFlow({
      log: 'AI-TEST:provider-error maintenance content',
    }), assertAiCode('unavailable'));
  });
});
