import 'server-only';

import type { HouseholdPermission, HouseholdRole } from '@/lib/types';
import { adminAuth, adminDb } from '@/lib/server/firebase-admin';
import { HomeHubAiError, type AiActionResult, toAiActionFailure } from '@/ai/errors';
import { resolveHouseholdAuthority } from '@/ai/household-authority';
import { consumeAiQuota } from '@/lib/server/ai-quota';

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

  const authority = resolveHouseholdAuthority({ uid: decodedToken.uid, member: memberSnapshot.data() });
  if (permission && !authority.permissions[permission]) throw new HomeHubAiError('forbidden');

  return { uid: decodedToken.uid, email, householdId: context.householdId, ...authority };
};

const runGuarded = async <T>(
  user: AuthorizedHouseholdUser,
  flowName: string,
  maxRequestsPerMinute: number,
  consumeQuota: boolean,
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
    // Durable per-user and per-household daily cap, shared across instances.
    if (consumeQuota) await consumeAiQuota({ uid: user.uid, householdId: user.householdId, flowName });
    return await task();
  } finally {
    inFlight.delete(guardKey);
  }
};

/**
 * Largest client payload (context + input, as JSON) an AI action accepts. Real
 * inputs are a few KB (a 60-item recipe request is about 12 KB). Rejecting larger
 * payloads before any validation bounds the work Genkit's pinned zod 3 can be made
 * to do (GHSA-mrhx-c7xc-m3w5, oversized constrained collections); see the AI/Genkit
 * module README.
 */
export const MAX_AI_ACTION_PAYLOAD_BYTES = 64 * 1024;

const payloadBytes = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export const executeAuthorizedAiAction = async <T>({
  context,
  input,
  permission,
  flowName,
  maxRequestsPerMinute,
  consumeQuota = true,
  task,
}: {
  context: AiActionContext;
  /** The action's client input, size-checked before authorization and validation. */
  input?: unknown;
  permission: HouseholdPermission;
  flowName: string;
  maxRequestsPerMinute: number;
  /**
   * Take one daily AI request before the task runs (default). Actions that do
   * non-AI work first and must still return it when the quota is used up (the
   * overview's exact facts) pass false and call consumeAiQuota around the model call.
   */
  consumeQuota?: boolean;
  task: (user: AuthorizedHouseholdUser) => Promise<T>;
}): Promise<AiActionResult<T>> => {
  try {
    if (payloadBytes({ context, input }) > MAX_AI_ACTION_PAYLOAD_BYTES) {
      throw new HomeHubAiError('invalid_input');
    }
    const user = await authorizeHouseholdAction(context, permission);
    const data = await runGuarded(user, flowName, maxRequestsPerMinute, consumeQuota, () => task(user));
    return { ok: true, data };
  } catch (error) {
    return toAiActionFailure(error);
  }
};
