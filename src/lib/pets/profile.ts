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

/**
 * The toast text after a delete (D-P12). `finishing`: the pet is gone but the
 * server stopped before its histories and photos were all removed; the hourly
 * upkeep finishes them (functions/src/shared/pet-delete.ts), so the person is
 * told that, not asked to retry a pet that has left every list.
 */
export function petDeletedMessage(name: string, status: 'deleted' | 'already' | 'finishing'): string {
  if (status === 'finishing') return `${name} has been removed. Their history and photos finish clearing on their own within the hour.`;
  return `${name} and everything logged for them have been removed.`;
}

// The photo-path rules are shared with the server-side delete and the hourly
// upkeep that resumes an interrupted one (functions/src/shared/pet-photo-path.ts).
export { ownedPhotoPath, petPhotoFolder, storagePathOfUrl } from '../../../functions/src/shared/pet-photo-path';

/** Hosts `next.config` lets `next/image` optimize; any other photo is drawn unoptimized. */
const OPTIMIZED_HOSTS = new Set(['firebasestorage.googleapis.com', 'placehold.co', 'lh3.googleusercontent.com']);

/**
 * Whether `next/image` may optimize a photo URL: same-origin paths and the
 * configured https hosts. Anything else (the Storage emulator's
 * `http://127.0.0.1:9199/…` download URLs, another host) is passed through
 * unoptimized, since `next/image` throws on an unconfigured host and would
 * take the whole Pets view down with it.
 */
export function canOptimizePetPhoto(url: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && OPTIMIZED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
