import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb, adminStorageBucket } from '@/lib/server/firebase-admin';
import { devicesEnabled } from '@/lib/server/device-identity';
import { writeDeviceAudit } from '@/lib/server/device-audit';
import {
  MembershipError,
  deleteIdentityAvatarFiles,
  removeIdentityInTransaction,
  requireIdentityManager,
  type VerifiedCaller,
} from '@/lib/server/household-membership';
import { CHILD_NAME_MAX, isChildIdentityUid, kidAvatarPathOf, readChildName } from '@/lib/devices/child-identities';

// Kid profiles (child identities; docs/modules/devices/README.md, "Actors"; HO-15a-c,
// D-T9, JC-9): membership records `households/{h}/members/kid_<id>` with
// `kind: 'identity'`, role Child (fixed) and status active. No contact document, no
// `users/{email}` profile, no Firebase Auth user, no email: they cannot sign in. They
// are face-row actors on wall tablets and attribution targets. Owners and admins
// (role) create, rename, re-photo and remove them from their own devices.

type DocRef = FirebaseFirestore.DocumentReference;

const requireFlag = () => {
  if (!devicesEnabled()) throw new MembershipError("Kid profiles aren't available yet.", 'unavailable');
};

const requireId = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('/')) throw new MembershipError(message, 'invalid_input');
  return value;
};

/** The household (exists, not deleting) and the caller as an active owner or admin, in the transaction. */
const loadManager = async (tx: FirebaseFirestore.Transaction, caller: VerifiedCaller, householdId: unknown) => {
  const householdRef = adminDb.collection('households').doc(requireId(householdId, 'That household no longer exists.'));
  const [household, member] = await Promise.all([tx.get(householdRef), tx.get(householdRef.collection('members').doc(caller.uid))]);
  if (!household.exists) throw new MembershipError('That household no longer exists.', 'not_found');
  if (household.get('deletingAt')) throw new MembershipError('This household is being deleted.', 'household_deleting');
  if (!member.exists) throw new MembershipError('You are not part of this household.', 'not_member');
  const data = member.data() || {};
  requireIdentityManager({ uid: caller.uid, role: data.role, status: data.status ?? 'active' });
  const name = typeof data.displayName === 'string' && data.displayName.trim() && !/\S+@\S+/.test(data.displayName) ? data.displayName.trim() : null;
  return { householdRef, actorName: name };
};

const requireName = (value: unknown): string => {
  const name = readChildName(value);
  if (!name) throw new MembershipError(`Give the kid profile a name (1 to ${CHILD_NAME_MAX} characters, not an email address).`, 'invalid_input');
  return name;
};

/**
 * A photo for this kid profile: a Firebase Storage download URL of a file under
 * `households/{h}/members/{kid}/avatar/` (uploaded there by an owner or admin), or null.
 */
const requireAvatar = (value: unknown, householdId: string, childId: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2048 || kidAvatarPathOf(value) === null ||
    !kidAvatarPathOf(value)!.startsWith(`households/${householdId}/members/${childId}/avatar/`)) {
    throw new MembershipError("That photo can't be used. Upload it again.", 'invalid_input');
  }
  return value;
};

const loadChild = async (tx: FirebaseFirestore.Transaction, householdRef: DocRef, childId: unknown) => {
  const id = requireId(childId, 'That kid profile no longer exists.');
  if (!isChildIdentityUid(id)) throw new MembershipError('That kid profile no longer exists.', 'not_found');
  const snap = await tx.get(householdRef.collection('members').doc(id));
  if (!snap.exists || snap.get('kind') !== 'identity') throw new MembershipError('That kid profile no longer exists.', 'not_found');
  return snap;
};

/** Creates a kid profile (a name; the photo is added with an update once uploaded). */
export const createChildIdentity = async (caller: VerifiedCaller, input: { householdId: unknown; name: unknown }, now = new Date()) => {
  requireFlag();
  const name = requireName(input?.name);
  return adminDb.runTransaction(async tx => {
    const context = await loadManager(tx, caller, input?.householdId);
    // A Firestore auto id: 20 letters and digits, never an account uid.
    const uid = `kid_${context.householdRef.collection('members').doc().id}`;
    const ref = context.householdRef.collection('members').doc(uid);
    const iso = now.toISOString();
    tx.create(ref, {
      uid,
      kind: 'identity',
      role: 'child',
      status: 'active',
      displayName: name,
      avatarUrl: null,
      permissions: {},
      joinedAt: iso,
      createdAt: Timestamp.fromDate(now),
      createdByUid: caller.uid,
    });
    writeDeviceAudit(tx, context.householdRef, {
      action: 'child.created', actorUid: caller.uid, actorName: context.actorName, via: 'members',
      targetUid: uid, targetName: name,
    }, now);
    return { childId: uid, name };
  });
};

/** Renames a kid profile or changes its photo (`avatarUrl: null` removes it). */
export const updateChildIdentity = async (
  caller: VerifiedCaller,
  input: { householdId: unknown; childId: unknown; name?: unknown; avatarUrl?: unknown },
  now = new Date(),
) => {
  requireFlag();
  const name = input?.name === undefined ? undefined : requireName(input.name);
  const result = await adminDb.runTransaction(async tx => {
    const context = await loadManager(tx, caller, input?.householdId);
    const child = await loadChild(tx, context.householdRef, input?.childId);
    const avatarUrl = input?.avatarUrl === undefined ? undefined : requireAvatar(input.avatarUrl, context.householdRef.id, child.id);
    const updates: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};
    const changed: string[] = [];
    if (name !== undefined && name !== child.get('displayName')) {
      updates.displayName = name;
      changed.push('name');
    }
    if (avatarUrl !== undefined && avatarUrl !== (child.get('avatarUrl') ?? null)) {
      updates.avatarUrl = avatarUrl;
      changed.push('photo');
    }
    if (changed.length === 0) return { changed, previousAvatar: null as string | null };
    tx.update(child.ref, updates);
    writeDeviceAudit(tx, context.householdRef, {
      action: 'child.updated', actorUid: caller.uid, actorName: context.actorName, via: 'members',
      targetUid: child.id, targetName: (name ?? child.get('displayName')) || null, details: { fields: changed.join(', ') },
    }, now);
    const previous = child.get('avatarUrl');
    return { changed, previousAvatar: changed.includes('photo') && typeof previous === 'string' ? previous : null };
  });
  // The replaced photo file goes after the commit (best effort).
  const previousPath = kidAvatarPathOf(result.previousAvatar);
  const bucket = previousPath ? adminStorageBucket() : null;
  if (bucket && previousPath) {
    await bucket.file(previousPath).delete({ ignoreNotFound: true })
      .catch(error => console.warn('Old kid profile photo could not be deleted.', error instanceof Error ? error.message : String(error)));
  }
  return { changed: result.changed };
};

/**
 * Removes a kid profile: the same transaction body `removeMember` uses for one (open
 * chores and templates unassigned, completed history kept, PIN documents deleted),
 * then its photo files.
 */
export const removeChildIdentity = async (caller: VerifiedCaller, input: { householdId: unknown; childId: unknown }, now = new Date()) => {
  requireFlag();
  const removed = await adminDb.runTransaction(async tx => {
    const context = await loadManager(tx, caller, input?.householdId);
    const child = await loadChild(tx, context.householdRef, input?.childId);
    await removeIdentityInTransaction(tx, context.householdRef, {
      uid: child.id, displayName: typeof child.get('displayName') === 'string' ? child.get('displayName') : undefined,
    }, { uid: caller.uid, name: context.actorName }, now);
    return { householdId: context.householdRef.id, childId: child.id };
  });
  await deleteIdentityAvatarFiles(removed.householdId, removed.childId);
  return { removed: true };
};
