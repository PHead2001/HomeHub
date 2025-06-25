
'use server';
/**
 * @fileOverview Looks up a product by its barcode, first checking a local
 * household library and then falling back to the Open Food Facts API.
 * 
 * - lookupBarcode - A function that takes a barcode and returns product info.
 * - LookupBarcodeInput - The input type for the lookupBarcode function.
 * - LookupBarcodeOutput - The return type for the lookupBarcode function.
 */

import { ai } from '@/ai/genkit';
import { z } from 'genkit';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { BarcodeLibraryItem } from '@/lib/types';


const LookupBarcodeInputSchema = z.object({
  barcode: z.string().describe('The product barcode (UPC) to look up.'),
  householdId: z.string().describe('The ID of the household to check the local library for.'),
});
export type LookupBarcodeInput = z.infer<typeof LookupBarcodeInputSchema>;

const BarcodeLibraryItemSchema = z.object({
    id: z.string(),
    name: z.string(),
    imageUrl: z.string(),
    createdAt: z.string(),
});

const LookupBarcodeOutputSchema = z.object({
  productName: z.string().nullable().describe('The name of the product found, or null if not found.'),
  libraryItem: BarcodeLibraryItemSchema.nullable().describe('The item from the local library, if found.'),
});
export type LookupBarcodeOutput = z.infer<typeof LookupBarcodeOutputSchema>;


async function lookupInLocalLibrary(householdId: string, barcode: string): Promise<BarcodeLibraryItem | null> {
    const itemDocRef = doc(db, 'households', householdId, 'barcode-library', barcode);
    try {
        const docSnap = await getDoc(itemDocRef);
        if (docSnap.exists()) {
            return { id: docSnap.id, ...docSnap.data() } as BarcodeLibraryItem;
        }
        return null;
    } catch (error) {
        console.error('Error looking up in local barcode library:', error);
        return null; // Don't block the flow if this fails
    }
}


async function lookupProductOnOpenFoodFacts(barcode: string): Promise<string | null> {
    const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'HomeHubApp - Web - Version 1.0',
            }
        });
        if (!response.ok) {
            console.error(`Open Food Facts API error: ${response.status}`);
            return null;
        }
        const data = await response.json();
        if (data.status === 1 && data.product && data.product.product_name) {
            return data.product.product_name;
        }
        return null;
    } catch (error) {
        console.error('Failed to fetch from Open Food Facts API', error);
        return null;
    }
}

export async function lookupBarcode(input: LookupBarcodeInput): Promise<LookupBarcodeOutput> {
  return lookupBarcodeFlow(input);
}


const lookupBarcodeFlow = ai.defineFlow(
  {
    name: 'lookupBarcodeFlow',
    inputSchema: LookupBarcodeInputSchema,
    outputSchema: LookupBarcodeOutputSchema,
  },
  async ({ barcode, householdId }) => {
    // 1. Check local library first
    const libraryItem = await lookupInLocalLibrary(householdId, barcode);
    if (libraryItem) {
        return {
            productName: libraryItem.name,
            libraryItem: libraryItem,
        }
    }

    // 2. If not found, fall back to Open Food Facts API
    const productName = await lookupProductOnOpenFoodFacts(barcode);
    return {
        productName,
        libraryItem: null,
    };
  }
);
