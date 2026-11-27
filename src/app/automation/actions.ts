'use server';

import { authorizeHouseholdAction, type AuthorizedHouseholdUser } from '@/ai/action-auth';
import { HomeHubAiError } from '@/ai/errors';
import {
  HomeAssistantError,
  callHomeAssistantService,
  fetchHomeAssistantSnapshot,
  normalizeHomeAssistantUrl,
} from '@/lib/server/home-assistant';
import { changeConfig, deleteCredentials, persistCredentials, readConfig, readConnectedUrl, readCredentials, syncConnectedFlag } from '@/lib/server/home-assistant-store';
import { forgetSnapshot, householdSnapshot, takeControlSlot } from '@/lib/server/home-assistant-snapshot';
import { maySeeSensitive, visibleEntities, type HomeAssistantEntitySummary } from '@/lib/automation/entities';
import { configForViewer, type AutomationConfig } from '@/lib/automation/config';
import { controlService, isSafeScene } from '@/lib/automation/controls';
import { homeStatus, houseDevices, type HomeStatus, type RoomDevices } from '@/lib/automation/home-status';
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

export type HomeStatusResult = { connected: false } | { connected: true; status: HomeStatus; rooms: Record<string, RoomDevices>; fetchedAt: number };

/** AU-15 and AU-13: the dashboard's card and house marks, from the same cached read. */
export async function getHomeStatus(context: Context): Promise<Result<HomeStatusResult>> {
  return run(context, 'automation.view', async (user) => {
    if (!(await readConnectedUrl(user.householdId))) return { connected: false };
    const [snapshot, config] = await Promise.all([householdSnapshot(user.householdId), readConfig(user.householdId)]);
    const now = new Date();
    return {
      connected: true,
      status: homeStatus(snapshot.entities, now),
      rooms: houseDevices(snapshot.entities, config.rooms),
      fetchedAt: snapshot.fetchedAt,
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
 * One settings change, answered with what this caller may see (`configForViewer`): a child
 * or guest given automation.manage still never receives sensitive favourites (AU-11).
 */
const changeFor = async (user: AuthorizedHouseholdUser, change: unknown) =>
  configFor(user, await changeConfig(user.householdId, user.uid, change));

/**
 * AU-8, AU-11: each setting is its own action, applied by the server to the stored config
 * inside one transaction, so an older page never overwrites another manager's change.
 */
export async function setAutomationFavorite(context: Context, input: { entityId: string; pinned: boolean }): Promise<Result<AutomationConfig>> {
  return run(context, 'automation.manage', (user) =>
    changeFor(user, { kind: 'favorite', entityId: input?.entityId, pinned: input?.pinned }));
}

/** AU-13: place one device in a chore room, or take it off the house (`roomId: null`). */
export async function setAutomationRoom(context: Context, input: { entityId: string; roomId: string | null }): Promise<Result<AutomationConfig>> {
  return run(context, 'automation.manage', (user) =>
    changeFor(user, { kind: 'room', entityId: input?.entityId, roomId: input?.roomId }));
}

export async function setMembersSeeSensitive(context: Context, input: { show: boolean }): Promise<Result<AutomationConfig>> {
  return run(context, 'automation.manage', (user) =>
    changeFor(user, { kind: 'showSensitiveToMembers', show: input?.show }));
}

/**
 * AU-14: switch a light or fan on or off, or activate a scene. `automation.control`,
 * checked here; anything else (locks, alarms, garage doors, covers, cameras, scripts) is
 * refused before Home Assistant is contacted.
 */
export async function controlHomeAssistantEntity(context: Context, input: { entityId: string; desired: 'on' | 'off' }): Promise<Result<null>> {
  return run(context, 'automation.control', async (user) => {
    const call = controlService(input?.entityId, input?.desired);
    if (!call) throw new HomeAssistantError('HomeHub can only switch lights, fans and scenes.');
    if (!takeControlSlot(user.householdId)) throw new HomeAssistantError('Too many switches at once. Wait a few seconds and try again.');
    const credentials = await readCredentials(user.householdId);
    if (!credentials) throw new HomeAssistantError('Home Assistant is not connected yet.');
    if (call.domain === 'scene') {
      // A scene can set locks or garage doors too: only scenes of lights and fans run.
      const snapshot = await householdSnapshot(user.householdId);
      if (!isSafeScene(snapshot.entities.find((entity) => entity.entity_id === call.entityId))) {
        throw new HomeAssistantError('HomeHub only runs scenes made of lights and fans.');
      }
    }
    await callHomeAssistantService(credentials.url, credentials.token, call);
    forgetSnapshot(user.householdId);
    return null;
  });
}
