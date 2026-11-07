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

export const recurringChoreId = (
  templateId: string,
  roomId: string,
  day: string,
  assignedToEmail: string,
): string => stableSlugify(`${templateId}-${roomId}-${day}-${assignedToEmail}`);

/**
 * Map key for one assignee in yearly chore stats. Emails cannot be Firestore
 * map keys (they contain dots), so the lower-cased email is hashed, with a
 * readable slug of its local part in front: "sam-member-1x2y3z".
 * @param {string} email Assignee email.
 * @return {string} Stable, field-path-safe key.
 */
export const choreStatsAssigneeKey = (email: string): string => {
  const normalized = email.trim().toLowerCase();
  const slug = stableSlugify(normalized.split("@")[0] || "member")
    .replace(/-/g, "_").slice(0, 24) || "member";
  return `${slug}_${hashIdentity(normalized)}`;
};
