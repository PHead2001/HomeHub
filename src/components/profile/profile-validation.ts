/** Pure profile checks (tests/unit/household-profile.test.ts). */

/** Image types Storage accepts for avatars (storage.rules `isImage`). */
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export const AVATAR_ACCEPT = AVATAR_TYPES.join(',');
/** storage.rules allow avatars up to 5 MB. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Inline message for a chosen avatar file, or null when it can be uploaded. */
export function avatarFileError(file: { type: string; size: number }): string | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return 'Choose a JPG, PNG, GIF or WebP image.';
  if (file.size > AVATAR_MAX_BYTES) return 'That photo is over 5 MB. Choose a smaller one.';
  return null;
}
