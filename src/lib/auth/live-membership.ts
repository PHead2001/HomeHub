/**
 * Live membership (SL-3): the pure state machine behind `AuthProvider`'s listeners on
 * the signed-in person's own membership record (`households/{id}/members/{uid}`) and,
 * while that record is approved, the household document. The profile pointer
 * (`users/{email}.householdId`) chooses which household is watched.
 *
 * The membership record is the only authority:
 * - a record the server says is gone, or a denied read of it, ends access;
 * - a cached "does not exist" is never proof (offline is not removal);
 * - once access ended, cached copies of the record never bring it back, only the server;
 * - a denied or missing household document never ends access by itself (it follows
 *   the record: pending people may not read it, and a deletion freezes the record first).
 *
 * No Firebase imports, so everything here is unit-testable.
 */
import { normalizeMember } from '@/lib/auth/cached-session';
import { pendingHouseholdView } from '@/lib/member-directory';
import type { Household, HouseholdMember, HouseholdRole, User } from '@/lib/types';

/** How long the membership may load (nothing cached, no server answer) before the retry screen. */
export const MEMBERSHIP_LOAD_TIMEOUT_MS = 15_000;

/** How a listener error is handled: `denied` ends access (member record); `transient` keeps the last known state and retries. */
export type ListenerFailure = 'denied' | 'transient';

/** Only a definitive refusal counts as denied; offline, timeouts and everything else are transient. */
export function classifyListenerError(error: unknown): ListenerFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return code === 'permission-denied' || code === 'firestore/permission-denied' ? 'denied' : 'transient';
}

/** Why access to a household ended while this session knew the membership. */
export type AccessEndReason = 'removed' | 'declined' | 'deleted';

export type AccessEnd = { householdId: string; reason: AccessEndReason };

export type LiveMembershipState = {
  /** The signed-in account whose membership this is; another account starts from nothing. */
  uid: string | null;
  /** The household being watched (the profile pointer, or one just created or joined here). */
  householdId: string | null;
  /** The latest known own membership record for `householdId` (from the cache or the server). */
  member: HouseholdMember | null;
  /** True once the server (not the cache) has answered for the membership record. */
  memberFromServer: boolean;
  /** The latest household document (approved members only). */
  household: Household | null;
  /** What a pending person sees: the household's id and the name on their own record. */
  pendingView: Household | null;
  /** The last household name this session knew (for the deletion screen). */
  lastName: string;
  /** Membership could not be loaded for an operational reason (offline with nothing cached, timeout). */
  loadFailed: boolean;
  /** Access ended while this session knew the membership; cleared by a dismissal or another household. */
  ended: AccessEnd | null;
  /** This person is leaving or deleting this household from this device: its end needs no notice. */
  endingHere: string | null;
  /** The household page stays while that action runs (it started from an active membership). */
  keepPageWhileEnding: boolean;
};

export const initialMembershipState: LiveMembershipState = {
  uid: null,
  householdId: null,
  member: null,
  memberFromServer: false,
  household: null,
  pendingView: null,
  lastName: '',
  loadFailed: false,
  ended: null,
  endingHere: null,
  keepPageWhileEnding: false,
};

export type MembershipEvent =
  /**
   * The signed-in account or its profile pointer changed (`uid` null: signed out;
   * `householdId` null: no household). Another account, even in the same household,
   * starts from nothing.
   */
  | { type: 'watch'; uid: string | null; householdId: string | null }
  | {
      type: 'member';
      householdId: string;
      uid: string;
      exists: boolean;
      data?: Record<string, unknown>;
      fromCache: boolean;
      /** The browser reported itself offline when the snapshot arrived. */
      offline?: boolean;
    }
  | { type: 'memberError'; householdId: string; failure: ListenerFailure }
  | { type: 'household'; householdId: string; exists: boolean; data?: Record<string, unknown>; fromCache: boolean }
  | { type: 'householdError'; householdId: string; failure: ListenerFailure }
  /** A household name recovered for the deletion screen (the cached household document). */
  | { type: 'householdName'; householdId: string; name: string }
  /** Nothing usable arrived in time while loading. */
  | { type: 'loadTimeout'; householdId: string }
  /** Try again after a failed load (the caller also reopens the listeners). */
  | { type: 'retry' }
  /** A household this person just created or joined on this device (from the server action's result). */
  | { type: 'adopt'; householdId: string; member: HouseholdMember; household: Household | null }
  /** This person started leaving or deleting the household on this device (before the server action). */
  | { type: 'endingHere'; householdId: string }
  /** That server action was refused or failed: membership goes on. */
  | { type: 'endingHereCancelled' }
  /** This person left or deleted the household here, or signed out: no notice. */
  | { type: 'reset' }
  /** The "no longer in this household" notice was acknowledged. */
  | { type: 'dismissEnded' };

const isPending = (member: Pick<HouseholdMember, 'role' | 'status'>) => member.role === 'newuser' || member.status === 'pending';

const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v
));

/** Same data, key order ignored: an unchanged snapshot (a metadata change) keeps object identity. */
const same = (a: unknown, b: unknown) => a === b || stable(a) === stable(b);

const endReason = (member: HouseholdMember | null): AccessEndReason => {
  if (member?.status === 'deleting') return 'deleted';
  if (member && isPending(member)) return 'declined';
  return 'removed';
};

/** Access to the watched household ended: forget everything about it, keep only the notice. */
const endAccess = (state: LiveMembershipState, householdId: string): LiveMembershipState => {
  if (!state.member || state.endingHere === householdId) {
    // Never knew a membership here (a stale profile pointer), or this person is leaving
    // or deleting it on this device: nothing to explain.
    return { ...initialMembershipState, uid: state.uid, householdId, memberFromServer: true };
  }
  return {
    ...initialMembershipState,
    uid: state.uid,
    householdId,
    memberFromServer: true,
    ended: { householdId, reason: endReason(state.member) },
  };
};

export function membershipReducer(state: LiveMembershipState, event: MembershipEvent): LiveMembershipState {
  switch (event.type) {
    case 'watch': {
      if (event.uid !== state.uid) {
        // A different account (or signed out): nothing of the previous one carries over,
        // not even an access-ended notice.
        return { ...initialMembershipState, uid: event.uid, householdId: event.uid ? event.householdId : null };
      }
      if (event.householdId === state.householdId) return state;
      const { uid } = state;
      if (event.householdId === null) {
        // The pointer was cleared. If this session still knew a membership, access ended
        // (a removal can reach the profile before the record's own snapshot does).
        if (state.ended) return { ...initialMembershipState, uid, ended: state.ended };
        if (state.householdId && state.member && state.endingHere !== state.householdId) {
          return { ...initialMembershipState, uid, ended: { householdId: state.householdId, reason: endReason(state.member) } };
        }
        return { ...initialMembershipState, uid };
      }
      return { ...initialMembershipState, uid, householdId: event.householdId };
    }
    case 'member': {
      if (event.householdId !== state.householdId || event.uid !== state.uid) return state;
      if (!event.exists) {
        if (event.fromCache) {
          // The cache cannot prove a record is gone. Offline with nothing known: say so.
          return event.offline && !state.member && !state.loadFailed ? { ...state, loadFailed: true } : state;
        }
        if (state.ended || (state.memberFromServer && !state.member)) return state;
        return endAccess(state, event.householdId);
      }
      // After access ended, only the server can bring the record back.
      if (state.ended && event.fromCache) return state;
      const member = normalizeMember((event.data ?? {}) as unknown as HouseholdMember, event.uid);
      const memberFromServer = state.memberFromServer || !event.fromCache;
      const nextMember = state.member && same(state.member, member) ? state.member : member;
      let { household, pendingView, lastName } = state;
      if (isPending(nextMember)) {
        const view = pendingHouseholdView(event.householdId, nextMember)!;
        pendingView = pendingView && same(pendingView, view) ? pendingView : view;
        household = null;
        if (view.name) lastName = view.name;
      }
      if (
        nextMember === state.member && memberFromServer === state.memberFromServer && household === state.household &&
        pendingView === state.pendingView && lastName === state.lastName && !state.loadFailed && !state.ended
      ) return state;
      return { ...state, member: nextMember, memberFromServer, household, pendingView, lastName, loadFailed: false, ended: null };
    }
    case 'memberError': {
      if (event.householdId !== state.householdId) return state;
      if (event.failure === 'denied') {
        if (state.ended || (state.memberFromServer && !state.member)) return state;
        return endAccess(state, event.householdId);
      }
      // Transient: keep what is known; with nothing known, show the retry screen.
      return state.member || state.loadFailed ? state : { ...state, loadFailed: true };
    }
    case 'household': {
      if (event.householdId !== state.householdId || !event.exists || state.ended) return state;
      // Only an approved record reads the household document; ignore late answers otherwise.
      if (!state.member || isPending(state.member) || state.member.status === 'deleting') return state;
      const household = { ...(event.data ?? {}), id: event.householdId } as Household;
      if (state.household && same(state.household, household)) return state;
      const name = typeof household.name === 'string' ? household.name : '';
      return { ...state, household, lastName: name || state.lastName, loadFailed: false };
    }
    case 'householdError':
      // The membership record decides access; the caller retries the household listener.
      return state;
    case 'householdName': {
      const name = event.name.trim();
      if (event.householdId !== state.householdId || !name || state.lastName || state.ended) return state;
      return { ...state, lastName: name };
    }
    case 'loadTimeout':
      if (event.householdId !== state.householdId || state.loadFailed) return state;
      return membershipPhase(state) === 'loading' ? { ...state, loadFailed: true } : state;
    case 'retry':
      return state.loadFailed ? { ...state, loadFailed: false } : state;
    case 'adopt': {
      const pending = isPending(event.member);
      const pendingView = pending ? (event.household ?? pendingHouseholdView(event.householdId, event.member)) : null;
      return {
        ...initialMembershipState,
        uid: state.uid,
        householdId: event.householdId,
        member: event.member,
        memberFromServer: true,
        household: pending ? null : event.household,
        pendingView,
        lastName: (pending ? pendingView?.name : event.household?.name) ?? '',
      };
    }
    case 'endingHere':
      if (event.householdId !== state.householdId || state.endingHere === event.householdId) return state;
      return { ...state, endingHere: event.householdId, keepPageWhileEnding: state.member?.status === 'active' };
    case 'endingHereCancelled':
      return state.endingHere ? { ...state, endingHere: null, keepPageWhileEnding: false } : state;
    case 'reset':
      // The account stays (a sign-out is a `watch` with no account).
      return { ...initialMembershipState, uid: state.uid };
    case 'dismissEnded':
      return state.ended ? { ...state, ended: null } : state;
    default:
      return state;
  }
}

export type MembershipPhase =
  /** No household (or a stale pointer the server confirmed has no record): onboarding. */
  | 'none'
  | 'loading'
  /** Loading failed for an operational reason: offer a retry, never onboarding. */
  | 'failed'
  | 'pending'
  | 'member'
  /** The owner is deleting the household; its data is frozen. */
  | 'deleting'
  /** Access ended while this session knew the membership: explain it, then onboarding. */
  | 'ended';

export function membershipPhase(state: LiveMembershipState): MembershipPhase {
  if (state.ended) return 'ended';
  if (!state.householdId) return 'none';
  const { member } = state;
  if (!member) {
    if (state.memberFromServer) return 'none';
    return state.loadFailed ? 'failed' : 'loading';
  }
  // The owner deleting it from this device keeps the page until the server action answers.
  if (member.status === 'deleting') return state.endingHere === state.householdId && state.keepPageWhileEnding && state.household ? 'member' : 'deleting';
  if (isPending(member)) return 'pending';
  if (state.household) return 'member';
  return state.loadFailed ? 'failed' : 'loading';
}

export type MembershipView = {
  phase: MembershipPhase;
  /** The household to show (pending: id and name only; deleting: the last known name, marked deleting). */
  household: Household | null;
  member: HouseholdMember | null;
  ended: AccessEnd | null;
};

/**
 * What the app shows. `profileUid` and `profileHouseholdId` are the signed-in account and the confirmed or cached profile pointer;
 * until the machine watches that same household the view is `loading`, so a new pointer
 * never flashes onboarding. Before the profile is confirmed by the server, an ended or
 * stale membership also shows as `loading`: the confirmed profile decides.
 */
export function membershipView(state: LiveMembershipState, profileUid: string | null, profileHouseholdId: string | null, profileConfirmed: boolean): MembershipView {
  const phase = membershipPhase(state);
  const loading: MembershipView = { phase: 'loading', household: null, member: null, ended: null };
  // Another account's membership is never shown, not even for one render.
  if ((profileUid ?? null) !== state.uid) return loading;
  if (phase === 'ended') return profileConfirmed ? { phase, household: null, member: null, ended: state.ended } : loading;
  if ((profileHouseholdId ?? null) !== state.householdId) return loading;
  switch (phase) {
    case 'none':
      return profileConfirmed ? { phase, household: null, member: null, ended: null } : loading;
    case 'loading':
    case 'failed':
      return { phase, household: null, member: null, ended: null };
    case 'pending':
      return { phase, household: state.pendingView, member: state.member, ended: null };
    case 'deleting':
      return {
        phase,
        household: { ...(state.household ?? { id: state.householdId!, name: state.lastName }), deletingAt: state.household?.deletingAt ?? true },
        member: state.member,
        ended: null,
      };
    case 'member': {
      // This device's own leave or delete request is still running (`endingHere`): the household's
      // freeze marker is that request at work, not a deletion that failed, so it is not shown
      // (the manager would otherwise offer "Finish deleting" while the first request still runs).
      const ownRequestRunning = state.endingHere === state.householdId && state.household?.deletingAt;
      const household = ownRequestRunning && state.household ? { ...state.household, deletingAt: undefined } : state.household;
      return { phase, household, member: state.member, ended: null };
    }
  }
}

const ROLE_NAMES: Record<HouseholdRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  child: 'Child',
  guest: 'Guest',
  newuser: 'Pending',
};

/** The settled membership a notice compares (loading states are skipped by the caller). */
export type NoticeSnapshot = { uid: string | null; householdId: string | null; phase: MembershipPhase; role: HouseholdRole | null };

/**
 * The toast for a change made by someone else while this page was open: an approval
 * ("You're in") or a new role. Nothing for the first load, another household, or the
 * same role.
 */
export function membershipChangeNotice(previous: NoticeSnapshot | null, next: NoticeSnapshot): { title: string; description: string } | null {
  if (!previous || !next.householdId || previous.uid !== next.uid || previous.householdId !== next.householdId || next.phase !== 'member' || !next.role) return null;
  const role = ROLE_NAMES[next.role] ?? 'Member';
  if (previous.phase === 'pending') return { title: "You're in", description: `An owner or admin approved you as ${role}.` };
  if (previous.phase === 'member' && previous.role && previous.role !== next.role) {
    return { title: 'Your role changed', description: `Your role is now ${role}. What you can do here changed with it.` };
  }
  return null;
}

/**
 * The household pointer to clear because the membership behind it is gone, or null.
 * Only for the signed-in account's own, server-confirmed profile, and only when the
 * membership state belongs to that same account: another account's ended membership
 * (seen while a new account's profile is arriving) never clears this one's pointer.
 */
export function stalePointerFor(
  state: LiveMembershipState,
  profile: Pick<User, 'uid' | 'householdId'> | null,
  profileConfirmed: boolean,
): string | null {
  const householdId = profile?.householdId ?? null;
  if (!profileConfirmed || !profile || !householdId || state.uid !== profile.uid) return null;
  if (state.ended?.householdId === householdId) return householdId;
  if (state.householdId === householdId && state.memberFromServer && !state.member) return householdId;
  return null;
}

/**
 * The name prefilled on "Finish deleting" (the server requires the household's exact
 * name, and nobody may read a frozen household's document). Only a suggestion, always
 * shown in an editable field: the name this session last saw or this device's cached
 * household document first; the record's `householdName` last, because it is the name
 * at invitation time and a later rename does not update it. '' when nothing is known.
 */
export function deletionNameSuggestion(knownName: string | null | undefined, recordName: string | null | undefined): string {
  const known = (knownName ?? '').trim();
  if (known) return known;
  return (recordName ?? '').trim();
}

/** The field's value: what the owner typed once they typed anything, else the suggestion. */
export function deletionNameField(typed: string | null, suggestion: string): string {
  return typed ?? suggestion;
}

/** The name sent, or null while the field is empty (Finish deleting is not offered then). */
export function finishDeletingName(field: string): string | null {
  const name = field.trim();
  return name || null;
}

/** Shown under the field when Finish deleting was refused (a wrong name, or no connection); the field stays editable. */
export const FINISH_DELETING_FAILED = "That didn't finish. The name must match the household's name exactly; check it and try again.";

/** What the dialog shows after a Finish deleting attempt: null after success, else the plain explanation. */
export function finishDeletingError(ok: boolean): string | null {
  return ok ? null : FINISH_DELETING_FAILED;
}

/** Whether the household document may be read (and so listened to) for this state. */
export function canWatchHousehold(state: LiveMembershipState): boolean {
  const { member } = state;
  return Boolean(state.householdId && member && !state.ended && !isPending(member) && member.status === 'active');
}

/**
 * The profile as the app uses it: the household pointer, role and permission overrides
 * follow the live membership record, never the profile's cached copies. While the
 * membership is loading the profile's own pointer is kept (screens show loading states).
 */
export function liveProfile(profile: User | null, view: MembershipView, watchedHouseholdId: string | null): User | null {
  if (!profile) return null;
  if (view.member && watchedHouseholdId && (view.phase === 'member' || view.phase === 'pending' || view.phase === 'deleting')) {
    const permissions = view.member.permissions ?? {};
    if (profile.householdId === watchedHouseholdId && profile.role === view.member.role && same(profile.permissions ?? {}, permissions)) return profile;
    return { ...profile, householdId: watchedHouseholdId, role: view.member.role, permissions };
  }
  if (view.phase === 'ended' || view.phase === 'none') {
    if (profile.householdId === null && profile.role === 'member' && same(profile.permissions ?? {}, {})) return profile;
    return { ...profile, householdId: null, role: 'member', permissions: {} };
  }
  return profile;
}
