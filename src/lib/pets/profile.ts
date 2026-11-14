/**
 * Pet profile helpers (P5), pure: pet ids that are not names (PE-30), the
 * duplicate-name check, the optional vet contact (PE-28a, D-P10) and which
 * Storage object a pet's photo is, so a replaced or deleted photo is removed
 * only when it really is that pet's (PE-21f).
 */

/* ------------------------------------------------------------------------- */
/* Identity and names (PE-30)                                                 */
/* ------------------------------------------------------------------------- */

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A new pet's document id: random, never derived from the name, so two pets
 * with the same name never write the same document and a rename never needs a
 * new id. Existing pets keep their (slug) ids. Taken once per Add dialog, so a
 * double submit or a retry writes the same pet.
 */
export function newPetId(): string {
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  return `pet-${Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`;
}

/** A pet id a client may name (a Firestore document id, no path tricks). */
export function isPetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('/') && value !== '.' && value !== '..' && !/^__.*__$/.test(value);
}

const nameKey = (name: string) => name.trim().toLocaleLowerCase('en-US');

/** The other pet already using a name (case-insensitive, trimmed), or null. `selfId` is excluded (a rename). */
export function duplicatePetName<T extends { id: string; name?: unknown }>(name: string, pets: readonly T[], selfId?: string | null): T | null {
  const key = nameKey(name);
  if (!key) return null;
  return pets.find((pet) => pet.id !== selfId && typeof pet.name === 'string' && nameKey(pet.name) === key) ?? null;
}

/** The names a form checks a draft against: every other pet's. */
export function otherPetNames(pets: readonly { id: string; name: string }[], selfId?: string | null): string[] {
  return pets.filter((pet) => pet.id !== selfId).map((pet) => pet.name);
}

/** Raised when a fresh read finds the name taken (another session added or renamed a pet meanwhile). */
export class DuplicatePetNameError extends Error {
  constructor(readonly petName: string) {
    super(`You already have a pet named ${petName}.`);
    this.name = 'DuplicatePetNameError';
  }
}

/* ------------------------------------------------------------------------- */
/* Vet contact (PE-28a)                                                       */
/* ------------------------------------------------------------------------- */

export const VET_TEXT_MAX = 80;
export const VET_PHONE_MAX = 30;
/** Digits, spaces, brackets, dots and dashes, an optional leading +; rules check the same shape. */
const PHONE_SHAPE = /^\+?[0-9 ().-]{3,30}$/;

export type VetDraft = { vetName: string; vetClinic: string; vetPhone: string };
export type VetErrors = Partial<Record<keyof VetDraft, string>>;
export const EMPTY_VET: VetDraft = { vetName: '', vetClinic: '', vetPhone: '' };

export function vetDraftFrom(pet: { vetName?: unknown; vetClinic?: unknown; vetPhone?: unknown }): VetDraft {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return { vetName: text(pet.vetName), vetClinic: text(pet.vetClinic), vetPhone: text(pet.vetPhone) };
}

/** Each field is optional; a phone needs at least three digits. Unchanged stored values are exempt. */
export function validateVet(draft: VetDraft, original?: VetDraft): VetErrors {
  const errors: VetErrors = {};
  const unchanged = (field: keyof VetDraft) => original !== undefined && draft[field].trim() === original[field].trim();
  for (const field of ['vetName', 'vetClinic'] as const) {
    if (draft[field].trim().length > VET_TEXT_MAX && !unchanged(field)) errors[field] = `Keep it under ${VET_TEXT_MAX + 1} characters.`;
  }
  const phone = draft.vetPhone.trim();
  if (phone && !unchanged('vetPhone')) {
    const digits = phone.replace(/\D/g, '').length;
    if (!PHONE_SHAPE.test(phone) || digits < 3) errors.vetPhone = 'Use digits, spaces, brackets or dashes, e.g. (512) 555-0134.';
  }
  return errors;
}

/** Firestore values for the vet fields: trimmed text, or null to remove a cleared field. */
export function vetFields(draft: VetDraft): Record<keyof VetDraft, string | null> {
  const value = (text: string) => text.trim() || null;
  return { vetName: value(draft.vetName), vetClinic: value(draft.vetClinic), vetPhone: value(draft.vetPhone) };
}

/** A `tel:` link for a stored phone (digits and a leading +), or null when it has too few digits. */
export function telHref(phone: unknown): string | null {
  if (typeof phone !== 'string') return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 3) return null;
  return `tel:${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

export function hasVetContact(pet: { vetName?: unknown; vetClinic?: unknown; vetPhone?: unknown }): boolean {
  return [pet.vetName, pet.vetClinic, pet.vetPhone].some((value) => typeof value === 'string' && value.trim().length > 0);
}

/* ------------------------------------------------------------------------- */
/* Photos in Storage (PE-21e, PE-21f)                                         */
/* ------------------------------------------------------------------------- */

/** Pet photos are at most this size after the shared downscale (the barcode library's cap). */
export const PET_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** The folder a pet's photos are uploaded to. */
export function petPhotoFolder(householdId: string, petId: string): string {
  return `households/${householdId}/pets/${petId}/`;
}

/**
 * The Storage path of a Firebase download URL (`…/v0/b/<bucket>/o/<encoded path>?…`,
 * production or emulator), or null for anything else (an empty value, the legacy
 * placehold.co placeholder, another host's URL).
 */
export function storagePathOfUrl(url: unknown, bucket?: string | null): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const match = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return null;
  if (bucket && decodeURIComponent(match[1]) !== bucket) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!path || path.includes('..') || path.startsWith('/')) return null;
  return path;
}

/**
 * The Storage object a pet's photo URL may be deleted as (PE-21f), or null when
 * it must stay: only a photo inside this pet's own folder
 * (`households/{h}/pets/{petId}/…`), or a legacy photo directly in the
 * household's pets folder (`households/{h}/pets/<file>`, before per-pet
 * folders) that no other pet references. Never a placeholder, another pet's
 * folder, another household's path or another bucket.
 */
export function ownedPhotoPath(
  url: unknown,
  scope: { householdId: string; petId: string; bucket?: string | null; otherPetPhotoUrls?: readonly unknown[] },
): string | null {
  const path = storagePathOfUrl(url, scope.bucket);
  if (!path) return null;
  const petsFolder = `households/${scope.householdId}/pets/`;
  if (!path.startsWith(petsFolder)) return null;
  if (path.startsWith(petPhotoFolder(scope.householdId, scope.petId))) return path;
  const rest = path.slice(petsFolder.length);
  if (!rest || rest.includes('/')) return null;
  const shared = (scope.otherPetPhotoUrls ?? []).some((other) => storagePathOfUrl(other, scope.bucket) === path);
  return shared ? null : path;
}
