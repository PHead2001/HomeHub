// Deterministic identifiers shared by the web app and Cloud Functions. Changing
// these breaks de-duplication against documents that already exist.

const FROM = "àáâäæãåāăąçćčđďèéêëēėęěğǵḧîïíīįìłḿñńǹňôö" +
  "òóœøōõőṕŕřßśšşșťțûüùúūǘůűųẃẍÿýžźż·/_,:;";
const TO = "aaaaaaaaaacccddeeeeeeeegghiiiiiilmnnnnoo" +
  "oooooooprrsssssttuuuuuuuuuwxyyzzz------";
const ACCENTS = new RegExp(FROM.split("").join("|"), "g");

export const stableSlugify = (text: string): string =>
  text.toString().toLowerCase()
    .replace(/\s+/g, "-")
    .replace(ACCENTS, (c) => TO.charAt(FROM.indexOf(c)))
    .replace(/&/g, "-and-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

const hashIdentity = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const deterministicNotificationId = (
  sourceType: string,
  sourceId: string,
  stateKey: string,
): string => {
  const identity = `${sourceType}|${sourceId}|${stateKey}`;
  return `${stableSlugify(sourceType) || "notification"}-` +
    hashIdentity(identity);
};

/**
 * Document id of one generated occurrence of a repeating chore:
 * `stableSlugify(templateId-roomId-day)`. It does not depend on the assignee
 * (member privacy release E), so reassigning a template never changes the id
 * of a day and no id carries anything about a person.
 * @param {string} templateId Source template id.
 * @param {string} roomId Room id ("general" when the template has none).
 * @param {string} day Occurrence day (YYYY-MM-DD, household timezone).
 * @return {string} Chore document id.
 */
export const occurrenceChoreId = (
  templateId: string,
  roomId: string,
  day: string,
): string => stableSlugify(`${templateId}-${roomId}-${day}`);

/**
 * The id shape generated before member privacy release E: the occurrence id
 * followed by the slug of the template's assignee key (its email, or later
 * its uid). Nothing generates it any more; scripts/ops/rekey-chore-ids.mjs
 * moves stored chores to `occurrenceChoreId`. Kept for tests that build such
 * chores (release F removes it).
 * @param {string} templateId Source template id.
 * @param {string} roomId Room id.
 * @param {string} day Occurrence day.
 * @param {string} assigneeKey Assignee email or uid.
 * @return {string} Legacy chore document id.
 */
export const recurringChoreId = (
  templateId: string,
  roomId: string,
  day: string,
  assigneeKey: string,
): string => stableSlugify(`${templateId}-${roomId}-${day}-${assigneeKey}`);

/**
 * The legacy map key for one person in yearly chore stats, written before the
 * stats were keyed by account ID: a slug of the email's local part and a hash
 * of the whole email ("sam_member_1x2y3z"). It reveals the local part and lets
 * anyone confirm a guessed email, so nothing writes it any more; Home Wrapped
 * still reads it during the move and scripts/ops/rekey-chore-stats.mjs
 * replaces it with `choreStatsMemberKey`.
 * @param {string} email Assignee email.
 * @return {string} Stable, field-path-safe key.
 */
export const choreStatsAssigneeKey = (email: string): string => {
  const normalized = email.trim().toLowerCase();
  const slug = stableSlugify(normalized.split("@")[0] || "member")
    .replace(/-/g, "_").slice(0, 24) || "member";
  return `${slug}_${hashIdentity(normalized)}`;
};

/**
 * Map key for one member in yearly chore stats: "uid-" and their Auth uid
 * (characters other than letters, digits, "_" and "-" become "_"). Legacy
 * keys (`choreStatsAssigneeKey`) never contain "-", so the two cannot collide.
 * @param {string} uid Member's Auth uid.
 * @return {string} Stable, field-path-safe key.
 */
export const choreStatsMemberKey = (uid: string): string =>
  `uid-${uid.trim().replace(/[^A-Za-z0-9_-]/g, "_")}`;

/**
 * Identity of one generated occurrence of a repeating chore, independent of
 * the assignee: "templateId|roomId|day". Upkeep writes it on every generated
 * chore and never creates a second chore with the same key, so reassigning
 * a template or editing its schedule never regenerates a day that already
 * has its chore (completed or not).
 * @param {string} templateId Source template id.
 * @param {string} roomId Room id ("general" when the template has none).
 * @param {string} day Occurrence day (YYYY-MM-DD, household timezone).
 * @return {string} Occurrence key.
 */
export const choreOccurrenceKey = (
  templateId: string,
  roomId: string,
  day: string,
): string => `${templateId}|${roomId}|${day}`;

export type OccurrenceSource = {
  occurrenceKey?: unknown;
  templateId?: unknown;
  roomIds?: unknown;
  sourceType?: unknown;
};

const OCCURRENCE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The occurrence key a stored chore holds: its `occurrenceKey` when written,
 * else, for a generated chore written before the key existed, the key
 * recovered from its deterministic id (`recurringChoreId` embeds the
 * original day, which survives a move to another day). One-time chores
 * (`sourceType` set) and chores whose id is not a generated id have none.
 * @param {string} id Chore document id.
 * @param {OccurrenceSource} chore Stored chore fields.
 * @return {string | null} Occurrence key, or null.
 */
export const storedOccurrenceKey = (
  id: string,
  chore: OccurrenceSource,
): string | null => {
  if (typeof chore.occurrenceKey === "string" && chore.occurrenceKey) {
    return chore.occurrenceKey;
  }
  if (chore.sourceType !== undefined && chore.sourceType !== null) return null;
  if (typeof chore.templateId !== "string" || !chore.templateId) return null;
  const rooms = Array.isArray(chore.roomIds) ? chore.roomIds : [];
  if (rooms.length > 1) return null;
  const roomId = typeof rooms[0] === "string" && rooms[0] ?
    rooms[0] : "general";
  const prefix = `${stableSlugify(`${chore.templateId}-${roomId}`)}-`;
  if (!id.startsWith(prefix)) return null;
  const day = id.slice(prefix.length, prefix.length + 10);
  const next = id.charAt(prefix.length + 10);
  if (!OCCURRENCE_DAY.test(day) || (next !== "" && next !== "-")) return null;
  return choreOccurrenceKey(chore.templateId, roomId, day);
};
