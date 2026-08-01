const decodeStoragePath = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function getManagedBarcodeImagePath({
  householdId,
  imagePath,
  imageUrl,
}: {
  householdId: string;
  imagePath?: string;
  imageUrl?: string;
}) {
  const prefix = `households/${householdId}/barcode-library/`;
  if (imagePath?.startsWith(prefix)) return imagePath;
  if (!imageUrl) return null;
  if (imageUrl.startsWith(prefix)) return imageUrl;

  if (imageUrl.startsWith('gs://')) {
    const path = imageUrl.slice('gs://'.length).split('/').slice(1).join('/');
    return path.startsWith(prefix) ? path : null;
  }

  try {
    const url = new URL(imageUrl);
    const objectMarker = '/o/';
    const markerIndex = url.pathname.indexOf(objectMarker);
    if (markerIndex === -1) return null;
    const path = decodeStoragePath(url.pathname.slice(markerIndex + objectMarker.length));
    return path.startsWith(prefix) ? path : null;
  } catch {
    return null;
  }
}
