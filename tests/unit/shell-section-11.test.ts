import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { AUTO_RETRY_DELAYS_MS, autoRetryDelay, retryUntil } from '../../src/lib/shell/auto-retry';
import { membershipPhase, membershipReducer, initialMembershipState } from '../../src/lib/auth/live-membership';

import { SECTION_TITLES, documentTitle, ROOT_TITLE, TITLE_TEMPLATE } from '../../src/lib/shell/page-titles';

import { AUTO_DARK_QUARTERS, autoIsDark, nextAutoSwitch, parseAppearance, resolvePresetId, themeBootstrapScript, APPEARANCE_STORAGE_KEY } from '../../src/lib/theme/appearance';
import { isThemeMode } from '../../src/lib/theme/tokens';

import { shouldMoveRouteFocus } from '../../src/lib/shell/route-focus';

import { installPromptSnapshot, installState, promptInstall, captureInstallPrompt, resetInstallPromptForTests } from '../../src/lib/shell/install-prompt';
import manifest from '../../src/app/manifest';
import { THEME_COLORS as PAGE_COLORS } from '../../src/lib/theme/appearance';
import { existsSync } from 'node:fs';

import { AMBIENT_PET_MAX, ambientNextUp, ambientPetPosition, ambientPets } from '../../src/lib/devices/ambient-scene';
import type { DashboardFacts } from '../../src/lib/dashboard/facts';
import type { DeviceSections } from '../../src/lib/devices/types';

import { WHATS_NEW, buildDay, decideUpdatedMoment } from '../../src/lib/shell/whats-new';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('SL-1: section error boundaries', () => {
  it('Maintenance has its own route boundary with the shared crash recovery', () => {
    const boundary = source('src/app/maintenance/error.tsx');
    assert.match(boundary, /^'use client';/);
    assert.match(boundary, /useCrashRecovery\(error\)/);
    assert.match(boundary, /retry\(\)/);
    assert.match(boundary, /Maintenance ran into a problem/);
    assert.match(boundary, /role="alert"/);
    // Never claims an unsaved form was kept.
    assert.match(boundary, /may need to be entered again/);
  });
});

describe('SL-12: loads retry on their own', () => {
  it('backs off 2 s, 5 s, 15 s, 30 s, then every 60 s', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((n) => autoRetryDelay(n)), [2000, 5000, 15000, 30000, 60000, 60000, 60000]);
    assert.equal(autoRetryDelay(0), AUTO_RETRY_DELAYS_MS[0]);
  });

  const manualTimers = () => {
    const pending = new Map<number, { fn: () => void; ms: number }>();
    let next = 1;
    return {
      pending,
      setTimer: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { fn, ms }); return id; },
      clearTimer: (id: unknown) => { pending.delete(id as number); },
      fireAll: () => { for (const [id, entry] of [...pending]) { pending.delete(id); entry.fn(); } },
    };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('retries a failing read until it answers', async () => {
    const timers = manualTimers();
    let calls = 0;
    const errors: number[] = [];
    const result = retryUntil(async () => {
      calls += 1;
      if (calls < 3) throw new Error('offline');
      return 'profile';
    }, { keepGoing: () => true, onError: (_e, attempt) => errors.push(attempt), onlineTarget: null, ...timers });
    await flush();
    assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [2000]);
    timers.fireAll();
    await flush();
    assert.deepEqual([...timers.pending.values()].map((t) => t.ms), [5000]);
    timers.fireAll();
    assert.deepEqual(await result, { aborted: false, value: 'profile' });
    assert.deepEqual(errors, [1, 2]);
  });

  it('retries at once when the browser comes back online', async () => {
    const timers = manualTimers();
    const target = new EventTarget();
    let calls = 0;
    const result = retryUntil(async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return 1;
    }, { keepGoing: () => true, onlineTarget: target, ...timers });
    await flush();
    target.dispatchEvent(new Event('online'));
    assert.deepEqual(await result, { aborted: false, value: 1 });
    assert.equal(timers.pending.size, 0, 'the backoff timer is cleared');
  });

  it('stops when another account (or nobody) is signed in, and drops a late answer', async () => {
    const timers = manualTimers();
    let signedIn = true;
    const failing = retryUntil(async () => { throw new Error('offline'); }, { keepGoing: () => signedIn, onlineTarget: null, ...timers });
    await flush();
    signedIn = false;
    timers.fireAll();
    assert.deepEqual(await failing, { aborted: true });

    let current = true;
    const late = retryUntil(async () => { current = false; return 'stale'; }, { keepGoing: () => current, onlineTarget: null, ...timers });
    assert.deepEqual(await late, { aborted: true });
  });

  it('the profile read in AuthProvider uses it', () => {
    const auth = source('src/contexts/auth-context.tsx');
    assert.match(auth, /retryUntil\(\(\) => fetchOrCreateUserProfile\(firebaseUser\)/);
    assert.match(auth, /if \(fetched\.aborted\) return;/);
  });

  it('a household that failed to load opens by itself once the record answers (listeners keep retrying)', () => {
    let state = membershipReducer(initialMembershipState, { type: 'watch', uid: 'u1', householdId: 'h1' });
    state = membershipReducer(state, { type: 'memberError', householdId: 'h1', failure: 'transient' });
    assert.equal(membershipPhase(state), 'failed');
    state = membershipReducer(state, { type: 'member', householdId: 'h1', uid: 'u1', exists: true, data: { role: 'member', status: 'approved' }, fromCache: false, offline: false });
    assert.notEqual(membershipPhase(state), 'failed');
  });
});

describe('SL-13: every page has its own title', () => {
  it('the root template suffixes each section name', () => {
    assert.deepEqual(ROOT_TITLE, { default: 'HomeHub', template: TITLE_TEMPLATE });
    assert.equal(documentTitle('chores'), 'Chores - HomeHub');
    assert.equal(documentTitle('library'), 'Barcode Library - HomeHub');
    assert.equal(documentTitle(null), 'HomeHub');
  });

  it('each section segment sets its own name, and no title doubles the suffix', () => {
    const segments: Array<[string, keyof typeof SECTION_TITLES]> = [
      ['src/app/shopping/layout.tsx', 'shopping'],
      ['src/app/pets/layout.tsx', 'pets'],
      ['src/app/maintenance/layout.tsx', 'maintenance'],
      ['src/app/chores/layout.tsx', 'chores'],
      ['src/app/calendar/layout.tsx', 'calendar'],
      ['src/app/automation/layout.tsx', 'automation'],
      ['src/app/library/layout.tsx', 'library'],
      ['src/app/profile/layout.tsx', 'profile'],
      ['src/app/household/page.tsx', 'household'],
      ['src/app/notifications/page.tsx', 'notifications'],
      ['src/app/setup/page.tsx', 'setup'],
    ];
    for (const [file, key] of segments) {
      assert.match(source(file), new RegExp(`export const metadata = sectionMetadata\\('${key}'\\)`), file);
    }
    assert.match(source('src/app/layout.tsx'), /title: ROOT_TITLE/);
    for (const file of ['src/app/offline/page.tsx', 'src/app/not-found.tsx', 'src/app/share/page.tsx']) {
      assert.doesNotMatch(source(file), /title: '[^']*- HomeHub'/, file);
    }
    assert.match(source('src/app/share/page.tsx'), /absolute: 'Add to HomeHub'/);
  });
});

describe('SL-14: theme "Automatic by time of day"', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 27, h, m);

  it('is a valid, synced mode; old values still parse', () => {
    assert.equal(isThemeMode('auto'), true);
    assert.equal(parseAppearance({ mode: 'auto' }).mode, 'auto');
    assert.equal(parseAppearance({ mode: 'sometimes' }).mode, 'dark');
  });

  it('is light from 7:00 and dark from 19:00, from the day phases', () => {
    assert.equal(AUTO_DARK_QUARTERS.length, 96);
    assert.equal(autoIsDark(at(6, 59)), true);
    assert.equal(autoIsDark(at(7, 0)), false);
    assert.equal(autoIsDark(at(12)), false);
    assert.equal(autoIsDark(at(18, 59)), false);
    assert.equal(autoIsDark(at(19, 0)), true);
    assert.equal(autoIsDark(at(0, 30)), true);
    const prefs = { mode: 'auto', darkPreset: 'hearth', lightPreset: 'sunrise' } as const;
    assert.equal(resolvePresetId(prefs, false, at(13)), 'sunrise');
    assert.equal(resolvePresetId(prefs, false, at(22)), 'hearth');
    // The system preference plays no part in Automatic.
    assert.equal(resolvePresetId(prefs, true, at(13)), 'sunrise');
  });

  it('knows its next switch', () => {
    assert.equal(nextAutoSwitch(at(13, 20)).getHours(), 19);
    assert.equal(nextAutoSwitch(at(13, 20)).getMinutes(), 0);
    const morning = nextAutoSwitch(at(23, 50));
    assert.deepEqual([morning.getDate(), morning.getHours(), morning.getMinutes()], [28, 7, 0]);
  });

  it('the pre-paint script picks the same preset as the provider (no flash)', () => {
    const script = themeBootstrapScript();
    for (const hour of [0, 6, 7, 12, 18, 19, 23]) {
      const attrs = new Map<string, string>();
      const classes = new Set<string>();
      const root = {
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        removeAttribute: (k: string) => attrs.delete(k),
        classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      };
      const fakeDocument = { documentElement: root, querySelector: () => null };
      const stored = JSON.stringify({ mode: 'auto', darkPreset: 'forest', lightPreset: 'light' });
      const fakeStorage = { getItem: (key: string) => (key === APPEARANCE_STORAGE_KEY ? stored : null) };
      const fakeWindow = { matchMedia: () => ({ matches: true }) };
      const FixedDate = class extends Date { constructor() { super(2026, 10, 27, hour, 30); } };
      new Function('document', 'window', 'localStorage', 'Date', script)(fakeDocument, fakeWindow, fakeStorage, FixedDate);
      const expected = resolvePresetId({ mode: 'auto', darkPreset: 'forest', lightPreset: 'light' }, true, at(hour, 30));
      assert.equal(attrs.get('data-theme'), expected, `at ${hour}:30`);
    }
  });

  it('Profile offers it; the provider re-checks at the switch and on wake', () => {
    assert.match(source('src/components/appearance-settings.tsx'), /value: 'auto', label: 'By time'/);
    const provider = source('src/components/appearance-provider.tsx');
    assert.match(provider, /useAutoClock\(preferences\.mode === 'auto'\)/);
    assert.match(provider, /nextAutoSwitch\(current\)/);
    assert.match(provider, /visibilitychange/);
  });
});

describe('SL-18: skip link and focus after navigation', () => {
  const focus = (patch: Partial<{ onBody: boolean; inShellNav: boolean; overlayOpen: boolean }> = {}) =>
    ({ onBody: false, inShellNav: false, overlayOpen: false, ...patch });

  it('moves focus only on a real page change, from the body or the shell navigation', () => {
    assert.equal(shouldMoveRouteFocus({ previousPath: null, path: '/', focus: focus({ onBody: true }) }), false, 'first load');
    assert.equal(shouldMoveRouteFocus({ previousPath: '/chores', path: '/chores', focus: focus({ onBody: true }) }), false, 'same page');
    assert.equal(shouldMoveRouteFocus({ previousPath: '/', path: '/chores', focus: focus({ inShellNav: true }) }), true, 'header link');
    assert.equal(shouldMoveRouteFocus({ previousPath: '/', path: '/chores', focus: focus({ onBody: true }) }), true, 'body');
    assert.equal(shouldMoveRouteFocus({ previousPath: '/', path: '/chores', focus: focus() }), false, 'a control in the page keeps focus');
    assert.equal(shouldMoveRouteFocus({ previousPath: '/', path: '/chores', focus: focus({ onBody: true, overlayOpen: true }) }), false, 'a dialog is open');
  });

  it('the layout has the skip link, main#main and the route focus; the tab bar counts as shell navigation', () => {
    const layout = source('src/app/layout.tsx');
    assert.match(layout, /href="#main"/);
    assert.match(layout, /<main id="main" tabIndex=\{-1\}/);
    assert.match(layout, /<RouteFocus \/>/);
    assert.ok(layout.indexOf('href="#main"') < layout.indexOf('<Header />'), 'the skip link comes before the header');
    assert.match(source('src/components/mobile-tab-bar.tsx'), /data-shell-nav/);
    const component = source('src/components/shell/route-focus.tsx');
    assert.match(component, /preventScroll: true/);
    // Closed overlays that stay mounted (the force-mounted account menu, the tab bar's
    // hidden quick-add fan) never block it: only a shown one counts.
    assert.match(component, /overlayOpen: overlayShown\(\)/);
    const rule = source('src/lib/shell/route-focus.ts');
    assert.match(rule, /closest\('\[aria-hidden="true"\]'\)/);
    assert.match(rule, /data-state'\) === 'closed'/);
  });
});

describe('SL-19: manifest polish and the install offer', () => {
  it('matches the page colour and gives each shortcut its own icon', () => {
    const m = manifest();
    assert.equal(m.theme_color, PAGE_COLORS.midnight);
    assert.equal(m.background_color, PAGE_COLORS.midnight);
    const icons = (m.shortcuts ?? []).map((shortcut) => shortcut.icons?.[0]?.src);
    assert.equal(new Set(icons).size, 3);
    for (const src of icons) assert.ok(existsSync(resolve(process.cwd(), 'public' + src)), `${src} exists`);
  });

  it('shows Install only while the browser offers it and the app is not installed', () => {
    assert.equal(installState({ hasPrompt: true, standalone: false, installed: false }), 'available');
    assert.equal(installState({ hasPrompt: false, standalone: false, installed: false }), 'unavailable');
    assert.equal(installState({ hasPrompt: true, standalone: true, installed: false }), 'installed');
    assert.equal(installState({ hasPrompt: false, standalone: false, installed: true }), 'installed');
  });

  it('keeps the browser event, replays it once and forgets it', async () => {
    resetInstallPromptForTests();
    const target = new EventTarget() as unknown as Window;
    captureInstallPrompt(target);
    let prompted = 0;
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: async () => { prompted += 1; },
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, "Chrome's own mini-infobar is held back");
    assert.equal(installPromptSnapshot().hasPrompt, true);
    assert.equal(await promptInstall(), 'accepted');
    assert.equal(prompted, 1);
    assert.equal(installPromptSnapshot().hasPrompt, false);
    assert.equal(await promptInstall(), 'unavailable');
    target.dispatchEvent(new Event('appinstalled'));
    assert.equal(installPromptSnapshot().installed, true);
    resetInstallPromptForTests();
  });
});

describe('SL-23: the richer ambient screen on registered tablets', () => {
  const allOn = { chores: true, pets: true, shopping: true, maintenance: true, calendar: true } as unknown as DeviceSections;
  const pet = (id: string, type: string, fed: boolean | null, needsMeal = false) =>
    ({ id, name: `Pet ${id}`, type, fed, needsMeal, lastFedAt: null, lastFedBy: null, countLabel: '', headline: '' });
  const facts = {
    pets: { pets: [pet('a', 'Dog', true), pet('b', 'cat', false, true), pet('c', 'Rabbit', null), pet('d', 'dog', true), pet('e', 'cat', true)], hungry: 1, unknown: 1 },
    chores: {
      nextUp: [{ id: 'c1', task: ' Water the plants ', dueLabel: 'Today', overdue: false, mine: false, assignee: 'Sam Member' }],
    },
  } as unknown as DashboardFacts;

  it('draws pets without names: at the bowl when due, resting when unknown, at most four', () => {
    const pets = ambientPets(facts, allOn);
    assert.equal(pets.length, AMBIENT_PET_MAX);
    assert.deepEqual(pets.map((p) => [p.kind, p.spot]), [['dog', 'wander'], ['cat', 'bowl'], ['other', 'rest'], ['dog', 'wander']]);
    assert.equal(JSON.stringify(pets).includes('Pet a'), false);
    assert.deepEqual(ambientPets(facts, { ...allOn, pets: false }), []);
    assert.deepEqual(ambientPets({}, allOn), []);
  });

  it('wandering pets move each step and never share a spot; the others stay put', () => {
    const pets = ambientPets(facts, allOn);
    assert.notDeepEqual(ambientPetPosition(pets[0], 0, 0), ambientPetPosition(pets[0], 0, 1));
    assert.notDeepEqual(ambientPetPosition(pets[0], 0, 3), ambientPetPosition(pets[3], 3, 3));
    assert.deepEqual(ambientPetPosition(pets[1], 1, 0), ambientPetPosition(pets[1], 1, 5));
    assert.deepEqual(ambientPetPosition(pets[2], 2, 0), ambientPetPosition(pets[2], 2, 5));
  });

  it('the next-up line names the chore, never the person, and says nothing when unknown', () => {
    assert.equal(ambientNextUp(facts, allOn), 'Next up: Water the plants · Today');
    assert.equal(ambientNextUp(facts, { ...allOn, chores: false }), null);
    assert.equal(ambientNextUp({}, allOn), null);
    assert.equal(ambientNextUp({ chores: { nextUp: [] } } as unknown as DashboardFacts, allOn), null);
  });

  it('the house is decoration and the kiosk CSS blocks selection and double-tap zoom', () => {
    const overlays = source('src/components/devices/tablet-overlays.tsx');
    assert.match(overlays, /aria-hidden className="pointer-events-none relative/);
    assert.doesNotMatch(overlays.slice(overlays.indexOf('function AmbientHouse')), /<Link|href=/);
    const css = source('src/app/globals.css');
    assert.match(css, /:root\[data-kiosk\] body \{[^}]*user-select: none;[^}]*touch-action: manipulation;/);
  });
});

describe('SL-24: the "HomeHub updated" moment', () => {
  const entries = [
    { date: '2026-11-27', items: ['Newest'] },
    { date: '2026-11-25', items: ['Middle'] },
    { date: '2026-11-20', items: ['Older'] },
  ];

  it('shows once a newer build replaced the last one this browser ran', () => {
    assert.deepEqual(decideUpdatedMoment({ previousBuild: null, currentBuild: '20261127T100000000Z', entries }), { show: false }, 'first visit');
    assert.deepEqual(decideUpdatedMoment({ previousBuild: '20261127T100000000Z', currentBuild: '20261127T100000000Z', entries }), { show: false }, 'same build');
    assert.deepEqual(decideUpdatedMoment({ previousBuild: '20261128T100000000Z', currentBuild: '20261127T100000000Z', entries }), { show: false }, 'older page');
    assert.deepEqual(decideUpdatedMoment({ previousBuild: 'garbage', currentBuild: '20261127T100000000Z', entries }), { show: false });
  });

  it('lists the releases after the last build, else the newest one', () => {
    const moment = decideUpdatedMoment({ previousBuild: '20261121T080000000Z', currentBuild: '20261127T100000000Z', entries });
    assert.equal(moment.show, true);
    if (moment.show) {
      assert.deepEqual(moment.entries.map((e) => e.date), ['2026-11-27', '2026-11-25']);
      assert.equal(moment.headline, 'Newest');
    }
    const sameDay = decideUpdatedMoment({ previousBuild: '20261127T080000000Z', currentBuild: '20261127T100000000Z', entries });
    assert.equal(sameDay.show && sameDay.entries[0].date, '2026-11-27');
    assert.equal(buildDay('20261127T080000000Z'), '2026-11-27');
  });

  it('the changelog is newest first with dated, non-empty entries', () => {
    for (let i = 1; i < WHATS_NEW.length; i += 1) assert.ok(WHATS_NEW[i - 1].date > WHATS_NEW[i].date);
    for (const entry of WHATS_NEW) {
      assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(entry.items.length > 0);
    }
  });

  it('its toast never holds the shell busy, and tablets get no button or route', () => {
    const moment = source('src/components/shell/updated-moment.tsx');
    assert.match(moment, /holdsAction: false/);
    assert.match(moment, /action: tablet \? undefined/);
    assert.doesNotMatch(moment, /href=|router\.push/);
    assert.match(source('src/components/devices/tablet-shell.tsx'), /<UpdatedMoment tablet \/>/);
  });
});
