'use strict';

const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
// Bind to 0.0.0.0 so hosting platforms (Railway etc.) can route traffic.
const HOST = process.env.HOST || '0.0.0.0';
// Point DB_PATH at a persistent volume in production, e.g. /data/links.db.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'links.db');

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    code       TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    max_clicks INTEGER,
    clicks     INTEGER NOT NULL DEFAULT 0,
    password   TEXT
  );
`);

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const newCode = (len = 5) =>
  Array.from(crypto.randomBytes(len))
    .map((b) => ALPHABET[b % ALPHABET.length])
    .join('');

const isExpiredBy = (row) => {
  if (row.expires_at !== null && Date.now() > row.expires_at) return 'time';
  if (row.max_clicks !== null && row.clicks >= row.max_clicks) return 'clicks';
  return null;
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API -------------------------------------------------------------------

app.post('/api/shorten', (req, res) => {
  const { url, alias, maxClicks, ttlMinutes, password } = req.body || {};

  let target;
  try {
    target = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'That is not a valid http(s) URL.' });
  }

  let code = alias
    ? String(alias).trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    : newCode();
  if (!code) return res.status(400).json({ error: 'Alias resolved to nothing.' });
  if (code.length > 32) return res.status(400).json({ error: 'Alias too long (max 32).' });
  if (code === 'api') return res.status(400).json({ error: 'That alias is reserved.' });

  if (db.prepare('SELECT code FROM links WHERE code = ?').get(code)) {
    return res.status(409).json({ error: 'That alias is already buried.' });
  }

  const ttl = Number(ttlMinutes);
  const mc = Number(maxClicks);
  const expires_at = Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 60_000 : null;
  const max_clicks = Number.isFinite(mc) && mc > 0 ? Math.floor(mc) : null;

  db.prepare(
    'INSERT INTO links (code, url, created_at, expires_at, max_clicks, clicks, password) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(code, target.href, Date.now(), expires_at, max_clicks, password || null);

  res.status(201).json({
    code,
    shortUrl: `${req.protocol}://${req.get('host')}/${code}`,
  });
});

app.get('/api/links', (_req, res) => {
  const rows = db.prepare('SELECT * FROM links ORDER BY created_at DESC').all();
  res.json(
    rows.map((r) => ({
      code: r.code,
      url: r.url,
      created_at: r.created_at,
      expires_at: r.expires_at,
      max_clicks: r.max_clicks,
      clicks: r.clicks,
      hasPassword: r.password !== null,
      expiredBy: isExpiredBy(r),
    }))
  );
});

app.delete('/api/links/:code', (req, res) => {
  const info = db
    .prepare('DELETE FROM links WHERE code = ?')
    .run(String(req.params.code).toLowerCase());
  if (info.changes === 0) return res.status(404).json({ error: 'No such specimen.' });
  res.json({ ok: true });
});

app.get('/api/qr/:code', async (req, res) => {
  const row = db
    .prepare('SELECT code FROM links WHERE code = ?')
    .get(String(req.params.code).toLowerCase());
  if (!row) return res.status(404).json({ error: 'No such specimen.' });
  const dataUrl = await QRCode.toDataURL(
    `${req.protocol}://${req.get('host')}/${row.code}`,
    { margin: 1, width: 220, color: { dark: '#0a1a0e', light: '#c8f5cf' } }
  );
  res.json({ dataUrl });
});

app.post('/api/unlock/:code', (req, res) => {
  const row = db
    .prepare('SELECT * FROM links WHERE code = ?')
    .get(String(req.params.code).toLowerCase());
  if (!row || isExpiredBy(row)) {
    return res.status(410).json({ error: 'This link is beyond saving.' });
  }
  if (row.password === null || req.body?.password === row.password) {
    db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ?').run(row.code);
    return res.json({ url: row.url });
  }
  res.status(403).json({ error: 'Wrong password.' });
});

// --- Redirect / tombstones ---------------------------------------------------

const CREDIT = `
      <a class="credit" href="https://github.com/Mostakim52" target="_blank" rel="noopener" title="github.com/Mostakim52">
        <img class="credit-avatar" src="https://avatars.githubusercontent.com/u/104221451?v=4" alt="Mostakim Hossain" width="34" height="34">
        <span class="credit-text">
          <span class="credit-label">MADE BY</span>
          <span class="credit-name">Mostakim Hossain</span>
        </span>
        <span class="credit-glyph">↗</span>
      </a>`;

const pageHead = `
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DUST — link mortuary</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=VT323&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">`;

const timeLived = (row) => {
  const end = Math.min(row.expires_at ?? Infinity, Date.now());
  const ms = Math.max(0, end - row.created_at);
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ${Math.floor((ms % 60_000) / 1000)}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
};

const tombstonePage = (code, row, cause) => {
  const epitaph =
    cause === 'clicks'
      ? 'This link was clicked to death.'
      : cause === 'time'
        ? 'This link died of old age.'
        : 'No body was found. This grave is empty.';
  const stats = row
    ? `<div class="tomb-stats">
           <span>lived for <b>${timeLived(row)}</b></span>
           <span>received <b>${row.clicks}</b> click${row.clicks === 1 ? '' : 's'}</span>
           <span>resting since <b>${new Date(row.expires_at ?? Date.now()).toLocaleString()}</b></span>
         </div>`
    : '';
  return `<!doctype html><html lang="en"><head>${pageHead}</head><body>
    <div class="crt"></div><div class="vignette"></div>
    <main class="tomb-wrap">
      <div class="tombstone">
        <div class="tomb-cross">†</div>
        <h1 class="tomb-code">/${code}</h1>
        <p class="tomb-epitaph">${epitaph}</p>
        ${stats}
        <a class="btn ghost" href="/">RESURRECT SOMETHING ELSE</a>
        <div class="tomb-credit">${CREDIT}</div>
      </div>
    </main>
  </body></html>`;
};

const gatePage = (code) => `<!doctype html><html lang="en"><head>${pageHead}</head><body>
  <div class="crt"></div><div class="vignette"></div>
  <main class="tomb-wrap">
    <div class="tombstone gate">
      <div class="tomb-cross">🔒</div>
      <h1 class="tomb-code">/${code}</h1>
      <p class="tomb-epitaph">This grave is sealed. Speak the password.</p>
      <form id="gate-form" class="gate-form">
        <input id="gate-password" type="password" placeholder="password" autocomplete="off" required>
        <button class="btn primary" type="submit">UNSEAL</button>
      </form>
      <p class="gate-error" id="gate-error"></p>
      <div class="tomb-credit">${CREDIT}</div>
    </div>
  </main>
  <script>
    const form = document.getElementById('gate-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await fetch('/api/unlock/${code}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('gate-password').value })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) { location.href = data.url; }
      else {
        const el = document.getElementById('gate-error');
        el.textContent = data.error || 'Unsealing failed.';
        form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
      }
    });
  </script>
</body></html>`;

app.get('/:code', (req, res) => {
  const code = String(req.params.code).toLowerCase();
  if (code === 'favicon.ico') return res.status(404).end();
  const row = db.prepare('SELECT * FROM links WHERE code = ?').get(code);

  if (!row) return res.status(404).type('html').send(tombstonePage(code, null, null));
  const cause = isExpiredBy(row);
  if (cause) return res.status(410).type('html').send(tombstonePage(code, row, cause));
  if (row.password !== null) return res.status(401).type('html').send(gatePage(code));

  db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ?').run(code);
  res.redirect(302, row.url);
});

// Run as a server locally and in production (Railway injects PORT).
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`DUST mortuary terminal open at http://${HOST}:${PORT}`);
  });
}

module.exports = app;
