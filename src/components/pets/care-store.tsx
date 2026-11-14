'use client';

/**
 * The household's Pets care store (PE-21a). One provider, mounted by the Pets
 * route layout (`src/app/pets/layout.tsx`), owns every pet's live care data:
 * the feeding window, medication (courses, legacy countdowns, offline doses)
 * and pinned notes. Cards, the board, the phone rows, the F picker, the pet
 * page's summary, its Medication tab and its Notes tab all read the same entry,
 * so a pet is subscribed once however many places show it, never once per
 * consumer. The layout persists across `/pets` ↔ `/pets/[id]`, and an entry
 * lingers for `LINGER_MS` after its last reader leaves, so opening a pet from
 * its card reuses the card's live data instead of subscribing again.
 *
 * The queries themselves are the existing resilient, settled-access hooks
 * (`usePetLogs`, `useMedicationState`, `usePinnedNotes`): each entry is one
 * invisible subscriber component that runs them and publishes the result.
 * Firestore has no single query over every pet's sub-collections without
 * collection-group rules, so each pet still has its own queries; what this adds
 * is that no pet is ever subscribed twice.
 */
import * as React from 'react';
import { useAuth } from '@/hooks/use-auth';
import type { PetFeedingLog } from '@/lib/pets/types';
import { useMedicationState, type MedicationState } from './medication-api';
import { usePetLogs } from './pet-log-api';
import { usePinnedNotes } from './records-api';
import { useNow } from './use-now';
import { CareStore } from './care-store-core';

export { LINGER_MS } from './care-store-core';

/** Newest feedings each pet loads (per date shape, merged), see `PET_FEEDING_WINDOW`. */
export const CARE_FEEDING_WINDOW = 30;
export type SharedPetCare = {
  feedings: ReturnType<typeof usePetLogs<PetFeedingLog>>;
  medications: MedicationState;
  pinned: ReturnType<typeof usePinnedNotes>;
};

/** The store, typed for this module's data. */
class PetCareStore extends CareStore<SharedPetCare> {}

const CareStoreContext = React.createContext<PetCareStore | null>(null);

/** One pet's subscriptions; invisible. Publishes after every render (each answer, the minute clock). */
function PetSubscriber({ store, storeKey }: { store: PetCareStore; storeKey: string }) {
  const [householdId, petId] = storeKey.split('/');
  const now = useNow();
  const { household } = useAuth();
  const feedings = usePetLogs<PetFeedingLog>(householdId, petId, 'feeding-logs', CARE_FEEDING_WINDOW);
  const medications = useMedicationState(householdId, petId, now, household?.timeZone ?? null);
  const pinned = usePinnedNotes(householdId, petId);
  React.useEffect(() => {
    store.publish(storeKey, { feedings, medications, pinned });
  });
  return null;
}

/** Provides the store and runs one subscriber per wanted pet. Mounted once by the Pets layout. */
export function PetsCareProvider({ children }: { children: React.ReactNode }) {
  const [store] = React.useState(() => new PetCareStore());
  const wanted = React.useSyncExternalStore(store.subscribeWanted, store.wanted, store.wanted);
  return (
    <CareStoreContext.Provider value={store}>
      {wanted.map((key) => <PetSubscriber key={key} store={store} storeKey={key} />)}
      {children}
    </CareStoreContext.Provider>
  );
}

const LOADING: SharedPetCare = {
  feedings: { logs: [], loading: true, error: null },
  medications: { courses: [], dues: [], legacy: [], legacyLogs: [], loading: true, error: null },
  pinned: { items: [], loading: true, error: null, hasMore: false, loadingMore: false, headline: null },
};

/**
 * A pet's shared live care data (feedings, medication, pinned notes). Reads as
 * loading until the store's subscriber has answered. Outside a provider (a
 * component rendered elsewhere) it stays loading, which every reader already
 * shows honestly.
 */
export function useSharedPetCare(householdId: string | null | undefined, petId: string): SharedPetCare {
  const store = React.useContext(CareStoreContext);
  const key = householdId ? `${householdId}/${petId}` : null;
  React.useEffect(() => {
    if (!store || !key) return;
    return store.acquire(key);
  }, [store, key]);
  const subscribe = React.useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => undefined), [store]);
  const snapshot = React.useCallback(() => (store && key ? store.read(key) : undefined), [store, key]);
  const value = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  return value ?? LOADING;
}

/** Whether a care store is mounted (tests and the source check). */
export function useHasCareStore(): boolean {
  return React.useContext(CareStoreContext) !== null;
}
