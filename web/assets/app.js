// slock client — vanilla ES module. Behaviour only: toggles classes/attributes
// per docs/DOM.md, never writes CSS values (except the composer auto-grow).
//
// Sections: helpers · api · state · toasts · sidebar · messages · body
// tokeniser · channel/history · read state · composer · uploads · reactions ·
// lightbox · realtime · palette · modals · menu/settings · push · boot.

/* ============================================================ helpers */

const byId = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function relativeTime(ts) {
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + 'd';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ts) {
  return new Date(ts).toDateString();
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const opts = { weekday: 'long', month: 'long', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

// Clone the first element of a <template> by id. Returns null if missing.
function tpl(id) {
  const t = byId(id);
  if (!t || !t.content) return null;
  return t.content.firstElementChild ? t.content.firstElementChild.cloneNode(true) : null;
}

function on(el, ev, fn, opts) {
  if (el) el.addEventListener(ev, fn, opts);
}

// Toggle visibility through the content attribute rather than the `hidden`
// IDL property. `hidden` is defined on HTMLElement, so `svg.hidden = true`
// silently sets a stray JS property and the [hidden] CSS never matches —
// setAttribute works for HTML and SVG alike.
function setHidden(el, on) {
  if (!el) return;
  if (on) el.setAttribute('hidden', '');
  else el.removeAttribute('hidden');
}

function fileURL(att, variant) {
  return `/api/files/${att.id}/${variant}/${encodeURIComponent(att.filename)}`;
}

// The one place that knows how to draw an avatar: picture when the user has
// one, coloured initials otherwise. `el` is an avatar element per docs/DOM.md
// ("Avatars"): it contains `.avatar-initials` and `img.avatar-img`.
function applyAvatar(el, user) {
  if (!el) return;
  el.dataset.color = (user && user.avatar_color) || 0;
  const name = user ? user.display_name : '?';
  const ini = el.querySelector('.avatar-initials');
  const img = el.querySelector('.avatar-img');
  if (ini) ini.textContent = initials(name);
  else if (!img) el.textContent = initials(name); // markup not migrated yet
  if (!img) return;
  const url = (user && user.avatar_url) || '';
  if (url) {
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => { img.hidden = true; };
    if (img.getAttribute('src') !== url) img.src = url; // hash-versioned, stable
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
}

function copyText(text, label) {
  navigator.clipboard.writeText(text)
    .then(() => toast(label || 'Copied'))
    .catch(() => toast('Could not copy', true));
}

/* ============================================================ api */

// One wrapper for every call: 401 → login page, parses {error, message},
// toasts failures unless opts.toast === false. A FormData body is sent as
// multipart (the browser sets the content type).
async function api(path, opts = {}) {
  const { method = 'GET', body, signal, toast: doToast = true } = opts;
  const init = { method, signal, headers: {} };
  // No live stream yet — booting, reconnecting, or a bad connection: ask the
  // service worker for its saved copy served instantly (refreshed in the
  // background). Cached messages in a beat beat a logo for ten seconds; the
  // SSE hello that follows gap-fills and refetches, so nothing stays stale.
  // With the stream up, reads are network-first exactly as before.
  if (method === 'GET' && !state.connected) init.headers['X-Slock-Prefer-Cache'] = '1';
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // Deliberately silent: the connection banner already says we are offline,
    // and anything that retries would otherwise bury the screen in identical
    // toasts. Callers that need to show something still get the thrown error
    // (the composer's retry row, a modal's inline error). Real server errors
    // — a response that arrived and said no — are toasted below.
    const e = new Error('Network error');
    e.code = 'network';
    throw e;
  }
  // The service worker flags anything it served from its offline store, so the
  // connection banner can say "saved messages" rather than "reconnecting".
  if (res.headers.get('X-Slock-Offline')) state.offlineCache = true;
  if (res.status === 401) {
    location.href = '/login.html';
    throw Object.assign(new Error('Unauthorized'), { code: 'unauthorized' });
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const e = new Error((data && data.message) || `Request failed (${res.status})`);
    e.code = (data && data.error) || 'internal';
    e.status = res.status;
    if (doToast) toast(e.message, true);
    throw e;
  }
  return data;
}

/* ============================================================ state */

const state = {
  me: null,
  mustChangePw: false,
  pushKey: '',
  workspace: { name: 'slock', icon_url: '' },
  users: new Map(),        // id -> User
  channels: new Map(),     // id -> Channel (channels + dms)
  chan: new Map(),         // id -> per-channel message state
  currentId: null,
  latest: false,           // the "Latest" meta-channel is showing (currentId is null then)
  online: new Set(),       // user ids
  typing: new Map(),       // channelId -> Map(userId -> expiresAt)
  connected: false,
  offlineCache: false,     // a response came from the service worker's store
  sseClientId: 0,          // this tab's stream id, from the SSE `hello` frame
  atBottom: true,
  editingId: null,         // message id being edited in the composer
  lastReadSent: new Map(), // channelId -> last message id POSTed to /read
  membersRefresh: null,    // live members-modal refresh hook
  pinsRefresh: null,       // live pins-modal refresh hook
};

const LS = {
  theme: 'slock:theme',
  side: 'slock:side',
  sideHidden: 'slock:side-hidden', // '1' = desktop sidebar folded away
  colors: 'slock:colors',
  density: 'slock:density',
  sidebarW: 'slock:sidebar-width',
  zoom: 'slock:zoom',
  closedDMs: 'slock:closed-dms',
  pinnedChans: 'slock:pinned-channels',
  foldChans: 'slock:fold-channels',
  foldDMs: 'slock:fold-dms',
  groupChans: 'slock:group-channels', // '1' = fold channels by name prefix
  showUnjoined: 'slock:show-unjoined', // '1' = list channels you are not in
  sound: 'slock:sound',
  font: 'slock:font',
  lastChannel: 'slock:last-channel', // a channel id, or 'latest'
  drafts: 'slock:drafts',
  outbox: 'slock:outbox',            // messages sent but not yet confirmed (see outbox)
  latestFaves: 'slock:latest-faves', // '1' = Latest shows pinned channels only
  latestDMs: 'slock:latest-dms',     // '0' = Latest leaves DMs out
  palHistory: 'slock:palette-history', // ⌘K "Recent": places opened + searches followed
};

function chanState(id) {
  let st = state.chan.get(id);
  if (!st) {
    st = {
      msgs: [], byId: new Map(), byClient: new Map(),
      loaded: false, loadingOlder: false, hasMore: true,
      olderRetryAt: 0, // don't re-ask for history before this (see loadOlder)
      stale: false, unreadStartId: null, jumpCount: 0,
      // Detached: showing a window around a jumped-to message rather than the
      // live end. Newer messages exist past the window and load on scrolling
      // down; live ones aren't appended (there'd be a gap). See loadAround.
      hasNewer: false, newerRetryAt: 0, loadingNewer: false,
      parked: [], // unsent messages held aside while detached (they belong at the live end)
    };
    state.chan.set(id, st);
  }
  return st;
}

function isMuted(ch) {
  return !!(ch && ch.muted);
}

// Notes is your DM with yourself (the server already supports a one-member
// "N:N" DM). It gets a fixed sidebar row under Latest instead of a spot in the
// DM list, and is called "Notes" everywhere.
function isNotesChannel(ch) {
  return !!(ch && ch.kind === 'dm' && state.me && ch.peer_user_id === state.me.id);
}

function notesChannel() {
  for (const ch of state.channels.values()) {
    if (isNotesChannel(ch)) return ch;
  }
  return null;
}

// Open Notes, creating the self-DM on first use.
async function openNotes() {
  const existing = notesChannel();
  if (existing) {
    reopenDM(existing.id); // in case it was closed from the DM list before Notes existed
    openChannel(existing.id);
    return;
  }
  if (!state.me || blockedOffline('Notes')) return;
  try {
    const data = await api('/api/dms', { method: 'POST', body: { user_id: state.me.id } });
    mergeChannel(data.channel);
    openChannel(data.channel.id);
  } catch { /* toasted */ }
}

function channelDisplayName(ch) {
  if (!ch) return '';
  if (isNotesChannel(ch)) return 'Notes';
  if (ch.kind === 'dm') {
    const peer = state.users.get(ch.peer_user_id);
    return peer ? peer.display_name : 'Direct message';
  }
  // Private channels carry an svg lock where they render (sidebar rows, the
  // header) — as text they are just the bare name, never an emoji.
  return (ch.is_private ? '' : '#') + ch.name;
}

function mergeChannel(ch) {
  const prev = state.channels.get(ch.id);
  state.channels.set(ch.id, prev ? Object.assign({}, prev, ch) : ch);
  return state.channels.get(ch.id);
}

// `startedAt` (when the list was requested) is given for refetches: a list
// requested before one of our mark-reads was answered may predate it, and its
// unread count for that channel would undo the read — keep ours instead (new
// messages since arrive over SSE and count locally anyway).
function setChannels(data, startedAt) {
  const seen = new Set();
  let reopened = false;
  for (const ch of [...(data.channels || []), ...(data.dms || [])]) {
    const prev = state.channels.get(ch.id);
    if (prev && startedAt && readMayPostdate(ch.id, startedAt)) {
      ch.unread_count = prev.unread_count || 0;
    }
    // A DM closed on this device that has unread messages got something new
    // since (while this app wasn't running to see it live): bring it back,
    // rather than count it in the title with nothing in the sidebar to click.
    if (ch.kind === 'dm' && ch.unread_count > 0 && closedDMs.delete(ch.id)) reopened = true;
    mergeChannel(ch);
    seen.add(ch.id);
  }
  if (reopened) saveClosedDMs();
  // Drop channels the server no longer reports (left private channels etc.),
  // except the one currently open.
  for (const id of [...state.channels.keys()]) {
    if (!seen.has(id) && id !== state.currentId) state.channels.delete(id);
  }
}

// Workspace identity: name in the wordmark + document.title, admin icon in
// place of the built-in SVG mark. Fed by GET /api/workspace, admin writes,
// and the workspace.update SSE frame — all through here.
function applyWorkspace(ws) {
  if (!ws) return;
  state.workspace = { name: ws.name || 'slock', icon_url: ws.icon_url || '' };
  const nameEl = byId('workspace-name');
  if (nameEl) nameEl.textContent = state.workspace.name;
  const img = byId('workspace-icon');
  const logo = document.querySelector('.workspace-logo');
  const custom = !!state.workspace.icon_url;
  if (img) {
    if (custom && img.getAttribute('src') !== state.workspace.icon_url) {
      img.src = state.workspace.icon_url;
    }
    if (!custom) img.removeAttribute('src');
    setHidden(img, !custom);
  }
  // The built-in mark is only a fallback: once an admin sets a real logo it
  // goes away entirely rather than sitting next to it.
  setHidden(logo, custom);
  updateBadges(); // document.title tracks the workspace name
}

// Merge a fresh User (own PATCH/avatar responses and the user.update SSE
// frame both land here — applying it twice is a no-op) and repaint every
// place a user appears. Mutates in place so held references stay valid.
function applyUserUpdate(user) {
  if (!user) return;
  const prev = state.users.get(user.id);
  const merged = prev ? Object.assign(prev, user) : user;
  state.users.set(user.id, merged);
  if (state.me && user.id === state.me.id) state.me = merged;
  renderSidebar();
  renderChannelHeader();
  if (state.currentId) {
    const sc = byId('message-scroll');
    const top = sc ? sc.scrollTop : 0;
    renderMessagesFull(state.currentId);
    if (sc) sc.scrollTop = state.atBottom ? sc.scrollHeight : top;
  }
}

async function refetchChannels() {
  try {
    const startedAt = Date.now();
    const data = await api('/api/channels', { toast: false });
    setChannels(data, startedAt);
    // setChannels keeps the open channel even when the list no longer has it.
    // For a named channel that means it is gone — deleted while this client
    // was not listening, or no longer allowed — so move off it rather than sit
    // on a channel every fetch refuses. (A DM can be legitimately unlisted.)
    const cur = state.channels.get(state.currentId);
    if (cur && cur.kind === 'channel' && !(data.channels || []).some((c) => c.id === cur.id)) {
      dropDeletedChannel(cur.id, { gone: true });
    }
    renderSidebar();
    renderChannelHeader();
    updateBadges();
    maybeMarkRead(); // reading the open channel now covers anything it brought
  } catch (err) {
    if (err.code !== 'network') console.warn('channel refetch failed', err);
  }
}

// Mark-read bookkeeping, so a channel list fetched around a read can't put
// the read channel's old unread count back (see setChannels).
const readInflight = new Map(); // channelId -> mark-read POSTs not yet answered
const readDoneAt = new Map();   // channelId -> when the last one was answered

// True when the server may have answered a channel list (requested at
// `startedAt`) before taking our latest read of this channel into account.
function readMayPostdate(channelId, startedAt) {
  return (readInflight.get(channelId) || 0) > 0 || (readDoneAt.get(channelId) || 0) >= startedAt;
}

/* ============================================================ toasts */

function toast(text, isError = false) {
  const root = byId('toasts');
  if (!root) { if (isError) console.error(text); return; }
  const el = tpl('tpl-toast');
  if (!el) return;
  const t = el.querySelector('.toast-text');
  if (t) t.textContent = text; else el.textContent = text;
  if (isError) el.classList.add('toast--error');
  root.append(el);
  setTimeout(() => el.remove(), 4500);
}

/* ============================================================ sidebar */

function sortedChannels() {
  return [...state.channels.values()]
    // Public channels show to everyone (join from the list); a private channel
    // is member-only, so once you leave (or are removed) it must disappear.
    .filter((c) => c.kind === 'channel' && (!c.is_private || c.is_member))
    .sort((a, b) => (isChannelPinned(b.id) - isChannelPinned(a.id))
      || (b.is_member - a.is_member) || a.name.localeCompare(b.name));
}

// A private channel you're no longer in is gone for good — you cannot see or
// reopen it. Forget it locally and, if you were viewing it, move to another.
function forgetPrivateChannel(channelId) {
  const ch = state.channels.get(channelId);
  if (!ch || ch.kind !== 'channel' || !ch.is_private || ch.is_member) return;
  state.channels.delete(channelId);
  state.chan.delete(channelId);
  if (state.currentId === channelId) {
    state.currentId = null;
    const next = sortedChannels().find((c) => c.is_member) || sortedChannels()[0] || sortedDMs()[0];
    if (next) openChannel(next.id);
    else renderChannelHeader();
  }
}

// A channel was deleted (by you or someone else): forget everything about it
// on this device — its view, pin, mention flag and unsendable outbox entries
// (drafts prune themselves on the next persist) — and move off it if open.
function dropDeletedChannel(channelId, opts = {}) {
  const ch = state.channels.get(channelId);
  if (!ch) return;
  state.channels.delete(channelId);
  state.chan.delete(channelId);
  mentionedChans.delete(channelId);
  if (isChannelPinned(channelId)) togglePinChannel(channelId, { quiet: true });
  writeOutbox(readOutbox().filter((e) => e.channel_id !== channelId));
  if (state.currentId === channelId) {
    state.currentId = null;
    // Its half-typed text must not follow into the next channel.
    const ta = byId('composer-input');
    if (ta) { ta.value = ''; autogrow(); }
    const next = sortedChannels().find((c) => c.is_member) || sortedChannels()[0] || sortedDMs()[0];
    if (next) openChannel(next.id);
    else renderChannelHeader();
    if (opts.gone) toast(`#${ch.name} is no longer available`);
    else if (!opts.mine) toast(`#${ch.name} was deleted`);
  }
  if (state.latest) loadLatest(); // it may have been showing that channel's messages
  persistDrafts();
  renderSidebar();
  updateBadges();
}

function sortedDMs() {
  return [...state.channels.values()]
    // closedDMs = device-locally hidden conversations; a new message or a
    // deliberate reopen (reopenDM) puts them back.
    .filter((c) => c.kind === 'dm' && !closedDMs.has(c.id) && !isNotesChannel(c))
    .sort((a, b) => (isChannelPinned(b.id) - isChannelPinned(a.id))
      || String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
}

function makeChanRow(ch, nested = false) {
  const li = tpl('tpl-channel-item');
  if (!li) return null;
  li.dataset.id = ch.id;
  li.classList.toggle('chan--nested', nested); // shown under its "bd-*" group
  li.classList.toggle('chan--active', ch.id === state.currentId);
  li.classList.toggle('chan--unread', ch.unread_count > 0 && !isMuted(ch));
  li.classList.toggle('chan--muted', isMuted(ch));
  li.classList.toggle('chan--member', !!ch.is_member);
  li.classList.toggle('chan--private', !!ch.is_private);
  li.classList.toggle('chan--pinned', isChannelPinned(ch.id));
  li.classList.toggle('chan--draft', ch.id !== state.currentId && hasDraft(ch.id));
  const name = li.querySelector('.chan-name');
  if (name) name.textContent = ch.name;
  const badge = li.querySelector('.chan-badge');
  if (badge) {
    badge.hidden = !(ch.unread_count > 0);
    badge.textContent = ch.unread_count > 99 ? '99+' : String(ch.unread_count || '');
  }
  return li;
}

// The "bd-*" row standing in for a folded group. Its unread state, badge and
// draft pencil cover only the channels it hides, so nothing is counted twice.
function makeChanGroupRow(key, group, shown, expanded) {
  const li = tpl('tpl-channel-group');
  const hidden = group.filter((c) => !shown.includes(c));
  const unread = hidden.filter((c) => !isMuted(c)).reduce((n, c) => n + (c.unread_count || 0), 0);
  li.dataset.group = key;
  li.classList.toggle('chan--member', group.some((c) => c.is_member));
  li.classList.toggle('chan--unread', unread > 0);
  li.classList.toggle('chan--draft', hidden.some((c) => hasDraft(c.id)));
  li.classList.toggle('chan-group--open', expanded);
  const btn = li.querySelector('.chan-btn');
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  btn.title = `${group.length} channels: ${group.map((c) => c.name).join(', ')}`;
  // Keep the first channel's spelling of the prefix ("BD-" stays "BD-").
  li.querySelector('.chan-name').textContent = `${group[0].name.slice(0, key.length)}*`;
  const badge = li.querySelector('.chan-badge');
  badge.hidden = !(unread > 0);
  badge.textContent = unread > 99 ? '99+' : String(unread || '');
  return li;
}

function renderSidebar() {
  const chanList = byId('channel-list');
  const dmList = byId('dm-list');
  if (chanList) {
    chanList.textContent = '';
    const chans = sortedChannels().filter(visibleInSidebar);
    const groups = prefixGroups(chans);
    const emitted = new Set();
    for (const ch of chans) {
      const group = groups.get(groupKey(ch));
      if (!group) {
        const li = makeChanRow(ch);
        if (!li) break;
        chanList.append(li);
        continue;
      }
      // A folded group renders once, where its first channel would sort, with
      // the channels it must not hide (all of them when expanded) under it.
      if (emitted.has(group)) continue;
      emitted.add(group);
      const expanded = openGroups.has(groupKey(ch));
      const shown = group.filter((c) => expanded || surfacedInGroup(c));
      chanList.append(makeChanGroupRow(groupKey(ch), group, shown, expanded));
      for (const c of shown) chanList.append(makeChanRow(c, true));
    }
  }
  if (dmList) {
    dmList.textContent = '';
    for (const ch of sortedDMs()) {
      if (!visibleInSidebar(ch)) continue;
      const li = tpl('tpl-dm-item');
      if (!li) break;
      const peer = state.users.get(ch.peer_user_id);
      li.dataset.id = ch.id;
      li.dataset.userId = ch.peer_user_id || '';
      li.classList.toggle('dm--active', ch.id === state.currentId);
      li.classList.toggle('dm--unread', ch.unread_count > 0 && !isMuted(ch));
      li.classList.toggle('dm--online', state.online.has(ch.peer_user_id));
      li.classList.toggle('dm--pinned', isChannelPinned(ch.id));
      li.classList.toggle('dm--draft', ch.id !== state.currentId && hasDraft(ch.id));
      applyAvatar(li.querySelector('.dm-avatar'), peer);
      const name = li.querySelector('.dm-name');
      if (name) name.textContent = peer ? peer.display_name : 'Unknown';
      const badge = li.querySelector('.dm-badge');
      if (badge) {
        badge.hidden = !(ch.unread_count > 0);
        badge.textContent = ch.unread_count > 99 ? '99+' : String(ch.unread_count || '');
      }
      const pres = li.querySelector('.dm-presence');
      if (pres) pres.title = state.online.has(ch.peer_user_id) ? 'Online' : 'Offline';
      dmList.append(li);
    }
  }
  const notesRow = byId('notes-row');
  if (notesRow) {
    const notes = notesChannel();
    notesRow.classList.toggle('chan--active', isNotesChannel(state.channels.get(state.currentId)));
    notesRow.classList.toggle('chan--draft', !!notes && notes.id !== state.currentId && hasDraft(notes.id));
  }
  // Pins come and go (and channels load after prefs): keep the header pin
  // toggles in step.
  reflectFoldButton('channel');
  reflectFoldButton('dm');
  renderMeChip();
}

function renderMeChip() {
  if (!state.me) return;
  applyAvatar(byId('me-avatar'), state.me);
  const name = byId('me-name');
  if (name) name.textContent = state.me.display_name;
}

/* ============================================================ messages */

const COMPACT_WINDOW_MS = 5 * 60 * 1000;

function userName(id) {
  const u = state.users.get(id);
  return u ? u.display_name : 'Someone';
}

function isCompactWith(prev, m, st) {
  if (m.kind === 'system' || (prev && prev.kind === 'system')) return false;
  if (!prev || prev.user_id !== m.user_id) return false;
  if (prev.deleted_at || m.deleted_at) return false;
  if (dayKey(prev.created_at) !== dayKey(m.created_at)) return false;
  if (new Date(m.created_at) - new Date(prev.created_at) > COMPACT_WINDOW_MS) return false;
  if (st && m.id && m.id === st.unreadStartId) return false;
  return true;
}

function makeDayDivider(ts) {
  const el = tpl('tpl-day-divider');
  if (!el) return document.createDocumentFragment();
  const label = el.querySelector('.day-divider-label');
  if (label) label.textContent = dayLabel(ts);
  el.dataset.day = dayKey(ts);
  return el;
}

// Channel-lifecycle notes (created, renamed, made public/private, joined) —
// an ambient centred line, not a chat bubble: no avatar, no actions, and the
// full date/time printed inline.
function makeSystemEl(m) {
  const li = document.createElement('li');
  li.className = 'msg msg--system';
  li.dataset.id = m.id || '';
  const line = document.createElement('span');
  line.className = 'sys-line';
  const who = document.createElement('span');
  who.className = 'sys-who';
  who.textContent = userName(m.user_id);
  line.append(who, document.createTextNode(' ' + (m.body || '')));
  const time = document.createElement('time');
  time.className = 'sys-time';
  const d = new Date(m.created_at);
  time.dateTime = d.toISOString();
  time.textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  line.append(document.createTextNode(' · '), time);
  li.append(line);
  return li;
}

function makeMsgEl(m, prev, st) {
  if (m.kind === 'system') return makeSystemEl(m);
  const el = tpl('tpl-message');
  if (!el) return document.createDocumentFragment();
  const me = state.me;
  const own = me && m.user_id === me.id;
  const user = state.users.get(m.user_id);

  el.dataset.id = m.id || '';
  el.dataset.userId = m.user_id;
  if (m.client_id) el.dataset.clientId = m.client_id;
  el.classList.toggle('msg--own', !!own);
  el.classList.toggle('msg--bot', !!(user && user.is_bot)); // no DM-on-click affordance
  el.classList.toggle('msg--compact', isCompactWith(prev, m, st));
  el.classList.toggle('msg--deleted', !!m.deleted_at);
  el.classList.toggle('msg--pending', !!m.pending);
  el.classList.toggle('msg--failed', !!m.failed);
  if (st && m.id && m.id === st.unreadStartId) el.classList.add('msg--unread-start');

  applyAvatar(el.querySelector('.msg-avatar'),
    user || { display_name: userName(m.user_id), avatar_color: 0, avatar_url: '' });
  const author = el.querySelector('.msg-author');
  if (author) author.textContent = userName(m.user_id);
  const time = el.querySelector('.msg-time');
  if (time) {
    time.textContent = m.failed ? 'not sent' : fmtTime(m.created_at);
    time.title = new Date(m.created_at).toLocaleString();
  }
  const edited = el.querySelector('.msg-edited');
  if (edited) edited.hidden = !m.edited_at;

  const body = el.querySelector('.msg-body');
  if (body) {
    if (m.deleted_at) body.textContent = 'Message deleted';
    else renderFoldedBody(body, m);
  }

  const attWrap = el.querySelector('.msg-attachments');
  if (attWrap) {
    attWrap.hidden = m.deleted_at || !(m.attachments && m.attachments.length);
    if (!attWrap.hidden) {
      for (const att of m.attachments) attWrap.append(makeAttachmentEl(att));
    }
  }

  renderReactionsInto(el, m);

  const actions = el.querySelector('.msg-actions');
  if (actions) {
    actions.hidden = !!(m.deleted_at || m.pending || m.failed);
    const show = (sel, yes) => {
      const b = actions.querySelector(sel);
      if (b) b.hidden = !yes;
    };
    show('.msg-edit', own && !m.deleted_at);
    show('.msg-delete', (own || (me && me.is_admin)) && !m.deleted_at);
    show('.msg-react', !m.deleted_at);
    show('.msg-pin', !m.deleted_at);
    show('.msg-reply', !m.deleted_at && !!(m.body && m.body.trim()));
    show('.msg-copy', !m.deleted_at && !!(m.body && m.body.trim()));
    show('.msg-link', !m.deleted_at);
    // Filled star = pinned, like the mute bell's two-icon toggle.
    const pin = actions.querySelector('.msg-pin');
    if (pin) {
      setHidden(pin.querySelector('.star-plain'), !!m.pinned);
      setHidden(pin.querySelector('.star-filled'), !m.pinned);
      pin.title = m.pinned ? 'Unpin message' : 'Pin message';
      pin.setAttribute('aria-label', pin.title);
      pin.setAttribute('aria-pressed', m.pinned ? 'true' : 'false');
    }
  }
  el.classList.toggle('msg--pinned', !!m.pinned);

  if (m.failed) {
    // Kept on this device (the outbox) until it goes out or is discarded.
    const row = document.createElement('div');
    row.className = 'msg-failrow';
    const note = document.createElement('span');
    note.className = 'msg-failnote';
    note.textContent = m.refused
      ? `Not sent: ${m.error}`
      : 'Not sent yet — it will go out when you’re back online';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'msg-retry';
    retry.textContent = m.refused ? 'Retry' : 'Retry now';
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'msg-discard';
    discard.textContent = 'Discard';
    discard.title = 'Remove it (the text goes back into an empty message box)';
    row.append(note, retry, discard);
    (body ? body.parentElement : el).append(row);
  }
  return el;
}

// Messages longer than FOLD_AT characters render only their first FOLD_AT,
// with a "Show more" button under the body, so one giant paste doesn't take
// over the channel. Expanding is per message and lasts the session (a
// re-render for a reaction or pin must not fold it back).
const FOLD_AT = 10000;
const unfoldedMsgs = new Set(); // message ids / client ids the reader expanded

function msgKey(m) {
  return m.id ? 'id:' + m.id : 'c:' + m.client_id;
}

function renderFoldedBody(bodyEl, m) {
  const text = m.body || '';
  // Cheap guard first: a string of ≤ FOLD_AT UTF-16 units can't hold more
  // than FOLD_AT characters, so the common case never splits the string.
  if (text.length <= FOLD_AT || unfoldedMsgs.has(msgKey(m))) {
    renderBody(bodyEl, text);
    return;
  }
  const chars = [...text]; // code points, like the server's limit
  if (chars.length <= FOLD_AT) {
    renderBody(bodyEl, text);
    return;
  }
  // Cut at the last line break shortly before the limit, so markdown isn't
  // split mid-line; fall back to a hard cut for one enormous line.
  let shown = chars.slice(0, FOLD_AT).join('');
  const nl = shown.lastIndexOf('\n');
  if (nl > shown.length * 0.8) shown = shown.slice(0, nl);
  renderBody(bodyEl, shown + '…');

  const hidden = chars.length - [...shown].length;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'msg-more';
  more.textContent = `Show more (${hidden.toLocaleString()} more characters)`;
  bodyEl.after(more);
}

// Give an attachment <img> its box up front: its aspect ratio, and its natural
// width as a cap (small images are never upscaled). The CSS keeps the existing
// limits on top (420px wide, 340px tall, the column's width).
function sizeImageBox(img, w, h) {
  img.classList.add('att-img-el--sized');
  img.style.setProperty('--att-w', `${w}px`);
  img.style.setProperty('--att-ar', `${w} / ${h}`);
  img.style.setProperty('--att-r', String(w / h));
}

function makeAttachmentEl(att) {
  if (att.is_image) {
    const el = tpl('tpl-attachment-image');
    if (!el) return document.createDocumentFragment();
    el.dataset.attId = att.id;
    const img = el.querySelector('.att-img-el') || el.querySelector('img');
    if (img) {
      img.src = fileURL(att, att.has_thumb ? 'thumb' : 'original');
      img.alt = att.filename;
      img.loading = 'lazy';
      img.dataset.display = fileURL(att, att.has_display ? 'display' : 'original');
      img.dataset.original = fileURL(att, 'original');
      img.dataset.filename = att.filename;
      // Reserve the image's box before it loads (lazily, as it scrolls into
      // view): without a size it starts at zero height and every image that
      // arrives pushes the rows below it down — content shifting under the
      // reader, and the whole list repainted each time (seen in a trace while
      // scrolling back through a channel with pictures). The server knows the
      // dimensions; CSS (.att-img-el--sized) turns them into the same box the
      // loaded image would get.
      if (att.width > 0 && att.height > 0) sizeImageBox(img, att.width, att.height);
      img.addEventListener('load', () => {
        // Correct the reservation if the real picture disagrees (a photo whose
        // stored size ignores its rotation, say).
        if (img.naturalWidth && img.naturalHeight) sizeImageBox(img, img.naturalWidth, img.naturalHeight);
        if (state.atBottom) scrollToBottom();
      }, { once: true });
    }
    return el;
  }
  const el = tpl('tpl-attachment-file');
  if (!el) return document.createDocumentFragment();
  const name = el.querySelector('.att-file-name');
  if (name) name.textContent = att.filename;
  const meta = el.querySelector('.att-file-meta');
  if (meta) meta.textContent = formatBytes(att.size_bytes);
  const link = el.querySelector('.att-file-link');
  if (link) {
    link.href = fileURL(att, 'original');
    link.setAttribute('download', att.filename);
  }
  return el;
}

function renderReactionsInto(msgEl, m) {
  const wrap = msgEl.querySelector('.msg-reactions');
  if (!wrap) return;
  wrap.textContent = '';
  const reactions = (m.reactions || []).filter((r) => r.count > 0);
  wrap.hidden = !reactions.length || !!m.deleted_at;
  for (const r of reactions) {
    const btn = tpl('tpl-reaction');
    if (!btn) break;
    btn.dataset.emoji = r.emoji;
    const mine = !!(state.me && r.user_ids && r.user_ids.includes(state.me.id));
    btn.classList.toggle('reaction--mine', mine);
    const e = btn.querySelector('.reaction-emoji');
    if (e) e.textContent = r.emoji;
    const c = btn.querySelector('.reaction-count');
    if (c) c.textContent = r.count;
    btn.title = (r.user_ids || []).map(userName).join(', ');
    wrap.append(btn);
  }
}

// Let go of the long-pressed row (phones); see wireMessageList.
function clearHeldMsg() {
  const held = document.querySelector('#message-list .msg--held');
  if (held) held.classList.remove('msg--held');
}

function findMsgEl(m) {
  const list = byId('message-list');
  if (!list) return null;
  if (m.id) {
    const el = list.querySelector(`.msg[data-id="${m.id}"]`);
    if (el) return el;
  }
  if (m.client_id) {
    return list.querySelector(`.msg[data-client-id="${CSS.escape(m.client_id)}"]`);
  }
  return null;
}

// Re-render one message node in place (edit, delete, reconcile, reactions).
function refreshMsgEl(channelId, m) {
  if (channelId !== state.currentId) return;
  const st = chanState(channelId);
  const el = findMsgEl(m);
  if (!el) return;
  const idx = st.msgs.indexOf(m);
  const prev = idx > 0 ? st.msgs[idx - 1] : null;
  // Read before the swap: no scroll event has fired yet, so this is still the
  // pre-mutation answer.
  const wasAtBottom = state.atBottom;
  el.replaceWith(makeMsgEl(m, prev, st));
  // A first reaction, a pin badge or an edit makes the node taller. If the
  // reader was pinned to the bottom, follow the growth instead of cropping it.
  if (wasAtBottom) scrollToBottom();
}

function renderMessagesFull(channelId) {
  const list = byId('message-list');
  if (!list || channelId !== state.currentId) return;
  const st = chanState(channelId);
  list.textContent = '';
  const frag = document.createDocumentFragment();
  let prev = null;
  for (const m of st.msgs) {
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) {
      frag.append(makeDayDivider(m.created_at));
    }
    frag.append(makeMsgEl(m, prev, st));
    prev = m;
  }
  list.append(frag);
}

function appendMsgToDom(channelId, m, prev) {
  if (channelId !== state.currentId) return;
  const list = byId('message-list');
  if (!list) return;
  const st = chanState(channelId);
  if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) {
    list.append(makeDayDivider(m.created_at));
  }
  list.append(makeMsgEl(m, prev, st));
}

function scrollToBottom() {
  const sc = byId('message-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

function updateJumpLatest() {
  const btn = byId('jump-latest');
  if (!btn) return;
  const st = state.currentId ? chanState(state.currentId) : null;
  const n = st ? st.jumpCount : 0;
  // A detached window (after a far jump) always offers the way back, even
  // scrolled to its own end — the present is further on.
  const show = state.currentId != null && (!state.atBottom || st.hasNewer);
  btn.hidden = !show;
  if (show) btn.textContent = n > 0 ? `${n} new message${n === 1 ? '' : 's'} ↓` : 'Jump to latest ↓';
}

/* ============================================================ body tokeniser */

// Compact message formatting: escape-by-construction (DOM nodes, never HTML
// strings), links, **bold**, *italic* / _italic_, ~strike~, `code`,
// ```fences```, > quotes, @mentions. Newlines preserved.

const URL_RE = /^https?:\/\/[^\s<>"']+/;
const TRAIL_PUNCT = /[.,;:!?)\]}'"]+$/;

function matchMention(text, i) {
  // text[i] === '@'. Prefer the longest matching known display name.
  const rest = text.slice(i + 1, i + 64);
  const restLower = rest.toLowerCase();
  let best = null;
  for (const u of state.users.values()) {
    const n = (u.display_name || '').toLowerCase();
    if (!n || !restLower.startsWith(n)) continue;
    const after = rest[n.length];
    if (after && /[\w@]/.test(after)) continue; // must end at a boundary
    if (!best || n.length > best.len) best = { user: u, len: n.length };
  }
  if (best) return { text: '@' + rest.slice(0, best.len), user: best.user, len: best.len + 1 };
  const m = /^[A-Za-z0-9][\w.-]*/.exec(rest);
  if (m) return { text: '@' + m[0], user: null, len: m[0].length + 1 };
  return null;
}

// Whether a message body @-mentions the signed-in user. Mirrors renderInline's
// mention rules (same boundaries, same matchMention) so it agrees with what
// renders as .mention--me.
function mentionsMe(text) {
  if (!state.me || !text || !text.includes('@')) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    if (i !== 0 && !/[\s([{'">]/.test(text[i - 1])) continue;
    const mm = matchMention(text, i);
    if (mm && mm.user && mm.user.id === state.me.id) return true;
  }
  return false;
}

function renderInline(text, out) {
  let i = 0, buf = '';
  const flush = () => { if (buf) { out.append(document.createTextNode(buf)); buf = ''; } };
  const boundaryBefore = () => i === 0 || /[\s([{'">]/.test(text[i - 1]);

  while (i < text.length) {
    const ch = text[i];

    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes('\n')) {
        flush();
        const code = document.createElement('code');
        code.textContent = text.slice(i + 1, end);
        out.append(code);
        i = end + 1;
        continue;
      }
    }

    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i + 2 && !text.slice(i + 2, end).includes('\n')) {
        flush();
        const strong = document.createElement('strong');
        renderInline(text.slice(i + 2, end), strong);
        out.append(strong);
        i = end + 2;
        continue;
      }
    }

    if (ch === '~') {
      const end = text.indexOf('~', i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes('\n')) {
        flush();
        const del = document.createElement('del');
        renderInline(text.slice(i + 1, end), del);
        out.append(del);
        i = end + 1;
        continue;
      }
    }

    if (ch === '*') {
      const end = text.indexOf('*', i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes('\n')) {
        flush();
        const em = document.createElement('em');
        em.textContent = text.slice(i + 1, end);
        out.append(em);
        i = end + 1;
        continue;
      }
    }

    if (ch === '_' && boundaryBefore()) {
      const end = text.indexOf('_', i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes('\n')
        && (end + 1 >= text.length || /[\s.,;:!?)\]}'"]/.test(text[end + 1]))) {
        flush();
        const em = document.createElement('em');
        em.textContent = text.slice(i + 1, end);
        out.append(em);
        i = end + 1;
        continue;
      }
    }

    if (ch === '@' && boundaryBefore()) {
      const mm = matchMention(text, i);
      if (mm) {
        flush();
        const span = document.createElement('span');
        span.className = 'mention';
        if (mm.user && state.me && mm.user.id === state.me.id) span.classList.add('mention--me');
        if (mm.user) span.dataset.userId = mm.user.id; // clicking opens their DM
        span.textContent = mm.text;
        out.append(span);
        i += mm.len;
        continue;
      }
    }

    if (ch === 'h' && (text.startsWith('http://', i) || text.startsWith('https://', i))) {
      const m = URL_RE.exec(text.slice(i));
      if (m) {
        let url = m[0];
        const trail = TRAIL_PUNCT.exec(url);
        if (trail) url = url.slice(0, -trail[0].length);
        if (url.length > 8) {
          flush();
          const a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = url;
          out.append(a);
          i += url.length;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
}

// ```fences``` are matched anywhere in the body, not just at the start of a
// line — "text ```code``` more" is a code block mid-message, the way Slack and
// Discord treat it. A newline that only exists to separate a fence sitting on
// its own line from its neighbours is absorbed so the block does not gain a
// blank line; a fence glued to text ("teset ```…") keeps that text inline
// before it. An unclosed fence has no match and stays literal.
function renderBody(el, body) {
  el.textContent = '';
  const src = String(body);
  const fence = /```([\s\S]*?)```/g;
  let last = 0;
  let afterFence = false;
  let m;
  while ((m = fence.exec(src)) !== null) {
    let text = src.slice(last, m.index);
    if (afterFence) text = text.replace(/^\n/, '');
    text = text.replace(/\n$/, ''); // the newline that led into this fence
    if (text) renderTextBlock(el, text);
    appendCodeBlock(el, m[1]);
    last = fence.lastIndex;
    afterFence = true;
  }
  let tail = src.slice(last);
  if (afterFence) tail = tail.replace(/^\n/, '');
  if (tail || !afterFence) renderTextBlock(el, tail);
}

function appendCodeBlock(el, raw) {
  let text = raw;
  if (text.startsWith('\n')) {
    text = text.slice(1); // opening fence ended its line; content starts next
  } else {
    // A bare token glued to the fence then a newline is a language hint (```go)
    // and dropped; content glued on the same line (```1. do this) is kept.
    const info = text.match(/^([A-Za-z0-9+.#_-]+)\n/);
    if (info) text = text.slice(info[0].length);
  }
  text = text.replace(/\n$/, ''); // closing fence sat on its own line
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = text;
  pre.append(code);
  el.append(pre);
}

// One run of non-fenced text: `> ` quote groups and inline formatting, with
// newlines preserved as <br>.
function renderTextBlock(el, text) {
  const lines = text.split('\n');
  let i = 0;
  let lastWasText = false;
  while (i < lines.length) {
    if (/^>\s?/.test(lines[i])) {
      const bq = document.createElement('blockquote');
      let first = true;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        if (!first) bq.append(document.createElement('br'));
        renderInline(lines[i].replace(/^>\s?/, ''), bq);
        first = false;
        i++;
      }
      el.append(bq);
      lastWasText = false;
      continue;
    }
    if (lastWasText) el.append(document.createElement('br'));
    renderInline(lines[i], el);
    lastWasText = true;
    i++;
  }
}

/* ============================================================ channel / history */

const HISTORY_PAGE = 75;
const OLDER_PAGE = 100;
// How long a channel stops asking for older history after a failed page.
// Cleared outright on reconnect, so this only paces the still-broken case.
const OLDER_RETRY_MS = 30_000;

function addMessageToState(channelId, m) {
  const st = chanState(channelId);
  if (m.id && st.byId.has(m.id)) return null;
  st.msgs.push(m);
  if (m.id) st.byId.set(m.id, m);
  if (m.client_id) st.byClient.set(m.client_id, m);
  return m;
}

function newestRealId(st) {
  for (let i = st.msgs.length - 1; i >= 0; i--) {
    if (st.msgs[i].id) return st.msgs[i].id;
  }
  return 0;
}

async function loadHistory(channelId) {
  const st = chanState(channelId);
  const data = await api(`/api/channels/${channelId}/messages?limit=${HISTORY_PAGE}`);
  // Messages typed while offline have no server id yet — carry them over so a
  // (re)load never drops something the user is still trying to send. They belong
  // at the tail: they're the most recent thing in the channel.
  // Unsent messages parked while the view was detached (loadAround) come back
  // too — this is the live end again.
  const outbox = st.msgs.filter((m) => !m.id && m.client_id).concat(st.parked);
  st.msgs = [];
  st.byId = new Map();
  st.byClient = new Map();
  for (const m of data.messages) addMessageToState(channelId, m);
  for (const m of outbox) {
    if (!st.byClient.has(m.client_id)) addMessageToState(channelId, m);
  }
  st.loaded = true;
  st.stale = false;
  st.hasMore = !!data.has_more;
  st.hasNewer = false;
  st.parked = [];
  st.jumpCount = 0;
}

/* -------- a bounded message window.
   A long session must not keep every message it ever scrolled past in the
   page: layout and style work scale with it (a long channel's trace showed
   ~5,400 layout objects behind every keystroke). So:
   - back at the bottom, the list is trimmed to its newest KEEP_MSGS (the rest
     re-fetches if you scroll up again);
   - jumping to a message that isn't loaded fetches only a window around it
     (?around=), "detached" from the live end: older and newer pages load as
     you scroll, and reaching the newest page re-attaches it. */

const KEEP_MSGS = 150;
const AROUND_PAGE = 100;

// Drop all but the newest KEEP_MSGS real messages (unsent ones stay: they are
// the tail). Not while detached — the window is already bounded by paging.
// Returns whether anything was dropped; `render` redraws the open channel.
function trimOldMessages(channelId, render) {
  const st = chanState(channelId);
  if (!st.loaded || st.hasNewer) return false;
  let real = 0;
  let cut = -1;
  for (let i = st.msgs.length - 1; i >= 0; i--) {
    if (st.msgs[i].id && ++real > KEEP_MSGS) { cut = i; break; }
  }
  if (cut < 0) return false;
  for (const m of st.msgs.slice(0, cut + 1)) {
    st.byId.delete(m.id);
    if (m.client_id) st.byClient.delete(m.client_id);
  }
  st.msgs = st.msgs.slice(cut + 1);
  st.hasMore = true; // they're still on the server
  st.olderRetryAt = 0;
  if (render && channelId === state.currentId) {
    renderMessagesFull(channelId);
    scrollToBottom();
  }
  return true;
}

// Replace a channel's window with the messages around one message: the jump
// to something far back. Unsent messages are parked (they belong at the live
// end) unless the window turns out to reach it.
async function loadAround(channelId, msgId) {
  const st = chanState(channelId);
  const data = await api(`/api/channels/${channelId}/messages?around=${msgId}&limit=${AROUND_PAGE}`);
  st.parked = st.parked.concat(st.msgs.filter((m) => !m.id && m.client_id));
  st.msgs = [];
  st.byId = new Map();
  st.byClient = new Map();
  for (const m of data.messages) addMessageToState(channelId, m);
  for (const m of st.parked) st.byClient.set(m.client_id, m); // still retry and reconcile
  st.loaded = true;
  st.stale = false;
  st.hasMore = !!data.has_more;
  st.hasNewer = !!data.has_more_after;
  st.olderRetryAt = 0;
  st.newerRetryAt = 0;
  st.jumpCount = 0;
  if (!st.hasNewer) attachParked(channelId);
}

// The window reached the live end: unsent messages go back on the tail.
function attachParked(channelId) {
  const st = chanState(channelId);
  const parked = st.parked;
  st.parked = [];
  for (const m of parked) {
    if (m.id || st.msgs.includes(m)) continue;
    const prev = st.msgs[st.msgs.length - 1] || null;
    st.msgs.push(m);
    st.byClient.set(m.client_id, m);
    appendMsgToDom(channelId, m, prev);
  }
}

// Detached window: scrolling down loads the next newer page; the last one
// re-attaches the channel to the live end.
async function loadNewer(channelId) {
  const st = chanState(channelId);
  if (!st.loaded || !st.hasNewer || st.loadingNewer) return false;
  if (st.newerRetryAt && Date.now() < st.newerRetryAt) return false;
  const newest = newestRealId(st);
  if (!newest) return false;
  st.loadingNewer = true;
  try {
    const data = await api(`/api/channels/${channelId}/messages?after=${newest}&limit=${OLDER_PAGE}`, { toast: false });
    if (!st.hasNewer) return false; // returned to the present meanwhile
    for (const m of data.messages) {
      if (st.byId.has(m.id)) continue;
      const prev = st.msgs[st.msgs.length - 1] || null;
      addMessageToState(channelId, m);
      appendMsgToDom(channelId, m, prev);
    }
    st.newerRetryAt = 0;
    if (!data.has_more) {
      st.hasNewer = false;
      attachParked(channelId);
      updateJumpLatest();
      maybeMarkRead(); // now it's the real end
    }
    return data.messages.length > 0;
  } catch {
    st.newerRetryAt = Date.now() + OLDER_RETRY_MS;
    return false;
  } finally {
    st.loadingNewer = false;
  }
}

// Leave a detached window for the live end (Jump to latest, sending).
async function returnToLatest(channelId) {
  const st = chanState(channelId);
  try { await loadHistory(channelId); } catch { return false; }
  if (channelId === state.currentId) {
    placeUnreadDivider(channelId);
    renderMessagesFull(channelId);
    state.atBottom = true;
    scrollToBottom();
    updateJumpLatest();
    maybeMarkRead();
  }
  return !st.hasNewer;
}

// Position the "new messages" divider for the current visit from the live
// unread count. Called on every open so it never lingers as a stale leftover:
// no unread → no divider, and a fresh batch places it at the right message.
function placeUnreadDivider(channelId) {
  const st = chanState(channelId);
  const ch = state.channels.get(channelId);
  st.unreadStartId = null;
  // Counted back from the live end — meaningless in a detached window.
  if (ch && ch.unread_count > 0 && st.msgs.length && !st.hasNewer) {
    const idx = Math.max(0, st.msgs.length - ch.unread_count);
    st.unreadStartId = st.msgs[idx].id;
  }
}

async function loadOlder(channelId) {
  const st = chanState(channelId);
  if (st.loadingOlder || !st.hasMore || !st.loaded) return false;
  // Scrolling fires this constantly, so a failed page must not be retried on
  // the very next event — offline that means hundreds of doomed requests a
  // minute, each one flashing the loader.
  if (st.olderRetryAt && Date.now() < st.olderRetryAt) return false;
  const oldest = st.msgs.find((m) => m.id);
  if (!oldest) return false;
  st.loadingOlder = true;
  const loader = byId('message-loader');
  if (loader) loader.hidden = false;
  try {
    const data = await api(`/api/channels/${channelId}/messages?before=${oldest.id}&limit=${OLDER_PAGE}`);
    const fresh = data.messages.filter((m) => !st.byId.has(m.id));
    st.hasMore = !!data.has_more;
    if (fresh.length) {
      st.msgs = fresh.concat(st.msgs);
      for (const m of fresh) {
        st.byId.set(m.id, m);
        if (m.client_id) st.byClient.set(m.client_id, m);
      }
      prependToDom(channelId, fresh);
    }
    st.olderRetryAt = 0;
    return fresh.length > 0;
  } catch {
    // Older pages are deliberately not cached for offline reading, so this is
    // the expected outcome on a plane. Back off rather than give up: hasMore
    // stays true, because the history is still there and must be reachable
    // once the network is — a reconnect clears this immediately.
    st.olderRetryAt = Date.now() + OLDER_RETRY_MS;
    return false;
  } finally {
    st.loadingOlder = false;
    if (loader) loader.hidden = true;
  }
}

function prependToDom(channelId, msgs) {
  if (channelId !== state.currentId) return;
  const list = byId('message-list');
  const sc = byId('message-scroll');
  if (!list || !sc) return;

  // If the current first divider duplicates the day of the last prepended
  // message, it is now mid-day — drop it.
  const last = msgs[msgs.length - 1];
  const firstChild = list.firstElementChild;
  if (firstChild && firstChild.classList.contains('day-divider')
    && firstChild.dataset.day === dayKey(last.created_at)) {
    firstChild.remove();
  }

  const frag = document.createDocumentFragment();
  let prev = null;
  for (const m of msgs) {
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) {
      frag.append(makeDayDivider(m.created_at));
    }
    frag.append(makeMsgEl(m, prev, chanState(channelId)));
    prev = m;
  }

  const before = sc.scrollHeight;
  list.prepend(frag);
  sc.scrollTop += sc.scrollHeight - before; // preserve position exactly
}

async function gapFill(channelId) {
  const st = chanState(channelId);
  // A detached window has a deliberate hole up to the present; it fills by
  // scrolling down (loadNewer), not by stitching on from its newest message.
  if (!st.loaded || st.hasNewer) return;
  let lastId = newestRealId(st);
  if (!lastId) return;
  for (let round = 0; round < 3; round++) {
    let data;
    try {
      data = await api(`/api/channels/${channelId}/messages?after=${lastId}&limit=200`, { toast: false });
    } catch {
      return;
    }
    for (const m of data.messages) {
      if (st.byId.has(m.id)) continue;
      if (m.client_id && st.byClient.has(m.client_id)) {
        reconcilePending(channelId, m);
        continue;
      }
      const prev = st.msgs[st.msgs.length - 1] || null;
      addMessageToState(channelId, m);
      appendMsgToDom(channelId, m, prev);
      lastId = m.id;
    }
    if (!data.has_more || !data.messages.length) {
      st.stale = false;
      break;
    }
    lastId = data.messages[data.messages.length - 1].id;
    if (round === 2) {
      // Too far behind to stitch: start the channel over from its newest
      // page, so nothing in the middle is silently missing (and a read covers
      // the real newest message).
      try { await loadHistory(channelId); } catch { return; }
      if (channelId === state.currentId) renderMessagesFull(channelId);
    }
  }
  if (channelId === state.currentId && state.atBottom) scrollToBottom();
  maybeMarkRead();
}

// Whether the server knows of a message newer than any we hold for this
// channel: its last_message_at (from the channel list) is past our newest
// message's time. Messages can be missed without a reconnect ever showing —
// a stream that died silently while the machine slept — and reading a
// channel that is behind would mark read only up to what we hold, leaving the
// rest unread on the server (and back in the title on the next refresh).
function behindServer(ch, st) {
  if (!ch || !ch.last_message_at) return false;
  for (let i = st.msgs.length - 1; i >= 0; i--) {
    const m = st.msgs[i];
    if (m.id) return new Date(ch.last_message_at) > new Date(m.created_at);
  }
  return true; // nothing real held, yet the server has messages
}

// Every entry we create carries the channel it stands for, so popstate can
// restore one without parsing the URL. `guard` marks the throwaway entry the
// phone back button eats before it is allowed to leave the app.
function markHistory(channelId, replace, guard) {
  const entry = { slock: 1, c: channelId, guard: guard || undefined };
  const url = '/?c=' + channelId;
  if (replace) history.replaceState(entry, '', url);
  else history.pushState(entry, '', url);
}

async function openChannel(channelId, opts = {}) {
  channelId = Number(channelId);
  let ch = state.channels.get(channelId);
  if (!ch) {
    try {
      const data = await api(`/api/channels/${channelId}`);
      ch = mergeChannel(data.channel);
    } catch {
      return;
    }
  }
  const prevId = state.currentId;
  if (prevId) {
    saveDraftFor(prevId); // keep whatever was typed (edits included) —
    persistDrafts();      // also when re-opening the same channel
    if (prevId !== channelId) flushMarkRead(); // commit the read we are leaving
  }
  const fromLatest = state.latest;
  if (fromLatest) setLatestView(false);
  state.currentId = channelId;
  resetComposerMode();
  localStorage.setItem(LS.lastChannel, String(channelId));
  rememberInPalette({ t: 'c', id: channelId });
  // A real swap earns a history entry, so back walks the channels visited
  // (leaving Latest counts). Re-opening the same channel, or arriving from
  // popstate, must not.
  if (!opts.fromHistory) markHistory(channelId, !(prevId || fromLatest) || prevId === channelId);
  document.body.classList.remove('nav-open');
  closeEmojiPicker();
  closeHeaderMenu();

  renderSidebar();
  renderChannelHeader();
  updateBadges(); // what counts toward the title depends on what's open

  const st = chanState(channelId);
  // Not loaded, or a detached window opened plainly (not to jump somewhere):
  // load the live end.
  if (!st.loaded || (st.hasNewer && !opts.jumpTo)) {
    const loader = byId('message-loader');
    if (loader) loader.hidden = false;
    try {
      await loadHistory(channelId);
    } catch {
      // Offline with nothing cached for this channel. Don't leave the previous
      // channel's messages under the new title — that reads as if they belong
      // here. Show the channel empty (any unsent messages we're holding still
      // render); the offline banner already explains why there's no history.
      // st.loaded stays false, so a reconnect refetches for real.
      if (state.currentId === channelId) {
        renderMessagesFull(channelId);
        restoreDraft(channelId);
        updateJumpLatest();
      }
      return;
    } finally {
      if (loader) loader.hidden = true;
    }
  } else if (st.stale || ch.unread_count > 0 || behindServer(ch, st)) {
    // Catch up before showing (and marking read): unread messages we may not
    // hold, or newer ones the server has that we missed.
    await gapFill(channelId);
  }
  if (state.currentId !== channelId) return; // user moved on mid-load
  // Opening at the bottom: whatever piled up from scrolling back last time
  // goes, before it's drawn.
  if (!opts.jumpTo) trimOldMessages(channelId, false);

  st.jumpCount = 0;
  placeUnreadDivider(channelId); // fresh each visit, not a stale leftover
  renderMessagesFull(channelId);

  if (opts.jumpTo) {
    await jumpToMessage(channelId, opts.jumpTo);
  } else {
    state.atBottom = true;
    scrollToBottom();
  }
  updateJumpLatest();
  renderTyping();
  maybeMarkRead();
  restoreDraft(channelId);
  const input = byId('composer-input');
  if (input && !opts.noFocus && matchMedia('(min-width: 700px)').matches) input.focus();
}

async function jumpToMessage(channelId, msgId) {
  const st = chanState(channelId);
  if (!st.byId.has(msgId)) {
    // Not in the loaded window: fetch just its surroundings instead of paging
    // back through everything in between.
    try {
      await loadAround(channelId, msgId);
    } catch {
      scrollToBottom();
      return;
    }
    if (state.currentId !== channelId) return;
    placeUnreadDivider(channelId);
    renderMessagesFull(channelId);
  }
  const el = byId('message-list')
    && byId('message-list').querySelector(`.msg[data-id="${msgId}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center' });
    el.classList.add('msg--highlight');
    setTimeout(() => el.classList.remove('msg--highlight'), 2500);
    state.atBottom = false;
  } else {
    scrollToBottom();
  }
}

/* ============================================================ latest (meta-channel)
   "Latest" is one read-only feed of the newest messages from every channel and
   DM you're in. Each row is the message as its sender wrote it, clamped to
   three lines, with the channel named beside the avatar; clicking one opens it
   in its channel. It has no unread count, no notifications and no composer,
   and it is not a real channel: while it shows, state.currentId is null and
   state.latest is true. It is fetched fresh on every open and kept live by
   message.new while open; nothing maintains it in the background. */

const LATEST_PAGE = 50;
const latest = {
  msgs: [], byId: new Map(),
  loaded: false, hasMore: false, loading: false,
  retryAt: 0, // don't re-ask for older pages before this (see loadOlder)
  seq: 0,     // bumps on every fresh load; stale responses are dropped
};

// Device-local toggles, edited in the Latest details dialog.
let latestFavesOnly = false; // named channels: pinned ones only
let latestWithDMs = true;
try {
  latestFavesOnly = localStorage.getItem(LS.latestFaves) === '1';
  latestWithDMs = localStorage.getItem(LS.latestDMs) !== '0';
} catch { /* storage blocked: defaults */ }

function setLatestPrefs(favesOnly, withDMs) {
  latestFavesOnly = !!favesOnly;
  latestWithDMs = !!withDMs;
  try {
    if (latestFavesOnly) localStorage.setItem(LS.latestFaves, '1');
    else localStorage.removeItem(LS.latestFaves);
    if (!latestWithDMs) localStorage.setItem(LS.latestDMs, '0');
    else localStorage.removeItem(LS.latestDMs);
  } catch { /* in-memory only */ }
}

// Whether a message belongs in the feed under the current toggles (the server
// applies the same rules to what it returns; this is for live messages).
function latestWants(m) {
  if (!m || !m.id || m.kind === 'system' || m.deleted_at) return false;
  const ch = state.channels.get(m.channel_id);
  if (!ch) return false;
  if (ch.kind === 'dm') return latestWithDMs;
  return !!ch.is_member && (!latestFavesOnly || isChannelPinned(ch.id));
}

function latestURL(before) {
  const qs = new URLSearchParams({ limit: String(LATEST_PAGE) });
  if (!latestWithDMs) qs.set('dms', '0');
  if (latestFavesOnly) qs.set('only', [...pinnedChans].join(','));
  if (before) qs.set('before', String(before));
  return `/api/latest?${qs}`;
}

function setLatestView(on) {
  state.latest = on;
  document.body.classList.toggle('view-latest', on);
  const row = byId('latest-row');
  if (row) row.classList.toggle('chan--active', on);
  if (!on) {
    latest.seq++; // drop any page still in flight
    latest.loaded = false;
    latest.msgs = [];
    latest.byId = new Map();
  }
}

async function openLatest(opts = {}) {
  const prevId = state.currentId;
  const wasLatest = state.latest;
  if (prevId) {
    saveDraftFor(prevId);
    persistDrafts();
    flushMarkRead();
  }
  state.currentId = null;
  setLatestView(true);
  resetComposerMode();
  rememberInPalette({ t: 'latest' });
  // The composer is hidden here, but its text must not follow into the next
  // channel opened (restoreDraft only fills in a channel that has a draft).
  const ta = byId('composer-input');
  if (ta) { ta.value = ''; autogrow(); }
  try { localStorage.setItem(LS.lastChannel, 'latest'); } catch { /* fine */ }
  if (!opts.fromHistory) markHistory('latest', wasLatest || !prevId);
  document.body.classList.remove('nav-open');
  closeEmojiPicker();
  closeHeaderMenu();
  renderSidebar();
  renderChannelHeader();
  updateBadges();
  renderTyping();
  await loadLatest();
}

async function loadLatest() {
  const seq = ++latest.seq;
  const list = byId('message-list');
  if (list && !latest.loaded) list.textContent = ''; // never show the last channel under this title
  const loader = byId('message-loader');
  if (loader) loader.hidden = false;
  try {
    const data = await api(latestURL(0), { toast: false });
    if (seq !== latest.seq || !state.latest) return;
    latest.msgs = data.messages;
    latest.byId = new Map(data.messages.map((m) => [m.id, m]));
    latest.hasMore = !!data.has_more;
    latest.loaded = true;
    latest.retryAt = 0;
  } catch {
    // Offline or failing: an empty feed; the connection banner says why.
    if (seq !== latest.seq || !state.latest) return;
    latest.msgs = [];
    latest.byId = new Map();
    latest.hasMore = false;
    latest.loaded = false;
  } finally {
    if (loader) loader.hidden = true;
  }
  renderLatestFull();
  state.atBottom = true;
  scrollToBottom();
  updateJumpLatest();
}

async function loadOlderLatest() {
  if (!state.latest || !latest.loaded || latest.loading || !latest.hasMore) return;
  if (latest.retryAt && Date.now() < latest.retryAt) return;
  const oldest = latest.msgs[0];
  if (!oldest) return;
  const seq = latest.seq;
  latest.loading = true;
  const loader = byId('message-loader');
  if (loader) loader.hidden = false;
  try {
    const data = await api(latestURL(oldest.id), { toast: false });
    if (seq !== latest.seq || !state.latest) return;
    const fresh = data.messages.filter((m) => !latest.byId.has(m.id));
    latest.hasMore = !!data.has_more;
    if (fresh.length) {
      latest.msgs = fresh.concat(latest.msgs);
      for (const m of fresh) latest.byId.set(m.id, m);
      prependLatest(fresh);
    }
    latest.retryAt = 0;
  } catch {
    latest.retryAt = Date.now() + OLDER_RETRY_MS;
  } finally {
    latest.loading = false;
    if (loader) loader.hidden = true;
  }
}

const LATEST_ICON = {
  hash: '<path d="M7.7 3.5 6.2 16.5M13.8 3.5l-1.5 13M4 7.3h13M3 12.7h13"/>',
  lock: '<rect x="4.5" y="9" width="11" height="7.5" rx="1.8"/><path d="M7 9V6.8a3 3 0 0 1 6 0V9"/>',
  dm: '<path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5Z"/>',
  notes: '<path d="M5.5 2.5h7l3 3v11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z"/><path d="M7.5 9h5M7.5 12h5M7.5 15h3"/>',
};

// The channel a feed row came from, as a small tag leading the header line.
function makeLatestChanTag(ch) {
  const tag = document.createElement('span');
  tag.className = 'latest-chan';
  let icon = LATEST_ICON.hash;
  let label = ch.name;
  if (isNotesChannel(ch)) {
    icon = LATEST_ICON.notes;
    label = 'Notes';
    tag.classList.add('latest-chan--dm');
    tag.title = 'Your notes';
  } else if (ch.kind === 'dm') {
    const peer = state.users.get(ch.peer_user_id);
    icon = LATEST_ICON.dm;
    label = peer ? peer.display_name : 'Direct message';
    tag.classList.add('latest-chan--dm');
    tag.title = 'Direct message';
  } else if (ch.is_private) {
    icon = LATEST_ICON.lock;
  }
  // Static markup only; the name goes in as a text node.
  tag.innerHTML = `<svg class="ic" viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
  tag.append(document.createTextNode(label));
  return tag;
}

function makeLatestEl(m) {
  const el = makeMsgEl(m, null, null);
  if (!el.classList) return el; // template missing
  el.classList.add('msg--latest');
  el.tabIndex = 0;
  el.setAttribute('role', 'link');
  el.querySelector('.msg-actions')?.remove();
  el.querySelector('.msg-more')?.remove(); // the three-line clamp is the fold here
  el.querySelector('.msg-reactions')?.remove();
  // Attachments shrink to a one-line list of names: a feed, not a gallery.
  const att = el.querySelector('.msg-attachments');
  if (att) {
    att.textContent = '';
    const names = (m.attachments || []).map((a) => a.filename);
    att.hidden = !names.length;
    if (names.length) {
      att.classList.add('latest-files');
      att.textContent = names.join(', ');
    }
  }
  const ch = state.channels.get(m.channel_id);
  const head = el.querySelector('.msg-head');
  if (head && ch) head.prepend(makeLatestChanTag(ch));
  return el;
}

function renderLatestFull() {
  const list = byId('message-list');
  if (!list || !state.latest) return;
  list.textContent = '';
  const frag = document.createDocumentFragment();
  let prev = null;
  for (const m of latest.msgs) {
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) frag.append(makeDayDivider(m.created_at));
    frag.append(makeLatestEl(m));
    prev = m;
  }
  if (!latest.msgs.length && latest.loaded) {
    const empty = document.createElement('li');
    empty.className = 'latest-empty';
    empty.textContent = latestFavesOnly && !pinnedChans.size
      ? 'No pinned channels yet. Pin one from its header, or turn off “Pinned channels only” in details.'
      : 'Nothing here yet.';
    frag.append(empty);
  }
  list.append(frag);
}

function prependLatest(msgs) {
  const list = byId('message-list');
  const sc = byId('message-scroll');
  if (!list || !sc || !state.latest) return;
  const last = msgs[msgs.length - 1];
  const first = list.firstElementChild;
  if (first && first.classList.contains('day-divider') && first.dataset.day === dayKey(last.created_at)) {
    first.remove();
  }
  const frag = document.createDocumentFragment();
  let prev = null;
  for (const m of msgs) {
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) frag.append(makeDayDivider(m.created_at));
    frag.append(makeLatestEl(m));
    prev = m;
  }
  const before = sc.scrollHeight;
  list.prepend(frag);
  sc.scrollTop += sc.scrollHeight - before;
}

// Back at the bottom of Latest after scrolling far up: keep only the newest
// KEEP_MSGS rows, like a channel (older ones re-fetch on scrolling up).
function trimLatest() {
  if (!state.latest || latest.msgs.length <= KEEP_MSGS) return;
  for (const m of latest.msgs.slice(0, latest.msgs.length - KEEP_MSGS)) latest.byId.delete(m.id);
  latest.msgs = latest.msgs.slice(-KEEP_MSGS);
  latest.hasMore = true;
  latest.retryAt = 0;
  renderLatestFull();
  scrollToBottom();
}

// A live message.new while the feed is showing.
function appendLatest(m) {
  const list = byId('message-list');
  if (!list) return;
  const prev = latest.msgs[latest.msgs.length - 1] || null;
  latest.msgs.push(m);
  latest.byId.set(m.id, m);
  list.querySelector('.latest-empty')?.remove();
  if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) list.append(makeDayDivider(m.created_at));
  list.append(makeLatestEl(m));
  if (state.atBottom) scrollToBottom();
}

function latestElFor(id) {
  const list = byId('message-list');
  return list && list.querySelector(`.msg--latest[data-id="${id}"]`);
}

// message.update / message.delete for a row in the feed.
function latestOnUpdate(m) {
  if (!state.latest || !m) return;
  const local = latest.byId.get(m.id);
  if (!local) return;
  Object.assign(local, m);
  const el = latestElFor(m.id);
  if (el) el.replaceWith(makeLatestEl(local));
}

function latestOnDelete(id) {
  if (!state.latest || !latest.byId.has(id)) return;
  latest.byId.delete(id);
  latest.msgs = latest.msgs.filter((m) => m.id !== id);
  const el = latestElFor(id);
  if (el) el.remove();
}

function openLatestModal() {
  const m = openModal('tpl-modal-latest');
  if (!m) return;
  const faves = m.q('[name=faves_only]');
  const dms = m.q('[name=dms]');
  if (faves) faves.checked = latestFavesOnly;
  if (dms) dms.checked = latestWithDMs;
  const apply = () => {
    setLatestPrefs(faves ? faves.checked : latestFavesOnly, dms ? dms.checked : latestWithDMs);
    renderChannelHeader();
    if (state.latest) loadLatest();
  };
  on(faves, 'change', apply);
  on(dms, 'change', apply);
}

function latestSubtitle() {
  const what = latestFavesOnly ? 'pinned channels' : 'your channels';
  return latestWithDMs ? `Newest messages from ${what} and DMs` : `Newest messages from ${what}`;
}

// A pasted slock link ("…/?c=5&m=42") is just an <a> in a message body. Rather
// than open a second window, route same-origin channel links through the SPA:
// switch channel (and jump to the message) in place. Modifier/middle clicks and
// links to other origins fall through to the browser untouched.
function wireInternalLinks() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a) return;
    let u;
    try { u = new URL(a.href); } catch { return; }
    if (u.origin !== location.origin || (u.pathname !== '/' && u.pathname !== '')) return;
    const c = Number(u.searchParams.get('c'));
    if (!c) return; // a plain home link, not a channel deep link
    const m = Number(u.searchParams.get('m')) || 0;
    e.preventDefault();
    openChannel(c, m ? { jumpTo: m } : {});
  });
}

function renderChannelHeader() {
  const ch = state.channels.get(state.currentId);
  const title = byId('channel-title');
  const topic = byId('channel-topic');
  if (title) title.textContent = ch ? channelDisplayName(ch) : '';
  setHidden(byId('title-lock'), !(ch && ch.kind === 'channel' && ch.is_private));
  if (topic) {
    // Inline next to the title; hidden whenever there is nothing to show
    // (DMs never have a topic).
    const text = (ch && ch.kind === 'channel' && ch.topic) ? ch.topic.trim() : '';
    topic.textContent = text;
    topic.hidden = !text;
  }

  const isDM = ch && ch.kind === 'dm';
  const joinBtn = byId('join-btn');
  if (joinBtn) joinBtn.hidden = !ch || isDM || ch.is_member;
  const membersBtn = byId('members-btn');
  if (membersBtn) membersBtn.hidden = !ch || isDM;
  const muteBtn = byId('mute-btn');
  if (muteBtn) {
    const muted = isMuted(ch);
    muteBtn.hidden = !ch || !(isDM || ch.is_member);
    // Icon toggle: plain bell = notifying (click to mute), slashed bell = muted.
    setHidden(muteBtn.querySelector('.bell-plain'), muted);
    setHidden(muteBtn.querySelector('.bell-slash'), !muted);
    muteBtn.title = muted ? 'Unmute channel' : 'Mute channel';
    muteBtn.setAttribute('aria-label', muteBtn.title);
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }
  const pinsBtn = byId('pins-btn');
  if (pinsBtn) pinsBtn.hidden = !ch;
  const pinChanBtn = byId('pin-channel-btn');
  if (pinChanBtn) {
    // Pin-to-sidebar works for channels and DMs alike.
    pinChanBtn.hidden = !ch;
    const pinned = ch && isChannelPinned(ch.id);
    pinChanBtn.classList.toggle('is-on', !!pinned);
    pinChanBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    pinChanBtn.title = pinned ? 'Unpin from sidebar' : 'Pin to sidebar';
    pinChanBtn.setAttribute('aria-label', pinChanBtn.title);
  }
  const filesBtn = byId('files-btn');
  if (filesBtn) filesBtn.hidden = !ch; // any readable channel has history
  const infoBtn = byId('info-btn');
  if (infoBtn) infoBtn.hidden = !ch || isDM;
  const closeBtn = byId('close-dm-btn');
  if (closeBtn) closeBtn.hidden = !isDM;

  // Notes: nothing to mute (it never notifies), pin (it has its own row) or
  // close (ditto).
  if (isNotesChannel(ch)) {
    if (topic) { topic.textContent = 'Only you can see these'; topic.hidden = false; }
    for (const b of [muteBtn, pinChanBtn, closeBtn]) if (b) b.hidden = true;
  }

  // The Latest meta-channel: no channel behind it (every button above hid
  // itself), just a title, what it's showing, and details for its toggles.
  if (state.latest) {
    if (title) title.textContent = 'Latest';
    if (topic) { topic.textContent = latestSubtitle(); topic.hidden = false; }
    if (infoBtn) infoBtn.hidden = false;
  }
  if (infoBtn) {
    infoBtn.title = state.latest ? 'Latest details' : 'Channel details';
    infoBtn.setAttribute('aria-label', infoBtn.title);
  }
}

/* ============================================================ read state / badges */

function newestVisible() {
  // "newest message is visible" ≈ scrolled to (near) the bottom — of the live
  // end: the bottom of a detached window (after a far jump) is not it.
  const st = state.currentId ? chanState(state.currentId) : null;
  return state.atBottom && !(st && st.hasNewer);
}

// Marking read is debounced (so scrolling does not spam the endpoint), but the
// debounce must remember WHICH channel it was scheduled for: reading globals
// at fire time meant opening a channel and switching away within the window
// left the first one's read unsent, so the server kept counting it and the
// title stuck at "(1)" for a channel already read. markReadPending is that
// channel; flushMarkRead commits it now (called when leaving a channel).
let markReadTimer = 0;
let markReadPending = 0;

function sendMarkRead(channelId) {
  const ch = state.channels.get(channelId);
  if (!ch || !ch.is_member) return;
  const st = chanState(channelId);
  const lastId = newestRealId(st);
  if (!lastId) return;
  if (state.lastReadSent.get(channelId) === lastId && ch.unread_count === 0) return;
  state.lastReadSent.set(channelId, lastId);
  ch.unread_count = 0;
  mentionedChans.delete(channelId); // caught up: the mention no longer surfaces it
  // Caught up: drop the "new messages" divider so it doesn't linger once read.
  // Only the open channel has one in the DOM.
  if (st.unreadStartId) {
    st.unreadStartId = null;
    if (channelId === state.currentId) {
      const marker = byId('message-list') && byId('message-list').querySelector('.msg--unread-start');
      if (marker) marker.classList.remove('msg--unread-start');
    }
  }
  renderSidebar();
  updateBadges();
  readInflight.set(channelId, (readInflight.get(channelId) || 0) + 1);
  api(`/api/channels/${channelId}/read`, { method: 'POST', body: { last_message_id: lastId }, toast: false })
    .catch(() => state.lastReadSent.delete(channelId))
    .finally(() => {
      readInflight.set(channelId, Math.max(0, (readInflight.get(channelId) || 1) - 1));
      readDoneAt.set(channelId, Date.now());
    });
}

// Commit any pending read immediately — used when leaving a channel so a quick
// switch cannot swallow it.
function flushMarkRead() {
  if (!markReadTimer) return;
  clearTimeout(markReadTimer);
  markReadTimer = 0;
  const id = markReadPending;
  markReadPending = 0;
  if (id) sendMarkRead(id);
}

function maybeMarkRead() {
  const ch = state.channels.get(state.currentId);
  if (!ch || !ch.is_member) return;
  if (document.hidden || !document.hasFocus()) return;
  if (!newestVisible()) return;
  // A different channel is waiting to be marked: commit it before this one
  // takes the single timer slot.
  if (markReadPending && markReadPending !== ch.id) flushMarkRead();
  markReadPending = ch.id;
  clearTimeout(markReadTimer);
  markReadTimer = setTimeout(flushMarkRead, 700);
}

function totalUnread() {
  let n = 0;
  for (const ch of state.channels.values()) {
    if (isMuted(ch)) continue;
    if (ch.kind === 'channel' && !ch.is_member) continue;
    // Folded away and not surfaced (pinned, open, or mentioned): the user chose
    // to hide it, so it must not light the window title / app badge either.
    if (!visibleInSidebar(ch)) continue;
    n += ch.unread_count || 0;
  }
  return n;
}

// The window title reads "<workspace> - slock", so the app stays identifiable
// in a crowded taskbar whatever the workspace is called. A workspace actually
// named "slock" would render "slock - slock", so that case collapses to one.
const PRODUCT_NAME = 'slock';

function workspaceTitle() {
  const name = (state.workspace && state.workspace.name) || PRODUCT_NAME;
  return name === PRODUCT_NAME ? PRODUCT_NAME : `${name} - ${PRODUCT_NAME}`;
}

function updateBadges() {
  const n = totalUnread();
  const title = workspaceTitle();
  document.title = n > 0 ? `(${n}) ${title}` : title;
  if ('setAppBadge' in navigator) {
    (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
}

/* ============================================================ composer */

const typingSentAt = new Map(); // channelId -> ts

// A per-send idempotency key the server dedupes on. A real UUID, so two of the
// user's own devices can never mint the same key (a timestamp+counter could
// collide across tabs at the same millisecond). Falls back to random bytes
// where crypto.randomUUID is unavailable (very old / non-secure contexts).
function sendId() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); }
  catch { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Blur the composer if it holds focus, which closes the phone keyboard.
function dismissKeyboard() {
  const ta = byId('composer-input');
  if (ta && document.activeElement === ta) ta.blur();
}

// Where the browser can size a textarea to its content by itself (CSS
// `field-sizing: content`, see #composer-input), autogrow has nothing to do.
// Elsewhere it measures — and the measuring is the expensive part: collapsing
// the box to `auto` and reading its height forces a synchronous layout of the
// whole main column, message list included. So that only happens when the box
// might have to shrink (text got shorter) or has outgrown its height; plain
// typing within the current lines costs a cheap read.
const FIELD_SIZING = typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('field-sizing', 'content');
let autogrowLen = 0;

function autogrow() {
  if (FIELD_SIZING) return;
  const ta = byId('composer-input');
  if (!ta) return;
  const grew = ta.value.length >= autogrowLen;
  autogrowLen = ta.value.length;
  if (grew && ta.style.height && ta.scrollHeight <= ta.clientHeight) return; // still fits
  ta.style.height = 'auto';
  const max = Math.floor(innerHeight * 0.4);
  ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  // Only scroll once the cap is hit; a fitting textarea showing a scrollbar
  // (which mobile browsers love to paint) just looks broken.
  ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
}

/* -------- drafts: survive channel switches, reloads and deploys.
   localStorage `slock:drafts` maps channelId -> {text, edit_id?}. */

// The server's message limit, in characters (code points, like Go's runes).
// Drafts are never cut to it: a draft over the limit is still the user's text,
// and send refuses it with a count instead of losing any of it.
const MSG_MAX = 40000;
let drafts = {};
try { drafts = JSON.parse(localStorage.getItem(LS.drafts) || '{}') || {}; } catch { drafts = {}; }

function persistDrafts() {
  if (state.channels.size) {
    for (const key of Object.keys(drafts)) {
      if (!state.channels.has(Number(key))) delete drafts[key]; // prune gone channels
    }
  }
  try { localStorage.setItem(LS.drafts, JSON.stringify(drafts)); } catch { /* storage full */ }
}

// Snapshot the composer into the draft map for `channelId` (the channel the
// composer text belongs to — call BEFORE the composer is cleared).
function saveDraftFor(channelId) {
  if (!channelId) return;
  const ta = byId('composer-input');
  if (!ta) return;
  const text = ta.value;
  if (!text.trim() && !state.editingId) {
    delete drafts[channelId];
  } else {
    const d = { text };
    if (state.editingId) d.edit_id = state.editingId;
    drafts[channelId] = d;
  }
}

// A channel has a draft: text typed and not sent, or an edit left open.
function hasDraft(channelId) {
  const d = channelId && drafts[channelId];
  return !!(d && ((d.text || '').trim() || d.edit_id));
}

// The draft's opening words, on one line, for the palette.
function draftSnippet(channelId) {
  const text = ((drafts[channelId] && drafts[channelId].text) || '').replace(/\s+/g, ' ').trim();
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

const queueDraftSave = debounce(() => {
  saveDraftFor(state.currentId);
  persistDrafts();
}, 300);

// Restore the draft for a freshly opened channel. A saved edit becomes an
// edit again when the message is still around; otherwise the text degrades
// to a plain draft rather than being lost.
function restoreDraft(channelId) {
  const ta = byId('composer-input');
  const d = drafts[channelId];
  if (!ta || !d) return;
  if (d.edit_id) {
    const st = chanState(channelId);
    const m = st.byId.get(d.edit_id);
    if (m && !m.deleted_at && state.me && m.user_id === state.me.id) {
      startEdit(d.edit_id);
      ta.value = d.text || '';
      autogrow();
      return;
    }
    delete d.edit_id; // message gone (deleted or out of reach) — keep the text
  }
  ta.value = d.text || '';
  autogrow();
}

/* -------- composer edit mode */

let editPrevText = ''; // what the composer held before ↑ / .msg-edit

// The single exit from edit mode / composer state; every path (Esc, cancel
// button, save, channel switch) funnels through here.
function resetComposerMode() {
  state.editingId = null;
  editPrevText = '';
  const ta = byId('composer-input');
  const form = byId('composer');
  if (form) delete form.dataset.editing;
  const bar = byId('composer-mode');
  if (bar) bar.hidden = true;
  if (ta) {
    if (ta.dataset.origPlaceholder !== undefined) ta.placeholder = ta.dataset.origPlaceholder;
    ta.value = '';
    autogrow();
  }
}

function startEdit(msgId) {
  const st = chanState(state.currentId);
  const m = st.byId.get(msgId);
  if (!m || !state.me || m.user_id !== state.me.id || m.deleted_at) return;
  const ta = byId('composer-input');
  const form = byId('composer');
  if (!ta) return;
  if (!state.editingId) editPrevText = ta.value; // keep what they were typing
  state.editingId = msgId;
  if (form) form.dataset.editing = String(msgId);
  const bar = byId('composer-mode');
  if (bar) {
    const label = bar.querySelector('.composer-mode-label');
    if (label) label.textContent = 'Editing message';
    bar.hidden = false;
  }
  if (ta.dataset.origPlaceholder === undefined) ta.dataset.origPlaceholder = ta.placeholder || '';
  ta.placeholder = 'Editing message — Enter to save, Esc to cancel';
  ta.value = m.body;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  autogrow();
}

function cancelEdit() {
  const prev = editPrevText;
  const channelId = state.currentId;
  resetComposerMode();
  const ta = byId('composer-input');
  if (ta) {
    ta.value = prev;
    autogrow();
    ta.focus();
  }
  if (channelId) {
    if (prev.trim()) drafts[channelId] = { text: prev };
    else delete drafts[channelId];
    persistDrafts();
  }
}

// .msg-reply: quote the message into the composer as `> ` lines — a quote is
// the whole reply story here, there is no threading.
function quoteReply(msgId) {
  if (state.editingId) return; // never splice a quote into an edit
  const st = chanState(state.currentId);
  const m = st.byId.get(msgId);
  if (!m || m.deleted_at || !m.body || !m.body.trim()) return;
  const ta = byId('composer-input');
  if (!ta) return;
  // The quote goes on top, whatever was already typed stays below it as the
  // reply — the reading order of a quoted answer.
  const quote = m.body.split('\n').map((l) => '> ' + l).join('\n') + '\n';
  ta.value = quote + ta.value;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length); // carry on at the end
  autogrow();
  queueDraftSave();
}

function editLastOwnMessage() {
  if (!state.currentId || !state.me) return;
  const st = chanState(state.currentId);
  for (let i = st.msgs.length - 1; i >= 0; i--) {
    const m = st.msgs[i];
    if (m.user_id === state.me.id && m.id && !m.deleted_at) {
      startEdit(m.id);
      return;
    }
  }
}

async function submitComposer() {
  const ta = byId('composer-input');
  if (!ta || !state.currentId) return;
  closeEmojiAuto();
  const body = replaceShortcodes(ta.value.replace(/\s+$/, ''));

  // Refuse up front, text untouched, rather than letting the server bounce it
  // into a failed message. Counted in code points, as the server does.
  const length = [...body].length;
  if (length > MSG_MAX) {
    toast(`Message is too long: ${length.toLocaleString()} / ${MSG_MAX.toLocaleString()} characters`, true);
    return;
  }

  if (state.editingId) {
    const id = state.editingId;
    const editChannelId = state.currentId;
    if (!body) { cancelEdit(); return; }
    cancelEdit(); // restores the pre-edit composer text
    try {
      const data = await api(`/api/messages/${id}`, { method: 'PATCH', body: { body } });
      applyMessageUpdate(data.message);
    } catch {
      // Toasted by api(); make sure the edited text is never lost.
      drafts[editChannelId] = { text: body, edit_id: id };
      persistDrafts();
      if (state.currentId === editChannelId && !state.editingId) {
        startEdit(id);
        const ta2 = byId('composer-input');
        if (ta2) { ta2.value = body; autogrow(); }
      }
    }
    return;
  }

  const uploading = trayItems.some((t) => t.status === 'uploading');
  if (uploading) { toast('Hold on — uploads still in progress'); return; }
  const done = trayItems.filter((t) => t.status === 'done');
  const attachmentIds = done.map((t) => t.attachment.id);
  if (!body && !attachmentIds.length) return;

  // Sending from a detached window (after a far jump): the message belongs at
  // the live end, so go there first. Offline that can fail — then nothing is
  // sent and the text stays in the box.
  if (chanState(state.currentId).hasNewer) {
    const back = await returnToLatest(state.currentId);
    if (!back) {
      toast('Can\u2019t reach the latest messages right now — your message is still in the box', true);
      return;
    }
  }

  const channelId = state.currentId;
  const st = chanState(channelId);
  const clientId = sendId();
  const msg = {
    id: 0, channel_id: channelId, user_id: state.me.id, body,
    created_at: new Date().toISOString(), edited_at: null, deleted_at: null,
    attachments: done.map((t) => t.attachment), reactions: [],
    client_id: clientId, pending: true,
  };
  const prev = st.msgs[st.msgs.length - 1] || null;
  addMessageToState(channelId, msg);
  appendMsgToDom(channelId, msg, prev);
  state.atBottom = true;
  scrollToBottom();
  ta.value = '';
  autogrow();
  clearTray(done);
  outboxAdd(msg); // durable before the draft goes: there is always a copy on disk
  delete drafts[channelId]; // the outbox holds it now
  persistDrafts();

  postMessage_(channelId, msg);
}

/* -------- outbox: sent messages the server hasn't confirmed yet.
   localStorage `slock:outbox` holds each message from the moment it's sent
   until the server confirms it (POST response or SSE echo). A reload, a
   crash, or hours on a plane can't lose one: boot puts them back in their
   channel as "not sent", and the next connection sends them. Sends are
   idempotent on client_id, so resending one that did get through is harmless.
   Every write is read-modify-write, so several tabs never clobber each other.
   It is never sent anywhere but the normal send endpoint — no server-side
   scratchpad. */

function readOutbox() {
  try {
    const v = JSON.parse(localStorage.getItem(LS.outbox) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function writeOutbox(list) {
  try {
    if (list.length) localStorage.setItem(LS.outbox, JSON.stringify(list));
    else localStorage.removeItem(LS.outbox);
  } catch { /* storage full or blocked: the in-memory copy still retries */ }
}

function outboxAdd(m) {
  const list = readOutbox().filter((e) => e.client_id !== m.client_id);
  list.push({
    user_id: m.user_id, channel_id: m.channel_id, client_id: m.client_id,
    body: m.body, attachments: m.attachments || [], created_at: m.created_at,
  });
  writeOutbox(list);
}

function outboxRemove(clientId) {
  const list = readOutbox();
  const next = list.filter((e) => e.client_id !== clientId);
  if (next.length !== list.length) writeOutbox(next);
}

// Boot: put this user's unconfirmed messages back in their channels as "not
// sent". The first SSE hello (a reconnect from nothing) then sends them.
// Entries for a channel this user can no longer see stay on disk untouched.
function restoreOutbox() {
  if (!state.me) return;
  for (const e of readOutbox()) {
    if (!e || !e.client_id || e.user_id !== state.me.id || !state.channels.has(e.channel_id)) continue;
    const st = chanState(e.channel_id);
    if (st.byClient.has(e.client_id)) continue;
    addMessageToState(e.channel_id, {
      id: 0, channel_id: e.channel_id, user_id: e.user_id, body: e.body || '',
      created_at: e.created_at || new Date().toISOString(), edited_at: null, deleted_at: null,
      attachments: e.attachments || [], reactions: [], client_id: e.client_id,
      failed: true,
    });
  }
}

// Drop an optimistic copy for good (discarded, or superseded by the server's).
function dropLocalMsg(channelId, m) {
  const st = chanState(channelId);
  st.msgs = st.msgs.filter((x) => x !== m);
  if (m.client_id) st.byClient.delete(m.client_id);
  if (channelId === state.currentId) {
    const el = findMsgEl(m);
    if (el) el.remove();
  }
}

// "Discard" on an unsent message. The words aren't thrown away: an empty
// composer gets them back, so discarding is "take it back", not "lose it".
function discardUnsent(channelId, clientId) {
  const m = chanState(channelId).byClient.get(clientId);
  if (!m || m.id) return;
  outboxRemove(clientId);
  dropLocalMsg(channelId, m);
  const ta = byId('composer-input');
  if (ta && channelId === state.currentId && !state.editingId && !ta.value.trim() && m.body) {
    ta.value = m.body;
    autogrow();
    queueDraftSave();
    ta.focus();
  }
}

// While connected, a send that failed on a blip retries on its own every so
// often, not just on the next reconnect (which may never come if the stream
// stayed up).
const OUTBOX_RETRY_MS = 20_000;
let outboxRetryTimer = 0;
function scheduleOutboxRetry() {
  if (outboxRetryTimer) return;
  outboxRetryTimer = setTimeout(() => {
    outboxRetryTimer = 0;
    if (state.connected) flushOutbox();
  }, OUTBOX_RETRY_MS);
}

function postMessage_(channelId, msg) {
  api(`/api/channels/${channelId}/messages`, {
    method: 'POST',
    toast: false,
    body: {
      body: msg.body,
      attachment_ids: msg.attachments.map((a) => a.id),
      client_id: msg.client_id,
    },
  }).then((data) => {
    reconcilePending(channelId, data.message);
    const ch = state.channels.get(channelId);
    if (ch && !ch.is_member) { ch.is_member = true; renderSidebar(); renderChannelHeader(); }
  }).catch((err) => {
    // The POST response can be lost on a flaky link even though the server got
    // it and the message.new SSE frame already reconciled us (msg.id set). Only
    // a truly unsent message is a failure.
    if (msg.id) return;
    msg.failed = true;
    msg.pending = false;
    // No network, or a server hiccup (5xx, a proxy's 502): it goes out by
    // itself once things recover — no toast, the row says so. A refusal (4xx:
    // no longer allowed there, too long…) won't fix itself; it waits for the
    // user's Retry or Discard, and stays in the outbox until then.
    msg.refused = err.code !== 'network' && err.status >= 400 && err.status < 500;
    msg.error = msg.refused ? (err.message || 'The server refused it') : '';
    refreshMsgEl(channelId, msg);
    if (msg.refused) toast(`Message not sent: ${msg.error}`, true);
    else scheduleOutboxRetry();
  });
}

function retrySend(channelId, clientId) {
  const st = chanState(channelId);
  const m = st.byClient.get(clientId);
  if (!m || m.id) return;
  m.failed = false;
  m.refused = false;
  m.pending = true;
  refreshMsgEl(channelId, m);
  postMessage_(channelId, m);
}

// Re-send every unsent message across every channel, oldest first: on
// reconnect, and periodically while connected. Refused ones wait for the
// user. retrySend skips any that the SSE echo has meanwhile reconciled (they
// have an id now), so this is safe to call anytime.
function flushOutbox() {
  for (const [channelId, st] of state.chan) {
    for (const m of st.msgs.concat(st.parked)) {
      if (m.failed && !m.refused && !m.id && m.client_id) retrySend(channelId, m.client_id);
    }
  }
}

// Reconcile the optimistic copy with the server message (from the POST echo
// or the message.new SSE frame — whichever lands first wins, the other no-ops).
function reconcilePending(channelId, serverMsg) {
  // Confirmed by the server: it no longer needs a copy on disk, whichever
  // tab or path saw the confirmation first.
  if (serverMsg.client_id) outboxRemove(serverMsg.client_id);
  const st = chanState(channelId);
  const local = serverMsg.client_id && st.byClient.get(serverMsg.client_id);
  if (local && st.parked.includes(local)) {
    // Parked while the view is detached: it's sent now. Let it go; the real
    // message shows up with the newer pages like any other.
    st.parked = st.parked.filter((x) => x !== local);
    st.byClient.delete(local.client_id);
    return;
  }
  if (serverMsg.id && st.byId.has(serverMsg.id)) {
    // The server's copy is already showing (history loaded after a reload
    // carries no client_id): the restored optimistic copy is a duplicate.
    if (local && !local.id) dropLocalMsg(channelId, local);
    return;
  }
  if (!local) return;
  Object.assign(local, serverMsg, { pending: false, failed: false });
  st.byId.set(local.id, local);
  refreshMsgEl(channelId, local);
  maybeMarkRead();
}

function sendTyping() {
  const ch = state.channels.get(state.currentId);
  if (!ch || !ch.is_member || state.editingId) return;
  const now = Date.now();
  if ((typingSentAt.get(ch.id) || 0) > now - 3000) return;
  typingSentAt.set(ch.id, now);
  api(`/api/channels/${ch.id}/typing`, { method: 'POST', toast: false }).catch(() => {});
}

/* -------- typing indicator (incoming) */

let typingTimer = 0;

function noteTyping(channelId, userId) {
  if (state.me && userId === state.me.id) return;
  let m = state.typing.get(channelId);
  if (!m) { m = new Map(); state.typing.set(channelId, m); }
  m.set(userId, Date.now() + 5000);
  renderTyping();
}

function renderTyping() {
  const el = byId('typing-indicator');
  if (!el) return;
  const m = state.typing.get(state.currentId);
  const now = Date.now();
  const names = [];
  if (m) {
    for (const [uid, exp] of m) {
      if (exp <= now) m.delete(uid);
      else names.push(userName(uid));
    }
  }
  // The element stays in flow with its line height reserved (see CSS), so
  // only the text toggles — never [hidden] — and the layout never jumps.
  el.hidden = false;
  const many = 'Several people are typing…';
  el.textContent = !names.length ? ''
    : names.length === 1 ? `${names[0]} is typing…`
      : names.length <= 5 ? `${names.join(', ')} are typing…`
        : many;
  // One line, never a scrollbar: a list too wide for it gives way to the
  // summary (a single long name just ellipsizes, see CSS).
  if (names.length > 1 && el.scrollWidth > el.clientWidth) el.textContent = many;
  clearTimeout(typingTimer);
  if (names.length) typingTimer = setTimeout(renderTyping, 1000);
}

/* ============================================================ uploads */

const trayItems = []; // {file, status: uploading|done|error, attachment?, xhr?, node}

function renderTrayVisibility() {
  const tray = byId('attachment-tray');
  if (tray) tray.hidden = trayItems.length === 0;
  // The tray growing or shrinking resizes the message area; a reader pinned
  // to the bottom must not have the last messages slide out of view.
  if (state.atBottom) scrollToBottom();
}

function setTrayProgress(item, pct, label) {
  const p = item.node && item.node.querySelector('.tray-item-progress');
  if (!p) return;
  if (p.tagName === 'PROGRESS') {
    p.max = 100;
    p.value = pct;
  } else {
    p.textContent = label !== undefined ? label : pct + '%';
  }
}

function addFiles(files) {
  const tray = byId('attachment-tray');
  for (const file of files) {
    const node = tpl('tpl-tray-item');
    if (!node) return;
    const name = node.querySelector('.tray-item-name');
    if (name) {
      name.textContent = file.name;
      name.title = `${file.name} (${formatBytes(file.size)})`;
    }
    const item = { file, status: 'uploading', node };
    node.addEventListener('click', (e) => {
      if (e.target.closest('.tray-item-remove')) {
        if (item.xhr && item.status === 'uploading') item.xhr.abort();
        const i = trayItems.indexOf(item);
        if (i >= 0) trayItems.splice(i, 1);
        node.remove();
        renderTrayVisibility();
      } else if (item.status === 'error') {
        uploadItem(item); // click a failed item to retry
      }
    });
    trayItems.push(item);
    if (tray) tray.append(node);
    uploadItem(item);
  }
  renderTrayVisibility();
}

function uploadItem(item) {
  item.status = 'uploading';
  item.node.classList.remove('tray-item--error');
  setTrayProgress(item, 0);
  const fd = new FormData();
  fd.append('file', item.file);
  const xhr = new XMLHttpRequest();
  item.xhr = xhr;
  xhr.open('POST', '/api/uploads');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) setTrayProgress(item, Math.round((e.loaded / e.total) * 100));
  };
  xhr.onload = () => {
    if (xhr.status === 201) {
      try {
        item.attachment = JSON.parse(xhr.responseText).attachment;
        item.status = 'done';
        item.node.classList.add('tray-item--done'); // CSS hides the spent bar
        return;
      } catch { /* fall through */ }
    }
    if (xhr.status === 401) { location.href = '/login.html'; return; }
    let msg = 'Upload failed';
    try { msg = JSON.parse(xhr.responseText).message || msg; } catch { /* ignore */ }
    item.status = 'error';
    item.node.classList.add('tray-item--error');
    setTrayProgress(item, 0, 'failed — click to retry');
    toast(`${item.file.name}: ${msg}`, true);
  };
  xhr.onerror = () => {
    item.status = 'error';
    item.node.classList.add('tray-item--error');
    setTrayProgress(item, 0, 'failed — click to retry');
  };
  xhr.send(fd);
}

function clearTray(items) {
  for (const item of items) {
    const i = trayItems.indexOf(item);
    if (i >= 0) trayItems.splice(i, 1);
    item.node.remove();
  }
  renderTrayVisibility();
}

function wireUploads() {
  on(byId('attach-btn'), 'click', () => {
    const fi = byId('file-input');
    if (fi) fi.click();
  });
  on(byId('file-input'), 'change', (e) => {
    if (e.target.files && e.target.files.length) addFiles([...e.target.files]);
    e.target.value = '';
  });

  const dropZone = byId('main') || byId('message-scroll');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
    });
    dropZone.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }
    });
  }

  on(byId('composer-input'), 'paste', (e) => {
    const files = e.clipboardData && [...e.clipboardData.files];
    if (files && files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
}

/* ============================================================ reactions / emoji picker */

// [char, name, ...aliases]. Deliberately curated rather than the full Unicode
// set: ~330 rows is a few KB and covers what people actually type, where the
// complete list is 1900 rows and ~100KB of payload for emoji nobody reaches
// for. The first REACTION_COUNT rows are the reaction picker's grid, so their
// order is load-bearing; everything after is search-only.
const EMOJI = [
  // — the reaction grid, in grid order —
  ['👍', 'thumbsup', '+1', 'like', 'yes'],
  ['❤️', 'heart', 'love', 'red_heart'],
  ['😂', 'joy', 'lol', 'laugh'],
  ['😮', 'open_mouth', 'wow', 'surprised'],
  ['😢', 'cry', 'sad'],
  ['😡', 'rage', 'angry', 'mad'],
  ['🎉', 'tada', 'party', 'celebrate'],
  ['🚀', 'rocket', 'ship', 'launch'],
  ['👀', 'eyes', 'look', 'see', 'watching'],
  ['✅', 'white_check_mark', 'check', 'done', 'tick'],
  ['❌', 'x', 'cross', 'no', 'fail'],
  ['🙏', 'pray', 'thanks', 'please'],
  ['👏', 'clap', 'applause'],
  ['🔥', 'fire', 'lit', 'hot'],
  ['💯', '100', 'hundred', 'perfect'],
  ['😅', 'sweat_smile', 'phew'],
  ['😊', 'blush', 'smile_blush'],
  ['😍', 'heart_eyes'],
  ['🤔', 'thinking', 'hmm'],
  ['😉', 'wink'],
  ['😎', 'sunglasses', 'cool'],
  ['🤣', 'rofl', 'rolling'],
  ['😭', 'sob', 'crying'],
  ['😴', 'sleeping', 'zzz'],
  ['🤯', 'exploding_head', 'mindblown'],
  ['🥳', 'partying', 'celebration'],
  ['😱', 'scream'],
  ['🤝', 'handshake', 'deal'],
  ['💪', 'muscle', 'strong', 'flex'],
  ['☕', 'coffee'],
  ['🍕', 'pizza'],
  ['🍺', 'beer'],
  ['⭐', 'star'],
  ['⚡', 'zap', 'lightning'],
  ['🐛', 'bug'],
  ['🧠', 'brain'],
  ['💡', 'bulb', 'idea', 'light'],
  ['📌', 'pushpin', 'pin'],
  ['🎯', 'dart', 'target', 'bullseye'],
  ['🫡', 'salute'],
  ['🤷', 'shrug'],

  // — faces —
  ['😀', 'grinning'], ['😃', 'smiley'], ['😄', 'smile', 'happy'],
  ['😁', 'grin'], ['😆', 'laughing'], ['🙂', 'slight_smile'],
  ['🙃', 'upside_down'], ['😇', 'innocent', 'halo'], ['🥰', 'smiling_hearts'],
  ['🤩', 'star_struck'], ['😘', 'kissing_heart', 'kiss'], ['😗', 'kissing'],
  ['😋', 'yum', 'tasty'], ['😛', 'tongue_out'], ['😜', 'winking_tongue'],
  ['🤪', 'zany', 'crazy'], ['🤑', 'money_mouth'], ['🤗', 'hugs'],
  ['🤭', 'hand_over_mouth', 'oops'], ['🤫', 'shushing', 'quiet'],
  ['🤐', 'zipper_mouth'], ['🤨', 'raised_eyebrow'], ['😐', 'neutral'],
  ['😑', 'expressionless'], ['😶', 'no_mouth'], ['😏', 'smirk'],
  ['😒', 'unamused', 'meh'], ['🙄', 'roll_eyes'], ['😬', 'grimacing'],
  ['🤥', 'lying'], ['😌', 'relieved'], ['😔', 'pensive'],
  ['😪', 'sleepy'], ['🤤', 'drooling'], ['😷', 'mask'],
  ['🤒', 'sick', 'thermometer_face'], ['🤕', 'head_bandage'],
  ['🤢', 'nauseated'], ['🤮', 'vomiting'], ['🤧', 'sneezing'],
  ['🥵', 'hot_face'], ['🥶', 'cold_face'], ['🥴', 'woozy'],
  ['😵', 'dizzy_face'], ['🤠', 'cowboy'], ['🤓', 'nerd'],
  ['🧐', 'monocle'], ['😕', 'confused'], ['😟', 'worried'],
  ['🙁', 'slight_frown'], ['😯', 'hushed'], ['😲', 'astonished'],
  ['😳', 'flushed'], ['🥺', 'pleading'], ['😦', 'frowning'],
  ['😨', 'fearful'], ['😰', 'anxious'], ['😖', 'confounded'],
  ['😞', 'disappointed'], ['😓', 'sweat'], ['😩', 'weary'],
  ['😫', 'tired'], ['🥱', 'yawning'], ['😤', 'triumph', 'huff'],
  ['😠', 'angry'], ['🤬', 'cursing', 'swearing'], ['😈', 'smiling_imp'],
  ['👿', 'imp'], ['💀', 'skull'], ['☠️', 'skull_crossbones'],
  ['💩', 'poop'], ['🤡', 'clown'], ['👻', 'ghost'],
  ['👽', 'alien'], ['🤖', 'robot', 'bot'], ['🎃', 'jack_o_lantern'],
  ['🫠', 'melting'], ['🫣', 'peeking'], ['🥹', 'holding_back_tears'],

  // — hands & body —
  ['👋', 'wave', 'hello', 'hi'], ['🤚', 'raised_back_of_hand'],
  ['✋', 'raised_hand', 'stop'], ['🖖', 'vulcan', 'spock'],
  ['👌', 'ok_hand'], ['🤏', 'pinching'], ['✌️', 'victory', 'peace'],
  ['🤞', 'crossed_fingers', 'luck'], ['🤟', 'love_you'],
  ['🤘', 'metal', 'horns'], ['🤙', 'call_me', 'shaka'],
  ['👈', 'point_left'], ['👉', 'point_right'], ['👆', 'point_up'],
  ['👇', 'point_down'], ['✊', 'fist'], ['👊', 'punch', 'fist_bump'],
  ['🙌', 'raised_hands', 'praise'], ['👐', 'open_hands'],
  ['🤲', 'palms_up'], ['✍️', 'writing'], ['💅', 'nail_polish'],
  ['🦾', 'mechanical_arm'], ['👁️', 'eye'], ['👅', 'tongue'],
  ['👄', 'lips'], ['🦵', 'leg'], ['🦶', 'foot'], ['👂', 'ear'],
  ['👃', 'nose'], ['🦷', 'tooth'], ['🫀', 'anatomical_heart'],

  // — hearts & marks —
  ['🧡', 'orange_heart'], ['💛', 'yellow_heart'], ['💚', 'green_heart'],
  ['💙', 'blue_heart'], ['💜', 'purple_heart'], ['🖤', 'black_heart'],
  ['🤍', 'white_heart'], ['🤎', 'brown_heart'], ['💔', 'broken_heart'],
  ['💕', 'two_hearts'], ['💞', 'revolving_hearts'], ['💓', 'heartbeat'],
  ['💖', 'sparkling_heart'], ['💘', 'cupid'], ['💝', 'gift_heart'],
  ['💢', 'anger'], ['💥', 'boom', 'explosion'], ['💫', 'dizzy'],
  ['💦', 'sweat_drops'], ['💨', 'dash'], ['✨', 'sparkles', 'shiny'],
  ['🌟', 'star2', 'glowing_star'], ['💤', 'zzz_sleep'],

  // — animals & nature —
  ['🐶', 'dog'], ['🐱', 'cat'], ['🐭', 'mouse'], ['🐹', 'hamster'],
  ['🐰', 'rabbit'], ['🦊', 'fox'], ['🐻', 'bear'], ['🐼', 'panda'],
  ['🐨', 'koala'], ['🐯', 'tiger'], ['🦁', 'lion'], ['🐮', 'cow'],
  ['🐷', 'pig'], ['🐸', 'frog'], ['🐵', 'monkey'],
  ['🙈', 'see_no_evil'], ['🙉', 'hear_no_evil'], ['🙊', 'speak_no_evil'],
  ['🐔', 'chicken'], ['🐧', 'penguin'], ['🐦', 'bird'], ['🦆', 'duck'],
  ['🦉', 'owl'], ['🦄', 'unicorn'], ['🐝', 'bee'], ['🦋', 'butterfly'],
  ['🐌', 'snail'], ['🐙', 'octopus'], ['🦀', 'crab'], ['🐬', 'dolphin'],
  ['🐳', 'whale'], ['🐟', 'fish'], ['🐢', 'turtle'], ['🐍', 'snake'],
  ['🦖', 'dinosaur', 't_rex'], ['🐘', 'elephant'], ['🐴', 'horse'],
  ['🐑', 'sheep'], ['🐺', 'wolf'], ['🦔', 'hedgehog'], ['🦥', 'sloth'],
  ['🌵', 'cactus'], ['🌲', 'evergreen_tree'], ['🌳', 'tree'],
  ['🌴', 'palm_tree'], ['🌱', 'seedling'], ['🌿', 'herb'],
  ['🍀', 'four_leaf_clover', 'luck_clover'], ['🍁', 'maple_leaf'],
  ['🌸', 'cherry_blossom'], ['🌺', 'hibiscus'], ['🌻', 'sunflower'],
  ['🌹', 'rose'], ['🌷', 'tulip'], ['💐', 'bouquet'],
  ['🌍', 'earth', 'globe', 'world'], ['🌙', 'crescent_moon'],
  ['☀️', 'sun', 'sunny'], ['⛅', 'partly_sunny'], ['☁️', 'cloud'],
  ['🌧️', 'rain'], ['❄️', 'snowflake'], ['⛄', 'snowman'],
  ['🌈', 'rainbow'], ['💧', 'droplet'], ['🌊', 'ocean', 'wave_water'],
  ['🌞', 'sun_face'], ['🌚', 'new_moon_face'],

  // — food & drink —
  ['🍵', 'tea'], ['🍻', 'beers', 'cheers'], ['🍷', 'wine'],
  ['🍸', 'cocktail'], ['🥂', 'champagne'], ['🍾', 'bottle_pop'],
  ['🥤', 'cup_straw'], ['🍔', 'burger', 'hamburger'], ['🍟', 'fries'],
  ['🌭', 'hotdog'], ['🌮', 'taco'], ['🌯', 'burrito'],
  ['🍿', 'popcorn'], ['🍩', 'doughnut', 'donut'], ['🍪', 'cookie'],
  ['🍫', 'chocolate'], ['🍬', 'candy'], ['🎂', 'birthday', 'cake'],
  ['🧁', 'cupcake'], ['🍎', 'apple'], ['🍌', 'banana'],
  ['🍓', 'strawberry'], ['🍇', 'grapes'], ['🍉', 'watermelon'],
  ['🍒', 'cherries'], ['🥑', 'avocado'], ['🥐', 'croissant'],
  ['🍞', 'bread'], ['🧀', 'cheese'], ['🥓', 'bacon'],
  ['🍳', 'cooking', 'egg'], ['🍜', 'ramen', 'noodles'], ['🍣', 'sushi'],
  ['🧊', 'ice_cube'], ['🥗', 'salad'], ['🍦', 'ice_cream'],

  // — activity & travel —
  ['🎊', 'confetti'], ['🎁', 'gift', 'present'], ['🏆', 'trophy', 'win'],
  ['🥇', 'first_place', 'gold'], ['🥈', 'second_place'], ['🥉', 'third_place'],
  ['🏅', 'medal'], ['⚽', 'soccer'], ['🏀', 'basketball'],
  ['🏈', 'football'], ['⚾', 'baseball'], ['🎾', 'tennis'],
  ['🎮', 'video_game', 'gaming'], ['🎲', 'dice'], ['🎸', 'guitar'],
  ['🎧', 'headphones'], ['🎵', 'musical_note', 'music'],
  ['🎤', 'microphone'], ['🎬', 'clapper', 'movie'], ['🎨', 'art', 'palette'],
  ['📷', 'camera'], ['🏃', 'runner', 'running'], ['🚴', 'cyclist'],
  ['🧘', 'yoga', 'meditate'], ['🏊', 'swimmer'], ['⛷️', 'skier'],
  ['✈️', 'airplane', 'plane'], ['🚗', 'car'], ['🚕', 'taxi'],
  ['🚌', 'bus'], ['🚲', 'bicycle', 'bike'], ['🛴', 'scooter'],
  ['🚂', 'train'], ['🚁', 'helicopter'], ['⛵', 'sailboat'],
  ['🚢', 'boat'], ['🏠', 'house', 'home'], ['🏢', 'office'],
  ['🗼', 'tower'], ['🏝️', 'desert_island'], ['🏔️', 'mountain'],
  ['🚦', 'traffic_light'], ['🗺️', 'map'],

  // — objects & tech —
  ['💻', 'computer', 'laptop'], ['🖥️', 'desktop'], ['⌨️', 'keyboard'],
  ['🖱️', 'mouse_computer'], ['🖨️', 'printer'], ['📱', 'phone', 'mobile'],
  ['📞', 'phone_receiver', 'call'], ['🔋', 'battery'], ['🔌', 'plug'],
  ['💾', 'floppy_disk', 'save'], ['💿', 'cd'], ['📺', 'tv'],
  ['📻', 'radio'], ['⏰', 'alarm_clock'], ['⏱️', 'stopwatch'],
  ['⏳', 'hourglass'], ['🕐', 'clock'], ['📅', 'calendar', 'date'],
  ['📈', 'chart_up', 'graph'], ['📉', 'chart_down'], ['📊', 'bar_chart', 'stats'],
  ['📋', 'clipboard'], ['📍', 'round_pushpin', 'location'],
  ['📎', 'paperclip'], ['📏', 'ruler'], ['✂️', 'scissors'],
  ['🗑️', 'wastebasket', 'trash'], ['🔒', 'lock', 'locked'],
  ['🔓', 'unlock', 'unlocked'], ['🔑', 'key'], ['🔨', 'hammer'],
  ['🛠️', 'tools'], ['🔧', 'wrench'], ['🔩', 'nut_and_bolt'],
  ['⚙️', 'gear', 'settings'], ['🧰', 'toolbox'], ['🧲', 'magnet'],
  ['🧪', 'test_tube'], ['🧬', 'dna'], ['🔬', 'microscope'],
  ['🔭', 'telescope'], ['📡', 'satellite'], ['🔦', 'flashlight'],
  ['🕯️', 'candle'], ['🧯', 'fire_extinguisher'], ['🛡️', 'shield'],
  ['🚪', 'door'], ['🛏️', 'bed'], ['🧹', 'broom'], ['🔮', 'crystal_ball'],
  ['🎈', 'balloon'], ['🧸', 'teddy_bear'], ['📦', 'package', 'box'],
  ['📫', 'mailbox'], ['✉️', 'envelope', 'email', 'mail'],
  ['📤', 'outbox'], ['📥', 'inbox'], ['📜', 'scroll'],
  ['📄', 'page', 'document', 'doc'], ['📑', 'bookmark_tabs'],
  ['📚', 'books'], ['📖', 'book'], ['📝', 'memo', 'note'],
  ['✏️', 'pencil'], ['🖊️', 'pen'], ['🔍', 'mag', 'search'],
  ['💰', 'moneybag'], ['💸', 'money_wings'], ['💵', 'dollar'],
  ['💳', 'credit_card'], ['🧾', 'receipt'], ['⚖️', 'balance_scale'],
  ['🔗', 'link'], ['⛓️', 'chains'], ['🧱', 'bricks'],
  ['💎', 'gem', 'diamond'], ['🏷️', 'label', 'tag'],

  // — symbols —
  ['☑️', 'ballot_box_with_check'], ['✔️', 'heavy_check_mark'],
  ['⭕', 'o', 'circle'], ['🚫', 'no_entry_sign', 'forbidden'],
  ['⛔', 'no_entry'], ['⚠️', 'warning', 'caution'],
  ['🚧', 'construction', 'wip'], ['❗', 'exclamation'],
  ['❓', 'question'], ['‼️', 'bangbang'], ['⁉️', 'interrobang'],
  ['♻️', 'recycle'], ['🔄', 'refresh', 'arrows_counterclockwise'],
  ['⬆️', 'arrow_up'], ['⬇️', 'arrow_down'], ['⬅️', 'arrow_left'],
  ['➡️', 'arrow_right'], ['↩️', 'arrow_hook'], ['🔙', 'back'],
  ['🔜', 'soon'], ['🆕', 'new'], ['🆗', 'ok'], ['🆘', 'sos'],
  ['🔝', 'top'], ['➕', 'plus'], ['➖', 'minus'], ['➗', 'divide'],
  ['♾️', 'infinity'], ['🔢', 'numbers'], ['🔵', 'blue_circle'],
  ['🔴', 'red_circle'], ['🟢', 'green_circle'], ['🟡', 'yellow_circle'],
  ['🟠', 'orange_circle'], ['🟣', 'purple_circle'], ['⚫', 'black_circle'],
  ['⚪', 'white_circle'], ['🟥', 'red_square'], ['🟩', 'green_square'],
  ['🟦', 'blue_square'], ['🔶', 'orange_diamond'], ['🔺', 'red_triangle_up'],
  ['🔻', 'red_triangle_down'],
];

// How many leading rows the reaction picker shows, so its grid stays the
// curated set it has always been rather than the whole search corpus.
const REACTION_COUNT = 40;

// name -> row, for the `:shortcode:` pass on send.
const EMOJI_BY_NAME = (() => {
  const m = new Map();
  for (const row of EMOJI) {
    for (const name of row.slice(1)) if (!m.has(name)) m.set(name, row);
  }
  return m;
})();

let emojiPickerEl = null;

function buildEmojiPicker() {
  const el = document.createElement('div');
  el.className = 'emoji-picker';
  el.setAttribute('role', 'menu');
  for (const [char, name] of EMOJI.slice(0, REACTION_COUNT)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-picker-item';
    b.textContent = char;
    b.title = ':' + name + ':';
    el.append(b);
  }
  return el;
}

function closeEmojiPicker() {
  if (emojiPickerEl) {
    emojiPickerEl.remove();
    emojiPickerEl = null;
  }
}

/* -------- `:name` and `@person` autocomplete in the composer

   Typing `:eyes` offers matching emoji; Enter/Tab or a click inserts one.
   Matching is prefix-first, then substring — deliberately not the palette's
   fuzzy scorer, which on short shortcodes surfaces surprises (`:ey` matching
   "monkey") where people expect the obvious answer at the top.
   Typing `@` offers people the same way (channel members first); picking one
   inserts `@Display Name`, which is what renders and notifies as a mention —
   and, in a channel, brings someone who is not in it yet in. */

const EMOJI_AUTO_MAX = 8;

// A `:word` token immediately left of the caret. The leading (^|\s) anchor is
// what keeps `http://`, `10:30` and `ratio:2` from ever opening the popup.
function emojiTokenAt(ta) {
  if (!ta || ta.selectionStart !== ta.selectionEnd) return null;
  const left = ta.value.slice(0, ta.selectionStart);
  const m = left.match(/(?:^|\s)(:([a-z0-9_+-]{2,}))$/i);
  if (!m) return null;
  return { start: ta.selectionStart - m[1].length, query: m[2].toLowerCase() };
}

// An `@name` token left of the caret, with the same "starts a word" rule as
// rendered mentions. Spaces are allowed ("@bob sm" still finds Bob Smith):
// the popup closes once nobody matches.
function mentionTokenAt(ta) {
  if (!ta || ta.selectionStart !== ta.selectionEnd) return null;
  const left = ta.value.slice(0, ta.selectionStart);
  const m = left.match(/(?:^|[\s([{'">])(@([^\n@`]{0,40}))$/);
  if (!m) return null;
  return { start: ta.selectionStart - m[1].length, query: m[2].toLowerCase() };
}

// People for an `@` query: name prefix before a later word's prefix, members of
// the open channel before everyone else. Not yourself, not bots.
function mentionMatches(query) {
  const ch = state.channels.get(state.currentId);
  if (ch && ch.kind === 'channel' && !ch.members) loadMembersForMentions(ch);
  const members = ch && ch.kind === 'channel' && ch.members ? new Set(ch.members) : null;
  const rows = [];
  for (const u of state.users.values()) {
    if (u.is_bot || (state.me && u.id === state.me.id)) continue;
    const name = (u.display_name || '').toLowerCase();
    let rank;
    if (name.startsWith(query)) rank = 0;
    else if (name.split(/\s+/).some((w) => w.startsWith(query))) rank = 1;
    else continue;
    const outside = !!members && !members.has(u.id);
    rows.push({ u, outside, key: (outside ? 2 : 0) + rank });
  }
  rows.sort((a, b) => a.key - b.key || a.u.display_name.localeCompare(b.u.display_name));
  return rows.slice(0, EMOJI_AUTO_MAX);
}

// The channel list carries no member ids; fetch them once, the first time `@`
// is typed in a channel, and redo the popup with members first.
function loadMembersForMentions(ch) {
  if (ch.membersLoading) return;
  ch.membersLoading = true;
  api(`/api/channels/${ch.id}`, { toast: false }).then((data) => {
    ch.members = data.channel.members || [];
    if (emojiAuto && emojiAuto.kind === 'mention' && state.currentId === ch.id) refreshEmojiAuto();
  }).catch(() => {}).finally(() => { ch.membersLoading = false; });
}

function emojiMatches(query) {
  const starts = [];
  const contains = [];
  for (const row of EMOJI) {
    let best = -1;
    for (let i = 1; i < row.length; i++) {
      const name = row[i];
      if (name.startsWith(query)) { best = 0; break; }
      if (best < 0 && name.includes(query)) best = 1;
    }
    if (best === 0) starts.push(row);
    else if (best === 1) contains.push(row);
    if (starts.length >= EMOJI_AUTO_MAX) break; // enough exact-ish answers
  }
  return starts.concat(contains).slice(0, EMOJI_AUTO_MAX);
}

// Horizontal offset of a character index inside a textarea, in pixels from its
// left edge. There is no API for this, so lay the text out in a hidden mirror
// with the same metrics and read the marker's position — which gets soft-
// wrapped lines right, where measuring the text since the last newline would
// put the popup far off to the right.
function caretOffsetX(ta, index) {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'whiteSpace',
    'overflowWrap', 'wordBreak', 'tabSize', 'boxSizing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) {
    mirror.style[p] = cs[p];
  }
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', top: '0', left: '0',
    width: ta.offsetWidth + 'px', height: 'auto',
  });
  mirror.textContent = ta.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = '​'; // zero width: measured, never drawn
  mirror.append(marker);
  document.body.append(mirror);
  const x = marker.offsetLeft;
  mirror.remove();
  return x;
}

// Park the popup under the `:` being typed, clamped so it never runs past the
// composer's right edge.
function placeEmojiAuto() {
  const ta = byId('composer-input');
  const host = byId('composer');
  if (!emojiAuto || !ta || !host) return;
  const x = caretOffsetX(ta, emojiAuto.start) - ta.scrollLeft;
  const taLeft = ta.getBoundingClientRect().left - host.getBoundingClientRect().left;
  const max = host.clientWidth - emojiAuto.el.offsetWidth;
  emojiAuto.el.style.insetInlineStart = Math.max(0, Math.min(taLeft + x, max)) + 'px';
}

let emojiAuto = null; // { el, kind: 'emoji' | 'mention', rows, active, start }

function closeEmojiAuto() {
  if (!emojiAuto) return;
  emojiAuto.el.remove();
  emojiAuto = null;
}

function paintEmojiAuto() {
  [...emojiAuto.el.children].forEach((li, i) => {
    li.classList.toggle('emoji-auto-item--active', i === emojiAuto.active);
  });
}

// Rebuild (or close) the popup for whatever the caret sits on now.
function refreshEmojiAuto() {
  const ta = byId('composer-input');
  let tok = emojiTokenAt(ta);
  let kind = 'emoji';
  if (!tok) {
    tok = mentionTokenAt(ta);
    kind = 'mention';
  }
  if (!tok) { closeEmojiAuto(); return; }
  const rows = kind === 'emoji' ? emojiMatches(tok.query) : mentionMatches(tok.query);
  if (!rows.length) { closeEmojiAuto(); return; }
  if (emojiAuto && emojiAuto.kind !== kind) emojiAuto.active = 0;

  if (!emojiAuto) {
    const el = document.createElement('ul');
    el.className = 'emoji-auto';
    el.setAttribute('role', 'listbox');
    // mousedown, not click: the composer must never lose focus, or the caret
    // position we are about to splice into is gone.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const li = e.target.closest('.emoji-auto-item');
      if (li) insertEmojiAt(Number(li.dataset.i));
    });
    (byId('composer') || document.body).append(el);
    emojiAuto = { el, kind, rows: [], active: 0, start: tok.start };
  }
  emojiAuto.kind = kind;
  emojiAuto.rows = rows;
  emojiAuto.start = tok.start;
  emojiAuto.active = Math.min(emojiAuto.active, rows.length - 1);

  emojiAuto.el.textContent = '';
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    li.className = 'emoji-auto-item';
    li.dataset.i = i;
    li.setAttribute('role', 'option');
    const n = document.createElement('span');
    n.className = 'emoji-auto-name';
    if (kind === 'emoji') {
      const c = document.createElement('span');
      c.className = 'emoji-auto-char';
      c.textContent = row[0];
      n.textContent = ':' + row[1];
      li.append(c, n);
    } else {
      const av = document.createElement('span');
      av.className = 'avatar emoji-auto-avatar';
      av.setAttribute('aria-hidden', 'true');
      const ini = document.createElement('span');
      ini.className = 'avatar-initials';
      const img = document.createElement('img');
      img.className = 'avatar-img';
      img.alt = '';
      img.hidden = true;
      av.append(ini, img);
      applyAvatar(av, row.u);
      n.textContent = row.u.display_name;
      li.append(av, n);
      if (row.outside) {
        // Mentioning them here adds them to the channel (server side).
        const note = document.createElement('span');
        note.className = 'emoji-auto-note';
        note.textContent = 'not in channel';
        li.append(note);
      }
    }
    emojiAuto.el.append(li);
  });
  paintEmojiAuto();
  placeEmojiAuto(); // after fill: clamping needs the popup's real width
}

// Replace the typed `:token` with the emoji, leaving a trailing space.
function insertEmojiAt(i) {
  const ta = byId('composer-input');
  if (!ta || !emojiAuto) return;
  const row = emojiAuto.rows[i];
  if (!row) return;
  const text = emojiAuto.kind === 'emoji' ? row[0] : '@' + row.u.display_name;
  const start = emojiAuto.start;
  const rest = ta.value.slice(ta.selectionStart);
  ta.value = ta.value.slice(0, start) + text + ' ' + rest;
  const caret = start + text.length + 1;
  closeEmojiAuto();
  ta.focus();
  ta.setSelectionRange(caret, caret);
  autogrow();
  queueDraftSave();
}

// Claim the keys the popup owns while it is open, before the composer's own
// Enter/ArrowUp bindings see them. Returns true when the key was consumed.
function emojiAutoKey(e) {
  if (!emojiAuto) return false;
  switch (e.key) {
    case 'ArrowDown':
      emojiAuto.active = (emojiAuto.active + 1) % emojiAuto.rows.length;
      paintEmojiAuto();
      return true;
    case 'ArrowUp':
      emojiAuto.active = (emojiAuto.active - 1 + emojiAuto.rows.length) % emojiAuto.rows.length;
      paintEmojiAuto();
      return true;
    case 'Enter':
    case 'Tab':
      if (e.shiftKey && e.key === 'Tab') return false;
      insertEmojiAt(emojiAuto.active);
      return true;
    case 'Escape':
      closeEmojiAuto();
      return true;
    default:
      return false;
  }
}

// `:eyes:` -> 👀 on send, for people who type shortcodes from muscle memory.
// Only whole, whitespace-delimited tokens with an exact name, so prose like
// "ratio 3:2:1" and inline `code` are left alone.
function replaceShortcodes(text) {
  return text.replace(/(^|\s):([a-z0-9_+-]{2,}):(?=\s|$)/gi, (all, pre, name) => {
    const row = EMOJI_BY_NAME.get(name.toLowerCase());
    return row ? pre + row[0] : all;
  });
}

// target: a .msg element (react to it) or the composer form (insert emoji).
function openEmojiPicker(anchor, onPick) {
  closeEmojiPicker();
  emojiPickerEl = buildEmojiPicker();
  emojiPickerEl.addEventListener('click', (e) => {
    const b = e.target.closest('.emoji-picker-item');
    if (!b) return;
    onPick(b.textContent);
    closeEmojiPicker();
  });
  anchor.append(emojiPickerEl);
  // Default is above the anchor; flip below when that would crop past the
  // top of the viewport (reacting to the first visible messages).
  if (emojiPickerEl.getBoundingClientRect().top < 8) {
    emojiPickerEl.classList.add('emoji-picker--below');
  }
  const first = emojiPickerEl.querySelector('button');
  if (first) first.focus();
}

function toggleReaction(msgId, emoji) {
  const st = chanState(state.currentId);
  const m = st.byId.get(msgId);
  if (!m) return;
  const existing = (m.reactions || []).find((r) => r.emoji === emoji);
  const mine = !!(existing && state.me && existing.user_ids && existing.user_ids.includes(state.me.id));

  // Optimistic local flip; the reaction SSE frame is authoritative.
  if (mine) {
    existing.count--;
    existing.user_ids = existing.user_ids.filter((id) => id !== state.me.id);
  } else if (existing) {
    existing.count++;
    (existing.user_ids = existing.user_ids || []).push(state.me.id);
  } else {
    m.reactions = m.reactions || [];
    m.reactions.push({ emoji, count: 1, user_ids: [state.me.id], mine: true });
  }
  refreshMsgEl(state.currentId, m);

  api(`/api/messages/${msgId}/reactions/${encodeURIComponent(emoji)}`, {
    method: mine ? 'DELETE' : 'PUT',
  }).catch(() => {});
}

/* ============================================================ lightbox */

// The gallery is whatever sibling images surround the one that was clicked:
// every image in the message list, or every thumbnail in the files modal.
let lightboxItems = [];
let lightboxIndex = -1;

function openLightbox(img) {
  const scope = img.closest('#message-list') || img.closest('.files-list');
  lightboxItems = scope ? [...scope.querySelectorAll('img[data-display]')] : [img];
  showLightboxAt(Math.max(0, lightboxItems.indexOf(img)));
}

// A phone (touch, no hover): the viewer shows the full-resolution original
// straight away and pinch-zoom does the zooming; there is no tap-to-zoom.
function isTouchDevice() {
  return matchMedia('(hover: none) and (pointer: coarse)').matches;
}

// Pinch-zoom is off for the app (the viewport meta caps the scale at 1, and
// CSS touch-action blocks the gesture on everything but the image viewer).
// Opening an image lifts the cap; closing restores it, which also snaps any
// zoom back to 1 — Chrome and Safari both re-apply a changed viewport meta.
const VIEWPORT_NOZOOM = ', maximum-scale=1';
function setPageZoomable(on) {
  const meta = document.querySelector('meta[name=viewport]');
  if (!meta) return;
  const base = meta.content.replace(VIEWPORT_NOZOOM, '');
  meta.content = on ? base : base + VIEWPORT_NOZOOM;
}

function showLightboxAt(i) {
  const box = byId('lightbox');
  const img = lightboxItems[i];
  if (!box || !img) return;
  lightboxIndex = i;
  box.classList.remove('lightbox--zoomed');
  const el = byId('lightbox-img');
  if (el) {
    // Desktop: the fit view uses the fast display variant, and click-to-zoom
    // swaps in the original. Phones get the original right away.
    el.src = isTouchDevice()
      ? (img.dataset.original || img.src)
      : (img.dataset.display || img.src);
    el.alt = img.dataset.filename || '';
    el.dataset.original = img.dataset.original || img.src;
  }
  const cap = byId('lightbox-caption');
  if (cap) cap.textContent = img.dataset.filename || '';
  const dl = byId('lightbox-download');
  if (dl) {
    dl.href = img.dataset.original || img.src;
    dl.setAttribute('download', img.dataset.filename || '');
  }
  setHidden(byId('lightbox-prev'), i <= 0);
  setHidden(byId('lightbox-next'), i >= lightboxItems.length - 1);
  box.hidden = false;
  setPageZoomable(true);
}

function lightboxStep(delta) {
  const box = byId('lightbox');
  if (!box || box.hidden) return;
  showLightboxAt(lightboxIndex + delta);
}

function closeLightbox() {
  const box = byId('lightbox');
  if (box && !box.hidden) {
    box.hidden = true;
    box.classList.remove('lightbox--zoomed');
    setPageZoomable(false); // back to normal size, and no zooming the app
    const el = byId('lightbox-img');
    if (el) el.removeAttribute('src');
    lightboxItems = [];
    lightboxIndex = -1;
    return true;
  }
  return false;
}

function wireLightbox() {
  const box = byId('lightbox');
  on(byId('lightbox-close'), 'click', closeLightbox);
  on(byId('lightbox-prev'), 'click', () => lightboxStep(-1));
  on(byId('lightbox-next'), 'click', () => lightboxStep(1));
  // Clicking the image toggles zoom (fit ↔ natural size, panned by scrolling).
  // Zoom means actual pixels, so entering it swaps the downscaled display
  // variant for the untouched original; the browser keeps showing the old
  // frame until the sharper one arrives.
  on(byId('lightbox-img'), 'click', () => {
    if (!box || isTouchDevice()) return; // phones: already the original; pinch to zoom
    const el = byId('lightbox-img');
    if (!box.classList.contains('lightbox--zoomed') && el
      && el.dataset.original && el.getAttribute('src') !== el.dataset.original) {
      el.src = el.dataset.original;
    }
    box.classList.toggle('lightbox--zoomed');
  });
  on(box, 'click', (e) => {
    // Backdrop click closes; clicks on the image/caption/download do not.
    if (e.target === e.currentTarget || e.target.classList.contains('modal-backdrop')) closeLightbox();
  });
  // No swipe-to-change: the arrows (and arrow keys) do that, and a finger on
  // the image is always just moving around it — pinch-zoom stays the
  // browser's own.
}

/* ============================================================ realtime */

let es = null;
let backoffMs = 1000;
let reconnectTimer = 0;

/* -------- server build version: a changed version on a reconnect `hello`
   means a deploy landed — save drafts and reload (at most once). */

let bootedVersion = '';
let reloadScheduled = false;
let versionResolve = () => {};
const versionReady = new Promise((resolve) => { versionResolve = resolve; });

function noteVersion(v) {
  if (!v) return;
  // Shown in the profile modal's small print, read at open time.
  if (!bootedVersion) bootedVersion = v;
  versionResolve(bootedVersion);
}

function scheduleReloadForUpdate() {
  if (reloadScheduled) return;
  reloadScheduled = true;
  saveDraftFor(state.currentId);
  persistDrafts();
  toast('Updating to the latest version…');
  setTimeout(() => {
    // Hand the reload a page as a fresh load would find it. Phones carry the
    // pinch-zoom level and the document's scroll offset across a reload, and
    // a keyboard open at that moment leaves the page pushed up: together that
    // came back as a zoomed-in app with its bottom cut off.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    closeLightbox();
    setPageZoomable(false);
    window.scrollTo(0, 0);
    setTimeout(() => location.reload(), 150); // let the keyboard and zoom settle
  }, 1000);
}

// Whether the server is currently out of reach. navigator.onLine is the
// browser's own verdict and covers the plane case exactly; the second clause
// catches a boot that was served entirely from the offline cache. Note that
// state.connected alone would not do: it is false for the moment before the
// first SSE frame lands on a perfectly healthy load.
function isOffline() {
  return navigator.onLine === false || (state.offlineCache && !state.connected);
}

// Dialogs whose every control talks to the server are worse than useless
// offline — they open, then fail on each button. Refuse with a word instead.
function blockedOffline(what) {
  if (!isOffline()) return false;
  toast(`${what} needs a connection — you are offline`, true);
  return true;
}

// A dropped stream usually comes right back — a phone waking from its pocket
// reconnects in a second or two. Flashing "Reconnecting…" over that blink is
// noise, so going offline waits out a grace period; coming back is instant.
// Two cases skip the wait: the browser itself says the network is gone, and a
// banner that is already up (only its label may need refreshing).
let offlineUITimer = 0;
const offlineUIGrace = 4000;

function setOffline(off) {
  if (!off) {
    clearTimeout(offlineUITimer);
    offlineUITimer = 0;
    applyOfflineUI(false);
    return;
  }
  const banner = byId('connection-banner');
  if (navigator.onLine === false || (banner && !banner.hidden)) {
    clearTimeout(offlineUITimer);
    offlineUITimer = 0;
    applyOfflineUI(true);
    return;
  }
  // Hidden: paint nothing — the stream dies in the background on phones, and
  // a banner (or a grace clock) started back there would greet the user
  // already expired; wireVisibility restarts the grace on return. Armed: let
  // the running timer stand, otherwise every backoff retry would reset it and
  // a real outage could dodge the banner for ages.
  if (document.hidden || offlineUITimer) return;
  offlineUITimer = setTimeout(() => {
    offlineUITimer = 0;
    if (!document.hidden) applyOfflineUI(true);
  }, offlineUIGrace);
}

function applyOfflineUI(off) {
  const app = byId('app');
  if (app) app.classList.toggle('is-offline', off);
  const banner = byId('connection-banner');
  if (!banner) return;
  banner.hidden = !off;
  // Say which kind of offline this is: still trying, or reading a stored copy.
  const label = banner.querySelector('span:last-child');
  if (label) {
    label.textContent = state.offlineCache
      ? 'Offline'
      : 'Reconnecting…';
  }
}

function connectSSE() {
  clearTimeout(reconnectTimer);
  if (es) { es.close(); es = null; }
  // The server pushes web notifications only to users with no *visible* tab,
  // so each stream declares its tab state at connect time (EventSource happily
  // reconnects from a hidden tab) and reports changes via /api/events/visible.
  const declaredVisible = !document.hidden;
  es = new EventSource('/api/events?visible=' + (declaredVisible ? '1' : '0'));

  es.addEventListener('hello', (e) => {
    const data = JSON.parse(e.data);
    state.sseClientId = data.client_id || 0;
    // Visibility may have flipped while the stream was connecting; the change
    // handler could not report it yet (no client id until this frame).
    if (!document.hidden !== declaredVisible) reportVisibility();
    const v = data.version || '';
    if (bootedVersion && v && v !== bootedVersion) {
      // New build deployed while we were connected/reconnecting.
      scheduleReloadForUpdate();
    } else {
      noteVersion(v);
    }
    const wasDown = !state.connected;
    state.connected = true;
    backoffMs = 1000;
    state.offlineCache = false; // live again: what follows is not a stored copy
    // History is reachable again — drop any back-off loadOlder was serving.
    for (const st of state.chan.values()) st.olderRetryAt = 0;
    setOffline(false);
    state.online = new Set(data.online || []);
    renderSidebar();
    if (wasDown) {
      // Resync after any gap: unread counts + missed messages.
      for (const [id, st] of state.chan) {
        if (st.loaded && id !== state.currentId) st.stale = true;
      }
      refetchChannels();
      flushOutbox(); // re-send anything that failed to send while offline
      if (state.currentId) {
        const st = chanState(state.currentId);
        // A channel opened while offline may have never loaded (empty view).
        // Fill it for real now; otherwise just close the gap.
        if (st.loaded) gapFill(state.currentId);
        else openChannel(state.currentId, { fromHistory: true, noFocus: true });
      } else if (state.latest) {
        loadLatest(); // whatever arrived during the gap
      }
    }
  });

  es.addEventListener('message.new', (e) => onMessageNew(JSON.parse(e.data)));
  es.addEventListener('message.update', (e) => applyMessageUpdate(JSON.parse(e.data).message));
  es.addEventListener('message.delete', (e) => {
    const { message_id, channel_id } = JSON.parse(e.data);
    latestOnDelete(message_id);
    const st = chanState(channel_id);
    const m = st.byId.get(message_id);
    if (m) {
      m.deleted_at = new Date().toISOString();
      m.body = '';
      refreshMsgEl(channel_id, m);
    }
  });

  es.addEventListener('reaction', (e) => {
    const { message_id, channel_id, reactions } = JSON.parse(e.data);
    const st = chanState(channel_id);
    const m = st.byId.get(message_id);
    if (m) {
      m.reactions = reactions || [];
      refreshMsgEl(channel_id, m);
    }
  });

  es.addEventListener('pin', (e) => {
    const { message_id, channel_id, pinned } = JSON.parse(e.data);
    const st = chanState(channel_id);
    const m = st.byId.get(message_id);
    if (m) {
      m.pinned = !!pinned;
      refreshMsgEl(channel_id, m);
    }
    // The list is per channel, and a pin elsewhere must not repaint it.
    if (state.pinsRefresh) state.pinsRefresh(channel_id);
  });

  es.addEventListener('channel.delete', (e) => {
    dropDeletedChannel(JSON.parse(e.data).channel_id);
  });

  es.addEventListener('channel.new', (e) => {
    mergeChannel(JSON.parse(e.data).channel);
    renderSidebar();
    updateBadges();
  });

  // An admin changed this user's channel allowlist: pull a fresh list so newly
  // allowed channels appear and now-forbidden ones drop out (refetchChannels
  // prunes channels the server no longer returns). If the open channel just
  // became off-limits, refetchChannels moves the user off it.
  es.addEventListener('channels.resync', () => { refetchChannels(); });

  es.addEventListener('channel.update', (e) => {
    const ch = JSON.parse(e.data).channel;
    // An update never introduces a channel (channel.new / resync do that).
    if (!state.channels.has(ch.id)) return;
    // The frame is built for whoever made the change: their unread count,
    // membership and mute are theirs, not ours. Keep only the shared fields.
    delete ch.unread_count;
    delete ch.is_member;
    delete ch.muted;
    mergeChannel(ch);
    renderSidebar();
    renderChannelHeader();
    updateBadges();
  });

  es.addEventListener('channel.members', (e) => {
    const { channel_id, members, member_count } = JSON.parse(e.data);
    const ch = state.channels.get(channel_id);
    if (ch) {
      ch.members = members;
      ch.member_count = member_count;
      if (state.me && members && ch.kind === 'channel') {
        ch.is_member = members.includes(state.me.id);
      }
      forgetPrivateChannel(channel_id); // removed from a private channel → drop it
      renderSidebar();
      renderChannelHeader();
    }
    if (state.membersRefresh) state.membersRefresh(channel_id);
  });

  es.addEventListener('channel.read', (e) => {
    const { channel_id } = JSON.parse(e.data);
    const ch = state.channels.get(channel_id);
    if (ch) {
      ch.unread_count = 0;
      renderSidebar();
      updateBadges();
    }
  });

  es.addEventListener('channel.mute', (e) => {
    const { channel_id, muted } = JSON.parse(e.data);
    const ch = state.channels.get(channel_id);
    if (ch) {
      ch.muted = muted;
      renderSidebar();
      renderChannelHeader();
      updateBadges();
    }
  });

  es.addEventListener('typing', (e) => {
    const { channel_id, user_id } = JSON.parse(e.data);
    noteTyping(channel_id, user_id);
  });

  es.addEventListener('user.update', (e) => {
    applyUserUpdate(JSON.parse(e.data).user);
  });

  es.addEventListener('workspace.update', (e) => {
    applyWorkspace(JSON.parse(e.data).workspace);
  });

  es.addEventListener('presence', (e) => {
    const { user_id, online } = JSON.parse(e.data);
    if (online) state.online.add(user_id);
    else state.online.delete(user_id);
    renderSidebar();
  });

  es.onerror = () => {
    if (es) { es.close(); es = null; }
    state.connected = false;
    setOffline(true);
    const jitter = Math.random() * 0.4 + 0.8; // 0.8–1.2×
    const wait = Math.min(backoffMs * jitter, 30_000);
    backoffMs = Math.min(backoffMs * 2, 30_000);
    reconnectTimer = setTimeout(connectSSE, wait);
  };
}

function onMessageNew(data) {
  const m = data.message;
  const channelId = m.channel_id;

  if (data.user && !state.users.has(data.user.id)) {
    state.users.set(data.user.id, {
      id: data.user.id, display_name: data.user.display_name, avatar_color: 0,
      avatar_url: '',
    });
  }

  let ch = state.channels.get(channelId);
  if (!ch) {
    // e.g. first message of a brand-new DM — resync the channel list.
    refetchChannels();
    ch = mergeChannel({
      id: channelId, kind: data.channel.kind, name: data.channel.name,
      is_member: true, unread_count: 0,
    });
  }
  ch.last_message_at = m.created_at;
  reopenDM(channelId); // a message resurfaces a locally hidden DM

  // The Latest feed, when it's showing. It never counts as "seen": the unread
  // and sound logic below runs exactly as if you were in any other channel.
  if (state.latest && latest.loaded && latestWants(m) && !latest.byId.has(m.id)) appendLatest(m);

  const st = chanState(channelId);

  // Clear this author's typing state.
  const t = state.typing.get(channelId);
  if (t) { t.delete(m.user_id); renderTyping(); }

  // Dedupe our own optimistic copy.
  if (m.client_id && st.byClient.has(m.client_id)) {
    reconcilePending(channelId, m);
    return;
  }
  if (m.id && st.byId.has(m.id)) return;

  // A detached window (after a far jump) ends before the present: appending
  // would leave a hole. It arrives with the newer pages as you scroll down.
  if (st.loaded && !st.hasNewer) {
    const prev = st.msgs[st.msgs.length - 1] || null;
    addMessageToState(channelId, m);
    if (channelId === state.currentId) {
      appendMsgToDom(channelId, m, prev);
      if (state.atBottom) {
        scrollToBottom();
      } else {
        st.jumpCount++;
        updateJumpLatest();
      }
    }
  }

  const isOwn = state.me && m.user_id === state.me.id;
  const visibleHere = channelId === state.currentId && state.atBottom && !st.hasNewer
    && !document.hidden && document.hasFocus();
  // System notes are ambient: they render in the channel but never bump unread,
  // sound, or the read marker's "someone said something" semantics.
  if (m.kind === 'system') {
    if (visibleHere) maybeMarkRead();
    return;
  }
  if (!isOwn && !visibleHere) {
    ch.unread_count = (ch.unread_count || 0) + 1;
    // A DM is direct, and an @-mention is aimed at you: either must surface the
    // channel past a fold and count toward the title. A plain message in a
    // folded-away channel does none of that.
    if (ch.kind === 'dm' || mentionsMe(m.body)) mentionedChans.add(channelId);
    renderSidebar();
    updateBadges();
    // A blip for a message that lands while you are not watching, unless the
    // channel is muted — same "would this bump the badge" condition.
    if (!isMuted(ch)) playMessageSound();
  } else if (!isOwn) {
    maybeMarkRead();
  }
}

function applyMessageUpdate(m) {
  if (!m) return;
  latestOnUpdate(m);
  const st = chanState(m.channel_id);
  const local = st.byId.get(m.id);
  if (!local) return;
  Object.assign(local, m, { pending: false, failed: false });
  refreshMsgEl(m.channel_id, local);
}

/* ============================================================ palette */

const pal = {
  open: false,
  items: [],       // [{el, pick}]
  active: 0,
  searchResults: [],
  abort: null,
  completion: null, // {replace, with}
  seq: 0,
};

function paletteEl() { return byId('palette'); }

/* -------- ⌘K history (device-local)

   An empty palette opens on "Recent": the conversations you opened and the
   message searches you followed (picked a result of), newest first, mixed.
   Kept in localStorage only — the server never sees it. Entries are
   {t: 'c', id} (a channel/DM/Notes), {t: 'latest'} or {t: 's', q} (a search),
   each with `at` (ms). */

const PAL_HISTORY_MAX = 20;  // stored
const PAL_RECENT_SHOWN = 8;  // shown

function readPaletteHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(LS.palHistory) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function sameHistoryEntry(a, b) {
  return a.t === b.t && (a.t === 'c' ? a.id === b.id : a.t === 's' ? a.q === b.q : true);
}

// Move (or add) an entry to the front.
function rememberInPalette(entry) {
  entry = Object.assign({}, entry, { at: Date.now() });
  const list = [entry, ...readPaletteHistory().filter((e) => !sameHistoryEntry(e, entry))];
  try {
    localStorage.setItem(LS.palHistory, JSON.stringify(list.slice(0, PAL_HISTORY_MAX)));
  } catch { /* storage full or blocked: history is a nicety */ }
}

function forgetInPalette(entry) {
  const list = readPaletteHistory().filter((e) => !sameHistoryEntry(e, entry));
  try { localStorage.setItem(LS.palHistory, JSON.stringify(list)); } catch { /* nicety */ }
}

// "just now", "5m ago", "3d ago" — or a plain date past a week ("Oct 3").
function searchedWhen(at) {
  const rel = relativeTime(new Date(at).toISOString());
  if (rel === 'now') return 'just now';
  return /^\d+[mhd]$/.test(rel) ? `${rel} ago` : rel;
}

// The "Recent" rows: history resolved against what exists now (a channel you
// left or lost access to drops out), minus where you are and anything already
// listed above (`skip`: the unread rows).
function paletteRecentEntries(all, skip = []) {
  const out = [];
  for (const h of readPaletteHistory()) {
    if (out.length >= PAL_RECENT_SHOWN) break;
    if (h.t === 's' && h.q) {
      out.push({
        kind: 'recent-search', id: 0, q: h.q, history: h,
        title: h.q, sub: `Searched ${searchedWhen(h.at)}`, icon: '⌕', lens: true,
      });
    } else if (h.t === 'latest') {
      if (state.latest) continue;
      const e = all.find((x) => x.kind === 'latest');
      if (e) out.push(Object.assign(e, { history: h }));
    } else if (h.t === 'c') {
      if (h.id === state.currentId) continue;
      const e = all.find((x) => (x.kind === 'channel' || x.kind === 'dm' || x.kind === 'notes') && x.id === h.id);
      if (e && !skip.includes(e)) out.push(Object.assign(e, { history: h }));
    }
  }
  return out;
}

function openPalette(prefill = '') {
  const p = paletteEl();
  const input = byId('palette-input');
  if (!p || !input) return;
  pal.open = true;
  pal.searchResults = [];
  p.hidden = false;
  input.value = prefill;
  renderPalette();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function closePalette() {
  const p = paletteEl();
  if (!p || p.hidden) return false;
  p.hidden = true;
  pal.open = false;
  pal.searchResults = [];
  if (pal.abort) { pal.abort.abort(); pal.abort = null; }
  return true;
}

function parsePaletteQuery(raw) {
  const out = { from: null, in: null, text: [], raw };
  for (const tok of raw.trim().split(/\s+/)) {
    if (!tok) continue;
    if (/^from:/i.test(tok)) out.from = tok.slice(5).replace(/^@/, '');
    else if (/^in:/i.test(tok)) out.in = tok.slice(3).replace(/^#/, '');
    else out.text.push(tok);
  }
  out.textStr = out.text.join(' ');
  out.hasFilter = !!(out.from || out.in);
  return out;
}

// Tiny subsequence fuzzy matcher; higher is better, -1 = no match.
function fuzzyScore(needle, hay) {
  needle = needle.toLowerCase();
  hay = hay.toLowerCase();
  if (!needle) return 0;
  let score = 0, hi = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const idx = hay.indexOf(needle[ni], hi);
    if (idx === -1) return -1;
    score += idx === hi ? 3 : 1; // consecutive runs score higher
    if (idx === 0) score += 2;   // start-of-string bonus
    hi = idx + 1;
  }
  return score + Math.max(0, 10 - hay.length / 4);
}

function localPaletteEntries(q) {
  const all = allPaletteEntries(q);
  return all.slice(0, q.textStr.replace(/^[#@]/, '') ? 8 : 12);
}

// Every channel, conversation and person for q, best first (unsliced).
function allPaletteEntries(q) {
  const raw = q.raw.trim();
  const biasChannels = raw.startsWith('#');
  const biasPeople = raw.startsWith('@');
  const needle = q.textStr.replace(/^[#@]/, '');
  const entries = [];

  if (!biasPeople) {
    for (const ch of state.channels.values()) {
      if (ch.kind !== 'channel') continue;
      const score = needle ? fuzzyScore(needle, ch.name) : 0;
      if (score < 0) continue;
      const unread = !isMuted(ch) && (ch.unread_count || 0) > 0;
      let sub = ch.topic || `${ch.member_count || 0} member${ch.member_count === 1 ? '' : 's'}`;
      if (!ch.is_member) sub = `Not joined · ${sub}`; // the sidebar may not list it
      entries.push({
        kind: 'channel', id: ch.id, score: score + (ch.is_member ? 1 : 0),
        unread,
        recency: ch.last_message_at || '',
        title: '#' + ch.name,
        sub: unread ? `${ch.unread_count} unread · ${sub}` : sub,
        icon: ch.is_private ? '🔒' : '#',
      });
    }
  }
  // Latest, findable by name like any channel ("#lat" too).
  const latestScore = needle ? fuzzyScore(needle, 'Latest') : 0;
  if (latestScore >= 0 && !biasPeople) {
    entries.push({
      kind: 'latest', id: 0, score: latestScore,
      unread: false,
      recency: '',
      title: 'Latest',
      sub: latestSubtitle(),
      icon: '☰',
    });
  }
  if (!biasChannels) {
    // Notes, findable by name (you are otherwise left out of the people below).
    const notesScore = needle ? fuzzyScore(needle, 'Notes') : 0;
    if (notesScore >= 0 && state.me) {
      const notes = notesChannel();
      entries.push({
        kind: 'notes', id: notes ? notes.id : 0, score: notesScore,
        unread: false,
        recency: (notes && notes.last_message_at) || '',
        title: 'Notes',
        sub: 'Only you can see these',
        icon: '✎',
      });
    }
    const dmByPeer = new Map();
    for (const ch of state.channels.values()) {
      if (ch.kind === 'dm') dmByPeer.set(ch.peer_user_id, ch);
    }
    for (const u of state.users.values()) {
      if (state.me && u.id === state.me.id) continue;
      if (u.is_bot) continue; // bots are posted to, not chatted with
      const score = needle ? fuzzyScore(needle, u.display_name) : 0;
      if (score < 0) continue;
      const dm = dmByPeer.get(u.id);
      const unread = !!dm && !isMuted(dm) && (dm.unread_count || 0) > 0;
      // "Direct messages" sits where a channel says "3 members"; status after.
      const extra = u.status_text || (state.online.has(u.id) ? 'online' : '');
      const sub = extra ? `Direct messages · ${extra}` : 'Direct messages';
      entries.push({
        kind: dm ? 'dm' : 'user',
        id: dm ? dm.id : u.id,
        score: score + (dm ? 1 : 0),
        unread,
        recency: (dm && dm.last_message_at) || '',
        title: u.display_name,
        sub: unread ? `${dm.unread_count} unread · ${sub}` : sub,
        icon: '@',
      });
    }
  }
  // A conversation with a half-written message (not the open one: its text
  // is right there) says so, and shows how it starts.
  for (const e of entries) {
    e.draft = (e.kind === 'channel' || e.kind === 'dm' || e.kind === 'notes')
      && e.id !== state.currentId && hasDraft(e.id);
    if (e.draft) e.sub = `✎ Draft: ${draftSnippet(e.id)}`;
  }
  // With no query, drafts come first (you were in the middle of something),
  // then unread channels/DMs (muted ones don't count). While typing, match
  // quality stays in charge and drafts, then unread, only break ties.
  entries.sort((a, b) => (needle
    ? (b.score - a.score) || (b.draft - a.draft) || (b.unread - a.unread)
    : (b.draft - a.draft) || (b.unread - a.unread) || (b.score - a.score))
    || b.recency.localeCompare(a.recency));
  return entries;
}

function paletteGroupHeader(text) {
  const li = document.createElement('li');
  li.className = 'pal-group';
  li.textContent = text;
  return li;
}

function renderPalette() {
  const list = byId('palette-results');
  const input = byId('palette-input');
  const empty = byId('palette-empty');
  if (!list || !input) return;
  const q = parsePaletteQuery(input.value);
  list.textContent = '';
  pal.items = [];

  const appendEntry = (entry) => {
    const li = tpl('tpl-palette-item');
    if (!li) return;
    li.dataset.kind = entry.kind;
    li.dataset.id = entry.id;
    const icon = li.querySelector('.pal-item-icon');
    // A remembered search wears the search bar's own magnifier.
    const lens = entry.lens && document.querySelector('#search-trigger svg');
    if (lens) icon && icon.append(lens.cloneNode(true));
    else if (icon) icon.textContent = entry.icon;
    const title = li.querySelector('.pal-item-title');
    if (title) title.textContent = entry.title;
    const sub = li.querySelector('.pal-item-sub');
    if (sub) sub.textContent = entry.sub;
    if (entry.history) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'pal-forget';
      x.textContent = '×';
      x.title = 'Remove from recent';
      x.setAttribute('aria-label', x.title);
      li.append(x);
    }
    list.append(li);
    pal.items.push({ el: li, pick: () => pickPaletteEntry(entry), entry });
  };

  if (!q.raw.trim()) {
    // Empty: conversations with new messages first, newest message on top (so
    // Ctrl-K Enter goes to the latest one), then your history, then what
    // else still wants you (drafts…).
    const all = allPaletteEntries(q);
    const unread = all.filter((e) => e.unread && e.id !== state.currentId)
      .sort((a, b) => b.recency.localeCompare(a.recency))
      .slice(0, PAL_RECENT_SHOWN);
    if (unread.length) {
      list.append(paletteGroupHeader('Unread'));
      unread.forEach(appendEntry);
    }
    const recent = paletteRecentEntries(all, unread);
    if (recent.length) {
      list.append(paletteGroupHeader('Recent'));
      recent.forEach(appendEntry);
    }
    const shown = unread.length + recent.length;
    const rest = all.filter((e) => !unread.includes(e) && !recent.includes(e)).slice(0, Math.max(4, 12 - shown));
    if (rest.length) {
      list.append(paletteGroupHeader(shown ? 'Suggested' : 'Recent'));
      rest.forEach(appendEntry);
    }
  } else {
    const locals = q.hasFilter && !q.textStr ? [] : localPaletteEntries(q);
    if (locals.length) {
      list.append(paletteGroupHeader('Go to'));
      locals.forEach(appendEntry);
    }
  }

  if (pal.searchResults.length) {
    list.append(paletteGroupHeader('Messages'));
    for (const r of pal.searchResults) {
      const li = tpl('tpl-search-result') || tpl('tpl-palette-item');
      if (!li) break;
      li.dataset.kind = 'search';
      li.dataset.id = r.message.id;
      li.dataset.channel = r.channel_id;
      const chEl = li.querySelector('.res-channel');
      if (chEl) {
        const ch = state.channels.get(r.channel_id);
        chEl.textContent = ch ? channelDisplayName(ch)
          : r.channel_kind === 'dm' ? 'DM' : '#' + r.channel_name;
      }
      const au = li.querySelector('.res-author');
      if (au) au.textContent = r.user_name;
      const tm = li.querySelector('.res-time');
      if (tm) {
        tm.textContent = relativeTime(r.message.created_at);
        tm.title = new Date(r.message.created_at).toLocaleString();
      }
      const sn = li.querySelector('.res-snippet');
      if (sn) renderSnippet(sn, r.snippet);
      list.append(li);
      pal.items.push({
        el: li,
        pick: () => {
          // A search you followed is worth offering again.
          const typed = byId('palette-input');
          if (typed && typed.value.trim()) rememberInPalette({ t: 's', q: typed.value.trim() });
          closePalette();
          openChannel(r.channel_id, { jumpTo: r.message.id });
        },
      });
    }
  }

  pal.active = 0;
  applyPaletteActive();
  if (empty) empty.hidden = pal.items.length > 0 || !q.raw.trim();
  renderPaletteHint(q);
}

// The server pre-escapes snippets and only emits <mark>. Rebuild defensively:
// keep text and <mark> textContent, flatten anything else to plain text.
function renderSnippet(target, html) {
  const t = document.createElement('template');
  t.innerHTML = String(html || '');
  const frag = document.createDocumentFragment();
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        frag.append(document.createTextNode(child.textContent));
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'MARK') {
        const mark = document.createElement('mark');
        mark.textContent = child.textContent;
        frag.append(mark);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        frag.append(document.createTextNode(child.textContent));
      }
    }
  })(t.content);
  target.textContent = '';
  target.append(frag);
}

function renderPaletteHint(q) {
  const hint = byId('palette-hint');
  if (!hint) return;
  pal.completion = null;
  const raw = byId('palette-input') ? byId('palette-input').value : '';
  const m = /(^|\s)(from:@?|in:#?)([^\s]*)$/i.exec(raw);
  if (m) {
    const isFrom = m[2].toLowerCase().startsWith('from');
    const partial = m[3].toLowerCase();
    let suggestion = null;
    if (isFrom) {
      for (const u of state.users.values()) {
        if (u.display_name.toLowerCase().startsWith(partial)) { suggestion = u.display_name; break; }
      }
      if (suggestion) {
        pal.completion = { start: m.index + m[1].length, text: `from:@${suggestion} ` };
        hint.textContent = `from:@${suggestion} — Tab to complete`;
        return;
      }
      hint.textContent = 'from:@user — filter by author';
      return;
    }
    for (const ch of state.channels.values()) {
      if (ch.kind === 'channel' && ch.name.startsWith(partial)) { suggestion = ch.name; break; }
    }
    if (suggestion) {
      pal.completion = { start: m.index + m[1].length, text: `in:#${suggestion} ` };
      hint.textContent = `in:#${suggestion} — Tab to complete`;
      return;
    }
    hint.textContent = 'in:#channel — filter by channel';
    return;
  }
  hint.textContent = q && q.raw.trim()
    ? 'Enter to open · from:@user in:#channel to filter messages'
    : 'Jump to a channel or person · # channels · @ people · from:@user in:#channel';
}

function applyPaletteCompletion() {
  const input = byId('palette-input');
  if (!input || !pal.completion) return false;
  input.value = input.value.slice(0, pal.completion.start) + pal.completion.text;
  input.setSelectionRange(input.value.length, input.value.length);
  onPaletteInput();
  return true;
}

function applyPaletteActive() {
  pal.items.forEach((it, i) => it.el.classList.toggle('pal-item--active', i === pal.active));
  const cur = pal.items[pal.active];
  if (cur) cur.el.scrollIntoView({ block: 'nearest' });
}

function movePaletteActive(delta) {
  if (!pal.items.length) return;
  pal.active = (pal.active + delta + pal.items.length) % pal.items.length;
  applyPaletteActive();
}

// Open (creating if needed) the DM with userId. The one path for every
// "click a person" affordance: palette, DM picker, message author/avatar.
async function openDMWith(userId) {
  if (!userId) return;
  if (state.me && userId === state.me.id) { openNotes(); return; } // your own name/avatar
  const u = state.users.get(userId);
  if (u && u.is_bot) return; // bots are posted to, not chatted with
  try {
    const data = await api('/api/dms', { method: 'POST', body: { user_id: userId } });
    mergeChannel(data.channel);
    reopenDM(data.channel.id); // deliberate open resurfaces a hidden one
    renderSidebar();
    openChannel(data.channel.id);
  } catch { /* toasted */ }
}

async function pickPaletteEntry(entry) {
  if (entry.kind === 'recent-search') {
    // Run it again, palette open, results below.
    const input = byId('palette-input');
    if (!input) return;
    input.value = entry.q;
    input.setSelectionRange(input.value.length, input.value.length);
    onPaletteInput();
    return;
  }
  closePalette();
  if (entry.kind === 'channel' || entry.kind === 'dm') {
    openChannel(entry.id);
  } else if (entry.kind === 'user') {
    openDMWith(entry.id);
  } else if (entry.kind === 'notes') {
    openNotes();
  } else if (entry.kind === 'latest') {
    openLatest();
  }
}

const schedulePaletteSearch = debounce(async () => {
  const input = byId('palette-input');
  if (!input || !pal.open) return;
  const raw = input.value.trim();
  const q = parsePaletteQuery(raw);
  // Leading # / @ means the user is navigating, not searching.
  if (!raw || raw.startsWith('#') || raw.startsWith('@') || (!q.textStr && !q.hasFilter)) {
    pal.searchResults = [];
    renderPalette();
    return;
  }
  if (pal.abort) pal.abort.abort();
  const ctrl = new AbortController();
  pal.abort = ctrl;
  const seq = ++pal.seq;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(raw)}&limit=20`, {
      signal: ctrl.signal, toast: false,
    });
    if (seq !== pal.seq || !pal.open) return; // stale response
    pal.searchResults = data.results || [];
    renderPalette();
  } catch (err) {
    if (err.name === 'AbortError') return;
    pal.searchResults = [];
    renderPalette();
  }
}, 180);

function onPaletteInput() {
  renderPalette();
  schedulePaletteSearch();
}

function wirePalette() {
  const input = byId('palette-input');
  const list = byId('palette-results');
  on(byId('search-trigger'), 'click', () => openPalette());
  on(byId('palette-close'), 'click', () => closePalette());
  on(input, 'input', onPaletteInput);
  on(input, 'keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteActive(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = pal.items[pal.active];
      if (it) it.pick();
    } else if (e.key === 'Tab') {
      if (applyPaletteCompletion()) e.preventDefault();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    }
  });
  if (list) {
    // The × on a Recent row must not take focus from the input.
    list.addEventListener('mousedown', (e) => {
      if (e.target.closest('.pal-forget')) e.preventDefault();
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('.pal-item');
      if (!li) return;
      const idx = pal.items.findIndex((it) => it.el === li);
      if (idx < 0) return;
      if (e.target.closest('.pal-forget')) {
        forgetInPalette(pal.items[idx].entry.history);
        renderPalette();
        pal.active = Math.min(idx, pal.items.length - 1);
        applyPaletteActive();
        return;
      }
      pal.items[idx].pick();
    });
    list.addEventListener('mousemove', (e) => {
      const li = e.target.closest('.pal-item');
      if (!li) return;
      const idx = pal.items.findIndex((it) => it.el === li);
      if (idx >= 0 && idx !== pal.active) {
        pal.active = idx;
        pal.items.forEach((it, i) => it.el.classList.toggle('pal-item--active', i === pal.active));
      }
    });
  }
  on(paletteEl(), 'click', (e) => {
    if (e.target === e.currentTarget || e.target.classList.contains('modal-backdrop')) closePalette();
  });
}

/* ============================================================ modals */

const modalStack = []; // {nodes, forced, prevFocus, onClose}

function modalQuery(modal, sel) {
  for (const n of modal.nodes) {
    if (n.matches && n.matches(sel)) return n;
    const found = n.querySelector && n.querySelector(sel);
    if (found) return found;
  }
  return null;
}

function openModal(tplId, opts = {}) {
  const root = byId('modal-root');
  const t = byId(tplId);
  if (!root || !t || !t.content) return null;
  const frag = t.content.cloneNode(true);
  const nodes = [...frag.children];
  const modal = {
    nodes,
    forced: !!opts.forced,
    prevFocus: document.activeElement,
    onClose: opts.onClose || null,
    q: (sel) => modalQuery(modal, sel),
    qa: (sel) => modal.nodes.flatMap((n) => (n.querySelectorAll ? [...n.querySelectorAll(sel)] : [])),
    close: () => closeModal(modal),
  };
  if (opts.forced) nodes.forEach((n) => n.classList.add('modal--forced'));
  root.append(frag);
  modalStack.push(modal);
  document.body.classList.add('modal-open');
  const focusable = modal.q('input:not([type=hidden]), textarea, select, button:not(.modal-close)');
  if (focusable) focusable.focus();
  return modal;
}

function closeModal(modal) {
  const idx = modalStack.indexOf(modal);
  if (idx === -1) return;
  modalStack.splice(idx, 1);
  modal.nodes.forEach((n) => n.remove());
  if (!modalStack.length) document.body.classList.remove('modal-open');
  if (modal.prevFocus && modal.prevFocus.focus) modal.prevFocus.focus();
  if (modal.onClose) modal.onClose();
}

function topModal() {
  return modalStack[modalStack.length - 1] || null;
}

function closeTopModal(force = false) {
  const m = topModal();
  if (!m) return false;
  if (m.forced && !force) return true; // swallow Esc, keep it open
  closeModal(m);
  return true;
}

function wireModalRoot() {
  const root = byId('modal-root');
  if (!root) return;
  root.addEventListener('click', (e) => {
    const m = topModal();
    if (!m) return;
    if (e.target.closest('.modal-close')) {
      if (!m.forced) closeModal(m);
      return;
    }
    if (e.target.classList.contains('modal-backdrop') && !m.forced) closeModal(m);
  });
  document.addEventListener('keydown', (e) => {
    const m = topModal();
    if (!m || e.key !== 'Tab') return;
    // Focus trap within the top modal.
    const els = [];
    for (const n of m.nodes) {
      if (n.querySelectorAll) {
        els.push(...n.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ));
      }
    }
    const visible = els.filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!visible.length) return;
    const first = visible[0];
    const last = visible[visible.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!visible.includes(document.activeElement)) { e.preventDefault(); first.focus(); }
  });
}

// opts.typed: the OK button stays disabled until exactly this is typed (a
// last gate before something irreversible).
function confirmModal(text, okLabel, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = openModal('tpl-modal-confirm', { onClose: () => done(false) });
    if (!m) { done(window.confirm(text)); return; }
    const t = m.q('.confirm-text');
    if (t) t.textContent = text;
    const ok = m.q('.confirm-ok');
    if (ok && okLabel) ok.textContent = okLabel;
    const typedField = m.q('.confirm-typed');
    const typedInput = m.q('.confirm-typed-input');
    if (opts.typed && typedField && typedInput && ok) {
      typedField.hidden = false;
      const label = m.q('.confirm-typed-label');
      if (label) label.textContent = `Type ${opts.typed} to confirm`;
      typedInput.placeholder = opts.typed;
      const matches = () => typedInput.value.trim() === opts.typed;
      ok.disabled = true;
      on(typedInput, 'input', () => { ok.disabled = !matches(); });
      on(typedInput, 'keydown', (e) => {
        if (e.key === 'Enter' && matches()) { e.preventDefault(); ok.click(); }
      });
      typedInput.focus();
    }
    on(ok, 'click', () => { done(true); m.close(); });
    on(m.q('.confirm-cancel'), 'click', () => m.close());
  });
}

function formError(m, text) {
  const el = m.q('.mform-error');
  if (el) {
    el.textContent = text || '';
    el.hidden = !text;
  }
}

/* -------- new channel + channel info (edit) */

function openNewChannelModal() {
  if (blockedOffline('Creating a channel')) return;
  const m = openModal('tpl-modal-new-channel');
  if (!m) return;
  const form = m.q('form') || m.q('.mform');
  on(form, 'submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    formError(m, '');
    try {
      const data = await api('/api/channels', {
        method: 'POST',
        toast: false,
        body: {
          name: String(fd.get('name') || '').trim(),
          topic: String(fd.get('topic') || '').trim(),
          is_private: !!fd.get('is_private'),
        },
      });
      mergeChannel(data.channel);
      renderSidebar();
      m.close();
      openChannel(data.channel.id);
    } catch (err) {
      formError(m, err.message);
    }
  });
}

// #info-btn: reuse the new-channel form to rename / retopic, plus leave.
function openChannelInfoModal() {
  if (state.latest) { openLatestModal(); return; } // device-local toggles: fine offline
  if (blockedOffline('Channel details')) return;
  const ch = state.channels.get(state.currentId);
  if (!ch || ch.kind === 'dm') return;
  const m = openModal('tpl-modal-new-channel');
  if (!m) return;
  // Same form as "New channel", but this is the channel's details.
  const heading = m.q('.modal-title');
  if (heading) heading.textContent = 'Channel details';
  const dialog = m.q('.modal');
  if (dialog) dialog.setAttribute('aria-label', 'Channel details');
  const form = m.q('form') || m.q('.mform');
  if (!form) return;
  const nameEl = form.querySelector('[name=name]');
  const topicEl = form.querySelector('[name=topic]');
  const privEl = form.querySelector('[name=is_private]');
  if (nameEl) nameEl.value = ch.name;
  if (topicEl) topicEl.value = ch.topic || '';
  const canEdit = state.me && (state.me.is_admin || ch.created_by === state.me.id);
  if (privEl) {
    privEl.checked = !!ch.is_private;
    privEl.disabled = !canEdit; // an admin/creator can flip it after creation
  }
  const submit = form.querySelector('.mform-submit');
  if (submit) {
    submit.textContent = 'Save changes';
    submit.hidden = !canEdit;
  }
  if (nameEl) nameEl.disabled = !canEdit;
  if (topicEl) topicEl.disabled = !canEdit;

  if (ch.is_member) {
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'mform-leave';
    leave.textContent = `Leave #${ch.name}`;
    form.append(leave);
    on(leave, 'click', async () => {
      const ok = await confirmModal(`Leave #${ch.name}?`, 'Leave');
      if (!ok) return;
      try {
        await api(`/api/channels/${ch.id}/leave`, { method: 'POST' });
        ch.is_member = false;
        ch.unread_count = 0;
        m.close();
        forgetPrivateChannel(ch.id); // private: drop it and leave its view
        renderSidebar();
        renderChannelHeader();
        updateBadges();
        toast(`Left #${ch.name}`);
      } catch { /* toasted */ }
    });
  }

  if (canEdit) {
    // Creator or admin. Asked twice, then the name must be typed.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mform-leave mform-delete';
    del.textContent = `Delete #${ch.name}`;
    form.append(del);
    on(del, 'click', async () => {
      if (blockedOffline('Deleting a channel')) return;
      if (!await confirmModal(
        `Delete #${ch.name}? Every message, file and pin in it is deleted too, for everyone.`,
        'Delete')) return;
      if (!await confirmModal(
        `Are you sure? Deleting #${ch.name} cannot be undone.`,
        'Yes, delete it')) return;
      if (!await confirmModal(
        `Last step: deleting #${ch.name} for good.`,
        'Delete channel', { typed: ch.name })) return;
      try {
        await api(`/api/channels/${ch.id}`, { method: 'DELETE', body: { name: ch.name } });
        m.close();
        dropDeletedChannel(ch.id, { mine: true });
        toast(`Deleted #${ch.name}`);
      } catch { /* toasted */ }
    });
  }

  on(form, 'submit', async (e) => {
    e.preventDefault();
    if (!canEdit) { m.close(); return; }
    formError(m, '');
    try {
      const body = {
        name: nameEl ? nameEl.value.trim() : ch.name,
        topic: topicEl ? topicEl.value.trim() : ch.topic,
      };
      if (privEl && privEl.checked !== !!ch.is_private) body.is_private = privEl.checked;
      const data = await api(`/api/channels/${ch.id}`, { method: 'PATCH', toast: false, body });
      const becamePrivate = body.is_private === true;
      mergeChannel(data.channel);
      renderSidebar();
      renderChannelHeader();
      m.close();
      if (body.is_private !== undefined) {
        toast(becamePrivate ? `#${data.channel.name} is now private` : `#${data.channel.name} is now public`);
      }
    } catch (err) {
      formError(m, err.message);
    }
  });
}

/* -------- new DM */

function memberRow(user, opts = {}) {
  const row = tpl('tpl-member-row');
  if (!row) return null;
  row.dataset.userId = user.id;
  applyAvatar(row.querySelector('.member-avatar'), user);
  const name = row.querySelector('.member-name');
  if (name) name.textContent = user.display_name;
  const meta = row.querySelector('.member-meta');
  if (meta) {
    meta.textContent = opts.meta !== undefined
      ? opts.meta
      : [user.is_admin ? 'admin' : '', state.online.has(user.id) ? 'online' : ''].filter(Boolean).join(' · ');
  }
  const rm = row.querySelector('.member-remove');
  if (rm) rm.hidden = !opts.removable;
  return row;
}

function openNewDMModal() {
  if (blockedOffline('Starting a conversation')) return;
  const m = openModal('tpl-modal-new-dm');
  if (!m) return;
  const input = m.q('.dm-picker-input');
  const list = m.q('.dm-picker-list');
  if (!list) return;

  const render = () => {
    const needle = input ? input.value.trim() : '';
    list.textContent = '';
    const users = [...state.users.values()]
      .filter((u) => (!state.me || u.id !== state.me.id) && !u.is_bot)
      .map((u) => ({ u, score: needle ? fuzzyScore(needle, u.display_name) : 0 }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    for (const { u } of users) {
      const row = memberRow(u);
      if (row) list.append(row);
    }
  };
  on(input, 'input', render);
  list.addEventListener('click', async (e) => {
    const row = e.target.closest('.member');
    if (!row) return;
    const userId = Number(row.dataset.userId);
    m.close();
    openDMWith(userId);
  });
  render();
}

/* -------- members */

async function openMembersModal() {
  if (blockedOffline('Members')) return;
  const chId = state.currentId;
  const ch = state.channels.get(chId);
  if (!ch || ch.kind === 'dm') return;
  const m = openModal('tpl-modal-members', {
    onClose: () => { state.membersRefresh = null; },
  });
  if (!m) return;
  const listEl = m.q('.members-list');
  const addInput = m.q('.member-add-input');
  const addList = m.q('.member-add-list');
  const titleEl = m.q('.members-title');

  let members = ch.members || null;

  const canManage = () => state.me && (state.me.is_admin || ch.created_by === state.me.id);

  const render = () => {
    if (titleEl) {
      titleEl.textContent = `#${ch.name} — ${ch.member_count || (members ? members.length : 0)} member${(ch.member_count || 0) === 1 ? '' : 's'}`;
    }
    if (listEl) {
      listEl.textContent = '';
      for (const uid of members || []) {
        const u = state.users.get(uid) || { id: uid, display_name: `User #${uid}`, avatar_color: 0 };
        const row = memberRow(u, { removable: canManage() && uid !== state.me.id });
        if (row) listEl.append(row);
      }
    }
    renderAddList();
  };

  const renderAddList = () => {
    if (!addList) return;
    addList.textContent = '';
    if (!ch.is_member && !canManage()) return;
    const needle = addInput ? addInput.value.trim() : '';
    const memberSet = new Set(members || []);
    const candidates = [...state.users.values()]
      // Bots stay out of the picker; a token's bot user is enrolled into a
      // private channel via the CLI's /slock invite instead.
      .filter((u) => !memberSet.has(u.id) && !u.is_bot)
      .map((u) => ({ u, score: needle ? fuzzyScore(needle, u.display_name) : 0 }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    for (const { u } of candidates) {
      const row = memberRow(u, { meta: 'Add to channel' });
      if (row) {
        row.classList.add('member--addable');
        addList.append(row);
      }
    }
  };

  state.membersRefresh = (channelId) => {
    if (channelId !== chId) return;
    members = ch.members || members;
    render();
  };

  on(addInput, 'input', renderAddList);
  if (addList) {
    addList.addEventListener('click', async (e) => {
      const row = e.target.closest('.member');
      if (!row) return;
      const uid = Number(row.dataset.userId);
      try {
        await api(`/api/channels/${chId}/members`, { method: 'POST', body: { user_id: uid } });
        members = [...(members || []), uid];
        ch.members = members;
        ch.member_count = (ch.member_count || members.length - 1) + 1;
        render();
      } catch { /* toasted */ }
    });
  }
  if (listEl) {
    listEl.addEventListener('click', async (e) => {
      const rm = e.target.closest('.member-remove');
      if (!rm) return;
      const row = e.target.closest('.member');
      const uid = Number(row.dataset.userId);
      const u = state.users.get(uid);
      const ok = await confirmModal(`Remove ${u ? u.display_name : 'this member'} from #${ch.name}?`, 'Remove');
      if (!ok) return;
      try {
        await api(`/api/channels/${chId}/members/${uid}`, { method: 'DELETE' });
        members = (members || []).filter((id) => id !== uid);
        ch.members = members;
        ch.member_count = Math.max(0, (ch.member_count || 1) - 1);
        render();
      } catch { /* toasted */ }
    });
  }

  if (!members) {
    try {
      const data = await api(`/api/channels/${chId}`);
      mergeChannel(data.channel);
      members = data.channel.members || [];
      ch.members = members;
      ch.member_count = data.channel.member_count;
    } catch {
      members = [];
    }
  }
  render();
}

/* -------- close a DM conversation (#close-dm-btn) — purely visual, this
   device only: the ids live in localStorage, the server never hears about it.
   A new message in the conversation, or reopening it via the palette,
   un-closes it. */

let closedDMs = new Set();

function loadClosedDMs() {
  try {
    closedDMs = new Set(JSON.parse(localStorage.getItem(LS.closedDMs) || '[]'));
  } catch {
    closedDMs = new Set();
  }
}

function saveClosedDMs() {
  if (closedDMs.size) localStorage.setItem(LS.closedDMs, JSON.stringify([...closedDMs]));
  else localStorage.removeItem(LS.closedDMs);
}

// A message arrived in it, or the user deliberately reopened it.
function reopenDM(channelId) {
  if (closedDMs.delete(channelId)) {
    saveClosedDMs();
    renderSidebar();
  }
}

// No confirm, no toast: hiding is non-destructive (history is kept, the
// conversation returns on the next message), so the rail change IS the
// feedback.
function closeDMConversation() {
  const ch = state.channels.get(state.currentId);
  if (!ch || ch.kind !== 'dm') return;
  closedDMs.add(ch.id);
  saveClosedDMs();
  const next = sortedChannels().find((c) => c.is_member) || sortedChannels()[0] || sortedDMs()[0];
  if (next) {
    openChannel(next.id);
  } else {
    state.currentId = null;
    renderSidebar();
    renderChannelHeader();
  }
}

/* -------- pinned channels + folded sections (device-local) --------
   Pinning a channel or DM keeps it visible when its section is folded to
   "pinned only". Channels and DMs fold independently. All per-device, like
   closedDMs, colours, density. */

let pinnedChans = new Set();
let foldChans = false;
let foldDMs = false;
// Prefix folding: unpinned channels sharing a prefix ("bd-blabla", "bd-bob")
// collapse into one "bd-*" row. openGroups holds the groups expanded in place;
// it is in-memory, so every group starts folded again on the next load.
let groupChans = false;
const openGroups = new Set();
// Public channels you have not joined stay out of the sidebar unless this is on
// (Profile → Display); ⌘K always finds them.
let showUnjoined = false;
// Channels/DMs with an unread @-mention (or, for DMs, any unread message):
// surfaced past a fold and counted in the window title even while hidden.
// In-memory and live-only — cleared when the channel is read.
const mentionedChans = new Set();

function loadSidebarPrefs() {
  try {
    pinnedChans = new Set((JSON.parse(localStorage.getItem(LS.pinnedChans) || '[]')).map(Number));
  } catch {
    pinnedChans = new Set();
  }
  foldChans = localStorage.getItem(LS.foldChans) === '1';
  foldDMs = localStorage.getItem(LS.foldDMs) === '1';
  groupChans = localStorage.getItem(LS.groupChans) === '1';
  showUnjoined = localStorage.getItem(LS.showUnjoined) === '1';
}

function setShowUnjoined(on) {
  showUnjoined = !!on;
  if (on) localStorage.setItem(LS.showUnjoined, '1'); else localStorage.removeItem(LS.showUnjoined);
  renderSidebar();
}

function isChannelPinned(id) {
  return pinnedChans.has(Number(id));
}

function togglePinChannel(id, opts = {}) {
  id = Number(id);
  if (!pinnedChans.delete(id)) pinnedChans.add(id);
  if (pinnedChans.size) localStorage.setItem(LS.pinnedChans, JSON.stringify([...pinnedChans]));
  else localStorage.removeItem(LS.pinnedChans);
  renderSidebar();
  renderChannelHeader();
  if (state.latest && latestFavesOnly) loadLatest(); // the pinned set is its filter
  const ch = state.channels.get(id);
  const pinned = pinnedChans.has(id);
  if (ch && !opts.quiet) toast(pinned ? `Pinned ${channelDisplayName(ch)}` : `Unpinned ${channelDisplayName(ch)}`);
}

// Whether the section has a pinned row, i.e. whether "pinned only" means
// anything there.
function sectionHasPinned(kind) {
  for (const id of pinnedChans) {
    const ch = state.channels.get(id);
    if (ch && ch.kind === kind && !isNotesChannel(ch)) return true;
  }
  return false;
}

function reflectFoldButton(kind) {
  const btn = byId(kind === 'dm' ? 'fold-dms' : 'fold-channels');
  if (!btn) return;
  const folded = kind === 'dm' ? foldDMs : foldChans;
  const noun = kind === 'dm' ? 'DMs' : 'channels';
  // The pin toggle only shows once something in the section is pinned — but
  // stays while the section is folded, so the fold can always be undone.
  btn.hidden = !folded && !sectionHasPinned(kind);
  btn.classList.toggle('is-on', folded);
  btn.setAttribute('aria-pressed', folded ? 'true' : 'false');
  btn.title = folded ? `Show all ${noun}` : `Show pinned ${noun} only`;
  btn.setAttribute('aria-label', btn.title);
}

function reflectGroupButton() {
  const btn = byId('group-channels');
  if (!btn) return;
  btn.classList.toggle('is-on', groupChans);
  btn.setAttribute('aria-pressed', groupChans ? 'true' : 'false');
  btn.title = groupChans ? 'Unfold channel groups' : 'Fold channels by prefix (bd-*)';
  btn.setAttribute('aria-label', btn.title);
}

function setChannelsGrouped(on) {
  groupChans = !!on;
  if (on) localStorage.setItem(LS.groupChans, '1'); else localStorage.removeItem(LS.groupChans);
  openGroups.clear();
  reflectGroupButton();
  renderSidebar();
}

function toggleChanGroup(key) {
  if (!openGroups.delete(key)) openGroups.add(key);
  renderSidebar();
}

// "bd-blabla" -> "bd-": the name up to and including its first separator.
// Pinned channels never fold; they are pinned to stay in sight.
function groupKey(ch) {
  if (!groupChans || isChannelPinned(ch.id)) return null;
  const m = /^[^-_.]+[-_.]/.exec(ch.name || '');
  return m ? m[0].toLowerCase() : null;
}

// Prefix -> its channels, for prefixes shared by two or more channels; a lone
// "bd-x" stays a plain row.
function prefixGroups(chans) {
  const groups = new Map();
  for (const ch of chans) {
    const key = groupKey(ch);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ch);
  }
  for (const [key, list] of groups) if (list.length < 2) groups.delete(key);
  return groups;
}

// Inside a folded group, the open channel (reached from search, say) and one
// with an unread mention still show, until you leave or read it.
function surfacedInGroup(ch) {
  return ch.id === state.currentId || mentionedChans.has(ch.id);
}

function setSectionFolded(kind, on) {
  const key = kind === 'dm' ? LS.foldDMs : LS.foldChans;
  if (kind === 'dm') foldDMs = !!on; else foldChans = !!on;
  if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key);
  reflectFoldButton(kind);
  renderSidebar();
}

// A folded section shows only pinned rows — plus the open one (never lose your
// place) and any with an unread mention (a mention must always surface). An
// unjoined channel is hidden unless asked for, or pinned, or open.
function visibleInSidebar(ch) {
  if (ch.id === state.currentId || mentionedChans.has(ch.id)) return true;
  if (ch.kind === 'channel' && !ch.is_member && !showUnjoined && !isChannelPinned(ch.id)) return false;
  const folded = ch.kind === 'dm' ? foldDMs : foldChans;
  return !folded || isChannelPinned(ch.id);
}

/* -------- pinned messages (#msg-pin, #pins-btn) */

// Optimistic like reactions: flip locally, let the `pin` frame confirm, and
// put it back if the server disagreed.
function togglePin(msgId) {
  const st = chanState(state.currentId);
  const m = st.byId.get(msgId);
  if (!m || m.deleted_at) return;
  const next = !m.pinned;
  m.pinned = next;
  refreshMsgEl(state.currentId, m);
  api(`/api/messages/${msgId}/pin`, { method: next ? 'PUT' : 'DELETE' })
    .then(() => { if (state.pinsRefresh) state.pinsRefresh(state.currentId); })
    .catch(() => {
      m.pinned = !next;
      refreshMsgEl(state.currentId, m);
    });
}

// One pinned row: who, when, and enough of the message to recognise it. The
// server flattens the message into the pin, so `p` is a Message plus
// pinned_by/pinned_at.
function makePinRow(msg) {
  const el = tpl('tpl-pin-row');
  if (!el) return document.createDocumentFragment();
  el.dataset.id = msg.id;
  applyAvatar(el.querySelector('.prow-avatar'), state.users.get(msg.user_id));
  const author = el.querySelector('.prow-author');
  if (author) author.textContent = userName(msg.user_id);
  const time = el.querySelector('.prow-time');
  if (time) {
    time.textContent = relativeTime(msg.created_at);
    time.title = new Date(msg.created_at).toLocaleString();
  }
  const body = el.querySelector('.prow-body');
  if (body) {
    // Plain text, single line: this is a picker, not a second message list.
    const text = (msg.body || '').trim();
    const files = (msg.attachments || []).length;
    body.textContent = text || (files ? `${files} attachment${files === 1 ? '' : 's'}` : '');
  }
  return el;
}

function openPinsModal() {
  if (blockedOffline('Pinned messages')) return;
  const ch = state.channels.get(state.currentId);
  if (!ch) return;
  const m = openModal('tpl-modal-pins', {
    onClose: () => { state.pinsRefresh = null; },
  });
  if (!m) return;
  const title = m.q('.pins-title');
  if (title) title.textContent = `Pinned — ${channelDisplayName(ch)}`;
  const list = m.q('.pins-list');
  const empty = m.q('.pins-empty');

  const load = async () => {
    if (!list) return;
    try {
      const data = await api(`/api/channels/${ch.id}/pins`);
      list.textContent = '';
      for (const p of data.pins || []) list.append(makePinRow(p));
      if (empty) empty.hidden = list.children.length > 0;
    } catch { /* toasted by api() */ }
  };

  // Someone else pinning (or this tab doing it) repaints the open list.
  state.pinsRefresh = (channelId) => { if (channelId === ch.id) load(); };

  on(list, 'click', (e) => {
    const row = e.target.closest('.prow');
    if (!row) return;
    const msgId = Number(row.dataset.id);
    if (e.target.closest('.prow-unpin')) {
      row.remove();
      if (empty) empty.hidden = list.children.length > 0;
      api(`/api/messages/${msgId}/pin`, { method: 'DELETE' }).catch(() => load());
      return;
    }
    m.close();
    openChannel(ch.id, { jumpTo: msgId });
  });

  load();
}

/* -------- channel attachments (#files-btn) */

function makeFileRow(att) {
  const el = tpl('tpl-file-row');
  if (!el) return document.createDocumentFragment();
  const img = el.querySelector('.frow-img');
  const name = el.querySelector('.frow-name');
  const meta = el.querySelector('.frow-meta');
  if (name) {
    name.textContent = att.filename;
    name.href = fileURL(att, 'original');
    name.setAttribute('download', att.filename);
  }
  if (meta) {
    meta.textContent = `${formatBytes(att.size_bytes)} · ${userName(att.user_id)} · ${relativeTime(att.created_at)}`;
  }
  if (att.is_image && img) {
    img.src = fileURL(att, att.has_thumb ? 'thumb' : 'original');
    img.alt = att.filename;
    img.loading = 'lazy';
    img.dataset.display = fileURL(att, att.has_display ? 'display' : 'original');
    img.dataset.original = fileURL(att, 'original');
    img.dataset.filename = att.filename;
    img.hidden = false;
    setHidden(el.querySelector('.frow-icon'), true);
    // The thumbnail opens the lightbox (z-indexed above the modal); the file
    // name stays a download link, same as in the message list.
    el.querySelector('.frow-thumb').addEventListener('click', () => openLightbox(img));
  }
  return el;
}

function openFilesModal() {
  if (blockedOffline('Attachments')) return;
  const ch = state.channels.get(state.currentId);
  if (!ch) return;
  const m = openModal('tpl-modal-files');
  if (!m) return;
  const title = m.q('.files-title');
  if (title) title.textContent = `Attachments — ${channelDisplayName(ch)}`;
  const list = m.q('.files-list');
  const empty = m.q('.files-empty');
  const more = m.q('.files-more');
  let before = 0;
  let loading = false;

  const load = async () => {
    if (loading || !list) return;
    loading = true;
    try {
      const q = before ? `&before=${before}` : '';
      const data = await api(`/api/channels/${ch.id}/attachments?limit=50${q}`);
      const atts = data.attachments || [];
      for (const att of atts) list.append(makeFileRow(att));
      if (atts.length) before = atts[atts.length - 1].id;
      if (empty) empty.hidden = list.children.length > 0;
      if (more) more.hidden = !data.has_more;
    } catch { /* toasted by api() */ }
    loading = false;
  };
  on(more, 'click', load);
  load();
}

/* -------- profile */

const AVATAR_COLORS = 10;

function openProfileModal() {
  if (blockedOffline('Your profile')) return;
  const m = openModal('tpl-modal-profile');
  if (!m || !state.me) return;
  const form = m.q('form') || m.q('.mform');
  const nameEl = m.q('[name=display_name]');
  const statusEl = m.q('[name=status_text]');
  if (nameEl) nameEl.value = state.me.display_name;
  if (statusEl) statusEl.value = state.me.status_text || '';

  let color = state.me.avatar_color;
  const swatches = m.q('.color-swatches');
  if (swatches) {
    for (let i = 0; i < AVATAR_COLORS; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.color = i;
      b.setAttribute('aria-label', `Colour ${i + 1}`);
      b.classList.toggle('swatch--active', i === color);
      swatches.append(b);
    }
    swatches.addEventListener('click', (e) => {
      const b = e.target.closest('.swatch');
      if (!b) return;
      color = Number(b.dataset.color);
      swatches.querySelectorAll('.swatch').forEach((s) => {
        s.classList.toggle('swatch--active', Number(s.dataset.color) === color);
      });
      if (preview) preview.dataset.color = color; // live colour preview
    });
  }

  /* -------- sidebar & chat colours — device-local, applied and saved on the
     spot (no server round-trip), so they sit outside the form's submit */
  const combos = m.q('.combo-swatches');
  const sbInput = m.q('.combo-sidebar');
  const chatInput = m.q('.combo-chat');
  const resetBtn = m.q('.combo-reset');
  if (combos && sbInput && chatInput) {
    // The modal edits the slot of whichever theme is painting the page now;
    // switch themes to style the other one.
    const theme = effectiveTheme();
    const note = m.q('.combo-note');
    if (note) note.textContent = `${theme} theme`;
    // The stock, un-customised tokens: root is never inline-overridden, so
    // these are the stylesheet values for the active theme.
    const cs = getComputedStyle(document.documentElement);
    const base = {
      sidebar: cs.getPropertyValue('--bg-1').trim(),
      chat: cs.getPropertyValue('--bg-0').trim(),
    };
    const sync = () => {
      const applied = activeColors();
      const sb = applied.sidebar || base.sidebar;
      const chat = applied.chat || base.chat;
      sbInput.value = sb;
      chatInput.value = chat;
      combos.querySelectorAll('.combo').forEach((b) => {
        b.classList.toggle('combo--active', b.dataset.sidebar === sb && b.dataset.chat === chat);
      });
      if (resetBtn) resetBtn.hidden = !loadColorsStore()[theme];
    };
    const set = (next) => { saveThemeColors(theme, next); applyColors(); sync(); };

    // "Classic" restores this theme's stock look, as an explicit choice.
    const presets = [{ name: 'Classic', ...base }, ...COLOR_COMBOS];
    for (const p of presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'combo';
      b.title = p.name;
      b.setAttribute('aria-label', `${p.name} colours`);
      b.dataset.sidebar = p.sidebar;
      b.dataset.chat = p.chat;
      b.style.background = `linear-gradient(105deg, ${p.sidebar} 40%, ${p.chat} 40%)`;
      combos.append(b);
    }
    combos.addEventListener('click', (e) => {
      const b = e.target.closest('.combo');
      if (b) set({ sidebar: b.dataset.sidebar, chat: b.dataset.chat });
    });
    on(sbInput, 'input', () => set(Object.assign({}, activeColors(), { sidebar: sbInput.value })));
    on(chatInput, 'input', () => set(Object.assign({}, activeColors(), { chat: chatInput.value })));
    on(resetBtn, 'click', () => set(null));
    sync();
  }

  /* -------- display preferences: density, sidebar side, zoom (device-local) */
  const segs = {
    density: {
      get: () => (localStorage.getItem(LS.density) === 'compact' ? 'compact' : 'cozy'),
      set: (val) => { localStorage.setItem(LS.density, val); applyDensity(val); },
    },
    side: {
      get: () => (localStorage.getItem(LS.side) === 'right' ? 'right' : 'left'),
      set: (val) => { localStorage.setItem(LS.side, val); applySide(val); },
    },
    unjoined: {
      get: () => (showUnjoined ? 'show' : 'hide'),
      set: (val) => setShowUnjoined(val === 'show'),
    },
  };
  m.qa('.seg').forEach((seg) => {
    const setting = segs[seg.dataset.setting];
    if (!setting) return;
    const cur = setting.get();
    const paint = (val) => seg.querySelectorAll('button').forEach(
      (b) => b.classList.toggle('seg--on', b.dataset.value === val));
    paint(cur);
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const val = b.dataset.value;
      setting.set(val);
      paint(val);
    });
  });

  const zoomRange = m.q('.zoom-range');
  const zoomVal = m.q('.zoom-val');
  const syncZoom = () => {
    const z = currentZoom();
    if (zoomRange) zoomRange.value = String(z);
    if (zoomVal) zoomVal.textContent = Math.round(z * 100) + '%';
  };
  on(zoomRange, 'input', () => { setZoom(parseFloat(zoomRange.value)); syncZoom(); });
  m.qa('.zoom-step').forEach((b) => on(b, 'click', () => {
    setZoom(currentZoom() + Number(b.dataset.dir) * ZOOM_STEP);
    syncZoom();
  }));
  on(zoomVal, 'click', () => { setZoom(1); syncZoom(); }); // click % to reset
  syncZoom();

  const fontSel = m.q('.font-select');
  const fontCustom = m.q('.font-custom');
  const fontFile = m.q('.font-file');
  const fontRemove = m.q('.font-remove');
  if (fontSel) {
    // Skip faces this machine provably lacks. Best effort: entries without a
    // probe are always offered, and a false positive still renders fine
    // through the stack's fallbacks.
    const canCheck = !!(document.fonts && document.fonts.check);
    for (const f of FONTS) {
      if (f.probe && canCheck && !document.fonts.check(`12px "${f.probe}"`)) continue;
      const opt = document.createElement('option');
      opt.value = f.stack;
      opt.textContent = f.name;
      if (f.stack) opt.style.fontFamily = f.stack; // preview, where supported
      fontSel.append(opt);
    }
    const custom = document.createElement('option');
    custom.value = '__custom';
    custom.textContent = 'Custom…';
    fontSel.append(custom);
    const upload = document.createElement('option');
    upload.value = '__upload';
    upload.textContent = 'Upload…';
    fontSel.append(upload);

    // The uploaded font's option exists whenever a record does, labelled with
    // the original filename and slotted before Custom….
    const ensureUploadedOption = (name) => {
      let opt = [...fontSel.options].find((o) => o.value === FONT_UPLOADED_STACK);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = FONT_UPLOADED_STACK;
        opt.style.fontFamily = FONT_UPLOADED_STACK;
        fontSel.insertBefore(opt, custom);
      }
      opt.textContent = `Uploaded: ${name}`;
      if (fontRemove) fontRemove.hidden = false;
    };

    // Reflect the applied choice; a stack no option claims is a custom one.
    const sync = () => {
      const cur = localStorage.getItem(LS.font) || '';
      if ([...fontSel.options].some((o) => o.value === cur)) {
        fontSel.value = cur;
        if (fontCustom && cur !== '__custom') fontCustom.hidden = true;
      } else if (cur && fontCustom && !cur.startsWith(`"${FONT_UPLOADED_FAMILY}"`)) {
        fontSel.value = '__custom';
        fontCustom.hidden = false;
        fontCustom.value = cur.split(',')[0].trim().replace(/^"|"$/g, '');
      }
    };
    sync();
    // The uploaded entry arrives async; a stored stack pointing at it selects
    // properly once the record's name is known. A stale stack whose bytes are
    // gone (cleared IDB) degrades back to System.
    loadUploadedFont().then((rec) => {
      const cur = localStorage.getItem(LS.font) || '';
      if (rec && rec.name) ensureUploadedOption(rec.name);
      else if (cur === FONT_UPLOADED_STACK) setFont('');
      sync();
    }).catch(() => {});

    on(fontSel, 'change', () => {
      if (fontSel.value === '__custom') {
        if (fontCustom) { fontCustom.hidden = false; fontCustom.focus(); }
        return;
      }
      if (fontCustom) fontCustom.hidden = true;
      if (fontSel.value === '__upload') {
        if (fontFile) fontFile.click();
        return; // sync() restores the selection after the dialog resolves
      }
      setFont(fontSel.value); // '' (System) clears back to the default
    });
    // Free-text: any installed face by exact name, default stack as fallback.
    on(fontCustom, 'input', () => {
      const name = fontCustom.value.trim().replace(/"/g, '');
      setFont(name ? `"${name}", ${FONT_DEFAULT}` : '');
    });

    on(fontFile, 'change', async () => {
      const file = fontFile.files && fontFile.files[0];
      fontFile.value = ''; // re-picking the same file must fire change again
      if (!file) { sync(); return; }
      if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) {
        toast('Pick a .ttf, .otf, .woff or .woff2 file.', true);
        sync();
        return;
      }
      if (file.size > 10 << 20) {
        toast('That font is over 10 MB — pick a smaller one.', true);
        sync();
        return;
      }
      try {
        const bytes = await file.arrayBuffer();
        await registerUploadedFont(bytes); // rejects on undecodable input
        await storeUploadedFont({ name: file.name, bytes });
        setFont(FONT_UPLOADED_STACK);
        ensureUploadedOption(file.name);
        toast(`Font ${file.name} uploaded`);
      } catch {
        toast('That file does not decode as a font.', true);
      }
      sync();
    });
    on(fontFile, 'cancel', () => sync()); // dialog dismissed — undo "Upload…"

    on(fontRemove, 'click', async () => {
      await deleteUploadedFont().catch(() => {});
      if ((localStorage.getItem(LS.font) || '') === FONT_UPLOADED_STACK) setFont('');
      const opt = [...fontSel.options].find((o) => o.value === FONT_UPLOADED_STACK);
      if (opt) opt.remove();
      fontRemove.hidden = true;
      sync();
      toast('Uploaded font removed');
    });
  }

  /* -------- profile picture */
  const preview = m.q('.avatar-preview');
  const uploadBtn = m.q('.avatar-upload');
  const fileInput = m.q('.avatar-file');
  const removeBtn = m.q('.avatar-remove');

  let objectUrl = null;
  const releasePreview = () => {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  };
  m.onClose = releasePreview;

  const renderAvatarControls = () => {
    if (preview) {
      applyAvatar(preview, state.me);
      preview.dataset.color = color;
    }
    if (removeBtn) removeBtn.hidden = !(state.me && state.me.avatar_url);
  };
  renderAvatarControls();

  const uploadAvatar = async (file) => {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      toast('Profile pictures must be image files.', true);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast('That image is over 8 MB — pick a smaller one.', true);
      return;
    }
    // Instant local preview while the upload runs.
    releasePreview();
    objectUrl = URL.createObjectURL(file);
    if (preview) {
      preview.classList.add('avatar-uploading');
      const img = preview.querySelector('.avatar-img');
      if (img) { img.src = objectUrl; img.hidden = false; }
    }
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await api('/api/users/me/avatar', { method: 'POST', body: fd });
      applyUserUpdate(data.user);
      toast('Profile picture updated');
    } catch { /* toasted by api(); old picture restored below */ }
    if (preview) preview.classList.remove('avatar-uploading');
    renderAvatarControls(); // repaints from state.me — success or rollback
    releasePreview();       // the blob is no longer referenced by the img
  };

  on(uploadBtn, 'click', () => { if (fileInput) fileInput.click(); });
  on(fileInput, 'change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // re-picking the same file must fire change again
    uploadAvatar(file);
  });
  on(removeBtn, 'click', async () => {
    try {
      const data = await api('/api/users/me/avatar', { method: 'DELETE' });
      applyUserUpdate(data.user);
      renderAvatarControls();
      toast('Profile picture removed');
    } catch { /* toasted */ }
  });

  // Small print: version + repo link, at the very bottom of the modal.
  const about = m.q('.about-version');
  if (about) about.textContent = bootedVersion || 'dev';

  // Guaranteed route to a voluntary password change, beside Save.
  const foot = m.q('.modal-foot');
  if (foot) {
    const pw = document.createElement('button');
    pw.type = 'button';
    pw.className = 'btn mform-password';
    pw.textContent = 'Change password…';
    foot.insertBefore(pw, m.q('.mform-submit'));
    on(pw, 'click', () => { m.close(); openPasswordModal(false); });
  }

  on(form, 'submit', async (e) => {
    e.preventDefault();
    formError(m, '');
    try {
      const data = await api('/api/users/me', {
        method: 'PATCH',
        toast: false,
        body: {
          display_name: nameEl ? nameEl.value.trim() : undefined,
          status_text: statusEl ? statusEl.value.trim() : undefined,
          avatar_color: color,
        },
      });
      applyUserUpdate(data.user);
      m.close();
      toast('Profile saved');
    } catch (err) {
      formError(m, err.message);
    }
  });
}

/* -------- password */

function openPasswordModal(forced = false) {
  if (blockedOffline('Changing your password')) return;
  const m = openModal('tpl-modal-password', { forced });
  if (!m) return;
  // First login (forced) also collects the display name the admin no longer
  // sets at creation. Prefilled with the email-derived placeholder so the user
  // can just confirm or edit it. A voluntary change hides the field entirely.
  const nameField = m.q('.pw-name-field');
  const nameInput = m.q('[name=display_name]');
  if (forced && nameField) {
    nameField.hidden = false;
    if (nameInput) nameInput.value = (state.me && state.me.display_name) || '';
    const note = m.q('.modal-note');
    if (note) note.textContent = 'Welcome! Choose your display name and a password (at least 8 characters).';
  }
  const form = m.q('form') || m.q('.mform');
  on(form, 'submit', async (e) => {
    e.preventDefault();
    const cur = m.q('[name=current_password]');
    const nw = m.q('[name=new_password]');
    const conf = m.q('[name=confirm_password]');
    formError(m, '');
    const name = nameInput ? nameInput.value.trim() : '';
    if (forced && !name) {
      formError(m, 'Please choose a display name.');
      return;
    }
    if (!nw || nw.value.length < 8) {
      formError(m, 'New password must be at least 8 characters.');
      return;
    }
    if (conf && nw.value !== conf.value) {
      formError(m, 'Passwords do not match.');
      return;
    }
    try {
      await api('/api/auth/password', {
        method: 'POST',
        toast: false,
        body: {
          current_password: cur ? cur.value : '',
          new_password: nw.value,
          ...(forced ? { display_name: name } : {}),
        },
      });
      if (forced && name && state.me) {
        state.me.display_name = name;
        state.users.set(state.me.id, state.me);
        renderSidebar();
        renderMeChip();
      }
      state.mustChangePw = false;
      m.forced = false;
      m.close();
      toast(forced ? 'Welcome to slock!' : 'Password updated');
    } catch (err) {
      formError(m, err.message);
    }
  });
}

/* -------- admin */

function adminRow(user) {
  const row = tpl('tpl-admin-row');
  if (!row) return null;
  row.dataset.userId = user.id;
  // The admin-row template has no contracted avatar slot; honour one if the
  // markup grows it.
  applyAvatar(row.querySelector('.arow-avatar, .member-avatar'), user);
  const name = row.querySelector('.arow-name');
  if (name) name.textContent = user.display_name;
  const email = row.querySelector('.arow-email');
  if (email) email.textContent = user.email || '';
  const badges = row.querySelector('.arow-badges');
  if (badges) {
    badges.textContent = [
      user.is_admin ? 'admin' : '',
      user.is_active ? '' : 'disabled',
    ].filter(Boolean).join(' · ');
  }
  const setToggle = (sel, val, disable) => {
    const el = row.querySelector(sel);
    if (!el) return;
    if (el.matches('input[type=checkbox]')) el.checked = val;
    el.setAttribute('aria-pressed', val ? 'true' : 'false');
    el.classList.toggle('is-on', !!val);
    if (disable) el.disabled = true;
  };
  const self = state.me && user.id === state.me.id;
  setToggle('.arow-admin-toggle', user.is_admin, self);
  setToggle('.arow-active-toggle', user.is_active, self);
  const allowed = row.querySelector('.arow-allowed');
  if (allowed) allowed.value = user.allowed_channels || '*';
  return row;
}

function showAdminResult(m, text, secret) {
  const box = m.q('.admin-new-result');
  if (!box) { toast(text + ' ' + secret); return; }
  box.hidden = false;
  box.textContent = '';
  const span = document.createElement('span');
  span.textContent = text + ' ';
  const code = document.createElement('code');
  code.textContent = secret;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'admin-copy';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => copyText(secret, 'Password copied'));
  box.append(span, code, ' ', copy);
}

async function openAdminModal() {
  if (blockedOffline('Admin')) return;
  if (!state.me || !state.me.is_admin) return;
  const m = openModal('tpl-modal-admin');
  if (!m) return;
  const tbody = m.q('.admin-users');
  let users = [];

  const render = () => {
    if (!tbody) return;
    tbody.textContent = '';
    for (const u of users) {
      const row = adminRow(u);
      if (row) tbody.append(row);
    }
  };

  const reload = async () => {
    try {
      const data = await api('/api/admin/users');
      users = data.users;
      render();
    } catch { /* toasted */ }
  };

  if (tbody) {
    tbody.addEventListener('click', async (e) => {
      const row = e.target.closest('.arow, [data-user-id]');
      if (!row) return;
      const uid = Number(row.dataset.userId);
      const user = users.find((u) => u.id === uid);
      if (!user) return;

      if (e.target.closest('.arow-admin-toggle')) {
        try {
          const data = await api(`/api/admin/users/${uid}`, {
            method: 'PATCH', body: { is_admin: !user.is_admin },
          });
          Object.assign(user, data.user);
          render();
        } catch { render(); }
      } else if (e.target.closest('.arow-active-toggle')) {
        const verb = user.is_active ? 'Deactivate' : 'Reactivate';
        const ok = await confirmModal(`${verb} ${user.display_name}?`, verb);
        if (!ok) { render(); return; }
        try {
          const data = await api(`/api/admin/users/${uid}`, {
            method: 'PATCH', body: { is_active: !user.is_active },
          });
          Object.assign(user, data.user);
          render();
        } catch { render(); }
      } else if (e.target.closest('.arow-reset')) {
        const ok = await confirmModal(`Reset ${user.display_name}'s password? The current one stops working immediately.`, 'Reset');
        if (!ok) return;
        try {
          const data = await api(`/api/admin/users/${uid}/reset-password`, { method: 'POST' });
          showAdminResult(m, `Temporary password for ${user.display_name}:`, data.temp_password);
        } catch { /* toasted */ }
      } else if (e.target.closest('.arow-save')) {
        const input = row.querySelector('.arow-allowed');
        if (input) saveAllowed(uid, input);
      }
    });

    // The channel allowlist is committed explicitly (the Save button or Enter),
    // so an edit is not lost or applied by a stray focus change.
    tbody.addEventListener('keydown', (e) => {
      const input = e.target.closest('.arow-allowed');
      if (!input || e.key !== 'Enter') return;
      e.preventDefault();
      const rowEl = e.target.closest('[data-user-id]');
      const uid = Number(rowEl && rowEl.dataset.userId);
      if (uid) saveAllowed(uid, input);
    });
  }

  const saveAllowed = async (uid, input) => {
    const user = users.find((u) => u.id === uid);
    if (!user) return;
    const value = input.value.trim() || '*';
    if (value === (user.allowed_channels || '*')) { toast('No channel changes to save'); return; }
    try {
      const data = await api(`/api/admin/users/${uid}`, {
        method: 'PATCH', body: { allowed_channels: value },
      });
      Object.assign(user, data.user);
      input.value = user.allowed_channels || '*'; // reflect server normalisation
      const scope = input.value === '*' ? 'all channels' : input.value;
      toast(`${user.display_name} can now access ${scope}`);
    } catch {
      input.value = user.allowed_channels || '*';
    }
  };

  /* -------- workspace identity (name + icon) */
  const wsForm = m.q('.ws-form');
  const wsName = m.q('[name=workspace_name]');
  const wsIconPreview = m.q('.ws-icon-preview');
  const wsIconUpload = m.q('.ws-icon-upload');
  const wsIconFile = m.q('.ws-icon-file');
  const wsIconRemove = m.q('.ws-icon-remove');

  const wsError = (text) => {
    const el = m.q('.ws-error');
    if (el) {
      el.textContent = text || '';
      el.hidden = !text;
    }
  };

  // force: the activeElement guard protects in-progress typing from live
  // workspace.update frames — but openModal focuses this very input, so the
  // initial prefill must ignore it or the field opens empty.
  const renderWs = (force = false) => {
    const ws = state.workspace;
    if (wsName && (force || document.activeElement !== wsName)) wsName.value = ws.name || '';
    if (wsIconPreview) {
      if (ws.icon_url) {
        if (wsIconPreview.getAttribute('src') !== ws.icon_url) wsIconPreview.src = ws.icon_url;
        wsIconPreview.hidden = false;
      } else {
        wsIconPreview.removeAttribute('src');
        wsIconPreview.hidden = true;
      }
    }
    if (wsIconRemove) wsIconRemove.hidden = !ws.icon_url;
  };
  renderWs(true);

  on(wsForm, 'submit', async (e) => {
    e.preventDefault();
    wsError('');
    const name = wsName ? wsName.value.trim() : '';
    if (!name || name.length > 40) {
      wsError('Workspace name must be 1–40 characters.');
      toast('Workspace name must be 1–40 characters.', true);
      return;
    }
    try {
      const data = await api('/api/admin/workspace', { method: 'PATCH', body: { name } });
      applyWorkspace(data.workspace);
      renderWs();
      toast('Workspace name saved');
    } catch (err) {
      wsError(err.message); // api() already toasted
    }
  });

  const uploadWsIcon = async (file) => {
    if (!file) return;
    wsError('');
    if (!file.type || !file.type.startsWith('image/')) {
      wsError('The workspace icon must be an image file.');
      toast('The workspace icon must be an image file.', true);
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      wsError('That image is over 4 MB — pick a smaller one.');
      toast('That image is over 4 MB — pick a smaller one.', true);
      return;
    }
    try {
      const fd = new FormData();
      fd.append('file', file);
      const data = await api('/api/admin/workspace/icon', { method: 'POST', body: fd });
      applyWorkspace(data.workspace);
      renderWs();
      toast('Workspace icon updated');
    } catch (err) {
      wsError(err.message); // api() already toasted
    }
  };

  on(wsIconUpload, 'click', () => { if (wsIconFile) wsIconFile.click(); });
  on(wsIconFile, 'change', () => {
    const file = wsIconFile.files && wsIconFile.files[0];
    wsIconFile.value = ''; // re-picking the same file must fire change again
    uploadWsIcon(file);
  });
  on(wsIconRemove, 'click', async () => {
    wsError('');
    try {
      const data = await api('/api/admin/workspace/icon', { method: 'DELETE' });
      applyWorkspace(data.workspace);
      renderWs();
      toast('Workspace icon removed');
    } catch (err) {
      wsError(err.message); // api() already toasted
    }
  });

  const form = m.q('.admin-new-form');
  on(form, 'submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    formError(m, '');
    try {
      const data = await api('/api/admin/users', {
        method: 'POST',
        toast: false,
        body: {
          email: String(fd.get('email') || '').trim(),
          is_admin: !!fd.get('is_admin'),
          limit_history: !!fd.get('limit_history'),
          allowed_channels: String(fd.get('allowed_channels') || '*').trim() || '*',
        },
      });
      users.unshift(data.user);
      state.users.set(data.user.id, data.user);
      render();
      form.reset();
      const ac = form.querySelector('[name=allowed_channels]');
      if (ac) ac.value = '*'; // reset() clears the value= default
      toast(`${data.user.email} created`);
    } catch (err) {
      formError(m, err.message);
    }
  });

  /* -------- API tokens (external posting via /api/send/<channel>) */
  const tokList = m.q('.tok-list');
  const tokForm = m.q('.tok-form');
  const tokResult = m.q('.tok-result');
  let tokens = [];

  const tokError = (text) => {
    const el = m.q('.tok-error');
    if (el) {
      el.textContent = text || '';
      el.hidden = !text;
    }
  };
  if (tokResult) tokResult.hidden = true; // fresh dialog: no stale reveal

  const tokenRow = (t) => {
    const row = tpl('tpl-token-row');
    if (!row) return null;
    row.dataset.id = t.id;
    const name = row.querySelector('.trow-name');
    if (name) name.textContent = t.name;
    const scope = row.querySelector('.trow-scope');
    if (scope) scope.textContent = t.scope;
    const used = row.querySelector('.trow-used');
    if (used) {
      used.textContent = t.last_used_at ? relativeTime(t.last_used_at) : 'never';
      if (t.last_used_at) used.title = new Date(t.last_used_at).toLocaleString();
    }
    const toggle = row.querySelector('.trow-active-toggle');
    if (toggle) {
      if (toggle.matches('input[type=checkbox]')) toggle.checked = t.is_active;
      toggle.setAttribute('aria-pressed', t.is_active ? 'true' : 'false');
      toggle.classList.toggle('is-on', !!t.is_active);
    }
    row.classList.toggle('trow--inactive', !t.is_active);
    return row;
  };

  const renderTokens = () => {
    if (!tokList) return;
    tokList.textContent = '';
    for (const t of tokens) {
      const row = tokenRow(t);
      if (row) tokList.append(row);
    }
  };

  // The secret exists only here, on the way to the screen and the clipboard —
  // never in state, storage, or the console. Shown once, until the dialog
  // closes.
  const revealSecret = (secret) => {
    if (!tokResult) {
      copyText(secret, 'Token copied — it will not be shown again');
      return;
    }
    tokResult.hidden = false;
    const sec = tokResult.querySelector('.tok-secret');
    if (sec) sec.textContent = secret;
    const copyBtn = tokResult.querySelector('.tok-copy');
    if (copyBtn) copyBtn.onclick = () => copyText(secret, 'Token copied');
    // The line someone actually wants right now: a ready-to-paste curl.
    let curl = tokResult.querySelector('.tok-curl');
    if (!curl) {
      curl = document.createElement('code');
      curl.className = 'tok-curl';
      curl.title = 'Click to copy';
      tokResult.append(curl);
    }
    const cmd = `curl -H "Authorization: Bearer ${secret}" -d 'hello' ${location.origin}/api/send/general`;
    curl.textContent = cmd;
    curl.onclick = () => copyText(cmd, 'curl command copied');
  };

  on(tokForm, 'submit', async (e) => {
    e.preventDefault();
    tokError('');
    const fd = new FormData(tokForm);
    const name = String(fd.get('token_name') || '').trim();
    const scope = String(fd.get('token_scope') || '').trim() || '*';
    if (!name) {
      tokError('Give the token a name — its messages post under that name.');
      toast('Give the token a name.', true);
      return;
    }
    try {
      const data = await api('/api/admin/tokens', { method: 'POST', body: { name, scope } });
      tokens.unshift(data.api_token); // server-canonicalised name/scope
      renderTokens();
      tokForm.reset();
      revealSecret(data.token);
    } catch (err) {
      tokError(err.message); // api() already toasted
    }
  });

  if (tokList) {
    tokList.addEventListener('click', async (e) => {
      const row = e.target.closest('.trow');
      if (!row) return;
      const id = Number(row.dataset.id);
      const t = tokens.find((x) => x.id === id);
      if (!t) return;

      if (e.target.closest('.trow-active-toggle')) {
        const next = !t.is_active;
        t.is_active = next; // optimistic, like the user rows
        renderTokens();
        try {
          const data = await api(`/api/admin/tokens/${id}`, {
            method: 'PATCH', body: { is_active: next },
          });
          Object.assign(t, data.api_token);
          renderTokens();
        } catch (err) {
          t.is_active = !next;
          renderTokens();
          tokError(err.message);
        }
      } else if (e.target.closest('.trow-delete')) {
        const ok = await confirmModal(
          `Delete "${t.name}"? Anything using this token stops working.`, 'Delete',
        );
        if (!ok) return;
        try {
          await api(`/api/admin/tokens/${id}`, { method: 'DELETE' });
          tokens = tokens.filter((x) => x.id !== id);
          renderTokens();
        } catch (err) {
          tokError(err.message);
        }
      }
    });
  }

  const reloadTokens = async () => {
    try {
      const data = await api('/api/admin/tokens');
      tokens = data.tokens || [];
      renderTokens();
    } catch (err) {
      tokError(err.message); // api() already toasted
    }
  };

  await Promise.all([reload(), reloadTokens()]);
}

/* ============================================================ menu / settings */

function applyTheme(value) {
  const html = document.documentElement;
  if (value === 'dark' || value === 'light') html.dataset.theme = value;
  else delete html.dataset.theme;
  const btn = byId('theme-btn');
  if (btn) {
    const mode = value === 'dark' || value === 'light' ? value : 'system';
    // The label span, not the button: its icon must survive.
    const label = btn.querySelector('.theme-label') || btn;
    label.textContent = `Theme: ${mode}`;
    btn.querySelectorAll('.theme-ic').forEach((ic) => {
      ic.hidden = !ic.classList.contains(`theme-ic--${mode}`);
    });
  }
  applyColors(); // each theme has its own custom-colour slot
}

function cycleTheme() {
  const cur = localStorage.getItem(LS.theme) || 'system';
  const next = cur === 'system' ? 'dark' : cur === 'dark' ? 'light' : 'system';
  localStorage.setItem(LS.theme, next);
  applyTheme(next);
}

/* -------- custom sidebar / chat colours (device-local, in localStorage).
   The picked colour becomes the surface's base token and every other token the
   surface's descendants use (--bg-*, --text-*, --border*, --accent*) is
   re-derived from its lightness, so any colour stays readable in both themes.
   Each theme has its own slot — the profile modal edits whichever theme is
   active — and the out-of-the-box look is aubergine. */

const COLOR_COMBOS = [
  { name: 'Aubergine',  sidebar: '#3f0e40', chat: '#f4f3f6' },
  { name: 'Ocean',      sidebar: '#12395b', chat: '#f2f7fa' },
  { name: 'Forest',     sidebar: '#1f3d2b', chat: '#f4f8f2' },
  { name: 'Terracotta', sidebar: '#69352a', chat: '#faf6f1' },
  { name: 'Midnight',   sidebar: '#11151d', chat: '#151a24' },
  { name: 'Mocha',      sidebar: '#332822', chat: '#171210' },
];

// The defaults: light gets the Aubergine preset, dark gets Midnight —
// dark-on-dark reads better than an aubergine sidebar on a dark canvas.
const DEFAULT_COLORS = {
  light: { sidebar: '#3f0e40', chat: '#f4f3f6' },
  dark: { sidebar: '#11151d', chat: '#151a24' },
};

const isHexColor = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

// The theme actually painting the page right now (the "system" choice resolves
// to whatever the OS prefers).
function effectiveTheme() {
  const t = localStorage.getItem(LS.theme);
  if (t === 'dark' || t === 'light') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// {light?: {sidebar?, chat?}, dark?: {...}} — only valid entries survive.
function loadColorsStore() {
  const out = {};
  try {
    const c = JSON.parse(localStorage.getItem(LS.colors) || 'null') || {};
    for (const theme of ['light', 'dark']) {
      const t = c[theme];
      if (!t) continue;
      const v = {};
      if (isHexColor(t.sidebar)) v.sidebar = t.sidebar;
      if (isHexColor(t.chat)) v.chat = t.chat;
      if (v.sidebar || v.chat) out[theme] = v;
    }
  } catch { /* corrupted — treat as unset */ }
  return out;
}

function saveThemeColors(theme, v) {
  const store = loadColorsStore();
  if (v && (isHexColor(v.sidebar) || isHexColor(v.chat))) store[theme] = v;
  else delete store[theme];
  if (store.light || store.dark) localStorage.setItem(LS.colors, JSON.stringify(store));
  else localStorage.removeItem(LS.colors);
}

// What should be painted for the current theme: stored choice over default.
function activeColors() {
  const theme = effectiveTheme();
  return Object.assign({}, DEFAULT_COLORS[theme], loadColorsStore()[theme]);
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mixRgb = (a, b, t) =>
  `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(', ')})`;

// surfaceVars builds the token overrides for an element painted with `hex`.
// `elevated` marks the sidebar, whose base surface token is --bg-1; the chat
// column's base is --bg-0.
function surfaceVars(hex, elevated) {
  const c = hexRgb(hex);
  const W = [255, 255, 255];
  const K = [8, 11, 16];
  const dark = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] < 140;
  const up = (t) => mixRgb(c, dark ? W : K, t); // hover / border direction
  const vars = dark ? {
    '--text-1': '#edf0f5',
    '--text-2': 'rgba(233, 237, 243, 0.74)',
    '--text-3': 'rgba(233, 237, 243, 0.54)',
    '--border': up(0.12),
    '--border-strong': up(0.25),
    '--accent': '#a3b1ff',
    '--accent-soft': 'rgba(163, 177, 255, 0.17)',
    '--bg-2': up(0.09),
    '--bg-3': up(0.12),
  } : {
    '--text-1': '#1b2430',
    '--text-2': 'rgba(27, 36, 48, 0.76)',
    '--text-3': 'rgba(27, 36, 48, 0.56)',
    '--border': up(0.13),
    '--border-strong': up(0.26),
    '--accent': '#3a49c2',
    '--accent-soft': 'rgba(67, 83, 201, 0.13)',
    '--bg-2': up(0.07),
    '--bg-3': mixRgb(c, W, 0.6), // popovers still lift toward white
  };
  if (elevated) {
    vars['--bg-1'] = hex;
    vars['--bg-0'] = mixRgb(c, K, dark ? 0.22 : 0.05); // inset (search field)
  } else {
    vars['--bg-0'] = hex;
    vars['--bg-1'] = dark ? up(0.05) : mixRgb(c, W, 0.55); // cards, composer
  }
  return vars;
}

function applyColors() {
  const c = activeColors();
  const targets = [
    [byId('sidebar'), c.sidebar, true],
    [byId('main'), c.chat, false],
  ];
  for (const [el, color, elevated] of targets) {
    if (!el) continue;
    el.style.cssText = ''; // drop any previous override set
    if (!isHexColor(color)) continue;
    for (const [k, v] of Object.entries(surfaceVars(color, elevated))) {
      el.style.setProperty(k, v);
    }
  }
}

// Sidebar side and message density (both device-local) are set from the
// profile modal now. These stay pure appliers so boot and the modal share them.
// Desktop only — the CSS ignores body.side-hidden under the phone breakpoint,
// where the sidebar is a drawer.
function setSidebarHidden(on) {
  document.body.classList.toggle('side-hidden', !!on);
  try {
    if (on) localStorage.setItem(LS.sideHidden, '1'); else localStorage.removeItem(LS.sideHidden);
  } catch { /* still applies for this session */ }
}

function applySide(value) {
  // Default is left; only an explicit "right" moves the sidebar.
  document.body.classList.toggle('side-right', value === 'right');
  document.body.classList.toggle('side-left', value !== 'right');
}

function applyDensity(value) {
  // compact drops the avatar column and inlines author + time before the text.
  document.body.classList.toggle('density-compact', value === 'compact');
}

/* -------- view zoom (device-local): scales the whole app view, like browser
   zoom but scoped to slock. #app compensates its size so it still fills the
   viewport at any zoom (see the CSS). 1 = 100%. */

const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.02; // fine, 2% per tick / button press

function clampZoom(z) {
  if (!Number.isFinite(z)) z = 1;
  z = Math.round(z / ZOOM_STEP) * ZOOM_STEP;        // snap to the step grid
  z = Math.round(z * 100) / 100;                    // shed binary-float drift
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function applyZoom(z) {
  z = clampZoom(z);
  document.documentElement.style.setProperty('--zoom', String(z));
  return z;
}

// Set + persist (100% is the default, so it clears the key rather than storing).
function setZoom(z) {
  z = applyZoom(z);
  if (Math.abs(z - 1) < 0.001) localStorage.removeItem(LS.zoom);
  else localStorage.setItem(LS.zoom, String(z));
  return z;
}

function currentZoom() {
  return clampZoom(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom')) || 1);
}

/* -------- UI font (device-local): swaps the --font-sans token the whole
   interface derives from. Stored as a full CSS stack; absent = the built-in
   default. Every curated stack ends in a generic family, so a machine that
   lacks the face degrades to something sane rather than to nothing. */

// Mirrors the stylesheet's --font-sans so custom picks can fall back to it.
const FONT_DEFAULT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif';

// name: shown in the select. probe: the concrete face document.fonts.check
// tests for (entries without one are always offered). stack: what --font-sans
// becomes; '' means the default token (and clears the stored key).
const FONTS = [
  { name: 'System', stack: '' },
  { name: 'Inter', probe: 'Inter', stack: 'Inter, ' + FONT_DEFAULT },
  { name: 'SF Pro', probe: 'SF Pro Text', stack: '-apple-system, "SF Pro Text", system-ui, sans-serif' },
  { name: 'Helvetica', probe: 'Helvetica', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { name: 'Segoe UI', probe: 'Segoe UI', stack: '"Segoe UI", system-ui, sans-serif' },
  { name: 'Roboto', probe: 'Roboto', stack: 'Roboto, "Noto Sans", sans-serif' },
  { name: 'Ubuntu', probe: 'Ubuntu', stack: 'Ubuntu, "Noto Sans", sans-serif' },
  { name: 'Cantarell', probe: 'Cantarell', stack: 'Cantarell, "Noto Sans", sans-serif' },
  { name: 'Noto Sans', probe: 'Noto Sans', stack: '"Noto Sans", sans-serif' },
  { name: 'Georgia', probe: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
  { name: 'Mono', stack: 'ui-monospace, "JetBrains Mono", Iosevka, Menlo, Consolas, monospace' },
];

function applyFont(stack) {
  if (stack) document.documentElement.style.setProperty('--font-sans', stack);
  else document.documentElement.style.removeProperty('--font-sans');
}

function setFont(stack) {
  applyFont(stack);
  if (stack) localStorage.setItem(LS.font, stack);
  else localStorage.removeItem(LS.font);
}

/* -------- uploaded font (device-local). The bytes live in IndexedDB — the
   one thing localStorage cannot hold — as a single record; the face registers
   under a fixed family name that the stored --font-sans stack references. A
   FontFace built from a buffer never fetches, so the same-origin CSP is not
   involved. */

const FONT_UPLOADED_FAMILY = 'slock-custom';
const FONT_UPLOADED_STACK = `"${FONT_UPLOADED_FAMILY}", ${FONT_DEFAULT}`;

// One db, one store, one key. Each op opens and closes its own connection —
// at this frequency (profile edits and boot) pooling would be vanity.
function fontStoreOp(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('slock', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('fonts');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = fn(db.transaction('fonts', mode).objectStore('fonts'));
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  });
}

const storeUploadedFont = (rec) => fontStoreOp('readwrite', (s) => s.put(rec, 'custom'));
const loadUploadedFont = () => fontStoreOp('readonly', (s) => s.get('custom'));
const deleteUploadedFont = () => fontStoreOp('readwrite', (s) => s.delete('custom'));

// registerUploadedFont makes the bytes usable as FONT_UPLOADED_FAMILY,
// replacing any face a previous upload registered this session. Rejects on
// undecodable input, which is the corrupt-file signal.
async function registerUploadedFont(bytes) {
  const face = new FontFace(FONT_UPLOADED_FAMILY, bytes);
  await face.load();
  document.fonts.forEach((f) => {
    if (f.family.replace(/^"|"$/g, '') === FONT_UPLOADED_FAMILY) document.fonts.delete(f);
  });
  document.fonts.add(face);
}

// Boot companion to applyFont: fire-and-forget, because until the face
// registers the stack's fallbacks render and then the page reflows once.
async function restoreUploadedFont() {
  try {
    const rec = await loadUploadedFont();
    if (rec && rec.bytes) await registerUploadedFont(rec.bytes);
  } catch { /* nothing stored, or IDB unavailable — fallbacks cover it */ }
}

/* -------- sidebar width (device-local, desktop only): drag the inner edge;
   double-click the handle to reset to the stylesheet default */

function applySidebarWidth(w) {
  if (w) document.documentElement.style.setProperty('--sidebar-w', w + 'px');
  else document.documentElement.style.removeProperty('--sidebar-w');
}

function wireSidebarResize() {
  const handle = byId('side-resize');
  if (!handle) return;
  const clampW = (w) => Math.max(200, Math.min(Math.floor(innerWidth * 0.4), Math.round(w)));
  let width = 0; // last dragged value, persisted on release
  on(handle, 'pointerdown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  on(handle, 'pointermove', (e) => {
    if (!handle.classList.contains('dragging')) return;
    width = clampW(document.body.classList.contains('side-right') ? innerWidth - e.clientX : e.clientX);
    applySidebarWidth(width);
  });
  on(handle, 'pointerup', () => {
    if (!handle.classList.contains('dragging')) return;
    handle.classList.remove('dragging');
    if (width) localStorage.setItem(LS.sidebarW, String(width));
  });
  on(handle, 'dblclick', () => {
    width = 0;
    localStorage.removeItem(LS.sidebarW);
    applySidebarWidth(0);
  });
}

function closeMeMenu() {
  const menu = byId('me-menu');
  if (menu && !menu.hidden) { menu.hidden = true; return true; }
  return false;
}

function wireMenu() {
  const menu = byId('me-menu');
  on(byId('me-chip'), 'click', (e) => {
    e.stopPropagation();
    if (menu) menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (menu && !menu.hidden && !menu.contains(e.target) && !e.target.closest('#me-chip')) {
      menu.hidden = true;
    }
  });

  on(byId('profile-btn'), 'click', () => { closeMeMenu(); openProfileModal(); });
  on(byId('admin-btn'), 'click', () => { closeMeMenu(); openAdminModal(); });
  on(byId('theme-btn'), 'click', () => cycleTheme());
  on(byId('notifications-btn'), 'click', () => { toggleNotifications(); });
  on(byId('sound-btn'), 'click', () => toggleSound());
  reflectSoundBtn();
  on(byId('logout-btn'), 'click', async () => {
    closeMeMenu();
    try { await api('/api/auth/logout', { method: 'POST', toast: false }); } catch { /* ignore */ }
    await clearOfflineCache(); // before the redirect: the next person is not this one
    location.href = '/login.html';
  });

  // Voluntary password change: #password-btn is not a contract id, so it is
  // optional — the guaranteed path is the button inside the profile modal.
  on(byId('password-btn'), 'click', () => { closeMeMenu(); openPasswordModal(false); });
}

/* -------- mute (per-member server state, POST /api/channels/{id}/mute;
   other tabs sync via the channel.mute event) */

function toggleMute() {
  const ch = state.channels.get(state.currentId);
  if (!ch) return;
  const next = !isMuted(ch);
  ch.muted = next; // optimistic; channel.mute / refetch are authoritative
  api(`/api/channels/${ch.id}/mute`, { method: 'POST', body: { muted: next } })
    .catch(() => {
      ch.muted = !next;
      renderSidebar();
      renderChannelHeader();
      updateBadges();
    });
  renderSidebar();
  renderChannelHeader();
  updateBadges();
  toast(next ? `Muted ${channelDisplayName(ch)}` : `Unmuted ${channelDisplayName(ch)}`);
}

/* ============================================================ push / service worker */

function urlB64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let swRegistration = null;

// Ask the worker to drop everything it stored for offline reading, and wait
// for it: the Cache API is scoped to the origin, not to the signed-in person,
// so this is what stops the next user on a shared device reading these
// messages. Bounded, because a hung worker must never trap someone in a
// session they asked to leave.
async function clearOfflineCache() {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return;
  await new Promise((resolve) => {
    const done = setTimeout(resolve, 1500);
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { clearTimeout(done); resolve(); };
    try {
      sw.postMessage({ type: 'clear-cache' }, [ch.port2]);
    } catch {
      clearTimeout(done);
      resolve();
    }
  });
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // A new build id changes the script URL, which makes the browser install a
  // fresh worker whose cache name (slock-<v>) obsoletes the old shell.
  const v = await Promise.race([
    versionReady,
    new Promise((resolve) => setTimeout(() => resolve(''), 3000)),
  ]);
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js?v=' + encodeURIComponent(v || 'dev'));
  } catch (err) {
    console.warn('service worker registration failed', err);
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'navigate' && e.data.url) {
      try {
        const u = new URL(e.data.url, location.origin);
        const c = u.searchParams.get('c');
        if (c) openChannel(Number(c));
      } catch { /* ignore malformed url */ }
    }
  });
}

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function currentPushSubscription() {
  if (!pushSupported() || !swRegistration) return null;
  try { return await swRegistration.pushManager.getSubscription(); } catch { return null; }
}

/* -------- new-message sound (device-local, #sound-btn) --------
   A short blip synthesised with the Web Audio API — no asset to ship, and it
   works offline. The context is created/resumed from the toggle click (a user
   gesture), which satisfies autoplay policies. */

let soundEnabled = false;
try { soundEnabled = localStorage.getItem(LS.sound) === '1'; } catch { /* private mode */ }
let audioCtx = null;

function ensureAudioCtx() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch {
    return null;
  }
}

function playMessageSound() {
  if (!soundEnabled) return;
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(660, t);
  osc.frequency.exponentialRampToValueAtTime(880, t + 0.07);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.14, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.25);
}

function reflectSoundBtn() {
  const btn = byId('sound-btn');
  if (!btn) return;
  const label = btn.querySelector('.sound-label') || btn;
  label.textContent = soundEnabled ? 'Sound: on' : 'Sound: off';
  btn.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false');
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  try {
    if (soundEnabled) localStorage.setItem(LS.sound, '1');
    else localStorage.removeItem(LS.sound);
  } catch { /* private mode */ }
  reflectSoundBtn();
  if (soundEnabled) { ensureAudioCtx(); playMessageSound(); } // unlock + preview
}

async function refreshNotifButton() {
  const btn = byId('notifications-btn');
  if (!btn) return;
  // Write into the label span, not the button: its bell icon must survive.
  const label = btn.querySelector('.notif-label') || btn;
  if (!pushSupported()) {
    btn.disabled = true;
    btn.title = 'Push notifications are not supported in this browser.';
    label.textContent = 'Notifications unavailable';
    return;
  }
  if (!state.pushKey) {
    btn.disabled = true;
    btn.title = 'Push is disabled on this server (no VAPID key configured).';
    label.textContent = 'Notifications unavailable';
    return;
  }
  if (Notification.permission === 'denied') {
    btn.disabled = true;
    btn.title = 'Notifications are blocked for this site in your browser settings.';
    label.textContent = 'Notifications blocked';
    return;
  }
  const sub = await currentPushSubscription();
  btn.disabled = false;
  btn.title = '';
  label.textContent = sub ? 'Notifications: on' : 'Enable notifications';
}

// Only ever called from an explicit click on #notifications-btn.
async function toggleNotifications() {
  if (!pushSupported() || !state.pushKey) return;
  const sub = await currentPushSubscription();
  if (sub) {
    try {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint }, toast: false });
    } catch { /* best effort */ }
    await sub.unsubscribe().catch(() => {});
    toast('Notifications disabled');
    refreshNotifButton();
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { refreshNotifButton(); return; }
    const keyData = await api('/api/push/key', { toast: false });
    if (!keyData || !keyData.public_key) {
      state.pushKey = '';
      refreshNotifButton();
      return;
    }
    state.pushKey = keyData.public_key;
    if (!swRegistration) swRegistration = await navigator.serviceWorker.ready;
    const newSub = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(state.pushKey),
    });
    const json = newSub.toJSON();
    await api('/api/push/subscribe', {
      method: 'POST',
      body: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    });
    toast('Notifications enabled');
  } catch (err) {
    console.warn('push subscribe failed', err);
    toast('Could not enable notifications', true);
  }
  refreshNotifButton();
}

/* ============================================================ global events */

function wireMessageList() {
  const list = byId('message-list');
  const sc = byId('message-scroll');
  // Long-press arming state (phones), up here because the scroll handler
  // guards it: scrolling never SELECTS — a pending or armed hold is wiped by
  // any scroll, and a finger landing on a coasting list (to stop it) must
  // not start one. A row already held before the scroll stays held; that is
  // deliberate.
  let holdTimer = 0;
  let holdX = 0, holdY = 0;
  let holdStartAt = 0;
  let lastScrollAt = 0;
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = 0; };
  if (sc) {
    sc.addEventListener('scroll', () => {
      sc.classList.add('is-scrolling');
      // A real scroll: record it (a pending long-press checks this and aborts,
      // rather than being cancelled here — mobile fires stray scroll events
      // during a stationary press, e.g. an overscroll bounce, which must not
      // kill a legitimate hold) and release any menu already shown.
      lastScrollAt = performance.now();
      clearHeldMsg();
      state.atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;
      if (state.atBottom && state.currentId) {
        chanState(state.currentId).jumpCount = 0;
        maybeMarkRead();
      }
      updateJumpLatest();
      if (sc.scrollTop < 240) {
        if (state.currentId) loadOlder(state.currentId);
        else if (state.latest) loadOlderLatest();
      }
      // A detached window (after a far jump) grows downwards as you near its
      // end, until it meets the present.
      if (state.currentId && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 240
        && chanState(state.currentId).hasNewer) {
        loadNewer(state.currentId);
      }
      scheduleTrim();
    }, { passive: true });
    // Back at the bottom and settled: drop what scrolling back piled up, so
    // the page never keeps more than a bounded window (see trimOldMessages).
    // Waits for the scroll to stop: removing rows mid-fling would jank it.
    let trimTimer = 0;
    const scheduleTrim = () => {
      clearTimeout(trimTimer);
      trimTimer = setTimeout(() => {
        if (sc.scrollHeight - sc.scrollTop - sc.clientHeight >= 48) return;
        if (state.currentId) trimOldMessages(state.currentId, true);
        else if (state.latest) trimLatest();
      }, 800);
    };
    // Re-arm hover only on real pointer movement. Chrome re-dispatches a
    // synthetic mousemove at the old coordinates after a scroll to refresh
    // hover targets; a same-position event must not count as movement.
    let lastMX = -1, lastMY = -1;
    sc.addEventListener('mousemove', (e) => {
      if (e.clientX === lastMX && e.clientY === lastMY) return;
      lastMX = e.clientX;
      lastMY = e.clientY;
      sc.classList.remove('is-scrolling');
    });
    // On touch there is no hover to re-arm; clear the class anyway so a tap
    // never finds a toolbar still forced hidden.
    sc.addEventListener('touchstart', () => sc.classList.remove('is-scrolling'), { passive: true });
  }
  if (!list) return;

  // Touch: a tap on a message is a non-event; the one gesture that reveals a
  // row's actions is a long press — hold ~0.65s roughly in place and the
  // toolbar appears (finger still down), staying until another spot is tapped
  // or the list is scrolled. The press is cancelled ONLY by real finger
  // movement (touchmove past a threshold); it deliberately does NOT trust
  // touchcancel or scroll events to cancel it, because mobile fires those
  // spuriously during a stationary press and that was silently killing every
  // hold. Instead the timer, when it fires, aborts if a genuine scroll landed
  // after the press began. CSS disables text selection / callout on touch;
  // images are skipped so their own long-press (save / share) stays clean.
  list.addEventListener('touchstart', (e) => {
    cancelHold();
    if (e.touches.length !== 1) return;
    const row = e.target.closest('.msg');
    const held = list.querySelector('.msg--held');
    if (held && held !== row) clearHeldMsg(); // tapping elsewhere lets go
    if (!row || row.classList.contains('msg--system') || row.classList.contains('msg--latest')
      || e.target.closest('.att-img') || e.target.closest('.msg-actions')) return;
    // A finger landing on a coasting list is there to stop the scroll — it
    // must never read as the start of a long-press.
    if (performance.now() - lastScrollAt < 200) return;
    const t = e.touches[0];
    holdX = t.clientX;
    holdY = t.clientY;
    holdStartAt = performance.now();
    holdTimer = setTimeout(() => {
      holdTimer = 0;
      if (lastScrollAt > holdStartAt) return; // the list scrolled: not a hold
      clearHeldMsg();
      row.classList.add('msg--held');
      if (navigator.vibrate) navigator.vibrate(15);
    }, 650);
  }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    if (!e.touches[0]) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - holdX) <= 12 && Math.abs(t.clientY - holdY) <= 12) return;
    // Real movement: this is a scroll/drag, not a hold. Cancel a pending press
    // and release a menu already shown (a drag near a list end, or in a short
    // channel, fires no scroll event, so this is the reliable clear signal).
    cancelHold();
    clearHeldMsg();
  }, { passive: true });
  // A clean lift before the timer fires just means "no hold"; after it fires
  // the menu is already up and stays. touchcancel does NOT cancel a pending
  // hold (mobile fires it spuriously) — it only dismisses a shown menu.
  list.addEventListener('touchend', cancelHold, { passive: true });
  list.addEventListener('touchcancel', clearHeldMsg, { passive: true });

  // A Latest row is one big link to its message in its channel. Links inside
  // the text keep working (in-app ones are routed by wireInternalLinks).
  const openLatestRow = (row) => {
    const m = latest.byId.get(Number(row.dataset.id));
    if (m) openChannel(m.channel_id, { jumpTo: m.id });
  };
  list.addEventListener('keydown', (e) => {
    const row = state.latest && e.key === 'Enter' && e.target.closest('.msg--latest');
    if (row) { e.preventDefault(); openLatestRow(row); }
  });

  list.addEventListener('click', (e) => {
    // An @mention of a person is a door to their DM, in Latest too.
    const mention = e.target.closest('.mention[data-user-id]');
    if (mention) {
      openDMWith(Number(mention.dataset.userId));
      return;
    }
    if (state.latest) {
      const row = e.target.closest('.msg--latest');
      if (row && !e.target.closest('a[href]')) openLatestRow(row);
      return;
    }
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    const msgId = Number(msgEl.dataset.id) || 0;
    const clientId = msgEl.dataset.clientId || '';

    // Picking any toolbar action dismisses the long-press menu (phones); the
    // emoji picker survives via .msg-actions:has(.emoji-picker) until closed.
    if (e.target.closest('.msg-actions')) clearHeldMsg();

    if (e.target.closest('.msg-retry')) {
      if (clientId) retrySend(state.currentId, clientId);
      return;
    }
    if (e.target.closest('.msg-discard')) {
      if (clientId) discardUnsent(state.currentId, clientId);
      return;
    }
    if (e.target.closest('.msg-more')) {
      const st = chanState(state.currentId);
      const m = (msgId && st.byId.get(msgId)) || (clientId && st.byClient.get(clientId));
      if (m) {
        unfoldedMsgs.add(msgKey(m));
        // Keep the reader where they are: the text grows below the fold.
        const sc = byId('message-scroll');
        const top = sc ? sc.scrollTop : 0;
        const wasAtBottom = state.atBottom;
        state.atBottom = false; // refreshMsgEl must not jump to the bottom
        refreshMsgEl(state.currentId, m);
        state.atBottom = wasAtBottom;
        if (sc) sc.scrollTop = top;
      }
      return;
    }
    // A person (name or picture) is a door to their DM.
    if (e.target.closest('.msg-author') || e.target.closest('.msg-avatar')) {
      const st = chanState(state.currentId);
      const m = (msgId && st.byId.get(msgId)) || (clientId && st.byClient.get(clientId));
      if (m) openDMWith(m.user_id);
      return;
    }
    const reactionPill = e.target.closest('.reaction');
    if (reactionPill && msgId) {
      toggleReaction(msgId, reactionPill.dataset.emoji);
      return;
    }
    if (e.target.closest('.msg-react') && msgId) {
      const anchor = e.target.closest('.msg-actions') || msgEl;
      openEmojiPicker(anchor, (emoji) => toggleReaction(msgId, emoji));
      return;
    }
    if (e.target.closest('.msg-pin') && msgId) {
      togglePin(msgId);
      return;
    }
    if (e.target.closest('.msg-reply') && msgId) {
      quoteReply(msgId);
      return;
    }
    if (e.target.closest('.msg-edit') && msgId) {
      startEdit(msgId);
      return;
    }
    if (e.target.closest('.msg-delete') && msgId) {
      confirmModal('Delete this message? This cannot be undone.', 'Delete').then((ok) => {
        if (ok) api(`/api/messages/${msgId}`, { method: 'DELETE' }).catch(() => {});
      });
      return;
    }
    if (e.target.closest('.msg-copy') && msgId) {
      const st = chanState(state.currentId);
      const msg = st.byId.get(msgId);
      if (msg && msg.body) copyText(msg.body, 'Text copied'); // raw markdown
      return;
    }
    if (e.target.closest('.msg-link') && msgId) {
      copyText(`${location.origin}/?c=${state.currentId}&m=${msgId}`, 'Link copied');
      return;
    }
    const img = e.target.closest('.att-img-el') || (e.target.closest('.att-img') && e.target.closest('.att-img').querySelector('img'));
    if (img) {
      openLightbox(img);
    }
  });
}

function wireSidebar() {
  const open = (e) => {
    const li = e.target.closest('.chan, .dm');
    if (li && li.dataset.group) toggleChanGroup(li.dataset.group);
    else if (li && li.dataset.id) openChannel(Number(li.dataset.id));
  };
  on(byId('channel-list'), 'click', open);
  on(byId('dm-list'), 'click', open);
  on(byId('latest-row'), 'click', () => openLatest());
  on(byId('notes-row'), 'click', () => openNotes());
  on(byId('new-channel-btn'), 'click', openNewChannelModal);
  on(byId('new-dm-btn'), 'click', openNewDMModal);
  on(byId('fold-channels'), 'click', () => setSectionFolded('channel', !foldChans));
  on(byId('fold-dms'), 'click', () => setSectionFolded('dm', !foldDMs));
  on(byId('group-channels'), 'click', () => setChannelsGrouped(!groupChans));
  reflectFoldButton('channel'); // reflect the saved state on the header buttons
  reflectFoldButton('dm');
  reflectGroupButton();
  on(byId('side-hide'), 'click', () => { closeMeMenu(); setSidebarHidden(true); });
  on(byId('side-show'), 'click', () => setSidebarHidden(false));
  on(byId('nav-toggle'), 'click', () => {
    if (document.body.classList.toggle('nav-open')) dismissKeyboard();
  });
  // Tapping the scrim behind the mobile drawer closes it.
  on(document.querySelector('.nav-backdrop'), 'click', () =>
    document.body.classList.remove('nav-open'));
}

function closeHeaderMenu() {
  const menu = byId('header-menu');
  if (menu && !menu.hidden) { menu.hidden = true; return true; }
  return false;
}

// The phone "⋯" menu is built at open time by mirroring the live header
// buttons — same icon, same label, same handler — so it always matches the
// current channel (DM vs channel, muted or not) with zero bookkeeping.
function openHeaderMenu() {
  const menu = byId('header-menu');
  if (!menu) return;
  menu.textContent = '';
  for (const btn of document.querySelectorAll('#channel-actions > .iconbtn')) {
    if (btn.hidden || btn.id === 'header-more') continue;
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    const svg = [...btn.querySelectorAll('svg')].find((s) => !s.hidden);
    if (svg) item.append(svg.cloneNode(true));
    item.append(document.createTextNode(btn.title || btn.getAttribute('aria-label') || ''));
    item.addEventListener('click', () => { closeHeaderMenu(); btn.click(); });
    menu.append(item);
  }
  menu.hidden = !menu.childElementCount;
}

function wireHeader() {
  on(byId('header-more'), 'click', (e) => {
    e.stopPropagation();
    if (!closeHeaderMenu()) openHeaderMenu();
  });
  document.addEventListener('click', (e) => {
    const menu = byId('header-menu');
    if (menu && !menu.hidden && !menu.contains(e.target)) closeHeaderMenu();
  });
  on(byId('join-btn'), 'click', async () => {
    const ch = state.channels.get(state.currentId);
    if (!ch) return;
    try {
      const data = await api(`/api/channels/${ch.id}/join`, { method: 'POST' });
      mergeChannel(data.channel);
      renderSidebar();
      renderChannelHeader();
      toast(`Joined #${ch.name}`);
      // A non-member gets no realtime, so anything said between opening this
      // channel and joining it is missing — and the join hands back an unread
      // count for exactly those. Catch up, then the visible newest can be
      // marked read; otherwise the dot sticks with no message behind it.
      const st = chanState(ch.id);
      if (st.loaded && newestRealId(st)) await gapFill(ch.id);
      else { st.loaded = false; await openChannel(ch.id); }
      maybeMarkRead();
    } catch { /* toasted */ }
  });
  on(byId('members-btn'), 'click', openMembersModal);
  on(byId('mute-btn'), 'click', toggleMute);
  on(byId('files-btn'), 'click', openFilesModal);
  on(byId('pins-btn'), 'click', openPinsModal);
  on(byId('pin-channel-btn'), 'click', () => { if (state.currentId) togglePinChannel(state.currentId); });
  on(byId('close-dm-btn'), 'click', closeDMConversation);
  on(byId('info-btn'), 'click', openChannelInfoModal);
  on(byId('jump-latest'), 'click', () => {
    // Detached after a far jump: "latest" is a reload of the live end.
    if (state.currentId && chanState(state.currentId).hasNewer) {
      returnToLatest(state.currentId);
      return;
    }
    state.atBottom = true;
    if (state.currentId) chanState(state.currentId).jumpCount = 0;
    scrollToBottom();
    updateJumpLatest();
    maybeMarkRead();
  });
}

function wireComposer() {
  const form = byId('composer');
  const ta = byId('composer-input');

  // The composer area's height moves for many reasons — the textarea growing
  // across lines, the edit bar, the attachment tray, the typing line — and
  // each one shrinks the message pane. When the view was pinned to the newest
  // message, keep it pinned, so the area visibly extends instead of eating
  // the last message (or leaving a sliver of scroll).
  const area = document.querySelector('.composer-area');
  if (area && 'ResizeObserver' in window) {
    new ResizeObserver(() => {
      if (state.atBottom) scrollToBottom();
    }).observe(area);
  }

  on(form, 'submit', (e) => {
    e.preventDefault();
    submitComposer();
  });
  // Tapping send must not steal focus from the textarea: on phones that closes
  // the keyboard, and you almost always have another line to write. Cancelling
  // mousedown keeps focus where it is without blocking the click itself.
  on(byId('send-btn'), 'mousedown', (e) => e.preventDefault());
  on(ta, 'input', () => {
    autogrow();
    if (ta.value.trim()) sendTyping();
    queueDraftSave();
    refreshEmojiAuto();
  });
  // Moving the caret off the token (arrows, click) retires the popup.
  on(ta, 'click', () => refreshEmojiAuto());
  on(ta, 'blur', () => closeEmojiAuto());
  on(byId('composer-cancel'), 'click', () => cancelEdit());
  on(ta, 'keydown', (e) => {
    if (e.isComposing) return;
    // The `:name` popup claims its keys first, so Enter picks an emoji
    // instead of sending and ArrowUp moves the list instead of editing.
    if (emojiAutoKey(e)) { e.preventDefault(); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitComposer();
    } else if (e.key === 'ArrowUp' && !ta.value && !state.editingId) {
      e.preventDefault();
      editLastOwnMessage();
    } else if (e.key === 'Escape') {
      if (state.editingId) {
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
      }
    }
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (pal.open) closePalette();
      else openPalette();
      return;
    }
    if (mod && e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openNewDMModal();
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const box = byId('lightbox');
      if (box && !box.hidden) {
        e.preventDefault();
        lightboxStep(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }
    }
    // PageUp/PageDown page through the chat (IRC-style, like the CLI) — also
    // from the composer, where a caret jump in a few-line box is useless.
    // Modals, the palette and the lightbox keep their own scrolling.
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      const lightbox = byId('lightbox');
      if (topModal() || pal.open || (lightbox && !lightbox.hidden)) return;
      const sc = byId('message-scroll');
      if (!sc) return;
      e.preventDefault();
      const dir = e.key === 'PageUp' ? -1 : 1;
      sc.scrollBy({ top: dir * sc.clientHeight * 0.85, behavior: 'smooth' });
      return;
    }
    // Tab on an idle screen jumps to the composer — a quick "start typing"
    // shortcut. Bail when anything is open (modal/palette/lightbox/menu/emoji
    // picker) or focus is already in a field, so normal tab-navigation stands.
    if (e.key === 'Tab' && !e.shiftKey && !mod && !e.altKey) {
      const ta = byId('composer-input');
      const ae = document.activeElement;
      const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'
        || ae.tagName === 'SELECT' || ae.isContentEditable);
      const lightbox = byId('lightbox');
      const menu = byId('me-menu');
      const idle = !topModal() && !pal.open && !emojiPickerEl
        && !(lightbox && !lightbox.hidden) && !(menu && !menu.hidden);
      if (ta && idle && !inField) {
        e.preventDefault();
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (emojiPickerEl) { closeEmojiPicker(); return; }
      if (closePalette()) return;
      if (closeLightbox()) return;
      if (closeTopModal()) return;
      if (closeMeMenu()) return;
      if (closeHeaderMenu()) return;
      const ta = byId('composer-input');
      if (ta && document.activeElement === ta) {
        if (state.editingId) cancelEdit();
        else ta.blur();
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (emojiPickerEl && !emojiPickerEl.contains(e.target) && !e.target.closest('.msg-react')) {
      closeEmojiPicker();
    }
  });
}

// Back walks the channels you visited, on every platform: each swap pushed an
// entry, so popstate just re-opens the one it lands on. On phones and the
// installed PWA back doubles as the app's back button, so it closes whatever
// is open (lightbox, palette, modal, menu, drawer) before it moves, and only a
// second press with nothing left actually leaves.
function wireBackButton() {
  const guarded = matchMedia('(display-mode: standalone)').matches
    || matchMedia('(max-width: 760px)').matches;
  const trap = () => {
    const here = state.latest ? 'latest' : state.currentId;
    if (here) markHistory(here, false, true);
  };
  if (guarded) trap();
  window.addEventListener('popstate', (e) => {
    // Browsers may put back the title the entry was created under ("(1)" from
    // before you read it): always rewrite it from the current unread state.
    updateBadges();
    if (guarded) {
      const closedSomething = (emojiPickerEl && (closeEmojiPicker(), true))
        || closeLightbox() || closePalette() || closeTopModal() || closeMeMenu()
        || closeHeaderMenu()
        || (document.body.classList.contains('nav-open')
          && (document.body.classList.remove('nav-open'), true));
      // Put back the entry that press consumed, so the trail stays put.
      if (closedSomething) { trap(); return; }
    }
    const target = (e.state && e.state.c) || new URLSearchParams(location.search).get('c');
    if (target === 'latest') {
      if (!state.latest) openLatest({ fromHistory: true });
      return;
    }
    const id = Number(target);
    if (id && id !== state.currentId && state.channels.has(id)) {
      openChannel(id, { fromHistory: true });
      return;
    }
    // Nowhere left to go. Desktop lets the browser leave; on a phone one more
    // press within the window leaves for real, and staying re-arms the trap.
    if (!guarded) return;
    toast('Back again to leave slock');
    setTimeout(trap, 1500);
  });
}

// Tell the server whether this tab is visible; it suppresses web push while
// the user has any visible tab. Best effort: on failure the server falls back
// to the state declared when the stream connected.
function reportVisibility() {
  if (!state.sseClientId) return;
  api('/api/events/visible', {
    method: 'POST',
    toast: false,
    body: { client_id: state.sseClientId, visible: !document.hidden },
  }).catch(() => {});
}

function wireVisibility() {
  document.addEventListener('visibilitychange', () => {
    reportVisibility();
    if (document.hidden) {
      // A grace clock must not tick while nobody is looking (see setOffline).
      clearTimeout(offlineUITimer);
      offlineUITimer = 0;
      flushMarkRead(); // commit a read in flight before the tab is parked
      // Phones kill a backgrounded app without a pagehide: this is the last
      // reliable moment to put the half-typed message on disk.
      saveDraftFor(state.currentId);
      persistDrafts();
      return;
    }
    if (!state.connected) {
      clearTimeout(reconnectTimer);
      backoffMs = 1000;
      setOffline(true); // grace restarts now, with the user watching
      connectSSE();
    } else {
      // Coming back to a tab whose stream looks alive: it may have died
      // silently while hidden (sleep, a parked phone app), dropping messages
      // for any channel. Treat it like a reconnect: every other loaded
      // channel catches up when next opened.
      for (const [id, st] of state.chan) {
        if (st.loaded && id !== state.currentId) st.stale = true;
      }
      refetchChannels();
      if (state.currentId) gapFill(state.currentId);
    }
    maybeMarkRead();
  });
  window.addEventListener('focus', () => maybeMarkRead());
  // Last-chance draft snapshot on refresh / tab close / our own update reload.
  window.addEventListener('pagehide', () => {
    saveDraftFor(state.currentId);
    persistDrafts();
    flushMarkRead();
  });
  // Phone keyboards: when the visual viewport shrinks under a focused
  // composer, scroll the composer back into view and keep the message list
  // pinned to its bottom (iOS pans instead of resizing the layout).
  if (window.visualViewport) {
    let lastVH = visualViewport.height;
    visualViewport.addEventListener('resize', () => {
      const shrank = visualViewport.height < lastVH - 40;
      lastVH = visualViewport.height;
      if (!shrank || document.activeElement !== byId('composer-input')) return;
      requestAnimationFrame(() => {
        const ta = byId('composer-input');
        if (ta) ta.scrollIntoView({ block: 'nearest' });
        if (state.atBottom) scrollToBottom();
      });
    });
  }
}

/* -------- mobile drawer swipe */

function wireSwipe() {
  const mq = matchMedia('(max-width: 760px)');
  const OPEN_ZONE = 0.5; // fraction of the screen, from the drawer's edge, that can start an open
  const CLAIM_DX = 10;   // horizontal movement before we claim the gesture
  const FLICK = 0.3;     // px/ms — faster than this decides by direction

  let gesture = null; // {x, y, mode, claimed, width, lastX, lastT, vx, p}

  const sideRight = () => document.body.classList.contains('side-right');
  const drawerWidth = () => {
    const sb = byId('sidebar');
    return (sb && sb.offsetWidth) || Math.min(320, innerWidth * 0.85);
  };

  // Don't hijack horizontally scrollable content (code blocks, wide tables).
  const startsOnHScroll = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 1
        && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };

  const progressFor = (dx) => {
    const inward = sideRight() ? -dx : dx; // motion toward "more open"
    const p = gesture.mode === 'open'
      ? inward / gesture.width
      : 1 + inward / gesture.width;
    return Math.max(0, Math.min(1, p));
  };

  // Inline styles on the two moving elements, not a custom property on body:
  // a body-level property inherits everywhere, so flipping it every touchmove
  // restyled the whole document — message list included — and the drawer
  // stuttered. Scoped writes keep each frame on the compositor.
  const paint = (p) => {
    const sb = byId('sidebar');
    if (sb) sb.style.transform = `translateX(${(1 - p) * (sideRight() ? 100 : -100)}%)`;
    const bd = document.querySelector('.nav-backdrop');
    if (bd) bd.style.opacity = String(p);
  };

  const settle = (open) => {
    document.body.classList.remove('nav-dragging');
    const sb = byId('sidebar');
    if (sb) sb.style.removeProperty('transform'); // CSS transition finishes it
    const bd = document.querySelector('.nav-backdrop');
    if (bd) bd.style.removeProperty('opacity');
    document.body.classList.toggle('nav-open', open);
    if (open) dismissKeyboard(); // sliding the menu over a focused composer
    gesture = null;
  };

  document.addEventListener('touchstart', (e) => {
    gesture = null;
    if (!mq.matches || e.touches.length !== 1) return;
    if (document.body.classList.contains('modal-open') || pal.open) return;
    // The image viewer owns every touch: a drag there pans the image, it must
    // never pull the channel list open underneath.
    const lightbox = byId('lightbox');
    if (lightbox && !lightbox.hidden) return;
    const t = e.touches[0];
    const open = document.body.classList.contains('nav-open');
    let mode = null;
    if (open) {
      mode = 'close'; // anywhere over the drawer or its scrim
    } else if (sideRight()
      ? t.clientX >= innerWidth * (1 - OPEN_ZONE)
      : t.clientX <= innerWidth * OPEN_ZONE) {
      mode = 'open'; // the claim logic keeps vertical scrolls safe mid-screen
    }
    if (!mode || startsOnHScroll(e.target)) return;
    gesture = {
      x: t.clientX, y: t.clientY, mode, claimed: false,
      width: drawerWidth(), lastX: t.clientX, lastT: e.timeStamp, vx: 0,
      p: mode === 'open' ? 0 : 1,
    };
  }, { passive: true });

  // Not passive: once the drag is ours we must stop the page scrolling.
  document.addEventListener('touchmove', (e) => {
    if (!gesture) return;
    if (e.touches.length !== 1) { gesture = null; return; }
    const t = e.touches[0];
    const dx = t.clientX - gesture.x;
    const dy = t.clientY - gesture.y;
    if (!gesture.claimed) {
      if (Math.abs(dx) > CLAIM_DX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        gesture.claimed = true;
        document.body.classList.add('nav-dragging');
      } else if (Math.abs(dy) > 24) {
        gesture = null; // vertical scroll won
        return;
      } else {
        return; // undecided — stay passive
      }
    }
    e.preventDefault();
    const dt = e.timeStamp - gesture.lastT;
    if (dt > 0) gesture.vx = (t.clientX - gesture.lastX) / dt;
    gesture.lastX = t.clientX;
    gesture.lastT = e.timeStamp;
    gesture.p = progressFor(dx);
    paint(gesture.p);
  }, { passive: false });

  const onTouchEnd = () => {
    if (!gesture) return;
    if (!gesture.claimed) { gesture = null; return; }
    const inwardV = (sideRight() ? -gesture.vx : gesture.vx); // >0 → opening
    const open = Math.abs(gesture.vx) > FLICK ? inwardV > 0 : gesture.p > 0.4;
    settle(open);
  };
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', () => {
    if (gesture && gesture.claimed) settle(gesture.mode !== 'open');
    gesture = null;
  }, { passive: true });
}

/* ============================================================ boot */

async function boot() {
  // The app lays itself out to the viewport and never scrolls the document;
  // a scroll offset restored by a reload (an update, a refresh with the
  // keyboard up) would just crop it.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  applyTheme(localStorage.getItem(LS.theme) || 'system');
  applySide(localStorage.getItem(LS.side) === 'right' ? 'right' : 'left');
  document.body.classList.toggle('side-hidden', localStorage.getItem(LS.sideHidden) === '1');
  applyDensity(localStorage.getItem(LS.density) === 'compact' ? 'compact' : 'cozy');
  applySidebarWidth(parseInt(localStorage.getItem(LS.sidebarW), 10) || 0);
  applyZoom(parseFloat(localStorage.getItem(LS.zoom)) || 1);
  loadClosedDMs();
  loadSidebarPrefs();
  applyFont(localStorage.getItem(LS.font) || '');
  restoreUploadedFont();
  // On "system", an OS theme flip swaps which custom-colour slot applies.
  on(matchMedia('(prefers-color-scheme: dark)'), 'change', () => applyColors());

  let meData;
  try {
    meData = await api('/api/auth/me', { toast: false });
  } catch {
    return; // 401 already redirected; network error leaves the shell
  }
  state.me = meData.user;
  state.mustChangePw = !!meData.must_change_pw;
  state.pushKey = meData.push_public_key || '';

  const adminBtn = byId('admin-btn');
  if (adminBtn) adminBtn.hidden = !state.me.is_admin;

  wireSidebar();
  wireHeader();
  wireMessageList();
  wireComposer();
  wireUploads();
  wirePalette();
  wireModalRoot();
  wireMenu();
  wireLightbox();
  wireKeyboard();
  wireVisibility();
  wireSwipe();
  wireSidebarResize();
  wireInternalLinks();

  // Workspace identity, in parallel and non-blocking: the built-in mark and
  // the "slock" default stand until (unless) this answers.
  api('/api/workspace', { toast: false })
    .then((data) => applyWorkspace(data.workspace))
    .catch(() => {});

  // Server build id, in parallel; the SSE `hello` frame also carries it and
  // whichever lands first wins (they agree unless a deploy races us).
  api('/api/version', { toast: false })
    .then((data) => noteVersion(data.version || ''))
    .catch(() => {});

  try {
    const [chanData, userData] = await Promise.all([
      api('/api/channels'),
      api('/api/users'),
    ]);
    for (const u of userData.users) state.users.set(u.id, u);
    state.users.set(state.me.id, state.me);
    setChannels(chanData);
  } catch {
    toast('Could not load channels', true);
    return; // the outbox stays on disk for the next start
  }

  renderSidebar();
  updateBadges();
  // Unconfirmed messages from earlier sessions go back in their channels; the
  // first SSE hello sends them.
  restoreOutbox();

  // Pick the channel to open: ?c= → last visited → first member channel → first.
  // "latest" (in ?c= or remembered) opens the Latest meta-channel instead.
  const params = new URLSearchParams(location.search);
  const wantLatest = params.get('c') === 'latest'
    || (!params.get('c') && localStorage.getItem(LS.lastChannel) === 'latest');
  if (wantLatest) {
    await openLatest();
  } else {
    let target = Number(params.get('c')) || Number(localStorage.getItem(LS.lastChannel)) || 0;
    if (!state.channels.has(target)) target = 0;
    if (!target) {
      const member = sortedChannels().find((c) => c.is_member) || sortedChannels()[0] || sortedDMs()[0];
      target = member ? member.id : 0;
    }
    const jumpTo = Number(params.get('m')) || 0;
    if (target) await openChannel(target, jumpTo ? { jumpTo } : {});
  }
  // After the first channel: the trail starts at a real entry, and the phone
  // trap needs a channel to name.
  wireBackButton();

  connectSSE();
  await registerSW();
  refreshNotifButton();

  if (state.mustChangePw) openPasswordModal(true);
}

boot();
