import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { nutritionChips, parseAllergens, parseNutriScore, storedNutrition } from '../../src/lib/barcode/nutrition';

describe('allergen and Nutri-Score chips (BL-22)', () => {
  test('English allergen tags as plain words, deduplicated and bounded', () => {
    assert.deepEqual(parseAllergens(['en:peanuts', 'en:milk', 'fr:lait', 'en:milk', 'en:tree-nuts', 7, 'en:<b>']), ['peanuts', 'milk', 'tree nuts']);
    assert.deepEqual(parseAllergens('en:peanuts'), []);
    assert.equal(parseAllergens(Array.from({ length: 40 }, (_, i) => `en:a${i}`)).length, 20);
  });

  test('Nutri-Score a to e only', () => {
    assert.equal(parseNutriScore('B'), 'b');
    assert.equal(parseNutriScore('unknown'), null);
    assert.equal(parseNutriScore('not-applicable'), null);
    assert.equal(parseNutriScore(3), null);
  });

  test('chips say only what is known', () => {
    assert.deepEqual(nutritionChips({ allergens: ['peanuts', 'milk'], nutriScore: 'b' }), [
      { kind: 'allergens', label: 'Contains: peanuts, milk' },
      { kind: 'nutri-score', label: 'Nutri-Score B', tone: 'b' },
    ]);
    assert.deepEqual(nutritionChips({}), []);
    assert.deepEqual(storedNutrition({ allergens: ['ok', 5, 'x'.repeat(41)], nutriScore: 'z' }), { allergens: ['ok'], nutriScore: null });
  });
});
