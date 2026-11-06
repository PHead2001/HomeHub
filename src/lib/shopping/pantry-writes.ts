import { collection, doc, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { slugify } from '@/lib/utils';
import type { PantryItem } from '@/lib/types';
import { planPantryHandoff, type PantryHandoffChoice } from './pantry';

/**
 * Writes a batch of purchased items into `households/{id}/pantry-inventory` in one
 * Firestore batch: existing same-name entries (same shelf, counted in `items`)
 * grow, everything else is created with the fields the pantry form writes
 * (`name`, `quantity`, `unit: 'items'`, `location`, `expiryDate: null`). Only
 * called online: the caller hides the action offline. Returns the number of
 * pantry entries written.
 */
export async function addPurchasesToPantry(householdId: string, choices: readonly PantryHandoffChoice[]): Promise<number> {
  const pantry = collection(db, 'households', householdId, 'pantry-inventory');
  const snapshot = await getDocs(pantry);
  const existing = snapshot.docs.map((pantryDoc) => ({ id: pantryDoc.id, ...pantryDoc.data() } as PantryItem));
  const plans = planPantryHandoff(choices, existing);
  if (plans.length === 0) return 0;

  const batch = writeBatch(db);
  for (const plan of plans) {
    if (plan.kind === 'increment') {
      batch.update(doc(pantry, plan.id), { quantity: plan.quantity });
    } else {
      batch.set(doc(pantry, slugify(plan.name)), {
        name: plan.name,
        quantity: plan.quantity,
        unit: 'items',
        location: plan.location,
        expiryDate: null,
      });
    }
  }
  await batch.commit();
  return plans.length;
}
