import 'server-only';

import { adminDb } from '@/lib/server/firebase-admin';
import { HomeAssistantError } from '@/lib/server/home-assistant';
import { getMemberPermissions } from '@/lib/permissions';
import type { HouseholdMember } from '@/lib/types';

// Stores Home Assistant credentials only if, at write time, the household still exists,
// is not being deleted, and the caller still may manage automation. Saving follows a
// connection test that can take seconds; re-checking in the same transaction means a
// household deleted (or a permission revoked) in the meantime never gets its token back.
// Server-only module: never import it from a 'use server' file's exports.
export const persistCredentials = async (householdId: string, uid: string, data: Record<string, unknown>) => {
  const householdRef = adminDb.collection('households').doc(householdId);
  await adminDb.runTransaction(async transaction => {
    const [household, member] = await Promise.all([
      transaction.get(householdRef),
      transaction.get(householdRef.collection('members').doc(uid)),
    ]);
    if (!household.exists || household.get('deletingAt')) {
      throw new HomeAssistantError('This household is no longer available.');
    }
    if (!member.exists || !getMemberPermissions(member.data() as HouseholdMember)['automation.manage']) {
      throw new HomeAssistantError('You no longer have permission to change the Home Assistant connection.');
    }
    transaction.set(householdRef.collection('home-automation').doc('credentials'), data);
  });
};
