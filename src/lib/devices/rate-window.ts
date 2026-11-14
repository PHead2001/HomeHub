// In-memory rate windows for the device endpoints (docs/modules/devices/README.md):
// "at most N calls a minute per key", per server instance. Pure, so the eviction and
// the address bucketing are unit-tested. The map is bounded: keys whose window has
// emptied are deleted on a periodic sweep, and past `maxKeys` the oldest keys go first.

export const RATE_WINDOW_MS = 60_000;

export type RateWindows = Map<string, number[]>;

export type RateWindowOptions = {
  /** Sweep the whole map for emptied windows every this many calls. */
  sweepEvery: number;
  /** Hard bound on the number of keys kept (oldest inserted keys are dropped first). */
  maxKeys: number;
};

export const DEFAULT_RATE_WINDOW_OPTIONS: RateWindowOptions = { sweepEvery: 256, maxKeys: 20_000 };

const live = (entries: number[], nowMs: number) => entries.filter(at => nowMs - at < RATE_WINDOW_MS);

/** Deletes every key whose window holds no call from the last minute. */
export const sweepRateWindows = (windows: RateWindows, nowMs: number) => {
  for (const [key, entries] of windows) {
    const recent = live(entries, nowMs);
    if (recent.length === 0) windows.delete(key);
    else if (recent.length !== entries.length) windows.set(key, recent);
  }
};

const callCounts = new WeakMap<RateWindows, number>();

/** Counts one call for `key` in a 60 s window; false when `max` calls were already counted. */
export const takeRateWindowSlot = (
  windows: RateWindows,
  key: string,
  max: number,
  nowMs: number,
  options: RateWindowOptions = DEFAULT_RATE_WINDOW_OPTIONS,
): boolean => {
  const calls = (callCounts.get(windows) ?? 0) + 1;
  callCounts.set(windows, calls);
  if (calls % options.sweepEvery === 0) sweepRateWindows(windows, nowMs);
  const recent = live(windows.get(key) ?? [], nowMs);
  if (recent.length >= max) {
    windows.set(key, recent);
    return false;
  }
  recent.push(nowMs);
  // Re-inserted at the end, so the first keys in the map are the least recently used.
  windows.delete(key);
  windows.set(key, recent);
  while (windows.size > options.maxKeys) {
    const oldest = windows.keys().next().value;
    if (oldest === undefined) break;
    windows.delete(oldest);
  }
  return true;
};

/**
 * The rate-limit bucket of a client address: an IPv4 address as is, an IPv6 address by its
 * /64 prefix (one subscriber usually holds a whole /64), an IPv4-mapped IPv6 address as its
 * IPv4 address. Anything else (the `unknown` bucket) is returned unchanged.
 */
export const addressBucket = (address: string): string => {
  const value = address.trim().toLowerCase();
  if (!value.includes(':')) return value;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return mapped[1];
  const hex = value.includes('.') ? value.slice(0, value.lastIndexOf(':')) + ':0:0' : value;
  const [head, tail] = hex.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = tail !== undefined ? Math.max(0, 8 - left.length - right.length) : 0;
  const groups = [...left, ...Array(missing).fill('0'), ...right].slice(0, 8);
  const prefix = groups.slice(0, 4).map(g => (g || '0').replace(/^0+(?=.)/, ''));
  while (prefix.length < 4) prefix.push('0');
  return `${prefix.join(':')}::/64`;
};
