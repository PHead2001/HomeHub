/**
 * The public face of household members: what any approved member may see of
 * anyone else (name, photo, role, status, join time), read from the
 * membership records (`households/{id}/members/{uid}`). Pure (no Firebase).
 *
 * Emails are not part of it. Each member's email lives in their protected
 * contact document (`members/{uid}/private/contact`, written by the server,
 * readable by the person and member managers; see
 * functions/src/shared/member-contact.ts). Records still carry `email` during
 * the move, so `email` is kept here only as a matching key for chores written
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
  /**
   * `'identity'`: a kid profile with no sign-in (docs/modules/devices/README.md). They
   * count everywhere names, leaderboards and "by Mia" appear, but are not offered as
   * chore assignees yet (HO-15d): use `assignablePeople` for pickers.
   */
  kind?: 'account' | 'identity';
};

/** Shown for someone who has no usable display name. */
export const MEMBER_FALLBACK_NAME = 'Member';

const EMAIL_LIKE = /\S+@\S+/;

/**
 * Whether a photo URL is a Firebase Storage download URL of a file in an
 * email-named folder (`users/{email}/avatars/...`, where photos were uploaded
 * before member privacy release B): the URL carries the email, so it is never
 * copied to public member data.
 */
export function isEmailFolderPhotoUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== 'firebasestorage.googleapis.com') return false;
  const match = /^\/v0\/b\/[^/]+\/o\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return false;
  let path: string;
  try {
    path = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  return /^users\/[^/]*@[^/]*\//.test(path);
}

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
    ...(data.kind === 'identity' ? { kind: 'identity' as const } : {}),
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
 * People a chore can be assigned to: everyone but kid profiles (assigning chores to
 * them is not part of this release, HO-15d). `keepUid` keeps the current assignee
 * listed whoever it is, so a picker never loses its value.
 */
export function assignablePeople<T extends { uid: string; kind?: 'account' | 'identity' }>(people: readonly T[], keepUid?: string | null): T[] {
  return people.filter(person => person.kind !== 'identity' || (keepUid !== undefined && keepUid !== null && person.uid === keepUid));
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
 * record. Pending people cannot read the household document, so an older pending
 * record without a name gets an empty name (the waiting screen then shows its
 * generic text). Null for approved members, who read the household document.
 */
export function pendingHouseholdView(householdId: string, member: Pick<HouseholdMember, 'role' | 'status' | 'householdName'>): Household | null {
  const pending = member.role === 'newuser' || member.status === 'pending';
  if (!pending) return null;
  const name = typeof member.householdName === 'string' ? member.householdName.trim() : '';
  return { id: householdId, name };
}

/** Whether the profile's name or photo differ from the public member data. */
export function memberProfileDiffers(member: Pick<HouseholdMember, 'displayName' | 'avatarUrl'>, profile: Pick<User, 'displayName' | 'avatarUrl'>): boolean {
  const name = (value: unknown) => { const shown = publicDisplayName(value, ''); return shown || null; };
  const photo = (value: unknown) => (typeof value === 'string' && value.startsWith('https://') && !isEmailFolderPhotoUrl(value) ? value : null);
  return name(member.displayName) !== name(profile.displayName) || photo(member.avatarUrl) !== photo(profile.avatarUrl);
}
