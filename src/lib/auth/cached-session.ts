/**
 * Pure helpers for the repeat-visit fast path in `AuthProvider` (H01: the live house on a
 * mid-range phone). After Firebase Auth restores the session on this device, the provider
 * renders from Firestore's local cache (this user's own data; the cache is cleared on
 * sign-out) and then confirms everything with the server exactly as before. No Firebase
 * imports here, so these stay unit-testable and safe on first-paint paths.
 */
import { normalizeRole } from '@/lib/permissions';
import type { HouseholdMember, User } from '@/lib/types';

/** A membership record as the app uses it: role normalized, status defaulted, uid attached. */
export function normalizeMember(data: HouseholdMember, uid: string): HouseholdMember {
  return {
    ...data,
    uid,
    role: normalizeRole(data.role),
    status: data.status || (data.role === 'newuser' ? 'pending' : 'active'),
  } as HouseholdMember;
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v
));

/**
 * True when two profiles carry the same data (key order ignored). The server copy replaces
 * the cached one only when something changed, so confirming an unchanged profile doesn't
 * re-run the household load or re-render the dashboard.
 */
export function sameProfile(a: User | null, b: User | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return stable(a) === stable(b);
}
