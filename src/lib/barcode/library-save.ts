/**
 * Saves an Open Food Facts find to the household library (BL-19): a create-only
 * transaction under the normalised barcode ID, like Add (BL-3), so a product
 * someone saved meanwhile is never replaced.
 */
import { doc, runTransaction } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { newProductData } from './library-writes';
import type { LibraryOffer } from './library-fill';

export async function saveOfferToLibrary(householdId: string, uid: string, offer: LibraryOffer): Promise<'saved' | 'exists'> {
  const ref = doc(db, 'households', householdId, 'barcode-library', offer.barcode);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists()) return 'exists';
    transaction.set(ref, {
      ...newProductData({ name: offer.name, photo: offer.imageUrl ? { imageUrl: offer.imageUrl } : null, uid, now: new Date() }),
      // BL-22: what Open Food Facts said about allergens and Nutri-Score.
      ...(offer.allergens?.length ? { allergens: offer.allergens } : {}),
      ...(offer.nutriScore ? { nutriScore: offer.nutriScore } : {}),
    });
    return 'saved';
  });
}
