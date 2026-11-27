'use server';

import { z } from 'zod';
import {
  executeAuthorizedAiAction,
  type AiActionContext,
  type AuthorizedHouseholdUser,
} from '@/ai/action-auth';
import type { AiActionResult } from '@/ai/errors';
import { parseOpenFoodFactsQuantity } from '@/ai/barcode-quantity';
import { adminDb } from '@/lib/server/firebase-admin';
import type { BarcodeLibraryItem, PantryItemUnit } from '@/lib/types';
import {
  classifyOpenFoodFactsError,
  classifyOpenFoodFactsReply,
  type OpenFoodFactsOutcome,
  type UnavailableReason,
} from '@/lib/barcode/lookup-outcome';
import { lookupIds } from '@/lib/barcode/gtin';
import { parseAllergens, parseNutriScore, storedNutrition, type NutriScore } from '@/lib/barcode/nutrition';

const LookupBarcodeInputSchema = z.object({
  barcode: z.string().trim().regex(/^\d{6,32}$/),
});
export type LookupBarcodeInput = z.infer<typeof LookupBarcodeInputSchema>;

export type LookupBarcodeOutput = {
  productName: string | null;
  libraryItem: BarcodeLibraryItem | null;
  /** `none`: the public database does not know the code; `unavailable`: it could not answer (BL-9). */
  source: 'household' | 'open_food_facts' | 'none' | 'unavailable';
  unavailableReason?: UnavailableReason;
  quantity?: number;
  unit?: PantryItemUnit;
  rawQuantity?: string;
  imageUrl?: string;
  /** BL-22: Open Food Facts allergens (English tag words) and Nutri-Score, when it knows them. */
  allergens?: string[];
  nutriScore?: NutriScore;
};

type OpenFoodFactsProduct = {
  product_name?: unknown;
  quantity?: unknown;
  product_quantity?: unknown;
  product_quantity_unit?: unknown;
  image_front_url?: unknown;
  allergens_tags?: unknown;
  nutriscore_grade?: unknown;
};

const deterministicFixtures: Record<string, OpenFoodFactsProduct | null | 'timeout' | 'rate-limit' | 'malformed'> = {
  '008500001280': { product_name: 'E2E Family Juice', quantity: '128 fl oz' },
  '009900045000': { product_name: 'E2E Yogurt Multipack', quantity: '3 x 150 g', product_quantity: 450, product_quantity_unit: 'g' },
  '007700000006': { product_name: 'E2E Odd Measure', quantity: '1 bushel' },
  '005500000551': { product_name: 'E2E Peanut Bar', quantity: '50 g', product_quantity: 50, product_quantity_unit: 'g', allergens_tags: ['en:peanuts', 'en:milk'], nutriscore_grade: 'd' },
  '000000000404': null,
  '000000000408': 'timeout',
  '000000000429': 'rate-limit',
  '000000000422': 'malformed',
};

const isSafeDeterministicMode = () => process.env.HOMEHUB_AI_TEST_MODE === 'deterministic'
  && process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true'
  && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === 'demo-homehub-e2e'
  && process.env.NODE_ENV !== 'production';

const sanitizeLibraryItem = (id: string, data: Record<string, unknown>): BarcodeLibraryItem => ({
  id,
  name: typeof data.name === 'string' ? data.name.slice(0, 160) : 'Saved product',
  imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : '',
  ...(typeof data.imagePath === 'string' ? { imagePath: data.imagePath } : {}),
  createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date(0).toISOString(),
  ...nutritionOf(data),
});

/** Stored allergens and Nutri-Score, only when present (BL-22). */
const nutritionOf = (data: Record<string, unknown>) => {
  const { allergens, nutriScore } = storedNutrition(data);
  return { ...(allergens.length > 0 ? { allergens } : {}), ...(nutriScore ? { nutriScore } : {}) };
};

const fetchOpenFoodFacts = async (barcode: string): Promise<OpenFoodFactsOutcome<OpenFoodFactsProduct>> => {
  if (isSafeDeterministicMode()) {
    const fixture = deterministicFixtures[barcode] ?? null;
    if (fixture === 'timeout') return { kind: 'unavailable', reason: 'timeout' };
    if (fixture === 'rate-limit') return { kind: 'unavailable', reason: 'rate_limited' };
    if (fixture === 'malformed') return { kind: 'unavailable', reason: 'error' };
    return fixture ? { kind: 'found', product: fixture } : { kind: 'not-found' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const fields = 'product_name,quantity,product_quantity,product_quantity_unit,image_front_url,allergens_tags,nutriscore_grade';
    const response = await fetch(`https://world.openfoodfacts.org/api/v3/product/${barcode}.json?fields=${fields}`, {
      headers: { 'User-Agent': 'HomeHub/1.0 (private household inventory application)' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return classifyOpenFoodFactsReply<OpenFoodFactsProduct>(response.status, payload);
  } catch (error) {
    return classifyOpenFoodFactsError(error);
  } finally {
    clearTimeout(timeout);
  }
};

export const lookupBarcodeForAuthorizedUser = async (
  rawInput: LookupBarcodeInput,
  user: AuthorizedHouseholdUser
): Promise<LookupBarcodeOutput> => {
  const { barcode: raw } = LookupBarcodeInputSchema.parse(rawInput);
  // BL-12: the normalised ID first, then the code as given (a product saved before
  // normalisation that scripts/ops/normalize-barcode-library.mjs has not moved yet).
  const ids = lookupIds(raw);
  const barcode = ids[0] ?? raw;
  const library = adminDb.collection('households').doc(user.householdId).collection('barcode-library');
  for (const id of ids) {
    const snapshot = await library.doc(id).get();
    if (snapshot.exists) {
      const libraryItem = sanitizeLibraryItem(snapshot.id, snapshot.data() || {});
      return { productName: libraryItem.name, libraryItem, source: 'household' };
    }
  }

  const outcome = await fetchOpenFoodFacts(barcode);
  if (outcome.kind === 'unavailable') {
    return { productName: null, libraryItem: null, source: 'unavailable', unavailableReason: outcome.reason };
  }
  const product = outcome.kind === 'found' ? outcome.product : null;
  const productName = typeof product?.product_name === 'string' ? product.product_name.trim().slice(0, 160) : null;
  if (!productName) return { productName: null, libraryItem: null, source: 'none' };
  const productData = product as OpenFoodFactsProduct;

  const rawQuantity = typeof productData.quantity === 'string' ? productData.quantity.trim().slice(0, 80) : undefined;
  const parsed = parseOpenFoodFactsQuantity({
    quantityText: rawQuantity,
    normalizedQuantity: typeof productData.product_quantity === 'number' || typeof productData.product_quantity === 'string'
      ? productData.product_quantity : undefined,
    normalizedUnit: typeof productData.product_quantity_unit === 'string' ? productData.product_quantity_unit : undefined,
  });
  return {
    productName,
    libraryItem: null,
    source: 'open_food_facts',
    ...(parsed || {}),
    ...(rawQuantity ? { rawQuantity } : {}),
    ...(typeof productData.image_front_url === 'string' ? { imageUrl: productData.image_front_url } : {}),
    ...nutritionOf({ allergens: parseAllergens(productData.allergens_tags), nutriScore: parseNutriScore(productData.nutriscore_grade) }),
  };
};

export async function lookupBarcode(
  input: LookupBarcodeInput,
  context: AiActionContext
): Promise<AiActionResult<LookupBarcodeOutput>> {
  return executeAuthorizedAiAction({
    context,
    input,
    permission: 'shopping.view',
    flowName: 'barcode-lookup',
    maxRequestsPerMinute: 30,
    // Model-free (household library, then Open Food Facts): never spends or needs
    // the daily AI quota, so scanning keeps working when AI capacity is used up.
    consumeQuota: false,
    task: user => lookupBarcodeForAuthorizedUser(input, user),
  });
}
