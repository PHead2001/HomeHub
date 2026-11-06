import 'server-only';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/firebase-admin';
import { HomeHubAiError } from '@/ai/errors';

// Durable daily AI quota, shared by every server instance. The in-memory guard in
// action-auth.ts only limits bursts on one instance and resets on cold start; this
// caps spend per person and per household per UTC day.
const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
export const AI_DAILY_USER_LIMIT = positive(process.env.AI_DAILY_USER_LIMIT, 150);
export const AI_DAILY_HOUSEHOLD_LIMIT = positive(process.env.AI_DAILY_HOUSEHOLD_LIMIT, 400);
// Usage documents are removed by the Firestore TTL policy on aiUsage.expiresAt.
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

export type AiQuotaLimits = { user: number; household: number };

/**
 * Records one AI request for the caller and their household, atomically, or throws
 * `quota_exceeded` without recording anything when either daily limit is reached.
 * Call only after the caller has been authorized for the household.
 */
export const consumeAiQuota = async (
  { uid, householdId, flowName }: { uid: string; householdId: string; flowName: string },
  now = new Date(),
  limits: AiQuotaLimits = { user: AI_DAILY_USER_LIMIT, household: AI_DAILY_HOUSEHOLD_LIMIT },
) => {
  const day = utcDay(now);
  const usage = adminDb.collection('aiUsage');
  const userRef = usage.doc(`user_${uid}_${day}`);
  const householdRef = usage.doc(`household_${householdId}_${day}`);
  const expiresAt = Timestamp.fromMillis(Date.parse(`${day}T00:00:00Z`) + RETENTION_MS);

  await adminDb.runTransaction(async transaction => {
    const [userSnap, householdSnap] = await Promise.all([transaction.get(userRef), transaction.get(householdRef)]);
    const userCount = (userSnap.get('count') as number | undefined) ?? 0;
    const householdCount = (householdSnap.get('count') as number | undefined) ?? 0;
    if (userCount >= limits.user || householdCount >= limits.household) {
      throw new HomeHubAiError('quota_exceeded');
    }
    const record = (scope: 'user' | 'household', id: string) => ({
      scope,
      id,
      day,
      count: FieldValue.increment(1),
      [`byFlow.${flowName}`]: FieldValue.increment(1),
      updatedAt: Timestamp.fromDate(now),
      expiresAt,
    });
    // set+merge with dotted keys would create a literal "byFlow.x" field, so build the
    // nested map explicitly for a new document and use update for an existing one.
    const write = (ref: typeof userRef, exists: boolean, scope: 'user' | 'household', id: string) => {
      if (exists) {
        transaction.update(ref, record(scope, id));
      } else {
        transaction.set(ref, {
          scope, id, day, count: 1, byFlow: { [flowName]: 1 },
          updatedAt: Timestamp.fromDate(now), expiresAt,
        });
      }
    };
    write(userRef, userSnap.exists, 'user', uid);
    write(householdRef, householdSnap.exists, 'household', householdId);
  });
};
