import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb, adminStorageBucket } from '@/lib/server/firebase-admin';
import { normalizeInviteCode } from '@/lib/invite-codes';
import type { Household, HouseholdMember } from '@/lib/types';
import { notificationAudience } from '@functions/shared/notification-audience';

export class MembershipError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
  }
}

const NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

export type VerifiedCaller = { uid: string; email: string; displayName?: string; avatarUrl?: string };

// Identity always comes from a verified Firebase ID token, never from caller-supplied fields.
export const verifyCaller = async (idToken: string): Promise<VerifiedCaller> => {
  if (!idToken) throw new MembershipError('Please sign in again.');
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
    throw new MembershipError('Your sign-in has expired. Please sign in again.');
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

export type JoinResult = { household: Household; member: HouseholdMember };

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
    const member: HouseholdMember = {
      uid: caller.uid,
      email: caller.email,
      ...(caller.displayName ? { displayName: caller.displayName } : {}),
      ...(caller.avatarUrl ? { avatarUrl: caller.avatarUrl } : {}),
      role: 'newuser',
      status: 'pending',
      inviteCode: code,
      joinedAt,
    } as HouseholdMember;

    transaction.set(memberRef, member);
    transaction.update(householdRef, { memberEmails: FieldValue.arrayUnion(caller.email), updatedAt: joinedAt });
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

    const household = { id: householdSnap.id, ...householdSnap.data() } as Household;
    return { household, member };
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

// Leaving: any non-owner. Chores and recurring templates assigned to the leaver
// become unassigned so nothing keeps being scheduled for someone who left.
// The membership is read inside the transaction, so a concurrent ownership
// transfer to the leaver forces a retry and the leave is then refused.
export const leaveHousehold = async (caller: VerifiedCaller, householdId: string, now = new Date()) => {
  const householdRef = adminDb.collection('households').doc(householdId);
  const memberRef = householdRef.collection('members').doc(caller.uid);
  await adminDb.runTransaction(async transaction => {
    const [householdSnap, memberSnap, chores, templates, approvers] = await Promise.all([
      transaction.get(householdRef),
      transaction.get(memberRef),
      transaction.get(householdRef.collection('chores').where('assignedToEmail', '==', caller.email)),
      transaction.get(householdRef.collection('chore-templates').where('assignedToEmail', '==', caller.email)),
      transaction.get(householdRef.collection('members').where('role', 'in', ['owner', 'admin'])),
    ]);
    if (householdSnap.get('deletingAt')) throw new MembershipError('This household is being deleted.');
    const member = memberSnap.exists ? memberSnap.data() || null : null;
    if (!member) throw new MembershipError('You are not part of this household.');
    if (member.role === 'owner') throw new MembershipError('Transfer ownership to someone else before leaving.');

    const iso = now.toISOString();
    transaction.delete(memberRef);
    transaction.update(householdRef, { memberEmails: FieldValue.arrayRemove(caller.email), updatedAt: iso });
    transaction.set(adminDb.collection('users').doc(caller.email), { householdId: null, role: 'member', permissions: {} }, { merge: true });
    chores.docs.filter(d => !d.data().isCompleted).forEach(d =>
      transaction.update(d.ref, { assignedToEmail: '', assignedToDisplayName: 'Unassigned' }));
    templates.docs.forEach(d => transaction.update(d.ref, {
      assignedToEmail: FieldValue.delete(),
      'recurrence.assignedToEmail': FieldValue.delete(),
    }));
    transaction.set(householdRef.collection('auditLogs').doc(), {
      actorUid: caller.uid, actorEmail: caller.email, actorName: caller.displayName || null,
      action: 'member.left', targetUid: caller.uid, targetEmail: caller.email, createdAt: iso,
    });
    approverNotices(householdRef, approvers.docs.filter(d => d.id !== caller.uid), now, {
      title: 'Member left',
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
  members.docs.forEach(d => batch.delete(d.ref));
  batch.delete(householdRef);
  await batch.commit();
};
