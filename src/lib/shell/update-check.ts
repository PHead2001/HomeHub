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

/**
 * Minimum supported build (member privacy release C). The server publishes it
 * through the service worker (`/api/sw` embeds it and sends it with every build
 * message); a page built before it must reload before it keeps writing, because
 * it may still write data in a shape newer releases no longer read. Release A
 * (#120, the first build that writes chore assignees by uid) merged at
 * 2026-11-10T20:34:02Z, so every build stamped before then predates it. Raise it
 * in the release that needs every open tab on a newer build; the
 * `HOMEHUB_MINIMUM_BUILD_ID` environment variable (read when the worker route is
 * built or served) can only raise it further.
 *
 * Only pages that contain this check (release C and later) honour it: a page
 * from an older build ignores the field and keeps its "HomeHub updated" prompt.
 */
export const MINIMUM_SUPPORTED_BUILD_ID = '20261110T203402000Z';

/** The minimum build the worker publishes: the code's floor, or a later valid override. */
export function minimumBuildId(override?: string | null): string {
  return isBuildId(override) && override > MINIMUM_SUPPORTED_BUILD_ID ? override : MINIMUM_SUPPORTED_BUILD_ID;
}

/** Reads a worker build message with its published minimum (null when absent or malformed). */
export function buildInfoFromMessage(data: unknown): { buildId: string; minimumBuildId: string | null } | null {
  const buildId = buildIdFromMessage(data);
  if (!buildId) return null;
  const { minimumBuildId: minimum } = data as { minimumBuildId?: unknown };
  return { buildId, minimumBuildId: isBuildId(minimum) ? minimum : null };
}

/**
 * Whether this page is older than the published minimum build. Never a reason to
 * reload by itself: most forms keep their drafts only in component state and do
 * not mark the shell busy, so an automatic reload could discard what the member
 * is typing. The page shows a persistent "HomeHub needs to update" banner with a
 * Reload button instead, and the member reloads when they are done.
 */
export function isBelowMinimumBuild(pageBuildId: string | null | undefined, minimum: string | null | undefined): boolean {
  return isBuildId(pageBuildId) && isBuildId(minimum) && pageBuildId < minimum;
}

/** sessionStorage: the build a wall tablet already reloaded for (never twice for one build). */
export const TABLET_RELOADED_KEY = 'homehub.shell.tablet-reloaded';

export type TabletReloadDecision = 'reload' | 'wait' | 'none';

/**
 * Registered wall tablets only (WT-14l, HP-17e; docs/modules/devices/README.md): a newer
 * build reloads the tablet by itself, but only while it is idle: nothing busy (no save,
 * no open Undo, no unsaved input), resting (nobody chosen, no PIN unlock, no dialog) and
 * online. It reloads at most once per build per tab, and never once the crash guard has
 * counted repeated crashes in this tab (the error boundary then shows a plain error with
 * the time and a manual retry, as in 2.1). Personal accounts keep the "HomeHub updated"
 * prompt and never reload on their own.
 */
export function decideTabletReload(input: {
  pageBuildId: string | null | undefined;
  workerBuildId: string | null | undefined;
  reloadedFor: string | null | undefined;
  busy: boolean;
  resting: boolean;
  online: boolean;
  recentCrashes: number;
  crashLimit?: number;
}): TabletReloadDecision {
  const { pageBuildId, workerBuildId, reloadedFor, busy, resting, online, recentCrashes, crashLimit = 2 } = input;
  if (!isBuildId(pageBuildId) || !isBuildId(workerBuildId) || workerBuildId <= pageBuildId) return 'none';
  if (isBuildId(reloadedFor) && reloadedFor >= workerBuildId) return 'none';
  if (recentCrashes >= crashLimit) return 'none';
  if (busy || !resting || !online) return 'wait';
  return 'reload';
}
