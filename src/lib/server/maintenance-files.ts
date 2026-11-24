import 'server-only';

import type { Firestore } from 'firebase-admin/firestore';

/**
 * Removing an upload whose metadata never landed (MA-11k). Every uploader (`maintenance.edit`, or
 * `maintenance.createLogs` for a receipt on their own new log) may upload, but only
 * `maintenance.delete` may delete Storage objects, so a member's client could not remove the file
 * it just uploaded when the metadata write was refused. This removes it on the server, only when
 * - the path is a maintenance attachment path of this household (one file name, no folders),
 * - the object's own metadata names the caller as its uploader (`uploadedByUid`, set on upload), and
 * - no attachment metadata points at it (it really is orphaned).
 * Anything else is refused and nothing is deleted.
 */
export type CleanupBucket = {
  file(path: string): {
    getMetadata(): Promise<[{ metadata?: Record<string, unknown> | null }, ...unknown[]]>;
    delete(options?: { ignoreNotFound?: boolean }): Promise<unknown>;
  };
};

const TARGET_TYPES = ['home_asset', 'vehicle', 'maintenance_log'];

/** A maintenance file path of this household: `households/{h}/maintenance/{type}/{id}/{name}`. */
export const isMaintenanceFilePath = (householdId: string, path: unknown): path is string => {
  if (typeof path !== 'string' || path.length > 1500 || path.includes('..') || path.includes('//')) return false;
  const parts = path.split('/');
  return parts.length === 6 && parts[0] === 'households' && parts[1] === householdId && parts[2] === 'maintenance'
    && TARGET_TYPES.includes(parts[3]) && parts[4].length > 0 && parts[5].length > 0;
};

export type CleanupResult = { removed: number; refused: number };

export async function cleanupOrphanUploadsAs(
  db: Firestore,
  bucket: CleanupBucket | null,
  householdId: string,
  paths: unknown,
  uid: string,
): Promise<CleanupResult> {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 3) return { removed: 0, refused: 1 };
  if (!bucket) return { removed: 0, refused: paths.length };
  const attachments = db.collection('households').doc(householdId).collection('maintenance-attachments');
  let removed = 0;
  let refused = 0;
  for (const path of paths) {
    if (!isMaintenanceFilePath(householdId, path)) { refused += 1; continue; }
    const linked = await attachments.where('filePath', '==', path).limit(1).get();
    const linkedCopy = linked.empty
      ? await attachments.where('displayPath', '==', path).limit(1).get()
      : linked;
    if (!linked.empty || !linkedCopy.empty) { refused += 1; continue; }
    const object = bucket.file(path);
    let uploader: unknown;
    try {
      const [metadata] = await object.getMetadata();
      uploader = metadata.metadata?.uploadedByUid;
    } catch {
      // Already gone: nothing to clean up.
      continue;
    }
    if (uploader !== uid) { refused += 1; continue; }
    await object.delete({ ignoreNotFound: true });
    removed += 1;
  }
  return { removed, refused };
}
