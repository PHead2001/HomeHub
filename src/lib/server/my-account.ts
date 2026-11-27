import 'server-only';

import { adminDb } from '@/lib/server/firebase-admin';
import type { VerifiedCaller } from '@/lib/server/household-membership';
import { exportableProfile, toPlain } from '@/lib/profile/account-data';

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
