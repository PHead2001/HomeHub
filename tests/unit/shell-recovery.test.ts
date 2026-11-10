import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { isShellBusy, markBusy, resetShellBusyForTests, shellBusyReasons, subscribeShellBusy, whileBusy } from '../../src/lib/shell/busy';
import {
  CRASH_HISTORY_KEY,
  CRASH_WINDOW_MS,
  decideCrashRecovery,
  isStaleBuildError,
  parseCrashHistory,
  recordCrash,
  storeCrash,
} from '../../src/lib/shell/crash-guard';
import {
  BUILD_MESSAGE,
  buildIdFromMessage,
  decideUpdatePrompt,
  formatBuildId,
  isBuildId,
  shouldCheckOnVisible,
  UPDATE_CHECK_INTERVAL_MS,
  VISIBLE_RECHECK_MIN_MS,
} from '../../src/lib/shell/update-check';
import { capToasts, TOAST_LIMIT, toastsHoldShell } from '../../src/lib/shell/toast-queue';
import { UNDO_WINDOW_MS } from '../../src/lib/undo-window';
import { DISMISS_UNDO_MS } from '../../src/app/notifications/undo-batch';

afterEach(() => resetShellBusyForTests());

describe('shell busy state', () => {
  test('marks count independently and release is idempotent', () => {
    assert.equal(isShellBusy(), false);
    const releaseSave = markBusy('save');
    const releaseUndo = markBusy('undo');
    assert.deepEqual(shellBusyReasons().sort(), ['save', 'undo']);
    releaseSave();
    releaseSave();
    assert.equal(isShellBusy(), true, 'a second release of the same mark frees nothing else');
    releaseUndo();
    assert.equal(isShellBusy(), false);
  });

  test('listeners hear only busy and idle transitions', () => {
    const heard: boolean[] = [];
    const stop = subscribeShellBusy((busy) => heard.push(busy));
    const a = markBusy('save');
    const b = markBusy('unsaved-input');
    a();
    b();
    stop();
    markBusy('save');
    assert.deepEqual(heard, [true, false]);
  });

  test('whileBusy holds the mark until the work settles, also on failure', async () => {
    let finish!: () => void;
    const pending = whileBusy('save', new Promise<void>((resolve) => { finish = resolve; }));
    assert.equal(isShellBusy(), true);
    finish();
    await pending;
    assert.equal(isShellBusy(), false);
    await assert.rejects(whileBusy('save', async () => { throw new Error('nope'); }));
    assert.equal(isShellBusy(), false);
  });
});

describe('crash-loop guard', () => {
  const now = 1_000_000_000;
  const chunk = Object.assign(new Error('Loading chunk 123 failed.'), { name: 'ChunkLoadError' });
  const base = { now, busy: false, online: true, recoverable: true, persisted: true };

  test('recognises stale-build chunk failures only', () => {
    assert.equal(isStaleBuildError(chunk), true);
    assert.equal(isStaleBuildError(new TypeError('Failed to fetch dynamically imported module: /_next/static/x.js')), true);
    assert.equal(isStaleBuildError(new Error('Cannot read properties of undefined')), false);
    assert.equal(isStaleBuildError('Loading chunk 1 failed'), false, 'a thrown string is not an Error');
    assert.equal(isStaleBuildError(null), false);
  });

  test('the first stale-build crash reloads once; the second within ten minutes stays manual', () => {
    const first = recordCrash([], now);
    assert.deepEqual(decideCrashRecovery({ ...base, history: first }), { action: 'auto-reload' });
    const second = recordCrash(first, now + 60_000);
    assert.deepEqual(decideCrashRecovery({ ...base, now: now + 60_000, history: second }), { action: 'manual', reason: 'repeated' });
  });

  test('crashes older than the window are forgotten', () => {
    const history = recordCrash([now - CRASH_WINDOW_MS - 1, now - CRASH_WINDOW_MS], now);
    assert.deepEqual(history, [now]);
    assert.equal(decideCrashRecovery({ ...base, history }).action, 'auto-reload');
  });

  test('never reloads while busy, offline, without stored history or for other errors', () => {
    const history = recordCrash([], now);
    assert.deepEqual(decideCrashRecovery({ ...base, history, busy: true }), { action: 'manual', reason: 'busy' });
    assert.deepEqual(decideCrashRecovery({ ...base, history, online: false }), { action: 'manual', reason: 'offline' });
    assert.deepEqual(decideCrashRecovery({ ...base, history, persisted: false }), { action: 'manual', reason: 'no-history' });
    assert.deepEqual(decideCrashRecovery({ ...base, history, recoverable: false }), { action: 'manual', reason: 'not-recoverable' });
  });

  test('storage: malformed history is empty, blocked storage is not persisted', () => {
    assert.deepEqual(parseCrashHistory('{"no":1}'), []);
    assert.deepEqual(parseCrashHistory('[1,"x",2]'), [1, 2]);
    assert.deepEqual(parseCrashHistory('not json'), []);
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    assert.deepEqual(storeCrash(storage, now), { history: [now], persisted: true });
    assert.deepEqual(storeCrash(storage, now + 5), { history: [now, now + 5], persisted: true });
    assert.equal(store.get(CRASH_HISTORY_KEY), JSON.stringify([now, now + 5]));
    const blocked = {
      getItem: (): string | null => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    assert.deepEqual(storeCrash(blocked, now), { history: [now], persisted: false });
    assert.deepEqual(storeCrash(null, now), { history: [now], persisted: false });
  });
});

describe('update detection', () => {
  const older = formatBuildId(new Date('2026-11-01T10:00:00.000Z'));
  const newer = formatBuildId(new Date('2026-11-09T08:30:00.123Z'));

  test('build ids are fixed-width timestamps that sort by time', () => {
    assert.equal(newer, '20261109T083000123Z');
    assert.equal(isBuildId(newer), true);
    assert.equal(isBuildId('dev'), false);
    assert.ok(older < newer);
  });

  test('offers Reload only for a strictly newer worker build, once per build', () => {
    const input = { pageBuildId: older, workerBuildId: newer, promptedBuildId: null, busy: false };
    assert.equal(decideUpdatePrompt(input), 'prompt');
    assert.equal(decideUpdatePrompt({ ...input, workerBuildId: older }), 'none', 'same build');
    assert.equal(decideUpdatePrompt({ ...input, pageBuildId: newer, workerBuildId: older }), 'none', 'the page is newer than the worker');
    assert.equal(decideUpdatePrompt({ ...input, promptedBuildId: newer }), 'none', 'already offered in this tab');
    assert.equal(decideUpdatePrompt({ ...input, pageBuildId: undefined }), 'none', 'development: no build id');
    assert.equal(decideUpdatePrompt({ ...input, workerBuildId: 'garbage' }), 'none');
  });

  test('waits while the shell is busy (an Undo, a save or unsaved input)', () => {
    assert.equal(decideUpdatePrompt({ pageBuildId: older, workerBuildId: newer, promptedBuildId: older, busy: true }), 'wait');
  });

  test('reads only build announcements from the worker', () => {
    assert.equal(buildIdFromMessage({ type: BUILD_MESSAGE, buildId: newer }), newer);
    assert.equal(buildIdFromMessage({ type: 'other', buildId: newer }), null);
    assert.equal(buildIdFromMessage({ type: BUILD_MESSAGE, buildId: 42 }), null);
    assert.equal(buildIdFromMessage(null), null);
  });

  test('checks every 30-60 minutes and on return to the tab at most every few minutes', () => {
    assert.ok(UPDATE_CHECK_INTERVAL_MS >= 30 * 60_000 && UPDATE_CHECK_INTERVAL_MS <= 60 * 60_000);
    assert.equal(shouldCheckOnVisible(0, VISIBLE_RECHECK_MIN_MS - 1), false);
    assert.equal(shouldCheckOnVisible(0, VISIBLE_RECHECK_MIN_MS), true);
  });
});

describe('toast queue and the Undo window', () => {
  const t = (id: string, extra: { open?: boolean; holdsAction?: boolean } = {}) => ({ id, open: true, ...extra });

  test('shows up to three toasts, newest first', () => {
    assert.equal(TOAST_LIMIT, 3);
    assert.deepEqual(capToasts([t('4'), t('3'), t('2'), t('1')]).map((toast) => toast.id), ['4', '3', '2']);
  });

  test('a new toast never displaces an open Undo while a plain toast can go', () => {
    const kept = capToasts([t('error'), t('push'), t('push2'), t('undo', { holdsAction: true })]);
    assert.deepEqual(kept.map((toast) => toast.id), ['error', 'push', 'undo']);
  });

  test('closed toasts go first; with only Undo toasts open the oldest goes', () => {
    const mixed = [t('new'), t('u1', { holdsAction: true }), t('gone', { open: false }), t('u0', { holdsAction: true })];
    assert.deepEqual(capToasts(mixed).map((toast) => toast.id), ['new', 'u1', 'u0']);
    const undos = ['u4', 'u3', 'u2', 'u1'].map((id) => t(id, { holdsAction: true }));
    assert.deepEqual(capToasts(undos).map((toast) => toast.id), ['u4', 'u3', 'u2']);
  });

  test('an open Undo toast keeps the shell busy; a closed one does not', () => {
    assert.equal(toastsHoldShell([t('a'), t('u', { holdsAction: true })]), true);
    assert.equal(toastsHoldShell([t('u', { holdsAction: true, open: false })]), false);
  });

  test('one 10-second Undo window, also for notification dismissals', () => {
    assert.equal(UNDO_WINDOW_MS, 10_000);
    assert.equal(DISMISS_UNDO_MS, UNDO_WINDOW_MS);
  });
});
