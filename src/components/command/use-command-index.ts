'use client';

/**
 * What the command palette can search, loaded once each time the palette opens
 * (read-only, only sections the member can view). Also supplies the members,
 * pets and lists the quick-add parser resolves names against.
 */
import { useEffect, useState } from 'react';
import { collection, query, where, type DocumentData, type QuerySnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { getDocsOfflineAware } from '@/lib/firestore-offline';
import { useAuth } from '@/hooks/use-auth';
import type { QuickAddList, QuickAddMember, QuickAddPet } from '@/lib/dashboard/quick-add';
import { shoppingListHref } from '@/lib/dashboard/links';
import { feedingPlan } from '@/lib/pets/care';
import type { PetProfile } from '@/lib/pets/types';

export type IndexEntry = { id: string; label: string; detail?: string; href: string; group: 'Chores' | 'Shopping' | 'Pets' | 'Maintenance' };

export type CommandIndex = {
  entries: IndexEntry[];
  members: QuickAddMember[];
  pets: QuickAddPet[];
  lists: QuickAddList[];
  loading: boolean;
};

const EMPTY: CommandIndex = { entries: [], members: [], pets: [], lists: [], loading: false };
const str = (value: unknown, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const rows = (snapshot: QuerySnapshot<DocumentData>) => snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }));

export function useCommandIndex(open: boolean): CommandIndex {
  const { currentUser, currentMember, permissions } = useAuth();
  const householdId = currentUser?.householdId ?? null;
  const [index, setIndex] = useState<CommandIndex>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const approved = Boolean(currentMember && currentMember.role !== 'newuser');

  useEffect(() => {
    if (!open || !householdId || !approved) return;
    let cancelled = false;
    const base = (...path: string[]) => collection(db, 'households', householdId, ...path);
    const safe = <T,>(promise: Promise<T>) => promise.catch(() => null);

    (async () => {
      const [members, lists, pets, chores, assets, vehicles] = await Promise.all([
        safe(getDocsOfflineAware(base('members'))),
        permissions['shopping.view'] ? safe(getDocsOfflineAware(base('shopping-lists'))) : null,
        permissions['pets.view'] ? safe(getDocsOfflineAware(base('pets'))) : null,
        permissions['chores.view'] ? safe(getDocsOfflineAware(query(base('chores'), where('isCompleted', '==', false)))) : null,
        permissions['maintenance.view'] ? safe(getDocsOfflineAware(base('home-assets'))) : null,
        permissions['maintenance.view'] ? safe(getDocsOfflineAware(base('vehicles'))) : null,
      ]);
      const listRows = lists ? rows(lists) : [];
      const items = permissions['shopping.view']
        ? (await Promise.all(listRows.map(async (list) => {
            const snapshot = await safe(getDocsOfflineAware(query(base('shopping-lists', list.id, 'items'), where('status', '==', 'needed'))));
            return snapshot ? rows(snapshot).map((item) => ({ item, list })) : [];
          }))).flat()
        : [];
      if (cancelled) return;

      const entries: IndexEntry[] = [
        ...(chores ? rows(chores).map((chore) => ({
          id: `chore-${chore.id}`,
          label: str(chore.task, 'Chore'),
          detail: str(chore.assignedToDisplayName) || undefined,
          href: '/chores',
          group: 'Chores' as const,
        })) : []),
        // Shopping's own URL scheme (`?list=<id>`), so a result opens the list that holds it.
        ...listRows.map((list) => ({ id: `list-${list.id}`, label: str(list.name, 'Shopping list'), detail: 'List', href: shoppingListHref(list.id), group: 'Shopping' as const })),
        ...items.map(({ item, list }) => ({ id: `item-${list.id}-${item.id}`, label: str(item.name, 'Item'), detail: str(list.name), href: shoppingListHref(list.id), group: 'Shopping' as const })),
        ...(pets ? rows(pets).map((pet) => ({ id: `pet-${pet.id}`, label: str(pet.name, 'Pet'), detail: str(pet.type) || undefined, href: `/pets/${encodeURIComponent(pet.id)}`, group: 'Pets' as const })) : []),
        ...(assets ? rows(assets).map((asset) => ({ id: `asset-${asset.id}`, label: str(asset.name, 'Home asset'), detail: str(asset.location) || 'Home asset', href: `/maintenance?asset=${encodeURIComponent(asset.id)}`, group: 'Maintenance' as const })) : []),
        ...(vehicles ? rows(vehicles).map((vehicle) => ({ id: `vehicle-${vehicle.id}`, label: str(vehicle.nickname, 'Vehicle'), detail: 'Vehicle', href: `/maintenance?vehicle=${encodeURIComponent(vehicle.id)}`, group: 'Maintenance' as const })) : []),
      ];

      setIndex({
        entries,
        members: members
          ? rows(members)
              .filter((member) => member.role !== 'newuser' && (member.status ?? 'active') === 'active' && typeof member.email === 'string')
              .map((member) => ({ uid: str(member.uid, member.id), email: member.email as string, name: str(member.displayName, member.email as string) }))
          : [],
        pets: pets ? rows(pets).map((pet) => {
          const plan = feedingPlan(pet as unknown as PetProfile);
          return { id: pet.id, name: str(pet.name, 'Pet'), portion: { amount: plan.amount, unit: plan.unit } };
        }) : [],
        lists: listRows.map((list) => ({ id: list.id, name: str(list.name, 'Shopping list'), type: str(list.type) || undefined })),
        loading: false,
      });
      setLoaded(true);
    })().catch(() => {
      if (!cancelled) setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [open, householdId, approved, permissions]);

  return { ...index, loading: open && !loaded };
}

/** Case-insensitive match score: 0 none, higher is better. */
export function matchScore(label: string, search: string): number {
  const haystack = label.toLowerCase();
  const needle = search.trim().toLowerCase();
  if (!needle) return 0;
  if (haystack === needle) return 4;
  if (haystack.startsWith(needle)) return 3;
  if (haystack.split(/\s+/).some((word) => word.startsWith(needle))) return 2;
  return haystack.includes(needle) ? 1 : 0;
}
