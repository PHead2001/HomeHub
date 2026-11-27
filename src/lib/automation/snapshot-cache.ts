// AU-10: one Home Assistant read per household per window, shared by every screen
// (personal pages, the dashboard card, several tablets). Pure and clock-injected:
// tests/unit/automation-snapshot-cache.test.ts. The server keeps one instance
// (src/lib/server/home-assistant-snapshot.ts).

export const SNAPSHOT_TTL_MS = 15_000;

type Entry<T> = { version: string; at: number; promise: Promise<T>; settled: boolean };

export type CachedValue<T> = { value: T; fetchedAt: number; fresh: boolean };

/**
 * Caches the last answer (or failure) per key for `ttlMs`, keyed also by a version
 * (the credentials' save time, so a new token or address never serves the old answer).
 * Concurrent callers share one in-flight load. A failure is cached too: a failing Home
 * Assistant is not asked again by every poll.
 */
export class SnapshotCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs = SNAPSHOT_TTL_MS, private readonly clock: () => number = () => Date.now(), private readonly maxKeys = 500) {}

  async get(key: string, version: string, load: () => Promise<T>): Promise<CachedValue<T>> {
    const now = this.clock();
    const current = this.entries.get(key);
    if (current && current.version === version && (!current.settled || now - current.at < this.ttlMs)) {
      return { value: await current.promise, fetchedAt: current.at, fresh: false };
    }
    const entry: Entry<T> = { version, at: now, promise: Promise.resolve().then(load), settled: false };
    if (!this.entries.has(key) && this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
    entry.promise.then(() => { entry.settled = true; }, () => { entry.settled = true; });
    return { value: await entry.promise, fetchedAt: entry.at, fresh: true };
  }

  /** Forget a key (after a control, so the next read shows the change). */
  invalidate(key: string) {
    this.entries.delete(key);
  }
}
