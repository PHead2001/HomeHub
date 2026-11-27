/**
 * Allergen and Nutri-Score chips (BL-22). Open Food Facts answers both in the
 * same lookup (`allergens_tags`, `nutriscore_grade`); they are kept on a saved
 * library product (`allergens`, `nutriScore`) and shown on its card and on
 * shopping rows that carry its barcode. Pure; unit tested in
 * tests/unit/barcode-nutrition.test.ts. Community data: shown as given, never
 * inferred (no tag means nothing is shown, not "allergen free").
 */

export type NutriScore = 'a' | 'b' | 'c' | 'd' | 'e';

export const MAX_ALLERGENS = 20;
const MAX_ALLERGEN_LENGTH = 40;

/** `["en:peanuts", "en:milk", "fr:lait"]` as `["peanuts", "milk"]`: English tags only, plain words, deduplicated. */
export function parseAllergens(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const match = /^en:([a-z][a-z0-9-]*)$/.exec(tag.trim().toLowerCase());
    if (!match) continue;
    const word = match[1].replace(/-/g, ' ').slice(0, MAX_ALLERGEN_LENGTH).trim();
    if (word && !out.includes(word)) out.push(word);
    if (out.length >= MAX_ALLERGENS) break;
  }
  return out;
}

/** A Nutri-Score grade a to e, or null ("unknown", "not-applicable", anything else). */
export function parseNutriScore(grade: unknown): NutriScore | null {
  if (typeof grade !== 'string') return null;
  const value = grade.trim().toLowerCase();
  return value === 'a' || value === 'b' || value === 'c' || value === 'd' || value === 'e' ? value : null;
}

/** Stored values read back defensively (a document written by anyone with shopping.edit). */
export function storedNutrition(data: { allergens?: unknown; nutriScore?: unknown }): { allergens: string[]; nutriScore: NutriScore | null } {
  const allergens = Array.isArray(data.allergens)
    ? data.allergens.filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ALLERGEN_LENGTH).slice(0, MAX_ALLERGENS)
    : [];
  return { allergens, nutriScore: parseNutriScore(data.nutriScore) };
}

export type NutritionChip = { kind: 'allergens' | 'nutri-score'; label: string; tone?: NutriScore };

/** "Contains: peanuts, milk" and "Nutri-Score B", in that order; nothing for unknown data. */
export function nutritionChips(data: { allergens?: unknown; nutriScore?: unknown }): NutritionChip[] {
  const { allergens, nutriScore } = storedNutrition(data);
  const chips: NutritionChip[] = [];
  if (allergens.length > 0) chips.push({ kind: 'allergens', label: `Contains: ${allergens.join(', ')}` });
  if (nutriScore) chips.push({ kind: 'nutri-score', label: `Nutri-Score ${nutriScore.toUpperCase()}`, tone: nutriScore });
  return chips;
}
