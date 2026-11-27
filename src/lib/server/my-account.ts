import 'server-only';

import { adminAuth, adminDb, adminStorageBucket } from '@/lib/server/firebase-admin';
import { MembershipError, leaveHousehold, type VerifiedCaller } from '@/lib/server/household-membership';
import { DELETION_BLOCKER_COPY, accountDeletionBlocker, exportableProfile, isRecentSignIn, toPlain } from '@/lib/profile/account-data';

/**
 * "Download my data" (audit PR-26). Everything is read on the server for the
 * verified caller only: their profile (without device push tokens), how many
 * devices get their pushes, their own membership record and household name, chores
 * assigned to or completed by them, and notifications addressed to them. Nothing of
 * another member is included (no emails, no PINs: PIN material lives in separate
 * documents that are not read). Lists are capped so the file stays small.
 */
export const EXPORT_LIST_CAP = 500;

export type MyDataExport = {
  format: 'homehub-my-data/1';
  exportedAt: string;
  account: { uid: string; email: string };
  profile: Record<string, unknown> | null;
  pushDevices: number;
  household: { id: string; name: string | null; membership: Record<string, unknown> } | null;
  choresAssigned: Array<Record<string, unknown>>;
  choresCompleted: Array<Record<string, unknown>>;
  notifications: Array<Record<string, unknown>>;
  notes: string[];
};

const CHORE_FIELDS = ['task', 'dueDate', 'originalDueDate', 'isCompleted', 'completedAt', 'roomIds', 'notes'] as const;
const NOTIFICATION_FIELDS = ['category', 'title', 'message', 'createdAt', 'deepLink'] as const;

const pick = (id: string, data: Record<string, unknown>, fields: readonly string[]) =>
  ({ id, ...Object.fromEntries(fields.filter((field) => field in data).map((field) => [field, toPlain(data[field])])) });

export async function exportMyData(caller: VerifiedCaller, now = new Date()): Promise<MyDataExport> {
  const profileRef = adminDb.collection('users').doc(caller.email);
  const [profileSnap, pushSnap] = await Promise.all([profileRef.get(), profileRef.collection('private').doc('push').get()]);
  const profile = profileSnap.exists ? profileSnap.data() ?? {} : undefined;
  const tokens = pushSnap.exists ? pushSnap.get('fcmTokens') : [];
  const householdId = typeof profile?.householdId === 'string' && profile.householdId ? profile.householdId : null;

  let household: MyDataExport['household'] = null;
  let choresAssigned: MyDataExport['choresAssigned'] = [];
  let choresCompleted: MyDataExport['choresCompleted'] = [];
  let notifications: MyDataExport['notifications'] = [];
  if (householdId) {
    const houseRef = adminDb.collection('households').doc(householdId);
    const [houseSnap, memberSnap] = await Promise.all([houseRef.get(), houseRef.collection('members').doc(caller.uid).get()]);
    if (houseSnap.exists && memberSnap.exists) {
      household = {
        id: householdId,
        name: typeof houseSnap.get('name') === 'string' ? houseSnap.get('name') as string : null,
        membership: toPlain(memberSnap.data() ?? {}) as Record<string, unknown>,
      };
      const [assigned, completed, notes] = await Promise.all([
        houseRef.collection('chores').where('assignedToUid', '==', caller.uid).limit(EXPORT_LIST_CAP).get(),
        houseRef.collection('chores').where('completedByUid', '==', caller.uid).limit(EXPORT_LIST_CAP).get(),
        houseRef.collection('notifications').where('targetUserUid', '==', caller.uid).limit(EXPORT_LIST_CAP).get(),
      ]);
      choresAssigned = assigned.docs.map((d) => pick(d.id, d.data(), CHORE_FIELDS));
      choresCompleted = completed.docs.map((d) => pick(d.id, d.data(), CHORE_FIELDS));
      notifications = notes.docs.map((d) => pick(d.id, d.data(), NOTIFICATION_FIELDS));
    }
  }

  return {
    format: 'homehub-my-data/1',
    exportedAt: now.toISOString(),
    account: { uid: caller.uid, email: caller.email },
    profile: exportableProfile(profile),
    pushDevices: Array.isArray(tokens) ? tokens.length : 0,
    household,
    choresAssigned,
    choresCompleted,
    notifications,
    notes: [
      `Lists are capped at ${EXPORT_LIST_CAP} entries each.`,
      'Shared household records (shopping lists, pets, maintenance) belong to the household and are not included.',
    ],
  };
}

/**
 * The caller of a sensitive account action: a person (with an email, never a wall
 * tablet), whose token is unrevoked and who signed in within the last five minutes
 * (`auth_time`), so a phone left unlocked cannot delete the account on its own.
 */
export async function verifyRecentCaller(idToken: unknown, nowMs = Date.now()): Promise<VerifiedCaller> {
  if (!idToken || typeof idToken !== 'string') throw new MembershipError('Please sign in again.', 'unauthenticated');
  let decoded: Awaited<ReturnType<typeof adminAuth.verifyIdToken>>;
  try {
    decoded = await adminAuth.verifyIdToken(idToken, true);
  } catch {
    throw new MembershipError('Your sign-in has expired. Please sign in again.', 'unauthenticated');
  }
  if (typeof decoded.email !== 'string' || !decoded.email) throw new MembershipError('Please sign in again.', 'unauthenticated');
  if (!isRecentSignIn(decoded.auth_time, nowMs)) {
    throw new MembershipError('For your safety, confirm with Google again, then delete your account.', 'unauthenticated');
  }
  return { uid: decoded.uid, email: decoded.email, displayName: typeof decoded.name === 'string' ? decoded.name : undefined };
}

export type AccountDeletion = { leftHousehold: boolean; householdsLeft: number; filesDeleted: number };

/**
 * Every household that lists the caller as a member, found by account ID (not by
 * the profile's `householdId` pointer, which the person may clear themselves): a
 * collection-group query on `members` where `uid == caller.uid` (single-field
 * collection-group index in firestore.indexes.json), restricted to
 * `households/{id}/members/{uid}`, plus the pointed-at household read by document
 * id for records written before `uid` was stored.
 */
async function callerMemberships(caller: VerifiedCaller, pointedHouseholdId: string) {
  const found = new Map<string, FirebaseFirestore.DocumentSnapshot>();
  const byUid = await adminDb.collectionGroup('members').where('uid', '==', caller.uid).get();
  for (const snap of byUid.docs) {
    const household = snap.ref.parent.parent;
    if (snap.id !== caller.uid || !household || household.parent.id !== 'households') continue;
    found.set(household.id, snap);
  }
  if (pointedHouseholdId && !found.has(pointedHouseholdId)) {
    const snap = await adminDb.collection('households').doc(pointedHouseholdId).collection('members').doc(caller.uid).get();
    if (snap.exists) found.set(pointedHouseholdId, snap);
  }
  return found;
}

/**
 * "Delete my account" (audit PR-26). Refused while ANY household lists the caller
 * as its owner (hand the household on, or delete it, first), whatever the profile's
 * household pointer says. Otherwise, in an order that can be run again after a
 * partial failure:
 * 1. leave every household found with the existing `leaveHousehold` (membership
 *    record, contact document, tablet PINs and sessions, open chores unassigned,
 *    stats kept under a former-member key, owners and admins notified); a household
 *    already being deleted is left to its deletion;
 * 2. delete the profile `users/{email}` with its subcollections (private push
 *    tokens, the legacy inbox);
 * 3. delete the person's profile photos (`users/{uid}/avatars/` and the older
 *    `users/{email}/avatars/`);
 * 4. delete the Firebase Auth user last (which also revokes its sessions), so a
 *    failure before it leaves the person able to sign in and run it again.
 */
export async function deleteMyAccount(caller: VerifiedCaller, now = new Date()): Promise<AccountDeletion> {
  const profileRef = adminDb.collection('users').doc(caller.email);
  const profileSnap = await profileRef.get();
  const pointed = profileSnap.exists && typeof profileSnap.get('householdId') === 'string' ? profileSnap.get('householdId') as string : '';
  const memberships = await callerMemberships(caller, pointed);

  // Every ownership is checked before anything is changed.
  const toLeave: string[] = [];
  for (const [householdId, mine] of memberships) {
    const householdRef = adminDb.collection('households').doc(householdId);
    const [householdSnap, members] = await Promise.all([householdRef.get(), householdRef.collection('members').get()]);
    const others = members.docs.filter((d) => d.id !== caller.uid).map((d) => d.data());
    const blocker = accountDeletionBlocker(mine.data(), others) ?? (householdSnap.get('ownerUid') === caller.uid ? accountDeletionBlocker({ role: 'owner' }, others) : null);
    if (blocker) throw new MembershipError(DELETION_BLOCKER_COPY[blocker], 'conflict');
    if (householdSnap.exists && !householdSnap.get('deletingAt')) toLeave.push(householdId);
  }
  for (const householdId of toLeave) await leaveHousehold(caller, householdId, now);
  const leftHousehold = toLeave.length > 0;

  await adminDb.recursiveDelete(profileRef);

  let filesDeleted = 0;
  const bucket = adminStorageBucket();
  if (bucket) {
    for (const folder of [caller.uid, caller.email]) {
      const [files] = await bucket.getFiles({ prefix: `users/${folder}/avatars/` });
      await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
      filesDeleted += files.length;
    }
  }

  try {
    await adminAuth.deleteUser(caller.uid);
  } catch (error) {
    if ((error as { code?: string })?.code !== 'auth/user-not-found') throw error;
  }
  return { leftHousehold, householdsLeft: toLeave.length, filesDeleted };
}
