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
 * What the re-key does with one stats document.
 * @param {Record<string, unknown> | null | undefined} data Stats data.
 * @param {Map<string, string>} byLegacy From legacyKeyMap.
 * @returns {{ kind: 'clean' } | { kind: 'rekey', byAssignee: Record<string, number>, names: Record<string, string>, members: number, former: number }}
 *   - `clean`: no legacy key in `byAssignee` or `names`;
 *   - `rekey`: the new `byAssignee` and `names` maps. A legacy key of a current
 *     member is folded into their uid key (counts added, an existing uid-key label
 *     kept); any other legacy key (someone who has left) becomes an opaque
 *     `former-<n>` key with the same count and label, so the email cannot be
 *     recovered from it. `members` and `former` count the keys moved each way.
 *   Running it again on its own output finds nothing to do.
 */
export function statsRekeyPlan(data, byLegacy) {
  const counts = isMap(data?.byAssignee) ? data.byAssignee : {};
  const labels = isMap(data?.names) ? data.names : {};
  const legacy = [...new Set([...Object.keys(counts), ...Object.keys(labels)])].filter(isLegacyStatsKey).sort();
  if (legacy.length === 0) return { kind: 'clean' };
  const byAssignee = Object.fromEntries(Object.entries(counts).filter(([key]) => !isLegacyStatsKey(key)));
  const names = Object.fromEntries(Object.entries(labels).filter(([key]) => !isLegacyStatsKey(key)));
  let next = Object.keys({ ...byAssignee, ...names }).filter(key => key.startsWith(FORMER_PREFIX))
    .map(key => Number(key.slice(FORMER_PREFIX.length))).filter(Number.isInteger)
    .reduce((max, n) => Math.max(max, n), 0) + 1;
  let members = 0;
  let former = 0;
  for (const key of legacy) {
    let target = byLegacy.get(key);
    if (target) members += 1;
    else {
      target = `${FORMER_PREFIX}${next}`;
      next += 1;
      former += 1;
    }
    if (typeof counts[key] === 'number') byAssignee[target] = (byAssignee[target] ?? 0) + counts[key];
    if (typeof labels[key] === 'string' && !(target in names)) names[target] = labels[key];
  }
  return { kind: 'rekey', byAssignee, names, members, former };
}
