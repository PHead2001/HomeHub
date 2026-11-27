import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, test } from 'node:test';
import { GET } from '../../src/app/api/sw/route';
import { pushOpenLink, safePushLink } from '../../functions/src/shared/push-link';
import { pushActionsFor } from '../../functions/src/shared/push-actions';
import { openedNotificationId, withoutOpenedNotification } from '../../src/lib/push-open';
import { isIOSDevice, pushCardState, pushSupport, pushTokenMissing } from '../../src/lib/push-status';
import { PUSH_OFF_KEY, pushSignInAction, readPushOff, readPushOffPending, writePushOff, writePushOffPending } from '../../src/lib/push-tokens';

// Section 7 "make push trustworthy": NO-5 (real status, token re-check), NO-9 / SL-16
// (reuse the open window, mark read on landing), NO-17 (iPhone guidance), NO-27 (badge).

type Client = { url: string; focus: () => Promise<Client>; navigate?: (url: string) => Promise<Client | null> };

async function loadWorker(clientsList: Client[] = [], trayCount = 0) {
  const script = await (await GET()).text();
  const listeners: Record<string, (event: unknown) => unknown> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const badges: Array<number | 'clear'> = [];
  let background: ((payload: unknown) => unknown) | undefined;
  const scope: Record<string, unknown> = {
    location: { origin: 'https://homehub.test' },
    addEventListener: (type: string, listener: (event: unknown) => unknown) => { listeners[type] = listener; },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); },
      getNotifications: async () => Array.from({ length: trayCount + shown.length }),
    },
    navigator: { setAppBadge: async (n: number) => { badges.push(n); }, clearAppBadge: async () => { badges.push('clear'); } },
    URL,
    console,
    importScripts: () => {
      scope.firebase = {
        apps: [], initializeApp: () => undefined,
        messaging: () => ({ onBackgroundMessage: (handler: (payload: unknown) => unknown) => { background = handler; } }),
      };
    },
    clients: { matchAll: async () => clientsList, openWindow: async (url: string) => { opened.push(url); } },
  };
  scope.self = scope;
  vm.runInContext(script, vm.createContext(scope));
  const click = async (link: string) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.notificationclick({ notification: { data: { link }, close: () => undefined }, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  };
  const close = async () => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.notificationclose({ notification: {}, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  };
  const clickAction = async (data: unknown, action: string) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.notificationclick({ action, notification: { data, close: () => undefined }, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
  };
  return { shown, opened, badges, click, clickAction, close, background: (payload: unknown) => background!(payload) };
}

describe('NO-9: the opened notification is marked read', () => {
  test('the worker adds the notification ID to the link', async () => {
    const worker = await loadWorker();
    await worker.background({ notification: { title: 'Filter' }, data: { tag: 'maint-abc_1' }, fcmOptions: { link: '/maintenance?tab=reminders#x' } });
    assert.equal((worker.shown[0].options.data as { link: string }).link, '/maintenance?tab=reminders&n=maint-abc_1#x');
  });

  test('pushOpenLink adds only plain IDs and stays a safe link', () => {
    assert.equal(pushOpenLink('/chores', 'o1-overdue'), '/chores?n=o1-overdue');
    assert.equal(pushOpenLink('/chores?due=overdue', 'o1-overdue'), '/chores?due=overdue&n=o1-overdue');
    assert.equal(pushOpenLink('/chores', '../evil'), '/chores');
    assert.equal(pushOpenLink('/chores', 'a&b=c'), '/chores');
    assert.equal(pushOpenLink('/chores', undefined), '/chores');
    assert.equal(safePushLink(pushOpenLink('/', 'n1')), '/?n=n1');
  });

  test('the landing page reads the ID and removes only that parameter', () => {
    assert.equal(openedNotificationId('?tab=medication&n=pet_med-1'), 'pet_med-1');
    assert.equal(openedNotificationId('?n=%2F%2Fevil'), null);
    assert.equal(openedNotificationId('?tab=x'), null);
    assert.equal(withoutOpenedNotification('https://h.test/pets/p1?tab=medication&n=x1&dose=c#top'), '/pets/p1?tab=medication&dose=c#top');
    assert.equal(withoutOpenedNotification('https://h.test/chores?n=x1'), '/chores');
  });
});

describe('NO-9 / SL-16: a tap reuses the open window', () => {
  const windowAt = (url: string, navigate?: Client['navigate']) => {
    const calls: string[] = [];
    const client: Client = {
      url,
      focus: async () => { calls.push('focus'); return client; },
      navigate: navigate ?? (async (to: string) => { calls.push(`navigate ${to}`); return client; }),
    };
    return { client, calls };
  };

  test('an open HomeHub window is focused and sent to the link, whatever its path', async () => {
    const open = windowAt('https://homehub.test/shopping?list=a');
    const worker = await loadWorker([open.client]);
    await worker.click('/chores?due=overdue&n=o1-overdue');
    assert.deepEqual(open.calls, ['focus', 'navigate /chores?due=overdue&n=o1-overdue']);
    assert.deepEqual(worker.opened, [], 'no second window');
  });

  test('a window that cannot be navigated (uncontrolled) falls back to a new window', async () => {
    const open = windowAt('https://homehub.test/', async () => { throw new TypeError('not controlled'); });
    const worker = await loadWorker([open.client]);
    await worker.click('/pets');
    assert.deepEqual(worker.opened, ['/pets']);
  });

  test('another origin is never reused; no window opens a new one', async () => {
    const other = windowAt('https://elsewhere.test/');
    const worker = await loadWorker([other.client]);
    await worker.click('/');
    assert.deepEqual(other.calls, []);
    assert.deepEqual(worker.opened, ['/']);
  });
});

describe('NO-27: the app badge while closed', () => {
  test('a background push sets the badge to the notifications in the tray', async () => {
    const worker = await loadWorker([], 2);
    await worker.background({ notification: { title: 'x' }, data: { tag: 't' }, fcmOptions: { link: '/' } });
    assert.deepEqual(worker.badges, [3]);
  });

  test('dismissing one from the tray refreshes the badge while the app is closed', async () => {
    const worker = await loadWorker([], 1);
    await worker.close();
    assert.deepEqual(worker.badges, [1]);
    const empty = await loadWorker([], 0);
    await empty.close();
    assert.deepEqual(empty.badges, ['clear']);
  });

  test('opening the last one clears it', async () => {
    const worker = await loadWorker([], 0);
    await worker.click('/');
    assert.deepEqual(worker.badges, ['clear']);
  });
});

describe('NO-17: iPhone guidance', () => {
  test('iPhone and iPad (also iPadOS posing as a Mac) are recognised', () => {
    assert.equal(isIOSDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), true);
    assert.equal(isIOSDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), true);
    assert.equal(isIOSDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
    assert.equal(isIOSDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), false);
  });

  test('a Safari tab on iPhone gets the Home Screen steps, not "unsupported"', () => {
    const none = { hasNotification: false, hasServiceWorker: true, hasPushManager: false };
    assert.equal(pushSupport({ ...none, isIOS: true, standalone: false }), 'ios-install');
    assert.equal(pushSupport({ ...none, isIOS: true, standalone: true }), 'unsupported');
    assert.equal(pushSupport({ ...none, isIOS: false, standalone: false }), 'unsupported');
    assert.equal(pushSupport({ hasNotification: true, hasServiceWorker: true, hasPushManager: true, isIOS: true, standalone: true }), 'supported');
  });
});

describe('NO-5: a real status, and the token checked on every load', () => {
  const state = (fields: Partial<Parameters<typeof pushCardState>[0]>) =>
    pushCardState({ support: 'supported', permission: 'granted', optedOut: false, registered: true, ...fields });

  test('permission alone no longer means "active"', () => {
    assert.equal(state({}), 'registered');
    assert.equal(state({ registered: false }), 'reconnect');
    assert.equal(state({ registered: null }), 'checking');
    assert.equal(state({ optedOut: true }), 'off');
    assert.equal(state({ permission: 'default' }), 'ask');
    assert.equal(state({ permission: 'denied' }), 'denied');
    assert.equal(state({ support: 'ios-install', permission: 'unsupported' }), 'ios-install');
  });

  test('a token the server removed is missing', () => {
    assert.equal(pushTokenMissing(['a', 'b'], 'b'), false);
    assert.equal(pushTokenMissing(['a'], 'b'), true);
    assert.equal(pushTokenMissing(undefined, 'b'), true);
    assert.equal(pushTokenMissing(['a'], null), true);
  });

  test('"Turn off on this device" stops the silent registration for that account only', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    writePushOff(storage, 'sam@example.test', true);
    assert.equal(readPushOff(storage, 'sam@example.test'), true);
    assert.equal(readPushOff(storage, 'alex@example.test'), false);
    const input = { permission: 'granted' as const, email: 'sam@example.test', record: null, now: 0 };
    assert.equal(pushSignInAction({ ...input, optedOut: true }), 'none');
    assert.equal(pushSignInAction(input), 'register');
    writePushOff(storage, 'sam@example.test', false);
    assert.equal(readPushOff(storage, 'sam@example.test'), false);
  });

  test('on a shared browser each account keeps its own opt-out', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    writePushOff(storage, 'a@example.test', true);
    writePushOff(storage, 'b@example.test', true);
    assert.equal(readPushOff(storage, 'a@example.test'), true, "B turning push off keeps A's choice");
    writePushOff(storage, 'b@example.test', false);
    assert.equal(readPushOff(storage, 'a@example.test'), true, "B turning push on again keeps A's choice");
    assert.equal(readPushOff(storage, 'b@example.test'), false);
    // An older build stored one email as plain text.
    store.set(PUSH_OFF_KEY, 'old@example.test');
    assert.equal(readPushOff(storage, 'old@example.test'), true);
    writePushOff(storage, 'new@example.test', true);
    assert.equal(readPushOff(storage, 'old@example.test'), true);
  });

  test('a "Turn off" that could not finish is retried, never left as registered', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    writePushOff(storage, 'sam@example.test', true);
    writePushOffPending(storage, 'sam@example.test', true);
    const base = { email: 'sam@example.test', record: { v: 1 as const, token: 't', email: 'sam@example.test', at: 0 }, now: 0, optedOut: true };
    assert.equal(pushSignInAction({ ...base, permission: 'granted', cleanupPending: readPushOffPending(storage, 'sam@example.test') }), 'cleanup');
    assert.equal(pushSignInAction({ ...base, permission: 'default', cleanupPending: true }), 'cleanup', 'whatever the permission');
    writePushOffPending(storage, 'sam@example.test', false);
    assert.equal(pushSignInAction({ ...base, permission: 'granted', cleanupPending: readPushOffPending(storage, 'sam@example.test') }), 'none');
    assert.equal(readPushOffPending(storage, 'alex@example.test'), false);
  });
});

describe('NO-23: action buttons open in-app links only', () => {
  test('which notifications get which button', () => {
    assert.deepEqual(pushActionsFor({ sourceType: 'pet_medication', deepLink: '/pets/maple?tab=medication&dose=c1' }),
      [{ action: 'dose', title: 'Give dose', link: '/pets/maple?tab=medication&dose=c1' }]);
    assert.deepEqual(pushActionsFor({ sourceType: 'pet_medication', deepLink: '/pets/maple?tab=medication' }), [], 'a legacy medication has no dose dialog to open');
    assert.equal(pushActionsFor({ sourceType: 'maintenance_asset_schedule', deepLink: '/maintenance?asset=a&schedule=s' })[0].title, 'Done or snooze');
    assert.equal(pushActionsFor({ sourceType: 'chore-reminder', sourceId: 'overdue', deepLink: '/chores?due=overdue' })[0].action, 'overdue');
    assert.deepEqual(pushActionsFor({ sourceType: 'chore-reminder', sourceId: 'reminder-2026-11-11', deepLink: '/chores' }), []);
    assert.deepEqual(pushActionsFor({ sourceType: 'maintenance_asset_schedule', deepLink: '//evil.example' }), [], 'no safe link, no button');
  });

  test('the worker shows the buttons and opens the chosen link with the notification ID', async () => {
    const worker = await loadWorker();
    await worker.background({
      notification: { title: "Maple's dose" }, data: { tag: 'pet-1', actions: JSON.stringify([{ action: 'dose', title: 'Give dose', link: '/pets/maple?tab=medication&dose=c1' }]) },
      fcmOptions: { link: '/pets/maple?tab=medication&dose=c1' },
    });
    const { options } = worker.shown[0];
    // Arrays from the worker's own realm: compare by value.
    assert.deepEqual(JSON.parse(JSON.stringify(options.actions)), [{ action: 'dose', title: 'Give dose' }]);
    await worker.clickAction(options.data, 'dose');
    assert.deepEqual(worker.opened, ['/pets/maple?tab=medication&dose=c1&n=pet-1']);
  });

  test('hostile actions are dropped or reduced to the home page', async () => {
    const worker = await loadWorker();
    await worker.background({
      notification: { title: 'x' },
      data: { tag: 't', actions: JSON.stringify([
        { action: 'BAD ID', title: 'x', link: '/' },
        { action: 'go', title: 'y'.repeat(40), link: '/' },
        { action: 'open', title: 'Open', link: 'https://evil.example' },
        { action: 'more', title: 'More', link: '/chores' },
        { action: 'third', title: 'Third', link: '/pets' },
      ]) },
      fcmOptions: { link: '/' },
    });
    const { options } = worker.shown[0];
    assert.deepEqual(JSON.parse(JSON.stringify((options.actions as Array<{ action: string }>).map((a) => a.action))), ['open', 'more']);
    await worker.clickAction(options.data, 'open');
    await worker.clickAction(options.data, 'unknown');
    assert.deepEqual(worker.opened, ['/?n=t', '/?n=t']);
    const broken = await loadWorker();
    await broken.background({ notification: { title: 'x' }, data: { tag: 't', actions: '{not json' }, fcmOptions: { link: '/' } });
    assert.equal('actions' in broken.shown[0].options, false);
  });
});
