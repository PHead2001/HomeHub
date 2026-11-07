
import { NextResponse } from 'next/server';

// HomeHub's single service worker, served from /api/sw with a root scope.
//
// One origin can have only one service worker per scope, so this worker serves
// two jobs:
//   1. Push: Firebase Cloud Messaging background messages and notification clicks.
//   2. App shell: offline navigation for the shopping lists, cached static assets,
//      and a friendly offline page for routes that were never cached.
//
// Registration: PushNotificationManager registers it on every production page
// load (after the window load event). PushNotificationSettings registers the
// same URL and scope when a member enables push, which returns the same
// registration, so FCM tokens keep using this worker.
//
// Bump SHELL_VERSION whenever the caching logic or precache list changes; the
// activate step deletes caches from older versions.
const SHELL_VERSION = 'v1';

export async function GET() {
  const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };

  const script = `
    // ---- Push (Firebase Cloud Messaging) ------------------------------------
    // Push payload checks. Links open only as in-app paths (the same rule as
    // the server's safeDeepLink). Icons and badges come only from this
    // origin's /icons/ folder. Rich images must be https download URLs for a
    // household object in this project's Storage bucket, or an image path on
    // this origin; the server has already limited them to the right household.
    const PUSH_STORAGE_PREFIX = 'https://firebasestorage.googleapis.com/v0/b/' +
      encodeURIComponent(${JSON.stringify(firebaseConfig.storageBucket || '')}) + '/o/households%2F';
    const safePushLink = (link) => {
      if (typeof link !== 'string') return '/';
      const trimmed = link.trim();
      return /^\\/(?![\\/\\\\])/.test(trimmed) && trimmed.length <= 300 ? trimmed : '/';
    };
    const safePushAsset = (value) => {
      if (typeof value !== 'string') return null;
      try {
        const url = new URL(value, self.location.origin);
        if (url.origin !== self.location.origin || !url.pathname.startsWith('/icons/')) return null;
        return url.pathname.includes('..') ? null : url.pathname;
      } catch (error) {
        return null;
      }
    };
    const safePushImage = (value) => {
      if (typeof value !== 'string' || value.length > 2048) return null;
      try {
        const url = new URL(value, self.location.origin);
        if (url.origin === self.location.origin) {
          return /\\.(png|jpe?g|webp|gif)$/i.test(url.pathname) && !url.pathname.includes('..') && !url.pathname.startsWith('/api/')
            ? url.pathname
            : null;
        }
        const ok = url.protocol === 'https:' && !url.username && !url.password && !url.port &&
          ${JSON.stringify(Boolean(firebaseConfig.storageBucket))} && url.href.startsWith(PUSH_STORAGE_PREFIX);
        return ok ? url.href : null;
      } catch (error) {
        return null;
      }
    };

    // A failed import (CDN blocked or offline at install) must not stop the
    // app-shell worker from installing; push simply stays off until the next update.
    try {
      importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
      importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
    } catch (error) {
      console.warn('HomeHub service worker: push scripts unavailable', error);
    }

    if (self.firebase) {
      try {
        if (!firebase.apps.length) {
            firebase.initializeApp(${JSON.stringify(firebaseConfig)});
        }

        const messaging = firebase.messaging();

        // When the payload has a notification block, the Messaging SDK has
        // already shown it with the server's icon, badge, image and tag. This
        // display uses the same tag, so it replaces that one instead of
        // stacking a duplicate, and routes clicks through the allowlisted
        // handler below. Every picture is re-checked here.
        messaging.onBackgroundMessage((payload) => {
          const notification = payload.notification || {};
          const data = payload.data || {};
          const notificationTitle = notification.title || 'HomeHub';
          const notificationOptions = {
            body: notification.body || '',
            icon: safePushAsset(notification.icon) || '/icons/icon-192.png',
            badge: safePushAsset(data.badge) || '/icons/badge-96.png',
            data: {
                link: safePushLink(payload.fcmOptions?.link)
            }
          };
          const image = safePushImage(notification.image);
          if (image) notificationOptions.image = image;
          if (typeof data.tag === 'string' && data.tag) notificationOptions.tag = data.tag;

          return self.registration.showNotification(notificationTitle, notificationOptions);
        });
      } catch (error) {
        console.warn('HomeHub service worker: push unavailable', error);
      }
    }

    self.addEventListener('notificationclick', (event) => {
        event.notification.close();

        const targetUrl = safePushLink(event.notification.data?.link);

        event.waitUntil(
            clients.matchAll({ type: "window" }).then((clientList) => {
                for (const client of clientList) {
                    if (new URL(client.url).pathname === targetUrl && 'focus' in client) {
                        return client.focus();
                    }
                }
                if (clients.openWindow) {
                    return clients.openWindow(targetUrl);
                }
            })
        );
    });

    // ---- App shell (offline) -------------------------------------------------
    const SHELL_CACHE = 'homehub-shell-${SHELL_VERSION}';
    const STATIC_CACHE = 'homehub-static-${SHELL_VERSION}';
    const CURRENT_CACHES = [SHELL_CACHE, STATIC_CACHE];
    // Page shells that may be served offline. They are client-rendered: the HTML
    // holds no household data (that lives in Firestore's own offline cache).
    const SHELL_ROUTES = ['/', '/shopping', '/offline'];
    const OFFLINE_ROUTE = '/offline';
    const STATIC_ASSETS = [
      '/manifest.webmanifest',
      '/icon.svg',
      '/favicon.ico',
      '/apple-icon.png',
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/maskable-512.png',
    ];
    const MAX_STATIC_ENTRIES = 300;

    const shellKey = (pathname) => new Request(self.location.origin + pathname);

    const isStaticAsset = (url) =>
      url.pathname.startsWith('/_next/static/') || STATIC_ASSETS.includes(url.pathname);

    const cacheStaticUrls = async (urls) => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.all(urls.map(async (url) => {
        try {
          const response = await fetch(url, { credentials: 'same-origin' });
          if (response.ok) await cache.put(url, response);
        } catch (error) {
          // One missing asset must not fail the whole install.
        }
      }));
    };

    // Fetch a page shell, store it, and also store the scripts/styles it needs
    // so the page can boot offline even before the worker controlled a visit.
    const precacheShell = async (pathname) => {
      const response = await fetch(pathname, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok || response.redirected) return;
      const html = await response.clone().text();
      const shell = await caches.open(SHELL_CACHE);
      await shell.put(shellKey(pathname), response);
      const assetUrls = Array.from(new Set(html.match(/\\/_next\\/static\\/[^"'\\s)\\\\]+/g) || []));
      await cacheStaticUrls(assetUrls);
    };

    const trimCache = async (cacheName, maxEntries) => {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      for (let index = 0; index < keys.length - maxEntries; index += 1) {
        await cache.delete(keys[index]);
      }
    };

    self.addEventListener('install', (event) => {
      event.waitUntil((async () => {
        await Promise.all([
          ...SHELL_ROUTES.map((pathname) => precacheShell(pathname).catch(() => undefined)),
          cacheStaticUrls(STATIC_ASSETS),
        ]);
        await self.skipWaiting();
      })());
    });

    self.addEventListener('activate', (event) => {
      event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
          .filter((name) => name.startsWith('homehub-') && !CURRENT_CACHES.includes(name))
          .map((name) => caches.delete(name)));
        await self.clients.claim();
      })());
    });

    const offlineFallback = async (pathname) => {
      const shell = await caches.open(SHELL_CACHE);
      if (SHELL_ROUTES.includes(pathname)) {
        const cached = await shell.match(shellKey(pathname));
        if (cached) return cached;
      }
      const offline = await shell.match(shellKey(OFFLINE_ROUTE));
      if (offline) return offline;
      return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline - HomeHub</title><body style="font-family:system-ui,sans-serif;background:#020817;color:#f8fafc;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center"><main><h1>You are offline</h1><p>Reconnect to keep using HomeHub.</p></main>', {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    };

    // Network first: online visitors always get the fresh page; successful
    // responses for shell routes refresh the offline copy.
    const handleNavigation = async (request, url) => {
      try {
        const response = await fetch(request);
        if (response.ok && !response.redirected && response.type === 'basic' && SHELL_ROUTES.includes(url.pathname)) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(shellKey(url.pathname), copy)).catch(() => undefined);
        }
        return response;
      } catch (error) {
        return offlineFallback(url.pathname);
      }
    };

    // Build assets are content-hashed, so cache first is safe; the small set of
    // unhashed brand assets is refreshed in the background.
    const handleStatic = async (request, url) => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(request);
      // Hashed build files never change: a cached copy is final, with no network request.
      if (cached && url.pathname.startsWith('/_next/static/')) return cached;
      const refresh = fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          cache.put(request, response.clone()).then(() => trimCache(STATIC_CACHE, MAX_STATIC_ENTRIES)).catch(() => undefined);
        }
        return response;
      });
      if (cached) {
        refresh.catch(() => undefined);
        return cached;
      }
      return refresh;
    };

    self.addEventListener('fetch', (event) => {
      const { request } = event;
      if (request.method !== 'GET') return;
      const url = new URL(request.url);
      // Only same-origin traffic. Firebase, Google APIs and CDNs pass straight through.
      if (url.origin !== self.location.origin) return;
      // Never touch API routes (including this worker's own script) or Firebase auth helpers.
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__/')) return;

      if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request, url));
        return;
      }
      // React Server Component payloads (client-side navigation) go to the network;
      // if that fails offline, Next falls back to a full navigation handled above.
      if (isStaticAsset(url)) {
        event.respondWith(handleStatic(request, url));
      }
    });
  `;

  return new NextResponse(script, {
    headers: {
      'Content-Type': 'application/javascript',
      'Service-Worker-Allowed': '/',
      // Browsers already bypass the HTTP cache for worker update checks; this
      // keeps intermediaries from serving a stale worker after a deploy.
      'Cache-Control': 'no-cache',
    },
  });
}
