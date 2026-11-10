import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { toStrictOutputSchema, type JsonSchema } from '../../src/ai/strict-output-schema';
import { CategorizeGroceryItemOutputSchema } from '../../src/ai/tasks/categorize-grocery-item';
import { CategorizeGroceryItemsModelOutputSchema } from '../../src/ai/tasks/categorize-grocery-items';
import { GenerateRecipeOutputSchema } from '../../src/ai/tasks/generate-recipe';
import { SummarizeMaintenanceLogOutputSchema } from '../../src/ai/tasks/summarize-maintenance-log';
import { HomeOverviewNarrativeSchema, OverviewSectionSchema } from '../../src/ai/overview-schemas';

// Keywords OpenAI strict structured outputs reject (mirrors the SDK's own list) plus the
// annotations the converter drops.
const forbiddenKeywords = [
  '$schema', 'default', '$ref', '$defs', 'definitions', 'allOf', 'oneOf', 'not', 'if', 'then', 'else',
  'patternProperties', 'propertyNames', 'dependencies', 'dependentRequired', 'dependentSchemas',
  'unevaluatedItems', 'unevaluatedProperties', 'prefixItems', 'contains', 'minProperties', 'maxProperties',
  'uniqueItems',
];

const assertStrict = (schema: JsonSchema, path = '#') => {
  for (const keyword of forbiddenKeywords) assert.equal(keyword in schema, false, `${path} has ${keyword}`);
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path} must close additionalProperties`);
    const properties = schema.properties as Record<string, JsonSchema>;
    assert.ok(properties, `${path} must list properties`);
    assert.deepEqual(schema.required, Object.keys(properties), `${path} must require every property`);
    for (const [key, child] of Object.entries(properties)) assertStrict(child, `${path}/properties/${key}`);
  }
  if (schema.type === 'array') assertStrict(schema.items as JsonSchema, `${path}/items`);
  if (Array.isArray(schema.anyOf)) schema.anyOf.forEach((branch, index) => assertStrict(branch as JsonSchema, `${path}/anyOf/${index}`));
};

const flowOutputSchemas = {
  categorization: CategorizeGroceryItemOutputSchema,
  'categorization-batch': CategorizeGroceryItemsModelOutputSchema,
  recipe: GenerateRecipeOutputSchema,
  'maintenance-summary': SummarizeMaintenanceLogOutputSchema,
  overview: HomeOverviewNarrativeSchema,
} as const;

describe('strict OpenAI output schemas', () => {
  for (const [flow, schema] of Object.entries(flowOutputSchemas)) {
    test(`${flow} output converts to a strict-mode schema`, () => {
      const { wireSchema } = toStrictOutputSchema(schema);
      assert.equal(wireSchema.type, 'object');
      assertStrict(wireSchema);
    });
  }

  test('fully required schemas are sent unchanged apart from closing objects', () => {
    assert.deepEqual(toStrictOutputSchema(CategorizeGroceryItemOutputSchema).wireSchema, {
      type: 'object',
      properties: { category: { type: 'string', minLength: 1, maxLength: 60 } },
      required: ['category'],
      additionalProperties: false,
    });
    const recipe = toStrictOutputSchema(GenerateRecipeOutputSchema).wireSchema as {
      properties: { ingredients: JsonSchema; instructions: JsonSchema };
    };
    assert.deepEqual(recipe.properties.ingredients.required, ['used', 'needed']);
    assert.equal(recipe.properties.ingredients.additionalProperties, false);
    assert.deepEqual(recipe.properties.instructions, {
      type: 'array',
      minItems: 1,
      maxItems: 30,
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
    });
  });

  test('overview section summaries become one required, nullable property per section', () => {
    const wire = toStrictOutputSchema(HomeOverviewNarrativeSchema).wireSchema as {
      properties: { sectionSummaries: { anyOf: [{ properties: Record<string, JsonSchema>; required: string[] }, JsonSchema] } };
    };
    // sectionSummaries has a .default({}), so the whole record is itself nullable.
    const [summaries, nullBranch] = wire.properties.sectionSummaries.anyOf;
    assert.deepEqual(nullBranch, { type: 'null' });
    assert.deepEqual(summaries.required, OverviewSectionSchema.options);
    for (const section of OverviewSectionSchema.options) {
      assert.deepEqual(summaries.properties[section], {
        anyOf: [{ type: 'string', minLength: 1, maxLength: 240 }, { type: 'null' }],
      });
    }
  });

  test('decoded wire output parses with every flow schema', () => {
    const cases: Array<[z.ZodType, unknown]> = [
      [CategorizeGroceryItemOutputSchema, { category: 'Dairy' }],
      [SummarizeMaintenanceLogOutputSchema, { summary: 'Filter replaced.' }],
      [GenerateRecipeOutputSchema, {
        recipeTitle: 'Rice and Beans',
        description: 'Simple.',
        ingredients: { used: ['rice', 'beans'], needed: [] },
        instructions: ['Cook.'],
        prepTime: '5 minutes',
        cookTime: '20 minutes',
      }],
    ];
    for (const [schema, value] of cases) {
      const { decode } = toStrictOutputSchema(schema);
      assert.deepEqual(schema.parse(decode(value)), value);
    }

    const overview = toStrictOutputSchema(HomeOverviewNarrativeSchema);
    const wireValue = {
      headline: '  Your home  ',
      summary: 'Two things need attention.',
      priorities: [{ level: 'urgent', title: 'Furnace', explanation: 'Overdue.', sourceSection: 'maintenance' }],
      sectionSummaries: Object.fromEntries(OverviewSectionSchema.options.map(section => [
        section,
        section === 'chores' ? 'One chore is due today.' : null,
      ])),
    };
    assert.deepEqual(HomeOverviewNarrativeSchema.parse(overview.decode(wireValue)), {
      headline: 'Your home',
      summary: 'Two things need attention.',
      priorities: [{ level: 'urgent', title: 'Furnace', explanation: 'Overdue.', sourceSection: 'maintenance' }],
      sectionSummaries: { chores: 'One chore is due today.' },
    });
    // An all-null record decodes to {} and still parses.
    const allNull = { ...wireValue, sectionSummaries: Object.fromEntries(OverviewSectionSchema.options.map(section => [section, null])) };
    assert.deepEqual(HomeOverviewNarrativeSchema.parse(overview.decode(allNull)).sectionSummaries, {});
    // A null record falls back to the schema default.
    assert.deepEqual(HomeOverviewNarrativeSchema.parse(overview.decode({ ...wireValue, sectionSummaries: null })).sectionSummaries, {});
  });

  test('optional and defaulted properties are nullable on the wire and null is removed again', () => {
    const schema = z.object({
      title: z.string(),
      note: z.string().optional(),
      tags: z.array(z.string()).default([]),
      nested: z.object({ due: z.string().max(32).optional() }),
    });
    const strict = toStrictOutputSchema(schema);
    assertStrict(strict.wireSchema);
    const properties = strict.wireSchema.properties as Record<string, JsonSchema>;
    assert.deepEqual(properties.note, { anyOf: [{ type: 'string' }, { type: 'null' }] });
    assert.deepEqual(properties.title, { type: 'string' });
    assert.deepEqual(
      schema.parse(strict.decode({ title: 'A', note: null, tags: null, nested: { due: null } })),
      { title: 'A', tags: [], nested: {} },
    );
    // A null for a required property is not removed, so the Zod gate still rejects it.
    assert.equal(schema.safeParse(strict.decode({ title: null, note: null, tags: null, nested: {} })).success, false);
  });

  test('schemas strict mode cannot represent are rejected at conversion time', () => {
    assert.throws(() => toStrictOutputSchema(z.object({ free: z.record(z.string(), z.string()) })), /string enum/);
    assert.throws(() => toStrictOutputSchema(z.object({ x: z.string() }).catchall(z.string())), /free-form additionalProperties/);
    assert.throws(() => toStrictOutputSchema(z.object({ pair: z.tuple([z.string(), z.number()]) })), /single items schema|prefixItems/);
  });

  test('conversion is cached per schema', () => {
    assert.equal(toStrictOutputSchema(GenerateRecipeOutputSchema), toStrictOutputSchema(GenerateRecipeOutputSchema));
  });
});
