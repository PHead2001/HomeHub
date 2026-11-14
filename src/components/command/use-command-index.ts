'use client';

/**
 * What the command palette can search, loaded once each time the palette opens
 * (read-only, only sections the member can view). Also supplies the members,
 * pets, lists, rooms, vehicles and assets the quick-add parser resolves names
 * against.
 */
import { useCallback, useEffect, useState } from 'react';
import { collection, query, where, type DocumentData, type QuerySnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { getDocsOfflineAware } from '@/lib/firestore-offline';
import { useAuth } from '@/hooks/use-auth';
import type { QuickAddAsset, QuickAddList, QuickAddMember, QuickAddPet, QuickAddRoom, QuickAddVehicle } from '@/lib/dashboard/quick-add';
import { INDEX_SECTIONS, sectionUnreadable, type IndexSection } from '@/lib/dashboard/quick-add-preview';
import { shoppingListHref } from '@/lib/dashboard/links';
import { feedingPlan } from '@/lib/pets/care';
import type { PetProfile } from '@/lib/pets/types';
import { publicDisplayName } from '@/lib/member-directory';

export type IndexEntry = { id: string; label: string; detail?: string; href: string; group: 'Chores' | 'Shopping' | 'Pets' | 'Maintenance' };

export type CommandIndex = {
  entries: IndexEntry[];
  members: QuickAddMember[];
  pets: QuickAddPet[];
  lists: QuickAddList[];
  rooms: QuickAddRoom[];
  /** Active vehicles (retired and sold ones are left out, as in Maintenance's reminders). */
  vehicles: QuickAddVehicle[];
  /** Home assets that are not retired. */
  assets: QuickAddAsset[];
  /**
   * Sections the member may view whose read failed. Kept apart from "loaded and
   * empty", so a preview never treats "no vehicles" as "none could be read".
   */
  failed: IndexSection[];
  loading: boolean;
  /** Reads the index again (after a failure). */
  retry: () => void;
};

const EMPTY: Omit<CommandIndex, 'retry'> = { entries: [], members: [], pets: [], lists: [], rooms: [], vehicles: [], assets: [], failed: [], loading: false };
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const str = (value: unknown, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
const rows = (snapshot: QuerySnapshot<DocumentData>) => snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown> & { id: string }));

export function useCommandIndex(open: boolean): CommandIndex {
  const { currentUser, currentMember, permissions } = useAuth();
  const householdId = currentUser?.householdId ?? null;
  const [index, setIndex] = useState<Omit<CommandIndex, 'retry'>>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const approved = Boolean(currentMember && currentMember.role !== 'newuser');

  useEffect(() => {
    if (!open || !householdId || !approved) return;
    let cancelled = false;
    const base = (...path: string[]) => collection(db, 'households', householdId, ...path);
    const safe = <T,>(promise: Promise<T>) => promise.catch(() => null);

    (async () => {
      const [members, lists, pets, chores, assets, vehicles, rooms] = await Promise.all([
        safe(getDocsOfflineAware(base('members'))),
        permissions['shopping.view'] ? safe(getDocsOfflineAware(base('shopping-lists'))) : null,
        permissions['pets.view'] ? safe(getDocsOfflineAware(base('pets'))) : null,
        permissions['chores.view'] ? safe(getDocsOfflineAware(query(base('chores'), where('isCompleted', '==', false)))) : null,
        permissions['maintenance.view'] ? safe(getDocsOfflineAware(base('home-assets'))) : null,
        permissions['maintenance.view'] ? safe(getDocsOfflineAware(base('vehicles'))) : null,
        permissions['chores.view'] ? safe(getDocsOfflineAware(base('rooms'))) : null,
      ]);
      // A section that was asked for and failed, or came back empty from the offline
      // cache (which cannot prove there are none), is unknown, never "empty".
      const requested: Record<IndexSection, boolean> = {
        members: true,
        lists: Boolean(permissions['shopping.view']),
        pets: Boolean(permissions['pets.view']),
        rooms: Boolean(permissions['chores.view']),
        vehicles: Boolean(permissions['maintenance.view']),
        assets: Boolean(permissions['maintenance.view']),
      };
      const results: Record<IndexSection, QuerySnapshot<DocumentData> | null> = { members, lists, pets, rooms, vehicles, assets };
      const failed = INDEX_SECTIONS.filter((section) => requested[section] && sectionUnreadable(results[section]));
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
              // Public member data (src/lib/member-directory.ts): the name is never an email.
              // The record's email, while it has one, only matches "for sam" locally.
              // Quick add assigns chores to these people: kid profiles are not assignees yet (HO-15d).
              .filter((member) => member.role !== 'newuser' && (member.status ?? 'active') === 'active' && member.kind !== 'identity')
              .map((member) => ({
                uid: str(member.uid, member.id),
                ...(typeof member.email === 'string' && member.email ? { email: member.email } : {}),
                name: publicDisplayName(member.displayName),
              }))
          : [],
        pets: pets ? rows(pets).map((pet) => {
          const plan = feedingPlan(pet as unknown as PetProfile);
          return { id: pet.id, name: str(pet.name, 'Pet'), portion: { amount: plan.amount, unit: plan.unit } };
        }) : [],
        lists: listRows.map((list) => ({ id: list.id, name: str(list.name, 'Shopping list'), type: str(list.type) || undefined })),
        rooms: rooms ? rows(rooms).map((room) => ({ id: room.id, name: str(room.name, 'Room') })) : [],
        vehicles: vehicles
          ? rows(vehicles)
              .filter((vehicle) => vehicle.status !== 'retired' && vehicle.status !== 'sold')
              .map((vehicle) => ({
                id: vehicle.id,
                name: str(vehicle.nickname, 'Vehicle'),
                make: str(vehicle.make) || undefined,
                model: str(vehicle.model) || undefined,
                currentMileage: num(vehicle.currentMileage),
              }))
          : [],
        assets: assets
          ? rows(assets).filter((asset) => asset.status !== 'retired').map((asset) => ({ id: asset.id, name: str(asset.name, 'Home asset') }))
          : [],
        failed,
        loading: false,
      });
      setLoaded(true);
    })().catch(() => {
      if (cancelled) return;
      // Nothing could be read: every section counts as failed, never as empty.
      setIndex({ ...EMPTY, failed: [...INDEX_SECTIONS] });
      setLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [open, householdId, approved, permissions, attempt]);

  const retry = useCallback(() => {
    setLoaded(false);
    setIndex(EMPTY);
    setAttempt((value) => value + 1);
  }, []);

  return { ...index, loading: open && !loaded, retry };
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
