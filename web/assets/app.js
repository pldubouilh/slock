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
    const e = new Error('Network error');
    e.code = 'network';
    if (doToast) toast('Network error — are you offline?', true);
    throw e;
  }
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
  online: new Set(),       // user ids
  typing: new Map(),       // channelId -> Map(userId -> expiresAt)
  connected: false,
  sseClientId: 0,          // this tab's stream id, from the SSE `hello` frame
  atBottom: true,
  editingId: null,         // message id being edited in the composer
  lastReadSent: new Map(), // channelId -> last message id POSTed to /read
  membersRefresh: null,    // live members-modal refresh hook
};

const LS = {
  theme: 'slock:theme',
  side: 'slock:side',
  colors: 'slock:colors',
  density: 'slock:density',
  sidebarW: 'slock:sidebar-width',
  zoom: 'slock:zoom',
  lastChannel: 'slock:last-channel',
  drafts: 'slock:drafts',
};

function chanState(id) {
  let st = state.chan.get(id);
  if (!st) {
    st = {
      msgs: [], byId: new Map(), byClient: new Map(),
      loaded: false, loadingOlder: false, hasMore: true,
      stale: false, unreadStartId: null, jumpCount: 0,
    };
    state.chan.set(id, st);
  }
  return st;
}

function isMuted(ch) {
  return !!(ch && ch.muted);
}

function channelDisplayName(ch) {
  if (!ch) return '';
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

function setChannels(data) {
  const seen = new Set();
  for (const ch of [...(data.channels || []), ...(data.dms || [])]) {
    mergeChannel(ch);
    seen.add(ch.id);
  }
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
    const data = await api('/api/channels', { toast: false });
    setChannels(data);
    renderSidebar();
    renderChannelHeader();
    updateBadges();
  } catch (err) {
    if (err.code !== 'network') console.warn('channel refetch failed', err);
  }
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
    .sort((a, b) => (b.is_member - a.is_member) || a.name.localeCompare(b.name));
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

function sortedDMs() {
  return [...state.channels.values()]
    .filter((c) => c.kind === 'dm')
    .sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
}

function renderSidebar() {
  const chanList = byId('channel-list');
  const dmList = byId('dm-list');
  if (chanList) {
    chanList.textContent = '';
    for (const ch of sortedChannels()) {
      const li = tpl('tpl-channel-item');
      if (!li) break;
      li.dataset.id = ch.id;
      li.classList.toggle('chan--active', ch.id === state.currentId);
      li.classList.toggle('chan--unread', ch.unread_count > 0 && !isMuted(ch));
      li.classList.toggle('chan--muted', isMuted(ch));
      li.classList.toggle('chan--member', !!ch.is_member);
      li.classList.toggle('chan--private', !!ch.is_private);
      const name = li.querySelector('.chan-name');
      if (name) name.textContent = ch.name;
      const badge = li.querySelector('.chan-badge');
      if (badge) {
        badge.hidden = !(ch.unread_count > 0);
        badge.textContent = ch.unread_count > 99 ? '99+' : String(ch.unread_count || '');
      }
      chanList.append(li);
    }
  }
  if (dmList) {
    dmList.textContent = '';
    for (const ch of sortedDMs()) {
      const li = tpl('tpl-dm-item');
      if (!li) break;
      const peer = state.users.get(ch.peer_user_id);
      li.dataset.id = ch.id;
      li.dataset.userId = ch.peer_user_id || '';
      li.classList.toggle('dm--active', ch.id === state.currentId);
      li.classList.toggle('dm--unread', ch.unread_count > 0 && !isMuted(ch));
      li.classList.toggle('dm--online', state.online.has(ch.peer_user_id));
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

function makeMsgEl(m, prev, st) {
  const el = tpl('tpl-message');
  if (!el) return document.createDocumentFragment();
  const me = state.me;
  const own = me && m.user_id === me.id;
  const user = state.users.get(m.user_id);

  el.dataset.id = m.id || '';
  el.dataset.userId = m.user_id;
  if (m.client_id) el.dataset.clientId = m.client_id;
  el.classList.toggle('msg--own', !!own);
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
    time.textContent = m.failed ? 'failed' : fmtTime(m.created_at);
    time.title = new Date(m.created_at).toLocaleString();
  }
  const edited = el.querySelector('.msg-edited');
  if (edited) edited.hidden = !m.edited_at;

  const body = el.querySelector('.msg-body');
  if (body) {
    if (m.deleted_at) body.textContent = 'Message deleted';
    else renderBody(body, m.body || '');
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
    show('.msg-reply', !m.deleted_at && !!(m.body && m.body.trim()));
    show('.msg-copy', !m.deleted_at);
  }

  if (m.failed) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'msg-retry';
    retry.textContent = 'Send failed — retry';
    (body ? body.parentElement : el).append(retry);
  }
  return el;
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
      img.addEventListener('load', () => {
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
  el.replaceWith(makeMsgEl(m, prev, st));
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
  const show = !state.atBottom && state.currentId != null;
  btn.hidden = !show;
  if (show) btn.textContent = n > 0 ? `${n} new message${n === 1 ? '' : 's'} ↓` : 'Jump to latest ↓';
}

/* ============================================================ body tokeniser */

// Compact message formatting: escape-by-construction (DOM nodes, never HTML
// strings), links, **bold**, *italic* / _italic_, `code`, ```fences```,
// > quotes, @mentions. Newlines preserved.

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

function renderBody(el, body) {
  el.textContent = '';
  const lines = String(body).split('\n');
  let i = 0;
  let lastWasText = false;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      // Fence opened and closed on one line (``` asd ```): a one-line block.
      // Otherwise the remainder of the opening line is an info string (```js)
      // and the block runs to the closing fence.
      const single = line.match(/^```(.*[^`].*?)```\s*$/);
      let text;
      let j = i;
      if (single) {
        text = single[1].trim();
      } else {
        const buf = [];
        // Text glued to the opening fence: a bare word is a language/info
        // string (```go) and dropped, but anything else (```1. Open…) is real
        // content — the first line of the block — so keep it rather than eat it.
        const rest = line.slice(3);
        if (rest.trim() && !/^[\w+.#-]+$/.test(rest.trim())) buf.push(rest);
        // Collect until the closing fence, which may sit on its own line or be
        // glued to the end of the last content line (…done.```).
        for (j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (/^```\s*$/.test(l)) break;             // fence on its own line
          const closed = l.match(/^(.*[^`])```\s*$/); // fence glued to content
          if (closed) { buf.push(closed[1]); break; }
          buf.push(l);
        }
        text = buf.join('\n');
      }
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = text;
      pre.append(code);
      el.append(pre);
      i = j < lines.length ? j + 1 : j;
      lastWasText = false;
      continue;
    }

    if (/^>\s?/.test(line)) {
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
    renderInline(line, el);
    lastWasText = true;
    i++;
  }
}

/* ============================================================ channel / history */

const HISTORY_PAGE = 75;
const OLDER_PAGE = 100;

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
  st.msgs = [];
  st.byId = new Map();
  st.byClient = new Map();
  for (const m of data.messages) addMessageToState(channelId, m);
  st.loaded = true;
  st.stale = false;
  st.hasMore = !!data.has_more;
  st.jumpCount = 0;
}

// Position the "new messages" divider for the current visit from the live
// unread count. Called on every open so it never lingers as a stale leftover:
// no unread → no divider, and a fresh batch places it at the right message.
function placeUnreadDivider(channelId) {
  const st = chanState(channelId);
  const ch = state.channels.get(channelId);
  st.unreadStartId = null;
  if (ch && ch.unread_count > 0 && st.msgs.length) {
    const idx = Math.max(0, st.msgs.length - ch.unread_count);
    st.unreadStartId = st.msgs[idx].id;
  }
}

async function loadOlder(channelId) {
  const st = chanState(channelId);
  if (st.loadingOlder || !st.hasMore || !st.loaded) return false;
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
    return fresh.length > 0;
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
  if (!st.loaded) return;
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
    if (!data.has_more || !data.messages.length) break;
    lastId = data.messages[data.messages.length - 1].id;
  }
  if (channelId === state.currentId && state.atBottom) scrollToBottom();
  maybeMarkRead();
}

const chanBack = []; // previously visited channel ids, most recent last

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
  }
  // Trail for the phone back button (see wireBackButton); walking back must
  // not extend the trail.
  if (prevId && prevId !== channelId && !opts.fromBack) {
    chanBack.push(prevId);
    if (chanBack.length > 20) chanBack.shift();
  }
  state.currentId = channelId;
  resetComposerMode();
  localStorage.setItem(LS.lastChannel, String(channelId));
  history.replaceState(null, '', '/?c=' + channelId);
  document.body.classList.remove('nav-open');
  closeEmojiPicker();

  renderSidebar();
  renderChannelHeader();

  const st = chanState(channelId);
  if (!st.loaded) {
    const loader = byId('message-loader');
    if (loader) loader.hidden = false;
    try {
      await loadHistory(channelId);
    } catch {
      return;
    } finally {
      if (loader) loader.hidden = true;
    }
  } else if (st.stale) {
    await gapFill(channelId);
  }
  if (state.currentId !== channelId) return; // user moved on mid-load

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
  for (let i = 0; i < 6 && !st.byId.has(msgId) && st.hasMore; i++) {
    const got = await loadOlder(channelId);
    if (!got) break;
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
  const filesBtn = byId('files-btn');
  if (filesBtn) filesBtn.hidden = !ch; // any readable channel has history
  const infoBtn = byId('info-btn');
  if (infoBtn) infoBtn.hidden = !ch || isDM;
}

/* ============================================================ read state / badges */

function newestVisible() {
  // "newest message is visible" ≈ scrolled to (near) the bottom.
  return state.atBottom;
}

const maybeMarkRead = debounce(() => {
  const ch = state.channels.get(state.currentId);
  if (!ch || !ch.is_member) return;
  if (document.hidden || !document.hasFocus()) return;
  if (!newestVisible()) return;
  const st = chanState(ch.id);
  const lastId = newestRealId(st);
  if (!lastId) return;
  if (state.lastReadSent.get(ch.id) === lastId && ch.unread_count === 0) return;
  state.lastReadSent.set(ch.id, lastId);
  ch.unread_count = 0;
  // Caught up: drop the "new messages" divider so it doesn't linger once read.
  if (st.unreadStartId) {
    st.unreadStartId = null;
    const marker = byId('message-list') && byId('message-list').querySelector('.msg--unread-start');
    if (marker) marker.classList.remove('msg--unread-start');
  }
  renderSidebar();
  updateBadges();
  api(`/api/channels/${ch.id}/read`, { method: 'POST', body: { last_message_id: lastId }, toast: false })
    .catch(() => state.lastReadSent.delete(ch.id));
}, 700);

function totalUnread() {
  let n = 0;
  for (const ch of state.channels.values()) {
    if (isMuted(ch)) continue;
    if (ch.kind === 'channel' && !ch.is_member) continue;
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

let clientSeq = 0;
const typingSentAt = new Map(); // channelId -> ts

// Blur the composer if it holds focus, which closes the phone keyboard.
function dismissKeyboard() {
  const ta = byId('composer-input');
  if (ta && document.activeElement === ta) ta.blur();
}

function autogrow() {
  const ta = byId('composer-input');
  if (!ta) return;
  ta.style.height = 'auto';
  const max = Math.floor(innerHeight * 0.4);
  ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  // Only scroll once the cap is hit; a fitting textarea showing a scrollbar
  // (which mobile browsers love to paint) just looks broken.
  ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
}

/* -------- drafts: survive channel switches, reloads and deploys.
   localStorage `slock:drafts` maps channelId -> {text, edit_id?}. */

const DRAFT_MAX = 8000;
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
  const text = ta.value.slice(0, DRAFT_MAX);
  if (!text.trim() && !state.editingId) {
    delete drafts[channelId];
  } else {
    const d = { text };
    if (state.editingId) d.edit_id = state.editingId;
    drafts[channelId] = d;
  }
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
    if (prev.trim()) drafts[channelId] = { text: prev.slice(0, DRAFT_MAX) };
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
  const quote = m.body.split('\n').map((l) => '> ' + l).join('\n') + '\n';
  const cur = ta.value;
  ta.value = cur && !/\n$/.test(cur) ? cur + '\n' + quote : cur + quote;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
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
  const body = ta.value.replace(/\s+$/, '');

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
      drafts[editChannelId] = { text: body.slice(0, DRAFT_MAX), edit_id: id };
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

  const channelId = state.currentId;
  const st = chanState(channelId);
  const clientId = `c-${Date.now()}-${++clientSeq}`;
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
  delete drafts[channelId]; // sent — the draft has served its purpose
  persistDrafts();

  postMessage_(channelId, msg);
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
    msg.failed = true;
    msg.pending = false;
    refreshMsgEl(channelId, msg);
    toast(err.message || 'Message failed to send', true);
  });
}

function retrySend(channelId, clientId) {
  const st = chanState(channelId);
  const m = st.byClient.get(clientId);
  if (!m || m.id) return;
  m.failed = false;
  m.pending = true;
  refreshMsgEl(channelId, m);
  postMessage_(channelId, m);
}

// Reconcile the optimistic copy with the server message (from the POST echo
// or the message.new SSE frame — whichever lands first wins, the other no-ops).
function reconcilePending(channelId, serverMsg) {
  const st = chanState(channelId);
  if (serverMsg.id && st.byId.has(serverMsg.id)) return;
  const local = serverMsg.client_id && st.byClient.get(serverMsg.client_id);
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
  el.textContent = !names.length ? ''
    : names.length === 1 ? `${names[0]} is typing…`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
        : 'Several people are typing…';
  clearTimeout(typingTimer);
  if (names.length) typingTimer = setTimeout(renderTyping, 1000);
}

/* ============================================================ uploads */

const trayItems = []; // {file, status: uploading|done|error, attachment?, xhr?, node}

function renderTrayVisibility() {
  const tray = byId('attachment-tray');
  if (tray) tray.hidden = trayItems.length === 0;
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
        setTrayProgress(item, 100, '✓');
        item.node.classList.add('tray-item--done');
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

const EMOJI = [
  '👍', '❤️', '😂', '😮', '😢', '😡', '🎉', '🚀', '👀', '✅',
  '❌', '🙏', '👏', '🔥', '💯', '😅', '😊', '😍', '🤔', '😉',
  '😎', '🤣', '😭', '😴', '🤯', '🥳', '😱', '🤝', '💪', '☕',
  '🍕', '🍺', '⭐', '⚡', '🐛', '🧠', '💡', '📌', '🎯', '🫡',
];

let emojiPickerEl = null;

function buildEmojiPicker() {
  const el = document.createElement('div');
  el.className = 'emoji-picker';
  el.setAttribute('role', 'menu');
  for (const e of EMOJI) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-picker-item';
    b.textContent = e;
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

function showLightboxAt(i) {
  const box = byId('lightbox');
  const img = lightboxItems[i];
  if (!box || !img) return;
  lightboxIndex = i;
  box.classList.remove('lightbox--zoomed');
  const el = byId('lightbox-img');
  if (el) {
    el.src = img.dataset.display || img.src;
    el.alt = img.dataset.filename || '';
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
  on(byId('lightbox-img'), 'click', () => {
    if (box) box.classList.toggle('lightbox--zoomed');
  });
  on(box, 'click', (e) => {
    // Backdrop click closes; clicks on the image/caption/download do not.
    if (e.target === e.currentTarget || e.target.classList.contains('modal-backdrop')) closeLightbox();
  });
  // Swipe left/right slides through the gallery (unless zoomed: then the
  // finger is for panning).
  let touch = null;
  on(box, 'touchstart', (e) => {
    touch = e.touches.length === 1 && !box.classList.contains('lightbox--zoomed')
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  on(box, 'touchend', (e) => {
    if (!touch) return;
    const dx = e.changedTouches[0].clientX - touch.x;
    const dy = e.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) lightboxStep(dx < 0 ? 1 : -1);
  }, { passive: true });
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
  setTimeout(() => location.reload(), 1000);
}

function setOffline(off) {
  const app = byId('app');
  if (app) app.classList.toggle('is-offline', off);
  const banner = byId('connection-banner');
  if (banner) banner.hidden = !off;
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
    setOffline(false);
    state.online = new Set(data.online || []);
    renderSidebar();
    if (wasDown) {
      // Resync after any gap: unread counts + missed messages.
      for (const [id, st] of state.chan) {
        if (st.loaded && id !== state.currentId) st.stale = true;
      }
      refetchChannels();
      if (state.currentId) gapFill(state.currentId);
    }
  });

  es.addEventListener('message.new', (e) => onMessageNew(JSON.parse(e.data)));
  es.addEventListener('message.update', (e) => applyMessageUpdate(JSON.parse(e.data).message));
  es.addEventListener('message.delete', (e) => {
    const { message_id, channel_id } = JSON.parse(e.data);
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

  es.addEventListener('channel.new', (e) => {
    mergeChannel(JSON.parse(e.data).channel);
    renderSidebar();
    updateBadges();
  });

  es.addEventListener('channel.update', (e) => {
    mergeChannel(JSON.parse(e.data).channel);
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

  if (st.loaded) {
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
  const visibleHere = channelId === state.currentId && state.atBottom
    && !document.hidden && document.hasFocus();
  if (!isOwn && !visibleHere) {
    ch.unread_count = (ch.unread_count || 0) + 1;
    renderSidebar();
    updateBadges();
  } else if (!isOwn) {
    maybeMarkRead();
  }
}

function applyMessageUpdate(m) {
  if (!m) return;
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
      const sub = ch.topic || `${ch.member_count || 0} member${ch.member_count === 1 ? '' : 's'}`;
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
  if (!biasChannels) {
    const dmByPeer = new Map();
    for (const ch of state.channels.values()) {
      if (ch.kind === 'dm') dmByPeer.set(ch.peer_user_id, ch);
    }
    for (const u of state.users.values()) {
      if (state.me && u.id === state.me.id) continue;
      const score = needle ? fuzzyScore(needle, u.display_name) : 0;
      if (score < 0) continue;
      const dm = dmByPeer.get(u.id);
      const unread = !!dm && !isMuted(dm) && (dm.unread_count || 0) > 0;
      const sub = u.status_text || (state.online.has(u.id) ? 'online' : '');
      entries.push({
        kind: dm ? 'dm' : 'user',
        id: dm ? dm.id : u.id,
        score: score + (dm ? 1 : 0),
        unread,
        recency: (dm && dm.last_message_at) || '',
        title: u.display_name,
        sub: unread ? `${dm.unread_count} unread${sub ? ' · ' + sub : ''}` : sub,
        icon: '@',
      });
    }
  }
  // With no query, unread channels/DMs float to the top (muted ones don't).
  // While typing, match quality stays in charge and unread only breaks ties.
  entries.sort((a, b) => (needle
    ? (b.score - a.score) || (b.unread - a.unread)
    : (b.unread - a.unread) || (b.score - a.score))
    || b.recency.localeCompare(a.recency));
  return entries.slice(0, needle ? 8 : 12);
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

  const locals = q.hasFilter && !q.textStr ? [] : localPaletteEntries(q);
  if (locals.length) {
    list.append(paletteGroupHeader(q.raw.trim() ? 'Go to' : 'Recent'));
    for (const entry of locals) {
      const li = tpl('tpl-palette-item');
      if (!li) break;
      li.dataset.kind = entry.kind;
      li.dataset.id = entry.id;
      const icon = li.querySelector('.pal-item-icon');
      if (icon) icon.textContent = entry.icon;
      const title = li.querySelector('.pal-item-title');
      if (title) title.textContent = entry.title;
      const sub = li.querySelector('.pal-item-sub');
      if (sub) sub.textContent = entry.sub;
      list.append(li);
      pal.items.push({ el: li, pick: () => pickPaletteEntry(entry) });
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
  if (!userId || (state.me && userId === state.me.id)) return;
  try {
    const data = await api('/api/dms', { method: 'POST', body: { user_id: userId } });
    mergeChannel(data.channel);
    renderSidebar();
    openChannel(data.channel.id);
  } catch { /* toasted */ }
}

async function pickPaletteEntry(entry) {
  closePalette();
  if (entry.kind === 'channel' || entry.kind === 'dm') {
    openChannel(entry.id);
  } else if (entry.kind === 'user') {
    openDMWith(entry.id);
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
    list.addEventListener('click', (e) => {
      const li = e.target.closest('.pal-item');
      if (!li) return;
      const idx = pal.items.findIndex((it) => it.el === li);
      if (idx >= 0) pal.items[idx].pick();
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

function confirmModal(text, okLabel) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = openModal('tpl-modal-confirm', { onClose: () => done(false) });
    if (!m) { done(window.confirm(text)); return; }
    const t = m.q('.confirm-text');
    if (t) t.textContent = text;
    const ok = m.q('.confirm-ok');
    if (ok && okLabel) ok.textContent = okLabel;
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
  const ch = state.channels.get(state.currentId);
  if (!ch || ch.kind === 'dm') return;
  const m = openModal('tpl-modal-new-channel');
  if (!m) return;
  const form = m.q('form') || m.q('.mform');
  if (!form) return;
  const nameEl = form.querySelector('[name=name]');
  const topicEl = form.querySelector('[name=topic]');
  const privEl = form.querySelector('[name=is_private]');
  if (nameEl) nameEl.value = ch.name;
  if (topicEl) topicEl.value = ch.topic || '';
  if (privEl) {
    privEl.checked = !!ch.is_private;
    privEl.disabled = true; // privacy cannot change after creation
  }
  const canEdit = state.me && (state.me.is_admin || ch.created_by === state.me.id);
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

  on(form, 'submit', async (e) => {
    e.preventDefault();
    if (!canEdit) { m.close(); return; }
    formError(m, '');
    try {
      const data = await api(`/api/channels/${ch.id}`, {
        method: 'PATCH',
        toast: false,
        body: {
          name: nameEl ? nameEl.value.trim() : ch.name,
          topic: topicEl ? topicEl.value.trim() : ch.topic,
        },
      });
      mergeChannel(data.channel);
      renderSidebar();
      renderChannelHeader();
      m.close();
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
  const m = openModal('tpl-modal-new-dm');
  if (!m) return;
  const input = m.q('.dm-picker-input');
  const list = m.q('.dm-picker-list');
  if (!list) return;

  const render = () => {
    const needle = input ? input.value.trim() : '';
    list.textContent = '';
    const users = [...state.users.values()]
      .filter((u) => !state.me || u.id !== state.me.id)
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
      .filter((u) => !memberSet.has(u.id))
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
    if (note) note.textContent = `${theme} theme · this device only`;
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
  m.qa('.seg').forEach((seg) => {
    const setting = seg.dataset.setting;
    const cur = setting === 'density'
      ? (localStorage.getItem(LS.density) === 'compact' ? 'compact' : 'cozy')
      : (localStorage.getItem(LS.side) === 'right' ? 'right' : 'left');
    const paint = (val) => seg.querySelectorAll('button').forEach(
      (b) => b.classList.toggle('seg--on', b.dataset.value === val));
    paint(cur);
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const val = b.dataset.value;
      if (setting === 'density') { localStorage.setItem(LS.density, val); applyDensity(val); }
      else { localStorage.setItem(LS.side, val); applySide(val); }
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
  const m = openModal('tpl-modal-password', { forced });
  if (!m) return;
  const form = m.q('form') || m.q('.mform');
  on(form, 'submit', async (e) => {
    e.preventDefault();
    const cur = m.q('[name=current_password]');
    const nw = m.q('[name=new_password]');
    const conf = m.q('[name=confirm_password]');
    formError(m, '');
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
        body: { current_password: cur ? cur.value : '', new_password: nw.value },
      });
      state.mustChangePw = false;
      m.forced = false;
      m.close();
      toast('Password updated');
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
      }
    });
  }

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

  const renderWs = () => {
    const ws = state.workspace;
    if (wsName && document.activeElement !== wsName) wsName.value = ws.name || '';
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
  renderWs();

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
          display_name: String(fd.get('display_name') || '').trim(),
          is_admin: !!fd.get('is_admin'),
        },
      });
      users.unshift(data.user);
      state.users.set(data.user.id, data.user);
      render();
      form.reset();
      showAdminResult(m, `${data.user.display_name} created — temporary password:`, data.temp_password);
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
    if (!tokens.length) {
      const probe = tpl('tpl-token-row');
      const empty = document.createElement(probe ? probe.tagName : 'div');
      empty.className = 'tok-empty';
      empty.textContent = 'No API tokens yet — create one below.';
      tokList.append(empty);
      return;
    }
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
  if (btn) btn.textContent = `Theme: ${value === 'dark' ? 'dark' : value === 'light' ? 'light' : 'system'}`;
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
  { name: 'Midnight',   sidebar: '#151a24', chat: '#0e1116' },
  { name: 'Mocha',      sidebar: '#332822', chat: '#171210' },
];

// The defaults: light gets the Aubergine preset, dark gets Midnight —
// dark-on-dark reads better than an aubergine sidebar on a dark canvas.
const DEFAULT_COLORS = {
  light: { sidebar: '#3f0e40', chat: '#f4f3f6' },
  dark: { sidebar: '#151a24', chat: '#0e1116' },
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
  on(byId('logout-btn'), 'click', async () => {
    closeMeMenu();
    try { await api('/api/auth/logout', { method: 'POST', toast: false }); } catch { /* ignore */ }
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

async function refreshNotifButton() {
  const btn = byId('notifications-btn');
  if (!btn) return;
  if (!pushSupported()) {
    btn.disabled = true;
    btn.title = 'Push notifications are not supported in this browser.';
    btn.textContent = 'Notifications unavailable';
    return;
  }
  if (!state.pushKey) {
    btn.disabled = true;
    btn.title = 'Push is disabled on this server (no VAPID key configured).';
    btn.textContent = 'Notifications unavailable';
    return;
  }
  if (Notification.permission === 'denied') {
    btn.disabled = true;
    btn.title = 'Notifications are blocked for this site in your browser settings.';
    btn.textContent = 'Notifications blocked';
    return;
  }
  const sub = await currentPushSubscription();
  btn.disabled = false;
  btn.title = '';
  btn.textContent = sub ? 'Notifications: on' : 'Enable notifications';
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
  let scrollHoverTimer = 0;
  if (sc) {
    sc.addEventListener('scroll', () => {
      // Touch scrolling drags a finger across rows; suppress hover while the
      // list is actually moving so nothing lights up under it.
      sc.classList.add('is-scrolling');
      clearTimeout(scrollHoverTimer);
      scrollHoverTimer = setTimeout(() => sc.classList.remove('is-scrolling'), 140);
      // A tapped row keeps :focus-within (its action toolbar, on phones)
      // until something else is tapped — scrolling away deselects it.
      const focused = document.activeElement;
      if (focused && focused.closest('#message-list')) focused.blur();
      state.atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;
      if (state.atBottom && state.currentId) {
        chanState(state.currentId).jumpCount = 0;
        maybeMarkRead();
      }
      updateJumpLatest();
      if (sc.scrollTop < 240 && state.currentId) loadOlder(state.currentId);
    }, { passive: true });
  }
  if (!list) return;

  list.addEventListener('click', (e) => {
    const msgEl = e.target.closest('.msg');
    if (!msgEl) return;
    const msgId = Number(msgEl.dataset.id) || 0;
    const clientId = msgEl.dataset.clientId || '';

    if (e.target.closest('.msg-retry')) {
      if (clientId) retrySend(state.currentId, clientId);
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
      if (e.altKey && msg && msg.body) {
        copyText(msg.body, 'Text copied');   // Alt+click: copy the raw text
      } else {
        copyText(`${location.origin}/?c=${state.currentId}&m=${msgId}`, 'Link copied');
      }
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
    if (li && li.dataset.id) openChannel(Number(li.dataset.id));
  };
  on(byId('channel-list'), 'click', open);
  on(byId('dm-list'), 'click', open);
  on(byId('new-channel-btn'), 'click', openNewChannelModal);
  on(byId('new-dm-btn'), 'click', openNewDMModal);
  on(byId('nav-toggle'), 'click', () => {
    if (document.body.classList.toggle('nav-open')) dismissKeyboard();
  });
  // Tapping the scrim behind the mobile drawer closes it.
  on(document.querySelector('.nav-backdrop'), 'click', () =>
    document.body.classList.remove('nav-open'));
}

function wireHeader() {
  on(byId('join-btn'), 'click', async () => {
    const ch = state.channels.get(state.currentId);
    if (!ch) return;
    try {
      const data = await api(`/api/channels/${ch.id}/join`, { method: 'POST' });
      mergeChannel(data.channel);
      renderSidebar();
      renderChannelHeader();
      toast(`Joined #${ch.name}`);
    } catch { /* toasted */ }
  });
  on(byId('members-btn'), 'click', openMembersModal);
  on(byId('mute-btn'), 'click', toggleMute);
  on(byId('files-btn'), 'click', openFilesModal);
  on(byId('info-btn'), 'click', openChannelInfoModal);
  on(byId('jump-latest'), 'click', () => {
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
  on(form, 'submit', (e) => {
    e.preventDefault();
    submitComposer();
  });
  on(ta, 'input', () => {
    autogrow();
    if (ta.value.trim()) sendTyping();
    queueDraftSave();
  });
  on(byId('composer-cancel'), 'click', () => cancelEdit());
  on(ta, 'keydown', (e) => {
    if (e.isComposing) return;
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

// Phone / installed-PWA back button: back closes whatever is open (lightbox,
// palette, modal, menu, drawer), then walks back through visited channels, and
// only a second press with nothing left actually leaves the app. Desktop
// browsers keep their native back untouched.
function wireBackButton() {
  const standalone = matchMedia('(display-mode: standalone)').matches;
  if (!standalone && !matchMedia('(max-width: 760px)').matches) return;
  const trap = () => history.pushState({ slock: 1 }, '');
  trap();
  window.addEventListener('popstate', () => {
    const closedSomething = (emojiPickerEl && (closeEmojiPicker(), true))
      || closeLightbox() || closePalette() || closeTopModal() || closeMeMenu()
      || (document.body.classList.contains('nav-open')
        && (document.body.classList.remove('nav-open'), true));
    if (closedSomething) { trap(); return; }
    const prev = chanBack.pop();
    if (prev && state.channels.has(prev)) {
      openChannel(prev, { fromBack: true });
      trap();
      return;
    }
    // Nothing left to close or revisit. We are now past our trap entry: one
    // more press within the window leaves for real; staying re-arms the trap.
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
    if (document.hidden) return;
    if (!state.connected) {
      clearTimeout(reconnectTimer);
      backoffMs = 1000;
      connectSSE();
    } else {
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
  const EDGE = 24;      // px from the screen edge that can start an open
  const CLAIM_DX = 10;  // horizontal movement before we claim the gesture
  const FLICK = 0.3;    // px/ms — faster than this decides by direction

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

  const settle = (open) => {
    document.body.classList.remove('nav-dragging');
    document.body.style.removeProperty('--nav-drag'); // CSS transition finishes it
    document.body.classList.toggle('nav-open', open);
    if (open) dismissKeyboard(); // sliding the menu over a focused composer
    gesture = null;
  };

  document.addEventListener('touchstart', (e) => {
    gesture = null;
    if (!mq.matches || e.touches.length !== 1) return;
    if (document.body.classList.contains('modal-open') || pal.open) return;
    const t = e.touches[0];
    const open = document.body.classList.contains('nav-open');
    let mode = null;
    if (open) {
      mode = 'close'; // anywhere over the drawer or its scrim
    } else if (sideRight() ? t.clientX >= innerWidth - EDGE : t.clientX <= EDGE) {
      mode = 'open';
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
    document.body.style.setProperty('--nav-drag', String(gesture.p));
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
  applyTheme(localStorage.getItem(LS.theme) || 'system');
  applySide(localStorage.getItem(LS.side) === 'right' ? 'right' : 'left');
  applyDensity(localStorage.getItem(LS.density) === 'compact' ? 'compact' : 'cozy');
  applySidebarWidth(parseInt(localStorage.getItem(LS.sidebarW), 10) || 0);
  applyZoom(parseFloat(localStorage.getItem(LS.zoom)) || 1);
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
  wireBackButton();
  wireSidebarResize();

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
    return;
  }

  renderSidebar();
  updateBadges();

  // Pick the channel to open: ?c= → last visited → first member channel → first.
  const params = new URLSearchParams(location.search);
  let target = Number(params.get('c')) || Number(localStorage.getItem(LS.lastChannel)) || 0;
  if (!state.channels.has(target)) target = 0;
  if (!target) {
    const member = sortedChannels().find((c) => c.is_member) || sortedChannels()[0] || sortedDMs()[0];
    target = member ? member.id : 0;
  }
  const jumpTo = Number(params.get('m')) || 0;
  if (target) await openChannel(target, jumpTo ? { jumpTo } : {});

  connectSSE();
  await registerSW();
  refreshNotifButton();

  if (state.mustChangePw) openPasswordModal(true);
}

boot();
