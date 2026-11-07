import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import {
  SWIPE_DISMISS_DISTANCE,
  SWIPE_OUT_MS,
  isSwipePointer,
  swipeDismisses,
  swipeHintOpacity,
  swipeOffset,
} from '../../src/app/notifications/swipe-dismiss';
import { GET } from '../../src/app/api/sw/route';

describe('swipe to dismiss', () => {
  test('only touch, and pens on coarse-pointer devices, can swipe', () => {
    assert.equal(isSwipePointer('touch', false), true);
    assert.equal(isSwipePointer('touch', true), true);
    assert.equal(isSwipePointer('pen', true), true);
    assert.equal(isSwipePointer('pen', false), false);
    assert.equal(isSwipePointer('mouse', true), false);
    assert.equal(isSwipePointer('mouse', false), false);
  });

  test('left drags follow the finger; right drags resist', () => {
    assert.equal(swipeOffset(-110), -110);
    assert.equal(swipeOffset(20), 4);
    assert.equal(swipeOffset(400), 10);
  });

  test('releasing past the threshold dismisses; short drags spring back', () => {
    assert.equal(swipeDismisses(-SWIPE_DISMISS_DISTANCE), true);
    assert.equal(swipeDismisses(-SWIPE_DISMISS_DISTANCE + 1), false);
    assert.equal(swipeDismisses(10), false);
  });

  test('the dismiss hint fades in with the drag', () => {
    assert.equal(swipeHintOpacity(0), 0);
    assert.equal(swipeHintOpacity(10), 0);
    assert.equal(swipeHintOpacity(-SWIPE_DISMISS_DISTANCE / 2), 0.5);
    assert.equal(swipeHintOpacity(-500), 1);
  });

  test('the slide-out stays within the UI transition budget', () => {
    assert.ok(SWIPE_OUT_MS <= 250);
  });
});

// Runs the real worker script with a stand-in Messaging SDK and checks what it shows.
async function loadWorker() {
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'homehub-test.firebasestorage.app';
  const script = await (await GET()).text();
  const listeners: Record<string, (event: unknown) => unknown> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  let backgroundHandler: ((payload: unknown) => unknown) | undefined;
  // The worker's global scope: `self` is the global object itself.
  const scope: Record<string, unknown> = {
    location: { origin: 'https://homehub.test' },
    addEventListener: (type: string, listener: (event: unknown) => unknown) => { listeners[type] = listener; },
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); } },
    URL,
    console,
    importScripts: () => {
      scope.firebase = {
        apps: [],
        initializeApp: () => undefined,
        messaging: () => ({ onBackgroundMessage: (handler: (payload: unknown) => unknown) => { backgroundHandler = handler; } }),
      };
    },
    clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); } },
  };
  scope.self = scope;
  vm.runInContext(script, vm.createContext(scope));
  return { listeners, shown, opened, background: (payload: unknown) => backgroundHandler!(payload) };
}

describe('service worker push display', () => {
  const PET = 'https://firebasestorage.googleapis.com/v0/b/homehub-test.firebasestorage.app/o/households%2Fhouse-a%2Fpets%2Fmaple.jpg?alt=media&token=t';

  test('uses the payload icon, badge and image, and the server tag', async () => {
    const worker = await loadWorker();
    await worker.background({
      notification: { title: 'Feed Maple', body: 'Dinner time', icon: '/icons/icon-192.png', image: PET },
      data: { tag: 'n1', badge: '/icons/badge-96.png' },
      fcmOptions: { link: '/pets' },
    });
    assert.equal(worker.shown.length, 1);
    const { title, options } = worker.shown[0];
    assert.equal(title, 'Feed Maple');
    assert.equal(options.icon, '/icons/icon-192.png');
    assert.equal(options.badge, '/icons/badge-96.png');
    assert.equal(options.image, PET);
    assert.equal(options.tag, 'n1');
    assert.equal((options.data as { link: string }).link, '/pets');
  });

  test('drops foreign pictures and unsafe links', async () => {
    const worker = await loadWorker();
    await worker.background({
      notification: { title: 'x', icon: 'https://evil.example/i.png', image: 'https://evil.example/p.png' },
      data: { badge: 'https://evil.example/b.png' },
      fcmOptions: { link: '//evil.example' },
    });
    const { options } = worker.shown[0];
    assert.equal(options.icon, '/icons/icon-192.png');
    assert.equal(options.badge, '/icons/badge-96.png');
    assert.equal('image' in options, false);
    assert.equal((options.data as { link: string }).link, '/');
  });

  test('notification clicks open only in-app paths', async () => {
    const worker = await loadWorker();
    const click = async (link: unknown) => {
      let done: Promise<unknown> = Promise.resolve();
      worker.listeners.notificationclick({ notification: { data: { link }, close: () => undefined }, waitUntil: (p: Promise<unknown>) => { done = p; } });
      await done;
    };
    await click('/chores?tab=mine');
    await click('https://evil.example');
    await click('/\\evil.example');
    assert.deepEqual(worker.opened, ['/chores?tab=mine', '/', '/']);
  });
});

describe('push artwork', () => {
  test('the badge exists and is a 96 px PNG', () => {
    const file = 'public/icons/badge-96.png';
    assert.ok(existsSync(file));
    const png = readFileSync(file);
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), 96);
    assert.equal(png.readUInt32BE(20), 96);
    // RGBA, so the glyph sits on transparency (Android uses only the alpha).
    assert.equal(png[25], 6);
  });
});
