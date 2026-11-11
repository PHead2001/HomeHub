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

export const HOUSEHOLD_FORGOTTEN_EVENT = 'homehub:household-forgotten';

/** `householdId` null: every household (sign-out). */
export type HouseholdForgottenDetail = { householdId: string | null };

/**
 * Per-household keys of the form `<prefix><householdId>` (`pantry-inventory-client.tsx`
 * remembers the last list an item was sent to).
 */
export const HOUSEHOLD_KEY_PREFIXES = ['homehub.pantry.recentList.'] as const;

type KeyStorage = Pick<Storage, 'removeItem' | 'key' | 'length'>;

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
 * keys above, and, through the event, in-memory memories such as the shopping category memory.
 */
export function forgetHouseholdOnDevice(householdId: string | null, now: number = Date.now()): void {
  // The house snapshot holds one household at a time; it is never shown for another.
  clearHouseSnapshot(deviceStorage());
  forgetHouseholdKeys(browserKeyStorage(), householdId);
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
