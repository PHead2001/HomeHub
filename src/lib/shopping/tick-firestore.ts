import { doc, getDocFromCache, updateDoc, type UpdateData, type DocumentData } from 'firebase/firestore';
import { db, getLocalPersistence } from '@/lib/firebase';
import { isBrowserOffline } from '@/lib/firestore-offline';
import type { ItemPath, TickIO } from './tick';

const itemRef = ({ householdId, listId, itemId }: ItemPath) => doc(db, 'households', householdId, 'shopping-lists', listId, 'items', itemId);

/** The app's Firestore side of the shared tick (`tick.ts`): used by the Shopping page and the dashboard. */
export const shoppingTickIO: TickIO = {
  update: (path, data) => updateDoc(itemRef(path), data as UpdateData<DocumentData>),
  persistence: getLocalPersistence,
  offline: isBrowserOffline,
  cachedStatusIs: async (path, status) => {
    const cached = await getDocFromCache(itemRef(path));
    return cached.exists() && cached.get('status') === status;
  },
};
