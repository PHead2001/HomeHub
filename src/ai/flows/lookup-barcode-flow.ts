'use server';

import { z } from 'genkit';
import {
  executeAuthorizedAiAction,
  type AiActionContext,
  type AuthorizedHouseholdUser,
} from '@/ai/action-auth';
import type { AiActionResult } from '@/ai/errors';
import { parseOpenFoodFactsQuantity } from '@/ai/barcode-quantity';
import { adminDb } from '@/lib/server/firebase-admin';
import type { BarcodeLibraryItem, PantryItemUnit } from '@/lib/types';

const LookupBarcodeInputSchema = z.object({
  barcode: z.string().trim().regex(/^\d{6,32}$/),
});
export type LookupBarcodeInput = z.infer<typeof LookupBarcodeInputSchema>;

export type LookupBarcodeOutput = {
  productName: string | null;
  libraryItem: BarcodeLibraryItem | null;
  source: 'household' | 'open_food_facts' | 'none';
  quantity?: number;
  unit?: PantryItemUnit;
  rawQuantity?: string;
  imageUrl?: string;
};

type OpenFoodFactsProduct = {
  product_name?: unknown;
  quantity?: unknown;
  product_quantity?: unknown;
  product_quantity_unit?: unknown;
  image_front_url?: unknown;
};

const deterministicFixtures: Record<string, OpenFoodFactsProduct | null | 'timeout' | 'rate-limit' | 'malformed'> = {
  '008500001280': { product_name: 'E2E Family Juice', quantity: '128 fl oz' },
  '009900045000': { product_name: 'E2E Yogurt Multipack', quantity: '3 x 150 g', product_quantity: 450, product_quantity_unit: 'g' },
  '007700000006': { product_name: 'E2E Odd Measure', quantity: '1 bushel' },
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
});

const fetchOpenFoodFacts = async (barcode: string): Promise<OpenFoodFactsProduct | null> => {
  if (isSafeDeterministicMode()) {
    const fixture = deterministicFixtures[barcode] ?? null;
    if (fixture === 'timeout') throw new Error('Open Food Facts request timed out.');
    if (fixture === 'rate-limit') throw new Error('Open Food Facts request was rate limited.');
    if (fixture === 'malformed') throw new Error('Open Food Facts returned malformed data.');
    return fixture;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const fields = 'product_name,quantity,product_quantity,product_quantity_unit,image_front_url';
    const response = await fetch(`https://world.openfoodfacts.org/api/v3/product/${barcode}.json?fields=${fields}`, {
      headers: { 'User-Agent': 'HomeHub/1.0 (private household inventory application)' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 429 || !response.ok) return null;
    const payload = await response.json() as { status?: unknown; product?: OpenFoodFactsProduct };
    return payload.status === 'success' || payload.status === 1 ? payload.product || null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

export const lookupBarcodeForAuthorizedUser = async (
  rawInput: LookupBarcodeInput,
  user: AuthorizedHouseholdUser
): Promise<LookupBarcodeOutput> => {
  const { barcode } = LookupBarcodeInputSchema.parse(rawInput);
  const snapshot = await adminDb
    .collection('households')
    .doc(user.householdId)
    .collection('barcode-library')
    .doc(barcode)
    .get();

  if (snapshot.exists) {
    const libraryItem = sanitizeLibraryItem(snapshot.id, snapshot.data() || {});
    return { productName: libraryItem.name, libraryItem, source: 'household' };
  }

  const product = await fetchOpenFoodFacts(barcode);
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
  };
};

export async function lookupBarcode(
  input: LookupBarcodeInput,
  context: AiActionContext
): Promise<AiActionResult<LookupBarcodeOutput>> {
  return executeAuthorizedAiAction({
    context,
    permission: 'shopping.view',
    flowName: 'barcode-lookup',
    maxRequestsPerMinute: 30,
    task: user => lookupBarcodeForAuthorizedUser(input, user),
  });
}
