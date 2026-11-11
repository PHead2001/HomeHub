import { doc, getDocFromCache, updateDoc, type UpdateData, type DocumentData } from 'firebase/firestore';
import { db, getLocalPersistence } from '@/lib/firebase';
import { isBrowserOffline } from '@/lib/firestore-offline';
import type { ItemPath, TickIO } from './tick';
import { browserStorage, recordLocalTick, settleLocalTick } from './overview';

// A tick that could not be kept in device storage this session: the overview then
// cannot tell this device's earlier ticks from another device's (SH-28c).
let localTickWriteFailed = false;
/** Whether a tick of this session could not be recorded in the local-ticks store. */
export const localTicksWriteFailed = (): boolean => localTickWriteFailed;

const itemRef = ({ householdId, listId, itemId }: ItemPath) => doc(db, 'households', householdId, 'shopping-lists', listId, 'items', itemId);

/** The app's Firestore side of the shared tick (`tick.ts`): used by the Shopping page and the dashboard. */
export const shoppingTickIO: TickIO = {
  update: (path, data) => updateDoc(itemRef(path), data as UpdateData<DocumentData>),
  persistence: getLocalPersistence,
  offline: isBrowserOffline,
  // Every tick through the shared path (the list, the overview, the dashboard tile).
  recordLocal: (path, opId) => {
    if (!recordLocalTick(browserStorage(), path.householdId, path.listId, opId, Date.now(), path.itemId)) localTickWriteFailed = true;
  },
  // Pending ticks are never aged out; an acknowledged one ages from now. A write
  // acknowledged after a reload is caught by `syncLocalTicks` on the next snapshot.
  settleLocal: (path, opId, outcome) => {
    if (!settleLocalTick(browserStorage(), path.householdId, path.listId, opId, Date.now(), outcome)) localTickWriteFailed = true;
  },
  cachedStatusIs: async (path, status) => {
    const cached = await getDocFromCache(itemRef(path));
    return cached.exists() && cached.get('status') === status;
  },
};
