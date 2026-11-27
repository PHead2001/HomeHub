/**
 * Chore rows (CH-16, CH-26): where focus goes after completing a row, and when a row
 * may skip re-rendering. Framework-free so it is unit-tested.
 */
import type { ToDoEntry } from './list';

/** The index to focus after the row at `index` leaves a list of `count`: the next row, else the one before, else none (-1). */
export function nextFocusIndex(count: number, index: number): number {
  if (index < 0 || index >= count) return -1;
  if (index + 1 < count) return index + 1;
  return index - 1;
}

/** The same chore object and the same folded missed days: the row shows the same thing. */
export function sameRowEntry(before: ToDoEntry, after: ToDoEntry): boolean {
  if (before === after) return true;
  if (before.chore !== after.chore || before.missed.length !== after.missed.length) return false;
  return before.missed.every((chore, index) => chore === after.missed[index]);
}

/**
 * A row's own done check (`CompletionCheck` with `rowCheck`). Step checkboxes in a row's
 * details are role="checkbox" buttons too, so only the marked check counts: a step of
 * the chore being completed is never the next focus target.
 */
export const ROW_CHECK = '[data-chore-id] button[data-chore-row-check]';

type CheckLike = Pick<Element, 'hasAttribute' | 'getAttribute'>;

/** The checks focus may move to: a row's own done check, enabled and not checked. */
export function focusCandidates<T extends CheckLike>(elements: readonly T[]): T[] {
  return elements.filter(el => el.hasAttribute('data-chore-row-check') && !el.hasAttribute('disabled') && el.getAttribute('aria-checked') !== 'true');
}

/**
 * The check to focus after completing `current`: the next candidate in page order, else
 * the one before. Every other copy of the same chore is left out (a chore in several
 * rooms has a row, and a check, in each room group, and they all leave together).
 */
export function pickFocusTarget<T>(candidates: readonly { item: T; choreId: string | null }[], current: T): T | null {
  const own = candidates.find(candidate => candidate.item === current);
  if (!own) return null;
  const others = candidates.filter(candidate => candidate.item === current || own.choreId === null || candidate.choreId !== own.choreId);
  const index = others.findIndex(candidate => candidate.item === current);
  return others[nextFocusIndex(others.length, index)]?.item ?? null;
}

/**
 * Called as a row's chore is being completed: once the row has left, focus moves to the
 * next open row's check in the same section (To Do), else the one before (never another
 * copy of the same chore in another room group), instead of dropping to the page body.
 */
export function focusAfterCompleting(check: HTMLElement): void {
  if (typeof document === 'undefined') return;
  const scope = check.closest('[data-chore-section]') ?? document;
  const checks = focusCandidates(Array.from(scope.querySelectorAll<HTMLElement>(ROW_CHECK)));
  const target = pickFocusTarget(checks.map(el => ({ item: el, choreId: el.closest('[data-chore-id]')?.getAttribute('data-chore-id') ?? null })), check);
  if (!target) return;
  requestAnimationFrame(() => {
    if (target.isConnected && document.activeElement !== target) target.focus();
  });
}
