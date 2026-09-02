// slock service worker: app-shell caching, offline reads, web push,
// notification clicks.
// The page registers this script as /sw.js?v=<server build id>; a new build
// changes the URL (new worker) and the cache name (old shells cleaned up on
// activate). 'dev' is the fallback when no version is known.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `slock-${VERSION}`;

// The API cache is deliberately NOT versioned: a deploy replaces the shell but
// must not throw away the messages someone is about to read on a plane. It is
// swept on logout instead (see the 'clear-cache' message below), because the
// Cache API is scoped to the origin rather than to a user.
const API_CACHE = 'slock-api';

// Enough history to read a channel back, capped so a busy workspace cannot
// grow the store without bound. The client asks for fewer (75) on the first
// page, so this is a ceiling rather than a target.
const MAX_CACHED_MESSAGES = 100;

const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/badge-96.png',
  '/icons/transparent.png',
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
    // Sweep superseded shells, but spare the API cache — it is not versioned
    // and its whole point is surviving the deploy that replaced the shell.
    await Promise.all(names
      .filter((n) => n !== CACHE && n !== API_CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// The page asks for this on logout: a second person signing in on the same
// device must not inherit the first one's messages.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'clear-cache') return;
  event.waitUntil((async () => {
    await caches.delete(API_CACHE);
    if (event.ports && event.ports[0]) event.ports[0].postMessage({ cleared: true });
  })());
});

// ---------------------------------------------------------------------------
// offline reads — the GETs worth keeping so a channel is readable with no
// network. Everything else under /api/ is a write, an endless stream, or a
// file, and is passed straight through untouched.
// ---------------------------------------------------------------------------

function offlineReadable(url) {
  switch (url.pathname) {
    case '/api/auth/me':      // boot dies without this one
    case '/api/channels':
    case '/api/users':
    case '/api/workspace':
    case '/api/version':
      return true;
  }
  // A channel's newest page, which is what openChannel asks for. Paging
  // through older history stays online-only: those pages are meaningless
  // without the live list they hang off.
  if (/^\/api\/channels\/\d+\/messages$/.test(url.pathname)) {
    return !url.searchParams.has('before') && !url.searchParams.has('after');
  }
  return false;
}

// Store the newest MAX_CACHED_MESSAGES of a history page. The server returns
// them oldest-first, so the tail is the recent end.
async function putMessages(cache, req, res) {
  try {
    const data = await res.clone().json();
    if (Array.isArray(data.messages) && data.messages.length > MAX_CACHED_MESSAGES) {
      data.messages = data.messages.slice(-MAX_CACHED_MESSAGES);
      const headers = new Headers(res.headers);
      headers.delete('content-length'); // the body is no longer that length
      await cache.put(req, new Response(JSON.stringify(data), { status: 200, headers }));
      return;
    }
  } catch { /* not the shape we expected — keep it verbatim */ }
  await cache.put(req, res.clone());
}

// Storing the identity doubles as the check for it: if the person behind this
// session changed, everything cached belongs to someone else.
async function putMe(cache, req, res) {
  try {
    const fresh = await res.clone().json();
    const prev = await cache.match(req);
    if (prev) {
      const old = await prev.json();
      if (old && old.user && fresh && fresh.user && old.user.id !== fresh.user.id) {
        await caches.delete(API_CACHE);
        cache = await caches.open(API_CACHE);
      }
    }
  } catch { /* unreadable either side: fall through and just store */ }
  await cache.put(req, res.clone());
}

async function putApi(req, url, res) {
  const cache = await caches.open(API_CACHE);
  if (url.pathname === '/api/auth/me') return putMe(cache, req, res);
  if (url.pathname.endsWith('/messages')) return putMessages(cache, req, res);
  return cache.put(req, res.clone());
}

// A cached body, flagged so the page can say it is showing saved messages.
async function fromCache(res) {
  const headers = new Headers(res.headers);
  headers.set('X-Slock-Offline', '1');
  return new Response(await res.blob(), {
    status: res.status, statusText: res.statusText, headers,
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: network-first for the handful of reads a channel needs, so being
  // online behaves exactly as it did before — the cache is consulted only
  // when the fetch itself fails. /api/events (an endless stream), /api/files
  // and every write fall through to the browser untouched.
  if (url.pathname.startsWith('/api/')) {
    if (!offlineReadable(url)) return;
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        // Hand the page its response immediately and store a clone in the
        // background: a channel open must not wait on a cache write.
        if (res.ok) event.waitUntil(putApi(req, url, res.clone()));
        return res;
      } catch {
        // Scoped to the API store, and ignoreSearch so a changed page size
        // (?limit=) still finds the copy that was saved under the old one.
        const cache = await caches.open(API_CACHE);
        const cached = await cache.match(req, { ignoreSearch: true });
        // No copy: fail exactly as an offline fetch does today, so api()
        // raises its usual network error rather than a confusing empty 200.
        return cached ? fromCache(cached) : Response.error();
      }
    })());
    return;
  }

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
  // the nice left icon is the installed app's own. Omitting `icon` is no good
  // either: the browser then draws a generated monogram ("S" in a circle) in
  // that slot, so it gets a fully transparent image instead, which renders as
  // nothing. Desktop: `icon` IS the main left logo and `badge` goes unused.
  const isAndroid = /Android/i.test(navigator.userAgent);
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,     // coalesce per-channel notifications
    renotify: !!data.tag,           // replacing a tag must still alert the user
    badge: '/icons/badge-96.png',
    icon: isAndroid ? '/icons/transparent.png' : '/icons/icon-192.png',
    data: { url: data.url || '/' },
  };
  event.waitUntil((async () => {
    let badge = typeof data.badge === 'number' ? data.badge : null;
    let show = true;
    // A push can land hours after it was sent: the phone was unreachable and
    // the push service queued it (the server keeps only the newest per
    // channel via the Topic header, but cannot retract even that). Delivery
    // is the only place left to drop stale ones — if the channel has been
    // read meanwhile, on any device, showing this now is pure noise. The
    // fresh channel list also corrects the badge, whose payload value is as
    // old as the message. Any failure (offline, slow, signed out) falls back
    // to showing; deliberate skips are rare enough to stay within Chrome's
    // silent-push allowance.
    if (data.channel_id) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 3000);
        const resp = await fetch('/api/channels', { signal: ctl.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const chans = (await resp.json()).channels || [];
          const ch = chans.find((c) => c.id === data.channel_id);
          if (ch && !ch.unread_count) show = false;
          badge = chans.reduce((n, c) => n + (c.unread_count || 0), 0);
        }
      } catch { /* can't tell — show it */ }
    }
    if (show) await self.registration.showNotification(title, options);
    if ('setAppBadge' in navigator && badge !== null) {
      try {
        if (badge > 0) await navigator.setAppBadge(badge);
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
