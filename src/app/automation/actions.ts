'use server';

import { authorizeHouseholdAction } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import { adminDb } from '@/lib/server/firebase-admin';
import {
  HomeAssistantError,
  fetchHomeAssistantStates,
  normalizeHomeAssistantUrl,
  type HomeAssistantEntitySummary,
} from '@/lib/server/home-assistant';
import type { HouseholdPermission } from '@/lib/types';

// Every call derives identity from a verified ID token and authorizes against the
// caller's membership record; caller-supplied email or household IDs prove nothing.
type Context = { idToken: string; householdId: string };
type Result<T> = { ok: true; data: T } | { ok: false; message: string };

const credentialsRef = (householdId: string) =>
  adminDb.collection('households').doc(householdId).collection('home-automation').doc('credentials');

const run = async <T>(context: Context, permission: HouseholdPermission, task: (householdId: string, uid: string) => Promise<T>): Promise<Result<T>> => {
  try {
    const user = await authorizeHouseholdAction(context, permission);
    return { ok: true, data: await task(user.householdId, user.uid) };
  } catch (error) {
    if (error instanceof HomeAssistantError) return { ok: false, message: error.userMessage };
    if (error instanceof HomeHubAiError) {
      return {
        ok: false,
        message: error.code === 'unauthenticated'
          ? 'Your sign-in has expired. Please sign in again.'
          : 'You do not have permission to do that in this household.',
      };
    }
    console.error('Home Assistant action failed', error);
    return { ok: false, message: 'Something went wrong on our side. Please try again in a moment.' };
  }
};

export type HomeAssistantStatus = { configured: boolean; host: string | null };

export async function getHomeAssistantStatus(context: Context): Promise<Result<HomeAssistantStatus>> {
  return run(context, 'automation.view', async householdId => {
    const snapshot = await credentialsRef(householdId).get();
    const url = snapshot.exists ? snapshot.data()?.url : null;
    let host: string | null = null;
    try {
      host = typeof url === 'string' ? new URL(url).host : null;
    } catch {
      host = null;
    }
    return { configured: snapshot.exists, host };
  });
}

export async function getHomeAssistantEntities(context: Context): Promise<Result<HomeAssistantEntitySummary[]>> {
  return run(context, 'automation.view', async householdId => {
    const snapshot = await credentialsRef(householdId).get();
    const data = snapshot.data();
    if (!snapshot.exists || typeof data?.url !== 'string' || typeof data?.accessToken !== 'string') {
      throw new HomeAssistantError('Home Assistant is not connected yet.');
    }
    return fetchHomeAssistantStates(data.url, data.accessToken);
  });
}

export async function saveHomeAssistantConnection(
  context: Context,
  input: { url: string; accessToken: string }
): Promise<Result<{ host: string; entityCount: number }>> {
  return run(context, 'automation.manage', async (householdId, uid) => {
    const token = (input.accessToken || '').trim();
    if (token.length < 20) throw new HomeAssistantError('Paste the full long-lived access token from your Home Assistant profile.');
    const url = await normalizeHomeAssistantUrl(input.url);
    // Only store credentials that actually work.
    const entities = await fetchHomeAssistantStates(url, token);
    await credentialsRef(householdId).set({ url, accessToken: token, updatedAt: new Date().toISOString(), updatedByUid: uid });
    return { host: new URL(url).host, entityCount: entities.length };
  });
}

export async function disconnectHomeAssistant(context: Context): Promise<Result<null>> {
  return run(context, 'automation.manage', async householdId => {
    await credentialsRef(householdId).delete();
    return null;
  });
}
