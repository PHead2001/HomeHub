// Pure decisions for rekey-chore-stats.mjs (member privacy release D). No
// Firebase imports, so tests/unit/chore-stats-rekey.test.ts can cover them.
//
// Yearly chore stats (`households/{id}/stats/chores-{year}`) used to key each
// person by `choreStatsAssigneeKey(email)`: a slug of the email's local part
// plus a hash of the whole email, which shows housemates the local part and
// lets them confirm a guessed address. They are now keyed by account ID
// (`choreStatsMemberKey(uid)`). The `...Js` functions are plain-JavaScript
// twins of those in functions/src/shared/ids.ts (these scripts run without a
// TypeScript loader); the unit test checks they agree.

const FROM = 'àáâäæãåāăąçćčđďèéêëēėęěğǵḧîïíīįìłḿñńǹňôö' +
  'òóœøōõőṕŕřßśšşșťțûüùúūǘůűųẃẍÿýžźż·/_,:;';
const TO = 'aaaaaaaaaacccddeeeeeeeegghiiiiiilmnnnnoo' +
  'oooooooprrsssssttuuuuuuuuuwxyyzzz------';
const ACCENTS = new RegExp(FROM.split('').join('|'), 'g');

const stableSlugifyJs = value => value.toString().toLowerCase()
  .replace(/\s+/g, '-')
  .replace(ACCENTS, c => TO.charAt(FROM.indexOf(c)))
  .replace(/&/g, '-and-')
  .replace(/[^\w-]+/g, '')
  .replace(/--+/g, '-')
  .replace(/^-+/, '')
  .replace(/-+$/, '');

const hashIdentityJs = value => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/** Twin of choreStatsAssigneeKey (the legacy, email-derived key). */
export function choreStatsAssigneeKeyJs(email) {
  const normalized = email.trim().toLowerCase();
  const slug = stableSlugifyJs(normalized.split('@')[0] || 'member').replace(/-/g, '_').slice(0, 24) || 'member';
  return `${slug}_${hashIdentityJs(normalized)}`;
}

/** Twin of choreStatsMemberKey (the uid key). */
export function choreStatsMemberKeyJs(uid) {
  return `uid-${uid.trim().replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

const MEMBER_PREFIX = 'uid-';
const FORMER_PREFIX = 'former-';
const text = value => (typeof value === 'string' ? value.trim() : '');
const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A key written before the stats were keyed by uid (legacy keys never contain "-"). */
export const isLegacyStatsKey = key => !key.startsWith(MEMBER_PREFIX) && !key.startsWith(FORMER_PREFIX);

/**
 * Legacy key to uid key for the household's members (emails from their
 * protected contact documents).
 * @param {Array<{ uid?: unknown, email?: unknown }>} members
 * @returns {Map<string, string>}
 */
export function legacyKeyMap(members) {
  const byLegacy = new Map();
  for (const member of members) {
    const uid = text(member?.uid);
    const email = text(member?.email);
    if (uid && email) byLegacy.set(choreStatsAssigneeKeyJs(email), choreStatsMemberKeyJs(uid));
  }
  return byLegacy;
}

/**
 * Adds the legacy keys of departed people to `byLegacy`: each email's legacy key
 * goes to the stats key of its settled identity (`identityOf`, from
 * ./former-member-key.mjs: their uid or their former-member key).
 * @param {Map<string, string>} byLegacy From legacyKeyMap (current members win).
 * @param {Iterable<string>} emails Departed people's emails.
 * @param {(email: string) => string} identityOf
 * @returns {Map<string, string>} The same map.
 */
export function addFormerLegacyKeys(byLegacy, emails, identityOf) {
  for (const email of emails) {
    const identity = identityOf(email);
    const legacy = choreStatsAssigneeKeyJs(email);
    if (identity && !byLegacy.has(legacy)) byLegacy.set(legacy, choreStatsMemberKeyJs(identity));
  }
  return byLegacy;
}

/**
 * What the re-key does with one stats document.
 * @param {Record<string, unknown> | null | undefined} data Stats data.
 * @param {Map<string, string>} byLegacy Legacy key to stats key: current members
 *   (legacyKeyMap) and departed people still named on chores (addFormerLegacyKeys).
 * @param {(legacyKey: string) => string} [unknownKeyOf] Identity for any other
 *   legacy key (`unknownLegacyKey`); without it such keys are left in place.
 * @returns {{ kind: 'clean' } | { kind: 'rekey', byAssignee: Record<string, number>, names: Record<string, string>, moved: number, unknown: number }}
 *   - `clean`: no legacy key that this call moves;
 *   - `rekey`: the new `byAssignee` and `names` maps: each moved legacy key's
 *     count is added to its target key and its label kept unless the target has
 *     one. `moved` counts keys moved through `byLegacy`, `unknown` the others.
 *   Running it again on its own output finds nothing to do.
 */
export function statsRekeyPlan(data, byLegacy, unknownKeyOf) {
  const counts = isMap(data?.byAssignee) ? data.byAssignee : {};
  const labels = isMap(data?.names) ? data.names : {};
  const targetOf = key => {
    if (byLegacy.has(key)) return byLegacy.get(key);
    const identity = unknownKeyOf ? unknownKeyOf(key) : '';
    return identity ? choreStatsMemberKeyJs(identity) : '';
  };
  const legacy = [...new Set([...Object.keys(counts), ...Object.keys(labels)])]
    .filter(key => isLegacyStatsKey(key) && targetOf(key)).sort();
  if (legacy.length === 0) return { kind: 'clean' };
  const moving = new Set(legacy);
  const byAssignee = Object.fromEntries(Object.entries(counts).filter(([key]) => !moving.has(key)));
  const names = Object.fromEntries(Object.entries(labels).filter(([key]) => !moving.has(key)));
  let moved = 0;
  let unknown = 0;
  for (const key of legacy) {
    const target = targetOf(key);
    if (byLegacy.has(key)) moved += 1;
    else unknown += 1;
    if (typeof counts[key] === 'number') byAssignee[target] = (byAssignee[target] ?? 0) + counts[key];
    if (typeof labels[key] === 'string' && !(target in names)) names[target] = labels[key];
  }
  return { kind: 'rekey', byAssignee, names, moved, unknown };
}
