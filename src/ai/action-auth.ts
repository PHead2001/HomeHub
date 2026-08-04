import 'server-only';

import type { HouseholdPermission, HouseholdRole, PermissionOverrides } from '@/lib/types';
import { hasPermission, normalizeRole } from '@/lib/permissions';
import { adminAuth, adminDb } from '@/lib/server/firebase-admin';
import { HomeHubAiError, type AiActionResult, toAiActionFailure } from '@/ai/errors';

export type AiActionContext = {
  idToken: string;
  householdId: string;
};

type AuthorizedAiUser = {
  uid: string;
  householdId: string;
};

type AiGuardState = typeof globalThis & {
  __homeHubAiInFlight?: Set<string>;
  __homeHubAiRequestWindows?: Map<string, number[]>;
};

const globalGuardState = globalThis as AiGuardState;
const inFlight = globalGuardState.__homeHubAiInFlight || new Set<string>();
const requestWindows = globalGuardState.__homeHubAiRequestWindows || new Map<string, number[]>();
globalGuardState.__homeHubAiInFlight = inFlight;
globalGuardState.__homeHubAiRequestWindows = requestWindows;

const authorizeAiAction = async (
  context: AiActionContext,
  permission: HouseholdPermission
): Promise<AuthorizedAiUser> => {
  if (!context?.idToken || !context.householdId) throw new HomeHubAiError('unauthenticated');

  let decodedToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(context.idToken);
  } catch {
    throw new HomeHubAiError('unauthenticated');
  }

  const email = typeof decodedToken.email === 'string' ? decodedToken.email : '';
  if (!email) throw new HomeHubAiError('unauthenticated');

  const householdRef = adminDb.collection('households').doc(context.householdId);
  const memberRef = householdRef.collection('members').doc(decodedToken.uid);
  const [householdSnapshot, memberSnapshot, profileSnapshot] = await Promise.all([
    householdRef.get(),
    memberRef.get(),
    adminDb.collection('users').doc(email).get(),
  ]);

  if (!householdSnapshot.exists) throw new HomeHubAiError('forbidden');

  const household = householdSnapshot.data() || {};
  const member = memberSnapshot.data();
  const profile = profileSnapshot.data() || {};
  const legacyMemberEmails = Array.isArray(household.memberEmails) ? household.memberEmails : [];
  const isLegacyMember = legacyMemberEmails.includes(email);

  if (!member && !isLegacyMember) throw new HomeHubAiError('forbidden');
  if (member?.status === 'pending' || member?.role === 'newuser') throw new HomeHubAiError('forbidden');

  const role = normalizeRole((member?.role
    || (household.ownerUid === decodedToken.uid || household.ownerEmail === email ? 'owner' : profile.role)) as HouseholdRole);
  const overrides = (member?.permissions || profile.permissions || {}) as PermissionOverrides;
  if (!hasPermission(role, permission, overrides)) throw new HomeHubAiError('forbidden');

  return { uid: decodedToken.uid, householdId: context.householdId };
};

const runGuarded = async <T>(
  user: AuthorizedAiUser,
  flowName: string,
  maxRequestsPerMinute: number,
  task: () => Promise<T>
) => {
  const guardKey = `${user.uid}:${user.householdId}:${flowName}`;
  if (inFlight.has(guardKey)) throw new HomeHubAiError('busy');

  const now = Date.now();
  const recent = (requestWindows.get(guardKey) || []).filter(timestamp => now - timestamp < 60_000);
  if (recent.length >= maxRequestsPerMinute) throw new HomeHubAiError('rate_limited');

  recent.push(now);
  requestWindows.set(guardKey, recent);
  inFlight.add(guardKey);
  try {
    return await task();
  } finally {
    inFlight.delete(guardKey);
  }
};

export const executeAuthorizedAiAction = async <T>({
  context,
  permission,
  flowName,
  maxRequestsPerMinute,
  task,
}: {
  context: AiActionContext;
  permission: HouseholdPermission;
  flowName: string;
  maxRequestsPerMinute: number;
  task: () => Promise<T>;
}): Promise<AiActionResult<T>> => {
  try {
    const user = await authorizeAiAction(context, permission);
    const data = await runGuarded(user, flowName, maxRequestsPerMinute, task);
    return { ok: true, data };
  } catch (error) {
    return toAiActionFailure(error);
  }
};
