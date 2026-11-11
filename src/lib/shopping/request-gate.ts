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
};

export function createRequestGate(): RequestGate {
  let generation = 0;
  return {
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
