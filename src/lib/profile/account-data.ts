/**
 * Account controls (audit PR-26): what "Download my data" contains and when
 * "Delete my account" must refuse. Pure; tests/unit/profile-account.test.ts. The
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

/** Deleting an account needs a sign-in within this many seconds (checked on the server). */
export const RECENT_SIGN_IN_SECONDS = 5 * 60;

/** Whether an ID token's `auth_time` (seconds) is recent enough for account deletion. */
export function isRecentSignIn(authTimeSeconds: unknown, nowMs: number, maxAgeSeconds = RECENT_SIGN_IN_SECONDS): boolean {
  if (typeof authTimeSeconds !== 'number' || !Number.isFinite(authTimeSeconds)) return false;
  const age = nowMs / 1000 - authTimeSeconds;
  return age >= -60 && age <= maxAgeSeconds;
}

export type DeletionBlocker = 'owner_with_members' | 'owner_alone';

/**
 * Why an account cannot be deleted yet, or null. An owner must hand the household
 * on first (Household > Members > Make owner) when other people with an account are
 * in it, or delete the household (Household > Danger Zone) when they are its only
 * account holder; kid profiles have no account and go with the household.
 */
export function accountDeletionBlocker(
  me: { role?: unknown } | null | undefined,
  others: ReadonlyArray<{ kind?: unknown; status?: unknown }>,
): DeletionBlocker | null {
  if (!me || me.role !== 'owner') return null;
  const accounts = others.filter((member) => member.kind !== 'identity');
  return accounts.length > 0 ? 'owner_with_members' : 'owner_alone';
}

export const DELETION_BLOCKER_COPY: Record<DeletionBlocker, string> = {
  owner_with_members: 'You own this household. Make someone else the owner first (Household, Members), then delete your account.',
  owner_alone: 'You are the only account in this household. Delete the household first (Household, Danger Zone), then delete your account.',
};

/** The words typed to confirm deletion. */
export const DELETE_CONFIRMATION = 'DELETE';
