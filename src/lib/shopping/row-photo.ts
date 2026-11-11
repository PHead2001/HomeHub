/**
 * Which photo a shopping row shows. A scan stores the library photo's URL on the
 * item, but the Barcode Library is the one source of truth: when a product's photo
 * is replaced or removed (and its Storage object deleted), rows must follow the
 * library instead of pointing at a deleted object. Pure; unit tested in
 * tests/unit/shopping-scan-tick.test.ts.
 *
 * - While the library is not known (loading, or its read failed): the stored URL.
 * - An item whose barcode is in the library: that product's current photo (none
 *   when the product has no photo).
 * - Otherwise: the stored URL, unless it is one of this household's managed
 *   library photos (its product is gone, so the object is deleted or will be).
 */
export function rowPhoto(
  item: { barcode?: string; imageUrl?: string },
  library: ReadonlyMap<string, { imageUrl?: string }> | null,
  isManagedLibraryPhoto: (url: string) => boolean,
): string | null {
  const stored = item.imageUrl || null;
  if (!library) return stored;
  const entry = item.barcode ? library.get(item.barcode) : undefined;
  if (entry) return entry.imageUrl || null;
  if (stored && isManagedLibraryPhoto(stored)) return null;
  return stored;
}
