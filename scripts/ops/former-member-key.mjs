// Opaque identity for a person who has left a household and is known on older
// chores only by email (member privacy release D). scripts/ops/scrub-member-emails.mjs
// stores it in place of that email, as `assignedToUid` or `completedByUid`, so
// the yearly chore stats and Home Wrapped keep crediting that person's
// completions (under `choreStatsMemberKey(key)`) once the email is gone.
//
// The key is an HMAC-SHA-256 of the lower-cased email under a random secret kept
// per household in `households/{id}/ops/former-members` (`{ secret, createdAt }`).
// Only the server can read that document (the rules deny every client read and
// write under `ops`), so housemates cannot recompute or confirm an email from a
// key, and the same person gets the same key in every run of the scrub. The
// script stores the secret only once a household needs its first key. No
// Firebase imports: the document is read and created through the reference
// passed in, so tests can use a fake.

import { createHmac, randomBytes } from 'node:crypto';

/** Prefix of every former-member key. Firebase Auth uids never contain "-". */
export const FORMER_KEY_PREFIX = 'former-';

const ALREADY_EXISTS = 6;
const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * The former-member key for one email in one household.
 * @param {string} secret The household's secret (from formerMemberSecret).
 * @param {string} email The email the chore names.
 * @returns {string} `former-` and 24 hex characters; '' for an empty email.
 */
export function formerMemberKey(secret, email) {
  const normalized = text(email).toLowerCase();
  if (!normalized || !secret) return '';
  return FORMER_KEY_PREFIX + createHmac('sha256', secret).update(normalized).digest('hex').slice(0, 24);
}

/**
 * The household's former-member secret: the stored one, else (`create`) the
 * `candidate` (or a new random one) stored there, else a random one that is not
 * stored (a dry run, or a run that has not needed a key yet). Two runs creating
 * it at once both end up with the stored one.
 * @param {{ get: () => Promise<any>, create: (data: any) => Promise<unknown> }} ref
 *   `households/{id}/ops/former-members`.
 * @param {{ create: boolean, candidate?: string, now?: () => unknown }} options `now` makes the stored `createdAt`.
 * @returns {Promise<{ secret: string, stored: boolean, created: boolean }>}
 */
export async function formerMemberSecret(ref, { create, candidate, now = () => new Date() }) {
  const existing = await ref.get();
  const stored = existing.exists ? text(existing.get('secret')) : '';
  if (stored) return { secret: stored, stored: true, created: false };
  const secret = text(candidate) || randomBytes(32).toString('base64');
  if (!create) return { secret, stored: false, created: false };
  try {
    await ref.create({ secret, createdAt: now() });
    return { secret, stored: true, created: true };
  } catch (error) {
    if (error?.code !== ALREADY_EXISTS) throw error;
    const winner = text((await ref.get()).get('secret'));
    if (!winner) throw error;
    return { secret: winner, stored: true, created: false };
  }
}
