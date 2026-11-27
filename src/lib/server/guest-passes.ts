import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/firebase-admin';
import { devicesEnabled } from '@/lib/server/device-identity';
import { writeDeviceAudit } from '@/lib/server/device-audit';
import { MembershipError, requireIdentityManager, type VerifiedCaller } from '@/lib/server/household-membership';
import {
  GUEST_IDENTITY_PREFIX,
  GUEST_NAME_MAX,
  memberIsCurrent,
  readGuestName,
  readGuestPassHours,
  tabletPassOverrides,
} from '@/lib/guest-pass';

// Tablet guest passes (audit HO-24, WT-21; docs/modules/household-governance/README.md,
// "Guest passes"): a temporary face on registered wall tablets with no account behind it.
// `members/guest_<id>` with `kind: 'identity'`, role Guest, status active, `accessUntil`
// (a Timestamp, at most a week ahead) and permission overrides for what the pass allows
// (feed pets: `pets.addLogs`; tick chores: `chores.complete`). No contact document, no
// profile, no Auth user. "Who's here?" shows it only until `accessUntil`, the device gate
// refuses it from then on, and the guest-pass sweep removes it. Owners and admins (role)
// create it from Members; removing it early is Remove (the identity removal body).

const requireId = (value: unknown, message: string): string => {
  if (typeof value !== 'string' || !value || value.length > 200 || value.includes('/')) throw new MembershipError(message, 'invalid_input');
  return value;
};

export type TabletGuestPassInput = {
  householdId: unknown;
  name: unknown;
  hours: unknown;
  feedPets?: unknown;
  tickChores?: unknown;
};

export const createTabletGuestPass = async (caller: VerifiedCaller, input: TabletGuestPassInput, now = new Date()) => {
  if (!devicesEnabled()) throw new MembershipError("Tablet guest passes aren't available yet.", 'unavailable');
  const name = readGuestName(input?.name);
  if (!name) throw new MembershipError(`Give the guest pass a name (1 to ${GUEST_NAME_MAX} characters, not an email address).`, 'invalid_input');
  const hours = readGuestPassHours(input?.hours);
  if (!hours) throw new MembershipError('Choose 4 hours, 1 day or 1 week for a guest pass.', 'invalid_input');
  const permissions = tabletPassOverrides({ feedPets: input?.feedPets === true, tickChores: input?.tickChores === true });
  if (Object.keys(permissions).length === 0) {
    throw new MembershipError('Choose at least one thing the guest may do on the tablets.', 'invalid_input');
  }
  return adminDb.runTransaction(async tx => {
    const householdRef = adminDb.collection('households').doc(requireId(input?.householdId, 'That household no longer exists.'));
    const [household, member] = await Promise.all([tx.get(householdRef), tx.get(householdRef.collection('members').doc(caller.uid))]);
    if (!household.exists) throw new MembershipError('That household no longer exists.', 'not_found');
    if (household.get('deletingAt')) throw new MembershipError('This household is being deleted.', 'household_deleting');
    if (!member.exists) throw new MembershipError('You are not part of this household.', 'not_member');
    const data = member.data() || {};
    requireIdentityManager({ uid: caller.uid, role: data.role, status: memberIsCurrent(data) ? 'active' : 'expired' });
    const actorName = typeof data.displayName === 'string' && data.displayName.trim() && !/\S+@\S+/.test(data.displayName)
      ? data.displayName.trim() : null;
    // A Firestore auto id: 20 letters and digits, never an account uid.
    const uid = `${GUEST_IDENTITY_PREFIX}${householdRef.collection('members').doc().id}`;
    const accessUntil = Timestamp.fromMillis(now.getTime() + hours * 60 * 60 * 1000);
    tx.create(householdRef.collection('members').doc(uid), {
      uid,
      kind: 'identity',
      role: 'guest',
      status: 'active',
      displayName: name,
      avatarUrl: null,
      permissions,
      accessUntil,
      joinedAt: now.toISOString(),
      createdAt: Timestamp.fromDate(now),
      createdByUid: caller.uid,
    });
    writeDeviceAudit(tx, householdRef, {
      action: 'guest.created', actorUid: caller.uid, actorName, via: 'members',
      targetUid: uid, targetName: name,
      details: { accessUntil: accessUntil.toDate().toISOString(), abilities: Object.keys(permissions).join(', ') },
    }, now);
    return { guestId: uid, name, accessUntil: accessUntil.toDate().toISOString() };
  });
};
