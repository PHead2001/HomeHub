/**
 * Shell "busy" state: whether reloading the page right now could lose
 * something the member cares about. Anything that must not be interrupted by an
 * automatic reload holds a busy mark while it lasts:
 *
 * - a save in flight (`whileBusy('save', promise)`),
 * - an open toast with an action such as Undo (the toast store marks these),
 * - a form with unsaved input (`useUnsavedInput(dirty)`).
 *
 * The shell reads `isShellBusy()` before any automatic recovery (the crash
 * guard in the error boundaries) and holds back the "HomeHub updated" prompt
 * until the member is idle. Nothing here ever reloads; it only answers.
 *
 * Plain module state (no React, no storage): it lives as long as the page.
 */

export type BusyReason = 'save' | 'undo' | 'unsaved-input' | (string & {});

type Listener = (busy: boolean) => void;

let nextId = 1;
const marks = new Map<number, BusyReason>();
const listeners = new Set<Listener>();

function emit() {
  const busy = marks.size > 0;
  // A snapshot: a listener that subscribes during this dispatch is first told on the next one.
  [...listeners].forEach((listener) => listener(busy));
}

/**
 * Marks the shell busy for `reason` and returns the release function. Release is
 * idempotent: calling it twice frees only this mark.
 */
export function markBusy(reason: BusyReason): () => void {
  const id = nextId++;
  const wasBusy = marks.size > 0;
  marks.set(id, reason);
  if (!wasBusy) emit();
  return () => {
    if (!marks.delete(id)) return;
    if (marks.size === 0) emit();
  };
}

/** True while anything holds a busy mark. */
export function isShellBusy(): boolean {
  return marks.size > 0;
}

/** The reasons currently held (one entry per mark), for diagnostics and tests. */
export function shellBusyReasons(): BusyReason[] {
  return [...marks.values()];
}

/** Calls `listener` whenever the shell turns busy or idle. Returns the unsubscribe. */
export function subscribeShellBusy(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Holds a busy mark for `reason` until `work` settles, then releases it either way. */
export async function whileBusy<T>(reason: BusyReason, work: Promise<T> | (() => Promise<T>)): Promise<T> {
  const release = markBusy(reason);
  try {
    return await (typeof work === 'function' ? work() : work);
  } finally {
    release();
  }
}

/** Test helper: drops every mark (listeners are told the shell is idle). */
export function resetShellBusyForTests(): void {
  const wasBusy = marks.size > 0;
  marks.clear();
  if (wasBusy) emit();
}
