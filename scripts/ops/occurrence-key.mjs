// Pure decisions for backfill-occurrence-key.mjs. No Firebase imports, so
// tests/unit/chores-completion.test.ts can cover them. `storedOccurrenceKey`
// is the plain-JavaScript twin of the function of the same name in
// functions/src/shared/ids.ts (these scripts run without a TypeScript loader);
// that test checks the two agree case by case.

const FROM = 'àáâäæãåāăąçćčđďèéêëēėęěğǵḧîïíīįìłḿñńǹňôö' +
  'òóœøōõőṕŕřßśšşșťțûüùúūǘůűųẃẍÿýžźż·/_,:;';
const TO = 'aaaaaaaaaacccddeeeeeeeegghiiiiiilmnnnnoo' +
  'oooooooprrsssssttuuuuuuuuuwxyyzzz------';
const ACCENTS = new RegExp(FROM.split('').join('|'), 'g');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Twin of `stableSlugify` in functions/src/shared/ids.ts. */
export const stableSlugify = text => text.toString().toLowerCase()
  .replace(/\s+/g, '-')
  .replace(ACCENTS, c => TO.charAt(FROM.indexOf(c)))
  .replace(/&/g, '-and-')
  .replace(/[^\w-]+/g, '')
  .replace(/--+/g, '-')
  .replace(/^-+/, '')
  .replace(/-+$/, '');

/** "templateId|roomId|day" (twin of `choreOccurrenceKey`). */
export const choreOccurrenceKey = (templateId, roomId, day) => `${templateId}|${roomId}|${day}`;

/**
 * The occurrence key a stored chore holds, or recovers from its generated id.
 * @param {string} id
 * @param {{ occurrenceKey?: unknown, templateId?: unknown, roomIds?: unknown, sourceType?: unknown }} chore
 * @returns {string | null}
 */
export function storedOccurrenceKey(id, chore) {
  if (typeof chore.occurrenceKey === 'string' && chore.occurrenceKey) return chore.occurrenceKey;
  if (chore.sourceType !== undefined && chore.sourceType !== null) return null;
  if (typeof chore.templateId !== 'string' || !chore.templateId) return null;
  const rooms = Array.isArray(chore.roomIds) ? chore.roomIds : [];
  if (rooms.length > 1) return null;
  const roomId = typeof rooms[0] === 'string' && rooms[0] ? rooms[0] : 'general';
  const prefix = `${stableSlugify(`${chore.templateId}-${roomId}`)}-`;
  if (!id.startsWith(prefix)) return null;
  const day = id.slice(prefix.length, prefix.length + 10);
  const next = id.charAt(prefix.length + 10);
  if (!DAY.test(day) || (next !== '' && next !== '-')) return null;
  return choreOccurrenceKey(chore.templateId, roomId, day);
}

/**
 * What the backfill does with one chore: `present` (already has a key), `oneTime`
 * (not a generated chore), `unrecognized` (has a template and day but an id that
 * is not a generated id: left alone), or `write` with the key to set.
 * @param {string} id
 * @param {Record<string, unknown>} chore
 * @returns {{ kind: 'present' | 'oneTime' | 'unrecognized' } | { kind: 'write', occurrenceKey: string }}
 */
export function occurrenceKeyDecision(id, chore) {
  if (typeof chore.occurrenceKey === 'string' && chore.occurrenceKey) return { kind: 'present' };
  if (chore.sourceType !== undefined && chore.sourceType !== null) return { kind: 'oneTime' };
  if (typeof chore.templateId !== 'string' || !chore.templateId || typeof chore.originalDueDate !== 'string' || !chore.originalDueDate) {
    return { kind: 'oneTime' };
  }
  const occurrenceKey = storedOccurrenceKey(id, chore);
  return occurrenceKey ? { kind: 'write', occurrenceKey } : { kind: 'unrecognized' };
}
