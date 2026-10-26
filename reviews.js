// ============================================================================
// Upper Echelon Automotive — Website Reviews (public side)
// File name in your backend repo:  reviews.js   (top level, next to loyalty.js)
//
// server.js already loads this file automatically:  mountOptional('/reviews', 'reviews')
//
//   GET  /reviews/public   approved reviews + average, shown on ueauto.store
//   POST /reviews          a customer submits a review (starts as "pending")
//   GET  /reviews/admin    opens the service desk on the Website reviews tab
//
// You approve, hide, reply to, or delete reviews in the service desk:
// Website reviews tab. Those routes live in loyalty.js.
//
// Needs the uea_site_reviews table (run reviews.sql once in Supabase).
// Env vars it uses (you already have them): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (or SUPABASE_SERVICE_KEY), TEXTBELT_KEY (optional, texts you about new reviews).
// ============================================================================

const express = require('express');
const crypto = require('crypto');

const router = express.Router();

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const PUBLIC_BASE = (process.env.PUBLIC_BACKEND_URL || 'https://uea-backend-3.onrender.com').replace(/\/$/, '');

function httpErr(status, message, extra) { const e = new Error(message); e.status = status; if (extra) Object.assign(e, extra); return e; }

async function sb(pathAndQuery, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && (data.message || data.hint || data.details)) || text || `Supabase ${r.status}`;
    if (/uea_site_reviews/.test(msg) && /does not exist|schema cache/i.test(msg)) {
      throw httpErr(503, 'Reviews aren’t set up yet. Run reviews.sql in Supabase.');
    }
    throw httpErr(r.status >= 500 ? 502 : 400, msg);
  }
  return data;
}

const h = fn => (req, res) => fn(req, res).catch(e => {
  if (!e.status || e.status >= 500) console.error('[reviews]', req.method, req.path, e.message);
  const out = { error: e.status && e.status < 500 ? e.message : (e.status === 503 ? e.message : 'Server error. Try again in a moment.') };
  if (e.fields) out.fields = e.fields;
  res.status(e.status || 500).json(out);
});

router.use(express.json({ limit: '50kb' }));

// ── Public list ──────────────────────────────────────────────────────────────
// Cached for a minute so a busy page doesn't hit the database on every visit.
let cache = null, cacheAt = 0;
router.get('/public', h(async (req, res) => {
  if (!cache || Date.now() - cacheAt > 60 * 1000) {
    const rows = await sb('uea_site_reviews?status=eq.approved&select=name,city,service,body,rating,reply,created_at&order=featured.desc,created_at.desc&limit=200');
    const count = rows.length;
    const average = count ? rows.reduce((s, r) => s + Number(r.rating || 0), 0) / count : 0;
    cache = { reviews: rows, count, average: Math.round(average * 10) / 10 };
    cacheAt = Date.now();
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.json(cache);
}));
router.clearCache = () => { cache = null; };

// ── Submit ───────────────────────────────────────────────────────────────────
const hits = new Map();
const clean = (v, n) => (v == null ? '' : String(v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s+\n/g, '\n').trim().slice(0, n));

router.post('/', h(async (req, res) => {
  const b = req.body || {};
  const ip = String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();

  // Spam traps: the hidden "website" field, and forms filled in faster than a person can.
  if (b.website) return res.json({ ok: true });
  if (b.started_at && Date.now() - Number(b.started_at) < 4000) return res.json({ ok: true });

  const now = Date.now(), recent = (hits.get(ip) || []).filter(t => now - t < 60 * 60 * 1000);
  if (recent.length >= 5) throw httpErr(429, 'You’ve sent a few reviews already. Please try again later.');

  const rating = Math.round(Number(b.rating));
  const name = clean(b.name, 60), city = clean(b.city, 60), service = clean(b.service, 80), body = clean(b.body, 1500);
  const fields = {};
  if (!(rating >= 1 && rating <= 5)) fields.rating = 'Choose a star rating.';
  if (name.length < 2) fields.name = 'Enter your name.';
  if (body.length < 10) fields.body = 'Write at least a sentence about your service.';
  if (/https?:\/\/|www\./i.test(body)) fields.body = 'Please leave links out of your review.';
  if (Object.keys(fields).length) throw httpErr(400, 'Check the highlighted fields.', { fields });

  recent.push(now); hits.set(ip, recent); if (hits.size > 5000) hits.clear();
  const ipHash = crypto.createHash('sha256').update(`uea|${ip}`).digest('hex').slice(0, 32);

  await sb('uea_site_reviews', {
    method: 'POST',
    body: { name, city: city || null, service: service || null, body, rating, status: 'pending', ip_hash: ipHash,
      user_agent: clean(req.get('user-agent'), 200) || null }
  });
  notifyOwner({ name, rating, body }).catch(e => console.warn('[reviews] owner text not sent:', e.message));
  res.json({ ok: true });
}));

// Texts you about a new review, using the "Your cell" number in desk Settings → Shop.
async function notifyOwner({ name, rating, body }) {
  const key = process.env.TEXTBELT_KEY;
  if (!key) return;
  const rows = await sb('uea_loyalty_settings?id=eq.1&select=config').catch(() => []);
  const cfg = (rows && rows[0] && rows[0].config) || {};
  const digits = String(cfg.notify_phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return;
  const msg = `New website review (${rating}★) from ${name}: "${body.slice(0, 90)}${body.length > 90 ? '…' : ''}" Approve it in the desk: ${PUBLIC_BASE}/reviews/admin`;
  await fetch('https://textbelt.com/text', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: digits, message: msg, key })
  });
}

// ── Admin shortcut ───────────────────────────────────────────────────────────
router.get('/admin', (req, res) => res.redirect(302, '/loyalty/admin#webreviews'));

module.exports = router;
