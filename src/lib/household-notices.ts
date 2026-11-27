/**
 * Pure wording and identities for the household's membership notices (audit HO-1,
 * HO-7, HO-28; NO-10 is the same problem, owned by HO-7). The server actions in
 * `src/lib/server/household-membership.ts` write them; no Firebase, so unit tests run
 * without an emulator.
 *
 * - The person approved, or whose role changed, gets a notice addressed to them alone
 *   (`household-member-approved`, `household-member-role-changed`).
 * - "New member needs approval" and the daily "still needs a household role" reminder
 *   are addressed to the people who may approve (`household.manageMembers`), and are
 *   resolved (`resolvedAt`) once the request is approved, denied or cancelled.
 */

import { PENDING_REMINDER_SOURCE_TYPE } from '@/lib/household-records';
import type { HouseholdRole } from '@/lib/types';

export const MEMBER_APPROVED_SOURCE_TYPE = 'household-member-approved';
export const MEMBER_ROLE_CHANGED_SOURCE_TYPE = 'household-member-role-changed';
export const JOIN_REQUEST_SOURCE_TYPE = 'household-newuser';

/** Notices about a pending person that stop being useful once the request is settled. */
export const PENDING_NOTICE_SOURCE_TYPES: readonly string[] = [JOIN_REQUEST_SOURCE_TYPE, PENDING_REMINDER_SOURCE_TYPE];

const ROLE_NAMES: Record<HouseholdRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  child: 'Child',
  guest: 'Guest',
  newuser: 'Pending',
};

const roleName = (role: HouseholdRole | null | undefined): string => (role ? ROLE_NAMES[role] ?? 'Member' : 'Member');

const householdText = (name: string | null | undefined): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed || 'the household';
};

export type MemberNotice = { title: string; message: string; sourceType: string; deepLink: string };

/**
 * The notice for the person whose membership changed: "You're in" on approval, "Your
 * role changed" otherwise. Addressed to that person only (it names their role, nobody
 * else's data).
 */
export function memberRoleNotice(input: {
  approved: boolean;
  role: HouseholdRole;
  previousRole?: HouseholdRole | null;
  householdName?: string | null;
}): MemberNotice {
  const household = householdText(input.householdName);
  if (input.approved) {
    return {
      title: "You're in",
      message: `You joined ${household} as ${roleName(input.role)}.`,
      sourceType: MEMBER_APPROVED_SOURCE_TYPE,
      deepLink: '/',
    };
  }
  const from = input.previousRole && input.previousRole !== 'newuser' ? ` from ${roleName(input.previousRole)}` : '';
  return {
    title: 'Your role changed',
    message: `Your role in ${household} changed${from} to ${roleName(input.role)}.`,
    sourceType: MEMBER_ROLE_CHANGED_SOURCE_TYPE,
    deepLink: '/household',
  };
}

/** Document id of a member notice: one per change and recipient; a transaction retry reuses it. */
export const memberNoticeId = (sourceType: string, uid: string, at: Date): string => `${sourceType}-${uid}-${at.getTime()}`;

/**
 * Document id of the daily pending reminder for one recipient: fixed per pending
 * person, day and recipient, so overlapping visits write one document each.
 */
export const pendingReminderNoticeId = (pendingUid: string, recipientUid: string, stateKey: string): string =>
  `${PENDING_REMINDER_SOURCE_TYPE}-${pendingUid}-${recipientUid}-${stateKey.replace(/[^A-Za-z0-9-]/g, '_')}`;

/** Whether a stored notice is an open notice about a pending request (to resolve once it is settled). */
export const isOpenPendingNotice = (data: { sourceType?: unknown; resolvedAt?: unknown } | undefined): boolean =>
  Boolean(data) && typeof data!.sourceType === 'string' && PENDING_NOTICE_SOURCE_TYPES.includes(data!.sourceType) && !data!.resolvedAt;
