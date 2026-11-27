/**
 * Search and ranking for the command palette (QA-5, QA-11, QA-18). Pure: no
 * Firebase, no React, no storage of its own (the recent-use store takes a
 * `Storage`-like object), so it is unit tested.
 */

/** Lower case, accents folded, split into words. */
export function searchTokens(value: string): string[] {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** True when `a` and `b` differ by at most one edit (insert, delete, substitute or swap). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    // A swap of two neighbours ("mlik" for "milk").
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** How well one typed token fits one word: 4 exact, 3 prefix, 2 inside, 1 one typo (4+ letters), 0 none. */
function tokenFit(token: string, word: string): number {
  if (word === token) return 4;
  if (word.startsWith(token)) return 3;
  if (token.length >= 3 && word.includes(token)) return 2;
  if (token.length >= 4 && (withinOneEdit(token, word) || withinOneEdit(token, word.slice(0, token.length)))) return 1;
  return 0;
}

export type Searchable = { label: string; detail?: string; keywords?: string };

/**
 * Scores a record against what was typed (QA-11): every typed word must fit a word
 * of the label, the detail (assignee, list, room) or the keywords (make and model,
 * settings words), with one typo allowed in words of four letters or more. Label
 * fits count double, and a label that starts with the whole query gets a bonus.
 * 0 means no match.
 */
export function searchScore(record: Searchable, query: string): number {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return 0;
  const label = searchTokens(record.label);
  const other = [...searchTokens(record.detail ?? ''), ...searchTokens(record.keywords ?? '')];
  let score = 0;
  for (const token of tokens) {
    const inLabel = Math.max(0, ...label.map((word) => tokenFit(token, word)));
    const inOther = Math.max(0, ...other.map((word) => tokenFit(token, word)));
    if (inLabel === 0 && inOther === 0) return 0;
    score += Math.max(inLabel * 2, inOther);
  }
  const whole = searchTokens(query).join(' ');
  if (label.join(' ') === whole) score += 4;
  else if (label.join(' ').startsWith(whole)) score += 2;
  return score;
}

/**
 * Keeps each group's options together (QA-5): groups appear in the order of their
 * first (best) option, and options keep their order inside a group, so a header is
 * shown once and React keys never repeat.
 */
export function groupContiguous<T extends { group: string }>(options: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const option of options) {
    const list = groups.get(option.group);
    if (list) list.push(option);
    else groups.set(option.group, [option]);
  }
  return [...groups.values()].flat();
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Use = { count: number; last: number };
const MAX_REMEMBERED = 40;
const DAY_MS = 86_400_000;

const read = (storage: StorageLike | null, key: string): Record<string, Use> => {
  try {
    const parsed = JSON.parse(storage?.getItem(key) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, Use> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const use = value as Partial<Use>;
      if (typeof use?.count === 'number' && typeof use?.last === 'number') out[id] = { count: use.count, last: use.last };
    }
    return out;
  } catch {
    return {};
  }
};

/** "Frecency": uses, fading by half each week. */
const frecency = (use: Use, now: number) => use.count * 0.5 ** ((now - use.last) / (7 * DAY_MS));

/**
 * A device-local record of what was used (palette results picked, items added),
 * per household, for recency and frequency ranking (QA-11) and the empty
 * palette's "Add again" (QA-18). Holds names and record ids only, never emails.
 */
export function recentUse(storage: StorageLike | null, key: string) {
  return {
    record(ids: readonly string[], now = Date.now()) {
      const uses = read(storage, key);
      for (const id of ids) {
        const use = uses[id] ?? { count: 0, last: 0 };
        uses[id] = { count: use.count + 1, last: now };
      }
      const kept = Object.entries(uses).sort((a, b) => frecency(b[1], now) - frecency(a[1], now)).slice(0, MAX_REMEMBERED);
      try {
        storage?.setItem(key, JSON.stringify(Object.fromEntries(kept)));
      } catch {
        // Storage full or blocked: ranking just stays as it was.
      }
    },
    /** A small boost (0 to 2) for ranking ties toward what is used often and lately. */
    boost(id: string, now = Date.now()): number {
      const use = read(storage, key)[id];
      return use ? Math.min(2, frecency(use, now)) : 0;
    },
    /** The ids used most, best first. */
    top(limit: number, now = Date.now()): string[] {
      return Object.entries(read(storage, key)).sort((a, b) => frecency(b[1], now) - frecency(a[1], now)).slice(0, limit).map(([id]) => id);
    },
  };
}

/** The storage keys (device-local). */
export const recentPicksKey = (householdId: string) => `homehub.palette.picks.${householdId}`;
export const recentItemsKey = (householdId: string) => `homehub.palette.items.${householdId}`;

/** The palette index cache's key: household, person and the view permissions they hold (QA-12, QA-21). */
export const indexCacheKey = (householdId: string, uid: string, permissions: Partial<Record<string, boolean>>) =>
  [householdId, uid, ...Object.keys(permissions).filter((name) => permissions[name]).sort()].join('|');
