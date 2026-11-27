// AU-1: /automation and the dashboard's Home status refresh themselves while the page is
// visible. The server serves every caller from one cached read (AU-10), so a poll costs
// Home Assistant at most one request per household every 15 s. Pure: tests/unit.

/** How often a visible page asks again. */
export const POLL_INTERVAL_MS = 30_000;
/** The dashboard card asks less often. */
export const STATUS_POLL_INTERVAL_MS = 60_000;

/** "Updated just now", "Updated 12 s ago", "Updated 3 min ago" (AU-1). */
export function updatedLabel(fetchedAt: number | null, now: number): string | null {
  if (fetchedAt === null || !Number.isFinite(fetchedAt)) return null;
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  return `Updated ${Math.floor(minutes / 60)} h ago`;
}

/** A poll is due when the page is visible, nothing is in flight, and the interval has passed. */
export function pollDue(input: { visible: boolean; inFlight: boolean; lastAttempt: number | null; now: number; interval?: number }): boolean {
  if (!input.visible || input.inFlight) return false;
  if (input.lastAttempt === null) return true;
  return input.now - input.lastAttempt >= (input.interval ?? POLL_INTERVAL_MS);
}
