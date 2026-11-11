/**
 * Per-device memory of the Grocery list the pantry (and its recipe card) last
 * added to (SH-6). A convenience only: storage may be blocked, and then the
 * household's default Grocery list is preselected.
 */
const recentListKey = (householdId: string) => `homehub.pantry.recentList.${householdId}`;

export const readRecentList = (householdId: string): string | null => {
  try {
    return window.localStorage.getItem(recentListKey(householdId));
  } catch {
    return null;
  }
};

export const rememberRecentList = (householdId: string, listId: string) => {
  try {
    window.localStorage.setItem(recentListKey(householdId), listId);
  } catch {
    // Storage blocked: the default list is preselected next time.
  }
};
