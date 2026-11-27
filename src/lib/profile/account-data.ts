/**
 * Account controls (audit PR-26): what "Download my data" contains. Pure; tests/unit/profile-account.test.ts. The
 * server side is src/lib/server/my-account.ts.
 */

/** Profile fields never exported: device push tokens are delivery credentials, not personal data. */
const NOT_EXPORTED = new Set(['fcmTokens']);

/** Firestore values as plain JSON: Timestamps become ISO strings, nested maps and lists kept. */
export function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'object') {
    const candidate = value as { toDate?: () => Date };
    if (typeof candidate.toDate === 'function') {
      try {
        return candidate.toDate().toISOString();
      } catch {
        return null;
      }
    }
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(toPlain);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, toPlain(entry)]));
  }
  return value;
}

export function exportableProfile(data: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!data) return null;
  return toPlain(Object.fromEntries(Object.entries(data).filter(([key]) => !NOT_EXPORTED.has(key)))) as Record<string, unknown>;
}
