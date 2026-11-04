// ============================================================================
// Upper Echelon Automotive — Square deposits and parts prepayment
// File name in your backend repo:  deposits.js   (next to slots.js and loyalty.js)
// server.js mounts it at /deposits, before the JSON parser (the Square webhook
// needs the raw request body to check its signature).
//
// What it does:
//   GET  /deposits/config          → deposit amounts the website shows
//   POST /deposits/checkout        → website: makes the Square checkout for a booking's $50 deposit (+ $100 rush)
//   GET  /deposits/status/:id      → website: has this checkout been paid yet?
//   POST /deposits/webhook         → optional: Square tells us a payment went through
//   (The server also checks Square every minute, so the webhook is not required.)
//   GET  /deposits/admin           → service writer page: parts prepayment and retainer links
//   GET  /deposits/health          → setup check
//
// Rules (match the Service Agreement):
//   • Every online booking pays a $50 non-refundable booking deposit. It is credited to
//     the final invoice and the time is NOT reserved until it is paid.
//   • Rush bookings pay the $50 deposit + the $100 rush fee in the same checkout.
//   • Shop-supplied parts on jobs under $499: full parts cost + $50 parts deposit, paid
//     before anything is ordered.
//   • Jobs $499+: 50% retainer (the booking deposit counts toward it), plus any parts
//     cost above the retainer. No separate parts deposit.
//
// Env vars (Render → your service → Environment):
//   SQUARE_ACCESS_TOKEN           Square Developer → your app → Production → Access token
//   SQUARE_LOCATION_ID            Square Developer → your app → Locations
//   SQUARE_WEBHOOK_SIGNATURE_KEY  optional; only if you set up a Square webhook
//   SQUARE_WEBHOOK_URL            optional; defaults to https://uea-backend-3.onrender.com/deposits/webhook
//   SQUARE_ENV                    optional; "sandbox" to test with Square's sandbox
//   DEPOSIT_HOLD_MINUTES          optional; minutes a time is held while the customer pays (default 10, 0 = never)
//   DEPOSIT_DESK_PASSWORD         optional; a password for the service writer's link page
//                                 (the owner password LOYALTY_ADMIN_PASSWORD always works)
//   DEPOSITS_ENABLED=false        optional; turns deposits off without removing the Square keys
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// ── Amounts (cents) ─────────────────────────────────────────────────────────
const BOOKING_DEPOSIT = 5000;   // $50
const RUSH_FEE = 10000;         // $100
const PARTS_DEPOSIT = 5000;     // $50
const RETAINER_THRESHOLD = 49900;   // jobs $499 and over use the 50% retainer instead

// ── Settings ────────────────────────────────────────────────────────────────
const TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const LOCATION = process.env.SQUARE_LOCATION_ID || '';
const SIG_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
const PUBLIC_BASE = (process.env.PUBLIC_BACKEND_URL || 'https://uea-backend-3.onrender.com').replace(/\/$/, '');
const WEBHOOK_URL = process.env.SQUARE_WEBHOOK_URL || `${PUBLIC_BASE}/deposits/webhook`;
const SITE = (process.env.SITE_URL || 'https://ueauto.store').replace(/\/$/, '');
const SQUARE = /^sandbox$/i.test(process.env.SQUARE_ENV || '') ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-01-23';
const ENABLED = !!(TOKEN && LOCATION) && process.env.DEPOSITS_ENABLED !== 'false';
const HOLD_MINUTES = Math.max(0, Math.min(60, parseInt(process.env.DEPOSIT_HOLD_MINUTES, 10) >= 0 ? parseInt(process.env.DEPOSIT_HOLD_MINUTES, 10) : 10));
const ADMIN_PASSWORDS = [process.env.LOYALTY_ADMIN_PASSWORD, process.env.DEPOSIT_DESK_PASSWORD].filter(Boolean);
const SLOT_CAPACITY = Math.max(1, parseInt(process.env.SLOT_CAPACITY, 10) || 1);

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const supabase = SB_URL && SB_KEY ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;

const mailer = process.env.EMAIL_FROM && process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_FROM, pass: process.env.GMAIL_APP_PASSWORD } })
  : null;

// The service desk (loyalty.js) — used to mark the job paid and send the booking texts.
function desk() {
  for (const p of ['./loyalty', '../loyalty']) {
    try { return require(p); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const money = c => `$${(c / 100).toFixed(2).replace(/\.00$/, '')}`;
const digits10 = p => { const d = String(p || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : (d.length === 10 ? d : ''); };
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  if (!err.status) console.error('[deposits]', err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please call (251) 289-0740.' });
});
function requireReady() {
  if (!supabase) throw httpErr(503, 'Deposits are not set up yet (missing Supabase settings on the server).');
  if (!ENABLED) throw httpErr(503, 'Deposits are not set up yet (missing Square settings on the server).');
}
function adminOk(req) {
  const pw = req.get('x-admin-password') || '';
  if (!pw || !ADMIN_PASSWORDS.length) return false;
  return ADMIN_PASSWORDS.some(p => crypto.timingSafeEqual(Buffer.from(sha256(pw)), Buffer.from(sha256(p))));
}
function requireAdmin(req) {
  if (!ADMIN_PASSWORDS.length) throw httpErr(500, 'Set LOYALTY_ADMIN_PASSWORD on Render first.');
  if (!adminOk(req)) throw httpErr(401, 'Wrong password.');
}
const hits = new Map();
function rateLimited(ip, max) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}
const ipOf = req => String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();

async function square(path, { method = 'GET', body } = {}) {
  const r = await fetch(SQUARE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (d.errors || []).map(e => e.detail || e.code).join('; ') || `Square returned ${r.status}`;
    console.error('[deposits] Square error:', msg);
    throw httpErr(502, 'The payment page could not be created. Please call (251) 289-0740.');
  }
  return d;
}

// One Square checkout page for a list of { name, cents, note }.
async function createLink(reqRow, items, { buyerEmail, buyerPhone, note }) {
  // Only the email is pre-filled. Square rejects many phone formats, and the
  // customer can type their number on the checkout page if Square asks for it.
  const pre = {};
  if (isEmail(buyerEmail)) pre.buyer_email = buyerEmail;
  const body = {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: LOCATION,
      reference_id: String(reqRow.id).slice(0, 40),
      line_items: items.map(i => ({
        name: i.name.slice(0, 500), quantity: '1', note: i.note ? i.note.slice(0, 2000) : undefined,
        base_price_money: { amount: i.cents, currency: 'USD' }
      }))
    },
    checkout_options: {
      redirect_url: reqRow.kind === 'booking' ? `${SITE}/?deposit=${reqRow.id}#book` : `${SITE}/?paid=${reqRow.id}`,
      ask_for_shipping_address: false,
      allow_tipping: false
    },
    payment_note: note ? note.slice(0, 500) : undefined
  };
  if (Object.keys(pre).length) body.pre_populated_data = pre;
  let d;
  try {
    d = await square('/v2/online-checkout/payment-links', { method: 'POST', body });
  } catch (e) {
    if (!body.pre_populated_data) throw e;
    // Square didn't like a pre-filled detail. Try once more with nothing pre-filled.
    delete body.pre_populated_data;
    body.idempotency_key = crypto.randomUUID();
    d = await square('/v2/online-checkout/payment-links', { method: 'POST', body });
  }
  const link = d.payment_link || {};
  const { error } = await supabase.from('uea_payment_requests')
    .update({ square_link_id: link.id, square_order_id: link.order_id, url: link.url })
    .eq('id', reqRow.id);
  if (error) throw error;
  return link.url;
}

async function capacity() {
  try {
    const { data } = await supabase.from('uea_loyalty_settings').select('config').eq('id', 1).maybeSingle();
    const n = Math.round(Number(data && data.config && data.config.jobs_per_window) || 0);
    return Math.max(1, n || SLOT_CAPACITY);
  } catch (e) { return SLOT_CAPACITY; }
}

async function ownerPhone() {
  try {
    const { data } = await supabase.from('uea_loyalty_settings').select('config').eq('id', 1).maybeSingle();
    return digits10(data && data.config && data.config.notify_phone);
  } catch (e) { return ''; }
}
async function textOwner(message) {
  const to = await ownerPhone();
  if (!to || !process.env.TEXTBELT_KEY) return;
  try {
    await fetch('https://textbelt.com/text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: to, message: message.slice(0, 640), key: process.env.TEXTBELT_KEY })
    });
  } catch (e) { console.warn('[deposits] owner text not sent:', e.message); }
}
async function emailOwner(subject, text) {
  if (!mailer) return;
  try {
    await mailer.sendMail({ from: `"Upper Echelon Automotive" <${process.env.EMAIL_FROM}>`, to: process.env.EMAIL_FROM, subject, text });
  } catch (e) { console.warn('[deposits] owner email not sent:', e.message); }
}
async function logDesk(jobId, kind, text) {
  if (!jobId) return;
  try { await supabase.from('uea_job_events').insert({ job_id: jobId, by_name: 'Square', kind, text: text.slice(0, 1000) }); }
  catch (e) { console.warn('[deposits] desk note not saved:', e.message); }
}

// ── Mark a payment request paid (from the webhook, or a status check) ───────
async function markPaid(row, paymentId, amountCents) {
  const { data: claimed, error } = await supabase.from('uea_payment_requests')
    .update({ status: 'paid', paid_at: new Date().toISOString(), square_payment_id: paymentId || null })
    .eq('id', row.id).eq('status', 'open').select('*');
  if (error) throw error;
  if (!claimed || !claimed.length) return;   // already handled
  const paid = claimed[0];
  const amount = amountCents || paid.amount_cents;

  if (paid.kind === 'booking') {
    // Reserve the time for real.
    let conflict = false;
    if (paid.slot_token_hash) {
      const { data: rows } = await supabase.from('uea_booked_slots')
        .update({ status: 'held', deposit_status: 'paid', deposit_paid_at: new Date().toISOString(), hold_expires_at: null })
        .eq('release_token_hash', paid.slot_token_hash).select('slot_date, slot_time');
      const cap = await capacity();
      for (const r of rows || []) {
        const { count } = await supabase.from('uea_booked_slots').select('id', { count: 'exact', head: true })
          .eq('slot_date', r.slot_date).eq('slot_time', r.slot_time).eq('status', 'held')
          .or('deposit_status.is.null,deposit_status.in.(paid,waived)');
        if ((count || 0) > cap) conflict = true;
      }
    }
    if (conflict) await supabase.from('uea_payment_requests').update({ conflict: true }).eq('id', paid.id);
    const loyalty = desk();
    if (paid.desk_booking_id && loyalty && loyalty.depositPaid) {
      try { await loyalty.depositPaid(paid.desk_booking_id, { amount_cents: amount, payment_id: paymentId, conflict }); }
      catch (e) { console.error('[deposits] desk update failed:', e.message); }
    } else {
      await textOwner(`UEA deposit paid ${money(amount)}: ${paid.customer_name || ''} ${paid.phone || ''}. ${paid.description || ''}`);
    }
    if (conflict) await emailOwner('Booking deposit paid, but the time filled first',
      `${paid.customer_name} (${paid.phone}) paid the ${money(amount)} deposit after their arrival window filled.\n${paid.description || ''}\nCall them to choose a new time. The deposit carries over.`);
    return;
  }

  // Parts prepayment or retainer: tell the shop it's safe to order.
  const what = paid.kind === 'parts' ? 'Parts prepayment' : 'Retainer';
  await logDesk(paid.desk_booking_id, 'status', `${what} paid: ${money(amount)}. OK to order parts.`);
  await textOwner(`UEA ${what.toLowerCase()} PAID ${money(amount)}: ${paid.customer_name || ''} ${paid.phone || ''}. OK to order parts. ${paid.description || ''}`);
  await emailOwner(`${what} paid — OK to order parts (${paid.customer_name || 'customer'})`,
    `${paid.customer_name || 'Customer'} paid ${money(amount)} through Square.\n\n${paid.description || ''}\n\nThis payment is non-refundable once parts are ordered (Service Agreement, sections 4–6).`);
}

// Ask Square directly whether an order has been paid (backup if a webhook is late).
async function syncFromSquare(row) {
  if (!row || row.status !== 'open' || !row.square_order_id) return row;
  try {
    const d = await square(`/v2/orders/${encodeURIComponent(row.square_order_id)}`);
    const o = d.order || {};
    const tenders = o.tenders || [];
    const paidCents = tenders.reduce((s, t) => s + ((t.amount_money && t.amount_money.amount) || 0), 0);
    const due = o.net_amount_due_money ? o.net_amount_due_money.amount : null;
    if (tenders.length && (o.state === 'COMPLETED' || due === 0 || paidCents >= row.amount_cents)) {
      const tender = tenders[0];
      await markPaid(row, tender.payment_id || tender.id, paidCents || row.amount_cents);
      const { data } = await supabase.from('uea_payment_requests').select('*').eq('id', row.id).maybeSingle();
      return data || row;
    }
  } catch (e) { /* the webhook will catch it */ }
  return row;
}

// ── Webhook (raw body; mounted before express.json) ─────────────────────────
router.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), h(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!SIG_KEY) return res.status(200).json({ ok: true, note: 'No webhook key set; payments are picked up by the every-minute check.' });
  const expected = crypto.createHmac('sha256', SIG_KEY).update(WEBHOOK_URL + raw).digest('base64');
  const got = req.get('x-square-hmacsha256-signature') || '';
  if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    console.warn('[deposits] webhook signature did not match. Check SQUARE_WEBHOOK_URL matches the URL saved in Square exactly.');
    return res.status(401).end();
  }
  let evt = {};
  try { evt = JSON.parse(raw); } catch (e) { return res.status(400).end(); }
  const pay = evt.data && evt.data.object && evt.data.object.payment;
  if (pay && pay.order_id && pay.status === 'COMPLETED' && supabase) {
    const { data: row } = await supabase.from('uea_payment_requests').select('*').eq('square_order_id', pay.order_id).maybeSingle();
    if (row) await markPaid(row, pay.id, pay.amount_money && pay.amount_money.amount);
  }
  res.status(200).json({ ok: true });
}));

// Everything below takes JSON and is called from ueauto.store.
router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
router.use(express.json({ limit: '200kb' }));

// ── Public routes ───────────────────────────────────────────────────────────
router.get('/health', h(async (req, res) => {
  const out = { route: 'ok', enabled: ENABLED, square_env: SQUARE.includes('sandbox') ? 'sandbox' : 'production',
    access_token: !!TOKEN, location_id: !!LOCATION, webhook: SIG_KEY ? 'on' : 'off (not needed: server checks Square every minute)',
    hold_minutes: HOLD_MINUTES, supabase: !!supabase, table: 'unknown' };
  if (supabase) {
    const { error } = await supabase.from('uea_payment_requests').select('id').limit(1);
    out.table = error ? `missing: run 3-deposits.sql in Supabase (${error.message})` : 'ok';
  }
  if (ENABLED) {
    try { const d = await square(`/v2/locations/${encodeURIComponent(LOCATION)}`); out.square = d.location ? `ok (${d.location.name})` : 'unknown'; }
    catch (e) { out.square = 'error: check SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID'; }
  }
  res.json(out);
}));

router.get('/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ enabled: ENABLED, booking_cents: BOOKING_DEPOSIT, rush_cents: RUSH_FEE, parts_deposit_cents: PARTS_DEPOSIT, hold_minutes: HOLD_MINUTES });
});

router.post('/checkout', h(async (req, res) => {
  requireReady();
  if (rateLimited(ipOf(req), 10)) throw httpErr(429, 'Too many attempts. Please call (251) 289-0740.');
  const b = req.body || {};
  const holdId = clean(b.hold_id, 40), holdToken = clean(b.hold_token, 100);
  if (!holdId || !holdToken) throw httpErr(400, 'Pick your time again, then try once more.');
  const tokenHash = sha256(holdToken);
  const { data: held, error } = await supabase.from('uea_booked_slots').select('id, slot_date, slot_time, rush')
    .eq('release_token_hash', tokenHash).eq('status', 'held');
  if (error) throw error;
  if (!held || !held.some(r => r.id === holdId)) throw httpErr(409, 'That time is no longer held. Please pick it again.');

  const deskId = clean(b.desk_booking_id, 64) || null;
  if (deskId) await supabase.from('uea_booked_slots').update({ desk_booking_id: deskId }).eq('release_token_hash', tokenHash);

  const rush = !!b.rush;
  const items = [{ name: 'Booking deposit (applies to your repair)', cents: BOOKING_DEPOSIT,
    note: 'Non-refundable. Credited toward your final invoice. Holds your spot in line.' }];
  if (rush) items.push({ name: 'Rush / priority dispatch fee', cents: RUSH_FEE, note: 'Non-refundable.' });
  const total = items.reduce((s, i) => s + i.cents, 0);
  const when = [clean(b.date_label, 40), clean(b.time, 30)].filter(Boolean).join(', ');
  const description = [clean(b.service, 120), clean(b.vehicle, 120), when].filter(Boolean).join(' · ');

  const { data: rows, error: e2 } = await supabase.from('uea_payment_requests').insert({
    kind: 'booking', amount_cents: total, line_items: items, slot_token_hash: tokenHash, desk_booking_id: deskId,
    customer_name: clean(b.name, 120), phone: clean(b.phone, 40), email: isEmail(b.email) ? clean(b.email, 160) : null,
    description, created_by: 'Website'
  }).select('*');
  if (e2) throw e2;
  const row = rows[0];
  const url = await createLink(row, items, { buyerEmail: b.email, buyerPhone: b.phone,
    note: `UEA booking deposit — ${clean(b.name, 60)} — ${description}`.slice(0, 500) });
  res.json({ ok: true, url, request_id: row.id, amount_cents: total, hold_minutes: HOLD_MINUTES });
}));

router.get('/status/:id', h(async (req, res) => {
  requireReady();
  res.set('Cache-Control', 'no-store');
  const id = clean(req.params.id, 40);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw httpErr(400, 'Unknown payment.');
  let { data: row } = await supabase.from('uea_payment_requests').select('*').eq('id', id).maybeSingle();
  if (!row) throw httpErr(404, 'Unknown payment.');
  row = await syncFromSquare(row);
  res.json({ status: row.status, kind: row.kind, amount_cents: row.amount_cents, conflict: !!row.conflict, description: row.description });
}));

// ── Service writer: parts prepayment and retainer links ─────────────────────
// kind "parts":    parts cost + $50 parts deposit (jobs under $499)
// kind "retainer": 50% of the job total, minus the booking deposit already paid,
//                  plus any parts cost above the retainer (jobs $499+)
function buildItems(b) {
  const parts = Math.max(0, Math.round(Number(b.parts_cents) || 0));
  const total = Math.max(0, Math.round(Number(b.job_total_cents) || 0));
  const credit = Math.max(0, Math.round(Number(b.credit_cents) || 0));
  if (b.kind === 'parts') {
    if (!parts) throw httpErr(400, 'Enter the parts cost.');
    if (total >= RETAINER_THRESHOLD) throw httpErr(400, `This job is ${money(total)}, so it takes the 50% retainer instead. Switch to "Retainer".`);
    return [
      { name: 'Parts (prepaid before we order)', cents: parts, note: 'Non-refundable once ordered.' },
      { name: 'Parts deposit', cents: PARTS_DEPOSIT, note: 'Non-refundable. Credited toward labor when the job is completed.' }
    ];
  }
  if (b.kind === 'retainer') {
    if (total < RETAINER_THRESHOLD) throw httpErr(400, `Retainers are for jobs of ${money(RETAINER_THRESHOLD)} or more. Use "Parts" for this job.`);
    const half = Math.round(total / 2);
    const items = [{ name: `Retainer: 50% of ${money(total)} estimate${credit ? ` (less ${money(credit)} booking deposit)` : ''}`, cents: Math.max(0, half - credit),
      note: 'Non-refundable. Credited toward your final invoice.' }];
    if (parts > half) items.push({ name: 'Parts cost above the retainer', cents: parts - half, note: 'Non-refundable once ordered.' });
    const out = items.filter(i => i.cents > 0);
    if (!out.length) throw httpErr(400, 'Nothing left to collect up front.');
    return out;
  }
  throw httpErr(400, 'Pick Parts or Retainer.');
}

router.post('/admin/preview', h(async (req, res) => {
  requireAdmin(req);
  const items = buildItems(req.body || {});
  res.json({ items, total_cents: items.reduce((s, i) => s + i.cents, 0) });
}));

router.post('/admin/link', h(async (req, res) => {
  requireAdmin(req);
  requireReady();
  const b = req.body || {};
  const items = buildItems(b);
  const name = clean(b.customer_name, 120), phone = clean(b.phone, 40);
  if (!name || !digits10(phone)) throw httpErr(400, 'Enter the customer name and a 10-digit phone number.');
  const description = clean(b.description, 300) || 'Parts order';
  const total = items.reduce((s, i) => s + i.cents, 0);
  const { data: rows, error } = await supabase.from('uea_payment_requests').insert({
    kind: b.kind, amount_cents: total, line_items: items, customer_name: name, phone,
    email: isEmail(b.email) ? clean(b.email, 160) : null, description,
    desk_booking_id: clean(b.desk_booking_id, 64) || null, created_by: clean(b.by, 60) || 'Service desk'
  }).select('*');
  if (error) throw error;
  const row = rows[0];
  const url = await createLink(row, items, { buyerEmail: b.email, buyerPhone: phone, note: `UEA ${b.kind} — ${name} — ${description}` });
  await logDesk(row.desk_booking_id, 'note', `${b.kind === 'parts' ? 'Parts prepayment' : 'Retainer'} link sent: ${money(total)}. Do not order parts until it shows paid.`);

  let texted = false;
  if (b.send_text && process.env.TEXTBELT_KEY) {
    const msg = `Upper Echelon Automotive: to order your parts (${description.slice(0, 80)}), please pay ${money(total)} here: ${url} ` +
      `${b.kind === 'parts' ? 'This covers the parts plus a $50 parts deposit. ' : ''}We order once it's paid. Non-refundable once parts are ordered. Questions? (251) 289-0740`;
    try {
      const r = await fetch('https://textbelt.com/text', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: digits10(phone), message: msg, key: process.env.TEXTBELT_KEY }) });
      texted = !!(await r.json().catch(() => ({}))).success;
    } catch (e) { texted = false; }
  }
  res.json({ ok: true, url, id: row.id, total_cents: total, items, texted });
}));

router.get('/admin/list', h(async (req, res) => {
  requireAdmin(req);
  requireReady();
  const { data, error } = await supabase.from('uea_payment_requests')
    .select('id, kind, status, amount_cents, customer_name, phone, description, url, conflict, created_at, paid_at')
    .order('created_at', { ascending: false }).limit(60);
  if (error) throw error;
  const fresh = [];
  for (const r of data) fresh.push(r.status === 'open' && Date.now() - new Date(r.created_at) < 14 * 864e5 ? await syncFromSquare(r) : r);
  res.json({ requests: fresh });
}));

router.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(ADMIN_HTML);
});

const ADMIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UEA Payment Links</title>
<style>
:root{--bg:#0b0a10;--card:#151020;--line:#2c2440;--fg:#f3efe8;--muted:#a79fb8;--gold:#cba135;--purple:#6b2896;--ok:#4ade80;--bad:#fca5a5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:20px 16px 60px}h1{font-size:1.4rem;margin:0 0 4px;color:var(--gold);letter-spacing:.02em}
.sub{color:var(--muted);margin:0 0 20px;font-size:.92rem}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
label{display:block;font-size:.82rem;color:var(--muted);margin:10px 0 4px}input,select,textarea{width:100%;padding:11px 12px;border-radius:8px;border:1px solid var(--line);background:#0f0b17;color:var(--fg);font:inherit}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:520px){.row{grid-template-columns:1fr}}
.seg{display:flex;gap:8px}.seg button{flex:1;background:#0f0b17;color:var(--fg);border:1px solid var(--line)}.seg button.on{background:var(--purple);border-color:var(--purple)}
button{min-height:44px;padding:0 18px;border:0;border-radius:8px;background:var(--gold);color:#120d00;font-weight:700;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.5}.sum{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}.sum div{display:flex;justify-content:space-between;gap:12px;padding:3px 0}
.tot{font-weight:800;color:var(--gold)}.msg{margin-top:10px;font-size:.92rem}.msg.err{color:var(--bad)}.msg.ok{color:var(--ok)}
.link{word-break:break-all;background:#0f0b17;border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:8px;font-size:.88rem}
.chk{display:flex;gap:8px;align-items:center;margin-top:12px}.chk input{width:auto}
table{width:100%;border-collapse:collapse;font-size:.88rem}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:.78rem;font-weight:700}.paid{background:#123a22;color:var(--ok)}.open{background:#3a2e10;color:var(--gold)}
</style></head><body><div class="wrap">
<h1>UEA Payment Links</h1><p class="sub">Collect parts money before you order. The shop gets a text when it's paid.</p>
<div class="card" id="login"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password"><div style="margin-top:12px"><button id="go">Open</button></div><div class="msg err" id="lmsg"></div></div>
<div id="app" hidden>
<div class="card">
<div class="seg"><button type="button" data-k="parts" class="on">Parts (job under $499)</button><button type="button" data-k="retainer">Retainer (job $499+)</button></div>
<div class="row"><div><label for="nm">Customer name</label><input id="nm"></div><div><label for="ph">Customer phone</label><input id="ph" inputmode="tel"></div></div>
<label for="em">Customer email (optional)</label><input id="em" type="email">
<label for="ds">What's being ordered</label><input id="ds" placeholder="e.g. Front pads + rotors, 2019 Camry">
<div class="row"><div><label for="pc">Parts cost ($)</label><input id="pc" inputmode="decimal"></div><div><label for="jt">Estimated job total ($)</label><input id="jt" inputmode="decimal"></div></div>
<div id="crw" hidden><label for="cr">Booking deposit already paid ($)</label><input id="cr" inputmode="decimal" value="50"></div>
<label for="jb">Desk job ID (optional, logs it on the job)</label><input id="jb">
<div class="sum" id="sum"></div>
<label class="chk"><input type="checkbox" id="tx" checked> Text the payment link to the customer</label>
<div style="margin-top:12px"><button id="mk">Create payment link</button></div>
<div class="msg" id="msg"></div><div id="out"></div>
</div>
<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><strong>Recent links</strong><button id="rf" style="min-height:36px">Refresh</button></div><div id="list" style="margin-top:8px"></div></div>
</div>
<script>
var pw='',kind='parts',$=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function cents(v){var n=parseFloat(String(v||'').replace(/[^0-9.]/g,''));return isFinite(n)?Math.round(n*100):0}
function money(c){return '$'+(c/100).toFixed(2)}
function api(p,b){return fetch('/deposits'+p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json','x-admin-password':pw},body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'Error');return d})})}
function body(){return{kind:kind,customer_name:$('nm').value,phone:$('ph').value,email:$('em').value,description:$('ds').value,parts_cents:cents($('pc').value),job_total_cents:cents($('jt').value),credit_cents:kind==='retainer'?cents($('cr').value):0,desk_booking_id:$('jb').value,send_text:$('tx').checked}}
var t;function preview(){clearTimeout(t);t=setTimeout(function(){var b=body();if(!b.parts_cents&&!b.job_total_cents){$('sum').innerHTML='';return}
api('/admin/preview',b).then(function(d){$('sum').innerHTML=d.items.map(function(i){return '<div><span>'+esc(i.name)+'</span><span>'+money(i.cents)+'</span></div>'}).join('')+'<div class="tot"><span>Customer pays now</span><span>'+money(d.total_cents)+'</span></div>'}).catch(function(e){$('sum').innerHTML='<div class="msg err">'+esc(e.message)+'</div>'})},250)}
document.querySelectorAll('.seg button').forEach(function(b){b.onclick=function(){kind=b.dataset.k;document.querySelectorAll('.seg button').forEach(function(x){x.classList.toggle('on',x===b)});$('crw').hidden=kind!=='retainer';preview()}});
['pc','jt','cr'].forEach(function(i){$(i).addEventListener('input',preview)});
function load(){api('/admin/list').then(function(d){$('list').innerHTML=d.requests.length?'<table><tr><th>Customer</th><th>For</th><th>Amount</th><th>Status</th></tr>'+d.requests.map(function(r){return '<tr><td>'+esc(r.customer_name||'')+'<br><span style="color:var(--muted)">'+esc(r.phone||'')+'</span></td><td>'+esc(r.kind)+(r.description?'<br><span style="color:var(--muted)">'+esc(r.description)+'</span>':'')+'</td><td>'+money(r.amount_cents)+'</td><td><span class="pill '+(r.status==='paid'?'paid':'open')+'">'+(r.status==='paid'?'PAID':'Waiting')+'</span>'+(r.conflict?'<br><span style="color:var(--bad)">Time conflict</span>':'')+'</td></tr>'}).join('')+'</table>':'<p class="sub">No links yet.</p>'}).catch(function(e){$('list').textContent=e.message})}
$('go').onclick=function(){pw=$('pw').value;api('/admin/list').then(function(){$('login').hidden=true;$('app').hidden=false;load()}).catch(function(e){$('lmsg').textContent=e.message})};
$('pw').addEventListener('keydown',function(e){if(e.key==='Enter')$('go').click()});
$('rf').onclick=load;
$('mk').onclick=function(){var btn=$('mk');btn.disabled=true;$('msg').className='msg';$('msg').textContent='Creating…';$('out').innerHTML='';
api('/admin/link',body()).then(function(d){$('msg').className='msg ok';$('msg').textContent=money(d.total_cents)+' link created'+(d.texted?' and texted to the customer.':'. Copy it and send it to the customer.');
$('out').innerHTML='<div class="link">'+esc(d.url)+'</div><div style="margin-top:8px"><button id="cp" style="min-height:36px">Copy link</button></div>';
$('cp').onclick=function(){navigator.clipboard&&navigator.clipboard.writeText(d.url);$('cp').textContent='Copied'};load()})
.catch(function(e){$('msg').className='msg err';$('msg').textContent=e.message}).then(function(){btn.disabled=false})};
</script></div></body></html>`;

// ── Payment checker ─────────────────────────────────────────────────────────
// Every minute, ask Square about any unpaid link from the last 3 days. This means
// payments are picked up even with no webhook set up in Square.
let checking = false;
async function checkOpenPayments() {
  if (checking || !ENABLED || !supabase) return;
  checking = true;
  try {
    const since = new Date(Date.now() - 3 * 864e5).toISOString();
    const { data, error } = await supabase.from('uea_payment_requests').select('*')
      .eq('status', 'open').not('square_order_id', 'is', null).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(60);
    if (error) throw error;
    for (const row of data || []) await syncFromSquare(row);
  } catch (e) { console.warn('[deposits] payment check skipped:', e.message); }
  finally { checking = false; }
}
if (ENABLED && supabase && process.env.NODE_ENV !== 'test') {
  setTimeout(checkOpenPayments, 15000).unref();
  setInterval(checkOpenPayments, 60000).unref();
}

router.__test = { buildItems, markPaid, syncFromSquare, checkOpenPayments };
module.exports = router;
