// AU-12: the Home Assistant token at rest. A long-lived token can do anything in the
// house, so when the server has a key (HOMEHUB_HA_TOKEN_KEY, 32 bytes as base64, from
// Secret Manager through apphosting.yaml) it is stored AES-256-GCM encrypted
// (`accessTokenEnc`) instead of as plain text (`accessToken`). Without a key the old
// plain field is still written and read, so nothing breaks before the secret exists.
// Node-only (node:crypto), no server-only guard so tests/unit can reach it; only
// src/lib/server/home-assistant-store.ts imports it.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'v1';

/** The key from its base64 text, or null when absent or not 32 bytes. */
export function readTokenKey(value: string | undefined | null): Buffer | null {
  if (!value) return null;
  const key = Buffer.from(value.trim(), 'base64');
  return key.length === 32 ? key : null;
}

/** `v1:<iv>:<tag>:<ciphertext>` (base64 parts), bound to the household id. */
export function encryptToken(token: string, key: Buffer, householdId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(householdId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

/** The token, or null when the text is malformed, tampered with, or for another household. */
export function decryptToken(text: string, key: Buffer, householdId: string): string | null {
  const parts = text.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
    decipher.setAAD(Buffer.from(householdId, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export type StoredToken = { accessToken?: string; accessTokenEnc?: string };

/** The fields to store for a token: encrypted when a key is set, else plain (legacy). */
export function storedTokenFields(token: string, key: Buffer | null, householdId: string): StoredToken {
  return key ? { accessTokenEnc: encryptToken(token, key, householdId) } : { accessToken: token };
}

/** The usable token from a stored document, or null when it cannot be read. */
export function readStoredToken(data: StoredToken | undefined | null, key: Buffer | null, householdId: string): string | null {
  if (!data) return null;
  if (typeof data.accessTokenEnc === 'string') return key ? decryptToken(data.accessTokenEnc, key, householdId) : null;
  return typeof data.accessToken === 'string' && data.accessToken ? data.accessToken : null;
}
