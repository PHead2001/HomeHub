'use server';

import { authorizeHouseholdAction, type AuthorizedHouseholdUser } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import {
  HomeAssistantError,
  fetchHomeAssistantSnapshot,
  normalizeHomeAssistantUrl,
} from '@/lib/server/home-assistant';
import { changeConfig, deleteCredentials, persistCredentials, readConfig, readConnectedUrl, syncConnectedFlag } from '@/lib/server/home-assistant-store';
import { forgetSnapshot, householdSnapshot } from '@/lib/server/home-assistant-snapshot';
import { maySeeSensitive, visibleEntities, type HomeAssistantEntitySummary } from '@/lib/automation/entities';
import { configForViewer, type AutomationConfig } from '@/lib/automation/config';
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

/** AU-11: whether this caller may see people, trackers, cameras and locks. */
const sensitiveFor = (user: AuthorizedHouseholdUser, config: AutomationConfig) => maySeeSensitive(user.role, config.showSensitiveToMembers);

const configFor = (user: AuthorizedHouseholdUser, config: AutomationConfig) =>
  configForViewer(config, { role: user.role, canManage: Boolean(user.permissions['automation.manage']) });

export type HomeAssistantStatus = {
  configured: boolean;
  host: string | null;
  config: AutomationConfig;
  canSeeSensitive: boolean;
};

export async function getHomeAssistantStatus(context: Context): Promise<Result<HomeAssistantStatus>> {
  return run(context, 'automation.view', async (user) => {
    // A token that can't be read still counts as connected (managers can replace it).
    const [url, config] = await Promise.all([readConnectedUrl(user.householdId), readConfig(user.householdId)]);
    // AU-6: households connected before the flag existed get it now (never fails the read).
    await syncConnectedFlag(user.householdId).catch((error) => console.error('Home Assistant flag sync failed', error));
    let host: string | null = null;
    try {
      host = url ? new URL(url).host : null;
    } catch {
      host = null;
    }
    return { configured: url !== null, host, config: configFor(user, config), canSeeSensitive: sensitiveFor(user, config) };
  });
}

export type HomeAssistantEntities = {
  entities: HomeAssistantEntitySummary[];
  /** Server time of the Home Assistant read these states came from (AU-1). */
  fetchedAt: number;
  total: number;
  truncated: boolean;
  /** AU-11: how many entities were withheld from this caller. */
  hiddenSensitive: number;
};

export async function getHomeAssistantEntities(context: Context): Promise<Result<HomeAssistantEntities>> {
  return run(context, 'automation.view', async (user) => {
    const [snapshot, config] = await Promise.all([householdSnapshot(user.householdId), readConfig(user.householdId)]);
    const visible = visibleEntities(snapshot.entities, user.role, config.showSensitiveToMembers);
    return {
      entities: visible.entities,
      fetchedAt: snapshot.fetchedAt,
      total: snapshot.total,
      truncated: snapshot.truncated,
      hiddenSensitive: visible.hidden,
    };
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
    await persistCredentials(user.householdId, user.uid, { url, accessToken: token });
    forgetSnapshot(user.householdId);
    return { host: new URL(url).host, entityCount: snapshot.total };
  });
}

/** AU-9: a new token for the connected address, tested before it replaces the old one. */
export async function replaceHomeAssistantToken(context: Context, input: { accessToken: string }): Promise<Result<{ host: string; entityCount: number }>> {
  return run(context, 'automation.manage', async (user) => {
    const token = readToken(input?.accessToken);
    // The stored address, even when the old token can no longer be read.
    const url = await readConnectedUrl(user.householdId);
    if (!url) throw new HomeAssistantError('Home Assistant is not connected. Connect it first.');
    const snapshot = await fetchHomeAssistantSnapshot(url, token);
    await persistCredentials(user.householdId, user.uid, { url, accessToken: token }, { mode: 'replace' });
    forgetSnapshot(user.householdId);
    return { host: new URL(url).host, entityCount: snapshot.total };
  });
}

export async function disconnectHomeAssistant(context: Context): Promise<Result<null>> {
  return run(context, 'automation.manage', async (user) => {
    await deleteCredentials(user.householdId, user.uid);
    forgetSnapshot(user.householdId);
    return null;
  });
}

/**
 * AU-8, AU-11: each setting is its own action, applied by the server to the stored config
 * inside one transaction, so an older page never overwrites another manager's change.
 */
export async function setAutomationFavorite(context: Context, input: { entityId: string; pinned: boolean }): Promise<Result<AutomationConfig>> {
  return run(context, 'automation.manage', (user) =>
    changeConfig(user.householdId, user.uid, { kind: 'favorite', entityId: input?.entityId, pinned: input?.pinned }));
}

export async function setMembersSeeSensitive(context: Context, input: { show: boolean }): Promise<Result<AutomationConfig>> {
  return run(context, 'automation.manage', (user) =>
    changeConfig(user.householdId, user.uid, { kind: 'showSensitiveToMembers', show: input?.show }));
}
