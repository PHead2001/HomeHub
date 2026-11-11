/**
 * Shared photo downscale (BL-11, audit 16.4). Phone photos are 6 to 12 MB and
 * several thousand pixels wide; uploads are capped (5 MB for product photos) and
 * a tile never shows more than about 1024 px. A photo is redrawn so its longer
 * edge is at most `maxEdge`, re-encoded with a falling quality until it fits
 * `maxBytes`, and refused with a reason when it still does not fit.
 *
 * The decisions (`planDownscale`, `targetSize`, `outputType`, `qualitySteps`,
 * `fitsLimit`) are pure and unit tested in tests/unit/images-downscale.test.ts.
 * `downscaleImage` is the browser part (createImageBitmap + canvas); it is
 * written for any photo upload, so other uploads (the profile photo) can adopt it
 * with their own limits.
 */

export const DEFAULT_MAX_EDGE = 1024;
/** The Storage rules cap for product photos. */
export const PRODUCT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Quality tried in order for lossy output until the file fits. */
export const QUALITY_STEPS = [0.86, 0.76, 0.64, 0.5] as const;

export type DownscaleOptions = {
  maxEdge?: number;
  maxBytes?: number;
};

export type ImageFacts = {
  width: number;
  height: number;
  /** MIME type of the source file. */
  type: string;
  bytes: number;
};

export type DownscalePlan =
  | { action: 'keep' }
  | { action: 'redraw'; width: number; height: number; type: OutputType; qualities: readonly number[] };

export type OutputType = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * The size to draw at: the same aspect ratio with the longer edge at most
 * `maxEdge` (rounded, never below 1 px). Never enlarges.
 */
export function targetSize(width: number, height: number, maxEdge = DEFAULT_MAX_EDGE): { width: number; height: number; scaled: boolean } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0, scaled: false };
  const longer = Math.max(width, height);
  if (longer <= maxEdge) return { width: Math.round(width), height: Math.round(height), scaled: false };
  const ratio = maxEdge / longer;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

/**
 * What a redrawn photo is saved as: PNG and WebP keep their format (they may be
 * transparent); every other photo (JPEG, HEIC/HEIF, AVIF, unknown) becomes JPEG,
 * which every browser can encode.
 */
export function outputType(sourceType: string): OutputType {
  const type = sourceType.toLowerCase();
  if (type === 'image/png') return 'image/png';
  if (type === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

/** Lossy formats step the quality down; PNG is lossless and gets one try. */
export function qualitySteps(type: OutputType): readonly number[] {
  return type === 'image/png' ? [1] : QUALITY_STEPS;
}

export function fitsLimit(bytes: number, maxBytes = PRODUCT_PHOTO_MAX_BYTES): boolean {
  return bytes > 0 && bytes <= maxBytes;
}

/**
 * Whether and how to redraw a photo. A photo already within `maxEdge` and the
 * byte limit is kept as it is (no re-encode, no quality loss). An animated-capable
 * GIF is kept when it fits (redrawing would drop its animation) and otherwise
 * redrawn as a still JPEG.
 */
export function planDownscale(image: ImageFacts, options: DownscaleOptions = {}): DownscalePlan {
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const maxBytes = options.maxBytes ?? PRODUCT_PHOTO_MAX_BYTES;
  const size = targetSize(image.width, image.height, maxEdge);
  if (size.width === 0) return { action: 'keep' };
  const fits = fitsLimit(image.bytes, maxBytes);
  if (fits && (!size.scaled || image.type.toLowerCase() === 'image/gif')) return { action: 'keep' };
  const type = outputType(image.type);
  return { action: 'redraw', width: size.width, height: size.height, type, qualities: qualitySteps(type) };
}

export type DownscaleResult =
  | { ok: true; file: File; resized: boolean }
  | { ok: false; reason: 'too-large' | 'unreadable' };

/** Inline copy for a photo that cannot be used. */
export function downscaleErrorCopy(reason: 'too-large' | 'unreadable', maxBytes = PRODUCT_PHOTO_MAX_BYTES): string {
  const limit = `${Math.round(maxBytes / (1024 * 1024))} MB`;
  return reason === 'too-large'
    ? `This photo is still larger than ${limit} after shrinking it. Remove it or choose a smaller photo.`
    : `This photo could not be read and is larger than ${limit}. Remove it or choose a JPEG or PNG photo.`;
}

const renamed = (name: string, type: OutputType) => {
  const base = name.replace(/\.[^.]+$/, '') || 'photo';
  const extension = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  return `${base}.${extension}`;
};

/**
 * Shrinks a picked photo in the browser. A photo the browser cannot decode
 * (HEIC outside Safari, a damaged file) is passed through when it is within the
 * byte limit, and refused as `unreadable` otherwise.
 */
export async function downscaleImage(file: File, options: DownscaleOptions = {}): Promise<DownscaleResult> {
  const maxBytes = options.maxBytes ?? PRODUCT_PHOTO_MAX_BYTES;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return fitsLimit(file.size, maxBytes) ? { ok: true, file, resized: false } : { ok: false, reason: 'unreadable' };
  }
  try {
    const plan = planDownscale({ width: bitmap.width, height: bitmap.height, type: file.type, bytes: file.size }, options);
    if (plan.action === 'keep') return { ok: true, file, resized: false };
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext('2d');
    if (!context) return fitsLimit(file.size, maxBytes) ? { ok: true, file, resized: false } : { ok: false, reason: 'unreadable' };
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);
    for (const quality of plan.qualities) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, plan.type, quality));
      // A browser that cannot encode WebP returns PNG; keep whatever it produced.
      if (blob && fitsLimit(blob.size, maxBytes)) {
        const type = (blob.type || plan.type) as OutputType;
        return { ok: true, file: new File([blob], renamed(file.name, type), { type, lastModified: Date.now() }), resized: true };
      }
    }
    return { ok: false, reason: 'too-large' };
  } finally {
    bitmap.close();
  }
}
