import { createHash } from 'node:crypto';
import { itemNameKey } from './items';

/**
 * The `shopping-usuals` document id for a bought name (SH-32). Only the server
 * derives it (the put-away transaction, `applyTrip`); clients address a usual
 * by the id they read from its snapshot. Node-only (`node:crypto`): never
 * import it from client code.
 *
 * - A short name key keeps a readable id: `encodeURIComponent(nameKey)` when
 *   that is at most `READABLE_ID_MAX` characters, a valid document id and has
 *   no `~` (which `encodeURIComponent` leaves as is).
 * - Any other key gets `<readable prefix>~<digest>`: the first 60 characters of
 *   the encoded key (never cutting an escape) and 128 bits of the SHA-256 of
 *   the FULL name key, in hex. Two names sharing a long prefix get different
 *   ids, and a digested id always contains `~` while a readable one never
 *   does, so the two kinds cannot collide. At most 60 + 1 + 32 bytes.
 */
export const READABLE_ID_MAX = 100;
const PREFIX_MAX = 60;

const validDocId = (value: string) => value.length > 0 && value !== '.' && value !== '..' && !/^__.*__$/.test(value) && !value.includes('/');

/** 128 bits of the SHA-256 of a name key (UTF-8), in hex. */
export function usualDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
}

export function usualId(name: string): string | null {
  const key = itemNameKey(name);
  if (!key) return null;
  const encoded = encodeURIComponent(key);
  if (encoded.length <= READABLE_ID_MAX && !encoded.includes('~') && validDocId(encoded)) return encoded;
  const prefix = encoded.slice(0, PREFIX_MAX).replace(/%[0-9A-F]?$/i, '');
  return `${prefix}~${usualDigest(key)}`;
}
