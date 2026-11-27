/**
 * Profile photos (PR-9). Every new photo is redrawn in the browser before upload:
 * at most 512 px on its longer edge (audit 16.4: avatars 512 px), re-encoded (which
 * also drops EXIF metadata such as GPS location), with the file extension taken
 * from the encoded type rather than the original file name. HEIC, HEIF and AVIF are
 * accepted where the browser can decode them (Safari reads HEIC) and become JPEG.
 * After a successful save, the previous photo is deleted when it is one of this
 * person's own uploads. Pure; tests/unit/profile-avatar.test.ts.
 */

/** Longer edge of a stored profile photo. */
export const AVATAR_MAX_EDGE = 512;

/** What may be picked: the uploadable types plus formats the browser converts. */
export const PROFILE_PHOTO_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif',
] as const;
export const PROFILE_PHOTO_ACCEPT = [...PROFILE_PHOTO_TYPES, '.heic', '.heif'].join(',');
/** A picked original may be large; what is uploaded is the 512 px copy. */
export const PROFILE_PHOTO_SOURCE_MAX_BYTES = 25 * 1024 * 1024;

const HEIC_NAME = /\.(heic|heif)$/i;

/**
 * Inline message for a picked photo, or null when it can be converted. Some
 * browsers report HEIC with an empty type, so the file name decides then.
 */
export function profilePhotoError(file: { type: string; size: number; name?: string }): string | null {
  const type = file.type.toLowerCase();
  const known = (PROFILE_PHOTO_TYPES as readonly string[]).includes(type) || (!type && HEIC_NAME.test(file.name ?? ''));
  if (!known) return 'Choose a photo: JPG, PNG, GIF, WebP or HEIC.';
  if (file.size > PROFILE_PHOTO_SOURCE_MAX_BYTES) return 'That photo is over 25 MB. Choose a smaller one.';
  return null;
}

/** The file extension for an encoded photo's type (never the picked file's name). */
export function avatarExtensionFor(type: string): 'jpg' | 'png' | 'webp' | 'gif' {
  switch (type.toLowerCase()) {
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'jpg';
  }
}

/**
 * The Storage path of a profile photo URL when it is one of this person's own
 * uploads (`users/{uid}/avatars/...` or the older `users/{email}/avatars/...`), so it
 * may be deleted after a replacement; null for anything else (the Google account
 * photo, another person's file, another bucket, a malformed URL).
 */
export function ownAvatarPath(
  url: string | null | undefined,
  owner: { uid: string; email?: string | null },
  bucket?: string | null,
): string | null {
  if (typeof url !== 'string' || !url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return null;
  if (bucket && decodeURIComponent(match[1]) !== bucket) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (path.includes('..') || path.includes('//')) return null;
  const folders = [owner.uid, owner.email].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return folders.some((folder) => path.startsWith(`users/${folder}/avatars/`) && path.length > `users/${folder}/avatars/`.length)
    ? path
    : null;
}
