// slock service worker: app-shell caching, web push, notification clicks.
// The page registers this script as /sw.js?v=<server build id>; a new build
// changes the URL (new worker) and the cache name (old shells cleaned up on
// activate). 'dev' is the fallback when no version is known.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `slock-${VERSION}`;

const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/badge-96.png',
  '/icons/favicon-64.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Tolerate individual misses (icon set may vary) — addAll would fail whole.
    await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the API (including /api/events).
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network-first, cached shell as offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const cached = await caches.match('/');
        return cached || Response.error();
      }
    })());
    return;
  }

  // Icons: cache-first (immutable in practice, versioned by cache name).
  if (url.pathname.startsWith('/icons/')) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    })());
    return;
  }

  // Other shell assets: network-first with cache fallback, refreshing the copy.
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(req);
      return cached || Response.error();
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'slock', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'slock';
  // The icon/badge slots mean different things per platform. Android: `badge`
  // is the small monochrome status-bar glyph (without it: a generic bell) and
  // `icon` renders as a big redundant image on the RIGHT of the notification —
  // the nice left icon is the installed app's own, so `icon` is omitted there.
  // Desktop: `icon` IS the main left logo and `badge` goes unused.
  const isAndroid = /Android/i.test(navigator.userAgent);
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,     // coalesce per-channel notifications
    renotify: !!data.tag,           // replacing a tag must still alert the user
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/' },
  };
  if (!isAndroid) options.icon = '/icons/icon-192.png';
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    if ('setAppBadge' in navigator && typeof data.badge === 'number') {
      try {
        if (data.badge > 0) await navigator.setAppBadge(data.badge);
        else await navigator.clearAppBadge();
      } catch { /* unsupported */ }
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of wins) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'navigate', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
