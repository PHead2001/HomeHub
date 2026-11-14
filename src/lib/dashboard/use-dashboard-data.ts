'use client';

/**
 * Live dashboard data. Subscribes (read-only) to the household collections the
 * member is allowed to view and turns them into exact facts with the pure
 * functions in `facts.ts` (via `assembleDashboardFacts`). Sections the member cannot
 * view are never queried and are left out.
 *
 * - Context and day are separate (HP-4). The store belongs to household + member +
 *   view permissions; a change there starts from nothing (GOAL-lastgood). The
 *   household's day (`useHouseholdToday`, D-6) is not part of it: at household
 *   midnight only the day-scoped queries (today's chores, today's completions, the
 *   home-health log window) subscribe again, and their old values stay until the
 *   new snapshots answer, so nothing blanks.
 * - Every listener is resilient (HP-5, `resilient-listener.ts`): an error retries with
 *   backoff and on `online` / visible, and `retry()` retries now.
 * - Each section is loading | ready | stale | unauthorized | failed (GOAL-states,
 *   `dashboard-store.ts`). Failed and unauthorized sections are listed in
 *   `facts.unavailable`; stale ones keep their last data.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDashboardScope } from './dashboard-scope';
import { householdDayStart, householdDayZone, useHouseholdToday } from '@/lib/household-day';
import { deduplicateNotifications, parseNotificationDoc } from '@/lib/notifications';
import { NOTIFICATION_WINDOW_DAYS } from './notification-display';
import { notificationWindowQuery, viewableNotificationCategories } from '@/app/notifications/notification-query';
import { SECTION_LIMITS, type DashboardFacts, type RawDoc } from './facts';
import { assembleDashboardFacts, feedingFailureKey, HEALTH_FAILURE, LEADERBOARD_FAILURE, STREAKS_FAILURE, type DashboardRaw } from './assemble';
import { leaderboardEnabledFrom } from './streaks';
import { deviceStorage, readHouseOutline, readHouseSnapshot, writeHouseSnapshot, type HouseOutlineRoom } from './house-snapshot';
import type { ChoreFacts } from './facts';
import { HEALTH_RULES } from '../maintenance/health';
import { addDays } from '../../../functions/src/shared/calendar';
import { resilientListener, type ResilientHandle } from './resilient-listener';
import {
  applyAnswer,
  applyError,
  createListenerSet,
  emptyStore,
  forgetListeners,
  sectionStates,
  unavailableGroups,
  withFeedingHints,
  type DashboardStore,
  type ListenerSpec,
  type SectionState,
} from './dashboard-store';

/** Lowest Timestamp, so the Timestamp-shape query matches every Timestamp date. */
const MIN_TIMESTAMP = Timestamp.fromMillis(-62135596800000);
/** Feedings read per pet and shape: enough for any daily target. */
const RECENT_FEEDINGS = 12;

const docs = (snapshot: QuerySnapshot<DocumentData>): RawDoc[] => snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

/**
 * The current time, refreshed every `intervalMs` so "today" and "fed 2h ago" stay true,
 * and re-read at once when the page becomes visible again or is restored (wake from
 * sleep, HP-17d) and whenever `resync` changes (the household day rolled over).
 */
export function useNow(intervalMs = 60_000, resync?: string): Date {
  const [state, setState] = useState(() => ({ resync, now: new Date() }));
  // Adjusting state during render: a new day re-reads the clock in the same render pass.
  if (state.resync !== resync) setState({ resync, now: new Date() });
  useEffect(() => {
    const tick = () => setState((previous) => ({ resync: previous.resync, now: new Date() }));
    const id = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', tick);
    };
  }, [intervalMs]);
  return state.now;
}

const subscribeOnline = (listener: () => void) => {
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
};

/** True while the browser reports no network. */
function useOffline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => !navigator.onLine, () => false);
}

type Access = { chores: boolean; shopping: boolean; maintenance: boolean; pets: boolean; notifications: boolean };

/**
 * Every top-level listener, its failure group and whether its query depends on the day.
 * Nested listeners (each list's items, each pet's feedings) are started by their parent.
 */
const PLAN = [
  { id: 'chores.rooms', group: 'chores', access: 'chores', scope: 'context' },
  { id: 'chores.templates', group: 'chores', access: 'chores', scope: 'context' },
  { id: 'chores.open', group: 'chores', access: 'chores', scope: 'context' },
  { id: 'chores.today', group: 'chores', access: 'chores', scope: 'day' },
  { id: 'chores.doneServer', group: 'chores', access: 'chores', scope: 'day' },
  { id: 'chores.doneLegacy', group: 'chores', access: 'chores', scope: 'day' },
  { id: 'streaks.completed', group: STREAKS_FAILURE, access: 'chores', scope: 'context' },
  { id: 'streaks.members', group: STREAKS_FAILURE, access: 'chores', scope: 'context' },
  { id: 'leaderboard', group: LEADERBOARD_FAILURE, access: 'chores', scope: 'context' },
  { id: 'shopping.lists', group: 'shopping', access: 'shopping', scope: 'context' },
  { id: 'pantry', group: 'pantry', access: 'shopping', scope: 'context' },
  { id: 'maintenance.assets', group: 'maintenance', access: 'maintenance', scope: 'context' },
  { id: 'maintenance.vehicles', group: 'maintenance', access: 'maintenance', scope: 'context' },
  { id: 'health.logs', group: HEALTH_FAILURE, access: 'maintenance', scope: 'day' },
  { id: 'pets', group: 'pets', access: 'pets', scope: 'context' },
  // Day-scoped: the 7-day query window moves forward each household day.
  { id: 'notifications', group: 'notifications', access: 'notifications', scope: 'day' },
] as const satisfies ReadonlyArray<{ id: string; group: string; access: keyof Access; scope: 'context' | 'day' }>;

type PlanId = (typeof PLAN)[number]['id'];

const plannedFor = (access: Access) => PLAN.filter((entry) => access[entry.access]);

export type DashboardData = {
  /** The dashboard's facts: lists hold short previews (`PREVIEW_LIMITS`). */
  facts: DashboardFacts;
  /**
   * Only with `{ sections: true }`: the same facts with no caps (`SECTION_LIMITS`), for full
   * section views (a wall tablet's Chores, Maintenance, Calendar). Null otherwise.
   */
  sectionFacts: DashboardFacts | null;
  /** True until every permitted, readable section has delivered its first snapshot. */
  loading: boolean;
  /** Failure keys of failed or unauthorized groups (sections, and `feed:<petId>`); sections also appear in `facts.unavailable`. */
  failed: Set<string>;
  /** loading | ready | stale | unauthorized | failed per group (sections, `streaks`, `health`, `feed:<petId>` …). */
  sections: Record<string, SectionState>;
  /** Retries every listener with a pending retry now (the "Retry" buttons). */
  retry: () => void;
  now: Date;
  /** The household's day key (D-6). */
  today: string;
  /** The zone `today` is computed in. */
  timeZone: string;
  /** Household + member + permissions; components keyed by it reset on a context change. */
  context: string;
  /**
   * HP-7b: while the chores are loading with no snapshot for today, the room layout of an
   * earlier day's snapshot (ids and names only), so the house keeps its shape. Null otherwise.
   */
  houseOutline: HouseOutlineRoom[] | null;
};

export function useDashboardData(enabled = true, options: { sections?: boolean } = {}): DashboardData {
  const wantSections = Boolean(options.sections);
  // A person by default; a registered wall tablet provides its own scope (dashboard-scope.tsx).
  const scope = useDashboardScope();
  const { permissions } = scope;
  const zone = householdDayZone(scope.timeZone);
  const householdId = enabled ? scope.householdId : null;
  const uid = scope.uid;
  const email = scope.email;
  const today = useHouseholdToday(zone);
  const now = useNow(60_000, today);
  const offline = useOffline();
  const [store, setStore] = useState<DashboardStore>(() => emptyStore(''));

  const canChores = Boolean(permissions['chores.view']);
  const canShopping = Boolean(permissions['shopping.view']);
  const canMaintenance = Boolean(permissions['maintenance.view']);
  const canPets = Boolean(permissions['pets.view']);
  const canNotifications = Boolean(permissions['notifications.view']);
  const canAutomation = Boolean(permissions['automation.view']);

  // The context: what the data was loaded for. Today is deliberately not part of it.
  const context = [householdId, uid, email, canChores, canShopping, canMaintenance, canPets, canNotifications, canAutomation].join('|');
  const access: Access = useMemo(() => ({
    chores: canChores, shopping: canShopping, maintenance: canMaintenance, pets: canPets, notifications: canNotifications && Boolean(uid),
  }), [canChores, canShopping, canMaintenance, canPets, canNotifications, uid]);

  // The bell's category check (module view permissions).
  const canView = useCallback((permission: string) => ({
    'chores.view': canChores, 'shopping.view': canShopping, 'maintenance.view': canMaintenance,
    'pets.view': canPets, 'automation.view': canAutomation,
  } as Record<string, boolean>)[permission] === true, [canChores, canShopping, canMaintenance, canPets, canAutomation]);

  const running = useRef<{ context: string; set: ReturnType<typeof createListenerSet>; handles: Set<ResilientHandle> } | null>(null);

  // One listener set per context; a context change stops everything and the store starts empty.
  useEffect(() => {
    if (!householdId) return;
    const entry = { context, set: createListenerSet(), handles: new Set<ResilientHandle>() };
    running.current = entry;
    return () => {
      entry.set.stopAll();
      entry.handles.forEach((handle) => handle.stop());
      entry.handles.clear();
      if (running.current === entry) running.current = null;
    };
  }, [context, householdId]);

  // Sync the listeners: context-scoped specs keep running; day-scoped specs restart when the day changes.
  useEffect(() => {
    const entry = running.current;
    if (!householdId || !entry || entry.context !== context) return;
    const { handles } = entry;
    const base = (...path: string[]) => collection(db, 'households', householdId, ...path);

    const watch = <T,>(
      id: string,
      group: string,
      subscribe: (next: (value: T) => void, error: (error: unknown) => void) => () => void,
      fromCache: (value: T) => boolean,
      apply: (value: T, raw: DashboardRaw) => DashboardRaw,
      after?: (value: T) => void,
    ) => {
      const handle = resilientListener<T>(subscribe, {
        next: (value) => {
          setStore((state) => applyAnswer(state, context, id, group, (raw) => apply(value, raw), { fromCache: fromCache(value), at: Date.now() }));
          after?.(value);
        },
        status: (status) => {
          if (status.kind !== 'live') setStore((state) => applyError(state, context, id, group, status.kind));
        },
        // Only a server answer resets the backoff and the permission-denied count.
        confirmed: (value) => !fromCache(value),
      });
      handles.add(handle);
      return () => {
        handle.stop();
        handles.delete(handle);
      };
    };
    const watchQuery = (
      id: string,
      group: string,
      q: Query<DocumentData>,
      apply: (snapshot: QuerySnapshot<DocumentData>, raw: DashboardRaw) => DashboardRaw,
      after?: (snapshot: QuerySnapshot<DocumentData>) => void,
    ) => watch<QuerySnapshot<DocumentData>>(
      id,
      group,
      // Metadata changes too, so a snapshot that turns from cached to live (or back) is seen.
      (next, error) => onSnapshot(q, { includeMetadataChanges: true }, next, error),
      (snapshot) => snapshot.metadata.fromCache,
      apply,
      after,
    );

    const dayStart = householdDayStart(zone, today);
    const dayStartIso = dayStart.toISOString();

    const starters: Record<PlanId, () => () => void> = {
      'chores.rooms': () => watchQuery('chores.rooms', 'chores', query(base('rooms')), (s, r) => ({ ...r, rooms: docs(s) })),
      // Templates tell which series repeat, so missed instances fold as on the Chores page.
      'chores.templates': () => watchQuery('chores.templates', 'chores', query(base('chore-templates')), (s, r) => ({ ...r, templates: docs(s) })),
      'chores.open': () => watchQuery('chores.open', 'chores', query(base('chores'), where('isCompleted', '==', false)), (s, r) => ({ ...r, openChores: docs(s) })),
      'chores.today': () => watchQuery('chores.today', 'chores', query(base('chores'), where('originalDueDate', '==', today)), (s, r) => ({ ...r, todayChores: docs(s) })),
      // Today's completions, by the same pair of timestamps as `completionInstant`: the
      // server stamp (authoritative, a Timestamp) and the legacy client string, both from
      // the household's midnight. Single-field range queries (automatic indexes); a
      // document missing one field is found by the other query.
      'chores.doneServer': () => watchQuery('chores.doneServer', 'chores', query(base('chores'), where('completedAtServer', '>=', Timestamp.fromDate(dayStart))), (s, r) => ({ ...r, doneTodayServer: docs(s) })),
      'chores.doneLegacy': () => watchQuery('chores.doneLegacy', 'chores', query(base('chores'), where('completedAt', '>=', dayStartIso)), (s, r) => ({ ...r, doneToday: docs(s) })),
      // Streaks (H22/H06): every retained completion and the approved members, as the Chores page reads them.
      'streaks.completed': () => watchQuery('streaks.completed', STREAKS_FAILURE, query(base('chores'), where('isCompleted', '==', true)), (s, r) => ({ ...r, completedChores: docs(s) })),
      'streaks.members': () => watchQuery('streaks.members', STREAKS_FAILURE, query(base('members')), (s, r) => ({ ...r, members: docs(s) })),
      // The Chores "Show leaderboard" setting gates the comparative streaks tile.
      leaderboard: () => watch<DocumentSnapshot<DocumentData>>(
        'leaderboard',
        LEADERBOARD_FAILURE,
        (next, error) => onSnapshot(doc(db, 'households', householdId, 'chore-settings', 'preferences'), { includeMetadataChanges: true }, next, error),
        (snapshot) => snapshot.metadata.fromCache,
        (snapshot, r) => ({ ...r, leaderboard: leaderboardEnabledFrom(snapshot.exists() ? snapshot.data() : undefined) ? 'on' : 'off' }),
      ),
      'shopping.lists': () => {
        const items = new Map<string, () => void>();
        const itemId = (listId: string) => `shopping.items:${listId}`;
        const stopLists = watchQuery('shopping.lists', 'shopping', query(base('shopping-lists')), (s, r) => {
          const lists = docs(s);
          // Keep only answered lists' items; a new list has no entry until its listener answers.
          return { ...r, lists, items: Object.fromEntries(lists.flatMap((list) => (r.items?.[list.id] ? [[list.id, r.items[list.id]]] : []))) };
        }, (s) => {
          const ids = new Set(s.docs.map((d) => d.id));
          const removed: string[] = [];
          for (const [id, stop] of items) {
            if (ids.has(id)) continue;
            stop();
            items.delete(id);
            removed.push(itemId(id));
          }
          if (removed.length > 0) setStore((state) => forgetListeners(state, context, removed));
          for (const id of ids) {
            if (items.has(id)) continue;
            items.set(id, watchQuery(itemId(id), 'shopping', query(base('shopping-lists', id, 'items')), (snapshot, r) => ({ ...r, items: { ...(r.items ?? {}), [id]: docs(snapshot) } })));
          }
        });
        return () => {
          stopLists();
          items.forEach((stop) => stop());
        };
      },
      pantry: () => watchQuery('pantry', 'pantry', query(base('pantry-inventory')), (s, r) => ({ ...r, pantry: docs(s) })),
      'maintenance.assets': () => watchQuery('maintenance.assets', 'maintenance', query(base('home-assets')), (s, r) => ({ ...r, assets: docs(s) })),
      'maintenance.vehicles': () => watchQuery('maintenance.vehicles', 'maintenance', query(base('vehicles')), (s, r) => ({ ...r, vehicles: docs(s) })),
      // Home health (H10 in the house): only logs recent enough to count toward the bonus (two
      // days of margin for time zones); `computeHomeHealth` applies the exact window. The
      // window moves with the household day, so this is a day-scoped query.
      'health.logs': () => watchQuery('health.logs', HEALTH_FAILURE, query(base('maintenance'), where('date', '>=', addDays(today, -(HEALTH_RULES.recentDays + 2)))), (s, r) => ({ ...r, logs: docs(s) })),
      pets: () => {
        // Feeding dates come in two shapes (Timestamps, and ISO strings on older entries).
        // Firestore orders types separately, so each shape is read on its own and merged
        // chronologically, as the Pets module does (`newestFirst`).
        const feeds = new Map<string, Array<() => void>>();
        const shapes = ['timestamp', 'string'] as const;
        const feedId = (petId: string, shape: string) => `feed:${petId}:${shape}`;
        const recent = (shape: 'timestamp' | 'string', petId: string) => query(
          base('pets', petId, 'feeding-logs'),
          where('date', '>=', shape === 'timestamp' ? MIN_TIMESTAMP : ''),
          orderBy('date', 'desc'),
          limit(RECENT_FEEDINGS),
        );
        const stopPets = watchQuery('pets', 'pets', query(base('pets')), (s, r) => {
          const pets = docs(s);
          const ids = new Set(pets.map((pet) => pet.id));
          return { ...r, pets, feedings: Object.fromEntries(Object.entries(r.feedings ?? {}).filter(([id]) => ids.has(id))) };
        }, (s) => {
          const ids = new Set(s.docs.map((d) => d.id));
          const removed: string[] = [];
          for (const [id, stops] of feeds) {
            if (ids.has(id)) continue;
            stops.forEach((stop) => stop());
            feeds.delete(id);
            removed.push(...shapes.map((shape) => feedId(id, shape)));
          }
          if (removed.length > 0) setStore((state) => forgetListeners(state, context, removed));
          for (const petId of ids) {
            if (feeds.has(petId)) continue;
            feeds.set(petId, shapes.map((shape) => watchQuery(feedId(petId, shape), feedingFailureKey(petId), recent(shape, petId), (logs, r) => {
              const previous = r.feedings?.[petId] ?? {};
              return { ...r, feedings: { ...(r.feedings ?? {}), [petId]: { ...previous, [shape]: docs(logs) } } };
            })));
          }
        });
        return () => {
          stopPets();
          feeds.forEach((stops) => stops.forEach((stop) => stop()));
        };
      },
      notifications: () => {
        // From the household's midnight 7 days back: until the next day's resubscribe the
        // window always covers the last 7 days; the count applies the exact window at `now`.
        const since = new Date(dayStart.getTime() - NOTIFICATION_WINDOW_DAYS * 86_400_000);
        // Same category filter as the bell (module view permissions; all in the context),
        // applied in the query so the 30-item cap counts only visible notifications.
        const views: Record<string, boolean> = {
          'chores.view': canChores, 'shopping.view': canShopping, 'maintenance.view': canMaintenance,
          'pets.view': canPets, 'automation.view': canAutomation,
        };
        const categories = viewableNotificationCategories((permission) => Boolean(views[permission]));
        // The documents are kept (deduplicated as the bell does); the unread count is
        // computed from them at `now` in assembleDashboardFacts, so expiry is applied live.
        return watchQuery('notifications', 'notifications', notificationWindowQuery(base('notifications'), uid, since, categories, 30), (s, r) => ({
          ...r, notifications: deduplicateNotifications(s.docs.map(parseNotificationDoc)),
        }));
      },
    };

    const specs: ListenerSpec[] = plannedFor(access).map((planned) => ({
      id: planned.id,
      key: planned.scope === 'day' ? `${planned.id}|${zone}|${today}` : planned.id,
      start: starters[planned.id],
    }));
    entry.set.sync(specs);
    // `context` covers householdId, uid, email and every permission read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, today, zone]);

  const retry = useCallback(() => {
    running.current?.handles.forEach((handle) => handle.retryNow());
  }, []);

  // Last-good data only within this context: another context's store is never shown.
  const current = useMemo(() => (store.context === context ? store : emptyStore(context)), [store, context]);
  const expected = useMemo(() => {
    const groups: Record<string, string[]> = {};
    plannedFor(access).forEach((planned) => {
      (groups[planned.group] ??= []).push(planned.id);
    });
    return groups;
  }, [access]);
  const sections = useMemo(() => sectionStates(current, expected, offline), [current, expected, offline]);
  const failed = useMemo(() => unavailableGroups(sections), [sections]);

  const { facts: assembled, loading } = useMemo(() => assembleDashboardFacts(
    current.raw,
    failed,
    { chores: canChores, shopping: canShopping, pantry: canShopping, maintenance: canMaintenance, pets: canPets, notifications: canNotifications && Boolean(uid) },
    { viewer: { uid, email }, now, timeZone: zone, recentFeedings: RECENT_FEEDINGS, canView },
  ), [current.raw, failed, now, uid, email, zone, canChores, canShopping, canMaintenance, canPets, canNotifications, canView]);

  // A pet whose feeding history is stale says so wherever its count or fed state shows.
  const facts = useMemo(() => withFeedingHints(assembled, sections, zone), [assembled, sections, zone]);

  // Full section views read the same documents with no preview caps (never a preview fact).
  const sectionFacts = useMemo(() => (wantSections ? withFeedingHints(assembleDashboardFacts(
    current.raw,
    failed,
    { chores: canChores, shopping: canShopping, pantry: canShopping, maintenance: canMaintenance, pets: canPets, notifications: false },
    { viewer: { uid, email }, now, timeZone: zone, recentFeedings: RECENT_FEEDINGS, canView, limits: SECTION_LIMITS },
  ).facts, sections, zone) : null), [wantSections, current.raw, failed, now, uid, email, zone, canChores, canShopping, canMaintenance, canPets, canView, sections]);
  const { facts: shown, outline } = useHouseSnapshot(facts, canChores ? householdId : null, uid, today);

  return { facts: shown, sectionFacts, loading, failed, sections, retry, now, today, timeZone: zone, context, houseOutline: outline };
}

/**
 * H01: until the live chores listeners deliver, the house draws its rooms from the last
 * snapshot saved on this device for exactly this user, household and household day (see
 * house-snapshot.ts). Live data always replaces it, a failed chores section never falls back
 * to it, and every change to the live rooms is saved for the next visit.
 */
function useHouseSnapshot(facts: DashboardFacts, householdId: string | null, uid: string, today: string): { facts: DashboardFacts; outline: HouseOutlineRoom[] | null } {
  const live: ChoreFacts | undefined = facts.chores;
  const choresFailed = Boolean(facts.unavailable?.includes('chores'));
  // Read only while the live chores are missing (the first moments of a visit).
  const waiting = !live && Boolean(householdId) && !choresFailed;
  const snapshot = waiting ? readHouseSnapshot(deviceStorage(), uid, householdId!, today) : null;
  // HP-7b: no snapshot for today: an earlier day's room layout, without its counts.
  const outline = waiting && !snapshot ? readHouseOutline(deviceStorage(), uid, householdId!) : null;
  const liveRooms = live ? JSON.stringify(live) : null;
  useEffect(() => {
    if (liveRooms && householdId && uid) writeHouseSnapshot(deviceStorage(), uid, householdId, today, liveRooms);
  }, [liveRooms, householdId, uid, today]);
  return { facts: snapshot ? { ...facts, chores: snapshot } : facts, outline };
}
