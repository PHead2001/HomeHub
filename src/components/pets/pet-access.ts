'use client';

import { useContext, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { settledPetAccess, type PetAccess } from '@/lib/pets/live-listener';
import { TabletContext } from '@/components/devices/tablet-context';

/**
 * The settled access every Pets listener is keyed on (`petListenerKey`): null
 * until auth and household membership have loaded (no listener starts; readers
 * show loading), then the member and their `pets.view`, kept while a later
 * membership snapshot is loading, and replaced only by a real change
 * (`settledPetAccess`). So a pet list, card, pet page or tab subscribes once,
 * and never falls back to a skeleton when permissions settle after the first
 * render, while access returning or being revoked still recreates it.
 *
 * On a registered wall tablet (the tablet shell is present) the reader is the
 * tablet itself (`device_<id>`, at its credential generation) and it may read
 * Pets while the record's Pets section is on (the device read rules): so the
 * tablet's pet sheet and board use these same Pets readers (courses with their
 * offline doses, legacy countdowns, both date shapes, pinned notes) instead of
 * readers of their own (F4b-2 review, Codex 1/3/7/9).
 */
export function useSettledPetAccess(): PetAccess | null {
  const tablet = useContext(TabletContext);
  const { currentUser, permissions, loading, householdLoading } = useAuth();
  const settled = tablet ? true : !loading && !householdLoading;
  const current: PetAccess = tablet
    ? { uid: `device_${tablet.deviceId}:${tablet.generation}`, canView: tablet.settings.sections.pets }
    : { uid: currentUser?.uid ?? null, canView: Boolean(permissions['pets.view']) };
  const [kept, setKept] = useState<PetAccess | null>(() => settledPetAccess(null, current, settled));
  const next = settledPetAccess(kept, current, settled);
  // State adjusted during render (the access only changes when it really does).
  if (next !== kept) setKept(next);
  return next;
}
