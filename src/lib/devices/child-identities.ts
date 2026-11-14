// Kid profiles (child identities): shared, pure helpers (docs/modules/devices/README.md,
// "Actors"). Used by the server (`src/lib/server/child-identities.ts`) and the Members
// tab dialog.

export const CHILD_NAME_MAX = 40;
export const CHILD_UID_PREFIX = 'kid_';

/** `kid_` + a 20-character Firestore auto id. */
export const isChildIdentityUid = (value: unknown): value is string =>
  typeof value === 'string' && /^kid_[A-Za-z0-9]{20}$/.test(value);

/** A kid profile's name: 1-40 characters after trimming, never an email address. */
export const readChildName = (value: unknown): string | null => {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > CHILD_NAME_MAX || /\S+@\S+/.test(name)) return null;
  return name;
};

/** Storage path of a kid profile photo. */
export const kidAvatarPath = (householdId: string, childId: string, fileName: string) =>
  `households/${householdId}/members/${childId}/avatar/${fileName}`;

/**
 * The Storage object path of a Firebase Storage download URL in the app's own bucket
 * (`NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`), or null. Production URLs only
 * (`https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>`); with the emulators
 * on, the local Storage emulator's URLs too.
 */
export const kidAvatarPathOf = (
  url: unknown,
  expectedBucket: string | undefined = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
): string | null => {
  // Only the app's own Storage bucket; without one configured nothing is accepted.
  if (!expectedBucket) return null;
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const production = parsed.protocol === 'https:' && parsed.hostname === 'firebasestorage.googleapis.com';
  const emulator = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true' &&
    parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (!production && !emulator) return null;
  const match = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return null;
  try {
    if (decodeURIComponent(match[1]) !== expectedBucket) return null;
    const path = decodeURIComponent(match[2]);
    return /^households\/[^/]+\/members\/kid_[A-Za-z0-9]{20}\/avatar\/[^/]+$/.test(path) ? path : null;
  } catch {
    return null;
  }
};
