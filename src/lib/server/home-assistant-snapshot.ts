import 'server-only';

import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '@/lib/server/firebase-admin';
import { HomeAssistantError, fetchHomeAssistantSnapshot, type HomeAssistantSnapshot } from '@/lib/server/home-assistant';
import { readConfig, readCredentials } from '@/lib/server/home-assistant-store';
import { SnapshotCache } from '@/lib/automation/snapshot-cache';
import { evaluateAlerts, type AlertNotice } from '@/lib/automation/alerts';
import { isQuietAt, readQuietHours } from '@/lib/devices/quiet-hours';
import { safeTimeZone } from '@functions/shared/calendar';
import { notificationAudience } from '@functions/shared/notification-audience';

// AU-10: every read of Home Assistant states goes through this cache, so polling pages,
// the dashboard card and several tablets cost at most one request per household every
// 15 s on a server instance. A fresh read also runs the sensor alerts (AU-16, AU-17):
// there is no background job that can reach Home Assistant, so alerts are checked
// whenever someone's screen asks for states (the wall tablet's dashboard does, all day).

const cache = new SnapshotCache<HomeAssistantSnapshot>();

export type HouseholdSnapshot = HomeAssistantSnapshot & { fetchedAt: number };

const NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALREADY_EXISTS = 6;

/** Writes each notice once (deterministic id; an existing one is left alone). Quiet hours mute all but urgent ones. */
export const writeAlertNotices = async (householdId: string, notices: AlertNotice[], quiet: boolean, now: Date) => {
  const notifications = adminDb.collection('households').doc(householdId).collection('notifications');
  let created = 0;
  for (const notice of notices) {
    try {
      await notifications.doc(notice.id).create({
        householdId,
        category: notice.category,
        title: notice.title,
        message: notice.message,
        createdAt: Timestamp.fromDate(now),
        expiresAt: Timestamp.fromMillis(now.getTime() + NOTIFICATION_TTL_MS),
        deepLink: notice.deepLink,
        sourceType: notice.sourceType,
        sourceId: notice.sourceId,
        audience: notificationAudience({}),
        readBy: {},
        dismissedBy: {},
        ...(quiet && !notice.urgent ? { silent: true } : {}),
      });
      created += 1;
    } catch (error) {
      if ((error as { code?: unknown })?.code !== ALREADY_EXISTS) throw error;
    }
  }
  return created;
};

/** Runs the household's alerts over fresh states. Never throws: a failed write must not fail a read. */
export const runAlerts = async (householdId: string, snapshot: HomeAssistantSnapshot, now = new Date()) => {
  try {
    const [household, config] = await Promise.all([adminDb.collection('households').doc(householdId).get(), readConfig(householdId)]);
    if (!household.exists || household.get('deletingAt')) return 0;
    const timeZone = safeTimeZone(household.get('timeZone'));
    const notices = evaluateAlerts({ entities: snapshot.entities, rules: config.alerts, timeZone, now });
    if (!notices.length) return 0;
    return await writeAlertNotices(householdId, notices, isQuietAt(readQuietHours(household.get('quietHours')), timeZone, now), now);
  } catch (error) {
    console.error('Home Assistant alerts failed', error instanceof Error ? error.message : String(error));
    return 0;
  }
};

/** The household's states, from the cache when fresh enough; throws HomeAssistantError when not connected. */
export const householdSnapshot = async (householdId: string): Promise<HouseholdSnapshot> => {
  const credentials = await readCredentials(householdId);
  if (!credentials) throw new HomeAssistantError('Home Assistant is not connected yet.');
  const result = await cache.get(householdId, credentials.version, () => fetchHomeAssistantSnapshot(credentials.url, credentials.token));
  if (result.fresh) await runAlerts(householdId, result.value);
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
