/**
 * The household Pets care store's bookkeeping (PE-21a), framework-free so it is
 * unit tested: which pets are wanted (their readers, plus a linger after the
 * last one leaves) and each pet's latest published data. The React side is
 * `care-store.tsx`.
 */

/** How long a pet stays subscribed after its last reader unmounts (a card → pet page navigation). */
export const LINGER_MS = 30_000;

type Entry = { readers: number; timer: ReturnType<typeof setTimeout> | null };

/** The store: which pets are wanted (readers + linger) and their latest published data. */
/** The timer functions the store uses (injected in tests). */
export type StoreTimers = {
  set: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (handle: ReturnType<typeof setTimeout>) => void;
};

/**
 * The global timers, each called through a wrapper. Storing `setTimeout` itself
 * on an object and calling it as `timers.set(...)` runs it with that object as
 * its receiver, which browsers refuse ("TypeError: Illegal invocation"); that
 * threw in the release path (an effect cleanup) and took the Pets view down.
 */
export const globalTimers: StoreTimers = {
  set: (callback, ms) => globalThis.setTimeout(callback, ms),
  clear: (handle) => globalThis.clearTimeout(handle),
};

export class CareStore<T> {
  private entries = new Map<string, Entry>();
  private data = new Map<string, T>();
  private listeners = new Set<() => void>();
  private wantedListeners = new Set<() => void>();
  private wantedSnapshot: string[] = [];

  constructor(private readonly lingerMs = LINGER_MS, private readonly timers: StoreTimers = globalTimers) {}

  /** Adds a reader of `key` (household/pet); returns its release. */
  acquire(key: string): () => void {
    const entry = this.entries.get(key) ?? { readers: 0, timer: null };
    if (entry.timer) this.timers.clear(entry.timer);
    entry.timer = null;
    entry.readers += 1;
    const added = !this.entries.has(key);
    this.entries.set(key, entry);
    if (added) this.changedWanted();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.readers -= 1;
      if (entry.readers > 0) return;
      entry.timer = this.timers.set(() => {
        if (entry.readers > 0) return;
        this.entries.delete(key);
        this.data.delete(key);
        this.changedWanted();
      }, this.lingerMs);
    };
  }

  /** Keys with a subscriber (stable array between changes, for `useSyncExternalStore`). */
  wanted = (): string[] => this.wantedSnapshot;

  subscribeWanted = (listener: () => void) => {
    this.wantedListeners.add(listener);
    return () => this.wantedListeners.delete(listener);
  };

  private changedWanted() {
    this.wantedSnapshot = [...this.entries.keys()];
    for (const listener of this.wantedListeners) listener();
  }

  publish(key: string, value: T) {
    if (!this.entries.has(key)) return;
    this.data.set(key, value);
    for (const listener of this.listeners) listener();
  }

  read = (key: string): T | undefined => this.data.get(key);

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

