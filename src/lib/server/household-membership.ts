import 'server-only';

import { randomInt } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb, adminStorageBucket } from '@/lib/server/firebase-admin';
import { normalizeInviteCode } from '@/lib/invite-codes';
import { choreStatsAssigneeKey } from '@functions/shared/ids';
import { choreStatsDocId } from '@functions/shared/chore-stats';
import { localDay, safeTimeZone } from '@functions/shared/calendar';
import { contactEmailOf } from '@functions/shared/member-contact';
import {
  canAssignRole,
  canEditPermissions,
  canManageInvites,
  canManageMember,
  canRemindPendingMembers,
  canRenameHousehold,
  canTransferOwnership,
  isOwnerOnlyPermission,
  normalizeOverrides,
  permissionChanges,
  refusalMessage,
  type PolicyDecision,
  type PolicyMember,
  type PolicyRefusal,
} from '@/lib/household-policy';
import { assignableRoles, householdPermissions } from '@/lib/permissions';
import {
  PENDING_REMINDER_SOURCE_TYPE,
  householdIdFor,
  membershipAvatarUrl,
  normalizeTimeZone,
  pendingReminderDue,
  pendingReminderStateKey,
  readHouseholdName,
} from '@/lib/household-records';
import { getDeterministicNotificationId } from '@/lib/notifications';
import type { Household, HouseholdMember, HouseholdPermission, HouseholdRole, InviteCode, PermissionOverrides } from '@/lib/types';

/**
 * Why an operation was refused: a policy reason (`src/lib/household-policy.ts`)
 * or one of the general ones below.
 */
export type MembershipErrorCode =
  | PolicyRefusal
  | 'unauthenticated'
  | 'invalid_input'
  | 'not_found'
  | 'household_deleting'
  | 'conflict'
  | 'failed';
import { notificationAudience } from '@functions/shared/notification-audience';
import { unassignedChoreFields } from '@functions/shared/assignee';

export class MembershipError extends Error {
  constructor(public readonly userMessage: string, public readonly code: MembershipErrorCode = 'failed') {
    super(userMessage);
  }
}

const NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A member's protected contact document, `households/{id}/members/{uid}/private/contact`
 * (`{ email, updatedAt }`). Only the server writes it; the rules let the person
 * and holders of `household.manageMembers` read it. Written whenever a membership
 * is created or approved, deleted with the membership.
 */
const memberContactRef = (householdRef: FirebaseFirestore.DocumentReference, uid: string) =>
  householdRef.collection('members').doc(uid).collection('private').doc('contact');

const memberContact = (email: string, now: Date) => ({ email, updatedAt: now.toISOString() });
const INVITE_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

export type VerifiedCaller = { uid: string; email: string; displayName?: string; avatarUrl?: string };

// Identity always comes from a verified Firebase ID token, never from caller-supplied fields.
export const verifyCaller = async (idToken: string): Promise<VerifiedCaller> => {
  if (!idToken || typeof idToken !== 'string') throw new MembershipError('Please sign in again.', 'unauthenticated');
  try {
    const decoded = await adminAuth.verifyIdToken(idToken, true);
    if (typeof decoded.email !== 'string' || !decoded.email) throw new Error('missing email');
    return {
      uid: decoded.uid,
      email: decoded.email,
      displayName: typeof decoded.name === 'string' ? decoded.name : undefined,
      avatarUrl: typeof decoded.picture === 'string' ? decoded.picture : undefined,
    };
  } catch {
    throw new MembershipError('Your sign-in has expired. Please sign in again.', 'unauthenticated');
  }
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

/**
 * What a person who just redeemed an invite gets back: the household's id and
 * name (for the waiting screen) and their own pending status. Never the
 * household document, which lists every member's email.
 */
export type JoinResult = {
  household: Pick<Household, 'id' | 'name'>;
  member: Pick<HouseholdMember, 'uid' | 'role' | 'status' | 'joinedAt' | 'householdName'>;
};

/** What the creator of a new household gets back: the household (only their own email in it) and their owner record. */
export type CreateHouseholdResult = { household: Household; member: HouseholdMember };

// Redeems an invite atomically: validates expiry, revocation and remaining uses,
// creates a pending membership, and alerts the people who can approve it.
export const redeemInvite = async (caller: VerifiedCaller, rawCode: string, now = new Date()): Promise<JoinResult> => {
  const code = normalizeInviteCode(rawCode);
  if (!code) throw new MembershipError('Enter the 10-character invite code, for example ABCD-EFGH-JK.');

  const profileRef = adminDb.collection('users').doc(caller.email);

  return adminDb.runTransaction(async transaction => {
    const inviteRef = adminDb.collection('inviteCodes').doc(code);
    const inviteSnap = await transaction.get(inviteRef);
    if (!inviteSnap.exists) throw new MembershipError('That invite code was not found. Check it and try again.');

    const invite = inviteSnap.data() || {};
    if (invite.revokedAt) throw new MembershipError('That invite code was cancelled. Ask for a new one.');
    // Whatever expiry the creator wrote, no invite outlives 2 hours from when Firestore
    // stored it (older clients write a free-form ISO string the rules cannot bound).
    const storedAt = inviteSnap.createTime?.toDate();
    const claimedExpiry = toDate(invite.expiresAt);
    const expiresAt = claimedExpiry && storedAt
      ? new Date(Math.min(claimedExpiry.getTime(), storedAt.getTime() + INVITE_MAX_LIFETIME_MS))
      : null;
    if (!expiresAt || expiresAt <= now) throw new MembershipError('That invite code has expired. Ask for a new one.');
    const maxUses = typeof invite.maxUses === 'number' ? invite.maxUses : 1;
    const useCount = typeof invite.useCount === 'number' ? invite.useCount : 0;
    if (useCount >= maxUses) throw new MembershipError('That invite code has already been used. Ask for a new one.');

    const householdId = typeof invite.householdId === 'string' ? invite.householdId : '';
    const householdRef = adminDb.collection('households').doc(householdId);
    const memberRef = householdRef.collection('members').doc(caller.uid);
    const [householdSnap, memberSnap, profileSnap, approversSnap] = await Promise.all([
      transaction.get(householdRef),
      transaction.get(memberRef),
      transaction.get(profileRef),
      transaction.get(householdRef.collection('members').where('role', 'in', ['owner', 'admin'])),
    ]);
    if (!householdId || !householdSnap.exists) throw new MembershipError('That household no longer exists.');
    if (householdSnap.get('deletingAt')) throw new MembershipError('That household is being deleted.');
    if (memberSnap.exists) throw new MembershipError('You are already part of this household.');

    const currentHouseholdId = profileSnap.exists ? profileSnap.data()?.householdId : null;
    if (typeof currentHouseholdId === 'string' && currentHouseholdId && currentHouseholdId !== householdId) {
      const existing = await transaction.get(
        adminDb.collection('households').doc(currentHouseholdId).collection('members').doc(caller.uid)
      );
      if (existing.exists) throw new MembershipError('Leave your current household before joining another one.');
    }

    const joinedAt = now.toISOString();
    const householdName = typeof householdSnap.get('name') === 'string' ? householdSnap.get('name') as string : '';
    // A photo removed in Profile stays removed; see membershipAvatarUrl.
    const avatarUrl = membershipAvatarUrl(profileSnap.exists ? profileSnap.data() : undefined, caller.avatarUrl);
    const member: HouseholdMember = {
      uid: caller.uid,
      email: caller.email,
      // Public member data: never an email as the name (see syncMemberProfile).
      ...(publicMemberName(caller.displayName) ? { displayName: publicMemberName(caller.displayName) } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      role: 'newuser',
      status: 'pending',
      inviteCode: code,
      joinedAt,
      // The waiting screen reads this from the person's own record instead of the household document.
      ...(householdName ? { householdName } : {}),
    } as HouseholdMember;

    transaction.set(memberRef, member);
    transaction.set(memberContactRef(householdRef, caller.uid), memberContact(caller.email, now));
    // No email on the household document (member privacy release C): the email lives in
    // the protected contact document above.
    transaction.update(householdRef, { updatedAt: joinedAt });
    transaction.set(profileRef, {
      email: caller.email,
      uid: caller.uid,
      householdId,
      role: 'newuser',
      permissions: {},
    }, { merge: true });
    transaction.update(inviteRef, {
      useCount: useCount + 1,
      usedByUid: caller.uid,
      usedAt: joinedAt,
      redemptions: FieldValue.arrayUnion({ uid: caller.uid, at: joinedAt }),
    });
    transaction.set(householdRef.collection('auditLogs').doc(), {
      actorUid: caller.uid,
      actorEmail: caller.email,
      actorName: caller.displayName || null,
      action: 'member.joined_pending',
      targetUid: caller.uid,
      targetEmail: caller.email,
      createdAt: joinedAt,
      details: { inviteCode: code },
    });

    const name = caller.displayName || caller.email;
    const createdAt = Timestamp.fromDate(now);
    const expires = Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS);
    // One document per join event and approver: a rejoin creates new documents (so the
    // push trigger fires), while a retry of this transaction reuses the same IDs.
    const eventId = `${caller.uid}-${now.getTime()}`;
    for (const approver of approversSnap.docs) {
      const approverData = approver.data();
      if (approverData.status && approverData.status !== 'active') continue;
      transaction.set(householdRef.collection('notifications').doc(`household-newuser-${eventId}-${approver.id}`), {
        householdId,
        category: 'system',
        title: 'New member needs approval',
        message: `${name} joined with an invite code. Choose their role to let them in.`,
        createdAt,
        expiresAt: expires,
        deepLink: '/household?tab=members',
        sourceType: 'household-newuser',
        // Per-event state: a rejoin must not inherit the earlier request's read/dismissed state.
        stateKey: String(now.getTime()),
        sourceId: caller.uid,
        targetUserUid: approver.id,
        audience: notificationAudience({ targetUserUid: approver.id }),
        readBy: {},
        dismissedBy: {},
      });
    }

    return {
      household: { id: householdSnap.id, name: householdName },
      member: { uid: caller.uid, role: 'newuser', status: 'pending', joinedAt, ...(householdName ? { householdName } : {}) },
    };
  });
};

const deleteHouseholdFiles = async (householdId: string) => {
  const bucket = adminStorageBucket();
  if (!bucket) return;
  await bucket.deleteFiles({ prefix: `households/${householdId}/` });
};

type NoticeFields = { title: string; message: string; sourceType: string; sourceId: string };

// One notification per active owner/admin and event, each targeted to its recipient.
// The event time is part of the ID so a repeat event (leave, rejoin, leave again)
// creates new documents and triggers push; transaction retries reuse the same IDs.
const approverNotices = (
  householdRef: FirebaseFirestore.DocumentReference,
  approvers: FirebaseFirestore.QueryDocumentSnapshot[],
  now: Date,
  fields: NoticeFields
): Array<[FirebaseFirestore.DocumentReference, Record<string, unknown>]> => approvers
  .filter(approver => !approver.data().status || approver.data().status === 'active')
  .map(approver => [
    householdRef.collection('notifications').doc(`${fields.sourceType}-${fields.sourceId}-${now.getTime()}-${approver.id}`),
    {
      householdId: householdRef.id,
      category: 'system',
      createdAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS),
      deepLink: '/household?tab=members',
      targetUserUid: approver.id,
      audience: notificationAudience({ targetUserUid: approver.id }),
      readBy: {},
      dismissedBy: {},
      // Per-event state: a repeat event must not inherit earlier read/dismissed state.
      stateKey: String(now.getTime()),
      ...fields,
    },
  ]);

type QuerySnap = FirebaseFirestore.QuerySnapshot;
type QueryDoc = FirebaseFirestore.QueryDocumentSnapshot;

/**
 * Chores or templates assigned to one person, found by email (older records)
 * and by uid, once each. A record found by uid whose email now names someone
 * else was reassigned by an older build (which rewrites only the email), so it
 * is no longer theirs and is skipped (functions/src/shared/assignee.ts).
 */
const assignedDocs = (byEmail: QuerySnap | null, byUid: QuerySnap, email: string): QueryDoc[] => {
  const found = new Map<string, QueryDoc>();
  byEmail?.docs.forEach(d => found.set(d.ref.path, d));
  const own = email.trim().toLowerCase();
  byUid.docs.forEach(d => {
    const stored = d.get('assignedToEmail');
    const other = typeof stored === 'string' && stored.trim() !== '' && stored.trim().toLowerCase() !== own;
    if (!other) found.set(d.ref.path, d);
  });
  return [...found.values()];
};

/**
 * Households no longer list member emails (member privacy release C). A household
 * written earlier may still carry the legacy `memberEmails` list (until
 * scripts/ops/scrub-shared-emails.mjs removes it): a departing member's email is
 * removed from it, and nothing is written when there is no list.
 */
const legacyMemberEmailRemoval = (household: FirebaseFirestore.DocumentData | undefined, email: string) =>
  email && Array.isArray(household?.memberEmails) ? { memberEmails: FieldValue.arrayRemove(email) } : {};

/** Unassigns an open chore; no email is left on it (member privacy release C). */
const unassignChoreFields = (): FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> => ({
  ...unassignedChoreFields(),
  assignedToEmail: FieldValue.delete(),
});

/**
 * A departing person's yearly chore stats identity: their completions were
 * counted under `choreStatsAssigneeKey(email)` while they were a member, and
 * once their membership and contact documents are gone their uid can no longer
 * be resolved to that email. `aliases.<uid>` in the stats documents of this
 * and last year keeps crediting it to the same key (`creditedStatsKey`), so
 * their score is one bucket before and after they leave. The alias holds no
 * email. The years are the household's (`timeZone`, defaulted by
 * `safeTimeZone` exactly as upkeep's `completionYear` and Home Wrapped
 * do): a completion of theirs still stored is in the past and at most 90 days
 * old, so its stats year is this local year or the one before; next year can
 * receive none of theirs (they no longer complete chores here).
 */
const keepStatsIdentity = (
  transaction: FirebaseFirestore.Transaction,
  householdRef: FirebaseFirestore.DocumentReference,
  uid: string,
  email: string | null | undefined,
  now: Date,
  timeZone: unknown,
) => {
  if (!uid || typeof email !== 'string' || !email.trim()) return;
  const key = choreStatsAssigneeKey(email);
  const year = Number(localDay(now, safeTimeZone(typeof timeZone === 'string' ? timeZone : undefined)).slice(0, 4));
  for (const statsYear of [year - 1, year]) {
    transaction.set(householdRef.collection('stats').doc(choreStatsDocId(statsYear)), { aliases: { [uid]: key } }, { merge: true });
  }
};

/** Unassigns a recurring template (it stops generating chores). */
const unassignTemplateFields = (d: QueryDoc): FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> => {
  const recurrence = d.get('recurrence');
  return {
    assignedToEmail: FieldValue.delete(),
    assignedToUid: FieldValue.delete(),
    ...(recurrence && typeof recurrence === 'object' ? { 'recurrence.assignedToEmail': FieldValue.delete() } : {}),
  };
};

// Leaving: any non-owner. Chores and recurring templates assigned to the leaver
// become unassigned so nothing keeps being scheduled for someone who left.
// The membership is read inside the transaction, so a concurrent ownership
// transfer to the leaver forces a retry and the leave is then refused.
export const leaveHousehold = async (caller: VerifiedCaller, householdId: string, now = new Date()) => {
  const householdRef = adminDb.collection('households').doc(householdId);
  const memberRef = householdRef.collection('members').doc(caller.uid);
  await adminDb.runTransaction(async transaction => {
    const [householdSnap, memberSnap, choresByEmail, choresByUid, templatesByEmail, templatesByUid, approvers] = await Promise.all([
      transaction.get(householdRef),
      transaction.get(memberRef),
      transaction.get(householdRef.collection('chores').where('assignedToEmail', '==', caller.email)),
      transaction.get(householdRef.collection('chores').where('assignedToUid', '==', caller.uid)),
      transaction.get(householdRef.collection('chore-templates').where('assignedToEmail', '==', caller.email)),
      transaction.get(householdRef.collection('chore-templates').where('assignedToUid', '==', caller.uid)),
      transaction.get(householdRef.collection('members').where('role', 'in', ['owner', 'admin'])),
    ]);
    const chores = assignedDocs(choresByEmail, choresByUid, caller.email);
    const templates = assignedDocs(templatesByEmail, templatesByUid, caller.email);
    if (householdSnap.get('deletingAt')) throw new MembershipError('This household is being deleted.');
    const member = memberSnap.exists ? memberSnap.data() || null : null;
    if (!member) throw new MembershipError('You are not part of this household.');
    if (member.role === 'owner') throw new MembershipError('Transfer ownership to someone else before leaving.');

    const iso = now.toISOString();
    transaction.delete(memberRef);
    transaction.delete(memberContactRef(householdRef, caller.uid));
    keepStatsIdentity(transaction, householdRef, caller.uid, caller.email, now, householdSnap.get('timeZone'));
    transaction.update(householdRef, { ...legacyMemberEmailRemoval(householdSnap.data(), caller.email), updatedAt: iso });
    transaction.set(adminDb.collection('users').doc(caller.email), { householdId: null, role: 'member', permissions: {} }, { merge: true });
    chores.filter(d => !d.data().isCompleted).forEach(d => transaction.update(d.ref, unassignChoreFields()));
    templates.forEach(d => transaction.update(d.ref, unassignTemplateFields(d)));
    transaction.set(householdRef.collection('auditLogs').doc(), {
      actorUid: caller.uid, actorEmail: caller.email, actorName: caller.displayName || null,
      action: 'member.left', targetUid: caller.uid, targetEmail: caller.email, createdAt: iso,
    });
    approverNotices(householdRef, approvers.docs.filter(d => d.id !== caller.uid), now, {
      title: 'Member left',
      // Sent to owners and admins only (member managers), who may see the email.
      message: `${caller.displayName || caller.email} left the household.`,
      sourceType: 'household-member-left',
      sourceId: caller.uid,
    }).forEach(([ref, data]) => transaction.set(ref, data));
  });
};

// Deleting: owner only, confirmed by typing the household name.
// 1. One transaction verifies the owner, marks the household `deletingAt`, sets every
//    membership to status 'deleting' and revokes every invite. Rules grant nothing to a
//    non-active membership, so from this point no client can read or write household
//    data or files, and joining/leaving are refused on the server.
// 2. Files, then every data subcollection, are removed.
// 3. Profiles, invites, memberships and the household document go in one final batch.
// If step 2 or 3 fails, the household stays frozen and the owner can run delete again.
export const deleteHousehold = async (caller: VerifiedCaller, householdId: string, confirmName: string, now = new Date()) => {
  const householdRef = adminDb.collection('households').doc(householdId);
  const invitesQuery = adminDb.collection('inviteCodes').where('householdId', '==', householdId);
  await adminDb.runTransaction(async transaction => {
    const [household, memberSnap, members, invites] = await Promise.all([
      transaction.get(householdRef),
      transaction.get(householdRef.collection('members').doc(caller.uid)),
      transaction.get(householdRef.collection('members')),
      transaction.get(invitesQuery),
    ]);
    if (!household.exists) throw new MembershipError('That household no longer exists.');
    const resuming = Boolean(household.get('deletingAt'));
    const member = memberSnap.exists ? memberSnap.data() || null : null;
    const allowedStatus = resuming ? ['deleting'] : ['active'];
    if (!member || member.role !== 'owner' || !allowedStatus.includes(member.status || 'active')) {
      throw new MembershipError('Only the household owner can delete it.');
    }
    if ((confirmName || '').trim() !== String(household.data()?.name || '').trim()) {
      throw new MembershipError('Type the household name exactly to confirm.');
    }
    if (resuming) return;
    transaction.update(householdRef, { deletingAt: Timestamp.fromDate(now), deletingByUid: caller.uid });
    members.docs.forEach(d => transaction.update(d.ref, { status: 'deleting' }));
    invites.docs.forEach(d => transaction.update(d.ref, { revokedAt: now.toISOString() }));
  });

  await deleteHouseholdFiles(householdId);
  const subcollections = await householdRef.listCollections();
  for (const collection of subcollections) {
    if (collection.id !== 'members') await adminDb.recursiveDelete(collection);
  }

  const [members, invites] = await Promise.all([
    householdRef.collection('members').get(),
    adminDb.collection('inviteCodes').where('householdId', '==', householdId).get(),
  ]);
  const emails = members.docs.map(d => d.data().email).filter((e): e is string => typeof e === 'string');
  const profiles = await Promise.all(emails.map(email => adminDb.collection('users').doc(email).get()));
  const batch = adminDb.batch();
  profiles.forEach(profile => {
    if (profile.exists && profile.data()?.householdId === householdId) {
      batch.set(profile.ref, { householdId: null, role: 'member', permissions: {} }, { merge: true });
    }
  });
  invites.docs.forEach(d => batch.delete(d.ref));
  members.docs.forEach(d => {
    batch.delete(memberContactRef(householdRef, d.id));
    batch.delete(d.ref);
  });
  batch.delete(householdRef);
  await batch.commit();
};

// ---------------------------------------------------------------------------
// Household management (rename, invites, roles, permissions, removal, transfer)
//
// Every operation runs in one transaction that re-reads the household and the
// actor's (and target's) membership records, applies the shared policy
// (`src/lib/household-policy.ts`), performs its writes and adds the activity-log
// entry. The actor in that entry always comes from the verified token and the
// time from the server clock; nothing the caller sends is trusted for either.
// ---------------------------------------------------------------------------

const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_TTL_MS = 30 * 60 * 1000;
const INVITE_CODE_ATTEMPTS = 6;

type Tx = FirebaseFirestore.Transaction;
type DocRef = FirebaseFirestore.DocumentReference;
type StoredMember = PolicyMember & { email: string; displayName?: string };

const requireId = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('/')) {
    throw new MembershipError(message, 'invalid_input');
  }
  return value;
};

const enforce = (decision: PolicyDecision) => {
  if (!decision.ok) throw new MembershipError(refusalMessage(decision.reason), decision.reason);
};

const KNOWN_ROLES: readonly HouseholdRole[] = ['owner', 'admin', 'member', 'child', 'guest', 'newuser'];

// A role the rules do not recognize (legacy names included) grants nothing here either.
const toStoredMember = (snapshot: FirebaseFirestore.DocumentSnapshot): StoredMember | null => {
  const data = snapshot.exists ? snapshot.data() : null;
  if (!data) return null;
  return {
    uid: snapshot.id,
    role: KNOWN_ROLES.includes(data.role) ? data.role as HouseholdRole : 'newuser',
    status: data.status || 'active',
    permissions: (data.permissions && typeof data.permissions === 'object' ? data.permissions : {}) as PermissionOverrides,
    email: typeof data.email === 'string' ? data.email : '',
    displayName: typeof data.displayName === 'string' && data.displayName ? data.displayName : undefined,
  };
};

type ActorContext = {
  householdRef: DocRef;
  household: FirebaseFirestore.DocumentData;
  actor: StoredMember;
};

/** Reads the household and the caller's membership inside the transaction. */
const loadActor = async (transaction: Tx, caller: VerifiedCaller, householdId: unknown): Promise<ActorContext> => {
  const id = requireId(householdId, 'That household no longer exists.');
  const householdRef = adminDb.collection('households').doc(id);
  const [householdSnap, actorSnap] = await Promise.all([
    transaction.get(householdRef),
    transaction.get(householdRef.collection('members').doc(caller.uid)),
  ]);
  if (!householdSnap.exists) throw new MembershipError('That household no longer exists.', 'not_found');
  if (householdSnap.get('deletingAt')) throw new MembershipError('This household is being deleted.', 'household_deleting');
  const actor = toStoredMember(actorSnap);
  if (!actor) throw new MembershipError('You are not part of this household.', 'not_member');
  return { householdRef, household: householdSnap.data() || {}, actor };
};

const loadTarget = async (transaction: Tx, householdRef: DocRef, targetUid: unknown): Promise<{ ref: DocRef; target: StoredMember }> => {
  const uid = requireId(targetUid, 'That person is no longer in this household.');
  const ref = householdRef.collection('members').doc(uid);
  const target = toStoredMember(await transaction.get(ref));
  if (!target) throw new MembershipError('That person is no longer in this household.', 'not_found');
  return { ref, target };
};

type AuditDetails = Record<string, string | number | boolean | null>;

/** Activity-log entry authored by the server: the actor is the verified caller. */
const writeAudit = (
  transaction: Tx,
  context: ActorContext,
  caller: VerifiedCaller,
  now: Date,
  entry: { action: string; target?: StoredMember; details?: AuditDetails },
) => {
  transaction.set(context.householdRef.collection('auditLogs').doc(), {
    actorUid: caller.uid,
    actorEmail: caller.email,
    actorName: context.actor.displayName || caller.displayName || null,
    action: entry.action,
    ...(entry.target ? {
      targetUid: entry.target.uid,
      targetEmail: entry.target.email,
      targetName: entry.target.displayName || null,
    } : {}),
    createdAt: now.toISOString(),
    ...(entry.details ? { details: entry.details } : {}),
  });
};

/** The profile cache (`users/{email}`) is display data only; it never grants access. */
const setProfileCache = (transaction: Tx, email: string, fields: { householdId?: string | null; role?: HouseholdRole; permissions?: PermissionOverrides }) => {
  if (!email) return;
  // mergeFields replaces `permissions` as a whole, so cleared overrides do not linger.
  transaction.set(adminDb.collection('users').doc(email), fields, { mergeFields: Object.keys(fields) });
};

const requireHouseholdName = (raw: unknown): string => {
  const checked = readHouseholdName(raw);
  if (!checked.ok) throw new MembershipError(checked.message, 'invalid_input');
  return checked.name;
};

const HOUSEHOLD_ID_ATTEMPTS = 8;

/**
 * Create a household with the caller as its owner. One transaction writes the
 * household, the owner's membership and its contact document, the profile pointer and the
 * `household.created` activity entry. Refused while the caller still belongs to
 * another household (their profile points at a household where they have a
 * membership record). A candidate ID that already exists is never reused, and
 * `create` makes the write fail rather than overwrite an existing household.
 */
export const createHousehold = async (
  caller: VerifiedCaller,
  input: { name: unknown; timeZone?: unknown },
  now = new Date(),
): Promise<CreateHouseholdResult> => {
  const name = requireHouseholdName(input?.name);
  const timeZone = normalizeTimeZone(input?.timeZone);
  const profileRef = adminDb.collection('users').doc(caller.email);

  return adminDb.runTransaction(async transaction => {
    const profileSnap = await transaction.get(profileRef);
    const profile = profileSnap.exists ? profileSnap.data() || {} : {};
    const currentHouseholdId = profile.householdId;
    if (typeof currentHouseholdId === 'string' && currentHouseholdId && !currentHouseholdId.includes('/')) {
      const existing = await transaction.get(
        adminDb.collection('households').doc(currentHouseholdId).collection('members').doc(caller.uid)
      );
      if (existing.exists) throw new MembershipError('Leave your current household before creating a new one.', 'conflict');
    }

    let householdRef: DocRef | null = null;
    for (let attempt = 0; attempt < HOUSEHOLD_ID_ATTEMPTS && !householdRef; attempt++) {
      const candidate = adminDb.collection('households').doc(householdIdFor(name, randomInt));
      if (!(await transaction.get(candidate)).exists) householdRef = candidate;
    }
    if (!householdRef) throw new MembershipError('Could not reserve a household ID. Please try again.', 'conflict');

    const iso = now.toISOString();
    // The name and photo the person chose in HomeHub; the token's are the fallback.
    // Public member data: never an email as the name (see syncMemberProfile).
    const displayName = publicMemberName(profile.displayName) || publicMemberName(caller.displayName) || undefined;
    const avatarUrl = membershipAvatarUrl(profile, caller.avatarUrl);
    // No emails on the household document (member privacy release C).
    const householdData: Omit<Household, 'id'> = {
      name,
      ownerUid: caller.uid,
      createdAt: iso,
      updatedAt: iso,
      // Reminders and recurring chores run on the server in this time zone.
      ...(timeZone ? { timeZone } : {}),
    };
    const member = {
      uid: caller.uid,
      email: caller.email,
      ...(displayName ? { displayName } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      role: 'owner',
      status: 'active',
      joinedAt: iso,
      approvedAt: iso,
      approvedByUid: caller.uid,
    } as HouseholdMember;

    transaction.create(householdRef, householdData);
    transaction.create(householdRef.collection('members').doc(caller.uid), member);
    transaction.set(memberContactRef(householdRef, caller.uid), memberContact(caller.email, now));
    setProfileCache(transaction, caller.email, { householdId: householdRef.id, role: 'owner', permissions: {} });
    writeAudit(transaction, {
      householdRef,
      household: householdData,
      actor: { uid: caller.uid, role: 'owner', status: 'active', permissions: {}, email: caller.email, displayName },
    }, caller, now, { action: 'household.created', details: { householdName: name } });
    return { household: { id: householdRef.id, ...householdData } as Household, member };
  });
};

/**
 * The daily "still needs a household role" reminder (`household.manageMembers`).
 * Household Manager calls it when someone who can approve opens the page. For
 * each pending person not reminded in the last 24 hours, one transaction stamps
 * `lastNewUserReminderAt` and writes a household-wide system notification whose
 * ID is fixed per person and day, so overlapping visits never duplicate it.
 */
export const remindPendingMembers = async (caller: VerifiedCaller, householdId: string, now = new Date()): Promise<{ count: number }> => {
  return adminDb.runTransaction(async transaction => {
    const context = await loadActor(transaction, caller, householdId);
    enforce(canRemindPendingMembers(context.actor));
    const pending = await transaction.get(context.householdRef.collection('members').where('role', '==', 'newuser'));
    const due = pending.docs.filter(d => pendingReminderDue(d.get('lastNewUserReminderAt'), now));
    const iso = now.toISOString();
    const stateKey = pendingReminderStateKey(now);
    for (const person of due) {
      const data = person.data();
      // Household-wide, so the public name only, never the email.
      const name = publicMemberName(data.displayName) || 'A member';
      transaction.update(person.ref, { lastNewUserReminderAt: iso });
      const notificationId = getDeterministicNotificationId({ sourceType: PENDING_REMINDER_SOURCE_TYPE, sourceId: person.id, stateKey });
      transaction.set(context.householdRef.collection('notifications').doc(notificationId), {
        householdId: context.householdRef.id,
        category: 'system',
        title: 'Pending member approval',
        message: `${name} still needs a household role.`,
        createdAt: Timestamp.fromDate(now),
        expiresAt: Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS),
        deepLink: '/household?tab=members',
        sourceType: PENDING_REMINDER_SOURCE_TYPE,
        sourceId: person.id,
        stateKey,
        // Household-wide, as before: every member with `notifications.view` sees it.
        audience: notificationAudience({}),
        readBy: {},
        dismissedBy: {},
      });
    }
    return { count: due.length };
  });
};

/** Rename the household (`household.manageMembers`). */
export const renameHousehold = async (caller: VerifiedCaller, householdId: string, rawName: string, now = new Date()): Promise<{ name: string }> => {
  const name = requireHouseholdName(rawName);
  return adminDb.runTransaction(async transaction => {
    const context = await loadActor(transaction, caller, householdId);
    enforce(canRenameHousehold(context.actor));
    const previousName = typeof context.household.name === 'string' ? context.household.name : '';
    if (previousName === name) return { name };
    transaction.update(context.householdRef, { name, updatedAt: now.toISOString() });
    writeAudit(transaction, context, caller, now, {
      action: 'household.renamed',
      details: { householdName: name, previousName },
    });
    return { name };
  });
};

const randomInviteCode = () => {
  const segment = (length: number) => Array.from({ length }, () => INVITE_CHARS[randomInt(INVITE_CHARS.length)]).join('');
  return `${segment(4)}-${segment(4)}-${segment(2)}`;
};

const inviteIsActive = (data: FirebaseFirestore.DocumentData, now: Date): boolean => {
  if (data.revokedAt) return false;
  const maxUses = typeof data.maxUses === 'number' ? data.maxUses : 1;
  const useCount = typeof data.useCount === 'number' ? data.useCount : 0;
  if (useCount >= maxUses) return false;
  const expiresAt = toDate(data.expiresAt);
  return Boolean(expiresAt && expiresAt > now);
};

/**
 * Create a single-use invite code that lasts 30 minutes (`household.manageInvites`).
 * The code is generated here; a code that already exists is never reused.
 */
export const createInvite = async (caller: VerifiedCaller, householdId: string, now = new Date()): Promise<InviteCode> => {
  return adminDb.runTransaction(async transaction => {
    const context = await loadActor(transaction, caller, householdId);
    enforce(canManageInvites(context.actor));
    let inviteRef: DocRef | null = null;
    for (let attempt = 0; attempt < INVITE_CODE_ATTEMPTS && !inviteRef; attempt++) {
      const candidate = adminDb.collection('inviteCodes').doc(randomInviteCode());
      if (!(await transaction.get(candidate)).exists) inviteRef = candidate;
    }
    if (!inviteRef) throw new MembershipError('Could not create an invite code. Please try again.', 'conflict');
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    const invite: InviteCode = {
      id: inviteRef.id,
      code: inviteRef.id,
      householdId: context.householdRef.id,
      householdName: typeof context.household.name === 'string' ? context.household.name : '',
      createdByUid: caller.uid,
      createdByEmail: caller.email,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      maxUses: 1,
      useCount: 0,
    };
    transaction.set(inviteRef, { ...invite, expiresAt: Timestamp.fromDate(expiresAt) });
    writeAudit(transaction, context, caller, now, { action: 'invite.generated', details: { code: invite.code } });
    return invite;
  });
};

/** Revoke one invite code of this household (`household.manageInvites`). */
export const revokeInvite = async (caller: VerifiedCaller, householdId: string, rawCode: string, now = new Date()): Promise<{ code: string }> => {
  const code = normalizeInviteCode(typeof rawCode === 'string' ? rawCode : '');
  if (!code) throw new MembershipError('That invite code was not found.', 'not_found');
  return adminDb.runTransaction(async transaction => {
    const context = await loadActor(transaction, caller, householdId);
    enforce(canManageInvites(context.actor));
    const inviteRef = adminDb.collection('inviteCodes').doc(code);
    const inviteSnap = await transaction.get(inviteRef);
    // A code of another household is reported exactly like one that does not exist.
    if (!inviteSnap.exists || inviteSnap.get('householdId') !== context.householdRef.id) {
      throw new MembershipError('That invite code was not found.', 'not_found');
    }
    if (inviteSnap.get('revokedAt')) return { code };
    transaction.update(inviteRef, { revokedAt: now.toISOString() });
    writeAudit(transaction, context, caller, now, { action: 'invite.revoked', details: { code } });
    return { code };
  });
};

/** Revoke every invite code that could still be used (`household.manageInvites`). */
export const revokeAllInvites = async (caller: VerifiedCaller, householdId: string, now = new Date()): Promise<{ count: number }> => {
  return adminDb.runTransaction(async transaction => {
    const context = await loadActor(transaction, caller, householdId);
    enforce(canManageInvites(context.actor));
    const invites = await transaction.get(adminDb.collection('inviteCodes').where('householdId', '==', context.householdRef.id));
    const active = invites.docs.filter(d => inviteIsActive(d.data(), now));
    if (active.length === 0) return { count: 0 };
    active.forEach(d => transaction.update(d.ref, { revokedAt: now.toISOString() }));
    writeAudit(transaction, context, caller, now, { action: 'invite.revoked_all', details: { count: active.length } });
    return { count: active.length };
  });
};

/**
 * Approve a pending person or change a member's role (`household.manageMembers`,
 * target strictly below the actor, new role strictly below the actor). A role
 * change resets the member's permission overrides, as it always has.
 */
export const changeMemberRole = async (
  caller: VerifiedCaller,
  householdId: string,
  targetUid: string,
  nextRole: HouseholdRole,
  now = new Date(),
): Promise<{ role: HouseholdRole; approved: boolean }> => {
  if (typeof nextRole !== 'string' || !assignableRoles.includes(nextRole)) {
    throw new MembershipError(refusalMessage('role_not_assignable'), 'role_not_assignable');
  }
  return adminDb.runTransaction(async transaction => {
    const context = await loadActor(transaction, caller, householdId);
    const { ref, target } = await loadTarget(transaction, context.householdRef, targetUid);
    enforce(canAssignRole(context.actor, target, nextRole));
    const approving = target.role === 'newuser';
    if (target.role === nextRole && target.status === 'active') return { role: nextRole, approved: false };
    const iso = now.toISOString();
    transaction.update(ref, {
      role: nextRole,
      status: 'active',
      permissions: {},
      approvedAt: iso,
      approvedByUid: caller.uid,
    });
    // Approval (re)writes the contact document, so a person who joined before it
    // existed has one from then on (the backfill covers everyone else).
    if (approving && target.email) transaction.set(memberContactRef(context.householdRef, target.uid), memberContact(target.email, now));
    setProfileCache(transaction, target.email, { role: nextRole, permissions: {} });
    writeAudit(transaction, context, caller, now, {
      action: approving ? 'member.approved' : 'member.role_changed',
      target,
      details: { role: nextRole, previousRole: target.role },
    });
    return { role: nextRole, approved: approving };
  });
};

const readOverrides = (input: unknown): PermissionOverrides => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MembershipError('Those permissions could not be read. Please try again.', 'invalid_input');
  }
  const known = new Set<string>(householdPermissions);
  const result: PermissionOverrides = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!known.has(key) || typeof value !== 'boolean') {
      throw new MembershipError('Those permissions could not be read. Please try again.', 'invalid_input');
    }
    const permission = key as HouseholdPermission;
    if (value && isOwnerOnlyPermission(permission)) throw new MembershipError(refusalMessage('owner_only'), 'owner_only');
    result[permission] = value;
  }
  return result;
};

/**
 * Replace a member's permission overrides (`household.manageRoles`; never your
 * own, never someone at or above your rank, never granting what you do not hold).
 * Only differences from the role default are stored. `expectedRole` is the role
 * the editor was showing: if the role changed meanwhile, nothing is saved.
 */
export const updateMemberPermissions = async (
  caller: VerifiedCaller,
  householdId: string,
  targetUid: string,
  overrides: PermissionOverrides,
  expectedRole?: HouseholdRole,
  now = new Date(),
): Promise<{ permissions: PermissionOverrides }> => {
  const requested = readOverrides(overrides);
  return adminDb.runTransaction(async transaction => {
    const context = await loadActor(transaction, caller, householdId);
    const { ref, target } = await loadTarget(transaction, context.householdRef, targetUid);
    // Who may edit whom comes first, so that refusal never depends on the payload.
    enforce(canEditPermissions(context.actor, target));
    if (expectedRole !== undefined && expectedRole !== target.role) {
      throw new MembershipError('Their role just changed. Check their permissions again before saving.', 'conflict');
    }
    const next = normalizeOverrides(target.role, requested);
    const changes = permissionChanges(target.role, target.permissions, next);
    enforce(canEditPermissions(context.actor, target, changes));
    const changed = Object.keys(changes) as HouseholdPermission[];
    if (changed.length === 0) return { permissions: next };
    transaction.update(ref, { permissions: next });
    setProfileCache(transaction, target.email, { permissions: next });
    writeAudit(transaction, context, caller, now, {
      action: 'member.permissions_changed',
      target,
      details: {
        granted: changed.filter(p => changes[p]).join(', '),
        revoked: changed.filter(p => !changes[p]).join(', '),
      },
    });
    return { permissions: next };
  });
};

/**
 * Remove a member or deny a pending request (`household.manageMembers`, target
 * strictly below the actor; the owner can never be removed). Their open chores
 * and recurring templates become unassigned; completed chores keep their history.
 */
export const removeMember = async (caller: VerifiedCaller, householdId: string, targetUid: string, now = new Date()): Promise<{ denied: boolean }> => {
  return adminDb.runTransaction(async transaction => {
    const context = await loadActor(transaction, caller, householdId);
    const { ref, target } = await loadTarget(transaction, context.householdRef, targetUid);
    enforce(canManageMember(context.actor, target));
    const profileRef = target.email ? adminDb.collection('users').doc(target.email) : null;
    // Assigned by email (older records) or by uid.
    const byEmail = (name: string) => target.email
      ? transaction.get(context.householdRef.collection(name).where('assignedToEmail', '==', target.email))
      : Promise.resolve(null);
    const byUid = (name: string) => transaction.get(context.householdRef.collection(name).where('assignedToUid', '==', target.uid));
    const [profileSnap, choresByEmail, choresByUid, templatesByEmail, templatesByUid, contactSnap] = await Promise.all([
      profileRef ? transaction.get(profileRef) : Promise.resolve(null),
      byEmail('chores'),
      byUid('chores'),
      byEmail('chore-templates'),
      byUid('chore-templates'),
      transaction.get(memberContactRef(context.householdRef, target.uid)),
    ]);
    const chores = assignedDocs(choresByEmail, choresByUid, target.email);
    const templates = assignedDocs(templatesByEmail, templatesByUid, target.email);

    const iso = now.toISOString();
    const denied = target.role === 'newuser';
    transaction.delete(ref);
    transaction.delete(memberContactRef(context.householdRef, target.uid));
    // The email upkeep credited them by: the contact document's, else the record's.
    if (!denied) keepStatsIdentity(transaction, context.householdRef, target.uid, contactEmailOf(contactSnap.exists ? contactSnap.data() : undefined) || target.email, now, context.household.timeZone);
    transaction.update(context.householdRef, {
      ...legacyMemberEmailRemoval(context.household, target.email),
      updatedAt: iso,
    });
    // Only a profile that still points here is cleared.
    if (profileRef && profileSnap?.exists && profileSnap.data()?.householdId === context.householdRef.id) {
      setProfileCache(transaction, target.email, { householdId: null, role: 'member', permissions: {} });
    }
    chores.filter(d => !d.data().isCompleted).forEach(d => transaction.update(d.ref, unassignChoreFields()));
    templates.forEach(d => transaction.update(d.ref, unassignTemplateFields(d)));
    writeAudit(transaction, context, caller, now, {
      action: 'member.removed',
      target,
      ...(denied ? { details: { pending: true } } : {}),
    });
    return { denied };
  });
};

/**
 * Hand the household to another approved member. Owner only, always: no
 * permission override can allow it. The previous owner becomes an admin, and
 * both people's overrides are cleared.
 */
export const transferOwnership = async (caller: VerifiedCaller, householdId: string, targetUid: string, now = new Date()): Promise<{ ownerUid: string }> => {
  return adminDb.runTransaction(async transaction => {
    const context = await loadActor(transaction, caller, householdId);
    const { ref, target } = await loadTarget(transaction, context.householdRef, targetUid);
    enforce(canTransferOwnership(context.actor, target));
    const iso = now.toISOString();
    // The owner is `ownerUid`; a legacy `ownerEmail` (the previous owner's) is removed, never rewritten.
    transaction.update(context.householdRef, {
      ownerUid: target.uid,
      ...('ownerEmail' in context.household ? { ownerEmail: FieldValue.delete() } : {}),
      updatedAt: iso,
    });
    transaction.update(ref, { role: 'owner', status: 'active', permissions: {} });
    transaction.update(context.householdRef.collection('members').doc(caller.uid), { role: 'admin', status: 'active', permissions: {} });
    setProfileCache(transaction, target.email, { role: 'owner', permissions: {} });
    setProfileCache(transaction, context.actor.email || caller.email, { role: 'admin', permissions: {} });
    writeAudit(transaction, context, caller, now, { action: 'ownership.transferred', target });
    const householdName = typeof context.household.name === 'string' && context.household.name ? context.household.name : 'the household';
    // One household-wide notice per transfer; a transaction retry reuses the ID.
    transaction.set(context.householdRef.collection('notifications').doc(`household-ownership-transfer-${target.uid}-${now.getTime()}`), {
      householdId: context.householdRef.id,
      category: 'system',
      title: 'Household ownership transferred',
      // Household-wide: the name only, never the email.
      message: `${target.displayName || 'A member'} is now the owner of ${householdName}.`,
      createdAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS),
      deepLink: '/household',
      sourceType: 'household-ownership-transfer',
      sourceId: target.uid,
      stateKey: String(now.getTime()),
      audience: notificationAudience({}),
      readBy: {},
      dismissedBy: {},
    });
    return { ownerUid: target.uid };
  });
};

// ---------------------------------------------------------------------------
// Public member data
//
// Housemates see each other through the membership records (name, photo, role,
// status, join time), never through each other's profiles. Members cannot write
// their own record under the rules, so a change of name or photo reaches it here.
// ---------------------------------------------------------------------------

// Same bound and email check as publicDisplayName (src/lib/member-directory.ts).
const MEMBER_NAME_MAX = 80;
const AVATAR_URL_MAX = 2048;

/** A profile name fit for housemates: trimmed, bounded, and never an email address. */
const publicMemberName = (value: unknown): string | null => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || /\S+@\S+/.test(name)) return null;
  return name.slice(0, MEMBER_NAME_MAX);
};

const publicAvatarUrl = (value: unknown): string | null =>
  typeof value === 'string' && value.startsWith('https://') && value.length <= AVATAR_URL_MAX ? value : null;

export type MemberProfileSync = { displayName: string | null; avatarUrl: string | null; changed: boolean };

/**
 * Copies the caller's own display name and photo from their profile
 * (`users/{email}`, read on the server, never taken from the request) onto their
 * membership record, so everyone in the household sees the current values. Only
 * those two fields change; a pending person may sync too (approvers see the name).
 */
export const syncMemberProfile = async (caller: VerifiedCaller, householdId: string): Promise<MemberProfileSync> => {
  const id = requireId(householdId, 'That household no longer exists.');
  const householdRef = adminDb.collection('households').doc(id);
  const memberRef = householdRef.collection('members').doc(caller.uid);
  const profileRef = adminDb.collection('users').doc(caller.email);
  return adminDb.runTransaction(async transaction => {
    const [householdSnap, memberSnap, profileSnap] = await Promise.all([
      transaction.get(householdRef),
      transaction.get(memberRef),
      transaction.get(profileRef),
    ]);
    if (!householdSnap.exists) throw new MembershipError('That household no longer exists.', 'not_found');
    if (householdSnap.get('deletingAt')) throw new MembershipError('This household is being deleted.', 'household_deleting');
    const status = memberSnap.exists ? (memberSnap.get('status') || 'active') : null;
    if (status !== 'active' && status !== 'pending') throw new MembershipError('You are not part of this household.', 'not_member');

    const profile = profileSnap.exists ? profileSnap.data() || {} : {};
    const displayName = publicMemberName(profile.displayName);
    const avatarUrl = publicAvatarUrl(profile.avatarUrl);
    const updates: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};
    const storedName = memberSnap.get('displayName');
    const storedAvatar = memberSnap.get('avatarUrl');
    if ((typeof storedName === 'string' ? storedName : null) !== displayName) {
      updates.displayName = displayName ?? FieldValue.delete();
    }
    if ((typeof storedAvatar === 'string' && storedAvatar ? storedAvatar : null) !== avatarUrl) {
      updates.avatarUrl = avatarUrl;
    }
    const changed = Object.keys(updates).length > 0;
    if (changed) transaction.update(memberRef, updates);
    return { displayName, avatarUrl, changed };
  });
};
