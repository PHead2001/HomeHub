/**
 * Photo deletes that wait out a delete's Undo window (BL-4). The registry lives
 * at module level (not in a page component), so leaving the library page while
 * the global Undo toast is still up neither deletes the photo early nor loses the
 * delete: the timer completes it, and the Undo cancels it first. Pure apart from
 * the injected timer and remover; unit tested in tests/unit/barcode-library.test.ts.
 */

export type Scheduler = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export type PendingPhotoDeletes = {
  /** Deletes `path` after `windowMs` unless `cancel(key)` comes first. Replaces an earlier entry for `key`. */
  schedule: (key: string, path: string) => void;
  /**
   * Stops the pending delete for `key`. Returns its path when the photo is still
   * there (the Undo may keep pointing at it), or null when it is already gone or
   * was never scheduled for this key.
   */
  cancel: (key: string) => string | null;
  /** Deletes now (e.g. an Undo that could not restore the product). */
  removeNow: (path: string) => void;
  pending: (key: string) => boolean;
};

export function createPendingPhotoDeletes({
  windowMs,
  remove,
  scheduler = { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
}: {
  windowMs: number;
  remove: (path: string) => void;
  scheduler?: Scheduler;
}): PendingPhotoDeletes {
  const entries = new Map<string, { handle: unknown; path: string }>();
  return {
    schedule(key, path) {
      const previous = entries.get(key);
      if (previous) {
        scheduler.clear(previous.handle);
        if (previous.path !== path) remove(previous.path);
      }
      const handle = scheduler.set(() => {
        entries.delete(key);
        remove(path);
      }, windowMs);
      entries.set(key, { handle, path });
    },
    cancel(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      scheduler.clear(entry.handle);
      entries.delete(key);
      return entry.path;
    },
    removeNow(path) {
      remove(path);
    },
    pending: (key) => entries.has(key),
  };
}
