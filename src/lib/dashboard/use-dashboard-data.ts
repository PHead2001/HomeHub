'use client';

/**
 * Live dashboard data. Subscribes (read-only) to the household collections the
 * member is allowed to view and turns them into exact facts with the pure
 * functions in `facts.ts` (via `assembleDashboardFacts`). Sections the member cannot
 * view are never queried and are left out; sections whose read failed are listed
 * in `facts.unavailable` and shown as unavailable, never as empty.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
  type Query,
  type QuerySnapshot,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/use-auth';
import { deduplicateNotifications, isNotificationReadBy, parseNotificationDoc } from '@/lib/notifications';
import { activeBellNotifications } from './notification-display';
import { notificationWindowQuery, viewableNotificationCategories } from '@/app/notifications/notification-query';
import { dayKey, startOfLocalDay } from './dates';
import type { DashboardFacts, RawDoc } from './facts';
import { assembleDashboardFacts, feedingFailureKey, HEALTH_FAILURE, STREAKS_FAILURE, type DashboardRaw } from './assemble';
import { HEALTH_RULES } from '../maintenance/health';

/** Lowest Timestamp, so the Timestamp-shape query matches every Timestamp date. */
const MIN_TIMESTAMP = Timestamp.fromMillis(-62135596800000);
/** Feedings read per pet and shape: enough for any daily target. */
const RECENT_FEEDINGS = 12;

const docs = (snapshot: QuerySnapshot<DocumentData>): RawDoc[] => snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

/** The current time, refreshed every `intervalMs` so "today" and "fed 2h ago" stay true. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

type Raw = DashboardRaw;

type Store = { key: string; raw: Raw; failed: Set<string> };
const EMPTY_STORE: Store = { key: '', raw: {}, failed: new Set() };

export type DashboardData = {
  facts: DashboardFacts;
  /** True until every permitted, readable section has delivered its first snapshot. */
  loading: boolean;
  /** Failure keys (sections, and `feed:<petId>`); failed sections also appear in `facts.unavailable`. */
  failed: Set<string>;
  now: Date;
};

export function useDashboardData(enabled = true): DashboardData {
  const { currentUser, household, permissions } = useAuth();
  const timeZone = household?.timeZone ?? null;
  const householdId = enabled ? currentUser?.householdId ?? null : null;
  const uid = currentUser?.uid ?? '';
  const email = currentUser?.email ?? '';
  const now = useNow();
  const today = dayKey(now);
  const [store, setStore] = useState<Store>(EMPTY_STORE);

  const canChores = Boolean(permissions['chores.view']);
  const canShopping = Boolean(permissions['shopping.view']);
  const canMaintenance = Boolean(permissions['maintenance.view']);
  const canPets = Boolean(permissions['pets.view']);
  const canNotifications = Boolean(permissions['notifications.view']);
  const canAutomation = Boolean(permissions['automation.view']);

  // State is keyed by what it was loaded for, so a household, member, day or
  // permission change never shows the previous data while new snapshots arrive.
  const key = [householdId, uid, today, canChores, canShopping, canMaintenance, canPets, canNotifications, canAutomation].join('|');

  useEffect(() => {
    if (!householdId) return;
    const current = (state: Store): Store => (state.key === key ? state : { key, raw: {}, failed: new Set() });
    const setRaw = (update: (raw: Raw) => Raw) => setStore((state) => {
      const base = current(state);
      return { ...base, raw: update(base.raw) };
    });
    const base = (...path: string[]) => collection(db, 'households', householdId, ...path);
    const unsubscribers: Array<() => void> = [];
    const fail = (section: string) => () => setStore((state) => {
      const next = current(state);
      return { ...next, failed: new Set(next.failed).add(section) };
    });
    const listen = (section: string, q: Query<DocumentData>, apply: (snapshot: QuerySnapshot<DocumentData>) => void) => {
      unsubscribers.push(onSnapshot(q, apply, fail(section)));
    };

    if (canChores) {
      const todayStartDate = startOfLocalDay(new Date());
      const todayStart = todayStartDate.toISOString();
      listen('chores', query(base('rooms')), (s) => setRaw((r) => ({ ...r, rooms: docs(s) })));
      // Templates tell which series repeat, so missed instances fold as on the Chores page.
      listen('chores', query(base('chore-templates')), (s) => setRaw((r) => ({ ...r, templates: docs(s) })));
      listen('chores', query(base('chores'), where('isCompleted', '==', false)), (s) => setRaw((r) => ({ ...r, openChores: docs(s) })));
      listen('chores', query(base('chores'), where('originalDueDate', '==', today)), (s) => setRaw((r) => ({ ...r, todayChores: docs(s) })));
      // Today's completions, by the same pair of timestamps as `completionInstant`:
      // the server stamp (authoritative, a Timestamp) and the legacy client string.
      // Both are single-field range queries (automatic indexes); documents missing
      // the field are simply not returned by that query, and the other one covers them.
      listen('chores', query(base('chores'), where('completedAtServer', '>=', Timestamp.fromDate(todayStartDate))), (s) => setRaw((r) => ({ ...r, doneTodayServer: docs(s) })));
      listen('chores', query(base('chores'), where('completedAt', '>=', todayStart)), (s) => setRaw((r) => ({ ...r, doneToday: docs(s) })));
      // Streaks (H22/H06): every retained completion and the approved members, as the Chores page reads them.
      listen(STREAKS_FAILURE, query(base('chores'), where('isCompleted', '==', true)), (s) => setRaw((r) => ({ ...r, completedChores: docs(s) })));
      listen(STREAKS_FAILURE, query(collection(db, 'households', householdId, 'members')), (s) => setRaw((r) => ({ ...r, members: docs(s) })));
    }

    if (canShopping) {
      const itemListeners = new Map<string, () => void>();
      listen('shopping', query(base('shopping-lists')), (s) => {
        const lists = docs(s);
        // Keep only answered lists' items; a new list has no entry until its listener answers.
        setRaw((r) => ({ ...r, lists, items: Object.fromEntries(lists.flatMap((list) => (r.items?.[list.id] ? [[list.id, r.items[list.id]]] : []))) }));
        const ids = new Set(lists.map((list) => list.id));
        for (const [id, stop] of itemListeners) {
          if (!ids.has(id)) {
            stop();
            itemListeners.delete(id);
          }
        }
        for (const list of lists) {
          if (itemListeners.has(list.id)) continue;
          itemListeners.set(list.id, onSnapshot(
            query(base('shopping-lists', list.id, 'items')),
            (items) => setRaw((r) => ({ ...r, items: { ...(r.items ?? {}), [list.id]: docs(items) } })),
            fail('shopping'),
          ));
        }
      });
      unsubscribers.push(() => itemListeners.forEach((stop) => stop()));
      listen('pantry', query(base('pantry-inventory')), (s) => setRaw((r) => ({ ...r, pantry: docs(s) })));
    }

    if (canMaintenance) {
      listen('maintenance', query(base('home-assets')), (s) => setRaw((r) => ({ ...r, assets: docs(s) })));
      listen('maintenance', query(base('vehicles')), (s) => setRaw((r) => ({ ...r, vehicles: docs(s) })));
      // Home health (H10 in the house): only logs recent enough to count toward the bonus
      // (with two days of margin for time zones); `computeHomeHealth` applies the exact window.
      const since = new Date(Date.now() - (HEALTH_RULES.recentDays + 2) * 86_400_000).toISOString().slice(0, 10);
      listen(HEALTH_FAILURE, query(base('maintenance'), where('date', '>=', since)), (s) => setRaw((r) => ({ ...r, logs: docs(s) })));
    }

    if (canPets) {
      // Feeding dates come in two shapes (Timestamps, and ISO strings on older
      // entries). Firestore orders types separately, so each shape is read on its
      // own and merged chronologically, as the Pets module does (`newestFirst`).
      const feedListeners = new Map<string, Array<() => void>>();
      const recent = (shape: 'timestamp' | 'string', petId: string) => query(
        base('pets', petId, 'feeding-logs'),
        where('date', '>=', shape === 'timestamp' ? MIN_TIMESTAMP : ''),
        orderBy('date', 'desc'),
        limit(RECENT_FEEDINGS),
      );
      listen('pets', query(base('pets')), (s) => {
        const pets = docs(s);
        setRaw((r) => ({ ...r, pets, feedings: r.feedings ?? {} }));
        const ids = new Set(pets.map((pet) => pet.id));
        for (const [id, stops] of feedListeners) {
          if (!ids.has(id)) {
            stops.forEach((stop) => stop());
            feedListeners.delete(id);
          }
        }
        for (const pet of pets) {
          if (feedListeners.has(pet.id)) continue;
          feedListeners.set(pet.id, (['timestamp', 'string'] as const).map((shape) => onSnapshot(
            recent(shape, pet.id),
            (logs) => setRaw((r) => {
              const previous = r.feedings?.[pet.id] ?? {};
              return { ...r, feedings: { ...(r.feedings ?? {}), [pet.id]: { ...previous, [shape]: docs(logs) } } };
            }),
            fail(feedingFailureKey(pet.id)),
          )));
        }
      });
      unsubscribers.push(() => feedListeners.forEach((stops) => stops.forEach((stop) => stop())));
    }

    if (canNotifications && uid) {
      const since = new Date(Date.now() - 7 * 86_400_000);
      // Same category filter as the bell (module view permissions; all in `key`),
      // applied in the query so the 30-item cap counts only visible notifications.
      const views: Record<string, boolean> = {
        'chores.view': canChores, 'shopping.view': canShopping, 'maintenance.view': canMaintenance,
        'pets.view': canPets, 'automation.view': canAutomation,
      };
      const categories = viewableNotificationCategories((permission) => Boolean(views[permission]));
      listen('notifications', notificationWindowQuery(base('notifications'), since, categories, 30), (s) => {
        // The bell's own pipeline: deduplicate, then the same filters and cap.
        const active = activeBellNotifications(deduplicateNotifications(s.docs.map(parseNotificationDoc)), {
          uid, email, canView: (permission) => Boolean(views[permission]),
        });
        setRaw((r) => ({ ...r, unread: active.filter((n) => !isNotificationReadBy(n, uid)).length }));
      });
    }

    return () => unsubscribers.forEach((stop) => stop());
    // `key` covers every input below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, email]);

  const raw = store.key === key ? store.raw : EMPTY_STORE.raw;
  const failed = store.key === key ? store.failed : EMPTY_STORE.failed;

  const { facts, loading } = useMemo(() => assembleDashboardFacts(
    raw,
    failed,
    { chores: canChores, shopping: canShopping, pantry: canShopping, maintenance: canMaintenance, pets: canPets, notifications: canNotifications && Boolean(uid) },
    { viewer: { uid, email }, now, timeZone, recentFeedings: RECENT_FEEDINGS },
  ), [raw, failed, now, uid, email, timeZone, canChores, canShopping, canMaintenance, canPets, canNotifications]);

  return { facts, loading, failed, now };
}
