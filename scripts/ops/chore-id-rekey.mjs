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
const DAY_AT = /^\d{4}-\d{2}-\d{2}(?=-|$)/;
const ENDS_WITH_DAY = /-\d{4}-\d{2}-\d{2}$/;

/**
 * The occurrence id inside a legacy id whose occurrence key is unknown (no stored
 * key, and a room that no longer matches it): `<template slug>-<room slug>-<day>`.
 * The assignee part after the day may itself contain date-shaped parts (an email
 * such as `alice-2025-01-01@work...`), so the day is never taken from the end.
 * Candidates are the date-shaped parts after the template slug and a non-empty
 * room part. One candidate is the day (the real day is always among them). With
 * several, the one whose room part is a known room (`roomSlugs`) decides; when
 * that does not single one out the id is ambiguous.
 * @param {string} id
 * @param {string} templateSlug `stableSlugify(templateId)`.
 * @param {ReadonlySet<string> | null} roomSlugs `stableSlugify` of the household's room ids and "general".
 * @returns {{ base: string } | { ambiguous: true } | null} Null when the id is not a generated id.
 */
export function legacyOccurrenceBase(id, templateSlug, roomSlugs) {
  const prefix = `${templateSlug}-`;
  if (!templateSlug || !id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const candidates = [];
  for (let index = 2; index < rest.length; index += 1) {
    if (rest[index - 1] !== '-') continue;
    const day = DAY_AT.exec(rest.slice(index));
    if (day) candidates.push({ room: rest.slice(0, index - 1), base: `${prefix}${rest.slice(0, index + day[0].length)}` });
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { base: candidates[0].base };
  const known = roomSlugs ? candidates.filter(candidate => roomSlugs.has(candidate.room)) : [];
  return known.length === 1 ? { base: known[0].base } : { ambiguous: true };
}

/**
 * Guard on every move target: the occurrence id ends with its day, so nothing of
 * the old id's assignee part can survive in it (the only thing ever added after
 * the day is a `-2`..`-9` duplicate slot, see rekeyTargets).
 * @param {string} base
 * @param {string} templateSlug
 * @returns {string} base
 */
export function assertOccurrenceBase(base, templateSlug) {
  if (!ENDS_WITH_DAY.test(base) || !base.startsWith(`${templateSlug}-`)) {
    throw new Error('chore id re-key: a target id must be <template>-<room>-<day>');
  }
  return base;
}

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
 * @param {ReadonlySet<string> | null} [roomSlugs] `stableSlugify` of the household's room
 *   ids and "general", to place the day in a keyless id with several date-shaped parts.
 * @returns {{ kind: 'one-time' | 'current' | 'unrecognized' | 'ambiguous' } | { kind: 'rekey', base: string, suffix: 'uid' | 'other', occurrenceKey: string | null }}
 *   - `one-time`: not a generated chore (a `sourceType`, or no template);
 *   - `current`: already under its occurrence id (or a numbered duplicate of it);
 *   - `unrecognized`: has a template, but the id is not a generated id: left alone;
 *   - `ambiguous`: a generated id without a usable key in which the day cannot be
 *     told apart from date-shaped parts of the assignee: left alone and counted;
 *   - `rekey`: move it to `base` (or the first free `rekeyTargets(base)` slot).
 *     `suffix` says whether the assignee part was a member's uid or anything else
 *     (an email, or a former member's uid). `occurrenceKey` is the key to add when
 *     the chore has none and its id names its room exactly (null otherwise: the
 *     move then keeps the fields as they are).
 */
export function choreIdRekeyPlan(id, chore, memberUidSlugs = new Set(), roomSlugs = null) {
  if (chore?.sourceType === 'template') return oneTimeLibraryPlan(id, chore, memberUidSlugs, roomSlugs);
  if (!chore || (chore.sourceType !== undefined && chore.sourceType !== null)) return { kind: 'one-time' };
  const templateId = text(chore.templateId) ? chore.templateId : '';
  if (!templateId) return { kind: 'one-time' };
  const stored = typeof chore.occurrenceKey === 'string' && chore.occurrenceKey ? chore.occurrenceKey : null;
  const key = storedOccurrenceKey(id, chore);
  const parsed = key ? parseOccurrenceKey(key) : null;
  let base = parsed ? occurrenceChoreIdJs(parsed.templateId, parsed.roomId, parsed.day) : null;
  if (!base || !(id === base || id.startsWith(`${base}-`))) {
    // No key, or a room that no longer matches the id (the chore was moved to
    // another room): the occurrence id is the id up to its day (legacyOccurrenceBase).
    const found = legacyOccurrenceBase(id, stableSlugify(templateId), roomSlugs);
    if (!found) return { kind: 'unrecognized' };
    if ('ambiguous' in found) return { kind: 'ambiguous' };
    base = found.base;
  }
  assertOccurrenceBase(base, stableSlugify(templateId));
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

/** Suffix of a moved one-time library assignment's id (never an occurrence id). */
export const ONE_TIME_SUFFIX = 'once';
const ONE_TIME_ID_TAIL = /^once(-[2-9])?$/;

/**
 * One-time chores assigned from the chore library before upkeep matched
 * occurrences by id (`sourceType: 'template'`) were stored under
 * `stableSlugify(templateId-roomId-day-<assignee email>)`, the same shape as a
 * generated chore: the slug of the assignee's email stays in a document id every
 * member can list. Such a chore moves to `<template>-<room>-<day>-once` (or a
 * `-once-2`..`-once-9` slot): never the occurrence id itself, which would stop
 * upkeep generating that day for the template, and without an occurrence key (a
 * `sourceType` chore has none, so it never suppresses recurring work). It stays a
 * one-time chore. Ids that do not start with the template's slug (auto ids, every
 * assignment since), that end at the day, or that were already moved are left alone.
 * @returns {{ kind: 'one-time' } | { kind: 'rekey', base: string, suffix: 'uid' | 'other', occurrenceKey: null, oneTime: true }}
 */
function oneTimeLibraryPlan(id, chore, memberUidSlugs, roomSlugs) {
  const templateId = text(chore.templateId) ? chore.templateId : '';
  if (!templateId) return { kind: 'one-time' };
  const found = legacyOccurrenceBase(id, stableSlugify(templateId), roomSlugs);
  if (!found || 'ambiguous' in found) return { kind: 'one-time' };
  const suffix = id.slice(found.base.length + 1);
  if (!id.startsWith(`${found.base}-`) || !suffix || ONE_TIME_ID_TAIL.test(suffix) || DUPLICATE_SUFFIX.test(suffix)) {
    return { kind: 'one-time' };
  }
  return {
    kind: 'rekey',
    base: `${assertOccurrenceBase(found.base, stableSlugify(templateId))}-${ONE_TIME_SUFFIX}`,
    suffix: memberUidSlugs.has(suffix) ? 'uid' : 'other',
    occurrenceKey: null,
    oneTime: true,
  };
}

/**
 * Overdue notifications list chore ids (`overdueChoreIds`, `notifiedChoreIds`;
 * functions/src/shared/overdue-notification.ts): a moved chore's old id is
 * replaced by its new one in place, so the chore is not news to its person again.
 * `overdueChoreIds` stays sorted, as upkeep stores it.
 * @param {Record<string, unknown> | null | undefined} data Notification data.
 * @param {string} from Old chore id.
 * @param {string} to New chore id.
 * @returns {{ overdueChoreIds?: string[], notifiedChoreIds?: string[] } | null} Fields to update, or null.
 */
export function overdueIdsAfterMove(data, from, to) {
  const update = {};
  const swap = list => [...new Set(list.map(id => (id === from ? to : id)))];
  if (Array.isArray(data?.overdueChoreIds) && data.overdueChoreIds.includes(from)) {
    update.overdueChoreIds = swap(data.overdueChoreIds).sort();
  }
  if (Array.isArray(data?.notifiedChoreIds) && data.notifiedChoreIds.includes(from)) {
    update.notifiedChoreIds = swap(data.notifiedChoreIds);
  }
  return Object.keys(update).length > 0 ? update : null;
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
