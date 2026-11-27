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

/** A row's completion check (`CompletionCheck` renders it as a button with role checkbox). */
const CHECK = '[data-chore-id] button[role="checkbox"]:not([disabled])';

/**
 * Called as a row's chore is being completed: once the row has left, focus moves to the
 * next open row's check in the same section (To Do), else the one before, instead of
 * dropping to the page body.
 */
export function focusAfterCompleting(check: HTMLElement): void {
  if (typeof document === 'undefined') return;
  const scope = check.closest('[data-chore-section]') ?? document;
  const checks = Array.from(scope.querySelectorAll<HTMLElement>(CHECK)).filter(el => el.getAttribute('aria-checked') !== 'true');
  const target = checks[nextFocusIndex(checks.length, checks.indexOf(check))];
  if (!target) return;
  requestAnimationFrame(() => {
    if (target.isConnected && document.activeElement !== target) target.focus();
  });
}
