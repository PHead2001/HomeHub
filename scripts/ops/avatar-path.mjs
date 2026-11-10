// Pure decisions for migrate-avatars-to-uid.mjs. No Firebase imports, so
// tests/unit/identity-avatar-path.test.ts can cover them.
//
// Uploaded profile photos used to be stored under the email
// (`users/{email}/avatars/{file}`), so their download URL, which is copied to
// the profile and to every membership record, carried the email. New uploads
// go to `users/{uid}/avatars/{file}`; the migration copies older files there
// and points `users/{email}.avatarUrl` and member `avatarUrl` at the copy.

const STORAGE_HOST = 'firebasestorage.googleapis.com';

/**
 * The bucket and object path of a Firebase Storage download URL
 * (`https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encoded path}?alt=media&token=...`).
 * @param {unknown} url
 * @returns {{ bucket: string, path: string } | null} Null for anything else (Google photos, other hosts).
 */
export function parseStorageDownloadUrl(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== STORAGE_HOST) return null;
  const match = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return null;
  try {
    return { bucket: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

/**
 * The Firebase Storage download URL of an object with a download token.
 * @param {string} bucket
 * @param {string} path
 * @param {string} token
 */
export function storageDownloadUrl(bucket, path, token) {
  return `https://${STORAGE_HOST}/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?alt=media&token=${encodeURIComponent(token)}`;
}

const AVATAR_PATH = /^users\/([^/]+)\/avatars\/(.+)$/;

/**
 * What the migration does with one stored photo URL.
 * @param {unknown} url `avatarUrl` of a profile or membership record.
 * @param {{ buckets: ReadonlySet<string>, uidByEmail: ReadonlyMap<string, string> }} context
 *   `buckets`: the project's Storage buckets; `uidByEmail`: lower-cased email to uid.
 * @returns {{ kind: 'none' | 'external' | 'uid-path' | 'no-uid' } | { kind: 'migrate', bucket: string, fromPath: string, toPath: string }}
 *   - `none`: no photo;
 *   - `external`: not an uploaded photo in this project (for example the Google account photo);
 *   - `uid-path`: already under the account ID;
 *   - `no-uid`: under an email nobody's uid is known for; left alone;
 *   - `migrate`: copy `fromPath` to `toPath` (same file name under the uid) and point the URL there.
 */
export function avatarMigrationDecision(url, { buckets, uidByEmail }) {
  if (typeof url !== 'string' || !url.trim()) return { kind: 'none' };
  const location = parseStorageDownloadUrl(url);
  if (!location || !buckets.has(location.bucket)) return { kind: 'external' };
  const match = AVATAR_PATH.exec(location.path);
  if (!match) return { kind: 'external' };
  const [, owner, file] = match;
  if (!owner.includes('@')) return { kind: 'uid-path' };
  const uid = uidByEmail.get(owner.trim().toLowerCase());
  if (!uid) return { kind: 'no-uid' };
  return { kind: 'migrate', bucket: location.bucket, fromPath: location.path, toPath: `users/${uid}/avatars/${file}` };
}

/**
 * The first download token in an object's custom metadata, or null.
 * @param {Record<string, unknown> | undefined | null} metadata `metadata.metadata` of a Storage object.
 */
export function firstDownloadToken(metadata) {
  const raw = metadata?.firebaseStorageDownloadTokens;
  if (typeof raw !== 'string') return null;
  const token = raw.split(',').map(part => part.trim()).find(Boolean);
  return token || null;
}

/**
 * Email (lower-cased) to uid, from profiles (`users/{email}.uid`) and
 * membership records (`members/{uid}.email`). The first uid seen for an email
 * wins; an email that maps to two different uids is dropped (ambiguous).
 * @param {Array<{ email?: unknown, uid?: unknown }>} entries
 * @returns {Map<string, string>}
 */
export function uidsByEmail(entries) {
  const found = new Map();
  const ambiguous = new Set();
  for (const entry of entries) {
    const email = typeof entry?.email === 'string' ? entry.email.trim().toLowerCase() : '';
    const uid = typeof entry?.uid === 'string' ? entry.uid.trim() : '';
    if (!email || !uid || uid.includes('@')) continue;
    const known = found.get(email);
    if (known && known !== uid) ambiguous.add(email);
    else found.set(email, uid);
  }
  for (const email of ambiguous) found.delete(email);
  return found;
}
