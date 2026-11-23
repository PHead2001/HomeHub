// Which Playwright specs each CI job runs. No Firebase or Playwright imports, so
// tests/unit/e2e-spec-sets.test.ts can cover the partition.
//
// Every `tests/e2e/*.spec.ts` file is in exactly one set:
// - smoke: the hand-maintained SMOKE_SPECS list (the "Authenticated smoke (shard i/N)" jobs, gated by
//   the "Validate and run authenticated smoke" check);
// - extended: every other spec, computed from the directory listing at run time
//   (the "Extended E2E (specs outside the smoke list)" job).
// `*.local.spec.ts` files (local-only) and `visual.spec.ts` (Windows-only baselines) are in neither.
// A new spec therefore runs in CI without being registered anywhere.

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_SPEC_DIR = 'tests/e2e';

/** Spec file names (inside tests/e2e) run by the smoke job, in run order. */
export const SMOKE_SPECS = Object.freeze([
  'smoke.spec.ts',
  'verification-findings.spec.ts',
  'temporary-chores-maintenance-ui.spec.ts',
  'ai-openai.spec.ts',
  'ai-hardening.spec.ts',
  'navigation-layout.spec.ts',
  'appearance.spec.ts',
  'dashboard-shell.spec.ts',
  'pwa-share.spec.ts',
  'pets-living-cards.spec.ts',
  'household-ux.spec.ts',
  'maintenance-ux.spec.ts',
  'shopping-trip.spec.ts',
  'chores-ux.spec.ts',
  'dashboard-house.spec.ts',
  'chores-room-filter.spec.ts',
  'pets-hold-to-feed.spec.ts',
  'maintenance-warranty-odometer.spec.ts',
  'shopping-cart-flight.spec.ts',
  'notifications-swipe.spec.ts',
  'shell-wave4.spec.ts',
  'dashboard-wide.spec.ts',
]);

export const VISUAL_SPEC = 'visual.spec.ts';

/** @param {string} name */
export const isSpecFile = (name) => name.endsWith('.spec.ts');

/** @param {string} name */
export const isLocalSpec = (name) => name.endsWith('.local.spec.ts');

/** @param {string} name */
export const isCiExcluded = (name) => isLocalSpec(name) || name === VISUAL_SPEC;

/**
 * Turns the E2E_SHARD value ("i/N", set by the smoke shard jobs) into Playwright arguments.
 * Unset or empty gives no arguments, so local runs are unchanged. Anything else that is not
 * "i/N" with 1 <= i <= N throws, so a typo cannot quietly run the whole list or nothing.
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function shardArgs(value) {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return [];
  const match = /^(\d+)\/(\d+)$/.exec(trimmed);
  const current = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!match || current < 1 || total < 1 || current > total) {
    throw new Error(`E2E_SHARD must look like "1/3" (shard number from 1 to the shard total), got "${trimmed}".`);
  }
  return [`--shard=${current}/${total}`];
}

/**
 * Splits the spec files of tests/e2e into the smoke and extended sets.
 * Throws when a smoke entry is missing on disk, listed twice, or is a local/visual spec,
 * so a renamed or deleted spec cannot silently drop out of CI.
 * @param {readonly string[]} fileNames File names in tests/e2e (non-spec names are ignored).
 * @param {readonly string[]} [smokeList]
 * @returns {{ smoke: string[], extended: string[], excluded: string[] }} File names, smoke in list order, the rest sorted.
 */
export function partitionSpecs(fileNames, smokeList = SMOKE_SPECS) {
  const specs = new Set(fileNames.filter(isSpecFile));
  const seen = new Set();
  for (const name of smokeList) {
    if (seen.has(name)) throw new Error(`Smoke list names ${name} twice.`);
    seen.add(name);
    if (isCiExcluded(name)) {
      throw new Error(`Smoke list names ${name}, which is local-only or visual and must not run in CI.`);
    }
    if (!specs.has(name)) {
      throw new Error(`Smoke list names ${E2E_SPEC_DIR}/${name}, which does not exist. Update SMOKE_SPECS in scripts/e2e/spec-sets.mjs.`);
    }
  }
  const sorted = [...specs].sort();
  return {
    smoke: [...smokeList],
    extended: sorted.filter((name) => !seen.has(name) && !isCiExcluded(name)),
    excluded: sorted.filter(isCiExcluded),
  };
}

/**
 * Reads tests/e2e and returns both sets as repository-relative paths (forward slashes).
 * @param {string} [root] Repository root.
 */
export function specSets(root = process.cwd()) {
  const fileNames = readdirSync(resolve(root, E2E_SPEC_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const { smoke, extended, excluded } = partitionSpecs(fileNames);
  const toPath = (/** @type {string} */ name) => `${E2E_SPEC_DIR}/${name}`;
  return { smoke: smoke.map(toPath), extended: extended.map(toPath), excluded: excluded.map(toPath) };
}

// `node scripts/e2e/spec-sets.mjs` prints both sets for the current tree.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sets = specSets();
  for (const [label, paths] of Object.entries(sets)) {
    console.log(`${label} (${paths.length}):`);
    for (const path of paths) console.log(`  ${path}`);
  }
}
