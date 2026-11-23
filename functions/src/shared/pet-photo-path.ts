// Which Storage object a pet's photo is (PE-21e, PE-21f), shared by the web
// app (src/lib/pets/profile.ts re-exports these) and the server-side pet
// delete (./pet-delete.ts), so a replaced or deleted photo is removed only
// when it really is that pet's. Pure; no SDK.

/**
 * The folder a pet's photos are uploaded to.
 * @param {string} householdId The household.
 * @param {string} petId The pet.
 * @return {string} `households/{h}/pets/{petId}/`.
 */
export const petPhotoFolder = (householdId: string, petId: string): string =>
  `households/${householdId}/pets/${petId}/`;

/**
 * The Storage path of a Firebase download URL
 * (`…/v0/b/<bucket>/o/<encoded path>?…`, production or emulator), or null
 * for anything else (an empty value, the legacy placehold.co placeholder,
 * another host's URL).
 * @param {unknown} url The stored photo URL.
 * @param {string | null} bucket When given, the URL must name this bucket.
 * @return {string | null} The object path, or null.
 */
export const storagePathOfUrl = (
  url: unknown, bucket?: string | null,
): string | null => {
  if (typeof url !== "string" || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
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
  if (!path || path.includes("..") || path.startsWith("/")) return null;
  return path;
};

export type PhotoScope = {
  householdId: string;
  petId: string;
  bucket?: string | null;
  otherPetPhotoUrls?: readonly unknown[];
};

/**
 * The Storage object a pet's photo URL may be deleted as (PE-21f), or null
 * when it must stay: only a photo inside this pet's own folder
 * (`households/{h}/pets/{petId}/…`), or a legacy photo directly in the
 * household's pets folder (`households/{h}/pets/<file>`, before per-pet
 * folders) that no other pet references. Never a placeholder, another pet's
 * folder, another household's path or another bucket.
 * @param {unknown} url The stored photo URL.
 * @param {PhotoScope} scope The household, pet, bucket and other pets' URLs.
 * @return {string | null} The deletable object path, or null.
 */
export const ownedPhotoPath = (
  url: unknown, scope: PhotoScope,
): string | null => {
  const path = storagePathOfUrl(url, scope.bucket);
  if (!path) return null;
  const petsFolder = `households/${scope.householdId}/pets/`;
  if (!path.startsWith(petsFolder)) return null;
  if (path.startsWith(petPhotoFolder(scope.householdId, scope.petId))) {
    return path;
  }
  const rest = path.slice(petsFolder.length);
  if (!rest || rest.includes("/")) return null;
  const shared = (scope.otherPetPhotoUrls ?? []).some((other) =>
    storagePathOfUrl(other, scope.bucket) === path);
  return shared ? null : path;
};
