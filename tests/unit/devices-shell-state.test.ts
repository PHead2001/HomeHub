import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FACE_MEMORY_MS, activeFace, creditFace, faceExpired, rememberFace } from '../../src/lib/devices/face-memory';
import {
  PIN_IDLE_MS,
  currentActor,
  initialShellState,
  nextShellDeadline,
  shellReducer,
  shellTimersFrom,
  type ShellEvent,
  type ShellState,
} from '../../src/lib/devices/shell-state';
import {
  pathOfView,
  resolveTabletPath,
  startView,
  tabletNavItems,
  viewOfPath,
} from '../../src/lib/devices/start-page';
import { describeQuietHours, isQuietAt, readQuietHours, validateQuietHours } from '../../src/lib/devices/quiet-hours';
import { matchLocalIntents } from '../../src/lib/devices/quick-add-local';
import { initialsOf, rosterFrom } from '../../src/lib/devices/roster';
import { decideTabletReload } from '../../src/lib/shell/update-check';
import { createWakeLockController, watchKeepAwake, type WakeLockSentinelLike } from '../../src/lib/devices/wake-lock';
import { defaultSections } from '../../src/lib/devices/settings';
import type { DeviceSections } from '../../src/lib/devices/types';

// The tablet shell (docs/modules/devices/README.md, "Tablet shell"; design 14.2-14.5):
// the state machine with every timer and the busy guard, face memory, start page and
// section rules, household quiet hours, local quick add, the roster, idle reload and the
// generalized wake lock. All pure, with an injected clock.

const T0 = Date.parse('2026-11-14T15:00:00Z');
const timers = shellTimersFrom({ homeAfterSec: 120, ambientAfterSec: 600 });

const run = (events: ShellEvent[], start: ShellState = initialShellState(T0)) => {
  let state = start;
  const effects: string[] = [];
  for (const event of events) {
    const result = shellReducer(state, event, timers);
    state = result.state;
    effects.push(...result.effects.map((effect) => (effect.kind === 'end-pin-session' ? `end:${effect.sessionId}` : effect.kind)));
  }
  return { state, effects };
};

describe('face memory (D-T3, WT-8c/d)', () => {
  it('slides 2 minutes from the last credited action', () => {
    const face = rememberFace('mia', T0);
    assert.equal(faceExpired(face, T0 + FACE_MEMORY_MS - 1), false);
    assert.equal(faceExpired(face, T0 + FACE_MEMORY_MS), true);
    const credited = creditFace(face, 'mia', T0 + 90_000);
    assert.equal(faceExpired(credited, T0 + FACE_MEMORY_MS + 1), false);
    assert.equal(faceExpired(credited, T0 + 90_000 + FACE_MEMORY_MS), true);
  });

  it('a credit to someone else replaces the memory', () => {
    assert.deepEqual(creditFace(rememberFace('mia', T0), 'sam', T0 + 5), { memberUid: 'sam', lastActionAt: T0 + 5 });
  });

  it('never expires while the shell is busy', () => {
    const face = rememberFace('mia', T0);
    const late = T0 + FACE_MEMORY_MS + 60_000;
    assert.equal(activeFace(face, late, true), face);
    assert.equal(activeFace(face, late, false), null);
    assert.equal(activeFace(null, late, false), null);
  });
});

describe('shell state machine (14.2, 14.3)', () => {
  it('starts resting with nobody chosen', () => {
    const state = initialShellState(T0);
    assert.equal(currentActor(state), null);
    assert.equal(state.ambient, false);
  });

  it('pick → face; credited actions slide the 2 minutes; Done clears', () => {
    let { state } = run([{ type: 'pick', memberUid: 'mia', now: T0 }]);
    assert.deepEqual(currentActor(state), { memberUid: 'mia', level: 'face' });
    ({ state } = run([{ type: 'credit', memberUid: 'mia', now: T0 + 100_000 }, { type: 'input', now: T0 + 100_000 }, { type: 'tick', now: T0 + FACE_MEMORY_MS + 1, busy: false }], state));
    assert.equal(state.face?.memberUid, 'mia', 'still remembered after a credited action');
    ({ state } = run([{ type: 'tick', now: T0 + 100_000 + FACE_MEMORY_MS, busy: false }], state));
    assert.equal(state.face, null, 'forgotten 2 minutes after the last credited action');
    ({ state } = run([{ type: 'pick', memberUid: 'sam', now: T0 + 300_000 }, { type: 'done' }], state));
    assert.equal(currentActor(state), null);
  });

  it('face expiry waits while busy and fires on the next idle tick', () => {
    let { state } = run([{ type: 'pick', memberUid: 'mia', now: T0 }, { type: 'input', now: T0 + 60_000 }]);
    ({ state } = run([{ type: 'tick', now: T0 + FACE_MEMORY_MS + 5_000, busy: true }], state));
    assert.equal(state.face?.memberUid, 'mia', 'kept during a save, an Undo or unsaved input');
    ({ state } = run([{ type: 'tick', now: T0 + FACE_MEMORY_MS + 6_000, busy: false }], state));
    assert.equal(state.face, null);
  });

  it('PIN unlock: 2 idle minutes since the last gated use, then the session is ended', () => {
    let { state, effects } = run([{ type: 'pin-verified', memberUid: 'alex', sessionId: 's1', now: T0 }]);
    assert.deepEqual(currentActor(state), { memberUid: 'alex', level: 'pin' });
    ({ state, effects } = run([{ type: 'pin-used', now: T0 + 60_000 }, { type: 'input', now: T0 + 60_000 }, { type: 'tick', now: T0 + PIN_IDLE_MS + 1, busy: false }], state));
    assert.ok(state.pin, 'a gated use slides it');
    assert.deepEqual(effects, []);
    ({ state, effects } = run([{ type: 'input', now: T0 + 170_000 }, { type: 'tick', now: T0 + 60_000 + PIN_IDLE_MS, busy: false }], state));
    assert.equal(state.pin, null);
    assert.deepEqual(effects, ['end:s1']);
  });

  it('PIN expiry waits while busy', () => {
    let { state, effects } = run([{ type: 'pin-verified', memberUid: 'alex', sessionId: 's1', now: T0 }, { type: 'input', now: T0 + 110_000 }]);
    ({ state, effects } = run([{ type: 'tick', now: T0 + PIN_IDLE_MS + 1, busy: true }], state));
    assert.ok(state.pin);
    assert.deepEqual(effects, []);
    ({ state, effects } = run([{ type: 'tick', now: T0 + PIN_IDLE_MS + 2, busy: false }], state));
    assert.equal(state.pin, null);
    assert.deepEqual(effects, ['end:s1']);
  });

  it('Done ends the PIN session; a server pin_session_invalid only forgets it', () => {
    let { state, effects } = run([{ type: 'pin-verified', memberUid: 'alex', sessionId: 's1', now: T0 }, { type: 'done' }]);
    assert.equal(state.pin, null);
    assert.deepEqual(effects, ['end:s1']);
    ({ state, effects } = run([{ type: 'pin-verified', memberUid: 'alex', sessionId: 's2', now: T0 }, { type: 'pin-invalid' }], state));
    assert.equal(state.pin, null);
    assert.deepEqual(effects, []);
  });

  it('choosing someone else ends the previous PIN unlock; the same person keeps it', () => {
    let { state, effects } = run([{ type: 'pin-verified', memberUid: 'alex', sessionId: 's1', now: T0 }, { type: 'pick', memberUid: 'alex', now: T0 + 1 }]);
    assert.ok(state.pin);
    assert.deepEqual(effects, []);
    ({ state, effects } = run([{ type: 'pick', memberUid: 'mia', now: T0 + 2 }], state));
    assert.equal(state.pin, null);
    assert.deepEqual(effects, ['end:s1']);
    assert.deepEqual(currentActor(state), { memberUid: 'mia', level: 'face' });
  });

  it('idle return: after the home time without input, back to the start page with face and PIN cleared, once per idle period', () => {
    let { state, effects } = run([{ type: 'pick', memberUid: 'mia', now: T0 }, { type: 'pin-verified', memberUid: 'mia', sessionId: 's1', now: T0 }]);
    ({ state, effects } = run([{ type: 'tick', now: T0 + 119_999, busy: false }], state));
    assert.deepEqual(effects, []);
    ({ state, effects } = run([{ type: 'tick', now: T0 + 120_000, busy: false }], state));
    assert.deepEqual(effects, ['end:s1', 'go-start-page']);
    assert.equal(currentActor(state), null);
    ({ state, effects } = run([{ type: 'tick', now: T0 + 130_000, busy: false }], state));
    assert.deepEqual(effects, [], 'not again in the same idle period');
    ({ state, effects } = run([{ type: 'input', now: T0 + 140_000 }, { type: 'tick', now: T0 + 260_000, busy: false }], state));
    assert.deepEqual(effects, ['go-start-page'], 'input starts a new idle period');
  });

  it('idle return never interrupts a save, an Undo or unsaved input', () => {
    let { state, effects } = run([{ type: 'pick', memberUid: 'mia', now: T0 }, { type: 'tick', now: T0 + 500_000, busy: true }]);
    assert.deepEqual(effects, []);
    assert.equal(state.face?.memberUid, 'mia');
    ({ state, effects } = run([{ type: 'tick', now: T0 + 500_001, busy: false }], state));
    assert.deepEqual(effects, ['go-start-page']);
  });

  it('ambient after the ambient time; input wakes it and never acts', () => {
    let { state } = run([{ type: 'tick', now: T0 + 599_999, busy: false }]);
    assert.equal(state.ambient, false);
    ({ state } = run([{ type: 'tick', now: T0 + 600_000, busy: false }], state));
    assert.equal(state.ambient, true);
    const woken = run([{ type: 'input', now: T0 + 700_000 }], state);
    assert.equal(woken.state.ambient, false);
    assert.deepEqual(woken.effects, []);
    assert.equal(currentActor(woken.state), null);
  });

  it('ambient waits while busy', () => {
    const { state } = run([{ type: 'tick', now: T0 + 900_000, busy: true }]);
    assert.equal(state.ambient, false);
  });

  it('ambient is never sooner than the idle return', () => {
    const t = shellTimersFrom({ homeAfterSec: 300, ambientAfterSec: 60 });
    assert.equal(t.ambientAfterMs, 300_000);
  });

  it('nextShellDeadline names the earliest pending expiry', () => {
    const start = initialShellState(T0);
    assert.equal(nextShellDeadline(start, timers), T0 + 120_000);
    const withPin = run([{ type: 'pin-verified', memberUid: 'a', sessionId: 's', now: T0 + 50_000 }], start).state;
    assert.equal(nextShellDeadline(withPin, timers), T0 + 120_000);
    const returned = run([{ type: 'tick', now: T0 + 120_000, busy: false }], start).state;
    assert.equal(nextShellDeadline(returned, timers), T0 + 600_000);
    const ambient = run([{ type: 'tick', now: T0 + 600_000, busy: false }], start).state;
    assert.equal(nextShellDeadline(ambient, timers), null);
  });

  it('after revocation nothing changes any more', () => {
    const { state, effects } = run([{ type: 'pick', memberUid: 'mia', now: T0 }, { type: 'revoked' }, { type: 'pick', memberUid: 'sam', now: T0 + 1 }, { type: 'tick', now: T0 + 999_999, busy: false }]);
    assert.equal(state.revoked, true);
    assert.equal(currentActor(state), null);
    assert.deepEqual(effects, []);
    assert.equal(nextShellDeadline(state, timers), null);
  });
});

describe('start page and sections (14.5, D-T18, WT-11b)', () => {
  const all = defaultSections();
  const off = (key: keyof DeviceSections): DeviceSections => ({ ...all, [key]: false });

  it('reads paths into views and back', () => {
    assert.deepEqual(viewOfPath('/'), { kind: 'home' });
    assert.deepEqual(viewOfPath('/pets/maple?tab=feeding'), { kind: 'section', section: 'pets' });
    assert.deepEqual(viewOfPath('/chores?room=kitchen'), { kind: 'section', section: 'chores', roomId: 'kitchen' });
    assert.deepEqual(viewOfPath('/shopping?list=weekly'), { kind: 'section', section: 'shopping', listId: 'weekly' });
    assert.deepEqual(viewOfPath('/notifications'), { kind: 'notices' });
    for (const never of ['/profile', '/household?tab=devices', '/automation', '/library', '/setup', '/share']) assert.equal(viewOfPath(never), null, never);
    assert.equal(pathOfView({ kind: 'section', section: 'chores', roomId: 'a b' }), '/chores?room=a%20b');
  });

  it('the start page opens its section, or Home when the section is off or the target is gone', () => {
    assert.deepEqual(startView({ kind: 'pets' }, all), { view: { kind: 'section', section: 'pets' }, fallback: false });
    assert.deepEqual(startView({ kind: 'pets' }, off('pets')), { view: { kind: 'home' }, fallback: true });
    assert.deepEqual(startView({ kind: 'chores-room', roomId: 'r1' }, all, { roomIds: new Set(['r1']) }).view, { kind: 'section', section: 'chores', roomId: 'r1' });
    assert.deepEqual(startView({ kind: 'chores-room', roomId: 'gone' }, all, { roomIds: new Set(['r1']) }), { view: { kind: 'home' }, fallback: true });
    assert.deepEqual(startView({ kind: 'chores-room', roomId: 'r1' }, all).fallback, false, 'trusted until the rooms load');
    assert.deepEqual(startView({ kind: 'shopping-list', listId: 'gone' }, all, { listIds: new Set() }), { view: { kind: 'home' }, fallback: true });
    assert.deepEqual(startView({ kind: 'home' }, all), { view: { kind: 'home' }, fallback: false });
  });

  it('deep links into an off section or a never-on-tablet page land on the start page', () => {
    const settings = { sections: off('shopping'), startPage: { kind: 'pets' } as const };
    assert.deepEqual(resolveTabletPath('/shopping?list=x', settings), { view: { kind: 'section', section: 'pets' }, redirected: true });
    assert.deepEqual(resolveTabletPath('/profile', settings), { view: { kind: 'section', section: 'pets' }, redirected: true });
    assert.deepEqual(resolveTabletPath('/pets?feed=1', settings), { view: { kind: 'section', section: 'pets' }, redirected: false });
    assert.deepEqual(resolveTabletPath('/notifications', settings).redirected, false, 'household notices are always on');
    assert.deepEqual(resolveTabletPath('/chores?room=gone', { sections: all, startPage: { kind: 'home' } }, { roomIds: new Set(['r1']) }), { view: { kind: 'section', section: 'chores' }, redirected: true });
  });

  it('switched-off sections leave the rail and More', () => {
    const { rail, more } = tabletNavItems({ ...all, shopping: false, maintenance: false });
    assert.deepEqual(rail.map((item) => item.key), ['home', 'chores', 'pets', 'calendar']);
    assert.deepEqual(more.map((item) => item.key), ['notices']);
    assert.deepEqual(tabletNavItems(all).more.map((item) => item.key), ['maintenance', 'notices']);
  });
});

describe('household quiet hours (14.4, D-T1)', () => {
  const zone = 'America/Chicago';
  // 2026-11-14 is CST (UTC-6).
  const at = (local: string) => new Date(`2026-11-14T${local}:00-06:00`);

  it('validates and reads the setting', () => {
    assert.deepEqual(validateQuietHours(null), { ok: true, value: null });
    assert.deepEqual(validateQuietHours({ start: '22:00', end: '07:00' }), { ok: true, value: { start: '22:00', end: '07:00' } });
    assert.equal(validateQuietHours({ start: '22:00', end: '22:00' }).ok, false);
    assert.equal(validateQuietHours({ start: '7:00', end: '22:00' }).ok, false);
    assert.equal(validateQuietHours({ start: '24:00', end: '07:00' }).ok, false);
    assert.equal(validateQuietHours({ start: '22:00', end: '07:00', extra: 1 }).ok, false);
    assert.equal(validateQuietHours('22:00-07:00').ok, false);
    assert.equal(readQuietHours({ start: 'x', end: '07:00' }), null);
    assert.equal(readQuietHours(undefined), null);
    assert.equal(describeQuietHours({ start: '22:00', end: '07:00' }), '22:00 to 07:00');
    assert.equal(describeQuietHours(null), 'Off');
  });

  it('a range across midnight, start inside and end outside', () => {
    const quiet = { start: '22:00', end: '07:00' };
    assert.equal(isQuietAt(quiet, zone, at('21:59')), false);
    assert.equal(isQuietAt(quiet, zone, at('22:00')), true);
    assert.equal(isQuietAt(quiet, zone, at('23:59')), true);
    assert.equal(isQuietAt(quiet, zone, new Date('2026-11-15T00:30:00-06:00')), true);
    assert.equal(isQuietAt(quiet, zone, new Date('2026-11-15T06:59:00-06:00')), true);
    assert.equal(isQuietAt(quiet, zone, new Date('2026-11-15T07:00:00-06:00')), false);
  });

  it('a daytime range and no setting', () => {
    const nap = { start: '13:00', end: '15:00' };
    assert.equal(isQuietAt(nap, zone, at('12:59')), false);
    assert.equal(isQuietAt(nap, zone, at('14:00')), true);
    assert.equal(isQuietAt(nap, zone, at('15:00')), false);
    assert.equal(isQuietAt(null, zone, at('03:00')), false);
  });

  it('uses the household zone, never the device zone, and holds across DST', () => {
    const quiet = { start: '22:00', end: '07:00' };
    // 05:00 UTC is 23:00 in Chicago (CST) but 06:00 in London.
    const instant = new Date('2026-11-15T05:00:00Z');
    assert.equal(isQuietAt(quiet, 'America/Chicago', instant), true);
    assert.equal(isQuietAt({ start: '00:00', end: '05:00' }, 'Europe/London', instant), false);
    // DST end in Chicago (2026-11-01 02:00 CDT → 01:00 CST): 01:30 happens twice, both quiet.
    assert.equal(isQuietAt(quiet, 'America/Chicago', new Date('2026-11-01T06:30:00Z')), true);
    assert.equal(isQuietAt(quiet, 'America/Chicago', new Date('2026-11-01T07:30:00Z')), true);
    // DST start (2026-03-08): 22:30 local the evening before is quiet, 07:30 CDT is not.
    assert.equal(isQuietAt(quiet, 'America/Chicago', new Date('2026-03-08T04:30:00Z')), true);
    assert.equal(isQuietAt(quiet, 'America/Chicago', new Date('2026-03-08T12:30:00Z')), false);
  });

  it('an unknown zone falls back to the household default', () => {
    assert.equal(isQuietAt({ start: '22:00', end: '07:00' }, 'Not/AZone', new Date('2026-11-15T05:00:00Z')), true);
  });
});

describe('local quick add (JC-28)', () => {
  const pets = [{ id: 'maple', name: 'Maple' }, { id: 'pixel', name: 'Pixel' }];
  const chores = [{ id: 'c1', title: 'Take out trash' }, { id: 'c2', title: 'Water plants' }];

  it('pet names give feed intents, dose words give dose intents', () => {
    assert.deepEqual(matchLocalIntents('feed maple', { pets, chores, sections: defaultSections() }).map((i) => i.label), ['Feed Maple']);
    assert.deepEqual(matchLocalIntents('Maple meds', { pets, chores, sections: defaultSections() }).map((i) => i.capability), ['pets.dose.give']);
    assert.deepEqual(matchLocalIntents('pix', { pets, chores, sections: defaultSections() }).map((i) => i.label), ['Feed Pixel']);
  });

  it('chore titles give "mark done" intents', () => {
    const intents = matchLocalIntents('trash done', { pets, chores, sections: defaultSections() });
    assert.deepEqual(intents.map((i) => [i.capability, i.label]), [['chores.complete', 'Mark "Take out trash" done']]);
  });

  it('switched-off sections never match; empty text gives nothing', () => {
    assert.deepEqual(matchLocalIntents('feed maple', { pets, chores, sections: { ...defaultSections(), pets: false } }), []);
    assert.deepEqual(matchLocalIntents('water plants', { pets, chores, sections: { ...defaultSections(), chores: false } }), []);
    assert.deepEqual(matchLocalIntents('   ', { pets, chores, sections: defaultSections() }), []);
  });
});

describe('"Who\'s here?" roster (WT-8b, WT-21a)', () => {
  it('active owners, admins, members and children, kid profiles included; never guests, pending, removed or devices', () => {
    const roster = rosterFrom([
      { id: 'o', data: { role: 'owner', status: 'active', displayName: 'Zoe Owner' } },
      { id: 'kid_1', data: { role: 'child', status: 'active', kind: 'identity', displayName: 'Mia' } },
      { id: 'c', data: { role: 'child', status: 'active', displayName: 'Ava' } },
      { id: 'a', data: { role: 'admin', status: 'active', displayName: 'Ada' } },
      { id: 'g', data: { role: 'guest', status: 'active', displayName: 'Gus' } },
      { id: 'p', data: { role: 'newuser', status: 'pending', displayName: 'Pat' } },
      { id: 'r', data: { role: 'member', status: 'removed', displayName: 'Rae' } },
      { id: 'd', data: { role: 'member', status: 'deleting', displayName: 'Dee' } },
      { id: 'device_x', data: { role: 'member', status: 'active', displayName: 'Tablet' } },
      { id: 'e', data: { role: 'member', status: 'active', displayName: 'sam@example.com' } },
    ]);
    assert.deepEqual(roster.map((p) => p.uid), ['a', 'e', 'o', 'c', 'kid_1']);
    assert.equal(roster.find((p) => p.uid === 'e')?.name, 'Someone', 'an email is never shown');
    assert.equal(roster.find((p) => p.uid === 'kid_1')?.kind, 'identity');
    assert.equal(initialsOf('Zoe Owner'), 'ZO');
  });
});

describe('idle reload for a new build (WT-14l, HP-17e)', () => {
  const base = { pageBuildId: '20261114T100000000Z', workerBuildId: '20261114T120000000Z', reloadedFor: null, busy: false, resting: true, online: true, recentCrashes: 0 };
  it('reloads only when idle, resting and online', () => {
    assert.equal(decideTabletReload(base), 'reload');
    assert.equal(decideTabletReload({ ...base, busy: true }), 'wait');
    assert.equal(decideTabletReload({ ...base, resting: false }), 'wait');
    assert.equal(decideTabletReload({ ...base, online: false }), 'wait');
  });
  it('never for an older or same build, twice for one build, or after repeated crashes', () => {
    assert.equal(decideTabletReload({ ...base, workerBuildId: base.pageBuildId }), 'none');
    assert.equal(decideTabletReload({ ...base, reloadedFor: base.workerBuildId }), 'none');
    assert.equal(decideTabletReload({ ...base, recentCrashes: 2 }), 'none');
    assert.equal(decideTabletReload({ ...base, pageBuildId: 'dev' }), 'none');
  });
});

describe('keep-awake (WT-14d, HP-17a)', () => {
  const fakeApi = () => {
    const held: Array<WakeLockSentinelLike & { released: boolean }> = [];
    return {
      held,
      api: {
        request: async () => {
          const sentinel = { released: false, release: async () => { sentinel.released = true; } };
          held.push(sentinel);
          return sentinel;
        },
      },
    };
  };

  it('holds the lock while visible and wanted, re-requests on visibility', async () => {
    const { api, held } = fakeApi();
    const listeners = new Set<() => void>();
    const page = { visibilityState: 'visible', addEventListener: (_: 'visibilitychange', l: () => void) => listeners.add(l), removeEventListener: (_: 'visibilitychange', l: () => void) => listeners.delete(l) };
    const watch = watchKeepAwake({ api, page, wanted: () => true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(held.length, 1);
    page.visibilityState = 'hidden';
    held[0].released = true; // the browser releases on hide
    listeners.forEach((l) => l());
    page.visibilityState = 'visible';
    listeners.forEach((l) => l());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(held.length, 2, 'requested again when shown');
    watch.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(held[1].released, true);
    assert.equal(listeners.size, 0);
  });

  it('the shopping list keeps using the same controller', () => {
    assert.equal(typeof createWakeLockController(null).set, 'function');
  });
});

describe('household brief on the resting view (HP-3b, HP-21, WT-5a)', () => {
  it('household totals, no name, nothing "yours"', async () => {
    const { buildMorningBrief } = await import('../../src/lib/dashboard/brief');
    const chores = { mineOpen: 2, mineOverdue: 1, mineDueToday: 2, todayTotal: 5, todayDone: 1, overdueTotal: 3, rooms: [], nextUp: [], mineNext: [] };
    const household = buildMorningBrief({ chores }, { greeting: 'Good morning', name: 'Alex', household: true });
    assert.equal(household.text, 'Good morning. 4 household chores today (3 overdue).');
    const personal = buildMorningBrief({ chores }, { greeting: 'Good morning', name: 'Alex' });
    assert.match(personal.text, /^Good morning, Alex\. 2 chores today \(1 overdue\)\./);
    const quiet = buildMorningBrief({ chores: { ...chores, mineDueToday: 0, mineOverdue: 0, todayTotal: 0, todayDone: 0, overdueTotal: 0 } }, { greeting: 'Hello', name: 'Alex', household: true });
    assert.equal(quiet.text, 'Hello. Nothing needs doing right now. Enjoy the quiet.');
  });
});
