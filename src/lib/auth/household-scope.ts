/**
 * Household-scoped data kept on this device outside the screens (SL-3). When this
 * device stops showing a household (access ended, the person left, switched to
 * another household, or signed out), `AuthProvider` calls `forgetHouseholdOnDevice`:
 * the persisted copies are removed here and modules holding in-memory copies are
 * told through `onHouseholdForgotten`, so nothing of that household is shown or
 * written afterwards. Screens themselves are remounted (see `HouseholdManager`).
 */
import { clearHouseSnapshot, deviceStorage } from '@/lib/dashboard/house-snapshot';
import { browserJournalStorage, clearJournal, forgetHouseholdJournal } from '@/lib/shopping/undo';
import { LOCAL_TICKS_KEY, RECENT_GROCERY_KEY } from '@/lib/shopping/overview';

export const HOUSEHOLD_FORGOTTEN_EVENT = 'homehub:household-forgotten';

/** `householdId` null: every household (sign-out). */
export type HouseholdForgottenDetail = { householdId: string | null };

/**
 * Per-household keys of the form `<prefix><householdId>` (`src/lib/shopping/recent-list.ts`:
 * the Grocery list the pantry and its recipe card last added to).
 */
export const HOUSEHOLD_KEY_PREFIXES = ['homehub.pantry.recentList.'] as const;

/**
 * Device keys that hold one JSON object for every household, with entries keyed by
 * the household id (`<householdId>`) or by `<householdId>/<listId>`: Shopping's
 * last-used Grocery list (`RECENT_GROCERY_KEY`) and this device's own recent ticks
 * (`LOCAL_TICKS_KEY`, entries of `{ opId, at, ackAt, itemId? }` ticks), both in
 * `src/lib/shopping/overview.ts`. A forgotten household's entries go whole, pending
 * ticks included: this device no longer shows its lists.
 */
export const HOUSEHOLD_MAP_KEYS = [RECENT_GROCERY_KEY, LOCAL_TICKS_KEY] as const;

type KeyStorage = Pick<Storage, 'removeItem' | 'key' | 'length'> & Partial<Pick<Storage, 'getItem' | 'setItem'>>;

/** Whether a map entry's key belongs to `householdId` (`<householdId>` or `<householdId>/...`). */
export const mapEntryOfHousehold = (entryKey: string, householdId: string): boolean =>
  entryKey === householdId || entryKey.startsWith(`${householdId}/`);

/**
 * Removes `householdId`'s entries from each of `HOUSEHOLD_MAP_KEYS` (null: the whole
 * keys, at sign-out). A key that is unreadable or not a JSON object is removed; a map
 * left empty is removed. Never throws.
 */
export function forgetHouseholdMapEntries(storage: KeyStorage | null, householdId: string | null): void {
  if (!storage) return;
  for (const key of HOUSEHOLD_MAP_KEYS) {
    try {
      if (householdId === null || !storage.getItem || !storage.setItem) {
        storage.removeItem(key);
        continue;
      }
      const raw = storage.getItem(key);
      if (raw === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        storage.removeItem(key);
        continue;
      }
      const map = parsed as Record<string, unknown>;
      const kept = Object.fromEntries(Object.entries(map).filter(([entryKey]) => !mapEntryOfHousehold(entryKey, householdId)));
      if (Object.keys(kept).length === Object.keys(map).length) continue;
      if (Object.keys(kept).length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(kept));
    } catch {
      // Storage blocked: nothing was saved either.
    }
  }
}

const browserKeyStorage = (): KeyStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Removes the per-household keys of `householdId` (null: of every household); never throws. */
export function forgetHouseholdKeys(storage: KeyStorage | null, householdId: string | null): void {
  if (!storage) return;
  try {
    if (householdId !== null) {
      for (const prefix of HOUSEHOLD_KEY_PREFIXES) storage.removeItem(`${prefix}${householdId}`);
      return;
    }
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && HOUSEHOLD_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // Storage blocked: nothing was saved either.
  }
}

/**
 * Removes what this device keeps for `householdId` (null: for every household):
 * the dashboard's last-known house, the shopping Undo journal entries, the per-household
 * keys and map entries above, and, through the event, in-memory memories such as the shopping category memory.
 */
export function forgetHouseholdOnDevice(householdId: string | null, now: number = Date.now()): void {
  // The house snapshot holds one household at a time; it is never shown for another.
  clearHouseSnapshot(deviceStorage());
  forgetHouseholdKeys(browserKeyStorage(), householdId);
  forgetHouseholdMapEntries(browserKeyStorage(), householdId);
  const journal = browserJournalStorage();
  if (householdId === null) clearJournal(journal);
  else forgetHouseholdJournal(journal, householdId, now);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<HouseholdForgottenDetail>(HOUSEHOLD_FORGOTTEN_EVENT, { detail: { householdId } }));
  }
}

/** Runs `handler` whenever a household's data must be forgotten (`null`: all of them). Returns the unsubscribe. */
export function onHouseholdForgotten(handler: (householdId: string | null) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event) => handler((event as CustomEvent<HouseholdForgottenDetail>).detail?.householdId ?? null);
  window.addEventListener(HOUSEHOLD_FORGOTTEN_EVENT, listener);
  return () => window.removeEventListener(HOUSEHOLD_FORGOTTEN_EVENT, listener);
}
