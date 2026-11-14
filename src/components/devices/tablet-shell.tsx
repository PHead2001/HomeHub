'use client';

// The registered wall tablet's shell (docs/modules/devices/README.md, "Tablet shell";
// design 13, 14; WT-14, WT-16, WT-19, D-T1-D-T18). Rendered by AuthProvider instead of
// the app for a device principal only (never by viewport size, WT-12b), so the personal
// header, account menu, Profile, push manager and command palette never mount on a
// tablet (WT-10, WT-14k). The service worker is registered (offline and new-build
// detection, `TabletUpdateWatcher`); no push subscription or token is ever requested.
//
// TabletShell → TabletRuntime (the tablet's own record, its household, the roster and the
// household-wide notices from the server; heartbeat; push clearing; revocation observed
// and cleared) → TabletFrame (the state machine, timers, rail, top bar, views, "Who's
// here?", PIN pad, ambient, night dimming, keep-awake, idle reload). Every write on a
// tablet is refused until the device actions exist (F4): the action pipeline and the
// offline queue are in place for them.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { MonitorSmartphone, WifiOff } from 'lucide-react';
import { auth } from '@/lib/firebase-app';
import type { Principal } from '@/lib/devices/principal';
import { deviceHeartbeatAction, endPinSessionAction } from '@/app/devices/actions';
import { browserPushClearDeps, clearPushState } from '@/lib/devices/push-clear';
import { readDeviceSettings } from '@/lib/devices/settings';
import { forgetHouseholdOnDevice } from '@/lib/auth/household-scope';
import {
  DEVICE_ENDED_KEY,
  DEVICE_NOTICES_LIMIT,
  EXIT_TIMEOUT_MS,
  clearTabletSession,
  decideSessionEnd,
  withTimeout,
  exitGateSettle,
  exitGateSignal,
  type ExitGate,
  destinationAfter,
  deviceNotificationCategories,
  parseDeviceNotice,
  type SessionEnd,
  type SessionSignal,
} from '@/lib/devices/device-session';
import { deleteDeviceDatabase } from '@/lib/devices/device-store';
import { tabletListener } from '@/lib/devices/tablet-listener';
import type { DocumentSnapshot, QuerySnapshot } from 'firebase/firestore';
import { forgetTabletMarker, markTabletBrowser } from '@/lib/devices/former-tablet';
import { readQuietHours, isQuietAt } from '@/lib/devices/quiet-hours';
import { readPointsPinPolicy, policyOf, requiredLevel, deviceRefusalResponse, type DeviceRefusal } from '@/lib/devices/action-policy';
import { rosterFrom, isOwnerOrAdmin, type RosterPerson } from '@/lib/devices/roster';
import {
  currentActor,
  initialShellState,
  nextShellDeadline,
  shellReducer,
  shellTimersFrom,
  type ShellEvent,
  type ShellState,
  type ShellTimers,
  initialNavigationState,
  navigationReducer,
  type NavigationEvent,
} from '@/lib/devices/shell-state';
import { activeFace } from '@/lib/devices/face-memory';
import { pathOfView, resolveTabletPath, sameView, startView, type KnownTargets } from '@/lib/devices/start-page';
import { watchKeepAwake, type WakeLockApi } from '@/lib/devices/wake-lock';
import { isShellBusy, subscribeShellBusy, whileBusy } from '@/lib/shell/busy';
import { useShellBusy } from '@/hooks/use-shell-busy';
import { DashboardScopeProvider, type DashboardScope } from '@/lib/dashboard/dashboard-scope';
import { useDashboardData } from '@/lib/dashboard/use-dashboard-data';
import { setDeviceWeather } from '@/lib/dashboard/use-weather';
import { AppearanceProvider, useAppearance } from '@/components/appearance-provider';
import { toast } from '@/hooks/use-toast';
import { appearanceFromRecord, devicePermissions, weatherFromRecord } from '@/lib/devices/tablet-settings-apply';
import type { DeviceSettings } from '@/lib/devices/types';
import {
  TabletContext,
  type DeviceNotice,
  type TabletActionAnswer,
  type TabletActionRequest,
  type TabletActor,
  type TabletContextValue,
  type TabletHousehold,
} from './tablet-context';
import { TabletRail } from './tablet-rail';
import { TabletTopBar } from './tablet-top-bar';
import { TabletView as TabletViewContent } from './tablet-views';
import { WhoIsHereDialog } from './who-is-here';
import { PinPadDialog } from './pin-pad';
import { AmbientScreen, NightDim } from './tablet-overlays';
import { TabletUpdateWatcher } from './tablet-update-watcher';

const TabletSettingsDialog = dynamic(() => import('./tablet-settings').then((mod) => mod.TabletSettingsDialog), { ssr: false });
const TabletQuickAdd = dynamic(() => import('./tablet-quick-add').then((mod) => mod.TabletQuickAdd), { ssr: false });
const Toaster = dynamic(() => import('@/components/ui/toaster').then((mod) => mod.Toaster), { ssr: false });

type TabletPrincipal = Exclude<Principal, { kind: 'personal' }>;

const HEARTBEAT_EVERY_MS = 5 * 60 * 1000;
const BUILD_ID = process.env.NEXT_PUBLIC_HOMEHUB_BUILD_ID || 'unknown';
/** Admin-PIN capabilities need a session at most 30 s old; the tablet re-asks a little earlier. */
const FRESH_PIN_MS = 25_000;

export default function TabletShell({ principal }: { principal: TabletPrincipal }) {
  if (principal.kind !== 'device') {
    // Unresolved claims (offline restore with an expired token): nothing is read or sent
    // until AuthProvider has them.
    return <TabletMessage title="HomeHub can't be reached right now" body="This screen tries again when the connection returns." offline />;
  }
  // Keyed by the session: another household, device record or generation starts from nothing.
  return <TabletRuntime key={`${principal.householdId}/${principal.deviceId}/${principal.generation}`} householdId={principal.householdId} deviceId={principal.deviceId} generation={principal.generation} />;
}

function TabletMessage({ title, body, offline }: { title: string; body: string; offline?: boolean }) {
  return (
    <main className="flex min-h-svh flex-1 items-center justify-center p-6" data-testid="tablet-message">
      <section className="max-w-md space-y-4 text-center" aria-live="polite">
        {offline ? <WifiOff aria-hidden className="mx-auto h-12 w-12 text-muted-foreground" /> : <MonitorSmartphone aria-hidden className="mx-auto h-12 w-12 text-primary" />}
        <h1 className="font-headline text-3xl">{title}</h1>
        <p className="text-lg text-muted-foreground">{body}</p>
      </section>
    </main>
  );
}

/** Where the tablet session is stopped from (listeners) and how it ended. */
let endingSession = false;

function TabletRuntime({ householdId, deviceId, generation }: { householdId: string; deviceId: string; generation: number }) {
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const [household, setHousehold] = useState<TabletHousehold | null>(null);
  const [roster, setRoster] = useState<RosterPerson[]>([]);
  const [noticesByCategory, setNoticesByCategory] = useState<Record<string, DeviceNotice[]>>({});
  // A source that returned its full window (the latest DEVICE_NOTICES_LIMIT) may have older notices.
  const [noticesWindowFull, setNoticesWindowFull] = useState<Record<string, boolean>>({});
  const [ending, setEnding] = useState(false);
  const stops = useRef<Array<() => void>>([]);
  const exitGate = useRef<ExitGate>({ inFlight: null, deferred: null });

  const stopListeners = useCallback(() => {
    stops.current.forEach((stop) => { try { stop(); } catch { /* already stopped */ } });
    stops.current = [];
  }, []);

  /** Section 13: clear everything this browser holds for the tablet, in order, then leave. */
  const clearAndLeave = useCallback((reason: SessionEnd) => {
    if (endingSession) return;
    endingSession = true;
    setEnding(true);
    void clearTabletSession({
      'stop-listeners': stopListeners,
      // The PIN secret and face memory live only in this page's memory: the hard navigation
      // below drops them; the server already refuses the old generation.
      'end-pin-and-face': () => undefined,
      'delete-device-database': () => deleteDeviceDatabase(),
      'forget-household': () => forgetHouseholdOnDevice(null),
      'clear-firestore': async () => {
        const { clearLocalFirestoreCache } = await import('@/lib/firebase');
        await clearLocalFirestoreCache();
      },
      'clear-push': () => clearPushState(browserPushClearDeps()),
      'forget-tablet-marker': () => forgetTabletMarker(),
      'sign-out': () => signOut(auth),
      'set-note': () => {
        try {
          if (reason !== 'personal-sign-in') window.sessionStorage.setItem(DEVICE_ENDED_KEY, reason);
        } catch {
          // Storage blocked: the setup screen shows without the note.
        }
      },
      // A full load: Firestore was terminated above and cannot be reused in this page.
      'navigate': () => window.location.replace(new URL(destinationAfter(reason), window.location.origin).href),
    });
  }, [stopListeners]);

  /** Any session end; while this tablet's own exit is in flight it waits for the exit's result. */
  const endSession = useCallback((end: SessionEnd) => {
    const { gate, endNow } = exitGateSignal(exitGate.current, end);
    exitGate.current = gate;
    if (endNow) clearAndLeave(endNow);
  }, [clearAndLeave]);

  /**
   * Runs one of this tablet's exits; the note and destination come from the exit, not the
   * race. The hold-back lasts at most EXIT_TIMEOUT_MS: a call that does not answer by then
   * counts as failed, and any session end that arrived meanwhile applies.
   */
  const runExit = useCallback(async <T extends { ok: boolean }>(end: SessionEnd, call: () => Promise<T>): Promise<T> => {
    exitGate.current = { inFlight: end, deferred: null };
    let ok = false;
    try {
      const result = await withTimeout(call(), EXIT_TIMEOUT_MS, 'tablet exit');
      ok = result.ok;
      return result;
    } finally {
      const { gate, endNow } = exitGateSettle(exitGate.current, ok);
      exitGate.current = gate;
      if (endNow) clearAndLeave(endNow);
    }
  }, [clearAndLeave]);

  const signal = useCallback((value: SessionSignal) => {
    const end = decideSessionEnd(value, generation);
    if (end) endSession(end);
  }, [endSession, generation]);

  /**
   * A denied read means removal (section 13), but App Check or a token refresh can also
   * deny a read for a moment. The server's verdict decides: the heartbeat answers
   * `device_revoked` / `household_deleting` for a removed tablet; anything else keeps the
   * session and the listeners start again later.
   */
  const confirmDenied = useCallback(async () => {
    try {
      const user = auth.currentUser;
      if (!user) return signal({ kind: 'signed-out' });
      const result = await deviceHeartbeatAction({ idToken: await user.getIdToken(), householdId, appVersion: BUILD_ID });
      if (!result.ok) signal({ kind: 'refusal', code: result.code });
    } catch {
      // Unreachable: try again later.
    }
  }, [householdId, signal]);


  // The tablet's own record, its household and the roster, from the server (SL-3b). Every
  // listener retries on its own (tabletListener); a settled denial of the record or the
  // household asks the server whether the tablet was removed.
  useEffect(() => {
    if (endingSession) return;
    let stopped = false;
    void Promise.all([import('@/lib/firebase'), import('firebase/firestore')]).then(([{ db }, fs]) => {
      if (stopped) return;
      const { doc, collection, onSnapshot } = fs;
      const recordRef = doc(db, 'households', householdId, 'devices', deviceId);
      const householdRef = doc(db, 'households', householdId);
      const fromServer = (snapshot: { metadata: { fromCache: boolean } }) => !snapshot.metadata.fromCache;
      const denied = () => { void confirmDenied(); };
      stops.current.push(tabletListener<DocumentSnapshot>(
        (next, error) => onSnapshot(recordRef, { includeMetadataChanges: true }, next, error),
        {
          confirmed: fromServer,
          onDenied: denied,
          next: (snapshot) => {
            signal({ kind: 'record', fromCache: snapshot.metadata.fromCache, exists: snapshot.exists(), status: snapshot.get('status'), generation: snapshot.get('generation'), endedReason: snapshot.get('endedReason') });
            if (snapshot.exists() && snapshot.get('status') === 'active' && snapshot.get('generation') === generation) setSettings(readDeviceSettings(snapshot.data()));
          },
        },
      ).stop);
      stops.current.push(tabletListener<DocumentSnapshot>(
        (next, error) => onSnapshot(householdRef, { includeMetadataChanges: true }, next, error),
        {
          confirmed: fromServer,
          onDenied: denied,
          next: (snapshot) => {
            signal({ kind: 'household', fromCache: snapshot.metadata.fromCache, exists: snapshot.exists(), deleting: Boolean(snapshot.get('deletingAt')) });
            if (!snapshot.exists()) return;
            const data = snapshot.data() ?? {};
            setHousehold({
              name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Home',
              timeZone: typeof data.timeZone === 'string' ? data.timeZone : 'America/Chicago',
              quietHours: readQuietHours(data.quietHours),
              pointsPin: readPointsPinPolicy(data as { devicePolicy?: { pointsPin?: unknown } }),
            });
          },
        },
      ).stop);
      stops.current.push(tabletListener<QuerySnapshot>(
        (next, error) => onSnapshot(collection(db, 'households', householdId, 'members'), { includeMetadataChanges: true }, next, error),
        { confirmed: fromServer, next: (snapshot) => setRoster(rosterFrom(snapshot.docs.map((d) => ({ id: d.id, data: d.data() })))) },
      ).stop);
    });
    return () => {
      stopped = true;
      stopListeners();
    };
  }, [confirmDenied, deviceId, generation, householdId, signal, stopListeners]);

  // The six household-wide notification listeners (5.6): one per enabled source, each retrying on its own.
  const sectionsKey = settings ? JSON.stringify(settings.sections) : '';
  useEffect(() => {
    if (!settings || endingSession) return;
    let stopped = false;
    const local: Array<() => void> = [];
    void Promise.all([import('@/lib/firebase'), import('firebase/firestore')]).then(([{ db }, fs]) => {
      if (stopped) return;
      const { collection, limit, onSnapshot, orderBy, query, where } = fs;
      const categories = deviceNotificationCategories(settings.sections);
      setNoticesByCategory((previous) => Object.fromEntries(Object.entries(previous).filter(([category]) => categories.includes(category as never))));
      for (const category of categories) {
        const q = query(
          collection(db, 'households', householdId, 'notifications'),
          where('audience', 'array-contains', '*'),
          where('category', '==', category),
          orderBy('createdAt', 'desc'),
          limit(DEVICE_NOTICES_LIMIT),
        );
        local.push(tabletListener<QuerySnapshot>(
          (next, error) => onSnapshot(q, { includeMetadataChanges: true }, next, error),
          {
            confirmed: (snapshot) => !snapshot.metadata.fromCache,
            next: (snapshot) => {
              const notices = snapshot.docs.map((d) => parseDeviceNotice(d.id, d.data(), Date.now())).filter((notice): notice is DeviceNotice => notice !== null);
              setNoticesByCategory((previous) => ({ ...previous, [category]: notices }));
              setNoticesWindowFull((previous) => ({ ...previous, [category]: snapshot.size >= DEVICE_NOTICES_LIMIT }));
            },
          },
        ).stop);
      }
    });
    return () => {
      stopped = true;
      local.forEach((stop) => stop());
    };
    // `sectionsKey` stands for settings.sections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, sectionsKey]);

  // Heartbeat: at start, when visible, on reconnect, every 5 minutes while visible.
  useEffect(() => {
    const beat = async () => {
      if (document.visibilityState !== 'visible' || !auth.currentUser || endingSession) return;
      try {
        const result = await deviceHeartbeatAction({ idToken: await auth.currentUser.getIdToken(), householdId, appVersion: BUILD_ID });
        if (!result.ok) signal({ kind: 'refusal', code: result.code });
      } catch {
        // Offline or unreachable: the next beat tries again.
      }
    };
    void beat();
    const timer = window.setInterval(beat, HEARTBEAT_EVERY_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void beat(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', beat);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', beat);
    };
  }, [householdId, signal]);

  // "This browser is a tablet": if the session ends while the shell is not running, the
  // signed-out app finishes the clearing (src/lib/devices/former-tablet.ts).
  useEffect(() => { markTabletBrowser(); }, []);

  // A tablet never holds a push subscription: retried at every start until it succeeds (S5, WT-10a).
  useEffect(() => {
    void clearPushState(browserPushClearDeps()).then((result) => {
      if (!result.ok) console.warn('Leftover push state could not be fully cleared yet.', result.errors.join('; '));
    });
  }, []);

  // The Auth user signing out (refresh refused, user deleted or disabled) ends the session.
  useEffect(() => auth.onAuthStateChanged((user) => {
    if (!user && !endingSession) signal({ kind: 'signed-out' });
  }), [signal]);

  const notices = useMemo(() => {
    const seen = new Map<string, DeviceNotice>();
    Object.values(noticesByCategory).flat().forEach((notice) => seen.set(notice.id, notice));
    return [...seen.values()].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }, [noticesByCategory]);

  if (ending) return <TabletMessage title="Signing this tablet out" body="Clearing this tablet's household data…" />;
  if (!settings || !household) return <TabletMessage title="This tablet is set up" body="Connecting to your household…" />;

  const scope: DashboardScope = {
    kind: 'device',
    householdId,
    householdName: household.name,
    timeZone: household.timeZone,
    uid: '',
    email: '',
    greetingName: null,
    permissions: devicePermissions(settings.sections),
    seasonal: settings.display.seasonal,
  };

  return (
    <AppearanceProvider>
      <ComfortSync settings={settings} />
      <DashboardScopeProvider value={scope}>
        <Suspense fallback={null}>
          <TabletFrame
            householdId={householdId}
            deviceId={deviceId}
            generation={generation}
            settings={settings}
            household={household}
            roster={roster}
            notices={notices}
            noticesComplete={!Object.entries(noticesWindowFull).some(([category, full]) => full && deviceNotificationCategories(settings.sections).includes(category as never))}
            endSession={endSession}
            runExit={runExit}
          />
        </Suspense>
      </DashboardScopeProvider>
      <Toaster />
    </AppearanceProvider>
  );
}

/** Comfort settings from the record (D-T2): theme, text size (115 % by default), motion, sound. */
function ComfortSync({ settings }: { settings: DeviceSettings }) {
  const { setPreferences } = useAppearance();
  // Every value from the record (tablet-settings-apply.ts): a previous personal session's
  // colour preset, haptics or text size on this browser never carries over.
  const appearanceKey = JSON.stringify(appearanceFromRecord(settings.comfort));
  useEffect(() => {
    setPreferences(JSON.parse(appearanceKey));
  }, [setPreferences, appearanceKey]);
  // Weather from the record's display settings, never a person's preference (S12, HP-18b).
  const weatherKey = JSON.stringify(weatherFromRecord(settings.display));
  useEffect(() => {
    setDeviceWeather(JSON.parse(weatherKey));
  }, [weatherKey]);
  // Kiosk behaviour on the shell (WT-14h/i): no pull-to-refresh, heavy effects off.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-kiosk', '');
    return () => root.removeAttribute('data-kiosk');
  }, []);
  return null;
}

type Prompt =
  | { kind: 'who'; purpose: 'admin' | 'action'; title: string; resolve: (person: RosterPerson | null) => void }
  | { kind: 'pin'; person: RosterPerson; resolve: (sessionId: string | null) => void };


function TabletFrame(props: {
  householdId: string;
  deviceId: string;
  generation: number;
  settings: DeviceSettings;
  household: TabletHousehold;
  roster: RosterPerson[];
  notices: DeviceNotice[];
  noticesComplete: boolean;
  endSession: (end: SessionEnd) => void;
  runExit: TabletContextValue['runExit'];
}) {
  const { householdId, deviceId, generation, settings, household, roster, notices, noticesComplete, endSession, runExit } = props;
  // Section views need the uncapped facts (never the dashboard's previews).
  const data = useDashboardData(true, { sections: true });
  const sectionFacts = data.sectionFacts ?? {};
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  // --- State machine and timers (14.2, 14.3) --------------------------------
  const [shell, setShell] = useState<ShellState>(() => initialShellState(Date.now()));
  const shellRef = useRef(shell);
  const timers = useMemo<ShellTimers>(() => shellTimersFrom(settings.idle), [settings.idle]);
  const timersRef = useRef(timers);
  useEffect(() => { timersRef.current = timers; }, [timers]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const promptRef = useRef<Prompt | null>(null);
  useEffect(() => { promptRef.current = prompt; }, [prompt]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  const known: KnownTargets = useMemo(() => ({
    roomIds: sectionFacts.chores ? new Set(sectionFacts.chores.rooms.map((room) => room.id)) : undefined,
    listIds: sectionFacts.shopping ? new Set(sectionFacts.shopping.lists.map((list) => list.id)) : undefined,
  }), [sectionFacts.chores, sectionFacts.shopping]);

  const startPath = useCallback(() => pathOfView(startView(settings.startPage, settings.sections, known).view), [known, settings.sections, settings.startPage]);

  const closePrompts = useCallback(() => {
    const open = promptRef.current;
    if (open?.kind === 'who') open.resolve(null);
    if (open?.kind === 'pin') open.resolve(null);
    setPrompt(null);
    setSettingsOpen(false);
    setQuickAddOpen(false);
  }, []);

  const idToken = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) throw new Error('signed out');
    return user.getIdToken();
  }, []);

  const apply = useCallback((event: ShellEvent) => {
    const { state, effects } = shellReducer(shellRef.current, event, timersRef.current);
    shellRef.current = state;
    setShell(state);
    for (const effect of effects) {
      if (effect.kind === 'end-pin-session') {
        void idToken().then((token) => endPinSessionAction({ idToken: token, householdId, pinSessionId: effect.sessionId })).catch(() => undefined);
      } else if (effect.kind === 'go-start-page') {
        // Idle return: dialogs close safely (nothing busy holds them) and the start page shows.
        closePrompts();
        router.replace(startPath());
      }
    }
  }, [closePrompts, householdId, idToken, router, startPath]);

  // Input starts a new idle period. A tap on the ambient screen wakes it there (never acts).
  useEffect(() => {
    const onInput = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-ambient]')) return;
      apply({ type: 'input', now: Date.now() });
    };
    document.addEventListener('pointerdown', onInput, true);
    document.addEventListener('keydown', onInput, true);
    return () => {
      document.removeEventListener('pointerdown', onInput, true);
      document.removeEventListener('keydown', onInput, true);
    };
  }, [apply]);

  // One timer to the next deadline; a busy shell ticks again as soon as it is idle.
  useEffect(() => {
    const deadline = nextShellDeadline(shell, timers);
    const tick = () => apply({ type: 'tick', now: Date.now(), busy: isShellBusy() });
    const stopBusy = subscribeShellBusy((busy) => { if (!busy) tick(); });
    const id = deadline === null ? null : window.setTimeout(tick, Math.max(0, deadline - Date.now()) + 50);
    return () => {
      stopBusy();
      if (id !== null) window.clearTimeout(id);
    };
  }, [apply, shell, timers]);

  // --- Navigation, start page and section rules (14.5, 4.2) ------------------
  const requested = `${pathname}${search.toString() ? `?${search.toString()}` : ''}`;
  const resolved = resolveTabletPath(requested, settings, known);
  const view = resolved.view;
  const target = pathOfView(view);
  // Deferred navigation (pure: navigationReducer). A new start page, or a section switched
  // off under the current page, navigates as soon as nothing is busy; data updates meanwhile
  // never cancel it, and a start-page change counts as applied only when it runs (WT-4i, 4.2).
  const busy = useShellBusy();
  const startKey = JSON.stringify(settings.startPage);
  const navState = useRef(initialNavigationState(startKey));
  const latest = useRef({ startPath, target, startKey });
  useEffect(() => { latest.current = { startPath, target, startKey }; });
  const stepNavigation = useCallback((event: NavigationEvent) => {
    const result = navigationReducer(navState.current, event, latest.current.startKey);
    navState.current = result.state;
    if (result.navigate === 'start-page') router.replace(latest.current.startPath());
    else if (result.navigate === 'leave-page') router.replace(latest.current.target);
  }, [router]);
  useEffect(() => {
    stepNavigation({ type: 'start-page', startKey });
    stepNavigation(resolved.redirected ? { type: 'leave-page' } : { type: 'page-allowed' });
    stepNavigation({ type: 'tick', busy });
  }, [busy, resolved.redirected, startKey, stepNavigation, target]);

  const navigate = useCallback((path: string) => {
    const next = resolveTabletPath(path, settings, known).view;
    if (!sameView(next, view)) router.push(pathOfView(next));
  }, [known, router, settings, view]);

  // --- People, PINs and the action pipeline ---------------------------------
  const person = useCallback((uid: string | null | undefined) => roster.find((p) => p.uid === uid) ?? null, [roster]);

  const askPerson = useCallback((purpose: 'admin' | 'action', title: string) => new Promise<RosterPerson | null>((resolve) => {
    setPrompt({ kind: 'who', purpose, title, resolve: (picked) => { setPrompt(null); resolve(picked); } });
  }), []);

  const askPin = useCallback((who: RosterPerson) => new Promise<string | null>((resolve) => {
    setPrompt({ kind: 'pin', person: who, resolve: (sessionId) => { setPrompt(null); resolve(sessionId); } });
  }), []);

  const message = useCallback((code: DeviceRefusal, who?: RosterPerson | null, retryAfterSec?: number) => {
    const response = deviceRefusalResponse(code, { name: who?.name, kid: who?.role === 'child', retryAfterSec });
    if (response.kind === 'revoked') return endSession(code === 'household_deleting' ? 'household-deleted' : 'removed');
    if (response.kind === 'message') {
      if (response.clearFace) apply({ type: 'done' });
      toast({ description: response.message, variant: response.retry ? undefined : 'destructive' });
    }
  }, [apply, endSession]);

  // An admin unlock in progress ("Who's here?" then the PIN pad): other dialogs stay aside
  // for the whole flow, also in the moment between the picker closing and the pad opening.
  const [unlocking, setUnlocking] = useState(0);
  const unlockAdmin = useCallback(async (reason: string, actorUid?: string): Promise<TabletActor | null> => {
    const who = (actorUid ? person(actorUid) : null) ?? await askPerson('admin', reason);
    if (!who) return null;
    if (!isOwnerOrAdmin(who)) {
      message('admin_pin_required');
      return null;
    }
    apply({ type: 'pick', memberUid: who.uid, now: Date.now() });
    // Always a fresh verify for admin-PIN capabilities (S9).
    const current = shellRef.current.pin;
    if (current && current.memberUid === who.uid && Date.now() - current.unlockedAt < FRESH_PIN_MS) return { actorUid: who.uid, pinSessionId: current.sessionId };
    const sessionId = await askPin(who);
    return sessionId ? { actorUid: who.uid, pinSessionId: sessionId } : null;
  }, [apply, askPerson, askPin, message, person]);

  const requestAdmin = useCallback(async (reason: string, actorUid?: string): Promise<TabletActor | null> => {
    setUnlocking((n) => n + 1);
    try {
      return await unlockAdmin(reason, actorUid);
    } finally {
      setUnlocking((n) => n - 1);
    }
  }, [unlockAdmin]);

  const runAction = useCallback(async (request: TabletActionRequest) => {
    const policy = policyOf(request.capability);
    if (policy.levelClass === 'not_on_tablets' || policy.levelClass === 'never' || !request.execute) {
      // Until F4 every write on a tablet is refused; the server refuses it too.
      message('not_on_tablets');
      return;
    }
    let actor: TabletActor | null;
    if (policy.levelClass === 'admin-pin') {
      actor = await requestAdmin(request.label);
    } else {
      const remembered = activeFace(shellRef.current.face, Date.now(), isShellBusy());
      const who = person(remembered?.memberUid) ?? await askPerson('action', request.label);
      if (!who) return;
      apply({ type: 'pick', memberUid: who.uid, now: Date.now() });
      const required = requiredLevel(request.capability, { pointsPin: household.pointsPin, actorRole: who.role });
      const unlock = shellRef.current.pin?.memberUid === who.uid ? shellRef.current.pin.sessionId : undefined;
      const sessionId = required === 'pin' && !unlock ? await askPin(who) : unlock;
      if (required === 'pin' && !sessionId) return;
      actor = { actorUid: who.uid, ...(sessionId ? { pinSessionId: sessionId } : {}) };
    }
    if (!actor) return;
    const answer: TabletActionAnswer = await whileBusy('save', request.execute(actor)).catch((): TabletActionAnswer => ({ ok: false, code: 'failed' }));
    const who = person(actor.actorUid);
    if (answer.ok) {
      apply({ type: 'credit', memberUid: actor.actorUid, now: Date.now() });
      if (actor.pinSessionId) apply({ type: 'pin-used', now: Date.now() });
      return;
    }
    if (answer.code === 'pin_session_invalid' || answer.code === 'pin_required' || answer.code === 'pin_fresh_required') apply({ type: 'pin-invalid' });
    message(answer.code, who, answer.retryAfterSec);
  }, [apply, askPerson, askPin, household.pointsPin, message, person, requestAdmin]);

  const done = useCallback(() => apply({ type: 'done' }), [apply]);
  const goStart = useCallback(() => router.push(startPath()), [router, startPath]);

  // --- Keep-awake, night dimming --------------------------------------------
  useEffect(() => {
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!api) return;
    const watch = watchKeepAwake({ api, page: document, wanted: () => true });
    return watch.stop;
  }, []);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const quiet = isQuietAt(household.quietHours, household.timeZone, now);

  const value: TabletContextValue = {
    householdId,
    deviceId,
    generation,
    settings,
    household,
    roster,
    notices,
    noticesComplete,
    data,
    shell,
    prompting: prompt !== null || unlocking > 0,
    view,
    navigate,
    goStart,
    done,
    runAction,
    requestAdmin,
    idToken,
    endSession,
    runExit,
    openSettings: () => setSettingsOpen(true),
    openQuickAdd: () => setQuickAddOpen(true),
    person,
  };

  const resting = !currentActor(shell) && !prompt && !settingsOpen && !quickAddOpen;

  return (
    <TabletContext.Provider value={value}>
      <div
        data-testid="tablet-shell"
        data-resting={resting ? 'true' : 'false'}
        className="fixed inset-0 flex select-none overscroll-none bg-background text-foreground touch-manipulation [-webkit-touch-callout:none] [&_input]:select-text [&_textarea]:select-text"
      >
        <TabletRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <TabletTopBar now={now} />
          <main id="tablet-main" className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="tablet-main">
            <TabletViewContent />
          </main>
        </div>
      </div>
      {prompt?.kind === 'who' && (
        <WhoIsHereDialog purpose={prompt.purpose} title={prompt.title} people={roster} onPick={prompt.resolve} />
      )}
      {prompt?.kind === 'pin' && (
        <PinPadDialog
          person={prompt.person}
          onVerified={(sessionId) => {
            apply({ type: 'pin-verified', memberUid: prompt.person.uid, sessionId, now: Date.now() });
            prompt.resolve(sessionId);
          }}
          onCancel={() => prompt.resolve(null)}
          onRevoked={(code) => message(code)}
        />
      )}
      {settingsOpen && <TabletSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {quickAddOpen && <TabletQuickAdd onClose={() => setQuickAddOpen(false)} />}
      {shell.ambient && <AmbientScreen now={now} onWake={() => apply({ type: 'input', now: Date.now() })} />}
      {quiet && <NightDim />}
      <TabletUpdateWatcher resting={resting} />
    </TabletContext.Provider>
  );
}

