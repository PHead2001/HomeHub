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

/** After a new token or a disconnect: the next read asks Home Assistant again. */
export const forgetSnapshot = (householdId: string) => cache.invalidate(householdId);
