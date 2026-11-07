// Pure decisions for the profile privacy clean-up scripts in this folder. No
// Firebase imports, so tests/unit/identity-profile-privacy.test.ts can cover them.

/** Profile fields that Google sign-in no longer collects and the purge removes. */
export const DEMOGRAPHIC_FIELDS = Object.freeze(['birthday', 'gender']);

/** Matches the Firestore rule for users/{email}/private/push. */
export const MAX_PUSH_TOKENS = 20;

/**
 * Which demographic fields a profile still holds. A field counts when it is
 * present at all, whatever its value (null and empty strings are still removed).
 * @param {Record<string, unknown> | undefined | null} data Profile data.
 * @returns {string[]} Field names to delete, in DEMOGRAPHIC_FIELDS order.
 */
export function demographicFieldsToDelete(data) {
  if (!data || typeof data !== 'object') return [];
  return DEMOGRAPHIC_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(data, field));
}

/**
 * Adds one profile's decision to running totals. Only counts, never values.
 * @param {{ scanned: number, birthday: number, gender: number }} totals
 * @param {string[]} fields Result of demographicFieldsToDelete.
 */
export function countDemographics(totals, fields) {
  totals.scanned += 1;
  if (fields.includes('birthday')) totals.birthday += 1;
  if (fields.includes('gender')) totals.gender += 1;
  return totals;
}

const tokenList = value => (Array.isArray(value) ? value.filter(token => typeof token === 'string' && token.length > 0) : []);

/**
 * The token list for users/{email}/private/push after moving the legacy
 * profile tokens in: existing private tokens first, then legacy ones, without
 * duplicates, capped at MAX_PUSH_TOKENS (the newest entries win).
 * @param {unknown} legacyTokens users/{email}.fcmTokens
 * @param {unknown} privateTokens users/{email}/private/push.fcmTokens
 * @returns {string[]}
 */
export function mergePushTokens(legacyTokens, privateTokens) {
  const merged = [...new Set([...tokenList(privateTokens), ...tokenList(legacyTokens)])];
  return merged.slice(Math.max(0, merged.length - MAX_PUSH_TOKENS));
}

/**
 * Parses the shared command line: `--project <id>` (required) and `--apply`.
 * @param {string[]} argv process.argv.slice(2)
 */
export function parseOpsArgs(argv) {
  const index = argv.indexOf('--project');
  const projectId = index >= 0 ? argv[index + 1] : undefined;
  if (!projectId || projectId.startsWith('--')) {
    throw new Error('Pass --project <firebase project id>.');
  }
  const known = new Set(['--project', projectId, '--apply']);
  const unknown = argv.filter(arg => !known.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  return { projectId, apply: argv.includes('--apply') };
}
