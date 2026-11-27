import 'server-only';

import { adminDb } from '@/lib/server/firebase-admin';
import { HomeAssistantError } from '@/lib/server/home-assistant';
import { getMemberPermissions } from '@/lib/permissions';
import type { HouseholdMember } from '@/lib/types';

// Home Assistant credentials (docs/modules/home-automation/README.md), server-only at
// households/{h}/home-automation/credentials (the rules deny every client).
// Server-only module: never import it from a 'use server' file's exports.

export const credentialsRef = (householdId: string) =>
  adminDb.collection('households').doc(householdId).collection('home-automation').doc('credentials');

export type StoredCredentials = { url: string; token: string; version: string };

/** The usable credentials, or null when not connected. `version` keys the AU-10 cache. */
export const readCredentials = async (householdId: string): Promise<StoredCredentials | null> => {
  const data = (await credentialsRef(householdId).get()).data();
  if (typeof data?.url !== 'string' || typeof data?.accessToken !== 'string') return null;
  return { url: data.url, token: data.accessToken, version: typeof data.updatedAt === 'string' ? data.updatedAt : 'legacy' };
};

/** The connected address, or null when not connected. */
export const readConnectedUrl = async (householdId: string): Promise<string | null> => {
  const url = (await credentialsRef(householdId).get()).get('url');
  return typeof url === 'string' ? url : null;
};

// Stores Home Assistant credentials only if, at write time, the household still exists,
// is not being deleted, and the caller still may manage automation. Saving follows a
// connection test that can take seconds; re-checking in the same transaction means a
// household deleted (or a permission revoked) in the meantime never gets its token back.
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
