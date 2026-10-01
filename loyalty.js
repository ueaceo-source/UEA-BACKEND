// ============================================================================
// Upper Echelon Automotive — Loyalty Program + Admin API
// File name in your backend repo:  loyalty.js   (next to server.js)
//
// Mount in server.js ABOVE any app.use(express.json()) line:
//     app.use('/loyalty', require('./loyalty'));
//
// Env vars (Render → your service → Environment):
//   SUPABASE_URL                 (you likely already have this)
//   SUPABASE_SERVICE_ROLE_KEY    (or SUPABASE_SERVICE_KEY — either name works)
//   LOYALTY_SECRET               long random string, ALSO pasted into the Shopify snippet
//   SHOPIFY_WEBHOOK_SECRET       from Shopify → Settings → Notifications → Webhooks
//   LOYALTY_ADMIN_PASSWORD       owner password for the admin portal
//   LOYALTY_OWNER_EMAIL          owner sign-in email (default ueaceo@ueauto.store)
//   TEXTBELT_KEY                 (already set) used to text customers from the portal
//   PUBLIC_BACKEND_URL           optional, default https://uea-backend-3.onrender.com
//   LOYALTY_ALLOWED_ORIGINS      optional, comma-separated storefront origins
//
// No new npm packages needed (Node 18+ built-in fetch + crypto).
// ============================================================================

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const router = express.Router();

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const LOYALTY_SECRET = process.env.LOYALTY_SECRET || '';
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';
const ADMIN_PASSWORD = process.env.LOYALTY_ADMIN_PASSWORD || '';
const OWNER_EMAIL = (process.env.LOYALTY_OWNER_EMAIL || 'ueaceo@ueauto.store').trim().toLowerCase();
const PUBLIC_BASE = (process.env.PUBLIC_BACKEND_URL || 'https://uea-backend-3.onrender.com').replace(/\/$/, '');
const ORIGINS = (process.env.LOYALTY_ALLOWED_ORIGINS ||
  'https://ueauto.store,https://www.ueauto.store,https://upper-echelon-automotive.myshopify.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const BOOKING_VARIANTS = (process.env.UEA_BOOKING_VARIANT_IDS || '54522213368083').split(',').map(s => s.trim());
const RUSH_VARIANTS = (process.env.UEA_RUSH_VARIANT_IDS || '54522213662995').split(',').map(s => s.trim());

(() => {
  const missing = [];
  if (!SB_URL) missing.push('SUPABASE_URL');
  if (!SB_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!LOYALTY_SECRET) missing.push('LOYALTY_SECRET');
  if (!WEBHOOK_SECRET) missing.push('SHOPIFY_WEBHOOK_SECRET');
  if (!ADMIN_PASSWORD) missing.push('LOYALTY_ADMIN_PASSWORD');
  if (missing.length) console.warn('[loyalty] Missing env vars:', missing.join(', '));
  else console.log('[loyalty] ready');
})();

// ── Default program (editable later in Admin → Settings) ────────────────────
const DEFAULT_CONFIG = {
  // Earning
  points_per_dollar: 1,            // per $1 of labor (and fees paid in Shopify)
  parts_points_per_dollar: 0.5,    // per $1 of parts; parts margin is thinner than labor
  cents_per_point: 2.5,            // what 1 point costs you when redeemed (liability math)
  welcome_bonus: 100,              // after first PAID service, not at signup
  referral_bonus_referrer: 250,
  referral_bonus_friend: 250,
  referral_min_cents: 7500,        // friend's first paid service must be at least $75
  review_bonus: 0,                 // keep 0: Google's policy prohibits incentivized reviews
  book_ahead_days: 2,              // booked this many days before the appointment...
  book_ahead_bonus: 50,            // ...earns this bonus when the job is paid
  offpeak_days: [2, 3],            // 0=Sun ... 6=Sat. Appointments on these days...
  offpeak_bonus: 75,               // ...earn this bonus when the job is paid
  expire_months: 12,               // balance expires after this many months with no activity (0 = never)
  payment_methods: ['Card (external portal)', 'Cash', 'Zelle', 'Check', 'Other'],
  terms_extra: [],                 // your own extra rules, shown on the website under "Your account"

  // Shop / service desk
  shop_phone: '251-289-0740',
  payment_link: '',                // your external card portal link, used in "job complete" texts
  labor_rate_cents: 0,             // default hourly labor rate for estimates (0 = enter price per line)
  parts_markup_pct: 30,            // parts price = cost + this %
  parts_tax_rate: 8.25,            // sales tax % applied to parts on estimates (confirm with your CPA)
  notify_phone: '',                // your cell: texted when a customer approves an estimate
  follow_up_days: 30,              // declined work becomes a follow-up this many days after the job
  tech_can_estimate: true,         // technicians can build and send estimates from the field
  time_windows: ['8–10 AM', '10 AM–12 PM', '12–2 PM', '2–4 PM', '4–6 PM'],
  sms_templates: {
    confirm:   'Hi {first}, this is Upper Echelon Automotive. Your {service} appointment is confirmed for {date}, {window}. Questions? Call {shop_phone}.',
    on_way:    'Hi {first}, {tech} from Upper Echelon Automotive is on the way. Estimated arrival: {eta}.',
    estimate:  'Hi {first}, your estimate for the {vehicle} is ready. Review and approve it here: {estimate_link}',
    complete:  'Hi {first}, your {vehicle} is all set. Total due: {total}. Pay securely here: {pay_link} Thank you for choosing Upper Echelon Automotive!',
    follow_up: 'Hi {first}, on your last visit we recommended: {recommended}. Want us to get that scheduled? Reply or call {shop_phone}.',
    review:    'Thanks for choosing Upper Echelon Automotive, {first}! If you have a minute, a Google review helps a small shop like ours a lot: {review_link}'
  },

  // Tiers: rolling 12-month spend. Multiplier applies to service points (not bonuses).
  tiers: [
    { key: 'standard', name: 'Standard', min_spend_cents: 0,      multiplier: 1,    perks: ['Base points'] },
    { key: 'silver',   name: 'Silver',   min_spend_cents: 60000,  multiplier: 1.1,  perks: ['1.1x points', 'Priority on next-day slots'] },
    { key: 'gold',     name: 'Gold',     min_spend_cents: 150000, multiplier: 1.25, perks: ['1.25x points', 'Priority same-day scheduling'] },
    { key: 'echelon',  name: 'Echelon',  min_spend_cents: 300000, multiplier: 1.5,  perks: ['1.5x points', 'First call on emergency dispatch', 'One rush fee waived per quarter'] }
  ],

  // Rewards. Dollar-off rewards come off labor only; min_invoice_cents is the invoice before the discount.
  rewards: [
    { key: 'addon',    name: 'Free add-on check',      points: 300,  value_cents: 3000,  min_invoice_cents: 0,     active: true,
      description: 'Battery and charging test, fluid top-off, and tire check added to any paid visit.' },
    { key: 'labor15',  name: '$15 off labor',          points: 600,  value_cents: 1500,  min_invoice_cents: 10000, active: true,
      description: 'On invoices of $100 or more.' },
    { key: 'labor35',  name: '$35 off labor',          points: 1200, value_cents: 3500,  min_invoice_cents: 15000, active: true,
      description: 'On invoices of $150 or more.' },
    { key: 'rush',     name: 'Free priority dispatch', points: 2000, value_cents: 10000, min_invoice_cents: 0,     active: true,
      description: 'Waives the $100 rush/emergency fee once.' },
    { key: 'labor85',  name: '$85 off labor',          points: 3000, value_cents: 8500,  min_invoice_cents: 25000, active: true,
      description: 'On invoices of $250 or more.' }
  ]
};

// ── Helpers ─────────────────────────────────────────────────────────────────
const enc = encodeURIComponent;

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

async function sb(pathAndQuery, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && (data.message || data.hint || data.details)) || text || `Supabase ${r.status}`;
    throw httpErr(r.status >= 500 ? 502 : 400, msg);
  }
  return data;
}
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: 'POST', body: args });

let cfgCache = null, cfgAt = 0;
async function getConfig(force = false) {
  if (!force && cfgCache && Date.now() - cfgAt < 60000) return cfgCache;
  const rows = await sb('uea_loyalty_settings?id=eq.1&select=config,updated_at');
  cfgCache = Object.assign({}, DEFAULT_CONFIG, (rows && rows[0] && rows[0].config) || {});
  cfgCache._updated_at = rows && rows[0] ? rows[0].updated_at : null;
  cfgAt = Date.now();
  return cfgCache;
}

function tierFor(cfg, spendCents) {
  const tiers = [...(cfg.tiers || [])].sort((a, b) => a.min_spend_cents - b.min_spend_cents);
  let tier = tiers[0], next = null;
  for (const t of tiers) {
    if (spendCents >= t.min_spend_cents) tier = t;
    else { next = t; break; }
  }
  return { tier, next };
}

let lastExpireRun = 0;
async function maybeExpire() {
  if (Date.now() - lastExpireRun < 60 * 60 * 1000) return;
  lastExpireRun = Date.now();
  try {
    const cfg = await getConfig();
    if (Number(cfg.expire_months) > 0) await rpc('uea_loyalty_expire_inactive', { p_months: Number(cfg.expire_months) });
  } catch (e) { console.error('[loyalty] expire run failed:', e.message); }
}

// Appointment date (from the booking's line-item property) as UTC midnight, or null.
function apptDay(s) {
  if (!s) return null;
  const iso = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  let t = Date.parse(s);
  if (isNaN(t)) t = Date.parse(`${s} ${new Date().getFullYear()}`);
  if (isNaN(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}
function centralDay(ts) {
  const [y, m, d] = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function bookingBonuses(cfg, b) {
  const out = [];
  const day = apptDay(b.appt_date);
  if (day == null || b.source !== 'shopify') return out;
  const ahead = Math.round((day - centralDay(b.created_at)) / 86400000);
  if (cfg.book_ahead_bonus > 0 && cfg.book_ahead_days > 0 && ahead >= cfg.book_ahead_days) {
    out.push({ key: 'ahead', points: cfg.book_ahead_bonus, note: `Booked ${ahead} days ahead` });
  }
  const dow = new Date(day).getUTCDay();
  if (cfg.offpeak_bonus > 0 && (cfg.offpeak_days || []).includes(dow)) {
    out.push({ key: 'offpeak', points: cfg.offpeak_bonus, note: `${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow]} appointment bonus` });
  }
  return out;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(prefix, n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return prefix + s;
}

const cleanEmail = e => (e ? String(e).trim().toLowerCase() : null);
const money = c => `$${(c / 100).toFixed(2)}`;

// ── Members ─────────────────────────────────────────────────────────────────
async function findMember({ customerId, email }) {
  if (customerId) {
    const r = await sb(`uea_loyalty_members?shopify_customer_id=eq.${enc(customerId)}&select=*`);
    if (r[0]) return r[0];
  }
  if (email) {
    const r = await sb(`uea_loyalty_members?email=eq.${enc(email)}&select=*`);
    if (r[0]) return r[0];
  }
  return null;
}

async function upsertMember({ customerId, email, name, phone }) {
  customerId = customerId ? String(customerId) : null;
  email = cleanEmail(email);
  name = name ? String(name).trim().slice(0, 120) : null;
  phone = phone ? String(phone).trim().slice(0, 40) : null;

  let m = await findMember({ customerId, email });
  if (m) {
    const patch = {};
    if (customerId && !m.shopify_customer_id) patch.shopify_customer_id = customerId;
    if (email && !m.email) patch.email = email;
    if (name && !m.name) patch.name = name;
    if (phone && !m.phone) patch.phone = phone;
    if (Object.keys(patch).length) {
      const r = await sb(`uea_loyalty_members?id=eq.${m.id}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
      m = r[0] || m;
    }
    return m;
  }
  if (!customerId && !email) throw httpErr(400, 'No customer email on this order');

  for (let i = 0; i < 5; i++) {
    try {
      const r = await sb('uea_loyalty_members', {
        method: 'POST',
        body: { shopify_customer_id: customerId, email, name, phone, referral_code: makeCode('UEA-', 5) },
        prefer: 'return=representation'
      });
      return r[0];
    } catch (e) {
      if (!/duplicate|unique/i.test(e.message)) throw e;
      const again = await findMember({ customerId, email });
      if (again) return again;
    }
  }
  throw httpErr(500, 'Could not create member');
}

// ── Earning ─────────────────────────────────────────────────────────────────
async function awardPurchase({ member, amountCents, laborCents, partsCents, orderRef, orderId, label, by = 'system' }) {
  if (laborCents == null && partsCents == null) { laborCents = amountCents || 0; partsCents = 0; }
  laborCents = Math.max(0, laborCents || 0); partsCents = Math.max(0, partsCents || 0);
  amountCents = laborCents + partsCents;
  if (amountCents <= 0) return { skipped: true, points: 0 };
  if (member.is_fleet) return { skipped: true, fleet: true, points: 0, bonuses: [] };
  const cfg = await getConfig();

  const spendBefore = Number(await rpc('uea_loyalty_spend_12mo', { p_member: member.id }));
  const { tier } = tierFor(cfg, spendBefore);
  const mult = Number(tier.multiplier) || 1;
  const ppd = Number(cfg.points_per_dollar ?? 1);
  const pppd = Number(cfg.parts_points_per_dollar ?? ppd);
  const pts = Math.floor(((laborCents / 100) * ppd + (partsCents / 100) * pppd) * mult);

  const earn = await rpc('uea_loyalty_post', {
    p_member: member.id, p_type: 'earn', p_points: pts, p_amount_cents: amountCents,
    p_ref: `${orderRef}:earn`, p_order: orderId || null,
    p_note: `${label || 'Service'} (${money(amountCents)}, ${tier.name} ${mult}x)`, p_by: by
  });
  if (!earn.inserted) return { duplicate: true };

  const out = { points: pts, bonuses: [] };

  // Welcome bonus — first paid service only
  if (!member.first_paid_at) {
    await sb(`uea_loyalty_members?id=eq.${member.id}&first_paid_at=is.null`, {
      method: 'PATCH', body: { first_paid_at: new Date().toISOString() }
    });
    if (cfg.welcome_bonus > 0) {
      const w = await rpc('uea_loyalty_post', {
        p_member: member.id, p_type: 'welcome', p_points: cfg.welcome_bonus,
        p_ref: `welcome:${member.id}`, p_note: 'Welcome bonus: first completed service', p_by: by
      });
      if (w.inserted) out.bonuses.push('welcome');
    }
  }

  // Referral — both people get points once the friend's first qualifying service is paid
  if (member.referred_by && !member.referral_rewarded && amountCents >= (cfg.referral_min_cents || 0)) {
    const flipped = await sb(`uea_loyalty_members?id=eq.${member.id}&referral_rewarded=eq.false`, {
      method: 'PATCH', body: { referral_rewarded: true }, prefer: 'return=representation'
    });
    if (flipped && flipped[0]) {
      if (cfg.referral_bonus_friend > 0) {
        await rpc('uea_loyalty_post', {
          p_member: member.id, p_type: 'referral', p_points: cfg.referral_bonus_friend,
          p_ref: `referral-friend:${member.id}`, p_note: 'Referral bonus: welcome from a friend', p_by: by
        });
      }
      if (cfg.referral_bonus_referrer > 0) {
        await rpc('uea_loyalty_post', {
          p_member: member.referred_by, p_type: 'referral', p_points: cfg.referral_bonus_referrer,
          p_ref: `referral-referrer:${member.id}`,
          p_note: `Referral bonus: ${member.name || member.email || 'a friend'} completed a service`, p_by: by
        });
      }
      out.bonuses.push('referral');
    }
  }
  return out;
}

async function handleRefund(refund) {
  const orderId = String(refund.order_id || '');
  if (!orderId || !refund.id) return;
  const refundedCents = Math.round(
    (refund.transactions || [])
      .filter(t => t.kind === 'refund' && t.status === 'success')
      .reduce((s, t) => s + parseFloat(t.amount || 0), 0) * 100
  );
  if (refundedCents <= 0) return;

  const rows = await sb(`uea_loyalty_ledger?ref=eq.${enc(`order:${orderId}:earn`)}&select=*`);
  const earn = rows[0];
  if (!earn || earn.amount_cents <= 0) return;

  const cappedCents = Math.min(refundedCents, earn.amount_cents);
  const pts = Math.min(earn.points, Math.round(earn.points * cappedCents / earn.amount_cents));
  await rpc('uea_loyalty_post', {
    p_member: earn.member_id, p_type: 'refund', p_points: -pts, p_amount_cents: -cappedCents,
    p_ref: `refund:${refund.id}`, p_order: orderId, p_note: `Refund of ${money(cappedCents)}`
  });
}

// Finds reward voucher codes (UER-XXXXXX) attached to a booking order and marks them applied.
async function markVouchersFromOrder(order) {
  const blobs = [order.note || ''];
  (order.note_attributes || []).forEach(a => blobs.push(String(a.value || '')));
  (order.line_items || []).forEach(li => (li.properties || []).forEach(p => blobs.push(String(p.value || ''))));
  const codes = [...new Set((blobs.join(' ').match(/UER-[A-Z0-9]{6}/g) || []))];
  for (const code of codes) {
    await sb(`uea_loyalty_vouchers?code=eq.${enc(code)}&status=eq.active`, {
      method: 'PATCH',
      body: { status: 'applied', booking_order: order.name || String(order.id), applied_at: new Date().toISOString() }
    });
  }
}

// ── Bookings ────────────────────────────────────────────────────────────────
function pickProp(props, re) {
  const p = props.find(x => re.test(x.name) && String(x.value || '').trim());
  return p ? String(p.value).slice(0, 300) : null;
}

async function createBookingFromOrder(order) {
  const items = order.line_items || [];
  const isBooking = items.some(li => BOOKING_VARIANTS.includes(String(li.variant_id)) || /booking/i.test(li.title || ''));
  if (!isBooking) return;

  const props = [];
  items.forEach(li => (li.properties || []).forEach(p => {
    if (p && p.name && !String(p.name).startsWith('_') && !props.find(a => a.name === String(p.name))) {
      props.push({ name: String(p.name), value: String(p.value ?? '') });
    }
  }));
  const rush = items.some(li => RUSH_VARIANTS.includes(String(li.variant_id)) || /priority dispatch|rush/i.test(li.title || ''));
  const c = order.customer || {};
  const email = cleanEmail(order.email || c.email || order.contact_email || pickProp(props, /e-?mail/i));
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || pickProp(props, /name/i);
  const phone = c.phone || order.phone || pickProp(props, /phone/i);
  const vehicle = pickProp(props, /vehicle/i) ||
    [pickProp(props, /year/i), pickProp(props, /make/i), pickProp(props, /model/i)].filter(Boolean).join(' ') || null;
  const voucher = (JSON.stringify(props).match(/UER-[A-Z0-9]{6}/) || [])[0] || null;

  let member = null;
  if (c.id || email) {
    try { member = await upsertMember({ customerId: c.id, email, name, phone }); } catch (e) { /* booking still saves */ }
  }

  const day = apptDay(pickProp(props, /date/i));
  const created = await sb('uea_loyalty_bookings?on_conflict=shopify_order_id', {
    method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
    body: {
      source: 'shopify', shopify_order_id: String(order.id), order_name: order.name || null,
      member_id: member ? member.id : null, customer_name: name || null, email, phone: phone || null,
      service: pickProp(props, /service/i), vehicle,
      appt_date: pickProp(props, /date/i), appt_time: pickProp(props, /time/i),
      address: pickProp(props, /address|location/i),
      details: props, rush, voucher_code: voucher,
      sched_date: day != null ? new Date(day).toISOString().slice(0, 10) : null,
      sched_window: pickProp(props, /time|window/i),
      concern: pickProp(props, /concern|issue|problem|symptom|describe|description|notes?$/i)
    }
  });
  if (created && created[0]) await logEvent(created[0].id, 'Website', 'status', `Booked online${rush ? ' (rush)' : ''}`);
}

async function memberForBooking(b) {
  if (b.member_id) {
    const m = (await sb(`uea_loyalty_members?id=eq.${b.member_id}&select=*`))[0];
    if (m) return m;
  }
  if (!b.email) return null;
  const m = await upsertMember({ email: b.email, name: b.customer_name, phone: b.phone });
  await sb(`uea_loyalty_bookings?id=eq.${b.id}`, { method: 'PATCH', body: { member_id: m.id } });
  return m;
}

async function markBookingPaid(b, { laborCents, partsCents, method, ref, voucherCode, note, by }) {
  laborCents = Math.max(0, Math.round(laborCents || 0));
  partsCents = Math.max(0, Math.round(partsCents || 0));
  const total = laborCents + partsCents;
  if (total <= 0) throw httpErr(400, 'Enter what the customer paid for labor and/or parts.');
  if (!method) throw httpErr(400, 'Choose how the customer paid.');

  let voucher = null;
  voucherCode = voucherCode ? String(voucherCode).trim().toUpperCase() : '';
  if (voucherCode) {
    voucher = (await sb(`uea_loyalty_vouchers?code=eq.${enc(voucherCode)}&select=*`))[0];
    if (!voucher) throw httpErr(400, `Voucher ${voucherCode} was not found.`);
    if (!['active', 'applied'].includes(voucher.status)) throw httpErr(400, `Voucher ${voucherCode} is already ${voucher.status}.`);
    const cfgV = await getConfig();
    const rw = (cfgV.rewards || []).find(r => r.key === voucher.reward_key);
    const min = rw && rw.min_invoice_cents ? rw.min_invoice_cents : 0;
    if (min && total + voucher.value_cents < min) {
      throw httpErr(400, `${voucher.reward_name} needs an invoice of at least ${money(min)} before the discount. Clear the voucher field or adjust the amounts.`);
    }
  }

  const seq = (b.pay_seq || 0) + 1;
  const upd = await sb(`uea_loyalty_bookings?id=eq.${b.id}&status=eq.open`, {
    method: 'PATCH', prefer: 'return=representation',
    body: {
      status: 'paid', labor_cents: laborCents, parts_cents: partsCents, total_cents: total,
      payment_method: String(method).slice(0, 40), payment_ref: ref ? String(ref).slice(0, 80) : null,
      voucher_used: voucher ? voucher.code : null, paid_at: new Date().toISOString(), pay_seq: seq,
      admin_note: note ? String(note).slice(0, 300) : b.admin_note || null,
      stage: 'completed', updated_at: new Date().toISOString(),
      follow_up_date: estTotals(b.estimate, 0).declined.length
        ? new Date(Date.now() + (Number((await getConfig()).follow_up_days) || 30) * 86400000).toISOString().slice(0, 10)
        : b.follow_up_date || null
    }
  });
  if (!upd[0]) throw httpErr(400, 'This booking is already marked paid or was cancelled.');
  await logEvent(b.id, by || 'Admin', 'payment', `Marked paid ${money(total)} (labor ${money(laborCents)}, parts ${money(partsCents)}) by ${method}${ref ? `, #${ref}` : ''}`);

  let award = { points: 0, bonuses: [], no_member: false };
  const member = await memberForBooking(b);
  if (member) {
    const label = [b.order_name || 'Job', b.service].filter(Boolean).join(': ').slice(0, 80);
    const r = await awardPurchase({ member, laborCents, partsCents, orderRef: `booking:${b.id}:${seq}`, label, by: by || 'admin' });
    award = { points: r.points || 0, bonuses: r.bonuses || [], no_member: false, fleet: !!r.fleet };
    if (!r.fleet) {
      const cfg = await getConfig();
      for (const bb of bookingBonuses(cfg, b)) {
        const x = await rpc('uea_loyalty_post', {
          p_member: member.id, p_type: 'bonus', p_points: bb.points,
          p_ref: `booking:${b.id}:${seq}:${bb.key}`, p_note: bb.note, p_by: 'admin'
        });
        if (x.inserted) { award.points += bb.points; award.bonuses.push(bb.note.toLowerCase()); }
      }
    }
    await sb(`uea_loyalty_bookings?id=eq.${b.id}`, { method: 'PATCH', body: { points_awarded: award.points, member_id: member.id } });
  } else {
    award.no_member = true;
  }

  if (voucher) {
    await sb(`uea_loyalty_vouchers?id=eq.${voucher.id}&status=in.(active,applied)`, {
      method: 'PATCH',
      body: { status: 'used', used_at: new Date().toISOString(), used_order: b.order_name || ref || 'manual job', booking_order: voucher.booking_order || b.order_name || null }
    });
  }
  return award;
}

// ── Work orders: helpers ────────────────────────────────────────────────────
const STAGES = ['new', 'scheduled', 'en_route', 'on_site', 'waiting_approval', 'waiting_parts', 'in_progress', 'completed'];
const STAGE_LABEL = { new: 'New', scheduled: 'Scheduled', en_route: 'On the way', on_site: 'On site', waiting_approval: 'Waiting on approval',
  waiting_parts: 'Waiting on parts', in_progress: 'Working', completed: 'Done, not paid' };
const todayCentral = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const isoDate = v => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'there';
function fmtDate(d) {
  if (!d) return '';
  const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
async function logEvent(jobId, by, kind, text) {
  try { await sb('uea_job_events', { method: 'POST', body: { job_id: jobId, by_name: by || null, kind, text: String(text || '').slice(0, 1000) } }); }
  catch (e) { console.error('[loyalty] event log failed:', e.message); }
}
function patchJob(id, body) {
  return sb(`uea_loyalty_bookings?id=eq.${enc(id)}`, {
    method: 'PATCH', prefer: 'return=representation', body: Object.assign({ updated_at: new Date().toISOString() }, body)
  });
}
async function loadJob(req, id) {
  const j = (await sb(`uea_loyalty_bookings?id=eq.${enc(id)}&select=*`))[0];
  if (!j || (req.staff.role === 'tech' && j.tech_id !== req.staff.id)) throw httpErr(404, 'Job not found.');
  return j;
}
async function listTechs() {
  return sb('uea_staff?active=eq.true&select=id,name,role&order=name.asc');
}

const lineAmount = l => Math.round((Number(l.qty) || 0) * (Number(l.unit_cents) || 0));
function estTotals(est, taxRate) {
  const lines = (est && est.lines) || [];
  const calc = keep => {
    const t = { labor: 0, parts: 0, fees: 0, discount: 0 };
    lines.forEach(l => {
      if (!keep(l)) return;
      const a = lineAmount(l);
      if (l.type === 'labor') t.labor += a; else if (l.type === 'part') t.parts += a;
      else if (l.type === 'fee') t.fees += a; else if (l.type === 'discount') t.discount += a;
    });
    t.tax = Math.round(t.parts * (Number(taxRate) || 0) / 100);
    t.subtotal = Math.max(0, t.labor + t.parts + t.fees - t.discount);
    t.total = t.subtotal + t.tax;
    t.pay_labor = Math.max(0, t.labor + t.fees - t.discount);   // what "Mark paid" pre-fills (before tax)
    t.pay_parts = t.parts;
    return t;
  };
  return {
    quoted: calc(l => l.status !== 'declined'),
    approved: calc(l => l.type === 'discount' || l.status === 'approved'),
    pending: lines.filter(l => l.type !== 'discount' && (l.status || 'pending') === 'pending').length,
    declined: lines.filter(l => l.status === 'declined')
  };
}

function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : '')).replace(/\s{2,}/g, ' ').trim();
}
async function smsVars(job, cfg, extra) {
  let tech = 'Your technician';
  if (job.tech_id) { const t = await getStaff(job.tech_id).catch(() => null); if (t) tech = firstName(t.name); }
  const tot = estTotals(job.estimate, cfg.parts_tax_rate);
  return Object.assign({
    first: firstName(job.customer_name), name: job.customer_name || '', service: job.service || 'service',
    vehicle: job.vehicle || 'vehicle', date: fmtDate(job.sched_date) || job.appt_date || '', window: job.sched_window || job.appt_time || '',
    tech, eta: '', estimate_link: job.estimate_token ? `${PUBLIC_BASE}/loyalty/e/${job.estimate_token}` : '',
    total: money(tot.approved.total || tot.quoted.total || job.total_cents || 0), pay_link: cfg.payment_link || '',
    shop_phone: cfg.shop_phone || '', review_link: cfg.google_review_url || '',
    recommended: tot.declined.map(l => l.desc).filter(Boolean).join(', ')
  }, extra || {});
}
async function sendSms(phone, message) {
  const key = process.env.TEXTBELT_KEY;
  if (!key) throw httpErr(400, 'Texting isn\'t set up. Add TEXTBELT_KEY on Render.');
  const digits = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length !== 10) throw httpErr(400, 'This job doesn\'t have a valid 10-digit phone number.');
  if (!message || message.length < 2) throw httpErr(400, 'The message is empty.');
  const r = await fetch('https://textbelt.com/text', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: digits, message: message.slice(0, 640), key })
  });
  const d = await r.json().catch(() => ({}));
  if (!d.success) throw httpErr(400, `Text not sent: ${d.error || 'texting service error'}`);
  return d;
}

// ── CORS ────────────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const h = fn => (req, res) => fn(req, res).catch(e => {
  if (!e.status || e.status >= 500) console.error('[loyalty]', req.method, req.path, e.message);
  res.status(e.status || 500).json({ error: e.status && e.status < 500 ? e.message : 'Server error. Try again in a moment.' });
});

// ── Shopify webhooks (raw body for signature check) ─────────────────────────
router.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body)) {
    console.error('[loyalty] Webhook body was already parsed. Move app.use(\'/loyalty\', ...) ABOVE app.use(express.json()) in server.js.');
    return res.sendStatus(500);
  }
  const sent = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.body).digest('base64');
  if (!WEBHOOK_SECRET || !safeEq(digest, sent)) return res.sendStatus(401);

  const topic = req.get('X-Shopify-Topic') || '';
  let data;
  try { data = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(200); }

  try {
    if (topic === 'orders/create') {
      await markVouchersFromOrder(data);
      await createBookingFromOrder(data);
    } else if (topic === 'orders/paid') {
      await markVouchersFromOrder(data);
      const amountCents = Math.round(parseFloat(data.current_subtotal_price ?? data.subtotal_price ?? '0') * 100);
      const c = data.customer || {};
      const email = cleanEmail(data.email || c.email || data.contact_email);
      if (amountCents > 0 && (c.id || email)) {
        const member = await upsertMember({
          customerId: c.id, email,
          name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
          phone: c.phone || data.phone || null
        });
        await awardPurchase({
          member, amountCents, orderRef: `order:${data.id}`, orderId: String(data.id),
          label: `Order ${data.name || data.id}`
        });
      }
    } else if (topic === 'refunds/create') {
      await handleRefund(data);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('[loyalty webhook]', topic, e.message);
    res.sendStatus(500); // Shopify retries; every award is idempotent
  }
});

router.use(express.json({ limit: '300kb' }));

// ── Customer auth (signed by Shopify Liquid with LOYALTY_SECRET) ─────────────
function verifyCustomer(a) {
  if (!a || !a.cid || !a.ts || !a.sig) throw httpErr(401, 'Sign in to see your rewards.');
  const email = cleanEmail(a.email) || '';
  const payload = `${a.cid}|${email}|${a.ts}`;
  const expected = crypto.createHmac('sha256', LOYALTY_SECRET).update(payload).digest('hex');
  if (!LOYALTY_SECRET || !safeEq(expected, String(a.sig).toLowerCase())) throw httpErr(401, 'Session could not be verified. Refresh the page.');
  const age = Math.abs(Date.now() / 1000 - Number(a.ts));
  if (!isFinite(age) || age > 60 * 60 * 24) throw httpErr(401, 'Session expired. Refresh the page.');
  return { customerId: String(a.cid), email, name: a.name || null, phone: a.phone || null };
}

async function customerProfile(member) {
  const cfg = await getConfig();
  const [spend, ledger, vouchers, claims] = await Promise.all([
    rpc('uea_loyalty_spend_12mo', { p_member: member.id }),
    sb(`uea_loyalty_ledger?member_id=eq.${member.id}&select=type,points,note,created_at&order=created_at.desc&limit=30`),
    sb(`uea_loyalty_vouchers?member_id=eq.${member.id}&status=in.(active,applied)&select=id,code,reward_name,value_cents,status,booking_order,created_at&order=created_at.desc`),
    sb(`uea_loyalty_review_claims?member_id=eq.${member.id}&select=status&order=created_at.desc&limit=1`)
  ]);
  const fresh = (await sb(`uea_loyalty_members?id=eq.${member.id}&select=*`))[0] || member;
  const spendCents = Number(spend);
  const { tier, next } = tierFor(cfg, spendCents);
  return {
    member: {
      name: fresh.name, email: fresh.email, balance: fresh.points_balance,
      is_fleet: !!fresh.is_fleet, last_activity_at: fresh.last_activity_at,
      referral_code: fresh.referral_code, referred: !!fresh.referred_by, first_paid: !!fresh.first_paid_at
    },
    spend_12mo_cents: spendCents,
    tier, next_tier: next,
    history: ledger, vouchers,
    review_status: claims[0] ? claims[0].status : null,
    program: publicProgram(cfg)
  };
}

// Public: program details for signed-out visitors
function publicProgram(cfg) {
  const keys = ['points_per_dollar', 'parts_points_per_dollar', 'welcome_bonus', 'referral_bonus_referrer',
    'referral_bonus_friend', 'referral_min_cents', 'review_bonus', 'google_review_url', 'book_ahead_days',
    'book_ahead_bonus', 'offpeak_days', 'offpeak_bonus', 'expire_months', 'tiers', 'terms_extra'];
  const out = {};
  keys.forEach(k => { out[k] = cfg[k]; });
  out.rewards = (cfg.rewards || []).filter(r => r.active);
  out.updated_at = cfg._updated_at || null;
  return out;
}

router.get('/program', h(async (req, res) => {
  res.json(publicProgram(await getConfig()));
}));

router.post('/me', h(async (req, res) => {
  const who = verifyCustomer(req.body.auth);
  await maybeExpire();
  const member = await upsertMember(who);
  res.json(await customerProfile(member));
}));

router.post('/redeem', h(async (req, res) => {
  const who = verifyCustomer(req.body.auth);
  const cfg = await getConfig(true);
  const reward = (cfg.rewards || []).find(r => r.key === req.body.reward_key && r.active);
  if (!reward) throw httpErr(400, 'That reward is no longer available.');
  const member = await upsertMember(who);
  let result;
  for (let i = 0; i < 3; i++) {
    try {
      result = await rpc('uea_loyalty_redeem', {
        p_member: member.id, p_key: reward.key, p_name: reward.name,
        p_cost: reward.points, p_value: reward.value_cents, p_code: makeCode('UER-', 6)
      });
      break;
    } catch (e) { if (!/duplicate|unique/i.test(e.message)) throw e; }
  }
  const profile = await customerProfile(member);
  res.json(Object.assign(profile, { redeemed: result }));
}));

router.post('/referral', h(async (req, res) => {
  const who = verifyCustomer(req.body.auth);
  const member = await upsertMember(who);
  if (member.referred_by) throw httpErr(400, 'A referral code is already on your account.');
  if (member.first_paid_at) throw httpErr(400, 'Referral codes can only be added before your first service.');
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!/^UEA-[A-Z0-9]{5}$/.test(code)) throw httpErr(400, 'Enter a code like UEA-AB12C.');
  const ref = (await sb(`uea_loyalty_members?referral_code=eq.${enc(code)}&select=id`))[0];
  if (!ref) throw httpErr(400, 'That referral code was not found.');
  if (ref.id === member.id) throw httpErr(400, "You can't use your own code.");
  await sb(`uea_loyalty_members?id=eq.${member.id}&referred_by=is.null`, { method: 'PATCH', body: { referred_by: ref.id } });
  res.json(await customerProfile(member));
}));

router.post('/review-claim', h(async (req, res) => {
  const who = verifyCustomer(req.body.auth);
  const member = await upsertMember(who);
  try {
    await sb('uea_loyalty_review_claims', { method: 'POST', body: { member_id: member.id } });
  } catch (e) {
    if (/duplicate|unique/i.test(e.message)) throw httpErr(400, 'Your review bonus has already been claimed.');
    throw e;
  }
  res.json(await customerProfile(member));
}));

// ── Staff auth (owner / service writer / technician) ───────────────────────
const OWNER = ['owner'], DESK = ['owner', 'writer'], ALL = ['owner', 'writer', 'tech'];
const adminKey = () => crypto.createHash('sha256').update(`${LOYALTY_SECRET}|${ADMIN_PASSWORD}`).digest();
const signTok = payload => crypto.createHmac('sha256', adminKey()).update(payload).digest('hex');
const attempts = new Map();
const staffCache = new Map();

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(pw), salt, 64).toString('hex')}`;
}
function checkPw(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  return safeEq(crypto.scryptSync(String(pw), salt, 64).toString('hex'), hash);
}
async function getStaff(id, fresh) {
  const c = staffCache.get(id);
  if (!fresh && c && Date.now() - c.at < 60000) return c.row;
  const row = (await sb(`uea_staff?id=eq.${enc(id)}&select=id,email,name,phone,role,token_ver,active`))[0] || null;
  staffCache.set(id, { row, at: Date.now() });
  return row;
}
function issueToken(staff) {
  const payload = Buffer.from(JSON.stringify({
    sid: staff.sid || staff.id, role: staff.role, ver: staff.token_ver || 0, exp: Date.now() + 12 * 3600 * 1000
  })).toString('base64url');
  return `${payload}.${signTok(payload)}`;
}
function auth(roles) {
  return async (req, res, next) => {
    let d;
    try {
      const tok = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const [p, sig] = tok.split('.');
      if (!p || !sig || !ADMIN_PASSWORD || !safeEq(sig, signTok(p))) throw 0;
      d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      if (!d.exp || d.exp < Date.now()) throw 0;
    } catch (e) { return res.status(401).json({ error: 'Session expired. Sign in again.' }); }
    let staff;
    if (d.sid === 'owner') {
      staff = { id: null, sid: 'owner', name: 'Owner', email: OWNER_EMAIL, role: 'owner' };
    } else {
      try { staff = await getStaff(d.sid); } catch (e) { return res.status(502).json({ error: 'Database unavailable. Try again.' }); }
      if (!staff || !staff.active || staff.token_ver !== d.ver) return res.status(401).json({ error: 'Session expired. Sign in again.' });
      staff = Object.assign({ sid: staff.id }, staff);
    }
    if (!roles.includes(staff.role)) return res.status(403).json({ error: 'Your account doesn\'t have access to this.' });
    req.staff = staff;
    next();
  };
}
const requireAdmin = auth(OWNER); // legacy name: owner-only

router.post('/admin/login', h(async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) throw httpErr(429, 'Too many attempts. Wait 15 minutes.');
  if (!ADMIN_PASSWORD) throw httpErr(500, 'Admin password not set on server.');
  const email = cleanEmail(req.body.email) || '';
  const pw = String(req.body.password || '');
  let staff = null;

  if (email === OWNER_EMAIL || !email) {
    const A = crypto.createHash('sha256').update(pw).digest(), B = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
    if (crypto.timingSafeEqual(A, B)) staff = { sid: 'owner', name: 'Owner', email: OWNER_EMAIL, role: 'owner', token_ver: 0 };
  }
  if (!staff && email) {
    const row = (await sb(`uea_staff?email=eq.${enc(email)}&select=*`))[0];
    if (row && row.active && checkPw(pw, row.pw_hash)) {
      staff = row;
      sb(`uea_staff?id=eq.${row.id}`, { method: 'PATCH', body: { last_login_at: new Date().toISOString() } }).catch(() => {});
    }
  }
  if (!staff) { a.n++; attempts.set(ip, a); throw httpErr(401, 'Wrong email or password.'); }
  attempts.delete(ip);
  res.json({ token: issueToken(staff), staff: { name: staff.name, email: staff.email, role: staff.role, id: staff.id || null } });
}));

router.get('/admin/me', auth(ALL), (req, res) => {
  const s = req.staff;
  res.json({ staff: { id: s.id, name: s.name, email: s.email, role: s.role } });
});

router.post('/admin/password', auth(ALL), h(async (req, res) => {
  if (!req.staff.id) throw httpErr(400, 'The owner password is set on Render (LOYALTY_ADMIN_PASSWORD).');
  const row = (await sb(`uea_staff?id=eq.${req.staff.id}&select=*`))[0];
  if (!row || !checkPw(req.body.current, row.pw_hash)) throw httpErr(400, 'Current password is wrong.');
  if (String(req.body.next || '').length < 10) throw httpErr(400, 'Use at least 10 characters.');
  await sb(`uea_staff?id=eq.${row.id}`, { method: 'PATCH', body: { pw_hash: hashPw(req.body.next), token_ver: row.token_ver + 1 } });
  staffCache.delete(row.id);
  res.json({ ok: true });
}));

// Admin portal page
router.get('/admin', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.sendFile(path.join(__dirname, 'loyalty-admin.html'));
});

// ── Admin API ───────────────────────────────────────────────────────────────
router.get('/admin/stats', auth(OWNER), h(async (req, res) => {
  await maybeExpire();
  const [stats, cfg] = await Promise.all([rpc('uea_loyalty_stats', {}), getConfig()]);
  stats.liability_cents = Math.round(Number(stats.outstanding_points) * Number(cfg.cents_per_point || 0));
  const recent = await sb('uea_loyalty_ledger?select=type,points,note,created_at,member:uea_loyalty_members(id,name,email)&order=created_at.desc&limit=15');
  res.json({ stats, recent });
}));

router.get('/admin/members', auth(DESK), h(async (req, res) => {
  const q = String(req.query.q || '').replace(/[^a-zA-Z0-9@._+\- ]/g, '').trim();
  const sort = req.query.sort === 'points' ? 'points_balance.desc' : 'last_activity_at.desc';
  let url = `uea_loyalty_members?select=*&order=${sort}&limit=60`;
  if (q) {
    const p = `*${q}*`;
    url += `&or=(${['email', 'name', 'phone', 'referral_code'].map(f => `${f}.ilike.${enc(p)}`).join(',')})`;
  }
  res.json({ members: await sb(url) });
}));

router.get('/admin/member/:id', auth(DESK), h(async (req, res) => {
  const id = req.params.id;
  const m = (await sb(`uea_loyalty_members?id=eq.${enc(id)}&select=*`))[0];
  if (!m) throw httpErr(404, 'Member not found.');
  const cfg = await getConfig();
  const [spend, ledger, vouchers, referrals, referrer] = await Promise.all([
    rpc('uea_loyalty_spend_12mo', { p_member: m.id }),
    sb(`uea_loyalty_ledger?member_id=eq.${m.id}&select=*&order=created_at.desc&limit=200`),
    sb(`uea_loyalty_vouchers?member_id=eq.${m.id}&select=*&order=created_at.desc`),
    sb(`uea_loyalty_members?referred_by=eq.${m.id}&select=id,name,email,referral_rewarded`),
    m.referred_by ? sb(`uea_loyalty_members?id=eq.${m.referred_by}&select=id,name,email`) : Promise.resolve([])
  ]);
  const { tier, next } = tierFor(cfg, Number(spend));
  const jobs = await sb(`uea_loyalty_bookings?member_id=eq.${m.id}&select=id,order_name,service,vehicle,vin,mileage,status,stage,total_cents,paid_at,created_at,sched_date&order=created_at.desc&limit=50`);
  res.json({ member: m, spend_12mo_cents: Number(spend), tier, next_tier: next, ledger, vouchers, referrals, referrer: referrer[0] || null, jobs });
}));

router.post('/admin/adjust', auth(OWNER), h(async (req, res) => {
  const pts = parseInt(req.body.points, 10);
  const note = String(req.body.note || '').trim();
  if (!pts) throw httpErr(400, 'Enter a point amount, like 100 to add or -100 to remove.');
  if (Math.abs(pts) > 100000) throw httpErr(400, 'That amount looks too large. Check the number.');
  if (!note) throw httpErr(400, 'Add a reason. The customer sees it in their points history.');
  let member;
  if (req.body.member_id) {
    member = (await sb(`uea_loyalty_members?id=eq.${enc(req.body.member_id)}&select=*`))[0];
    if (!member) throw httpErr(404, 'Member not found.');
  } else {
    const email = cleanEmail(req.body.email);
    if (!email || !/.+@.+\..+/.test(email)) throw httpErr(400, 'Pick a member or enter the customer\'s email.');
    member = await upsertMember({ email, name: req.body.name, phone: req.body.phone });
  }
  if (pts < 0 && member.points_balance + pts < 0) {
    throw httpErr(400, `${member.name || member.email} only has ${member.points_balance} points. You can remove up to that amount.`);
  }
  const r = await rpc('uea_loyalty_post', {
    p_member: member.id, p_type: 'adjust', p_points: pts, p_note: note.slice(0, 200), p_by: req.staff.name || 'admin'
  });
  res.json(Object.assign(r, { member_id: member.id, name: member.name, email: member.email }));
}));

// Record a job that never came through the website (phone, walk-up, repeat customer).
// Creates a booking and marks it paid in one step.
router.post('/admin/award', auth(DESK), h(async (req, res) => {
  const b = req.body;
  let member = null;
  if (b.member_id) {
    member = (await sb(`uea_loyalty_members?id=eq.${enc(b.member_id)}&select=*`))[0];
    if (!member) throw httpErr(404, 'Member not found.');
  } else {
    const email = cleanEmail(b.email);
    if (!email || !/.+@.+\..+/.test(email)) throw httpErr(400, 'Enter the customer\'s email so points have somewhere to go.');
    member = await upsertMember({ email, name: b.name, phone: b.phone });
  }
  const ref = String(b.reference || '').trim().slice(0, 80);
  if (ref) {
    const dup = await sb(`uea_loyalty_bookings?source=eq.manual&payment_ref=eq.${enc(ref)}&status=eq.paid&select=id`);
    if (dup[0]) throw httpErr(400, `A paid job with reference "${ref}" is already recorded.`);
  }
  const created = await sb('uea_loyalty_bookings', {
    method: 'POST', prefer: 'return=representation',
    body: {
      source: 'manual', member_id: member.id, customer_name: member.name || b.name || null,
      email: member.email, phone: member.phone || b.phone || null,
      service: b.service ? String(b.service).slice(0, 200) : null
    }
  });
  const award = await markBookingPaid(created[0], {
    laborCents: Math.round(parseFloat(b.labor || 0) * 100),
    partsCents: Math.round(parseFloat(b.parts || 0) * 100),
    method: b.method, ref, voucherCode: b.voucher_code, note: b.note, by: req.staff.name
  }).catch(async e => {
    await sb(`uea_loyalty_bookings?id=eq.${created[0].id}&status=eq.open`, { method: 'DELETE' });
    throw e;
  });
  res.json(Object.assign(award, { member_id: member.id, booking_id: created[0].id }));
}));

router.get('/admin/bookings', auth(DESK), h(async (req, res) => {
  const st = ['open', 'paid', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const q = String(req.query.q || '').replace(/[^a-zA-Z0-9@._+#\- ]/g, '').trim();
  let url = `uea_loyalty_bookings?select=*,member:uea_loyalty_members(id,name,points_balance)&order=created_at.desc&limit=100`;
  if (st) url += `&status=eq.${st}`;
  if (q) {
    const p = enc(`*${q}*`);
    url += `&or=(${['customer_name', 'email', 'phone', 'order_name', 'service', 'payment_ref'].map(f => `${f}.ilike.${p}`).join(',')})`;
  }
  res.json({ bookings: await sb(url) });
}));

router.get('/admin/booking/:id', auth(ALL), h(async (req, res) => {
  const b = await loadJob(req, req.params.id);
  const cfg = await getConfig();
  let member = null, tier = null, voucher = null;
  if (b.member_id) {
    member = (await sb(`uea_loyalty_members?id=eq.${b.member_id}&select=id,name,email,points_balance,first_paid_at,is_fleet`))[0] || null;
    if (member) tier = tierFor(cfg, Number(await rpc('uea_loyalty_spend_12mo', { p_member: member.id }))).tier;
  }
  const code = b.voucher_used || b.voucher_code;
  if (code) voucher = (await sb(`uea_loyalty_vouchers?code=eq.${enc(code)}&select=*`))[0] || null;
  const desk = req.staff.role !== 'tech';
  const [events, techs, history] = await Promise.all([
    sb(`uea_job_events?job_id=eq.${b.id}&select=*&order=at.desc&limit=150`),
    desk ? listTechs() : Promise.resolve([]),
    b.member_id || b.email || b.phone
      ? sb(`uea_loyalty_bookings?id=neq.${b.id}&select=id,order_name,service,vehicle,status,total_cents,paid_at,created_at,mileage&order=created_at.desc&limit=10&or=(${
          [b.member_id ? `member_id.eq.${b.member_id}` : null, b.email ? `email.eq.${enc(b.email)}` : null,
           b.phone ? `phone.eq.${enc(b.phone)}` : null].filter(Boolean).join(',')})`)
      : Promise.resolve([])
  ]);
  res.json({
    booking: b, member, tier, voucher, events, techs, history,
    totals: estTotals(b.estimate, cfg.parts_tax_rate),
    estimate_link: b.estimate_token ? `${PUBLIC_BASE}/loyalty/e/${b.estimate_token}` : null,
    payment_methods: cfg.payment_methods || DEFAULT_CONFIG.payment_methods,
    rates: { labor: cfg.points_per_dollar, parts: cfg.parts_points_per_dollar ?? cfg.points_per_dollar },
    shop: {
      labor_rate_cents: cfg.labor_rate_cents, parts_markup_pct: cfg.parts_markup_pct, parts_tax_rate: cfg.parts_tax_rate,
      time_windows: cfg.time_windows, sms_templates: cfg.sms_templates, payment_link: cfg.payment_link,
      shop_phone: cfg.shop_phone, google_review_url: cfg.google_review_url, tech_can_estimate: cfg.tech_can_estimate
    },
    sms_vars: await smsVars(b, cfg),
    sms_ready: !!process.env.TEXTBELT_KEY,
    stages: STAGES.map(k => ({ key: k, label: STAGE_LABEL[k] }))
  });
}));

router.post('/admin/booking/:id/paid', auth(DESK), h(async (req, res) => {
  const b = (await sb(`uea_loyalty_bookings?id=eq.${enc(req.params.id)}&select=*`))[0];
  if (!b) throw httpErr(404, 'Booking not found.');
  const award = await markBookingPaid(b, {
    laborCents: Math.round(parseFloat(req.body.labor || 0) * 100),
    partsCents: Math.round(parseFloat(req.body.parts || 0) * 100),
    method: req.body.method, ref: req.body.reference, voucherCode: req.body.voucher_code, note: req.body.note, by: req.staff.name
  });
  res.json(award);
}));

// Undo a payment entered by mistake: takes the points back and reopens the booking.
router.post('/admin/booking/:id/reopen', auth(OWNER), h(async (req, res) => {
  const b = (await sb(`uea_loyalty_bookings?id=eq.${enc(req.params.id)}&status=eq.paid&select=*`))[0];
  if (!b) throw httpErr(400, 'Only paid bookings can be reopened.');
  if (b.member_id && b.points_awarded) {
    await rpc('uea_loyalty_post', {
      p_member: b.member_id, p_type: 'refund', p_points: -b.points_awarded, p_amount_cents: -(b.total_cents || 0),
      p_ref: `booking:${b.id}:${b.pay_seq}:reverse`, p_note: `Payment reversed: ${b.order_name || 'job'}`, p_by: 'admin'
    });
  }
  if (b.voucher_used) {
    await sb(`uea_loyalty_vouchers?code=eq.${enc(b.voucher_used)}&status=eq.used`, {
      method: 'PATCH', body: { status: 'applied', used_at: null, used_order: null }
    });
  }
  await patchJob(b.id, { status: 'open', stage: 'completed', labor_cents: null, parts_cents: null, total_cents: null, payment_method: null,
            payment_ref: null, voucher_used: null, points_awarded: null, paid_at: null });
  await logEvent(b.id, req.staff.name, 'payment', `Payment undone${b.points_awarded ? `; ${b.points_awarded} points taken back` : ''}`);
  res.json({ ok: true });
}));

router.post('/admin/booking/:id/cancel', auth(DESK), h(async (req, res) => {
  const r = await sb(`uea_loyalty_bookings?id=eq.${enc(req.params.id)}&status=eq.open`, {
    method: 'PATCH', prefer: 'return=representation', body: { status: 'cancelled' }
  });
  if (!r[0]) throw httpErr(400, 'Only open bookings can be cancelled. Reopen a paid booking first.');
  await logEvent(r[0].id, req.staff.name, 'status', `Cancelled${req.body && req.body.reason ? `: ${String(req.body.reason).slice(0, 200)}` : ''}`);
  if (r[0].voucher_code) {
    await sb(`uea_loyalty_vouchers?code=eq.${enc(r[0].voucher_code)}&status=eq.applied`, {
      method: 'PATCH', body: { status: 'active', booking_order: null, applied_at: null }
    });
  }
  res.json({ ok: true });
}));

router.post('/admin/booking/:id/restore', auth(DESK), h(async (req, res) => {
  const r = await sb(`uea_loyalty_bookings?id=eq.${enc(req.params.id)}&status=eq.cancelled`, {
    method: 'PATCH', prefer: 'return=representation', body: { status: 'open' }
  });
  if (!r[0]) throw httpErr(400, 'Only cancelled bookings can be restored.');
  await logEvent(r[0].id, req.staff.name, 'status', 'Restored');
  res.json({ ok: true });
}));

// ── Jobs (work orders) ──────────────────────────────────────────────────────
router.get('/admin/jobs', auth(ALL), h(async (req, res) => {
  const view = ['today', 'open', 'history'].includes(req.query.view) ? req.query.view : 'open';
  const today = todayCentral();
  let url = 'uea_loyalty_bookings?select=*,tech:uea_staff(id,name),member:uea_loyalty_members(id,points_balance,is_fleet)';
  if (view === 'today') url += `&status=eq.open&sched_date=lte.${today}&order=sched_date.asc,sched_window.asc`;
  else if (view === 'history') url += '&status=in.(paid,cancelled)&order=paid_at.desc.nullslast,created_at.desc';
  else url += '&status=eq.open&order=sched_date.asc.nullsfirst,created_at.desc';
  if (req.staff.role === 'tech') url += `&tech_id=eq.${req.staff.id}`;
  else if (req.query.tech) url += req.query.tech === 'none' ? '&tech_id=is.null' : `&tech_id=eq.${enc(req.query.tech)}`;
  const q = String(req.query.q || '').replace(/[^a-zA-Z0-9@._+#\- ]/g, '').trim();
  if (q) {
    const p = enc(`*${q}*`);
    url += `&or=(${['customer_name', 'email', 'phone', 'order_name', 'service', 'vehicle', 'vin', 'address'].map(f => `${f}.ilike.${p}`).join(',')})`;
  }
  url += `&limit=${view === 'history' ? 100 : 300}`;
  res.json({ jobs: await sb(url), today, stages: STAGES.map(k => ({ key: k, label: STAGE_LABEL[k] })) });
}));

router.post('/admin/jobs', auth(DESK), h(async (req, res) => {
  const b = req.body || {};
  const t = (v, n = 300) => (v == null ? null : String(v).trim().slice(0, n) || null);
  const email = cleanEmail(b.email);
  const name = t(b.customer_name, 120), phone = t(b.phone, 40);
  if (!name && !phone && !email && !b.member_id) throw httpErr(400, 'Enter the customer\'s name and phone number.');
  let member = null;
  if (b.member_id) member = (await sb(`uea_loyalty_members?id=eq.${enc(b.member_id)}&select=*`))[0] || null;
  else if (email) member = await upsertMember({ email, name, phone });
  const sched = isoDate(b.sched_date);
  let techId = b.tech_id || null;
  if (techId) { const tt = await getStaff(techId, true); if (!tt || !tt.active) techId = null; }
  const created = await sb('uea_loyalty_bookings', {
    method: 'POST', prefer: 'return=representation',
    body: {
      source: 'manual', member_id: member ? member.id : null,
      customer_name: name || (member && member.name) || null, phone: phone || (member && member.phone) || null,
      email: email || (member && member.email) || null, address: t(b.address), service: t(b.service, 200),
      vehicle: t(b.vehicle, 120), vin: t(b.vin, 17), plate: t(b.plate, 12),
      mileage: b.mileage ? parseInt(String(b.mileage).replace(/\D/g, ''), 10) || null : null,
      concern: t(b.concern, 2000), sched_date: sched, sched_window: t(b.sched_window, 40), tech_id: techId,
      rush: !!b.rush, stage: sched ? 'scheduled' : 'new'
    }
  });
  const job = created[0];
  await logEvent(job.id, req.staff.name, 'status', `Job created${b.source_note ? ` (${t(b.source_note, 60)})` : ''}`);
  let award = null;
  if (b.paid) {
    try {
      award = await markBookingPaid(job, {
        laborCents: Math.round(parseFloat(b.paid.labor || 0) * 100), partsCents: Math.round(parseFloat(b.paid.parts || 0) * 100),
        method: b.paid.method, ref: t(b.paid.reference, 80), voucherCode: b.paid.voucher_code, by: req.staff.name
      });
    } catch (e) {
      throw httpErr(400, `The job was created, but the payment wasn't recorded: ${e.message} Open the job to mark it paid.`);
    }
  }
  res.json({ booking_id: job.id, award });
}));

router.patch('/admin/booking/:id', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const b = req.body || {};
  const tech = req.staff.role === 'tech';
  const allowed = tech ? ['stage', 'findings', 'mileage', 'vin', 'plate']
    : ['stage', 'findings', 'mileage', 'vin', 'plate', 'customer_name', 'phone', 'email', 'address', 'service', 'vehicle',
       'concern', 'sched_date', 'sched_window', 'tech_id', 'rush', 'admin_note', 'follow_up_date'];
  const long = ['findings', 'concern', 'admin_note'];
  const patch = {};
  for (const k of allowed) {
    if (!(k in b)) continue;
    let v = b[k];
    if (typeof v === 'string') v = v.trim().slice(0, long.includes(k) ? 2000 : 300) || null;
    if (k === 'stage') {
      if (!STAGES.includes(v)) throw httpErr(400, 'Unknown stage.');
      if (j.status !== 'open' && v !== j.stage) throw httpErr(400, 'This job is closed. Undo the payment or restore it first.');
    }
    if (k === 'mileage') v = v == null ? null : parseInt(String(v).replace(/\D/g, ''), 10) || null;
    if (k === 'vin' && v) { v = v.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, ''); if (v.length !== 17) throw httpErr(400, 'A VIN is 17 characters (no I, O, or Q).'); }
    if (k === 'sched_date' || k === 'follow_up_date') { if (v && !isoDate(v)) throw httpErr(400, 'Use a valid date.'); v = v || null; }
    if (k === 'tech_id' && v) { const t = await getStaff(v, true); if (!t || !t.active) throw httpErr(400, 'That team member isn\'t active.'); }
    if (k === 'rush') v = !!v;
    if (k === 'email') v = cleanEmail(v);
    if (String(j[k] ?? '') !== String(v ?? '')) patch[k] = v;
  }
  if (patch.sched_date && j.stage === 'new' && !patch.stage) patch.stage = 'scheduled';
  if (!Object.keys(patch).length) return res.json({ booking: j });

  const updated = (await patchJob(j.id, patch))[0];
  const by = req.staff.name;
  if (patch.stage) await logEvent(j.id, by, 'status', `${STAGE_LABEL[j.stage] || j.stage} → ${STAGE_LABEL[patch.stage]}`);
  if ('tech_id' in patch) {
    const t = patch.tech_id ? await getStaff(patch.tech_id) : null;
    await logEvent(j.id, by, 'status', t ? `Assigned to ${t.name}` : 'Unassigned');
  }
  if ('sched_date' in patch || 'sched_window' in patch) {
    await logEvent(j.id, by, 'status', updated.sched_date ? `Scheduled for ${fmtDate(updated.sched_date)}${updated.sched_window ? `, ${updated.sched_window}` : ''}` : 'Schedule cleared');
  }
  if ('findings' in patch) await logEvent(j.id, by, 'note', `Findings: ${patch.findings || '(cleared)'}`);
  const other = Object.keys(patch).filter(k => !['stage', 'tech_id', 'sched_date', 'sched_window', 'findings'].includes(k));
  if (other.length) await logEvent(j.id, by, 'edit', `Updated ${other.join(', ').replace(/_/g, ' ')}`);
  if (patch.email && !updated.member_id) await memberForBooking(updated).catch(() => {});
  res.json({ booking: updated });
}));

router.post('/admin/booking/:id/note', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const text = String(req.body.text || '').trim();
  if (!text) throw httpErr(400, 'Write a note first.');
  await logEvent(j.id, req.staff.name, 'note', text);
  await patchJob(j.id, {});
  res.json({ ok: true });
}));

async function estimateGuard(req) {
  const cfg = await getConfig();
  if (req.staff.role === 'tech' && !cfg.tech_can_estimate) throw httpErr(403, 'Estimates are handled by the service desk.');
  return cfg;
}

router.put('/admin/booking/:id/estimate', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const cfg = await estimateGuard(req);
  if (j.status !== 'open') throw httpErr(400, 'This job is closed. Undo the payment to change the estimate.');
  const old = j.estimate || { lines: [] };
  const oldById = new Map((old.lines || []).map(l => [l.id, l]));
  const lines = (Array.isArray(req.body.lines) ? req.body.lines : []).slice(0, 80).map(l => {
    const type = ['labor', 'part', 'fee', 'discount'].includes(l.type) ? l.type : 'labor';
    const status = type === 'discount' ? 'approved' : (['pending', 'approved', 'declined'].includes(l.status) ? l.status : 'pending');
    return {
      id: /^[a-z0-9]{6,20}$/i.test(String(l.id || '')) ? String(l.id) : crypto.randomBytes(5).toString('hex'),
      type, desc: String(l.desc || '').trim().slice(0, 200),
      qty: Math.min(1000, Math.max(0, Math.round((Number(l.qty) || 0) * 100) / 100)),
      unit_cents: Math.min(5000000, Math.max(0, Math.round(Number(l.unit_cents) || 0))),
      cost_cents: l.cost_cents == null || l.cost_cents === '' ? null : Math.max(0, Math.round(Number(l.cost_cents) || 0)),
      part_no: l.part_no ? String(l.part_no).trim().slice(0, 60) : null,
      status
    };
  }).filter(l => l.desc);
  const changes = [];
  lines.forEach(l => {
    const o = oldById.get(l.id);
    if (o && o.status !== l.status && l.type !== 'discount') changes.push(`${l.desc}: ${l.status} (by ${req.staff.name}, phone/in person)`);
  });
  const est = Object.assign({}, old, { lines, notes: String(req.body.notes || '').slice(0, 1000), updated_at: new Date().toISOString() });
  const totals = estTotals(est, cfg.parts_tax_rate);
  let stage = j.stage;
  if (changes.length && totals.pending === 0 && j.stage === 'waiting_approval' && lines.some(l => l.status === 'approved')) stage = 'in_progress';
  await patchJob(j.id, { estimate: est, stage });
  await logEvent(j.id, req.staff.name, 'estimate', `Estimate saved: ${lines.length} line${lines.length === 1 ? '' : 's'}, ${money(totals.quoted.total)} quoted`);
  for (const c of changes) await logEvent(j.id, req.staff.name, 'estimate', c);
  if (stage !== j.stage) await logEvent(j.id, req.staff.name, 'status', `${STAGE_LABEL[j.stage]} → ${STAGE_LABEL[stage]}`);
  res.json({ estimate: est, totals, stage });
}));

router.post('/admin/booking/:id/estimate/send', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const cfg = await estimateGuard(req);
  if (j.status !== 'open') throw httpErr(400, 'This job is closed.');
  if (!j.estimate || !(j.estimate.lines || []).length) throw httpErr(400, 'Add at least one line and save the estimate first.');
  const token = j.estimate_token || crypto.randomBytes(16).toString('hex');
  const link = `${PUBLIC_BASE}/loyalty/e/${token}`;
  const viaText = req.body.via !== 'link';
  if (viaText) {
    const text = req.body.text || fillTemplate(cfg.sms_templates.estimate, await smsVars(Object.assign({}, j, { estimate_token: token }), cfg));
    await sendSms(j.phone, text);
    await logEvent(j.id, req.staff.name, 'sms', text);
  }
  const est = Object.assign({}, j.estimate, { sent_at: new Date().toISOString() });
  const stage = ['new', 'scheduled', 'en_route', 'on_site', 'in_progress'].includes(j.stage) ? 'waiting_approval' : j.stage;
  await patchJob(j.id, { estimate_token: token, estimate: est, stage });
  await logEvent(j.id, req.staff.name, 'estimate', viaText ? 'Estimate texted to customer' : 'Estimate link created');
  if (stage !== j.stage) await logEvent(j.id, req.staff.name, 'status', `${STAGE_LABEL[j.stage]} → ${STAGE_LABEL[stage]}`);
  res.json({ link, texted: viaText, stage });
}));

router.post('/admin/booking/:id/sms', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const text = String(req.body.text || '').trim();
  await sendSms(j.phone, text);
  await logEvent(j.id, req.staff.name, 'sms', text);
  let stage = j.stage;
  if (req.body.kind === 'on_way' && ['new', 'scheduled'].includes(j.stage) && j.status === 'open') stage = 'en_route';
  if (req.body.kind === 'confirm' && j.stage === 'new' && j.status === 'open') stage = 'scheduled';
  if (stage !== j.stage) {
    await patchJob(j.id, { stage });
    await logEvent(j.id, req.staff.name, 'status', `${STAGE_LABEL[j.stage]} → ${STAGE_LABEL[stage]}`);
  }
  res.json({ ok: true, stage });
}));

router.get('/admin/followups', auth(DESK), h(async (req, res) => {
  const rows = await sb('uea_loyalty_bookings?status=eq.paid&follow_up_done=eq.false&estimate=not.is.null&select=id,order_name,customer_name,phone,email,vehicle,estimate,follow_up_date,paid_at&order=follow_up_date.asc.nullslast&limit=300');
  const today = todayCentral();
  const out = rows.map(r => {
    const declined = (r.estimate.lines || []).filter(l => l.status === 'declined');
    return { id: r.id, order_name: r.order_name, customer_name: r.customer_name, phone: r.phone, email: r.email, vehicle: r.vehicle,
      follow_up_date: r.follow_up_date, paid_at: r.paid_at, due: !r.follow_up_date || r.follow_up_date <= today,
      declined: declined.map(l => ({ desc: l.desc, amount_cents: lineAmount(l) })),
      value_cents: declined.reduce((s2, l) => s2 + lineAmount(l), 0) };
  }).filter(r => r.declined.length);
  res.json({ followups: out, today });
}));

router.post('/admin/booking/:id/followup', auth(DESK), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  if (req.body.snooze_days) {
    const d = new Date(Date.now() + Math.min(365, Math.max(1, parseInt(req.body.snooze_days, 10))) * 86400000).toISOString().slice(0, 10);
    await patchJob(j.id, { follow_up_date: d });
    await logEvent(j.id, req.staff.name, 'note', `Follow-up moved to ${fmtDate(d)}`);
  } else {
    await patchJob(j.id, { follow_up_done: true });
    await logEvent(j.id, req.staff.name, 'note', `Follow-up closed${req.body.note ? `: ${String(req.body.note).slice(0, 200)}` : ''}`);
  }
  res.json({ ok: true });
}));

// ── Staff (owner only) ──────────────────────────────────────────────────────
router.get('/admin/meta', auth(ALL), h(async (req, res) => {
  const cfg = await getConfig();
  res.json({ time_windows: cfg.time_windows || [], payment_methods: cfg.payment_methods || [], tech_can_estimate: cfg.tech_can_estimate !== false });
}));

router.get('/admin/techs', auth(DESK), h(async (req, res) => { res.json({ techs: await listTechs() }); }));

router.get('/admin/staff', auth(OWNER), h(async (req, res) => {
  res.json({ staff: await sb('uea_staff?select=id,email,name,phone,role,active,last_login_at,created_at&order=active.desc,name.asc') });
}));

router.post('/admin/staff', auth(OWNER), h(async (req, res) => {
  const b = req.body || {};
  const email = cleanEmail(b.email);
  if (!email || !/.+@.+\..+/.test(email)) throw httpErr(400, 'Enter a valid email.');
  if (email === OWNER_EMAIL) throw httpErr(400, 'That email is the owner login. Use a different email.');
  if (!String(b.name || '').trim()) throw httpErr(400, 'Enter their name.');
  if (!['owner', 'writer', 'tech'].includes(b.role)) throw httpErr(400, 'Choose a role.');
  if (String(b.password || '').length < 10) throw httpErr(400, 'Temporary password must be at least 10 characters.');
  try {
    const r = await sb('uea_staff', {
      method: 'POST', prefer: 'return=representation',
      body: { email, name: String(b.name).trim().slice(0, 80), phone: b.phone ? String(b.phone).trim().slice(0, 40) : null, role: b.role, pw_hash: hashPw(b.password) }
    });
    res.json({ staff: { id: r[0].id, email, name: r[0].name, role: r[0].role } });
  } catch (e) {
    if (/duplicate|unique/i.test(e.message)) throw httpErr(400, 'Someone already uses that email.');
    throw e;
  }
}));

router.patch('/admin/staff/:id', auth(OWNER), h(async (req, res) => {
  const row = (await sb(`uea_staff?id=eq.${enc(req.params.id)}&select=*`))[0];
  if (!row) throw httpErr(404, 'Team member not found.');
  const b = req.body || {}, patch = {};
  let bump = false;
  if (b.name != null) patch.name = String(b.name).trim().slice(0, 80) || row.name;
  if (b.phone != null) patch.phone = String(b.phone).trim().slice(0, 40) || null;
  if (b.role != null) { if (!['owner', 'writer', 'tech'].includes(b.role)) throw httpErr(400, 'Choose a role.'); if (b.role !== row.role) { patch.role = b.role; bump = true; } }
  if (b.active != null && !!b.active !== row.active) { patch.active = !!b.active; bump = true; }
  if (b.password) { if (String(b.password).length < 10) throw httpErr(400, 'Password must be at least 10 characters.'); patch.pw_hash = hashPw(b.password); bump = true; }
  if (bump) patch.token_ver = row.token_ver + 1;
  if (Object.keys(patch).length) await sb(`uea_staff?id=eq.${row.id}`, { method: 'PATCH', body: patch });
  staffCache.delete(row.id);
  res.json({ ok: true });
}));

router.post('/admin/member/:id/fleet', auth(OWNER), h(async (req, res) => {
  const r = await sb(`uea_loyalty_members?id=eq.${enc(req.params.id)}`, {
    method: 'PATCH', prefer: 'return=representation', body: { is_fleet: !!req.body.is_fleet }
  });
  if (!r[0]) throw httpErr(404, 'Member not found.');
  res.json({ is_fleet: r[0].is_fleet });
}));

router.get('/admin/vouchers', auth(DESK), h(async (req, res) => {
  const s = req.query.status || 'open';
  const filter = s === 'open' ? '&status=in.(active,applied)' : s === 'all' ? '' : `&status=eq.${enc(s)}`;
  res.json({
    vouchers: await sb(`uea_loyalty_vouchers?select=*,member:uea_loyalty_members(id,name,email,phone)${filter}&order=created_at.desc&limit=200`)
  });
}));

router.post('/admin/voucher/:id/used', auth(DESK), h(async (req, res) => {
  const r = await sb(`uea_loyalty_vouchers?id=eq.${enc(req.params.id)}&status=in.(active,applied)`, {
    method: 'PATCH', prefer: 'return=representation',
    body: { status: 'used', used_at: new Date().toISOString(), used_order: String(req.body.order || '').slice(0, 60) || null }
  });
  if (!r[0]) throw httpErr(400, 'Voucher is already used or void.');
  res.json(r[0]);
}));

router.post('/admin/voucher/:id/void', auth(OWNER), h(async (req, res) => {
  res.json(await rpc('uea_loyalty_void_voucher', { p_voucher: req.params.id, p_by: 'admin' }));
}));

router.get('/admin/reviews', auth(OWNER), h(async (req, res) => {
  const s = ['pending', 'approved', 'denied'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({
    claims: await sb(`uea_loyalty_review_claims?status=eq.${s}&select=*,member:uea_loyalty_members(id,name,email)&order=created_at.desc&limit=100`)
  });
}));

router.post('/admin/review/:id', auth(OWNER), h(async (req, res) => {
  const claim = (await sb(`uea_loyalty_review_claims?id=eq.${enc(req.params.id)}&status=eq.pending&select=*`))[0];
  if (!claim) throw httpErr(400, 'This claim was already decided.');
  const approve = !!req.body.approve;
  if (approve) {
    const cfg = await getConfig();
    await rpc('uea_loyalty_post', {
      p_member: claim.member_id, p_type: 'review', p_points: cfg.review_bonus,
      p_ref: `review:${claim.id}`, p_note: 'Google review bonus', p_by: 'admin'
    });
  }
  await sb(`uea_loyalty_review_claims?id=eq.${claim.id}`, {
    method: 'PATCH', body: { status: approve ? 'approved' : 'denied', decided_at: new Date().toISOString() }
  });
  res.json({ ok: true });
}));

router.get('/admin/settings', auth(OWNER), h(async (req, res) => {
  res.json({ config: await getConfig(true), defaults: DEFAULT_CONFIG });
}));

router.put('/admin/settings', auth(OWNER), h(async (req, res) => {
  const c = req.body.config;
  const num = (v, min = 0) => typeof v === 'number' && isFinite(v) && v >= min;
  if (c && c.parts_points_per_dollar == null) c.parts_points_per_dollar = c.points_per_dollar;
  if (c && (!Array.isArray(c.payment_methods) || !c.payment_methods.length)) c.payment_methods = DEFAULT_CONFIG.payment_methods;
  if (!c || !num(c.points_per_dollar, 0.01) || !num(c.parts_points_per_dollar) || !num(c.cents_per_point) || !num(c.welcome_bonus) ||
      !num(c.referral_bonus_referrer) || !num(c.referral_bonus_friend) || !num(c.referral_min_cents) || !num(c.review_bonus)) {
    throw httpErr(400, 'Check the number fields; one is missing or negative.');
  }
  if (!Array.isArray(c.tiers) || !c.tiers.length || c.tiers.some(t => !t.key || !t.name || !num(t.min_spend_cents) || !num(t.multiplier, 0.1))) {
    throw httpErr(400, 'Every tier needs a name, a minimum spend, and a multiplier.');
  }
  if (!c.tiers.some(t => t.min_spend_cents === 0)) throw httpErr(400, 'One tier must start at $0.');
  ['book_ahead_days', 'book_ahead_bonus', 'offpeak_bonus', 'expire_months'].forEach(k => {
    if (c[k] == null) c[k] = DEFAULT_CONFIG[k];
    if (!num(c[k])) throw httpErr(400, 'Check the bonus and expiration fields; one is negative.');
  });
  c.offpeak_days = (Array.isArray(c.offpeak_days) ? c.offpeak_days : []).map(Number).filter(d => d >= 0 && d <= 6);
  c.terms_extra = (Array.isArray(c.terms_extra) ? c.terms_extra : []).map(t => String(t).trim().slice(0, 400)).filter(Boolean).slice(0, 20);
  delete c._updated_at;
  ['labor_rate_cents', 'parts_markup_pct', 'parts_tax_rate', 'follow_up_days'].forEach(k => {
    if (c[k] == null) c[k] = DEFAULT_CONFIG[k];
    if (!num(c[k])) throw httpErr(400, 'Check the shop number fields; one is missing or negative.');
  });
  c.time_windows = (Array.isArray(c.time_windows) ? c.time_windows : DEFAULT_CONFIG.time_windows).map(x => String(x).trim()).filter(Boolean).slice(0, 12);
  c.sms_templates = Object.assign({}, DEFAULT_CONFIG.sms_templates, c.sms_templates || {});
  Object.keys(c.sms_templates).forEach(k => { c.sms_templates[k] = String(c.sms_templates[k] || '').slice(0, 600); });
  c.tech_can_estimate = c.tech_can_estimate !== false;
  ['shop_phone', 'payment_link', 'notify_phone'].forEach(k => { c[k] = String(c[k] || '').trim().slice(0, 300); });
  c.rewards.forEach(r => { r.min_invoice_cents = Math.max(0, Math.round(Number(r.min_invoice_cents) || 0)); });
  if (!Array.isArray(c.rewards) || c.rewards.some(r => !r.key || !r.name || !num(r.points, 1) || !num(r.value_cents))) {
    throw httpErr(400, 'Every reward needs a name, a point cost, and a dollar value.');
  }
  const keys = c.rewards.map(r => r.key);
  if (new Set(keys).size !== keys.length) throw httpErr(400, 'Two rewards share the same key.');
  await sb('uea_loyalty_settings?on_conflict=id', {
    method: 'POST', prefer: 'resolution=merge-duplicates',
    body: { id: 1, config: c, updated_at: new Date().toISOString() }
  });
  cfgCache = null;
  res.json({ config: await getConfig(true) });
}));

// ── Customer estimate approval page (public, link texted to the customer) ────
function estimatePage(j, cfg, token) {
  const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lines = (j.estimate && j.estimate.lines) || [];
  const tax = Number(cfg.parts_tax_rate) || 0;
  const pending = lines.filter(l => l.type !== 'discount' && (l.status || 'pending') === 'pending');
  const typeLabel = { labor: 'Labor', part: 'Part', fee: 'Fee', discount: 'Discount' };
  const row = l => {
    const amt = lineAmount(l);
    const st = l.type === 'discount' ? '' : (l.status || 'pending');
    const ctl = st === 'pending'
      ? `<label class="chk"><input type="checkbox" data-id="${e(l.id)}" checked> Approve</label>`
      : st ? `<span class="st ${st}">${st === 'approved' ? 'Approved' : 'Declined'}</span>` : '';
    return `<tr data-type="${e(l.type)}" data-amt="${amt}" data-st="${e(st)}" data-id="${e(l.id)}"><td><b>${e(l.desc)}</b><br><span class="dim">${typeLabel[l.type]}${l.type === 'labor' && l.qty ? `, ${l.qty} hr` : l.qty && l.qty !== 1 ? `, qty ${l.qty}` : ''}</span></td><td class="r">${l.type === 'discount' ? '−' : ''}${money(amt)}</td><td class="r">${ctl}</td></tr>`;
  };
  const auths = (j.estimate && j.estimate.authorizations) || [];
  const lastAuth = auths[auths.length - 1];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>Your estimate | Upper Echelon Automotive</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Oswald:wght@500;600&display=swap" rel="stylesheet">
<style>
:root{--g:#CBA135;--gh:#E6C76A;--gl:#8E6F1F;--p:#6B2896;--tx:#EDE8DC;--dm:#9A9488;--ed:#2e2e2e;--ok:#5FBF7A;--bd:#E0605A}
*{box-sizing:border-box}body{margin:0;background:#000;color:var(--tx);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
main{max-width:720px;margin:0 auto;padding:1.25rem}
.brand{display:flex;align-items:center;gap:.7rem;margin-bottom:1.2rem}
.nut{width:40px;height:40px;clip-path:polygon(25% 3%,75% 3%,100% 50%,75% 97%,25% 97%,0 50%);background:linear-gradient(135deg,var(--gh),var(--g) 40%,var(--gl))}
.brand b{font:400 1.6rem/1 'Bebas Neue',Impact,sans-serif;letter-spacing:.04em}
h1{font:400 2.3rem/1 'Bebas Neue',Impact,sans-serif;letter-spacing:.03em;margin:.2rem 0 .3rem}
.dim{color:var(--dm);font-size:.88rem}
.box{border:1px solid var(--ed);border-radius:6px;background:#0f0f0f;padding:1rem;margin:1rem 0}
.box h2{font:500 1.05rem 'Oswald',Arial,sans-serif;margin:0 0 .4rem}
table{width:100%;border-collapse:collapse}td{padding:.65rem .3rem;border-bottom:1px solid #1d1d1d;vertical-align:top}.r{text-align:right;white-space:nowrap}
.chk{display:inline-flex;gap:.35rem;align-items:center;font:500 .95rem 'Oswald',Arial,sans-serif;color:var(--gh);cursor:pointer}
.chk input{width:20px;height:20px;accent-color:#CBA135}
.st{font:500 .85rem 'Oswald',Arial,sans-serif}.st.approved{color:var(--ok)}.st.declined{color:var(--bd)}
.tot td{border:0;padding:.25rem .3rem}.tot .big td{font:600 1.25rem 'Oswald',Arial,sans-serif;color:var(--gh);padding-top:.5rem}
input[type=text]{width:100%;background:#000;border:1px solid var(--ed);border-radius:4px;color:var(--tx);padding:.7rem;font-size:16px}
input[type=text]:focus{border-color:var(--g);outline:none}
button{width:100%;margin-top:.8rem;border:1px solid var(--gl);border-radius:4px;padding:.85rem;font:500 1.05rem 'Oswald',Arial,sans-serif;letter-spacing:.03em;
background:linear-gradient(180deg,var(--gh),var(--g) 45%,var(--gl));color:#140f02;cursor:pointer}
button:disabled{opacity:.5}.err{color:var(--bd);margin-top:.5rem;min-height:1.2em}
.ok{border-color:#2c5a37;background:rgba(95,191,122,.08)}
:focus-visible{outline:2px solid var(--gh);outline-offset:2px}
</style></head><body><main>
<div class="brand"><div class="nut"></div><b>Upper Echelon Automotive</b></div>
<h1>Your estimate</h1>
<div class="dim">${e(j.customer_name || '')}${j.vehicle ? ` &middot; ${e(j.vehicle)}` : ''}${j.order_name ? ` &middot; ${e(j.order_name)}` : ''}</div>
${j.concern ? `<div class="box"><h2>What you told us</h2>${e(j.concern)}</div>` : ''}
${j.findings ? `<div class="box"><h2>What our technician found</h2>${e(j.findings).replace(/\n/g, '<br>')}</div>` : ''}
${j.estimate && j.estimate.notes ? `<div class="box"><h2>Notes</h2>${e(j.estimate.notes).replace(/\n/g, '<br>')}</div>` : ''}
<div class="box"><h2>Recommended work</h2><table>${lines.map(row).join('')}</table>
<table class="tot" style="margin-top:.6rem"><tr><td>Labor and fees</td><td class="r" id="tL"></td></tr><tr><td>Parts</td><td class="r" id="tP"></td></tr>
<tr><td>Tax on parts (${tax}%)</td><td class="r" id="tT"></td></tr><tr class="big"><td>Total for approved work</td><td class="r" id="tA"></td></tr></table></div>
${pending.length ? `<div class="box" id="authBox"><h2>Approve the work</h2>
<p class="dim" style="margin-top:0">Uncheck anything you don't want done today. By typing your name you authorize Upper Echelon Automotive to perform the checked work at the prices shown, plus applicable tax. If we find anything else, we'll ask before doing more.</p>
<input type="text" id="nm" placeholder="Type your full name" autocomplete="name">
<button id="go">Approve checked work</button><div class="err" id="er"></div></div>`
  : `<div class="box ok"><h2>Thanks, you're all set</h2>${lastAuth ? `Approved by ${e(lastAuth.name)} on ${new Date(lastAuth.at).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' })}.` : 'Every item on this estimate has a decision.'} Questions? Call <a style="color:#E6C76A" href="tel:${e(String(cfg.shop_phone || '').replace(/\D/g, ''))}">${e(cfg.shop_phone || '')}</a>.</div>`}
<p class="dim">Estimate prices are good for 30 days. Card payment is collected when the work is done.</p>
</main>
<script>
(function(){
  var TAX=${tax};
  function usd(c){return '$'+(c/100).toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');}
  function rows(){return Array.prototype.slice.call(document.querySelectorAll('tr[data-type]'));}
  function counted(r){var st=r.dataset.st;if(r.dataset.type==='discount')return true;if(st==='approved')return true;if(st==='pending'){var c=r.querySelector('input');return c&&c.checked;}return false;}
  function calc(){var L=0,P=0,D=0;rows().forEach(function(r){if(!counted(r))return;var a=+r.dataset.amt;if(r.dataset.type==='part')P+=a;else if(r.dataset.type==='discount')D+=a;else L+=a;});
    var T=Math.round(P*TAX/100);document.getElementById('tL').textContent=usd(Math.max(0,L-D));document.getElementById('tP').textContent=usd(P);document.getElementById('tT').textContent=usd(T);document.getElementById('tA').textContent=usd(Math.max(0,L+P-D)+T);}
  document.addEventListener('change',calc);calc();
  var go=document.getElementById('go');if(!go)return;
  go.addEventListener('click',function(){
    var nm=document.getElementById('nm').value.trim(),er=document.getElementById('er');er.textContent='';
    if(nm.length<2){er.textContent='Type your full name to approve.';return;}
    var dec={};rows().forEach(function(r){if(r.dataset.st==='pending'){dec[r.dataset.id]=r.querySelector('input').checked;}});
    go.disabled=true;go.textContent='Sending…';
    fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nm,decisions:dec})})
      .then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'Something went wrong.');return d;});})
      .then(function(){location.reload();})
      .catch(function(e){er.textContent=e.message+' You can also call us.';go.disabled=false;go.textContent='Approve checked work';});
  });
})();
</script></body></html>`;
}

router.get('/e/:token', h(async (req, res) => {
  const token = String(req.params.token || '');
  const j = /^[a-f0-9]{32}$/.test(token) ? (await sb(`uea_loyalty_bookings?estimate_token=eq.${token}&select=*`))[0] : null;
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-store');
  if (!j || !j.estimate) return res.status(404).send('<!DOCTYPE html><meta name="viewport" content="width=device-width"><body style="background:#000;color:#EDE8DC;font-family:system-ui;padding:2rem">This estimate link is no longer valid. Call Upper Echelon Automotive at 251-289-0740.</body>');
  res.send(estimatePage(j, await getConfig(), token));
}));

router.post('/e/:token', h(async (req, res) => {
  const token = String(req.params.token || '');
  const j = /^[a-f0-9]{32}$/.test(token) ? (await sb(`uea_loyalty_bookings?estimate_token=eq.${token}&select=*`))[0] : null;
  if (!j || !j.estimate) throw httpErr(404, 'This estimate link is no longer valid.');
  if (j.status !== 'open') throw httpErr(400, 'This job is already closed. Please call us.');
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (name.length < 2) throw httpErr(400, 'Type your full name to approve.');
  const dec = req.body.decisions || {};
  const approved = [], declined = [];
  const lines = (j.estimate.lines || []).map(l => {
    if (l.type === 'discount' || (l.status || 'pending') !== 'pending' || !(l.id in dec)) return l;
    const ok = !!dec[l.id];
    (ok ? approved : declined).push(l.desc);
    return Object.assign({}, l, { status: ok ? 'approved' : 'declined' });
  });
  if (!approved.length && !declined.length) throw httpErr(400, 'There\'s nothing left to approve on this estimate.');
  const cfg = await getConfig();
  const est = Object.assign({}, j.estimate, { lines });
  const totals = estTotals(est, cfg.parts_tax_rate);
  est.authorizations = (j.estimate.authorizations || []).concat([{
    name, at: new Date().toISOString(), ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
    ua: String(req.get('user-agent') || '').slice(0, 200), approved, declined, approved_total_cents: totals.approved.total
  }]);
  const stage = approved.length && j.stage === 'waiting_approval' ? 'in_progress' : j.stage;
  await patchJob(j.id, { estimate: est, stage });
  await logEvent(j.id, `${name} (customer)`, 'estimate',
    `Customer approved ${approved.length ? approved.join(', ') : 'nothing'}${declined.length ? `; declined ${declined.join(', ')}` : ''}. Approved total ${money(totals.approved.total)}.`);
  if (stage !== j.stage) await logEvent(j.id, 'System', 'status', `${STAGE_LABEL[j.stage]} → ${STAGE_LABEL[stage]}`);
  if (cfg.notify_phone) {
    sendSms(cfg.notify_phone, `UEA: ${name} ${approved.length ? `approved ${money(totals.approved.total)}` : 'declined the estimate'} on ${j.order_name || 'a job'} (${j.vehicle || j.service || ''}).`)
      .catch(e => console.error('[loyalty] owner notify failed:', e.message));
  }
  res.json({ ok: true });
}));

module.exports = router;
