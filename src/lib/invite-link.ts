/**
 * Joining by link or QR code (audit HO-16, HO-23). An invite code can be shared as
 * `<origin>/join?code=ABCD-EFGH-JK` (a link, the system share sheet, or a QR code on the
 * Invite Codes tab). Opening it never joins anyone by itself: `/join` keeps the code on
 * this device only for this tab (`sessionStorage`), removes it from the address bar,
 * and the Join form is pre-filled once the person is signed in and has no household.
 * Codes stay single-use and short-lived (16.3: no longer or multi-use codes). Pure
 * except for the storage helpers, which take the storage as a parameter.
 */

import { normalizeInviteCode } from '@/lib/invite-codes';
import { assignableRoles } from '@/lib/permissions';
import type { HouseholdRole } from '@/lib/types';

export const JOIN_PATH = '/join';

/** Where the code waits between opening the link and the Join form (this tab only). */
export const PENDING_JOIN_CODE_KEY = 'homehub.join.pendingCode';

/** Dispatched on `window` when a link's code was stored, so an open Join form picks it up. */
export const JOIN_CODE_EVENT = 'homehub:join-code';

/** The link for an invite code, on this app's own origin. */
export function inviteJoinUrl(origin: string, code: string): string {
  const normalized = normalizeInviteCode(code);
  if (!normalized) throw new Error('Not an invite code');
  return `${origin.replace(/\/+$/, '')}${JOIN_PATH}?code=${normalized}`;
}

/** The invite code in a `/join` query string, normalized, or null when there is none or it is malformed. */
export function joinCodeFromSearch(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw = params.get('code');
  return raw ? normalizeInviteCode(raw) : null;
}

type SessionLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Keeps a code from a link for the Join form (malformed codes are dropped). */
export function rememberJoinCode(storage: SessionLike | null | undefined, code: string | null): void {
  if (!storage || !code) return;
  try {
    storage.setItem(PENDING_JOIN_CODE_KEY, code);
  } catch {
    // Storage blocked: the person can still type the code.
  }
}

/** The code waiting for the Join form, or ''. */
export function pendingJoinCode(storage: SessionLike | null | undefined): string {
  if (!storage) return '';
  try {
    return normalizeInviteCode(storage.getItem(PENDING_JOIN_CODE_KEY) ?? '') ?? '';
  } catch {
    return '';
  }
}

export function forgetJoinCode(storage: SessionLike | null | undefined): void {
  try {
    storage?.removeItem(PENDING_JOIN_CODE_KEY);
  } catch {
    // Nothing to do.
  }
}

/**
 * The role an invite may suggest (HO-16 "role at invite time"): an assignable role
 * strictly below its creator's own, or null for none. Only a default for whoever
 * approves; approval still checks their own authority (`canAssignRole`).
 */
export function suggestedRoleFor(value: unknown, creatorRank: number, rankOf: (role: HouseholdRole) => number): HouseholdRole | null {
  if (typeof value !== 'string' || !assignableRoles.includes(value as HouseholdRole)) return null;
  const role = value as HouseholdRole;
  return rankOf(role) < creatorRank ? role : null;
}
