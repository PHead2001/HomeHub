/**
 * Crash-loop guard for the error boundaries (`src/app/error.tsx`,
 * `src/app/global-error.tsx`).
 *
 * The only automatic recovery HomeHub makes is one reload when a crash is a
 * stale-build chunk failure (a new deploy removed the scripts this tab was
 * using), which a reload fixes. It never fires while the shell is busy (a save,
 * an open Undo, unsaved input), offline, or for any other kind of error, and it
 * stops after repeated crashes: the second crash within ten minutes (tracked in
 * sessionStorage, so per tab) shows a plain error with the time and a manual
 * retry instead. Personal accounts therefore never see a reload loop.
 */

export const CRASH_HISTORY_KEY = 'homehub.shell.crashes';
/** Crashes inside this window count together. */
export const CRASH_WINDOW_MS = 10 * 60 * 1000;
/** At this many crashes inside the window, automatic recovery stops. */
export const CRASH_LIMIT = 2;

export type CrashRecovery =
  | { action: 'auto-reload' }
  | { action: 'manual'; reason: 'not-recoverable' | 'busy' | 'offline' | 'repeated' | 'no-history' };

/** Reads a stored crash history; anything malformed is an empty history. */
export function parseCrashHistory(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((at): at is number => typeof at === 'number' && Number.isFinite(at)) : [];
  } catch {
    return [];
  }
}

/** Adds a crash at `now` and keeps only the crashes inside the window (oldest first). */
export function recordCrash(history: readonly number[], now: number, windowMs = CRASH_WINDOW_MS): number[] {
  return [...history.filter((at) => at <= now && now - at < windowMs), now].sort((a, b) => a - b);
}

/**
 * Whether a thrown value is a stale-build chunk failure: the browser could not
 * load a script or module this page asked for (typically after a deploy).
 */
export function isStaleBuildError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  if (typeof message !== 'string') return false;
  return /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(message);
}

/**
 * What to do about a crash. `history` already includes this crash
 * (`recordCrash`). Repeated crashes win over everything else, so the page can
 * say "this keeps happening". Without a stored history (`persisted` false, e.g.
 * storage blocked) a reload could not be counted, so it never auto-reloads.
 */
export function decideCrashRecovery(input: {
  history: readonly number[];
  now: number;
  busy: boolean;
  online: boolean;
  recoverable: boolean;
  persisted: boolean;
  windowMs?: number;
  limit?: number;
}): CrashRecovery {
  const { history, now, busy, online, recoverable, persisted, windowMs = CRASH_WINDOW_MS, limit = CRASH_LIMIT } = input;
  const recent = history.filter((at) => at <= now && now - at < windowMs).length;
  if (recent >= limit) return { action: 'manual', reason: 'repeated' };
  if (!recoverable) return { action: 'manual', reason: 'not-recoverable' };
  if (busy) return { action: 'manual', reason: 'busy' };
  if (!online) return { action: 'manual', reason: 'offline' };
  if (!persisted) return { action: 'manual', reason: 'no-history' };
  return { action: 'auto-reload' };
}

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Records a crash in the tab's sessionStorage and returns the updated history.
 * `persisted` is false when storage is missing or blocked: the crash could not
 * be counted across a reload, so the caller must not reload on its own.
 */
export function storeCrash(storage: SessionStore | null, now: number): { history: number[]; persisted: boolean } {
  let history: number[] = [];
  try {
    history = parseCrashHistory(storage?.getItem(CRASH_HISTORY_KEY));
  } catch {
    history = [];
  }
  const next = recordCrash(history, now);
  if (!storage) return { history: next, persisted: false };
  try {
    storage.setItem(CRASH_HISTORY_KEY, JSON.stringify(next));
    return { history: next, persisted: storage.getItem(CRASH_HISTORY_KEY) === JSON.stringify(next) };
  } catch {
    return { history: next, persisted: false };
  }
}
