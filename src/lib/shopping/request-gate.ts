/**
 * A gate for asynchronous openings (a dialog shown after a lookup): each
 * opening takes a ticket with `begin()` and may show its result only while
 * `isCurrent(ticket)` holds. A newer opening, or `invalidate()` (the tab was
 * left, the list changed), makes every earlier ticket stale, so a slow lookup
 * never opens its dialog over a screen the member has since moved to.
 */
export type RequestGate = {
  begin: () => number;
  isCurrent: (ticket: number) => boolean;
  invalidate: () => void;
  /**
   * Records what the openings belong to (e.g. household and list); a different
   * scope makes every pending ticket stale. Returns whether it changed.
   */
  setScope: (scope: string) => boolean;
};

/**
 * Closing an opening: `current` becomes null only when it is still `target`, the
 * opening that asked. A slow submission of an earlier (unmounted) dialog that
 * finishes later never closes a newer one.
 */
export function closeIfCurrent<T>(current: T | null, target: T): T | null {
  return current === target ? null : current;
}

export function createRequestGate(): RequestGate {
  let generation = 0;
  let current: string | null = null;
  return {
    setScope: (scope) => {
      if (scope === current) return false;
      current = scope;
      generation += 1;
      return true;
    },
    begin: () => {
      generation += 1;
      return generation;
    },
    isCurrent: (ticket) => ticket === generation,
    invalidate: () => {
      generation += 1;
    },
  };
}
