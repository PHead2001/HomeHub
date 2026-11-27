import { isBuildId } from './update-check';

/**
 * SL-24: the "HomeHub updated" moment. When this browser last ran an older build (a
 * tablet that reloaded itself for a new build, or a person who tapped Reload), the
 * first page of the new build says so once, with the newest change in one line and
 * (personal accounts) a **What's new** button listing the changes since that build.
 * The build this browser last ran is kept in `localStorage` (`LAST_BUILD_KEY`): a
 * build id only, nothing personal. A first visit records it and says nothing.
 *
 * Pure; unit tested in tests/unit/shell-section-11.test.ts.
 */

export const LAST_BUILD_KEY = 'homehub.shell.last-build';

export type WhatsNewEntry = {
  /** The release day (YYYY-MM-DD, UTC like the build id). */
  date: string;
  items: readonly string[];
};

/** Newest first. Add a line here in the release that changes something people will notice. */
export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    // This release (audit section 11) and the changes merged the same day.
    date: '2026-11-27',
    items: [
      'Pages have their own titles, and a Skip to content link leads past the header.',
      'Signing out asks first.',
      'A new "By time" theme: light by day, dark in the evening.',
      'Install HomeHub from your Profile where your browser offers it.',
      'Wall tablets: the resting clock shows the house, the pets and what is next.',
      'Chores: skip one day of a repeat, fair streaks, and missed days stay listed.',
      'Automation: a live, readable device list.',
      'Wall tablets: add and tick shopping items, with Undo.',
    ],
  },
  {
    date: '2026-11-24',
    items: [
      'Maintenance: a Needs doing list, filters and receipts read with AI.',
      'Maintenance on wall tablets: Done, Snooze and Log service with Undo.',
    ],
  },
];

/** The UTC day of a build id ("20261127T101522000Z" → "2026-11-27"). */
export function buildDay(buildId: string): string {
  return `${buildId.slice(0, 4)}-${buildId.slice(4, 6)}-${buildId.slice(6, 8)}`;
}

export type UpdatedMoment = { show: false } | { show: true; headline: string; entries: WhatsNewEntry[] };

/**
 * Whether to say "HomeHub updated" now: only when the browser's last build is a valid
 * build strictly older than this page's. The entries are the releases after the last
 * build's day (at most three), or the newest one when none is dated after it.
 */
export function decideUpdatedMoment(input: {
  previousBuild: string | null | undefined;
  currentBuild: string | null | undefined;
  entries?: readonly WhatsNewEntry[];
}): UpdatedMoment {
  const { previousBuild, currentBuild, entries = WHATS_NEW } = input;
  if (!isBuildId(previousBuild) || !isBuildId(currentBuild) || currentBuild <= previousBuild) return { show: false };
  const since = buildDay(previousBuild);
  const newer = entries.filter((entry) => entry.date > since && entry.date <= buildDay(currentBuild)).slice(0, 3);
  const shown = newer.length > 0 ? newer : entries.slice(0, 1);
  const headline = shown[0]?.items[0] ?? 'You are on the latest version.';
  return { show: true, headline, entries: [...shown] };
}
