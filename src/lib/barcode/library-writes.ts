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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a create would accept this photo URL: the client's copy of
 * `validBarcodeImageUrl` in firestore.rules (a download URL of this household's
 * barcode-library folder in this project's Storage or the Storage emulator of a
 * demo- project, or an Open Food Facts image; empty means no photo). An update
 * that leaves an older URL unchanged is accepted; a create checks every field.
 */
export function photoUrlAcceptedOnCreate(householdId: string, url: string): boolean {
  if (url === '') return true;
  if (url.length > 2048) return false;
  const folder = `/o/households%2F${escapeRegExp(householdId)}%2Fbarcode-library%2F[^/?#]+([?].*)?$`;
  return new RegExp(`^https://firebasestorage[.]googleapis[.]com/v0/b/homehub-j91jb[.](appspot[.]com|firebasestorage[.]app)${folder}`).test(url)
    || new RegExp(`^http://(127[.]0[.]0[.]1|localhost):9199/v0/b/demo-[a-z0-9-]+[.]appspot[.]com${folder}`).test(url)
    || /^https:\/\/(images|static)[.]openfoodfacts[.](org|net)\/[^?#]*([?].*)?$/.test(url);
}

/** Whether a create would accept this `imagePath` (the household's barcode-library folder). */
function photoPathAcceptedOnCreate(householdId: string, path: string): boolean {
  return path.length <= 512 && new RegExp(`^households/${escapeRegExp(householdId)}/barcode-library/[^/]+$`).test(path);
}

/** What happened to the photo of a restored product. */
export type RestoredPhoto = 'restored' | 'none' | 'gone' | 'not-accepted';

/** Product names on create: non-empty, at most 200 characters (firestore.rules). */
const MAX_STORED_NAME_LENGTH = 200;

/**
 * The document an Undo of a delete re-creates (only while the code is still
 * free), checked against the create contract because the restore is a create.
 * It keeps the name, photo and date; `createdByUid` is the restorer, because a
 * create must name its writer. The product always comes back; its photo does
 * not when the photo's delayed delete already ran (`photoGone`, `'gone'`) or when
 * a create would refuse it (`'not-accepted'`: an older URL that is only kept
 * on edits), so the caller can say the photo was not restored.
 */
export function restoredProductData(
  item: { name: string; imageUrl?: string; imagePath?: string; createdAt?: string },
  { householdId, uid, now, photoGone = false }: { householdId: string; uid: string; now: Date; photoGone?: boolean },
): { data: NewProductData; photo: RestoredPhoto } {
  const createdAt = typeof item.createdAt === 'string' && item.createdAt && item.createdAt.length <= 40 ? item.createdAt : now.toISOString();
  const name = Array.from(item.name).slice(0, MAX_STORED_NAME_LENGTH).join('');
  const imageUrl = item.imageUrl ?? '';
  const photo: RestoredPhoto = !imageUrl ? 'none'
    : !photoUrlAcceptedOnCreate(householdId, imageUrl) ? 'not-accepted'
      : photoGone ? 'gone' : 'restored';
  const keepPath = photo === 'restored' && Boolean(item.imagePath) && photoPathAcceptedOnCreate(householdId, item.imagePath!);
  return {
    data: {
      name,
      imageUrl: photo === 'restored' ? imageUrl : '',
      ...(keepPath ? { imagePath: item.imagePath } : {}),
      createdAt,
      createdByUid: uid,
    },
    photo,
  };
}

/**
 * The product a delete removed, read in the same transaction as the delete (not
 * the page's possibly older copy), so the Undo restores and the delayed photo
 * cleanup targets what was actually deleted. Null when the product was already
 * gone (nothing to undo).
 */
export function capturedProduct(id: string, data: Record<string, unknown> | null | undefined): {
  id: string; name: string; imageUrl: string; imagePath?: string; createdAt?: string;
} | null {
  if (!data) return null;
  return {
    id,
    name: typeof data.name === 'string' && data.name ? data.name : 'Saved product',
    imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : '',
    ...(typeof data.imagePath === 'string' && data.imagePath ? { imagePath: data.imagePath } : {}),
    ...(typeof data.createdAt === 'string' ? { createdAt: data.createdAt } : {}),
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

/**
 * Whether Save may run. A photo still being shrunk waits; a rejected photo (too
 * large, unreadable) blocks until the member removes it or picks a valid one, so
 * a product is never saved without, or with the old instead of, the photo shown.
 */
export function productSubmitBlock({ photoBusy, photoError }: { photoBusy: boolean; photoError: string | null }): 'busy' | 'photo-rejected' | null {
  if (photoBusy) return 'busy';
  if (photoError) return 'photo-rejected';
  return null;
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
