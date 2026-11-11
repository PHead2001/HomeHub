/**
 * Barcode Library writes (BL-3, BL-4, BL-10). Pure builders, unit tested in
 * tests/unit/barcode-library.test.ts; the Firestore calls live in
 * src/components/barcode-library-client.tsx.
 *
 * - Add is create-only: it never replaces an existing product (the client checks
 *   in a transaction, and the rules refuse an update that writes `createdAt`).
 *   A new product records `createdByUid` (the writer).
 * - Edit is an update of only what changed (name, photo); it never writes
 *   `createdAt` or `createdByUid`.
 * - The photo is optional: a product can be just a barcode and a name.
 */

export type ProductPhoto = { imageUrl: string; imagePath?: string };

export type NewProductData = {
  name: string;
  imageUrl: string;
  imagePath?: string;
  createdAt: string;
  createdByUid: string;
};

/** Library name limit (the rules allow 200; the form keeps 120). */
export const MAX_PRODUCT_NAME_LENGTH = 120;

export function productName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_PRODUCT_NAME_LENGTH).trim();
}

/** The document a new product is created with. */
export function newProductData({ name, photo, uid, now }: { name: string; photo: ProductPhoto | null; uid: string; now: Date }): NewProductData {
  return {
    name: productName(name),
    imageUrl: photo?.imageUrl ?? '',
    ...(photo?.imagePath ? { imagePath: photo.imagePath } : {}),
    createdAt: now.toISOString(),
    createdByUid: uid,
  };
}

/**
 * The document an Undo of a delete re-creates (only while the code is still
 * free). It keeps the name, photo and date; `createdByUid` is the restorer,
 * because a create must name its writer. With `photoGone` (the photo's delayed
 * delete already ran) the product comes back without a photo rather than
 * pointing at a deleted object.
 */
export function restoredProductData(
  item: { name: string; imageUrl?: string; imagePath?: string; createdAt?: string },
  uid: string,
  now: Date,
  { photoGone = false }: { photoGone?: boolean } = {},
): NewProductData {
  if (photoGone) return restoredProductData({ name: item.name, imageUrl: '', createdAt: item.createdAt }, uid, now);
  const createdAt = typeof item.createdAt === 'string' && item.createdAt && item.createdAt.length <= 40 ? item.createdAt : now.toISOString();
  return {
    name: item.name,
    imageUrl: item.imageUrl ?? '',
    ...(item.imagePath ? { imagePath: item.imagePath } : {}),
    createdAt,
    createdByUid: uid,
  };
}

export type PhotoChange = { kind: 'keep' } | { kind: 'remove' } | { kind: 'replace'; photo: ProductPhoto };

export type ProductEdit = {
  /** Fields to update (only changed ones). */
  set: { name?: string; imageUrl?: string; imagePath?: string };
  /** Whether `imagePath` must be removed (the photo was removed or replaced by one without a path). */
  removeImagePath: boolean;
  /** Whether anything changes at all. */
  changed: boolean;
};

/** The update for an edit: never `createdAt` or `createdByUid`. */
export function productEdit(
  existing: { name: string; imageUrl?: string; imagePath?: string },
  next: { name: string; photo: PhotoChange },
): ProductEdit {
  const set: ProductEdit['set'] = {};
  const name = productName(next.name);
  if (name && name !== existing.name) set.name = name;
  let removeImagePath = false;
  if (next.photo.kind === 'remove') {
    if (existing.imageUrl) set.imageUrl = '';
    removeImagePath = Boolean(existing.imagePath);
  } else if (next.photo.kind === 'replace') {
    set.imageUrl = next.photo.photo.imageUrl;
    if (next.photo.photo.imagePath) set.imagePath = next.photo.photo.imagePath;
    else removeImagePath = Boolean(existing.imagePath);
  }
  return { set, removeImagePath, changed: Object.keys(set).length > 0 || removeImagePath };
}

/**
 * The managed photo an edit leaves unused (to delete after the edit is saved),
 * or null. `managed` maps a stored image to its household Storage path.
 */
export function staleProductPhoto(
  existing: { imageUrl?: string; imagePath?: string },
  photo: PhotoChange,
  managed: (image: { imageUrl?: string; imagePath?: string }) => string | null,
): string | null {
  if (photo.kind === 'keep') return null;
  const previous = managed(existing);
  if (!previous) return null;
  if (photo.kind === 'replace' && managed(photo.photo) === previous) return null;
  return previous;
}

/** Inline copy when Add finds the code already saved (BL-3). */
export function alreadySavedCopy(name: string): string {
  return `This barcode is already saved as ${name}. Edit it instead?`;
}

/** Reads `?add=<barcode>` (the "Save to library" link from a scan): 6 to 32 digits or null. */
export function barcodeToAdd(search: string): string | null {
  const value = new URLSearchParams(search).get('add')?.trim() ?? '';
  return /^\d{6,32}$/.test(value) ? value : null;
}

/** The library link a scan of an unknown code offers. */
export function saveToLibraryHref(barcode: string): string {
  return `/library?add=${encodeURIComponent(barcode)}`;
}
