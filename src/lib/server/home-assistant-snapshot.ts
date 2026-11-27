import 'server-only';

import { HomeAssistantError, fetchHomeAssistantSnapshot, type HomeAssistantSnapshot } from '@/lib/server/home-assistant';
import { readCredentials } from '@/lib/server/home-assistant-store';
import { SnapshotCache } from '@/lib/automation/snapshot-cache';

// AU-10: every read of Home Assistant states goes through this cache, so polling pages,
// the dashboard card and several tablets cost at most one request per household every
// 15 s on a server instance.

const cache = new SnapshotCache<HomeAssistantSnapshot>();

export type HouseholdSnapshot = HomeAssistantSnapshot & { fetchedAt: number };

/** The household's states, from the cache when fresh enough; throws HomeAssistantError when not connected. */
export const householdSnapshot = async (householdId: string): Promise<HouseholdSnapshot> => {
  const credentials = await readCredentials(householdId);
  if (!credentials) throw new HomeAssistantError('Home Assistant is not connected yet.');
  const result = await cache.get(householdId, credentials.version, () => fetchHomeAssistantSnapshot(credentials.url, credentials.token));
  return { ...result.value, fetchedAt: result.fetchedAt };
};

const CONTROL_WINDOW_MS = 10_000;
const CONTROL_LIMIT = 20;
const controlWindows = new Map<string, number[]>();

/** AU-10 for writes: at most 20 switch requests per household every 10 s on an instance. */
export const takeControlSlot = (householdId: string, now = Date.now()): boolean => {
  const recent = (controlWindows.get(householdId) ?? []).filter((at) => now - at < CONTROL_WINDOW_MS);
  if (recent.length >= CONTROL_LIMIT) {
    controlWindows.set(householdId, recent);
    return false;
  }
  recent.push(now);
  controlWindows.set(householdId, recent);
  if (controlWindows.size > 500) controlWindows.delete(controlWindows.keys().next().value as string);
  return true;
};

/** After a control or a disconnect: the next read asks Home Assistant again. */
export const forgetSnapshot = (householdId: string) => cache.invalidate(householdId);
