'use server';

import { Timestamp } from 'firebase-admin/firestore';
import { authorizeHouseholdAction } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import { adminDb } from '@/lib/server/firebase-admin';
import { runHouseholdReminders } from '@functions/reminders';

// functions/ pins its own firebase-admin version; the Firestore calls used are
// identical across versions, so the instance is passed through untyped.
// Runs the same idempotent upkeep the hourly Cloud Function runs (recurring
// chores, retention, reminders), on demand for the caller's household, so a
// newly assigned recurring chore appears immediately.
// End-to-end tests pin the browser clock; the server follows the same pinned instant,
// but only against the emulator, so production always uses the real time.
const upkeepNow = () => {
  const configured = process.env.FIRESTORE_EMULATOR_HOST ? process.env.HOMEHUB_TEST_NOW : undefined;
  const parsed = configured ? new Date(configured) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

export async function syncHouseholdUpkeep(context: { idToken: string; householdId: string }) {
  try {
    const user = await authorizeHouseholdAction(context, 'chores.view');
    const result = await runHouseholdReminders(adminDb as never, user.householdId, upkeepNow(), d => Timestamp.fromDate(d) as never);
    return { ok: true as const, generatedChores: result.generatedChores };
  } catch (error) {
    if (!(error instanceof HomeHubAiError)) console.error('Household upkeep failed', error);
    return { ok: false as const };
  }
}
