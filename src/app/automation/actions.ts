'use server';

import { authorizeHouseholdAction, type AuthorizedHouseholdUser } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import {
  HomeAssistantError,
  fetchHomeAssistantSnapshot,
  normalizeHomeAssistantUrl,
} from '@/lib/server/home-assistant';
import { credentialsRef, persistCredentials, readConnectedUrl } from '@/lib/server/home-assistant-store';
import { forgetSnapshot, householdSnapshot } from '@/lib/server/home-assistant-snapshot';
import type { HomeAssistantEntitySummary } from '@/lib/automation/entities';
import type { HouseholdPermission } from '@/lib/types';

// Every call derives identity from a verified ID token and authorizes against the
// caller's membership record; caller-supplied email or household IDs prove nothing.
// Authorization always runs before the input is read. A wall tablet's own token is
// refused here (no email); tablets never reach Home Assistant.
type Context = { idToken: string; householdId: string };
type Result<T> = { ok: true; data: T } | { ok: false; message: string };

const run = async <T>(context: Context, permission: HouseholdPermission, task: (user: AuthorizedHouseholdUser) => Promise<T>): Promise<Result<T>> => {
  try {
    const user = await authorizeHouseholdAction(context, permission);
    return { ok: true, data: await task(user) };
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

export type HomeAssistantStatus = {
  configured: boolean;
  host: string | null;
};

export async function getHomeAssistantStatus(context: Context): Promise<Result<HomeAssistantStatus>> {
  return run(context, 'automation.view', async (user) => {
    const url = await readConnectedUrl(user.householdId);
    let host: string | null = null;
    try {
      host = url ? new URL(url).host : null;
    } catch {
      host = null;
    }
    return { configured: url !== null, host };
  });
}

export type HomeAssistantEntities = {
  entities: HomeAssistantEntitySummary[];
  /** Server time of the Home Assistant read these states came from (AU-1). */
  fetchedAt: number;
  total: number;
  truncated: boolean;
};

export async function getHomeAssistantEntities(context: Context): Promise<Result<HomeAssistantEntities>> {
  return run(context, 'automation.view', async (user) => {
    const snapshot = await householdSnapshot(user.householdId);
    return { entities: snapshot.entities, fetchedAt: snapshot.fetchedAt, total: snapshot.total, truncated: snapshot.truncated };
  });
}

const readToken = (value: unknown) => {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token.length < 20 || token.length > 4096) throw new HomeAssistantError('Paste the full long-lived access token from your Home Assistant profile.');
  return token;
};

export async function saveHomeAssistantConnection(
  context: Context,
  input: { url: string; accessToken: string }
): Promise<Result<{ host: string; entityCount: number }>> {
  return run(context, 'automation.manage', async (user) => {
    const token = readToken(input?.accessToken);
    const url = await normalizeHomeAssistantUrl(typeof input?.url === 'string' ? input.url : '');
    // Only store credentials that actually work.
    const snapshot = await fetchHomeAssistantSnapshot(url, token);
    await persistCredentials(user.householdId, user.uid, { url, accessToken: token, updatedAt: new Date().toISOString(), updatedByUid: user.uid });
    forgetSnapshot(user.householdId);
    return { host: new URL(url).host, entityCount: snapshot.total };
  });
}

export async function disconnectHomeAssistant(context: Context): Promise<Result<null>> {
  return run(context, 'automation.manage', async (user) => {
    await credentialsRef(user.householdId).delete();
    forgetSnapshot(user.householdId);
    return null;
  });
}

