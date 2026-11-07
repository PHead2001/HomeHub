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

const VALUE_FLAGS = new Set(['--project', '--firebase-tools-from']);
const SWITCHES = new Set(['--apply', '--firebase-tools-login']);

/**
 * Parses the shared command line:
 * - `--project <id>` (required)
 * - `--apply` (otherwise a dry run)
 * - `--firebase-tools-login` (authenticate with the firebase-tools login
 *   instead of Application Default Credentials)
 * - `--firebase-tools-from <dir or package.json>` (where firebase-tools is
 *   installed; falls back to `env.HOMEHUB_FIREBASE_TOOLS_FROM`, then this
 *   checkout). Only meaningful with --firebase-tools-login.
 * @param {string[]} argv process.argv.slice(2)
 * @param {Record<string, string | undefined>} [env] process.env
 */
export function parseOpsArgs(argv, env = {}) {
  const values = {};
  const switches = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Pass a value after ${arg}.`);
      values[arg] = value;
      index += 1;
    } else if (SWITCHES.has(arg)) {
      switches.add(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!values['--project']) throw new Error('Pass --project <firebase project id>.');
  const firebaseToolsLogin = switches.has('--firebase-tools-login');
  if (values['--firebase-tools-from'] && !firebaseToolsLogin) {
    throw new Error('--firebase-tools-from needs --firebase-tools-login.');
  }
  return {
    projectId: values['--project'],
    apply: switches.has('--apply'),
    auth: firebaseToolsLogin ? 'firebase-tools' : 'adc',
    firebaseToolsFrom: firebaseToolsLogin
      ? values['--firebase-tools-from'] || env.HOMEHUB_FIREBASE_TOOLS_FROM || null
      : null,
  };
}
