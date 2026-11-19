'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { settledPetAccess, type PetAccess } from '@/lib/pets/live-listener';

/**
 * The settled access every Pets listener is keyed on (`petListenerKey`): null
 * until auth and household membership have loaded (no listener starts; readers
 * show loading), then the member and their `pets.view`, kept while a later
 * membership snapshot is loading, and replaced only by a real change
 * (`settledPetAccess`). So a pet list, card, pet page or tab subscribes once,
 * and never falls back to a skeleton when permissions settle after the first
 * render, while access returning or being revoked still recreates it.
 */
export function useSettledPetAccess(): PetAccess | null {
  const { currentUser, permissions, loading, householdLoading } = useAuth();
  const settled = !loading && !householdLoading;
  const current: PetAccess = { uid: currentUser?.uid ?? null, canView: Boolean(permissions['pets.view']) };
  const [kept, setKept] = useState<PetAccess | null>(() => settledPetAccess(null, current, settled));
  const next = settledPetAccess(kept, current, settled);
  // State adjusted during render (the access only changes when it really does).
  if (next !== kept) setKept(next);
  return next;
}
