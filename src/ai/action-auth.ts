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
 * payloads before authorization or any schema validation keeps that work bounded to
 * small inputs (defense in depth; the zod 3 advisory GHSA-mrhx-c7xc-m3w5 that first
 * motivated it is fixed by zod 4.6.6+); see the AI module README.
 */
export const MAX_AI_ACTION_PAYLOAD_BYTES = 64 * 1024;

/**
 * True when the payload's size (roughly its JSON size) exceeds `budget`. Walks the
 * value node by node and stops as soon as the running total passes the budget, so
 * the work is bounded by the budget itself: every node visited adds at least one
 * unit. Shared references (which Server Actions can transport) and cycles are
 * counted each time they are reached, as JSON would expand them, but never
 * materialized, so a tiny request cannot make this check allocate a large string.
 */
export const exceedsPayloadBudget = (value: unknown, budget: number): boolean => {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    total += 1;
    if (typeof node === 'string') total += node.length;
    else if (typeof node === 'number' || typeof node === 'bigint') total += 8;
    else if (node !== null && typeof node === 'object') {
      if (Array.isArray(node)) {
        for (let index = node.length - 1; index >= 0; index -= 1) {
          stack.push(node[index]);
          if (total + stack.length > budget) return true;
        }
      } else {
        for (const key of Object.keys(node)) {
          total += key.length + 1;
          stack.push((node as Record<string, unknown>)[key]);
          if (total + stack.length > budget) return true;
        }
      }
    }
    if (total > budget) return true;
  }
  return false;
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
    if (exceedsPayloadBudget({ context, input }, MAX_AI_ACTION_PAYLOAD_BYTES)) {
      throw new HomeHubAiError('invalid_input');
    }
    const user = await authorizeHouseholdAction(context, permission);
    const data = await runGuarded(user, flowName, maxRequestsPerMinute, consumeQuota, () => task(user));
    return { ok: true, data };
  } catch (error) {
    return toAiActionFailure(error);
  }
};
