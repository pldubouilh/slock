// slock password-reset page: reads ?token=, sets the new password.

const byId = (id) => document.getElementById(id);

function showError(text) {
  const el = byId('reset-error');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

const token = new URLSearchParams(location.search).get('token') || '';
const form = byId('reset-form');

if (!token) {
  showError('This reset link is missing its token. Request a new one from the login page.');
  if (form) {
    for (const el of form.querySelectorAll('input, button')) el.disabled = true;
  }
}

if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const fd = new FormData(form);
    const newPassword = String(fd.get('new_password') || '');
    const confirm = String(fd.get('confirm_password') || '');
    if (newPassword.length < 8) {
      showError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      showError('Passwords do not match.');
      return;
    }
    let res;
    try {
      res = await fetch('/api/auth/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: newPassword }),
      });
    } catch {
      showError('Network error — are you offline?');
      return;
    }
    if (res.status === 204) {
      const el = byId('reset-error');
      if (el) {
        el.textContent = 'Password updated — taking you to the sign-in page…';
        el.hidden = false;
      }
      setTimeout(() => { location.href = '/login.html'; }, 1200);
      return;
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    showError((data && data.message) || 'That reset link is invalid or has expired.');
  });
}
