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

// The files without which there is no app to start.
const CORE = ['/', '/style.css', '/app.js'];

// Sweep superseded shells once this build's is complete, sparing the API
// cache — it is not versioned and its whole point is surviving the deploy
// that replaced the shell. An install on a bad connection can miss files;
// deleting the last good copy then left the next start fetching the app over
// that connection, on a blank page. Until then lookups (caches.match, across
// every cache) fall back to the older copy, and each background refresh
// below tries again.
async function sweepOldShells() {
  const cache = await caches.open(CACHE);
  for (const u of CORE) if (!(await cache.match(u))) return;
  const names = await caches.keys();
  await Promise.all(names
    .filter((n) => n !== CACHE && n !== API_CACHE)
    .map((n) => caches.delete(n)));
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await sweepOldShells();
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
  // The Latest feed's first page (older pages stay online-only, as below).
  if (url.pathname === '/api/latest') return !url.searchParams.has('before');
  // A channel's newest page, which is what openChannel asks for. Paging
  // through older/newer history, and windows around a jumped-to message,
  // stay online-only: they are meaningless without the live list they hang
  // off — and since lookups ignore the query string, storing one would let it
  // be served offline as the channel's newest page.
  // A note's whole text: the page keeps every note it can open stored here
  // (see "notes offline" in app.js), and an older copy is still a good start —
  // edits since are fetched as ops once the stream is back.
  if (/^\/api\/notes\/\d+$/.test(url.pathname)) return true;
  if (/^\/api\/channels\/\d+\/messages$/.test(url.pathname)) {
    return !url.searchParams.has('before') && !url.searchParams.has('after')
      && !url.searchParams.has('around');
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

// Lookups ignore the query string, so a changed page size (?limit=) still
// finds the copy saved under the old one — except the Latest feed's, whose
// query says which feed it is (DMs or not, pinned channels only).
function matchStored(cache, req, url) {
  return cache.match(req, { ignoreSearch: url.pathname !== '/api/latest' });
}

async function putApi(req, url, res) {
  const cache = await caches.open(API_CACHE);
  if (url.pathname === '/api/auth/me') return putMe(cache, req, res);
  if (url.pathname.endsWith('/messages')) return putMessages(cache, req, res);
  await cache.put(req, res.clone());
  if (url.pathname === '/api/channels') {
    try { await storePages(await res.clone().json()); } catch { /* not a list */ }
  }
}

// Every channel you are in keeps its newest page stored, so it opens at once
// even the first time in a session. After each fresh channel list: a page
// that ends before its channel's last_message_at (or is missing) is fetched
// again, most recent first, one at a time; pages of channels no longer listed
// are dropped. Public channels you are not in are stored only as you open
// them.
const PAGE = 75; // = HISTORY_PAGE in app.js: the same URL replaces the same entry
const PAGE_RE = /^\/api\/channels\/(\d+)\/messages$/;
let storing = null;

async function storePages(list) {
  if (storing) return storing; // one pass at a time: the next list catches up
  storing = (async () => {
    const cache = await caches.open(API_CACHE);
    const chans = [...(list.channels || []), ...(list.dms || [])];
    const listed = new Set(chans.map((c) => c.id));
    for (const req of await cache.keys()) {
      const m = PAGE_RE.exec(new URL(req.url).pathname);
      if (m && !listed.has(Number(m[1]))) await cache.delete(req);
    }
    const mine = chans
      .filter((c) => c.kind !== 'channel' || c.is_member)
      .sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''));
    for (const ch of mine) {
      const url = `/api/channels/${ch.id}/messages?limit=${PAGE}`;
      const stored = await cache.match(url, { ignoreSearch: true });
      if (stored && !pageBehind(await stored.json(), ch)) continue;
      let res;
      try { res = await fetch(url); } catch { return; } // offline: next list
      if (res.ok) await putMessages(cache, new Request(url), res);
    }
  })();
  try { await storing; } catch { /* best effort */ } finally { storing = null; }
}

function pageBehind(page, ch) {
  const msgs = page && Array.isArray(page.messages) ? page.messages : null;
  if (!msgs) return true;
  if (!ch.last_message_at) return false;
  const last = msgs[msgs.length - 1];
  return !last || new Date(ch.last_message_at) > new Date(last.created_at);
}

// API reads: the stored copy at once, and the live one fetched behind it,
// stored, and posted to the page that asked — under the id it sent as
// X-Slock-Req: {type: 'api-fresh', id, status, body}, body null when the live
// one is the same or unreachable. Nothing stored: plain network. A request
// made with cache: 'no-cache' (the page syncing after a reconnect, or
// prefetching) is network-first instead, the copy answering only if the
// network fails.
async function answerApi(event, req, url) {
  const cache = await caches.open(API_CACHE);
  const cached = await matchStored(cache, req, url);
  if (cached && req.cache !== 'no-cache' && req.cache !== 'reload') {
    const text = await cached.clone().text();
    event.waitUntil(revalidate(event.clientId, req, url, text));
    return fromCache(cached, 'X-Slock-Revalidating');
  }
  try {
    const res = await fetch(req);
    // Hand the page its response immediately and store a clone in the
    // background: a channel open must not wait on a cache write.
    if (res.ok) event.waitUntil(putApi(req, url, res.clone()));
    else if (lostAccess(res)) event.waitUntil(forget(cache, req, url));
    return res;
  } catch {
    // No copy: fail exactly as an offline fetch does, so api() raises its
    // usual network error rather than a confusing empty 200.
    return cached ? fromCache(cached, 'X-Slock-Offline') : Response.error();
  }
}

async function revalidate(clientId, req, url, storedText) {
  const msg = { type: 'api-fresh', id: req.headers.get('X-Slock-Req'), status: 0, body: null };
  try {
    const res = await fetch(req);
    msg.status = res.status;
    if (res.ok) {
      const text = await res.clone().text();
      await putApi(req, url, res);
      if (text !== storedText) msg.body = text;
    } else if (lostAccess(res)) {
      await forget(await caches.open(API_CACHE), req, url);
    }
  } catch { /* unreachable: the copy stands */ }
  if (!msg.id || !clientId) return;
  const client = await self.clients.get(clientId);
  if (client) client.postMessage(msg);
}

// Left, removed, deleted: the stored copy must not stay readable.
const lostAccess = (res) => res.status === 403 || res.status === 404;
const forget = (cache, req, url) =>
  cache.delete(req, { ignoreSearch: url.pathname !== '/api/latest' }).catch(() => {});

// A stored body, flagged for the page: X-Slock-Revalidating when the live one
// is being fetched behind it (see answerApi), X-Slock-Offline when the network
// failed — the page then says it is showing saved messages.
async function fromCache(res, flag) {
  const headers = new Headers(res.headers);
  headers.set(flag, '1');
  return new Response(await res.blob(), {
    status: res.status, statusText: res.statusText, headers,
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: the handful of reads a channel needs (see answerApi). /api/events
  // (an endless stream), /api/files and every write fall through untouched.
  if (url.pathname.startsWith('/api/')) {
    if (!offlineReadable(url)) return;
    event.respondWith(answerApi(event, req, url));
    return;
  }

  // Navigations to the app itself: cached shell first — on a slow connection
  // the logo used to stand in for seconds while the network dawdled. Safe
  // because the shell cache is keyed by build: a deploy installs a new
  // worker+cache and the version check reloads the page. A background fetch
  // keeps the copy fresh within a build. Other pages (login.html) stay
  // network-first with no shell fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      if (url.pathname === '/') {
        const cached = await caches.match('/');
        if (cached) {
          event.waitUntil((async () => {
            try {
              const res = await fetch(req);
              if (res.ok) {
                await (await caches.open(CACHE)).put('/', res);
                await sweepOldShells();
              }
            } catch { /* offline */ }
          })());
          return cached;
        }
      }
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

  // Other shell assets (style.css, app.js, manifest): cache-first, same
  // build-keyed safety as navigations, refreshed in the background.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) {
      event.waitUntil((async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            await (await caches.open(CACHE)).put(req, res);
            await sweepOldShells();
          }
        } catch { /* offline */ }
      })());
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      return Response.error();
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
