// PIN hashing (docs/modules/devices/README.md, "PINs", S7). Server code only; it has
// no `server-only` import so the unit suite can hash with the production parameters
// (a wrong `maxmem` makes Node refuse N=2^15, r=8 with ERR_CRYPTO_INVALID_SCRYPT_PARAMS).
// Never import it from client code.

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Stored with every hash, so parameters can change later without breaking old hashes. */
export const PIN_SCRYPT_PARAMS = { alg: 'scrypt', N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 } as const;
export type PinHashParams = { alg: 'scrypt'; N: number; r: number; p: number; keyLen: number; maxmem: number };

const PEPPER_ID = /^[A-Za-z0-9]{1,32}$/;
const PEPPER_MIN_LENGTH = 32;

export type PepperEnv = Record<string, string | undefined>;

/** The id new hashes use (`HOMEHUB_PIN_PEPPER_CURRENT`), or null when not configured. */
export const currentPepperId = (env: PepperEnv = process.env): string | null => {
  const id = env.HOMEHUB_PIN_PEPPER_CURRENT?.trim();
  return id && PEPPER_ID.test(id) && pepperFor(id, env) ? id : null;
};

/** The secret `HOMEHUB_PIN_PEPPER_<id>` (at least 32 characters), or null when missing. */
export const pepperFor = (id: unknown, env: PepperEnv = process.env): Buffer | null => {
  if (typeof id !== 'string' || !PEPPER_ID.test(id)) return null;
  const value = env[`HOMEHUB_PIN_PEPPER_${id}`];
  return typeof value === 'string' && value.length >= PEPPER_MIN_LENGTH ? Buffer.from(value, 'utf8') : null;
};

export const newPinSalt = () => randomBytes(16);

/**
 * `scrypt(HMAC-SHA256(pepper, pin), salt, keyLen, { N, r, p, maxmem })`, async (the
 * synchronous form would block the event loop for about 75 ms per hash).
 */
export const hashPinValue = (pin: string, salt: Buffer, pepper: Buffer, params: PinHashParams = PIN_SCRYPT_PARAMS): Promise<Buffer> => {
  const keyed = createHmac('sha256', pepper).update(pin, 'utf8').digest();
  return new Promise((resolve, reject) => {
    scrypt(keyed, salt, params.keyLen, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
};

/** Constant-time comparison of two hashes. */
export const hashesEqual = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/** Stored params, falling back to the production ones for anything malformed. */
export const readPinParams = (value: unknown): PinHashParams => {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const int = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : fallback);
  return {
    alg: 'scrypt',
    N: int(v.N, PIN_SCRYPT_PARAMS.N),
    r: int(v.r, PIN_SCRYPT_PARAMS.r),
    p: int(v.p, PIN_SCRYPT_PARAMS.p),
    keyLen: int(v.keyLen, PIN_SCRYPT_PARAMS.keyLen),
    maxmem: int(v.maxmem, PIN_SCRYPT_PARAMS.maxmem),
  };
};
