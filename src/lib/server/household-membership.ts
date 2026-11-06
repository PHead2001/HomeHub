import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminAuth, adminDb } from '@/lib/server/firebase-admin';
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
