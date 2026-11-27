/**
 * The profile write is `setDoc(..., { merge: true })`, which merges nested maps
 * key by key. The context's local copy must merge the same way, or a partial
 * `theme` write (PR-6) would replace the whole local theme until the live
 * profile listener caught up. Pure; tests/unit/profile-correctness.test.ts.
 */
const NESTED_FIELDS = ['theme', 'choreSettings', 'preferences'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function mergeProfilePatch<T extends object>(previous: T, patch: Partial<T>): T {
  const merged: Record<string, unknown> = { ...(previous as Record<string, unknown>), ...(patch as Record<string, unknown>) };
  for (const field of NESTED_FIELDS) {
    const before = (previous as Record<string, unknown>)[field];
    const change = (patch as Record<string, unknown>)[field];
    if (isRecord(before) && isRecord(change)) merged[field] = { ...before, ...change };
  }
  return merged as T;
}
