/**
 * The public face of household members: what any approved member may see of
 * anyone else (name, photo, role, status, join time), read from the
 * membership records (`households/{id}/members/{uid}`). Pure (no Firebase).
 *
 * Emails are not part of it. A record may still carry `email` (until a later
 * release moves it to a document only the person and member managers can
 * read), so `email` is kept here only as a matching key for chores written
 * before `assignedToUid` existed. It must never be shown to someone who may
 * not manage members; use `canSeeMemberEmails` before displaying it.
 */
import type { Household, HouseholdMember, HouseholdMemberStatus, HouseholdPermission, HouseholdRole, User } from '@/lib/types';

export type HouseholdPerson = {
  uid: string;
  /** Never an email address (see `publicDisplayName`). */
  displayName: string;
  avatarUrl: string | null;
  role: HouseholdRole;
  status: HouseholdMemberStatus;
  joinedAt?: string;
  /** Matching key only, while records still carry it. Never displayed to others. */
  email?: string;
};

/** Shown for someone who has no usable display name. */
export const MEMBER_FALLBACK_NAME = 'Member';

const EMAIL_LIKE = /\S+@\S+/;

/** A display name that is safe to show housemates: never an email address. */
export function publicDisplayName(name: unknown, fallback = MEMBER_FALLBACK_NAME): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || EMAIL_LIKE.test(trimmed)) return fallback;
  return trimmed.slice(0, 80);
}

const ROLES: readonly HouseholdRole[] = ['owner', 'admin', 'member', 'child', 'guest', 'newuser'];

/**
 * A membership record as public member data. `uid` falls back to the
 * document id. Returns null for a record without a uid.
 */
export function personFromMemberRecord(data: Record<string, unknown>, docId?: string): HouseholdPerson | null {
  const uid = typeof data.uid === 'string' && data.uid ? data.uid : docId;
  if (!uid) return null;
  const role = ROLES.includes(data.role as HouseholdRole) ? data.role as HouseholdRole : 'newuser';
  const status = data.status === 'pending' || data.status === 'deleting' ? data.status : 'active';
  return {
    uid,
    displayName: publicDisplayName(data.displayName),
    avatarUrl: typeof data.avatarUrl === 'string' && data.avatarUrl ? data.avatarUrl : null,
    role,
    status,
    ...(typeof data.joinedAt === 'string' ? { joinedAt: data.joinedAt } : {}),
    ...(typeof data.email === 'string' && data.email ? { email: data.email } : {}),
  };
}

/** Approved, active members (pending people and departing households excluded). */
export function approvedPeople(records: ReadonlyArray<{ id: string; data: Record<string, unknown> }>): HouseholdPerson[] {
  return records
    // A missing status means active (older records); any other value is not approved.
    .filter(record => record.data.status === undefined || record.data.status === 'active')
    .map(record => personFromMemberRecord(record.data, record.id))
    .filter((person): person is HouseholdPerson => Boolean(person) && person!.role !== 'newuser' && person!.status === 'active');
}

/**
 * Who may see other members' emails: the owner and holders of
 * `household.manageMembers` (src/lib/household-policy.ts). Everyone may see
 * their own.
 */
export function canSeeMemberEmails(permissions: Partial<Record<HouseholdPermission, boolean>> | null | undefined): boolean {
  return Boolean(permissions?.['household.manageMembers']);
}

/**
 * The household as a pending person sees it: id and name from their own membership
 * record. Null for approved members, and for older pending records without a name.
 */
export function pendingHouseholdView(householdId: string, member: Pick<HouseholdMember, 'role' | 'status' | 'householdName'>): Household | null {
  const pending = member.role === 'newuser' || member.status === 'pending';
  const name = typeof member.householdName === 'string' ? member.householdName.trim() : '';
  return pending && name ? { id: householdId, name } : null;
}

/** Whether the profile's name or photo differ from the public member data. */
export function memberProfileDiffers(member: Pick<HouseholdMember, 'displayName' | 'avatarUrl'>, profile: Pick<User, 'displayName' | 'avatarUrl'>): boolean {
  const name = (value: unknown) => { const shown = publicDisplayName(value, ''); return shown || null; };
  const photo = (value: unknown) => (typeof value === 'string' && value.startsWith('https://') ? value : null);
  return name(member.displayName) !== name(profile.displayName) || photo(member.avatarUrl) !== photo(profile.avatarUrl);
}
