// slock login page: sign-in + forgot-password. Vanilla module, no inline JS.

const byId = (id) => document.getElementById(id);

function showError(el, text) {
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

async function postJSON(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Network error — are you offline?');
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw new Error((data && data.message) || `Request failed (${res.status})`);
  }
  return data;
}

// Already signed in? Skip the form.
fetch('/api/auth/me').then((res) => {
  if (res.ok) location.href = '/';
}).catch(() => {});

// Workspace branding (unauthenticated endpoint). Best-effort: on any failure
// the built-in mark and default name simply stay.
fetch('/api/workspace').then(async (res) => {
  if (!res.ok) return;
  const data = await res.json().catch(() => null);
  const ws = data && data.workspace;
  if (!ws) return;
  const nameEl = byId('workspace-name');
  if (nameEl && ws.name) nameEl.textContent = ws.name;
  // Matches the app's "<workspace> - slock", keeping the "Sign in" prefix the
  // static title already carries. A workspace named "slock" collapses to one.
  if (ws.name) {
    document.title = ws.name === 'slock'
      ? 'Sign in · slock'
      : `Sign in · ${ws.name} - slock`;
  }
  const img = byId('workspace-icon');
  const logo = document.querySelector('.workspace-logo');
  if (img && ws.icon_url) {
    img.src = ws.icon_url;
    img.removeAttribute('hidden');
    // Attribute, not the `hidden` property: that property only exists on
    // HTMLElement, so setting it on an <svg> would do nothing at all.
    if (logo) logo.setAttribute('hidden', '');
  }
}).catch(() => {});

const loginForm = byId('login-form');
const forgotForm = byId('forgot-form');

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = byId('login-error');
    const submit = byId('login-submit');
    showError(errEl, '');
    const fd = new FormData(loginForm);
    const email = String(fd.get('email') || '').trim();
    const password = String(fd.get('password') || '');
    if (!email || !password) {
      showError(errEl, 'Enter your email and password.');
      return;
    }
    if (submit) submit.disabled = true;
    try {
      await postJSON('/api/auth/login', { email, password });
      location.href = '/';
    } catch (err) {
      showError(errEl, err.message);
      if (submit) submit.disabled = false;
    }
  });
}

const forgotLink = byId('forgot-link');
if (forgotLink && loginForm && forgotForm) {
  forgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    loginForm.hidden = !loginForm.hidden;
    forgotForm.hidden = !forgotForm.hidden;
    const target = forgotForm.hidden ? loginForm : forgotForm;
    const first = target.querySelector('input');
    if (first) first.focus();
  });
}

if (forgotForm) {
  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = byId('forgot-error');
    const doneEl = byId('forgot-done');
    showError(errEl, '');
    const fd = new FormData(forgotForm);
    const email = String(fd.get('email') || '').trim();
    if (!email) {
      showError(errEl, 'Enter your email address.');
      return;
    }
    try {
      await postJSON('/api/auth/forgot', { email });
      if (doneEl) doneEl.hidden = false;
    } catch (err) {
      showError(errEl, err.message);
    }
  });
}
