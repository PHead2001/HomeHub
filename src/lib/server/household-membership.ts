import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb, adminStorageBucket } from '@/lib/server/firebase-admin';
import { normalizeInviteCode } from '@/lib/invite-codes';
import type { Household, HouseholdMember } from '@/lib/types';

export class MembershipError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
  }
}

const NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    const expiresAt = toDate(invite.expiresAt);
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
    for (const approver of approversSnap.docs) {
      const approverData = approver.data();
      if (approverData.status && approverData.status !== 'active') continue;
      transaction.set(householdRef.collection('notifications').doc(`household-newuser-${caller.uid}-${approver.id}`), {
        householdId,
        category: 'system',
        title: 'New member needs approval',
        message: `${name} joined with an invite code. Choose their role to let them in.`,
        createdAt,
        expiresAt: expires,
        deepLink: '/household?tab=members',
        sourceType: 'household-newuser',
        sourceId: caller.uid,
        targetUserUid: approver.id,
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

const memberRecord = async (householdId: string, uid: string) => {
  const snap = await adminDb.collection('households').doc(householdId).collection('members').doc(uid).get();
  return snap.exists ? snap.data() || null : null;
};

const notifyApprovers = (
  batch: FirebaseFirestore.WriteBatch,
  householdRef: FirebaseFirestore.DocumentReference,
  approvers: FirebaseFirestore.QueryDocumentSnapshot[],
  now: Date,
  fields: { title: string; message: string; sourceType: string; sourceId: string }
) => {
  for (const approver of approvers) {
    const data = approver.data();
    if (data.status && data.status !== 'active') continue;
    batch.set(householdRef.collection('notifications').doc(`${fields.sourceType}-${fields.sourceId}-${approver.id}`), {
      householdId: householdRef.id,
      category: 'system',
      createdAt: Timestamp.fromDate(now),
      expiresAt: Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS),
      deepLink: '/household?tab=members',
      targetUserUid: approver.id,
      readBy: {},
      dismissedBy: {},
      ...fields,
    });
  }
};

// Leaving: any non-owner. Chores and recurring templates assigned to the leaver
// become unassigned so nothing keeps being scheduled for someone who left.
export const leaveHousehold = async (caller: VerifiedCaller, householdId: string, now = new Date()) => {
  const member = await memberRecord(householdId, caller.uid);
  if (!member) throw new MembershipError('You are not part of this household.');
  if (member.role === 'owner') throw new MembershipError('Transfer ownership to someone else before leaving.');

  const householdRef = adminDb.collection('households').doc(householdId);
  const [chores, templates, approvers] = await Promise.all([
    householdRef.collection('chores').where('assignedToEmail', '==', caller.email).get(),
    householdRef.collection('chore-templates').where('assignedToEmail', '==', caller.email).get(),
    householdRef.collection('members').where('role', 'in', ['owner', 'admin']).get(),
  ]);
  const batch = adminDb.batch();
  const iso = now.toISOString();
  batch.delete(householdRef.collection('members').doc(caller.uid));
  batch.update(householdRef, { memberEmails: FieldValue.arrayRemove(caller.email), updatedAt: iso });
  batch.set(adminDb.collection('users').doc(caller.email), { householdId: null, role: 'member', permissions: {} }, { merge: true });
  chores.docs.filter(d => !d.data().isCompleted).forEach(d =>
    batch.update(d.ref, { assignedToEmail: '', assignedToDisplayName: 'Unassigned' }));
  templates.docs.forEach(d => batch.update(d.ref, {
    assignedToEmail: FieldValue.delete(),
    'recurrence.assignedToEmail': FieldValue.delete(),
  }));
  batch.set(householdRef.collection('auditLogs').doc(), {
    actorUid: caller.uid, actorEmail: caller.email, actorName: caller.displayName || null,
    action: 'member.left', targetUid: caller.uid, targetEmail: caller.email, createdAt: iso,
  });
  notifyApprovers(batch, householdRef, approvers.docs.filter(d => d.id !== caller.uid), now, {
    title: 'Member left',
    message: `${caller.displayName || caller.email} left the household.`,
    sourceType: 'household-member-left',
    sourceId: caller.uid,
  });
  await batch.commit();
};

// Deleting: owner only, confirmed by typing the household name. Removes every
// subcollection, the household's invites and files, and clears members' profiles.
export const deleteHousehold = async (caller: VerifiedCaller, householdId: string, confirmName: string) => {
  const householdRef = adminDb.collection('households').doc(householdId);
  const [household, member] = await Promise.all([householdRef.get(), memberRecord(householdId, caller.uid)]);
  if (!household.exists) throw new MembershipError('That household no longer exists.');
  if (!member || member.role !== 'owner' || (member.status && member.status !== 'active')) {
    throw new MembershipError('Only the household owner can delete it.');
  }
  if ((confirmName || '').trim() !== String(household.data()?.name || '').trim()) {
    throw new MembershipError('Type the household name exactly to confirm.');
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
  await batch.commit();
  await deleteHouseholdFiles(householdId);
  await adminDb.recursiveDelete(householdRef);
};
