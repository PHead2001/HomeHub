import 'server-only';

import type { HouseholdPermission, HouseholdRole } from '@/lib/types';
import { adminAuth, adminDb } from '@/lib/server/firebase-admin';
import { HomeHubAiError, type AiActionResult, toAiActionFailure } from '@/ai/errors';
import { resolveHouseholdAuthority } from '@/ai/household-authority';

export type AiActionContext = {
  idToken: string;
  householdId: string;
};

export type AuthorizedHouseholdUser = {
  uid: string;
  email: string;
  householdId: string;
  role: HouseholdRole;
  permissions: Record<HouseholdPermission, boolean>;
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

export const authorizeHouseholdAction = async (
  context: AiActionContext,
  permission?: HouseholdPermission
): Promise<AuthorizedHouseholdUser> => {
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
  const [householdSnapshot, memberSnapshot] = await Promise.all([
    householdRef.get(),
    memberRef.get(),
  ]);

  if (!householdSnapshot.exists) throw new HomeHubAiError('forbidden');

  const household = householdSnapshot.data() || {};
  const member = memberSnapshot.data();
  const authority = resolveHouseholdAuthority({ uid: decodedToken.uid, email, household, member });
  if (permission && !authority.permissions[permission]) throw new HomeHubAiError('forbidden');

  return { uid: decodedToken.uid, email, householdId: context.householdId, ...authority };
};

const runGuarded = async <T>(
  user: AuthorizedHouseholdUser,
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
  task: (user: AuthorizedHouseholdUser) => Promise<T>;
}): Promise<AiActionResult<T>> => {
  try {
    const user = await authorizeHouseholdAction(context, permission);
    const data = await runGuarded(user, flowName, maxRequestsPerMinute, () => task(user));
    return { ok: true, data };
  } catch (error) {
    return toAiActionFailure(error);
  }
};
