'use strict';

// ---------------------------------------------------------------------------
// DUST dashboard
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const CLICK_PRESETS = [
  { label: '1', value: 1 },
  { label: '5', value: 5 },
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '100', value: 100 },
  { label: '∞', value: null },
];
const TIME_PRESETS = [
  { label: '5m', value: 5 },
  { label: '1h', value: 60 },
  { label: '24h', value: 1440 },
  { label: '7d', value: 10080 },
  { label: '∞', value: null },
];

const state = {
  maxClicks: null,
  ttlMinutes: 1440,
  links: [],
  lastResult: null,
};

// --- helpers -----------------------------------------------------------------

const fmtDur = (mins) =>
  mins == null ? 'forever' : mins < 60 ? `${mins}m` : mins < 1440 ? `${mins / 60}h` : `${mins / 1440}d`;

const fmtCountdown = (ms) => {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};

function fateText(maxClicks, ttlMinutes) {
  const c = maxClicks == null ? null : `${maxClicks} click${maxClicks === 1 ? '' : 's'}`;
  const t = ttlMinutes == null ? null : fmtDur(ttlMinutes);
  if (!c && !t) return 'This link will be immortal. Bold choice.';
  if (c && !t) return `Dies after ${c}.`;
  if (!c && t) return `Dies in ${t}.`;
  return `Dies after ${c} OR in ${t} — whichever comes first.`;
}

function vitality(link) {
  if (link.expiredBy) return 0;
  const now = Date.now();
  let v = 1;
  if (link.max_clicks != null) v = Math.min(v, (link.max_clicks - link.clicks) / link.max_clicks);
  if (link.expires_at != null) {
    const total = link.expires_at - link.created_at;
    v = Math.min(v, Math.max(0, (link.expires_at - now) / total));
  }
  return Math.max(0, Math.min(1, v));
}

// --- pills ---------------------------------------------------------------------

function buildPills(elId, presets, current, onPick) {
  const box = $(elId);
  box.innerHTML = '';
  for (const p of presets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill' + (p.value === current ? ' active' : '');
    b.textContent = p.label;
    b.addEventListener('click', () => {
      onPick(p.value);
      buildPills(elId, presets, p.value, onPick);
      $('fate-preview').textContent = fateText(state.maxClicks, state.ttlMinutes);
    });
    box.appendChild(b);
  }
}

// --- vault ---------------------------------------------------------------------

function meterHtml(v, dead) {
  const on = dead ? 0 : Math.max(v > 0 ? 1 : 0, Math.ceil(v * 10));
  const cls = v > 0.5 ? 'ok' : v > 0.2 ? 'warn' : 'crit';
  let segs = '';
  for (let i = 0; i < 10; i++) segs += `<span class="seg${i < on ? ` on ${cls}` : ''}"></span>`;
  return `<span class="spec-meter" title="vitality">${segs}</span>`;
}

function renderVault() {
  const vault = $('vault');
  const links = state.links;
  $('vault-count').textContent =
    links.length === 0 ? '' : `${links.filter((l) => !l.expiredBy).length} ALIVE / ${links.filter((l) => l.expiredBy).length} DEAD`;

  if (links.length === 0) {
    vault.innerHTML = '<div class="vault-empty">THE VAULT IS EMPTY — NO LINKS HAVE BEEN BURIED YET</div>';
    return;
  }

  vault.innerHTML = links
    .map((l) => {
      const dead = Boolean(l.expiredBy);
      const host = (() => {
        try { return new URL(l.url).host; } catch { return l.url; }
      })();
      const cause =
        l.expiredBy === 'time' ? 'died of old age' :
        l.expiredBy === 'clicks' ? 'clicked to death' : null;

      const clicksLeft =
        l.max_clicks != null
          ? `<span>clicks <b>${dead ? l.clicks : `${l.clicks}/${l.max_clicks}`}</b></span>`
          : `<span>clicks <b>${l.clicks}</b></span>`;
      const timeLeft =
        l.expires_at != null
          ? `<span data-expire="${l.expires_at}">time left <b>${dead ? '—' : fmtCountdown(l.expires_at - Date.now())}</b></span>`
          : '';

      return `
      <article class="specimen${dead ? ' dead' : ''}" data-code="${esc(l.code)}">
        <div class="specimen-top">
          <span class="spec-code" data-goto>${esc(l.code)}</span>
          ${l.hasPassword ? '<span class="spec-lock" title="password-protected">🔒</span>' : ''}
          ${meterHtml(vitality(l), dead)}
        </div>
        <div class="spec-target" title="${esc(l.url)}">${esc(host)} → ${esc(l.url)}</div>
        <div class="spec-meta">
          ${clicksLeft}
          ${timeLeft}
          <span>born <b>${new Date(l.created_at).toLocaleString()}</b></span>
          ${dead ? `<span class="spec-cause">† ${cause}</span>` : ''}
        </div>
        <div class="spec-actions">
          <button class="btn ghost" data-act="copy" type="button">COPY</button>
          <button class="btn ghost" data-act="qr" type="button">QR</button>
          <button class="btn ghost" data-act="open" type="button">OPEN</button>
          ${dead ? '' : '<button class="btn danger" data-act="kill" type="button">KILL</button>'}
        </div>
      </article>`;
    })
    .join('');
}

async function refresh() {
  try {
    const res = await fetch('/api/links');
    state.links = await res.json();
    renderVault();
    const alive = state.links.filter((l) => !l.expiredBy).length;
    const dead = state.links.length - alive;
    $('statline-text').textContent = `MORTUARY TERMINAL — ${alive} ALIVE · ${dead} DEAD`;
    $('statline').classList.toggle('dead', alive === 0 && dead > 0);
  } catch {
    $('statline-text').textContent = 'MORTUARY TERMINAL — CONNECTION LOST';
  }
}

// --- countdown ticker -------------------------------------------------------------

setInterval(() => {
  for (const el of document.querySelectorAll('[data-expire]')) {
    const b = el.querySelector('b');
    if (b) b.textContent = fmtCountdown(Number(el.dataset.expire) - Date.now());
  }
}, 1000);

setInterval(refresh, 10_000);

// --- actions ------------------------------------------------------------------------

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const shortUrl = (code) => `${location.origin}/${code}`;

$('shorten-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('form-error');
  errEl.textContent = '';
  try {
    const data = await api('/api/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: $('url').value.trim(),
        alias: $('alias').value.trim() || undefined,
        maxClicks: state.maxClicks,
        ttlMinutes: state.ttlMinutes,
        password: $('password').value.trim() || undefined,
      }),
    });
    state.lastResult = data.code;
    const link = $('result-link');
    link.href = data.shortUrl;
    link.textContent = data.shortUrl.replace(/^https?:\/\//, '');
    $('result-fate').textContent = fateText(state.maxClicks, state.ttlMinutes);
    $('result-panel').hidden = false;
    $('url').value = '';
    $('alias').value = '';
    $('password').value = '';
    await refresh();
    $('result-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    errEl.textContent = err.message;
  }
});

$('copy-result').addEventListener('click', async () => {
  await navigator.clipboard.writeText(shortUrl(state.lastResult));
  $('copy-result').textContent = 'COPIED';
  setTimeout(() => ($('copy-result').textContent = 'COPY'), 1200);
});
$('qr-result').addEventListener('click', () => showQr(state.lastResult));
$('again-result').addEventListener('click', () => {
  $('result-panel').hidden = true;
  $('url').focus();
});

$('vault').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  const card = e.target.closest('.specimen');
  if (!card) return;
  const code = card.dataset.code;

  if (e.target.closest('[data-goto]') || btn?.dataset.act === 'open') {
    window.open(shortUrl(code), '_blank', 'noopener');
    return;
  }
  if (!btn) return;

  if (btn.dataset.act === 'copy') {
    await navigator.clipboard.writeText(shortUrl(code));
    btn.textContent = 'COPIED';
    setTimeout(() => (btn.textContent = 'COPY'), 1200);
  } else if (btn.dataset.act === 'qr') {
    showQr(code);
  } else if (btn.dataset.act === 'kill') {
    btn.textContent = 'DEAD';
    btn.disabled = true;
    try {
      await api(`/api/links/${code}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      btn.textContent = 'KILL';
      btn.disabled = false;
    }
  }
});

// --- QR modal --------------------------------------------------------------------------

async function showQr(code) {
  try {
    const { dataUrl } = await api(`/api/qr/${code}`);
    $('qr-img').src = dataUrl;
    $('qr-code-label').textContent = `/${code}`;
    $('qr-modal').hidden = false;
  } catch {}
}
$('qr-close').addEventListener('click', () => ($('qr-modal').hidden = true));
$('qr-modal').addEventListener('click', (e) => {
  if (e.target === $('qr-modal')) $('qr-modal').hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('qr-modal').hidden = true;
});

// --- boot --------------------------------------------------------------------------------

buildPills('clicks-pills', CLICK_PRESETS, state.maxClicks, (v) => (state.maxClicks = v));
buildPills('time-pills', TIME_PRESETS, state.ttlMinutes, (v) => (state.ttlMinutes = v));
$('fate-preview').textContent = fateText(state.maxClicks, state.ttlMinutes);
refresh();
