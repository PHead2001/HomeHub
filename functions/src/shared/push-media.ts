// Pure decisions for the pictures a push carries: the app icon, the badge and
// an optional rich image (a pet photo or a product photo). Kept free of
// Firebase imports so they can be unit-tested. Notification documents are
// written by clients and image fields are written by members, so nothing is
// trusted: an image is used only when it is an https download URL for an
// object in this household's own folder of the project's Storage bucket, or a
// plain image path on the app's own origin. Anything else is dropped.

import {memberCanView, type ViewPermission} from "./push-audience";

// Re-exported for callers that check who may see a picture.
export {memberCanView};
export type {ViewPermission};

/** App icon shown with every push (same file as the web manifest). */
export const PUSH_ICON = "/icons/icon-192.png";
/** Monochrome house glyph on transparency, for the Android status bar. */
export const PUSH_BADGE = "/icons/badge-96.png";

/** A Firestore document to read, relative to the household document. */
export type ImageSource = {
  /** Path segments under `households/{householdId}`. */
  path: string[];
  /** Field holding the image URL. */
  field: string;
  /** Storage folders (under the household) the image may live in. */
  folders: string[];
  /** Permission a recipient needs to see this picture in the app. */
  permission: ViewPermission;
  /** A follow-up source when this document has no usable image. */
  fallback?: (data: Record<string, unknown>) => ImageSource | null;
};

/** Reads one document by full path; resolves undefined when it is missing. */
export type DocReader = (
  path: string,
) => Promise<Record<string, unknown> | undefined>;

export type PushImage = {url: string; permission: ViewPermission};

const MAX_URL_LENGTH = 2048;
const STORAGE_HOST = "firebasestorage.googleapis.com";
const APP_IMAGE_PATH =
  /^\/(?![/\\])[A-Za-z0-9_\-/.]{1,200}\.(?:png|jpe?g|webp|gif)$/;

/**
 * Whether a value can be used as one Firestore document ID segment.
 * @param {unknown} id Candidate ID.
 * @return {boolean} True for a single, non-reserved segment.
 */
export const isDocId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[^/]{1,200}$/.test(id) &&
  id !== "." && id !== ".." &&
  !/^__.*__$/.test(id);

/**
 * Returns the image URL when it is safe to put in a push, otherwise null.
 * Allowed: an https Firebase Storage media download URL for an object at
 * `households/{householdId}/{folder}...` in `bucket`, or an image path on the
 * app's own origin. Foreign hosts, other buckets, other households, other
 * folders, credentials, ports and path tricks are refused.
 * @param {unknown} value Candidate image URL.
 * @param {object} scope Bucket, household and allowed folders.
 * @return {string | null} The URL to send, or null.
 */
export const safePushImageUrl = (
  value: unknown,
  scope: {bucket: string; householdId: string; folders: string[]},
): string | null => {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL_LENGTH) return null;

  // An image path on the app's own origin (the browser resolves it there).
  if (raw.startsWith("/")) {
    if (!APP_IMAGE_PATH.test(raw) || raw.startsWith("/api/")) return null;
    return raw.split("/").some((part) => part === "..") ? null : raw;
  }

  if (!scope.bucket || !isDocId(scope.householdId)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== STORAGE_HOST) return null;
  if (url.username || url.password || url.port || url.hash) return null;
  if (url.searchParams.get("alt") !== "media") return null;

  const match = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  let bucket: string;
  let objectPath: string;
  try {
    bucket = decodeURIComponent(match[1]);
    objectPath = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (bucket !== scope.bucket) return null;
  if (objectPath.includes("\\")) return null;
  const parts = objectPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  if (parts[0] !== "households" || parts[1] !== scope.householdId) {
    return null;
  }
  const rest = parts.slice(2).join("/");
  const inFolder = scope.folders.some((folder) =>
    rest.startsWith(folder) && rest.length > folder.length);
  return inFolder ? url.toString() : null;
};

const barcodeSource = (barcode: unknown): ImageSource | null =>
  isDocId(barcode) ? {
    path: ["barcode-library", barcode],
    field: "imageUrl",
    folders: ["barcode-library/"],
    permission: "shopping.view",
  } : null;

const firstSegment = (sourceId: string): string => sourceId.split(/[:|]/)[0];

/**
 * Finds the household record whose picture belongs on this notification.
 *
 * Contract for notification writers (`sourceType` / `sourceId`):
 * - category `pets`, sourceType `pet` or starting `pet-`/`pet_` (for example
 *   `pet_feeding`, `pet_medication`): sourceId is the pet ID, optionally
 *   followed by `:` or `|` and a state key. Uses the pet's `photoUrl`.
 * - category `shopping`, sourceType `shopping_item`/`shopping-item`: sourceId
 *   is `listId:itemId`. Uses the item's `imageUrl`, else its barcode's
 *   library image.
 * - category `shopping`, sourceType `barcode_library`/`barcode-library`/
 *   `product`: sourceId is the barcode. Uses the library item's `imageUrl`.
 * Everything else carries no image.
 * @param {Record<string, unknown>} notification The notification document.
 * @return {ImageSource | null} Where to look, or null.
 */
export const imageSourceFor = (
  notification: Record<string, unknown>,
): ImageSource | null => {
  const {category, sourceType, sourceId} = notification;
  if (typeof sourceType !== "string" || typeof sourceId !== "string") {
    return null;
  }
  const type = sourceType.toLowerCase();

  if (category === "pets" && (type === "pet" || /^pet[-_]/.test(type))) {
    const petId = firstSegment(sourceId);
    return isDocId(petId) ? {
      path: ["pets", petId],
      field: "photoUrl",
      folders: ["pets/"],
      permission: "pets.view",
    } : null;
  }

  if (category !== "shopping") return null;
  if (type === "shopping_item" || type === "shopping-item") {
    const [listId, itemId, extra] = sourceId.split(":");
    if (extra !== undefined || !isDocId(listId) || !isDocId(itemId)) {
      return null;
    }
    return {
      path: ["shopping-lists", listId, "items", itemId],
      field: "imageUrl",
      folders: ["barcode-library/"],
      permission: "shopping.view",
      fallback: (data) => barcodeSource(data.barcode),
    };
  }
  if (["barcode_library", "barcode-library", "product"].includes(type)) {
    return barcodeSource(sourceId);
  }
  return null;
};

/**
 * Resolves the rich image for a push, reading only inside the notification's
 * own household. Never throws: any failure means "no image".
 * @param {DocReader} read Reads a document by full path.
 * @param {string} householdId Household from the trigger path.
 * @param {Record<string, unknown>} notification The notification document.
 * @param {string} bucket The project's default Storage bucket.
 * @return {Promise<PushImage | null>} The image, or null.
 */
export const resolvePushImage = async (
  read: DocReader,
  householdId: string,
  notification: Record<string, unknown>,
  bucket: string,
): Promise<PushImage | null> => {
  if (!isDocId(householdId) || notification.householdId !== householdId) {
    return null;
  }
  let source = imageSourceFor(notification);
  // At most one fallback hop (shopping item -> barcode library).
  for (let hop = 0; source && hop < 2; hop++) {
    let data: Record<string, unknown> | undefined;
    try {
      data = await read(["households", householdId, ...source.path].join("/"));
    } catch {
      return null;
    }
    if (!data) return null;
    const url = safePushImageUrl(data[source.field], {
      bucket, householdId, folders: source.folders,
    });
    if (url) return {url, permission: source.permission};
    source = source.fallback ? source.fallback(data) : null;
  }
  return null;
};

/**
 * The `webpush.notification` block: app icon and badge always, the rich image
 * only when given, and a tag so a repeat display replaces rather than stacks.
 * @param {string} tag Notification document ID.
 * @param {string | null} image Safe image URL, or null.
 * @return {object} Web Push notification options.
 */
export const webpushNotification = (
  tag: string,
  image: string | null,
): {icon: string; badge: string; tag: string; image?: string} => ({
  icon: PUSH_ICON,
  badge: PUSH_BADGE,
  tag,
  ...(image ? {image} : {}),
});
