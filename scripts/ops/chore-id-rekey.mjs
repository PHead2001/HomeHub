// Pure decisions for rekey-chore-ids.mjs (member privacy release E). No
// Firebase imports, so tests/unit/chore-id-rekey.test.ts can cover them.
//
// Generated chores used to be stored under
// `stableSlugify(templateId-roomId-day-<assignee>)`, where the assignee part
// was the template's email (or, for templates without one, its uid): every
// member who can list chores could read the slug of a housemate's email in the
// document ids. Upkeep now generates `stableSlugify(templateId-roomId-day)`
// (`occurrenceChoreId` in functions/src/shared/ids.ts). The re-key moves every
// stored chore with an assignee part to that id, whatever the part was.

import { choreOccurrenceKey, stableSlugify, storedOccurrenceKey } from './occurrence-key.mjs';

/** Twin of `occurrenceChoreId` in functions/src/shared/ids.ts. */
export const occurrenceChoreIdJs = (templateId, roomId, day) => stableSlugify(`${templateId}-${roomId}-${day}`);

/** Free ids tried, in order, for a chore whose occurrence id is already taken. */
export const MAX_DUPLICATE_SLOT = 9;

// A re-keyed duplicate: `<occurrence id>-<2..9>`. An assignee part was the slug
// of an email (which always keeps letters from its domain) or of a uid, never a
// lone digit.
const DUPLICATE_SUFFIX = /^[2-9]$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_ID = /^(.+-\d{4}-\d{2}-\d{2})-(.+)$/;

const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * Template, room and day of an occurrence key (`templateId|roomId|day`). The
 * day and room are the last two parts, so a `|` inside a template id survives.
 * @param {string} key
 * @returns {{ templateId: string, roomId: string, day: string } | null}
 */
export function parseOccurrenceKey(key) {
  const parts = typeof key === 'string' ? key.split('|') : [];
  if (parts.length < 3) return null;
  const day = parts[parts.length - 1];
  const roomId = parts[parts.length - 2];
  const templateId = parts.slice(0, -2).join('|');
  if (!templateId || !roomId || !DAY.test(day)) return null;
  return { templateId, roomId, day };
}

/**
 * Ids to try, in order, for a chore whose occurrence id is `base`: the id
 * itself, then `<base>-2` to `<base>-9` for a day that (from before upkeep
 * checked occurrence keys) has more than one chore.
 * @param {string} base
 * @returns {string[]}
 */
export function rekeyTargets(base) {
  const slots = [base];
  for (let slot = 2; slot <= MAX_DUPLICATE_SLOT; slot += 1) slots.push(`${base}-${slot}`);
  return slots;
}

/**
 * What the re-key does with one chore.
 * @param {string} id Chore document id.
 * @param {Record<string, unknown> | null | undefined} chore Stored fields (at least
 *   `templateId`, `roomIds`, `sourceType`, `occurrenceKey`).
 * @param {ReadonlySet<string>} [memberUidSlugs] `stableSlugify(uid)` of the household's
 *   members, only to count how many assignee parts were uids (`suffix`).
 * @returns {{ kind: 'one-time' | 'current' | 'unrecognized' } | { kind: 'rekey', base: string, suffix: 'uid' | 'other', occurrenceKey: string | null }}
 *   - `one-time`: not a generated chore (a `sourceType`, or no template);
 *   - `current`: already under its occurrence id (or a numbered duplicate of it);
 *   - `unrecognized`: has a template, but the id is not a generated id: left alone;
 *   - `rekey`: move it to `base` (or the first free `rekeyTargets(base)` slot).
 *     `suffix` says whether the assignee part was a member's uid or anything else
 *     (an email, or a former member's uid). `occurrenceKey` is the key to add when
 *     the chore has none and its id names its room exactly (null otherwise: the
 *     move then keeps the fields as they are).
 */
export function choreIdRekeyPlan(id, chore, memberUidSlugs = new Set()) {
  if (!chore || (chore.sourceType !== undefined && chore.sourceType !== null)) return { kind: 'one-time' };
  const templateId = text(chore.templateId) ? chore.templateId : '';
  if (!templateId) return { kind: 'one-time' };
  const stored = typeof chore.occurrenceKey === 'string' && chore.occurrenceKey ? chore.occurrenceKey : null;
  const key = storedOccurrenceKey(id, chore);
  const parsed = key ? parseOccurrenceKey(key) : null;
  let base = parsed ? occurrenceChoreIdJs(parsed.templateId, parsed.roomId, parsed.day) : null;
  if (!base || !(id === base || id.startsWith(`${base}-`))) {
    // No key, or a room that no longer matches the id (the chore was moved to
    // another room): the occurrence id is the id up to its day, as long as it
    // starts with the template's slug.
    const match = LEGACY_ID.exec(id);
    if (!match || !match[1].startsWith(`${stableSlugify(templateId)}-`)) return { kind: 'unrecognized' };
    base = match[1];
  }
  if (id === base) return { kind: 'current' };
  const suffix = id.slice(base.length + 1);
  if (!suffix) return { kind: 'unrecognized' };
  if (DUPLICATE_SUFFIX.test(suffix)) return { kind: 'current' };
  return {
    kind: 'rekey',
    base,
    suffix: memberUidSlugs.has(suffix) ? 'uid' : 'other',
    occurrenceKey: !stored && key ? key : null,
  };
}

/**
 * The document to create under the new id: every stored field, unchanged, plus
 * the occurrence key when the plan found one the chore did not store.
 * @param {Record<string, unknown>} data Source document data (as read).
 * @param {{ occurrenceKey: string | null }} plan From choreIdRekeyPlan.
 * @returns {Record<string, unknown>}
 */
export function rekeyedChoreData(data, plan) {
  if (!plan.occurrenceKey || (typeof data.occurrenceKey === 'string' && data.occurrenceKey)) return { ...data };
  return { ...data, occurrenceKey: plan.occurrenceKey };
}

export { choreOccurrenceKey };
