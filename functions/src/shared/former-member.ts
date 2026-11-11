// The former-member key of an email in one household: `former-` and 24 hex
// characters, an HMAC-SHA-256 of the lower-cased email under the household's
// random secret (`households/{id}/ops/former-members`, which no client can
// read). Twin of `formerMemberKey` in scripts/ops/former-member-key.mjs (a
// unit test checks they agree): a departure records the leaver's uid under
// this key, and the ops scripts read it as a settled identity.
import {createHmac} from "node:crypto";

/** Prefix of every former-member key. Firebase Auth uids never contain "-". */
export const FORMER_KEY_PREFIX = "former-";

/**
 * The former-member key for one email in one household.
 * @param {string} secret The household's secret.
 * @param {string} email The email.
 * @return {string} The key; "" for an empty email or secret.
 */
export const formerMemberKey = (secret: string, email: string): string => {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized || !secret) return "";
  return FORMER_KEY_PREFIX + createHmac("sha256", secret)
    .update(normalized).digest("hex").slice(0, 24);
};
