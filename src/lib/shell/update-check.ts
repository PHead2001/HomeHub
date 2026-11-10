/**
 * "HomeHub updated" detection (SL-2).
 *
 * Every production build gets a build id (`NEXT_PUBLIC_HOMEHUB_BUILD_ID`, set in
 * next.config.ts): a fixed-width UTC timestamp, so a later build sorts after an
 * earlier one. The page knows the id it was built with; the service worker
 * (`/api/sw`) embeds the same id, so every deploy ships a byte-different worker
 * that the browser installs (skipWaiting + clients.claim already activate it at
 * once). The page asks the active worker for its id, and the worker announces it
 * on activation. A newer worker id means a new build is live: the page shows a
 * non-blocking toast with a Reload action. Nothing reloads on its own.
 */

/** Page -> worker: "which build are you?" */
export const BUILD_QUERY_MESSAGE = 'homehub:build-query';
/** Worker -> page: `{ type, buildId }`, sent in reply and on activation. */
export const BUILD_MESSAGE = 'homehub:build';

/** Background `registration.update()` interval while a page stays open. */
export const UPDATE_CHECK_INTERVAL_MS = 45 * 60 * 1000;
/** A tab coming back to the foreground checks again only if the last check is this old. */
export const VISIBLE_RECHECK_MIN_MS = 5 * 60 * 1000;

/** sessionStorage: the newest build this tab already offered (never offered twice). */
export const UPDATE_PROMPTED_KEY = 'homehub.shell.update-prompted';

const BUILD_ID_PATTERN = /^\d{8}T\d{9}Z$/;

/** Formats a build id (`20261109T153012345Z`). */
export function formatBuildId(date: Date): string {
  return date.toISOString().replace(/-|:|\./g, '');
}

export function isBuildId(value: unknown): value is string {
  return typeof value === 'string' && BUILD_ID_PATTERN.test(value);
}

/** Reads a worker message; anything that is not a build announcement is null. */
export function buildIdFromMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const { type, buildId } = data as { type?: unknown; buildId?: unknown };
  return type === BUILD_MESSAGE && isBuildId(buildId) ? buildId : null;
}

export type UpdatePromptDecision = 'prompt' | 'wait' | 'none';

/**
 * Whether to offer "HomeHub updated" now.
 * - `none` unless the worker runs a strictly newer build than this page (an
 *   older worker, e.g. this page loaded before the new worker activated, is not
 *   an update), or when this tab already offered that build or a newer one.
 * - `wait` while the shell is busy (a save, an Undo toast, unsaved input): the
 *   prompt waits for idle so it never crowds out an Undo.
 */
export function decideUpdatePrompt(input: {
  pageBuildId: string | null | undefined;
  workerBuildId: string | null | undefined;
  promptedBuildId: string | null | undefined;
  busy: boolean;
}): UpdatePromptDecision {
  const { pageBuildId, workerBuildId, promptedBuildId, busy } = input;
  if (!isBuildId(pageBuildId) || !isBuildId(workerBuildId)) return 'none';
  if (workerBuildId <= pageBuildId) return 'none';
  if (isBuildId(promptedBuildId) && promptedBuildId >= workerBuildId) return 'none';
  return busy ? 'wait' : 'prompt';
}

/** Whether a tab returning to the foreground should check for a new worker now. */
export function shouldCheckOnVisible(lastCheckAt: number, now: number, minGapMs = VISIBLE_RECHECK_MIN_MS): boolean {
  return now - lastCheckAt >= minGapMs;
}
