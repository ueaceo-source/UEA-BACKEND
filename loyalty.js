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
const fs = require('fs');

const router = express.Router();

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const LOYALTY_SECRET = process.env.LOYALTY_SECRET || '';
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || '';
// Owner password. A LOYALTY_ADMIN_PASSWORD value on Render overrides this one.
const ADMIN_PASSWORD = process.env.LOYALTY_ADMIN_PASSWORD || 'Daytona01@';
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
  if (!SB_KEY) missing.push('SUPABASE_SERVICE_KEY');
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
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

// Admin portal page (built into this file, so no separate HTML file is needed)
router.get('/admin', (req, res) => {
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' });
  res.send(ADMIN_HTML);
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
  let job = created[0];
  await logEvent(job.id, req.staff.name, 'status', `Job created${b.source_note ? ` (${t(b.source_note, 60)})` : ''}`);
  const quoteLines = sanitizeLines(b.estimate_lines);
  if (quoteLines.length) {
    job = (await patchJob(job.id, { estimate: { lines: quoteLines, notes: t(b.estimate_notes, 1000) || '', updated_at: new Date().toISOString() } }))[0] || job;
    await logEvent(job.id, req.staff.name, 'estimate', `Estimate started from quote: ${quoteLines.length} line${quoteLines.length === 1 ? '' : 's'}`);
  }
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

function sanitizeLines(input) {
  return (Array.isArray(input) ? input : []).slice(0, 80).map(l => {
    const type = ['labor', 'part', 'fee', 'discount'].includes(l.type) ? l.type : 'labor';
    const status = type === 'discount' ? 'approved' : (['pending', 'approved', 'declined'].includes(l.status) ? l.status : 'pending');
    return {
      id: /^[a-z0-9]{6,20}$/i.test(String(l.id || '')) ? String(l.id) : crypto.randomBytes(5).toString('hex'),
      type, desc: String(l.desc || '').trim().slice(0, 200),
      qty: Math.min(1000, Math.max(0, Math.round((Number(l.qty) || 0) * 100) / 100)),
      unit_cents: Math.min(5000000, Math.max(0, Math.round(Number(l.unit_cents) || 0))),
      cost_cents: l.cost_cents == null || l.cost_cents === '' ? null : Math.max(0, Math.round(Number(l.cost_cents) || 0)),
      part_no: l.part_no ? String(l.part_no).trim().slice(0, 60) : null,
      guide_id: l.guide_id ? String(l.guide_id).slice(0, 80) : null,
      status
    };
  }).filter(l => l.desc);
}

router.put('/admin/booking/:id/estimate', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const cfg = await estimateGuard(req);
  if (j.status !== 'open') throw httpErr(400, 'This job is closed. Undo the payment to change the estimate.');
  const old = j.estimate || { lines: [] };
  const oldById = new Map((old.lines || []).map(l => [l.id, l]));
  const lines = sanitizeLines(req.body.lines);
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
  histCache.at = 0; // guide history picks up this estimate right away
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

// ── Labor & parts guide ─────────────────────────────────────────────────────
const MAKES = ['Land Rover', 'Mercedes-Benz', 'Mercedes', 'Alfa Romeo', 'Aston Martin', 'Acura', 'Audi', 'BMW', 'Buick', 'Cadillac',
  'Chevrolet', 'Chevy', 'Chrysler', 'Dodge', 'Fiat', 'Ford', 'GMC', 'Genesis', 'Honda', 'Hummer', 'Hyundai', 'Infiniti', 'Isuzu',
  'Jaguar', 'Jeep', 'Kia', 'Lexus', 'Lincoln', 'Mazda', 'MINI', 'Mitsubishi', 'Nissan', 'Pontiac', 'Porsche', 'RAM', 'Saturn',
  'Scion', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Volkswagen', 'VW', 'Volvo'];
const MAKE_ALIAS = { chevy: 'Chevrolet', vw: 'Volkswagen', mercedes: 'Mercedes-Benz' };

function parseVehicle(input) {
  const text = String(input || '').trim();
  const low = text.toLowerCase();
  const y = (text.match(/\b(19[5-9]\d|20[0-4]\d)\b/) || [])[1];
  let make = null, at = -1;
  for (const m of MAKES) {
    const i = low.search(new RegExp(`\\b${m.toLowerCase().replace(/[-]/g, '\\-')}\\b`));
    if (i > -1) { make = MAKE_ALIAS[m.toLowerCase()] || m; at = i + m.length; break; }
  }
  // Model = first word after the make ("F-150", "Camry"), or two words for names like "Grand Cherokee" / "Santa Fe"
  let model = null;
  if (make) {
    const w = text.slice(at).replace(/\b(19|20)\d\d\b/, '').trim().split(/\s+/).filter(Boolean);
    if (w.length) model = ['grand', 'santa', 'town', 'range', 'model', 'land', 'monte', 'el'].includes(w[0].toLowerCase()) && w[1] ? `${w[0]} ${w[1]}` : w[0];
  }
  return { text, low, year: y ? Number(y) : null, make, model };
}

function overrideScore(o, v) {
  if (!v.make || String(o.make).toLowerCase() !== v.make.toLowerCase()) return -1;
  if (o.model && !v.low.includes(String(o.model).toLowerCase())) return -1;
  if (o.year_from && (!v.year || v.year < o.year_from)) return -1;
  if (o.year_to && (!v.year || v.year > o.year_to)) return -1;
  if (o.engine && !v.low.includes(String(o.engine).toLowerCase())) return -1;
  return 1 + (o.model ? 2 : 0) + (o.year_from || o.year_to ? 1 : 0) + (o.engine ? 1 : 0);
}

const describeOverride = o => [o.year_from && o.year_to ? (o.year_from === o.year_to ? `${o.year_from}` : `${o.year_from}–${o.year_to}`) : o.year_from ? `${o.year_from}+` : o.year_to ? `up to ${o.year_to}` : '',
  o.make, o.model, o.engine].filter(Boolean).join(' ');

let histCache = { at: 0, rows: [] };
async function recentEstimates() {
  if (Date.now() - histCache.at < 5 * 60 * 1000) return histCache.rows;
  const rows = await sb('uea_loyalty_bookings?estimate=not.is.null&select=vehicle,estimate,status&order=created_at.desc&limit=500');
  histCache = { at: Date.now(), rows };
  return rows;
}
function historyFor(rows, jobId, v) {
  const out = { all: 0, all_hours: 0, veh: 0, veh_hours: 0 };
  const modelWord = v.model ? v.model.split(' ')[0].toLowerCase() : null;
  for (const r of rows) {
    const vl = String(r.vehicle || '').toLowerCase();
    const same = v.make && vl.includes(v.make.toLowerCase()) && (!modelWord || vl.includes(modelWord));
    for (const l of (r.estimate.lines || [])) {
      if (l.guide_id !== jobId || l.type !== 'labor' || l.status === 'declined') continue;
      out.all++; out.all_hours += Number(l.qty) || 0;
      if (same) { out.veh++; out.veh_hours += Number(l.qty) || 0; }
    }
  }
  return {
    times_quoted: out.all, avg_hours: out.all ? Math.round(out.all_hours / out.all * 10) / 10 : null,
    vehicle_times_quoted: out.veh, vehicle_avg_hours: out.veh ? Math.round(out.veh_hours / out.veh * 10) / 10 : null
  };
}

function cleanParts(parts) {
  return (Array.isArray(parts) ? parts : []).slice(0, 20).map(p => ({
    name: String(p.name || '').trim().slice(0, 120),
    part_no: p.part_no ? String(p.part_no).trim().slice(0, 60) : null,
    qty: Math.min(100, Math.max(0, Number(p.qty) || 1)),
    cost_cents: Math.max(0, Math.round(Number(p.cost_cents) || 0))
  })).filter(p => p.name);
}

async function guideGuard(req) {
  if (req.staff.role === 'tech') {
    const cfg = await getConfig();
    if (!cfg.tech_can_estimate) throw httpErr(403, 'The guide is for the service desk.');
  }
}

router.get('/admin/guide', auth(ALL), h(async (req, res) => {
  await guideGuard(req);
  const [jobs, ovs] = await Promise.all([
    sb('uea_guide_jobs?select=*&order=category.asc,name.asc'),
    sb('uea_guide_overrides?select=job_id')
  ]);
  const counts = {};
  ovs.forEach(o => { counts[o.job_id] = (counts[o.job_id] || 0) + 1; });
  res.json({ jobs: jobs.map(j => Object.assign(j, { override_count: counts[j.id] || 0 })) });
}));

// Resolve every active job for one vehicle: vehicle-specific time if saved, plus your quoting history
router.get('/admin/guide/lookup', auth(ALL), h(async (req, res) => {
  await guideGuard(req);
  const v = parseVehicle(req.query.vehicle || [req.query.year, req.query.make, req.query.model].filter(Boolean).join(' '));
  const q = String(req.query.q || '').trim().toLowerCase();
  const [jobs, ovs, hist] = await Promise.all([
    sb('uea_guide_jobs?active=eq.true&select=*&order=category.asc,name.asc'),
    v.make ? sb(`uea_guide_overrides?select=*&make=ilike.${enc(v.make)}`) : Promise.resolve([]),
    recentEstimates().catch(() => [])
  ]);
  const words = q.split(/\s+/).filter(Boolean);
  const results = jobs
    .filter(j => !words.length || words.every(w => `${j.name} ${j.category} ${j.notes || ''} ${(j.parts || []).map(p => p.name).join(' ')}`.toLowerCase().includes(w)))
    .map(j => {
      let best = null, bestScore = 0;
      ovs.filter(o => o.job_id === j.id).forEach(o => { const sc = overrideScore(o, v); if (sc > bestScore) { best = o; bestScore = sc; } });
      return {
        id: j.id, name: j.name, category: j.category, notes: [best && best.notes, j.notes].filter(Boolean).join(' '),
        flat_cents: j.flat_cents,
        labor_hours: best && best.labor_hours != null ? Number(best.labor_hours) : Number(j.labor_hours),
        parts: best && Array.isArray(best.parts) && best.parts.length ? best.parts : j.parts,
        source: best ? 'vehicle' : 'standard', override_label: best ? describeOverride(best) : null,
        history: historyFor(hist, j.id, v)
      };
    });
  res.json({ vehicle: { year: v.year, make: v.make, model: v.model, text: v.text }, results: results.slice(0, 60) });
}));

router.get('/admin/guide/job/:id', auth(DESK), h(async (req, res) => {
  const job = (await sb(`uea_guide_jobs?id=eq.${enc(req.params.id)}&select=*`))[0];
  if (!job) throw httpErr(404, 'Guide entry not found.');
  const overrides = await sb(`uea_guide_overrides?job_id=eq.${enc(job.id)}&select=*&order=make.asc,model.asc`);
  res.json({ job, overrides });
}));

function guideBody(b) {
  const name = String(b.name || '').trim().slice(0, 120);
  if (!name) throw httpErr(400, 'Give the job a name.');
  const hours = Number(b.labor_hours);
  const flat = b.flat_cents === '' || b.flat_cents == null ? null : Math.max(0, Math.round(Number(b.flat_cents) || 0));
  if (flat == null && !(hours >= 0 && hours <= 100)) throw httpErr(400, 'Labor hours must be between 0 and 100.');
  return {
    name, category: String(b.category || 'Other').trim().slice(0, 60) || 'Other',
    labor_hours: flat == null ? Math.round(hours * 100) / 100 : 0, flat_cents: flat,
    parts: cleanParts(b.parts), notes: b.notes ? String(b.notes).trim().slice(0, 500) : null,
    active: b.active !== false
  };
}

router.post('/admin/guide', auth(DESK), h(async (req, res) => {
  const body = guideBody(req.body || {});
  const id = (body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) || 'job') + '_' + crypto.randomBytes(2).toString('hex');
  const r = await sb('uea_guide_jobs', { method: 'POST', prefer: 'return=representation',
    body: Object.assign(body, { id, updated_by: req.staff.name }) });
  res.json({ job: r[0] });
}));

router.put('/admin/guide/job/:id', auth(DESK), h(async (req, res) => {
  const body = guideBody(req.body || {});
  const r = await sb(`uea_guide_jobs?id=eq.${enc(req.params.id)}`, { method: 'PATCH', prefer: 'return=representation',
    body: Object.assign(body, { updated_by: req.staff.name, updated_at: new Date().toISOString() }) });
  if (!r[0]) throw httpErr(404, 'Guide entry not found.');
  res.json({ job: r[0] });
}));

function overrideBody(b) {
  const make = String(b.make || '').trim().slice(0, 40);
  if (!make) throw httpErr(400, 'Enter at least the make (for example, Ford).');
  const yf = b.year_from ? parseInt(b.year_from, 10) : null, yt = b.year_to ? parseInt(b.year_to, 10) : null;
  if ((yf && (yf < 1950 || yf > 2050)) || (yt && (yt < 1950 || yt > 2050)) || (yf && yt && yf > yt)) throw httpErr(400, 'Check the year range.');
  const hours = b.labor_hours === '' || b.labor_hours == null ? null : Number(b.labor_hours);
  if (hours != null && !(hours >= 0 && hours <= 100)) throw httpErr(400, 'Labor hours must be between 0 and 100.');
  const parts = cleanParts(b.parts);
  if (hours == null && !parts.length) throw httpErr(400, 'Enter the labor hours, the parts, or both for this vehicle.');
  return { make: MAKE_ALIAS[make.toLowerCase()] || make, model: b.model ? String(b.model).trim().slice(0, 40) : null,
    year_from: yf, year_to: yt, engine: b.engine ? String(b.engine).trim().slice(0, 30) : null,
    labor_hours: hours, parts: parts.length ? parts : null, notes: b.notes ? String(b.notes).trim().slice(0, 300) : null };
}

// One click from an estimate: remember this labor time for this make/model/year
router.post('/admin/guide/job/:id/save-vehicle-time', auth(DESK), h(async (req, res) => {
  const job = (await sb(`uea_guide_jobs?id=eq.${enc(req.params.id)}&select=id,name`))[0];
  if (!job) throw httpErr(404, 'Guide entry not found.');
  const v = parseVehicle(req.body.vehicle);
  if (!v.make) throw httpErr(400, 'Add the vehicle (year, make, model) to the job first.');
  const hours = Number(req.body.labor_hours);
  if (!(hours > 0 && hours <= 100)) throw httpErr(400, 'Enter the labor hours first.');
  const existing = (await sb(`uea_guide_overrides?job_id=eq.${enc(job.id)}&make=ilike.${enc(v.make)}&select=*`))
    .find(o => (o.model || '').toLowerCase() === (v.model || '').toLowerCase() && o.year_from === v.year && o.year_to === v.year && !o.engine);
  const body = { make: v.make, model: v.model, year_from: v.year, year_to: v.year, labor_hours: Math.round(hours * 100) / 100, updated_by: req.staff.name, updated_at: new Date().toISOString() };
  const r = existing
    ? await sb(`uea_guide_overrides?id=eq.${existing.id}`, { method: 'PATCH', prefer: 'return=representation', body })
    : await sb('uea_guide_overrides', { method: 'POST', prefer: 'return=representation', body: Object.assign(body, { job_id: job.id }) });
  res.json({ override: r[0], label: describeOverride(r[0]) });
}));

router.post('/admin/guide/job/:id/overrides', auth(DESK), h(async (req, res) => {
  const job = (await sb(`uea_guide_jobs?id=eq.${enc(req.params.id)}&select=id`))[0];
  if (!job) throw httpErr(404, 'Guide entry not found.');
  const r = await sb('uea_guide_overrides', { method: 'POST', prefer: 'return=representation',
    body: Object.assign(overrideBody(req.body || {}), { job_id: job.id, updated_by: req.staff.name }) });
  res.json({ override: r[0] });
}));

router.put('/admin/guide/overrides/:oid', auth(DESK), h(async (req, res) => {
  const r = await sb(`uea_guide_overrides?id=eq.${enc(req.params.oid)}`, { method: 'PATCH', prefer: 'return=representation',
    body: Object.assign(overrideBody(req.body || {}), { updated_by: req.staff.name, updated_at: new Date().toISOString() }) });
  if (!r[0]) throw httpErr(404, 'Vehicle time not found.');
  res.json({ override: r[0] });
}));

router.delete('/admin/guide/overrides/:oid', auth(DESK), h(async (req, res) => {
  await sb(`uea_guide_overrides?id=eq.${enc(req.params.oid)}`, { method: 'DELETE' });
  res.json({ ok: true });
}));

// ── Staff (owner only) ──────────────────────────────────────────────────────
router.get('/admin/meta', auth(ALL), h(async (req, res) => {
  const cfg = await getConfig();
  res.json({ time_windows: cfg.time_windows || [], payment_methods: cfg.payment_methods || [], tech_can_estimate: cfg.tech_can_estimate !== false,
    labor_rate_cents: cfg.labor_rate_cents || 0, parts_markup_pct: cfg.parts_markup_pct || 0, parts_tax_rate: cfg.parts_tax_rate || 0 });
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
  histCache.at = 0; // guide history picks up this estimate right away
  await logEvent(j.id, `${name} (customer)`, 'estimate',
    `Customer approved ${approved.length ? approved.join(', ') : 'nothing'}${declined.length ? `; declined ${declined.join(', ')}` : ''}. Approved total ${money(totals.approved.total)}.`);
  if (stage !== j.stage) await logEvent(j.id, 'System', 'status', `${STAGE_LABEL[j.stage]} → ${STAGE_LABEL[stage]}`);
  if (cfg.notify_phone) {
    sendSms(cfg.notify_phone, `UEA: ${name} ${approved.length ? `approved ${money(totals.approved.total)}` : 'declined the estimate'} on ${j.order_name || 'a job'} (${j.vehicle || j.service || ''}).`)
      .catch(e => console.error('[loyalty] owner notify failed:', e.message));
  }
  res.json({ ok: true });
}));

// ── Admin portal page markup ─────────────────────────────────────────────────
const ADMIN_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<meta name=\"theme-color\" content=\"#000000\">\n<title>UEA Service Desk</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Oswald:wght@400;500;600&family=Inter:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n<style>\n:root{\n  --black:#000; --iron:#141414; --steel:#1f1f1f; --edge:#2e2e2e;\n  --gold:#CBA135; --gold-hi:#E6C76A; --gold-lo:#8E6F1F;\n  --purple:#6B2896; --purple-hi:#8A3FBF;\n  --text:#EDE8DC; --dim:#9A9488; --good:#5FBF7A; --bad:#E0605A; --warn:#E8A33C;\n  --display:'Bebas Neue',Impact,'Arial Narrow',sans-serif;\n  --head:'Oswald','Arial Narrow',Arial,sans-serif;\n  --body:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;background:var(--black);color:var(--text);font:15px/1.5 var(--body)}\nbody{padding-bottom:env(safe-area-inset-bottom)}\nbutton,input,select,textarea{font:inherit;color:inherit}\n:focus-visible{outline:2px solid var(--gold-hi);outline-offset:2px}\na{color:var(--gold-hi)}\n.hide{display:none!important}\n.steel{background:linear-gradient(180deg,#1c1c1c 0%,#121212 100%);border:1px solid var(--edge);border-radius:6px}\n.btn{appearance:none;border:1px solid var(--gold-lo);border-radius:4px;padding:.55rem 1rem;cursor:pointer;text-decoration:none;display:inline-block;\n  font-family:var(--head);font-weight:500;letter-spacing:.03em;line-height:1.2;\n  background:linear-gradient(180deg,var(--gold-hi) 0%,var(--gold) 45%,var(--gold-lo) 100%);color:#140f02;\n  box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 1px 0 #000}\n.btn:hover{filter:brightness(1.08)}\n.btn:disabled{opacity:.5;cursor:default}\n.btn.ghost{background:transparent;color:var(--text);border-color:var(--edge);box-shadow:none}\n.btn.ghost:hover{border-color:var(--gold)}\n.btn.purple{background:linear-gradient(180deg,var(--purple-hi),var(--purple));color:#fff;border-color:#4a1a69}\n.btn.danger{background:transparent;border-color:#5a2522;color:var(--bad);box-shadow:none}\n.btn.sm{padding:.32rem .65rem;font-size:.86rem}\ninput,select,textarea{background:#0a0a0a;border:1px solid var(--edge);border-radius:4px;padding:.55rem .7rem;width:100%}\ninput:focus,select:focus,textarea:focus{border-color:var(--gold);outline:none}\ninput[type=checkbox]{width:auto;accent-color:#CBA135}\nlabel{display:block;font-family:var(--head);font-size:.85rem;color:var(--dim);margin:0 0 .3rem}\n.field{margin-bottom:.9rem}\n.help{font-size:.82rem;color:var(--dim);margin-top:.25rem}\n.dim{color:var(--dim)}\n.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}\n.grid{display:grid;gap:.8rem}\n.g2{grid-template-columns:repeat(2,minmax(0,1fr))}\n.g3{grid-template-columns:repeat(3,minmax(0,1fr))}\n.g4{grid-template-columns:repeat(4,minmax(0,1fr))}\n.g5{grid-template-columns:repeat(5,minmax(0,1fr))}\nh2{font-family:var(--display);font-weight:400;font-size:2.4rem;letter-spacing:.03em;margin:0 0 1.1rem;line-height:1}\nh3{font-family:var(--head);font-weight:500;font-size:1.08rem;margin:0 0 .7rem}\n.panel{padding:1rem 1.1rem}\n.empty{padding:2rem 1rem;text-align:center;color:var(--dim)}\n.err-text{color:var(--bad);font-size:.9rem;margin-top:.5rem}\n.pts{font-family:var(--head);font-weight:600;white-space:nowrap}\n.plus{color:var(--good)} .minus{color:var(--bad)}\ntable{width:100%;border-collapse:collapse}\nth{text-align:left;font-family:var(--head);font-weight:500;color:var(--dim);font-size:.85rem;padding:.5rem .6rem;border-bottom:1px solid var(--edge)}\ntd{padding:.6rem;border-bottom:1px solid #1b1b1b;vertical-align:top}\ntr.click{cursor:pointer}\ntr.click:hover td{background:#0f0f0f}\n.scroll{overflow-x:auto}\n.chip{display:inline-block;font-family:var(--head);font-size:.78rem;padding:.02rem .45rem;border-radius:3px;border:1px solid var(--edge);color:var(--dim);white-space:nowrap;line-height:1.5}\n.chip.gold,.chip.active{border-color:var(--gold-lo);color:var(--gold-hi)}\n.chip.purple,.chip.applied{border-color:var(--purple);color:#c9a2e6}\n.chip.good,.chip.used{color:var(--good);border-color:#2c5a37}\n.chip.bad,.chip.void{color:var(--bad);border-color:#5a2522}\n.chip.warn{color:var(--warn);border-color:#6a4a16}\n\n/* login */\n#login{min-height:100vh;display:grid;place-items:center;padding:1.5rem}\n#login form{width:100%;max-width:380px;padding:2rem}\n.mark{display:flex;align-items:center;gap:.8rem;margin-bottom:1.5rem}\n.bolt{width:44px;height:44px;flex:none;clip-path:polygon(25% 3%,75% 3%,100% 50%,75% 97%,25% 97%,0 50%);\n  background:linear-gradient(135deg,var(--gold-hi),var(--gold) 40%,var(--gold-lo));display:grid;place-items:center}\n.bolt::after{content:'';width:46%;height:46%;border-radius:50%;background:radial-gradient(circle at 35% 35%,#3a2a05,#000)}\n.mark h1{font-family:var(--display);font-size:2rem;letter-spacing:.04em;margin:0;line-height:1}\n.mark small{display:block;color:var(--dim);font-family:var(--head);font-size:.85rem}\n\n/* shell */\n#app{display:grid;grid-template-columns:210px 1fr;min-height:100vh}\nnav{border-right:1px solid var(--edge);padding:1.1rem .7rem;background:#070707;position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column}\nnav .mark{margin:0 .4rem 1.2rem}\nnav .mark h1{font-size:1.45rem}\nnav .grp{font-family:var(--head);font-size:.78rem;color:#6e6a62;margin:.9rem .8rem .25rem}\nnav button.tab{display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;background:none;border:0;\n  border-left:3px solid transparent;padding:.5rem .8rem;margin-bottom:.1rem;cursor:pointer;font-family:var(--head);font-size:1rem;color:var(--dim)}\nnav button.tab:hover{color:var(--text)}\nnav button.tab.on{color:var(--gold-hi);border-left-color:var(--gold);background:linear-gradient(90deg,rgba(203,161,53,.1),transparent)}\n.count{background:var(--purple);color:#fff;border-radius:10px;font-size:.75rem;padding:0 .45rem;font-family:var(--body)}\nnav .who{margin-top:auto;padding:.8rem;font-size:.85rem;color:var(--dim);border-top:1px solid var(--edge)}\nmain{padding:1.6rem 1.8rem 5rem;min-width:0}\n\n/* jobs */\n.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(230px,1fr);gap:.7rem;overflow-x:auto;padding-bottom:.6rem}\n.col{background:#0b0b0b;border:1px solid var(--edge);border-radius:6px;padding:.55rem;min-height:120px}\n.col h4{font-family:var(--head);font-weight:500;font-size:.92rem;margin:.1rem .2rem .55rem;display:flex;justify-content:space-between;color:var(--dim)}\n.col h4 b{color:var(--text);font-weight:500}\n.card{display:block;width:100%;text-align:left;background:linear-gradient(180deg,#1a1a1a,#121212);border:1px solid var(--edge);border-radius:5px;padding:.6rem .65rem;margin-bottom:.5rem;cursor:pointer;color:var(--text)}\n.card:hover{border-color:var(--gold-lo)}\n.card .t{font-family:var(--head);font-weight:500;font-size:.98rem;line-height:1.25}\n.card .s{font-size:.84rem;color:var(--dim);margin-top:.15rem;line-height:1.35}\n.card .f{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.4rem}\n.day{display:grid;gap:.7rem}\n.stop{display:grid;grid-template-columns:110px 1fr auto;gap:1rem;align-items:start;padding:.9rem 1rem}\n.stop .when{font-family:var(--display);font-size:1.35rem;line-height:1.05;color:var(--gold-hi)}\n.stop .when small{display:block;font-family:var(--body);font-size:.78rem;color:var(--dim);letter-spacing:0}\n.stop .who{font-family:var(--head);font-size:1.08rem}\n.stop .acts{display:flex;flex-direction:column;gap:.35rem;min-width:118px}\n\n/* drawer */\n#drawer{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;justify-content:flex-end;z-index:20}\n#drawer .sheet{width:min(760px,100%);height:100%;overflow-y:auto;background:var(--iron);border-left:1px solid var(--gold-lo);padding:1.2rem 1.4rem 4rem}\n.dtabs{display:flex;gap:.2rem;border-bottom:1px solid var(--edge);margin:1rem 0 1rem;position:sticky;top:-1.2rem;background:var(--iron);z-index:2;padding-top:.4rem;overflow-x:auto}\n.dtabs button{background:none;border:0;border-bottom:2px solid transparent;padding:.5rem .8rem;font-family:var(--head);font-size:.98rem;color:var(--dim);cursor:pointer;white-space:nowrap}\n.dtabs button.on{color:var(--gold-hi);border-bottom-color:var(--gold)}\n.kv{display:grid;grid-template-columns:130px 1fr;gap:.35rem .8rem;font-size:.93rem}\n.kv dt{color:var(--dim)} .kv dd{margin:0}\n.sec{margin-bottom:1rem}\n.est td{padding:.35rem .3rem;border-bottom:1px solid #1b1b1b}\n.est input,.est select{padding:.38rem .45rem;font-size:.9rem}\n.est .amt{font-family:var(--head);text-align:right;white-space:nowrap;padding-top:.6rem}\n.totals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}\n.totals table td{border:0;padding:.18rem .2rem}\n.totals .big td{font-family:var(--head);font-size:1.1rem;color:var(--gold-hi);border-top:1px solid var(--edge);padding-top:.4rem}\n.ev{display:grid;grid-template-columns:112px 1fr;gap:.6rem;padding:.5rem 0;border-bottom:1px solid #1b1b1b;font-size:.9rem}\n.ev .k{font-family:var(--head);font-size:.78rem;color:var(--dim)}\n.tierline{display:flex;align-items:center;gap:1rem;margin:1rem 0}\n.tierline .bolt{width:64px;height:64px}\n.tierline .bolt::after{display:none}\n.tierline .bolt b{font-family:var(--display);font-weight:400;color:#140f02;font-size:1.05rem}\n.bar{height:6px;background:#000;border:1px solid var(--edge);border-radius:3px;overflow:hidden}\n.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--purple),var(--gold))}\n.gauges{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--edge);border:1px solid var(--edge);border-radius:6px;overflow:hidden;margin-bottom:1rem}\n.gauge{background:var(--iron);padding:1.1rem 1.2rem}\n.gauge b{display:block;font-family:var(--display);font-weight:400;font-size:2.5rem;line-height:1;color:var(--gold-hi)}\n.gauge span{font-family:var(--head);color:var(--dim);font-size:.9rem}\n.gauge em{display:block;font-style:normal;font-size:.8rem;color:var(--dim);margin-top:.3rem}\n.settings table input{padding:.35rem .5rem}\n.gres{display:grid;grid-template-columns:1fr auto;gap:.6rem;align-items:start;padding:.7rem .2rem;border-bottom:1px solid #1b1b1b}\n.gres:last-child{border-bottom:0}\n.gres h4{margin:0;font-family:var(--head);font-weight:500;font-size:1rem}\n.gres .meta{font-size:.84rem;color:var(--dim);margin-top:.15rem}\n.gres .price{font-family:var(--head);color:var(--gold-hi);white-space:nowrap;text-align:right}\n.gpick{border:1px solid var(--gold-lo);border-radius:6px;padding:.8rem;margin:.6rem 0;background:#0d0d0d}\n.gpick .list{max-height:380px;overflow-y:auto;margin-top:.5rem}\n.parts-ed td{padding:.25rem .2rem;border:0}\n.parts-ed input{padding:.35rem .45rem;font-size:.9rem}\n#toast{position:fixed;left:50%;bottom:calc(1.5rem + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--steel);border:1px solid var(--gold);padding:.7rem 1.1rem;border-radius:4px;z-index:40;font-family:var(--head);max-width:92vw}\n#toast.err{border-color:var(--bad)}\n\n@media (max-width:900px){\n  #app{grid-template-columns:1fr}\n  nav{position:sticky;top:0;height:auto;z-index:10;flex-direction:row;overflow-x:auto;gap:.15rem;padding:.5rem;border-right:0;border-bottom:1px solid var(--edge)}\n  nav .mark,nav .grp,nav .who{display:none}\n  nav button.tab{width:auto;white-space:nowrap;border-left:0;border-bottom:2px solid transparent;margin:0;padding:.45rem .7rem}\n  nav button.tab.on{border-bottom-color:var(--gold);background:none}\n  main{padding:1.1rem .9rem 5rem}\n  .gauges,.g4,.g5{grid-template-columns:repeat(2,minmax(0,1fr))}\n  .g2,.g3,.totals{grid-template-columns:1fr}\n  h2{font-size:2rem}\n  .stop{grid-template-columns:1fr}\n  .stop .acts{flex-direction:row;flex-wrap:wrap}\n  #drawer .sheet{padding:1rem 1rem 4rem}\n  .kv{grid-template-columns:100px 1fr}\n}\n@media (prefers-reduced-motion:no-preference){\n  #drawer .sheet{animation:slide .18s ease-out}\n  @keyframes slide{from{transform:translateX(30px);opacity:.4}to{transform:none;opacity:1}}\n}\n</style>\n</head>\n<body>\n\n<section id=\"login\" class=\"hide\">\n  <form class=\"steel\" id=\"loginForm\">\n    <div class=\"mark\"><div class=\"bolt\"></div><div><h1>Upper Echelon</h1><small>Service desk</small></div></div>\n    <div class=\"field\"><label for=\"em\">Email</label><input id=\"em\" type=\"email\" autocomplete=\"username\" required></div>\n    <div class=\"field\"><label for=\"pw\">Password</label><input id=\"pw\" type=\"password\" autocomplete=\"current-password\" required></div>\n    <button class=\"btn\" style=\"width:100%\">Sign in</button>\n    <div id=\"loginErr\" class=\"err-text\"></div>\n  </form>\n</section>\n\n<div id=\"app\" class=\"hide\">\n  <nav id=\"nav\"></nav>\n  <main id=\"view\"></main>\n</div>\n\n<div id=\"drawer\" class=\"hide\"><div class=\"sheet\" id=\"sheet\" role=\"dialog\" aria-modal=\"true\"></div></div>\n<div id=\"toast\" class=\"hide\" role=\"status\"></div>\n\n<script>\n(function(){\n'use strict';\nvar API = location.pathname.replace(/\\/admin\\/?$/, '');\nvar TOKEN_KEY = 'uea_desk_token', ME_KEY = 'uea_desk_me';\nvar S = { tab:null, token:null, me:null, settings:null, prefill:null, jobsView:'board', methods:null };\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nfunction $(s, r){ return (r||document).querySelector(s); }\nfunction $$(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); }\nfunction esc(v){ return String(v == null ? '' : v).replace(/[&<>\"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]; }); }\nfunction usd(c){ return '$' + (Number(c||0)/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }\nfunction n(v){ return Number(v||0).toLocaleString(); }\nfunction when(d){ if(!d) return ''; var x=new Date(d); return x.toLocaleDateString(undefined,{month:'short',day:'numeric',year:x.getFullYear()!==new Date().getFullYear()?'numeric':undefined})+' '+x.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); }\nfunction dayLabel(iso){ if(!iso) return ''; var p=String(iso).slice(0,10).split('-'); var d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2])); return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}); }\nfunction signed(p){ p=Number(p); return '<span class=\"pts '+(p>=0?'plus':'minus')+'\">'+(p>=0?'+':'')+n(p)+'</span>'; }\nfunction telHref(p){ return 'tel:'+String(p||'').replace(/[^\\d+]/g,''); }\nfunction smsHref(p){ return 'sms:'+String(p||'').replace(/[^\\d+]/g,''); }\nfunction mapHref(a){ return 'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(a||''); }\nfunction dollars(c){ return c ? (Number(c)/100).toFixed(2) : ''; }\nfunction cents(v){ return Math.round((parseFloat(v)||0)*100); }\nfunction isRole(){ var r=S.me&&S.me.role; return Array.prototype.slice.call(arguments).indexOf(r)>-1; }\nvar DESK = function(){ return isRole('owner','writer'); };\nvar OWN = function(){ return isRole('owner'); };\nvar TYPE = {earn:'Service',welcome:'Welcome',referral:'Referral',review:'Review',redeem:'Redeemed',void:'Returned',adjust:'Adjustment',refund:'Refund',bonus:'Bonus',expire:'Expired'};\nvar STAGE_CHIP = {new:'gold',scheduled:'',en_route:'purple',on_site:'purple',waiting_approval:'warn',waiting_parts:'warn',in_progress:'purple',completed:'good'};\nvar STAGES = [['new','New'],['scheduled','Scheduled'],['en_route','On the way'],['on_site','On site'],['waiting_approval','Waiting on approval'],['waiting_parts','Waiting on parts'],['in_progress','Working'],['completed','Done, not paid']];\nfunction stageLabel(k){ for(var i=0;i<STAGES.length;i++) if(STAGES[i][0]===k) return STAGES[i][1]; return k; }\nfunction stageChip(j){\n  if(j.status==='paid') return '<span class=\"chip good\">Paid</span>';\n  if(j.status==='cancelled') return '<span class=\"chip bad\">Cancelled</span>';\n  return '<span class=\"chip '+(STAGE_CHIP[j.stage]||'')+'\">'+esc(stageLabel(j.stage))+'</span>';\n}\nfunction fe(f, n){ return f.querySelector('[name=\"'+n+'\"]'); }\nfunction fill(tpl, v){ return String(tpl||'').replace(/\\{(\\w+)\\}/g, function(m,k){ return v[k]!=null?String(v[k]):''; }).replace(/\\s{2,}/g,' ').trim(); }\n\nfunction toast(msg, err){\n  var t=$('#toast'); t.textContent=msg; t.className=err?'err':''; clearTimeout(t._h);\n  t._h=setTimeout(function(){ t.className='hide'; }, 3500);\n}\nfunction api(path, opts){\n  opts = opts || {};\n  return fetch(API + path, {\n    method: opts.method || 'GET',\n    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+(S.token||'') },\n    body: opts.body ? JSON.stringify(opts.body) : undefined\n  }).then(function(r){\n    return r.json().catch(function(){ return {}; }).then(function(d){\n      if (r.status===401 && path!=='/admin/login') { signOut(); throw new Error(d.error||'Signed out'); }\n      if (!r.ok) throw new Error(d.error || ('Request failed ('+r.status+')'));\n      return d;\n    });\n  });\n}\nfunction busy(btn, on, label){ if(!btn) return; if(on){ btn._t=btn.textContent; btn.disabled=true; btn.textContent=label||'Working\u2026'; } else { btn.disabled=false; if(btn._t) btn.textContent=btn._t; } }\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 auth \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nfunction signOut(){\n  try{ sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(ME_KEY); }catch(e){}\n  S.token=null; S.me=null; $('#drawer').classList.add('hide');\n  $('#app').classList.add('hide'); $('#login').classList.remove('hide'); $('#em').focus();\n}\n$('#loginForm').addEventListener('submit', function(e){\n  e.preventDefault(); $('#loginErr').textContent='';\n  var b=e.target.querySelector('button'); busy(b,true,'Signing in\u2026');\n  api('/admin/login',{method:'POST',body:{email:$('#em').value,password:$('#pw').value}}).then(function(d){\n    S.token=d.token; S.me=d.staff;\n    try{ sessionStorage.setItem(TOKEN_KEY,d.token); sessionStorage.setItem(ME_KEY,JSON.stringify(d.staff)); }catch(e){}\n    $('#pw').value=''; start();\n  }).catch(function(err){ $('#loginErr').textContent=err.message; }).then(function(){ busy(b,false); });\n});\n\nvar NAV = [\n  {grp:'Work'},\n  {tab:'today', label:function(){ return isRole('tech')?'My day':'Today'; }, roles:['owner','writer','tech']},\n  {tab:'jobs', label:function(){ return isRole('tech')?'My jobs':'Jobs'; }, roles:['owner','writer','tech'], count:'cJobs'},\n  {tab:'new', label:'New job', roles:['owner','writer']},\n  {tab:'guide', label:'Quotes & labor guide', roles:['owner','writer']},\n  {tab:'followups', label:'Follow-ups', roles:['owner','writer'], count:'cFollow'},\n  {grp:'Customers', roles:['owner','writer']},\n  {tab:'customers', label:'Customers', roles:['owner','writer']},\n  {tab:'vouchers', label:'Reward vouchers', roles:['owner','writer'], count:'cVouchers'},\n  {tab:'points', label:'Add points', roles:['owner']},\n  {grp:'Business', roles:['owner']},\n  {tab:'overview', label:'Overview', roles:['owner']},\n  {tab:'staff', label:'Team & access', roles:['owner']},\n  {tab:'settings', label:'Settings', roles:['owner']},\n  {grp:'You'},\n  {tab:'account', label:'My account', roles:['owner','writer','tech']}\n];\nfunction buildNav(){\n  var r=S.me.role, h='<div class=\"mark\"><div class=\"bolt\"></div><div><h1>Upper Echelon</h1><small>Service desk</small></div></div>';\n  NAV.forEach(function(it){\n    if(it.roles && it.roles.indexOf(r)<0) return;\n    if(it.grp){ h+='<div class=\"grp\">'+it.grp+'</div>'; return; }\n    var lab=typeof it.label==='function'?it.label():it.label;\n    h+='<button class=\"tab\" data-tab=\"'+it.tab+'\">'+esc(lab)+(it.count?' <span class=\"count hide\" id=\"'+it.count+'\"></span>':'')+'</button>';\n  });\n  h+='<div class=\"who\">'+esc(S.me.name)+'<br>'+esc({owner:'Owner',writer:'Service writer',tech:'Technician'}[r])+'</div>';\n  $('#nav').innerHTML=h;\n  $$('#nav .tab').forEach(function(b){ b.addEventListener('click', function(){ go(b.dataset.tab); }); });\n}\nfunction start(){\n  $('#login').classList.add('hide'); $('#app').classList.remove('hide');\n  buildNav(); go(S.tab||'today'); refreshCounts();\n  api('/admin/me').then(function(d){ S.me=d.staff; try{ sessionStorage.setItem(ME_KEY,JSON.stringify(d.staff)); }catch(e){} }).catch(function(){});\n}\nfunction setCount(id, v){ var el=$('#'+id); if(!el) return; el.textContent=v; el.classList.toggle('hide', !v); }\nfunction refreshCounts(){\n  api('/admin/jobs?view=open').then(function(d){ setCount('cJobs', d.jobs.length); }).catch(function(){});\n  if(DESK()){\n    api('/admin/followups').then(function(d){ setCount('cFollow', d.followups.filter(function(f){return f.due;}).length); }).catch(function(){});\n    api('/admin/vouchers?status=open').then(function(d){ setCount('cVouchers', d.vouchers.length); }).catch(function(){});\n  }\n}\nvar VIEWS = {};\nfunction go(tab){\n  var allowed=$$('#nav .tab').map(function(b){ return b.dataset.tab; });\n  if(allowed.indexOf(tab)<0) tab='today';\n  S.tab=tab; $$('#nav .tab').forEach(function(b){ b.classList.toggle('on', b.dataset.tab===tab); });\n  $('#view').innerHTML='<div class=\"empty\">Loading\u2026</div>';\n  VIEWS[tab]();\n}\nfunction fail(err){ $('#view').innerHTML='<div class=\"empty\">'+esc(err.message)+'</div>'; }\nfunction rerender(){ if(VIEWS[S.tab]) VIEWS[S.tab](); refreshCounts(); }\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 TODAY \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS.today = function(){\n  var tech=isRole('tech');\n  Promise.all([api('/admin/jobs?view=today'), DESK()?api('/admin/jobs?view=open'):Promise.resolve(null), DESK()?api('/admin/techs'):Promise.resolve({techs:[]})]).then(function(r){\n    var d=r[0], open=r[1], techs=r[2].techs, today=d.today;\n    var unsched = open ? open.jobs.filter(function(j){ return !j.sched_date; }) : [];\n    var waiting = open ? open.jobs.filter(function(j){ return j.stage==='waiting_approval'; }) : [];\n    var unpaid = open ? open.jobs.filter(function(j){ return j.stage==='completed'; }) : [];\n    var h='<h2>'+(tech?'My day':'Today')+'</h2><p class=\"dim\" style=\"margin:-.7rem 0 1rem\">'+dayLabel(today)+'</p>';\n    if(DESK()){\n      h+='<div class=\"grid g3\" style=\"margin-bottom:1rem\">'+\n        miniLink('Need scheduling', unsched.length, 'jobs')+miniLink('Waiting on customer approval', waiting.length, 'jobs')+miniLink('Done but not paid', unpaid.length, 'jobs')+'</div>';\n      if(techs.length) h+='<div class=\"row\" style=\"margin-bottom:.8rem\"><select id=\"tFilter\" style=\"width:auto\"><option value=\"\">Everyone</option><option value=\"none\">Unassigned</option>'+techs.map(function(t){return '<option value=\"'+t.id+'\">'+esc(t.name)+'</option>';}).join('')+'</select></div>';\n    }\n    h+='<div class=\"day\" id=\"dayList\"></div>';\n    $('#view').innerHTML=h;\n    $$('[data-goto]').forEach(function(b){ b.addEventListener('click', function(){ go(b.dataset.goto); }); });\n    function paint(filter){\n      var jobs=d.jobs.filter(function(j){ return !filter || (filter==='none'?!j.tech_id:j.tech_id===filter); });\n      $('#dayList').innerHTML = jobs.length ? jobs.map(function(j){\n        var late=j.sched_date && j.sched_date<today;\n        return '<div class=\"steel stop\"><div class=\"when\">'+esc(j.sched_window||'Any time')+(late?'<small style=\"color:var(--warn)\">From '+dayLabel(j.sched_date)+'</small>':'')+'</div>'+\n          '<div><div class=\"who\">'+esc(j.customer_name||'Customer')+' '+stageChip(j)+(j.rush?' <span class=\"chip bad\">Rush</span>':'')+'</div>'+\n          '<div>'+esc(j.service||'')+(j.vehicle?' <span class=\"dim\">on '+esc(j.vehicle)+'</span>':'')+'</div>'+\n          (j.address?'<div class=\"dim\" style=\"font-size:.88rem\">'+esc(j.address)+'</div>':'')+\n          (DESK()?'<div class=\"dim\" style=\"font-size:.85rem\">'+(j.tech?esc(j.tech.name):'<span style=\"color:var(--warn)\">Unassigned</span>')+'</div>':'')+'</div>'+\n          '<div class=\"acts\">'+(j.address?'<a class=\"btn ghost sm\" target=\"_blank\" rel=\"noopener\" href=\"'+mapHref(j.address)+'\">Navigate</a>':'')+\n          (j.phone?'<a class=\"btn ghost sm\" href=\"'+telHref(j.phone)+'\">Call</a>':'')+\n          '<button class=\"btn sm\" data-job=\"'+j.id+'\">Open job</button></div></div>';\n      }).join('') : '<div class=\"steel empty\">'+(tech?'Nothing assigned to you today.':'Nothing scheduled for today.')+(DESK()&&unsched.length?' <a href=\"#\" data-goto=\"jobs\">'+unsched.length+' job'+(unsched.length>1?'s':'')+' need scheduling.</a>':'')+'</div>';\n      $$('#dayList [data-job]').forEach(function(b){ b.addEventListener('click', function(){ openJob(b.dataset.job); }); });\n      $$('#dayList [data-goto]').forEach(function(b){ b.addEventListener('click', function(e){ e.preventDefault(); go(b.dataset.goto); }); });\n    }\n    paint('');\n    if($('#tFilter')) $('#tFilter').addEventListener('change', function(){ paint(this.value); });\n  }).catch(fail);\n};\nfunction miniLink(label, v, tab){ return '<button class=\"steel panel\" data-goto=\"'+tab+'\" style=\"text-align:left;cursor:pointer;color:var(--text)\"><div class=\"dim\" style=\"font-family:var(--head);font-size:.85rem\">'+label+'</div><div style=\"font-family:var(--display);font-size:2rem;line-height:1.1;color:'+(v?'var(--gold-hi)':'var(--text)')+'\">'+n(v)+'</div></button>'; }\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 JOBS BOARD \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS.jobs = function(){\n  var h='<h2>'+(isRole('tech')?'My jobs':'Jobs')+'</h2><div class=\"row\" style=\"margin-bottom:1rem\">'+\n    '<div class=\"row\" role=\"tablist\"><button class=\"btn sm '+(S.jobsView==='board'?'':'ghost')+'\" data-jv=\"board\">Open jobs</button><button class=\"btn sm '+(S.jobsView==='history'?'':'ghost')+'\" data-jv=\"history\">Paid & cancelled</button></div>'+\n    '<input id=\"jq\" placeholder=\"Search name, phone, VIN, order #, address\" style=\"flex:1;min-width:200px\">'+\n    (DESK()?'<select id=\"jt\" style=\"width:auto\"><option value=\"\">Everyone</option><option value=\"none\">Unassigned</option></select><button class=\"btn purple sm\" data-goto=\"new\">New job</button>':'')+\n    '</div><div id=\"jlist\"></div>';\n  $('#view').innerHTML=h;\n  $$('[data-jv]').forEach(function(b){ b.addEventListener('click', function(){ S.jobsView=b.dataset.jv; VIEWS.jobs(); }); });\n  $$('[data-goto]').forEach(function(b){ b.addEventListener('click', function(){ go(b.dataset.goto); }); });\n  if(DESK()) api('/admin/techs').then(function(d){ $('#jt').insertAdjacentHTML('beforeend', d.techs.map(function(t){return '<option value=\"'+t.id+'\">'+esc(t.name)+'</option>';}).join('')); });\n  var t; $('#jq').addEventListener('input', function(){ clearTimeout(t); t=setTimeout(loadJobs, 250); });\n  if($('#jt')) $('#jt').addEventListener('change', loadJobs);\n  loadJobs();\n};\nfunction loadJobs(){\n  var q=$('#jq').value, tech=$('#jt')?$('#jt').value:'';\n  var hist=S.jobsView==='history';\n  api('/admin/jobs?view='+(hist?'history':'open')+'&q='+encodeURIComponent(q)+'&tech='+encodeURIComponent(tech)).then(function(d){\n    if(hist){\n      $('#jlist').innerHTML = d.jobs.length ? '<div class=\"steel scroll\"><table><tr><th>Job</th><th>Customer</th><th>Service</th><th>Status</th></tr>'+d.jobs.map(function(j){\n        return '<tr class=\"click\" data-job=\"'+j.id+'\"><td><b style=\"font-family:var(--head)\">'+esc(j.order_name||'Phone job')+'</b><div class=\"dim\" style=\"font-size:.8rem\">'+when(j.paid_at||j.created_at)+'</div></td><td>'+esc(j.customer_name||j.email||'')+'</td><td>'+esc(j.service||'')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(j.vehicle||'')+'</div></td><td>'+stageChip(j)+(j.status==='paid'?'<div class=\"dim\" style=\"font-size:.82rem\">'+usd(j.total_cents)+'</div>':'')+'</td></tr>';\n      }).join('')+'</table></div>' : '<div class=\"steel empty\">No paid or cancelled jobs match.</div>';\n    } else {\n      var cols=STAGES.map(function(s){ return {k:s[0], l:s[1], jobs:d.jobs.filter(function(j){ return j.stage===s[0]; })}; });\n      if(isRole('tech')) cols=cols.filter(function(c){ return c.jobs.length || ['scheduled','on_site','in_progress'].indexOf(c.k)>-1; });\n      $('#jlist').innerHTML = '<div class=\"board\">'+cols.map(function(c){\n        return '<div class=\"col\"><h4><b>'+c.l+'</b><span>'+c.jobs.length+'</span></h4>'+(c.jobs.length?c.jobs.map(card).join(''):'<div class=\"dim\" style=\"font-size:.82rem;padding:.3rem\">None</div>')+'</div>';\n      }).join('')+'</div>';\n    }\n    $$('#jlist [data-job]').forEach(function(el){ el.addEventListener('click', function(){ openJob(el.dataset.job); }); });\n  }).catch(function(e){ $('#jlist').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\nfunction card(j){\n  var est=j.estimate&&j.estimate.lines&&j.estimate.lines.length;\n  return '<button class=\"card\" data-job=\"'+j.id+'\"><div class=\"t\">'+esc(j.customer_name||'Customer')+'</div>'+\n    '<div class=\"s\">'+esc(j.service||'No service listed')+(j.vehicle?'<br>'+esc(j.vehicle):'')+'</div>'+\n    '<div class=\"s\">'+(j.sched_date?dayLabel(j.sched_date)+(j.sched_window?', '+esc(j.sched_window):''):'<span style=\"color:var(--warn)\">Not scheduled</span>')+\n    (j.tech?' &middot; '+esc(j.tech.name):(DESK()?' &middot; <span style=\"color:var(--warn)\">No tech</span>':''))+'</div>'+\n    '<div class=\"f\">'+(j.order_name?'<span class=\"chip\">'+esc(j.order_name)+'</span>':'<span class=\"chip\">Phone</span>')+\n    (j.rush?'<span class=\"chip bad\">Rush</span>':'')+(j.voucher_code?'<span class=\"chip purple\">Reward</span>':'')+\n    (est?'<span class=\"chip gold\">Estimate</span>':'')+(j.member&&j.member.is_fleet?'<span class=\"chip\">Fleet</span>':'')+'</div></button>';\n}\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 JOB DRAWER \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nvar J = null; // current job payload\nfunction openJob(id, tab, preset){\n  var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide');\n  var keepTab = J && J.booking.id===id ? J.tab : null;\n  if(!keepTab) sh.innerHTML='<div class=\"empty\">Loading\u2026</div>';\n  api('/admin/booking/'+id).then(function(x){\n    J=x; J.tab = tab || keepTab || 'job'; J.preset = preset || null; S.methods=x.payment_methods;\n    renderJob();\n  }).catch(function(e){ sh.innerHTML='<div class=\"empty\">'+esc(e.message)+'</div><button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button>'; $('#closeDrawer').addEventListener('click', closeDrawer); });\n}\nfunction closeDrawer(){ $('#drawer').classList.add('hide'); J=null; rerender(); }\n$('#drawer').addEventListener('click', function(e){ if(e.target.id==='drawer') closeDrawer(); });\ndocument.addEventListener('keydown', function(e){ if(e.key==='Escape' && !$('#drawer').classList.contains('hide')) closeDrawer(); });\n\nfunction renderJob(){\n  var b=J.booking, open=b.status==='open';\n  var tabs=[['job','Job'],['estimate','Estimate'+(J.totals.pending&&b.estimate_token?' \u2022':'')],['texts','Texts'],['payment','Payment'],['history','Notes & history']];\n  if(isRole('tech')) tabs=tabs.filter(function(t){ return t[0]!=='payment'; });\n  var h='<div class=\"row\" style=\"justify-content:space-between;align-items:flex-start\"><div>'+\n      '<h2 style=\"margin:0 0 .3rem\">'+esc(b.customer_name||'Customer')+'</h2>'+\n      '<div class=\"row\" style=\"gap:.4rem\">'+stageChip(b)+(b.order_name?'<span class=\"chip\">'+esc(b.order_name)+'</span>':'<span class=\"chip\">Phone job</span>')+(b.rush?'<span class=\"chip bad\">Rush</span>':'')+\n      (J.tier&&!(J.member&&J.member.is_fleet)?'<span class=\"chip gold\">'+esc(J.tier.name)+' member</span>':'')+(J.member&&J.member.is_fleet?'<span class=\"chip\">Fleet</span>':'')+'</div></div>'+\n      '<button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button></div>';\n  if(open){\n    h+='<div class=\"row\" style=\"margin-top:.9rem;gap:.4rem\">'+\n      '<select id=\"stageSel\" style=\"width:auto\">'+STAGES.map(function(s){ return '<option value=\"'+s[0]+'\"'+(s[0]===b.stage?' selected':'')+'>'+s[1]+'</option>'; }).join('')+'</select>'+\n      (b.phone?'<a class=\"btn ghost sm\" href=\"'+telHref(b.phone)+'\">Call</a>':'')+\n      (b.address?'<a class=\"btn ghost sm\" target=\"_blank\" rel=\"noopener\" href=\"'+mapHref(b.address)+'\">Navigate</a>':'')+\n      (['new','scheduled'].indexOf(b.stage)>-1&&b.phone?'<button class=\"btn purple sm\" data-quick=\"onway\">On my way</button>':'')+\n      (['en_route','scheduled'].indexOf(b.stage)>-1?'<button class=\"btn ghost sm\" data-quick=\"arrived\">Arrived</button>':'')+\n      (['on_site','in_progress','waiting_parts'].indexOf(b.stage)>-1?'<button class=\"btn sm\" data-quick=\"done\">Work done</button>':'')+\n      '</div>';\n  }\n  h+='<div class=\"dtabs\">'+tabs.map(function(t){ return '<button data-dt=\"'+t[0]+'\" class=\"'+(J.tab===t[0]?'on':'')+'\">'+t[1]+'</button>'; }).join('')+'</div><div id=\"dbody\"></div>';\n  $('#sheet').innerHTML=h;\n  $('#closeDrawer').addEventListener('click', closeDrawer);\n  $$('[data-dt]').forEach(function(t){ t.addEventListener('click', function(){ J.tab=t.dataset.dt; renderJob(); }); });\n  if($('#stageSel')) $('#stageSel').addEventListener('change', function(){ patchJob({stage:this.value}, 'Stage updated'); });\n  $$('[data-quick]').forEach(function(btn){ btn.addEventListener('click', function(){\n    var q=btn.dataset.quick;\n    if(q==='onway'){ J.tab='texts'; J.preset='on_way'; renderJob(); return; }\n    if(q==='arrived') patchJob({stage:'on_site'}, 'Marked on site');\n    if(q==='done') patchJob({stage:'completed'}, 'Marked done. '+(DESK()?'Next: payment.':'The desk will collect payment.'));\n  }); });\n  ({job:tabJob,estimate:tabEstimate,texts:tabTexts,payment:tabPayment,history:tabHistory})[J.tab]();\n  $('#sheet').scrollTop=0;\n}\nfunction patchJob(body, msg){\n  return api('/admin/booking/'+J.booking.id,{method:'PATCH',body:body}).then(function(){ toast(msg||'Saved'); openJob(J.booking.id); }).catch(function(e){ toast(e.message,true); openJob(J.booking.id); });\n}\n\n/* Job tab */\nfunction tabJob(){\n  var b=J.booking, open=b.status==='open', desk=DESK();\n  var dis=function(deskOnly){ return (!open && deskOnly!=='always') || (deskOnly===true && !desk) ? ' disabled' : ''; };\n  var details=(b.details||[]).filter(function(p){ return p.value && !/^(rewards member|reward voucher)$/i.test(p.name); });\n  var h='<form id=\"jobForm\">';\n  h+='<div class=\"steel panel sec\"><h3>Customer</h3><div class=\"grid g2\">'+\n    fld('Name','customer_name',b.customer_name,dis(true))+fld('Phone','phone',b.phone,dis(true),'tel')+\n    fld('Email','email',b.email,dis(true),'email')+fld('Service address','address',b.address,dis(true))+'</div>'+\n    (J.member?'<div class=\"dim\" style=\"font-size:.88rem\">'+(J.member.is_fleet?'Fleet account. ':(J.tier?esc(J.tier.name)+' member, ':'')+n(J.member.points_balance)+' points. ')+(desk?'<a href=\"#\" id=\"toMember\">Open customer</a>':'')+'</div>':'<div class=\"dim\" style=\"font-size:.88rem\">Not a rewards member'+(b.email?' yet.':'. Add an email to give them points.')+'</div>')+\n    (J.voucher&&['active','applied'].indexOf(J.voucher.status)>-1?'<div style=\"margin-top:.5rem\"><span class=\"chip purple\">Reward attached</span> '+esc(J.voucher.reward_name)+' ('+esc(J.voucher.code)+'). Add it as a discount line on the estimate.</div>':'')+\n    '</div>';\n  h+='<div class=\"steel panel sec\"><h3>Schedule</h3><div class=\"grid g3\">'+\n    '<div class=\"field\"><label>Date</label><input type=\"date\" name=\"sched_date\" value=\"'+esc(b.sched_date||'')+'\"'+dis(true)+'></div>'+\n    '<div class=\"field\"><label>Time window</label><select name=\"sched_window\"'+dis(true)+'><option value=\"\">Choose</option>'+\n      (J.shop.time_windows||[]).concat(b.sched_window&&(J.shop.time_windows||[]).indexOf(b.sched_window)<0?[b.sched_window]:[]).map(function(w){ return '<option'+(w===b.sched_window?' selected':'')+'>'+esc(w)+'</option>'; }).join('')+'</select></div>'+\n    '<div class=\"field\"><label>Technician</label><select name=\"tech_id\"'+dis(true)+'><option value=\"\">Unassigned</option>'+\n      (J.techs||[]).map(function(t){ return '<option value=\"'+t.id+'\"'+(t.id===b.tech_id?' selected':'')+'>'+esc(t.name)+'</option>'; }).join('')+\n      (!desk&&b.tech_id?'<option selected>You</option>':'')+'</select></div></div>'+\n    (desk?'<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" name=\"rush\"'+(b.rush?' checked':'')+dis(true)+'> Rush / emergency</label>':'')+'</div>';\n  h+='<div class=\"steel panel sec\"><h3>Vehicle</h3><div class=\"grid g2\">'+\n    fld('Year, make, model','vehicle',b.vehicle,dis(true))+\n    '<div class=\"field\"><label>VIN</label><div class=\"row\" style=\"flex-wrap:nowrap\"><input name=\"vin\" value=\"'+esc(b.vin||'')+'\" maxlength=\"17\" style=\"text-transform:uppercase\"'+dis()+'>'+(open?'<button type=\"button\" class=\"btn ghost sm\" id=\"vinDecode\">Decode</button>':'')+'</div></div>'+\n    fld('Mileage','mileage',b.mileage,dis(),'text','numeric')+fld('Plate','plate',b.plate,dis())+'</div></div>';\n  h+='<div class=\"steel panel sec\"><h3>Concern and findings</h3>'+\n    '<div class=\"field\"><label>Customer concern</label><textarea name=\"concern\" rows=\"2\"'+dis(true)+'>'+esc(b.concern||'')+'</textarea></div>'+\n    '<div class=\"field\"><label>Technician findings</label><textarea name=\"findings\" rows=\"3\" placeholder=\"What you tested, what you found, readings, codes\"'+dis()+'>'+esc(b.findings||'')+'</textarea><div class=\"help\">Customers see findings on their estimate approval page.</div></div>'+\n    (desk?'<div class=\"field\"><label>Internal note (staff only)</label><input name=\"admin_note\" value=\"'+esc(b.admin_note||'')+'\"'+dis(true)+'></div>':'')+'</div>';\n  if(open) h+='<div class=\"row sec\"><button class=\"btn\">Save changes</button>'+(desk?'<button type=\"button\" class=\"btn danger sm\" id=\"cancelJob\">Cancel job</button>':'')+'</div>';\n  h+='</form>';\n  if(details.length) h+='<div class=\"steel panel sec\"><h3>From the website booking</h3><div class=\"kv\">'+details.map(function(p){ return '<dt>'+esc(p.name)+'</dt><dd>'+esc(p.value)+'</dd>'; }).join('')+'</div></div>';\n  if(J.history&&J.history.length) h+='<div class=\"steel panel sec\"><h3>Earlier jobs for this customer</h3><table>'+J.history.map(function(x){\n    return '<tr class=\"click\" data-job=\"'+x.id+'\"><td class=\"dim\" style=\"white-space:nowrap\">'+dayLabel((x.paid_at||x.created_at||'').slice(0,10))+'</td><td>'+esc(x.service||'')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(x.vehicle||'')+(x.mileage?', '+n(x.mileage)+' mi':'')+'</div></td><td>'+stageChip(x)+'</td></tr>';\n  }).join('')+'</table></div>';\n  $('#dbody').innerHTML=h;\n  $$('#dbody tr[data-job]').forEach(function(tr){ tr.addEventListener('click', function(){ J.tab='job'; openJob(tr.dataset.job); }); });\n  if($('#toMember')) $('#toMember').addEventListener('click', function(e){ e.preventDefault(); openMember(J.member.id); });\n  if($('#vinDecode')) $('#vinDecode').addEventListener('click', function(){ decodeVin(fe($('#jobForm'),'vin'), fe($('#jobForm'),'vehicle')); });\n  if($('#cancelJob')) $('#cancelJob').addEventListener('click', function(){\n    var reason=prompt('Cancel this job? Add a reason (optional):',''); if(reason===null) return;\n    api('/admin/booking/'+b.id+'/cancel',{method:'POST',body:{reason:reason}}).then(function(){ toast('Job cancelled'); openJob(b.id); }).catch(function(e){ toast(e.message,true); });\n  });\n  $('#jobForm').addEventListener('submit', function(e){\n    e.preventDefault(); var f=e.target, body={};\n    ['customer_name','phone','email','address','vehicle','vin','mileage','plate','concern','findings','admin_note','sched_date','sched_window','tech_id'].forEach(function(k){\n      if(fe(f,k) && !fe(f,k).disabled && fe(f,k).value!==(J.booking[k]==null?'':String(J.booking[k]))) body[k]=fe(f,k).value;\n    });\n    if(fe(f,'rush') && !fe(f,'rush').disabled && fe(f,'rush').checked!==!!J.booking.rush) body.rush=fe(f,'rush').checked;\n    if(!Object.keys(body).length) return toast('Nothing changed');\n    patchJob(body,'Job saved');\n  });\n}\nfunction fld(label, name, val, dis, type, mode){ return '<div class=\"field\"><label>'+label+'</label><input name=\"'+name+'\" type=\"'+(type||'text')+'\"'+(mode?' inputmode=\"'+mode+'\"':'')+' value=\"'+esc(val==null?'':val)+'\"'+(dis||'')+'></div>'; }\nfunction decodeVin(vinInput, vehInput){\n  var vin=(vinInput.value||'').toUpperCase().trim();\n  if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return toast('Enter the full 17-character VIN first', true);\n  toast('Decoding VIN\u2026');\n  fetch('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/'+vin+'?format=json').then(function(r){ return r.json(); }).then(function(d){\n    var r=d.Results&&d.Results[0]; if(!r||!r.Make) throw new Error('VIN not recognized');\n    var tc=function(s){ return String(s||'').toLowerCase().replace(/\\b\\w/g,function(c){return c.toUpperCase();}); };\n    var eng=r.DisplacementL?(Math.round(parseFloat(r.DisplacementL)*10)/10)+'L':'';\n    var v=[r.ModelYear, tc(r.Make), r.Model, r.Trim, eng].filter(Boolean).join(' ');\n    if(vehInput && !vehInput.disabled) vehInput.value=v;\n    vinInput.value=vin; toast('Decoded: '+v);\n  }).catch(function(e){ toast('Could not decode: '+e.message, true); });\n}\n\n/* Estimate tab */\nfunction tabEstimate(){\n  var b=J.booking, open=b.status==='open', canEdit=open&&(DESK()||J.shop.tech_can_estimate);\n  var est=b.estimate||{lines:[],notes:''};\n  J.lines=JSON.parse(JSON.stringify(est.lines||[]));\n  var h='';\n  if(!canEdit && !J.lines.length){ $('#dbody').innerHTML='<div class=\"steel empty\">No estimate on this job'+(open?'. The service desk builds estimates.':'.')+'</div>'; return; }\n  h+='<div class=\"steel panel sec\"><div class=\"row\" style=\"justify-content:space-between\"><h3 style=\"margin:0\">Lines</h3>'+\n     (canEdit?'<div class=\"row\" style=\"gap:.3rem\"><button class=\"btn sm\" id=\"fromGuide\">+ From guide</button><button class=\"btn ghost sm\" data-add=\"labor\">+ Labor</button><button class=\"btn ghost sm\" data-add=\"part\">+ Part</button><button class=\"btn ghost sm\" data-add=\"fee\">+ Fee</button><button class=\"btn ghost sm\" data-add=\"discount\">+ Discount</button></div>':'')+\n     '</div><div id=\"estPick\"></div><div class=\"scroll\"><table class=\"est\" style=\"margin-top:.6rem\"><tbody id=\"estRows\"></tbody></table></div>'+\n     (canEdit?'<div class=\"help\">Labor: quantity is hours. Parts: enter your cost and press % to apply your '+(J.shop.parts_markup_pct||0)+'% markup, or type the price. Lines start as \"Waiting\"; the customer approves them online, or you can set them yourself after a phone OK.</div>':'')+\n     '</div>';\n  h+='<div class=\"totals sec\" id=\"estTotals\"></div>';\n  h+='<div class=\"steel panel sec\"><div class=\"field\"><label>Note to customer (shows on their estimate)</label><textarea id=\"estNotes\" rows=\"2\"'+(canEdit?'':' disabled')+'>'+esc(est.notes||'')+'</textarea></div>'+\n     (canEdit?'<div class=\"row\"><button class=\"btn\" id=\"estSave\">Save estimate</button><button class=\"btn purple\" id=\"estText\"'+(b.phone?'':' disabled title=\"No phone number on this job\"')+'>Save and text to customer</button><button class=\"btn ghost sm\" id=\"estLink\">Get link</button></div>':'')+\n     '<div id=\"estLinkOut\" class=\"help\" style=\"margin-top:.6rem\">'+(J.estimate_link?'Customer link: <a href=\"'+esc(J.estimate_link)+'\" target=\"_blank\" rel=\"noopener\">'+esc(J.estimate_link)+'</a>'+(est.sent_at?' (sent '+when(est.sent_at)+')':''):'')+'</div></div>';\n  var auths=est.authorizations||[];\n  if(auths.length) h+='<div class=\"steel panel sec\"><h3>Customer authorizations</h3>'+auths.slice().reverse().map(function(a){\n    return '<div class=\"ev\"><div class=\"k\">'+when(a.at)+'</div><div><b>'+esc(a.name)+'</b> approved '+esc((a.approved||[]).join(', ')||'nothing')+(a.declined&&a.declined.length?'; declined '+esc(a.declined.join(', ')):'')+'. Total '+usd(a.approved_total_cents)+'<div class=\"dim\" style=\"font-size:.78rem\">IP '+esc(a.ip||'')+'</div></div></div>';\n  }).join('')+'</div>';\n  $('#dbody').innerHTML=h;\n  paintLines(canEdit);\n  if(canEdit){\n    $('#fromGuide').addEventListener('click', function(){\n      guidePicker($('#estPick'), {vehicle:function(){ return J.booking.vehicle||''; }, rate:J.shop.labor_rate_cents, markup:J.shop.parts_markup_pct,\n        onAdd:function(lines, r){ J.lines=J.lines.concat(lines); paintLines(true); toast('Added '+r.name+'. Save the estimate when done.'); }});\n    });\n    $$('[data-add]').forEach(function(btn){ btn.addEventListener('click', function(){\n      var t=btn.dataset.add, l={id:'',type:t,desc:'',qty:1,unit_cents:0,status:'pending'};\n      if(t==='labor'){ l.unit_cents=J.shop.labor_rate_cents||0; }\n      if(t==='discount'&&J.voucher&&['active','applied'].indexOf(J.voucher.status)>-1){ l.desc='Reward '+J.voucher.code+': '+J.voucher.reward_name; l.unit_cents=J.voucher.value_cents; l.status='approved'; }\n      if(t==='discount') l.status='approved';\n      J.lines.push(l); paintLines(true);\n      var rows=$$('#estRows input[data-f=\"desc\"]'); if(rows.length) rows[rows.length-1].focus();\n    }); });\n    $('#estSave').addEventListener('click', function(){ saveEstimate().then(function(){ toast('Estimate saved'); openJob(b.id,'estimate'); }).catch(function(e){ toast(e.message,true); }); });\n    $('#estText').addEventListener('click', function(){\n      var btn=this; busy(btn,true,'Sending\u2026');\n      saveEstimate().then(function(){ return api('/admin/booking/'+b.id+'/estimate/send',{method:'POST',body:{via:'sms'}}); })\n        .then(function(){ toast('Estimate texted to '+(b.customer_name||'customer')); openJob(b.id,'estimate'); })\n        .catch(function(e){ toast(e.message,true); busy(btn,false); });\n    });\n    $('#estLink').addEventListener('click', function(){\n      saveEstimate().then(function(){ return api('/admin/booking/'+b.id+'/estimate/send',{method:'POST',body:{via:'link'}}); })\n        .then(function(r){ $('#estLinkOut').innerHTML='Customer link: <a href=\"'+esc(r.link)+'\" target=\"_blank\" rel=\"noopener\">'+esc(r.link)+'</a>';\n          if(navigator.clipboard) navigator.clipboard.writeText(r.link).then(function(){ toast('Link copied'); }).catch(function(){}); })\n        .catch(function(e){ toast(e.message,true); });\n    });\n  }\n}\nfunction paintLines(canEdit){\n  var dis=canEdit?'':' disabled';\n  var tl={labor:'Labor',part:'Part',fee:'Fee',discount:'Discount'};\n  $('#estRows').innerHTML = J.lines.length ? '<tr><th style=\"width:92px\">Type</th><th>Description</th><th style=\"width:72px\">Qty / hrs</th><th style=\"width:100px\">Price each</th><th style=\"width:96px\">Amount</th><th style=\"width:120px\">Status</th><th style=\"width:34px\"></th></tr>'+\n    J.lines.map(function(l,i){\n      var amt=Math.round((Number(l.qty)||0)*(Number(l.unit_cents)||0));\n      return '<tr><td><select data-i=\"'+i+'\" data-f=\"type\"'+dis+'>'+['labor','part','fee','discount'].map(function(t){ return '<option value=\"'+t+'\"'+(t===l.type?' selected':'')+'>'+tl[t]+'</option>'; }).join('')+'</select></td>'+\n        '<td><input data-i=\"'+i+'\" data-f=\"desc\" value=\"'+esc(l.desc)+'\" placeholder=\"'+(l.type==='part'?'Part name':'Description')+'\"'+dis+'>'+\n          (l.type==='part'?'<div class=\"row\" style=\"gap:.3rem;margin-top:.3rem;flex-wrap:nowrap\"><input data-i=\"'+i+'\" data-f=\"part_no\" value=\"'+esc(l.part_no||'')+'\" placeholder=\"Part #\" style=\"max-width:120px\"'+dis+'><input data-i=\"'+i+'\" data-f=\"cost\" value=\"'+dollars(l.cost_cents)+'\" placeholder=\"Cost $\" inputmode=\"decimal\" style=\"max-width:90px\"'+dis+'>'+(canEdit?'<button type=\"button\" class=\"btn ghost sm\" data-markup=\"'+i+'\" title=\"Apply markup\">%</button>':'')+'</div>':'')+'</td>'+\n        '<td><input data-i=\"'+i+'\" data-f=\"qty\" value=\"'+esc(l.qty)+'\" inputmode=\"decimal\"'+dis+'>'+(canEdit&&DESK()&&l.type==='labor'&&l.guide_id?'<button type=\"button\" class=\"btn ghost sm\" data-savetime=\"'+i+'\" title=\"Use this time next time you quote this vehicle\" style=\"margin-top:.3rem;font-size:.72rem;padding:.15rem .4rem\">Save for this vehicle</button>':'')+'</td>'+\n        '<td><input data-i=\"'+i+'\" data-f=\"unit\" value=\"'+dollars(l.unit_cents)+'\" inputmode=\"decimal\" placeholder=\"0.00\"'+dis+'></td>'+\n        '<td class=\"amt\">'+(l.type==='discount'?'\u2212':'')+usd(amt)+'</td>'+\n        '<td>'+(l.type==='discount'?'<span class=\"chip good\">Applied</span>':'<select data-i=\"'+i+'\" data-f=\"status\"'+dis+'>'+[['pending','Waiting'],['approved','Approved'],['declined','Declined']].map(function(s){ return '<option value=\"'+s[0]+'\"'+(s[0]===(l.status||'pending')?' selected':'')+'>'+s[1]+'</option>'; }).join('')+'</select>')+'</td>'+\n        '<td>'+(canEdit?'<button type=\"button\" class=\"btn danger sm\" data-del=\"'+i+'\" aria-label=\"Remove line\">\u00d7</button>':'')+'</td></tr>';\n    }).join('') : '<tr><td class=\"dim\" style=\"padding:1rem 0\">No lines yet. Add labor, parts, or fees.</td></tr>';\n  $$('#estRows [data-f]').forEach(function(inp){ inp.addEventListener('change', function(){\n    var l=J.lines[+inp.dataset.i], f=inp.dataset.f;\n    if(f==='type'){ l.type=inp.value; if(l.type==='discount') l.status='approved'; paintLines(canEdit); return; }\n    if(f==='desc') l.desc=inp.value;\n    if(f==='part_no') l.part_no=inp.value;\n    if(f==='qty') l.qty=parseFloat(inp.value)||0;\n    if(f==='unit') l.unit_cents=cents(inp.value);\n    if(f==='cost') l.cost_cents=inp.value===''?null:cents(inp.value);\n    if(f==='status') l.status=inp.value;\n    if(f!=='desc'&&f!=='part_no') paintLines(canEdit); else paintTotals();\n  }); });\n  $$('#estRows [data-savetime]').forEach(function(btn){ btn.addEventListener('click', function(){\n    var l=J.lines[+btn.dataset.savetime];\n    if(!J.booking.vehicle) return toast('Add the vehicle on the Job tab first', true);\n    api('/admin/guide/job/'+encodeURIComponent(l.guide_id)+'/save-vehicle-time',{method:'POST',body:{vehicle:J.booking.vehicle,labor_hours:l.qty}})\n      .then(function(r){ toast('Saved '+l.qty+' hr for '+r.label); }).catch(function(e){ toast(e.message,true); });\n  }); });\n  $$('#estRows [data-del]').forEach(function(btn){ btn.addEventListener('click', function(){ J.lines.splice(+btn.dataset.del,1); paintLines(canEdit); }); });\n  $$('#estRows [data-markup]').forEach(function(btn){ btn.addEventListener('click', function(){\n    var l=J.lines[+btn.dataset.markup]; if(!l.cost_cents) return toast('Enter the part cost first', true);\n    l.unit_cents=Math.round(l.cost_cents*(1+(Number(J.shop.parts_markup_pct)||0)/100)); paintLines(canEdit);\n  }); });\n  paintTotals();\n}\nfunction calcTotals(lines, keep){\n  var t={labor:0,parts:0,fees:0,discount:0};\n  lines.forEach(function(l){ if(!keep(l)) return; var a=Math.round((Number(l.qty)||0)*(Number(l.unit_cents)||0));\n    if(l.type==='labor') t.labor+=a; else if(l.type==='part') t.parts+=a; else if(l.type==='fee') t.fees+=a; else t.discount+=a; });\n  t.tax=Math.round(t.parts*(Number(J.shop.parts_tax_rate)||0)/100); t.total=Math.max(0,t.labor+t.parts+t.fees-t.discount)+t.tax;\n  var cost=0, hasCost=false; lines.forEach(function(l){ if(keep(l)&&l.type==='part'&&l.cost_cents!=null){ cost+=Math.round((Number(l.qty)||0)*l.cost_cents); hasCost=true; } });\n  t.partsProfit=hasCost?t.parts-cost:null; return t;\n}\nfunction paintTotals(){\n  var q=calcTotals(J.lines,function(l){ return l.status!=='declined'; }), a=calcTotals(J.lines,function(l){ return l.type==='discount'||l.status==='approved'; });\n  var tbl=function(t,title){ return '<div class=\"steel panel\"><h3>'+title+'</h3><table><tr><td>Labor</td><td style=\"text-align:right\">'+usd(t.labor)+'</td></tr><tr><td>Parts</td><td style=\"text-align:right\">'+usd(t.parts)+'</td></tr>'+\n    (t.fees?'<tr><td>Fees</td><td style=\"text-align:right\">'+usd(t.fees)+'</td></tr>':'')+(t.discount?'<tr><td>Discounts</td><td style=\"text-align:right\">\u2212'+usd(t.discount)+'</td></tr>':'')+\n    '<tr><td>Tax on parts ('+(J.shop.parts_tax_rate||0)+'%)</td><td style=\"text-align:right\">'+usd(t.tax)+'</td></tr><tr class=\"big\"><td>Total</td><td style=\"text-align:right\">'+usd(t.total)+'</td></tr>'+\n    (DESK()&&t.partsProfit!=null?'<tr><td class=\"dim\" style=\"font-size:.82rem\">Parts profit (staff only)</td><td class=\"dim\" style=\"text-align:right;font-size:.82rem\">'+usd(t.partsProfit)+'</td></tr>':'')+'</table></div>'; };\n  $('#estTotals').innerHTML=tbl(q,'Quoted (not declined)')+tbl(a,'Approved so far');\n}\nfunction saveEstimate(){\n  var bad=J.lines.filter(function(l){ return !String(l.desc||'').trim(); });\n  if(bad.length) return Promise.reject(new Error('Every line needs a description.'));\n  return api('/admin/booking/'+J.booking.id+'/estimate',{method:'PUT',body:{lines:J.lines,notes:$('#estNotes').value}});\n}\n\n/* Texts tab */\nvar TEMPLATES=[['confirm','Confirm appointment'],['on_way','On my way'],['estimate','Estimate ready'],['complete','Job done + payment link'],['review','Ask for a review'],['follow_up','Recommended work follow-up']];\nfunction tabTexts(){\n  var b=J.booking, v=J.sms_vars, tpls=J.shop.sms_templates||{};\n  var sent=(J.events||[]).filter(function(e){ return e.kind==='sms'; });\n  var h='';\n  if(!J.sms_ready) h+='<div class=\"steel panel sec\" style=\"border-color:var(--warn)\">Texting isn\\'t connected yet. Add <b>TEXTBELT_KEY</b> on Render to send texts from here. Until then, use <a href=\"'+smsHref(b.phone)+'\">your phone</a>.</div>';\n  if(!b.phone) h+='<div class=\"steel panel sec\" style=\"border-color:var(--warn)\">No phone number on this job. Add one on the Job tab.</div>';\n  h+='<div class=\"steel panel sec\"><h3>Send a text to '+esc(b.customer_name||'customer')+(b.phone?' <span class=\"dim\">('+esc(b.phone)+')</span>':'')+'</h3>'+\n    '<div class=\"row\" style=\"gap:.35rem;margin-bottom:.7rem\">'+TEMPLATES.map(function(t){ return '<button type=\"button\" class=\"btn ghost sm\" data-tpl=\"'+t[0]+'\">'+t[1]+'</button>'; }).join('')+'</div>'+\n    '<div id=\"etaRow\" class=\"field hide\"><label>Arrival time to tell them</label><input id=\"eta\" placeholder=\"e.g. 20 minutes, or 10:45 AM\"></div>'+\n    '<textarea id=\"smsText\" rows=\"4\" placeholder=\"Pick a template or write your own message\"></textarea>'+\n    '<div class=\"row\" style=\"justify-content:space-between;margin-top:.5rem\"><span class=\"help\" id=\"smsCount\"></span><button class=\"btn\" id=\"smsSend\"'+(b.phone&&J.sms_ready?'':' disabled')+'>Send text</button></div></div>';\n  h+='<div class=\"steel panel\"><h3>Texts sent</h3>'+(sent.length?sent.map(function(e){ return '<div class=\"ev\"><div class=\"k\">'+when(e.at)+'<br>'+esc(e.by_name||'')+'</div><div>'+esc(e.text)+'</div></div>'; }).join(''):'<div class=\"dim\">No texts sent from the portal yet.</div>')+'</div>';\n  $('#dbody').innerHTML=h;\n  var kind=null;\n  function setTpl(k){\n    kind=k; $('#etaRow').classList.toggle('hide', k!=='on_way');\n    var vars=Object.assign({}, v, {eta: $('#eta').value || '[arrival time]'});\n    if(k==='estimate' && !J.estimate_link){ vars.estimate_link='[link is created when you send]'; }\n    if(k==='complete' && !J.shop.payment_link) toast('Add your payment portal link in Settings so it appears in this text', true);\n    $('#smsText').value=fill(tpls[k], vars); count();\n  }\n  function count(){ var l=$('#smsText').value.length; $('#smsCount').textContent=l+' characters'+(l>160?' (sends as '+Math.ceil(l/153)+' texts)':''); }\n  $$('[data-tpl]').forEach(function(btn){ btn.addEventListener('click', function(){ setTpl(btn.dataset.tpl); }); });\n  $('#eta').addEventListener('input', function(){ if(kind==='on_way') setTpl('on_way'); });\n  $('#smsText').addEventListener('input', count);\n  if(J.preset){ setTpl(J.preset); J.preset=null; if(kind==='on_way') $('#eta').focus(); }\n  $('#smsSend').addEventListener('click', function(){\n    var text=$('#smsText').value.trim(), btn=this;\n    if(!text) return toast('Write a message first', true);\n    if(/\\[arrival time\\]|\\[link is created/.test(text)) return toast(kind==='on_way'?'Enter the arrival time first':'Send estimates from the Estimate tab', true);\n    if(kind==='estimate'){ busy(btn,true,'Sending\u2026'); api('/admin/booking/'+b.id+'/estimate/send',{method:'POST',body:{via:'sms',text:J.estimate_link?text:null}}).then(function(){ toast('Estimate texted'); openJob(b.id,'texts'); }).catch(function(e){ toast(e.message,true); busy(btn,false); }); return; }\n    busy(btn,true,'Sending\u2026');\n    api('/admin/booking/'+b.id+'/sms',{method:'POST',body:{text:text,kind:kind}}).then(function(){ toast('Text sent'); openJob(b.id,'texts'); }).catch(function(e){ toast(e.message,true); busy(btn,false); });\n  });\n}\n\n/* Payment tab */\nfunction tabPayment(){\n  var b=J.booking, v=J.voucher, h='';\n  if(b.status==='open'){\n    var a=J.totals.approved, q=J.totals.quoted, useA=a.pay_labor+a.pay_parts>0;\n    var lab=useA?a.pay_labor:q.pay_labor, par=useA?a.pay_parts:q.pay_parts;\n    var vnote=v?(['active','applied'].indexOf(v.status)>-1?'<b>'+esc(v.reward_name)+'</b> ('+usd(v.value_cents)+'). Make sure it\\'s on the estimate as a discount.':'Voucher '+esc(v.code)+' is '+esc(v.status)+' and can\\'t be used.'):'';\n    h+='<form id=\"payForm\" class=\"steel panel sec\" style=\"border-color:var(--gold-lo)\"><h3>Mark as paid</h3>'+\n      (lab+par>0?'<div class=\"help\" style=\"margin:-.4rem 0 .8rem\">Filled in from the '+(useA?'approved':'quoted')+' estimate. Change it if the final charge was different.</div>':'')+\n      '<div class=\"grid g2\"><div class=\"field\"><label>Labor and fees charged ($)</label><input name=\"labor\" type=\"number\" step=\"0.01\" min=\"0\" inputmode=\"decimal\" value=\"'+dollars(lab)+'\"></div>'+\n      '<div class=\"field\"><label>Parts charged ($)</label><input name=\"parts\" type=\"number\" step=\"0.01\" min=\"0\" inputmode=\"decimal\" value=\"'+dollars(par)+'\"></div></div>'+\n      '<div class=\"help\" style=\"margin:-.5rem 0 .9rem\">Before tax, after any discount. Points: '+J.rates.labor+' per $1 labor, '+J.rates.parts+' per $1 parts, times their tier. Book-ahead and slow-day bonuses are added automatically.</div>'+\n      '<div class=\"grid g2\"><div class=\"field\"><label>Paid by</label><select name=\"method\">'+J.payment_methods.map(function(o){return '<option>'+esc(o)+'</option>';}).join('')+'</select></div>'+\n      '<div class=\"field\"><label>Receipt or transaction #</label><input name=\"reference\" placeholder=\"From your card portal\"></div></div>'+\n      '<div class=\"field\"><label>Reward voucher used</label><input name=\"voucher_code\" value=\"'+esc(b.voucher_code||'')+'\" placeholder=\"UER-XXXXXX (leave blank if none)\" style=\"text-transform:uppercase\">'+(vnote?'<div class=\"help\">'+vnote+'</div>':'')+'</div>'+\n      '<div class=\"row\"><button class=\"btn\">Mark paid</button><span id=\"payPts\" class=\"dim\"></span></div><div id=\"payErr\" class=\"err-text\"></div></form>'+\n      '<div class=\"steel panel\"><h3>Collecting payment</h3><p class=\"dim\" style=\"margin:0 0 .6rem\">Text the customer the total and your payment link, then mark it paid here once the charge goes through.</p><button class=\"btn ghost sm\" id=\"toComplete\">Text \"Job done + payment link\"</button></div>';\n  } else if(b.status==='paid'){\n    h+='<div class=\"steel panel sec\"><h3>Paid '+usd(b.total_cents)+'</h3><div>Labor and fees '+usd(b.labor_cents)+', parts '+usd(b.parts_cents)+'</div>'+\n      '<div class=\"dim\">'+esc(b.payment_method||'')+(b.payment_ref?', #'+esc(b.payment_ref):'')+', '+when(b.paid_at)+'</div>'+\n      (b.voucher_used?'<div class=\"dim\">Voucher '+esc(b.voucher_used)+' used</div>':'')+\n      '<div style=\"margin-top:.4rem\">'+(b.points_awarded!=null?'<span class=\"plus pts\">+'+n(b.points_awarded)+' points</span> awarded':'No points awarded')+'</div></div>'+\n      (OWN()?'<button class=\"btn danger sm\" id=\"bReopen\">Undo payment</button><div class=\"help\">Takes the points back and reopens the job.</div>':'<div class=\"help\">Only the owner can undo a payment.</div>');\n  } else {\n    h+='<div class=\"steel panel\">This job was cancelled. <button class=\"btn ghost sm\" id=\"bRestore\">Restore job</button></div>';\n  }\n  $('#dbody').innerHTML=h;\n  var f=$('#payForm');\n  if(f){\n    var mult=(J.member&&J.member.is_fleet)?0:(J.tier?Number(J.tier.multiplier)||1:1);\n    var pv=function(){ var l=parseFloat(fe(f,'labor').value)||0, p=parseFloat(fe(f,'parts').value)||0;\n      $('#payPts').textContent=(l+p)>0?'Total '+usd(cents(l+p))+(b.email||J.member?', about '+n(Math.floor((l*J.rates.labor+p*J.rates.parts)*mult))+' points':''):''; };\n    fe(f,'labor').addEventListener('input',pv); fe(f,'parts').addEventListener('input',pv); pv();\n    $('#toComplete').addEventListener('click', function(){ J.tab='texts'; J.preset='complete'; renderJob(); });\n    f.addEventListener('submit', function(e){\n      e.preventDefault(); $('#payErr').textContent='';\n      var l=parseFloat(fe(f,'labor').value)||0, p=parseFloat(fe(f,'parts').value)||0;\n      if(!(l+p>0)){ $('#payErr').textContent='Enter labor and/or parts.'; return; }\n      if(!confirm('Mark paid: '+usd(cents(l+p))+' by '+fe(f,'method').value+'?')) return;\n      var btn=f.querySelector('button'); busy(btn,true,'Saving\u2026');\n      api('/admin/booking/'+b.id+'/paid',{method:'POST',body:{labor:l,parts:p,method:fe(f,'method').value,reference:fe(f,'reference').value.trim(),voucher_code:fe(f,'voucher_code').value.trim()}})\n        .then(function(r){ toast(r.no_member?'Marked paid. No email, so no points.':r.fleet?'Marked paid. Fleet account, no points.':'Marked paid, '+n(r.points)+' points awarded'); openJob(b.id,'payment'); })\n        .catch(function(err){ $('#payErr').textContent=err.message; busy(btn,false); });\n    });\n  }\n  if($('#bReopen')) $('#bReopen').addEventListener('click', function(){\n    if(!confirm('Undo this payment?'+(b.points_awarded?' '+n(b.points_awarded)+' points will be taken back.':''))) return;\n    api('/admin/booking/'+b.id+'/reopen',{method:'POST'}).then(function(){ toast('Payment undone'); openJob(b.id,'payment'); }).catch(function(e){ toast(e.message,true); });\n  });\n  if($('#bRestore')) $('#bRestore').addEventListener('click', function(){\n    api('/admin/booking/'+b.id+'/restore',{method:'POST'}).then(function(){ toast('Job restored'); openJob(b.id); }).catch(function(e){ toast(e.message,true); });\n  });\n}\n\n/* History tab */\nfunction tabHistory(){\n  var ev=J.events||[];\n  var h='<div class=\"steel panel sec\"><h3>Add a note</h3><textarea id=\"noteText\" rows=\"2\" placeholder=\"Parts ordered from O\\'Reilly, ETA Thursday. Customer prefers texts after 5 PM.\"></textarea><div class=\"row\" style=\"margin-top:.5rem\"><button class=\"btn sm\" id=\"noteAdd\">Add note</button></div></div>'+\n    '<div class=\"steel panel\">'+(ev.length?ev.map(function(e){\n      var k={note:'Note',status:'Status',sms:'Text sent',estimate:'Estimate',payment:'Payment',edit:'Edit'}[e.kind]||e.kind;\n      return '<div class=\"ev\"><div class=\"k\">'+when(e.at)+'<br>'+esc(e.by_name||'')+'</div><div><span class=\"chip\">'+esc(k)+'</span> '+esc(e.text)+'</div></div>';\n    }).join(''):'<div class=\"dim\">No history yet.</div>')+'</div>';\n  $('#dbody').innerHTML=h;\n  $('#noteAdd').addEventListener('click', function(){\n    var t=$('#noteText').value.trim(); if(!t) return;\n    api('/admin/booking/'+J.booking.id+'/note',{method:'POST',body:{text:t}}).then(function(){ toast('Note added'); openJob(J.booking.id,'history'); }).catch(function(e){ toast(e.message,true); });\n  });\n}\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 LABOR & PARTS GUIDE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nvar META=null;\nfunction loadMeta(){ return META?Promise.resolve(META):api('/admin/meta').then(function(m){ META=m; return m; }); }\nfunction guideToLines(r, rate, markup){\n  var lines=[];\n  if(r.flat_cents!=null) lines.push({type:'fee',desc:r.name,qty:1,unit_cents:r.flat_cents,status:'pending',guide_id:r.id});\n  else if(r.labor_hours>0) lines.push({type:'labor',desc:r.name+' (labor)',qty:r.labor_hours,unit_cents:rate||0,status:'pending',guide_id:r.id});\n  (r.parts||[]).forEach(function(p){ lines.push({type:'part',desc:p.name,part_no:p.part_no||null,qty:Number(p.qty)||1,cost_cents:p.cost_cents||0,\n    unit_cents:Math.round((p.cost_cents||0)*(1+(Number(markup)||0)/100)),status:'pending',guide_id:r.id}); });\n  return lines;\n}\nfunction guideRow(r, rate, markup){\n  var partsCost=(r.parts||[]).reduce(function(a,p){ return a+(p.cost_cents||0)*(Number(p.qty)||1); },0);\n  var partsPrice=Math.round(partsCost*(1+(Number(markup)||0)/100));\n  var labor=r.flat_cents!=null?r.flat_cents:Math.round(r.labor_hours*(rate||0));\n  var h=r.history||{};\n  var hist=h.vehicle_times_quoted?'Quoted '+h.vehicle_times_quoted+'\u00d7 on this make/model, avg '+h.vehicle_avg_hours+' hr':(h.times_quoted?'Quoted '+h.times_quoted+'\u00d7 before, avg '+h.avg_hours+' hr':'');\n  return '<div class=\"gres\"><div><h4>'+esc(r.name)+'</h4>'+\n    '<div class=\"meta\">'+(r.flat_cents!=null?'Flat '+usd(r.flat_cents):'<b style=\"color:var(--text)\">'+r.labor_hours+' hr</b>')+\n      (r.source==='vehicle'?' <span class=\"chip good\">'+esc(r.override_label)+' time</span>':' <span class=\"chip\">Standard time</span>')+\n      ((r.parts||[]).length?' &middot; '+r.parts.length+' part'+(r.parts.length>1?'s':'')+', cost '+usd(partsCost):'')+'</div>'+\n    (hist?'<div class=\"meta\">'+esc(hist)+'</div>':'')+(r.notes?'<div class=\"meta\" style=\"color:var(--warn)\">'+esc(r.notes)+'</div>':'')+'</div>'+\n    '<div><div class=\"price\">'+usd(labor+partsPrice)+'</div><div class=\"meta\" style=\"text-align:right\">before tax</div><button type=\"button\" class=\"btn sm\" data-gadd=\"'+esc(r.id)+'\" style=\"margin-top:.3rem\">Add</button></div></div>';\n}\nfunction guidePicker(el, opts){\n  // opts: vehicle (string), onAdd(lines, result), rate, markup\n  el.innerHTML='<div class=\"gpick\"><div class=\"row\"><input class=\"gq\" placeholder=\"Search a job or part: starter, brakes, water pump\u2026\" style=\"flex:1;min-width:200px\"><button type=\"button\" class=\"btn ghost sm gclose\">Close</button></div>'+\n    '<div class=\"help gveh\"></div><div class=\"list\"><div class=\"dim\" style=\"padding:.6rem\">Loading the guide\u2026</div></div></div>';\n  var q=el.querySelector('.gq'), list=el.querySelector('.list'), t, last=[];\n  function load(){\n    api('/admin/guide/lookup?vehicle='+encodeURIComponent(opts.vehicle()||'')+'&q='+encodeURIComponent(q.value)).then(function(d){\n      last=d.results; var v=d.vehicle;\n      el.querySelector('.gveh').innerHTML=v.make?'Times for <b style=\"color:var(--text)\">'+esc([v.year,v.make,v.model].filter(Boolean).join(' '))+'</b>. Vehicle-specific times are used when saved.':'<span style=\"color:var(--warn)\">Add the year, make, and model to see vehicle-specific times.</span>';\n      list.innerHTML=d.results.length?d.results.map(function(r){ return guideRow(r, opts.rate, opts.markup); }).join(''):'<div class=\"dim\" style=\"padding:.6rem\">No guide entries match. Add one under Quotes & labor guide.</div>';\n      $$('[data-gadd]', list).forEach(function(b){ b.addEventListener('click', function(){\n        var r=last.filter(function(x){ return x.id===b.dataset.gadd; })[0]; if(!r) return;\n        if(!opts.rate && r.flat_cents==null && r.labor_hours>0) toast('Labor rate is $0. Set it in Settings \u2192 Shop', true);\n        opts.onAdd(guideToLines(r, opts.rate, opts.markup), r);\n        b.textContent='Added \u2713'; setTimeout(function(){ b.textContent='Add'; }, 1500);\n      }); });\n    }).catch(function(e){ list.innerHTML='<div class=\"err-text\">'+esc(e.message)+'</div>'; });\n  }\n  q.addEventListener('input', function(){ clearTimeout(t); t=setTimeout(load, 250); });\n  q.addEventListener('keydown', function(e){ if(e.key==='Enter') e.preventDefault(); });\n  el.querySelector('.gclose').addEventListener('click', function(){ el.innerHTML=''; if(opts.onClose) opts.onClose(); });\n  load(); q.focus();\n}\nfunction quoteTotals(lines, taxRate){\n  var t={labor:0,parts:0,fees:0,discount:0};\n  lines.forEach(function(l){ var a=Math.round((Number(l.qty)||0)*(Number(l.unit_cents)||0));\n    if(l.type==='labor') t.labor+=a; else if(l.type==='part') t.parts+=a; else if(l.type==='fee') t.fees+=a; else t.discount+=a; });\n  t.tax=Math.round(t.parts*(Number(taxRate)||0)/100); t.total=Math.max(0,t.labor+t.parts+t.fees-t.discount)+t.tax; return t;\n}\n\nVIEWS.guide = function(){\n  loadMeta().then(function(m){\n    S.quote=S.quote||{vehicle:'',vin:'',lines:[]};\n    var Q=S.quote;\n    $('#view').innerHTML='<h2>Quotes &amp; labor guide</h2>'+\n      '<div class=\"steel panel sec\"><h3>Quick quote</h3><p class=\"dim\" style=\"margin:-.4rem 0 .8rem;font-size:.9rem\">Price a job over the phone. Then turn it into a job with the estimate already filled in.</p>'+\n        '<div class=\"grid g2\"><div class=\"field\"><label>Vehicle (year, make, model, engine)</label><input id=\"qVeh\" value=\"'+esc(Q.vehicle)+'\" placeholder=\"2015 Ford F-150 5.0\"></div>'+\n        '<div class=\"field\"><label>VIN (optional)</label><div class=\"row\" style=\"flex-wrap:nowrap\"><input id=\"qVin\" maxlength=\"17\" style=\"text-transform:uppercase\" value=\"'+esc(Q.vin)+'\"><button type=\"button\" class=\"btn ghost sm\" id=\"qVinBtn\">Decode</button></div></div></div>'+\n        '<div class=\"row\"><button type=\"button\" class=\"btn sm\" id=\"qAdd\">+ Add from guide</button><button type=\"button\" class=\"btn ghost sm\" id=\"qCustom\">+ Custom line</button></div>'+\n        '<div id=\"qPick\"></div><div class=\"scroll\"><table class=\"est\" style=\"margin-top:.6rem\"><tbody id=\"qRows\"></tbody></table></div>'+\n        '<div id=\"qTot\" style=\"margin-top:.6rem\"></div>'+\n        '<div class=\"row\" style=\"margin-top:.8rem\"><button type=\"button\" class=\"btn purple\" id=\"qJob\">Create job from this quote</button><button type=\"button\" class=\"btn ghost sm\" id=\"qCopy\">Copy quote as text</button><button type=\"button\" class=\"btn danger sm\" id=\"qClear\">Clear</button></div>'+\n        (m.labor_rate_cents?'':'<div class=\"help\" style=\"color:var(--warn)\">Your labor rate is $0. Set it in Settings \u2192 Shop (owner) so labor prices fill in.</div>')+\n      '</div>'+\n      '<div class=\"steel panel\"><div class=\"row\" style=\"justify-content:space-between\"><h3 style=\"margin:0\">Guide</h3><button type=\"button\" class=\"btn ghost sm\" id=\"gNew\">+ New guide entry</button></div>'+\n        '<p class=\"dim\" style=\"font-size:.88rem;margin:.4rem 0 .8rem\">Starting times are general estimates, not book times. Adjust them to your real numbers. Save vehicle-specific times as you quote, and the guide gets more accurate on its own.</p>'+\n        '<div class=\"row\" style=\"margin-bottom:.6rem\"><input id=\"gQ\" placeholder=\"Search the guide\" style=\"flex:1;min-width:200px\"><select id=\"gCat\" style=\"width:auto\"><option value=\"\">All categories</option></select></div>'+\n        '<div id=\"gList\"><div class=\"empty\">Loading\u2026</div></div></div>';\n    function paintQuote(){\n      var rows=Q.lines.map(function(l,i){ var amt=Math.round((Number(l.qty)||0)*(Number(l.unit_cents)||0));\n        return '<tr><td><input data-qi=\"'+i+'\" data-qf=\"desc\" value=\"'+esc(l.desc)+'\"></td><td style=\"width:80px\"><input data-qi=\"'+i+'\" data-qf=\"qty\" value=\"'+esc(l.qty)+'\" inputmode=\"decimal\"></td>'+\n          '<td style=\"width:105px\"><input data-qi=\"'+i+'\" data-qf=\"unit\" value=\"'+dollars(l.unit_cents)+'\" inputmode=\"decimal\"></td><td class=\"amt\" style=\"width:95px\">'+(l.type==='discount'?'\u2212':'')+usd(amt)+'</td>'+\n          '<td style=\"width:34px\"><button type=\"button\" class=\"btn danger sm\" data-qdel=\"'+i+'\">\u00d7</button></td></tr>'; }).join('');\n      $('#qRows').innerHTML=Q.lines.length?'<tr><th>Line</th><th>Qty / hrs</th><th>Price each</th><th>Amount</th><th></th></tr>'+rows:'<tr><td class=\"dim\" style=\"padding:.6rem 0\">No lines yet. Add jobs from the guide.</td></tr>';\n      var t=quoteTotals(Q.lines, m.parts_tax_rate);\n      $('#qTot').innerHTML=Q.lines.length?'<div class=\"row\" style=\"justify-content:flex-end;gap:1.2rem;font-size:.92rem\"><span class=\"dim\">Labor &amp; fees '+usd(t.labor+t.fees-t.discount)+'</span><span class=\"dim\">Parts '+usd(t.parts)+'</span><span class=\"dim\">Tax '+usd(t.tax)+'</span><span style=\"font-family:var(--head);font-size:1.2rem;color:var(--gold-hi)\">Total '+usd(t.total)+'</span></div>':'';\n      $$('[data-qf]').forEach(function(inp){ inp.addEventListener('change', function(){ var l=Q.lines[+inp.dataset.qi], f=inp.dataset.qf;\n        if(f==='desc') l.desc=inp.value; else if(f==='qty') l.qty=parseFloat(inp.value)||0; else l.unit_cents=cents(inp.value); paintQuote(); }); });\n      $$('[data-qdel]').forEach(function(b){ b.addEventListener('click', function(){ Q.lines.splice(+b.dataset.qdel,1); paintQuote(); }); });\n    }\n    paintQuote();\n    $('#qVeh').addEventListener('input', function(){ Q.vehicle=this.value; });\n    $('#qVin').addEventListener('input', function(){ Q.vin=this.value; });\n    $('#qVinBtn').addEventListener('click', function(){ decodeVin($('#qVin'), $('#qVeh')); setTimeout(function(){ Q.vehicle=$('#qVeh').value; Q.vin=$('#qVin').value; }, 1500); });\n    $('#qAdd').addEventListener('click', function(){ guidePicker($('#qPick'), {vehicle:function(){ return $('#qVeh').value; }, rate:m.labor_rate_cents, markup:m.parts_markup_pct,\n      onAdd:function(lines){ Q.lines=Q.lines.concat(lines); paintQuote(); }}); });\n    $('#qCustom').addEventListener('click', function(){ Q.lines.push({type:'labor',desc:'Labor',qty:1,unit_cents:m.labor_rate_cents||0,status:'pending'}); paintQuote(); });\n    $('#qClear').addEventListener('click', function(){ if(Q.lines.length && !confirm('Clear this quote?')) return; S.quote={vehicle:'',vin:'',lines:[]}; VIEWS.guide(); });\n    $('#qCopy').addEventListener('click', function(){\n      if(!Q.lines.length) return toast('Add lines first', true);\n      var t=quoteTotals(Q.lines, m.parts_tax_rate);\n      var txt='Upper Echelon Automotive estimate'+(Q.vehicle?' for '+Q.vehicle:'')+'\\n'+Q.lines.map(function(l){ return '- '+l.desc+': '+usd(Math.round(l.qty*l.unit_cents)); }).join('\\n')+'\\nTax on parts: '+usd(t.tax)+'\\nTotal: '+usd(t.total)+'\\nFinal price confirmed after inspection.';\n      (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(function(){ toast('Quote copied'); }).catch(function(){ prompt('Copy this quote:', txt); });\n    });\n    $('#qJob').addEventListener('click', function(){\n      if(!Q.lines.length) return toast('Add lines first', true);\n      var names=[]; Q.lines.forEach(function(l){ if(l.type!=='part'){ var n=l.desc.replace(/ \\(labor\\)$/,''); if(names.indexOf(n)<0) names.push(n); } });\n      S.prefill={vehicle:Q.vehicle, vin:Q.vin, service:names.join(', ').slice(0,190), estimate_lines:Q.lines.slice()};\n      go('new');\n    });\n    loadGuideList();\n  }).catch(fail);\n};\nfunction loadGuideList(){\n  api('/admin/guide').then(function(d){\n    var cats=[]; d.jobs.forEach(function(j){ if(cats.indexOf(j.category)<0) cats.push(j.category); });\n    var sel=$('#gCat'); if(sel.options.length<=1) sel.insertAdjacentHTML('beforeend', cats.map(function(c){ return '<option>'+esc(c)+'</option>'; }).join(''));\n    function paint(){\n      var q=$('#gQ').value.toLowerCase(), c=$('#gCat').value;\n      var rows=d.jobs.filter(function(j){ return (!c||j.category===c) && (!q || (j.name+' '+(j.parts||[]).map(function(p){return p.name;}).join(' ')).toLowerCase().indexOf(q)>-1); });\n      $('#gList').innerHTML=rows.length?'<div class=\"scroll\"><table><tr><th>Job</th><th>Category</th><th>Time</th><th>Parts cost</th><th>Vehicle times</th></tr>'+rows.map(function(j){\n        var pc=(j.parts||[]).reduce(function(a,p){ return a+(p.cost_cents||0)*(Number(p.qty)||1); },0);\n        return '<tr class=\"click\" data-gj=\"'+esc(j.id)+'\"><td>'+esc(j.name)+(j.active?'':' <span class=\"chip bad\">Off</span>')+'</td><td class=\"dim\">'+esc(j.category)+'</td><td>'+(j.flat_cents!=null?'Flat '+usd(j.flat_cents):j.labor_hours+' hr')+'</td><td>'+(pc?usd(pc):'\u2014')+'</td><td class=\"dim\">'+(j.override_count||'\u2014')+'</td></tr>';\n      }).join('')+'</table></div>':'<div class=\"empty\">Nothing matches.</div>';\n      $$('[data-gj]').forEach(function(tr){ tr.addEventListener('click', function(){ openGuideJob(tr.dataset.gj); }); });\n    }\n    paint();\n    var t; $('#gQ').oninput=function(){ clearTimeout(t); t=setTimeout(paint,150); };\n    $('#gCat').onchange=paint;\n    $('#gNew').onclick=function(){ openGuideJob(null); };\n  }).catch(function(e){ $('#gList').innerHTML='<div class=\"empty\">'+esc(e.message)+(/relation|does not exist|schema cache/i.test(e.message)?' Run 5-labor-parts-guide.sql in Supabase first.':'')+'</div>'; });\n}\nfunction partsEditor(el, parts){\n  var P=JSON.parse(JSON.stringify(parts||[]));\n  function paint(){\n    el.innerHTML='<table class=\"parts-ed\"><tr><th>Part</th><th style=\"width:110px\">Part #</th><th style=\"width:60px\">Qty</th><th style=\"width:95px\">Your cost $</th><th style=\"width:34px\"></th></tr>'+\n      P.map(function(p,i){ return '<tr><td><input data-pi=\"'+i+'\" data-pf=\"name\" value=\"'+esc(p.name)+'\"></td><td><input data-pi=\"'+i+'\" data-pf=\"part_no\" value=\"'+esc(p.part_no||'')+'\"></td><td><input data-pi=\"'+i+'\" data-pf=\"qty\" value=\"'+esc(p.qty||1)+'\" inputmode=\"decimal\"></td><td><input data-pi=\"'+i+'\" data-pf=\"cost\" value=\"'+dollars(p.cost_cents)+'\" inputmode=\"decimal\"></td><td><button type=\"button\" class=\"btn danger sm\" data-pdel=\"'+i+'\">\u00d7</button></td></tr>'; }).join('')+\n      '</table><button type=\"button\" class=\"btn ghost sm\" data-padd>+ Part</button>';\n    $$('[data-pf]', el).forEach(function(inp){ inp.addEventListener('change', function(){ var p=P[+inp.dataset.pi], f=inp.dataset.pf;\n      if(f==='cost') p.cost_cents=cents(inp.value); else if(f==='qty') p.qty=parseFloat(inp.value)||1; else p[f]=inp.value; }); });\n    $$('[data-pdel]', el).forEach(function(b){ b.addEventListener('click', function(){ P.splice(+b.dataset.pdel,1); paint(); }); });\n    el.querySelector('[data-padd]').addEventListener('click', function(){ P.push({name:'',qty:1,cost_cents:0}); paint(); });\n  }\n  paint();\n  return function(){ return P.filter(function(p){ return String(p.name||'').trim(); }); };\n}\nfunction openGuideJob(id){\n  J=null; var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide'); sh.innerHTML='<div class=\"empty\">Loading\u2026</div>';\n  (id?api('/admin/guide/job/'+encodeURIComponent(id)):Promise.resolve({job:{name:'',category:'Other',labor_hours:1,flat_cents:null,parts:[],notes:'',active:true},overrides:[]})).then(function(x){\n    var j=x.job, flat=j.flat_cents!=null;\n    sh.innerHTML='<div class=\"row\" style=\"justify-content:space-between\"><h2 style=\"margin:0\">'+(id?esc(j.name):'New guide entry')+'</h2><button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button></div>'+\n      '<form id=\"gForm\" class=\"steel panel sec\" style=\"margin-top:1rem\"><div class=\"grid g2\">'+fld('Job name','name',j.name)+fld('Category','category',j.category)+'</div>'+\n        '<div class=\"row\" style=\"margin-bottom:.8rem\"><label class=\"row\" style=\"color:var(--text);font-family:var(--body);margin:0\"><input type=\"radio\" name=\"kind\" value=\"hours\"'+(flat?'':' checked')+'> Priced by labor hours</label><label class=\"row\" style=\"color:var(--text);font-family:var(--body);margin:0\"><input type=\"radio\" name=\"kind\" value=\"flat\"'+(flat?' checked':'')+'> Flat price</label></div>'+\n        '<div class=\"grid g2\"><div class=\"field\" id=\"hoursF\"><label>Standard labor hours</label><input name=\"labor_hours\" type=\"number\" step=\"0.1\" min=\"0\" value=\"'+esc(j.labor_hours)+'\"></div><div class=\"field\" id=\"flatF\"><label>Flat price ($)</label><input name=\"flat\" type=\"number\" step=\"0.01\" min=\"0\" value=\"'+(flat?dollars(j.flat_cents):'')+'\"></div></div>'+\n        '<label>Standard parts</label><div id=\"gParts\"></div>'+\n        '<div class=\"field\" style=\"margin-top:.8rem\"><label>Notes (shown when quoting)</label><input name=\"notes\" value=\"'+esc(j.notes||'')+'\"></div>'+\n        '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" name=\"active\"'+(j.active!==false?' checked':'')+'> Show this job when quoting</label>'+\n        '<div class=\"row\" style=\"margin-top:.8rem\"><button class=\"btn\">Save</button>'+(j.updated_by?'<span class=\"help\">Last edited by '+esc(j.updated_by)+'</span>':'')+'</div></form>'+\n      (id?'<div class=\"steel panel sec\"><h3>Vehicle-specific times</h3><p class=\"dim\" style=\"font-size:.88rem;margin-top:-.4rem\">When a quote matches one of these, its time and parts replace the standard ones. The most specific match wins.</p><div id=\"ovList\"></div>'+\n        '<h3 style=\"margin-top:1rem\">Add a vehicle time</h3><form id=\"ovForm\"><div class=\"grid g3\">'+fld('Make','make','')+fld('Model (optional)','model','')+fld('Engine (optional)','engine','','','text')+\n        fld('Year from','year_from','','','number')+fld('Year to','year_to','','','number')+fld('Labor hours','labor_hours','','','number')+'</div>'+\n        '<label>Parts for this vehicle (optional, replaces the standard parts)</label><div id=\"ovParts\"></div>'+fld('Notes','notes','')+\n        '<button class=\"btn sm\">Add vehicle time</button></form></div>':'');\n    $('#closeDrawer').addEventListener('click', function(){ closeDrawer(); });\n    var getParts=partsEditor($('#gParts'), j.parts);\n    var f=$('#gForm');\n    function kind(){ var k=$$('input[name=\"kind\"]', f).filter(function(r){ return r.checked; })[0].value; $('#hoursF').classList.toggle('hide', k==='flat'); $('#flatF').classList.toggle('hide', k!=='flat'); return k; }\n    $$('input[name=\"kind\"]', f).forEach(function(r){ r.addEventListener('change', kind); }); kind();\n    f.addEventListener('submit', function(e){ e.preventDefault();\n      var k=kind(), body={name:fe(f,'name').value,category:fe(f,'category').value,labor_hours:parseFloat(fe(f,'labor_hours').value)||0,\n        flat_cents:k==='flat'?cents(fe(f,'flat').value):null,parts:getParts(),notes:fe(f,'notes').value,active:fe(f,'active').checked};\n      api(id?'/admin/guide/job/'+encodeURIComponent(id):'/admin/guide',{method:id?'PUT':'POST',body:body}).then(function(r){ toast('Guide saved'); openGuideJob(r.job.id); }).catch(function(e){ toast(e.message,true); });\n    });\n    if(id){\n      $('#ovList').innerHTML=x.overrides.length?'<table>'+x.overrides.map(function(o){\n        var lbl=[o.year_from&&o.year_to?(o.year_from===o.year_to?o.year_from:o.year_from+'\u2013'+o.year_to):o.year_from?o.year_from+'+':o.year_to?'up to '+o.year_to:'', o.make, o.model, o.engine].filter(Boolean).join(' ');\n        return '<tr><td>'+esc(lbl)+'<div class=\"dim\" style=\"font-size:.8rem\">'+(o.updated_by?'by '+esc(o.updated_by):'')+(o.notes?' &middot; '+esc(o.notes):'')+'</div></td><td>'+(o.labor_hours!=null?o.labor_hours+' hr':'standard time')+'</td><td class=\"dim\">'+(o.parts?o.parts.length+' parts':'standard parts')+'</td><td><button class=\"btn danger sm\" data-ovdel=\"'+o.id+'\">Remove</button></td></tr>';\n      }).join('')+'</table>':'<div class=\"dim\">None yet. Add one below, or tap \"Save for this vehicle\" on an estimate line.</div>';\n      $$('[data-ovdel]').forEach(function(b){ b.addEventListener('click', function(){ if(!confirm('Remove this vehicle time?')) return;\n        api('/admin/guide/overrides/'+b.dataset.ovdel,{method:'DELETE'}).then(function(){ toast('Removed'); openGuideJob(id); }).catch(function(e){ toast(e.message,true); }); }); });\n      var getOvParts=partsEditor($('#ovParts'), []);\n      $('#ovForm').addEventListener('submit', function(e){ e.preventDefault(); var o=e.target;\n        api('/admin/guide/job/'+encodeURIComponent(id)+'/overrides',{method:'POST',body:{make:fe(o,'make').value,model:fe(o,'model').value,engine:fe(o,'engine').value,\n          year_from:fe(o,'year_from').value,year_to:fe(o,'year_to').value,labor_hours:fe(o,'labor_hours').value,notes:fe(o,'notes').value,parts:getOvParts()}})\n          .then(function(){ toast('Vehicle time added'); openGuideJob(id); }).catch(function(err){ toast(err.message,true); });\n      });\n    }\n  }).catch(function(e){ sh.innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 NEW JOB \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS['new'] = function(){\n  var p=S.prefill||{}; S.prefill=null;\n  Promise.all([api('/admin/techs'), api('/admin/meta')]).then(function(r){\n    var techs=r[0].techs, windows=r[1].time_windows||[], methods=r[1].payment_methods||[];\n    var h='<h2>New job</h2><p class=\"dim\" style=\"margin:-.6rem 0 1rem;max-width:640px\">For phone calls, texts, and repeat customers. Website bookings show up in Jobs on their own.</p>'+\n    (p.estimate_lines&&p.estimate_lines.length?'<div class=\"steel panel sec\" style=\"border-color:var(--gold-lo)\">The quote you built ('+p.estimate_lines.length+' line'+(p.estimate_lines.length>1?'s':'')+') will be added to this job\\'s estimate.</div>':'')+\n    '<form id=\"nj\" style=\"max-width:820px\">'+\n    '<div class=\"steel panel sec\"><h3>Customer</h3>'+\n      '<div class=\"field\"><label>Find an existing customer</label><input id=\"njFind\" placeholder=\"Search name, email, or phone\" autocomplete=\"off\"><div id=\"njRes\"></div><div id=\"njPicked\" class=\"help\"></div></div>'+\n      '<div class=\"grid g2\">'+fld('Name','customer_name',p.customer_name)+fld('Phone','phone',p.phone,'','tel')+fld('Email (for rewards points)','email',p.email,'','email')+fld('Service address','address',p.address)+'</div></div>'+\n    '<div class=\"steel panel sec\"><h3>Vehicle</h3><div class=\"grid g2\">'+fld('Year, make, model','vehicle',p.vehicle)+\n      '<div class=\"field\"><label>VIN</label><div class=\"row\" style=\"flex-wrap:nowrap\"><input name=\"vin\" maxlength=\"17\" style=\"text-transform:uppercase\" value=\"'+esc(p.vin||'')+'\"><button type=\"button\" class=\"btn ghost sm\" id=\"njVin\">Decode</button></div></div>'+\n      fld('Mileage','mileage','','','text','numeric')+fld('Plate','plate','')+'</div></div>'+\n    '<div class=\"steel panel sec\"><h3>Work</h3>'+fld('Service','service',p.service)+\n      '<div class=\"field\"><label>Customer concern</label><textarea name=\"concern\" rows=\"3\" placeholder=\"What the customer described, when it happens, warning lights\">'+esc(p.concern||'')+'</textarea></div></div>'+\n    '<div class=\"steel panel sec\"><h3>Schedule</h3><div class=\"grid g3\">'+\n      '<div class=\"field\"><label>Date</label><input type=\"date\" name=\"sched_date\"></div>'+\n      '<div class=\"field\"><label>Time window</label><select name=\"sched_window\"><option value=\"\">Choose</option>'+windows.map(function(w){return '<option>'+esc(w)+'</option>';}).join('')+'</select></div>'+\n      '<div class=\"field\"><label>Technician</label><select name=\"tech_id\"><option value=\"\">Unassigned</option>'+techs.map(function(t){return '<option value=\"'+t.id+'\">'+esc(t.name)+'</option>';}).join('')+'</select></div></div>'+\n      '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" name=\"rush\"> Rush / emergency</label></div>'+\n    '<div class=\"steel panel sec\"><label class=\"row\" style=\"color:var(--text);font-family:var(--head);font-size:1rem\"><input type=\"checkbox\" id=\"njPaid\"> This job is already done and paid</label>'+\n      '<div id=\"njPayBox\" class=\"hide\" style=\"margin-top:.8rem\"><div class=\"grid g2\">'+\n      '<div class=\"field\"><label>Labor and fees charged ($)</label><input name=\"p_labor\" type=\"number\" step=\"0.01\" min=\"0\"></div><div class=\"field\"><label>Parts charged ($)</label><input name=\"p_parts\" type=\"number\" step=\"0.01\" min=\"0\"></div>'+\n      '<div class=\"field\"><label>Paid by</label><select name=\"p_method\">'+methods.map(function(o){return '<option>'+esc(o)+'</option>';}).join('')+'</select></div><div class=\"field\"><label>Receipt or transaction #</label><input name=\"p_ref\"></div></div>'+\n      '<div class=\"field\"><label>Reward voucher used</label><input name=\"p_voucher\" placeholder=\"UER-XXXXXX (optional)\" style=\"text-transform:uppercase\"></div></div></div>'+\n    '<div class=\"row\"><button class=\"btn\">Create job</button><span id=\"njErr\" class=\"err-text\"></span></div></form>';\n    $('#view').innerHTML=h;\n    var f=$('#nj'), picked=p.member_id?{id:p.member_id}:null, t;\n    if(picked) $('#njPicked').textContent='Linked to existing customer.';\n    $('#njPaid').addEventListener('change', function(){ $('#njPayBox').classList.toggle('hide', !this.checked); });\n    $('#njVin').addEventListener('click', function(){ decodeVin(fe(f,'vin'), fe(f,'vehicle')); });\n    $('#njFind').addEventListener('keydown', function(e){ if(e.key==='Enter') e.preventDefault(); });\n    $('#njFind').addEventListener('input', function(){\n      clearTimeout(t); var q=this.value.trim(); if(q.length<2){ $('#njRes').innerHTML=''; return; }\n      t=setTimeout(function(){ api('/admin/members?q='+encodeURIComponent(q)).then(function(d){\n        $('#njRes').innerHTML=d.members.slice(0,6).map(function(m,i){ return '<button type=\"button\" class=\"btn ghost sm\" data-pi=\"'+i+'\" style=\"display:block;width:100%;text-align:left;margin-top:.3rem\">'+esc(m.name||'\u2014')+' <span class=\"dim\">'+esc(m.email||'')+' '+esc(m.phone||'')+'</span></button>'; }).join('')||'<div class=\"help\">No match. Fill in the fields below.</div>';\n        $$('#njRes [data-pi]').forEach(function(b){ b.addEventListener('click', function(){\n          var m=d.members[+b.dataset.pi]; picked=m; $('#njRes').innerHTML=''; $('#njFind').value='';\n          fe(f,'customer_name').value=m.name||''; fe(f,'email').value=m.email||''; fe(f,'phone').value=m.phone||'';\n          $('#njPicked').textContent='Linked to '+(m.name||m.email)+'. Their earlier jobs and vehicles show on the job.';\n        }); });\n      }); }, 250);\n    });\n    f.addEventListener('submit', function(e){\n      e.preventDefault(); $('#njErr').textContent='';\n      var body={member_id:picked?picked.id:null,customer_name:fe(f,'customer_name').value,phone:fe(f,'phone').value,email:fe(f,'email').value,address:fe(f,'address').value,\n        vehicle:fe(f,'vehicle').value,vin:fe(f,'vin').value,mileage:fe(f,'mileage').value,plate:fe(f,'plate').value,service:fe(f,'service').value,concern:fe(f,'concern').value,\n        sched_date:fe(f,'sched_date').value,sched_window:fe(f,'sched_window').value,tech_id:fe(f,'tech_id').value,rush:fe(f,'rush').checked};\n      if(p.estimate_lines&&p.estimate_lines.length) body.estimate_lines=p.estimate_lines;\n      if($('#njPaid').checked) body.paid={labor:fe(f,'p_labor').value,parts:fe(f,'p_parts').value,method:fe(f,'p_method').value,reference:fe(f,'p_ref').value,voucher_code:fe(f,'p_voucher').value};\n      var btn=f.querySelector('button.btn:not(.ghost)'); busy(btn,true,'Creating\u2026');\n      api('/admin/jobs',{method:'POST',body:body}).then(function(r){\n        if(p.estimate_lines) S.quote=null;\n        toast(r.award?'Job created and marked paid, '+n(r.award.points)+' points':'Job created'); go('jobs'); openJob(r.booking_id, p.estimate_lines?'estimate':null);\n      }).catch(function(err){ $('#njErr').textContent=err.message; busy(btn,false); });\n    });\n  }).catch(fail);\n};\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 FOLLOW-UPS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS.followups = function(){\n  api('/admin/followups').then(function(d){\n    var due=d.followups.filter(function(f){ return f.due; }), later=d.followups.filter(function(f){ return !f.due; });\n    var row=function(f){\n      return '<div class=\"steel panel\" style=\"margin-bottom:.6rem\"><div class=\"row\" style=\"justify-content:space-between;align-items:flex-start\">'+\n        '<div><div style=\"font-family:var(--head);font-size:1.05rem\">'+esc(f.customer_name||f.email||'Customer')+' <span class=\"dim\" style=\"font-family:var(--body);font-size:.88rem\">'+esc(f.vehicle||'')+'</span></div>'+\n        '<div>'+f.declined.map(function(x){ return esc(x.desc)+' <span class=\"dim\">'+usd(x.amount_cents)+'</span>'; }).join(', ')+'</div>'+\n        '<div class=\"dim\" style=\"font-size:.85rem\">Declined on '+esc(f.order_name||'a job')+', '+dayLabel((f.paid_at||'').slice(0,10))+(f.follow_up_date?'. Follow up '+dayLabel(f.follow_up_date):'')+'</div></div>'+\n        '<div style=\"font-family:var(--display);font-size:1.6rem;color:var(--gold-hi)\">'+usd(f.value_cents)+'</div></div>'+\n        '<div class=\"row\" style=\"margin-top:.6rem;gap:.35rem\">'+(f.phone?'<a class=\"btn ghost sm\" href=\"'+telHref(f.phone)+'\">Call</a><button class=\"btn ghost sm\" data-ftext=\"'+f.id+'\">Text</button>':'')+\n        '<button class=\"btn sm\" data-fbook=\"'+f.id+'\">Book it</button><button class=\"btn ghost sm\" data-fsnooze=\"'+f.id+'\">Remind me in 30 days</button><button class=\"btn danger sm\" data-fclose=\"'+f.id+'\">Close</button></div></div>';\n    };\n    $('#view').innerHTML='<h2>Follow-ups</h2><p class=\"dim\" style=\"margin:-.6rem 0 1rem;max-width:660px\">Work customers declined. A follow-up call or text is the cheapest job you\\'ll ever book.</p>'+\n      (due.length?'<h3>Due now ('+due.length+')</h3>'+due.map(row).join(''):'<div class=\"steel empty\">Nothing due right now.</div>')+\n      (later.length?'<h3 style=\"margin-top:1.4rem\">Coming up</h3>'+later.map(row).join(''):'');\n    var byId={}; d.followups.forEach(function(f){ byId[f.id]=f; });\n    $$('[data-ftext]').forEach(function(b){ b.addEventListener('click', function(){ openJob(b.dataset.ftext,'texts','follow_up'); }); });\n    $$('[data-fbook]').forEach(function(b){ b.addEventListener('click', function(){\n      var f=byId[b.dataset.fbook];\n      S.prefill={customer_name:f.customer_name,phone:f.phone,email:f.email,vehicle:f.vehicle,service:f.declined.map(function(x){return x.desc;}).join(', '),concern:'Recommended on '+(f.order_name||'previous visit')+': '+f.declined.map(function(x){return x.desc;}).join(', ')};\n      api('/admin/booking/'+f.id+'/followup',{method:'POST',body:{note:'Booked as a new job'}}).catch(function(){});\n      go('new');\n    }); });\n    $$('[data-fsnooze]').forEach(function(b){ b.addEventListener('click', function(){ api('/admin/booking/'+b.dataset.fsnooze+'/followup',{method:'POST',body:{snooze_days:30}}).then(function(){ toast('Moved 30 days out'); rerender(); }).catch(function(e){ toast(e.message,true); }); }); });\n    $$('[data-fclose]').forEach(function(b){ b.addEventListener('click', function(){ var note=prompt('Close this follow-up? Reason (optional):',''); if(note===null) return; api('/admin/booking/'+b.dataset.fclose+'/followup',{method:'POST',body:{note:note}}).then(function(){ toast('Follow-up closed'); rerender(); }).catch(function(e){ toast(e.message,true); }); }); });\n  }).catch(fail);\n};\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 CUSTOMERS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS.customers = function(){\n  $('#view').innerHTML='<h2>Customers</h2><div class=\"row\" style=\"margin-bottom:1rem\"><input id=\"mq\" placeholder=\"Search name, email, phone, or referral code\" style=\"flex:1;min-width:220px\"><select id=\"msort\" style=\"width:auto\"><option value=\"recent\">Recently active</option><option value=\"points\">Most points</option></select></div><div id=\"mlist\" class=\"steel\"></div>'+\n    '<p class=\"help\">Customers appear here once they have an email on a job or sign in to Rewards.</p>';\n  var t; $('#mq').addEventListener('input', function(){ clearTimeout(t); t=setTimeout(loadMembers,250); });\n  $('#msort').addEventListener('change', loadMembers); loadMembers();\n};\nfunction loadMembers(){\n  if(!$('#mlist')) return;\n  api('/admin/members?q='+encodeURIComponent($('#mq').value)+'&sort='+$('#msort').value).then(function(d){\n    $('#mlist').innerHTML=d.members.length?'<div class=\"scroll\"><table><tr><th>Name</th><th>Contact</th><th>Points</th><th>Last active</th></tr>'+d.members.map(function(m){\n      return '<tr class=\"click\" data-mid=\"'+m.id+'\"><td>'+esc(m.name||'\u2014')+(m.is_fleet?' <span class=\"chip\">Fleet</span>':'')+'</td><td>'+esc(m.email||'')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(m.phone||'')+'</div></td><td class=\"pts\">'+n(m.points_balance)+'</td><td class=\"dim\">'+when(m.last_activity_at)+'</td></tr>';\n    }).join('')+'</table></div>':'<div class=\"empty\">No customers match.</div>';\n    $$('#mlist tr[data-mid]').forEach(function(tr){ tr.addEventListener('click', function(){ openMember(tr.dataset.mid); }); });\n  }).catch(function(e){ $('#mlist').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\nfunction openMember(id){\n  J=null; var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide'); sh.innerHTML='<div class=\"empty\">Loading\u2026</div>';\n  api('/admin/member/'+id).then(function(x){\n    var m=x.member, t=x.tier, nx=x.next_tier;\n    var pct=nx?Math.min(100,Math.round((x.spend_12mo_cents-t.min_spend_cents)/Math.max(1,nx.min_spend_cents-t.min_spend_cents)*100)):100;\n    var veh={}; (x.jobs||[]).forEach(function(j){ var k=(j.vin||j.vehicle||'').toUpperCase(); if(k&&!veh[k]) veh[k]=j; });\n    var h='<div class=\"row\" style=\"justify-content:space-between\"><h2 style=\"margin:0\">'+esc(m.name||m.email||'Customer')+'</h2><button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button></div>'+\n      '<div class=\"dim\">'+esc(m.email||'')+(m.phone?' &nbsp; <a href=\"'+telHref(m.phone)+'\">'+esc(m.phone)+'</a>':'')+'</div>'+\n      '<div class=\"row\" style=\"margin:.8rem 0\"><button class=\"btn purple sm\" id=\"newForMember\">New job for this customer</button></div>'+\n      (m.is_fleet?'<div class=\"steel panel sec\">Fleet account. Earns no points.</div>':\n      '<div class=\"tierline\"><div class=\"bolt\"><b>'+esc(t.name)+'</b></div><div style=\"flex:1\"><div style=\"font-family:var(--display);font-size:2.1rem;line-height:1\">'+n(m.points_balance)+' pts</div>'+\n        '<div class=\"dim\" style=\"font-size:.88rem;margin:.2rem 0 .4rem\">'+usd(x.spend_12mo_cents)+' spent in 12 months'+(nx?', '+usd(nx.min_spend_cents-x.spend_12mo_cents)+' to '+esc(nx.name):', top tier')+'</div><div class=\"bar\"><i style=\"width:'+pct+'%\"></i></div></div></div>')+\n      (Object.keys(veh).length?'<div class=\"steel panel sec\"><h3>Vehicles</h3>'+Object.keys(veh).map(function(k){ var j=veh[k]; return '<div>'+esc(j.vehicle||'Vehicle')+(j.vin?' <span class=\"dim\">VIN '+esc(j.vin)+'</span>':'')+(j.mileage?' <span class=\"dim\">'+n(j.mileage)+' mi</span>':'')+'</div>'; }).join('')+'</div>':'')+\n      '<div class=\"steel panel sec\"><h3>Jobs</h3>'+((x.jobs||[]).length?'<table>'+x.jobs.map(function(j){ return '<tr class=\"click\" data-job=\"'+j.id+'\"><td class=\"dim\" style=\"white-space:nowrap\">'+dayLabel((j.sched_date||j.created_at||'').slice(0,10))+'</td><td>'+esc(j.service||'')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(j.vehicle||'')+'</div></td><td>'+stageChip(j)+(j.total_cents?'<div class=\"dim\" style=\"font-size:.82rem\">'+usd(j.total_cents)+'</div>':'')+'</td></tr>'; }).join('')+'</table>':'<div class=\"dim\">No jobs on file yet.</div>')+'</div>'+\n      (OWN()?'<label class=\"row sec\" style=\"color:var(--text);font-family:var(--body);cursor:pointer\"><input type=\"checkbox\" id=\"fleetBox\"'+(m.is_fleet?' checked':'')+'> Fleet account (FleetCare pricing, earns no points)</label>'+\n        '<div class=\"steel panel sec\"><h3>Adjust points</h3><div class=\"row\"><input id=\"adjPts\" type=\"number\" placeholder=\"+50 or -50\" style=\"width:130px\"><input id=\"adjNote\" placeholder=\"Reason (shows in their history)\" style=\"flex:1;min-width:160px\"><button class=\"btn sm\" id=\"adjGo\">Apply</button></div></div>':'')+\n      (x.vouchers.length?'<div class=\"steel panel sec\"><h3>Reward vouchers</h3><div class=\"scroll\"><table>'+x.vouchers.map(voucherRow).join('')+'</table></div></div>':'')+\n      '<div class=\"steel panel\"><h3>Points history</h3>'+(x.ledger.length?'<table>'+x.ledger.map(function(l){ return '<tr><td class=\"dim\" style=\"white-space:nowrap\">'+when(l.created_at)+'</td><td>'+esc(l.note||TYPE[l.type])+'</td><td>'+signed(l.points)+'</td></tr>'; }).join('')+'</table>':'<div class=\"dim\">No points activity yet.</div>')+'</div>';\n    sh.innerHTML=h;\n    $('#closeDrawer').addEventListener('click', closeDrawer);\n    $$('#sheet tr[data-job]').forEach(function(tr){ tr.addEventListener('click', function(){ openJob(tr.dataset.job); }); });\n    $('#newForMember').addEventListener('click', function(){ S.prefill={member_id:m.id,customer_name:m.name,email:m.email,phone:m.phone}; $('#drawer').classList.add('hide'); go('new'); });\n    if($('#fleetBox')) $('#fleetBox').addEventListener('change', function(){ var on=this.checked; api('/admin/member/'+m.id+'/fleet',{method:'POST',body:{is_fleet:on}}).then(function(){ toast(on?'Marked as fleet':'Fleet flag removed'); openMember(m.id); }).catch(function(e){ toast(e.message,true); }); });\n    if($('#adjGo')) $('#adjGo').addEventListener('click', function(){\n      var p=parseInt($('#adjPts').value,10), note=$('#adjNote').value.trim();\n      if(!p) return toast('Enter a point amount',true); if(!note) return toast('Add a reason',true);\n      api('/admin/adjust',{method:'POST',body:{member_id:m.id,points:p,note:note}}).then(function(){ toast('Points adjusted'); openMember(m.id); }).catch(function(e){ toast(e.message,true); });\n    });\n    bindVoucherButtons(function(){ openMember(m.id); });\n  }).catch(function(e){ sh.innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 VOUCHERS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nfunction voucherRow(v){\n  var who=v.member?'<td>'+esc(v.member.name||v.member.email)+(v.member.phone?'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(v.member.phone)+'</div>':'')+'</td>':'';\n  var where=v.status==='applied'?'On booking '+esc(v.booking_order):v.status==='used'?'Used'+(v.used_order?' on '+esc(v.used_order):''):v.status==='void'?'Points returned':'Not used yet';\n  var acts=(v.status==='active'||v.status==='applied')?'<button class=\"btn sm\" data-vused=\"'+v.id+'\">Mark used</button>'+(OWN()?' <button class=\"btn danger sm\" data-vvoid=\"'+v.id+'\">Void</button>':''):'';\n  return '<tr><td><b style=\"font-family:var(--head)\">'+esc(v.code)+'</b><div class=\"dim\" style=\"font-size:.82rem\">'+when(v.created_at)+'</div></td>'+who+\n    '<td>'+esc(v.reward_name)+'<div class=\"dim\" style=\"font-size:.82rem\">'+usd(v.value_cents)+' value, '+n(v.points_cost)+' pts</div></td><td><span class=\"chip '+v.status+'\">'+v.status+'</span><div class=\"dim\" style=\"font-size:.82rem\">'+where+'</div></td><td style=\"white-space:nowrap\">'+acts+'</td></tr>';\n}\nfunction bindVoucherButtons(after){\n  $$('[data-vused]').forEach(function(b){ b.addEventListener('click', function(){\n    var o=prompt('Invoice or job # this was used on (optional):',''); if(o===null) return;\n    api('/admin/voucher/'+b.dataset.vused+'/used',{method:'POST',body:{order:o}}).then(function(){ toast('Voucher marked used'); after(); refreshCounts(); }).catch(function(e){ toast(e.message,true); });\n  }); });\n  $$('[data-vvoid]').forEach(function(b){ b.addEventListener('click', function(){\n    if(!confirm('Void this voucher and return the points?')) return;\n    api('/admin/voucher/'+b.dataset.vvoid+'/void',{method:'POST'}).then(function(){ toast('Voucher voided, points returned'); after(); refreshCounts(); }).catch(function(e){ toast(e.message,true); });\n  }); });\n}\nVIEWS.vouchers = function(){\n  $('#view').innerHTML='<h2>Reward vouchers</h2><p class=\"dim\" style=\"max-width:640px;margin-top:-.6rem\">Codes customers got by redeeming points. Vouchers used on a job are marked used automatically when you mark the job paid with the code.</p>'+\n    '<div class=\"row\" style=\"margin-bottom:1rem\"><select id=\"vstat\" style=\"width:auto\"><option value=\"open\">Open</option><option value=\"used\">Used</option><option value=\"void\">Voided</option><option value=\"all\">All</option></select></div><div id=\"vlist\" class=\"steel\"></div>';\n  $('#vstat').addEventListener('change', loadVouchers); loadVouchers();\n};\nfunction loadVouchers(){\n  api('/admin/vouchers?status='+$('#vstat').value).then(function(d){\n    $('#vlist').innerHTML=d.vouchers.length?'<div class=\"scroll\"><table><tr><th>Code</th><th>Customer</th><th>Reward</th><th>Status</th><th></th></tr>'+d.vouchers.map(voucherRow).join('')+'</table></div>':'<div class=\"empty\">No vouchers here.</div>';\n    bindVoucherButtons(loadVouchers);\n  }).catch(function(e){ $('#vlist').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 ADD POINTS (owner) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS.points = function(){\n  var reasons=['Goodwill','Job paid before the program started','Correction','Promotion','Other'];\n  $('#view').innerHTML='<h2>Add points</h2><p class=\"dim\" style=\"max-width:640px;margin-top:-.6rem\">Give or remove points by hand. The reason shows in the customer\\'s history. For paid jobs, mark the job paid instead so tier and bonuses count.</p>'+\n    '<form id=\"ptsForm\" class=\"steel panel\" style=\"max-width:600px\"><div class=\"field\"><label>Customer</label><input id=\"ptsFind\" placeholder=\"Search by name, email, or phone\" autocomplete=\"off\"><div id=\"ptsResults\"></div><div id=\"ptsPicked\" class=\"help\"></div></div>'+\n    '<div id=\"ptsNew\" class=\"grid g2 hide\"><div class=\"field\"><label>Email (new member)</label><input name=\"email\" type=\"email\"></div><div class=\"field\"><label>Name</label><input name=\"name\"></div></div>'+\n    '<div class=\"grid g2\"><div class=\"field\"><label>Points</label><input name=\"points\" type=\"number\" step=\"1\" placeholder=\"100, or -100 to remove\"></div><div class=\"field\"><label>Reason</label><select name=\"reason\">'+reasons.map(function(r){return '<option>'+esc(r)+'</option>';}).join('')+'</select></div></div>'+\n    '<div class=\"field\"><label>Note for the customer</label><input name=\"note\" placeholder=\"e.g. Sorry for the late arrival on Oct 2\"></div><button class=\"btn\">Apply points</button><div id=\"ptsOut\" class=\"help\" style=\"margin-top:.8rem\"></div></form>';\n  var picked=null, t;\n  function pick(m){ picked=m; $('#ptsResults').innerHTML=''; $('#ptsFind').value=''; $('#ptsNew').classList.add('hide');\n    $('#ptsPicked').innerHTML=m?'Selected: <b style=\"color:var(--text)\">'+esc(m.name||m.email)+'</b> ('+esc(m.email||'')+', '+n(m.points_balance)+' points) <a href=\"#\" id=\"ptsClear\">Change</a>':'';\n    if(m) $('#ptsClear').addEventListener('click', function(e){ e.preventDefault(); pick(null); }); }\n  $('#ptsFind').addEventListener('keydown', function(e){ if(e.key==='Enter') e.preventDefault(); });\n  $('#ptsFind').addEventListener('input', function(){ clearTimeout(t); var q=this.value.trim(); if(q.length<2){ $('#ptsResults').innerHTML=''; return; }\n    t=setTimeout(function(){ api('/admin/members?q='+encodeURIComponent(q)).then(function(d){\n      $('#ptsResults').innerHTML=d.members.slice(0,6).map(function(m,i){ return '<button type=\"button\" class=\"btn ghost sm\" data-pi=\"'+i+'\" style=\"display:block;width:100%;text-align:left;margin-top:.3rem\">'+esc(m.name||'\u2014')+' <span class=\"dim\">'+esc(m.email||'')+', '+n(m.points_balance)+' pts</span></button>'; }).join('')+\n        '<button type=\"button\" class=\"btn ghost sm\" id=\"ptsAddNew\" style=\"display:block;width:100%;text-align:left;margin-top:.3rem\">Not a member yet? Add by email</button>';\n      $$('#ptsResults [data-pi]').forEach(function(b){ b.addEventListener('click', function(){ pick(d.members[+b.dataset.pi]); }); });\n      $('#ptsAddNew').addEventListener('click', function(){ pick(null); $('#ptsNew').classList.remove('hide'); var f=$('#ptsForm'); if(/@/.test(q)) fe(f,'email').value=q; fe(f,'email').focus(); });\n    }); }, 250); });\n  $('#ptsForm').addEventListener('submit', function(e){\n    e.preventDefault(); var f=e.target, out=$('#ptsOut'), pts=parseInt(fe(f,'points').value,10);\n    if(!pts){ out.innerHTML='<span class=\"minus\">Enter a point amount.</span>'; return; }\n    if(!picked && !fe(f,'email').value.trim()){ out.innerHTML='<span class=\"minus\">Pick a customer, or choose \"Add by email.\"</span>'; return; }\n    var who=picked?(picked.name||picked.email):fe(f,'email').value.trim();\n    if(!confirm((pts>0?'Add ':'Remove ')+n(Math.abs(pts))+' points '+(pts>0?'to ':'from ')+who+'?')) return;\n    var body={points:pts,note:fe(f,'reason').value+(fe(f,'note').value.trim()?': '+fe(f,'note').value.trim():'')};\n    if(picked) body.member_id=picked.id; else { body.email=fe(f,'email').value.trim(); body.name=fe(f,'name').value.trim(); }\n    api('/admin/adjust',{method:'POST',body:body}).then(function(r){ out.innerHTML='<span class=\"plus\">Done. New balance: '+n(r.balance)+'.</span>'; f.reset(); pick(null); })\n      .catch(function(err){ out.innerHTML='<span class=\"minus\">'+esc(err.message)+'</span>'; });\n  });\n};\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 OVERVIEW (owner) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS.overview = function(){\n  Promise.all([api('/admin/stats'), api('/admin/followups')]).then(function(r){\n    var s=r[0].stats, fu=r[1].followups, fuVal=fu.reduce(function(a,f){ return a+f.value_cents; },0);\n    $('#view').innerHTML='<h2>Overview</h2><div class=\"gauges\">'+\n      '<div class=\"gauge\"><b>'+usd(s.job_revenue_30d)+'</b><span>Jobs paid, 30 days</span><em>'+n(s.jobs_paid_30d)+' jobs</em></div>'+\n      '<div class=\"gauge\"><b>'+n(s.open_bookings)+'</b><span>Open jobs</span><em>Not yet paid</em></div>'+\n      '<div class=\"gauge\"><b>'+usd(fuVal)+'</b><span>Declined work to follow up</span><em>'+n(fu.length)+' customers</em></div>'+\n      '<div class=\"gauge\"><b>'+n(s.members)+'</b><span>Rewards members</span><em>'+n(s.new_30d)+' joined in 30 days</em></div></div>'+\n      '<div class=\"grid g4\" style=\"margin-bottom:1rem\">'+mini('Unredeemed points',n(s.outstanding_points)+' <span style=\"font-size:1rem;color:var(--dim)\">\u2248 '+usd(s.liability_cents)+'</span>')+mini('Open reward vouchers',usd(s.open_voucher_cents))+mini('Referrals converted',n(s.referrals_converted))+mini('Points redeemed, 30 days',n(s.redeemed_30d))+'</div>'+\n      '<div class=\"steel panel\"><h3>Recent points activity</h3>'+(r[0].recent.length?'<div class=\"scroll\"><table>'+r[0].recent.map(function(x){ return '<tr><td class=\"dim\">'+when(x.created_at)+'</td><td>'+esc(x.member?(x.member.name||x.member.email):'')+'</td><td>'+esc(x.note||TYPE[x.type])+'</td><td>'+signed(x.points)+'</td></tr>'; }).join('')+'</table></div>':'<div class=\"empty\">No activity yet.</div>')+'</div>';\n  }).catch(fail);\n};\nfunction mini(l,v){ return '<div class=\"steel panel\"><div class=\"dim\" style=\"font-family:var(--head);font-size:.85rem\">'+l+'</div><div style=\"font-family:var(--display);font-size:1.7rem;line-height:1.15\">'+v+'</div></div>'; }\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 TEAM & ACCESS (owner) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS.staff = function(){\n  api('/admin/staff').then(function(d){\n    var roleName={owner:'Owner',writer:'Service writer',tech:'Technician'};\n    $('#view').innerHTML='<h2>Team & access</h2>'+\n      '<div class=\"steel panel sec\" style=\"max-width:760px\"><h3>What each role can do</h3><div class=\"kv\">'+\n        '<dt>Owner</dt><dd>Everything, including revenue, program settings, adding points, voiding vouchers, undoing payments, and managing the team.</dd>'+\n        '<dt>Service writer</dt><dd>Jobs, scheduling and dispatch, estimates, texting customers, marking jobs paid, follow-ups, customers, and reward vouchers. No revenue reports, settings, or point adjustments.</dd>'+\n        '<dt>Technician</dt><dd>Only jobs assigned to them: their day, navigation, \"On my way\" texts, stage updates, findings, VIN and mileage, notes, and estimates if you allow it in Settings.</dd></div></div>'+\n      '<div class=\"steel panel sec\"><h3>Team</h3>'+(d.staff.length?'<div class=\"scroll\"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr>'+d.staff.map(function(s){\n        return '<tr><td>'+esc(s.name)+(s.active?'':' <span class=\"chip bad\">Disabled</span>')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(s.phone||'')+'</div></td><td>'+esc(s.email)+'</td>'+\n          '<td><select data-role=\"'+s.id+'\" style=\"width:auto\">'+['owner','writer','tech'].map(function(r){ return '<option value=\"'+r+'\"'+(r===s.role?' selected':'')+'>'+roleName[r]+'</option>'; }).join('')+'</select></td>'+\n          '<td class=\"dim\">'+(s.last_login_at?when(s.last_login_at):'Never')+'</td>'+\n          '<td style=\"white-space:nowrap\"><button class=\"btn ghost sm\" data-reset=\"'+s.id+'\">Reset password</button> <button class=\"btn '+(s.active?'danger':'ghost')+' sm\" data-active=\"'+s.id+'\" data-on=\"'+(s.active?0:1)+'\">'+(s.active?'Disable':'Enable')+'</button></td></tr>';\n      }).join('')+'</table></div>':'<div class=\"dim\">No team members yet. Add yourself as a technician or owner if you work jobs, so you can be assigned.</div>')+'</div>'+\n      '<form id=\"addStaff\" class=\"steel panel\" style=\"max-width:760px\"><h3>Add a team member</h3><div class=\"grid g2\">'+fld('Name','name','')+fld('Email (their sign-in)','email','','','email')+fld('Cell phone','phone','','','tel')+\n        '<div class=\"field\"><label>Role</label><select name=\"role\"><option value=\"writer\">Service writer</option><option value=\"tech\">Technician</option><option value=\"owner\">Owner</option></select></div></div>'+\n        '<div class=\"field\"><label>Temporary password</label><div class=\"row\" style=\"flex-wrap:nowrap\"><input name=\"password\" minlength=\"10\"><button type=\"button\" class=\"btn ghost sm\" id=\"genPw\">Generate</button></div><div class=\"help\">Give it to them in person or by text. They can change it under My account.</div></div>'+\n        '<button class=\"btn\">Add team member</button><div id=\"stOut\" class=\"help\" style=\"margin-top:.6rem\"></div></form>';\n    $('#genPw').addEventListener('click', function(){ var c='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', a=new Uint32Array(12); crypto.getRandomValues(a); fe($('#addStaff'),'password').value=Array.prototype.map.call(a,function(x){ return c[x%c.length]; }).join(''); });\n    $('#addStaff').addEventListener('submit', function(e){\n      e.preventDefault(); var f=e.target;\n      api('/admin/staff',{method:'POST',body:{name:fe(f,'name').value,email:fe(f,'email').value,phone:fe(f,'phone').value,role:fe(f,'role').value,password:fe(f,'password').value}})\n        .then(function(){ toast('Team member added. Sign-in: '+fe(f,'email').value); VIEWS.staff(); }).catch(function(err){ $('#stOut').innerHTML='<span class=\"minus\">'+esc(err.message)+'</span>'; });\n    });\n    $$('[data-role]').forEach(function(s){ s.addEventListener('change', function(){ api('/admin/staff/'+s.dataset.role,{method:'PATCH',body:{role:s.value}}).then(function(){ toast('Role updated. They\\'ll need to sign in again.'); }).catch(function(e){ toast(e.message,true); }); }); });\n    $$('[data-active]').forEach(function(b){ b.addEventListener('click', function(){ var on=b.dataset.on==='1'; if(!on&&!confirm('Disable this account? They\\'re signed out right away.')) return;\n      api('/admin/staff/'+b.dataset.active,{method:'PATCH',body:{active:on}}).then(function(){ toast(on?'Account enabled':'Account disabled'); VIEWS.staff(); }).catch(function(e){ toast(e.message,true); }); }); });\n    $$('[data-reset]').forEach(function(b){ b.addEventListener('click', function(){ var pw=prompt('New temporary password (10+ characters):',''); if(!pw) return;\n      api('/admin/staff/'+b.dataset.reset,{method:'PATCH',body:{password:pw}}).then(function(){ toast('Password reset. They\\'re signed out until they use it.'); }).catch(function(e){ toast(e.message,true); }); }); });\n  }).catch(fail);\n};\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 MY ACCOUNT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS.account = function(){\n  var owner=!S.me.id;\n  $('#view').innerHTML='<h2>My account</h2><div class=\"steel panel sec\" style=\"max-width:560px\"><div class=\"kv\"><dt>Name</dt><dd>'+esc(S.me.name)+'</dd><dt>Email</dt><dd>'+esc(S.me.email)+'</dd><dt>Role</dt><dd>'+esc({owner:'Owner',writer:'Service writer',tech:'Technician'}[S.me.role])+'</dd></div></div>'+\n    (owner?'<div class=\"steel panel sec\" style=\"max-width:560px\">You\\'re signed in with the main owner login. Its password is <b>LOYALTY_ADMIN_PASSWORD</b> on Render; change it there.</div>':\n    '<form id=\"pwForm\" class=\"steel panel sec\" style=\"max-width:560px\"><h3>Change password</h3>'+fld('Current password','current','','','password')+fld('New password (10+ characters)','next','','','password')+'<button class=\"btn\">Change password</button><div id=\"pwOut\" class=\"help\" style=\"margin-top:.6rem\"></div></form>')+\n    '<button class=\"btn ghost\" id=\"soBtn\">Sign out</button>';\n  $('#soBtn').addEventListener('click', signOut);\n  if($('#pwForm')) $('#pwForm').addEventListener('submit', function(e){ e.preventDefault(); var f=e.target;\n    api('/admin/password',{method:'POST',body:{current:fe(f,'current').value,next:fe(f,'next').value}}).then(function(){ toast('Password changed. Sign in again.'); signOut(); }).catch(function(err){ $('#pwOut').innerHTML='<span class=\"minus\">'+esc(err.message)+'</span>'; }); });\n};\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 SETTINGS (owner) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\nVIEWS.settings = function(){\n  api('/admin/settings').then(function(d){ S.settings=JSON.parse(JSON.stringify(d.config)); S.defaults=d.defaults; S.windows=S.settings.time_windows; renderSettings(); }).catch(fail);\n};\nfunction renderSettings(){\n  var c=S.settings;\n  function num(name,label,val,help,step){ return '<div class=\"field\"><label>'+label+'</label><input data-k=\"'+name+'\" type=\"number\" step=\"'+(step||'1')+'\" value=\"'+esc(val)+'\">'+(help?'<div class=\"help\">'+help+'</div>':'')+'</div>'; }\n  function txt(name,label,val,help,ph){ return '<div class=\"field\"><label>'+label+'</label><input data-k=\"'+name+'\" value=\"'+esc(val||'')+'\"'+(ph?' placeholder=\"'+esc(ph)+'\"':'')+'>'+(help?'<div class=\"help\">'+help+'</div>':'')+'</div>'; }\n  var tl={confirm:'Confirm appointment',on_way:'On my way',estimate:'Estimate ready',complete:'Job done + payment link',follow_up:'Recommended work follow-up',review:'Ask for a review'};\n  $('#view').innerHTML='<h2>Settings</h2><div class=\"settings\">'+\n    '<div class=\"steel panel sec\"><h3>Shop</h3><div class=\"grid g3\">'+\n      txt('shop_phone','Shop phone',c.shop_phone)+txt('payment_link','Payment portal link',c.payment_link,'Goes in the \"Job done\" text','https://...')+txt('notify_phone','Your cell for alerts',c.notify_phone,'Texted when a customer approves an estimate')+\n      num('labor_rate','Labor rate ($/hr)',(c.labor_rate_cents||0)/100,'Default for new labor lines. 0 = type each price',0.01)+num('parts_markup_pct','Parts markup (%)',c.parts_markup_pct,'Applied with the % button on part lines',0.5)+num('parts_tax_rate','Sales tax on parts (%)',c.parts_tax_rate,'Confirm what\\'s taxable with your CPA',0.01)+\n      num('follow_up_days','Follow up declined work after (days)',c.follow_up_days)+\n    '</div><div class=\"field\"><label>Appointment time windows (comma-separated)</label><input data-k=\"time_windows\" value=\"'+esc((c.time_windows||[]).join(', '))+'\"></div>'+\n    '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" data-k=\"tech_can_estimate\"'+(c.tech_can_estimate!==false?' checked':'')+'> Technicians can build and send estimates from the field</label></div>'+\n    '<div class=\"steel panel sec\"><h3>Text message templates</h3><div class=\"help\" style=\"margin:-.5rem 0 .8rem\">Placeholders: {first} {name} {service} {vehicle} {date} {window} {tech} {eta} {estimate_link} {total} {pay_link} {shop_phone} {review_link} {recommended}</div>'+\n      Object.keys(tl).map(function(k){ return '<div class=\"field\"><label>'+tl[k]+'</label><textarea data-tpl=\"'+k+'\" rows=\"2\">'+esc((c.sms_templates||{})[k]||'')+'</textarea></div>'; }).join('')+'</div>'+\n    '<div class=\"steel panel sec\"><h3>Rewards: earning</h3><div class=\"grid g4\">'+\n      num('points_per_dollar','Points per $1 of labor',c.points_per_dollar,'Also for fees paid in Shopify',0.25)+num('parts_points_per_dollar','Points per $1 of parts',c.parts_points_per_dollar==null?c.points_per_dollar:c.parts_points_per_dollar,'',0.25)+\n      num('welcome_bonus','Welcome bonus',c.welcome_bonus,'After first paid service')+num('cents_per_point','Cost per point (\u00a2)',c.cents_per_point,'For the liability estimate',0.1)+\n      num('referral_bonus_referrer','Referral: referrer gets',c.referral_bonus_referrer)+num('referral_bonus_friend','Referral: friend gets',c.referral_bonus_friend)+\n      num('referral_min_dollars','Referral minimum job ($)',c.referral_min_cents/100)+num('expire_months','Points expire after (months)',c.expire_months,'0 = never')+\n      num('book_ahead_bonus','Book-ahead bonus',c.book_ahead_bonus)+num('book_ahead_days','Book-ahead days',c.book_ahead_days)+num('offpeak_bonus','Slow-day bonus',c.offpeak_bonus)+\n      num('review_bonus','Google review bonus',c.review_bonus,'Leave at 0. Google bans rewards for reviews.')+'</div>'+\n      '<div class=\"field\"><label>Slow days</label><div class=\"row\">'+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function(d,i){ return '<label class=\"row\" style=\"gap:.3rem;margin:0;color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" data-day=\"'+i+'\"'+((c.offpeak_days||[]).indexOf(i)>-1?' checked':'')+'>'+d+'</label>'; }).join('')+'</div></div>'+\n      txt('payment_methods','Payment methods (comma-separated)',(c.payment_methods||[]).join(', '))+txt('google_review_url','Google review link',c.google_review_url,'Used in the \"Ask for a review\" text','https://g.page/r/.../review')+'</div>'+\n    '<div class=\"steel panel sec\"><h3>Rewards: tiers</h3><div class=\"scroll\"><table><tr><th>Name</th><th>Spend from ($)</th><th>Multiplier</th><th>Perks (one per line)</th><th></th></tr>'+\n      c.tiers.map(function(t,i){ return '<tr><td><input data-t=\"'+i+'\" data-f=\"name\" value=\"'+esc(t.name)+'\"></td><td><input data-t=\"'+i+'\" data-f=\"min\" type=\"number\" value=\"'+(t.min_spend_cents/100)+'\"></td><td><input data-t=\"'+i+'\" data-f=\"multiplier\" type=\"number\" step=\"0.05\" value=\"'+t.multiplier+'\"></td><td><textarea data-t=\"'+i+'\" data-f=\"perks\" rows=\"2\">'+esc((t.perks||[]).join('\\n'))+'</textarea></td><td><button class=\"btn danger sm\" data-deltier=\"'+i+'\">Remove</button></td></tr>'; }).join('')+\n      '</table></div><button class=\"btn ghost sm\" id=\"addTier\" style=\"margin-top:.6rem\">Add tier</button></div>'+\n    '<div class=\"steel panel sec\"><h3>Rewards: catalog</h3><div class=\"scroll\"><table><tr><th>On</th><th>Name</th><th>Points</th><th>Value ($)</th><th>Min invoice ($)</th><th>Description</th><th></th></tr>'+\n      c.rewards.map(function(r,i){ return '<tr><td><input type=\"checkbox\" data-r=\"'+i+'\" data-f=\"active\"'+(r.active?' checked':'')+'></td><td><input data-r=\"'+i+'\" data-f=\"name\" value=\"'+esc(r.name)+'\"></td><td><input data-r=\"'+i+'\" data-f=\"points\" type=\"number\" value=\"'+r.points+'\"></td><td><input data-r=\"'+i+'\" data-f=\"value\" type=\"number\" step=\"0.01\" value=\"'+(r.value_cents/100)+'\"></td><td><input data-r=\"'+i+'\" data-f=\"min\" type=\"number\" value=\"'+((r.min_invoice_cents||0)/100)+'\"></td><td><input data-r=\"'+i+'\" data-f=\"description\" value=\"'+esc(r.description||'')+'\"></td><td><button class=\"btn danger sm\" data-delrew=\"'+i+'\">Remove</button></td></tr>'; }).join('')+\n      '</table></div><button class=\"btn ghost sm\" id=\"addRew\" style=\"margin-top:.6rem\">Add reward</button></div>'+\n    '<div class=\"steel panel sec\"><h3>Your extra program rules</h3><div class=\"help\" style=\"margin:-.5rem 0 .8rem\">Shown on the website rules page. One per line.</div><textarea data-k=\"terms_extra\" rows=\"3\">'+esc((c.terms_extra||[]).join('\\n'))+'</textarea></div>'+\n    '<div class=\"row\"><button class=\"btn\" id=\"saveSet\">Save settings</button><button class=\"btn ghost\" id=\"resetSet\">Load recommended defaults</button></div></div>';\n  $$('[data-k]').forEach(function(inp){ inp.addEventListener('change', function(){\n    var k=inp.dataset.k, v=inp.value;\n    if(k==='tech_can_estimate') c.tech_can_estimate=inp.checked;\n    else if(k==='labor_rate') c.labor_rate_cents=cents(v);\n    else if(k==='referral_min_dollars') c.referral_min_cents=cents(v);\n    else if(k==='time_windows'||k==='payment_methods') c[k]=v.split(',').map(function(x){return x.trim();}).filter(Boolean);\n    else if(k==='terms_extra') c.terms_extra=v.split('\\n').map(function(x){return x.trim();}).filter(Boolean);\n    else if(['shop_phone','payment_link','notify_phone','google_review_url'].indexOf(k)>-1) c[k]=v.trim();\n    else c[k]=parseFloat(v);\n  }); });\n  $$('[data-tpl]').forEach(function(ta){ ta.addEventListener('change', function(){ c.sms_templates=c.sms_templates||{}; c.sms_templates[ta.dataset.tpl]=ta.value; }); });\n  $$('[data-day]').forEach(function(cb){ cb.addEventListener('change', function(){ c.offpeak_days=$$('[data-day]').filter(function(x){return x.checked;}).map(function(x){return +x.dataset.day;}); }); });\n  $$('[data-t]').forEach(function(inp){ inp.addEventListener('change', function(){ var t=c.tiers[inp.dataset.t], f=inp.dataset.f;\n    if(f==='min') t.min_spend_cents=cents(inp.value); else if(f==='multiplier') t.multiplier=parseFloat(inp.value); else if(f==='perks') t.perks=inp.value.split('\\n').map(function(s){return s.trim();}).filter(Boolean); else t.name=inp.value.trim(); }); });\n  $$('[data-r]').forEach(function(inp){ inp.addEventListener('change', function(){ var r=c.rewards[inp.dataset.r], f=inp.dataset.f;\n    if(f==='active') r.active=inp.checked; else if(f==='points') r.points=parseInt(inp.value,10); else if(f==='value') r.value_cents=cents(inp.value); else if(f==='min') r.min_invoice_cents=cents(inp.value); else r[f]=inp.value.trim(); }); });\n  $$('[data-deltier]').forEach(function(b){ b.addEventListener('click', function(){ c.tiers.splice(+b.dataset.deltier,1); renderSettings(); }); });\n  $$('[data-delrew]').forEach(function(b){ b.addEventListener('click', function(){ c.rewards.splice(+b.dataset.delrew,1); renderSettings(); }); });\n  $('#addTier').addEventListener('click', function(){ c.tiers.push({key:'tier'+Date.now().toString(36),name:'New tier',min_spend_cents:0,multiplier:1,perks:[]}); renderSettings(); });\n  $('#addRew').addEventListener('click', function(){ c.rewards.push({key:'r'+Date.now().toString(36),name:'New reward',points:1000,value_cents:2500,min_invoice_cents:0,active:false,description:''}); renderSettings(); });\n  $('#resetSet').addEventListener('click', function(){ if(confirm('Replace everything here with the recommended defaults? Nothing is saved until you press Save.')){ S.settings=JSON.parse(JSON.stringify(S.defaults)); renderSettings(); } });\n  $('#saveSet').addEventListener('click', function(){ c.tiers.sort(function(a,b){ return a.min_spend_cents-b.min_spend_cents; });\n    api('/admin/settings',{method:'PUT',body:{config:c}}).then(function(d){ S.settings=d.config; S.windows=d.config.time_windows; toast('Settings saved'); renderSettings(); }).catch(function(e){ toast(e.message,true); }); });\n}\n\n/* \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 boot \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\ntry{ S.token=sessionStorage.getItem(TOKEN_KEY); S.me=JSON.parse(sessionStorage.getItem(ME_KEY)||'null'); }catch(e){}\nif(S.token && S.me){\n  var exp=0; try{ exp=JSON.parse(atob(S.token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))).exp; }catch(e){}\n  if(exp>Date.now()) start(); else signOut();\n} else signOut();\n})();\n</script>\n</body>\n</html>\n";

module.exports = router;
