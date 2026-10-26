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
//   OLP_API_KEY                  Open Labor Project key: turns on "Book time" in quotes and estimates
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
// Owner password lives only on Render (LOYALTY_ADMIN_PASSWORD), never in this file.
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
  if (!SB_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!LOYALTY_SECRET) missing.push('LOYALTY_SECRET');
  if (!WEBHOOK_SECRET) missing.push('SHOPIFY_WEBHOOK_SECRET');
  if (!ADMIN_PASSWORD) missing.push('LOYALTY_ADMIN_PASSWORD');
  if (missing.length) console.warn('[loyalty] Missing env vars:', missing.join(', '));
  else console.log('[loyalty] ready');
})();

// ── Default program (editable later in Admin → Settings) ────────────────────
const DEFAULT_CONFIG = {
  // Program version. Saved settings older than this get the new program applied once (see getConfig).
  program_version: 2,

  // Earning: 1 point for every $1 paid (labor and parts). Rush fees don't earn points.
  points_per_dollar: 1,            // per $1 of labor (and fees paid in Shopify)
  parts_points_per_dollar: 1,      // per $1 of parts
  cents_per_point: 2.5,            // what 1 point costs you when redeemed (liability math)
  welcome_bonus: 100,              // shows as "pending" at sign-up; unlocks after the first PAID service
  birthday_bonus: 100,             // once a year in the member's birthday month (after their first paid job)
  comeback_bonus: 100,             // paid job within comeback_months of their last one
  comeback_months: 6,
  review_bonus: 0,                 // keep 0: Google's policy prohibits incentivized reviews

  // Referrals: "Give $25, Get $25". Credits are store-credit vouchers, never cash.
  referral_friend_cents: 2500,     // friend: $25 off their first service of referral_min_cents or more
  referral_referrer_cents: 2500,   // referrer: $25 credit once the friend's job is paid
  referral_min_cents: 20000,       // friend's job must be at least $200 (before discounts)
  referral_bonus_referrer: 0,      // old points-based referral bonus (kept at 0)
  referral_bonus_friend: 0,
  referral_milestones: [           // bonuses when this many friends have had a paid job
    { count: 3,  name: 'Free oil change', credit_cents: 7500, credit_name: 'Free oil change (labor and standard oil, up to $75)', status_tier: '', status_months: 0 },
    { count: 5,  name: 'Gold status for 12 months', credit_cents: 0, credit_name: '', status_tier: 'gold', status_months: 12 },
    { count: 10, name: 'Echelon status for 12 months + $100 credit', credit_cents: 10000, credit_name: '$100 referral milestone credit', status_tier: 'echelon', status_months: 12 }
  ],
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
  oil_change_months: 6,            // paid oil changes create a reminder this many months out
  reminders_auto: false,           // text due reminders automatically (10 AM–6 PM Central)
  reply_alerts: true,              // text "Your cell for alerts" when a customer replies to a text
  tech_can_estimate: true,         // technicians can build and send estimates from the field
  time_windows: ['8–10 AM', '10 AM–12 PM', '12–2 PM', '2–4 PM', '4–6 PM', '6–8 PM', '8–10 PM'],   // also the website's arrival windows
  jobs_per_window: 1,              // jobs your team can take at once; long jobs hold more than one window
  booking_text_on: true,           // text customers the moment they book online
  sms_templates: {
    booking_received: 'Hi {first}, this is Upper Echelon Automotive. We got your booking request for {service} on {date}, arriving {window}. We\'ll text to confirm shortly. Reply here with any questions.',
    confirm:   'Hi {first}, this is Upper Echelon Automotive. Your {service} appointment is confirmed for {date}, {window}. Questions? Call {shop_phone}.',
    on_way:    'Hi {first}, {tech} from Upper Echelon Automotive is on the way. Estimated arrival: {eta}.',
    estimate:  'Hi {first}, your estimate for the {vehicle} is ready. Review and approve it here: {estimate_link}',
    complete:  'Hi {first}, your {vehicle} is all set. Total due: {total}. Pay securely here: {pay_link} Thank you for choosing Upper Echelon Automotive!',
    follow_up: 'Hi {first}, on your last visit we recommended: {recommended}. Want us to get that scheduled? Reply or call {shop_phone}.',
    review:    'Thanks for choosing Upper Echelon Automotive, {first}! If you have a minute, a Google review helps a small shop like ours a lot: {review_link}',
    invoice:   'Hi {first}, here is your itemized invoice for the {vehicle} from Upper Echelon Automotive: {invoice_link}',
    inspection:'Hi {first}, your {vehicle} inspection report is ready, with photos. {flagged} item(s) need a look: {report_link}',
    reminder:  'Hi {first}, it\'s time for your {title} on your {vehicle}. Want us to come to you? Reply here or call {shop_phone}. – Upper Echelon Automotive'
  },

  // Tiers: rolling 12-month spend. Multiplier applies to service points (not bonuses).
  // warranty_days is shown to the customer and on the desk; it covers labor on shop-supplied parts.
  tiers: [
    { key: 'standard', name: 'Member',  min_spend_cents: 0,      multiplier: 1,    warranty_days: 90,
      perks: ['1 point per $1', 'Birthday bonus', 'Comeback bonus'] },
    { key: 'silver',   name: 'Silver',  min_spend_cents: 60000,  multiplier: 1.25, warranty_days: 90,
      perks: ['1.25x points', 'Priority on next-day slots', 'Free multi-point inspection every visit'] },
    { key: 'gold',     name: 'Gold',    min_spend_cents: 150000, multiplier: 1.5,  warranty_days: 180,
      perks: ['1.5x points', 'Priority same-day scheduling', '6-month labor warranty on shop-supplied parts'] },
    { key: 'echelon',  name: 'Echelon', min_spend_cents: 300000, multiplier: 2,    warranty_days: 365,
      perks: ['2x points', 'First call on emergency dispatch', 'One rush fee waived per quarter', '12-month labor warranty on shop-supplied parts'] }
  ],

  // Rewards. Dollar-off rewards come off labor only; min_invoice_cents is the invoice before the discount.
  rewards: [
    { key: 'addon',    name: 'Free add-on check',      points: 250,  value_cents: 3000,  min_invoice_cents: 0,     active: true,
      description: 'Battery and charging test, tire check, and fluid top-off added to any paid visit.' },
    { key: 'labor15',  name: '$15 off labor',          points: 600,  value_cents: 1500,  min_invoice_cents: 10000, active: true,
      description: 'On invoices of $100 or more.' },
    { key: 'labor35',  name: '$35 off labor',          points: 1200, value_cents: 3500,  min_invoice_cents: 15000, active: true,
      description: 'On invoices of $150 or more.' },
    { key: 'rotation', name: 'Free tire rotation or filter install', points: 1800, value_cents: 4500, min_invoice_cents: 0, active: true,
      description: 'Tire rotation, or engine/cabin air filter installed (you pay for the filter), added to any paid visit.' },
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
  let saved = (rows && rows[0] && rows[0].config) || null;
  // Saved settings from before the 2026 program revision: apply the new earning, rewards, tiers and
  // referral program once, keeping everything else the owner set (shop, texts, slow days, etc.).
  if (saved && (Number(saved.program_version) || 1) < DEFAULT_CONFIG.program_version) {
    saved = Object.assign({}, saved);
    PROGRAM_KEYS.forEach(k => { saved[k] = JSON.parse(JSON.stringify(DEFAULT_CONFIG[k])); });
    try {
      await sb('uea_loyalty_settings?id=eq.1', { method: 'PATCH', body: { config: saved, updated_at: new Date().toISOString() } });
      console.log('[loyalty] rewards program upgraded to version', DEFAULT_CONFIG.program_version);
    } catch (e) { console.warn('[loyalty] program upgrade not saved (will retry):', e.message); }
  }
  cfgCache = Object.assign({}, DEFAULT_CONFIG, saved || {});
  // Settings saved before the evening windows existed still had the old default list: upgrade it.
  if (JSON.stringify(cfgCache.time_windows) === JSON.stringify(['8–10 AM', '10 AM–12 PM', '12–2 PM', '2–4 PM', '4–6 PM'])) cfgCache.time_windows = DEFAULT_CONFIG.time_windows.slice();
  cfgCache.sms_templates = Object.assign({}, DEFAULT_CONFIG.sms_templates, cfgCache.sms_templates || {});
  cfgCache._updated_at = rows && rows[0] ? rows[0].updated_at : null;
  cfgAt = Date.now();
  return cfgCache;
}

// Settings that belong to the rewards program itself (replaced by a program upgrade).
const PROGRAM_KEYS = ['program_version', 'points_per_dollar', 'parts_points_per_dollar', 'birthday_bonus', 'comeback_bonus', 'comeback_months',
  'referral_friend_cents', 'referral_referrer_cents', 'referral_min_cents', 'referral_bonus_referrer', 'referral_bonus_friend',
  'referral_milestones', 'tiers', 'rewards'];

// member (optional): a status a member earned through referrals ("Gold for 12 months") counts
// until it runs out, when it beats the tier their spend has reached.
function tierFor(cfg, spendCents, member) {
  const tiers = [...(cfg.tiers || [])].sort((a, b) => a.min_spend_cents - b.min_spend_cents);
  let tier = tiers[0];
  for (const t of tiers) if (spendCents >= t.min_spend_cents) tier = t;
  let status = null;
  if (member && member.status_tier && member.status_until && Date.parse(member.status_until) > Date.now()) {
    const st = tiers.find(t => t.key === member.status_tier);
    if (st && st.min_spend_cents > tier.min_spend_cents) { tier = st; status = { tier: st.key, name: st.name, until: member.status_until }; }
  }
  const next = tiers.find(t => t.min_spend_cents > tier.min_spend_cents) || null;
  return { tier, next, status };
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
  if (day == null || !['shopify', 'website'].includes(b.source)) return out;
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
// Last 10 digits of a phone number, so "(512) 555-0100" and "+1 512-555-0100" match.
const phoneKey = p => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
const money = c => `$${(c / 100).toFixed(2)}`;
const n0 = v => Number(v || 0).toLocaleString('en-US');

// ── Members ─────────────────────────────────────────────────────────────────
async function findMember({ customerId, email, phone }) {
  if (customerId) {
    const r = await sb(`uea_loyalty_members?shopify_customer_id=eq.${enc(customerId)}&select=*`);
    if (r[0]) return r[0];
  }
  if (email) {
    const r = await sb(`uea_loyalty_members?email=eq.${enc(email)}&select=*`);
    if (r[0]) return r[0];
  }
  const pk = phoneKey(phone);
  if (pk) {
    const r = await sb(`uea_loyalty_members?phone_key=eq.${pk}&select=*&order=last_activity_at.desc&limit=1`);
    if (r[0]) return r[0];
  }
  return null;
}

async function upsertMember({ customerId, email, name, phone, address }) {
  customerId = customerId ? String(customerId) : null;
  email = cleanEmail(email);
  if (email && !/.+@.+\..+/.test(email)) email = null;
  name = name ? String(name).trim().slice(0, 120) : null;
  phone = phone ? String(phone).trim().slice(0, 40) : null;
  address = address ? String(address).trim().slice(0, 300) : null;
  const pk = phoneKey(phone);

  let m = await findMember({ customerId, email, phone });
  if (m) {
    const patch = {};
    if (customerId && !m.shopify_customer_id) patch.shopify_customer_id = customerId;
    if (email && !m.email && !(await findMember({ email }))) patch.email = email;   // never steal another client's email
    if (name && !m.name) patch.name = name;
    if (phone && !m.phone) patch.phone = phone;
    if (pk && !m.phone_key) patch.phone_key = pk;
    if (address && address !== m.address) patch.address = address;   // keep their latest service address
    if (Object.keys(patch).length) {
      const r = await sb(`uea_loyalty_members?id=eq.${m.id}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
      m = r[0] || m;
    }
    return m;
  }
  if (!customerId && !email && !pk) throw httpErr(400, 'Add a phone number or email to save this customer.');

  for (let i = 0; i < 5; i++) {
    try {
      const r = await sb('uea_loyalty_members', {
        method: 'POST',
        body: { shopify_customer_id: customerId, email, name, phone, phone_key: pk, address, referral_code: makeCode('UEA-', 5) },
        prefer: 'return=representation'
      });
      return r[0];
    } catch (e) {
      if (!/duplicate|unique/i.test(e.message)) throw e;
      const again = await findMember({ customerId, email, phone });
      if (again) return again;
    }
  }
  throw httpErr(500, 'Could not create member');
}

// ── Client vehicles ─────────────────────────────────────────────────────────
const vehNorm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cleanVin = v => { const x = String(v || '').toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, ''); return x.length === 17 ? x : null; };
async function upsertVehicle(memberId, { vehicle, vin, plate, mileage }) {
  const desc = vehicle ? String(vehicle).trim().replace(/\s+/g, ' ').slice(0, 120) : null;
  vin = cleanVin(vin);
  plate = plate ? String(plate).trim().toUpperCase().slice(0, 12) : null;
  mileage = mileage ? parseInt(String(mileage).replace(/\D/g, ''), 10) || null : null;
  if (!memberId || (!desc && !vin)) return null;
  const list = await sb(`uea_client_vehicles?member_id=eq.${enc(memberId)}&select=*`);
  const d = vehNorm(desc);
  const hit = (vin && list.find(x => x.vin === vin)) ||
    (d && list.find(x => vehNorm(x.description) === d)) ||
    (d && list.find(x => !x.vin || !vin ? (d.startsWith(vehNorm(x.description)) || vehNorm(x.description).startsWith(d)) : false));
  if (hit) {
    const patch = { last_seen_at: new Date().toISOString() };
    if (vin && !hit.vin) patch.vin = vin;
    if (plate && plate !== hit.plate) patch.plate = plate;
    if (mileage && (!hit.mileage || mileage > hit.mileage)) patch.mileage = mileage;
    if (desc && desc.length > String(hit.description || '').length) patch.description = desc;   // keep the most detailed name
    const r = await sb(`uea_client_vehicles?id=eq.${hit.id}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
    return r[0] || hit;
  }
  const r = await sb('uea_client_vehicles', { method: 'POST', prefer: 'return=representation',
    body: { member_id: memberId, description: desc || `Vehicle ${vin}`, vin, plate, mileage } });
  return r[0];
}
// Saves the customer and their vehicle from any job. Never blocks the job if it fails.
async function linkClient(info) {
  let member = null, vehicle = null;
  try {
    member = info.member_id ? (await sb(`uea_loyalty_members?id=eq.${enc(info.member_id)}&select=*`))[0] || null : null;
    if (member && info.address && info.address !== member.address) {
      await sb(`uea_loyalty_members?id=eq.${member.id}`, { method: 'PATCH', body: { address: String(info.address).slice(0, 300) } });
    }
    if (!member) member = await upsertMember(info);
  } catch (e) { return { member: null, vehicle: null }; }
  try { vehicle = await upsertVehicle(member.id, info); } catch (e) { console.warn('[loyalty] vehicle not saved:', e.message); }
  return { member, vehicle };
}

// ── Earning ─────────────────────────────────────────────────────────────────
// pointsCents: the part of the invoice that earns points (rush fees taken out). Defaults to the full amount.
// invoiceCents: the invoice before reward/credit discounts, used for the referral minimum.
async function awardPurchase({ member, amountCents, laborCents, partsCents, orderRef, orderId, label, by = 'system', rushCents = 0, invoiceCents }) {
  if (laborCents == null && partsCents == null) { laborCents = amountCents || 0; partsCents = 0; }
  laborCents = Math.max(0, laborCents || 0); partsCents = Math.max(0, partsCents || 0);
  amountCents = laborCents + partsCents;
  if (amountCents <= 0) return { skipped: true, points: 0 };
  if (member.is_fleet) return { skipped: true, fleet: true, points: 0, bonuses: [] };
  const cfg = await getConfig();

  const spendBefore = Number(await rpc('uea_loyalty_spend_12mo', { p_member: member.id }));
  const { tier } = tierFor(cfg, spendBefore, member);
  const mult = Number(tier.multiplier) || 1;
  const ppd = Number(cfg.points_per_dollar ?? 1);
  const pppd = Number(cfg.parts_points_per_dollar ?? ppd);
  const earnLabor = Math.max(0, laborCents - Math.max(0, rushCents || 0));   // rush fees don't earn points
  const pts = Math.floor(((earnLabor / 100) * ppd + (partsCents / 100) * pppd) * mult);

  // The member's last paid job before this one (not an earlier payment of this same job), for the comeback bonus.
  const sameJob = orderRef.startsWith('booking:') ? orderRef.split(':').slice(0, 2).join(':') + ':' : `${orderRef}:`;
  const prevEarn = cfg.comeback_bonus > 0
    ? (await sb(`uea_loyalty_ledger?member_id=eq.${member.id}&type=eq.earn&ref=not.like.${enc(sameJob)}*&select=created_at&order=created_at.desc&limit=1`).catch(() => []))[0]
    : null;

  const earn = await rpc('uea_loyalty_post', {
    p_member: member.id, p_type: 'earn', p_points: pts, p_amount_cents: amountCents,
    p_ref: `${orderRef}:earn`, p_order: orderId || null,
    p_note: `${label || 'Service'} (${money(amountCents)}, ${tier.name} ${mult}x)`, p_by: by
  });
  if (!earn.inserted) return { duplicate: true };

  const out = { points: pts, bonuses: [] };

  // Comeback bonus: a paid job within comeback_months of their last one. Counted in this job's points,
  // so "Undo payment" takes it back too.
  if (prevEarn && cfg.comeback_bonus > 0) {
    const since = new Date(prevEarn.created_at); since.setMonth(since.getMonth() + (Number(cfg.comeback_months) || 6));
    if (since.getTime() >= Date.now()) {
      const c = await rpc('uea_loyalty_post', {
        p_member: member.id, p_type: 'bonus', p_points: Number(cfg.comeback_bonus),
        p_ref: `${orderRef}:comeback`, p_note: `Comeback bonus: back within ${Number(cfg.comeback_months) || 6} months`, p_by: by
      });
      if (c.inserted) { out.points += Number(cfg.comeback_bonus); out.bonuses.push('comeback bonus'); }
    }
  }

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

  // Referral: once the friend's first qualifying job is paid, the person who referred them gets their credit.
  if (member.referred_by && !member.referral_rewarded && (invoiceCents || amountCents) >= (cfg.referral_min_cents || 0)) {
    const r = await rewardReferrer(member, cfg, by).catch(e => { console.error('[loyalty] referral reward failed:', e.message); return null; });
    if (r && r.rewarded) out.bonuses.push('referral');
    if (r && r.blocked) out.referral_blocked = r.blocked;
  }
  return out;
}

// ── Credit vouchers (referral credits and milestone rewards) ─────────────────
// Same UER- codes as point rewards, so they work everywhere a reward does (booking form, Mark paid).
const CREDIT_PREFIX = 'ref_';
async function issueCredit(memberId, { key, name, valueCents }) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await sb('uea_loyalty_vouchers', {
        method: 'POST', prefer: 'return=representation',
        body: { member_id: memberId, code: makeCode('UER-', 6), reward_key: key, reward_name: name, value_cents: valueCents, points_cost: 0, status: 'active' }
      });
      return r[0];
    } catch (e) { if (!/duplicate|unique/i.test(e.message)) throw e; }
  }
  throw httpErr(500, 'Could not create the credit. Try again.');
}
// Minimum invoice (before discounts) a voucher needs.
function voucherMin(cfg, v) {
  if (v.reward_key === 'ref_friend') return Number(cfg.referral_min_cents) || 0;
  const rw = (cfg.rewards || []).find(r => r.key === v.reward_key);
  return rw && rw.min_invoice_cents ? rw.min_invoice_cents : 0;
}
const isCredit = v => String(v.reward_key || '').startsWith(CREDIT_PREFIX);
const normAddr = a => String(a || '').toLowerCase().replace(/\b(apt|unit|ste|suite|#)\b.*$/, '').replace(/[^a-z0-9]/g, '');

// Checks a referral before it's attached. Returns the referrer row, or throws a customer-facing error.
async function checkReferral(member, code) {
  code = String(code || '').trim().toUpperCase();
  if (!/^UEA-[A-Z0-9]{5}$/.test(code)) throw httpErr(400, 'Enter a code like UEA-AB12C.');
  if (member.referred_by) throw httpErr(400, 'A referral code is already on your account.');
  if (member.first_paid_at) throw httpErr(400, 'Referral codes are for new customers, before their first service.');
  if (member.is_fleet) throw httpErr(400, 'Fleet accounts get FleetCare pricing instead of referral credits.');
  const ref = (await sb(`uea_loyalty_members?referral_code=eq.${enc(code)}&select=id,name,phone_key,address,email`))[0];
  if (!ref) throw httpErr(400, 'That referral code was not found.');
  if (ref.id === member.id) throw httpErr(400, "You can't use your own code.");
  if (member.phone_key && ref.phone_key && member.phone_key === ref.phone_key) throw httpErr(400, "You can't use your own code.");
  const a = normAddr(member.address), b = normAddr(ref.address);
  if (a && b && a.length > 6 && a === b) throw httpErr(400, 'Referral credits are for friends at a different address.');
  return ref;
}
// Attaches the referral and gives the friend their welcome credit. Safe to call twice.
async function applyReferral(member, code) {
  const ref = await checkReferral(member, code);
  const cfg = await getConfig();
  const set = await sb(`uea_loyalty_members?id=eq.${member.id}&referred_by=is.null`, { method: 'PATCH', body: { referred_by: ref.id }, prefer: 'return=representation' });
  if (!set || !set[0]) throw httpErr(400, 'A referral code is already on your account.');
  let voucher = null;
  if (Number(cfg.referral_friend_cents) > 0) {
    voucher = await issueCredit(member.id, {
      key: 'ref_friend', valueCents: Number(cfg.referral_friend_cents),
      name: `${money(cfg.referral_friend_cents).replace('.00', '')} off your first service (friend referral)`
    });
  }
  return { referrer: ref, voucher };
}

// The friend's job is paid: credit the referrer, check milestones, and text them the good news.
async function rewardReferrer(friend, cfg, by) {
  const referrer = (await sb(`uea_loyalty_members?id=eq.${friend.referred_by}&select=*`))[0];
  // Same household after the fact (address added later): no credit, and stop checking.
  const blocked = referrer && ((friend.phone_key && friend.phone_key === referrer.phone_key) ||
    (normAddr(friend.address).length > 6 && normAddr(friend.address) === normAddr(referrer.address)));
  const flipped = await sb(`uea_loyalty_members?id=eq.${friend.id}&referral_rewarded=eq.false`, {
    method: 'PATCH', body: { referral_rewarded: true }, prefer: 'return=representation'
  });
  if (!flipped || !flipped[0] || !referrer) return { rewarded: false };
  if (blocked) return { rewarded: false, blocked: 'same address or phone as the person who referred them' };
  if (referrer.is_fleet) return { rewarded: false, blocked: 'the referrer is a fleet account' };

  const who = firstName(friend.name) !== 'there' ? firstName(friend.name) : 'Your friend';
  const got = [];
  if (Number(cfg.referral_referrer_cents) > 0) {
    await issueCredit(referrer.id, { key: 'ref_credit', valueCents: Number(cfg.referral_referrer_cents),
      name: `${money(cfg.referral_referrer_cents).replace('.00', '')} referral credit (${who})` });
    got.push(`${money(cfg.referral_referrer_cents).replace('.00', '')} credit`);
  }
  // Old points-based referral bonus, if the owner ever turns it back on.
  if (Number(cfg.referral_bonus_referrer) > 0) {
    await rpc('uea_loyalty_post', { p_member: referrer.id, p_type: 'referral', p_points: Number(cfg.referral_bonus_referrer),
      p_ref: `referral-referrer:${friend.id}`, p_note: `Referral bonus: ${friend.name || 'a friend'} completed a service`, p_by: by });
  }
  if (Number(cfg.referral_bonus_friend) > 0) {
    await rpc('uea_loyalty_post', { p_member: friend.id, p_type: 'referral', p_points: Number(cfg.referral_bonus_friend),
      p_ref: `referral-friend:${friend.id}`, p_note: 'Referral bonus: welcome from a friend', p_by: by });
  }

  // Milestones: count friends whose job has been paid.
  const done = (await sb(`uea_loyalty_members?referred_by=eq.${referrer.id}&referral_rewarded=eq.true&select=id`)).length;
  const ms = (cfg.referral_milestones || []).find(m => Number(m.count) === done);
  if (ms) {
    if (Number(ms.credit_cents) > 0) {
      await issueCredit(referrer.id, { key: `ref_m${ms.count}`, valueCents: Number(ms.credit_cents), name: ms.credit_name || ms.name });
    }
    if (ms.status_tier && Number(ms.status_months) > 0) {
      const base = referrer.status_until && Date.parse(referrer.status_until) > Date.now() ? new Date(referrer.status_until) : new Date();
      const until = new Date(base); until.setMonth(until.getMonth() + Number(ms.status_months));
      const keepHigher = referrer.status_tier && Date.parse(referrer.status_until || 0) > Date.now() &&
        tierRank(cfg, referrer.status_tier) > tierRank(cfg, ms.status_tier);
      await sb(`uea_loyalty_members?id=eq.${referrer.id}`, { method: 'PATCH',
        body: { status_tier: keepHigher ? referrer.status_tier : ms.status_tier, status_until: until.toISOString() } });
    }
    got.push(ms.name);
  }

  // Let them know; this is what makes people refer the next friend. Never blocks the payment.
  if (referrer.phone && process.env.TEXTBELT_KEY && got.length) {
    const msg = `${who} just had their first service with Upper Echelon Automotive. Thanks for the referral! You earned: ${got.join(' + ')}. It's in your Rewards at ueauto.store/#rewards`;
    sendSms(referrer.phone, msg, { member: referrer, kind: 'referral', by: 'Rewards' }).catch(e => console.warn('[loyalty] referral text not sent:', e.message));
  }
  return { rewarded: true, milestone: ms ? ms.name : null, count: done };
}
function tierRank(cfg, key) {
  const t = (cfg.tiers || []).find(x => x.key === key);
  return t ? Number(t.min_spend_cents) || 0 : -1;
}

// Referral progress for the customer's Rewards page and the desk.
async function referralSummary(member, cfg) {
  const friends = await sb(`uea_loyalty_members?referred_by=eq.${member.id}&select=referral_rewarded`).catch(() => []);
  const rewarded = friends.filter(f => f.referral_rewarded).length;
  const ms = (cfg.referral_milestones || []).slice().sort((a, b) => a.count - b.count);
  return {
    code: member.referral_code,
    link: member.referral_code ? `https://ueauto.store/?ref=${member.referral_code}#rewards` : null,
    friend_cents: Number(cfg.referral_friend_cents) || 0,
    referrer_cents: Number(cfg.referral_referrer_cents) || 0,
    min_cents: Number(cfg.referral_min_cents) || 0,
    rewarded, pending: friends.length - rewarded,
    milestones: ms.map(m => ({ count: Number(m.count), name: m.name, reached: rewarded >= Number(m.count) })),
    next: ms.find(m => rewarded < Number(m.count)) ? (({ count, name }) => ({ count: Number(count), name, to_go: Number(count) - rewarded }))(ms.find(m => rewarded < Number(m.count))) : null
  };
}

// ── Birthday bonus: once a year, in the member's birthday month ───────────────
// Needs a paid job on record, and a birthday saved before this month (so it can't be set to "this month" for points).
let lastBirthdayRun = 0;
async function maybeBirthdays(force) {
  if (!force && Date.now() - lastBirthdayRun < 60 * 60 * 1000) return;
  lastBirthdayRun = Date.now();
  try {
    const cfg = await getConfig();
    if (!(Number(cfg.birthday_bonus) > 0)) return;
    const [y, m] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).split('-').map(Number);
    const monthStart = new Date(Date.UTC(y, m - 1, 1, 6)).toISOString();   // midnight Central (CST)
    const list = await sb(`uea_loyalty_members?birth_month=eq.${m}&first_paid_at=not.is.null&is_fleet=not.is.true&birthday_set_at=lt.${enc(monthStart)}&select=id`);
    for (const x of list) {
      await rpc('uea_loyalty_post', { p_member: x.id, p_type: 'bonus', p_points: Number(cfg.birthday_bonus),
        p_ref: `birthday:${x.id}:${y}`, p_note: 'Happy birthday from Upper Echelon!', p_by: 'system' });
    }
  } catch (e) { if (!/birth_month|birthday_set_at|does not exist/i.test(e.message)) console.error('[loyalty] birthday run failed:', e.message); }
}
setInterval(() => { maybeBirthdays(); }, 60 * 60 * 1000).unref();

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

async function createBookingFromOrder(order, opts = {}) {
  const items = order.line_items || [];
  const isBooking = items.some(li => BOOKING_VARIANTS.includes(String(li.variant_id)) || /booking/i.test(li.title || ''));
  if (!isBooking) return 'not_booking';

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

  const address = pickProp(props, /address|location/i);
  const { member, vehicle: veh } = await linkClient({ customerId: c.id, email, name, phone, address, vehicle });

  // The website sends the booking straight to the desk first (POST /book) with a Booking Ref.
  // When Shopify's order arrives, attach it to that booking instead of making a second copy.
  const ref = pickProp(props, /booking ref/i);
  if (ref && /^[a-zA-Z0-9-]{8,64}$/.test(ref)) {
    const existing = (await sb(`uea_loyalty_bookings?web_ref=eq.${enc(ref)}&select=id,order_name`))[0];
    if (existing) {
      await sb(`uea_loyalty_bookings?id=eq.${existing.id}`, { method: 'PATCH', body: {
        shopify_order_id: String(order.id), order_name: order.name || existing.order_name || null,
        member_id: member ? member.id : undefined, email: email || undefined, vehicle_id: veh ? veh.id : undefined
      } });
      await logEvent(existing.id, 'Website', 'status', `Shopify order ${order.name || order.id} received`);
      return 'linked';
    }
  }

  const day = apptDay(pickProp(props, /date/i));
  if (opts.upcomingOnly && day != null && day < centralDay(Date.now())) return 'past';
  const created = await sb('uea_loyalty_bookings?on_conflict=shopify_order_id', {
    method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
    body: {
      source: 'shopify', shopify_order_id: String(order.id), order_name: order.name || null,
      member_id: member ? member.id : null, customer_name: name || null, email, phone: phone || null,
      service: pickProp(props, /service/i), vehicle,
      appt_date: pickProp(props, /date/i), appt_time: pickProp(props, /time/i),
      address,
      details: props, rush, voucher_code: voucher,
      sched_date: day != null ? new Date(day).toISOString().slice(0, 10) : null,
      sched_window: pickProp(props, /time|window/i),
      concern: pickProp(props, /concern|issue|problem|symptom|describe|description|notes?$/i),
      web_ref: ref && /^[a-zA-Z0-9-]{8,64}$/.test(ref) ? ref : null,
      vehicle_id: veh ? veh.id : null
    }
  });
  if (created && created[0]) {
    await logEvent(created[0].id, opts.by || 'Website', 'status', opts.by ? `Imported from Shopify order ${order.name || order.id}` : `Booked online${rush ? ' (rush)' : ''}`);
    return 'created';
  }
  return 'duplicate';
}

async function memberForBooking(b) {
  if (b.member_id) {
    const m = (await sb(`uea_loyalty_members?id=eq.${b.member_id}&select=*`))[0];
    if (m) return m;
  }
  if (!b.email && !phoneKey(b.phone)) return null;
  const m = await upsertMember({ email: b.email, name: b.customer_name, phone: b.phone, address: b.address });
  await sb(`uea_loyalty_bookings?id=eq.${b.id}`, { method: 'PATCH', body: { member_id: m.id } });
  return m;
}

async function markBookingPaid(b, { laborCents, partsCents, method, ref, voucherCode, note, by }) {
  laborCents = Math.max(0, Math.round(laborCents || 0));
  partsCents = Math.max(0, Math.round(partsCents || 0));
  const total = laborCents + partsCents;
  if (total <= 0) throw httpErr(400, 'Enter what the customer paid for labor and/or parts.');
  if (!method) throw httpErr(400, 'Choose how the customer paid.');

  // One points reward per invoice, plus any number of referral/milestone credits.
  const cfgV = await getConfig();
  const codes = [...new Set((String(voucherCode || '').toUpperCase().match(/UER-[A-Z0-9]{6}/g) || []))];
  if (String(voucherCode || '').trim() && !codes.length) throw httpErr(400, 'Voucher codes look like UER-XXXXXX.');
  const vouchers = [];
  for (const code of codes) {
    const v = (await sb(`uea_loyalty_vouchers?code=eq.${enc(code)}&select=*`))[0];
    if (!v) throw httpErr(400, `Voucher ${code} was not found.`);
    if (!['active', 'applied'].includes(v.status)) throw httpErr(400, `Voucher ${code} is already ${v.status}.`);
    vouchers.push(v);
  }
  if (vouchers.filter(v => !isCredit(v)).length > 1) throw httpErr(400, 'Only one points reward per invoice. Referral credits can be added on top.');
  const discounts = vouchers.reduce((s, v) => s + (Number(v.value_cents) || 0), 0);
  for (const v of vouchers) {
    const min = voucherMin(cfgV, v);
    if (min && total + discounts < min) {
      throw httpErr(400, `${v.reward_name} needs an invoice of at least ${money(min)} before discounts. Remove ${v.code} or adjust the amounts.`);
    }
  }

  const seq = (b.pay_seq || 0) + 1;
  const upd = await sb(`uea_loyalty_bookings?id=eq.${b.id}&status=eq.open`, {
    method: 'PATCH', prefer: 'return=representation',
    body: {
      status: 'paid', labor_cents: laborCents, parts_cents: partsCents, total_cents: total,
      payment_method: String(method).slice(0, 40), payment_ref: ref ? String(ref).slice(0, 80) : null,
      voucher_used: vouchers.length ? vouchers.map(v => v.code).join(',') : null, paid_at: new Date().toISOString(), pay_seq: seq,
      admin_note: note ? String(note).slice(0, 300) : b.admin_note || null,
      stage: 'completed', updated_at: new Date().toISOString(),
      follow_up_date: estTotals(b.estimate, 0).declined.length
        ? new Date(Date.now() + (Number(cfgV.follow_up_days) || 30) * 86400000).toISOString().slice(0, 10)
        : b.follow_up_date || null
    }
  });
  if (!upd[0]) throw httpErr(400, 'This booking is already marked paid or was cancelled.');
  await logEvent(b.id, by || 'Admin', 'payment', `Marked paid ${money(total)} (labor ${money(laborCents)}, parts ${money(partsCents)}) by ${method}${ref ? `, #${ref}` : ''}` +
    (vouchers.length ? `; used ${vouchers.map(v => `${v.code} (${v.reward_name})`).join(', ')}` : ''));

  let award = { points: 0, bonuses: [], no_member: false };
  const member = await memberForBooking(b);
  if (member) {
    const label = [b.order_name || 'Job', b.service].filter(Boolean).join(': ').slice(0, 80);
    // Rush fees don't earn points: take out any rush/priority fee line on the estimate (if it was charged here).
    const rushCents = ((b.estimate && b.estimate.lines) || [])
      .filter(l => l.type === 'fee' && l.status !== 'declined' && /rush|priority|emergency/i.test(l.desc || ''))
      .reduce((s, l) => s + lineAmount(l), 0);
    const r = await awardPurchase({ member, laborCents, partsCents, orderRef: `booking:${b.id}:${seq}`, label, by: by || 'admin',
      rushCents: Math.min(rushCents, laborCents), invoiceCents: total + discounts });
    award = { points: r.points || 0, bonuses: r.bonuses || [], no_member: false, fleet: !!r.fleet };
    if (r.referral_blocked) await logEvent(b.id, 'Rewards', 'note', `No referral credit: ${r.referral_blocked}.`);
    if (!r.fleet) {
      for (const bb of bookingBonuses(cfgV, b)) {
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

  for (const v of vouchers) {
    await sb(`uea_loyalty_vouchers?id=eq.${v.id}&status=in.(active,applied)`, {
      method: 'PATCH',
      body: { status: 'used', used_at: new Date().toISOString(), used_order: b.order_name || ref || 'manual job', booking_order: v.booking_order || b.order_name || null }
    });
  }
  await scheduleAfterPaid(Object.assign({}, b, { member_id: (member && member.id) || b.member_id }))
    .catch(e => console.warn('[loyalty] reminder not scheduled:', e.message));
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
// ── Texting (Textbelt) ──────────────────────────────────────────────────────
// TEXTBELT_KEY on Render turns texting on. Replies come back to /loyalty/sms/reply and land in
// the desk's Messages inbox. Textbelt handles STOP/START itself and adds the opt-out line on the
// first text to a new number. Links in texts need Textbelt's URL whitelist (see SETUP).
const SMS_SENDER = process.env.SMS_SENDER_NAME || 'Upper Echelon Automotive';
const smsDigits = p => String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
function smsErrorText(err) {
  const e = String(err || '');
  if (/url|link/i.test(e)) return 'Textbelt blocks links until your key is approved for links. Request it at textbelt.com/whitelist, or remove the link and send again.';
  if (/out of quota|out of credit|no credit/i.test(e)) return 'Your Textbelt key is out of texts. Refill it at textbelt.com.';
  if (/limit|too many|exceed|throttl/i.test(e)) return `Textbelt limit reached: "${e}". Texts already sent went through. Email support@textbelt.com to raise your limit.`;
  if (/opt|stop|unsubscrib/i.test(e)) return 'This customer replied STOP, so texts to them are blocked. They can reply START to opt back in.';
  if (/invalid.*key|key.*invalid/i.test(e)) return 'The TEXTBELT_KEY on Render is not valid. Copy it again from your Textbelt receipt.';
  return `Text not sent: ${e || 'texting service error'}`;
}
async function memberByPhone(phone) {
  const pk = phoneKey(phone); if (!pk) return null;
  return (await sb(`uea_loyalty_members?phone_key=eq.${pk}&select=id,name,phone,sms_opt_out&order=last_activity_at.desc.nullslast&limit=1`).catch(() => []))[0] || null;
}
async function logSms(row) {
  try { await sb('uea_sms_messages', { method: 'POST', body: row }); }
  catch (e) { if (!/does not exist|schema cache/i.test(e.message)) console.warn('[loyalty] sms log failed:', e.message); }
}
async function sendSms(phone, message, ctx) {
  ctx = ctx || {};
  const key = process.env.TEXTBELT_KEY;
  if (!key) throw httpErr(400, 'Texting isn\'t set up yet. Add TEXTBELT_KEY on Render (Settings → Texting shows how).');
  const digits = smsDigits(phone);
  if (digits.length !== 10) throw httpErr(400, 'This customer doesn\'t have a valid 10-digit phone number.');
  message = String(message || '').trim();
  if (message.length < 2) throw httpErr(400, 'The message is empty.');
  const member = ctx.internal ? null : (ctx.member || await memberByPhone(digits));
  if (member && member.sms_opt_out && !ctx.force) throw httpErr(400, 'This customer is marked “do not text”. To allow texts again: Customers → tick them → More… → Allow texts again.');
  const body = { phone: digits, message: message.slice(0, 640), key, sender: SMS_SENDER };
  if (!ctx.internal && !/^textbelt(_test)?$/.test(key)) {
    body.replyWebhookUrl = `${PUBLIC_BASE}/loyalty/sms/reply`;
    body.webhookData = String((member && member.id) || '').slice(0, 100);
  }
  const r = await fetch('https://textbelt.com/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!d.success) throw httpErr(400, smsErrorText(d.error));
  if (!ctx.internal) {
    await logSms({ direction: 'out', phone_key: digits, member_id: (member && member.id) || null, job_id: (ctx.job && ctx.job.id) || ctx.job_id || null,
      body: message.slice(0, 640), sent_by: ctx.by || null, kind: ctx.kind || null, text_id: d.textId ? String(d.textId) : null, read_at: new Date().toISOString() });
  }
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

// ── Textbelt replies → Messages inbox ──────────────────────────────────────
// Textbelt signs each reply: HMAC-SHA256(key, timestamp + rawBody) in X-textbelt-signature.
const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|opt out)\s*[.!]?\s*$/i;
const START_WORDS = /^\s*(start|unstop|yes|subscribe)\s*[.!]?\s*$/i;
router.post('/sms/reply', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  try {
    const key = process.env.TEXTBELT_KEY || '';
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const ts = String(req.get('X-textbelt-timestamp') || '');
    const sig = String(req.get('X-textbelt-signature') || '');
    const mac = key ? crypto.createHmac('sha256', key).update(ts + raw) : null;
    const hex = mac ? mac.digest('hex') : '';
    const b64 = hex ? Buffer.from(hex, 'hex').toString('base64') : '';
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 15 * 60;
    if (!key || !fresh || !(safeEq(hex, sig.toLowerCase()) || safeEq(b64, sig))) return res.sendStatus(401);
    let d; try { d = JSON.parse(raw); } catch { return res.sendStatus(200); }
    const digits = smsDigits(d.fromNumber);
    const text = String(d.text || '').slice(0, 1600);
    if (digits.length !== 10 || !text) return res.sendStatus(200);
    let member = null;
    if (d.data && /^[0-9a-zA-Z-]{1,64}$/.test(String(d.data))) member = (await sb(`uea_loyalty_members?id=eq.${enc(d.data)}&select=id,name,phone,phone_key`))[0] || null;
    if (!member || (member.phone_key && member.phone_key !== digits)) member = await memberByPhone(digits);
    await logSms({ direction: 'in', phone_key: digits, member_id: member ? member.id : null, body: text, text_id: d.textId ? String(d.textId) : null });
    if (member && STOP_WORDS.test(text)) await sb(`uea_loyalty_members?id=eq.${member.id}`, { method: 'PATCH', body: { sms_opt_out: true } }).catch(() => {});
    if (member && START_WORDS.test(text)) await sb(`uea_loyalty_members?id=eq.${member.id}&sms_opt_out=is.true`, { method: 'PATCH', body: { sms_opt_out: false } }).catch(() => {});
    const cfg = await getConfig();
    if (cfg.reply_alerts !== false && cfg.notify_phone && smsDigits(cfg.notify_phone) !== digits) {
      const who = (member && member.name) || `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      sendSms(cfg.notify_phone, `UEA reply from ${who}: ${text.slice(0, 120)}${text.length > 120 ? '…' : ''} — open Messages in the desk to answer.`, { internal: true })
        .catch(e => console.warn('[loyalty] reply alert not sent:', e.message));
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('[loyalty] sms reply:', e.message);
    res.sendStatus(500);
  }
});

router.use(express.json({ limit: '3mb' }));   // room for inspection photos

// ── Website bookings → service desk ─────────────────────────────────────────
// The booking form posts here when the customer confirms, so the job shows up on the desk
// right away, whether or not Shopify's order webhook is working. Safe to call twice.
const bookHits = new Map();
router.post('/book', h(async (req, res) => {
  const ip = String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
  const now = Date.now(), recent = (bookHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  recent.push(now); bookHits.set(ip, recent); if (bookHits.size > 5000) bookHits.clear();
  if (recent.length > 10) throw httpErr(429, 'Too many bookings from this device. Please call (251) 289-0740.');

  const b = req.body || {};
  if (b.website) throw httpErr(400, 'Request blocked.');   // spam trap
  const t = (v, n = 300) => (v == null ? null : String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) || null);
  const ref = t(b.ref, 64);
  if (!ref || !/^[a-zA-Z0-9-]{8,64}$/.test(ref)) throw httpErr(400, 'Missing booking reference.');
  const name = t(b.name, 120), phone = t(b.phone, 40), address = t(b.location, 300);
  if (!name || !phone || !address) throw httpErr(400, 'Name, phone and service address are required.');
  const date = isoDate(b.date), time = t(b.time, 20);
  // Who supplies the parts: the shop, the customer, or "not sure" (the writer advises).
  const PARTS_CHOICES = { shop: 'Shop supplies parts', customer: 'Customer supplies own parts', unsure: 'Not sure, wants advice' };
  const partsKey = PARTS_CHOICES[b.parts] ? b.parts : null;
  const partsLabel = partsKey ? PARTS_CHOICES[partsKey] : t(b.parts, 80);
  const partsNote = t(b.parts_note, 300);
  const hasQuote = !!b.has_quote, quoteRef = t(b.quote_ref, 120);

  const dupe = (await sb(`uea_loyalty_bookings?web_ref=eq.${enc(ref)}&select=id`))[0];
  if (dupe) return res.json({ ok: true, booking_id: dupe.id, duplicate: true });

  const email = cleanEmail(t(b.email, 160));
  // Signed-in Rewards members: link the booking to their account and attach a reward they picked.
  let signed = null, preMember = null, voucher = null;
  if (b.auth && b.auth.token) {
    try { preMember = (await memberFromAuth(b.auth)).member; signed = !!preMember; } catch (e) { signed = null; }
  } else if (b.auth) { try { signed = verifyCustomer(b.auth); } catch (e) { signed = null; } }
  if (signed && !preMember) {
    preMember = await upsertMember({ customerId: signed.customerId, email: signed.email || email, name, phone, address })
      .catch(e => { console.warn('[loyalty] member link failed:', e.message); return null; });
  }
  const { member, vehicle: veh } = await linkClient({ member_id: preMember ? preMember.id : null, email, name, phone, address, vehicle: t(b.vehicle, 120) });
  const vcode = String(b.voucher_code || '').trim().toUpperCase();
  if (signed && member && /^UER-[A-Z0-9]{6}$/.test(vcode)) {
    voucher = (await sb(`uea_loyalty_vouchers?code=eq.${enc(vcode)}&member_id=eq.${member.id}&status=eq.active&select=id,code,reward_name`))[0] || null;
  }
  // Came from a friend's link (?ref=UEA-XXXXX): attach the referral and their $25 welcome credit to this booking.
  let referralNote = null;
  const refCode = String(b.ref_code || '').trim().toUpperCase();
  if (member && /^UEA-[A-Z0-9]{5}$/.test(refCode) && !member.referred_by && !member.first_paid_at) {
    try {
      const r = await applyReferral(member, refCode);
      referralNote = `Referred by ${r.referrer.name || refCode} (${refCode}).`;
      if (r.voucher) {
        referralNote += ` Friend credit ${r.voucher.code}: ${r.voucher.reward_name}, on jobs of ${money((await getConfig()).referral_min_cents)}+ before discounts.`;
        if (!voucher) voucher = { id: r.voucher.id, code: r.voucher.code, reward_name: r.voucher.reward_name };
      }
    } catch (e) { referralNote = `Referral code ${refCode} not applied: ${e.message}`; }
  }
  const details = [
    ['Vehicle', b.vehicle], ['Service', b.service], ['Preferred Date', b.date_label || date], ['Preferred Time', time],
    ['Rush Service', b.rush ? 'YES (+$100 fee)' : 'No'], ['Contact Name', name], ['Phone', phone], ['Email', email],
    ['Service Location', address], ['Problem Description', b.concern], ['Additional Notes', b.notes],
    ['Parts', partsLabel], ['Customer Parts Details', partsNote],
    ['Already has our quote', hasQuote ? (quoteRef || 'Yes') : null], ['Photos from customer', b.photo_count ? String(Math.min(4, Number(b.photo_count) || 0)) : null],
    ['Time Reserved', b.slot_reserved ? 'Yes' : 'No'], ['Service Agreement', b.agreement],
    ['Reward Voucher', voucher ? `${voucher.code} (${voucher.reward_name})` : null], ['Booking Ref', ref]
  ].filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => ({ name: k, value: String(v).slice(0, 2000) }));

  const created = await sb('uea_loyalty_bookings', {
    method: 'POST', prefer: 'return=representation',
    body: {
      source: 'website', web_ref: ref, member_id: member ? member.id : null, vehicle_id: veh ? veh.id : null,
      customer_name: name, phone, email, address, service: t(b.service, 200), vehicle: t(b.vehicle, 120),
      concern: t([b.concern, b.notes].filter(Boolean).join('\n\n'), 2000),
      appt_date: date, appt_time: time, sched_date: date, sched_window: time,
      rush: !!b.rush, details, stage: 'new', voucher_code: voucher ? voucher.code : null
    }
  });
  const job = created[0];
  await logEvent(job.id, 'Website', 'status', `Booked online${b.rush ? ' (rush)' : ''}`);
  if (partsLabel) await logEvent(job.id, 'Website', 'note', `Parts: ${partsLabel}${partsNote ? ` (${partsNote})` : ''}`);
  if (referralNote) await logEvent(job.id, 'Rewards', 'note', referralNote);
  if (hasQuote) {
    // Point the desk at the estimate they're talking about, so nobody quotes them twice.
    let match = null;
    try {
      const or = [member ? `member_id.eq.${member.id}` : null, phone ? `phone.eq.${enc(phone)}` : null].filter(Boolean).join(',');
      if (or) match = (await sb(`uea_loyalty_bookings?id=neq.${job.id}&estimate=not.is.null&status=eq.open&select=id,service,vehicle,created_at,order_name&order=created_at.desc&limit=1&or=(${or})`))[0] || null;
    } catch (e) { /* the note below still goes in */ }
    await logEvent(job.id, 'Website', 'note', `Customer says they already have a quote from us${quoteRef ? ` (${quoteRef})` : ''}.` +
      (match ? ` Likely this one: ${match.service || 'job'}${match.vehicle ? ` on the ${match.vehicle}` : ''}, quoted ${fmtDate(String(match.created_at).slice(0, 10)) || ''}${match.order_name ? ` (${match.order_name})` : ''}.` : ' No open estimate found for this customer; check by name.'));
  }
  if (voucher) {
    await sb(`uea_loyalty_vouchers?id=eq.${voucher.id}&status=eq.active`, {
      method: 'PATCH', body: { status: 'applied', booking_order: `Web booking ${fmtDate(date) || ''}`.trim(), applied_at: new Date().toISOString() }
    }).catch(e => console.warn('[loyalty] voucher not applied:', e.message));
    await logEvent(job.id, 'Website', 'note', `Customer applied reward ${voucher.code}: ${voucher.reward_name}`);
  }

  // Text the owner (Settings → Shop → "Your cell") so new bookings never sit unseen.
  const cfg = await getConfig();
  if (cfg.notify_phone) {
    const when = [date ? new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : null, time].filter(Boolean).join(' ');
    sendSms(cfg.notify_phone, `UEA new booking${b.rush ? ' (RUSH)' : ''}: ${name}, ${t(b.service, 60) || 'service'}, ${t(b.vehicle, 40) || ''} — ${when}. ${address}. ${phone}${partsLabel ? `. Parts: ${partsLabel}` : ''}`, { internal: true })
      .catch(e => console.warn('[loyalty] booking text not sent:', e.message));
  }
  // Text the customer right away so they know the request landed (Settings → text templates → Booking received).
  if (cfg.booking_text_on !== false && phone && process.env.TEXTBELT_KEY) {
    try {
      const msg = fillTemplate(cfg.sms_templates.booking_received, await smsVars(job, cfg));
      if (msg) {
        await sendSms(phone, msg, { member, job, kind: 'booking_received', by: 'Website' });
        await logEvent(job.id, 'Website', 'note', 'Booking received text sent to the customer');
      }
    } catch (e) { console.warn('[loyalty] customer booking text not sent:', e.message); }
  }
  res.json({ ok: true, booking_id: job.id, member: !!member, voucher: voucher ? voucher.code : null, photo_key: photoKey(job.id) });
}));

// ── Photos customers add while booking (shown on the job in the desk) ────────
const photoKey = id => crypto.createHmac('sha256', `photo|${LOYALTY_SECRET}`).update(String(id)).digest('hex').slice(0, 40);
router.post('/book/photo', h(async (req, res) => {
  const id = String(req.body.booking_id || ''), key = String(req.body.key || '');
  if (!id || !LOYALTY_SECRET || !safeEq(key, photoKey(id))) throw httpErr(403, 'This upload link has expired. Text the photos to us instead.');
  const job = (await sb(`uea_loyalty_bookings?id=eq.${enc(id)}&select=id,created_at`))[0];
  if (!job || Date.now() - Date.parse(job.created_at) > 3 * 3600 * 1000) throw httpErr(403, 'This upload link has expired. Text the photos to us instead.');
  const data = String(req.body.data || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) throw httpErr(400, 'That file isn\'t a photo.');
  if (data.length > 2_500_000) throw httpErr(400, 'That photo is too large.');
  let n;
  try { n = (await sb(`uea_booking_photos?booking_id=eq.${enc(id)}&select=id`)).length; }
  catch (e) { throw /does not exist|schema cache/i.test(e.message) ? httpErr(503, 'Photo uploads aren\'t set up yet. Run booking_photos.sql in Supabase.') : e; }
  if (n >= 4) throw httpErr(400, 'You can add up to 4 photos.');
  const token = crypto.randomBytes(16).toString('hex');
  await sb('uea_booking_photos', { method: 'POST', body: { booking_id: id, token, data } });
  if (n === 0) await logEvent(id, 'Website', 'note', 'Customer added photos. See them under Concern and findings.');
  res.json({ ok: true });
}));
router.get('/bp/:token', h(async (req, res) => {
  const token = String(req.params.token || '');
  const p = /^[a-f0-9]{32}$/.test(token) ? (await sb(`uea_booking_photos?token=eq.${token}&select=data`))[0] : null;
  const m = p && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(p.data);
  if (!m) return res.sendStatus(404);
  res.set({ 'Content-Type': m[1], 'Cache-Control': 'private, max-age=86400', 'X-Robots-Tag': 'noindex' });
  res.send(Buffer.from(m[2], 'base64'));
}));

// ── Price ranges for the website, built from the quote maker ─────────────────
// Every active labor-guide job, priced with your labor rate and parts markup, widened by the
// vehicle-specific times you've saved and by what you've actually quoted. Nothing to set by hand.
let pricesCache = { at: 0, data: null };
router.get('/prices', h(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  if (pricesCache.data && Date.now() - pricesCache.at < 10 * 60 * 1000) return res.json(pricesCache.data);
  const cfg = await getConfig();
  const [jobs, ovs, hist] = await Promise.all([
    sb('uea_guide_jobs?active=eq.true&select=id,name,category,labor_hours,flat_cents,parts').catch(() => []),
    sb('uea_guide_overrides?select=job_id,labor_hours,parts').catch(() => []),
    recentEstimates().catch(() => [])
  ]);
  const markup = 1 + (Number(cfg.parts_markup_pct) || 0) / 100, tax = 1 + (Number(cfg.parts_tax_rate) || 0) / 100;
  // Labor rate: your setting, or the rate you usually quote.
  const quotedRates = [];
  hist.forEach(r => (r.estimate.lines || []).forEach(l => { if (l.type === 'labor' && l.unit_cents > 0) quotedRates.push(l.unit_cents); }));
  quotedRates.sort((a, b) => a - b);
  const rate = Number(cfg.labor_rate_cents) || (quotedRates.length ? quotedRates[Math.floor(quotedRates.length / 2)] : 0);
  const partsPrice = parts => (Array.isArray(parts) ? parts : []).reduce((a, p) => a + (Number(p.cost_cents) || 0) * (Number(p.qty) || 1), 0) * markup;
  // What each job was actually quoted at (labor and parts lines tied to that guide job).
  const quoted = {};
  hist.forEach(r => {
    const per = {};
    (r.estimate.lines || []).forEach(l => {
      if (!l.guide_id || l.status === 'declined') return;
      const q = per[l.guide_id] || (per[l.guide_id] = { hours: 0, labor: 0, parts: 0 });
      const amt = (Number(l.qty) || 0) * (Number(l.unit_cents) || 0);
      if (l.type === 'labor') { q.hours += Number(l.qty) || 0; q.labor += amt; } else if (l.type === 'part') q.parts += amt;
    });
    Object.keys(per).forEach(k => (quoted[k] = quoted[k] || []).push(per[k]));
  });
  const out = [];
  jobs.forEach(j => {
    const myOvs = ovs.filter(o => o.job_id === j.id), hq = quoted[j.id] || [];
    const flat = j.flat_cents != null && j.flat_cents > 0 ? Number(j.flat_cents) : null;
    const hours = [Number(j.labor_hours) || 0].concat(myOvs.map(o => Number(o.labor_hours)).filter(x => x > 0), hq.map(q => q.hours).filter(x => x > 0)).filter(x => x > 0);
    const parts = [partsPrice(j.parts)].concat(myOvs.filter(o => Array.isArray(o.parts) && o.parts.length).map(o => partsPrice(o.parts))).map(p => p * tax);
    let lows = [], highs = [];
    if (flat) { lows.push(flat + Math.min.apply(null, parts)); highs.push(flat + Math.max.apply(null, parts)); }
    else if (rate && hours.length) { lows.push(Math.min.apply(null, hours) * rate + Math.min.apply(null, parts)); highs.push(Math.max.apply(null, hours) * rate + Math.max.apply(null, parts)); }
    hq.forEach(q => { const tot = q.labor + q.parts * tax; if (tot > 0) { lows.push(tot); highs.push(tot); } });
    if (!lows.length) return;
    let low = Math.min.apply(null, lows), high = Math.max.apply(null, highs);
    if (high - low < low * 0.15) { low *= 0.9; high *= 1.2; }   // one data point: allow for different vehicles
    low = Math.max(0, Math.floor(low / 1000) * 1000); high = Math.ceil(high / 1000) * 1000;
    if (!high) return;
    const hrs = hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : null;
    out.push({ name: j.name, category: j.category, low_cents: low, high_cents: high,
      hours: hrs != null ? Math.round(hrs * 10) / 10 : null, parts_included: parts.some(p => p > 0) });
  });
  pricesCache = { at: Date.now(), data: { rate_set: !!rate, jobs: out, updated_at: new Date().toISOString() } };
  res.json(pricesCache.data);
}));

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

// ── Website Rewards sign-in: text code, then stays signed in for 60 days ─────
// The site keeps a signed member pass on the customer's phone. Every visit pushes
// the 60 days out again, so a regular customer basically never has to sign in twice.
const MEMBER_DAYS = Math.max(1, Number(process.env.MEMBER_SESSION_DAYS) || 60);
const memberKey = () => crypto.createHash('sha256').update(`member-session|${LOYALTY_SECRET}`).digest();
function issueMemberSession(memberId) {
  if (!LOYALTY_SECRET) throw httpErr(500, 'LOYALTY_SECRET is not set on the server.');
  const exp = Date.now() + MEMBER_DAYS * 86400000;
  const p = Buffer.from(JSON.stringify({ mid: memberId, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', memberKey()).update(p).digest('base64url');
  return { token: `${p}.${sig}`, expires_at: new Date(exp).toISOString() };
}
function readMemberSession(tok) {
  const [p, sig] = String(tok || '').split('.');
  if (!p || !sig || !LOYALTY_SECRET) throw httpErr(401, 'Please sign in again.');
  const expected = crypto.createHmac('sha256', memberKey()).update(p).digest('base64url');
  if (!safeEq(expected, sig)) throw httpErr(401, 'Please sign in again.');
  let d;
  try { d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (e) { throw httpErr(401, 'Please sign in again.'); }
  if (!d.mid || !d.exp || d.exp < Date.now()) throw httpErr(401, 'Your sign-in expired. Sign in again with your phone number.');
  return d;
}
// Website requests carry either { token } (phone sign-in) or the older Shopify-account signature.
async function memberFromAuth(a) {
  if (a && a.token) {
    const d = readMemberSession(a.token);
    const m = (await sb(`uea_loyalty_members?id=eq.${enc(d.mid)}&select=*`))[0];
    if (!m) throw httpErr(401, 'Please sign in again.');
    const session = (d.exp - Date.now() < (MEMBER_DAYS - 1) * 86400000) ? issueMemberSession(m.id) : null;
    return { member: m, session };
  }
  return { member: await upsertMember(verifyCustomer(a)), session: null };
}

const loginCodes = new Map();   // phone key -> { hash, exp, tries }
const loginHits = new Map();    // 'ip:…' or 'ph:…' -> request times
function tooMany(key, max, ms) {
  const now = Date.now(), list = (loginHits.get(key) || []).filter(t => now - t < ms);
  list.push(now); loginHits.set(key, list);
  if (loginHits.size > 5000) loginHits.clear();
  return list.length > max;
}
const codeHash = (pk, code) => crypto.createHmac('sha256', memberKey()).update(`${pk}|${code}`).digest('hex');

async function customerProfile(member) {
  const cfg = await getConfig();
  const [spend, ledger, vouchers, claims, jobs] = await Promise.all([
    rpc('uea_loyalty_spend_12mo', { p_member: member.id }),
    sb(`uea_loyalty_ledger?member_id=eq.${member.id}&select=type,points,note,created_at&order=created_at.desc&limit=30`),
    sb(`uea_loyalty_vouchers?member_id=eq.${member.id}&status=in.(active,applied)&select=id,code,reward_key,reward_name,value_cents,status,booking_order,created_at&order=created_at.desc`),
    sb(`uea_loyalty_review_claims?member_id=eq.${member.id}&select=status&order=created_at.desc&limit=1`),
    sb(`uea_loyalty_bookings?member_id=eq.${member.id}&status=neq.cancelled&select=service,vehicle,sched_date,sched_window,stage,status,total_cents,points_awarded,voucher_code,voucher_used,paid_at,created_at&order=created_at.desc&limit=15`)
      .catch(() => [])
  ]);
  const fresh = (await sb(`uea_loyalty_members?id=eq.${member.id}&select=*`))[0] || member;
  const spendCents = Number(spend);
  const { tier, next, status } = tierFor(cfg, spendCents, fresh);
  const referral = await referralSummary(fresh, cfg);
  const months = Number(cfg.expire_months) || 0;
  let expiresAt = null;
  if (months && fresh.last_activity_at && fresh.points_balance > 0) {
    const d = new Date(fresh.last_activity_at); d.setMonth(d.getMonth() + months); expiresAt = d.toISOString();
  }
  return {
    expires_at: expiresAt,
    jobs: (jobs || []).map(j => ({
      service: j.service, vehicle: j.vehicle, date: j.sched_date || (j.paid_at || j.created_at || '').slice(0, 10),
      window: j.status === 'open' ? j.sched_window : null,
      status: j.status === 'paid' ? 'Paid' : (STAGE_LABEL[j.stage] || 'Booked'),
      paid: j.status === 'paid', total_cents: j.status === 'paid' ? j.total_cents : null,
      points: j.points_awarded || null, reward: j.voucher_used || j.voucher_code || null
    })),
    member: {
      name: fresh.name, email: fresh.email, phone: fresh.phone || null, address: fresh.address || null,
      balance: fresh.points_balance,
      is_fleet: !!fresh.is_fleet, last_activity_at: fresh.last_activity_at,
      referral_code: fresh.referral_code, referred: !!fresh.referred_by, first_paid: !!fresh.first_paid_at,
      birth_month: fresh.birth_month || null
    },
    spend_12mo_cents: spendCents,
    tier, next_tier: next, status,
    welcome_pending: !fresh.first_paid_at && !fresh.is_fleet ? Number(cfg.welcome_bonus) || 0 : 0,
    referral,
    history: ledger, vouchers,
    review_status: claims[0] ? claims[0].status : null,
    program: publicProgram(cfg)
  };
}

// Public: program details for signed-out visitors
function publicProgram(cfg) {
  const keys = ['points_per_dollar', 'parts_points_per_dollar', 'welcome_bonus', 'referral_bonus_referrer',
    'referral_bonus_friend', 'referral_min_cents', 'review_bonus', 'google_review_url', 'book_ahead_days',
    'book_ahead_bonus', 'offpeak_days', 'offpeak_bonus', 'expire_months', 'tiers', 'terms_extra',
    'birthday_bonus', 'comeback_bonus', 'comeback_months', 'referral_friend_cents', 'referral_referrer_cents', 'referral_milestones'];
  const out = {};
  keys.forEach(k => { out[k] = cfg[k]; });
  out.rewards = (cfg.rewards || []).filter(r => r.active);
  out.updated_at = cfg._updated_at || null;
  return out;
}

// The website loads this one script for the referral program, birthday and comeback bonuses.
router.get('/rewards-plus.js', (req, res) => {
  res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  res.send(REWARDS_PLUS_JS.replace('__API__', `${PUBLIC_BASE}/loyalty`));
});

router.get('/program', h(async (req, res) => {
  res.json(publicProgram(await getConfig()));
}));

router.post('/me', h(async (req, res) => {
  await maybeExpire();
  maybeBirthdays();
  const { member, session } = await memberFromAuth(req.body.auth);
  res.json(Object.assign(await customerProfile(member), session ? { session } : {}));
}));

// Rewards sign-in, step 1: text a 6-digit code to the customer's phone.
router.post('/login/start', h(async (req, res) => {
  const pk = phoneKey(req.body.phone);
  if (!pk) throw httpErr(400, 'Enter your 10-digit phone number.');
  const ip = String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
  if (tooMany(`ip:${ip}`, 8, 15 * 60 * 1000) || tooMany(`ph:${pk}`, 3, 15 * 60 * 1000)) {
    throw httpErr(429, 'Too many codes requested. Wait 15 minutes, or call (251) 289-0740.');
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  loginCodes.set(pk, { hash: codeHash(pk, code), exp: Date.now() + 10 * 60 * 1000, tries: 0 });
  if (loginCodes.size > 5000) loginCodes.clear();
  try {
    await sendSms(pk, `${code} is your Upper Echelon Rewards code. It expires in 10 minutes.`, { internal: true });
  } catch (e) {
    loginCodes.delete(pk);
    console.warn('[loyalty] sign-in code not sent:', e.message);
    throw httpErr(502, 'We couldn\u2019t text a code right now. Call (251) 289-0740 and we\u2019ll check your points.');
  }
  res.json({ ok: true, last4: pk.slice(-4) });
}));

// Rewards sign-in, step 2: check the code, then hand back a 60-day member pass.
router.post('/login/verify', h(async (req, res) => {
  const pk = phoneKey(req.body.phone);
  const code = String(req.body.code || '').replace(/\D/g, '');
  const rec = pk ? loginCodes.get(pk) : null;
  if (!rec || rec.exp < Date.now()) throw httpErr(400, 'That code expired. Tap \u201cSend a new code\u201d.');
  if (rec.tries >= 5) { loginCodes.delete(pk); throw httpErr(429, 'Too many wrong tries. Send a new code.'); }
  if (code.length !== 6 || !safeEq(rec.hash, codeHash(pk, code))) {
    rec.tries++;
    throw httpErr(400, 'That code isn\u2019t right. Check the text and try again.');
  }
  loginCodes.delete(pk);
  await maybeExpire();
  const member = (await findMember({ phone: pk })) || (await upsertMember({ phone: pk }));
  res.json(Object.assign(await customerProfile(member), { session: issueMemberSession(member.id) }));
}));

router.post('/redeem', h(async (req, res) => {
  const { member } = await memberFromAuth(req.body.auth);
  const cfg = await getConfig(true);
  const reward = (cfg.rewards || []).find(r => r.key === req.body.reward_key && r.active);
  if (!reward) throw httpErr(400, 'That reward is no longer available.');
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
  const { member } = await memberFromAuth(req.body.auth);
  const r = await applyReferral(member, req.body.code);
  res.json(Object.assign(await customerProfile(member), { referral_voucher: r.voucher ? { code: r.voucher.code, reward_name: r.voucher.reward_name } : null }));
}));

// Birthday month (for the yearly birthday bonus). Set once; after that the shop can change it.
router.post('/birthday', h(async (req, res) => {
  const { member } = await memberFromAuth(req.body.auth);
  const month = parseInt(req.body.month, 10);
  if (!(month >= 1 && month <= 12)) throw httpErr(400, 'Pick your birthday month.');
  if (member.birth_month) throw httpErr(400, 'Your birthday month is already saved. Call us to change it.');
  await sb(`uea_loyalty_members?id=eq.${member.id}&birth_month=is.null`, { method: 'PATCH', body: { birth_month: month, birthday_set_at: new Date().toISOString() } });
  res.json(await customerProfile(member));
}));

router.post('/review-claim', h(async (req, res) => {
  const { member } = await memberFromAuth(req.body.auth);
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
    // exp 0 = stays signed in on that device until they sign out, are deactivated, or their password changes.
    sid: staff.sid || staff.id, role: staff.role, ver: staff.token_ver || 0, exp: 0
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
      if (d.exp && d.exp < Date.now()) throw 0;
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
  const sort = req.query.sort === 'points' ? 'points_balance.desc' : req.query.sort === 'name' ? 'name.asc.nullslast' : 'last_activity_at.desc.nullslast';
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 60));
  syncClients().catch(e => console.warn('[loyalty] client import:', e.message));
  let url = `uea_loyalty_members?select=*,vehicles:uea_client_vehicles(id,description,vin,plate,mileage)&order=${sort}&limit=${limit}`;
  const f = String(req.query.filter || '');
  const daysAgo = d => new Date(Date.now() - d * 864e5).toISOString();
  if (f === 'points') url += '&points_balance=gt.0';
  else if (f === 'inactive') url += `&or=(last_activity_at.lt.${daysAgo(180)},last_activity_at.is.null)`;
  else if (f === 'recent') url += `&last_activity_at=gte.${daysAgo(90)}`;
  else if (f === 'noemail') url += '&email=is.null';
  else if (f === 'fleet') url += '&is_fleet=eq.true';
  else if (f === 'textable') url += '&phone_key=not.is.null&sms_opt_out=not.is.true';
  else if (f === 'optout') url += '&sms_opt_out=is.true';
  if (q) {
    const p = `*${q}*`, digits = q.replace(/\D/g, '');
    const ors = ['email', 'name', 'phone', 'referral_code', 'address'].map(f => `${f}.ilike.${enc(p)}`);
    if (digits.length >= 3) ors.push(`phone_key.ilike.${enc(`*${digits}*`)}`);
    url += url.includes('&or=(') ? `&and=(or(${ors.join(',')}))` : `&or=(${ors.join(',')})`;
  }
  res.json({ members: await sb(url), limit });
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
  const { tier, next, status } = tierFor(cfg, Number(spend), m);
  const referral = await referralSummary(m, cfg).catch(() => null);
  const [jobs, vehicles] = await Promise.all([
    sb(`uea_loyalty_bookings?member_id=eq.${m.id}&select=id,order_name,service,vehicle,vehicle_id,vin,mileage,status,stage,total_cents,paid_at,created_at,sched_date,address,estimate&order=created_at.desc&limit=100`),
    sb(`uea_client_vehicles?member_id=eq.${m.id}&select=*&order=last_seen_at.desc`)
  ]);
  // Declined work per vehicle, so the writer can offer it next visit.
  jobs.forEach(j => { j.declined = ((j.estimate && j.estimate.lines) || []).filter(l => l.status === 'declined' && l.type !== 'discount').map(l => l.desc).filter(Boolean); delete j.estimate; });
  res.json({ member: m, spend_12mo_cents: Number(spend), tier, next_tier: next, status, referral, ledger, vouchers, referrals, referrer: referrer[0] || null, jobs, vehicles });
}));

// ── Client records: edit contact info, notes and vehicles ────────────────────
router.patch('/admin/member/:id', auth(DESK), h(async (req, res) => {
  const m = (await sb(`uea_loyalty_members?id=eq.${enc(req.params.id)}&select=*`))[0];
  if (!m) throw httpErr(404, 'Customer not found.');
  const b = req.body || {}, patch = {};
  const t = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
  if ('name' in b) patch.name = t(b.name, 120);
  if ('phone' in b) { patch.phone = t(b.phone, 40); patch.phone_key = phoneKey(b.phone); }
  if ('address' in b) patch.address = t(b.address, 300);
  if ('notes' in b) patch.notes = t(b.notes, 2000);
  if ('birth_month' in b) {
    const bm = b.birth_month === '' || b.birth_month == null ? null : parseInt(b.birth_month, 10);
    if (bm != null && !(bm >= 1 && bm <= 12)) throw httpErr(400, 'Birthday month must be 1–12.');
    if (bm !== (m.birth_month || null)) { patch.birth_month = bm; patch.birthday_set_at = bm ? new Date().toISOString() : null; }
  }
  if ('email' in b) {
    const e = cleanEmail(t(b.email, 160));
    if (e && !/.+@.+\..+/.test(e)) throw httpErr(400, 'That email doesn\'t look right.');
    if (e && e !== m.email) { const other = await findMember({ email: e }); if (other && other.id !== m.id) throw httpErr(400, `${e} already belongs to ${other.name || 'another customer'}.`); }
    patch.email = e;
  }
  const r = await sb(`uea_loyalty_members?id=eq.${m.id}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
  res.json({ member: r[0] });
}));

router.post('/admin/member/:id/vehicles', auth(DESK), h(async (req, res) => {
  const m = (await sb(`uea_loyalty_members?id=eq.${enc(req.params.id)}&select=id`))[0];
  if (!m) throw httpErr(404, 'Customer not found.');
  const b = req.body || {};
  if (b.vin && !cleanVin(b.vin)) throw httpErr(400, 'A VIN is 17 characters (no I, O, or Q).');
  const v = await upsertVehicle(m.id, { vehicle: b.description, vin: b.vin, plate: b.plate, mileage: b.mileage });
  if (!v) throw httpErr(400, 'Enter the year, make and model, or the VIN.');
  if (b.notes != null) await sb(`uea_client_vehicles?id=eq.${v.id}`, { method: 'PATCH', body: { notes: String(b.notes).trim().slice(0, 1000) || null } });
  res.json({ vehicle: v });
}));

router.patch('/admin/vehicle/:id', auth(DESK), h(async (req, res) => {
  const b = req.body || {}, patch = {};
  if ('description' in b) { const d = String(b.description || '').trim().slice(0, 120); if (!d) throw httpErr(400, 'Enter the year, make and model.'); patch.description = d; }
  if ('vin' in b) { if (b.vin && !cleanVin(b.vin)) throw httpErr(400, 'A VIN is 17 characters (no I, O, or Q).'); patch.vin = cleanVin(b.vin); }
  if ('plate' in b) patch.plate = b.plate ? String(b.plate).trim().toUpperCase().slice(0, 12) : null;
  if ('mileage' in b) patch.mileage = b.mileage ? parseInt(String(b.mileage).replace(/\D/g, ''), 10) || null : null;
  if ('notes' in b) patch.notes = b.notes ? String(b.notes).trim().slice(0, 1000) : null;
  const r = await sb(`uea_client_vehicles?id=eq.${enc(req.params.id)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
  if (!r[0]) throw httpErr(404, 'Vehicle not found.');
  res.json({ vehicle: r[0] });
}));

// Saves clients and vehicles from past jobs that aren't linked yet. Runs in the background
// when someone opens Customers, a batch at a time, until everything is linked.
let syncing = false, syncedAll = false;
async function syncClients() {
  if (syncing || syncedAll) return;
  syncing = true;
  try {
    const rows = await sb('uea_loyalty_bookings?or=(member_id.is.null,and(vehicle_id.is.null,vehicle.not.is.null))&select=id,member_id,vehicle_id,customer_name,phone,email,address,vehicle,vin,plate,mileage&order=created_at.asc&limit=200');
    for (const j of rows) {
      if (!j.member_id && !j.email && !phoneKey(j.phone)) continue;
      const { member, vehicle: veh } = await linkClient({ member_id: j.member_id, email: j.email, name: j.customer_name, phone: j.phone,
        address: j.address, vehicle: j.vehicle, vin: j.vin, plate: j.plate, mileage: j.mileage });
      const link = {};
      if (member && !j.member_id) link.member_id = member.id;
      if (veh && !j.vehicle_id) link.vehicle_id = veh.id;
      if (Object.keys(link).length) await sb(`uea_loyalty_bookings?id=eq.${j.id}`, { method: 'PATCH', body: link });
    }
    if (rows.length < 200) syncedAll = true;
  } finally { syncing = false; }
}

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
    member = (await sb(`uea_loyalty_members?id=eq.${b.member_id}&select=*`))[0] || null;
    if (member) tier = tierFor(cfg, Number(await rpc('uea_loyalty_spend_12mo', { p_member: member.id })), member).tier;
  }
  const code = String(b.voucher_used || b.voucher_code || '').split(',')[0].trim();
  if (code) voucher = (await sb(`uea_loyalty_vouchers?code=eq.${enc(code)}&select=*`))[0] || null;
  // Everything the customer can use on this job: the reward they picked plus any referral credits.
  const memberVouchers = member && b.status === 'open'
    ? await sb(`uea_loyalty_vouchers?member_id=eq.${member.id}&status=in.(active,applied)&select=code,reward_key,reward_name,value_cents,status,booking_order&order=created_at.asc`).catch(() => [])
    : [];
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
  const [insp, time, vehicles, custPhotos] = await Promise.all([
    getInspection(b.id, false).catch(() => null),
    jobTime(b, req.staff.id || 'owner').catch(() => null),
    b.member_id ? sb(`uea_client_vehicles?member_id=eq.${b.member_id}&select=*&order=last_seen_at.desc`).catch(() => []) : Promise.resolve([]),
    sb(`uea_booking_photos?booking_id=eq.${enc(b.id)}&select=token&order=created_at.asc`).catch(() => [])
  ]);
  let costs;
  if (req.staff.role === 'owner') {
    costs = await jobCosts(b, cfg).catch(e => {
      if (bookMissing(e)) return { setup_needed: true };
      console.warn('[loyalty] job costs:', e.message); return null;
    });
  }
  res.json({
    booking: b, member, tier, voucher, member_vouchers: memberVouchers.map(v => Object.assign(v, { credit: isCredit(v), min_cents: voucherMin(cfg, v) })), events, techs, history, vehicles, time, costs,
    photos: (custPhotos || []).map(p => `${PUBLIC_BASE}/loyalty/bp/${p.token}`),
    inspection: insp ? Object.assign(inspectionCounts(insp), { sent_at: insp.sent_at, link: `${PUBLIC_BASE}/loyalty/i/${insp.token}` }) : null,
    totals: estTotals(b.estimate, cfg.parts_tax_rate),
    estimate_link: b.estimate_token ? `${PUBLIC_BASE}/loyalty/e/${b.estimate_token}` : null,
    invoice_link: b.estimate_token ? `${PUBLIC_BASE}/loyalty/v/${b.estimate_token}` : null,
    quote_link: b.estimate_token ? `${PUBLIC_BASE}/loyalty/q/${b.estimate_token}` : null,
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
  for (const code of String(b.voucher_used || '').split(',').map(x => x.trim()).filter(Boolean)) {
    await sb(`uea_loyalty_vouchers?code=eq.${enc(code)}&status=eq.used`, {
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

// Close or cancel several jobs at once (e.g. old Shopify bookings already done and paid there).
// "Finish" marks the job done without recording a charge or adding points; reopen it from the job to change that.
router.post('/admin/jobs/bulk', auth(DESK), h(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String).filter(x => /^[0-9a-f-]{8,40}$/i.test(x)))].slice(0, 200);
  const action = req.body.action;
  if (!ids.length) throw httpErr(400, 'Select at least one job.');
  if (!['finish', 'cancel'].includes(action)) throw httpErr(400, 'Unknown action.');
  const jobs = await sb(`uea_loyalty_bookings?id=in.(${ids.join(',')})&status=eq.open&select=id,sched_date,voucher_code,order_name`);
  const now = new Date().toISOString(), today = todayCentral();
  let done = 0;
  for (const j of jobs) {
    if (action === 'finish') {
      const when = j.sched_date && j.sched_date < today ? `${j.sched_date}T18:00:00.000Z` : now;
      await patchJob(j.id, { status: 'paid', stage: 'completed', paid_at: when, payment_method: 'Closed (no charge recorded)',
        labor_cents: 0, parts_cents: 0, total_cents: 0, points_awarded: null });
      await logEvent(j.id, req.staff.name, 'status', 'Marked finished (bulk). No charge recorded and no points added.');
    } else {
      await patchJob(j.id, { status: 'cancelled' });
      await logEvent(j.id, req.staff.name, 'status', 'Cancelled (bulk)');
      if (j.voucher_code) await sb(`uea_loyalty_vouchers?code=eq.${enc(j.voucher_code)}&status=eq.applied`, {
        method: 'PATCH', body: { status: 'active', booking_order: null, applied_at: null } });
    }
    done++;
  }
  res.json({ done, skipped: ids.length - done });
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
  const { member, vehicle: veh } = await linkClient({ member_id: b.member_id || null, email, name, phone, address: t(b.address),
    vehicle: t(b.vehicle, 120), vin: b.vin, plate: b.plate, mileage: b.mileage });
  const sched = isoDate(b.sched_date);
  let techId = b.tech_id || null;
  if (techId) { const tt = await getStaff(techId, true); if (!tt || !tt.active) techId = null; }
  const created = await sb('uea_loyalty_bookings', {
    method: 'POST', prefer: 'return=representation',
    body: {
      source: 'manual', member_id: member ? member.id : null, vehicle_id: veh ? veh.id : null,
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
  // Keep the client's record current: link the job if it has no client yet, and update their vehicle.
  const clientKeys = ['customer_name', 'phone', 'email', 'address', 'vehicle', 'vin', 'plate', 'mileage'];
  if (clientKeys.some(k => k in patch)) {
    const { member, vehicle: veh } = await linkClient({ member_id: updated.member_id, email: updated.email, name: updated.customer_name,
      phone: updated.phone, address: 'address' in patch ? updated.address : null, vehicle: updated.vehicle, vin: updated.vin, plate: updated.plate, mileage: updated.mileage });
    const link = {};
    if (member && member.id !== updated.member_id) link.member_id = member.id;
    if (veh && veh.id !== updated.vehicle_id) link.vehicle_id = veh.id;
    if (Object.keys(link).length) Object.assign(updated, (await patchJob(j.id, link))[0] || link);
  }
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
      supplier: l.supplier ? String(l.supplier).replace(/[^a-z0-9-]/gi, '').slice(0, 20) || null : null,
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
    await sendSms(j.phone, text, { job: j, by: req.staff.name, kind: req.body.kind || null });
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
  await sendSms(j.phone, text, { job: j, by: req.staff.name, kind: req.body.kind || null });
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

// ── Book times from Open Labor Project ──────────────────────────────────────
// Needs OLP_API_KEY on Render. Each vehicle is looked up once and saved for 90 days, so the
// daily lookup limit goes a long way. Times the writer saves for a vehicle still win.
const OLP_KEY = process.env.OLP_API_KEY || '';
const OLP_BASE = 'https://openlaborproject.com/api/v1';
const OLP_DAYS = 90;
const olpSlug = v => String(v || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const JOB_NOISE = new Set(['replacement', 'replace', 'r', 'and', 'or', 'the', 'labor', 'general', 'repair', 'service', 'remove', 'install', 'rr', 'a', 'of', 'on', 'with']);
const jobWords = v => String(v || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ')
  .filter(w => w && !JOB_NOISE.has(w)).map(w => w.replace(/s$/, ''));

function olpError(status, d) {
  const code = d && d.error && d.error.code;
  if (status === 401) return httpErr(400, 'The Open Labor Project key on Render is missing or wrong (OLP_API_KEY).');
  if (status === 429 || code === 'RATE_LIMIT_EXCEEDED') return httpErr(429, 'Today\'s book-time lookups are used up. They reset at 7 PM Central. Saved vehicles still work.');
  if (status === 404 || code === 'NOT_FOUND') return httpErr(404, 'Open Labor Project has no times for this vehicle. Check the year, make and model.');
  return httpErr(502, `Open Labor Project didn't answer (${(d && d.error && d.error.message) || status}). Try again in a minute.`);
}
async function olpGet(params) {
  const r = await fetch(`${OLP_BASE}/labor-times?${new URLSearchParams(params)}`, { headers: { 'x-api-key': OLP_KEY, accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && d && d.data, status: r.status, d, remaining: r.headers.get('x-ratelimit-remaining-daily') };
}
async function olpCached(key, params) {
  const hit = (await sb(`uea_olp_cache?key=eq.${enc(key)}&select=data,fetched_at`).catch(() => []))[0];
  if (hit && Date.now() - Date.parse(hit.fetched_at) < OLP_DAYS * 86400000) return { data: hit.data, cached: true, remaining: null };
  const r = await olpGet(params);
  if (!r.ok) return { error: olpError(r.status, r.d), code: r.d && r.d.error && r.d.error.code };
  const data = { data: r.d.data, meta: r.d.meta || {} };
  await sb('uea_olp_cache?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates',
    body: { key, data, fetched_at: new Date().toISOString() } }).catch(() => {});
  return { data, cached: false, remaining: r.remaining };
}

router.get('/admin/guide/booktime', auth(ALL), h(async (req, res) => {
  await guideGuard(req);
  if (!OLP_KEY) throw httpErr(400, 'Book times are off. Add OLP_API_KEY on Render to turn them on.');
  const v = parseVehicle(req.query.vehicle);
  if (!v.year || !v.make || !v.model) throw httpErr(400, 'Add the year, make and model to the job first (for example, 2018 Toyota Camry).');
  let jobName = String(req.query.q || '').trim().slice(0, 120);
  if (req.query.job) {
    const g = (await sb(`uea_guide_jobs?id=eq.${enc(req.query.job)}&select=name`))[0];
    if (g) jobName = g.name;
  }
  if (!jobName) throw httpErr(400, 'Pick a job to look up.');

  const base = { make: olpSlug(v.make), model: olpSlug(v.model), year: String(v.year) };
  const vKey = `${base.year}|${base.make}|${base.model}`;
  // One call per vehicle covers every job. If the API insists on a job, fall back to one call per job.
  let got = await olpCached(vKey, base);
  if (got.error && got.code === 'MISSING_PARAMS') {
    const job = olpSlug(jobName.replace(/\(.*?\)/g, ''));
    got = await olpCached(`${vKey}|${job}`, Object.assign({ job }, base));
  }
  if (got.error) throw got.error;

  const payload = got.data.data || {}, meta = got.data.meta || {};
  const engines = Array.isArray(payload.engines) ? payload.engines : [];
  const want = jobWords(jobName);
  const engineHint = (v.text.match(/\b(\d\.\d)\s*l?\b/i) || [])[1] || (v.text.match(/\bv(6|8|10|12)\b/i) || [])[0] || null;
  const matches = [];
  engines.forEach(e => (e.laborTimes || e.labor_times || []).forEach(l => {
    const name = l.job || l.name || '';
    const have = jobWords(name);
    if (!have.length || !want.length) return;
    const shared = want.filter(w => have.includes(w)).length;
    if (!shared) return;
    const score = shared / new Set(want.concat(have)).size + (olpSlug(name) === olpSlug(jobName) ? 1 : 0);
    const hours = Number(l.hours);
    if (!(hours > 0)) return;
    const conf = l.confidence || l.confidenceLevel || (l.verified === true ? 'verified' : null) || null;
    matches.push({
      engine: e.engine || e.name || '', job: name, hours, confidence: conf ? String(conf) : null,
      engine_match: !!(engineHint && String(e.engine || '').toLowerCase().includes(engineHint.toLowerCase())),
      check: hours > 3 || /low|estimat|unverified/i.test(String(conf || '')), score
    });
  }));
  matches.sort((a, b) => (b.engine_match - a.engine_match) || (b.score - a.score) || a.hours - b.hours);
  const served = meta.modelServed || payload.model || null;
  res.json({
    vehicle: [v.year, v.make, v.model].join(' '), job: jobName,
    served_as: served && olpSlug(served) !== base.model ? `${payload.make || v.make} ${payload.model || served}` : null,
    matches: matches.slice(0, 6), engines: engines.map(e => e.engine || e.name).filter(Boolean),
    cached: got.cached, lookups_left: got.remaining != null ? Number(got.remaining) : null
  });
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
    labor_rate_cents: cfg.labor_rate_cents || 0, parts_markup_pct: cfg.parts_markup_pct || 0, parts_tax_rate: cfg.parts_tax_rate || 0,
    book_times: !!OLP_KEY });
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

// The desk adds a friend's referral code for a customer (e.g. they mentioned it on the phone).
router.post('/admin/member/:id/referral', auth(DESK), h(async (req, res) => {
  const m = (await sb(`uea_loyalty_members?id=eq.${enc(req.params.id)}&select=*`))[0];
  if (!m) throw httpErr(404, 'Customer not found.');
  const r = await applyReferral(m, req.body.code);
  res.json({ ok: true, referrer: { id: r.referrer.id, name: r.referrer.name }, voucher: r.voucher ? { code: r.voucher.code, reward_name: r.voucher.reward_name } : null });
}));

router.post('/admin/member/:id/fleet', auth(OWNER), h(async (req, res) => {
  const r = await sb(`uea_loyalty_members?id=eq.${enc(req.params.id)}`, {
    method: 'PATCH', prefer: 'return=representation', body: { is_fleet: !!req.body.is_fleet }
  });
  if (!r[0]) throw httpErr(404, 'Member not found.');
  res.json({ is_fleet: r[0].is_fleet });
}));

// ── Messages (two-way texting) ──────────────────────────────────────────────
const fmtPhone = d => (d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || '');
router.get('/admin/sms/status', auth(DESK), h(async (req, res) => {
  const key = process.env.TEXTBELT_KEY || '';
  const out = { key_set: !!key, free_key: /^textbelt/.test(key), quota: null, inbox_ready: true, replies_url: `${PUBLIC_BASE}/loyalty/sms/reply`, sender: SMS_SENDER };
  if (key) {
    try { const r = await fetch(`https://textbelt.com/quota/${encodeURIComponent(key)}`); const d = await r.json(); out.quota = d.success ? d.quotaRemaining : null; out.key_valid = !!d.success; }
    catch (e) { out.quota = null; }
  }
  try { await sb('uea_sms_messages?select=id&limit=1'); } catch (e) { out.inbox_ready = false; }
  res.json(out);
}));
router.get('/admin/messages', auth(DESK), h(async (req, res) => {
  const rows = await sb('uea_sms_messages?select=id,direction,phone_key,member_id,body,created_at,read_at&order=created_at.desc&limit=1000');
  const convos = new Map();
  for (const m of rows) {
    let c = convos.get(m.phone_key);
    if (!c) { c = { phone_key: m.phone_key, phone: fmtPhone(m.phone_key), member_id: m.member_id, last: m, unread: 0 }; convos.set(m.phone_key, c); }
    if (!c.member_id && m.member_id) c.member_id = m.member_id;
    if (m.direction === 'in' && !m.read_at) c.unread++;
  }
  const list = [...convos.values()].slice(0, 150);
  const ids = [...new Set(list.map(c => c.member_id).filter(Boolean))];
  const mem = ids.length ? await sb(`uea_loyalty_members?id=in.(${ids.join(',')})&select=id,name,points_balance,sms_opt_out,is_fleet`) : [];
  list.forEach(c => { c.member = mem.find(x => x.id === c.member_id) || null; });
  res.json({ conversations: list, unread: list.reduce((a, c) => a + c.unread, 0) });
}));
router.get('/admin/messages/:pk', auth(DESK), h(async (req, res) => {
  const pk = smsDigits(req.params.pk); if (pk.length !== 10) throw httpErr(400, 'Invalid phone number.');
  const [msgs, member] = await Promise.all([
    sb(`uea_sms_messages?phone_key=eq.${pk}&select=id,direction,body,sent_by,kind,job_id,created_at,read_at&order=created_at.desc&limit=200`),
    memberByPhone(pk)
  ]);
  if (msgs.some(m => m.direction === 'in' && !m.read_at)) {
    await sb(`uea_sms_messages?phone_key=eq.${pk}&direction=eq.in&read_at=is.null`, { method: 'PATCH', body: { read_at: new Date().toISOString() } });
  }
  res.json({ phone_key: pk, phone: fmtPhone(pk), member, messages: msgs.reverse() });
}));
router.post('/admin/messages/:pk', auth(DESK), h(async (req, res) => {
  const pk = smsDigits(req.params.pk); if (pk.length !== 10) throw httpErr(400, 'Invalid phone number.');
  const text = String((req.body || {}).text || '').trim();
  if (text.length > 600) throw httpErr(400, 'Keep the text under 600 characters.');
  const member = await memberByPhone(pk);
  const cfg = await getConfig();
  const msg = member ? fillTemplate(text, { first: firstName(member.name), name: member.name || '', shop_phone: cfg.shop_phone || '' }) : text;
  await sendSms(pk, msg, { member, by: req.staff.name, kind: 'message' });
  res.json({ ok: true });
}));

// ── Promotions (mass texts for deals and discounts) ────────────────────────
// Texas limits sales calls/texts to 9 AM–9 PM Mon–Sat and noon–9 PM Sunday (Bus. & Com. Code §301.051),
// so promo sends are held to those hours, Central time.
function promoWindow(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(at || new Date()).map(x => [x.type, x.value]));
  const hr = Number(p.hour) % 24, sun = p.weekday === 'Sun', start = sun ? 12 : 9;
  const ok = hr >= start && hr < 21;
  return { ok, msg: ok ? null : `Promotions can only go out ${sun ? 'noon' : '9 AM'}–9 PM ${sun ? 'on Sundays' : 'Monday–Saturday'} (Central). Try again then, or send yourself a test now.` };
}
const PROMO_SEGMENTS = {
  all: 'Everyone who can be texted', recent: 'Active in the last 90 days', inactive: 'No visit in 6+ months',
  points: 'Rewards members with points', fleet: 'Fleet accounts', nonfleet: 'Everyone except fleet accounts'
};
async function promoAudience(seg, vehicleKw, serviceKw) {
  const daysAgo = d => new Date(Date.now() - d * 864e5).toISOString();
  let url = 'uea_loyalty_members?phone_key=not.is.null&sms_opt_out=not.is.true&select=id,name,phone,points_balance,is_fleet,referral_code&order=last_activity_at.desc.nullslast&limit=5000';
  if (seg === 'recent') url += `&last_activity_at=gte.${daysAgo(90)}`;
  else if (seg === 'inactive') url += `&or=(last_activity_at.lt.${daysAgo(180)},last_activity_at.is.null)`;
  else if (seg === 'points') url += '&points_balance=gt.0';
  else if (seg === 'fleet') url += '&is_fleet=eq.true';
  else if (seg === 'nonfleet') url += '&is_fleet=not.is.true';
  const clean = v => String(v || '').replace(/[^a-zA-Z0-9 .\-]/g, '').trim().slice(0, 40);
  const vk = clean(vehicleKw), sk = clean(serviceKw);
  const [members, vRows, sRows] = await Promise.all([
    sb(url),
    vk ? sb(`uea_client_vehicles?description=ilike.${enc(`*${vk}*`)}&select=member_id&limit=5000`) : null,
    sk ? sb(`uea_loyalty_bookings?service=ilike.${enc(`*${sk}*`)}&member_id=not.is.null&status=neq.cancelled&select=member_id&limit=5000`) : null
  ]);
  const vSet = vRows && new Set(vRows.map(r => r.member_id)), sSet = sRows && new Set(sRows.map(r => r.member_id));
  return members.filter(m => (!vSet || vSet.has(m.id)) && (!sSet || sSet.has(m.id)));
}
router.get('/admin/promo/audience', auth(DESK), h(async (req, res) => {
  const seg = PROMO_SEGMENTS[req.query.seg] ? req.query.seg : 'all';
  const list = await promoAudience(seg, req.query.vehicle, req.query.service);
  const [optedOut] = await Promise.all([sb('uea_loyalty_members?sms_opt_out=is.true&select=id&limit=5000').catch(() => [])]);
  res.json({ segment: seg, label: PROMO_SEGMENTS[seg], segments: PROMO_SEGMENTS, count: list.length, opted_out: optedOut.length,
    members: list.map(m => ({ id: m.id, name: m.name, phone: m.phone, points_balance: m.points_balance, referral_code: m.referral_code })),
    window: promoWindow(), sms_ready: !!process.env.TEXTBELT_KEY });
}));
// Sends the promo to "Your cell for alerts" so you see exactly what customers get.
router.post('/admin/promo/test', auth(DESK), h(async (req, res) => {
  const cfg = await getConfig();
  if (!cfg.notify_phone) throw httpErr(400, 'Add "Your cell for alerts" in Settings → Shop to send yourself a test.');
  const tpl = String((req.body || {}).message || '').trim();
  if (tpl.length < 2) throw httpErr(400, 'Write a message.');
  if (tpl.length > 600) throw httpErr(400, 'Keep the message under 600 characters.');
  const msg = '[TEST] ' + fillTemplate(tpl, { first: firstName(req.staff.name === 'Owner' ? 'Robert' : req.staff.name), name: req.staff.name || '', points: '250',
    shop_phone: cfg.shop_phone || '', rewards_link: String(cfg.rewards_url || 'https://ueauto.store/pages/rewards'), referral_code: 'UEA123' }) + ' Reply STOP to opt out.';
  await sendSms(cfg.notify_phone, msg, { internal: true });
  res.json({ ok: true, to: cfg.notify_phone });
}));
// Past campaigns, rebuilt from the text log (each promo send is tagged promo:<campaign>).
router.get('/admin/promo/history', auth(DESK), h(async (req, res) => {
  const rows = await sb('uea_sms_messages?kind=like.promo:*&direction=eq.out&select=kind,body,sent_by,created_at&order=created_at.desc&limit=5000').catch(() => []);
  const by = new Map();
  rows.forEach(r => {
    let c = by.get(r.kind);
    if (!c) { c = { id: r.kind.slice(6), sample: r.body, sent_by: r.sent_by, first_at: r.created_at, last_at: r.created_at, sent: 0 }; by.set(r.kind, c); }
    c.sent++; if (r.created_at < c.first_at) { c.first_at = r.created_at; c.sample = r.body; }
  });
  res.json({ campaigns: [...by.values()].sort((a, b) => (a.first_at < b.first_at ? 1 : -1)).slice(0, 50) });
}));

// ── Bulk customer actions (Customers → Select) ──────────────────────────────
// The desk sends ids in batches of up to 50 and shows progress; each customer gets its own result.
const BULK_OWNER_ONLY = ['points', 'fleet_on', 'fleet_off'];
router.post('/admin/members/bulk', auth(DESK), h(async (req, res) => {
  const b = req.body || {};
  const action = String(b.action || '');
  if (!['text', 'points', 'reminder', 'fleet_on', 'fleet_off', 'optout_on', 'optout_off'].includes(action)) throw httpErr(400, 'Unknown action.');
  if (BULK_OWNER_ONLY.includes(action) && req.staff.role !== 'owner') throw httpErr(403, 'Only the owner can do that.');
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(x => /^[0-9a-zA-Z-]{1,64}$/.test(x)))];
  if (!ids.length) throw httpErr(400, 'Select at least one customer.');
  if (ids.length > 50) throw httpErr(400, 'Send at most 50 customers per request.');
  const members = await sb(`uea_loyalty_members?id=in.(${ids.map(enc).join(',')})&select=*`);
  const cfg = await getConfig();
  const results = [];
  let stopped = null;
  const done = (m, ok, msg) => results.push({ id: m.id, name: m.name || m.email || m.phone || 'Customer', ok, msg: msg || null });

  if (action === 'text') {
    const tpl = String(b.message || '').trim();
    if (tpl.length < 2) throw httpErr(400, 'Write a message.');
    // Promotions: always carry the opt-out line, only go out during allowed hours, grouped by campaign.
    const promo = b.promo ? String(b.campaign || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'x' : null;
    if (promo) { const w = promoWindow(); if (!w.ok) throw httpErr(400, w.msg); b.stop_line = true; }
    if (tpl.length > 600) throw httpErr(400, 'Keep the message under 600 characters.');
    const rewardsUrl = String(cfg.rewards_url || 'https://ueauto.store/pages/rewards');
    // Resending the same promo only reaches people who didn't get it yet.
    const already = promo ? new Set((await sb(`uea_sms_messages?kind=eq.${enc(`promo:${promo}`)}&select=member_id&limit=5000`).catch(() => [])).map(r => r.member_id)) : new Set();
    for (const m of members) {
      if (stopped) { done(m, false, 'Not sent: Textbelt limit reached'); continue; }
      if (already.has(m.id)) { results.push({ id: m.id, name: m.name || 'Customer', ok: true, msg: 'Already got this promo', already: true }); continue; }
      if (m.sms_opt_out) { done(m, false, 'Opted out of texts'); continue; }
      if (!phoneKey(m.phone)) { done(m, false, 'No phone number'); continue; }
      let msg = fillTemplate(tpl, {
        first: firstName(m.name), name: m.name || '', points: n0(m.points_balance), shop_phone: cfg.shop_phone || '',
        rewards_link: rewardsUrl, referral_code: m.referral_code || ''
      });
      if (b.stop_line) msg += ' Reply STOP to opt out.';
      try { await sendSms(m.phone, msg, { member: m, by: req.staff.name, kind: promo ? `promo:${promo}` : 'bulk' }); done(m, true); }
      catch (e) {
        if (/opt|stop|unsubscrib/i.test(e.message)) {
          await sb(`uea_loyalty_members?id=eq.${m.id}`, { method: 'PATCH', body: { sms_opt_out: true } }).catch(() => {});
        }
        if (/^Textbelt limit reached|out of texts/.test(e.message)) stopped = e.message;
        done(m, false, e.message.replace(/^Text not sent: /, ''));
      }
      await new Promise(r => setTimeout(r, 700));   // Textbelt asks for no more than 1–2 texts per second
    }
  } else if (action === 'points') {
    const pts = parseInt(b.points, 10);
    const note = String(b.note || '').trim().slice(0, 200);
    if (!pts) throw httpErr(400, 'Enter a point amount, like 100 to add or -100 to remove.');
    if (Math.abs(pts) > 100000) throw httpErr(400, 'That amount looks too large. Check the number.');
    if (!note) throw httpErr(400, 'Add a reason. Customers see it in their points history.');
    for (const m of members) {
      if (pts < 0 && m.points_balance + pts < 0) { done(m, false, `Only has ${m.points_balance} points`); continue; }
      try {
        const r = await rpc('uea_loyalty_post', { p_member: m.id, p_type: 'adjust', p_points: pts, p_note: note, p_by: req.staff.name || 'admin',
          p_ref: b.batch ? `bulk:${String(b.batch).slice(0, 40)}:${m.id}` : null });
        done(m, r && r.inserted === false ? false : true, r && r.inserted === false ? 'Already added in this batch' : null);
      } catch (e) { done(m, false, e.message); }
    }
  } else if (action === 'reminder') {
    const due = isoDate(b.due_date); if (!due) throw httpErr(400, 'Pick a due date.');
    const title = String(b.title || '').trim().slice(0, 80); if (!title) throw httpErr(400, 'Say what the reminder is for, like "Oil change".');
    const rows = members.map(m => ({ member_id: m.id, kind: 'custom', status: 'pending', title, due_date: due,
      note: b.note ? String(b.note).trim().slice(0, 300) : null, created_by: req.staff.name }));
    await sb('uea_reminders', { method: 'POST', body: rows });
    members.forEach(m => done(m, true));
  } else {
    const field = action.startsWith('fleet') ? 'is_fleet' : 'sms_opt_out';
    const on = action.endsWith('_on');
    await sb(`uea_loyalty_members?id=in.(${members.map(m => m.id).join(',')})`, { method: 'PATCH', body: { [field]: on } });
    members.forEach(m => done(m, true));
  }
  ids.filter(id => !members.some(m => String(m.id) === id)).forEach(id => results.push({ id, name: 'Unknown', ok: false, msg: 'Customer not found' }));
  res.json({ action, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results, stopped });
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

// ── Website reviews (customers submit through reviews.js; you decide here) ──
function clearReviewCache() {
  for (const p of ['./reviews', '../reviews']) {
    try { const m = require(p); if (m && m.clearCache) m.clearCache(); return; } catch (e) { /* not installed */ }
  }
}
const siteReviewsErr = e => {
  if (/uea_site_reviews/.test(e.message) && /does not exist|schema cache/i.test(e.message)) {
    return httpErr(400, 'Website reviews aren\u2019t set up yet. Run reviews.sql in Supabase (SQL Editor).');
  }
  return e;
};
router.get('/admin/site-reviews', auth(DESK), h(async (req, res) => {
  const s = ['pending', 'approved', 'hidden'].includes(req.query.status) ? req.query.status : 'pending';
  try {
    const [rows, pend] = await Promise.all([
      sb(`uea_site_reviews?status=eq.${s}&select=id,created_at,name,city,service,body,rating,status,featured,reply,replied_at,decided_at,decided_by&order=created_at.desc&limit=200`),
      sb('uea_site_reviews?status=eq.pending&select=id')
    ]);
    res.json({ reviews: rows, pending: pend.length });
  } catch (e) { throw siteReviewsErr(e); }
}));
router.post('/admin/site-review/:id', auth(DESK), h(async (req, res) => {
  const id = enc(req.params.id), a = req.body.action, now = new Date().toISOString();
  const by = req.staff.name || req.staff.role;
  const replyPatch = () => {
    const t = String(req.body.reply || '').trim().slice(0, 1000);
    return { reply: t || null, replied_at: t ? now : null };
  };
  let patch;
  if (a === 'approve') patch = Object.assign({ status: 'approved', decided_at: now, decided_by: by }, typeof req.body.reply === 'string' ? replyPatch() : {});
  else if (a === 'hide') patch = { status: 'hidden', featured: false, decided_at: now, decided_by: by };
  else if (a === 'feature') patch = { featured: !!req.body.on };
  else if (a === 'reply') patch = replyPatch();
  else if (a === 'delete') {
    if (req.staff.role !== 'owner') throw httpErr(403, 'Only the owner can delete reviews. Hide it instead.');
    try { await sb(`uea_site_reviews?id=eq.${id}`, { method: 'DELETE' }); } catch (e) { throw siteReviewsErr(e); }
    clearReviewCache();
    return res.json({ ok: true });
  } else throw httpErr(400, 'Unknown action.');
  let r;
  try { r = await sb(`uea_site_reviews?id=eq.${id}`, { method: 'PATCH', body: patch, prefer: 'return=representation' }); }
  catch (e) { throw siteReviewsErr(e); }
  if (!r || !r[0]) throw httpErr(404, 'That review wasn\u2019t found.');
  clearReviewCache();
  res.json({ ok: true, review: r[0] });
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
  ['birthday_bonus', 'comeback_bonus', 'comeback_months', 'referral_friend_cents', 'referral_referrer_cents'].forEach(k => {
    if (c[k] == null) c[k] = DEFAULT_CONFIG[k];
    c[k] = Number(c[k]);
    if (!num(c[k])) throw httpErr(400, 'Check the birthday, comeback and referral credit fields; one is negative.');
  });
  c.program_version = DEFAULT_CONFIG.program_version;
  const tierKeys = c.tiers.map(t => t.key);
  c.referral_milestones = (Array.isArray(c.referral_milestones) ? c.referral_milestones : [])
    .map(m => ({
      count: Math.round(Number(m.count) || 0), name: String(m.name || '').trim().slice(0, 120),
      credit_cents: Math.max(0, Math.round(Number(m.credit_cents) || 0)), credit_name: String(m.credit_name || '').trim().slice(0, 120),
      status_tier: tierKeys.includes(m.status_tier) ? m.status_tier : '', status_months: Math.max(0, Math.round(Number(m.status_months) || 0))
    }))
    .filter(m => m.count > 0 && m.name)
    .sort((a, b) => a.count - b.count).slice(0, 10);
  if (new Set(c.referral_milestones.map(m => m.count)).size !== c.referral_milestones.length) throw httpErr(400, 'Two referral milestones use the same number of friends.');
  c.tiers.forEach(t => { if (t.warranty_days != null) t.warranty_days = Math.max(0, Math.round(Number(t.warranty_days) || 0)); });
  ['book_ahead_days', 'book_ahead_bonus', 'offpeak_bonus', 'expire_months'].forEach(k => {
    if (c[k] == null) c[k] = DEFAULT_CONFIG[k];
    if (!num(c[k])) throw httpErr(400, 'Check the bonus and expiration fields; one is negative.');
  });
  c.offpeak_days = (Array.isArray(c.offpeak_days) ? c.offpeak_days : []).map(Number).filter(d => d >= 0 && d <= 6);
  c.terms_extra = (Array.isArray(c.terms_extra) ? c.terms_extra : []).map(t => String(t).trim().slice(0, 400)).filter(Boolean).slice(0, 20);
  delete c._updated_at;
  c.reminders_auto = c.reminders_auto === true;
  c.reply_alerts = c.reply_alerts !== false;
  ['labor_rate_cents', 'parts_markup_pct', 'parts_tax_rate', 'follow_up_days', 'oil_change_months'].forEach(k => {
    if (c[k] == null) c[k] = DEFAULT_CONFIG[k];
    if (!num(c[k])) throw httpErr(400, 'Check the shop number fields; one is missing or negative.');
  });
  c.time_windows = (Array.isArray(c.time_windows) ? c.time_windows : DEFAULT_CONFIG.time_windows).map(x => String(x).trim()).filter(Boolean).slice(0, 12);
  c.sms_templates = Object.assign({}, DEFAULT_CONFIG.sms_templates, c.sms_templates || {});
  Object.keys(c.sms_templates).forEach(k => { c.sms_templates[k] = String(c.sms_templates[k] || '').slice(0, 600); });
  c.tech_can_estimate = c.tech_can_estimate !== false;
  c.booking_text_on = c.booking_text_on !== false;
  c.jobs_per_window = Math.min(10, Math.max(1, Math.round(Number(c.jobs_per_window) || 1)));
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

// ── Customer-facing documents: one template for estimates, invoices and inspection reports ──
// Same look as ueauto.store (purple surfaces, gold accent, Archivo) with the logo on top.
const LOGO_URL = process.env.UEA_LOGO_URL || 'https://ueauto.store/cdn/shop/t/5/assets/uea-logo_1.png';
const AGREEMENT_URL = 'https://ueauto.store/pages/service-agreement';
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const docDate = d => new Date(d || Date.now()).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' });
const docNumber = j => j.order_name || `UEA-${String(j.id || '').replace(/-/g, '').slice(0, 6).toUpperCase()}`;

function docShell({ title, kind, number, date, inner, script }) {
  const e = escHtml;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0B0A10"><title>${e(title)} | Upper Echelon Automotive</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0B0A10;--sf:#120E1B;--rs:#1A1428;--r2:#241C38;--ln:rgba(226,214,255,.10);--ln2:rgba(226,214,255,.18);--g:#CBA135;--gh:#D8B24D;--p:#6B2896;
  --tx:#F3EFE8;--dm:rgba(243,239,232,.68);--ft:rgba(243,239,232,.5);--ok:#5FBF7A;--bd:#F07A73;--wn:#E8A33C;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.55 'Archivo',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;
  padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
main{max-width:760px;margin:0 auto;padding:1.4rem max(16px,env(safe-area-inset-left)) 3rem max(16px,env(safe-area-inset-right))}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;padding-bottom:1.2rem;border-bottom:1px solid var(--ln);margin-bottom:1.4rem}
.top img{height:40px;width:auto;display:block}
.top .fallback{font-stretch:118%;font-weight:750;font-size:1.15rem}
.top .meta{text-align:right;font-size:.82rem;color:var(--dm);font-variant-numeric:tabular-nums}
.top .meta b{display:block;color:var(--g);font-stretch:85%;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;margin-bottom:.2rem}
h1{font-stretch:118%;font-weight:750;font-size:clamp(1.7rem,5vw,2.3rem);letter-spacing:-.02em;line-height:1.05;margin:0 0 .4rem}
.lede{color:var(--dm);margin:0 0 1.2rem}
.parties{display:grid;grid-template-columns:1fr 1fr;gap:.8rem;margin-bottom:1rem}
.card{background:var(--rs);border:1px solid var(--ln);border-radius:12px;padding:1rem 1.1rem;margin-bottom:1rem}
.card h2{font-stretch:85%;font-size:.72rem;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--ft);margin:0 0 .45rem}
.card p{margin:0;color:var(--dm)} .card p b{color:var(--tx);font-weight:600}
.wrap{overflow-x:auto;margin:0 -.2rem}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{font-stretch:85%;font-size:.7rem;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:var(--ft);text-align:left;padding:.5rem .4rem;border-bottom:1px solid var(--ln)}
td{padding:.75rem .4rem;border-bottom:1px solid var(--ln);vertical-align:top}
td.r,th.r{text-align:right;white-space:nowrap}
td .sub{display:block;font-size:.82rem;color:var(--ft);margin-top:.1rem}
.tag{display:inline-block;font-size:.7rem;font-weight:650;padding:.05rem .45rem;border-radius:6px;background:var(--r2);color:var(--dm);margin-left:.3rem;vertical-align:1px}
.tot{margin-top:.6rem}.tot td{border:0;padding:.25rem .4rem;color:var(--dm)}
.tot .big td{color:var(--tx);font-weight:750;font-size:1.2rem;border-top:1px solid var(--ln);padding-top:.6rem}
.tot .big td.r{color:var(--g)}
.chk{display:inline-flex;gap:.4rem;align-items:center;font-weight:650;font-size:.9rem;color:var(--g);cursor:pointer;white-space:nowrap}
.chk input{width:20px;height:20px;accent-color:#CBA135}
.st{font-weight:650;font-size:.85rem}.st.approved{color:var(--ok)}.st.declined{color:var(--bd)}
input[type=text]{width:100%;min-height:50px;background:var(--bg);border:1px solid var(--ln2);border-radius:6px;color:var(--tx);padding:.75rem;font:inherit;font-size:16px}
input[type=text]:focus{border-color:var(--g);outline:none;box-shadow:0 0 0 3px rgba(203,161,53,.15)}
.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:52px;margin-top:.8rem;border:0;border-radius:2px;
  clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%);background:var(--g);color:#0B0A10;font:inherit;font-weight:700;font-size:1rem;
  text-decoration:none;cursor:pointer;transition:transform .12s cubic-bezier(.23,1,.32,1),background-color .15s ease}
.btn:active{transform:scale(.98)} .btn:disabled{opacity:.5}
.btn.quiet{background:var(--r2);color:var(--tx)}
.err{color:var(--bd);margin-top:.5rem;min-height:1.2em;font-size:.9rem}
.ok{border-color:rgba(95,191,122,.4);background:rgba(95,191,122,.08)}
.paid{display:inline-block;font-weight:750;color:var(--ok);border:2px solid var(--ok);border-radius:8px;padding:.2rem .7rem;letter-spacing:.06em;text-transform:uppercase;font-size:.85rem}
.due{color:var(--g)}
.foot{color:var(--ft);font-size:.82rem;margin-top:1.4rem;line-height:1.6}
.foot a{color:var(--g)}
.ins-item{display:grid;grid-template-columns:auto 1fr;gap:.7rem;padding:.8rem 0;border-bottom:1px solid var(--ln)}
.ins-item:last-child{border-bottom:0}
.dot{width:14px;height:14px;margin-top:.3rem;clip-path:polygon(25% 3%,75% 3%,100% 50%,75% 97%,25% 97%,0 50%)}
.dot.good{background:var(--ok)}.dot.watch{background:var(--wn)}.dot.bad{background:var(--bd)}.dot.na{background:var(--r2)}
.photos{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem}
.photos img{width:120px;height:90px;object-fit:cover;border-radius:6px;border:1px solid var(--ln)}
.legend{display:flex;gap:1rem;flex-wrap:wrap;font-size:.85rem;color:var(--dm);margin-bottom:.4rem}
.legend span{display:inline-flex;gap:.4rem;align-items:center}
:focus-visible{outline:2px solid var(--g);outline-offset:2px}
@media (max-width:560px){.parties{grid-template-columns:1fr}.top{flex-direction:column}.top .meta{text-align:left}}
@media print{body{background:#fff;color:#111}.card{background:#fff;border-color:#ccc}.btn,.chk input{display:none}}
</style></head><body><main>
<div class="top"><div><img src="${LOGO_URL}" alt="Upper Echelon Automotive" width="160" height="40" onerror="this.outerHTML='<span class=fallback>Upper Echelon Automotive</span>'"></div>
<div class="meta"><b>${e(kind)}</b>${number ? `#${e(number)}<br>` : ''}${e(date || docDate())}</div></div>
${inner}
<div class="foot">Upper Echelon Automotive · Mobile mechanic, Austin TX · (251) 289-0740<br>
Work is covered by our <a href="${AGREEMENT_URL}" target="_blank" rel="noopener">Service Agreement</a>, including the 90-day warranty on parts and labor we supply.</div>
</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function partiesHtml(j) {
  const e = escHtml;
  return `<div class="parties"><div class="card"><h2>Customer</h2><p><b>${e(j.customer_name || 'Customer')}</b>${j.phone ? `<br>${e(j.phone)}` : ''}${j.email ? `<br>${e(j.email)}` : ''}${j.address ? `<br>${e(j.address)}` : ''}</p></div>
<div class="card"><h2>Vehicle</h2><p><b>${e(j.vehicle || 'Vehicle')}</b>${j.vin ? `<br>VIN ${e(j.vin)}` : ''}${j.mileage ? `<br>${Number(j.mileage).toLocaleString()} miles` : ''}${j.plate ? `<br>Plate ${e(j.plate)}` : ''}</p></div></div>`;
}

const LINE_TYPE = { labor: 'Labor', part: 'Part', fee: 'Fee', discount: 'Discount' };
function lineCells(l) {
  const e = escHtml, amt = lineAmount(l);
  const qty = l.type === 'labor' ? `${Number(l.qty) || 0} hr` : (l.type === 'discount' ? '' : String(Number(l.qty) || 1));
  return `<td><b>${e(l.desc)}</b><span class="sub">${LINE_TYPE[l.type] || ''}${l.part_no ? ` · #${e(l.part_no)}` : ''}</span></td>
<td class="r">${e(qty)}</td><td class="r">${l.type === 'discount' ? '' : money(Number(l.unit_cents) || 0)}</td><td class="r">${l.type === 'discount' ? '−' : ''}${money(amt)}</td>`;
}

// ── Customer estimate approval page (public, link texted to the customer) ────
function estimatePage(j, cfg, token, insp) {
  const e = escHtml;
  const lines = (j.estimate && j.estimate.lines) || [];
  const tax = Number(cfg.parts_tax_rate) || 0;
  const pending = lines.filter(l => l.type !== 'discount' && (l.status || 'pending') === 'pending');
  const sentAt = (j.estimate && j.estimate.sent_at) || j.updated_at || j.created_at;
  const validTo = new Date(Date.parse(sentAt || new Date().toISOString()) + 30 * 86400000);
  const row = l => {
    const st = l.type === 'discount' ? '' : (l.status || 'pending');
    const ctl = st === 'pending'
      ? `<label class="chk"><input type="checkbox" data-id="${e(l.id)}" checked> Approve</label>`
      : st ? `<span class="st ${st}">${st === 'approved' ? 'Approved' : 'Declined'}</span>` : '';
    return `<tr data-type="${e(l.type)}" data-amt="${lineAmount(l)}" data-st="${e(st)}" data-id="${e(l.id)}">${lineCells(l)}<td class="r">${ctl}</td></tr>`;
  };
  const auths = (j.estimate && j.estimate.authorizations) || [];
  const lastAuth = auths[auths.length - 1];
  const flagged = insp ? (insp.items || []).filter(i => i.status === 'bad' || i.status === 'watch').length : 0;
  const inner = `<h1>Your repair estimate</h1>
<p class="lede">Review each item below. Uncheck anything you don't want done, then approve with your name.</p>
${partiesHtml(j)}
${j.concern ? `<div class="card"><h2>What you told us</h2><p>${e(j.concern)}</p></div>` : ''}
${j.findings ? `<div class="card"><h2>What our technician found</h2><p>${e(j.findings).replace(/\n/g, '<br>')}</p></div>` : ''}
${insp && insp.token && flagged ? `<div class="card"><h2>Inspection</h2><p>${flagged} item${flagged > 1 ? 's' : ''} need attention. <a class="due" href="${PUBLIC_BASE}/loyalty/i/${insp.token}">See the inspection report with photos</a></p></div>` : ''}
<div class="card"><h2>Itemized estimate</h2><div class="wrap"><table>
<tr><th>Item</th><th class="r">Qty / hrs</th><th class="r">Price</th><th class="r">Amount</th><th class="r"></th></tr>
${lines.map(row).join('')}</table></div>
<table class="tot"><tr><td>Labor and fees</td><td class="r" id="tL"></td></tr><tr><td>Parts</td><td class="r" id="tP"></td></tr>
<tr><td>Tax on parts (${tax}%)</td><td class="r" id="tT"></td></tr><tr class="big"><td>Total for approved work</td><td class="r" id="tA"></td></tr></table></div>
${j.estimate && j.estimate.notes ? `<div class="card"><h2>Notes</h2><p>${e(j.estimate.notes).replace(/\n/g, '<br>')}</p></div>` : ''}
${pending.length ? `<div class="card" id="authBox"><h2>Approve the work</h2>
<p style="margin-bottom:.8rem">By typing your name you authorize Upper Echelon Automotive to do the checked work at the prices shown, plus tax. If we find anything else, we'll ask before doing it. Jobs of $499 or more need a 50% retainer before parts are ordered.</p>
<input type="text" id="nm" placeholder="Type your full name" autocomplete="name">
<button class="btn" id="go">Approve checked work</button><div class="err" id="er"></div></div>`
  : `<div class="card ok"><h2>All set</h2><p>${lastAuth ? `Approved by <b>${e(lastAuth.name)}</b> on ${new Date(lastAuth.at).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' })}.` : 'Every item on this estimate has a decision.'} Questions? Call (251) 289-0740.</p></div>`}
<p class="foot" style="margin-top:0">Prices are good until ${docDate(validTo)}. <a href="${PUBLIC_BASE}/loyalty/q/${token}" style="color:var(--g)">Download a printable copy of this quote</a></p>`;
  const script = `(function(){
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
      .catch(function(e){er.textContent=e.message+' You can also call (251) 289-0740.';go.disabled=false;go.textContent='Approve checked work';});
  });
})();`;
  return docShell({ title: 'Your estimate', kind: 'Estimate', number: docNumber(j), date: docDate(sentAt), inner, script });
}

// ── Invoice page (public, texted when the job is done) ───────────────────────
function invoicePage(j, cfg) {
  const e = escHtml;
  const all = (j.estimate && j.estimate.lines) || [];
  const hasDecisions = all.some(l => l.status === 'approved');
  const lines = all.filter(l => l.type === 'discount' || (hasDecisions ? l.status === 'approved' : l.status !== 'declined'));
  const t = estTotals({ lines: lines.map(l => Object.assign({}, l, { status: l.type === 'discount' ? l.status : 'approved' })) }, cfg.parts_tax_rate).approved;
  const paid = j.status === 'paid';
  const total = paid && j.total_cents ? j.total_cents : t.total;
  const payLink = j.pay_link || cfg.payment_link || '';
  const inner = `<h1>${paid ? 'Thank you for your business' : 'Your invoice'}</h1>
<p class="lede">${paid ? `Paid${j.payment_method ? ` by ${e(j.payment_method)}` : ''}${j.paid_at ? ` on ${docDate(j.paid_at)}` : ''}. Keep this for your records.` : 'Here is the itemized bill for the work we completed.'}</p>
${paid ? '<p><span class="paid">Paid</span></p>' : ''}
${partiesHtml(j)}
${j.findings ? `<div class="card"><h2>Work notes</h2><p>${e(j.findings).replace(/\n/g, '<br>')}</p></div>` : ''}
<div class="card"><h2>Itemized invoice</h2>${lines.length ? `<div class="wrap"><table>
<tr><th>Item</th><th class="r">Qty / hrs</th><th class="r">Price</th><th class="r">Amount</th></tr>
${lines.map(l => `<tr>${lineCells(l)}</tr>`).join('')}</table></div>
<table class="tot"><tr><td>Labor and fees</td><td class="r">${money(Math.max(0, t.labor + t.fees - t.discount))}</td></tr><tr><td>Parts</td><td class="r">${money(t.parts)}</td></tr>
<tr><td>Tax on parts (${Number(cfg.parts_tax_rate) || 0}%)</td><td class="r">${money(t.tax)}</td></tr>
<tr class="big"><td>${paid ? 'Total paid' : 'Total due'}</td><td class="r">${money(total)}</td></tr></table>` : `<table class="tot"><tr class="big"><td>${paid ? 'Total paid' : 'Total due'}</td><td class="r">${money(total)}</td></tr></table>`}</div>
${!paid && payLink ? `<a class="btn" href="${e(payLink)}" target="_blank" rel="noopener">Pay ${money(total)} securely</a>` : ''}
${!paid ? '<p class="foot" style="margin-top:.8rem">Payment is due when the work is complete. We accept cards, cash, Zelle, Venmo and Cash App.</p>' : ''}`;
  return docShell({ title: paid ? 'Receipt' : 'Invoice', kind: paid ? 'Receipt' : 'Invoice', number: docNumber(j), date: docDate(j.paid_at || j.updated_at), inner });
}

// ── Inspection report (public) ───────────────────────────────────────────────
function inspectionPage(j, insp, photos) {
  const e = escHtml;
  const items = (insp.items || []).filter(i => i.status && i.status !== 'na');
  const order = { bad: 0, watch: 1, good: 2 };
  items.sort((a, b) => order[a.status] - order[b.status]);
  const label = { bad: 'Needs attention now', watch: 'Keep an eye on it', good: 'Good' };
  const count = s => items.filter(i => i.status === s).length;
  const pics = key => photos.filter(p => p.item_key === key);
  const inner = `<h1>Vehicle inspection report</h1>
<p class="lede">${count('bad')} need attention now · ${count('watch')} to keep an eye on · ${count('good')} good</p>
${partiesHtml(j)}
${insp.summary ? `<div class="card"><h2>Technician summary</h2><p>${e(insp.summary).replace(/\n/g, '<br>')}</p></div>` : ''}
<div class="card"><h2>Checklist</h2>
<div class="legend"><span><i class="dot bad"></i>Needs attention now</span><span><i class="dot watch"></i>Keep an eye on it</span><span><i class="dot good"></i>Good</span></div>
${items.map(i => `<div class="ins-item"><i class="dot ${e(i.status)}" aria-label="${e(label[i.status])}"></i><div><b>${e(i.name)}</b> <span class="tag">${e(label[i.status])}</span>
${i.note ? `<div style="color:var(--dm);margin-top:.2rem">${e(i.note)}</div>` : ''}
${pics(i.key).length ? `<div class="photos">${pics(i.key).map(p => `<a href="${PUBLIC_BASE}/loyalty/i/${insp.token}/p/${p.id}" target="_blank"><img src="${PUBLIC_BASE}/loyalty/i/${insp.token}/p/${p.id}" alt="${e(i.name)} photo" loading="lazy"></a>`).join('')}</div>` : ''}</div></div>`).join('') || '<p>No items were checked.</p>'}
</div>
${j.estimate_token ? `<a class="btn" href="${PUBLIC_BASE}/loyalty/e/${j.estimate_token}">See your estimate</a>` : ''}`;
  return docShell({ title: 'Inspection report', kind: 'Inspection', number: docNumber(j), date: docDate(insp.sent_at || insp.updated_at), inner });
}

// ── Digital vehicle inspections ─────────────────────────────────────────────
const INSPECTION_ITEMS = [
  ['battery', 'Battery and charging system'], ['starting', 'Starter and cranking'], ['codes', 'Check engine light and stored codes'],
  ['oil', 'Engine oil level and condition'], ['coolant', 'Coolant level and condition'], ['brake_fluid', 'Brake fluid'],
  ['trans_fluid', 'Transmission fluid'], ['ps_fluid', 'Power steering fluid'], ['belts', 'Drive belts'], ['hoses', 'Radiator and heater hoses'],
  ['leaks', 'Fluid leaks'], ['air_filter', 'Engine air filter'], ['cabin_filter', 'Cabin air filter'], ['front_brakes', 'Front brakes'],
  ['rear_brakes', 'Rear brakes'], ['tires', 'Tire tread and pressure'], ['suspension', 'Suspension and steering'], ['cv', 'CV axles and boots'],
  ['exhaust', 'Exhaust system'], ['lights', 'Lights and signals'], ['wipers', 'Wipers and washer'], ['ac', 'A/C and heat']
].map(([key, name]) => ({ key, name, status: null, note: '' }));
const INS_STATUS = ['good', 'watch', 'bad', 'na'];

async function getInspection(jobId, create) {
  let insp = (await sb(`uea_inspections?job_id=eq.${enc(jobId)}&select=*`))[0] || null;
  if (!insp && create) {
    const r = await sb('uea_inspections?on_conflict=job_id', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
      body: { job_id: jobId, items: INSPECTION_ITEMS, token: crypto.randomBytes(16).toString('hex') } });
    insp = r[0] || (await sb(`uea_inspections?job_id=eq.${enc(jobId)}&select=*`))[0];
  }
  return insp;
}
const inspectionCounts = insp => {
  const c = { good: 0, watch: 0, bad: 0, done: 0, total: 0 };
  ((insp && insp.items) || []).forEach(i => { c.total++; if (i.status) { c.done++; if (c[i.status] != null) c[i.status]++; } });
  return c;
};

router.get('/admin/booking/:id/inspection', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const insp = await getInspection(j.id, true);
  const photos = await sb(`uea_inspection_photos?inspection_id=eq.${insp.id}&select=id,item_key,created_at&order=created_at.asc`);
  res.json({ inspection: insp, photos, report_link: `${PUBLIC_BASE}/loyalty/i/${insp.token}` });
}));

router.put('/admin/booking/:id/inspection', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const insp = await getInspection(j.id, true);
  const known = new Map((insp.items || []).map(i => [i.key, i]));
  const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 60).map(i => {
    const key = String(i.key || '').replace(/[^a-z0-9_]/gi, '').slice(0, 40) || `custom_${crypto.randomBytes(3).toString('hex')}`;
    const base = known.get(key) || {};
    return { key, name: String(i.name || base.name || 'Item').trim().slice(0, 80),
      status: INS_STATUS.includes(i.status) ? i.status : null, note: String(i.note || '').trim().slice(0, 500) };
  });
  const r = await sb(`uea_inspections?id=eq.${insp.id}`, { method: 'PATCH', prefer: 'return=representation',
    body: { items, summary: String(req.body.summary || '').trim().slice(0, 2000) || null, updated_at: new Date().toISOString(), updated_by: req.staff.name } });
  res.json({ inspection: r[0] });
}));

router.post('/admin/booking/:id/inspection/photo', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const insp = await getInspection(j.id, true);
  const data = String(req.body.data || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) throw httpErr(400, 'That file isn\'t a photo.');
  if (data.length > 2_500_000) throw httpErr(400, 'That photo is too large. Try again; the desk shrinks photos before sending.');
  const n = (await sb(`uea_inspection_photos?inspection_id=eq.${insp.id}&select=id`)).length;
  if (n >= 60) throw httpErr(400, 'This inspection already has 60 photos.');
  const r = await sb('uea_inspection_photos', { method: 'POST', prefer: 'return=representation',
    body: { inspection_id: insp.id, item_key: String(req.body.item_key || 'general').slice(0, 40), data } });
  res.json({ photo: { id: r[0].id, item_key: r[0].item_key }, url: `${PUBLIC_BASE}/loyalty/i/${insp.token}/p/${r[0].id}` });
}));

router.delete('/admin/inspection-photo/:pid', auth(ALL), h(async (req, res) => {
  await sb(`uea_inspection_photos?id=eq.${enc(req.params.pid)}`, { method: 'DELETE' });
  res.json({ ok: true });
}));

router.post('/admin/booking/:id/inspection/send', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const insp = await getInspection(j.id, true);
  const c = inspectionCounts(insp);
  if (!c.done) throw httpErr(400, 'Mark at least one item before sending the report.');
  const cfg = await getConfig();
  const link = `${PUBLIC_BASE}/loyalty/i/${insp.token}`;
  const text = req.body.text || fillTemplate(cfg.sms_templates.inspection || DEFAULT_CONFIG.sms_templates.inspection,
    Object.assign(await smsVars(j, cfg), { report_link: link, flagged: String(c.bad + c.watch) }));
  if (req.body.via !== 'link') { await sendSms(j.phone, text, { job: j, by: req.staff.name, kind: req.body.kind || null }); await logEvent(j.id, req.staff.name, 'sms', text); }
  await sb(`uea_inspections?id=eq.${insp.id}`, { method: 'PATCH', body: { sent_at: new Date().toISOString() } });
  await logEvent(j.id, req.staff.name, 'inspection', `Inspection report ${req.body.via === 'link' ? 'link created' : 'texted'}: ${c.bad} need attention, ${c.watch} to watch, ${c.good} good`);
  res.json({ link, texted: req.body.via !== 'link' });
}));

router.get('/i/:token', h(async (req, res) => {
  const token = String(req.params.token || '');
  const insp = /^[a-f0-9]{32}$/.test(token) ? (await sb(`uea_inspections?token=eq.${token}&select=*`))[0] : null;
  res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Cache-Control', 'no-store');
  const j = insp ? (await sb(`uea_loyalty_bookings?id=eq.${insp.job_id}&select=*`))[0] : null;
  if (!insp || !j) return res.status(404).send(docShell({ title: 'Not found', kind: 'Inspection', inner: '<h1>This link is no longer valid</h1><p class="lede">Call us at (251) 289-0740.</p>' }));
  const photos = await sb(`uea_inspection_photos?inspection_id=eq.${insp.id}&select=id,item_key&order=created_at.asc`);
  res.send(inspectionPage(j, insp, photos));
}));

router.get('/i/:token/p/:pid', h(async (req, res) => {
  const token = String(req.params.token || '');
  const insp = /^[a-f0-9]{32}$/.test(token) ? (await sb(`uea_inspections?token=eq.${token}&select=id`))[0] : null;
  const p = insp ? (await sb(`uea_inspection_photos?id=eq.${enc(req.params.pid)}&inspection_id=eq.${insp.id}&select=data`))[0] : null;
  const m = p && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(p.data);
  if (!m) return res.sendStatus(404);
  res.set({ 'Content-Type': m[1], 'Cache-Control': 'private, max-age=86400', 'X-Robots-Tag': 'noindex' });
  res.send(Buffer.from(m[2], 'base64'));
}));

// ── Invoices ────────────────────────────────────────────────────────────────
async function jobByToken(token) {
  return /^[a-f0-9]{32}$/.test(String(token || '')) ? (await sb(`uea_loyalty_bookings?estimate_token=eq.${token}&select=*`))[0] || null : null;
}
router.get('/v/:token', h(async (req, res) => {
  const j = await jobByToken(req.params.token);
  res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Cache-Control', 'no-store');
  if (!j) return res.status(404).send(docShell({ title: 'Not found', kind: 'Invoice', inner: '<h1>This link is no longer valid</h1><p class="lede">Call us at (251) 289-0740.</p>' }));
  res.send(invoicePage(j, await getConfig()));
}));

router.post('/admin/booking/:id/invoice/send', auth(DESK), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const cfg = await getConfig();
  const token = j.estimate_token || crypto.randomBytes(16).toString('hex');
  if (!j.estimate_token) await patchJob(j.id, { estimate_token: token });
  const link = `${PUBLIC_BASE}/loyalty/v/${token}`;
  const viaText = req.body.via !== 'link';
  if (viaText) {
    const text = req.body.text || fillTemplate(cfg.sms_templates.invoice || DEFAULT_CONFIG.sms_templates.invoice,
      Object.assign(await smsVars(Object.assign({}, j, { estimate_token: token }), cfg), { invoice_link: link }));
    await sendSms(j.phone, text, { job: j, by: req.staff.name, kind: req.body.kind || null });
    await logEvent(j.id, req.staff.name, 'sms', text);
  }
  await logEvent(j.id, req.staff.name, 'invoice', viaText ? `${j.status === 'paid' ? 'Receipt' : 'Invoice'} texted to customer` : 'Invoice link created');
  res.json({ link, texted: viaText });
}));

// ── Calendar ────────────────────────────────────────────────────────────────
// Start time from "10:00 AM", "1 PM", "9-11 AM", "14:30". Returns minutes after midnight or null.
function windowStart(w) {
  const t = String(w || '');
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?/i);
  if (!m) return null;
  let h = +m[1]; const min = +(m[2] || 0);
  let ap = m[3] || (t.match(/([ap])\.?\s*m/i) || [])[1];
  if (h > 23 || min > 59) return null;
  if (ap) { ap = ap.toLowerCase(); if (h === 12) h = 0; if (ap === 'p') h += 12; }
  return h * 60 + min;
}
// Chicago wall-clock time → UTC Date (handles daylight saving).
function chicagoToUtc(iso, minutes) {
  const [y, mo, d] = iso.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const asChicago = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const asUtc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess + (asUtc - asChicago));
}
const jobHours = j => {
  const h = ((j.estimate && j.estimate.lines) || []).filter(l => l.type === 'labor' && l.status !== 'declined').reduce((a, l) => a + (Number(l.qty) || 0), 0);
  return Math.min(10, Math.max(1, h || 1.5));
};
const calRow = j => ({
  id: j.id, date: j.sched_date, window: j.sched_window || null, start_min: windowStart(j.sched_window), hours: jobHours(j),
  customer_name: j.customer_name, service: j.service, vehicle: j.vehicle, address: j.address, phone: j.phone,
  stage: j.stage, status: j.status, rush: !!j.rush, order_name: j.order_name, tech: j.tech || null, tech_id: j.tech_id || null
});
router.get('/admin/calendar', auth(ALL), h(async (req, res) => {
  const from = isoDate(req.query.from), to = isoDate(req.query.to);
  if (!from || !to || to < from) throw httpErr(400, 'Pick a date range.');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 62) throw httpErr(400, 'Pick 2 months or less.');
  let url = `uea_loyalty_bookings?select=*,tech:uea_staff(id,name)&sched_date=gte.${from}&sched_date=lte.${to}&status=neq.cancelled&order=sched_date.asc&limit=1000`;
  let un = 'uea_loyalty_bookings?select=id&status=eq.open&sched_date=is.null&limit=500';
  if (req.staff.role === 'tech') { url += `&tech_id=eq.${req.staff.id}`; un += `&tech_id=eq.${req.staff.id}`; }
  else if (req.query.tech) { const f = req.query.tech === 'none' ? '&tech_id=is.null' : `&tech_id=eq.${enc(req.query.tech)}`; url += f; }
  const [jobs, unsched] = await Promise.all([sb(url), sb(un)]);
  const rows = jobs.map(calRow).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start_min ?? 9999) - (b.start_min ?? 9999));
  res.json({ jobs: rows, unscheduled: unsched.length, today: todayCentral() });
}));

// Calendar feed for phones (Apple/Google/Outlook). Link carries a secret; changing LOYALTY_SECRET resets every link.
const calToken = key => crypto.createHmac('sha256', LOYALTY_SECRET || 'unset').update(`calendar:${key}`).digest('hex').slice(0, 32);
router.get('/admin/calendar/feed', auth(ALL), h(async (req, res) => {
  const key = req.staff.role === 'tech' ? `tech:${req.staff.id}` : 'shop';
  const url = `${PUBLIC_BASE}/loyalty/cal/${encodeURIComponent(key)}/${calToken(key)}.ics`;
  res.json({ url, webcal: url.replace(/^https?:/, 'webcal:'), scope: key === 'shop' ? 'all jobs' : 'your jobs' });
}));
const icsEsc = v => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
const icsFold = line => { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); } out.push(s); return out.join('\r\n'); };
const icsTime = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
router.get('/cal/:key/:token.ics', h(async (req, res) => {
  const key = String(req.params.key || '');
  if (!LOYALTY_SECRET || !/^(shop|tech:[0-9a-f-]{8,40})$/i.test(key) || req.params.token !== calToken(key)) return res.sendStatus(404);
  const today = todayCentral();
  const from = new Date(Date.parse(today) - 60 * 864e5).toISOString().slice(0, 10);
  const to = new Date(Date.parse(today) + 180 * 864e5).toISOString().slice(0, 10);
  let url = `uea_loyalty_bookings?select=*,tech:uea_staff(id,name)&sched_date=gte.${from}&sched_date=lte.${to}&status=neq.cancelled&limit=2000`;
  if (key.startsWith('tech:')) url += `&tech_id=eq.${enc(key.slice(5))}`;
  const jobs = await sb(url);
  const stamp = icsTime(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Upper Echelon Automotive//Service Desk//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${key === 'shop' ? 'UEA Jobs' : 'UEA – My jobs'}`, 'X-WR-TIMEZONE:America/Chicago', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M'];
  for (const j of jobs) {
    const r = calRow(j);
    const title = `${j.status === 'paid' ? '✓ ' : ''}${r.rush ? 'RUSH ' : ''}${r.service || 'Service'} – ${r.customer_name || 'Customer'}${r.vehicle ? ` (${r.vehicle})` : ''}`;
    const desc = [r.window ? `Time: ${r.window}` : null, r.phone ? `Phone: ${r.phone}` : null, r.vehicle ? `Vehicle: ${r.vehicle}` : null,
      j.concern ? `Concern: ${j.concern}` : null, r.tech ? `Tech: ${r.tech.name}` : 'Tech: not assigned', `Status: ${j.status === 'paid' ? 'Paid' : (STAGE_LABEL[r.stage] || r.stage)}`,
      r.order_name ? `Order: ${r.order_name}` : null, `Open in desk: ${PUBLIC_BASE}/loyalty/admin`].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${j.id}@ueauto.store`, `DTSTAMP:${stamp}`);
    if (r.start_min != null) {
      const st = chicagoToUtc(r.date, r.start_min);
      lines.push(`DTSTART:${icsTime(st)}`, `DTEND:${icsTime(new Date(st.getTime() + r.hours * 3600000))}`);
    } else {
      const next = new Date(Date.parse(r.date) + 864e5).toISOString().slice(0, 10).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${r.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${next}`);
    }
    lines.push(icsFold(`SUMMARY:${icsEsc(title)}`), icsFold(`DESCRIPTION:${icsEsc(desc)}`));
    if (r.address) lines.push(icsFold(`LOCATION:${icsEsc(r.address)}`));
    lines.push(`STATUS:${j.status === 'paid' ? 'CONFIRMED' : 'CONFIRMED'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.send(lines.join('\r\n') + '\r\n');
}));

// ── Import bookings placed before the desk existed ──────────────────────────
// Paste the JSON from Shopify admin (…/admin/orders.json). Same handling as the
// order webhook; orders already in the desk are skipped, so it's safe to run twice.
router.post('/admin/import/shopify', auth(DESK), h(async (req, res) => {
  let orders = req.body && req.body.orders;
  if (orders && !Array.isArray(orders) && Array.isArray(orders.orders)) orders = orders.orders;
  if (!Array.isArray(orders) || !orders.length) throw httpErr(400, 'Nothing to import. Paste the whole page from Shopify.');
  if (orders.length > 250) throw httpErr(400, 'Import up to 250 orders at a time.');
  const upcomingOnly = req.body.include_past !== true;
  const out = { created: 0, already: 0, past: 0, cancelled: 0, not_booking: 0, failed: 0, errors: [] };
  for (const o of orders) {
    if (!o || !o.id || !Array.isArray(o.line_items)) { out.not_booking++; continue; }
    if (o.cancelled_at) { out.cancelled++; continue; }
    const before = (await sb(`uea_loyalty_bookings?shopify_order_id=eq.${enc(String(o.id))}&select=id`))[0];
    if (before) { out.already++; continue; }
    try {
      const r = await createBookingFromOrder(o, { upcomingOnly, by: req.staff.name });
      if (r === 'created') {
        out.created++;
        if (o.financial_status === 'paid') {
          const b = (await sb(`uea_loyalty_bookings?shopify_order_id=eq.${enc(String(o.id))}&select=id`))[0];
          if (b) await logEvent(b.id, req.staff.name, 'note', `Shopify shows this order as paid (${o.total_price || '?'}). Points weren't added by the import.`);
        }
      } else if (r === 'linked' || r === 'duplicate') out.already++;
      else if (r === 'past') out.past++;
      else out.not_booking++;
    } catch (e) { out.failed++; if (out.errors.length < 5) out.errors.push(`${o.name || o.id}: ${e.message}`); }
  }
  res.json(out);
}));

// ── Service reminders ───────────────────────────────────────────────────────
function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  return dt.toISOString().slice(0, 10);
}
async function scheduleAfterPaid(b) {
  if (!b.member_id) return;
  const cfg = await getConfig();
  const lines = ((b.estimate && b.estimate.lines) || []).filter(l => l.status !== 'declined').map(l => l.desc).join(' ');
  const text = `${b.service || ''} ${lines}`;
  if (/oil change|oil service|lube/i.test(text)) {
    const months = Number(cfg.oil_change_months) || 6;
    const existing = await sb(`uea_reminders?member_id=eq.${b.member_id}&status=eq.pending&title=eq.${enc('Oil change')}${b.vehicle_id ? `&vehicle_id=eq.${b.vehicle_id}` : ''}&select=id`);
    const body = { member_id: b.member_id, vehicle_id: b.vehicle_id || null, job_id: b.id, kind: 'service', status: 'pending', title: 'Oil change',
      due_date: addMonths(todayCentral(), months), note: b.mileage ? `Last done at ${Number(b.mileage).toLocaleString()} miles` : null, created_by: 'System' };
    if (existing[0]) await sb(`uea_reminders?id=eq.${existing[0].id}`, { method: 'PATCH', body: { due_date: body.due_date, job_id: b.id, note: body.note } });
    else await sb('uea_reminders', { method: 'POST', body });
  }
}

router.get('/admin/reminders', auth(DESK), h(async (req, res) => {
  const view = ['due', 'upcoming', 'done'].includes(req.query.view) ? req.query.view : 'due';
  const today = todayCentral();
  let url = 'uea_reminders?select=*,member:uea_loyalty_members(id,name,phone,email),vehicle:uea_client_vehicles(id,description,mileage)';
  if (view === 'due') url += `&status=eq.pending&due_date=lte.${today}&order=due_date.asc`;
  else if (view === 'upcoming') url += `&status=eq.pending&due_date=gt.${today}&order=due_date.asc`;
  else url += '&status=in.(sent,done,skipped)&order=due_date.desc';
  if (req.query.member) url += `&member_id=eq.${enc(req.query.member)}`;
  res.json({ reminders: await sb(url + '&limit=200'), today, auto: !!(await getConfig()).reminders_auto });
}));

router.post('/admin/reminders', auth(DESK), h(async (req, res) => {
  const b = req.body || {};
  const m = (await sb(`uea_loyalty_members?id=eq.${enc(b.member_id)}&select=id`))[0];
  if (!m) throw httpErr(400, 'Pick a customer.');
  const due = isoDate(b.due_date); if (!due) throw httpErr(400, 'Pick a due date.');
  const title = String(b.title || '').trim().slice(0, 80); if (!title) throw httpErr(400, 'Say what the reminder is for, like "Oil change".');
  const r = await sb('uea_reminders', { method: 'POST', prefer: 'return=representation', body: {
    member_id: m.id, vehicle_id: b.vehicle_id || null, kind: 'custom', status: 'pending', title, due_date: due,
    note: b.note ? String(b.note).trim().slice(0, 300) : null, created_by: req.staff.name } });
  res.json({ reminder: r[0] });
}));

router.patch('/admin/reminder/:id', auth(DESK), h(async (req, res) => {
  const patch = {};
  if (req.body.status) { if (!['pending', 'done', 'skipped'].includes(req.body.status)) throw httpErr(400, 'Unknown status.'); patch.status = req.body.status; }
  if (req.body.due_date) { const d = isoDate(req.body.due_date); if (!d) throw httpErr(400, 'Pick a valid date.'); patch.due_date = d; patch.status = 'pending'; }
  const r = await sb(`uea_reminders?id=eq.${enc(req.params.id)}`, { method: 'PATCH', prefer: 'return=representation', body: patch });
  if (!r[0]) throw httpErr(404, 'Reminder not found.');
  res.json({ reminder: r[0] });
}));

async function sendReminder(rem, by) {
  const cfg = await getConfig();
  const m = rem.member || (await sb(`uea_loyalty_members?id=eq.${rem.member_id}&select=name,phone`))[0] || {};
  const v = rem.vehicle || (rem.vehicle_id ? (await sb(`uea_client_vehicles?id=eq.${rem.vehicle_id}&select=description`))[0] : null) || {};
  const text = fillTemplate(cfg.sms_templates.reminder || DEFAULT_CONFIG.sms_templates.reminder, {
    first: firstName(m.name), name: m.name || '', title: rem.title.toLowerCase(), vehicle: v.description || 'car', shop_phone: cfg.shop_phone || '' });
  await sendSms(m.phone, text, { member_id: rem.member_id, by, kind: 'reminder' });
  await sb(`uea_reminders?id=eq.${rem.id}`, { method: 'PATCH', body: { status: 'sent', sent_at: new Date().toISOString(), sent_by: by } });
  return text;
}
router.post('/admin/reminder/:id/send', auth(DESK), h(async (req, res) => {
  const rem = (await sb(`uea_reminders?id=eq.${enc(req.params.id)}&select=*,member:uea_loyalty_members(id,name,phone),vehicle:uea_client_vehicles(id,description)`))[0];
  if (!rem) throw httpErr(404, 'Reminder not found.');
  res.json({ text: await sendReminder(rem, req.staff.name) });
}));

// Automatic reminder texts: once an hour, 10 AM–6 PM Central, only when turned on in Settings.
let reminderTimer = null;
async function runAutoReminders() {
  const cfg = await getConfig();
  if (!cfg.reminders_auto || !process.env.TEXTBELT_KEY) return;
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));
  if (hour < 10 || hour >= 18) return;
  const due = await sb(`uea_reminders?status=eq.pending&due_date=lte.${todayCentral()}&select=*,member:uea_loyalty_members(id,name,phone),vehicle:uea_client_vehicles(id,description)&limit=20`);
  for (const r of due) { await sendReminder(r, 'Automatic').catch(e => console.warn('[loyalty] reminder not sent:', e.message)); }
}
if (!reminderTimer && process.env.NODE_ENV !== 'test') {
  reminderTimer = setInterval(() => runAutoReminders().catch(e => console.warn('[loyalty] reminders:', e.message)), 60 * 60 * 1000);
  if (reminderTimer.unref) reminderTimer.unref();
}

// ── Technician time tracking ────────────────────────────────────────────────
router.post('/admin/booking/:id/clock', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  const who = req.staff.id || 'owner';
  const now = new Date().toISOString();
  const open = await sb(`uea_time_entries?staff_key=eq.${enc(who)}&ended_at=is.null&select=*`);
  if (req.body.action === 'in') {
    for (const o of open) await sb(`uea_time_entries?id=eq.${o.id}`, { method: 'PATCH', body: { ended_at: now } });   // one job at a time
    await sb('uea_time_entries', { method: 'POST', body: { job_id: j.id, staff_key: who, staff_name: req.staff.name, started_at: now } });
    await logEvent(j.id, req.staff.name, 'time', 'Clocked in');
  } else {
    const mine = open.filter(o => o.job_id === j.id);
    if (!mine.length) throw httpErr(400, 'You aren\'t clocked in on this job.');
    for (const o of mine) await sb(`uea_time_entries?id=eq.${o.id}`, { method: 'PATCH', body: { ended_at: now } });
    await logEvent(j.id, req.staff.name, 'time', 'Clocked out');
  }
  res.json({ time: await jobTime(j, who) });
}));

async function jobTime(j, who) {
  const entries = await sb(`uea_time_entries?job_id=eq.${j.id}&select=*&order=started_at.asc`);
  const hours = entries.reduce((a, e) => a + ((Date.parse(e.ended_at || new Date().toISOString()) - Date.parse(e.started_at)) / 3600000), 0);
  const quoted = ((j.estimate && j.estimate.lines) || []).filter(l => l.type === 'labor' && l.status !== 'declined').reduce((a, l) => a + (Number(l.qty) || 0), 0);
  return { entries, worked_hours: Math.round(hours * 100) / 100, quoted_hours: Math.round(quoted * 100) / 100,
    clocked_in: !!entries.find(e => !e.ended_at && e.staff_key === who) };
}

// ── Branded quote (printable, one per job) ──────────────────────────────────
// Same design as the Pathfinder quote: black sheet, gold + purple, Bebas Neue / Oswald,
// numbered hex-bolt line items, letter size. Built live from the job's saved estimate,
// so every job keeps its own quote and it updates whenever the estimate is saved.
const RETAINER_MIN_CENTS = 49900;   // jobs of $499+ need a retainer (matches the estimate page and agreement)
const RETAINER_PCT = 50;

function quotePage(j, cfg, token) {
  const e = escHtml;
  const est = j.estimate || { lines: [] };
  const lines = (est.lines || []).filter(l => l.status !== 'declined');
  const taxRate = Number(cfg.parts_tax_rate) || 0;
  const t = estTotals(est, taxRate).quoted;
  const laborFees = t.labor + t.fees;
  const retainer = t.total >= RETAINER_MIN_CENTS ? Math.round(t.total * RETAINER_PCT / 100) : 0;
  const balance = t.total - retainer;
  const quoteDate = docDate(est.updated_at || j.updated_at || j.created_at);
  const validTo = docDate(Date.parse(est.updated_at || j.updated_at || j.created_at || new Date().toISOString()) + 30 * 86400000);
  const sched = [fmtDate(j.sched_date || j.appt_date) || (j.appt_date && !isoDate(j.appt_date) ? j.appt_date : ''), j.sched_window || j.appt_time || '']
    .filter(Boolean).join(' · ');
  const vehBits = [j.vin ? `VIN ${e(j.vin)}` : '', j.mileage ? `${Number(j.mileage).toLocaleString()} mi` : '', j.plate ? `Plate ${e(j.plate)}` : '']
    .filter(Boolean).join(' · ');
  const usd = c => '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const qno = String(docNumber(j)).replace(/^#/, '');
  const bolt = n => `<svg class="bolt" viewBox="0 0 32 36" aria-hidden="true"><polygon points="16,1 31,9.5 31,26.5 16,35 1,26.5 1,9.5" fill="#CBA135"/><text x="16" y="23.5" text-anchor="middle" font-family="Oswald, sans-serif" font-weight="700" font-size="${n > 9 ? 12 : 15}" fill="#0B0B0C">${n}</text></svg>`;
  let n = 0;
  const rows = lines.map(l => {
    const amt = lineAmount(l);
    const qty = Number(l.qty) || 0;
    let sub;
    if (l.type === 'labor') sub = `Labor · ${qty} hr${qty === 1 ? '' : 's'}`;
    else if (l.type === 'part') sub = `Parts${qty && qty !== 1 ? ` · Qty ${qty} @ ${usd(Number(l.unit_cents) || 0)}` : ''}${l.part_no ? ` · #${e(l.part_no)}` : ''}`;
    else if (l.type === 'fee') sub = 'Fee';
    else sub = 'Discount';
    const num = l.type === 'discount' ? '<span class="bolt-sp"></span>' : bolt(++n);
    return `<div class="li${l.type === 'discount' ? ' disc' : ''}">${num}<div class="li-t"><div class="li-n">${e(l.desc)}</div><div class="li-s">${sub}</div></div><div class="li-a">${l.type === 'discount' ? '−' : ''}${usd(amt)}</div></div>`;
  }).join('');
  const sumRow = (k, v, cls) => `<div class="sr${cls ? ' ' + cls : ''}"><span>${k}</span><span>${v}</span></div>`;
  const approveLink = token && (est.lines || []).some(l => l.type !== 'discount' && (l.status || 'pending') === 'pending')
    ? `${PUBLIC_BASE}/loyalty/e/${token}` : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="theme-color" content="#0B0B0C">
<title>Quote ${e(qno)} — ${e(j.customer_name || 'Customer')} | Upper Echelon Automotive</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bk:#0B0B0C;--g:#CBA135;--p:#6B2896;--cr:#F4F1EA;--dm:rgba(244,241,234,.72);--ft:rgba(244,241,234,.5);--ln:rgba(244,241,234,.12);color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:#1a1a1c}
body{font-family:'Inter',system-ui,sans-serif;color:var(--cr);-webkit-font-smoothing:antialiased;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{position:sticky;top:0;z-index:5;display:flex;gap:.6rem;align-items:center;justify-content:center;flex-wrap:wrap;padding:.7rem 16px;background:#111;border-bottom:1px solid var(--ln)}
.bar button,.bar a{font:600 15px 'Oswald',sans-serif;letter-spacing:.06em;text-transform:uppercase;border:0;border-radius:2px;padding:.65rem 1.2rem;cursor:pointer;text-decoration:none;
  clip-path:polygon(0 0,calc(100% - 10px) 0,100% 10px,100% 100%,0 100%)}
.bar .pr{background:var(--g);color:var(--bk)} .bar .q{background:#2a2135;color:var(--cr)}
.bar small{flex-basis:100%;text-align:center;color:var(--ft);font-size:12px}
.wrap{padding:24px 16px 48px;display:flex;justify-content:center}
.sheet{width:100%;max-width:816px;min-height:1056px;background:var(--bk);padding:48px 56px 40px;display:flex;flex-direction:column;gap:26px;position:relative;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.sheet:before{content:"";position:absolute;inset:0 0 auto 0;height:6px;background:linear-gradient(90deg,var(--p) 0 60%,var(--g) 60% 100%)}
.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:22px;border-bottom:1px solid var(--ln)}
.brand{display:flex;align-items:center;gap:16px;min-width:0}
.brand img{height:64px;width:auto;display:block}
.brand .wm{font:400 34px/1 'Bebas Neue',sans-serif;letter-spacing:1px;color:var(--g)}
.brand .nm{font:400 30px/1 'Bebas Neue',sans-serif;letter-spacing:1.5px;color:var(--cr)}
.brand .tg{font:500 12px 'Oswald',sans-serif;letter-spacing:3px;text-transform:uppercase;color:var(--g);margin-top:6px}
.qt{text-align:right;flex-shrink:0}
.qt .big{font:400 54px/.9 'Bebas Neue',sans-serif;letter-spacing:2px;color:var(--g)}
.qt .m{font:500 13px/1.6 'Oswald',sans-serif;color:var(--dm);letter-spacing:.5px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.lb{font:500 11px 'Oswald',sans-serif;letter-spacing:2.5px;text-transform:uppercase;color:var(--g);margin-bottom:6px}
.v1{font:500 19px 'Oswald',sans-serif;color:var(--cr)}
.v2{font-size:13px;color:var(--dm);margin-top:2px;line-height:1.5}
.sch{display:flex;align-items:center;gap:12px;background:rgba(107,40,150,.18);border:1px solid rgba(107,40,150,.55);padding:12px 16px}
.sch .v1{font-size:17px}
.items .th{display:flex;justify-content:space-between;padding:0 4px 10px;border-bottom:2px solid var(--p);font:500 12px 'Oswald',sans-serif;letter-spacing:2.5px;text-transform:uppercase;color:var(--g)}
.li{display:flex;align-items:center;gap:14px;padding:14px 4px;border-bottom:1px solid rgba(244,241,234,.1);break-inside:avoid}
.bolt{width:26px;height:29px;flex-shrink:0}.bolt-sp{width:26px;flex-shrink:0}
.li-t{flex:1;min-width:0}.li-n{font:400 17px 'Oswald',sans-serif;color:var(--cr)}.li-s{font-size:12.5px;color:var(--dm);margin-top:2px}
.li-a{font:500 18px 'Oswald',sans-serif;color:var(--cr);white-space:nowrap;font-variant-numeric:tabular-nums}
.li.disc .li-n,.li.disc .li-a{color:var(--g)}
.empty{padding:22px 4px;color:var(--ft);font-style:italic}
.money{display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:start;break-inside:avoid}
.sums .sr{display:flex;justify-content:space-between;padding:6px 0;font:400 15px 'Oswald',sans-serif;color:var(--dm);font-variant-numeric:tabular-nums}
.sums .sr.tot{border-top:2px solid var(--g);margin-top:6px;padding-top:12px;font:400 30px/1 'Bebas Neue',sans-serif;letter-spacing:1px;color:var(--cr)}
.sums .sr.tot span:last-child{color:var(--g)}
.pay{border:1px solid rgba(203,161,53,.45);background:rgba(203,161,53,.07);padding:14px 16px}
.pay .sr{display:flex;justify-content:space-between;gap:10px;padding:5px 0;font:500 15px 'Oswald',sans-serif;color:var(--cr);font-variant-numeric:tabular-nums}
.pay .sr.due span:last-child{color:var(--g);font-size:20px}
.pay .nt{font-size:11.5px;color:var(--dm);margin-top:6px;line-height:1.5}
.notes{font-size:13px;color:var(--dm);line-height:1.6;white-space:pre-line}
.terms{font-size:11.5px;color:var(--ft);line-height:1.6}
.terms a{color:var(--g)}
.ft{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;gap:16px;padding-top:16px;border-top:1px solid var(--ln)}
.sig{font-size:12px;color:var(--dm);display:flex;gap:20px;flex-wrap:wrap}
.ct{display:flex;flex-direction:column;align-items:flex-end;gap:3px;font:400 13px 'Oswald',sans-serif;color:var(--cr)}
.ct .w{color:var(--g);letter-spacing:1px}
@media (max-width:640px){
  .sheet{padding:32px 20px 28px;min-height:0;gap:22px}
  .hd{flex-direction:column}.qt{text-align:left}
  .grid,.money{grid-template-columns:1fr}
  .brand img{height:48px}.qt .big{font-size:44px}
  .ft{flex-direction:column;align-items:flex-start}.ct{align-items:flex-start}
}
@page{size:letter;margin:0}
@media print{
  html,body{background:var(--bk);height:auto}
  .bar{display:none}.wrap{padding:0;display:block}
  .sheet{max-width:none;width:8.5in;min-height:calc(11in - 2px);box-shadow:none;padding:.42in .55in .36in;gap:16px}
  .hd{padding-bottom:14px}.li{padding:9px 4px}.brand img{height:54px}.qt .big{font-size:48px}
}
</style></head><body>
<div class="bar"><button class="pr" onclick="window.print()">Save as PDF / Print</button>${approveLink ? `<a class="q" href="${approveLink}">Approve online</a>` : ''}
<small>On a phone: tap Save as PDF, then Share → Save to Files, or send it by text or email.</small></div>
<div class="wrap"><div class="sheet">
<div class="hd"><div class="brand"><img src="${LOGO_URL}" alt="Upper Echelon Automotive" onerror="this.outerHTML='<span class=wm>UE</span>'">
<div><div class="nm">Upper Echelon Automotive</div><div class="tg">Built to Keep You Rolling</div></div></div>
<div class="qt"><div class="big">Quote</div><div class="m">#${e(qno)}<br>${e(quoteDate)}<br>Valid until ${e(validTo)}</div></div></div>

<div class="grid"><div><div class="lb">Prepared for</div><div class="v1">${e(j.customer_name || 'Customer')}</div>
<div class="v2">${[j.phone, j.email].filter(Boolean).map(e).join(' · ')}${j.address ? `<br>${e(j.address)}` : ''}</div></div>
<div><div class="lb">Vehicle</div><div class="v1">${e(j.vehicle || 'Vehicle')}</div><div class="v2">${vehBits || e(j.service || '')}</div></div></div>

${sched ? `<div class="sch"><svg class="bolt" viewBox="0 0 32 36" aria-hidden="true"><polygon points="16,1 31,9.5 31,26.5 16,35 1,26.5 1,9.5" fill="#6B2896" stroke="#CBA135" stroke-width="2"/><circle cx="16" cy="18" r="5" fill="#CBA135"/></svg><div><div class="lb" style="margin:0">Scheduled service</div><div class="v1">${e(sched)}</div></div></div>` : ''}

<div class="items"><div class="th"><span>Item</span><span>Amount</span></div>
${rows || '<div class="empty">No line items on this estimate yet.</div>'}</div>

<div class="money"><div>
${est.notes ? `<div class="lb">Notes</div><div class="notes">${e(est.notes)}</div>` : ''}
${retainer ? `<div class="pay"${est.notes ? ' style="margin-top:14px"' : ''}><div class="lb">Payment</div>
${sumRow(`Retainer due to book (${RETAINER_PCT}%, non-refundable)`, usd(retainer), 'due')}${sumRow('Balance due at completion', usd(balance))}
<div class="nt">Parts are ordered once the retainer is received.</div></div>`
  : `<div class="pay"${est.notes ? ' style="margin-top:14px"' : ''}><div class="lb">Payment</div>${sumRow('Due at completion', usd(t.total), 'due')}</div>`}
</div><div class="sums">
${t.parts ? sumRow('Parts subtotal', usd(t.parts)) : ''}
${laborFees ? sumRow(t.fees ? 'Labor &amp; fees' : 'Labor', usd(laborFees)) : ''}
${t.discount ? sumRow('Discount', '−' + usd(t.discount)) : ''}
${t.tax ? sumRow(`Tax on parts (${taxRate}%)`, usd(t.tax)) : ''}
${sumRow('Job total', usd(t.total), 'tot')}
</div></div>

<div class="terms"><div class="lb">Terms</div>Prices are good for 30 days. ${retainer ? `Jobs of ${usd(RETAINER_MIN_CENTS)} or more require a ${RETAINER_PCT}% non-refundable retainer before parts are ordered. ` : ''}Parts are non-refundable once ordered. Free rescheduling with 48+ hours' notice; late cancellations and no-shows forfeit the retainer. If we find anything else, we'll ask before doing it. Shop-supplied parts and labor carry a 90-day warranty. All work is subject to the <a href="${AGREEMENT_URL}">Upper Echelon Automotive Service Agreement</a>.</div>

<div class="ft"><div><div class="lb">Customer approval</div><div class="sig"><span>Signature ______________________</span><span>Date __________</span></div></div>
<div class="ct"><span>(251) 289-0740</span><span style="color:var(--dm)">ueaceo@ueauto.store</span><span class="w">ueauto.store</span></div></div>
</div></div></body></html>`;
}

router.get('/q/:token', h(async (req, res) => {
  const token = String(req.params.token || '');
  const j = /^[a-f0-9]{32}$/.test(token) ? (await sb(`uea_loyalty_bookings?estimate_token=eq.${token}&select=*`))[0] : null;
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-store');
  if (!j || !j.estimate) return res.status(404).send('<!DOCTYPE html><meta name="viewport" content="width=device-width"><body style="background:#000;color:#EDE8DC;font-family:system-ui;padding:2rem">This quote link is no longer valid. Call Upper Echelon Automotive at 251-289-0740.</body>');
  res.send(quotePage(j, await getConfig(), token));
}));

// Desk: get (or create) the quote link for a job without texting anyone or changing its stage.
router.post('/admin/booking/:id/quote', auth(ALL), h(async (req, res) => {
  const j = await loadJob(req, req.params.id);
  if (!j.estimate || !(j.estimate.lines || []).length) throw httpErr(400, 'Add at least one line and save the estimate first.');
  let token = j.estimate_token;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    await patchJob(j.id, { estimate_token: token });
  }
  res.json({ link: `${PUBLIC_BASE}/loyalty/q/${token}` });
}));

router.get('/e/:token', h(async (req, res) => {
  const token = String(req.params.token || '');
  const j = /^[a-f0-9]{32}$/.test(token) ? (await sb(`uea_loyalty_bookings?estimate_token=eq.${token}&select=*`))[0] : null;
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-store');
  if (!j || !j.estimate) return res.status(404).send('<!DOCTYPE html><meta name="viewport" content="width=device-width"><body style="background:#000;color:#EDE8DC;font-family:system-ui;padding:2rem">This estimate link is no longer valid. Call Upper Echelon Automotive at 251-289-0740.</body>');
  res.send(estimatePage(j, await getConfig(), token, await getInspection(j.id, false).catch(() => null)));
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
    sendSms(cfg.notify_phone, `UEA: ${name} ${approved.length ? `approved ${money(totals.approved.total)}` : 'declined the estimate'} on ${j.order_name || 'a job'} (${j.vehicle || j.service || ''}).`, { internal: true })
      .catch(e => console.error('[loyalty] owner notify failed:', e.message));
  }
  res.json({ ok: true });
}));

// ── Admin portal page markup ─────────────────────────────────────────────────
const ADMIN_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<meta name=\"theme-color\" content=\"#0B0A10\">\n<title>UEA Service Desk</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&display=swap\" rel=\"stylesheet\">\n<style>\n/* ═══════════════════════════════════════════════════════════════════════\n   UEA SERVICE DESK — matches ueauto.store\n   Purple-tinted dark surfaces, gold is the only accent, Archivo throughout.\n   Buttons are chamfered, containers 12px, controls 6px. Hex = brand marker.\n   ═══════════════════════════════════════════════════════════════════════ */\n:root{\n  /* Surfaces (same as the website) */\n  --black:#0B0A10; --iron:#120E1B; --steel:#1A1428; --raised-2:#241C38;\n  --edge:rgba(226,214,255,.10); --edge-strong:rgba(226,214,255,.18);\n  /* Brand */\n  --gold:#CBA135; --gold-hi:#D8B24D; --gold-lo:#B48E2C; --gold-soft:rgba(203,161,53,.12);\n  --purple:#6B2896; --purple-hi:#8A3FBF; --purple-soft:rgba(107,40,150,.22);\n  /* Text */\n  --text:#F3EFE8; --dim:rgba(243,239,232,.66); --faint:rgba(243,239,232,.5);\n  /* State (kept apart from the gold accent) */\n  --good:#5FBF7A; --bad:#F07A73; --warn:#E8A33C;\n  /* Type: one family, different widths */\n  --display:'Archivo','Arial',sans-serif;\n  --head:'Archivo','Arial',sans-serif;\n  --body:'Archivo',system-ui,-apple-system,'Segoe UI',sans-serif;\n  --ease:cubic-bezier(.23,1,.32,1);\n  --chamfer:polygon(0 0,calc(100% - 9px) 0,100% 9px,100% 100%,0 100%);\n  --hex:polygon(25% 3%,75% 3%,100% 50%,75% 97%,25% 97%,0 50%);\n  color-scheme:dark;\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;background:var(--black);color:var(--text);font:15px/1.55 var(--body);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}\nbody{padding-bottom:env(safe-area-inset-bottom)}\nbutton,input,select,textarea{font:inherit;color:inherit}\nbutton{-webkit-tap-highlight-color:transparent;touch-action:manipulation}\n:focus-visible{outline:2px solid var(--gold);outline-offset:2px}\na{color:var(--gold)}\n.hide{display:none!important}\n.steel{background:var(--steel);border:1px solid var(--edge);border-radius:12px}\n\n/* Buttons */\n.btn{appearance:none;border:0;border-radius:2px;clip-path:var(--chamfer);padding:.6rem 1.15rem;min-height:40px;cursor:pointer;text-decoration:none;\n  display:inline-flex;align-items:center;justify-content:center;gap:.4rem;font-family:var(--head);font-weight:650;font-size:.92rem;line-height:1.2;\n  background:var(--gold);color:#0B0A10;transition:background-color .15s ease,transform .12s var(--ease),opacity .15s ease}\n.btn:active:not(:disabled){transform:scale(.97);background:var(--gold-lo)}\n.btn:disabled{opacity:.45;cursor:default}\n.btn.ghost{background:var(--raised-2);color:var(--text)}\n.btn.ghost:active:not(:disabled){background:var(--steel)}\n.btn.purple{background:var(--purple);color:#fff}\n.btn.danger{background:rgba(240,122,115,.12);color:var(--bad)}\n.btn.sm{padding:.36rem .7rem;min-height:32px;font-size:.84rem}\n\n/* Forms (16px so iPhones don't zoom) */\ninput,select,textarea{background:var(--black);border:1px solid var(--edge-strong);border-radius:6px;padding:.6rem .75rem;width:100%;font-size:16px;\n  transition:border-color .15s ease,box-shadow .15s ease}\ninput::placeholder,textarea::placeholder{color:var(--faint)}\ninput:focus,select:focus,textarea:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(203,161,53,.14);outline:none}\ninput[type=checkbox]{width:auto;accent-color:#CBA135}\nlabel{display:block;font-family:var(--head);font-stretch:85%;font-size:.76rem;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0 0 .35rem}\n.field{margin-bottom:1rem}\n.help{font-size:.82rem;color:var(--dim);margin-top:.3rem}\n.dim{color:var(--dim)}\n.row{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}\n.grid{display:grid;gap:.8rem}\n.g2{grid-template-columns:repeat(2,minmax(0,1fr))}\n.g3{grid-template-columns:repeat(3,minmax(0,1fr))}\n.g4{grid-template-columns:repeat(4,minmax(0,1fr))}\n.g5{grid-template-columns:repeat(5,minmax(0,1fr))}\n\n/* Type */\nh2{font-family:var(--display);font-stretch:118%;font-weight:750;font-size:clamp(1.6rem,3vw,2.1rem);letter-spacing:-.02em;margin:0 0 1.2rem;line-height:1.05;text-wrap:balance}\nh3{font-family:var(--head);font-weight:650;font-size:1.05rem;letter-spacing:-.01em;margin:0 0 .75rem}\n.panel{padding:1.1rem 1.2rem}\n.empty{padding:2.2rem 1rem;text-align:center;color:var(--dim)}\n.err-text{color:var(--bad);font-size:.9rem;margin-top:.5rem}\n.pts{font-family:var(--head);font-weight:650;white-space:nowrap;font-variant-numeric:tabular-nums}\n.plus{color:var(--good)} .minus{color:var(--bad)}\n\n/* Tables */\ntable{width:100%;border-collapse:collapse}\nth{text-align:left;font-family:var(--head);font-stretch:85%;font-weight:650;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);padding:.55rem .6rem;border-bottom:1px solid var(--edge)}\ntd{padding:.65rem .6rem;border-bottom:1px solid var(--edge);vertical-align:top;font-variant-numeric:tabular-nums}\ntr.click{cursor:pointer}\n.scroll{overflow-x:auto}\n\n/* Chips */\n.chip{display:inline-flex;align-items:center;font-family:var(--head);font-size:.74rem;font-weight:600;padding:.08rem .5rem;border-radius:6px;background:var(--raised-2);color:var(--dim);white-space:nowrap;line-height:1.5}\n.chip.gold,.chip.active{background:var(--gold-soft);color:var(--gold)}\n.chip.purple,.chip.applied{background:var(--purple-soft);color:#D6B4F0}\n.chip.good,.chip.used{background:rgba(95,191,122,.13);color:var(--good)}\n.chip.bad,.chip.void{background:rgba(240,122,115,.13);color:var(--bad)}\n.chip.warn{background:rgba(232,163,60,.13);color:var(--warn)}\n\n/* Brand mark: logo, with a gold hex as the fallback */\n.mark{display:flex;align-items:center;gap:.8rem;margin-bottom:1.6rem}\n.mark img{height:38px;width:auto;display:block}\n.mark .bolt{display:none}\n.mark img.broken{display:none}\n.mark img.broken + .bolt{display:grid}\n.bolt{width:40px;height:40px;flex:none;clip-path:var(--hex);background:var(--gold);place-items:center}\n.bolt::after{content:'';width:42%;height:42%;clip-path:var(--hex);background:var(--black)}\n.mark h1{font-family:var(--display);font-stretch:118%;font-weight:750;font-size:1.3rem;letter-spacing:-.01em;margin:0;line-height:1}\n.mark small{display:block;color:var(--gold);font-family:var(--head);font-stretch:80%;font-size:.72rem;font-weight:650;letter-spacing:.14em;text-transform:uppercase;margin-top:.25rem}\n\n/* Login */\n#login{min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:1.5rem;\n  background:radial-gradient(80% 60% at 100% 0%,rgba(107,40,150,.28),transparent 60%),var(--black)}\n#login form{width:100%;max-width:400px;padding:2rem 1.8rem}\n#login .btn{width:100%;min-height:48px;font-size:1rem}\n.keep{display:flex;gap:.55rem;align-items:center;font-size:.88rem;color:var(--dim);margin:-.2rem 0 1.1rem;text-transform:none;letter-spacing:0;font-weight:400}\n.keep input{width:18px;height:18px}\n\n/* Shell */\n#app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}\nnav{border-right:1px solid var(--edge);padding:1.2rem .75rem;background:var(--iron);position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column}\nnav .mark{margin:0 .45rem 1.4rem}\nnav .grp{font-family:var(--head);font-stretch:80%;font-size:.7rem;font-weight:650;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:1rem .8rem .35rem}\nnav button.tab{position:relative;display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;background:none;border:0;border-radius:6px;\n  padding:.55rem .8rem;margin-bottom:.1rem;cursor:pointer;font-family:var(--head);font-size:.95rem;font-weight:500;color:var(--dim);transition:color .15s ease,background-color .15s ease}\nnav button.tab.on{color:var(--text);background:var(--raised-2)}\nnav button.tab.on::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:2px;background:var(--gold)}\n.count{background:var(--gold);color:#0B0A10;border-radius:999px;font-size:.72rem;font-weight:700;padding:0 .45rem;font-family:var(--body);font-variant-numeric:tabular-nums}\nnav .who{margin-top:auto;padding:.9rem .8rem 0;font-size:.85rem;color:var(--dim);border-top:1px solid var(--edge)}\nmain{padding:1.8rem 2rem 5rem;min-width:0}\n\n/* Jobs board */\n.board{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(240px,1fr);gap:.75rem;overflow-x:auto;padding-bottom:.6rem}\n.col{background:var(--iron);border:1px solid var(--edge);border-radius:12px;padding:.6rem;min-height:120px}\n.col h4{font-family:var(--head);font-stretch:85%;font-weight:650;font-size:.74rem;letter-spacing:.1em;text-transform:uppercase;margin:.2rem .3rem .65rem;display:flex;justify-content:space-between;color:var(--faint)}\n.col h4 b{color:var(--text);font-weight:650;font-variant-numeric:tabular-nums}\n.card{display:block;width:100%;text-align:left;background:var(--steel);border:1px solid var(--edge);border-radius:8px;padding:.7rem .75rem;margin-bottom:.5rem;cursor:pointer;color:var(--text);\n  transition:border-color .15s ease,transform .12s var(--ease)}\n.card:active{transform:scale(.985)}\n.selbar{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center;position:sticky;top:0;z-index:5;background:var(--raised);border:1px solid var(--gold);border-radius:8px;padding:.55rem .7rem;margin-bottom:.8rem}\n.selbar #selN{font-weight:650;color:var(--gold);font-variant-numeric:tabular-nums}\n.card.picked{border-color:var(--gold);box-shadow:inset 0 0 0 1px var(--gold);background:var(--gold-soft)}\n.card.picked .t::before{content:'\\2713  ';color:var(--gold)}\ntr.mpicked td{background:var(--gold-soft)}\n.convo{display:flex;gap:.7rem;align-items:center;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--edge);padding:.8rem .4rem;color:var(--text);cursor:pointer;font:inherit}\n.convo:hover{background:var(--raised-2)}\n.convo .av{flex:0 0 38px;height:38px;border-radius:50%;background:var(--purple-soft);color:#D6B4F0;display:flex;align-items:center;justify-content:center;font-family:var(--head);font-weight:700}\n.convo .mid{flex:1;min-width:0}.convo .mid b{display:block}.convo .mid span{display:block;color:var(--dim);font-size:.86rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.convo.unread .mid b,.convo.unread .mid span{color:var(--text);font-weight:650}\n.convo .ub{background:var(--gold);color:#0B0A10;border-radius:999px;font-size:.75rem;font-weight:700;padding:.05rem .45rem}\n#thread{display:flex;flex-direction:column;gap:.45rem;max-height:56vh;overflow-y:auto;padding:.4rem .2rem 1rem}\n.bub{max-width:82%;padding:.55rem .75rem;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;font-size:.95rem;line-height:1.4}\n.bub.in{align-self:flex-start;background:var(--raised-2);border-bottom-left-radius:4px}\n.bub.out{align-self:flex-end;background:var(--purple);color:#fff;border-bottom-right-radius:4px}\n.bub small{display:block;font-size:.72rem;opacity:.7;margin-top:.2rem}\n.tday{align-self:center;font-size:.75rem;color:var(--dim);margin:.4rem 0}\n.composer{display:flex;gap:.5rem;align-items:flex-end;position:sticky;bottom:0;background:var(--iron);padding:.6rem 0}\n.composer textarea{flex:1;min-height:44px;max-height:160px;resize:vertical}\n\n#mselBar [data-bulk]:disabled,#mClear:disabled{opacity:.45}\n.card .t{font-family:var(--head);font-weight:650;font-size:.96rem;line-height:1.25}\n.card .s{font-size:.83rem;color:var(--dim);margin-top:.2rem;line-height:1.4}\n.card .f{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.5rem}\n\n/* Today */\n.day{display:grid;gap:.75rem}\n.stop{display:grid;grid-template-columns:118px minmax(0,1fr) auto;gap:1rem;align-items:start;padding:1rem 1.1rem}\n.stop .when{font-family:var(--display);font-stretch:118%;font-weight:750;font-size:1.25rem;line-height:1.05;color:var(--gold);font-variant-numeric:tabular-nums}\n.stop .when small{display:block;font-family:var(--body);font-stretch:100%;font-weight:400;font-size:.78rem;color:var(--dim);margin-top:.2rem}\n.stop .who{font-family:var(--head);font-weight:650;font-size:1.05rem}\n.stop .acts{display:flex;flex-direction:column;gap:.4rem;min-width:124px}\n\n/* Job drawer */\n#drawer{position:fixed;inset:0;background:rgba(6,4,10,.72);display:flex;justify-content:flex-end;z-index:20}\n#drawer .sheet{width:min(800px,100%);height:100%;overflow-y:auto;background:var(--iron);border-left:1px solid var(--edge-strong);padding:1.3rem 1.5rem 4rem;overscroll-behavior:contain}\n.dtabs{display:flex;gap:.2rem;border-bottom:1px solid var(--edge);margin:1rem 0;position:sticky;top:-1.3rem;background:var(--iron);z-index:2;padding-top:.4rem;overflow-x:auto}\n.dtabs button{background:none;border:0;border-bottom:2px solid transparent;padding:.55rem .85rem;font-family:var(--head);font-weight:600;font-size:.92rem;color:var(--dim);cursor:pointer;white-space:nowrap;transition:color .15s ease}\n.dtabs button.on{color:var(--text);border-bottom-color:var(--gold)}\n.kv{display:grid;grid-template-columns:132px minmax(0,1fr);gap:.4rem .9rem;font-size:.93rem}\n.kv dt{color:var(--dim)} .kv dd{margin:0;overflow-wrap:anywhere}\n.sec{margin-bottom:1.1rem}\n\n/* Estimates */\n.est td{padding:.4rem .3rem;border-bottom:1px solid var(--edge)}\n.est input,.est select{padding:.42rem .5rem;font-size:16px}\n.est .amt{font-family:var(--head);font-weight:650;text-align:right;white-space:nowrap;padding-top:.65rem}\n.totals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}\n.totals table td{border:0;padding:.2rem .2rem}\n.totals .big td{font-family:var(--head);font-weight:700;font-size:1.1rem;color:var(--gold);border-top:1px solid var(--edge);padding-top:.45rem}\n.ev{display:grid;grid-template-columns:118px minmax(0,1fr);gap:.6rem;padding:.55rem 0;border-bottom:1px solid var(--edge);font-size:.9rem}\n.ev .k{font-family:var(--head);font-stretch:85%;font-weight:650;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}\n\n/* Loyalty tier */\n.tierline{display:flex;align-items:center;gap:1rem;margin:1rem 0}\n.tierline .bolt{width:60px;height:60px;display:grid}\n.tierline .bolt::after{display:none}\n.tierline .bolt b{font-family:var(--display);font-weight:750;color:#0B0A10;font-size:.95rem}\n.bar{height:6px;background:var(--black);border:1px solid var(--edge);border-radius:999px;overflow:hidden}\n.bar i{display:block;height:100%;background:var(--gold)}\n\n/* Overview numbers */\n.gauges{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--edge);border-radius:12px;overflow:hidden;margin-bottom:1rem;background:var(--iron)}\n.gauge{padding:1.15rem 1.25rem}\n.gauge + .gauge{border-left:1px solid var(--edge)}\n.gauge b{display:block;font-family:var(--display);font-stretch:118%;font-weight:750;font-size:2rem;line-height:1.05;color:var(--gold);font-variant-numeric:tabular-nums}\n.gauge span{font-family:var(--head);color:var(--dim);font-size:.88rem}\n.gauge em{display:block;font-style:normal;font-size:.8rem;color:var(--faint);margin-top:.3rem}\n.settings table input{padding:.4rem .5rem}\n\n/* Labor guide picker */\n.gres{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem;align-items:start;padding:.85rem .25rem;border-bottom:1px solid var(--edge)}\n.gres:last-child{border-bottom:0}\n.gres h4{margin:0;font-family:var(--head);font-weight:650;font-size:.98rem}\n.gres .meta{font-size:.83rem;color:var(--dim);margin-top:.2rem}\n.gres .price{font-family:var(--head);font-weight:700;color:var(--gold);white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}\n.gacts{display:flex;flex-direction:column;align-items:flex-end;gap:.35rem}\n.gpick{border:1px solid var(--edge-strong);border-radius:12px;padding:.9rem;margin:.7rem 0;background:var(--black)}\n.gpick .list{max-height:440px;overflow-y:auto;margin-top:.55rem}\n.plinks{white-space:normal}\n.plinks a{font-weight:600;text-decoration:none;border-bottom:1px solid rgba(203,161,53,.35)}\n.btbox{margin-top:.6rem;padding:.7rem .8rem;border-radius:8px;background:var(--steel);border:1px solid var(--edge)}\n.bthead{font-size:.85rem;color:var(--dim);margin-bottom:.4rem}\n.bthead b{color:var(--text)}\n.btrow{display:flex;justify-content:space-between;gap:.75rem;align-items:center;padding:.5rem 0;border-top:1px solid var(--edge)}\n.btrow b{color:var(--gold);font-variant-numeric:tabular-nums}\n.parts-ed td{padding:.3rem .2rem;border:0}\n.parts-ed input{padding:.4rem .5rem}\n\n/* Price check, inspections, clock, vehicles */\n.supgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:.4rem}\n.supgrid .btn{width:100%}\n.insrow{display:grid;grid-template-columns:minmax(150px,1.1fr) auto minmax(160px,1.4fr);gap:.6rem .8rem;align-items:center;padding:.7rem 0;border-bottom:1px solid var(--edge)}\n.insrow:last-child{border-bottom:0}\n.insname{font-weight:600}\n.insph{grid-column:1/-1;display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}\n.insph:empty{display:none}\n.seg{display:inline-flex;border:1px solid var(--edge-strong);border-radius:8px;overflow:hidden}\n.seg button{background:none;border:0;border-right:1px solid var(--edge);color:var(--dim);font:inherit;font-size:.82rem;font-weight:600;padding:.45rem .65rem;min-height:38px;cursor:pointer}\n.seg button:last-child{border-right:0}\n.seg button.on.good{background:rgba(95,191,122,.18);color:var(--good)}\n.seg button.on.watch{background:rgba(232,163,60,.18);color:var(--warn)}\n.seg button.on.bad{background:rgba(240,122,115,.18);color:var(--bad)}\n.seg button.on.na{background:var(--raised-2);color:var(--text)}\n.insnote{min-height:38px;padding:.45rem .6rem}\n.ph{position:relative;display:inline-block}\n.ph img{width:84px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--edge);display:block}\n.ph button{position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;border:0;background:var(--bad);color:#0B0A10;font-weight:800;cursor:pointer;line-height:1}\n.addph{cursor:pointer}\n.clock{display:flex;gap:.7rem;align-items:center;flex-wrap:wrap;margin-top:.8rem;padding:.55rem .7rem;border:1px solid var(--edge);border-radius:8px;background:var(--steel)}\n.cnote{margin-top:.6rem;padding:.55rem .7rem;border-left:3px solid var(--gold);background:var(--gold-soft);border-radius:6px;font-size:.9rem}\n.veh{padding:.75rem 0;border-bottom:1px solid var(--edge)}\n.veh:last-child{border-bottom:0}\n@media (max-width:900px){.insrow{grid-template-columns:1fr}.seg{width:100%}.seg button{flex:1}}\n\n/* ── Calendar ── */\n.calhead{display:flex;justify-content:space-between;align-items:center;gap:.8rem;flex-wrap:wrap;margin-bottom:1rem}\n.calbar{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.8rem}\n.caltitle{flex:1;font-family:var(--display);font-stretch:110%;font-weight:700;font-size:1.25rem;letter-spacing:-.01em;min-width:9rem}\n.calmode button{min-height:36px;padding:.35rem .8rem}\n#calGrid{padding:0;overflow:hidden;border-radius:12px}\n.cgrid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}\n.cdow{font-family:var(--head);font-stretch:85%;font-size:.7rem;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);padding:.55rem .5rem;border-bottom:1px solid var(--edge)}\n.cday{min-height:112px;padding:.35rem .35rem .45rem;border-right:1px solid var(--edge);border-bottom:1px solid var(--edge);cursor:pointer;min-width:0;transition:background-color .15s ease}\n.cday:nth-child(7n+7){border-right:0}\n.cgrid.week .cday{min-height:300px}\n.cday.out{background:rgba(0,0,0,.18)}.cday.out .cnum{color:var(--faint)}\n.cday.sel{background:var(--raised-2)}\n.cnum{font-variant-numeric:tabular-nums;font-weight:600;font-size:.85rem;color:var(--dim);width:26px;height:26px;display:grid;place-items:center;border-radius:50%;margin-bottom:.2rem}\n.cday.today .cnum{background:var(--gold);color:#0B0A10}\n.cev{display:block;width:100%;text-align:left;border:0;border-left:3px solid var(--purple,#6B2896);background:rgba(107,40,150,.22);color:var(--text);font:inherit;font-size:.74rem;line-height:1.25;\n  padding:.2rem .35rem;border-radius:4px;margin-bottom:.18rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}\n.cev span{color:var(--dim);font-variant-numeric:tabular-nums}\n.cev.live{border-left-color:var(--gold);background:var(--gold-soft)}\n.cev.rush{border-left-color:var(--bad);background:rgba(240,122,115,.14)}\n.cev.done{border-left-color:var(--good);background:rgba(95,191,122,.1);color:var(--dim)}\n.cmore{font-size:.72rem;color:var(--faint);padding-left:.3rem}\n.cdots{display:flex;gap:3px;justify-content:center;align-items:center;margin-top:.15rem}\n.cdots i{width:6px;height:6px;border-radius:50%;background:var(--gold)}\n.cdots b{font-size:.7rem;color:var(--gold);line-height:1}\n.dayhead{display:flex;justify-content:space-between;align-items:baseline;gap:.6rem;flex-wrap:wrap;margin:1.2rem 0 .6rem}\n.dayhead h3{margin:0}\n.cjob{display:grid !important;grid-template-columns:74px minmax(0,1fr);gap:.8rem;align-items:start}\n.ctime{font-family:var(--head);font-weight:700;color:var(--gold);font-variant-numeric:tabular-nums;font-size:.95rem;line-height:1.2}\n.ctime small{display:block;color:var(--faint);font-weight:500;font-size:.75rem;margin-top:.15rem}\n.unsched{display:block;width:100%;text-align:left;cursor:pointer;color:var(--text);font:inherit;border-top:0;border-right:0;border-bottom:0;margin:0 0 .8rem}\n@media (hover:hover) and (pointer:fine){ .cday:hover{background:var(--raised)} .cev:hover{filter:brightness(1.2)} }\n\n/* ── Phone layout ── */\n#bnav,#more{display:none}\n.jhead{display:flex;flex-direction:row-reverse;justify-content:space-between;align-items:flex-start;gap:.8rem}\n.schips{display:flex;gap:.4rem;overflow-x:auto;margin:0 -1rem .9rem;padding:0 1rem .2rem;scrollbar-width:none}\n.schips::-webkit-scrollbar{display:none}\n.schip{flex:none;min-height:38px;padding:.4rem .8rem;border-radius:999px;border:1px solid var(--edge-strong);background:var(--steel);color:var(--dim);font:inherit;font-weight:600;font-size:.88rem;cursor:pointer}\n.schip b{color:var(--faint);font-weight:650;margin-left:.15rem;font-variant-numeric:tabular-nums}\n.schip.on{background:var(--gold);border-color:var(--gold);color:#0B0A10}.schip.on b{color:#0B0A10}\n.lhead{font-family:var(--head);font-stretch:85%;font-weight:650;font-size:.74rem;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin:1rem .2rem .5rem;display:flex;justify-content:space-between}\n@media (max-width:900px){\n  nav#nav{display:none}\n  #app{display:block;padding-bottom:calc(64px + env(safe-area-inset-bottom))}\n  main{padding:calc(1rem + env(safe-area-inset-top)) 1rem 2rem}\n  h2{font-size:1.55rem;margin-bottom:.9rem}\n  #bnav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:15;background:rgba(18,14,27,.96);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);\n    border-top:1px solid var(--edge-strong);padding:0 .25rem env(safe-area-inset-bottom)}\n  #bnav .bt{flex:1;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.15rem;min-height:60px;background:none;border:0;color:var(--faint);\n    font:inherit;font-size:.7rem;font-weight:600;letter-spacing:.01em;cursor:pointer;-webkit-tap-highlight-color:transparent}\n  #bnav .bt.on{color:var(--gold)}\n  #bnav .bt:active{transform:scale(.94)}\n  #bnav .bt.plus svg{background:var(--gold);color:#0B0A10;border-radius:10px;padding:5px;width:32px;height:32px;margin-top:-2px}\n  #bnav .bt.plus.on{color:var(--text)}\n  .bc{position:absolute;top:6px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--gold);color:#0B0A10;font-style:normal;font-size:.68rem;font-weight:750;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}\n  #more:not(.hide){display:flex;position:fixed;inset:0;z-index:30;background:rgba(6,4,10,.6);align-items:flex-end}\n  .msheet{width:100%;max-height:82vh;overflow-y:auto;background:var(--iron);border-top:1px solid var(--edge-strong);border-radius:16px 16px 0 0;padding:.5rem .9rem calc(1rem + env(safe-area-inset-bottom));animation:up .22s cubic-bezier(.23,1,.32,1)}\n  @keyframes up{from{transform:translateY(24px);opacity:.6}to{transform:none;opacity:1}}\n  .mgrab{width:40px;height:4px;border-radius:2px;background:var(--edge-strong);margin:.2rem auto .7rem}\n  .mwho{font-size:.85rem;color:var(--dim);padding:0 .2rem .4rem}\n  .msheet .grp{font-family:var(--head);font-stretch:80%;font-size:.7rem;font-weight:650;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:.9rem .2rem .3rem}\n  .mi{position:relative;display:flex;align-items:center;width:100%;min-height:50px;padding:0 .3rem;background:none;border:0;border-bottom:1px solid var(--edge);color:var(--text);font:inherit;font-size:1rem;text-align:left;cursor:pointer}\n  .mi span{flex:1}.mi b{color:var(--faint);font-size:1.3rem;font-weight:400}\n  .mi .bc{position:static;margin-right:.6rem}\n  /* bigger tap targets */\n  .btn{min-height:46px}\n  .btn.sm{min-height:40px;padding-left:.8rem;padding-right:.8rem}\n  select,input{min-height:46px}\n  /* jobs */\n  #jlist .card{padding:.85rem .9rem;margin-bottom:.55rem}\n  .selbar{position:fixed;left:.5rem;right:.5rem;top:auto;background:#1A1428;bottom:calc(68px + env(safe-area-inset-bottom));z-index:14;box-shadow:0 10px 30px rgba(0,0,0,.5);gap:.35rem}\n  .selbar #selN{width:100%}\n  #view:has(.selbar) #jlist,#view:has(.selbar) #mmore{padding-bottom:150px}\n  .cday{min-height:52px;padding:.25rem .1rem;display:flex;flex-direction:column;align-items:center}\n  .cgrid.week .cday{min-height:64px}\n  .cdow{text-align:center;padding:.45rem 0;font-size:.64rem;letter-spacing:.04em}\n  .cnum{margin-bottom:.05rem}\n  .calbar .caltitle{order:-1;flex-basis:100%;font-size:1.15rem}\n  .calbar > .row{flex:0 0 auto}\n  .calbar .calmode{margin-left:auto;width:auto}\n  .calhead #calTech{max-width:46vw}\n  .selbar > span[style]{display:none}\n  .selbar #selFinish,.selbar #selCancel{flex:1}\n  /* job sheet */\n  #drawer .sheet{border-left:0;padding-bottom:calc(2rem + env(safe-area-inset-bottom))}\n  .jhead{flex-direction:column;gap:.5rem}\n  .jhead .back{order:-1;align-self:flex-start;margin-left:-.6rem;background:none;color:var(--gold);padding:0 .6rem;font-size:1rem;min-height:44px}\n  .jacts{display:grid !important;grid-template-columns:repeat(3,minmax(0,1fr))}\n  .jacts #stageSel{grid-column:1/-1;width:100% !important}\n  .jacts .btn{width:100%}\n  .dtabs{top:calc(-1.1rem - env(safe-area-inset-top));margin-left:-1rem;margin-right:-1rem;padding-left:.5rem;padding-right:.5rem;scrollbar-width:none}\n  .dtabs::-webkit-scrollbar{display:none}\n  .dtabs button{padding:.7rem .75rem;min-height:46px}\n  /* estimate lines become cards */\n  table.est,table.est tbody{display:block}\n  table.est tr:first-child:has(th){display:none}\n  table.est tr{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.45rem .5rem;padding:.8rem 0;border-bottom:1px solid var(--edge);align-items:end}\n  table.est td{display:block;padding:0;border:0}\n  table.est td:nth-child(2){grid-column:1/-1;grid-row:1}\n  table.est td:nth-child(1){grid-row:2}\n  table.est td:nth-child(3){grid-row:2}\n  table.est td:nth-child(4){grid-row:2}\n  table.est td:nth-child(6){grid-row:3;grid-column:1/3}\n  table.est td:nth-child(5){grid-row:3;grid-column:3;text-align:right;padding-bottom:.7rem;font-size:1.05rem}\n  table.est td:nth-child(7){grid-row:1;grid-column:3;justify-self:end;align-self:start}\n  table.est tr:has(td:nth-child(7) .btn) td:nth-child(2){grid-column:1/3}\n  table.est td:nth-child(3)::before{content:'Qty / hrs'}\n  table.est td:nth-child(4)::before{content:'Price each'}\n  table.est td:nth-child(3)::before,table.est td:nth-child(4)::before{display:block;font-family:var(--head);font-stretch:85%;font-size:.68rem;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-bottom:.25rem}\n  table.est td[colspan],table.est tr td:only-child{grid-column:1/-1}\n  table.est .row[style*=\"nowrap\"] input{max-width:none !important;flex:1}\n  /* other tables become stacked rows */\n  .scroll > table:not(.est),.scroll > table:not(.est) tbody{display:block}\n  .scroll > table:not(.est) tr:first-child:has(th){display:none}\n  .scroll > table:not(.est) tr{display:flex;flex-wrap:wrap;gap:.25rem .9rem;padding:.8rem .9rem;border-bottom:1px solid var(--edge)}\n  .scroll > table:not(.est) td{display:block;padding:0;border:0;flex:0 1 auto;min-width:0}\n  .scroll > table:not(.est) td:first-child{flex-basis:100%;font-weight:600}\n  .scroll > table:not(.est) td:last-child:has(.btn){flex-basis:100%;display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.35rem}\n  .scroll > table:not(.est) td:empty{display:none}\n  #sheet a{overflow-wrap:anywhere}\n  #toast,.toast{bottom:calc(76px + env(safe-area-inset-bottom)) !important}\n}\n\n/* Toast */\n#toast{position:fixed;left:50%;bottom:calc(1.5rem + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--raised-2);border:1px solid var(--edge-strong);\n  border-left:3px solid var(--gold);padding:.75rem 1.15rem;border-radius:8px;z-index:40;font-family:var(--head);font-weight:600;max-width:92vw;box-shadow:0 18px 40px -20px rgba(0,0,0,.8)}\n#toast.err{border-left-color:var(--bad)}\n\n/* Hover only where there is a mouse */\n@media (hover:hover) and (pointer:fine){\n  .btn:hover:not(:disabled){background:var(--gold-hi)}\n  .btn.ghost:hover:not(:disabled){background:#2E2448}\n  .btn.purple:hover:not(:disabled){background:var(--purple-hi)}\n  .btn.danger:hover:not(:disabled){background:rgba(240,122,115,.2)}\n  nav button.tab:hover{color:var(--text);background:rgba(36,28,56,.6)}\n  tr.click:hover td{background:rgba(36,28,56,.45)}\n  .card:hover{border-color:rgba(203,161,53,.45)}\n  .dtabs button:hover{color:var(--text)}\n}\n\n/* Text generator + promotions */\n.tgroup{margin-bottom:.55rem}\n.tgroup>span{display:block;color:var(--dim);font-size:.74rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:.3rem}\n.tgroup .row{gap:.35rem}\n.btn.sm.picked{border-color:var(--gold);color:var(--gold)}\n.gens{display:grid;gap:.5rem}\n.gen{display:block;width:100%;text-align:left;background:var(--raised-2);border:1px solid var(--edge);border-radius:10px;padding:.7rem .85rem;color:var(--text);font:inherit;font-size:.93rem;line-height:1.45;cursor:pointer}\n.gen.on{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset}\n.gen small{display:block;color:var(--gold);font-family:var(--head);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:.25rem}\n.phone-prev{background:var(--black);border:1px solid var(--edge-strong);border-radius:16px;padding:1rem}\n.bubble{background:var(--raised-2);border-radius:14px 14px 14px 4px;padding:.65rem .8rem;white-space:pre-wrap;font-size:.93rem;line-height:1.45;max-width:100%}\n.wlist{max-height:220px;overflow:auto;font-size:.88rem;color:var(--dim);margin-top:.4rem}\n/* Overview + Books */\n.ovh{margin:1.3rem 0 .6rem;color:var(--dim);font-size:.82rem;letter-spacing:.1em;text-transform:uppercase}\n.ownstrip{border-color:rgba(107,40,150,.45)}\n.gauge b.neg,.neg{color:var(--bad)}\n.stagebars{display:grid;gap:.35rem}\n.sbar{display:grid;grid-template-columns:minmax(0,9.5rem) minmax(0,1fr) auto;gap:.6rem;align-items:center;background:none;border:0;padding:.2rem 0;color:var(--text);font:inherit;font-size:.9rem;text-align:left}\nbutton.sbar{cursor:pointer}\n.sbar span{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.sbar i{display:block;height:10px;border-radius:5px;background:var(--raised-2);overflow:hidden}\n.sbar i em{display:block;height:100%;background:var(--gold);border-radius:5px}\n.sbar i em.pu{background:var(--purple-hi)}\n.sbar b{font-family:var(--head);font-variant-numeric:tabular-nums;white-space:nowrap}\n.bkbar{margin-bottom:.9rem}\n.subtabs{display:flex;gap:.25rem;overflow-x:auto;border-bottom:1px solid var(--edge);margin-bottom:1rem;scrollbar-width:none}\n.subtabs button{background:none;border:0;border-bottom:2px solid transparent;color:var(--dim);font-family:var(--head);font-size:.92rem;font-weight:600;padding:.6rem .8rem;cursor:pointer;white-space:nowrap;min-height:42px}\n.subtabs button.on{color:var(--text);border-bottom-color:var(--gold)}\ntable.pl td{padding:.38rem .2rem;border-bottom:1px solid var(--edge);font-size:.93rem}\ntable.pl tr.hd td{padding-top:.9rem;border-bottom:0;color:var(--gold);font-family:var(--head);font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}\ntable.pl tr.tot td{font-weight:650}\ntable.pl tr.net td{font-family:var(--display);font-size:1.25rem;font-weight:750;border-bottom:0;padding-top:.8rem}\n.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}\n.warnbox{border-color:rgba(232,163,60,.4);color:var(--warn)}\n.legend{gap:.9rem;font-size:.82rem;color:var(--dim)}\n.lg{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:.35rem;vertical-align:-1px}\n.lg.go,.tbars i.go{background:var(--gold)} .lg.pu,.tbars i.pu{background:var(--purple-hi)}\n.trend{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:.35rem;margin-top:1rem;align-items:end}\n.tcol{display:flex;flex-direction:column;align-items:center;gap:.25rem;min-width:0}\n.tbars{height:140px;width:100%;display:flex;align-items:flex-end;justify-content:center;gap:2px}\n.tbars i{display:block;width:42%;max-width:16px;border-radius:3px 3px 0 0;min-height:1px}\n.tcol small{font-size:.68rem;font-variant-numeric:tabular-nums;color:var(--dim);white-space:nowrap}\n.tcol span{font-size:.74rem;color:var(--dim)}\n.llist{overflow:hidden}\n.lrow{display:grid;grid-template-columns:4.2rem minmax(0,1fr) auto auto;gap:.7rem;align-items:center;width:100%;background:none;border:0;border-bottom:1px solid var(--edge);padding:.75rem 1rem;color:var(--text);font:inherit;text-align:left}\nbutton.lrow{cursor:pointer}\nbutton.lrow:active{background:var(--raised-2)}\n.lrow:last-child{border-bottom:0}\n.lrow .ld{color:var(--dim);font-size:.85rem}\n.lrow .lm{min-width:0}\n.lrow .lm b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.lrow .lm small{display:block;color:var(--dim);font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.lrow .lt{display:flex;gap:.3rem}\n.lrow .la{font-family:var(--head);font-weight:650;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}\ntable.jt td,table.jt th{padding:.5rem .45rem;border-bottom:1px solid var(--edge);font-size:.9rem;vertical-align:top}\ntable.jt th{color:var(--dim);font-weight:600;font-size:.78rem;text-align:left}\ntable.jt th.num{text-align:right}\ntr.click{cursor:pointer} tr.click:active{background:var(--raised-2)}\n.kindseg{display:flex;width:100%} .kindseg button{flex:1;min-height:42px;font-size:.92rem}\n.seg button.on{background:var(--gold-soft);color:var(--gold)}\n.rimg{display:block;max-width:100%;max-height:320px;border-radius:8px;margin-top:.5rem;border:1px solid var(--edge)}\n.catrow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,13rem) auto auto;gap:.5rem;align-items:center;margin-bottom:.45rem}\nol.steps{padding-left:1.2rem;line-height:1.7}\n@media (max-width:900px){\n  .lrow{grid-template-columns:3.4rem minmax(0,1fr) auto;padding:.7rem .8rem}\n  .lrow .lt{display:none}\n  .catrow{grid-template-columns:1fr 1fr}\n  .tbars{height:110px}\n  .tcol small{display:none}\n  .sbar{grid-template-columns:minmax(0,7rem) minmax(0,1fr) auto}\n}\n\n/* Phone */\n@media (max-width:900px){\n  #app{grid-template-columns:1fr;grid-template-rows:auto 1fr}\n  nav{position:sticky;top:0;height:auto;min-height:0;z-index:10;flex-direction:row;align-items:center;overflow-x:auto;gap:.2rem;padding:.5rem .6rem;padding-top:calc(.5rem + env(safe-area-inset-top));border-right:0;border-bottom:1px solid var(--edge)}\n  nav button.tab{flex:none}\n  nav .mark,nav .grp,nav .who{display:none}\n  nav button.tab{width:auto;white-space:nowrap;margin:0;padding:.5rem .8rem}\n  nav button.tab.on::before{left:12px;right:12px;top:auto;bottom:2px;width:auto;height:2px}\n  main{padding:1.2rem 1rem 5rem}\n  .gauges,.g4,.g5{grid-template-columns:repeat(2,minmax(0,1fr))}\n  .gauge + .gauge{border-left:0}\n  .gauge:nth-child(even){border-left:1px solid var(--edge)}\n  .gauge:nth-child(n+3){border-top:1px solid var(--edge)}\n  .g2,.g3,.totals{grid-template-columns:1fr}\n  .stop{grid-template-columns:1fr}\n  .stop .acts{flex-direction:row;flex-wrap:wrap}\n  #drawer .sheet{padding:1.1rem 1rem 4rem;padding-top:calc(1.1rem + env(safe-area-inset-top))}\n  .kv{grid-template-columns:104px minmax(0,1fr)}\n  .gres{grid-template-columns:1fr}\n  .gacts{flex-direction:row;align-items:center;flex-wrap:wrap}\n  .btrow{flex-direction:column;align-items:flex-start}\n}\n@media (prefers-reduced-motion:no-preference){\n  #drawer .sheet{animation:slide .22s var(--ease)}\n  @keyframes slide{from{transform:translateX(24px);opacity:.5}to{transform:none;opacity:1}}\n}\n@media (prefers-reduced-motion:reduce){\n  *{transition-duration:.01ms!important}\n}\n</style>\n</head>\n<body>\n\n<section id=\"login\" class=\"hide\">\n  <form class=\"steel\" id=\"loginForm\">\n    <div class=\"mark\"><img src=\"https://ueauto.store/cdn/shop/t/5/assets/uea-logo_1.png\" alt=\"Upper Echelon Automotive\" width=\"152\" height=\"38\" onerror=\"this.className='broken'\"><div class=\"bolt\"></div><div><small>Service desk</small></div></div>\n    <div class=\"field\"><label for=\"em\">Email</label><input id=\"em\" type=\"email\" autocomplete=\"username\" required></div>\n    <div class=\"field\"><label for=\"pw\">Password</label><input id=\"pw\" type=\"password\" autocomplete=\"current-password\" required></div>\n    <p class=\"help\" style=\"margin:-.3rem 0 1.1rem\">You stay signed in on this device until you sign out.</p>\n    <button class=\"btn\">Sign in</button>\n    <div id=\"loginErr\" class=\"err-text\"></div>\n  </form>\n</section>\n\n<div id=\"app\" class=\"hide\">\n  <nav id=\"nav\"></nav>\n  <main id=\"view\"></main>\n  <div id=\"bnav\" role=\"navigation\" aria-label=\"Main\"></div>\n</div>\n<div id=\"more\" class=\"hide\" role=\"dialog\" aria-modal=\"true\" aria-label=\"More\"><div class=\"msheet\" id=\"moreSheet\"></div></div>\n\n<div id=\"drawer\" class=\"hide\"><div class=\"sheet\" id=\"sheet\" role=\"dialog\" aria-modal=\"true\"></div></div>\n<div id=\"toast\" class=\"hide\" role=\"status\"></div>\n\n<script>\n(function(){\n'use strict';\nvar API = location.pathname.replace(/\\/admin\\/?$/, '');\nvar TOKEN_KEY = 'uea_desk_token', ME_KEY = 'uea_desk_me';\nvar S = { tab:null, token:null, me:null, settings:null, prefill:null, jobsView:'board', methods:null };\n\n/* ───────── helpers ───────── */\nfunction $(s, r){ return (r||document).querySelector(s); }\nfunction $$(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); }\nfunction esc(v){ return String(v == null ? '' : v).replace(/[&<>\"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]; }); }\nfunction usd(c){ return '$' + (Number(c||0)/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }\nfunction n(v){ return Number(v||0).toLocaleString(); }\nfunction when(d){ if(!d) return ''; var x=new Date(d); return x.toLocaleDateString(undefined,{month:'short',day:'numeric',year:x.getFullYear()!==new Date().getFullYear()?'numeric':undefined})+' '+x.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); }\nfunction dayLabel(iso){ if(!iso) return ''; var p=String(iso).slice(0,10).split('-'); var d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2])); return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}); }\nfunction signed(p){ p=Number(p); return '<span class=\"pts '+(p>=0?'plus':'minus')+'\">'+(p>=0?'+':'')+n(p)+'</span>'; }\nfunction telHref(p){ return 'tel:'+String(p||'').replace(/[^\\d+]/g,''); }\nfunction smsHref(p){ return 'sms:'+String(p||'').replace(/[^\\d+]/g,''); }\nfunction mapHref(a){ return 'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(a||''); }\nfunction dollars(c){ return c ? (Number(c)/100).toFixed(2) : ''; }\nfunction cents(v){ return Math.round((parseFloat(v)||0)*100); }\nfunction isRole(){ var r=S.me&&S.me.role; return Array.prototype.slice.call(arguments).indexOf(r)>-1; }\nvar DESK = function(){ return isRole('owner','writer'); };\nvar PHONE = function(){ return window.matchMedia('(max-width:900px)').matches; };\n(function(){ var mq=window.matchMedia('(max-width:900px)'), f=function(){ if(S.tab==='jobs' && $('#jlist')) loadJobs(); };\n  if(mq.addEventListener) mq.addEventListener('change', f); else if(mq.addListener) mq.addListener(f); })();\nvar OWN = function(){ return isRole('owner'); };\nvar TYPE = {earn:'Service',welcome:'Welcome',referral:'Referral',review:'Review',redeem:'Redeemed',void:'Returned',adjust:'Adjustment',refund:'Refund',bonus:'Bonus',expire:'Expired'};\nvar STAGE_CHIP = {new:'gold',scheduled:'',en_route:'purple',on_site:'purple',waiting_approval:'warn',waiting_parts:'warn',in_progress:'purple',completed:'good'};\nvar STAGES = [['new','New'],['scheduled','Scheduled'],['en_route','On the way'],['on_site','On site'],['waiting_approval','Waiting on approval'],['waiting_parts','Waiting on parts'],['in_progress','Working'],['completed','Done, not paid']];\nfunction stageLabel(k){ for(var i=0;i<STAGES.length;i++) if(STAGES[i][0]===k) return STAGES[i][1]; return k; }\nfunction stageChip(j){\n  if(j.status==='paid') return '<span class=\"chip good\">Paid</span>';\n  if(j.status==='cancelled') return '<span class=\"chip bad\">Cancelled</span>';\n  return '<span class=\"chip '+(STAGE_CHIP[j.stage]||'')+'\">'+esc(stageLabel(j.stage))+'</span>';\n}\nfunction fe(f, n){ return f.querySelector('[name=\"'+n+'\"]'); }\nfunction fill(tpl, v){ return String(tpl||'').replace(/\\{(\\w+)\\}/g, function(m,k){ return v[k]!=null?String(v[k]):''; }).replace(/\\s{2,}/g,' ').trim(); }\n\nfunction toast(msg, err){\n  var t=$('#toast'); t.textContent=msg; t.className=err?'err':''; clearTimeout(t._h);\n  t._h=setTimeout(function(){ t.className='hide'; }, 3500);\n}\nfunction api(path, opts){\n  opts = opts || {};\n  return fetch(API + path, {\n    method: opts.method || 'GET',\n    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+(S.token||'') },\n    body: opts.body ? JSON.stringify(opts.body) : undefined\n  }).then(function(r){\n    return r.json().catch(function(){ return {}; }).then(function(d){\n      if (r.status===401 && path!=='/admin/login') { signOut(); throw new Error(d.error||'Signed out'); }\n      if (!r.ok) throw new Error(d.error || ('Request failed ('+r.status+')'));\n      return d;\n    });\n  });\n}\nfunction busy(btn, on, label){ if(!btn) return; if(on){ btn._t=btn.textContent; btn.disabled=true; btn.textContent=label||'Working…'; } else { btn.disabled=false; if(btn._t) btn.textContent=btn._t; } }\n\n/* ───────── auth ───────── */\nfunction signOut(){\n  try{ localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(ME_KEY); }catch(e){}\n  S.token=null; S.me=null; $('#drawer').classList.add('hide');\n  $('#app').classList.add('hide'); $('#login').classList.remove('hide'); $('#em').focus();\n}\n$('#loginForm').addEventListener('submit', function(e){\n  e.preventDefault(); $('#loginErr').textContent='';\n  var b=e.target.querySelector('button'); busy(b,true,'Signing in…');\n  api('/admin/login',{method:'POST',body:{email:$('#em').value,password:$('#pw').value}}).then(function(d){\n    S.token=d.token; S.me=d.staff;\n    try{ localStorage.setItem(TOKEN_KEY,d.token); localStorage.setItem(ME_KEY,JSON.stringify(d.staff)); }catch(e){}\n    $('#pw').value=''; start();\n  }).catch(function(err){ $('#loginErr').textContent=err.message; }).then(function(){ busy(b,false); });\n});\n\nvar NAV = [\n  {grp:'Work'},\n  {tab:'today', label:function(){ return isRole('tech')?'My day':'Today'; }, roles:['owner','writer','tech']},\n  {tab:'jobs', label:function(){ return isRole('tech')?'My jobs':'Jobs'; }, roles:['owner','writer','tech'], count:'cJobs'},\n  {tab:'calendar', label:'Calendar', roles:['owner','writer','tech']},\n  {tab:'new', label:'New job', roles:['owner','writer']},\n  {tab:'guide', label:'Quotes & labor guide', roles:['owner','writer']},\n  {tab:'followups', label:'Follow-ups', roles:['owner','writer'], count:'cFollow'},\n  {tab:'reminders', label:'Service reminders', roles:['owner','writer'], count:'cRem'},\n  {grp:'Customers', roles:['owner','writer']},\n  {tab:'messages', label:'Messages', roles:['owner','writer'], count:'cMsg'},\n  {tab:'customers', label:'Customers', roles:['owner','writer']},\n  {tab:'promos', label:'Promotions', roles:['owner','writer']},\n  {tab:'vouchers', label:'Reward vouchers', roles:['owner','writer'], count:'cVouchers'},\n  {tab:'webreviews', label:'Website reviews', roles:['owner','writer'], count:'cWebRev'},\n  {tab:'points', label:'Add points', roles:['owner']},\n  {grp:'Business', roles:['owner','writer']},\n  {tab:'overview', label:'Shop overview', roles:['owner','writer']},\n  {tab:'books', label:'Books', roles:['owner']},\n  {tab:'staff', label:'Team & access', roles:['owner']},\n  {tab:'settings', label:'Settings', roles:['owner']},\n  {grp:'You'},\n  {tab:'account', label:'My account', roles:['owner','writer','tech']}\n];\nfunction buildNav(){\n  var r=S.me.role, h='<div class=\"mark\"><img src=\"https://ueauto.store/cdn/shop/t/5/assets/uea-logo_1.png\" alt=\"Upper Echelon Automotive\" width=\"152\" height=\"38\" onerror=\"this.className=\\'broken\\'\"><div class=\"bolt\"></div></div>';\n  NAV.forEach(function(it){\n    if(it.roles && it.roles.indexOf(r)<0) return;\n    if(it.grp){ h+='<div class=\"grp\">'+it.grp+'</div>'; return; }\n    var lab=typeof it.label==='function'?it.label():it.label;\n    h+='<button class=\"tab\" data-tab=\"'+it.tab+'\">'+esc(lab)+(it.count?' <span class=\"count hide\" id=\"'+it.count+'\"></span>':'')+'</button>';\n  });\n  h+='<div class=\"who\">'+esc(S.me.name)+'<br>'+esc({owner:'Owner',writer:'Service writer',tech:'Technician'}[r])+'</div>';\n  $('#nav').innerHTML=h;\n  $$('#nav .tab').forEach(function(b){ b.addEventListener('click', function(){ go(b.dataset.tab); }); });\n  // Phone: bottom bar with the 4 most-used screens + More\n  var allowed=NAV.filter(function(it){ return it.tab && (!it.roles||it.roles.indexOf(r)>-1); });\n  var has=function(t){ return allowed.some(function(it){ return it.tab===t; }); };\n  var IC={today:'<path d=\"M4 6h16M4 12h10M4 18h7\"/>',jobs:'<rect x=\"3\" y=\"4\" width=\"7\" height=\"16\" rx=\"1.5\"/><rect x=\"14\" y=\"4\" width=\"7\" height=\"10\" rx=\"1.5\"/>',\n    'new':'<path d=\"M12 5v14M5 12h14\"/>',customers:'<circle cx=\"12\" cy=\"8\" r=\"3.5\"/><path d=\"M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5\"/>',\n    calendar:'<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"15\" rx=\"2\"/><path d=\"M3.5 10h17M8 3v4M16 3v4\"/>',\n    guide:'<path d=\"M6 3h9l3 3v15H6z\"/><path d=\"M9 11h6M9 15h6\"/>',more:'<circle cx=\"5.5\" cy=\"12\" r=\"1.4\"/><circle cx=\"12\" cy=\"12\" r=\"1.4\"/><circle cx=\"18.5\" cy=\"12\" r=\"1.4\"/>'};\n  var main=['today','jobs','new','calendar'].filter(has);\n  if(main.length<4 && has('guide')) main.push('guide');\n  var lab=function(t){ var it=allowed.filter(function(x){ return x.tab===t; })[0]; var l=typeof it.label==='function'?it.label():it.label; return {'Quotes & labor guide':'Quotes','New job':'New'}[l]||l; };\n  var ico=function(k){ return '<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">'+(IC[k]||IC.more)+'</svg>'; };\n  $('#bnav').innerHTML=main.map(function(t){ return '<button class=\"bt'+(t==='new'?' plus':'')+'\" data-tab=\"'+t+'\">'+ico(t)+'<span>'+esc(lab(t))+'</span>'+(t==='jobs'?'<i class=\"bc hide\" data-cnt=\"cJobs\"></i>':'')+'</button>'; }).join('')+\n    '<button class=\"bt\" id=\"bMore\">'+ico('more')+'<span>More</span><i class=\"bc hide\" data-cnt=\"more\"></i></button>';\n  $$('#bnav [data-tab]').forEach(function(b){ b.addEventListener('click', function(){ go(b.dataset.tab); window.scrollTo(0,0); }); });\n  var rest=NAV.filter(function(it){ return !it.roles||it.roles.indexOf(r)>-1; });\n  var mh='<div class=\"mgrab\" aria-hidden=\"true\"></div><div class=\"mwho\">'+esc(S.me.name)+' · '+esc({owner:'Owner',writer:'Service writer',tech:'Technician'}[r])+'</div>';\n  rest.forEach(function(it){\n    if(it.grp){ mh+='<div class=\"grp\">'+it.grp+'</div>'; return; }\n    if(main.indexOf(it.tab)>-1) return;\n    var l=typeof it.label==='function'?it.label():it.label;\n    mh+='<button class=\"mi\" data-tab=\"'+it.tab+'\"><span>'+esc(l)+'</span>'+(it.count?'<i class=\"bc hide\" data-cnt=\"'+it.count+'\"></i>':'')+'<b aria-hidden=\"true\">›</b></button>';\n  });\n  mh=mh.replace(/<div class=\"grp\">[^<]*<\\/div>(?=<div class=\"grp\">|$)/g,'');\n  $('#moreSheet').innerHTML=mh;\n  $$('#moreSheet [data-tab]').forEach(function(b){ b.addEventListener('click', function(){ $('#more').classList.add('hide'); go(b.dataset.tab); window.scrollTo(0,0); }); });\n  $('#bMore').addEventListener('click', function(){ $('#more').classList.remove('hide'); });\n  $('#more').addEventListener('click', function(e){ if(e.target.id==='more') $('#more').classList.add('hide'); });\n}\nfunction start(){\n  $('#login').classList.add('hide'); $('#app').classList.remove('hide');\n  buildNav(); go(S.tab||(location.hash==='#webreviews'?'webreviews':'today')); refreshCounts();\n  api('/admin/me').then(function(d){ S.me=d.staff; try{ localStorage.setItem(ME_KEY,JSON.stringify(d.staff)); }catch(e){} }).catch(function(){});\n}\nfunction setCount(id, v){ var el=$('#'+id); if(el){ el.textContent=v; el.classList.toggle('hide', !v); }\n  $$('[data-cnt=\"'+id+'\"]').forEach(function(b){ b.textContent=v; b.classList.toggle('hide', !v); });\n  S.cnt=S.cnt||{}; S.cnt[id]=v; var m=(S.cnt.cFollow||0)+(S.cnt.cRem||0)+(S.cnt.cVouchers||0)+(S.cnt.cMsg||0)+(S.cnt.cWebRev||0);\n  $$('[data-cnt=\"more\"]').forEach(function(b){ b.textContent=m; b.classList.toggle('hide', !m); }); }\nfunction refreshCounts(){\n  api('/admin/jobs?view=open').then(function(d){ setCount('cJobs', d.jobs.length); }).catch(function(){});\n  if(DESK()){\n    api('/admin/followups').then(function(d){ setCount('cFollow', d.followups.filter(function(f){return f.due;}).length); }).catch(function(){});\n    api('/admin/vouchers?status=open').then(function(d){ setCount('cVouchers', d.vouchers.length); }).catch(function(){});\n    api('/admin/reminders?view=due').then(function(d){ setCount('cRem', d.reminders.length); }).catch(function(){});\n    api('/admin/site-reviews?status=pending').then(function(d){ setCount('cWebRev', d.pending); }).catch(function(){});\n    refreshMsgCount();\n  }\n}\nfunction refreshMsgCount(){\n  return api('/admin/messages').then(function(d){\n    var before=(S.cnt&&S.cnt.cMsg)||0; setCount('cMsg', d.unread); S.convos=d.conversations;\n    if(d.unread>before && S.msgReady) toast('New text from a customer');\n    S.msgReady=true; return d;\n  }).catch(function(){});\n}\n// Check for new customer texts every 30 seconds while the desk is open.\nsetInterval(function(){\n  if(!S.token||!S.me||!DESK()||document.hidden) return;\n  refreshMsgCount().then(function(){\n    if(S.tab==='messages'&&$('#convList')&&!S.thread) paintConvos();\n    if(S.thread&&$('#thread')) loadThread(S.thread,true);\n  });\n}, 30000);\nvar VIEWS = {};\nfunction go(tab){\n  var allowed=$$('#nav .tab').map(function(b){ return b.dataset.tab; });\n  if(allowed.indexOf(tab)<0) tab='today';\n  S.tab=tab; $$('#nav .tab, #bnav [data-tab]').forEach(function(b){ b.classList.toggle('on', b.dataset.tab===tab); });\n  if($('#bMore')) $('#bMore').classList.toggle('on', !$('#bnav [data-tab=\"'+tab+'\"]'));\n  if(tab!=='jobs') S.sel=null;\n  S.thread=null;\n  $('#view').innerHTML='<div class=\"empty\">Loading…</div>';\n  VIEWS[tab]();\n}\nfunction fail(err){ $('#view').innerHTML='<div class=\"empty\">'+esc(err.message)+'</div>'; }\nfunction rerender(){ if(VIEWS[S.tab]) VIEWS[S.tab](); refreshCounts(); }\n\n/* ───────── TODAY ───────── */\nVIEWS.today = function(){\n  var tech=isRole('tech');\n  Promise.all([api('/admin/jobs?view=today'), DESK()?api('/admin/jobs?view=open'):Promise.resolve(null), DESK()?api('/admin/techs'):Promise.resolve({techs:[]})]).then(function(r){\n    var d=r[0], open=r[1], techs=r[2].techs, today=d.today;\n    var unsched = open ? open.jobs.filter(function(j){ return !j.sched_date; }) : [];\n    var waiting = open ? open.jobs.filter(function(j){ return j.stage==='waiting_approval'; }) : [];\n    var unpaid = open ? open.jobs.filter(function(j){ return j.stage==='completed'; }) : [];\n    var h='<h2>'+(tech?'My day':'Today')+'</h2><p class=\"dim\" style=\"margin:-.7rem 0 1rem\">'+dayLabel(today)+'</p>';\n    if(DESK()){\n      h+='<div class=\"grid g3\" style=\"margin-bottom:1rem\">'+\n        miniLink('Need scheduling', unsched.length, 'jobs')+miniLink('Waiting on customer approval', waiting.length, 'jobs')+miniLink('Done but not paid', unpaid.length, 'jobs')+'</div>';\n      if(techs.length) h+='<div class=\"row\" style=\"margin-bottom:.8rem\"><select id=\"tFilter\" style=\"width:auto\"><option value=\"\">Everyone</option><option value=\"none\">Unassigned</option>'+techs.map(function(t){return '<option value=\"'+t.id+'\">'+esc(t.name)+'</option>';}).join('')+'</select></div>';\n    }\n    h+='<div class=\"day\" id=\"dayList\"></div>';\n    $('#view').innerHTML=h;\n    $$('[data-goto]').forEach(function(b){ b.addEventListener('click', function(){ go(b.dataset.goto); }); });\n    function paint(filter){\n      var jobs=d.jobs.filter(function(j){ return !filter || (filter==='none'?!j.tech_id:j.tech_id===filter); });\n      $('#dayList').innerHTML = jobs.length ? jobs.map(function(j){\n        var late=j.sched_date && j.sched_date<today;\n        return '<div class=\"steel stop\"><div class=\"when\">'+esc(j.sched_window||'Any time')+(late?'<small style=\"color:var(--warn)\">From '+dayLabel(j.sched_date)+'</small>':'')+'</div>'+\n          '<div><div class=\"who\">'+esc(j.customer_name||'Customer')+' '+stageChip(j)+(j.rush?' <span class=\"chip bad\">Rush</span>':'')+'</div>'+\n          '<div>'+esc(j.service||'')+(j.vehicle?' <span class=\"dim\">on '+esc(j.vehicle)+'</span>':'')+'</div>'+\n          (j.address?'<div class=\"dim\" style=\"font-size:.88rem\">'+esc(j.address)+'</div>':'')+\n          (DESK()?'<div class=\"dim\" style=\"font-size:.85rem\">'+(j.tech?esc(j.tech.name):'<span style=\"color:var(--warn)\">Unassigned</span>')+'</div>':'')+'</div>'+\n          '<div class=\"acts\">'+(j.address?'<a class=\"btn ghost sm\" target=\"_blank\" rel=\"noopener\" href=\"'+mapHref(j.address)+'\">Navigate</a>':'')+\n          (j.phone?'<a class=\"btn ghost sm\" href=\"'+telHref(j.phone)+'\">Call</a>':'')+\n          '<button class=\"btn sm\" data-job=\"'+j.id+'\">Open job</button></div></div>';\n      }).join('') : '<div class=\"steel empty\">'+(tech?'Nothing assigned to you today.':'Nothing scheduled for today.')+(DESK()&&unsched.length?' <a href=\"#\" data-goto=\"jobs\">'+unsched.length+' job'+(unsched.length>1?'s':'')+' need scheduling.</a>':'')+'</div>';\n      $$('#dayList [data-job]').forEach(function(b){ b.addEventListener('click', function(){ openJob(b.dataset.job); }); });\n      $$('#dayList [data-goto]').forEach(function(b){ b.addEventListener('click', function(e){ e.preventDefault(); go(b.dataset.goto); }); });\n    }\n    paint('');\n    if($('#tFilter')) $('#tFilter').addEventListener('change', function(){ paint(this.value); });\n  }).catch(fail);\n};\nfunction miniLink(label, v, tab){ return '<button class=\"steel panel\" data-goto=\"'+tab+'\" style=\"text-align:left;cursor:pointer;color:var(--text)\"><div class=\"dim\" style=\"font-family:var(--head);font-size:.85rem\">'+label+'</div><div style=\"font-family:var(--display);font-size:2rem;line-height:1.1;color:'+(v?'var(--gold-hi)':'var(--text)')+'\">'+n(v)+'</div></button>'; }\n\n/* ───────── JOBS BOARD ───────── */\nVIEWS.jobs = function(){\n  var h='<h2>'+(isRole('tech')?'My jobs':'Jobs')+'</h2><div class=\"row\" style=\"margin-bottom:1rem\">'+\n    '<div class=\"row\" role=\"tablist\"><button class=\"btn sm '+(S.jobsView==='board'?'':'ghost')+'\" data-jv=\"board\">Open jobs</button><button class=\"btn sm '+(S.jobsView==='history'?'':'ghost')+'\" data-jv=\"history\">Paid & cancelled</button></div>'+\n    '<input id=\"jq\" placeholder=\"Search name, phone, VIN, order #, address\" style=\"flex:1;min-width:200px\">'+\n    (DESK()?'<select id=\"jt\" style=\"width:auto\"><option value=\"\">Everyone</option><option value=\"none\">Unassigned</option></select>'+(S.jobsView==='board'?'<button class=\"btn ghost sm\" id=\"selMode\">'+(S.sel?'Done selecting':'Select jobs')+'</button>':'')+'<button class=\"btn purple sm\" data-goto=\"new\">New job</button>':'')+\n    '</div>'+(S.sel&&S.jobsView==='board'?'<div class=\"selbar\" id=\"selBar\"><span id=\"selN\">0 selected</span><button class=\"btn ghost sm\" id=\"selPast\">Select all with past dates</button><button class=\"btn ghost sm\" id=\"selAll\">Select all</button><button class=\"btn ghost sm\" id=\"selNone\">Clear</button><span style=\"flex:1\"></span><button class=\"btn sm\" id=\"selFinish\" disabled>Mark finished</button><button class=\"btn danger sm\" id=\"selCancel\" disabled>Cancel jobs</button></div>':'')+\n    '<div id=\"jlist\"></div>';\n  $('#view').innerHTML=h;\n  $$('[data-jv]').forEach(function(b){ b.addEventListener('click', function(){ S.jobsView=b.dataset.jv; S.sel=null; VIEWS.jobs(); }); });\n  if($('#selMode')) $('#selMode').addEventListener('click', function(){ S.sel=S.sel?null:{}; VIEWS.jobs(); });\n  if(S.sel&&$('#selBar')){\n    var pick=function(test){ S.sel={}; (S.lastJobs||[]).forEach(function(j){ if(test(j)) S.sel[j.id]=1; }); paintSel(); };\n    $('#selPast').addEventListener('click', function(){ var t=new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'}); pick(function(j){ return j.sched_date && j.sched_date<t; }); });\n    $('#selAll').addEventListener('click', function(){ pick(function(){ return true; }); });\n    $('#selNone').addEventListener('click', function(){ pick(function(){ return false; }); });\n    var bulk=function(action, btn){\n      var ids=Object.keys(S.sel); if(!ids.length) return;\n      var msg=action==='finish'?'Mark '+ids.length+' job'+(ids.length>1?'s':'')+' as finished? They move to \"Paid & cancelled\". No charge is recorded and no points are added.':'Cancel '+ids.length+' job'+(ids.length>1?'s':'')+'?';\n      if(!confirm(msg)) return;\n      busy(btn,true,'Working…');\n      api('/admin/jobs/bulk',{method:'POST',body:{ids:ids,action:action}}).then(function(r){\n        toast(r.done+' job'+(r.done===1?'':'s')+(action==='finish'?' marked finished':' cancelled')); S.sel={}; busy(btn,false); loadJobs(); refreshCounts();\n      }).catch(function(e){ busy(btn,false); toast(e.message,true); });\n    };\n    $('#selFinish').addEventListener('click', function(){ bulk('finish', this); });\n    $('#selCancel').addEventListener('click', function(){ bulk('cancel', this); });\n  }\n  $$('[data-goto]').forEach(function(b){ b.addEventListener('click', function(){ go(b.dataset.goto); }); });\n  if(DESK()) api('/admin/techs').then(function(d){ $('#jt').insertAdjacentHTML('beforeend', d.techs.map(function(t){return '<option value=\"'+t.id+'\">'+esc(t.name)+'</option>';}).join('')); });\n  var t; $('#jq').addEventListener('input', function(){ clearTimeout(t); t=setTimeout(loadJobs, 250); });\n  if($('#jt')) $('#jt').addEventListener('change', loadJobs);\n  loadJobs();\n};\nfunction loadJobs(){\n  var q=$('#jq').value, tech=$('#jt')?$('#jt').value:'';\n  var hist=S.jobsView==='history';\n  api('/admin/jobs?view='+(hist?'history':'open')+'&q='+encodeURIComponent(q)+'&tech='+encodeURIComponent(tech)).then(function(d){\n    if(hist){\n      $('#jlist').innerHTML = d.jobs.length ? '<div class=\"steel scroll\"><table><tr><th>Job</th><th>Customer</th><th>Service</th><th>Status</th></tr>'+d.jobs.map(function(j){\n        return '<tr class=\"click\" data-job=\"'+j.id+'\"><td><b style=\"font-family:var(--head)\">'+esc(j.order_name||'Phone job')+'</b><div class=\"dim\" style=\"font-size:.8rem\">'+when(j.paid_at||j.created_at)+'</div></td><td>'+esc(j.customer_name||j.email||'')+'</td><td>'+esc(j.service||'')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(j.vehicle||'')+'</div></td><td>'+stageChip(j)+(j.status==='paid'?'<div class=\"dim\" style=\"font-size:.82rem\">'+usd(j.total_cents)+'</div>':'')+'</td></tr>';\n      }).join('')+'</table></div>' : '<div class=\"steel empty\">No paid or cancelled jobs match.</div>';\n    } else {\n      var cols=STAGES.map(function(s){ return {k:s[0], l:s[1], jobs:d.jobs.filter(function(j){ return j.stage===s[0]; })}; });\n      if(isRole('tech')) cols=cols.filter(function(c){ return c.jobs.length || ['scheduled','on_site','in_progress'].indexOf(c.k)>-1; });\n      if(PHONE()){\n        var f=S.stageF||'all'; if(f!=='all' && !cols.some(function(c){ return c.k===f && c.jobs.length; })) f='all';\n        var shown=cols.filter(function(c){ return c.jobs.length && (f==='all'||c.k===f); });\n        $('#jlist').innerHTML='<div class=\"schips\" role=\"tablist\"><button class=\"schip'+(f==='all'?' on':'')+'\" data-sf=\"all\">All <b>'+d.jobs.length+'</b></button>'+\n          cols.filter(function(c){ return c.jobs.length; }).map(function(c){ return '<button class=\"schip'+(f===c.k?' on':'')+'\" data-sf=\"'+c.k+'\">'+esc(c.l)+' <b>'+c.jobs.length+'</b></button>'; }).join('')+'</div>'+\n          (shown.length?shown.map(function(c){ return (f==='all'?'<h4 class=\"lhead\">'+esc(c.l)+' <span>'+c.jobs.length+'</span></h4>':'')+c.jobs.map(card).join(''); }).join(''):'<div class=\"steel empty\">No open jobs'+($('#jq').value?' match your search':'')+'.</div>');\n        $$('[data-sf]').forEach(function(b){ b.addEventListener('click', function(){ S.stageF=b.dataset.sf; loadJobs(); }); });\n        cols=null;\n      }\n      if(cols)\n      $('#jlist').innerHTML = '<div class=\"board\">'+cols.map(function(c){\n        return '<div class=\"col\"><h4><b>'+c.l+'</b><span>'+c.jobs.length+'</span></h4>'+(c.jobs.length?c.jobs.map(card).join(''):'<div class=\"dim\" style=\"font-size:.82rem;padding:.3rem\">None</div>')+'</div>';\n      }).join('')+'</div>';\n    }\n    if(!hist) S.lastJobs=d.jobs;\n    $$('#jlist [data-job]').forEach(function(el){ el.addEventListener('click', function(){\n      if(S.sel&&!hist){ if(S.sel[el.dataset.job]) delete S.sel[el.dataset.job]; else S.sel[el.dataset.job]=1; paintSel(); }\n      else openJob(el.dataset.job); }); });\n    paintSel();\n  }).catch(function(e){ $('#jlist').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\nfunction paintSel(){\n  if(!S.sel) return;\n  var n=Object.keys(S.sel).length;\n  $$('#jlist .card[data-job]').forEach(function(c){ c.classList.toggle('picked', !!S.sel[c.dataset.job]); c.setAttribute('aria-pressed', S.sel[c.dataset.job]?'true':'false'); });\n  if($('#selN')) $('#selN').textContent=n+' selected';\n  if($('#selFinish')){ $('#selFinish').disabled=!n; $('#selCancel').disabled=!n; }\n}\nfunction card(j){\n  var est=j.estimate&&j.estimate.lines&&j.estimate.lines.length;\n  return '<button class=\"card\" data-job=\"'+j.id+'\"><div class=\"t\">'+esc(j.customer_name||'Customer')+'</div>'+\n    '<div class=\"s\">'+esc(j.service||'No service listed')+(j.vehicle?'<br>'+esc(j.vehicle):'')+'</div>'+\n    '<div class=\"s\">'+(j.sched_date?dayLabel(j.sched_date)+(j.sched_window?', '+esc(j.sched_window):''):'<span style=\"color:var(--warn)\">Not scheduled</span>')+\n    (j.tech?' &middot; '+esc(j.tech.name):(DESK()?' &middot; <span style=\"color:var(--warn)\">No tech</span>':''))+'</div>'+\n    '<div class=\"f\">'+(j.order_name?'<span class=\"chip\">'+esc(j.order_name)+'</span>':'<span class=\"chip\">Phone</span>')+\n    (j.rush?'<span class=\"chip bad\">Rush</span>':'')+(j.voucher_code?'<span class=\"chip purple\">Reward</span>':'')+\n    (est?'<span class=\"chip gold\">Estimate</span>':'')+(j.member&&j.member.is_fleet?'<span class=\"chip\">Fleet</span>':'')+'</div></button>';\n}\n\n/* ───────── JOB DRAWER ───────── */\nvar J = null; // current job payload\nfunction openJob(id, tab, preset){\n  var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide');\n  var keepTab = J && J.booking.id===id ? J.tab : null;\n  if(!keepTab) sh.innerHTML='<div class=\"empty\">Loading…</div>';\n  api('/admin/booking/'+id).then(function(x){\n    J=x; J.tab = tab || keepTab || 'job'; J.preset = preset || null; S.methods=x.payment_methods;\n    renderJob();\n  }).catch(function(e){ sh.innerHTML='<div class=\"empty\">'+esc(e.message)+'</div><button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button>'; $('#closeDrawer').addEventListener('click', closeDrawer); });\n}\nfunction closeDrawer(){ $('#drawer').classList.add('hide'); J=null; rerender(); }\n$('#drawer').addEventListener('click', function(e){ if(e.target.id==='drawer') closeDrawer(); });\ndocument.addEventListener('keydown', function(e){ if(e.key==='Escape' && !$('#drawer').classList.contains('hide')) closeDrawer(); });\n\n// What the customer picked for parts at booking (website form or Shopify order).\nfunction partsChip(b){\n  var p=(b.details||[]).filter(function(x){ return /^parts$/i.test(x.name) && x.value; })[0];\n  if(!p) return '';\n  var v=String(p.value);\n  if(/customer|own/i.test(v)) return '<span class=\"chip warn\" title=\"'+esc(v)+'\">Customer\\'s parts</span>';\n  if(/shop|we supply/i.test(v)) return '<span class=\"chip gold\" title=\"'+esc(v)+'\">We supply parts</span>';\n  return '<span class=\"chip purple\" title=\"'+esc(v)+'\">Parts: ask customer</span>';\n}\nfunction renderJob(){\n  var b=J.booking, open=b.status==='open';\n  var ins=J.inspection;\n  var tabs=[['job','Job'],['inspection','Inspection'+(ins&&ins.done?' ('+ins.done+')':'')],['estimate','Estimate'+(J.totals.pending&&b.estimate_token?' •':'')],['texts','Texts'],['payment','Payment'],['history','History']];\n  if(isRole('tech')) tabs=tabs.filter(function(t){ return t[0]!=='payment'; });\n  if(isRole('owner')) tabs.splice(tabs.length-1,0,['costs','Job costs']);\n  var h='<div class=\"jhead\"><button class=\"btn ghost sm back\" id=\"closeDrawer\" aria-label=\"Back to list\">'+(PHONE()?'‹ Back':'Close')+'</button><div class=\"jtitle\">'+\n      '<h2 style=\"margin:0 0 .3rem\">'+esc(b.customer_name||'Customer')+'</h2>'+\n      '<div class=\"row\" style=\"gap:.4rem\">'+stageChip(b)+(b.order_name?'<span class=\"chip\">'+esc(b.order_name)+'</span>':'<span class=\"chip\">Phone job</span>')+(b.rush?'<span class=\"chip bad\">Rush</span>':'')+partsChip(b)+\n      (J.tier&&!(J.member&&J.member.is_fleet)?'<span class=\"chip gold\">'+esc(J.tier.name)+' member</span>':'')+(J.member&&J.member.is_fleet?'<span class=\"chip\">Fleet</span>':'')+'</div></div></div>';\n  if(open) h+=clockBar();\n  if(open){\n    h+='<div class=\"row jacts\" style=\"margin-top:.9rem;gap:.4rem\">'+\n      '<select id=\"stageSel\" style=\"width:auto\">'+STAGES.map(function(s){ return '<option value=\"'+s[0]+'\"'+(s[0]===b.stage?' selected':'')+'>'+s[1]+'</option>'; }).join('')+'</select>'+\n      (b.phone?'<a class=\"btn ghost sm\" href=\"'+telHref(b.phone)+'\">Call</a><a class=\"btn ghost sm\" href=\"sms:'+String(b.phone).replace(/[^\\d+]/g,'')+'\">Text</a>':'')+\n      (b.address?'<a class=\"btn ghost sm\" target=\"_blank\" rel=\"noopener\" href=\"'+mapHref(b.address)+'\">Navigate</a>':'')+\n      (['new','scheduled'].indexOf(b.stage)>-1&&b.phone?'<button class=\"btn purple sm\" data-quick=\"onway\">On my way</button>':'')+\n      (['en_route','scheduled'].indexOf(b.stage)>-1?'<button class=\"btn ghost sm\" data-quick=\"arrived\">Arrived</button>':'')+\n      (['on_site','in_progress','waiting_parts'].indexOf(b.stage)>-1?'<button class=\"btn sm\" data-quick=\"done\">Work done</button>':'')+\n      '</div>';\n  }\n  h+='<div class=\"dtabs\">'+tabs.map(function(t){ return '<button data-dt=\"'+t[0]+'\" class=\"'+(J.tab===t[0]?'on':'')+'\">'+t[1]+'</button>'; }).join('')+'</div><div id=\"dbody\"></div>';\n  $('#sheet').innerHTML=h;\n  $('#closeDrawer').addEventListener('click', closeDrawer);\n  $$('[data-dt]').forEach(function(t){ t.addEventListener('click', function(){ J.tab=t.dataset.dt; renderJob(); }); });\n  if($('#stageSel')) $('#stageSel').addEventListener('change', function(){ patchJob({stage:this.value}, 'Stage updated'); });\n  $$('[data-quick]').forEach(function(btn){ btn.addEventListener('click', function(){\n    var q=btn.dataset.quick;\n    if(q==='onway'){ J.tab='texts'; J.preset='on_way'; renderJob(); return; }\n    if(q==='arrived') patchJob({stage:'on_site'}, 'Marked on site');\n    if(q==='done') patchJob({stage:'completed'}, 'Marked done. '+(DESK()?'Next: payment.':'The desk will collect payment.'));\n  }); });\n  bindClock();\n  (({job:tabJob,inspection:tabInspection,estimate:tabEstimate,texts:tabTexts,payment:tabPayment,costs:tabCosts,history:tabHistory})[J.tab]||tabJob)();\n  $('#sheet').scrollTop=0;\n}\nfunction patchJob(body, msg){\n  return api('/admin/booking/'+J.booking.id,{method:'PATCH',body:body}).then(function(){ toast(msg||'Saved'); openJob(J.booking.id); }).catch(function(e){ toast(e.message,true); openJob(J.booking.id); });\n}\n\n/* Job tab */\nfunction tabJob(){\n  var b=J.booking, open=b.status==='open', desk=DESK();\n  var dis=function(deskOnly){ return (!open && deskOnly!=='always') || (deskOnly===true && !desk) ? ' disabled' : ''; };\n  var details=(b.details||[]).filter(function(p){ return p.value && !/^(rewards member|reward voucher)$/i.test(p.name); });\n  var h='<form id=\"jobForm\">';\n  h+='<div class=\"steel panel sec\"><h3>Customer</h3><div class=\"grid g2\">'+\n    fld('Name','customer_name',b.customer_name,dis(true))+fld('Phone','phone',b.phone,dis(true),'tel')+\n    fld('Email','email',b.email,dis(true),'email')+fld('Service address','address',b.address,dis(true))+'</div>'+\n    (J.member?'<div class=\"dim\" style=\"font-size:.88rem\">'+(J.member.is_fleet?'Fleet account. ':(J.tier?esc(J.tier.name)+' member, ':'')+n(J.member.points_balance)+' points. ')+(desk?'<a href=\"#\" id=\"toMember\">Open customer</a>':'')+'</div>':'<div class=\"dim\" style=\"font-size:.88rem\">Not a rewards member'+(b.email?' yet.':'. Add an email to give them points.')+'</div>')+\n    (J.member&&J.member.notes?'<div class=\"cnote\"><b>Customer notes:</b> '+esc(J.member.notes)+'</div>':'')+\n    ((J.vehicles||[]).length>1?'<div class=\"help\">Vehicles on file: '+J.vehicles.map(function(v){ return esc(v.description)+(v.mileage?' ('+n(v.mileage)+' mi)':''); }).join(' · ')+'</div>':'')+\n    (J.voucher&&['active','applied'].indexOf(J.voucher.status)>-1?'<div style=\"margin-top:.5rem\"><span class=\"chip purple\">Reward attached</span> '+esc(J.voucher.reward_name)+' ('+esc(J.voucher.code)+'). Add it as a discount line on the estimate.</div>':'')+\n    '</div>';\n  h+='<div class=\"steel panel sec\"><h3>Schedule</h3><div class=\"grid g3\">'+\n    '<div class=\"field\"><label>Date</label><input type=\"date\" name=\"sched_date\" value=\"'+esc(b.sched_date||'')+'\"'+dis(true)+'></div>'+\n    '<div class=\"field\"><label>Time window</label><select name=\"sched_window\"'+dis(true)+'><option value=\"\">Choose</option>'+\n      (J.shop.time_windows||[]).concat(b.sched_window&&(J.shop.time_windows||[]).indexOf(b.sched_window)<0?[b.sched_window]:[]).map(function(w){ return '<option'+(w===b.sched_window?' selected':'')+'>'+esc(w)+'</option>'; }).join('')+'</select></div>'+\n    '<div class=\"field\"><label>Technician</label><select name=\"tech_id\"'+dis(true)+'><option value=\"\">Unassigned</option>'+\n      (J.techs||[]).map(function(t){ return '<option value=\"'+t.id+'\"'+(t.id===b.tech_id?' selected':'')+'>'+esc(t.name)+'</option>'; }).join('')+\n      (!desk&&b.tech_id?'<option selected>You</option>':'')+'</select></div></div>'+\n    (desk?'<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" name=\"rush\"'+(b.rush?' checked':'')+dis(true)+'> Rush / emergency</label>':'')+'</div>';\n  h+='<div class=\"steel panel sec\"><h3>Vehicle</h3><div class=\"grid g2\">'+\n    fld('Year, make, model','vehicle',b.vehicle,dis(true))+\n    '<div class=\"field\"><label>VIN</label><div class=\"row\" style=\"flex-wrap:nowrap\"><input name=\"vin\" value=\"'+esc(b.vin||'')+'\" maxlength=\"17\" style=\"text-transform:uppercase\"'+dis()+'>'+(open?'<button type=\"button\" class=\"btn ghost sm\" id=\"vinDecode\">Decode</button>':'')+'</div></div>'+\n    fld('Mileage','mileage',b.mileage,dis(),'text','numeric')+fld('Plate','plate',b.plate,dis())+'</div></div>';\n  h+='<div class=\"steel panel sec\"><h3>Concern and findings</h3>'+\n    '<div class=\"field\"><label>Customer concern</label><textarea name=\"concern\" rows=\"2\"'+dis(true)+'>'+esc(b.concern||'')+'</textarea></div>'+\n    ((J.photos||[]).length?'<div class=\"field\"><label>Photos from the customer</label><div class=\"row\" style=\"gap:.5rem;flex-wrap:wrap\">'+J.photos.map(function(u){ return '<a href=\"'+esc(u)+'\" target=\"_blank\" rel=\"noopener\"><img src=\"'+esc(u)+'\" alt=\"Customer photo\" style=\"width:96px;height:96px;object-fit:cover;border-radius:6px;border:1px solid var(--edge)\"></a>'; }).join('')+'</div></div>':'')+\n    '<div class=\"field\"><label>Technician findings</label><textarea name=\"findings\" rows=\"3\" placeholder=\"What you tested, what you found, readings, codes\"'+dis()+'>'+esc(b.findings||'')+'</textarea><div class=\"help\">Customers see findings on their estimate approval page.</div></div>'+\n    (desk?'<div class=\"field\"><label>Internal note (staff only)</label><input name=\"admin_note\" value=\"'+esc(b.admin_note||'')+'\"'+dis(true)+'></div>':'')+'</div>';\n  if(open) h+='<div class=\"row sec\"><button class=\"btn\">Save changes</button>'+(desk?'<button type=\"button\" class=\"btn danger sm\" id=\"cancelJob\">Cancel job</button>':'')+'</div>';\n  h+='</form>';\n  if(details.length) h+='<div class=\"steel panel sec\"><h3>From the website booking</h3><div class=\"kv\">'+details.map(function(p){ return '<dt>'+esc(p.name)+'</dt><dd>'+esc(p.value)+'</dd>'; }).join('')+'</div></div>';\n  if(J.history&&J.history.length) h+='<div class=\"steel panel sec\"><h3>Earlier jobs for this customer</h3><table>'+J.history.map(function(x){\n    return '<tr class=\"click\" data-job=\"'+x.id+'\"><td class=\"dim\" style=\"white-space:nowrap\">'+dayLabel((x.paid_at||x.created_at||'').slice(0,10))+'</td><td>'+esc(x.service||'')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(x.vehicle||'')+(x.mileage?', '+n(x.mileage)+' mi':'')+'</div></td><td>'+stageChip(x)+'</td></tr>';\n  }).join('')+'</table></div>';\n  $('#dbody').innerHTML=h;\n  $$('#dbody tr[data-job]').forEach(function(tr){ tr.addEventListener('click', function(){ J.tab='job'; openJob(tr.dataset.job); }); });\n  if($('#toMember')) $('#toMember').addEventListener('click', function(e){ e.preventDefault(); openMember(J.member.id); });\n  if($('#vinDecode')) $('#vinDecode').addEventListener('click', function(){ decodeVin(fe($('#jobForm'),'vin'), fe($('#jobForm'),'vehicle')); });\n  if($('#cancelJob')) $('#cancelJob').addEventListener('click', function(){\n    var reason=prompt('Cancel this job? Add a reason (optional):',''); if(reason===null) return;\n    api('/admin/booking/'+b.id+'/cancel',{method:'POST',body:{reason:reason}}).then(function(){ toast('Job cancelled'); openJob(b.id); }).catch(function(e){ toast(e.message,true); });\n  });\n  $('#jobForm').addEventListener('submit', function(e){\n    e.preventDefault(); var f=e.target, body={};\n    ['customer_name','phone','email','address','vehicle','vin','mileage','plate','concern','findings','admin_note','sched_date','sched_window','tech_id'].forEach(function(k){\n      if(fe(f,k) && !fe(f,k).disabled && fe(f,k).value!==(J.booking[k]==null?'':String(J.booking[k]))) body[k]=fe(f,k).value;\n    });\n    if(fe(f,'rush') && !fe(f,'rush').disabled && fe(f,'rush').checked!==!!J.booking.rush) body.rush=fe(f,'rush').checked;\n    if(!Object.keys(body).length) return toast('Nothing changed');\n    patchJob(body,'Job saved');\n  });\n}\nfunction fld(label, name, val, dis, type, mode){ return '<div class=\"field\"><label>'+label+'</label><input name=\"'+name+'\" type=\"'+(type||'text')+'\"'+(mode?' inputmode=\"'+mode+'\"':'')+' value=\"'+esc(val==null?'':val)+'\"'+(dis||'')+'></div>'; }\nfunction decodeVin(vinInput, vehInput){\n  var vin=(vinInput.value||'').toUpperCase().trim();\n  if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return toast('Enter the full 17-character VIN first', true);\n  toast('Decoding VIN…');\n  fetch('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/'+vin+'?format=json').then(function(r){ return r.json(); }).then(function(d){\n    var r=d.Results&&d.Results[0]; if(!r||!r.Make) throw new Error('VIN not recognized');\n    var tc=function(s){ return String(s||'').toLowerCase().replace(/\\b\\w/g,function(c){return c.toUpperCase();}); };\n    var eng=r.DisplacementL?(Math.round(parseFloat(r.DisplacementL)*10)/10)+'L':'';\n    var v=[r.ModelYear, tc(r.Make), r.Model, r.Trim, eng].filter(Boolean).join(' ');\n    if(vehInput && !vehInput.disabled) vehInput.value=v;\n    vinInput.value=vin; toast('Decoded: '+v);\n  }).catch(function(e){ toast('Could not decode: '+e.message, true); });\n}\n\n/* Estimate tab */\nfunction tabEstimate(){\n  var b=J.booking, open=b.status==='open', canEdit=open&&(DESK()||J.shop.tech_can_estimate);\n  var est=b.estimate||{lines:[],notes:''};\n  J.lines=JSON.parse(JSON.stringify(est.lines||[]));\n  var h='';\n  if(!canEdit && !J.lines.length){ $('#dbody').innerHTML='<div class=\"steel empty\">No estimate on this job'+(open?'. The service desk builds estimates.':'.')+'</div>'; return; }\n  h+='<div class=\"steel panel sec\"><div class=\"row\" style=\"justify-content:space-between\"><h3 style=\"margin:0\">Lines</h3>'+\n     (canEdit?'<div class=\"row\" style=\"gap:.3rem\"><button class=\"btn sm\" id=\"fromGuide\">+ From guide</button><button class=\"btn ghost sm\" data-add=\"labor\">+ Labor</button><button class=\"btn ghost sm\" data-add=\"part\">+ Part</button><button class=\"btn ghost sm\" data-add=\"fee\">+ Fee</button><button class=\"btn ghost sm\" data-add=\"discount\">+ Discount</button></div>':'')+\n     '</div><div id=\"estPick\"></div><div class=\"scroll\"><table class=\"est\" style=\"margin-top:.6rem\"><tbody id=\"estRows\"></tbody></table></div><div id=\"estPrices\"></div>'+\n     (canEdit?'<div class=\"help\">Labor: quantity is hours. Parts: enter your cost and press % to apply your '+(J.shop.parts_markup_pct||0)+'% markup, or type the price. Lines start as \"Waiting\"; the customer approves them online, or you can set them yourself after a phone OK.</div>':'')+\n     '</div>';\n  h+='<div class=\"totals sec\" id=\"estTotals\"></div>';\n  h+='<div class=\"steel panel sec\"><div class=\"field\"><label>Note to customer (shows on their estimate)</label><textarea id=\"estNotes\" rows=\"2\"'+(canEdit?'':' disabled')+'>'+esc(est.notes||'')+'</textarea></div>'+\n     (canEdit?'<div class=\"row\"><button class=\"btn\" id=\"estSave\">Save estimate</button><button class=\"btn purple\" id=\"estText\"'+(b.phone?'':' disabled title=\"No phone number on this job\"')+'>Save and text to customer</button><button class=\"btn ghost sm\" id=\"estLink\">Get link</button><button class=\"btn ghost sm\" id=\"estQuote\">Quote PDF</button></div>':(J.lines.length?'<div class=\"row\"><button class=\"btn ghost sm\" id=\"estQuote\">Quote PDF</button></div>':''))+\n     '<div id=\"estLinkOut\" class=\"help\" style=\"margin-top:.6rem\">'+(J.estimate_link?'<a class=\"btn ghost sm\" href=\"'+esc(J.estimate_link)+'\" target=\"_blank\" rel=\"noopener\" style=\"margin-right:.5rem\">Preview what the customer sees</a>Customer link: <a href=\"'+esc(J.estimate_link)+'\" target=\"_blank\" rel=\"noopener\">'+esc(J.estimate_link)+'</a>'+(J.quote_link?' · <a href=\"'+esc(J.quote_link)+'\" target=\"_blank\" rel=\"noopener\">Saved quote</a>':'')+(est.sent_at?' (sent '+when(est.sent_at)+')':''):'')+'</div></div>';\n  var auths=est.authorizations||[];\n  if(auths.length) h+='<div class=\"steel panel sec\"><h3>Customer authorizations</h3>'+auths.slice().reverse().map(function(a){\n    return '<div class=\"ev\"><div class=\"k\">'+when(a.at)+'</div><div><b>'+esc(a.name)+'</b> approved '+esc((a.approved||[]).join(', ')||'nothing')+(a.declined&&a.declined.length?'; declined '+esc(a.declined.join(', ')):'')+'. Total '+usd(a.approved_total_cents)+'<div class=\"dim\" style=\"font-size:.78rem\">IP '+esc(a.ip||'')+'</div></div></div>';\n  }).join('')+'</div>';\n  $('#dbody').innerHTML=h;\n  paintLines(canEdit);\n  if($('#estQuote')) $('#estQuote').addEventListener('click', function(){\n    var btn=this, w=window.open('about:blank','_blank'); busy(btn,true,'Building…');\n    (canEdit?saveEstimate():Promise.resolve()).then(function(){ return api('/admin/booking/'+b.id+'/quote',{method:'POST',body:{}}); })\n      .then(function(r){ J.quote_link=r.link; if(w) w.location.href=r.link; else location.href=r.link; busy(btn,false); toast('Quote ready. Tap Save as PDF to download it.'); })\n      .catch(function(e){ if(w) w.close(); toast(e.message,true); busy(btn,false); });\n  });\n  if(canEdit){\n    $('#fromGuide').addEventListener('click', function(){\n      guidePicker($('#estPick'), {vehicle:function(){ return J.booking.vehicle||''; }, rate:J.shop.labor_rate_cents, markup:J.shop.parts_markup_pct,\n        onAdd:function(lines, r){ J.lines=J.lines.concat(lines); paintLines(true); toast('Added '+r.name+'. Save the estimate when done.'); }});\n    });\n    $$('[data-add]').forEach(function(btn){ btn.addEventListener('click', function(){\n      var t=btn.dataset.add, l={id:'',type:t,desc:'',qty:1,unit_cents:0,status:'pending'};\n      if(t==='labor'){ l.unit_cents=J.shop.labor_rate_cents||0; }\n      if(t==='discount'&&J.voucher&&['active','applied'].indexOf(J.voucher.status)>-1){ l.desc='Reward '+J.voucher.code+': '+J.voucher.reward_name; l.unit_cents=J.voucher.value_cents; l.status='approved'; }\n      if(t==='discount') l.status='approved';\n      J.lines.push(l); paintLines(true);\n      var rows=$$('#estRows input[data-f=\"desc\"]'); if(rows.length) rows[rows.length-1].focus();\n    }); });\n    $('#estSave').addEventListener('click', function(){ saveEstimate().then(function(){ toast('Estimate saved'); openJob(b.id,'estimate'); }).catch(function(e){ toast(e.message,true); }); });\n    $('#estText').addEventListener('click', function(){\n      var btn=this; busy(btn,true,'Sending…');\n      saveEstimate().then(function(){ return api('/admin/booking/'+b.id+'/estimate/send',{method:'POST',body:{via:'sms'}}); })\n        .then(function(){ toast('Estimate texted to '+(b.customer_name||'customer')); openJob(b.id,'estimate'); })\n        .catch(function(e){ toast(e.message,true); busy(btn,false); });\n    });\n    $('#estLink').addEventListener('click', function(){\n      saveEstimate().then(function(){ return api('/admin/booking/'+b.id+'/estimate/send',{method:'POST',body:{via:'link'}}); })\n        .then(function(r){ $('#estLinkOut').innerHTML='Customer link: <a href=\"'+esc(r.link)+'\" target=\"_blank\" rel=\"noopener\">'+esc(r.link)+'</a>';\n          if(navigator.clipboard) navigator.clipboard.writeText(r.link).then(function(){ toast('Link copied'); }).catch(function(){}); })\n        .catch(function(e){ toast(e.message,true); });\n    });\n  }\n}\nfunction paintLines(canEdit){\n  var dis=canEdit?'':' disabled';\n  var tl={labor:'Labor',part:'Part',fee:'Fee',discount:'Discount'};\n  $('#estRows').innerHTML = J.lines.length ? '<tr><th style=\"width:92px\">Type</th><th>Description</th><th style=\"width:72px\">Qty / hrs</th><th style=\"width:100px\">Price each</th><th style=\"width:96px\">Amount</th><th style=\"width:120px\">Status</th><th style=\"width:34px\"></th></tr>'+\n    J.lines.map(function(l,i){\n      var amt=Math.round((Number(l.qty)||0)*(Number(l.unit_cents)||0));\n      return '<tr><td><select data-i=\"'+i+'\" data-f=\"type\"'+dis+'>'+['labor','part','fee','discount'].map(function(t){ return '<option value=\"'+t+'\"'+(t===l.type?' selected':'')+'>'+tl[t]+'</option>'; }).join('')+'</select></td>'+\n        '<td><input data-i=\"'+i+'\" data-f=\"desc\" value=\"'+esc(l.desc)+'\" placeholder=\"'+(l.type==='part'?'Part name':'Description')+'\"'+dis+'>'+\n          (l.type==='part'?'<div class=\"row\" style=\"gap:.3rem;margin-top:.3rem;flex-wrap:nowrap\"><input data-i=\"'+i+'\" data-f=\"part_no\" value=\"'+esc(l.part_no||'')+'\" placeholder=\"Part #\" style=\"max-width:120px\"'+dis+'><input data-i=\"'+i+'\" data-f=\"cost\" value=\"'+dollars(l.cost_cents)+'\" placeholder=\"Cost $\" inputmode=\"decimal\" style=\"max-width:90px\"'+dis+'>'+(canEdit?'<button type=\"button\" class=\"btn ghost sm\" data-markup=\"'+i+'\" title=\"Apply markup\">%</button>':'')+'</div>'+'<div class=\"row\" style=\"gap:.35rem;margin-top:.3rem\">'+(canEdit?'<button type=\"button\" class=\"btn ghost sm\" data-prices=\"'+i+'\">Prices</button>':'')+(l.supplier?'<span class=\"chip\">'+esc(supplierName(l.supplier))+'</span>':'')+'</div>':'')+'</td>'+\n        '<td><input data-i=\"'+i+'\" data-f=\"qty\" value=\"'+esc(l.qty)+'\" inputmode=\"decimal\"'+dis+'>'+(canEdit&&DESK()&&l.type==='labor'&&l.guide_id?'<button type=\"button\" class=\"btn ghost sm\" data-savetime=\"'+i+'\" title=\"Use this time next time you quote this vehicle\" style=\"margin-top:.3rem;font-size:.72rem;padding:.15rem .4rem\">Save for this vehicle</button>':'')+'</td>'+\n        '<td><input data-i=\"'+i+'\" data-f=\"unit\" value=\"'+dollars(l.unit_cents)+'\" inputmode=\"decimal\" placeholder=\"0.00\"'+dis+'></td>'+\n        '<td class=\"amt\">'+(l.type==='discount'?'−':'')+usd(amt)+'</td>'+\n        '<td>'+(l.type==='discount'?'<span class=\"chip good\">Applied</span>':'<select data-i=\"'+i+'\" data-f=\"status\"'+dis+'>'+[['pending','Waiting'],['approved','Approved'],['declined','Declined']].map(function(s){ return '<option value=\"'+s[0]+'\"'+(s[0]===(l.status||'pending')?' selected':'')+'>'+s[1]+'</option>'; }).join('')+'</select>')+'</td>'+\n        '<td>'+(canEdit?'<button type=\"button\" class=\"btn danger sm\" data-del=\"'+i+'\" aria-label=\"Remove line\">×</button>':'')+'</td></tr>';\n    }).join('') : '<tr><td class=\"dim\" style=\"padding:1rem 0\">No lines yet. Add labor, parts, or fees.</td></tr>';\n  $$('#estRows [data-prices]').forEach(function(btn){ btn.addEventListener('click', function(){\n    var l=J.lines[+btn.dataset.prices];\n    pricePanel($('#estPrices'), {part:l.desc, partNo:l.part_no, vehicle:J.booking.vehicle, supplier:l.supplier, cost:l.cost_cents, markup:J.shop.parts_markup_pct,\n      onUse:function(r){ l.cost_cents=r.cost_cents; l.supplier=r.supplier; l.unit_cents=Math.round(r.cost_cents*(1+(Number(J.shop.parts_markup_pct)||0)/100)); paintLines(canEdit); toast('Price set. Save the estimate when done.'); }});\n    $('#estPrices').scrollIntoView({block:'nearest'});\n  }); });\n  $$('#estRows [data-f]').forEach(function(inp){ inp.addEventListener('change', function(){\n    var l=J.lines[+inp.dataset.i], f=inp.dataset.f;\n    if(f==='type'){ l.type=inp.value; if(l.type==='discount') l.status='approved'; paintLines(canEdit); return; }\n    if(f==='desc') l.desc=inp.value;\n    if(f==='part_no') l.part_no=inp.value;\n    if(f==='qty') l.qty=parseFloat(inp.value)||0;\n    if(f==='unit') l.unit_cents=cents(inp.value);\n    if(f==='cost') l.cost_cents=inp.value===''?null:cents(inp.value);\n    if(f==='status') l.status=inp.value;\n    if(f!=='desc'&&f!=='part_no') paintLines(canEdit); else paintTotals();\n  }); });\n  $$('#estRows [data-savetime]').forEach(function(btn){ btn.addEventListener('click', function(){\n    var l=J.lines[+btn.dataset.savetime];\n    if(!J.booking.vehicle) return toast('Add the vehicle on the Job tab first', true);\n    api('/admin/guide/job/'+encodeURIComponent(l.guide_id)+'/save-vehicle-time',{method:'POST',body:{vehicle:J.booking.vehicle,labor_hours:l.qty}})\n      .then(function(r){ toast('Saved '+l.qty+' hr for '+r.label); }).catch(function(e){ toast(e.message,true); });\n  }); });\n  $$('#estRows [data-del]').forEach(function(btn){ btn.addEventListener('click', function(){ J.lines.splice(+btn.dataset.del,1); paintLines(canEdit); }); });\n  $$('#estRows [data-markup]').forEach(function(btn){ btn.addEventListener('click', function(){\n    var l=J.lines[+btn.dataset.markup]; if(!l.cost_cents) return toast('Enter the part cost first', true);\n    l.unit_cents=Math.round(l.cost_cents*(1+(Number(J.shop.parts_markup_pct)||0)/100)); paintLines(canEdit);\n  }); });\n  paintTotals();\n}\nfunction calcTotals(lines, keep){\n  var t={labor:0,parts:0,fees:0,discount:0};\n  lines.forEach(function(l){ if(!keep(l)) return; var a=Math.round((Number(l.qty)||0)*(Number(l.unit_cents)||0));\n    if(l.type==='labor') t.labor+=a; else if(l.type==='part') t.parts+=a; else if(l.type==='fee') t.fees+=a; else t.discount+=a; });\n  t.tax=Math.round(t.parts*(Number(J.shop.parts_tax_rate)||0)/100); t.total=Math.max(0,t.labor+t.parts+t.fees-t.discount)+t.tax;\n  var cost=0, hasCost=false; lines.forEach(function(l){ if(keep(l)&&l.type==='part'&&l.cost_cents!=null){ cost+=Math.round((Number(l.qty)||0)*l.cost_cents); hasCost=true; } });\n  t.partsProfit=hasCost?t.parts-cost:null; return t;\n}\nfunction paintTotals(){\n  var q=calcTotals(J.lines,function(l){ return l.status!=='declined'; }), a=calcTotals(J.lines,function(l){ return l.type==='discount'||l.status==='approved'; });\n  var tbl=function(t,title){ return '<div class=\"steel panel\"><h3>'+title+'</h3><table><tr><td>Labor</td><td style=\"text-align:right\">'+usd(t.labor)+'</td></tr><tr><td>Parts</td><td style=\"text-align:right\">'+usd(t.parts)+'</td></tr>'+\n    (t.fees?'<tr><td>Fees</td><td style=\"text-align:right\">'+usd(t.fees)+'</td></tr>':'')+(t.discount?'<tr><td>Discounts</td><td style=\"text-align:right\">−'+usd(t.discount)+'</td></tr>':'')+\n    '<tr><td>Tax on parts ('+(J.shop.parts_tax_rate||0)+'%)</td><td style=\"text-align:right\">'+usd(t.tax)+'</td></tr><tr class=\"big\"><td>Total</td><td style=\"text-align:right\">'+usd(t.total)+'</td></tr>'+\n    (DESK()&&t.partsProfit!=null?'<tr><td class=\"dim\" style=\"font-size:.82rem\">Parts profit (staff only)</td><td class=\"dim\" style=\"text-align:right;font-size:.82rem\">'+usd(t.partsProfit)+'</td></tr>':'')+'</table></div>'; };\n  $('#estTotals').innerHTML=tbl(q,'Quoted (not declined)')+tbl(a,'Approved so far');\n}\nfunction saveEstimate(){\n  var bad=J.lines.filter(function(l){ return !String(l.desc||'').trim(); });\n  if(bad.length) return Promise.reject(new Error('Every line needs a description.'));\n  return api('/admin/booking/'+J.booking.id+'/estimate',{method:'PUT',body:{lines:J.lines,notes:$('#estNotes').value}});\n}\n\n/* Texts tab */\n/* Job text library. The first version of a saved template (Settings → Text message templates) is yours;\n   the rest are alternates in different tones. \"Another version\" cycles through them. */\nvar TONES=[['','Any tone'],['friendly','Friendly'],['pro','Professional'],['short','Short']];\nvar JOB_TEXT_GROUPS=[\n  ['Before the visit',['confirm','reminder_day','need_info','reschedule']],\n  ['Day of',['on_way','late']],\n  ['Estimate & parts',['estimate','approval_nudge','parts_wait']],\n  ['After the job',['complete','payment_due','thanks','review','follow_up']]\n];\nvar JOB_TEXTS={\n  confirm:{label:'Confirm appointment', saved:true, v:[\n    ['pro','Hello {first}, this confirms your {service} appointment with Upper Echelon Automotive on {date}, {window}. Reply here if anything changes.'],\n    ['short','Upper Echelon Automotive: you\\'re booked for {date}, {window}. Reply with any questions.']]},\n  reminder_day:{label:'Reminder for tomorrow', v:[\n    ['friendly','Hi {first}! Quick reminder: Upper Echelon Automotive is coming out tomorrow, {date}, {window}, for your {vehicle}. Reply here if you need to change anything.'],\n    ['pro','Hello {first}, a reminder of your {service} appointment tomorrow ({date}, {window}). Please have the {vehicle} accessible with the keys handy. – Upper Echelon Automotive'],\n    ['short','Reminder: Upper Echelon Automotive tomorrow, {window}. Reply to reschedule.']]},\n  need_info:{label:'Ask for photos / info', v:[\n    ['friendly','Hi {first}, this is Upper Echelon Automotive. To get ready for your {vehicle}, could you text us a photo of any warning lights and tell us when the problem started?'],\n    ['pro','Hello {first}, before your appointment please reply with the VIN (bottom of the windshield, driver side) and current mileage of your {vehicle} so we bring the right parts.'],\n    ['short','Upper Echelon Automotive: can you text a photo of the issue on your {vehicle}? Helps us come prepared.']]},\n  reschedule:{label:'Need to reschedule', v:[\n    ['friendly','Hi {first}, it\\'s Upper Echelon Automotive. We need to move your {service} appointment. What day and time works best for you? Sorry for the hassle.'],\n    ['pro','Hello {first}, due to a scheduling change we need to reschedule your {date} appointment. Please reply with a few times that work and we\\'ll confirm right away. – Upper Echelon Automotive'],\n    ['short','Upper Echelon Automotive: we need to reschedule your {date} visit. What time works for you?']]},\n  on_way:{label:'On my way', eta:true, saved:true, v:[\n    ['pro','Hello {first}, your technician {tech} is en route and should arrive in about {eta}. – Upper Echelon Automotive'],\n    ['short','{tech} from Upper Echelon Automotive is on the way. ETA {eta}.']]},\n  late:{label:'Running late', eta:true, v:[\n    ['friendly','Hi {first}, this is {tech} with Upper Echelon Automotive. I\\'m running a little behind on the job before yours. New arrival: {eta}. Sorry about that!'],\n    ['pro','Hello {first}, we\\'re running behind schedule. Your technician will now arrive in about {eta}. If that no longer works, reply and we\\'ll reschedule. – Upper Echelon Automotive'],\n    ['short','Upper Echelon Automotive is running late. New ETA: {eta}. Sorry!']]},\n  estimate:{label:'Estimate ready', saved:true, v:[\n    ['pro','Hello {first}, the estimate for your {vehicle} is ready. You can approve or decline each item here: {estimate_link}'],\n    ['short','Your Upper Echelon Automotive estimate is ready: {estimate_link}']]},\n  approval_nudge:{label:'Estimate still waiting', link:true, v:[\n    ['friendly','Hi {first}, just checking in. Your estimate for the {vehicle} is still waiting for your OK: {estimate_link} Any questions, reply here.'],\n    ['pro','Hello {first}, your estimate is awaiting approval. We can schedule the work as soon as you approve: {estimate_link}'],\n    ['short','Still need your OK on the {vehicle} estimate: {estimate_link}']]},\n  parts_wait:{label:'Parts ordered', v:[\n    ['friendly','Hi {first}, the parts for your {vehicle} are ordered. We\\'ll text you as soon as they arrive to set up a time to finish the job.'],\n    ['pro','Hello {first}, the parts for your {service} have been ordered. We will contact you to schedule installation once they arrive. – Upper Echelon Automotive'],\n    ['short','Upper Echelon Automotive: parts ordered for your {vehicle}. We\\'ll text when they\\'re in.']]},\n  complete:{label:'Job done + payment link', saved:true, v:[\n    ['pro','Hello {first}, work on your {vehicle} is complete. Your total is {total}. You can pay securely here: {pay_link} Thank you for your business.'],\n    ['short','Your {vehicle} is done! Total {total}. Pay here: {pay_link}']]},\n  payment_due:{label:'Payment reminder', v:[\n    ['friendly','Hi {first}, friendly reminder from Upper Echelon Automotive: your balance of {total} for the {vehicle} is still open. You can pay here: {pay_link}'],\n    ['pro','Hello {first}, our records show an open balance of {total} for your recent service. Please pay at {pay_link} or call {shop_phone} with any questions.'],\n    ['short','Reminder: {total} balance due to Upper Echelon Automotive. Pay here: {pay_link}']]},\n  thanks:{label:'Thank you', v:[\n    ['friendly','Thanks again for choosing Upper Echelon Automotive, {first}! If anything with the {vehicle} doesn\\'t feel right, just reply here.'],\n    ['pro','Hello {first}, thank you for your business. If you have any questions about the work on your {vehicle}, please reply or call {shop_phone}.'],\n    ['short','Thanks for choosing Upper Echelon Automotive, {first}! Reply anytime with questions.']]},\n  review:{label:'Ask for a review', saved:true, v:[\n    ['pro','Hello {first}, thank you for choosing Upper Echelon Automotive. We would appreciate a short Google review of your experience: {review_link}'],\n    ['short','Thanks {first}! Mind leaving us a quick review? {review_link}']]},\n  follow_up:{label:'Recommended work follow-up', saved:true, v:[\n    ['friendly','Hi {first}, it\\'s Upper Echelon Automotive checking in on your {vehicle}. Last time we noted: {recommended}. Want to take care of it before it turns into a bigger repair?'],\n    ['short','Still need {recommended} on your {vehicle}? Reply and we\\'ll set it up.']]}\n};\nfunction jobVersions(k, tpls){\n  var t=JOB_TEXTS[k], out=[]; if(!t) return out;\n  if(t.saved && tpls[k]) out.push(['friendly', tpls[k]]);\n  return out.concat(t.v);\n}\nfunction tabTexts(){\n  var b=J.booking, v=J.sms_vars, tpls=J.shop.sms_templates||{};\n  var sent=(J.events||[]).filter(function(e){ return e.kind==='sms'; });\n  var h='';\n  if(!J.sms_ready) h+='<div class=\"steel panel sec\" style=\"border-color:var(--warn)\">Texting isn\\'t connected yet. Add <b>TEXTBELT_KEY</b> on Render to send texts from here. Until then, use <a href=\"'+smsHref(b.phone)+'\">your phone</a>.</div>';\n  if(!b.phone) h+='<div class=\"steel panel sec\" style=\"border-color:var(--warn)\">No phone number on this job. Add one on the Job tab.</div>';\n  h+='<div class=\"steel panel sec\"><h3>Send a text to '+esc(b.customer_name||'customer')+(b.phone?' <span class=\"dim\">('+esc(b.phone)+')</span>':'')+'</h3>'+\n    JOB_TEXT_GROUPS.map(function(g){ return '<div class=\"tgroup\"><span>'+g[0]+'</span><div class=\"row\">'+g[1].map(function(k){ return '<button type=\"button\" class=\"btn ghost sm\" data-tpl=\"'+k+'\">'+JOB_TEXTS[k].label+'</button>'; }).join('')+'</div></div>'; }).join('')+\n    '<div class=\"row\" style=\"gap:.5rem;margin:.6rem 0 .7rem\"><div class=\"seg\" id=\"toneSeg\">'+TONES.map(function(t){ return '<button type=\"button\" data-tone=\"'+t[0]+'\" class=\"'+(t[0]===(S.tone||'')?'on good':'')+'\">'+t[1]+'</button>'; }).join('')+'</div>'+\n      '<button type=\"button\" class=\"btn ghost sm\" id=\"tplNext\" disabled>↻ Another version</button></div>'+\n    '<div id=\"etaRow\" class=\"field hide\"><label>Arrival time to tell them</label><input id=\"eta\" placeholder=\"e.g. 20 minutes, or 10:45 AM\"></div>'+\n    '<textarea id=\"smsText\" rows=\"4\" placeholder=\"Pick a template or write your own message\"></textarea>'+\n    '<div class=\"row\" style=\"justify-content:space-between;margin-top:.5rem\"><span class=\"help\" id=\"smsCount\"></span><button class=\"btn\" id=\"smsSend\"'+(b.phone&&J.sms_ready?'':' disabled')+'>Send text</button></div></div>';\n  h+='<div class=\"steel panel\"><h3>Texts sent</h3>'+(sent.length?sent.map(function(e){ return '<div class=\"ev\"><div class=\"k\">'+when(e.at)+'<br>'+esc(e.by_name||'')+'</div><div>'+esc(e.text)+'</div></div>'; }).join(''):'<div class=\"dim\">No texts sent from the portal yet.</div>')+'</div>';\n  $('#dbody').innerHTML=h;\n  var kind=null, ver=0;\n  function versions(k){ var all=jobVersions(k,tpls), tone=S.tone||''; var f=tone?all.filter(function(x){ return x[0]===tone; }):all; return f.length?f:all; }\n  function setTpl(k, keepVer){\n    if(k!==kind||!keepVer) ver=keepVer?ver:0;\n    kind=k; var t=JOB_TEXTS[k]||{}; $('#etaRow').classList.toggle('hide', !t.eta);\n    $$('[data-tpl]').forEach(function(b){ b.classList.toggle('picked', b.dataset.tpl===k); });\n    var list=versions(k); ver=ver%list.length;\n    $('#tplNext').disabled=list.length<2; $('#tplNext').textContent='↻ Another version'+(list.length>1?' ('+(ver+1)+' of '+list.length+')':'');\n    var vars=Object.assign({}, v, {eta: $('#eta').value || '[arrival time]'});\n    if(k==='estimate' && !J.estimate_link){ vars.estimate_link='[link is created when you send]'; }\n    if(k==='approval_nudge' && !J.estimate_link){ toast('Send the estimate first (Estimate tab), then nudge them', true); }\n    if((k==='complete'||k==='payment_due') && !J.shop.payment_link) toast('Add your payment portal link in Settings so it appears in this text', true);\n    if(k==='review' && !J.shop.google_review_url) toast('Add your Google review link in Settings so it appears in this text', true);\n    $('#smsText').value=fill(list[ver][1], vars); count();\n  }\n  $('#tplNext').addEventListener('click', function(){ if(!kind) return; ver++; setTpl(kind, true); });\n  $$('[data-tone]').forEach(function(b){ b.addEventListener('click', function(){ S.tone=b.dataset.tone; $$('[data-tone]').forEach(function(x){ x.className=x===b?'on good':''; }); if(kind) setTpl(kind); }); });\n  function count(){ var l=$('#smsText').value.length; $('#smsCount').textContent=l+' characters'+(l>160?' (sends as '+Math.ceil(l/153)+' texts)':''); }\n  $$('[data-tpl]').forEach(function(btn){ btn.addEventListener('click', function(){ setTpl(btn.dataset.tpl); }); });\n  $('#eta').addEventListener('input', function(){ if(kind&&(JOB_TEXTS[kind]||{}).eta) setTpl(kind, true); });\n  $('#smsText').addEventListener('input', count);\n  if(J.preset){ setTpl(J.preset); J.preset=null; if((JOB_TEXTS[kind]||{}).eta) $('#eta').focus(); }\n  $('#smsSend').addEventListener('click', function(){\n    var text=$('#smsText').value.trim(), btn=this;\n    if(!text) return toast('Write a message first', true);\n    if(/\\[arrival time\\]|\\[link is created/.test(text)) return toast((JOB_TEXTS[kind]||{}).eta?'Enter the arrival time first':'Send estimates from the Estimate tab', true);\n    if(kind==='estimate'){ busy(btn,true,'Sending…'); api('/admin/booking/'+b.id+'/estimate/send',{method:'POST',body:{via:'sms',text:J.estimate_link?text:null}}).then(function(){ toast('Estimate texted'); openJob(b.id,'texts'); }).catch(function(e){ toast(e.message,true); busy(btn,false); }); return; }\n    busy(btn,true,'Sending…');\n    api('/admin/booking/'+b.id+'/sms',{method:'POST',body:{text:text,kind:kind}}).then(function(){ toast('Text sent'); openJob(b.id,'texts'); }).catch(function(e){ toast(e.message,true); busy(btn,false); });\n  });\n}\n\n/* Payment tab */\nfunction tabPayment(){\n  var b=J.booking, v=J.voucher, h='';\n  if(b.status!=='cancelled') h+=invoicePanel();\n  if(b.status==='open'){\n    var a=J.totals.approved, q=J.totals.quoted, useA=a.pay_labor+a.pay_parts>0;\n    var lab=useA?a.pay_labor:q.pay_labor, par=useA?a.pay_parts:q.pay_parts;\n    var vnote=v?(['active','applied'].indexOf(v.status)>-1?'<b>'+esc(v.reward_name)+'</b> ('+usd(v.value_cents)+'). Make sure it\\'s on the estimate as a discount.':'Voucher '+esc(v.code)+' is '+esc(v.status)+' and can\\'t be used.'):'';\n    h+='<form id=\"payForm\" class=\"steel panel sec\" style=\"border-color:var(--gold-lo)\"><h3>Mark as paid</h3>'+\n      (lab+par>0?'<div class=\"help\" style=\"margin:-.4rem 0 .8rem\">Filled in from the '+(useA?'approved':'quoted')+' estimate. Change it if the final charge was different.</div>':'')+\n      '<div class=\"grid g2\"><div class=\"field\"><label>Labor and fees charged ($)</label><input name=\"labor\" type=\"number\" step=\"0.01\" min=\"0\" inputmode=\"decimal\" value=\"'+dollars(lab)+'\"></div>'+\n      '<div class=\"field\"><label>Parts charged ($)</label><input name=\"parts\" type=\"number\" step=\"0.01\" min=\"0\" inputmode=\"decimal\" value=\"'+dollars(par)+'\"></div></div>'+\n      '<div class=\"help\" style=\"margin:-.5rem 0 .9rem\">Before tax, after any discount. Points: '+J.rates.labor+' per $1 labor, '+J.rates.parts+' per $1 parts, times their tier. Rush fee lines on the estimate don\\'t earn points. Book-ahead, slow-day and comeback bonuses are added automatically.</div>'+\n      '<div class=\"grid g2\"><div class=\"field\"><label>Paid by</label><select name=\"method\">'+J.payment_methods.map(function(o){return '<option>'+esc(o)+'</option>';}).join('')+'</select></div>'+\n      '<div class=\"field\"><label>Receipt or transaction #</label><input name=\"reference\" placeholder=\"From your card portal\"></div></div>'+\n      '<div class=\"field\"><label>Rewards and credits used</label><input name=\"voucher_code\" value=\"'+esc(b.voucher_code||'')+'\" placeholder=\"UER-XXXXXX (one points reward, plus any credits)\" style=\"text-transform:uppercase\">'+(vnote?'<div class=\"help\">'+vnote+'</div>':'')+\n        ((J.member_vouchers||[]).length?'<div class=\"help\">Customer has: '+J.member_vouchers.map(function(v){ return '<a href=\"#\" data-addv=\"'+esc(v.code)+'\" style=\"color:var(--gold)\">'+esc(v.code)+'</a> '+esc(v.reward_name)+' ('+usd(v.value_cents)+(v.min_cents?', jobs '+usd(v.min_cents)+'+':'')+')'; }).join(' &middot; ')+'. Tap a code to add it, and put each one on the estimate as a discount. One points reward per job; referral credits stack on top.</div>':'')+'</div>'+\n      '<div class=\"row\"><button class=\"btn\">Mark paid</button><span id=\"payPts\" class=\"dim\"></span></div><div id=\"payErr\" class=\"err-text\"></div></form>'+\n      '<div class=\"steel panel\"><h3>Collecting payment</h3><p class=\"dim\" style=\"margin:0 0 .6rem\">Text the customer the total and your payment link, then mark it paid here once the charge goes through.</p><button class=\"btn ghost sm\" id=\"toComplete\">Text \"Job done + payment link\"</button></div>';\n  } else if(b.status==='paid'){\n    h+='<div class=\"steel panel sec\"><h3>Paid '+usd(b.total_cents)+'</h3><div>Labor and fees '+usd(b.labor_cents)+', parts '+usd(b.parts_cents)+'</div>'+\n      '<div class=\"dim\">'+esc(b.payment_method||'')+(b.payment_ref?', #'+esc(b.payment_ref):'')+', '+when(b.paid_at)+'</div>'+\n      (b.voucher_used?'<div class=\"dim\">Voucher '+esc(b.voucher_used)+' used</div>':'')+\n      '<div style=\"margin-top:.4rem\">'+(b.points_awarded!=null?'<span class=\"plus pts\">+'+n(b.points_awarded)+' points</span> awarded':'No points awarded')+'</div></div>'+\n      (OWN()?'<button class=\"btn danger sm\" id=\"bReopen\">Undo payment</button><div class=\"help\">Takes the points back and reopens the job.</div>':'<div class=\"help\">Only the owner can undo a payment.</div>');\n  } else {\n    h+='<div class=\"steel panel\">This job was cancelled. <button class=\"btn ghost sm\" id=\"bRestore\">Restore job</button></div>';\n  }\n  $('#dbody').innerHTML=h;\n  bindInvoicePanel();\n  var f=$('#payForm');\n  if(f){\n    var mult=(J.member&&J.member.is_fleet)?0:(J.tier?Number(J.tier.multiplier)||1:1);\n    var pv=function(){ var l=parseFloat(fe(f,'labor').value)||0, p=parseFloat(fe(f,'parts').value)||0;\n      $('#payPts').textContent=(l+p)>0?'Total '+usd(cents(l+p))+(b.email||J.member?', about '+n(Math.floor((l*J.rates.labor+p*J.rates.parts)*mult))+' points':''):''; };\n    fe(f,'labor').addEventListener('input',pv); fe(f,'parts').addEventListener('input',pv); pv();\n    $$('[data-addv]').forEach(function(a){ a.addEventListener('click', function(e){ e.preventDefault(); var inp=fe(f,'voucher_code'), cur=inp.value.toUpperCase().match(/UER-[A-Z0-9]{6}/g)||[];\n      if(cur.indexOf(a.dataset.addv)<0) cur.push(a.dataset.addv); inp.value=cur.join(', '); }); });\n    $('#toComplete').addEventListener('click', function(){ J.tab='texts'; J.preset='complete'; renderJob(); });\n    f.addEventListener('submit', function(e){\n      e.preventDefault(); $('#payErr').textContent='';\n      var l=parseFloat(fe(f,'labor').value)||0, p=parseFloat(fe(f,'parts').value)||0;\n      if(!(l+p>0)){ $('#payErr').textContent='Enter labor and/or parts.'; return; }\n      if(!confirm('Mark paid: '+usd(cents(l+p))+' by '+fe(f,'method').value+'?')) return;\n      var btn=f.querySelector('button'); busy(btn,true,'Saving…');\n      api('/admin/booking/'+b.id+'/paid',{method:'POST',body:{labor:l,parts:p,method:fe(f,'method').value,reference:fe(f,'reference').value.trim(),voucher_code:fe(f,'voucher_code').value.trim()}})\n        .then(function(r){ toast(r.no_member?'Marked paid. No email, so no points.':r.fleet?'Marked paid. Fleet account, no points.':'Marked paid, '+n(r.points)+' points awarded'+((r.bonuses||[]).indexOf('referral')>-1?'. Their friend got a referral credit':'')); openJob(b.id,'payment'); })\n        .catch(function(err){ $('#payErr').textContent=err.message; busy(btn,false); });\n    });\n  }\n  if($('#bReopen')) $('#bReopen').addEventListener('click', function(){\n    if(!confirm('Undo this payment?'+(b.points_awarded?' '+n(b.points_awarded)+' points will be taken back.':''))) return;\n    api('/admin/booking/'+b.id+'/reopen',{method:'POST'}).then(function(){ toast('Payment undone'); openJob(b.id,'payment'); }).catch(function(e){ toast(e.message,true); });\n  });\n  if($('#bRestore')) $('#bRestore').addEventListener('click', function(){\n    api('/admin/booking/'+b.id+'/restore',{method:'POST'}).then(function(){ toast('Job restored'); openJob(b.id); }).catch(function(e){ toast(e.message,true); });\n  });\n}\n\n/* History tab */\n/* Job costs tab (owner only): what this job really made */\nfunction jobLabel(j){ return [j.order_name||'Phone job', j.customer_name, j.service].filter(Boolean).join(' · '); }\nfunction tabCosts(){\n  var c=J.costs, b=J.booking, el=$('#dbody');\n  if(!c){ el.innerHTML='<div class=\"empty\">Job costs couldn\\'t load. Try reopening the job.</div>'; return; }\n  if(c.setup_needed){ el.innerHTML='<div class=\"steel panel\"><h3>Finish Books setup</h3><p>Run <b>books_migration.sql</b> in Supabase (Books tab shows the steps), then reopen this job to track its costs.</p><button class=\"btn sm\" id=\"toBooks\">Open Books</button></div>';\n    $('#toBooks').addEventListener('click', function(){ closeDrawer(); go('books'); }); return; }\n  var cfg=c.settings, has=function(k){ return cfg.categories.some(function(x){ return x.key===k; }); };\n  var mg=c.income_cents?Math.round(c.profit_cents/c.income_cents*100):0;\n  var tech=(J.techs||[]).filter(function(t){ return t.id===b.tech_id; })[0];\n  var quick=[['parts','Parts'],['fuel','Gas'],['contractor','Tech pay'],['supplies','Supplies']].filter(function(q){ return has(q[0]); });\n  var h='<p class=\"dim\" style=\"margin:0 0 .8rem\">Only you see this tab. Anything you add here also lands in Books.</p>'+\n    '<div class=\"gauges\">'+\n    '<div class=\"gauge\"><b>'+usd(c.income_cents)+'</b><span>'+(c.paid?'Job paid':'Job total (not paid yet)')+'</span><em>'+(c.paid?'Collected':'From the estimate')+'</em></div>'+\n    '<div class=\"gauge\"><b>'+usd(c.costs_cents)+'</b><span>Job costs</span><em>Parts + expenses</em></div>'+\n    '<div class=\"gauge\"><b class=\"'+(c.profit_cents<0?'neg':'')+'\">'+usd(c.profit_cents)+'</b><span>Job profit</span><em>'+(c.income_cents?mg+'% margin':'')+'</em></div></div>';\n  h+='<div class=\"steel panel sec\"><h3>Add a job expense</h3><div class=\"row\" style=\"gap:.4rem\">'+\n    quick.map(function(q){ return '<button class=\"btn ghost sm\" data-qcat=\"'+q[0]+'\">+ '+q[1]+'</button>'; }).join('')+\n    '<button class=\"btn sm\" data-qcat=\"\">+ Other expense</button></div>'+\n    '<p class=\"help\" style=\"margin-bottom:0\">Parts you bought, gas to get there, what you paid the tech, a tow, a rental tool. Snap the receipt while you\\'re at it.</p></div>';\n  h+='<div class=\"steel panel sec\"><h3>Breakdown</h3><div class=\"kv\">'+\n    '<dt>'+(c.paid?'Customer paid':'Estimate total')+'</dt><dd>'+usd(c.job_income_cents)+'</dd>'+\n    (c.extra_income_cents?'<dt>Other money in for this job</dt><dd>'+usd(c.extra_income_cents)+'</dd>':'')+\n    (c.parts_from==='estimate'?'<dt>Parts cost (from estimate)</dt><dd>'+usd(c.parts_est_cents)+(c.parts_missing?' <span class=\"chip warn\">'+c.parts_missing+' part'+(c.parts_missing===1?'':'s')+' missing cost</span>':'')+'</dd>'\n      :'<dt>Parts receipts</dt><dd>'+usd(c.parts_receipts_cents)+'</dd>')+\n    '<dt>Other job expenses</dt><dd>'+usd(c.other_cents)+'</dd>'+\n    '<dt><b>Profit</b></dt><dd><b class=\"'+(c.profit_cents<0?'neg':'')+'\">'+usd(c.profit_cents)+'</b></dd></div>'+\n    (c.parts_from==='estimate'?'<p class=\"help\">Parts cost comes from the cost you enter on each part in the Estimate tab. If you log a parts receipt here instead, the receipt replaces it so nothing is counted twice.</p>':'')+'</div>';\n  h+='<div class=\"steel llist\">'+(c.entries.length?c.entries.map(function(e){ return entryRow(e,cfg); }).join(''):'<div class=\"empty\">No expenses on this job yet.</div>')+'</div>';\n  el.innerHTML=h;\n  var back=function(){ openJob(b.id,'costs'); };\n  var opts=function(cat){ return {booking_id:b.id, job_label:jobLabel(b), category:cat||null, vendor:cat==='contractor'&&tech?tech.name:'', cfg:cfg, done:back}; };\n  $$('#dbody [data-qcat]').forEach(function(q){ q.addEventListener('click', function(){ entrySheet(null,'expense',opts(q.dataset.qcat||'other')); }); });\n  $$('#dbody [data-entry]').forEach(function(r){ r.addEventListener('click', function(){ var e=c.entries.filter(function(x){ return x.id===r.dataset.entry; })[0]; if(e) entrySheet(e,null,{cfg:cfg, done:back}); }); });\n}\n\nfunction tabHistory(){\n  var ev=J.events||[];\n  var h='<div class=\"steel panel sec\"><h3>Add a note</h3><textarea id=\"noteText\" rows=\"2\" placeholder=\"Parts ordered from O\\'Reilly, ETA Thursday. Customer prefers texts after 5 PM.\"></textarea><div class=\"row\" style=\"margin-top:.5rem\"><button class=\"btn sm\" id=\"noteAdd\">Add note</button></div></div>'+\n    '<div class=\"steel panel\">'+(ev.length?ev.map(function(e){\n      var k={note:'Note',status:'Status',sms:'Text sent',estimate:'Estimate',payment:'Payment',edit:'Edit'}[e.kind]||e.kind;\n      return '<div class=\"ev\"><div class=\"k\">'+when(e.at)+'<br>'+esc(e.by_name||'')+'</div><div><span class=\"chip\">'+esc(k)+'</span> '+esc(e.text)+'</div></div>';\n    }).join(''):'<div class=\"dim\">No history yet.</div>')+'</div>';\n  $('#dbody').innerHTML=h;\n  $('#noteAdd').addEventListener('click', function(){\n    var t=$('#noteText').value.trim(); if(!t) return;\n    api('/admin/booking/'+J.booking.id+'/note',{method:'POST',body:{text:t}}).then(function(){ toast('Note added'); openJob(J.booking.id,'history'); }).catch(function(e){ toast(e.message,true); });\n  });\n}\n\n/* ───────── LABOR & PARTS GUIDE ───────── */\nvar META=null;\nfunction loadMeta(){ return META?Promise.resolve(META):api('/admin/meta').then(function(m){ META=m; return m; }); }\nfunction guideToLines(r, rate, markup){\n  var lines=[];\n  if(r.flat_cents!=null) lines.push({type:'fee',desc:r.name,qty:1,unit_cents:r.flat_cents,status:'pending',guide_id:r.id});\n  else if(r.labor_hours>0) lines.push({type:'labor',desc:r.name+' (labor)',qty:r.labor_hours,unit_cents:rate||0,status:'pending',guide_id:r.id});\n  (r.parts||[]).forEach(function(p){ lines.push({type:'part',desc:p.name,part_no:p.part_no||null,qty:Number(p.qty)||1,cost_cents:p.cost_cents||0,\n    unit_cents:Math.round((p.cost_cents||0)*(1+(Number(markup)||0)/100)),status:'pending',guide_id:r.id}); });\n  return lines;\n}\nfunction guideRow(r, rate, markup, opts){\n  opts=opts||{};\n  var partsCost=(r.parts||[]).reduce(function(a,p){ return a+(p.cost_cents||0)*(Number(p.qty)||1); },0);\n  var partsPrice=Math.round(partsCost*(1+(Number(markup)||0)/100));\n  var labor=r.flat_cents!=null?r.flat_cents:Math.round(r.labor_hours*(rate||0));\n  var h=r.history||{};\n  var hist=h.vehicle_times_quoted?'Quoted '+h.vehicle_times_quoted+'× on this make/model, avg '+h.vehicle_avg_hours+' hr':(h.times_quoted?'Quoted '+h.times_quoted+'× before, avg '+h.avg_hours+' hr':'');\n  return '<div class=\"gres\"><div><h4>'+esc(r.name)+'</h4>'+\n    '<div class=\"meta\">'+(r.flat_cents!=null?'Flat '+usd(r.flat_cents):'<b style=\"color:var(--text)\">'+r.labor_hours+' hr</b>')+\n      (r.source==='vehicle'?' <span class=\"chip good\">'+esc(r.override_label)+' time</span>':' <span class=\"chip\">Standard time</span>')+\n      ((r.parts||[]).length?' &middot; '+r.parts.length+' part'+(r.parts.length>1?'s':'')+', est. cost '+usd(partsCost):'')+'</div>'+\n    ((r.parts||[]).length?'<div class=\"meta\">Parts costs are estimates. '+partLinks(r.parts[0].name, opts.vehicleText)+'</div>':'')+\n    (hist?'<div class=\"meta\">'+esc(hist)+'</div>':'')+(r.notes?'<div class=\"meta\" style=\"color:var(--warn)\">'+esc(r.notes)+'</div>':'')+\n    '<div class=\"gbt\" data-gbt=\"'+esc(r.id)+'\"></div></div>'+\n    '<div class=\"gacts\"><div class=\"price\">'+usd(labor+partsPrice)+'</div><div class=\"meta\" style=\"text-align:right\">before tax</div>'+\n      '<button type=\"button\" class=\"btn sm\" data-gadd=\"'+esc(r.id)+'\">Add</button>'+\n      (opts.bookTimes&&r.flat_cents==null?'<button type=\"button\" class=\"btn ghost sm\" data-gbook=\"'+esc(r.id)+'\">Book time</button>':'')+'</div></div>';\n}\nfunction bookTimeHtml(bt, r){\n  var h='<div class=\"btbox\"><div class=\"bthead\">Book time for <b>'+esc(bt.vehicle)+'</b>'+(bt.served_as?' <span class=\"chip warn\">Matched as '+esc(bt.served_as)+'. Confirm engine.</span>':'')+'</div>';\n  if(!bt.matches.length){\n    return h+'<div class=\"meta\">No book time matches “'+esc(bt.job)+'” for this vehicle'+(bt.engines.length?' ('+esc(bt.engines.join(', '))+')':'')+'. Use the standard time or type the hours.</div></div>';\n  }\n  h+=bt.matches.map(function(m,i){\n    return '<div class=\"btrow\"><div><b>'+m.hours+' hr</b> · '+esc(m.job)+'<div class=\"meta\">'+esc(m.engine||'All engines')+\n      (m.engine_match?' <span class=\"chip good\">Engine match</span>':'')+(m.confidence?' <span class=\"chip\">'+esc(m.confidence)+'</span>':'')+\n      (m.check?' <span class=\"chip warn\">Double-check before quoting</span>':'')+'</div></div>'+\n      '<div class=\"row\" style=\"gap:.35rem;flex-wrap:nowrap\"><button type=\"button\" class=\"btn sm\" data-btuse=\"'+i+'\">Use</button><button type=\"button\" class=\"btn ghost sm\" data-btuse=\"'+i+'\" data-save=\"1\">Use + save</button></div></div>';\n  }).join('');\n  h+='<div class=\"meta\">From Open Labor Project'+(bt.cached?' (saved lookup)':'')+(bt.lookups_left!=null?' · '+bt.lookups_left+' lookups left today':'')+'. Times over 3 hours or marked low-confidence need a check.</div></div>';\n  return h;\n}\nfunction guidePicker(el, opts){\n  // opts: vehicle (string), onAdd(lines, result), rate, markup\n  el.innerHTML='<div class=\"gpick\"><div class=\"row\"><input class=\"gq\" placeholder=\"Search a job or part: starter, brakes, water pump…\" style=\"flex:1;min-width:200px\"><button type=\"button\" class=\"btn ghost sm gclose\">Close</button></div>'+\n    '<div class=\"help gveh\"></div><div class=\"list\"><div class=\"dim\" style=\"padding:.6rem\">Loading the guide…</div></div></div>';\n  var q=el.querySelector('.gq'), list=el.querySelector('.list'), t, last=[];\n  function load(){\n    Promise.all([api('/admin/guide/lookup?vehicle='+encodeURIComponent(opts.vehicle()||'')+'&q='+encodeURIComponent(q.value)), loadMeta().catch(function(){ return {}; })]).then(function(all){\n      var d=all[0], meta=all[1]||{};\n      last=d.results; var v=d.vehicle;\n      var rowOpts={bookTimes:!!meta.book_times, vehicleText:[v.year,v.make,v.model].filter(Boolean).join(' ')};\n      el.querySelector('.gveh').innerHTML=v.make?'Times for <b style=\"color:var(--text)\">'+esc([v.year,v.make,v.model].filter(Boolean).join(' '))+'</b>. Vehicle-specific times are used when saved.':'<span style=\"color:var(--warn)\">Add the year, make, and model to see vehicle-specific times.</span>';\n      list.innerHTML=d.results.length?d.results.map(function(r){ return guideRow(r, opts.rate, opts.markup, rowOpts); }).join(''):'<div class=\"dim\" style=\"padding:.6rem\">No guide entries match. Add one under Quotes & labor guide.</div>';\n      $$('[data-gadd]', list).forEach(function(b){ b.addEventListener('click', function(){\n        var r=last.filter(function(x){ return x.id===b.dataset.gadd; })[0]; if(!r) return;\n        if(!opts.rate && r.flat_cents==null && r.labor_hours>0) toast('Labor rate is $0. Set it in Settings → Shop', true);\n        opts.onAdd(guideToLines(r, opts.rate, opts.markup), r);\n        b.textContent='Added ✓'; setTimeout(function(){ b.textContent='Add'; }, 1500);\n      }); });\n      $$('[data-gbook]', list).forEach(function(b){ b.addEventListener('click', function(){\n        var r=last.filter(function(x){ return x.id===b.dataset.gbook; })[0]; if(!r) return;\n        var box=list.querySelector('[data-gbt=\"'+r.id.replace(/\"/g,'')+'\"]');\n        busy(b,true,'Looking up…');\n        api('/admin/guide/booktime?vehicle='+encodeURIComponent(opts.vehicle()||'')+'&job='+encodeURIComponent(r.id)).then(function(bt){\n          box.innerHTML=bookTimeHtml(bt, r);\n          $$('[data-btuse]', box).forEach(function(u){ u.addEventListener('click', function(){\n            var m=bt.matches[+u.dataset.btuse], save=u.dataset.save==='1';\n            var lines=guideToLines(Object.assign({}, r, {labor_hours:m.hours}), opts.rate, opts.markup);\n            opts.onAdd(lines, r);\n            if(save) api('/admin/guide/job/'+encodeURIComponent(r.id)+'/save-vehicle-time',{method:'POST',body:{vehicle:opts.vehicle(),labor_hours:m.hours}})\n              .then(function(x){ toast('Added and saved '+m.hours+' hr for '+x.label); }).catch(function(e){ toast('Added, but not saved: '+e.message, true); });\n            else toast('Added '+m.hours+' hr book time');\n          }); });\n        }).catch(function(e){ box.innerHTML='<div class=\"err-text\">'+esc(e.message)+'</div>'; }).then(function(){ busy(b,false); });\n      }); });\n    }).catch(function(e){ list.innerHTML='<div class=\"err-text\">'+esc(e.message)+'</div>'; });\n  }\n  q.addEventListener('input', function(){ clearTimeout(t); t=setTimeout(load, 250); });\n  q.addEventListener('keydown', function(e){ if(e.key==='Enter') e.preventDefault(); });\n  el.querySelector('.gclose').addEventListener('click', function(){ el.innerHTML=''; if(opts.onClose) opts.onClose(); });\n  load(); q.focus();\n}\nfunction quoteTotals(lines, taxRate){\n  var t={labor:0,parts:0,fees:0,discount:0};\n  lines.forEach(function(l){ var a=Math.round((Number(l.qty)||0)*(Number(l.unit_cents)||0));\n    if(l.type==='labor') t.labor+=a; else if(l.type==='part') t.parts+=a; else if(l.type==='fee') t.fees+=a; else t.discount+=a; });\n  t.tax=Math.round(t.parts*(Number(taxRate)||0)/100); t.total=Math.max(0,t.labor+t.parts+t.fees-t.discount)+t.tax; return t;\n}\n\nVIEWS.guide = function(){\n  loadMeta().then(function(m){\n    S.quote=S.quote||{vehicle:'',vin:'',lines:[]};\n    var Q=S.quote;\n    $('#view').innerHTML='<h2>Quotes &amp; labor guide</h2>'+\n      '<div class=\"steel panel sec\"><h3>Quick quote</h3><p class=\"dim\" style=\"margin:-.4rem 0 .8rem;font-size:.9rem\">Price a job over the phone. Then turn it into a job with the estimate already filled in.</p>'+\n        '<div class=\"grid g2\"><div class=\"field\"><label>Vehicle (year, make, model, engine)</label><input id=\"qVeh\" value=\"'+esc(Q.vehicle)+'\" placeholder=\"2015 Ford F-150 5.0\"></div>'+\n        '<div class=\"field\"><label>VIN (optional)</label><div class=\"row\" style=\"flex-wrap:nowrap\"><input id=\"qVin\" maxlength=\"17\" style=\"text-transform:uppercase\" value=\"'+esc(Q.vin)+'\"><button type=\"button\" class=\"btn ghost sm\" id=\"qVinBtn\">Decode</button></div></div></div>'+\n        '<div class=\"grid g2\"><div class=\"field\"><label>Customer name</label><input id=\"qName\" value=\"'+esc(Q.name||'')+'\" placeholder=\"For sending the quote\"></div>'+\n        '<div class=\"field\"><label>Customer phone</label><input id=\"qPhone\" type=\"tel\" value=\"'+esc(Q.phone||'')+'\" placeholder=\"(512) 555-0100\"></div></div>'+\n        '<div class=\"row\"><button type=\"button\" class=\"btn sm\" id=\"qAdd\">+ Add from guide</button><button type=\"button\" class=\"btn ghost sm\" id=\"qCustom\">+ Custom line</button></div>'+\n        '<div id=\"qPick\"></div><div class=\"scroll\"><table class=\"est\" style=\"margin-top:.6rem\"><tbody id=\"qRows\"></tbody></table></div>'+\n        '<div id=\"qTot\" style=\"margin-top:.6rem\"></div>'+\n        '<div class=\"row\" style=\"margin-top:.8rem\"><button type=\"button\" class=\"btn\" id=\"qSend\">Text quote to customer</button><button type=\"button\" class=\"btn purple\" id=\"qJob\">Create job from this quote</button><button type=\"button\" class=\"btn ghost sm\" id=\"qCopy\">Copy quote as text</button><button type=\"button\" class=\"btn danger sm\" id=\"qClear\">Clear</button></div>'+\n        (m.labor_rate_cents?'':'<div class=\"help\" style=\"color:var(--warn)\">Your labor rate is $0. Set it in Settings → Shop (owner) so labor prices fill in.</div>')+\n      '</div>'+\n      '<div class=\"steel panel\"><div class=\"row\" style=\"justify-content:space-between\"><h3 style=\"margin:0\">Guide</h3><button type=\"button\" class=\"btn ghost sm\" id=\"gNew\">+ New guide entry</button></div>'+\n        '<p class=\"dim\" style=\"font-size:.88rem;margin:.4rem 0 .8rem\">Starting times are general estimates, not book times. Adjust them to your real numbers. Save vehicle-specific times as you quote, and the guide gets more accurate on its own.</p>'+\n        '<div class=\"row\" style=\"margin-bottom:.6rem\"><input id=\"gQ\" placeholder=\"Search the guide\" style=\"flex:1;min-width:200px\"><select id=\"gCat\" style=\"width:auto\"><option value=\"\">All categories</option></select></div>'+\n        '<div id=\"gList\"><div class=\"empty\">Loading…</div></div></div>';\n    function paintQuote(){\n      var rows=Q.lines.map(function(l,i){ var amt=Math.round((Number(l.qty)||0)*(Number(l.unit_cents)||0));\n        return '<tr><td><input data-qi=\"'+i+'\" data-qf=\"desc\" value=\"'+esc(l.desc)+'\"></td><td style=\"width:80px\"><input data-qi=\"'+i+'\" data-qf=\"qty\" value=\"'+esc(l.qty)+'\" inputmode=\"decimal\"></td>'+\n          '<td style=\"width:105px\"><input data-qi=\"'+i+'\" data-qf=\"unit\" value=\"'+dollars(l.unit_cents)+'\" inputmode=\"decimal\"></td><td class=\"amt\" style=\"width:95px\">'+(l.type==='discount'?'−':'')+usd(amt)+'</td>'+\n          '<td style=\"width:34px\"><button type=\"button\" class=\"btn danger sm\" data-qdel=\"'+i+'\">×</button></td></tr>'; }).join('');\n      $('#qRows').innerHTML=Q.lines.length?'<tr><th>Line</th><th>Qty / hrs</th><th>Price each</th><th>Amount</th><th></th></tr>'+rows:'<tr><td class=\"dim\" style=\"padding:.6rem 0\">No lines yet. Add jobs from the guide.</td></tr>';\n      var t=quoteTotals(Q.lines, m.parts_tax_rate);\n      $('#qTot').innerHTML=Q.lines.length?'<div class=\"row\" style=\"justify-content:flex-end;gap:1.2rem;font-size:.92rem\"><span class=\"dim\">Labor &amp; fees '+usd(t.labor+t.fees-t.discount)+'</span><span class=\"dim\">Parts '+usd(t.parts)+'</span><span class=\"dim\">Tax '+usd(t.tax)+'</span><span style=\"font-family:var(--head);font-size:1.2rem;color:var(--gold-hi)\">Total '+usd(t.total)+'</span></div>':'';\n      $$('[data-qf]').forEach(function(inp){ inp.addEventListener('change', function(){ var l=Q.lines[+inp.dataset.qi], f=inp.dataset.qf;\n        if(f==='desc') l.desc=inp.value; else if(f==='qty') l.qty=parseFloat(inp.value)||0; else l.unit_cents=cents(inp.value); paintQuote(); }); });\n      $$('[data-qdel]').forEach(function(b){ b.addEventListener('click', function(){ Q.lines.splice(+b.dataset.qdel,1); paintQuote(); }); });\n    }\n    paintQuote();\n    $('#qVeh').addEventListener('input', function(){ Q.vehicle=this.value; });\n    $('#qName').addEventListener('input', function(){ Q.name=this.value; });\n    $('#qPhone').addEventListener('input', function(){ Q.phone=this.value; });\n    $('#qSend').addEventListener('click', function(){\n      if(!Q.lines.length) return toast('Add lines first', true);\n      if(!Q.name||!Q.phone) return toast('Enter the customer\\'s name and phone', true);\n      var btn=this; busy(btn,true,'Sending…');\n      var names=[]; Q.lines.forEach(function(l){ if(l.type!=='part'){ var n2=l.desc.replace(/ \\(labor\\)$/,''); if(names.indexOf(n2)<0) names.push(n2); } });\n      api('/admin/jobs',{method:'POST',body:{customer_name:Q.name,phone:Q.phone,vehicle:Q.vehicle,vin:Q.vin,service:names.join(', ').slice(0,190),estimate_lines:Q.lines,source_note:'quick quote'}})\n        .then(function(r){ return api('/admin/booking/'+r.booking_id+'/estimate/send',{method:'POST',body:{via:'sms'}}).then(function(){ return r; }); })\n        .then(function(r){ toast('Quote texted to '+Q.name+'. It\\'s saved as a job.'); S.quote=null; go('jobs'); openJob(r.booking_id,'estimate'); })\n        .catch(function(e){ toast(e.message,true); busy(btn,false); });\n    });\n    $('#qVin').addEventListener('input', function(){ Q.vin=this.value; });\n    $('#qVinBtn').addEventListener('click', function(){ decodeVin($('#qVin'), $('#qVeh')); setTimeout(function(){ Q.vehicle=$('#qVeh').value; Q.vin=$('#qVin').value; }, 1500); });\n    $('#qAdd').addEventListener('click', function(){ guidePicker($('#qPick'), {vehicle:function(){ return $('#qVeh').value; }, rate:m.labor_rate_cents, markup:m.parts_markup_pct,\n      onAdd:function(lines){ Q.lines=Q.lines.concat(lines); paintQuote(); }}); });\n    $('#qCustom').addEventListener('click', function(){ Q.lines.push({type:'labor',desc:'Labor',qty:1,unit_cents:m.labor_rate_cents||0,status:'pending'}); paintQuote(); });\n    $('#qClear').addEventListener('click', function(){ if(Q.lines.length && !confirm('Clear this quote?')) return; S.quote={vehicle:'',vin:'',lines:[]}; VIEWS.guide(); });\n    $('#qCopy').addEventListener('click', function(){\n      if(!Q.lines.length) return toast('Add lines first', true);\n      var t=quoteTotals(Q.lines, m.parts_tax_rate);\n      var txt='Upper Echelon Automotive estimate'+(Q.vehicle?' for '+Q.vehicle:'')+'\\n'+Q.lines.map(function(l){ return '- '+l.desc+': '+usd(Math.round(l.qty*l.unit_cents)); }).join('\\n')+'\\nTax on parts: '+usd(t.tax)+'\\nTotal: '+usd(t.total)+'\\nFinal price confirmed after inspection.';\n      (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(function(){ toast('Quote copied'); }).catch(function(){ prompt('Copy this quote:', txt); });\n    });\n    $('#qJob').addEventListener('click', function(){\n      if(!Q.lines.length) return toast('Add lines first', true);\n      var names=[]; Q.lines.forEach(function(l){ if(l.type!=='part'){ var n=l.desc.replace(/ \\(labor\\)$/,''); if(names.indexOf(n)<0) names.push(n); } });\n      S.prefill={vehicle:Q.vehicle, vin:Q.vin, service:names.join(', ').slice(0,190), estimate_lines:Q.lines.slice()};\n      go('new');\n    });\n    loadGuideList();\n  }).catch(fail);\n};\nfunction loadGuideList(){\n  api('/admin/guide').then(function(d){\n    var cats=[]; d.jobs.forEach(function(j){ if(cats.indexOf(j.category)<0) cats.push(j.category); });\n    var sel=$('#gCat'); if(sel.options.length<=1) sel.insertAdjacentHTML('beforeend', cats.map(function(c){ return '<option>'+esc(c)+'</option>'; }).join(''));\n    function paint(){\n      var q=$('#gQ').value.toLowerCase(), c=$('#gCat').value;\n      var rows=d.jobs.filter(function(j){ return (!c||j.category===c) && (!q || (j.name+' '+(j.parts||[]).map(function(p){return p.name;}).join(' ')).toLowerCase().indexOf(q)>-1); });\n      $('#gList').innerHTML=rows.length?'<div class=\"scroll\"><table><tr><th>Job</th><th>Category</th><th>Time</th><th>Parts cost</th><th>Vehicle times</th></tr>'+rows.map(function(j){\n        var pc=(j.parts||[]).reduce(function(a,p){ return a+(p.cost_cents||0)*(Number(p.qty)||1); },0);\n        return '<tr class=\"click\" data-gj=\"'+esc(j.id)+'\"><td>'+esc(j.name)+(j.active?'':' <span class=\"chip bad\">Off</span>')+'</td><td class=\"dim\">'+esc(j.category)+'</td><td>'+(j.flat_cents!=null?'Flat '+usd(j.flat_cents):j.labor_hours+' hr')+'</td><td>'+(pc?usd(pc):'—')+'</td><td class=\"dim\">'+(j.override_count||'—')+'</td></tr>';\n      }).join('')+'</table></div>':'<div class=\"empty\">Nothing matches.</div>';\n      $$('[data-gj]').forEach(function(tr){ tr.addEventListener('click', function(){ openGuideJob(tr.dataset.gj); }); });\n    }\n    paint();\n    var t; $('#gQ').oninput=function(){ clearTimeout(t); t=setTimeout(paint,150); };\n    $('#gCat').onchange=paint;\n    $('#gNew').onclick=function(){ openGuideJob(null); };\n  }).catch(function(e){ $('#gList').innerHTML='<div class=\"empty\">'+esc(e.message)+(/relation|does not exist|schema cache/i.test(e.message)?' Run 5-labor-parts-guide.sql in Supabase first.':'')+'</div>'; });\n}\nfunction partsEditor(el, parts){\n  var P=JSON.parse(JSON.stringify(parts||[]));\n  function paint(){\n    el.innerHTML='<table class=\"parts-ed\"><tr><th>Part</th><th style=\"width:110px\">Part #</th><th style=\"width:60px\">Qty</th><th style=\"width:95px\">Your cost $</th><th style=\"width:34px\"></th></tr>'+\n      P.map(function(p,i){ return '<tr><td><input data-pi=\"'+i+'\" data-pf=\"name\" value=\"'+esc(p.name)+'\"></td><td><input data-pi=\"'+i+'\" data-pf=\"part_no\" value=\"'+esc(p.part_no||'')+'\"></td><td><input data-pi=\"'+i+'\" data-pf=\"qty\" value=\"'+esc(p.qty||1)+'\" inputmode=\"decimal\"></td><td><input data-pi=\"'+i+'\" data-pf=\"cost\" value=\"'+dollars(p.cost_cents)+'\" inputmode=\"decimal\"></td><td><button type=\"button\" class=\"btn danger sm\" data-pdel=\"'+i+'\">×</button></td></tr>'; }).join('')+\n      '</table><button type=\"button\" class=\"btn ghost sm\" data-padd>+ Part</button>';\n    $$('[data-pf]', el).forEach(function(inp){ inp.addEventListener('change', function(){ var p=P[+inp.dataset.pi], f=inp.dataset.pf;\n      if(f==='cost') p.cost_cents=cents(inp.value); else if(f==='qty') p.qty=parseFloat(inp.value)||1; else p[f]=inp.value; }); });\n    $$('[data-pdel]', el).forEach(function(b){ b.addEventListener('click', function(){ P.splice(+b.dataset.pdel,1); paint(); }); });\n    el.querySelector('[data-padd]').addEventListener('click', function(){ P.push({name:'',qty:1,cost_cents:0}); paint(); });\n  }\n  paint();\n  return function(){ return P.filter(function(p){ return String(p.name||'').trim(); }); };\n}\nfunction openGuideJob(id){\n  J=null; var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide'); sh.innerHTML='<div class=\"empty\">Loading…</div>';\n  (id?api('/admin/guide/job/'+encodeURIComponent(id)):Promise.resolve({job:{name:'',category:'Other',labor_hours:1,flat_cents:null,parts:[],notes:'',active:true},overrides:[]})).then(function(x){\n    var j=x.job, flat=j.flat_cents!=null;\n    sh.innerHTML='<div class=\"row\" style=\"justify-content:space-between\"><h2 style=\"margin:0\">'+(id?esc(j.name):'New guide entry')+'</h2><button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button></div>'+\n      '<form id=\"gForm\" class=\"steel panel sec\" style=\"margin-top:1rem\"><div class=\"grid g2\">'+fld('Job name','name',j.name)+fld('Category','category',j.category)+'</div>'+\n        '<div class=\"row\" style=\"margin-bottom:.8rem\"><label class=\"row\" style=\"color:var(--text);font-family:var(--body);margin:0\"><input type=\"radio\" name=\"kind\" value=\"hours\"'+(flat?'':' checked')+'> Priced by labor hours</label><label class=\"row\" style=\"color:var(--text);font-family:var(--body);margin:0\"><input type=\"radio\" name=\"kind\" value=\"flat\"'+(flat?' checked':'')+'> Flat price</label></div>'+\n        '<div class=\"grid g2\"><div class=\"field\" id=\"hoursF\"><label>Standard labor hours</label><input name=\"labor_hours\" type=\"number\" step=\"0.1\" min=\"0\" value=\"'+esc(j.labor_hours)+'\"></div><div class=\"field\" id=\"flatF\"><label>Flat price ($)</label><input name=\"flat\" type=\"number\" step=\"0.01\" min=\"0\" value=\"'+(flat?dollars(j.flat_cents):'')+'\"></div></div>'+\n        '<label>Standard parts</label><div id=\"gParts\"></div>'+\n        '<div class=\"field\" style=\"margin-top:.8rem\"><label>Notes (shown when quoting)</label><input name=\"notes\" value=\"'+esc(j.notes||'')+'\"></div>'+\n        '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" name=\"active\"'+(j.active!==false?' checked':'')+'> Show this job when quoting</label>'+\n        '<div class=\"row\" style=\"margin-top:.8rem\"><button class=\"btn\">Save</button>'+(j.updated_by?'<span class=\"help\">Last edited by '+esc(j.updated_by)+'</span>':'')+'</div></form>'+\n      (id?'<div class=\"steel panel sec\"><h3>Vehicle-specific times</h3><p class=\"dim\" style=\"font-size:.88rem;margin-top:-.4rem\">When a quote matches one of these, its time and parts replace the standard ones. The most specific match wins.</p><div id=\"ovList\"></div>'+\n        '<h3 style=\"margin-top:1rem\">Add a vehicle time</h3><form id=\"ovForm\"><div class=\"grid g3\">'+fld('Make','make','')+fld('Model (optional)','model','')+fld('Engine (optional)','engine','','','text')+\n        fld('Year from','year_from','','','number')+fld('Year to','year_to','','','number')+fld('Labor hours','labor_hours','','','number')+'</div>'+\n        '<label>Parts for this vehicle (optional, replaces the standard parts)</label><div id=\"ovParts\"></div>'+fld('Notes','notes','')+\n        '<button class=\"btn sm\">Add vehicle time</button></form></div>':'');\n    $('#closeDrawer').addEventListener('click', function(){ closeDrawer(); });\n    var getParts=partsEditor($('#gParts'), j.parts);\n    var f=$('#gForm');\n    function kind(){ var k=$$('input[name=\"kind\"]', f).filter(function(r){ return r.checked; })[0].value; $('#hoursF').classList.toggle('hide', k==='flat'); $('#flatF').classList.toggle('hide', k!=='flat'); return k; }\n    $$('input[name=\"kind\"]', f).forEach(function(r){ r.addEventListener('change', kind); }); kind();\n    f.addEventListener('submit', function(e){ e.preventDefault();\n      var k=kind(), body={name:fe(f,'name').value,category:fe(f,'category').value,labor_hours:parseFloat(fe(f,'labor_hours').value)||0,\n        flat_cents:k==='flat'?cents(fe(f,'flat').value):null,parts:getParts(),notes:fe(f,'notes').value,active:fe(f,'active').checked};\n      api(id?'/admin/guide/job/'+encodeURIComponent(id):'/admin/guide',{method:id?'PUT':'POST',body:body}).then(function(r){ toast('Guide saved'); openGuideJob(r.job.id); }).catch(function(e){ toast(e.message,true); });\n    });\n    if(id){\n      $('#ovList').innerHTML=x.overrides.length?'<table>'+x.overrides.map(function(o){\n        var lbl=[o.year_from&&o.year_to?(o.year_from===o.year_to?o.year_from:o.year_from+'–'+o.year_to):o.year_from?o.year_from+'+':o.year_to?'up to '+o.year_to:'', o.make, o.model, o.engine].filter(Boolean).join(' ');\n        return '<tr><td>'+esc(lbl)+'<div class=\"dim\" style=\"font-size:.8rem\">'+(o.updated_by?'by '+esc(o.updated_by):'')+(o.notes?' &middot; '+esc(o.notes):'')+'</div></td><td>'+(o.labor_hours!=null?o.labor_hours+' hr':'standard time')+'</td><td class=\"dim\">'+(o.parts?o.parts.length+' parts':'standard parts')+'</td><td><button class=\"btn danger sm\" data-ovdel=\"'+o.id+'\">Remove</button></td></tr>';\n      }).join('')+'</table>':'<div class=\"dim\">None yet. Add one below, or tap \"Save for this vehicle\" on an estimate line.</div>';\n      $$('[data-ovdel]').forEach(function(b){ b.addEventListener('click', function(){ if(!confirm('Remove this vehicle time?')) return;\n        api('/admin/guide/overrides/'+b.dataset.ovdel,{method:'DELETE'}).then(function(){ toast('Removed'); openGuideJob(id); }).catch(function(e){ toast(e.message,true); }); }); });\n      var getOvParts=partsEditor($('#ovParts'), []);\n      $('#ovForm').addEventListener('submit', function(e){ e.preventDefault(); var o=e.target;\n        api('/admin/guide/job/'+encodeURIComponent(id)+'/overrides',{method:'POST',body:{make:fe(o,'make').value,model:fe(o,'model').value,engine:fe(o,'engine').value,\n          year_from:fe(o,'year_from').value,year_to:fe(o,'year_to').value,labor_hours:fe(o,'labor_hours').value,notes:fe(o,'notes').value,parts:getOvParts()}})\n          .then(function(){ toast('Vehicle time added'); openGuideJob(id); }).catch(function(err){ toast(err.message,true); });\n      });\n    }\n  }).catch(function(e){ sh.innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\n\n/* ───────── NEW JOB ───────── */\nVIEWS['new'] = function(){\n  var p=S.prefill||{}; S.prefill=null;\n  Promise.all([api('/admin/techs'), api('/admin/meta')]).then(function(r){\n    var techs=r[0].techs, windows=r[1].time_windows||[], methods=r[1].payment_methods||[];\n    var h='<h2>New job</h2><p class=\"dim\" style=\"margin:-.6rem 0 1rem;max-width:640px\">For phone calls, texts, and repeat customers. Website bookings show up in Jobs on their own.</p>'+\n    (p.estimate_lines&&p.estimate_lines.length?'<div class=\"steel panel sec\" style=\"border-color:var(--gold-lo)\">The quote you built ('+p.estimate_lines.length+' line'+(p.estimate_lines.length>1?'s':'')+') will be added to this job\\'s estimate.</div>':'')+\n    '<form id=\"nj\" style=\"max-width:820px\">'+\n    '<div class=\"steel panel sec\"><h3>Customer</h3>'+\n      '<div class=\"field\"><label>Find an existing customer</label><input id=\"njFind\" placeholder=\"Search name, email, or phone\" autocomplete=\"off\"><div id=\"njRes\"></div><div id=\"njPicked\" class=\"help\"></div></div>'+\n      '<div class=\"grid g2\">'+fld('Name','customer_name',p.customer_name)+fld('Phone','phone',p.phone,'','tel')+fld('Email (for rewards points)','email',p.email,'','email')+fld('Service address','address',p.address)+'</div></div>'+\n    '<div class=\"steel panel sec\"><h3>Vehicle</h3><div id=\"njVeh\"></div><div class=\"grid g2\">'+fld('Year, make, model','vehicle',p.vehicle)+\n      '<div class=\"field\"><label>VIN</label><div class=\"row\" style=\"flex-wrap:nowrap\"><input name=\"vin\" maxlength=\"17\" style=\"text-transform:uppercase\" value=\"'+esc(p.vin||'')+'\"><button type=\"button\" class=\"btn ghost sm\" id=\"njVin\">Decode</button></div></div>'+\n      fld('Mileage','mileage','','','text','numeric')+fld('Plate','plate',p.plate||'')+'</div></div>'+\n    '<div class=\"steel panel sec\"><h3>Work</h3>'+fld('Service','service',p.service)+\n      '<div class=\"field\"><label>Customer concern</label><textarea name=\"concern\" rows=\"3\" placeholder=\"What the customer described, when it happens, warning lights\">'+esc(p.concern||'')+'</textarea></div></div>'+\n    '<div class=\"steel panel sec\"><h3>Schedule</h3><div class=\"grid g3\">'+\n      '<div class=\"field\"><label>Date</label><input type=\"date\" name=\"sched_date\" value=\"'+esc(p.sched_date||'')+'\"></div>'+\n      '<div class=\"field\"><label>Time window</label><select name=\"sched_window\"><option value=\"\">Choose</option>'+windows.map(function(w){return '<option>'+esc(w)+'</option>';}).join('')+'</select></div>'+\n      '<div class=\"field\"><label>Technician</label><select name=\"tech_id\"><option value=\"\">Unassigned</option>'+techs.map(function(t){return '<option value=\"'+t.id+'\">'+esc(t.name)+'</option>';}).join('')+'</select></div></div>'+\n      '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" name=\"rush\"> Rush / emergency</label></div>'+\n    '<div class=\"steel panel sec\"><label class=\"row\" style=\"color:var(--text);font-family:var(--head);font-size:1rem\"><input type=\"checkbox\" id=\"njPaid\"> This job is already done and paid</label>'+\n      '<div id=\"njPayBox\" class=\"hide\" style=\"margin-top:.8rem\"><div class=\"grid g2\">'+\n      '<div class=\"field\"><label>Labor and fees charged ($)</label><input name=\"p_labor\" type=\"number\" step=\"0.01\" min=\"0\"></div><div class=\"field\"><label>Parts charged ($)</label><input name=\"p_parts\" type=\"number\" step=\"0.01\" min=\"0\"></div>'+\n      '<div class=\"field\"><label>Paid by</label><select name=\"p_method\">'+methods.map(function(o){return '<option>'+esc(o)+'</option>';}).join('')+'</select></div><div class=\"field\"><label>Receipt or transaction #</label><input name=\"p_ref\"></div></div>'+\n      '<div class=\"field\"><label>Reward voucher used</label><input name=\"p_voucher\" placeholder=\"UER-XXXXXX (optional)\" style=\"text-transform:uppercase\"></div></div></div>'+\n    '<div class=\"row\"><button class=\"btn\">Create job</button><span id=\"njErr\" class=\"err-text\"></span></div></form>';\n    $('#view').innerHTML=h;\n    var f=$('#nj'), picked=p.member_id?{id:p.member_id}:null, t;\n    if(picked) $('#njPicked').textContent='Linked to existing customer.';\n    function showVehicles(list){\n      $('#njVeh').innerHTML=(list||[]).length?'<div class=\"help\" style=\"margin:-.3rem 0 .6rem\">On file: '+list.map(function(v,i){ return '<button type=\"button\" class=\"chip gold\" data-vpick=\"'+i+'\" style=\"cursor:pointer;border:0\">'+esc(v.description)+'</button>'; }).join(' ')+'</div>':'';\n      $$('[data-vpick]').forEach(function(b){ b.addEventListener('click', function(){ var v=list[+b.dataset.vpick];\n        fe(f,'vehicle').value=v.description||''; fe(f,'vin').value=v.vin||''; fe(f,'plate').value=v.plate||''; fe(f,'mileage').value=v.mileage||''; }); });\n    }\n    showVehicles(p.vehicles);\n    $('#njPaid').addEventListener('change', function(){ $('#njPayBox').classList.toggle('hide', !this.checked); });\n    $('#njVin').addEventListener('click', function(){ decodeVin(fe(f,'vin'), fe(f,'vehicle')); });\n    $('#njFind').addEventListener('keydown', function(e){ if(e.key==='Enter') e.preventDefault(); });\n    $('#njFind').addEventListener('input', function(){\n      clearTimeout(t); var q=this.value.trim(); if(q.length<2){ $('#njRes').innerHTML=''; return; }\n      t=setTimeout(function(){ api('/admin/members?q='+encodeURIComponent(q)).then(function(d){\n        $('#njRes').innerHTML=d.members.slice(0,6).map(function(m,i){ return '<button type=\"button\" class=\"btn ghost sm\" data-pi=\"'+i+'\" style=\"display:block;width:100%;text-align:left;margin-top:.3rem\">'+esc(m.name||'—')+' <span class=\"dim\">'+esc(m.phone||'')+' '+esc(m.email||'')+((m.vehicles||[]).length?' · '+esc(m.vehicles.map(function(v){ return v.description; }).join(', ')):'')+'</span></button>'; }).join('')||'<div class=\"help\">No match. Fill in the fields below.</div>';\n        $$('#njRes [data-pi]').forEach(function(b){ b.addEventListener('click', function(){\n          var m=d.members[+b.dataset.pi]; picked=m; $('#njRes').innerHTML=''; $('#njFind').value='';\n          fe(f,'customer_name').value=m.name||''; fe(f,'email').value=m.email||''; fe(f,'phone').value=m.phone||''; if(m.address) fe(f,'address').value=m.address;\n          var vs=m.vehicles||[]; showVehicles(vs);\n          if(vs.length===1){ fe(f,'vehicle').value=vs[0].description||''; fe(f,'vin').value=vs[0].vin||''; fe(f,'plate').value=vs[0].plate||''; }\n          $('#njPicked').textContent='Linked to '+(m.name||m.email)+'. Their earlier jobs and vehicles show on the job.';\n        }); });\n      }); }, 250);\n    });\n    f.addEventListener('submit', function(e){\n      e.preventDefault(); $('#njErr').textContent='';\n      var body={member_id:picked?picked.id:null,customer_name:fe(f,'customer_name').value,phone:fe(f,'phone').value,email:fe(f,'email').value,address:fe(f,'address').value,\n        vehicle:fe(f,'vehicle').value,vin:fe(f,'vin').value,mileage:fe(f,'mileage').value,plate:fe(f,'plate').value,service:fe(f,'service').value,concern:fe(f,'concern').value,\n        sched_date:fe(f,'sched_date').value,sched_window:fe(f,'sched_window').value,tech_id:fe(f,'tech_id').value,rush:fe(f,'rush').checked};\n      if(p.estimate_lines&&p.estimate_lines.length) body.estimate_lines=p.estimate_lines;\n      if($('#njPaid').checked) body.paid={labor:fe(f,'p_labor').value,parts:fe(f,'p_parts').value,method:fe(f,'p_method').value,reference:fe(f,'p_ref').value,voucher_code:fe(f,'p_voucher').value};\n      var btn=f.querySelector('button.btn:not(.ghost)'); busy(btn,true,'Creating…');\n      api('/admin/jobs',{method:'POST',body:body}).then(function(r){\n        if(p.estimate_lines) S.quote=null;\n        toast(r.award?'Job created and marked paid, '+n(r.award.points)+' points':'Job created'); go('jobs'); openJob(r.booking_id, p.estimate_lines?'estimate':null);\n      }).catch(function(err){ $('#njErr').textContent=err.message; busy(btn,false); });\n    });\n  }).catch(fail);\n};\n\n/* ───────── FOLLOW-UPS ───────── */\nVIEWS.followups = function(){\n  api('/admin/followups').then(function(d){\n    var due=d.followups.filter(function(f){ return f.due; }), later=d.followups.filter(function(f){ return !f.due; });\n    var row=function(f){\n      return '<div class=\"steel panel\" style=\"margin-bottom:.6rem\"><div class=\"row\" style=\"justify-content:space-between;align-items:flex-start\">'+\n        '<div><div style=\"font-family:var(--head);font-size:1.05rem\">'+esc(f.customer_name||f.email||'Customer')+' <span class=\"dim\" style=\"font-family:var(--body);font-size:.88rem\">'+esc(f.vehicle||'')+'</span></div>'+\n        '<div>'+f.declined.map(function(x){ return esc(x.desc)+' <span class=\"dim\">'+usd(x.amount_cents)+'</span>'; }).join(', ')+'</div>'+\n        '<div class=\"dim\" style=\"font-size:.85rem\">Declined on '+esc(f.order_name||'a job')+', '+dayLabel((f.paid_at||'').slice(0,10))+(f.follow_up_date?'. Follow up '+dayLabel(f.follow_up_date):'')+'</div></div>'+\n        '<div style=\"font-family:var(--display);font-size:1.6rem;color:var(--gold-hi)\">'+usd(f.value_cents)+'</div></div>'+\n        '<div class=\"row\" style=\"margin-top:.6rem;gap:.35rem\">'+(f.phone?'<a class=\"btn ghost sm\" href=\"'+telHref(f.phone)+'\">Call</a><button class=\"btn ghost sm\" data-ftext=\"'+f.id+'\">Text</button>':'')+\n        '<button class=\"btn sm\" data-fbook=\"'+f.id+'\">Book it</button><button class=\"btn ghost sm\" data-fsnooze=\"'+f.id+'\">Remind me in 30 days</button><button class=\"btn danger sm\" data-fclose=\"'+f.id+'\">Close</button></div></div>';\n    };\n    $('#view').innerHTML='<h2>Follow-ups</h2><p class=\"dim\" style=\"margin:-.6rem 0 1rem;max-width:660px\">Work customers declined. A follow-up call or text is the cheapest job you\\'ll ever book.</p>'+\n      (due.length?'<h3>Due now ('+due.length+')</h3>'+due.map(row).join(''):'<div class=\"steel empty\">Nothing due right now.</div>')+\n      (later.length?'<h3 style=\"margin-top:1.4rem\">Coming up</h3>'+later.map(row).join(''):'');\n    var byId={}; d.followups.forEach(function(f){ byId[f.id]=f; });\n    $$('[data-ftext]').forEach(function(b){ b.addEventListener('click', function(){ openJob(b.dataset.ftext,'texts','follow_up'); }); });\n    $$('[data-fbook]').forEach(function(b){ b.addEventListener('click', function(){\n      var f=byId[b.dataset.fbook];\n      S.prefill={customer_name:f.customer_name,phone:f.phone,email:f.email,vehicle:f.vehicle,service:f.declined.map(function(x){return x.desc;}).join(', '),concern:'Recommended on '+(f.order_name||'previous visit')+': '+f.declined.map(function(x){return x.desc;}).join(', ')};\n      api('/admin/booking/'+f.id+'/followup',{method:'POST',body:{note:'Booked as a new job'}}).catch(function(){});\n      go('new');\n    }); });\n    $$('[data-fsnooze]').forEach(function(b){ b.addEventListener('click', function(){ api('/admin/booking/'+b.dataset.fsnooze+'/followup',{method:'POST',body:{snooze_days:30}}).then(function(){ toast('Moved 30 days out'); rerender(); }).catch(function(e){ toast(e.message,true); }); }); });\n    $$('[data-fclose]').forEach(function(b){ b.addEventListener('click', function(){ var note=prompt('Close this follow-up? Reason (optional):',''); if(note===null) return; api('/admin/booking/'+b.dataset.fclose+'/followup',{method:'POST',body:{note:note}}).then(function(){ toast('Follow-up closed'); rerender(); }).catch(function(e){ toast(e.message,true); }); }); });\n  }).catch(fail);\n};\n\n/* ───────── PROMOTIONS (mass texts) ───────── */\nvar PROMO_TYPES={\n  discount:{label:'Discount (% or $ off)', a:['Discount','20% off'], s:['On','brake service'], c:{\n    friendly:['Hi {first}! Upper Echelon Automotive is taking {amt} off {svc}, and we come to you.','Hey {first}, it\\'s Upper Echelon Automotive. Right now you can save {amt} on {svc}, done at your home or office.'],\n    urgent:['{first}, this one won\\'t last: {amt} off {svc} from Upper Echelon Automotive.'],\n    pro:['Hello {first}, Upper Echelon Automotive is offering {amt} off {svc} for a limited time.'],\n    short:['Upper Echelon Automotive: {amt} off {svc}.']}},\n  free:{label:'Free add-on', a:['What\\'s free','a full vehicle inspection'], s:['With','any brake or battery job'], c:{\n    friendly:['Hi {first}! Book {svc} with Upper Echelon Automotive and get {amt} free.'],\n    urgent:['{first}, limited time: get {amt} FREE with {svc} from Upper Echelon Automotive.'],\n    pro:['Hello {first}, for a limited time Upper Echelon Automotive includes {amt} at no charge with {svc}.'],\n    short:['Free {amt} with {svc}. Upper Echelon Automotive.']}},\n  seasonal:{label:'Seasonal service', a:['Price (optional)','$49'], s:['Service','A/C performance check'], c:{\n    friendly:['Hi {first}! It\\'s that time of year. Upper Echelon Automotive is doing {svc}{for_amt}, right in your driveway.'],\n    urgent:['{first}, beat the rush: {svc}{for_amt} from Upper Echelon Automotive. Spots are filling up.'],\n    pro:['Hello {first}, Upper Echelon Automotive is now scheduling {svc}{for_amt}. We come to your home or workplace.'],\n    short:['{svc}{for_amt}. Upper Echelon Automotive comes to you.']}},\n  openings:{label:'Open slots', a:null, s:['When','this week'], c:{\n    friendly:['Hi {first}, Upper Echelon Automotive has a few openings {svc}. Anything your vehicle needs? We come to you.'],\n    urgent:['{first}, last-minute openings {svc}! Grab one before they\\'re gone. Upper Echelon Automotive.'],\n    pro:['Hello {first}, Upper Echelon Automotive has appointment availability {svc}.'],\n    short:['Openings {svc}. Upper Echelon Automotive comes to you.']}},\n  holiday:{label:'Holiday special', a:['Deal','15% off any repair'], s:['Holiday','Black Friday'], c:{\n    friendly:['Happy {svc}, {first}! Upper Echelon Automotive is celebrating with {amt}.'],\n    urgent:['{svc} deal from Upper Echelon Automotive: {amt}. Limited spots, {first}!'],\n    pro:['Hello {first}, for {svc}, Upper Echelon Automotive is offering {amt}.'],\n    short:['{svc} special: {amt}. Upper Echelon Automotive.']}},\n  winback:{label:'We miss you', a:['Comeback offer','15% off your next visit'], s:null, c:{\n    friendly:['Hi {first}, we miss you at Upper Echelon Automotive! Here\\'s {amt} to welcome you back.'],\n    urgent:['{first}, your welcome-back offer from Upper Echelon Automotive: {amt}. Don\\'t let it slip by!'],\n    pro:['Hello {first}, it has been a while since your last service with Upper Echelon Automotive. Please enjoy {amt}.'],\n    short:['We miss you, {first}! {amt} from Upper Echelon Automotive.']}},\n  referral:{label:'Refer a friend', a:['Each person gets','$25 off'], s:null, c:{\n    friendly:['Hi {first}! Know someone who needs a mechanic? Send them to Upper Echelon Automotive and you both get {amt}. Have them mention your name when they book.'],\n    urgent:['{first}, refer a friend this month and you each get {amt} from Upper Echelon Automotive. Just have them mention your name.'],\n    pro:['Hello {first}, refer a friend to Upper Echelon Automotive and you will both receive {amt}. Ask them to mention your name when booking.'],\n    short:['Refer a friend to Upper Echelon Automotive, you both get {amt}.']}},\n  points:{label:'Bonus reward points', a:['Bonus','double reward points'], s:['On','any service'], c:{\n    friendly:['Hi {first}! Earn {amt} on {svc} with Upper Echelon Automotive. You have {points} points right now.'],\n    urgent:['{first}, {amt} on {svc} for a limited time! Your balance: {points} points.'],\n    pro:['Hello {first}, Upper Echelon Automotive rewards members earn {amt} on {svc}. Current balance: {points} points.'],\n    short:['{amt} on {svc} at Upper Echelon Automotive. You have {points} pts.']}},\n  fleet:{label:'Fleet offer', a:['Offer','10% off preventive maintenance'], s:['For','your work trucks'], c:{\n    friendly:['Hi {first}, Upper Echelon Automotive is offering {amt} for {svc}. We service on-site so your vehicles stay on the job.'],\n    urgent:['{first}, fleet special this month: {amt} for {svc}. On-site, no downtime driving to a shop.'],\n    pro:['Hello {first}, Upper Echelon Automotive provides on-site service for {svc}. Fleet customers receive {amt}.'],\n    short:['Fleet deal: {amt} for {svc}. On-site service.']}},\n  custom:{label:'Write my own', a:null, s:null, c:{}}\n};\nvar TONE_NAME={friendly:'Friendly',urgent:'Urgent',pro:'Professional',short:'Short'};\nfunction promoEnd(iso){ if(!iso) return ''; var p=iso.split('-'); return new Date(Date.UTC(+p[0],+p[1]-1,+p[2])).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}); }\nfunction promoGenerate(P){\n  var T=PROMO_TYPES[P.type]; if(!T||P.type==='custom') return [];\n  var amt=(P.amt||(T.a?T.a[1]:'')).trim(), svc=(P.svc||(T.s?T.s[1]:'')).trim();\n  var out=[];\n  ['friendly','urgent','pro','short'].forEach(function(tone){ (T.c[tone]||[]).forEach(function(core){\n    var t=core.replace(/\\{amt\\}/g,amt).replace(/\\{svc\\}/g,svc).replace(/\\{for_amt\\}/g,amt?' for '+amt:'');\n    if(P.code) t+=tone==='short'?' Code '+P.code.toUpperCase()+'.':' Use code '+P.code.toUpperCase()+'.';\n    if(P.end) t+=tone==='short'?' Ends '+promoEnd(P.end)+'.':' Good through '+promoEnd(P.end)+'.';\n    if(P.link) t+=tone==='short'?' '+P.link:' Book: '+P.link;\n    else t+=tone==='short'?' Reply to book.':' Reply here or call {shop_phone} to book.';\n    out.push({tone:tone, text:t.charAt(0).toUpperCase()+t.slice(1)});\n  }); });\n  return out;\n}\nVIEWS.promos = function(){\n  var P=S.promo||(S.promo={type:'discount',amt:'',svc:'',end:'',code:'',link:'https://ueauto.store',useLink:true,msg:'',pick:-1,seg:'all',vehicle:'',service:''});\n  var h='<h2>Promotions</h2><p class=\"dim\" style=\"margin:.2rem 0 1rem\">Text a deal to your customers. Pick the kind of promotion, fill in the details, choose a message, then pick who gets it. Customers who replied STOP are never included.</p>'+\n    '<div class=\"grid g2 sec\" style=\"align-items:start\"><div>'+\n    '<form class=\"steel panel sec\" id=\"pForm\"><h3>1. The deal</h3>'+\n      '<div class=\"field\"><label>Kind of promotion</label><select name=\"type\">'+Object.keys(PROMO_TYPES).map(function(k){ return '<option value=\"'+k+'\"'+(k===P.type?' selected':'')+'>'+PROMO_TYPES[k].label+'</option>'; }).join('')+'</select></div>'+\n      '<div class=\"grid g2\" id=\"pFields\"></div>'+\n      '<div class=\"grid g2\">'+fld('Ends (optional)','end',P.end,'','date')+fld('Promo code (optional)','code',P.code)+'</div>'+\n      '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" name=\"useLink\"'+(P.useLink?' checked':'')+'> Include a booking link</label>'+\n      '<div id=\"pLinkF\">'+fld('Link','link',P.link)+'<div class=\"help\" style=\"margin-top:-.5rem\">Textbelt only sends links after your key is approved for them. If texts fail, untick this and customers can reply instead.</div></div></form>'+\n    '<div class=\"steel panel sec\" id=\"pGenWrap\"><h3>2. Pick a message</h3><div class=\"gens\" id=\"pGens\"></div></div>'+\n    '<div class=\"steel panel sec\"><h3>3. Fine-tune</h3><textarea id=\"pMsg\" rows=\"5\" maxlength=\"520\" placeholder=\"Pick a message above or write your own. Use {first} for their first name.\">'+esc(P.msg)+'</textarea>'+\n      '<div class=\"help\">Personalize with <b>{first}</b>, <b>{name}</b>, <b>{points}</b>, <b>{shop_phone}</b>, <b>{rewards_link}</b>. “Reply STOP to opt out.” is always added to promotions. <span id=\"pCount\"></span></div></div>'+\n    '</div><div>'+\n    '<div class=\"steel panel sec\"><h3>4. Who gets it</h3><div class=\"field\"><label>Customers</label><select id=\"pSeg\"></select></div>'+\n      '<div class=\"grid g2\"><div class=\"field\"><label>Vehicle contains (optional)</label><input id=\"pVeh\" placeholder=\"Ford, F-150, Silverado…\" value=\"'+esc(P.vehicle)+'\"></div>'+\n      '<div class=\"field\"><label>Past service contains (optional)</label><input id=\"pSvc\" placeholder=\"brake, battery, A/C…\" value=\"'+esc(P.service)+'\"></div></div>'+\n      '<div id=\"pAud\" class=\"dim\">Counting…</div></div>'+\n    '<div class=\"steel panel sec\"><h3>Preview</h3><div class=\"phone-prev\"><div class=\"bubble\" id=\"pPrev\">—</div></div><div class=\"help\" id=\"pPrevWho\"></div></div>'+\n    '<div class=\"steel panel sec\"><div id=\"pWin\"></div><div class=\"row\" style=\"gap:.5rem\"><button class=\"btn\" id=\"pSend\" disabled>Send</button><button class=\"btn ghost\" id=\"pTest\">Text me a test</button></div>'+\n      '<p class=\"help\">Only text customers who agreed to hear about deals from you. Promotions go out 9 AM–9 PM Mon–Sat and noon–9 PM Sunday (Central).</p><div id=\"bOut\" style=\"margin-top:.6rem\"></div></div>'+\n    '<div class=\"steel panel\" id=\"pHist\"><h3>Past promotions</h3><div class=\"dim\">Loading…</div></div>'+\n    '</div></div>';\n  $('#view').innerHTML=h;\n  var f=$('#pForm'), A=null;\n  var vars=function(){ var m=A&&A.members[0]; return {first:m?String(m.name||'there').trim().split(/\\s+/)[0]:'Alex', name:m?m.name||'':'Alex Smith', points:m?n(m.points_balance):'250', shop_phone:(S.settings&&S.settings.shop_phone)||'251-289-0740', rewards_link:'https://ueauto.store/pages/rewards'}; };\n  var preview=function(){\n    var raw=$('#pMsg').value.trim(); P.msg=raw;\n    var t=raw?fill(raw, vars())+' Reply STOP to opt out.':'';\n    $('#pPrev').textContent=t||'—';\n    $('#pPrevWho').textContent=A&&A.members[0]?'As '+(A.members[0].name||'the first customer')+' will see it.':'';\n    var segs=t.length>160?Math.ceil(t.length/153):1;\n    $('#pCount').textContent=t.length+' characters'+(t.length>160?' · '+segs+' text segments each':'');\n    var c=A?A.count:0, can=c&&raw&&A.window.ok&&A.sms_ready;\n    $('#pSend').disabled=!can;\n    $('#pSend').textContent='Send to '+n(c)+' customer'+(c===1?'':'s')+(c?' (about $'+(c*segs*0.01).toFixed(2)+')':'');\n  };\n  var fields=function(){\n    var T=PROMO_TYPES[P.type];\n    $('#pFields').innerHTML=(T.a?fld(T.a[0],'amt',P.amt,'','text'):'')+(T.s?fld(T.s[0],'svc',P.svc,'','text'):'');\n    if(fe(f,'amt')) fe(f,'amt').placeholder=T.a[1]; if(fe(f,'svc')) fe(f,'svc').placeholder=T.s[1];\n    $$('#pFields input').forEach(function(i){ i.addEventListener('input', function(){ P[i.name]=i.value; gens(); }); });\n  };\n  var gens=function(){\n    P.link=fe(f,'link').value.trim(); P.useLink=fe(f,'useLink').checked; $('#pLinkF').classList.toggle('hide',!P.useLink);\n    var L=promoGenerate({type:P.type, amt:P.amt, svc:P.svc, end:P.end, code:P.code, link:P.useLink?P.link:''});\n    $('#pGenWrap').classList.toggle('hide', !L.length);\n    $('#pGens').innerHTML=L.map(function(g,i){ return '<button type=\"button\" class=\"gen'+(i===P.pick?' on':'')+'\" data-gen=\"'+i+'\"><small>'+TONE_NAME[g.tone]+'</small>'+esc(fill(g.text, vars()))+'</button>'; }).join('');\n    $$('#pGens [data-gen]').forEach(function(b){ b.addEventListener('click', function(){ P.pick=+b.dataset.gen; $('#pMsg').value=L[P.pick].text; gens(); preview(); }); });\n    if(P.pick>-1 && L[P.pick]){ $('#pMsg').value=L[P.pick].text; }\n    preview();\n  };\n  fe(f,'type').addEventListener('change', function(){ P.type=this.value; P.amt=''; P.svc=''; P.pick=P.type==='custom'?-1:0; if(P.type==='custom') $('#pMsg').value=''; fields(); gens(); if(P.type==='winback'){ $('#pSeg').value='inactive'; P.seg='inactive'; aud(); } if(P.type==='fleet'){ $('#pSeg').value='fleet'; P.seg='fleet'; aud(); } if(P.type==='points'){ $('#pSeg').value='points'; P.seg='points'; aud(); } });\n  ['end','code','link'].forEach(function(k){ fe(f,k).addEventListener('input', function(){ P[k]=this.value; gens(); }); });\n  fe(f,'useLink').addEventListener('change', gens);\n  $('#pMsg').addEventListener('input', function(){ P.pick=-1; $$('#pGens .gen').forEach(function(g){ g.classList.remove('on'); }); preview(); });\n  var aud=function(){\n    P.vehicle=$('#pVeh').value.trim(); P.service=$('#pSvc').value.trim();\n    api('/admin/promo/audience?seg='+P.seg+'&vehicle='+encodeURIComponent(P.vehicle)+'&service='+encodeURIComponent(P.service)).then(function(d){\n      A=d;\n      if(!$('#pSeg').options.length){ $('#pSeg').innerHTML=Object.keys(d.segments).map(function(k){ return '<option value=\"'+k+'\">'+esc(d.segments[k])+'</option>'; }).join(''); $('#pSeg').value=P.seg; }\n      $('#pAud').innerHTML='<b style=\"color:var(--text);font-size:1.1rem\">'+n(d.count)+'</b> customer'+(d.count===1?'':'s')+' will get this.'+(d.opted_out?' <span class=\"dim\">'+n(d.opted_out)+(d.opted_out===1?' customer who opted out is':' customers who opted out are')+' left out.</span>':'')+\n        (d.count?' <a href=\"#\" id=\"pWho\">See who</a><div class=\"wlist hide\" id=\"pWhoL\">'+d.members.slice(0,300).map(function(m){ return esc(m.name||m.phone||'Customer'); }).join(', ')+(d.count>300?' and '+(d.count-300)+' more':'')+'</div>':'');\n      if($('#pWho')) $('#pWho').addEventListener('click', function(e){ e.preventDefault(); $('#pWhoL').classList.toggle('hide'); });\n      $('#pWin').innerHTML=!d.sms_ready?'<div class=\"warnbox steel panel\" style=\"margin-bottom:.6rem\">Texting isn\\'t connected. Add TEXTBELT_KEY on Render first.</div>':\n        d.window.ok?'':'<div class=\"warnbox steel panel\" style=\"margin-bottom:.6rem\">'+esc(d.window.msg)+'</div>';\n      gens();\n    }).catch(function(e){ $('#pAud').innerHTML='<span class=\"minus\">'+esc(e.message)+'</span>'; });\n  };\n  var at; $('#pSeg').addEventListener('change', function(){ P.seg=this.value; aud(); });\n  [$('#pVeh'),$('#pSvc')].forEach(function(i){ i.addEventListener('input', function(){ clearTimeout(at); at=setTimeout(aud,350); }); });\n  $('#pTest').addEventListener('click', function(){ var msg=$('#pMsg').value.trim(), btn=this; if(!msg) return toast('Write or pick a message first',true);\n    busy(btn,true,'Sending…'); api('/admin/promo/test',{method:'POST',body:{message:msg}}).then(function(r){ busy(btn,false); toast('Test sent to '+r.to); }).catch(function(e){ busy(btn,false); toast(e.message,true); }); });\n  $('#pSend').addEventListener('click', function(){\n    var msg=$('#pMsg').value.trim(), btn=this; if(!msg||!A||!A.count) return;\n    if(/\\{(amt|svc|for_amt)\\}/.test(msg)) return toast('Fill in the deal details first',true);\n    if(!confirm('Text this promotion to '+A.count+' customer'+(A.count===1?'':'s')+'? This can\\'t be undone.')) return;\n    if(!P.campaign||P.campaignMsg!==msg){ P.campaign=todayIso().replace(/-/g,'')+'-'+Math.random().toString(36).slice(2,7); P.campaignMsg=msg; }\n    var campaign=P.campaign;\n    runBulk('text',{message:msg,promo:true,campaign:campaign},A.members,btn).then(function(){ hist(); preview(); }).catch(function(e){ busy(btn,false); toast(e.message,true); });\n  });\n  var hist=function(){ api('/admin/promo/history').then(function(d){\n    $('#pHist').innerHTML='<h3>Past promotions</h3>'+(d.campaigns.length?d.campaigns.map(function(c){ return '<div class=\"ev\"><div class=\"k\">'+when(c.first_at)+'<br>'+n(c.sent)+' sent'+(c.sent_by?'<br>'+esc(c.sent_by):'')+'</div><div>'+esc(c.sample)+'</div></div>'; }).join(''):'<div class=\"dim\">No promotions sent yet.</div>');\n  }).catch(function(){ $('#pHist').innerHTML='<h3>Past promotions</h3><div class=\"dim\">Couldn\\'t load history.</div>'; }); };\n  fields(); if(P.pick<0&&!P.msg&&P.type!=='custom') P.pick=0; gens(); aud(); hist();\n};\n\n/* ───────── CUSTOMERS ───────── */\nVIEWS.customers = function(){\n  var C=S.cust||(S.cust={q:'',sort:'recent',filter:'',limit:60}); if(!S.msel) S.msel={};\n  $('#view').innerHTML='<h2>Customers</h2>'+\n    '<div class=\"row\" style=\"margin-bottom:.6rem;gap:.5rem\"><input id=\"mq\" placeholder=\"Search name, phone, email, address\" style=\"flex:1;min-width:200px\" value=\"'+esc(C.q)+'\">'+\n      '<select id=\"mfilter\" style=\"width:auto\"><option value=\"\">All customers</option><option value=\"textable\">Can be texted</option><option value=\"points\">Has points</option><option value=\"recent\">Active last 90 days</option><option value=\"inactive\">No visit in 6+ months</option><option value=\"noemail\">Missing email</option><option value=\"fleet\">Fleet accounts</option><option value=\"optout\">Opted out of texts</option></select>'+\n      '<select id=\"msort\" style=\"width:auto\"><option value=\"recent\">Recently active</option><option value=\"points\">Most points</option><option value=\"name\">Name A–Z</option></select></div>'+\n    '<div class=\"selbar\" id=\"mselBar\"><label style=\"display:flex;align-items:center;gap:.4rem;cursor:pointer\"><input type=\"checkbox\" id=\"mAll\"> <span id=\"mselN\">0 selected</span></label>'+\n      '<button class=\"btn sm\" data-bulk=\"text\">Send text</button>'+\n      (OWN()?'<button class=\"btn sm\" data-bulk=\"points\">Add / remove points</button>':'')+\n      '<button class=\"btn ghost sm\" data-bulk=\"reminder\">Add reminder</button>'+\n      '<button class=\"btn ghost sm\" data-bulk=\"more\">More…</button>'+\n      '<button class=\"btn ghost sm\" id=\"mClear\">Clear</button></div>'+\n    '<div id=\"mlist\" class=\"steel\"></div><div id=\"mmore\"></div>'+\n    '<p class=\"help\">Tick customers, or use the box at the top to select everyone in the list. Filters and search narrow the list first, e.g. “Can be texted” + “No visit in 6+ months” for a win-back text. Every customer is saved automatically from website bookings, phone jobs and Shopify orders.</p>';\n  $('#mfilter').value=C.filter; $('#msort').value=C.sort;\n  var t; $('#mq').addEventListener('input', function(){ clearTimeout(t); t=setTimeout(function(){ C.q=$('#mq').value; C.limit=60; loadMembers(); },250); });\n  $('#mfilter').addEventListener('change', function(){ C.filter=this.value; C.limit=60; loadMembers(); });\n  $('#msort').addEventListener('change', function(){ C.sort=this.value; loadMembers(); });\n  $('#mAll').addEventListener('change', function(){ var on=this.checked; (S.mlist||[]).forEach(function(m){ if(on) S.msel[m.id]=m; else delete S.msel[m.id]; }); paintMsel(); });\n  $('#mClear').addEventListener('click', function(){ S.msel={}; paintMsel(); });\n  $$('[data-bulk]').forEach(function(b){ b.addEventListener('click', function(){ bulkSheet(b.dataset.bulk); }); });\n  loadMembers();\n};\nfunction paintMsel(){\n  var ids=Object.keys(S.msel||{}), k=ids.length;\n  if($('#mselN')) $('#mselN').textContent=k+' selected';\n  $$('#mselBar [data-bulk]').forEach(function(b){ b.disabled=!k; });\n  if($('#mClear')) $('#mClear').disabled=!k;\n  $$('#mlist tr[data-mid]').forEach(function(tr){ var on=!!S.msel[tr.dataset.mid]; tr.classList.toggle('mpicked',on); var c=tr.querySelector('.mchk'); if(c) c.checked=on; });\n  var L=S.mlist||[]; if($('#mAll')){ var all=L.length&&L.every(function(m){ return S.msel[m.id]; }); $('#mAll').checked=!!all; $('#mAll').indeterminate=!all&&L.some(function(m){ return S.msel[m.id]; }); }\n}\nfunction loadMembers(){\n  if(!$('#mlist')) return; var C=S.cust;\n  api('/admin/members?q='+encodeURIComponent(C.q)+'&sort='+C.sort+'&filter='+C.filter+'&limit='+C.limit).then(function(d){\n    S.mlist=d.members;\n    d.members.forEach(function(m){ if(S.msel[m.id]) S.msel[m.id]=m; });\n    $('#mlist').innerHTML=d.members.length?'<div class=\"scroll\"><table><tr><th style=\"width:34px\"></th><th>Name</th><th>Contact</th><th>Vehicles</th><th>Points</th><th>Last active</th></tr>'+d.members.map(function(m){\n      return '<tr class=\"click\" data-mid=\"'+m.id+'\"><td><input type=\"checkbox\" class=\"mchk\" aria-label=\"Select '+esc(m.name||'customer')+'\" style=\"width:20px;height:20px\"></td><td>'+esc(m.name||'—')+(m.is_fleet?' <span class=\"chip\">Fleet</span>':'')+(m.sms_opt_out?' <span class=\"chip\">No texts</span>':'')+(m.address?'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(m.address)+'</div>':'')+'</td><td>'+esc(m.phone||'')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(m.email||'')+'</div></td>'+\n        '<td style=\"font-size:.88rem\">'+((m.vehicles||[]).map(function(v){ return esc(v.description); }).join('<br>')||'<span class=\"dim\">—</span>')+'</td><td class=\"pts\">'+n(m.points_balance)+'</td><td class=\"dim\">'+when(m.last_activity_at)+'</td></tr>';\n    }).join('')+'</table></div>':'<div class=\"empty\">No customers match.</div>';\n    $('#mmore').innerHTML=d.members.length>=C.limit&&C.limit<500?'<button class=\"btn ghost sm\" id=\"mLoadMore\" style=\"margin-top:.6rem\">Show more customers</button>':'';\n    if($('#mLoadMore')) $('#mLoadMore').addEventListener('click', function(){ C.limit=Math.min(500,C.limit+140); loadMembers(); });\n    $$('#mlist tr[data-mid]').forEach(function(tr){ tr.addEventListener('click', function(e){\n      var m=(S.mlist||[]).filter(function(x){ return String(x.id)===tr.dataset.mid; })[0];\n      if(e.target.classList.contains('mchk')||e.target.closest('td:first-child')){ if(S.msel[tr.dataset.mid]) delete S.msel[tr.dataset.mid]; else S.msel[tr.dataset.mid]=m; paintMsel(); return; }\n      openMember(tr.dataset.mid);\n    }); });\n    paintMsel();\n  }).catch(function(e){ $('#mlist').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\nfunction bulkSheet(kind){\n  var sel=Object.keys(S.msel).map(function(id){ return S.msel[id]; }); if(!sel.length) return;\n  var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide'); J=null;\n  var names=sel.slice(0,8).map(function(m){ return esc(m.name||m.phone||m.email||'Customer'); }).join(', ')+(sel.length>8?' and '+(sel.length-8)+' more':'');\n  var head='<div class=\"row\" style=\"justify-content:space-between\"><h2 style=\"margin:0\">'+({text:'Text customers',points:'Add or remove points',reminder:'Add reminder',more:'More actions'}[kind])+'</h2><button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button></div>'+\n    '<p class=\"dim\" style=\"margin:.3rem 0 1rem\">'+sel.length+' selected: '+names+'</p>';\n  var body='';\n  if(kind==='text'){\n    var ok=sel.filter(function(m){ return m.phone&&!m.sms_opt_out; }).length;\n    var tpl=(S.settings&&S.settings.sms_templates)||{};\n    body='<form class=\"steel panel\" id=\"bForm\"><div class=\"field\"><label>Start from</label><select id=\"bTpl\"><option value=\"\">Write my own</option>'+\n        '<option value=\"Hi {first}, it\\'s Upper Echelon Automotive. You have {points} reward points with us — see what you can get: {rewards_link}\">Points reminder</option>'+\n        '<option value=\"Hi {first}, it\\'s been a while! Upper Echelon Automotive comes to you for diagnostics and repairs. Book here: https://ueauto.store/#contact or call {shop_phone}.\">Win-back</option>'+\n        '<option value=\"Hi {first}, Upper Echelon Automotive has openings this week. Want us to come to you? Reply here or call {shop_phone}.\">Open slots this week</option>'+\n        (tpl.review?'<option value=\"'+esc(tpl.review)+'\">Review request</option>':'')+'</select></div>'+\n      '<div class=\"field\"><label>Message</label><textarea name=\"message\" rows=\"5\" maxlength=\"560\" required placeholder=\"Hi {first}, …\"></textarea>'+\n        '<div class=\"help\">Personalize with <b>{first}</b>, <b>{name}</b>, <b>{points}</b>, <b>{referral_code}</b>, <b>{rewards_link}</b>, <b>{shop_phone}</b>. <span id=\"bCount\"></span></div></div>'+\n      '<label style=\"display:flex;gap:.5rem;align-items:flex-start;margin:.4rem 0 .8rem\"><input type=\"checkbox\" name=\"stop_line\" checked style=\"margin-top:.25rem\"> <span>Add “Reply STOP to opt out.” <span class=\"dim\">Keep this on for promotions.</span></span></label>'+\n      '<div class=\"field\"><label>Preview ('+esc((sel[0].name||'first customer'))+')</label><div class=\"steel panel\" id=\"bPrev\" style=\"white-space:pre-wrap;font-size:.92rem;min-height:2.5rem\"></div></div>'+\n      '<p class=\"dim\">'+ok+' of '+sel.length+' can be texted'+(ok<sel.length?' (the rest have no phone or opted out and will be skipped)':'')+'. About $'+(ok*0.01).toFixed(2)+' per text segment.</p>'+\n      '<button class=\"btn\" type=\"submit\"'+(ok?'':' disabled')+'>Send '+ok+' text'+(ok===1?'':'s')+'</button><div id=\"bOut\" style=\"margin-top:1rem\"></div></form>';\n  } else if(kind==='points'){\n    body='<form class=\"steel panel\" id=\"bForm\"><div class=\"grid g2\"><div class=\"field\"><label>Points each</label><input name=\"points\" type=\"number\" step=\"1\" required placeholder=\"100 to add, -100 to remove\"></div>'+\n      '<div class=\"field\"><label>Reason</label><select name=\"reason\"><option>Goodwill</option><option>Promotion</option><option>Job paid before the program started</option><option>Correction</option><option>Other</option></select></div></div>'+\n      '<div class=\"field\"><label>Note customers will see</label><input name=\"note\" maxlength=\"150\" placeholder=\"e.g. Thanks for being a customer — holiday bonus\"></div>'+\n      '<label style=\"display:flex;gap:.5rem;align-items:center;margin:.2rem 0 .8rem\"><input type=\"checkbox\" name=\"notify\"> <span>Also text them about it</span></label>'+\n      '<p class=\"dim\">Customers see this right away on the website under Rewards → Points. Removing points skips anyone who doesn’t have enough.</p>'+\n      '<button class=\"btn\" type=\"submit\">Update '+sel.length+' customer'+(sel.length===1?'':'s')+'</button><div id=\"bOut\" style=\"margin-top:1rem\"></div></form>';\n  } else if(kind==='reminder'){\n    body='<form class=\"steel panel\" id=\"bForm\"><div class=\"grid g2\"><div class=\"field\"><label>What for</label><input name=\"title\" required maxlength=\"80\" placeholder=\"Oil change, Inspection, Follow up…\"></div>'+\n      '<div class=\"field\"><label>Due date</label><input name=\"due_date\" type=\"date\" required value=\"'+todayIso()+'\"></div></div>'+\n      '<div class=\"field\"><label>Note (optional)</label><input name=\"note\" maxlength=\"300\"></div>'+\n      '<p class=\"dim\">Reminders show under Reminders, where you can text each customer when it’s due.</p>'+\n      '<button class=\"btn\" type=\"submit\">Add '+sel.length+' reminder'+(sel.length===1?'':'s')+'</button><div id=\"bOut\" style=\"margin-top:1rem\"></div></form>';\n  } else {\n    body='<div class=\"steel panel\"><div class=\"grid g2\" style=\"gap:.6rem\">'+\n      '<button class=\"btn ghost\" data-act=\"csv\">Download as spreadsheet (CSV)</button>'+\n      '<button class=\"btn ghost\" data-act=\"copy_phones\">Copy phone numbers</button>'+\n      '<button class=\"btn ghost\" data-act=\"copy_emails\">Copy email addresses</button>'+\n      '<button class=\"btn ghost\" data-act=\"optout_on\">Mark “do not text”</button>'+\n      '<button class=\"btn ghost\" data-act=\"optout_off\">Allow texts again</button>'+\n      (OWN()?'<button class=\"btn ghost\" data-act=\"fleet_on\">Make fleet accounts</button><button class=\"btn ghost\" data-act=\"fleet_off\">Remove fleet status</button>':'')+\n      '</div><p class=\"dim\" style=\"margin-top:.8rem\">Fleet accounts stop earning points (FleetCare pricing is their benefit). “Do not text” customers are skipped by bulk texts.</p><div id=\"bOut\" style=\"margin-top:1rem\"></div></div>';\n  }\n  sh.innerHTML=head+body;\n  $('#closeDrawer').addEventListener('click', closeDrawer);\n  var f=$('#bForm');\n  if(kind==='text'){\n    var ta=fe(f,'message');\n    var m0=sel[0], vars={first:String(m0.name||'there').trim().split(/\\s+/)[0],name:m0.name||'',points:n(m0.points_balance),referral_code:m0.referral_code||'',rewards_link:'https://ueauto.store/pages/rewards',shop_phone:(S.settings&&S.settings.shop_phone)||'251-289-0740'};\n    var prev=function(){ var v=String(ta.value||'').replace(/\\{(\\w+)\\}/g,function(x,k){ return vars[k]!=null?vars[k]:''; }).replace(/\\s{2,}/g,' ').trim();\n      if(fe(f,'stop_line').checked&&v) v+=' Reply STOP to opt out.'; $('#bPrev').textContent=v||'—'; $('#bCount').textContent=v.length+' characters'+(v.length>160?' ('+Math.ceil(v.length/153)+' text segments)':''); };\n    ta.addEventListener('input',prev); fe(f,'stop_line').addEventListener('change',prev);\n    $('#bTpl').addEventListener('change', function(){ if(this.value){ ta.value=this.value; prev(); } });\n    prev();\n  }\n  if(f) f.addEventListener('submit', function(e){\n    e.preventDefault(); var btn=f.querySelector('button[type=submit]'), payload={};\n    if(kind==='text'){ payload={message:fe(f,'message').value.trim(),stop_line:fe(f,'stop_line').checked};\n      var cnt=sel.filter(function(m){ return m.phone&&!m.sms_opt_out; }).length;\n      if(!confirm('Send this text to '+cnt+' customer'+(cnt===1?'':'s')+'? This can\\'t be undone.')) return; }\n    else if(kind==='points'){ var pts=parseInt(fe(f,'points').value,10); if(!pts){ toast('Enter a point amount',true); return; }\n      var note=[fe(f,'reason').value,fe(f,'note').value.trim()].filter(Boolean).join(': ');\n      payload={points:pts,note:note,batch:Date.now().toString(36)+Math.random().toString(36).slice(2,6)};\n      if(!confirm((pts>0?'Add ':'Remove ')+Math.abs(pts)+' points '+(pts>0?'to ':'from ')+sel.length+' customer'+(sel.length===1?'':'s')+'?')) return; }\n    else if(kind==='reminder'){ payload={title:fe(f,'title').value.trim(),due_date:fe(f,'due_date').value,note:fe(f,'note').value.trim()}; }\n    runBulk(kind, payload, sel, btn).then(function(){\n      if(kind==='points'&&fe(f,'notify').checked){\n        var pts2=payload.points, msg='Hi {first}, Upper Echelon Automotive just '+(pts2>0?'added '+pts2+' points to':'updated')+' your rewards. You now have {points} points: {rewards_link}';\n        return runBulk('text',{message:msg,stop_line:false},sel,btn,true);\n      }\n    });\n  });\n  $$('#sheet [data-act]').forEach(function(b){ b.addEventListener('click', function(){\n    var a=b.dataset.act;\n    if(a==='csv'){ var rows=[['Name','Phone','Email','Address','Points','Fleet','Do not text','Vehicles','Last active']].concat(sel.map(function(m){ return [m.name,m.phone,m.email,m.address,m.points_balance,m.is_fleet?'yes':'',m.sms_opt_out?'yes':'',(m.vehicles||[]).map(function(v){ return v.description; }).join('; '),m.last_activity_at?String(m.last_activity_at).slice(0,10):'']; }));\n      var csv=rows.map(function(r){ return r.map(function(c){ c=String(c==null?'':c); return /[\",\\n]/.test(c)?'\"'+c.replace(/\"/g,'\"\"')+'\"':c; }).join(','); }).join('\\r\\n');\n      var url=URL.createObjectURL(new Blob([csv],{type:'text/csv'})), a2=document.createElement('a'); a2.href=url; a2.download='uea-customers-'+todayIso()+'.csv'; document.body.appendChild(a2); a2.click(); a2.remove(); setTimeout(function(){ URL.revokeObjectURL(url); },2000); toast('Downloaded '+sel.length+' customers'); return; }\n    if(a==='copy_phones'||a==='copy_emails'){ var list=sel.map(function(m){ return a==='copy_phones'?m.phone:m.email; }).filter(Boolean);\n      (navigator.clipboard?navigator.clipboard.writeText(list.join(a==='copy_phones'?', ':'; ')):Promise.reject()).then(function(){ toast('Copied '+list.length); },function(){ $('#bOut').innerHTML='<textarea rows=\"4\" style=\"width:100%\">'+esc(list.join(', '))+'</textarea>'; }); return; }\n    runBulk(a, {}, sel, b);\n  }); });\n}\nfunction runBulk(action, payload, sel, btn, quiet){\n  var ids=sel.map(function(m){ return m.id; }), out=$('#bOut'), chunks=[], all=[], stopped=null;\n  for(var i=0;i<ids.length;i+=action==='text'?10:50) chunks.push(ids.slice(i,i+(action==='text'?10:50)));\n  busy(btn,true,'Working… 0 of '+ids.length);\n  var step=function(k){\n    if(k>=chunks.length) return Promise.resolve();\n    return api('/admin/members/bulk',{method:'POST',body:Object.assign({action:action,ids:chunks[k]},payload)}).then(function(r){\n      all=all.concat(r.results); if(btn) btn.textContent='Working… '+Math.min(ids.length,all.length)+' of '+ids.length;\n      if(r.stopped){ stopped=r.stopped; var byId={}; sel.forEach(function(m){ byId[m.id]=m; });\n        chunks.slice(k+1).forEach(function(c){ c.forEach(function(id){ var m=byId[id]||{}; all.push({id:id,name:m.name||m.phone||'Customer',ok:false,msg:'Not sent: Textbelt limit reached'}); }); });\n        return; }\n      return step(k+1);\n    });\n  };\n  return step(0).then(function(){\n    busy(btn,false);\n    var had=all.filter(function(r){ return r.already; }), ok=all.filter(function(r){ return r.ok&&!r.already; }), bad=all.filter(function(r){ return !r.ok; });\n    var label={text:'texted',points:'updated',reminder:'reminders added',fleet_on:'made fleet',fleet_off:'fleet removed',optout_on:'marked do not text',optout_off:'texts allowed'}[action]||'done';\n    toast(ok.length+' '+label+(bad.length?', '+bad.length+' skipped':''));\n    if(out&&!quiet) out.innerHTML=(stopped?'<div class=\"steel panel warnbox\" style=\"margin-bottom:.6rem\"><b>Sending stopped.</b> '+esc(stopped)+(action==='text'&&payload.promo?' Press <b>Send</b> again later with the same message and it only goes to customers who missed it.':'')+'</div>':'')+\n      '<div class=\"steel panel\"><b class=\"plus\">✓ '+ok.length+' '+label+'</b>'+(had.length?' <span class=\"dim\">· '+had.length+' already had it</span>':'')+(bad.length?'<div style=\"margin-top:.5rem\"><b class=\"minus\">'+bad.length+' skipped</b><ul style=\"margin:.3rem 0 0 1rem;padding:0\">'+bad.map(function(r){ return '<li>'+esc(r.name)+': <span class=\"dim\">'+esc(r.msg||'error')+'</span></li>'; }).join('')+'</ul></div>':'')+'</div>';\n    else if(out&&quiet) out.innerHTML+='<div class=\"dim\" style=\"margin-top:.4rem\">Notification texts: '+ok.length+' sent'+(bad.length?', '+bad.length+' skipped':'')+'.</div>';\n    loadMembers();\n  }).catch(function(e){ busy(btn,false); toast(e.message,true); if(out) out.innerHTML='<div class=\"minus\">'+esc(e.message)+(all.length?' ('+all.filter(function(r){ return r.ok; }).length+' finished before the error)':'')+'</div>'; });\n}\n/* ───────── MESSAGES ───────── */\nVIEWS.messages = function(){\n  $('#view').innerHTML='<div class=\"row\" style=\"justify-content:space-between;align-items:center\"><h2 style=\"margin:0\">Messages</h2><button class=\"btn sm\" id=\"msgNew\">New text</button></div>'+\n    '<div id=\"smsStatus\" style=\"margin:.8rem 0\"></div><div class=\"steel\" id=\"convList\"><div class=\"empty\">Loading…</div></div>'+\n    '<p class=\"help\">Texts you send from jobs, reminders, bulk texts and here all show up as conversations. Customer replies arrive here within a few seconds; the desk checks every 30 seconds.</p>';\n  $('#msgNew').addEventListener('click', newTextSheet);\n  api('/admin/sms/status').then(paintSmsStatus).catch(function(){});\n  refreshMsgCount().then(paintConvos);\n};\nfunction paintSmsStatus(st){\n  var el=$('#smsStatus'); if(!el) return; S.smsStatus=st; var h='';\n  if(!st.key_set) h='<div class=\"steel panel\" style=\"border-color:var(--gold)\"><h3 style=\"margin-top:0\">Turn on texting (about 5 minutes)</h3><ol style=\"margin:.3rem 0 0 1.1rem;padding:0;line-height:1.7\">'+\n      '<li>Buy a key at <a href=\"https://textbelt.com/purchase/?generateKey=1\" target=\"_blank\" rel=\"noopener\">textbelt.com</a>. It\\'s emailed to you right away.</li>'+\n      '<li>On Render, open your backend → <b>Environment</b> → add <code>TEXTBELT_KEY</code> with that key → <b>Save, rebuild, and deploy</b>.</li>'+\n      '<li>So texts can include links (estimates, invoices, rewards), request link approval for your key at <a href=\"https://textbelt.com/whitelist\" target=\"_blank\" rel=\"noopener\">textbelt.com/whitelist</a>.</li>'+\n      '<li>Come back here. This box turns into your remaining text balance.</li></ol></div>';\n  else if(st.free_key) h='<div class=\"steel panel\" style=\"border-color:var(--gold)\">You\\'re on Textbelt\\'s free test key: 1 text a day and no replies. Buy a key at textbelt.com and put it in <code>TEXTBELT_KEY</code> on Render.</div>';\n  else if(st.key_valid===false) h='<div class=\"steel panel\" style=\"border-color:var(--bad)\">The <code>TEXTBELT_KEY</code> on Render isn\\'t valid. Copy it again from your Textbelt email.</div>';\n  else h='<div class=\"row\" style=\"gap:.5rem\"><span class=\"chip gold\">Texting on</span>'+(st.quota!=null?'<span class=\"chip'+(st.quota<50?' bad':'')+'\">'+n(st.quota)+' texts left</span>'+(st.quota<50?' <a href=\"https://textbelt.com/purchase/\" target=\"_blank\" rel=\"noopener\" class=\"dim\">Refill</a>':''):'')+'</div>';\n  if(st.key_set&&!st.inbox_ready) h+='<div class=\"steel panel\" style=\"margin-top:.6rem;border-color:var(--bad)\">Run <b>texting.sql</b> in Supabase so sent texts and replies are saved here.</div>';\n  el.innerHTML=h;\n}\nfunction paintConvos(){\n  var el=$('#convList'); if(!el) return; var L=S.convos||[];\n  if(!L.length){ el.innerHTML='<div class=\"empty\">No texts yet. Send one with <b>New text</b>, or from a customer or job.</div>'; return; }\n  el.innerHTML=L.map(function(c){\n    var nm=(c.member&&c.member.name)||c.phone, ini=String(nm).replace(/[^A-Za-z ]/g,'').trim().split(/\\s+/).map(function(w){ return w[0]; }).join('').slice(0,2).toUpperCase()||'#';\n    return '<button class=\"convo'+(c.unread?' unread':'')+'\" data-pk=\"'+esc(c.phone_key)+'\"><span class=\"av\">'+esc(ini)+'</span><span class=\"mid\"><b>'+esc(nm)+(c.member&&c.member.sms_opt_out?' <span class=\"chip\">No texts</span>':'')+'</b><span>'+(c.last.direction==='out'?'You: ':'')+esc(c.last.body)+'</span></span>'+\n      '<span style=\"text-align:right;white-space:nowrap\"><span class=\"dim\" style=\"font-size:.78rem;display:block\">'+shortWhen(c.last.created_at)+'</span>'+(c.unread?'<span class=\"ub\">'+c.unread+'</span>':'')+'</span></button>';\n  }).join('');\n  $$('#convList [data-pk]').forEach(function(b){ b.addEventListener('click', function(){ openThread(b.dataset.pk); }); });\n}\nfunction shortWhen(d){ var x=new Date(d), now=new Date(); if(x.toDateString()===now.toDateString()) return x.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});\n  var y=new Date(now); y.setDate(now.getDate()-1); if(x.toDateString()===y.toDateString()) return 'Yesterday'; return x.toLocaleDateString([], {month:'short',day:'numeric'}); }\nfunction openThread(pk){\n  if(!pk||pk.length!==10){ toast('This customer has no valid phone number', true); return; }\n  S.thread=pk; var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide'); J=null;\n  sh.innerHTML='<div class=\"row\" style=\"justify-content:space-between\"><h2 style=\"margin:0\" id=\"thName\">Text</h2><button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button></div><div class=\"dim\" id=\"thSub\" style=\"margin:.2rem 0 .6rem\"></div>'+\n    '<div id=\"thread\"><div class=\"empty\">Loading…</div></div>'+\n    '<form class=\"composer\" id=\"thForm\"><textarea name=\"text\" rows=\"2\" maxlength=\"600\" placeholder=\"Type a message…\" required></textarea><button class=\"btn\" type=\"submit\">Send</button></form>'+\n    '<div class=\"row\" style=\"gap:.35rem;flex-wrap:wrap\" id=\"thQuick\"></div><div class=\"help\" id=\"thHint\" style=\"margin-top:.4rem\">Enter sends · Shift+Enter for a new line · {first} fills in their first name</div>';\n  $('#closeDrawer').addEventListener('click', function(){ S.thread=null; closeDrawer(); });\n  var f=$('#thForm'), ta=fe(f,'text');\n  var quick=[['On my way','Hi {first}, this is Upper Echelon Automotive. Your technician is on the way.'],['Running late','Hi {first}, we\\'re running about 20 minutes behind. Sorry for the wait!'],['Car is ready','Hi {first}, your vehicle is all set. Thanks for choosing Upper Echelon Automotive!'],['Call me','Hi {first}, please give us a call when you get a moment.']];\n  $('#thQuick').innerHTML=quick.map(function(q,i){ return '<button type=\"button\" class=\"btn ghost sm\" data-q=\"'+i+'\">'+esc(q[0])+'</button>'; }).join('');\n  $$('#thQuick [data-q]').forEach(function(b){ b.addEventListener('click', function(){ ta.value=quick[+b.dataset.q][1]; ta.focus(); }); });\n  ta.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); f.requestSubmit?f.requestSubmit():f.dispatchEvent(new Event('submit',{cancelable:true})); } });\n  f.addEventListener('submit', function(e){\n    e.preventDefault(); var txt=ta.value.trim(); if(!txt) return; var b=f.querySelector('button'); busy(b,true,'Sending…');\n    api('/admin/messages/'+pk,{method:'POST',body:{text:txt}}).then(function(){ ta.value=''; busy(b,false); loadThread(pk); refreshMsgCount(); })\n      .catch(function(err){ busy(b,false); toast(err.message,true); });\n  });\n  loadThread(pk);\n}\nfunction loadThread(pk, quiet){\n  return api('/admin/messages/'+pk).then(function(d){\n    if(S.thread!==pk||!$('#thread')) return;\n    var m=d.member; $('#thName').textContent=(m&&m.name)||d.phone;\n    $('#thSub').innerHTML=esc(d.phone)+(m?' · <a href=\"#\" id=\"thProfile\" style=\"color:var(--gold)\">Customer profile</a>':' · not saved as a customer')+(m&&m.sms_opt_out?' · <span class=\"chip bad\">Opted out of texts</span>':'');\n    if($('#thProfile')) $('#thProfile').addEventListener('click', function(e){ e.preventDefault(); S.thread=null; openMember(m.id); });\n    var box=$('#thread'), atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<40, last='';\n    box.innerHTML=d.messages.length?d.messages.map(function(x){\n      var day=new Date(x.created_at).toDateString(), sep=day!==last?'<div class=\"tday\">'+new Date(x.created_at).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'})+'</div>':''; last=day;\n      return sep+'<div class=\"bub '+x.direction+'\">'+esc(x.body)+'<small>'+new Date(x.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+(x.direction==='out'&&x.sent_by?' · '+esc(x.sent_by):'')+(x.kind&&x.kind!=='message'?' · '+esc(x.kind.replace('_',' ')):'')+'</small></div>';\n    }).join(''):'<div class=\"empty\">No texts with this number yet. Say hi below.</div>';\n    if(!quiet||atBottom) box.scrollTop=box.scrollHeight;\n    if(!quiet) refreshMsgCount();\n  }).catch(function(e){ if($('#thread')) $('#thread').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\nfunction newTextSheet(){\n  var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide'); J=null; S.thread=null;\n  sh.innerHTML='<div class=\"row\" style=\"justify-content:space-between\"><h2 style=\"margin:0\">New text</h2><button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button></div>'+\n    '<div class=\"field\" style=\"margin-top:1rem\"><label>Customer or phone number</label><input id=\"ntFind\" placeholder=\"Search name, or type a 10-digit number\" autocomplete=\"off\"></div><div id=\"ntRes\"></div>';\n  $('#closeDrawer').addEventListener('click', closeDrawer);\n  var t; $('#ntFind').addEventListener('input', function(){ var q=this.value.trim(), dg=q.replace(/\\D/g,''); clearTimeout(t);\n    if(dg.length>=10&&dg.length===q.replace(/[\\s()+.-]/g,'').length){ $('#ntRes').innerHTML='<button class=\"btn sm\" id=\"ntNum\">Text '+esc(dg.slice(-10))+'</button>'; $('#ntNum').addEventListener('click', function(){ openThread(dg.slice(-10)); }); return; }\n    if(q.length<2){ $('#ntRes').innerHTML=''; return; }\n    t=setTimeout(function(){ api('/admin/members?q='+encodeURIComponent(q)).then(function(r){\n      var L=r.members.filter(function(m){ return m.phone; }).slice(0,8);\n      $('#ntRes').innerHTML=L.length?L.map(function(m,i){ return '<button type=\"button\" class=\"btn ghost sm\" data-ti=\"'+i+'\" style=\"display:block;width:100%;text-align:left;margin-top:.35rem\">'+esc(m.name||'Customer')+' <span class=\"dim\">'+esc(m.phone)+'</span></button>'; }).join(''):'<div class=\"dim\" style=\"margin-top:.4rem\">No customers with a phone number match.</div>';\n      $$('#ntRes [data-ti]').forEach(function(b){ b.addEventListener('click', function(){ openThread(String(L[+b.dataset.ti].phone).replace(/\\D/g,'').slice(-10)); }); });\n    }).catch(function(e){ toast(e.message,true); }); },250); });\n  $('#ntFind').focus();\n}\n/* ───────── VOUCHERS ───────── */\nfunction voucherRow(v){\n  var who=v.member?'<td>'+esc(v.member.name||v.member.email)+(v.member.phone?'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(v.member.phone)+'</div>':'')+'</td>':'';\n  var where=v.status==='applied'?'On booking '+esc(v.booking_order):v.status==='used'?'Used'+(v.used_order?' on '+esc(v.used_order):''):v.status==='void'?(v.points_cost?'Points returned':'Voided'):'Not used yet';\n  var acts=(v.status==='active'||v.status==='applied')?'<button class=\"btn sm\" data-vused=\"'+v.id+'\">Mark used</button>'+(OWN()?' <button class=\"btn danger sm\" data-vvoid=\"'+v.id+'\">Void</button>':''):'';\n  return '<tr><td><b style=\"font-family:var(--head)\">'+esc(v.code)+'</b><div class=\"dim\" style=\"font-size:.82rem\">'+when(v.created_at)+'</div></td>'+who+\n    '<td>'+esc(v.reward_name)+'<div class=\"dim\" style=\"font-size:.82rem\">'+usd(v.value_cents)+' value, '+(v.points_cost?n(v.points_cost)+' pts':'credit (no points)')+'</div></td><td><span class=\"chip '+v.status+'\">'+v.status+'</span><div class=\"dim\" style=\"font-size:.82rem\">'+where+'</div></td><td style=\"white-space:nowrap\">'+acts+'</td></tr>';\n}\nfunction bindVoucherButtons(after){\n  $$('[data-vused]').forEach(function(b){ b.addEventListener('click', function(){\n    var o=prompt('Invoice or job # this was used on (optional):',''); if(o===null) return;\n    api('/admin/voucher/'+b.dataset.vused+'/used',{method:'POST',body:{order:o}}).then(function(){ toast('Voucher marked used'); after(); refreshCounts(); }).catch(function(e){ toast(e.message,true); });\n  }); });\n  $$('[data-vvoid]').forEach(function(b){ b.addEventListener('click', function(){\n    if(!confirm('Void this voucher and return the points?')) return;\n    api('/admin/voucher/'+b.dataset.vvoid+'/void',{method:'POST'}).then(function(){ toast('Voucher voided, points returned'); after(); refreshCounts(); }).catch(function(e){ toast(e.message,true); });\n  }); });\n}\nVIEWS.vouchers = function(){\n  $('#view').innerHTML='<h2>Reward vouchers</h2><p class=\"dim\" style=\"max-width:640px;margin-top:-.6rem\">Codes customers got by redeeming points. Vouchers used on a job are marked used automatically when you mark the job paid with the code.</p>'+\n    '<div class=\"row\" style=\"margin-bottom:1rem\"><select id=\"vstat\" style=\"width:auto\"><option value=\"open\">Open</option><option value=\"used\">Used</option><option value=\"void\">Voided</option><option value=\"all\">All</option></select></div><div id=\"vlist\" class=\"steel\"></div>';\n  $('#vstat').addEventListener('change', loadVouchers); loadVouchers();\n};\nfunction loadVouchers(){\n  api('/admin/vouchers?status='+$('#vstat').value).then(function(d){\n    $('#vlist').innerHTML=d.vouchers.length?'<div class=\"scroll\"><table><tr><th>Code</th><th>Customer</th><th>Reward</th><th>Status</th><th></th></tr>'+d.vouchers.map(voucherRow).join('')+'</table></div>':'<div class=\"empty\">No vouchers here.</div>';\n    bindVoucherButtons(loadVouchers);\n  }).catch(function(e){ $('#vlist').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\n\n/* ───────── WEBSITE REVIEWS ───────── */\nVIEWS.webreviews = function(){\n  $('#view').innerHTML='<h2>Website reviews</h2><p class=\"dim\" style=\"max-width:640px;margin-top:-.6rem\">Reviews customers leave on ueauto.store. Nothing shows on the website until you approve it. To ask for one, text customers this link: <b style=\"color:var(--text)\">ueauto.store/#write-review</b></p>'+\n    '<div class=\"row\" style=\"margin-bottom:1rem\"><select id=\"wrStat\" style=\"width:auto\"><option value=\"pending\">Waiting for approval</option><option value=\"approved\">On the website</option><option value=\"hidden\">Hidden</option></select></div><div id=\"wrList\"><div class=\"empty\">Loading…</div></div>';\n  $('#wrStat').addEventListener('change', loadWebReviews); loadWebReviews();\n};\nfunction wrStars(n){ var s=''; for(var i=1;i<=5;i++) s+=(i<=n?'★':'☆'); return '<span style=\"color:var(--gold);letter-spacing:1px;font-size:1.1rem\">'+s+'</span>'; }\nfunction loadWebReviews(){\n  var st=$('#wrStat').value;\n  api('/admin/site-reviews?status='+st).then(function(d){\n    setCount('cWebRev', d.pending);\n    $('#wrList').innerHTML=d.reviews.length?d.reviews.map(function(r){\n      return '<div class=\"steel panel\" style=\"margin-bottom:.8rem\" data-wr=\"'+esc(r.id)+'\">'+\n        '<div class=\"row\" style=\"justify-content:space-between;gap:.5rem;flex-wrap:wrap\"><div>'+wrStars(r.rating)+' <b>'+esc(r.name)+'</b>'+(r.city?' <span class=\"dim\">· '+esc(r.city)+'</span>':'')+(r.featured?' <span class=\"dim\">· Pinned to top</span>':'')+'</div>'+\n        '<span class=\"dim\">'+esc(new Date(r.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}))+'</span></div>'+\n        (r.service?'<div class=\"dim\" style=\"margin-top:.3rem\">'+esc(r.service)+'</div>':'')+\n        '<p style=\"margin:.7rem 0;white-space:pre-wrap\">'+esc(r.body)+'</p>'+\n        '<div class=\"field\"><label>Your public reply (optional)</label><textarea data-wr-reply rows=\"2\" placeholder=\"Thanks for trusting us with your vehicle!\">'+esc(r.reply||'')+'</textarea></div>'+\n        '<div class=\"row\" style=\"gap:.4rem;flex-wrap:wrap\">'+\n          (r.status!=='approved'?'<button class=\"btn sm\" data-wr-act=\"approve\">Approve</button>':'')+\n          (r.status!=='hidden'?'<button class=\"btn ghost sm\" data-wr-act=\"hide\">'+(r.status==='approved'?'Take off website':'Hide')+'</button>':'')+\n          '<button class=\"btn ghost sm\" data-wr-act=\"reply\">Save reply</button>'+\n          (r.status==='approved'?'<button class=\"btn ghost sm\" data-wr-act=\"feature\" data-on=\"'+(r.featured?'0':'1')+'\">'+(r.featured?'Unpin':'Pin to top')+'</button>':'')+\n          (isRole('owner')?'<button class=\"btn ghost sm\" data-wr-act=\"delete\">Delete</button>':'')+\n        '</div></div>';\n    }).join(''):'<div class=\"steel\"><div class=\"empty\">'+({pending:'No reviews waiting. New ones show up here, and the desk counts them in the menu.',approved:'No reviews on the website yet.',hidden:'Nothing hidden.'}[st])+'</div></div>';\n    $$('#wrList [data-wr-act]').forEach(function(b){ b.addEventListener('click', function(){\n      var card=b.closest('[data-wr]'), act=b.dataset.wrAct, body={action:act};\n      if(act==='delete' && !confirm('Delete this review for good? Hiding it keeps a copy.')) return;\n      if(act==='reply'||act==='approve') body.reply=card.querySelector('[data-wr-reply]').value;\n      if(act==='feature') body.on=b.dataset.on==='1';\n      busy(b,true);\n      api('/admin/site-review/'+encodeURIComponent(card.dataset.wr),{method:'POST',body:body}).then(function(){\n        toast({approve:'Approved. It shows on the website within a minute.',hide:'Hidden from the website',reply:'Reply saved',feature:'Updated',delete:'Deleted'}[act]);\n        loadWebReviews();\n      }).catch(function(e){ busy(b,false); toast(e.message,true); });\n    }); });\n  }).catch(function(e){ $('#wrList').innerHTML='<div class=\"steel\"><div class=\"empty\">'+esc(e.message)+'</div></div>'; });\n}\n\n/* ───────── ADD POINTS (owner) ───────── */\nVIEWS.points = function(){\n  var reasons=['Goodwill','Job paid before the program started','Correction','Promotion','Other'];\n  $('#view').innerHTML='<h2>Add points</h2><p class=\"dim\" style=\"max-width:640px;margin-top:-.6rem\">Give or remove points by hand. The reason shows in the customer\\'s history. For paid jobs, mark the job paid instead so tier and bonuses count.</p>'+\n    '<form id=\"ptsForm\" class=\"steel panel\" style=\"max-width:600px\"><div class=\"field\"><label>Customer</label><input id=\"ptsFind\" placeholder=\"Search by name, email, or phone\" autocomplete=\"off\"><div id=\"ptsResults\"></div><div id=\"ptsPicked\" class=\"help\"></div></div>'+\n    '<div id=\"ptsNew\" class=\"grid g2 hide\"><div class=\"field\"><label>Email (new member)</label><input name=\"email\" type=\"email\"></div><div class=\"field\"><label>Name</label><input name=\"name\"></div></div>'+\n    '<div class=\"grid g2\"><div class=\"field\"><label>Points</label><input name=\"points\" type=\"number\" step=\"1\" placeholder=\"100, or -100 to remove\"></div><div class=\"field\"><label>Reason</label><select name=\"reason\">'+reasons.map(function(r){return '<option>'+esc(r)+'</option>';}).join('')+'</select></div></div>'+\n    '<div class=\"field\"><label>Note for the customer</label><input name=\"note\" placeholder=\"e.g. Sorry for the late arrival on Oct 2\"></div><button class=\"btn\">Apply points</button><div id=\"ptsOut\" class=\"help\" style=\"margin-top:.8rem\"></div></form>';\n  var picked=null, t;\n  function pick(m){ picked=m; $('#ptsResults').innerHTML=''; $('#ptsFind').value=''; $('#ptsNew').classList.add('hide');\n    $('#ptsPicked').innerHTML=m?'Selected: <b style=\"color:var(--text)\">'+esc(m.name||m.email)+'</b> ('+esc(m.email||'')+', '+n(m.points_balance)+' points) <a href=\"#\" id=\"ptsClear\">Change</a>':'';\n    if(m) $('#ptsClear').addEventListener('click', function(e){ e.preventDefault(); pick(null); }); }\n  $('#ptsFind').addEventListener('keydown', function(e){ if(e.key==='Enter') e.preventDefault(); });\n  $('#ptsFind').addEventListener('input', function(){ clearTimeout(t); var q=this.value.trim(); if(q.length<2){ $('#ptsResults').innerHTML=''; return; }\n    t=setTimeout(function(){ api('/admin/members?q='+encodeURIComponent(q)).then(function(d){\n      $('#ptsResults').innerHTML=d.members.slice(0,6).map(function(m,i){ return '<button type=\"button\" class=\"btn ghost sm\" data-pi=\"'+i+'\" style=\"display:block;width:100%;text-align:left;margin-top:.3rem\">'+esc(m.name||'—')+' <span class=\"dim\">'+esc(m.email||'')+', '+n(m.points_balance)+' pts</span></button>'; }).join('')+\n        '<button type=\"button\" class=\"btn ghost sm\" id=\"ptsAddNew\" style=\"display:block;width:100%;text-align:left;margin-top:.3rem\">Not a member yet? Add by email</button>';\n      $$('#ptsResults [data-pi]').forEach(function(b){ b.addEventListener('click', function(){ pick(d.members[+b.dataset.pi]); }); });\n      $('#ptsAddNew').addEventListener('click', function(){ pick(null); $('#ptsNew').classList.remove('hide'); var f=$('#ptsForm'); if(/@/.test(q)) fe(f,'email').value=q; fe(f,'email').focus(); });\n    }); }, 250); });\n  $('#ptsForm').addEventListener('submit', function(e){\n    e.preventDefault(); var f=e.target, out=$('#ptsOut'), pts=parseInt(fe(f,'points').value,10);\n    if(!pts){ out.innerHTML='<span class=\"minus\">Enter a point amount.</span>'; return; }\n    if(!picked && !fe(f,'email').value.trim()){ out.innerHTML='<span class=\"minus\">Pick a customer, or choose \"Add by email.\"</span>'; return; }\n    var who=picked?(picked.name||picked.email):fe(f,'email').value.trim();\n    if(!confirm((pts>0?'Add ':'Remove ')+n(Math.abs(pts))+' points '+(pts>0?'to ':'from ')+who+'?')) return;\n    var body={points:pts,note:fe(f,'reason').value+(fe(f,'note').value.trim()?': '+fe(f,'note').value.trim():'')};\n    if(picked) body.member_id=picked.id; else { body.email=fe(f,'email').value.trim(); body.name=fe(f,'name').value.trim(); }\n    api('/admin/adjust',{method:'POST',body:body}).then(function(r){ out.innerHTML='<span class=\"plus\">Done. New balance: '+n(r.balance)+'.</span>'; f.reset(); pick(null); })\n      .catch(function(err){ out.innerHTML='<span class=\"minus\">'+esc(err.message)+'</span>'; });\n  });\n};\n\n/* ───────── SHOP OVERVIEW (owner + writer; money only for owner) ───────── */\nVIEWS.overview = function(){\n  var own=OWN();\n  Promise.all([api('/admin/overview'), api('/admin/followups').catch(function(){ return {followups:[]}; }), own?api('/admin/stats').catch(function(){ return null; }):Promise.resolve(null)]).then(function(r){\n    var o=r[0], w=o.work, fu=r[1].followups, fuVal=fu.reduce(function(a,f){ return a+f.value_cents; },0), st=r[2], m=o.money;\n    var h='<h2>Shop overview</h2>';\n    if(own&&m){\n      h+='<div class=\"steel panel sec ownstrip\"><div class=\"row\" style=\"justify-content:space-between;margin-bottom:.7rem\"><h3 style=\"margin:0\">Owner snapshot <span class=\"chip purple\">Only you see this</span></h3><button class=\"btn sm\" data-goto=\"books\">Open Books</button></div>';\n      if(m.month){\n        var mg=m.month.income?Math.round(m.month.net/m.month.income*100):0;\n        h+='<div class=\"gauges\" style=\"margin-bottom:.8rem\">'+\n          '<div class=\"gauge\"><b>'+usd(m.month.income)+'</b><span>Money in this month</span></div>'+\n          '<div class=\"gauge\"><b>'+usd(m.month.expenses)+'</b><span>Expenses this month</span></div>'+\n          '<div class=\"gauge\"><b class=\"'+(m.month.net<0?'neg':'')+'\">'+usd(m.month.net)+'</b><span>Profit this month</span><em>'+(m.month.income?mg+'% margin':'')+'</em></div>'+\n          '<div class=\"gauge\"><b>'+usd(m.month.set_aside)+'</b><span>Set aside for taxes</span></div></div>';\n      } else h+='<p class=\"dim\" style=\"margin:0 0 .8rem\">Finish the one-time Books setup to see profit and expenses here. <a href=\"#\" data-goto=\"books\">Set up Books</a></p>';\n      h+='<div class=\"grid g4\">'+mini('Job revenue, 30 days',usd(m.revenue_30d))+mini('Jobs paid, 30 days',n(m.jobs_30d))+mini('Average ticket',usd(m.avg_ticket_30d))+mini('Unredeemed points owed',usd(m.points_liability_cents))+'</div></div>';\n    }\n    h+='<h3 class=\"ovh\">Workload</h3><div class=\"gauges\">'+\n      '<div class=\"gauge\"><b>'+n(w.open)+'</b><span>Open jobs</span><em>'+n(w.unassigned)+' unassigned</em></div>'+\n      '<div class=\"gauge\"><b>'+n(w.today)+'</b><span>Scheduled today</span><em>Includes overdue</em></div>'+\n      '<div class=\"gauge\"><b>'+n(w.next_7)+'</b><span>Next 7 days</span><em>'+n(w.unscheduled)+' not scheduled yet</em></div>'+\n      '<div class=\"gauge\"><b>'+n(w.done_not_paid)+'</b><span>Done, not paid</span><em>'+usd(w.done_not_paid_cents)+' to collect</em></div></div>'+\n      '<div class=\"grid g2 sec\"><div class=\"steel panel\"><h3>Jobs by stage</h3><div class=\"stagebars\">'+o.stages.map(function(s){\n        var v=w.by_stage[s.key]||0, max=Math.max.apply(null,o.stages.map(function(x){ return w.by_stage[x.key]||0; }).concat([1]));\n        return '<button class=\"sbar\" data-goto=\"jobs\"><span>'+esc(s.label)+'</span><i><em style=\"width:'+(v?Math.max(4,Math.round(v/max*100)):0)+'%\"></em></i><b>'+n(v)+'</b></button>';\n      }).join('')+'</div></div>'+\n      '<div class=\"steel panel\"><h3>Finished work</h3><div class=\"kv\"><dt>Paid this week</dt><dd>'+n(w.paid_week)+' job'+(w.paid_week===1?'':'s')+'</dd><dt>Paid this month</dt><dd>'+n(w.paid_month)+' job'+(w.paid_month===1?'':'s')+'</dd></div>'+\n        '<h3 style=\"margin-top:1.1rem\">Declined work to follow up</h3><div class=\"kv\"><dt>Customers</dt><dd>'+n(fu.length)+'</dd><dt>Work value</dt><dd>'+usd(fuVal)+'</dd></div>'+\n        '<button class=\"btn ghost sm\" data-goto=\"followups\" style=\"margin-top:.7rem\">Open follow-ups</button></div></div>'+\n      '<h3 class=\"ovh\">Rewards program</h3><div class=\"grid g4 sec\">'+mini('Members',n(o.rewards.members))+mini('Joined, 30 days',n(o.rewards.new_30d))+mini('Open reward vouchers',usd(o.rewards.open_voucher_cents))+mini('Referrals converted',n(o.rewards.referrals_converted))+'</div>';\n    if(st&&st.recent) h+='<div class=\"steel panel\"><h3>Recent points activity</h3>'+(st.recent.length?'<div class=\"scroll\"><table>'+st.recent.map(function(x){ return '<tr><td class=\"dim\">'+when(x.created_at)+'</td><td>'+esc(x.member?(x.member.name||x.member.email):'')+'</td><td>'+esc(x.note||TYPE[x.type])+'</td><td>'+signed(x.points)+'</td></tr>'; }).join('')+'</table></div>':'<div class=\"empty\">No activity yet.</div>')+'</div>';\n    $('#view').innerHTML=h;\n    $$('#view [data-goto]').forEach(function(b){ b.addEventListener('click', function(e){ e.preventDefault(); go(b.dataset.goto); window.scrollTo(0,0); }); });\n  }).catch(fail);\n};\n\n/* ───────── BOOKS (owner only) ───────── */\nS.books={preset:'month', from:null, to:null, sub:'summary', q:'', cat:''};\nvar BOOK_PRESETS=[['month','This month'],['last_month','Last month'],['quarter','This quarter'],['ytd','This year'],['last_year','Last year'],['custom','Custom']];\nvar BOOK_SUBS=[['summary','Summary'],['out','Money out'],['in','Money in'],['miles','Mileage'],['repeat','Repeating bills'],['setup','Setup']];\nfunction bookRange(p){\n  var t=todayIso(), y=+t.slice(0,4), mo=+t.slice(5,7), pad=function(x){ return String(x).padStart(2,'0'); };\n  var last=function(yy,mm){ return new Date(Date.UTC(yy,mm,0)).getUTCDate(); };\n  if(p==='last_month'){ var ly=mo===1?y-1:y, lm=mo===1?12:mo-1; return [ly+'-'+pad(lm)+'-01', ly+'-'+pad(lm)+'-'+pad(last(ly,lm))]; }\n  if(p==='quarter'){ var qm=Math.floor((mo-1)/3)*3+1; return [y+'-'+pad(qm)+'-01', t]; }\n  if(p==='ytd') return [y+'-01-01', t];\n  if(p==='last_year') return [(y-1)+'-01-01', (y-1)+'-12-31'];\n  return [t.slice(0,8)+'01', t];\n}\nfunction bookCat(cfg, kind, key){ var L=kind==='income'?cfg.income_categories:cfg.categories; for(var i=0;i<L.length;i++) if(L[i].key===key) return L[i]; return {key:key,name:key,group:kind==='income'?'income':'opex'}; }\nfunction shortDay(iso){ var p=String(iso).split('-'); return new Date(Date.UTC(+p[0],+p[1]-1,+p[2])).toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'}); }\nfunction monthLabel(ym){ var p=ym.split('-'); return new Date(Date.UTC(+p[0],+p[1]-1,1)).toLocaleDateString(undefined,{month:'short',timeZone:'UTC'}); }\n\nVIEWS.books = function(){\n  var B=S.books;\n  if(!B.from||B.preset!=='custom'){ var r=bookRange(B.preset); B.from=r[0]; B.to=r[1]; }\n  var h='<div class=\"row\" style=\"justify-content:space-between;margin-bottom:.4rem\"><h2 style=\"margin:0\">Books</h2>'+\n    '<div class=\"row\"><button class=\"btn sm\" data-new=\"expense\">+ Expense</button><button class=\"btn ghost sm\" data-new=\"income\">+ Income</button></div></div>'+\n    '<p class=\"dim\" style=\"margin:.2rem 0 1rem\">Only you can see this. Job payments marked paid in the desk come in on their own; add everything else here.</p>'+\n    '<div class=\"row bkbar\"><select id=\"bkP\" style=\"width:auto\">'+BOOK_PRESETS.map(function(p){ return '<option value=\"'+p[0]+'\"'+(p[0]===B.preset?' selected':'')+'>'+p[1]+'</option>'; }).join('')+'</select>'+\n    '<span id=\"bkCustom\" class=\"row'+(B.preset==='custom'?'':' hide')+'\"><input type=\"date\" id=\"bkF\" value=\"'+B.from+'\" style=\"width:auto\"><span class=\"dim\">to</span><input type=\"date\" id=\"bkT\" value=\"'+B.to+'\" style=\"width:auto\"></span>'+\n    '<span class=\"dim\" id=\"bkRange\">'+shortDay(B.from)+' – '+shortDay(B.to)+'</span><span style=\"flex:1\"></span><button class=\"btn ghost sm\" id=\"bkCsv\">Export for accountant (CSV)</button></div>'+\n    '<div class=\"subtabs\" role=\"tablist\">'+BOOK_SUBS.map(function(s){ return '<button data-sub=\"'+s[0]+'\" class=\"'+(s[0]===B.sub?'on':'')+'\">'+s[1]+'</button>'; }).join('')+'</div><div id=\"bk\"><div class=\"empty\">Loading…</div></div>';\n  $('#view').innerHTML=h;\n  $('#bkP').addEventListener('change', function(){ B.preset=this.value; if(B.preset!=='custom'){ var r=bookRange(B.preset); B.from=r[0]; B.to=r[1]; } VIEWS.books(); });\n  var cust=function(){ var f=$('#bkF').value, t=$('#bkT').value; if(f&&t){ B.from=f; B.to=t; VIEWS.books(); } };\n  $('#bkF').addEventListener('change', cust); $('#bkT').addEventListener('change', cust);\n  $$('[data-sub]').forEach(function(b){ b.addEventListener('click', function(){ B.sub=b.dataset.sub; VIEWS.books(); }); });\n  $$('[data-new]').forEach(function(b){ b.addEventListener('click', function(){ entrySheet(null, b.dataset.new); }); });\n  $('#bkCsv').addEventListener('click', function(){ var btn=this; busy(btn,true,'Exporting…');\n    api('/admin/books/export?from='+B.from+'&to='+B.to).then(function(d){ busy(btn,false); if(d.setup_needed) return toast('Finish the Books setup first',true);\n      var a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([d.csv],{type:'text/csv'})); a.download=d.filename; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },500);\n    }).catch(function(e){ busy(btn,false); toast(e.message,true); }); });\n  if(B.sub==='repeat') return paintRepeat();\n  if(B.sub==='setup') return paintBookSetup();\n  api('/admin/books?from='+B.from+'&to='+B.to).then(function(d){\n    if(d.setup_needed) return paintBookSetupNeeded();\n    S.bk=d;\n    ({summary:paintBookSummary, out:paintBookOut, 'in':paintBookIn, miles:paintBookMiles})[B.sub](d);\n  }).catch(function(e){ $('#bk').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n};\n\nfunction paintBookSetupNeeded(){\n  $('#bk').innerHTML='<div class=\"steel panel\" style=\"max-width:720px\"><h3>One-time setup</h3>'+\n    '<p>Books needs a few new tables in your database. This takes about a minute and doesn\\'t change any of your existing data.</p><ol class=\"steps\">'+\n    '<li>Open <a href=\"https://supabase.com/dashboard/project/vdhcnrnubcdbzpxwthro/sql/new\" target=\"_blank\" rel=\"noopener\">Supabase → SQL Editor → New query</a>.</li>'+\n    '<li>Paste everything from <b>books_migration.sql</b> and click <b>Run</b>. It should say \"Success. No rows returned.\"</li>'+\n    '<li>Come back here and tap <b>Check again</b>.</li></ol><button class=\"btn\" id=\"bkRetry\">Check again</button></div>';\n  $('#bkRetry').addEventListener('click', function(){ VIEWS.books(); });\n}\n\nfunction paintBookSummary(d){\n  var t=d.totals, cfg=d.settings, mg=t.income?Math.round(t.net/t.income*100):0, jobCost=cfg.parts_cost_source!=='expenses';\n  var line=function(l,v,cls){ return '<tr class=\"'+(cls||'')+'\"><td>'+l+'</td><td class=\"num\">'+v+'</td></tr>'; };\n  var pl='<table class=\"pl\">'+line('<b>Income</b>','','hd')+\n    line('Job labor & fees',usd(t.job_labor))+line('Job parts sold',usd(t.job_parts))+\n    Object.keys(t.by_income_cat).map(function(k){ return line(esc(bookCat(cfg,'income',k).name), usd(t.by_income_cat[k])); }).join('')+\n    line('Total income',usd(t.income),'tot')+\n    line('<b>Cost of parts</b>','','hd')+\n    (jobCost?line('Parts cost on paid jobs'+(t.cost_missing?' <span class=\"chip warn\">'+t.cost_missing+' missing</span>':''),usd(t.job_parts_cost)):'')+\n    (t.cogs_expenses||!jobCost?line('Parts receipts logged',usd(t.cogs_expenses)):'')+\n    line('Gross profit',usd(t.gross)+(t.income?' <span class=\"dim\">'+Math.round(t.gross/t.income*100)+'%</span>':''),'tot')+\n    line('<b>Operating expenses</b>','','hd')+\n    cfg.categories.filter(function(c){ return c.group==='opex' && t.by_cat[c.key]; }).map(function(c){ return line(esc(c.name), usd(t.by_cat[c.key])); }).join('')+\n    (t.opex?'':line('<span class=\"dim\">None logged yet</span>',''))+\n    line('Total operating expenses',usd(t.opex),'tot')+\n    line('Net profit',usd(t.net),'net'+(t.net<0?' neg':''))+'</table>'+\n    '<p class=\"help\">Owner pay (draws) of '+usd(t.draws)+' and money you put in ('+usd(t.contributions)+') aren\\'t profit or expenses, so they\\'re left out of this statement.</p>';\n  var cats=cfg.categories.filter(function(c){ return c.group!=='transfer' && t.by_cat[c.key]; }).map(function(c){ return {name:c.name, v:t.by_cat[c.key]}; });\n  if(jobCost&&t.job_parts_cost) cats.push({name:'Parts on paid jobs', v:t.job_parts_cost});\n  cats.sort(function(a,b){ return b.v-a.v; });\n  var cmax=cats.length?cats[0].v:1, ctot=cats.reduce(function(a,c){ return a+c.v; },0);\n  var tmax=Math.max.apply(null, d.trend.map(function(x){ return Math.max(x.income,x.expenses); }).concat([1]));\n  var h='<div class=\"gauges\">'+\n    '<div class=\"gauge\"><b>'+usd(t.income)+'</b><span>Money in</span><em>'+n(t.jobs)+' paid job'+(t.jobs===1?'':'s')+'</em></div>'+\n    '<div class=\"gauge\"><b>'+usd(t.expenses_all)+'</b><span>Expenses</span><em>Parts + operating</em></div>'+\n    '<div class=\"gauge\"><b class=\"'+(t.net<0?'neg':'')+'\">'+usd(t.net)+'</b><span>Net profit</span><em>'+(t.income?mg+'% of income':'')+'</em></div>'+\n    '<div class=\"gauge\"><b>'+usd(t.tax_set_aside)+'</b><span>Set aside for taxes</span><em>'+n(cfg.tax_set_aside_pct)+'% of profit</em></div></div>';\n  if(jobCost&&t.cost_missing) h+='<div class=\"steel panel sec warnbox\">'+t.cost_missing+' paid job'+(t.cost_missing===1?' has':'s have')+' parts with no cost entered, so profit looks higher than it is. <a href=\"#\" id=\"bkMiss\">See which jobs</a></div>';\n  h+='<div class=\"grid g2 sec\"><div class=\"steel panel\"><h3>Profit & loss</h3>'+pl+'</div>'+\n    '<div><div class=\"steel panel sec\"><h3>Where the money went</h3>'+(cats.length?'<div class=\"stagebars\">'+cats.map(function(c){\n      return '<div class=\"sbar\"><span>'+esc(c.name)+'</span><i><em class=\"pu\" style=\"width:'+Math.max(3,Math.round(c.v/cmax*100))+'%\"></em></i><b>'+usd(c.v)+' <small class=\"dim\">'+Math.round(c.v/ctot*100)+'%</small></b></div>'; }).join('')+'</div>':'<div class=\"dim\">No expenses in this period yet. Tap <b>+ Expense</b> to add gas, marketing, tools and more.</div>')+'</div>'+\n    '<div class=\"steel panel\"><h3>Cash in and out</h3><div class=\"kv\"><dt>Came in</dt><dd>'+usd(t.money_in)+'</dd><dt>Went out</dt><dd>'+usd(t.money_out)+'</dd><dt>Owner pay</dt><dd>'+usd(t.draws)+'</dd><dt>Business miles</dt><dd>'+n(d.mileage.miles)+' mi <span class=\"dim\">≈ '+usd(d.mileage.deduction_cents)+' deduction</span></dd></div></div></div></div>'+\n    '<div class=\"steel panel sec\"><div class=\"row\" style=\"justify-content:space-between\"><h3 style=\"margin:0\">Last 12 months</h3><div class=\"row legend\"><span><i class=\"lg go\"></i>Money in</span><span><i class=\"lg pu\"></i>Expenses</span></div></div>'+\n    '<div class=\"trend\">'+d.trend.map(function(m){\n      return '<div class=\"tcol\" title=\"'+monthLabel(m.month)+': in '+usd(m.income)+', out '+usd(m.expenses)+', profit '+usd(m.net)+'\"><div class=\"tbars\"><i class=\"go\" style=\"height:'+Math.round(m.income/tmax*100)+'%\"></i><i class=\"pu\" style=\"height:'+Math.round(m.expenses/tmax*100)+'%\"></i></div>'+\n        '<small class=\"'+(m.net<0?'neg':'')+'\">'+(m.income||m.expenses?(m.net<0?'-':'')+'$'+Math.abs(Math.round(m.net/100)).toLocaleString():'')+'</small><span>'+monthLabel(m.month)+'</span></div>'; }).join('')+'</div><p class=\"help\">The number under each month is profit.</p></div>';\n  h+='<div class=\"steel panel\"><h3>Contractor pay this year ('+d.year+')</h3>'+(d.contractors_ytd.length?'<p class=\"help\" style=\"margin-top:0\">Totals per person for 1099 forms. Ask your tax preparer which ones need a 1099-NEC.</p><div class=\"kv\">'+d.contractors_ytd.map(function(c){ return '<dt>'+esc(c.payee)+'</dt><dd>'+usd(c.cents)+'</dd>'; }).join('')+'</div>':'<div class=\"dim\">No contractor pay logged this year. Log tech pay as an expense under \"Contractor / tech pay\" with their name as the payee.</div>')+'</div>';\n  $('#bk').innerHTML=h;\n  if($('#bkMiss')) $('#bkMiss').addEventListener('click', function(e){ e.preventDefault(); S.books.sub='in'; S.books.missing=true; VIEWS.books(); });\n}\n\nfunction entryRow(e, cfg){\n  var c=bookCat(cfg,e.kind,e.category);\n  return '<button class=\"lrow\" data-entry=\"'+e.id+'\"><span class=\"ld\">'+shortDay(e.entry_date)+'</span><span class=\"lm\"><b>'+esc(e.vendor||c.name)+'</b>'+\n    '<small>'+esc(c.name)+(e.job_ref?' · '+esc(e.job_ref):'')+(e.method?' · '+esc(e.method):'')+(e.description?' · '+esc(e.description):'')+'</small></span>'+\n    '<span class=\"lt\">'+(e.booking_id?'<span class=\"chip gold\">Job</span>':'')+(e.has_receipt?'<span class=\"chip\" title=\"Receipt saved\">Receipt</span>':'')+(e.recurring_id?'<span class=\"chip purple\">Monthly</span>':'')+(c.group==='transfer'?'<span class=\"chip\">Owner</span>':'')+'</span>'+\n    '<span class=\"la '+(e.kind==='income'?'plus':'')+'\">'+(e.kind==='income'?'+':'')+usd(e.amount_cents)+'</span></button>';\n}\nfunction bindEntryRows(d){ $$('#bk [data-entry]').forEach(function(b){ b.addEventListener('click', function(){ var e=d.entries.filter(function(x){ return x.id===b.dataset.entry; })[0]; if(e) entrySheet(e); }); }); }\n\nfunction paintBookOut(d){\n  var B=S.books, cfg=d.settings, all=d.entries.filter(function(e){ return e.kind==='expense'; });\n  var h='<div class=\"row sec\"><select id=\"bkCat\" style=\"width:auto\"><option value=\"\">All categories</option>'+cfg.categories.map(function(c){ return '<option value=\"'+esc(c.key)+'\"'+(B.cat===c.key?' selected':'')+'>'+esc(c.name)+'</option>'; }).join('')+'</select>'+\n    '<input id=\"bkQ\" placeholder=\"Search payee or note\" value=\"'+esc(B.q)+'\" style=\"flex:1;min-width:180px\"></div><div id=\"bkList\"></div>';\n  $('#bk').innerHTML=h;\n  var paint=function(){\n    var q=B.q.toLowerCase(), L=all.filter(function(e){ return (!B.cat||e.category===B.cat) && (!q||((e.vendor||'')+' '+(e.description||'')+' '+(e.job_ref||'')).toLowerCase().indexOf(q)>-1); });\n    var tot=L.reduce(function(a,e){ return a+Number(e.amount_cents); },0);\n    $('#bkList').innerHTML=L.length?'<div class=\"dim\" style=\"margin-bottom:.5rem\">'+L.length+' expense'+(L.length===1?'':'s')+' · '+usd(tot)+'</div><div class=\"steel llist\">'+L.map(function(e){ return entryRow(e,cfg); }).join('')+'</div>'+\n      (cfg.parts_cost_source!=='expenses'&&d.totals.job_parts_cost?'<p class=\"help\">Parts cost from paid jobs ('+usd(d.totals.job_parts_cost)+') is counted automatically and isn\\'t listed here. See Money in.</p>':'')\n      :'<div class=\"steel empty\">No expenses'+(B.cat||B.q?' match':' in this period')+'. Tap <b>+ Expense</b> to add one.</div>';\n    bindEntryRows(d);\n  };\n  $('#bkCat').addEventListener('change', function(){ B.cat=this.value; paint(); });\n  var tm; $('#bkQ').addEventListener('input', function(){ var v=this.value; clearTimeout(tm); tm=setTimeout(function(){ B.q=v; paint(); },200); });\n  paint();\n}\n\nfunction paintBookIn(d){\n  var B=S.books, cfg=d.settings, jobCost=cfg.parts_cost_source!=='expenses', other=d.entries.filter(function(e){ return e.kind==='income'; });\n  var jobs=B.missing?d.jobs.filter(function(j){ return j.cost_missing; }):d.jobs;\n  var h='<div class=\"steel panel sec\"><div class=\"row\" style=\"justify-content:space-between\"><h3 style=\"margin:0\">Job payments from the desk</h3>'+(B.missing?'<button class=\"btn ghost sm\" id=\"bkAll\">Show all jobs</button>':'')+'</div>'+\n    '<p class=\"help\" style=\"margin-top:.2rem\">'+(B.missing?'Jobs with parts but no cost entered. Open each one, add the part cost on the Estimate tab (or log the parts receipt on its Job costs tab), and the profit updates.':'Added automatically when a job is marked paid. Profit takes out parts and any expenses you added on the job. Tap one to open it and add costs.')+'</p>'+\n    (jobs.length?'<div class=\"scroll\"><table class=\"jt\"><tr><th>Date</th><th>Job</th><th class=\"num\">Labor</th><th class=\"num\">Parts</th><th class=\"num\">Total</th>'+(jobCost?'<th class=\"num\">Parts cost</th>':'')+'<th class=\"num\">Job expenses</th><th class=\"num\">Profit</th></tr>'+\n      jobs.map(function(j){ var gp=j.job_profit_cents, pc=(jobCost?j.parts_cost_cents:0)+(j.receipt_parts_cents||0);\n        return '<tr data-job=\"'+j.id+'\" class=\"click\"><td class=\"dim\">'+shortDay(j.day)+'</td><td><b>'+esc(j.customer_name||'Customer')+'</b><div class=\"dim\" style=\"font-size:.84rem\">'+esc([j.order_name,j.service].filter(Boolean).join(' · '))+'</div></td>'+\n          '<td class=\"num\">'+usd(j.labor_cents)+'</td><td class=\"num\">'+usd(j.parts_cents)+'</td><td class=\"num\"><b>'+usd(j.total_cents)+'</b></td>'+\n          (jobCost?'<td class=\"num\">'+(j.cost_missing?'<span class=\"chip warn\">Missing</span>':usd(pc))+'</td>':'')+'<td class=\"num\">'+usd((j.job_expense_cents||0)+(jobCost?0:(j.receipt_parts_cents||0)))+'</td><td class=\"num\"><b class=\"'+(gp<0?'neg':'')+'\">'+usd(gp)+'</b></td></tr>'; }).join('')+'</table></div>'\n      :'<div class=\"dim\">'+(B.missing?'Every paid job has its part costs. Nice.':'No jobs marked paid in this period.')+'</div>')+'</div>'+\n    '<div class=\"steel panel\"><div class=\"row\" style=\"justify-content:space-between\"><h3 style=\"margin:0\">Other money in</h3><button class=\"btn ghost sm\" data-new2=\"income\">+ Add income</button></div>'+\n    '<p class=\"help\" style=\"margin-top:.2rem\">FleetCare billing, online store orders, jobs paid outside the desk, refunds, or money you put into the business.</p>'+\n    (other.length?'<div class=\"llist\">'+other.map(function(e){ return entryRow(e,cfg); }).join('')+'</div>':'<div class=\"dim\">Nothing added in this period.</div>')+'</div>';\n  $('#bk').innerHTML=h;\n  $$('#bk [data-job]').forEach(function(r){ r.addEventListener('click', function(){ openJob(r.dataset.job); }); });\n  $$('#bk [data-new2]').forEach(function(b){ b.addEventListener('click', function(){ entrySheet(null,'income'); }); });\n  if($('#bkAll')) $('#bkAll').addEventListener('click', function(){ B.missing=false; VIEWS.books(); });\n  bindEntryRows(d);\n}\n\nfunction paintBookMiles(d){\n  var cfg=d.settings;\n  var h='<div class=\"grid g2 sec\"><form id=\"mForm\" class=\"steel panel\"><h3>Log business miles</h3><div class=\"grid g2\">'+fld('Date','trip_date',todayIso(),'','date')+fld('Miles driven','miles','','','number','decimal')+'</div>'+\n    '<p class=\"help\" style=\"margin-top:-.4rem\">Or use the odometer:</p><div class=\"grid g2\">'+fld('Odometer start','odo_start','','','number','numeric')+fld('Odometer end','odo_end','','','number','numeric')+'</div>'+\n    fld('Where / why (job, parts run…)','purpose','')+'<button class=\"btn\">Add trip</button></form>'+\n    '<div class=\"steel panel\"><h3>This period</h3><div class=\"kv\"><dt>Miles</dt><dd>'+n(d.mileage.miles)+'</dd><dt>Rate</dt><dd>$'+(cfg.mileage_rate_cents/100).toFixed(2)+' per mile</dd><dt>Deduction</dt><dd><b>'+usd(d.mileage.deduction_cents)+'</b></dd></div>'+\n    '<p class=\"help\">Most owners pick one method per vehicle: the standard mileage rate, or actual gas and repair costs. Ask your tax preparer which works better for your truck. Change the rate under Setup when the IRS updates it.</p></div></div>'+\n    '<div class=\"steel llist\">'+(d.trips.length?d.trips.map(function(t){ return '<div class=\"lrow\"><span class=\"ld\">'+shortDay(t.trip_date)+'</span><span class=\"lm\"><b>'+n(t.miles)+' mi</b><small>'+esc(t.purpose||'')+'</small></span><span class=\"lt\"></span><span class=\"la\"><button class=\"btn ghost sm\" data-deltrip=\"'+t.id+'\">Remove</button></span></div>'; }).join(''):'<div class=\"empty\">No trips logged in this period.</div>')+'</div>';\n  $('#bk').innerHTML=h;\n  $('#mForm').addEventListener('submit', function(e){ e.preventDefault(); var f=e.target, btn=f.querySelector('.btn'); busy(btn,true,'Saving…');\n    api('/admin/books/mileage',{method:'POST',body:{trip_date:fe(f,'trip_date').value,miles:fe(f,'miles').value,odo_start:fe(f,'odo_start').value||null,odo_end:fe(f,'odo_end').value||null,purpose:fe(f,'purpose').value}})\n      .then(function(){ toast('Trip added'); VIEWS.books(); }).catch(function(err){ busy(btn,false); toast(err.message,true); }); });\n  $$('[data-deltrip]').forEach(function(b){ b.addEventListener('click', function(){ if(!confirm('Remove this trip?')) return;\n    api('/admin/books/mileage/'+b.dataset.deltrip,{method:'DELETE'}).then(function(){ toast('Trip removed'); VIEWS.books(); }).catch(function(e){ toast(e.message,true); }); }); });\n}\n\nfunction paintRepeat(){\n  api('/admin/books/recurring').then(function(d){\n    if(d.setup_needed) return paintBookSetupNeeded();\n    var cfg=d.settings, L=d.recurring;\n    $('#bk').innerHTML='<p class=\"help\" style=\"margin-top:0\">Bills that post themselves every month on the same day, like insurance, phone or software. To add one, create an expense and check <b>Repeats every month</b>.</p>'+\n      '<div class=\"steel llist\">'+(L.length?L.map(function(r){ var c=bookCat(cfg,r.kind,r.category);\n        return '<div class=\"lrow\"><span class=\"ld\">Day '+r.day_of_month+'</span><span class=\"lm\"><b>'+esc(r.vendor||c.name)+'</b><small>'+esc(c.name)+(r.method?' · '+esc(r.method):'')+(r.last_posted?' · last posted '+shortDay(r.last_posted):'')+'</small></span>'+\n          '<span class=\"lt\">'+(r.active?'<span class=\"chip good\">Active</span>':'<span class=\"chip\">Paused</span>')+'</span>'+\n          '<span class=\"la\">'+usd(r.amount_cents)+'<span class=\"row\" style=\"gap:.3rem;margin-top:.3rem;justify-content:flex-end\"><button class=\"btn ghost sm\" data-ramt=\"'+r.id+'\" data-v=\"'+dollars(r.amount_cents)+'\">Amount</button><button class=\"btn ghost sm\" data-rtog=\"'+r.id+'\" data-on=\"'+(r.active?0:1)+'\">'+(r.active?'Pause':'Resume')+'</button><button class=\"btn danger sm\" data-rdel=\"'+r.id+'\">Stop</button></span></span></div>'; }).join('')\n        :'<div class=\"empty\">No repeating bills yet.</div>')+'</div>';\n      var p=function(id, body, msg){ api('/admin/books/recurring/'+id,{method:'PATCH',body:body}).then(function(){ toast(msg); VIEWS.books(); }).catch(function(e){ toast(e.message,true); }); };\n      $$('[data-ramt]').forEach(function(b){ b.addEventListener('click', function(){ var v=prompt('New monthly amount ($). Months already posted stay the same.', b.dataset.v); if(v) p(b.dataset.ramt,{amount:v},'Amount updated'); }); });\n      $$('[data-rtog]').forEach(function(b){ b.addEventListener('click', function(){ p(b.dataset.rtog,{active:b.dataset.on==='1'}, b.dataset.on==='1'?'Resumed':'Paused'); }); });\n      $$('[data-rdel]').forEach(function(b){ b.addEventListener('click', function(){ if(!confirm('Stop this bill from posting? Months already posted stay in your books.')) return;\n        api('/admin/books/recurring/'+b.dataset.rdel,{method:'DELETE'}).then(function(){ toast('Stopped'); VIEWS.books(); }).catch(function(e){ toast(e.message,true); }); }); });\n  }).catch(function(e){ $('#bk').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\n\nfunction paintBookSetup(){\n  api('/admin/books/settings').then(function(d){\n    if(d.setup_needed) return paintBookSetupNeeded();\n    var c=d.settings, cats=c.categories.slice(), inc=c.income_categories.slice();\n    var catRows=function(list, kind){ return list.map(function(x,i){\n      var groups=kind==='income'?[['income','Income'],['transfer','Owner money (not income)']]:[['opex','Operating expense'],['cogs','Parts / cost of jobs'],['transfer','Owner pay (not an expense)']];\n      return '<div class=\"catrow\"><input data-k=\"'+kind+'\" data-i=\"'+i+'\" data-f=\"name\" value=\"'+esc(x.name)+'\"><select data-k=\"'+kind+'\" data-i=\"'+i+'\" data-f=\"group\">'+groups.map(function(g){ return '<option value=\"'+g[0]+'\"'+(g[0]===x.group?' selected':'')+'>'+g[1]+'</option>'; }).join('')+'</select>'+\n        (kind==='income'?'':'<label class=\"keep\" style=\"margin:0\"><input type=\"checkbox\" data-k=\"'+kind+'\" data-i=\"'+i+'\" data-f=\"is_1099\"'+(x.is_1099?' checked':'')+'> 1099</label>')+\n        '<button type=\"button\" class=\"btn ghost sm\" data-rm=\"'+kind+'\" data-i=\"'+i+'\">Remove</button></div>'; }).join(''); };\n    var paint=function(){\n      $('#bk').innerHTML='<form id=\"bsForm\" class=\"steel panel sec\" style=\"max-width:820px\"><h3>Numbers</h3><div class=\"grid g2\">'+\n        fld('Set aside for taxes (% of profit)','tax_set_aside_pct',c.tax_set_aside_pct,'','number','decimal')+fld('Mileage rate ($ per mile)','mileage_rate',(c.mileage_rate_cents/100).toFixed(2),'','number','decimal')+'</div>'+\n        '<p class=\"help\" style=\"margin-top:-.4rem\">The tax set-aside is a savings target, not a tax calculation. Your tax preparer can tell you the right percentage.</p>'+\n        '<h3 style=\"margin-top:1rem\">Parts cost</h3><label class=\"keep\"><input type=\"radio\" name=\"pcs\" value=\"jobs\"'+(c.parts_cost_source!=='expenses'?' checked':'')+'> Use the part cost entered on each job\\'s estimate (recommended)</label>'+\n        '<label class=\"keep\"><input type=\"radio\" name=\"pcs\" value=\"expenses\"'+(c.parts_cost_source==='expenses'?' checked':'')+'> I log parts receipts as expenses instead</label>'+\n        '<p class=\"help\">Pick one so parts aren\\'t counted twice. With the first option, don\\'t also log parts receipts for those jobs.</p>'+\n        '<h3 style=\"margin-top:1rem\">Expense categories</h3><div id=\"catsOut\">'+catRows(cats,'out')+'</div><button type=\"button\" class=\"btn ghost sm\" id=\"addOut\">+ Category</button>'+\n        '<h3 style=\"margin-top:1.2rem\">Income categories</h3><div id=\"catsIn\">'+catRows(inc,'income')+'</div><button type=\"button\" class=\"btn ghost sm\" id=\"addIn\">+ Category</button>'+\n        '<h3 style=\"margin-top:1.2rem\">Paid with</h3>'+fld('Payment methods (comma separated)','methods',c.methods.join(', '))+\n        '<div class=\"row\" style=\"margin-top:.6rem\"><button class=\"btn\" id=\"bsSave\">Save</button><button type=\"button\" class=\"btn ghost\" id=\"bsReset\">Reset categories to default</button></div></form>';\n      $$('#bk [data-f]').forEach(function(el){ el.addEventListener('change', function(){ var L=el.dataset.k==='income'?inc:cats, x=L[+el.dataset.i];\n        x[el.dataset.f]=el.type==='checkbox'?el.checked:el.value; }); });\n      $$('#bk [data-rm]').forEach(function(b){ b.addEventListener('click', function(){ var L=b.dataset.rm==='income'?inc:cats; if(L.length<2) return toast('Keep at least one category',true); L.splice(+b.dataset.i,1); paint(); }); });\n      $('#addOut').addEventListener('click', function(){ cats.push({key:'',name:'New category',group:'opex'}); paint(); });\n      $('#addIn').addEventListener('click', function(){ inc.push({key:'',name:'New income',group:'income'}); paint(); });\n      $('#bsReset').addEventListener('click', function(){ if(!confirm('Put the default categories back? Entries keep their category; renamed ones may show by their old key.')) return; cats=d.defaults.categories.slice(); inc=d.defaults.income_categories.slice(); paint(); });\n      $('#bsForm').addEventListener('submit', function(e){ e.preventDefault(); var f=e.target, btn=$('#bsSave'); busy(btn,true,'Saving…');\n        var pcs=f.querySelector('[name=\"pcs\"]:checked');\n        api('/admin/books/settings',{method:'PUT',body:{tax_set_aside_pct:fe(f,'tax_set_aside_pct').value, mileage_rate_cents:Math.round(parseFloat(fe(f,'mileage_rate').value||0)*100),\n          parts_cost_source:pcs?pcs.value:'jobs', categories:cats, income_categories:inc, methods:fe(f,'methods').value.split(',')}})\n          .then(function(r){ c=r.settings; cats=c.categories.slice(); inc=c.income_categories.slice(); toast('Books settings saved'); paint(); }).catch(function(err){ busy(btn,false); toast(err.message,true); });\n      });\n    };\n    paint();\n  }).catch(function(e){ $('#bk').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\n\nfunction entrySheet(e, kind, o){\n  o=o||{};\n  var cfgP=o.cfg?Promise.resolve(o.cfg):S.bk&&S.bk.settings?Promise.resolve(S.bk.settings):api('/admin/books/settings').then(function(d){ if(d.setup_needed) throw new Error('Finish the Books setup first.'); return d.settings; });\n  var jobsP=o.booking_id?Promise.resolve(null):(S.jobPick?Promise.resolve(S.jobPick):api('/admin/books/jobs').then(function(r){ S.jobPick=r.jobs; return r.jobs; }).catch(function(){ return []; }));\n  Promise.all([cfgP,jobsP]).then(function(r){\n    var cfg=r[0], jobs=r[1]||[];\n    var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide'); J=null;\n    var finish=function(){ if(o.done){ S.jobPick=null; o.done(); } else closeDrawer(); };\n    var st={kind:e?e.kind:(kind||'expense'), receipt:null, removeReceipt:false, job:o.booking_id||(e&&e.booking_id)||''};\n    if(st.job&&!o.booking_id&&!jobs.some(function(j){ return j.id===st.job; })) jobs=[{id:st.job, order_name:e&&e.job_ref||'Linked job'}].concat(jobs);\n    var draw=function(){\n      var cats=st.kind==='income'?cfg.income_categories:cfg.categories, cur=e&&e.kind===st.kind?e.category:(st.kind==='expense'?(o.category||(st.job?'parts':'fuel')):'job_other');\n      sh.innerHTML='<div class=\"row\" style=\"justify-content:space-between\"><h2 style=\"margin:0\">'+(e?'Edit entry':st.kind==='income'?'Add income':o.booking_id?'Add job expense':'Add expense')+'</h2><button class=\"btn ghost sm\" id=\"closeDrawer\">'+(o.done?'‹ Back to job':'Close')+'</button></div>'+\n        (o.booking_id?'<div class=\"chip gold\" style=\"margin-top:.6rem;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">For job: '+esc(o.job_label||'')+'</div>':'')+\n        '<form id=\"enForm\" style=\"margin-top:1rem\"><div class=\"seg sec kindseg\"><button type=\"button\" data-kind=\"expense\" class=\"'+(st.kind==='expense'?'on':'')+'\">Money out</button><button type=\"button\" data-kind=\"income\" class=\"'+(st.kind==='income'?'on':'')+'\">Money in</button></div>'+\n        '<div class=\"grid g2\">'+fld('Amount ($)','amount',e&&e.kind===st.kind?dollars(e.amount_cents):'','','text','decimal')+fld('Date','entry_date',e?e.entry_date:todayIso(),'','date')+'</div>'+\n        '<div class=\"field\"><label>Category</label><select name=\"category\">'+cats.map(function(c){ return '<option value=\"'+esc(c.key)+'\"'+(c.key===cur?' selected':'')+'>'+esc(c.name)+'</option>'; }).join('')+'</select></div>'+\n        '<div class=\"grid g2\">'+fld(st.kind==='income'?'From (customer, company)':'Paid to (store, person)','vendor',e?e.vendor||'':(o.vendor||''))+\n        '<div class=\"field\"><label>'+(st.kind==='income'?'Paid by':'Paid with')+'</label><select name=\"method\"><option value=\"\">—</option>'+cfg.methods.map(function(m){ return '<option'+(e&&e.method===m?' selected':'')+'>'+esc(m)+'</option>'; }).join('')+'</select></div></div>'+\n        fld('Note','description',e?e.description||'':'')+\n        (o.booking_id?'':'<div class=\"field\"><label>Job (optional)</label><select name=\"booking_id\"><option value=\"\">Not for a specific job</option>'+\n          jobs.map(function(j){ var dt=j.paid_at?String(j.paid_at).slice(0,10):j.sched_date||String(j.created_at||'').slice(0,10);\n            return '<option value=\"'+esc(j.id)+'\"'+(j.id===st.job?' selected':'')+'>'+esc(jobLabel(j)+(dt?' · '+shortDay(dt):''))+'</option>'; }).join('')+'</select>'+\n          '<div class=\"help\">Pick the job to count this against its profit.</div></div>')+\n        '<div class=\"field\"><label>Receipt photo</label><div id=\"rcpt\">'+(e&&e.has_receipt&&!st.removeReceipt?'<div class=\"row\"><button type=\"button\" class=\"btn ghost sm\" id=\"rView\">View receipt</button><button type=\"button\" class=\"btn ghost sm\" id=\"rDel\">Remove</button></div>':'')+\n          (st.receipt?'<img src=\"'+st.receipt+'\" alt=\"Receipt\" class=\"rimg\">':'')+'<input type=\"file\" accept=\"image/*\" capture=\"environment\" id=\"rFile\" style=\"margin-top:.4rem\"></div></div>'+\n        (e||o.booking_id?'':'<label class=\"keep\"><input type=\"checkbox\" name=\"repeat\"> Repeats every month on this day</label>')+\n        (e&&e.recurring_id?'<p class=\"help\">This came from a monthly bill. Editing it changes this month only. Manage the bill under Repeating bills.</p>':'')+\n        '<div class=\"row\" style=\"margin-top:.8rem\"><button class=\"btn\" id=\"enSave\">Save</button>'+(e?'<button type=\"button\" class=\"btn danger\" id=\"enDel\">Delete</button>':'')+'</div><div id=\"enOut\" class=\"help\"></div></form>';\n      $('#closeDrawer').addEventListener('click', o.done?function(){ o.done(); }:closeDrawer);\n      if(fe($('#enForm'),'booking_id')) fe($('#enForm'),'booking_id').addEventListener('change', function(){ st.job=this.value; });\n      $$('[data-kind]').forEach(function(b){ b.addEventListener('click', function(){ if(st.kind!==b.dataset.kind){ st.kind=b.dataset.kind; draw(); } }); });\n      $('#rFile').addEventListener('change', function(){ var file=this.files[0]; if(!file) return; shrinkPhoto(file).then(function(u){ st.receipt=u; st.removeReceipt=false; draw(); }).catch(function(err){ toast(err.message,true); }); });\n      if($('#rView')) $('#rView').addEventListener('click', function(){ var b=this; busy(b,true,'Loading…');\n        api('/admin/books/receipt/'+e.id).then(function(r){ busy(b,false); var w=window.open(''); if(w){ w.document.title='Receipt'; w.document.body.style.margin='0'; var im=w.document.createElement('img'); im.src=r.data; im.style.maxWidth='100%'; w.document.body.appendChild(im); } else { $('#rcpt').insertAdjacentHTML('afterbegin','<img src=\"'+r.data+'\" class=\"rimg\" alt=\"Receipt\">'); } })\n          .catch(function(err){ busy(b,false); toast(err.message,true); }); });\n      if($('#rDel')) $('#rDel').addEventListener('click', function(){ st.removeReceipt=true; draw(); });\n      if($('#enDel')) $('#enDel').addEventListener('click', function(){ if(!confirm('Delete this entry?')) return;\n        api('/admin/books/entries/'+e.id,{method:'DELETE'}).then(function(){ toast('Deleted'); finish(); }).catch(function(err){ toast(err.message,true); }); });\n      $('#enForm').addEventListener('submit', function(ev){ ev.preventDefault(); var f=ev.target, btn=$('#enSave');\n        var body={kind:st.kind, amount:fe(f,'amount').value, entry_date:fe(f,'entry_date').value, category:fe(f,'category').value, vendor:fe(f,'vendor').value,\n          method:fe(f,'method').value, description:fe(f,'description').value, booking_id:o.booking_id||st.job||null};\n        if(st.receipt) body.receipt=st.receipt; else if(st.removeReceipt) body.remove_receipt=true;\n        if(!e && fe(f,'repeat') && fe(f,'repeat').checked) body.repeat_monthly=true;\n        busy(btn,true,'Saving…');\n        api(e?'/admin/books/entries/'+e.id:'/admin/books/entries',{method:e?'PATCH':'POST',body:body})\n          .then(function(){ toast(e?'Saved':(st.kind==='income'?'Income added':'Expense added')); finish(); })\n          .catch(function(err){ busy(btn,false); $('#enOut').innerHTML='<span class=\"minus\">'+esc(err.message)+'</span>'; });\n      });\n    };\n    draw();\n    var a=$('#enForm [name=\"amount\"]'); if(a&&!e) a.focus();\n  }).catch(function(err){ toast(err.message,true); });\n}\n\nfunction mini(l,v){ return '<div class=\"steel panel\"><div class=\"dim\" style=\"font-family:var(--head);font-size:.85rem\">'+l+'</div><div style=\"font-family:var(--display);font-size:1.7rem;line-height:1.15\">'+v+'</div></div>'; }\n\n/* ───────── TEAM & ACCESS (owner) ───────── */\nVIEWS.staff = function(){\n  api('/admin/staff').then(function(d){\n    var roleName={owner:'Owner',writer:'Service writer',tech:'Technician'};\n    $('#view').innerHTML='<h2>Team & access</h2>'+\n      '<div class=\"steel panel sec\" style=\"max-width:760px\"><h3>What each role can do</h3><div class=\"kv\">'+\n        '<dt>Owner</dt><dd>Everything, including revenue, program settings, adding points, voiding vouchers, undoing payments, and managing the team.</dd>'+\n        '<dt>Service writer</dt><dd>Jobs, scheduling and dispatch, estimates, texting customers, marking jobs paid, follow-ups, customers, and reward vouchers. No revenue reports, settings, or point adjustments.</dd>'+\n        '<dt>Technician</dt><dd>Only jobs assigned to them: their day, navigation, \"On my way\" texts, stage updates, findings, VIN and mileage, notes, and estimates if you allow it in Settings.</dd></div></div>'+\n      '<div class=\"steel panel sec\"><h3>Team</h3>'+(d.staff.length?'<div class=\"scroll\"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr>'+d.staff.map(function(s){\n        return '<tr><td>'+esc(s.name)+(s.active?'':' <span class=\"chip bad\">Disabled</span>')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(s.phone||'')+'</div></td><td>'+esc(s.email)+'</td>'+\n          '<td><select data-role=\"'+s.id+'\" style=\"width:auto\">'+['owner','writer','tech'].map(function(r){ return '<option value=\"'+r+'\"'+(r===s.role?' selected':'')+'>'+roleName[r]+'</option>'; }).join('')+'</select></td>'+\n          '<td class=\"dim\">'+(s.last_login_at?when(s.last_login_at):'Never')+'</td>'+\n          '<td style=\"white-space:nowrap\"><button class=\"btn ghost sm\" data-reset=\"'+s.id+'\">Reset password</button> <button class=\"btn '+(s.active?'danger':'ghost')+' sm\" data-active=\"'+s.id+'\" data-on=\"'+(s.active?0:1)+'\">'+(s.active?'Disable':'Enable')+'</button></td></tr>';\n      }).join('')+'</table></div>':'<div class=\"dim\">No team members yet. Add yourself as a technician or owner if you work jobs, so you can be assigned.</div>')+'</div>'+\n      '<form id=\"addStaff\" class=\"steel panel\" style=\"max-width:760px\"><h3>Add a team member</h3><div class=\"grid g2\">'+fld('Name','name','')+fld('Email (their sign-in)','email','','','email')+fld('Cell phone','phone','','','tel')+\n        '<div class=\"field\"><label>Role</label><select name=\"role\"><option value=\"writer\">Service writer</option><option value=\"tech\">Technician</option><option value=\"owner\">Owner</option></select></div></div>'+\n        '<div class=\"field\"><label>Temporary password</label><div class=\"row\" style=\"flex-wrap:nowrap\"><input name=\"password\" minlength=\"10\"><button type=\"button\" class=\"btn ghost sm\" id=\"genPw\">Generate</button></div><div class=\"help\">Give it to them in person or by text. They can change it under My account.</div></div>'+\n        '<button class=\"btn\">Add team member</button><div id=\"stOut\" class=\"help\" style=\"margin-top:.6rem\"></div></form>';\n    $('#genPw').addEventListener('click', function(){ var c='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', a=new Uint32Array(12); crypto.getRandomValues(a); fe($('#addStaff'),'password').value=Array.prototype.map.call(a,function(x){ return c[x%c.length]; }).join(''); });\n    $('#addStaff').addEventListener('submit', function(e){\n      e.preventDefault(); var f=e.target;\n      api('/admin/staff',{method:'POST',body:{name:fe(f,'name').value,email:fe(f,'email').value,phone:fe(f,'phone').value,role:fe(f,'role').value,password:fe(f,'password').value}})\n        .then(function(){ toast('Team member added. Sign-in: '+fe(f,'email').value); VIEWS.staff(); }).catch(function(err){ $('#stOut').innerHTML='<span class=\"minus\">'+esc(err.message)+'</span>'; });\n    });\n    $$('[data-role]').forEach(function(s){ s.addEventListener('change', function(){ api('/admin/staff/'+s.dataset.role,{method:'PATCH',body:{role:s.value}}).then(function(){ toast('Role updated. They\\'ll need to sign in again.'); }).catch(function(e){ toast(e.message,true); }); }); });\n    $$('[data-active]').forEach(function(b){ b.addEventListener('click', function(){ var on=b.dataset.on==='1'; if(!on&&!confirm('Disable this account? They\\'re signed out right away.')) return;\n      api('/admin/staff/'+b.dataset.active,{method:'PATCH',body:{active:on}}).then(function(){ toast(on?'Account enabled':'Account disabled'); VIEWS.staff(); }).catch(function(e){ toast(e.message,true); }); }); });\n    $$('[data-reset]').forEach(function(b){ b.addEventListener('click', function(){ var pw=prompt('New temporary password (10+ characters):',''); if(!pw) return;\n      api('/admin/staff/'+b.dataset.reset,{method:'PATCH',body:{password:pw}}).then(function(){ toast('Password reset. They\\'re signed out until they use it.'); }).catch(function(e){ toast(e.message,true); }); }); });\n  }).catch(fail);\n};\n\n/* ───────── MY ACCOUNT ───────── */\nVIEWS.account = function(){\n  var owner=!S.me.id;\n  $('#view').innerHTML='<h2>My account</h2><div class=\"steel panel sec\" style=\"max-width:560px\"><div class=\"kv\"><dt>Name</dt><dd>'+esc(S.me.name)+'</dd><dt>Email</dt><dd>'+esc(S.me.email)+'</dd><dt>Role</dt><dd>'+esc({owner:'Owner',writer:'Service writer',tech:'Technician'}[S.me.role])+'</dd></div></div>'+\n    (owner?'<div class=\"steel panel sec\" style=\"max-width:560px\">You\\'re signed in with the main owner login. Its password is <b>LOYALTY_ADMIN_PASSWORD</b> on Render; change it there.</div>':\n    '<form id=\"pwForm\" class=\"steel panel sec\" style=\"max-width:560px\"><h3>Change password</h3>'+fld('Current password','current','','','password')+fld('New password (10+ characters)','next','','','password')+'<button class=\"btn\">Change password</button><div id=\"pwOut\" class=\"help\" style=\"margin-top:.6rem\"></div></form>')+\n    '<button class=\"btn ghost\" id=\"soBtn\">Sign out</button>';\n  $('#soBtn').addEventListener('click', signOut);\n  if($('#pwForm')) $('#pwForm').addEventListener('submit', function(e){ e.preventDefault(); var f=e.target;\n    api('/admin/password',{method:'POST',body:{current:fe(f,'current').value,next:fe(f,'next').value}}).then(function(){ toast('Password changed. Sign in again.'); signOut(); }).catch(function(err){ $('#pwOut').innerHTML='<span class=\"minus\">'+esc(err.message)+'</span>'; }); });\n};\n\n/* ───────── SETTINGS (owner) ───────── */\nVIEWS.settings = function(){\n  api('/admin/settings').then(function(d){ S.settings=JSON.parse(JSON.stringify(d.config)); S.defaults=d.defaults; S.windows=S.settings.time_windows; renderSettings(); }).catch(fail);\n};\nfunction renderSettings(){\n  var c=S.settings;\n  function num(name,label,val,help,step){ return '<div class=\"field\"><label>'+label+'</label><input data-k=\"'+name+'\" type=\"number\" step=\"'+(step||'1')+'\" value=\"'+esc(val)+'\">'+(help?'<div class=\"help\">'+help+'</div>':'')+'</div>'; }\n  function txt(name,label,val,help,ph){ return '<div class=\"field\"><label>'+label+'</label><input data-k=\"'+name+'\" value=\"'+esc(val||'')+'\"'+(ph?' placeholder=\"'+esc(ph)+'\"':'')+'>'+(help?'<div class=\"help\">'+help+'</div>':'')+'</div>'; }\n  var tl={booking_received:'Booking received (sent automatically when a customer books online)',confirm:'Confirm appointment',on_way:'On my way',estimate:'Estimate ready',inspection:'Inspection report',invoice:'Invoice / receipt',complete:'Job done + payment link',follow_up:'Recommended work follow-up',reminder:'Service reminder',review:'Ask for a review'};\n  $('#view').innerHTML='<h2>Settings</h2><div class=\"settings\">'+\n    '<div class=\"steel panel sec\"><h3>Shop</h3><div class=\"grid g3\">'+\n      txt('shop_phone','Shop phone',c.shop_phone)+txt('payment_link','Payment portal link',c.payment_link,'Goes in the \"Job done\" text','https://...')+txt('notify_phone','Your cell for alerts',c.notify_phone,'Texted when a customer approves an estimate')+\n      num('labor_rate','Labor rate ($/hr)',(c.labor_rate_cents||0)/100,'Default for new labor lines. 0 = type each price',0.01)+num('parts_markup_pct','Parts markup (%)',c.parts_markup_pct,'Applied with the % button on part lines',0.5)+num('parts_tax_rate','Sales tax on parts (%)',c.parts_tax_rate,'Confirm what\\'s taxable with your CPA',0.01)+\n      num('jobs_per_window','Jobs per time window',c.jobs_per_window==null?1:c.jobs_per_window,'How many jobs your team can take at once. Longer jobs hold the next window too.')+\n      num('follow_up_days','Follow up declined work after (days)',c.follow_up_days)+num('oil_change_months','Oil change reminder after (months)',c.oil_change_months==null?6:c.oil_change_months)+\n    '</div><div class=\"field\"><label>Appointment time windows (comma-separated). Customers pick from these on the website.</label><input data-k=\"time_windows\" value=\"'+esc((c.time_windows||[]).join(', '))+'\"></div>'+\n    '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" data-k=\"booking_text_on\"'+(c.booking_text_on!==false?' checked':'')+'> Text customers right away when they book online</label>'+\n    '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" data-k=\"reply_alerts\"'+(c.reply_alerts!==false?' checked':'')+'> Text my cell when a customer replies to a text</label>'+\n    '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" data-k=\"reminders_auto\"'+(c.reminders_auto?' checked':'')+'> Text service reminders automatically when they\\'re due (10 AM–6 PM)</label>'+\n    '<label class=\"row\" style=\"color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" data-k=\"tech_can_estimate\"'+(c.tech_can_estimate!==false?' checked':'')+'> Technicians can build and send estimates from the field</label></div>'+\n    '<div class=\"steel panel sec\"><h3>Text message templates</h3><div class=\"help\" style=\"margin:-.5rem 0 .8rem\">Placeholders: {first} {name} {service} {vehicle} {date} {window} {tech} {eta} {estimate_link} {invoice_link} {report_link} {title} {total} {pay_link} {shop_phone} {review_link} {recommended}</div>'+\n      Object.keys(tl).map(function(k){ return '<div class=\"field\"><label>'+tl[k]+'</label><textarea data-tpl=\"'+k+'\" rows=\"2\">'+esc((c.sms_templates||{})[k]||'')+'</textarea></div>'; }).join('')+'</div>'+\n    '<div class=\"steel panel sec\"><h3>Rewards: earning</h3><div class=\"grid g4\">'+\n      num('points_per_dollar','Points per $1 of labor',c.points_per_dollar,'Also for fees paid in Shopify',0.25)+num('parts_points_per_dollar','Points per $1 of parts',c.parts_points_per_dollar==null?c.points_per_dollar:c.parts_points_per_dollar,'',0.25)+\n      num('welcome_bonus','Welcome bonus',c.welcome_bonus,'After first paid service')+num('cents_per_point','Cost per point (¢)',c.cents_per_point,'For the liability estimate',0.1)+\n      num('birthday_bonus','Birthday bonus',c.birthday_bonus==null?100:c.birthday_bonus,'Once a year, in their birthday month')+num('comeback_bonus','Comeback bonus',c.comeback_bonus==null?100:c.comeback_bonus,'Paid job soon after their last one')+\n      num('comeback_months','Comeback window (months)',c.comeback_months==null?6:c.comeback_months)+num('expire_months','Points expire after (months)',c.expire_months,'0 = never')+\n      num('referral_friend','Referral: friend gets ($ off)',(c.referral_friend_cents||0)/100,'Off their first job, as a credit',1)+num('referral_referrer','Referral: referrer gets ($ credit)',(c.referral_referrer_cents||0)/100,'Once the friend\\'s job is paid',1)+\n      num('referral_min_dollars','Referral minimum job ($)',c.referral_min_cents/100,'Before discounts')+\n      num('book_ahead_bonus','Book-ahead bonus',c.book_ahead_bonus)+num('book_ahead_days','Book-ahead days',c.book_ahead_days)+num('offpeak_bonus','Slow-day bonus',c.offpeak_bonus)+\n      num('review_bonus','Google review bonus',c.review_bonus,'Leave at 0. Google bans rewards for reviews.')+'</div>'+\n      '<div class=\"field\"><label>Slow days</label><div class=\"row\">'+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function(d,i){ return '<label class=\"row\" style=\"gap:.3rem;margin:0;color:var(--text);font-family:var(--body)\"><input type=\"checkbox\" data-day=\"'+i+'\"'+((c.offpeak_days||[]).indexOf(i)>-1?' checked':'')+'>'+d+'</label>'; }).join('')+'</div></div>'+\n      txt('payment_methods','Payment methods (comma-separated)',(c.payment_methods||[]).join(', '))+txt('google_review_url','Google review link',c.google_review_url,'Used in the \"Ask for a review\" text','https://g.page/r/.../review')+'</div>'+\n    '<div class=\"steel panel sec\"><h3>Referral milestones</h3><div class=\"help\" style=\"margin:-.5rem 0 .8rem\">When this many of a customer\\'s friends have had a paid job. A credit becomes a voucher; a status gives them that tier for the months shown.</div><div class=\"scroll\"><table><tr><th>Friends</th><th>Shown as</th><th>Credit ($)</th><th>Credit name</th><th>Status tier</th><th>Months</th><th></th></tr>'+\n      (c.referral_milestones||[]).map(function(m,i){ return '<tr><td><input data-ms=\"'+i+'\" data-f=\"count\" type=\"number\" value=\"'+m.count+'\" style=\"width:70px\"></td><td><input data-ms=\"'+i+'\" data-f=\"name\" value=\"'+esc(m.name)+'\"></td><td><input data-ms=\"'+i+'\" data-f=\"credit\" type=\"number\" step=\"0.01\" value=\"'+((m.credit_cents||0)/100)+'\" style=\"width:90px\"></td><td><input data-ms=\"'+i+'\" data-f=\"credit_name\" value=\"'+esc(m.credit_name||'')+'\"></td>'+\n        '<td><select data-ms=\"'+i+'\" data-f=\"status_tier\"><option value=\"\">None</option>'+c.tiers.map(function(t){ return '<option value=\"'+esc(t.key)+'\"'+(m.status_tier===t.key?' selected':'')+'>'+esc(t.name)+'</option>'; }).join('')+'</select></td><td><input data-ms=\"'+i+'\" data-f=\"status_months\" type=\"number\" value=\"'+(m.status_months||0)+'\" style=\"width:70px\"></td><td><button class=\"btn danger sm\" data-delms=\"'+i+'\">Remove</button></td></tr>'; }).join('')+\n      '</table></div><button class=\"btn ghost sm\" id=\"addMs\" style=\"margin-top:.6rem\">Add milestone</button></div>'+\n    '<div class=\"steel panel sec\"><h3>Rewards: tiers</h3><div class=\"scroll\"><table><tr><th>Name</th><th>Spend from ($)</th><th>Multiplier</th><th>Warranty (days)</th><th>Perks (one per line)</th><th></th></tr>'+\n      c.tiers.map(function(t,i){ return '<tr><td><input data-t=\"'+i+'\" data-f=\"name\" value=\"'+esc(t.name)+'\"></td><td><input data-t=\"'+i+'\" data-f=\"min\" type=\"number\" value=\"'+(t.min_spend_cents/100)+'\"></td><td><input data-t=\"'+i+'\" data-f=\"multiplier\" type=\"number\" step=\"0.05\" value=\"'+t.multiplier+'\"></td><td><input data-t=\"'+i+'\" data-f=\"warranty\" type=\"number\" value=\"'+(t.warranty_days==null?90:t.warranty_days)+'\" style=\"width:80px\"></td><td><textarea data-t=\"'+i+'\" data-f=\"perks\" rows=\"2\">'+esc((t.perks||[]).join('\\n'))+'</textarea></td><td><button class=\"btn danger sm\" data-deltier=\"'+i+'\">Remove</button></td></tr>'; }).join('')+\n      '</table></div><button class=\"btn ghost sm\" id=\"addTier\" style=\"margin-top:.6rem\">Add tier</button></div>'+\n    '<div class=\"steel panel sec\"><h3>Rewards: catalog</h3><div class=\"scroll\"><table><tr><th>On</th><th>Name</th><th>Points</th><th>Value ($)</th><th>Min invoice ($)</th><th>Description</th><th></th></tr>'+\n      c.rewards.map(function(r,i){ return '<tr><td><input type=\"checkbox\" data-r=\"'+i+'\" data-f=\"active\"'+(r.active?' checked':'')+'></td><td><input data-r=\"'+i+'\" data-f=\"name\" value=\"'+esc(r.name)+'\"></td><td><input data-r=\"'+i+'\" data-f=\"points\" type=\"number\" value=\"'+r.points+'\"></td><td><input data-r=\"'+i+'\" data-f=\"value\" type=\"number\" step=\"0.01\" value=\"'+(r.value_cents/100)+'\"></td><td><input data-r=\"'+i+'\" data-f=\"min\" type=\"number\" value=\"'+((r.min_invoice_cents||0)/100)+'\"></td><td><input data-r=\"'+i+'\" data-f=\"description\" value=\"'+esc(r.description||'')+'\"></td><td><button class=\"btn danger sm\" data-delrew=\"'+i+'\">Remove</button></td></tr>'; }).join('')+\n      '</table></div><button class=\"btn ghost sm\" id=\"addRew\" style=\"margin-top:.6rem\">Add reward</button></div>'+\n    '<div class=\"steel panel sec\"><h3>Your extra program rules</h3><div class=\"help\" style=\"margin:-.5rem 0 .8rem\">Shown on the website rules page. One per line.</div><textarea data-k=\"terms_extra\" rows=\"3\">'+esc((c.terms_extra||[]).join('\\n'))+'</textarea></div>'+\n    '<div class=\"row\"><button class=\"btn\" id=\"saveSet\">Save settings</button><button class=\"btn ghost\" id=\"resetSet\">Load recommended defaults</button></div></div>'+\n    '<div class=\"steel panel sec\" id=\"impBox\"><h3>Bring in older Shopify bookings</h3>'+\n      '<ol class=\"help\" style=\"margin:0 0 .8rem 1.1rem;padding:0;line-height:1.7\"><li><a href=\"'+SHOP_ORDERS_URL+'\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--gold)\">Open your Shopify orders list</a> (signed in to Shopify).</li>'+\n      '<li>Select everything on that page (Ctrl+A or Cmd+A) and copy it.</li><li>Paste it below and press Import.</li></ol>'+\n      '<textarea id=\"impTxt\" rows=\"4\" placeholder=\"Paste the Shopify page here\"></textarea>'+\n      '<label class=\"row\" style=\"color:var(--text);font-family:var(--body);margin-top:.5rem\"><input type=\"checkbox\" id=\"impPast\"> Also bring in appointments whose date has already passed</label>'+\n      '<div class=\"row\" style=\"margin-top:.6rem\"><button class=\"btn purple\" id=\"impGo\">Import</button><span class=\"help\" id=\"impOut\"></span></div>'+\n      '<div class=\"help\">Bookings already in the desk are skipped, so it\\'s safe to run again.</div></div>';\n  $$('[data-k]').forEach(function(inp){ inp.addEventListener('change', function(){\n    var k=inp.dataset.k, v=inp.value;\n    if(k==='tech_can_estimate') c.tech_can_estimate=inp.checked;\n    else if(k==='reminders_auto') c.reminders_auto=inp.checked;\n    else if(k==='reply_alerts') c.reply_alerts=inp.checked;\n    else if(k==='booking_text_on') c.booking_text_on=inp.checked;\n    else if(k==='labor_rate') c.labor_rate_cents=cents(v);\n    else if(k==='referral_min_dollars') c.referral_min_cents=cents(v);\n    else if(k==='referral_friend') c.referral_friend_cents=cents(v);\n    else if(k==='referral_referrer') c.referral_referrer_cents=cents(v);\n    else if(k==='time_windows'||k==='payment_methods') c[k]=v.split(',').map(function(x){return x.trim();}).filter(Boolean);\n    else if(k==='terms_extra') c.terms_extra=v.split('\\n').map(function(x){return x.trim();}).filter(Boolean);\n    else if(['shop_phone','payment_link','notify_phone','google_review_url'].indexOf(k)>-1) c[k]=v.trim();\n    else c[k]=parseFloat(v);\n  }); });\n  $$('[data-tpl]').forEach(function(ta){ ta.addEventListener('change', function(){ c.sms_templates=c.sms_templates||{}; c.sms_templates[ta.dataset.tpl]=ta.value; }); });\n  $$('[data-day]').forEach(function(cb){ cb.addEventListener('change', function(){ c.offpeak_days=$$('[data-day]').filter(function(x){return x.checked;}).map(function(x){return +x.dataset.day;}); }); });\n  $$('[data-t]').forEach(function(inp){ inp.addEventListener('change', function(){ var t=c.tiers[inp.dataset.t], f=inp.dataset.f;\n    if(f==='min') t.min_spend_cents=cents(inp.value); else if(f==='multiplier') t.multiplier=parseFloat(inp.value); else if(f==='warranty') t.warranty_days=parseInt(inp.value,10)||0; else if(f==='perks') t.perks=inp.value.split('\\n').map(function(s){return s.trim();}).filter(Boolean); else t.name=inp.value.trim(); }); });\n  $$('[data-r]').forEach(function(inp){ inp.addEventListener('change', function(){ var r=c.rewards[inp.dataset.r], f=inp.dataset.f;\n    if(f==='active') r.active=inp.checked; else if(f==='points') r.points=parseInt(inp.value,10); else if(f==='value') r.value_cents=cents(inp.value); else if(f==='min') r.min_invoice_cents=cents(inp.value); else r[f]=inp.value.trim(); }); });\n  $$('[data-deltier]').forEach(function(b){ b.addEventListener('click', function(){ c.tiers.splice(+b.dataset.deltier,1); renderSettings(); }); });\n  $$('[data-ms]').forEach(function(inp){ inp.addEventListener('change', function(){ var m=c.referral_milestones[inp.dataset.ms], f=inp.dataset.f;\n    if(f==='count'||f==='status_months') m[f]=parseInt(inp.value,10)||0; else if(f==='credit') m.credit_cents=cents(inp.value); else m[f]=inp.value.trim(); }); });\n  $$('[data-delms]').forEach(function(b){ b.addEventListener('click', function(){ c.referral_milestones.splice(+b.dataset.delms,1); renderSettings(); }); });\n  $('#addMs').addEventListener('click', function(){ c.referral_milestones=c.referral_milestones||[]; c.referral_milestones.push({count:(c.referral_milestones.length?c.referral_milestones[c.referral_milestones.length-1].count+5:3),name:'New milestone',credit_cents:0,credit_name:'',status_tier:'',status_months:0}); renderSettings(); });\n  $$('[data-delrew]').forEach(function(b){ b.addEventListener('click', function(){ c.rewards.splice(+b.dataset.delrew,1); renderSettings(); }); });\n  $('#addTier').addEventListener('click', function(){ c.tiers.push({key:'tier'+Date.now().toString(36),name:'New tier',min_spend_cents:0,multiplier:1,perks:[]}); renderSettings(); });\n  $('#addRew').addEventListener('click', function(){ c.rewards.push({key:'r'+Date.now().toString(36),name:'New reward',points:1000,value_cents:2500,min_invoice_cents:0,active:false,description:''}); renderSettings(); });\n  $('#impGo').addEventListener('click', function(){\n    var btn=this, raw=$('#impTxt').value.trim(), data;\n    try{ data=JSON.parse(raw.slice(raw.indexOf('{'))); }catch(e){ return toast('That isn\\'t the Shopify orders page. Copy the whole page and try again.', true); }\n    busy(btn,true,'Importing…');\n    api('/admin/import/shopify',{method:'POST',body:{orders:data.orders||data,include_past:$('#impPast').checked}}).then(function(r){\n      busy(btn,false);\n      var parts=[r.created+' added'];\n      if(r.already) parts.push(r.already+' already in the desk');\n      if(r.past) parts.push(r.past+' skipped (date already passed)');\n      if(r.cancelled) parts.push(r.cancelled+' cancelled');\n      if(r.not_booking) parts.push(r.not_booking+' not bookings');\n      if(r.failed) parts.push(r.failed+' failed: '+r.errors.join('; '));\n      $('#impOut').textContent=parts.join(' · ');\n      toast(r.created?r.created+' bookings added to Jobs':'No new bookings to add');\n      $('#impTxt').value='';\n    }).catch(function(e){ busy(btn,false); toast(e.message,true); });\n  });\n  $('#resetSet').addEventListener('click', function(){ if(confirm('Replace everything here with the recommended defaults? Nothing is saved until you press Save.')){ S.settings=JSON.parse(JSON.stringify(S.defaults)); renderSettings(); } });\n  $('#saveSet').addEventListener('click', function(){ c.tiers.sort(function(a,b){ return a.min_spend_cents-b.min_spend_cents; });\n    api('/admin/settings',{method:'PUT',body:{config:c}}).then(function(d){ S.settings=d.config; S.windows=d.config.time_windows; toast('Settings saved'); renderSettings(); }).catch(function(e){ toast(e.message,true); }); });\n}\n\n/* ───────── PARTS PRICES ───────── */\nvar SUPPLIERS=[\n  ['oreilly',\"O'Reilly\",function(q){ return 'https://www.oreillyauto.com/search?q='+q; }],\n  ['autozone','AutoZone',function(q){ return 'https://www.autozone.com/searchresult?searchText='+q; }],\n  ['advance','Advance',function(q){ return 'https://shop.advanceautoparts.com/web/SearchResults?searchTerm='+q; }],\n  ['napa','NAPA',function(q){ return 'https://www.napaonline.com/search?text='+q; }],\n  ['amazon','Amazon',function(q){ return 'https://www.amazon.com/s?k='+q+'&i=automotive'; }],\n  ['partsgeek','PartsGeek',function(q){ return 'https://www.partsgeek.com/ss/?ssq='+q; }],\n  ['apremium','A-Premium',function(q){ return 'https://www.a-premium.com/search?q='+q; }]\n];\nfunction supplierName(k){ for(var i=0;i<SUPPLIERS.length;i++) if(SUPPLIERS[i][0]===k) return SUPPLIERS[i][1]; return k||''; }\nfunction partLinks(name, vehicle){\n  var q=encodeURIComponent(((vehicle||'')+' '+(name||'')).trim());\n  return '<span class=\"plinks\">Check price: '+SUPPLIERS.slice(0,4).map(function(s){ return '<a href=\"'+s[2](q)+'\" target=\"_blank\" rel=\"noopener\">'+esc(s[1])+'</a>'; }).join(' · ')+'</span>';\n}\n// Side-by-side price check for one part: opens each supplier's search for this vehicle, then records the price you pick.\nfunction pricePanel(el, opts){\n  var q=encodeURIComponent(((opts.vehicle||'')+' '+(opts.part||'')+(opts.partNo?' '+opts.partNo:'')).trim());\n  el.innerHTML='<div class=\"gpick\"><div class=\"row\" style=\"justify-content:space-between\"><b>Price check: '+esc(opts.part||'part')+'</b><button type=\"button\" class=\"btn ghost sm\" data-pclose>Close</button></div>'+\n    '<div class=\"help\" style=\"margin:.2rem 0 .7rem\">For '+esc(opts.vehicle||'this vehicle')+'. Each button opens that store\\'s search. Pick the best price and record it below.</div>'+\n    '<div class=\"supgrid\">'+SUPPLIERS.map(function(s){ return '<a class=\"btn ghost sm\" href=\"'+s[2](q)+'\" target=\"_blank\" rel=\"noopener\">'+esc(s[1])+' ↗</a>'; }).join('')+'</div>'+\n    '<div class=\"grid g3\" style=\"margin-top:.8rem;align-items:end\"><div class=\"field\" style=\"margin:0\"><label>Bought from</label><select data-psup>'+SUPPLIERS.map(function(s){ return '<option value=\"'+s[0]+'\"'+(s[0]===opts.supplier?' selected':'')+'>'+esc(s[1])+'</option>'; }).join('')+'<option value=\"other\">Other</option></select></div>'+\n    '<div class=\"field\" style=\"margin:0\"><label>Your cost ($)</label><input data-pcost inputmode=\"decimal\" value=\"'+(opts.cost?dollars(opts.cost):'')+'\" placeholder=\"0.00\"></div>'+\n    '<div class=\"field\" style=\"margin:0\"><button type=\"button\" class=\"btn\" data-puse style=\"width:100%\">Use this price</button></div></div>'+\n    '<div class=\"help\" style=\"margin-top:.5rem\">Your '+(opts.markup||0)+'% markup is added automatically. Live prices inside the desk turn on once your PartsTech account is connected.</div></div>';\n  el.querySelector('[data-pclose]').addEventListener('click', function(){ el.innerHTML=''; });\n  el.querySelector('[data-puse]').addEventListener('click', function(){\n    var c=cents(el.querySelector('[data-pcost]').value); if(!c) return toast('Enter what the part costs you', true);\n    opts.onUse({cost_cents:c, supplier:el.querySelector('[data-psup]').value}); el.innerHTML='';\n  });\n}\n\n/* ───────── PHOTOS ───────── */\n// Shrinks a phone photo to 1280px JPEG before upload so inspections stay fast on cell data.\nfunction shrinkPhoto(file){\n  return new Promise(function(resolve, reject){\n    var img=new Image(), url=URL.createObjectURL(file);\n    img.onload=function(){ var max=1280, w=img.naturalWidth, h=img.naturalHeight, k=Math.min(1, max/Math.max(w,h));\n      var cv=document.createElement('canvas'); cv.width=Math.round(w*k); cv.height=Math.round(h*k);\n      cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height); URL.revokeObjectURL(url); resolve(cv.toDataURL('image/jpeg',0.72)); };\n    img.onerror=function(){ URL.revokeObjectURL(url); reject(new Error('That file isn\\'t a photo.')); };\n    img.src=url;\n  });\n}\n\n/* ───────── INSPECTION TAB ───────── */\nfunction tabInspection(){\n  var b=J.booking;\n  $('#dbody').innerHTML='<div class=\"empty\">Loading inspection…</div>';\n  api('/admin/booking/'+b.id+'/inspection').then(function(d){\n    var I=d.inspection, photos=d.photos, items=I.items||[], saveT;\n    var token=(d.report_link.match(/\\/i\\/([a-f0-9]+)/)||[])[1];\n    function photoUrl(p){ return API+'/i/'+token+'/p/'+p.id; }\n    function counts(){ var c={good:0,watch:0,bad:0,done:0}; items.forEach(function(i){ if(i.status){ c.done++; if(c[i.status]!=null) c[i.status]++; } }); return c; }\n    function save(now){ clearTimeout(saveT); saveT=setTimeout(function(){\n      api('/admin/booking/'+b.id+'/inspection',{method:'PUT',body:{items:items,summary:$('#insSum').value}}).then(function(){ $('#insSaved').textContent='Saved'; }).catch(function(e){ toast(e.message,true); });\n    }, now?0:600); $('#insSaved').textContent='Saving…'; }\n    function paint(){\n      var c=counts();\n      $('#dbody').innerHTML='<div class=\"steel panel sec\"><div class=\"row\" style=\"justify-content:space-between\"><div><h3 style=\"margin:0\">Vehicle inspection</h3>'+\n          '<div class=\"help\">'+c.done+' of '+items.length+' checked · <span style=\"color:var(--bad)\">'+c.bad+' need attention</span> · <span style=\"color:var(--warn)\">'+c.watch+' to watch</span> · <span style=\"color:var(--good)\">'+c.good+' good</span> · <span id=\"insSaved\"></span></div></div>'+\n          '<div class=\"row\" style=\"gap:.35rem\"><a class=\"btn ghost sm\" href=\"'+esc(d.report_link)+'\" target=\"_blank\" rel=\"noopener\">Preview report</a>'+\n          '<button class=\"btn purple sm\" id=\"insSend\"'+(b.phone?'':' disabled title=\"No phone on this job\"')+'>Text report</button></div></div></div>'+\n        '<div class=\"steel panel sec\">'+items.map(function(it,i){\n          var pics=photos.filter(function(p){ return p.item_key===it.key; });\n          return '<div class=\"insrow\"><div class=\"insname\">'+esc(it.name)+'</div>'+\n            '<div class=\"seg\" role=\"group\" aria-label=\"'+esc(it.name)+'\">'+[['good','Good'],['watch','Watch'],['bad','Needs work'],['na','N/A']].map(function(s){\n              return '<button type=\"button\" class=\"'+s[0]+(it.status===s[0]?' on':'')+'\" data-ist=\"'+i+'\" data-v=\"'+s[0]+'\">'+s[1]+'</button>'; }).join('')+'</div>'+\n            '<input class=\"insnote\" data-inote=\"'+i+'\" value=\"'+esc(it.note||'')+'\" placeholder=\"Note (what you saw, measurements)\">'+\n            '<div class=\"insph\">'+pics.map(function(p){ return '<span class=\"ph\"><img src=\"'+photoUrl(p)+'\" alt=\"\"><button type=\"button\" data-pdel=\"'+p.id+'\" aria-label=\"Delete photo\">×</button></span>'; }).join('')+\n              '<label class=\"btn ghost sm addph\">+ Photo<input type=\"file\" accept=\"image/*\" capture=\"environment\" data-padd=\"'+esc(it.key)+'\" hidden></label></div></div>';\n        }).join('')+'</div>'+\n        '<div class=\"steel panel sec\"><div class=\"field\"><label>Summary for the customer</label><textarea id=\"insSum\" rows=\"3\" placeholder=\"Overall condition, what to fix now, what can wait\">'+esc(I.summary||'')+'</textarea></div>'+\n          '<button class=\"btn sm\" id=\"insToEst\"'+(c.bad+c.watch?'':' disabled')+'>Add \"needs work\" items to the estimate</button></div>';\n      $$('[data-ist]').forEach(function(btn){ btn.addEventListener('click', function(){ var it=items[+btn.dataset.ist]; it.status=it.status===btn.dataset.v?null:btn.dataset.v; paint(); save(); }); });\n      $$('[data-inote]').forEach(function(inp){ inp.addEventListener('input', function(){ items[+inp.dataset.inote].note=inp.value; save(); }); });\n      $('#insSum').addEventListener('input', function(){ save(); });\n      $$('[data-padd]').forEach(function(inp){ inp.addEventListener('change', function(){\n        var f=inp.files&&inp.files[0]; if(!f) return; toast('Uploading photo…');\n        shrinkPhoto(f).then(function(data){ return api('/admin/booking/'+b.id+'/inspection/photo',{method:'POST',body:{item_key:inp.dataset.padd,data:data}}); })\n          .then(function(r){ photos.push(r.photo); paint(); toast('Photo added'); }).catch(function(e){ toast(e.message,true); });\n      }); });\n      $$('[data-pdel]').forEach(function(btn){ btn.addEventListener('click', function(){\n        if(!confirm('Delete this photo?')) return;\n        api('/admin/inspection-photo/'+btn.dataset.pdel,{method:'DELETE'}).then(function(){ photos=photos.filter(function(p){ return p.id!==btn.dataset.pdel; }); paint(); }).catch(function(e){ toast(e.message,true); });\n      }); });\n      $('#insSend').addEventListener('click', function(){ var btn=this; busy(btn,true,'Sending…');\n        api('/admin/booking/'+b.id+'/inspection',{method:'PUT',body:{items:items,summary:$('#insSum').value}})\n          .then(function(){ return api('/admin/booking/'+b.id+'/inspection/send',{method:'POST',body:{via:'sms'}}); })\n          .then(function(){ toast('Inspection report texted'); busy(btn,false); }).catch(function(e){ toast(e.message,true); busy(btn,false); }); });\n      $('#insToEst').addEventListener('click', function(){\n        var est=JSON.parse(JSON.stringify(b.estimate||{lines:[],notes:''})); est.lines=est.lines||[];\n        var have=est.lines.map(function(l){ return l.desc; }), added=0;\n        items.filter(function(i){ return i.status==='bad'||i.status==='watch'; }).forEach(function(i){\n          var desc=i.name+(i.note?' – '+i.note:''); if(have.indexOf(desc)>-1) return;\n          est.lines.push({type:'labor',desc:desc.slice(0,200),qty:1,unit_cents:J.shop.labor_rate_cents||0,status:'pending'}); added++; });\n        if(!added) return toast('Those items are already on the estimate');\n        api('/admin/booking/'+b.id+'/estimate',{method:'PUT',body:{lines:est.lines,notes:est.notes||''}})\n          .then(function(){ toast(added+' item'+(added>1?'s':'')+' added. Set the hours and parts on the estimate.'); openJob(b.id,'estimate'); }).catch(function(e){ toast(e.message,true); });\n      });\n    }\n    paint();\n  }).catch(function(e){ $('#dbody').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\n\n/* ───────── INVOICE PANEL (payment tab) ───────── */\nfunction invoicePanel(){\n  var b=J.booking, paid=b.status==='paid';\n  return '<div class=\"steel panel sec\"><h3>'+(paid?'Receipt':'Invoice')+'</h3><p class=\"dim\" style=\"margin:-.3rem 0 .7rem;font-size:.9rem\">'+(paid?'Send the customer an itemized receipt.':'Send the itemized bill'+(J.shop.payment_link?' with your payment link':'')+'. It only lists approved work.')+'</p>'+\n    '<div class=\"row\" style=\"gap:.4rem\"><button class=\"btn purple sm\" id=\"invText\"'+(b.phone?'':' disabled title=\"No phone on this job\"')+'>Text '+(paid?'receipt':'invoice')+'</button>'+\n    '<button class=\"btn ghost sm\" id=\"invLink\">Copy link</button>'+(J.invoice_link?'<a class=\"btn ghost sm\" href=\"'+esc(J.invoice_link)+'\" target=\"_blank\" rel=\"noopener\">Preview</a>':'')+'</div><div id=\"invOut\" class=\"help\"></div></div>';\n}\nfunction bindInvoicePanel(){\n  var b=J.booking;\n  if($('#invText')) $('#invText').addEventListener('click', function(){ var btn=this; busy(btn,true,'Sending…');\n    api('/admin/booking/'+b.id+'/invoice/send',{method:'POST',body:{via:'sms'}}).then(function(){ toast((b.status==='paid'?'Receipt':'Invoice')+' texted'); busy(btn,false); }).catch(function(e){ toast(e.message,true); busy(btn,false); }); });\n  if($('#invLink')) $('#invLink').addEventListener('click', function(){\n    api('/admin/booking/'+b.id+'/invoice/send',{method:'POST',body:{via:'link'}}).then(function(r){\n      $('#invOut').innerHTML='<a href=\"'+esc(r.link)+'\" target=\"_blank\" rel=\"noopener\">'+esc(r.link)+'</a>';\n      if(navigator.clipboard) navigator.clipboard.writeText(r.link).then(function(){ toast('Link copied'); }).catch(function(){}); }).catch(function(e){ toast(e.message,true); }); });\n}\n\n/* ───────── TIME CLOCK (job header) ───────── */\nfunction clockBar(){\n  var t=J.time; if(!t) return '';\n  var over=t.quoted_hours&&t.worked_hours>t.quoted_hours;\n  return '<div class=\"clock\"><button class=\"btn sm '+(t.clocked_in?'danger':'')+'\" id=\"clockBtn\">'+(t.clocked_in?'Clock out':'Clock in')+'</button>'+\n    '<span class=\"dim\">Worked <b style=\"color:'+(over?'var(--bad)':'var(--text)')+'\">'+t.worked_hours+' hr</b>'+(t.quoted_hours?' of '+t.quoted_hours+' hr quoted':'')+(t.clocked_in?' · <span style=\"color:var(--good)\">on the clock</span>':'')+'</span></div>';\n}\nfunction bindClock(){\n  if(!$('#clockBtn')) return;\n  $('#clockBtn').addEventListener('click', function(){ var inNow=!J.time.clocked_in, btn=this; busy(btn,true);\n    api('/admin/booking/'+J.booking.id+'/clock',{method:'POST',body:{action:inNow?'in':'out'}}).then(function(r){ J.time=r.time; toast(inNow?'Clocked in':'Clocked out'); renderJob(); })\n      .catch(function(e){ toast(e.message,true); busy(btn,false); }); });\n}\n\n/* ───────── SERVICE REMINDERS ───────── */\nVIEWS.reminders = function(){\n  S.remView=S.remView||'due';\n  $('#view').innerHTML='<h2>Service reminders</h2><p class=\"dim\" style=\"margin:-.6rem 0 1rem;max-width:680px\">Paid oil changes schedule the next one automatically. Add your own from a customer\\'s page.</p>'+\n    '<div class=\"row\" style=\"margin-bottom:1rem\">'+[['due','Due now'],['upcoming','Upcoming'],['done','Sent and done']].map(function(v){ return '<button class=\"btn sm '+(S.remView===v[0]?'':'ghost')+'\" data-rv=\"'+v[0]+'\">'+v[1]+'</button>'; }).join('')+\n    '<span id=\"remAuto\" class=\"dim\" style=\"margin-left:auto\"></span></div><div id=\"remList\" class=\"steel\"><div class=\"empty\">Loading…</div></div>';\n  $$('[data-rv]').forEach(function(b){ b.addEventListener('click', function(){ S.remView=b.dataset.rv; VIEWS.reminders(); }); });\n  api('/admin/reminders?view='+S.remView).then(function(d){\n    $('#remAuto').innerHTML=d.auto?'Automatic texts are <b style=\"color:var(--good)\">on</b>':'Automatic texts are off'+(OWN()?' (turn on in Settings)':'');\n    $('#remList').innerHTML=d.reminders.length?'<div class=\"scroll\"><table><tr><th>Due</th><th>Customer</th><th>Reminder</th><th></th></tr>'+d.reminders.map(function(r){\n      var m=r.member||{}, v=r.vehicle||{};\n      return '<tr><td style=\"white-space:nowrap\">'+dayLabel(r.due_date)+(r.due_date<d.today&&r.status==='pending'?' <span class=\"chip bad\">Overdue</span>':'')+'</td>'+\n        '<td><a href=\"#\" data-rm=\"'+esc(m.id||'')+'\">'+esc(m.name||'Customer')+'</a><div class=\"dim\" style=\"font-size:.82rem\">'+esc(m.phone||'No phone')+'</div></td>'+\n        '<td>'+esc(r.title)+(v.description?'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(v.description)+'</div>':'')+(r.note?'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(r.note)+'</div>':'')+'</td>'+\n        '<td><div class=\"row\" style=\"gap:.3rem;justify-content:flex-end\">'+(r.status==='pending'?\n          '<button class=\"btn purple sm\" data-rsend=\"'+r.id+'\"'+(m.phone?'':' disabled')+'>Text now</button><button class=\"btn ghost sm\" data-rdone=\"'+r.id+'\">Done</button><button class=\"btn ghost sm\" data-rsnooze=\"'+r.id+'\">+1 month</button><button class=\"btn ghost sm\" data-rskip=\"'+r.id+'\">Skip</button>'\n          :'<span class=\"chip '+(r.status==='sent'?'gold':'')+'\">'+esc(r.status==='sent'?'Texted '+when(r.sent_at):r.status)+'</span>')+'</div></td></tr>';\n    }).join('')+'</table></div>':'<div class=\"empty\">'+(S.remView==='due'?'Nobody is due right now.':'Nothing here yet.')+'</div>';\n    $$('[data-rm]').forEach(function(a){ a.addEventListener('click', function(e){ e.preventDefault(); if(a.dataset.rm) openMember(a.dataset.rm); }); });\n    $$('[data-rsend]').forEach(function(b){ b.addEventListener('click', function(){ busy(b,true,'Sending…'); api('/admin/reminder/'+b.dataset.rsend+'/send',{method:'POST'}).then(function(){ toast('Reminder texted'); VIEWS.reminders(); }).catch(function(e){ toast(e.message,true); busy(b,false); }); }); });\n    function setStatus(id, body, msg){ api('/admin/reminder/'+id,{method:'PATCH',body:body}).then(function(){ toast(msg); VIEWS.reminders(); }).catch(function(e){ toast(e.message,true); }); }\n    $$('[data-rdone]').forEach(function(b){ b.addEventListener('click', function(){ setStatus(b.dataset.rdone,{status:'done'},'Marked done'); }); });\n    $$('[data-rskip]').forEach(function(b){ b.addEventListener('click', function(){ setStatus(b.dataset.rskip,{status:'skipped'},'Skipped'); }); });\n    $$('[data-rsnooze]').forEach(function(b){ b.addEventListener('click', function(){ var d2=new Date(); d2.setMonth(d2.getMonth()+1); setStatus(b.dataset.rsnooze,{due_date:d2.toISOString().slice(0,10)},'Moved out a month'); }); });\n  }).catch(function(e){ $('#remList').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n};\n\n/* ───────── CUSTOMER PROFILE ───────── */\nfunction openMember(id){\n  J=null; var d=$('#drawer'), sh=$('#sheet'); d.classList.remove('hide'); sh.innerHTML='<div class=\"empty\">Loading…</div>';\n  Promise.all([api('/admin/member/'+id), api('/admin/reminders?view=upcoming&member='+id).catch(function(){ return {reminders:[]}; }), api('/admin/reminders?view=due&member='+id).catch(function(){ return {reminders:[]}; })]).then(function(all){\n    var x=all[0], rems=all[2].reminders.concat(all[1].reminders), m=x.member, t=x.tier, nx=x.next_tier, V=x.vehicles||[];\n    var pct=nx?Math.min(100,Math.round((x.spend_12mo_cents-t.min_spend_cents)/Math.max(1,nx.min_spend_cents-t.min_spend_cents)*100)):100;\n    var paid=(x.jobs||[]).filter(function(j){ return j.status==='paid'; }), spent=paid.reduce(function(a,j){ return a+(j.total_cents||0); },0);\n    var h='<div class=\"row\" style=\"justify-content:space-between\"><h2 style=\"margin:0\">'+esc(m.name||m.email||m.phone||'Customer')+'</h2><button class=\"btn ghost sm\" id=\"closeDrawer\">Close</button></div>'+\n      '<div class=\"row\" style=\"gap:.4rem;margin:.4rem 0 1rem\">'+(m.is_fleet?'<span class=\"chip\">Fleet</span>':'<span class=\"chip gold\">'+esc(t.name)+' · '+n(m.points_balance)+' pts</span>')+\n        '<span class=\"chip\">'+paid.length+' paid visit'+(paid.length===1?'':'s')+'</span><span class=\"chip\">'+usd(spent)+' lifetime</span></div>'+\n      '<div class=\"row\" style=\"gap:.4rem;margin-bottom:1rem\"><button class=\"btn purple sm\" id=\"newForMember\">New job</button>'+\n        (m.phone?'<a class=\"btn ghost sm\" href=\"'+telHref(m.phone)+'\">Call</a><button class=\"btn ghost sm\" type=\"button\" id=\"textMember\">Text</button>':'')+\n        (m.address?'<a class=\"btn ghost sm\" href=\"'+mapHref(m.address)+'\" target=\"_blank\" rel=\"noopener\">Navigate</a>':'')+'</div>'+\n      '<form class=\"steel panel sec\" id=\"mForm\"><h3>Contact</h3><div class=\"grid g2\">'+\n        '<div class=\"field\"><label>Name</label><input name=\"name\" value=\"'+esc(m.name||'')+'\"></div><div class=\"field\"><label>Phone</label><input name=\"phone\" type=\"tel\" value=\"'+esc(m.phone||'')+'\"></div>'+\n        '<div class=\"field\"><label>Email</label><input name=\"email\" type=\"email\" value=\"'+esc(m.email||'')+'\"></div><div class=\"field\"><label>Service address</label><input name=\"address\" value=\"'+esc(m.address||'')+'\"></div></div>'+\n        '<div class=\"field\"><label>Notes (only your team sees these)</label><textarea name=\"notes\" rows=\"2\" placeholder=\"Gate code, parking, prefers texts, fleet contact…\">'+esc(m.notes||'')+'</textarea></div>'+\n        '<button class=\"btn sm\">Save contact</button><span id=\"mErr\" class=\"err-text\"></span></form>'+\n      '<div class=\"steel panel sec\"><div class=\"row\" style=\"justify-content:space-between\"><h3 style=\"margin:0\">Vehicles</h3><button class=\"btn ghost sm\" id=\"vAddBtn\">+ Add vehicle</button></div><div id=\"vAdd\"></div>'+\n        (V.length?V.map(function(v){ var hist=(x.jobs||[]).filter(function(j){ return j.vehicle_id===v.id; }); var dec=[]; hist.forEach(function(j){ (j.declined||[]).forEach(function(dd){ if(dec.indexOf(dd)<0) dec.push(dd); }); });\n          return '<div class=\"veh\"><div class=\"row\" style=\"justify-content:space-between;align-items:flex-start\"><div><b>'+esc(v.description)+'</b><div class=\"dim\" style=\"font-size:.85rem\">'+\n            [v.vin?'VIN '+esc(v.vin):'', v.plate?'Plate '+esc(v.plate):'', v.mileage?n(v.mileage)+' mi':''].filter(Boolean).join(' · ')+(hist.length?' · '+hist.length+' job'+(hist.length>1?'s':''):'')+'</div>'+\n            (v.notes?'<div class=\"dim\" style=\"font-size:.85rem\">'+esc(v.notes)+'</div>':'')+(dec.length?'<div style=\"font-size:.85rem;color:var(--warn)\">Declined before: '+esc(dec.join(', '))+'</div>':'')+'</div>'+\n            '<div class=\"row\" style=\"gap:.3rem\"><button class=\"btn sm\" data-vjob=\"'+v.id+'\">New job</button><button class=\"btn ghost sm\" data-vedit=\"'+v.id+'\">Edit</button></div></div><div data-vform=\"'+v.id+'\"></div></div>'; }).join('')\n          :'<div class=\"dim\">No vehicles on file yet. They\\'re saved automatically from every job.</div>')+'</div>'+\n      '<div class=\"steel panel sec\"><div class=\"row\" style=\"justify-content:space-between\"><h3 style=\"margin:0\">Reminders</h3><button class=\"btn ghost sm\" id=\"rAddBtn\">+ Add reminder</button></div><div id=\"rAdd\"></div>'+\n        (rems.length?rems.map(function(r){ return '<div class=\"ev\"><div class=\"k\">'+dayLabel(r.due_date)+'</div><div>'+esc(r.title)+(r.vehicle&&r.vehicle.description?' <span class=\"dim\">'+esc(r.vehicle.description)+'</span>':'')+'</div></div>'; }).join(''):'<div class=\"dim\">No reminders scheduled.</div>')+'</div>'+\n      '<div class=\"steel panel sec\"><h3>Job history</h3>'+((x.jobs||[]).length?'<table>'+x.jobs.map(function(j){ return '<tr class=\"click\" data-job=\"'+j.id+'\"><td class=\"dim\" style=\"white-space:nowrap\">'+dayLabel((j.sched_date||j.created_at||'').slice(0,10))+'</td><td>'+esc(j.service||'')+'<div class=\"dim\" style=\"font-size:.82rem\">'+esc(j.vehicle||'')+(j.mileage?' · '+n(j.mileage)+' mi':'')+'</div>'+(j.declined&&j.declined.length?'<div style=\"font-size:.82rem;color:var(--warn)\">Declined: '+esc(j.declined.join(', '))+'</div>':'')+'</td><td>'+stageChip(j)+(j.total_cents?'<div class=\"dim\" style=\"font-size:.82rem\">'+usd(j.total_cents)+'</div>':'')+'</td></tr>'; }).join('')+'</table>':'<div class=\"dim\">No jobs on file yet.</div>')+'</div>'+\n      (OWN()?'<label class=\"row sec\" style=\"color:var(--text);font-family:var(--body);cursor:pointer\"><input type=\"checkbox\" id=\"fleetBox\"'+(m.is_fleet?' checked':'')+'> Fleet account (FleetCare pricing, earns no points)</label>'+\n        '<div class=\"steel panel sec\"><h3>Adjust points</h3><div class=\"row\"><input id=\"adjPts\" type=\"number\" placeholder=\"+50 or -50\" style=\"width:130px\"><input id=\"adjNote\" placeholder=\"Reason (shows in their history)\" style=\"flex:1;min-width:160px\"><button class=\"btn sm\" id=\"adjGo\">Apply</button></div></div>':'')+\n      (!m.is_fleet?'<div class=\"steel panel sec\"><h3>Rewards</h3><div class=\"tierline\"><div class=\"bolt\"><b>'+esc(t.name)+'</b></div><div style=\"flex:1\"><div class=\"dim\" style=\"font-size:.88rem;margin:.2rem 0 .4rem\">'+usd(x.spend_12mo_cents)+' spent in 12 months'+(nx?', '+usd(Math.max(0,nx.min_spend_cents-x.spend_12mo_cents))+' to '+esc(nx.name):', top tier')+'</div><div class=\"bar\"><i style=\"width:'+Math.max(0,pct)+'%\"></i></div></div></div>'+\n        (x.status?'<div class=\"dim\" style=\"font-size:.88rem;margin-top:.5rem\">'+esc(x.status.name)+' status from referrals through '+esc(new Date(x.status.until).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}))+'</div>':'')+\n        (t.warranty_days?'<div class=\"dim\" style=\"font-size:.88rem;margin-top:.3rem\">Labor warranty on shop-supplied parts: '+n(t.warranty_days)+' days</div>':'')+\n        (x.referral&&x.referral.code?'<div style=\"margin-top:.7rem;font-size:.9rem\">Referral code <b style=\"color:var(--gold)\">'+esc(x.referral.code)+'</b> &middot; '+n(x.referral.rewarded)+' friend'+(x.referral.rewarded===1?'':'s')+' rewarded'+(x.referral.pending?', '+n(x.referral.pending)+' waiting on a first job':'')+(x.referral.next?' &middot; next: '+esc(x.referral.next.name)+' in '+n(x.referral.next.to_go):'')+'</div>':'')+\n        (x.referrer?'<div class=\"dim\" style=\"font-size:.88rem\">Referred by '+esc(x.referrer.name||x.referrer.email||'a customer')+(m.referral_rewarded?' (their credit was issued)':' (they get their credit after this customer\\'s first paid job)')+'</div>':'')+\n        (!m.referred_by&&!m.first_paid_at?'<div class=\"row\" style=\"margin-top:.6rem\"><input id=\"refCode\" placeholder=\"Friend\\'s code UEA-XXXXX\" style=\"flex:1;min-width:150px;text-transform:uppercase\"><button class=\"btn ghost sm\" id=\"refGo\">Add referral</button></div><div class=\"help\">Gives this customer the friend credit. Whoever referred them gets theirs after this customer\\'s first paid job.</div>':'')+\n        '<div class=\"row\" style=\"margin-top:.7rem;align-items:center;gap:.5rem\"><span class=\"dim\" style=\"font-size:.88rem\">Birthday month</span><select id=\"bmSel\" style=\"width:auto\"><option value=\"\">Not set</option>'+['January','February','March','April','May','June','July','August','September','October','November','December'].map(function(mo,i){ return '<option value=\"'+(i+1)+'\"'+(m.birth_month===i+1?' selected':'')+'>'+mo+'</option>'; }).join('')+'</select></div>'+\n        '</div>':'')+\n      (x.vouchers.length?'<div class=\"steel panel sec\"><h3>Reward vouchers</h3><div class=\"scroll\"><table>'+x.vouchers.map(voucherRow).join('')+'</table></div></div>':'')+\n      '<div class=\"steel panel\"><h3>Points history</h3>'+(x.ledger.length?'<table>'+x.ledger.map(function(l){ return '<tr><td class=\"dim\" style=\"white-space:nowrap\">'+when(l.created_at)+'</td><td>'+esc(l.note||TYPE[l.type])+'</td><td>'+signed(l.points)+'</td></tr>'; }).join('')+'</table>':'<div class=\"dim\">No points activity yet.</div>')+'</div>';\n    sh.innerHTML=h;\n    $('#closeDrawer').addEventListener('click', closeDrawer);\n    $$('#sheet tr[data-job]').forEach(function(tr){ tr.addEventListener('click', function(){ openJob(tr.dataset.job); }); });\n    function newJob(v){ S.prefill={member_id:m.id,customer_name:m.name,email:m.email,phone:m.phone,address:m.address,vehicles:V,vehicle:v?v.description:'',vin:v?v.vin:'',plate:v?v.plate:''}; $('#drawer').classList.add('hide'); go('new'); }\n    $('#newForMember').addEventListener('click', function(){ newJob(V.length===1?V[0]:null); });\n    if($('#textMember')) $('#textMember').addEventListener('click', function(){ openThread(String(m.phone).replace(/\\D/g,'').slice(-10)); });\n    if($('#refGo')) $('#refGo').addEventListener('click', function(){ var btn=this, code=$('#refCode').value.trim(); if(!code) return; busy(btn,true,'Adding…');\n      api('/admin/member/'+m.id+'/referral',{method:'POST',body:{code:code}}).then(function(r){ toast('Referral added'+(r.voucher?': '+r.voucher.code+' ('+r.voucher.reward_name+')':'')); openMember(m.id); }).catch(function(e){ busy(btn,false); toast(e.message,true); }); });\n    if($('#bmSel')) $('#bmSel').addEventListener('change', function(){ api('/admin/member/'+m.id,{method:'PATCH',body:{birth_month:this.value}}).then(function(){ toast('Birthday month saved'); }).catch(function(e){ toast(e.message,true); }); });\n    $$('[data-vjob]').forEach(function(b){ b.addEventListener('click', function(){ newJob(V.filter(function(v){ return v.id===b.dataset.vjob; })[0]); }); });\n    $('#mForm').addEventListener('submit', function(e){ e.preventDefault(); var f=e.target, btn=f.querySelector('button'); busy(btn,true,'Saving…');\n      api('/admin/member/'+m.id,{method:'PATCH',body:{name:fe(f,'name').value,phone:fe(f,'phone').value,email:fe(f,'email').value,address:fe(f,'address').value,notes:fe(f,'notes').value}})\n        .then(function(){ toast('Customer saved'); openMember(m.id); }).catch(function(err){ $('#mErr').textContent=err.message; busy(btn,false); }); });\n    function vehForm(el, v){\n      el.innerHTML='<form class=\"gpick\" data-vf><div class=\"grid g2\"><div class=\"field\"><label>Year, make, model, engine</label><input name=\"description\" value=\"'+esc(v?v.description:'')+'\" placeholder=\"2018 Toyota Camry 2.5L\"></div>'+\n        '<div class=\"field\"><label>VIN</label><div class=\"row\" style=\"flex-wrap:nowrap\"><input name=\"vin\" maxlength=\"17\" style=\"text-transform:uppercase\" value=\"'+esc(v&&v.vin||'')+'\"><button type=\"button\" class=\"btn ghost sm\" data-vdec>Decode</button></div></div>'+\n        '<div class=\"field\"><label>Plate</label><input name=\"plate\" value=\"'+esc(v&&v.plate||'')+'\" style=\"text-transform:uppercase\"></div><div class=\"field\"><label>Mileage</label><input name=\"mileage\" inputmode=\"numeric\" value=\"'+esc(v&&v.mileage||'')+'\"></div></div>'+\n        '<div class=\"field\"><label>Vehicle notes</label><input name=\"notes\" value=\"'+esc(v&&v.notes||'')+'\" placeholder=\"Aftermarket stereo, lifted, known oil leak…\"></div>'+\n        '<div class=\"row\"><button class=\"btn sm\">Save vehicle</button><button type=\"button\" class=\"btn ghost sm\" data-vcancel>Cancel</button></div></form>';\n      var f=el.querySelector('form');\n      f.querySelector('[data-vdec]').addEventListener('click', function(){ decodeVin(fe(f,'vin'), fe(f,'description')); });\n      f.querySelector('[data-vcancel]').addEventListener('click', function(){ el.innerHTML=''; });\n      f.addEventListener('submit', function(e){ e.preventDefault(); var body={description:fe(f,'description').value,vin:fe(f,'vin').value,plate:fe(f,'plate').value,mileage:fe(f,'mileage').value,notes:fe(f,'notes').value};\n        (v?api('/admin/vehicle/'+v.id,{method:'PATCH',body:body}):api('/admin/member/'+m.id+'/vehicles',{method:'POST',body:body}))\n          .then(function(){ toast('Vehicle saved'); openMember(m.id); }).catch(function(err){ toast(err.message,true); }); });\n    }\n    $('#vAddBtn').addEventListener('click', function(){ vehForm($('#vAdd'), null); });\n    $$('[data-vedit]').forEach(function(b){ b.addEventListener('click', function(){ vehForm($('[data-vform=\"'+b.dataset.vedit+'\"]'), V.filter(function(v){ return v.id===b.dataset.vedit; })[0]); }); });\n    $('#rAddBtn').addEventListener('click', function(){\n      var due=new Date(); due.setMonth(due.getMonth()+6);\n      $('#rAdd').innerHTML='<form class=\"gpick\"><div class=\"grid g3\"><div class=\"field\"><label>Reminder</label><input name=\"title\" placeholder=\"Oil change\"></div><div class=\"field\"><label>Due</label><input type=\"date\" name=\"due_date\" value=\"'+due.toISOString().slice(0,10)+'\"></div>'+\n        '<div class=\"field\"><label>Vehicle</label><select name=\"vehicle_id\"><option value=\"\">Any</option>'+V.map(function(v){ return '<option value=\"'+v.id+'\">'+esc(v.description)+'</option>'; }).join('')+'</select></div></div><button class=\"btn sm\">Add reminder</button></form>';\n      $('#rAdd form').addEventListener('submit', function(e){ e.preventDefault(); var f=e.target;\n        api('/admin/reminders',{method:'POST',body:{member_id:m.id,title:fe(f,'title').value,due_date:fe(f,'due_date').value,vehicle_id:fe(f,'vehicle_id').value||null}})\n          .then(function(){ toast('Reminder added'); openMember(m.id); }).catch(function(err){ toast(err.message,true); }); });\n    });\n    if($('#fleetBox')) $('#fleetBox').addEventListener('change', function(){ var on=this.checked; api('/admin/member/'+m.id+'/fleet',{method:'POST',body:{is_fleet:on}}).then(function(){ toast(on?'Marked as fleet':'Fleet flag removed'); openMember(m.id); }).catch(function(e){ toast(e.message,true); }); });\n    if($('#adjGo')) $('#adjGo').addEventListener('click', function(){\n      var p=parseInt($('#adjPts').value,10), note=$('#adjNote').value.trim();\n      if(!p) return toast('Enter a point amount',true); if(!note) return toast('Add a reason',true);\n      api('/admin/adjust',{method:'POST',body:{member_id:m.id,points:p,note:note}}).then(function(){ toast('Points adjusted'); openMember(m.id); }).catch(function(e){ toast(e.message,true); });\n    });\n    bindVoucherButtons(function(){ openMember(m.id); });\n  }).catch(function(e){ sh.innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n}\n\n/* ───────── CALENDAR ───────── */\nvar CAL={mode:null, ref:null, sel:null, tech:''};\nfunction isoOf(d){ return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0'); }\nfunction parseIso(s){ var p=s.split('-'); return new Date(Date.UTC(+p[0],+p[1]-1,+p[2])); }\nfunction addDays(s,n){ var d=parseIso(s); d.setUTCDate(d.getUTCDate()+n); return isoOf(d); }\nfunction todayIso(){ return new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'}); }\nfunction minLabel(m){ if(m==null) return ''; var h=Math.floor(m/60), mm=m%60; return ((h%12)||12)+(mm?':'+String(mm).padStart(2,'0'):'')+(h<12?' AM':' PM'); }\nfunction calRange(){\n  var r=parseIso(CAL.ref);\n  if(CAL.mode==='week'){ var s=addDays(CAL.ref, -r.getUTCDay()); return {from:s, to:addDays(s,6), first:s, days:7}; }\n  var first=isoOf(new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), 1)));\n  var start=addDays(first, -parseIso(first).getUTCDay());\n  return {from:start, to:addDays(start,41), first:first, days:42};\n}\nVIEWS.calendar=function(){\n  if(!CAL.ref){ CAL.ref=todayIso(); CAL.sel=CAL.ref; }\n  if(!CAL.mode) CAL.mode=PHONE()?'month':'month';\n  var rg=calRange(), r=parseIso(CAL.mode==='week'?rg.from:rg.first);\n  var title=CAL.mode==='week'\n    ? dayLabel(rg.from).replace(/^\\w+, /,'')+' – '+dayLabel(rg.to).replace(/^\\w+, /,'')\n    : r.toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});\n  $('#view').innerHTML='<div class=\"calhead\"><h2 style=\"margin:0\">Calendar</h2>'+\n      '<div class=\"row\" style=\"gap:.35rem\"><button class=\"btn ghost sm\" id=\"calSub\">Add to my phone</button>'+\n      (DESK()?'<select id=\"calTech\" style=\"width:auto\"><option value=\"\">Everyone</option><option value=\"none\">Unassigned</option></select>':'')+'</div></div>'+\n    '<div class=\"calbar\"><div class=\"row\" style=\"gap:.3rem\"><button class=\"btn ghost sm\" id=\"calPrev\" aria-label=\"Previous\">‹</button><button class=\"btn ghost sm\" id=\"calToday\">Today</button><button class=\"btn ghost sm\" id=\"calNext\" aria-label=\"Next\">›</button></div>'+\n      '<div class=\"caltitle\">'+esc(title)+'</div>'+\n      '<div class=\"seg calmode\"><button class=\"'+(CAL.mode==='month'?'on na':'')+'\" data-cm=\"month\">Month</button><button class=\"'+(CAL.mode==='week'?'on na':'')+'\" data-cm=\"week\">Week</button></div></div>'+\n    '<div id=\"calUnsched\"></div><div id=\"calSubBox\"></div><div id=\"calGrid\" class=\"steel\"><div class=\"empty\">Loading…</div></div><div id=\"calDay\"></div>';\n  $('#calPrev').addEventListener('click', function(){ step(-1); });\n  $('#calNext').addEventListener('click', function(){ step(1); });\n  $('#calToday').addEventListener('click', function(){ CAL.ref=todayIso(); CAL.sel=CAL.ref; VIEWS.calendar(); });\n  $$('[data-cm]').forEach(function(b){ b.addEventListener('click', function(){ CAL.mode=b.dataset.cm; CAL.ref=CAL.sel||CAL.ref; VIEWS.calendar(); }); });\n  $('#calSub').addEventListener('click', showSub);\n  if($('#calTech')){\n    api('/admin/techs').then(function(d){ $('#calTech').insertAdjacentHTML('beforeend', d.techs.map(function(t){ return '<option value=\"'+t.id+'\">'+esc(t.name)+'</option>'; }).join('')); $('#calTech').value=CAL.tech; });\n    $('#calTech').addEventListener('change', function(){ CAL.tech=this.value; load(); });\n  }\n  function step(n){\n    if(CAL.mode==='week'){ CAL.ref=addDays(CAL.ref, 7*n); }\n    else { var d=parseIso(CAL.ref); CAL.ref=isoOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+n, 1))); }\n    CAL.sel=CAL.ref; VIEWS.calendar();\n  }\n  function load(){\n    api('/admin/calendar?from='+rg.from+'&to='+rg.to+'&tech='+encodeURIComponent(CAL.tech)).then(function(d){\n      var by={}; d.jobs.forEach(function(j){ (by[j.date]=by[j.date]||[]).push(j); });\n      CAL.by=by; CAL.today=d.today;\n      $('#calUnsched').innerHTML=d.unscheduled?'<button class=\"cnote unsched\" id=\"calUn\"><b>'+d.unscheduled+'</b> open job'+(d.unscheduled>1?'s':'')+' not on the calendar yet. Tap to schedule.</button>':'';\n      if($('#calUn')) $('#calUn').addEventListener('click', function(){ S.jobsView='board'; S.stageF='new'; go('jobs'); });\n      paintGrid(); paintDay();\n    }).catch(function(e){ $('#calGrid').innerHTML='<div class=\"empty\">'+esc(e.message)+'</div>'; });\n  }\n  function chip(j){\n    var cls=j.status==='paid'?'done':(j.stage==='completed'?'done':(['en_route','on_site','in_progress'].indexOf(j.stage)>-1?'live':(j.rush?'rush':'')));\n    return '<button class=\"cev '+cls+'\" data-cj=\"'+j.id+'\"><span>'+esc(j.start_min!=null?minLabel(j.start_min):'Any')+'</span> '+esc(j.customer_name||'Customer')+'</button>';\n  }\n  function paintGrid(){\n    var h='<div class=\"cgrid '+CAL.mode+'\">'+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(function(w){ return '<div class=\"cdow\">'+w+'</div>'; }).join('');\n    var month=parseIso(rg.first).getUTCMonth();\n    for(var i=0;i<rg.days;i++){\n      var day=addDays(rg.from,i), jobs=CAL.by[day]||[], dd=parseIso(day);\n      var max=PHONE()?0:(CAL.mode==='week'?20:3);\n      h+='<div class=\"cday'+(dd.getUTCMonth()!==month&&CAL.mode==='month'?' out':'')+(day===CAL.today?' today':'')+(day===CAL.sel?' sel':'')+'\" data-cd=\"'+day+'\" role=\"button\" tabindex=\"0\" aria-label=\"'+esc(dayLabel(day))+', '+jobs.length+' job'+(jobs.length===1?'':'s')+'\">'+\n        '<div class=\"cnum\">'+dd.getUTCDate()+'</div>'+\n        (max?jobs.slice(0,max).map(chip).join('')+(jobs.length>max?'<div class=\"cmore\">+'+(jobs.length-max)+' more</div>':''):(jobs.length?'<div class=\"cdots\">'+jobs.slice(0,4).map(function(){ return '<i></i>'; }).join('')+(jobs.length>4?'<b>+</b>':'')+'</div>':''))+\n        '</div>';\n    }\n    $('#calGrid').innerHTML=h+'</div>';\n    $$('#calGrid [data-cd]').forEach(function(c){\n      var pick=function(e){ if(e.target.closest('[data-cj]')) return; CAL.sel=c.dataset.cd; $$('#calGrid .cday').forEach(function(x){ x.classList.toggle('sel', x===c); }); paintDay(); if(PHONE()) $('#calDay').scrollIntoView({behavior:'smooth',block:'start'}); };\n      c.addEventListener('click', pick); c.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); pick(e); } });\n    });\n    $$('#calGrid [data-cj]').forEach(function(b){ b.addEventListener('click', function(){ openJob(b.dataset.cj); }); });\n  }\n  function paintDay(){\n    var day=CAL.sel; if(!day||!CAL.by) return;\n    var jobs=CAL.by[day]||[];\n    var hrs=jobs.filter(function(j){ return j.status!=='paid'; }).reduce(function(a,j){ return a+j.hours; },0);\n    $('#calDay').innerHTML='<div class=\"dayhead\"><h3>'+esc(dayLabel(day))+(day===CAL.today?' <span class=\"chip gold\">Today</span>':'')+'</h3>'+\n        '<span class=\"help\">'+(jobs.length?jobs.length+' job'+(jobs.length>1?'s':'')+(hrs?' · about '+(Math.round(hrs*10)/10)+' hr of work':''):'Nothing booked')+'</span></div>'+\n      (jobs.length?jobs.map(function(j){\n        return '<button class=\"card cjob\" data-cj=\"'+j.id+'\"><div class=\"ctime\">'+esc(j.start_min!=null?minLabel(j.start_min):(j.window||'Any time'))+'<small>'+(Math.round(j.hours*10)/10)+' hr</small></div>'+\n          '<div><div class=\"t\">'+esc(j.customer_name||'Customer')+' '+stageChip(j)+(j.rush?' <span class=\"chip bad\">Rush</span>':'')+'</div>'+\n          '<div class=\"s\">'+esc(j.service||'No service listed')+(j.vehicle?' · '+esc(j.vehicle):'')+'</div>'+\n          '<div class=\"s\">'+(j.address?esc(j.address)+' · ':'')+(j.tech?esc(j.tech.name):'<span style=\"color:var(--warn)\">No tech</span>')+'</div></div></button>';\n      }).join(''):'')+\n      (DESK()?'<button class=\"btn ghost sm\" id=\"calNew\" style=\"margin-top:.4rem\">+ New job on '+esc(dayLabel(day))+'</button>':'');\n    $$('#calDay [data-cj]').forEach(function(b){ b.addEventListener('click', function(){ openJob(b.dataset.cj); }); });\n    if($('#calNew')) $('#calNew').addEventListener('click', function(){ S.prefill={sched_date:day}; go('new'); });\n  }\n  function showSub(){\n    var box=$('#calSubBox'); if(box.innerHTML){ box.innerHTML=''; return; }\n    box.innerHTML='<div class=\"steel panel sec\"><div class=\"empty\">Loading…</div></div>';\n    api('/admin/calendar/feed').then(function(d){\n      box.innerHTML='<div class=\"steel panel sec\"><h3>See jobs in your phone\\'s calendar</h3>'+\n        '<p class=\"help\" style=\"margin-top:-.4rem\">Shows '+esc(d.scope)+'. New and changed jobs show up on their own within about 15 minutes (Google can take a few hours).</p>'+\n        '<div class=\"row\" style=\"gap:.4rem\"><a class=\"btn\" href=\"'+esc(d.webcal)+'\">iPhone: add calendar</a>'+\n        '<a class=\"btn ghost\" target=\"_blank\" rel=\"noopener\" href=\"https://calendar.google.com/calendar/u/0/r?cid='+encodeURIComponent(d.webcal)+'\">Google Calendar</a>'+\n        '<button class=\"btn ghost\" id=\"calCopy\">Copy link</button></div>'+\n        '<div class=\"help\" style=\"margin-top:.6rem\">Keep this link private. Anyone with it can see the job list.</div></div>';\n      $('#calCopy').addEventListener('click', function(){ (navigator.clipboard?navigator.clipboard.writeText(d.url):Promise.reject()).then(function(){ toast('Calendar link copied'); }).catch(function(){ prompt('Copy this link', d.url); }); });\n    }).catch(function(e){ box.innerHTML=''; toast(e.message,true); });\n  }\n  load();\n};\n\nvar SHOP_ORDERS_URL='https://ueauto.store/admin/orders.json?status=any&limit=250';\n/* ───────── boot ───────── */\ntry{ S.token=localStorage.getItem(TOKEN_KEY); S.me=JSON.parse(localStorage.getItem(ME_KEY)||'null'); }catch(e){}\nif(S.token && S.me){\n  var exp=0; try{ exp=JSON.parse(atob(S.token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))).exp; }catch(e){}\n  if(!exp || exp>Date.now()) start(); else signOut();\n} else signOut();\n})();\n</script>\n</body>\n</html>\n";

// Website add-on for the Rewards section (source: rewards-plus.src.js). Served at /loyalty/rewards-plus.js
const REWARDS_PLUS_JS = "// ═══════════════════════════════════════════════════════════════════════════\n// UPPER ECHELON REWARDS PLUS — served by the backend at /loyalty/rewards-plus.js\n// Adds the \"Give $25, get $25\" referral program, birthday bonus, comeback bonus,\n// pending welcome points and referral status to the Rewards section on ueauto.store,\n// plus the customer rating bar at the top of every page.\n// The theme only needs one line before </body>:\n//   <script src=\"https://uea-backend-3.onrender.com/loyalty/rewards-plus.js\" defer></script>\n// Changes to this file go live with a Render deploy; no theme edits needed.\n// ═══════════════════════════════════════════════════════════════════════════\n(function () {\n'use strict';\nif (window.__ueaRwPlus) return; window.__ueaRwPlus = true;\nvar API = '__API__';\nvar REFKEY = 'uea_rw_ref';\nvar MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];\nvar esc = function (t) { var e = document.createElement('span'); e.textContent = t == null ? '' : String(t); return e.innerHTML; };\nvar n = function (v) { return Number(v || 0).toLocaleString('en-US'); };\nvar money = function (c) { var d = (c || 0) / 100; return '$' + (d % 1 ? d.toFixed(2) : d.toLocaleString('en-US')); };\nvar ls = {\n  get: function (k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },\n  del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }\n};\nvar ss = {\n  get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },\n  set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }\n};\nvar program = null;\n\n// ── Styles (match the site's purple/gold Rewards look) ─────────────────────\nvar css = '' +\n'@media (min-width:900px){#rewards .rw-earn{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (min-width:721px){#rewards .rw-rail{grid-template-columns:repeat(3,minmax(0,1fr))}}' +\n'.rwp-ref{margin-top:var(--space-6,1.5rem);padding:var(--space-5,1.25rem);border-radius:var(--radius-md,12px);border:1px solid rgba(203,161,53,.55);background:linear-gradient(135deg,rgba(107,40,150,.45),rgba(11,10,16,.55))}' +\n'.rwp-ref-head{display:flex;gap:var(--space-4,1rem);align-items:center}' +\n'.rwp-big{flex:none;display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:var(--color-accent,#CBA135);color:var(--color-on-accent,#0B0A10);font-weight:800;font-size:1.35rem;font-stretch:85%}' +\n'.rwp-ref-head b{display:block;font-size:1.1rem}.rwp-ref-head div>span{font-size:.88rem;color:var(--color-text-muted)}' +\n'.rwp-code{margin-top:var(--space-4,1rem);font-size:.9rem;color:var(--color-text-muted)}' +\n'.rwp-btns{display:flex;flex-wrap:wrap;gap:var(--space-2,.5rem);margin-top:var(--space-3,.75rem)}' +\n'.rwp-btns .rw-mini{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;flex:1 1 140px}' +\n'.rwp-ghost{background:transparent!important;color:var(--color-accent,#CBA135)!important;border:1px solid rgba(203,161,53,.6)!important}' +\n'.rwp-stats{margin-top:var(--space-4,1rem);font-size:.88rem;color:var(--color-text-muted)}' +\n'.rwp-ladder{list-style:none;margin:var(--space-3,.75rem) 0 0;padding:0;display:grid;gap:6px}' +\n'.rwp-ladder li{display:flex;gap:10px;align-items:center;font-size:.88rem;padding:8px 10px;border-radius:var(--radius-sm,8px);background:rgba(11,10,16,.5);border:1px solid var(--color-line)}' +\n'.rwp-ladder li i{flex:none;font-style:normal;display:grid;place-items:center;min-width:30px;height:30px;border-radius:999px;border:1px solid rgba(203,161,53,.55);color:var(--color-accent,#CBA135);font-weight:800;font-size:.8rem}' +\n'.rwp-ladder li.done{border-color:rgba(203,161,53,.6)}.rwp-ladder li.done i{background:var(--color-accent,#CBA135);color:var(--color-on-accent,#0B0A10)}' +\n'.rwp-pending,.rwp-status{margin-top:var(--space-3,.75rem);display:block;width:fit-content;max-width:100%;line-height:1.4;padding:6px 12px;border-radius:14px;font-size:.84rem;border:1px dashed rgba(203,161,53,.7);color:var(--color-text)}' +\n'.rwp-pending b,.rwp-status b{color:var(--color-accent,#CBA135)}' +\n'.rwp-bday{display:flex;gap:var(--space-2,.5rem);margin-top:var(--space-2,.5rem)}' +\n'.rwp-bday select{flex:1;min-width:0;min-height:44px;padding:0 10px;border-radius:var(--radius-sm,8px);border:1px solid var(--color-line-strong);background:var(--color-bg,#0B0A10);color:var(--color-text);font:inherit;font-size:16px}' +\n'.rwp-band{max-width:1040px;margin:var(--space-7,2.5rem) auto 0;padding:var(--space-5,1.25rem);border-radius:var(--radius-md,12px);border:1px solid rgba(203,161,53,.55);background:linear-gradient(135deg,rgba(107,40,150,.45),var(--color-raised,#1A1428) 70%)}' +\n'.rwp-band h3{margin:0 0 6px}.rwp-band>p{margin:0;color:var(--color-text-muted)}' +\n'.rwp-steps{list-style:none;margin:var(--space-4,1rem) 0 0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3,.75rem)}' +\n'.rwp-steps li{padding:var(--space-4,1rem);border-radius:var(--radius-sm,8px);background:rgba(11,10,16,.5);border:1px solid var(--color-line);font-size:.92rem}' +\n'.rwp-steps b{display:block;color:var(--color-accent,#CBA135);font-size:1.25rem;font-weight:800;margin-bottom:2px}' +\n'.rwp-band .rwp-ladder{grid-template-columns:repeat(3,minmax(0,1fr))}' +\n'.rwp-band .rw-cta{margin-top:var(--space-5,1.25rem)}' +\n'@media (max-width:720px){.rwp-steps,.rwp-band .rwp-ladder{grid-template-columns:1fr}}' +\n'.rwp-gift{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:1900;max-width:460px;margin:0 auto;display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:14px;border:1px solid rgba(203,161,53,.7);background:#1A1428;box-shadow:0 12px 40px rgba(0,0,0,.55);color:var(--color-text,#F3EFE8);font-size:.9rem}' +\n'.rwp-gift b{color:var(--color-accent,#CBA135)}.rwp-gift .rw-mini{text-decoration:none;display:inline-flex;align-items:center}' +\n'.rwp-gift button.rwp-x{flex:none;background:none;border:0;color:var(--color-text-subtle,#999);font-size:1.4rem;line-height:1;padding:4px 6px;cursor:pointer}';\nvar st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);\n\n// ── Program numbers ────────────────────────────────────────────────────────\nfunction friendAmt(p) { return money((p && p.referral_friend_cents) || 2500); }\nfunction referAmt(p) { return money((p && p.referral_referrer_cents) || 2500); }\nfunction minAmt(p) { return money((p && p.referral_min_cents) || 20000); }\nfunction setHTML(el, html) { if (el && el.innerHTML !== html) el.innerHTML = html; }\nfunction setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }\n\n// ── Public Rewards section ─────────────────────────────────────────────────\nfunction applyPublic() {\n  var p = program, root = document.getElementById('rewards');\n  if (!p || !root) return;\n  var earn = root.querySelector('.rw-earn');\n  if (earn) {\n    var ppd = Number(p.points_per_dollar) || 1, parts = Number(p.parts_points_per_dollar);\n    var first = root.querySelector('[data-rw=\"ppd\"]');\n    if (first && parts === ppd) {\n      var what = first.parentNode.querySelector('.rw-what');\n      setHTML(what, 'per $1 you spend <span class=\"rw-sub\" data-rw=\"parts\">Labor and parts, on every paid job</span>');\n    }\n    var refNum = root.querySelector('[data-rw=\"referral\"]');\n    if (refNum && (p.referral_friend_cents || p.referral_referrer_cents)) {\n      setText(refNum, friendAmt(p));\n      setHTML(refNum.parentNode.querySelector('.rw-what'), 'for you and a friend <span class=\"rw-sub\" data-rw=\"refmin\">They get ' + friendAmt(p) + ' off their first service of ' + minAmt(p) + '+. You get ' + referAmt(p) + ' when it’s paid.</span>');\n    }\n    if (p.birthday_bonus && !earn.querySelector('[data-rwp=\"bday\"]')) {\n      var li = document.createElement('li'); li.setAttribute('data-rwp', 'bday');\n      li.innerHTML = '<span class=\"rw-num\">+' + n(p.birthday_bonus) + '</span><span class=\"rw-what\">birthday month <span class=\"rw-sub\">Every year, once you’re a customer</span></span>';\n      earn.appendChild(li);\n    }\n    if (p.comeback_bonus && !earn.querySelector('[data-rwp=\"comeback\"]')) {\n      var li2 = document.createElement('li'); li2.setAttribute('data-rwp', 'comeback');\n      li2.innerHTML = '<span class=\"rw-num\">+' + n(p.comeback_bonus) + '</span><span class=\"rw-what\">comeback bonus <span class=\"rw-sub\">Any paid job within ' + n(p.comeback_months || 6) + ' months of your last one</span></span>';\n      earn.appendChild(li2);\n    }\n  }\n  var fine = root.querySelector('[data-rw=\"fine\"]');\n  setText(fine, 'One points reward per invoice; referral credits can be added on top. Dollar-off rewards and credits apply to labor. Rush fees don’t earn points. Points expire after ' + n(p.expire_months || 12) + ' months with no activity. Fleet accounts get FleetCare pricing instead of points and referral credits.');\n  var tiers = root.querySelector('.rw-tiers');\n  if (tiers && !root.querySelector('.rwp-band') && (p.referral_friend_cents || p.referral_referrer_cents)) {\n    var band = document.createElement('div'); band.className = 'rwp-band'; band.id = 'refer';\n    var ms = (p.referral_milestones || []).slice().sort(function (a, b) { return a.count - b.count; });\n    band.innerHTML = '<h3>Give ' + friendAmt(p) + ', get ' + referAmt(p) + '</h3><p>Know someone whose car needs work? Send them your link. There’s no limit on how many friends you can refer.</p>' +\n      '<ol class=\"rwp-steps\"><li><b>1</b>Sign in and tap <strong>Text a friend</strong>. It sends your personal link.</li>' +\n      '<li><b>2</b>Your friend gets ' + friendAmt(p) + ' off their first service of ' + minAmt(p) + ' or more.</li>' +\n      '<li><b>3</b>When their job is paid, you get a ' + referAmt(p) + ' credit for your next visit.</li></ol>' +\n      (ms.length ? '<ul class=\"rwp-ladder\">' + ms.map(function (m) { return '<li><i>' + n(m.count) + '</i><span><b>' + n(m.count) + ' friends:</b> ' + esc(m.name) + '</span></li>'; }).join('') + '</ul>' : '') +\n      '<div class=\"rw-cta\"><button type=\"button\" class=\"btn btn-primary\" data-rwp-refer>Get my referral link</button></div>';\n    tiers.parentNode.insertBefore(band, tiers.nextSibling);\n  }\n}\n\n// ── Signed-in dashboard ────────────────────────────────────────────────────\nfunction refBlock(p) {\n  var r = p.referral, m = p.member || {};\n  if (!r || !r.code || m.is_fleet || !(r.friend_cents || r.referrer_cents)) return '';\n  var text = 'Upper Echelon Automotive came to my driveway and fixed my car. Use my link for ' + money(r.friend_cents) + ' off your first service: ' + r.link;\n  var h = '<div class=\"rwp-ref\" data-rwp=\"ref\"><div class=\"rwp-ref-head\"><span class=\"rwp-big\">' + money(r.referrer_cents) + '</span><div><b>Give ' + money(r.friend_cents) + ', get ' + money(r.referrer_cents) + '</b>' +\n    '<span>Your friend gets ' + money(r.friend_cents) + ' off their first service of ' + money(r.min_cents) + '+. You get a ' + money(r.referrer_cents) + ' credit when it’s paid.</span></div></div>' +\n    '<div class=\"rwp-code\">Your code <span class=\"rw-code\">' + esc(r.code) + '</span></div>' +\n    '<div class=\"rwp-btns\"><a class=\"rw-mini\" href=\"sms:?&amp;body=' + encodeURIComponent(text) + '\">Text a friend</a>' +\n    '<button type=\"button\" class=\"rw-mini rwp-ghost\" data-rwp-copy=\"' + esc(text) + '\">Copy my link</button></div>';\n  if (r.rewarded || r.pending) {\n    h += '<div class=\"rwp-stats\">' + (r.rewarded ? '<b>' + n(r.rewarded) + '</b> friend' + (r.rewarded === 1 ? '' : 's') + ' rewarded' : '') +\n      (r.rewarded && r.pending ? ' &middot; ' : '') + (r.pending ? n(r.pending) + ' waiting on their first service' : '') + '</div>';\n  }\n  if (r.milestones && r.milestones.length) {\n    if (r.next) {\n      var prev = r.milestones.filter(function (x) { return x.count <= r.rewarded; }).pop();\n      var from = prev ? prev.count : 0, pct = (r.rewarded - from) / Math.max(1, r.next.count - from) * 100;\n      h += '<div class=\"rw-prog\"><div class=\"rw-prog-lbl\"><span>Next: ' + esc(r.next.name) + '</span><b>' + n(r.next.to_go) + ' more friend' + (r.next.to_go === 1 ? '' : 's') + '</b></div><div class=\"rw-bar\"><i style=\"width:' + Math.max(3, Math.min(100, pct)) + '%\"></i></div></div>';\n    }\n    h += '<ul class=\"rwp-ladder\">' + r.milestones.map(function (x) {\n      return '<li class=\"' + (x.reached ? 'done' : '') + '\"><i>' + (x.reached ? '✓' : n(x.count)) + '</i><span><b>' + n(x.count) + ' friends:</b> ' + esc(x.name) + '</span></li>';\n    }).join('') + '</ul>';\n  }\n  return h + '</div>';\n}\n\nfunction augment(p) {\n  var me = document.getElementById('rw-me');\n  var dash = me && me.querySelector('.rw-dash');\n  if (!dash || !p || !p.member || dash.getAttribute('data-rwp') === '1') return;\n  dash.setAttribute('data-rwp', '1');\n  var m = p.member, prog = p.program || {};\n\n  // Balance area: pending welcome points, referral status, warranty\n  var top = dash.querySelector('.rw-dash-top');\n  var extra = '';\n  if (p.welcome_pending) extra += '<div class=\"rwp-pending\"><b>+' + n(p.welcome_pending) + '</b> welcome points pending &middot; they unlock with your first paid job</div>';\n  if (p.status && p.status.until) {\n    var until = ''; try { until = new Date(p.status.until).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); } catch (e) {}\n    extra += '<div class=\"rwp-status\"><b>' + esc(p.status.name) + '</b> status through ' + esc(until) + ', thanks to your referrals</div>';\n  }\n  var wd = p.tier && Number(p.tier.warranty_days);\n  if (wd && wd > 90 && !m.is_fleet) extra += '<div class=\"rwp-status\">Your labor warranty: <b>' + (wd >= 365 ? Math.round(wd / 365) * 12 : Math.round(wd / 30)) + ' months</b> on shop-supplied parts</div>';\n  if (top && extra) { var box = document.createElement('div'); box.innerHTML = extra; top.parentNode.insertBefore(box, top.nextSibling); }\n\n  // Flash text from the theme that still talks about referral points\n  var fl = dash.querySelector('.rw-flash');\n  if (fl && /both get points/i.test(fl.textContent)) fl.textContent = 'Code added. Your ' + friendAmt(prog) + ' credit is ready for your first service of ' + minAmt(prog) + '+.';\n\n  // Replace the theme's points-based referral block with the dollar one\n  var heads = dash.querySelectorAll('h4');\n  for (var i = 0; i < heads.length; i++) {\n    var hd = heads[i], sib = hd.nextElementSibling;\n    if (sib && sib.classList.contains('rw-ref')) { hd.parentNode.removeChild(sib); hd.parentNode.removeChild(hd); }\n    else if (/friend.s code/i.test(hd.textContent)) hd.textContent = 'Got a friend’s code? Get ' + friendAmt(prog) + ' off';\n  }\n  var html = refBlock(p);\n  if (html) {\n    var anchor = null;\n    for (var j = 0; j < heads.length; j++) if (/recent activity/i.test(heads[j].textContent)) anchor = heads[j];\n    anchor = anchor || dash.querySelector('.rw-dash-cta');\n    var wrap = document.createElement('div'); wrap.innerHTML = html;\n    if (anchor) anchor.parentNode.insertBefore(wrap.firstChild, anchor); else dash.appendChild(wrap.firstChild);\n  }\n\n  // Credits stack: the booking form picks one reward, so say how the rest get used.\n  var credits = (p.vouchers || []).filter(function (v) { return v.status === 'active' && /^ref_/.test(v.reward_key || ''); });\n  var vs = dash.querySelectorAll('.rw-voucher');\n  if (credits.length && vs.length) {\n    var tot = credits.reduce(function (s, v) { return s + (Number(v.value_cents) || 0); }, 0);\n    var cn = document.createElement('p'); cn.className = 'rw-hi'; cn.style.cssText = 'margin:.4rem 0 0;font-size:.84rem';\n    cn.innerHTML = 'Referral credits (' + money(tot) + ' total) stack with a points reward. Tell your technician and we\\u2019ll apply them all to your next invoice.';\n    vs[vs.length - 1].parentNode.insertBefore(cn, vs[vs.length - 1].nextSibling);\n  }\n\n  // Birthday month (once)\n  if (!m.birth_month && !m.is_fleet && prog.birthday_bonus) {\n    var cta = dash.querySelector('.rw-dash-cta');\n    var b = document.createElement('div');\n    b.innerHTML = '<h4>Birthday bonus: +' + n(prog.birthday_bonus) + ' points</h4><form class=\"rwp-bday\" data-rwp-bday><select name=\"month\" aria-label=\"Birthday month\"><option value=\"\">Your birthday month</option>' +\n      MONTHS.map(function (x, k) { return '<option value=\"' + (k + 1) + '\">' + x + '</option>'; }).join('') + '</select><button class=\"rw-mini\" type=\"submit\">Save</button></form><div class=\"rw-err\" data-rwp-bdayerr></div>';\n    if (cta) cta.parentNode.insertBefore(b, cta); else dash.appendChild(b);\n  } else if (m.birth_month) {\n    var hist = dash.querySelector('.rw-act');\n    var note = document.createElement('p'); note.className = 'rw-hi'; note.style.cssText = 'margin-top:.9rem;font-size:.8rem';\n    note.textContent = 'Birthday bonus: +' + n(prog.birthday_bonus || 0) + ' points every ' + MONTHS[m.birth_month - 1] + '.';\n    if (prog.birthday_bonus) (hist ? hist.parentNode.insertBefore(note, hist.nextSibling) : dash.appendChild(note));\n  }\n}\n\nfunction post(path, body) {\n  return fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })\n    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Something went wrong. Try again.'); return d; }); });\n}\n\ndocument.addEventListener('submit', function (e) {\n  var f = e.target.closest && e.target.closest('[data-rwp-bday]');\n  if (!f) return;\n  e.preventDefault();\n  var err = document.querySelector('[data-rwp-bdayerr]'), RW = window.UEARW;\n  if (!f.month.value) { if (err) err.textContent = 'Pick your birthday month.'; return; }\n  if (!RW || !RW.auth()) return;\n  var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Saving…';\n  post('/birthday', { auth: RW.auth(), month: f.month.value }).then(function () { return RW.refresh(); })\n    .catch(function (er) { btn.disabled = false; btn.textContent = 'Save'; if (err) err.textContent = er.message; });\n});\ndocument.addEventListener('click', function (e) {\n  var c = e.target.closest && e.target.closest('[data-rwp-copy]');\n  if (c) {\n    var t = c.getAttribute('data-rwp-copy');\n    var done = function () { c.textContent = 'Copied'; setTimeout(function () { c.textContent = 'Copy my link'; }, 2500); };\n    if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) { navigator.share({ title: 'Upper Echelon Automotive', text: t }).catch(function () {}); return; }\n    if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, function () { window.prompt('Copy this:', t); });\n    else window.prompt('Copy this:', t);\n    return;\n  }\n  var r = e.target.closest && e.target.closest('[data-rwp-refer]');\n  if (r) {\n    var RW = window.UEARW;\n    if (RW && RW.profile) { var me = document.querySelector('[data-rwp=\"ref\"]') || document.getElementById('rw-me'); if (me) me.scrollIntoView({ behavior: 'smooth', block: 'center' }); }\n    else if (RW) RW.openSignIn();\n    return;\n  }\n  if (e.target.closest && e.target.closest('.rwp-x')) { var g = document.querySelector('.rwp-gift'); if (g) g.parentNode.removeChild(g); ss.set('uea_rwp_gift', '1'); }\n});\n\n// ── Friend arrived from a referral link ────────────────────────────────────\nfunction giftBanner() {\n  var code = ls.get(REFKEY), RW = window.UEARW, p = RW && RW.profile;\n  if (!code || ss.get('uea_rwp_gift') || document.querySelector('.rwp-gift')) return;\n  if (p && p.member && (p.member.referred || p.member.first_paid || p.member.referral_code === code)) return;\n  var prog = program || {};\n  var a = document.createElement('div'); a.className = 'rwp-gift'; a.setAttribute('role', 'status');\n  a.innerHTML = '<span>A friend sent you <b>' + friendAmt(prog) + ' off</b> your first service of ' + minAmt(prog) + '+. It’s applied automatically when you book.</span>' +\n    '<a class=\"rw-mini\" href=\"#contact\">Book</a><button type=\"button\" class=\"rwp-x\" aria-label=\"Close\">×</button>';\n  document.body.appendChild(a);\n  a.querySelector('a').addEventListener('click', function () { if (a.parentNode) a.parentNode.removeChild(a); });\n}\n\n// Booking form: send the friend's code with the booking so their credit is attached to the job.\nif (window.fetch && !window.fetch.__rwp) {\n  var _fetch = window.fetch;\n  var wrapped = function (input, init) {\n    try {\n      var url = typeof input === 'string' ? input : (input && input.url) || '';\n      if (/\\/loyalty\\/book$/.test(url) && init && typeof init.body === 'string') {\n        var code = ls.get(REFKEY);\n        if (code) {\n          var body = JSON.parse(init.body);\n          if (!body.ref_code) { body.ref_code = code; init = Object.assign({}, init, { body: JSON.stringify(body) }); }\n          return _fetch.call(this, input, init).then(function (res) {\n            if (res.ok) { ls.del(REFKEY); var g = document.querySelector('.rwp-gift'); if (g) g.parentNode.removeChild(g); }\n            return res;\n          });\n        }\n      }\n    } catch (e) { /* never block a booking */ }\n    return _fetch.apply(this, arguments);\n  };\n  wrapped.__rwp = true;\n  window.fetch = wrapped;\n}\n\n// ── Customer rating bar (top of every page) ────────────────────────────────\n// Shows the average of the approved reviews on the site (service desk → Website reviews).\n// It sits inside the fixed navbar, so it stays on screen while customers scroll.\nvar REVIEWS_API = API.replace(/\\/loyalty$/, '') + '/reviews/public';\nvar RATEKEY = 'uea_rwp_rating';\nvar rateCss = '' +\n'.rwp-rate{display:flex;align-items:center;justify-content:center;gap:8px;min-height:34px;padding:5px 12px;background:var(--color-accent,#CBA135);color:var(--color-on-accent,#0B0A10);font-weight:700;font-size:.86rem;line-height:1.2;text-decoration:none;text-align:center;letter-spacing:.01em}' +\n'.rwp-rate{flex-wrap:wrap;row-gap:2px}.rwp-rate>*{flex:none;white-space:nowrap}.rwp-rate:hover{filter:brightness(1.06)}' +\n'.rwp-stars{position:relative;display:inline-block;font-size:1rem;letter-spacing:1px;line-height:1;color:rgba(11,10,16,.28)}' +\n'.rwp-stars i{position:absolute;inset:0 auto 0 0;overflow:hidden;white-space:nowrap;font-style:normal;color:#0B0A10}' +\n'.rwp-rate b{font-size:1rem;font-weight:800}.rwp-rate u{text-decoration:underline;text-underline-offset:2px;white-space:nowrap}' +\n'.rwp-rate .rwp-sep{opacity:.55}' +\n'.rwp-chip{display:inline-flex;align-items:center;gap:8px;margin-bottom:var(--space-3,.75rem);padding:6px 12px;border-radius:999px;border:1px solid rgba(203,161,53,.55);background:rgba(11,10,16,.6);color:var(--color-text,#F3EFE8);font-size:.88rem;font-weight:600;text-decoration:none}' +\n'.rwp-chip .rwp-stars{color:rgba(203,161,53,.3)}.rwp-chip .rwp-stars i{color:var(--color-accent,#CBA135)}.rwp-chip b{color:var(--color-accent,#CBA135)}' +\n'@media (max-width:420px){.rwp-rate{font-size:.8rem;gap:6px}.rwp-rate .rwp-long{display:none}}';\nvar rs = document.createElement('style'); rs.textContent = rateCss; document.head.appendChild(rs);\n\nfunction stars(avg) {\n  var pct = Math.max(0, Math.min(100, (Number(avg) || 0) / 5 * 100));\n  return '<span class=\"rwp-stars\" aria-hidden=\"true\">★★★★★<i style=\"width:' + pct + '%\">★★★★★</i></span>';\n}\nfunction fitUnderNav() {\n  var nav = document.getElementById('navbar'), home = document.getElementById('home'), bar = document.querySelector('.rwp-rate');\n  if (!nav || !bar) return;\n  var h = bar.offsetHeight || 0;\n  if (home) {\n    home.style.paddingTop = '';\n    var base = parseFloat(getComputedStyle(home).paddingTop) || 0;\n    home.style.paddingTop = (base + h) + 'px';\n  }\n  var de = document.documentElement;\n  de.style.scrollPaddingTop = '';\n  var sp = parseFloat(getComputedStyle(de).scrollPaddingTop) || 0;\n  de.style.scrollPaddingTop = (sp + h) + 'px';\n}\nfunction showRating(d) {\n  var count = Number(d && d.count) || 0, avg = Number(d && d.average) || 0;\n  if (!count || !avg) return;\n  var a = avg.toFixed(1);\n  var label = a + ' out of 5 stars from ' + n(count) + ' customer review' + (count === 1 ? '' : 's');\n  var html = stars(avg) + '<b>' + a + '</b><span>rated by <span class=\"rwp-long\">our </span>customers</span><span class=\"rwp-sep\">·</span><span>' + n(count) + ' review' + (count === 1 ? '' : 's') + '</span><span class=\"rwp-sep\">·</span><u>Read<span class=\"rwp-long\"> reviews</span></u>';\n  var nav = document.getElementById('navbar');\n  var bar = document.querySelector('.rwp-rate');\n  if (nav && !bar) {\n    bar = document.createElement('a'); bar.className = 'rwp-rate'; bar.href = '#reviews';\n    nav.insertBefore(bar, nav.firstChild);\n  }\n  if (bar) { setHTML(bar, html); bar.setAttribute('aria-label', label + '. Read reviews'); fitUnderNav(); }\n  // A smaller badge in the hero, right above the headline.\n  var hero = document.querySelector('#home .hero-content');\n  if (hero) {\n    var chip = hero.querySelector('.rwp-chip');\n    if (!chip) { chip = document.createElement('a'); chip.className = 'rwp-chip'; chip.href = '#reviews'; hero.insertBefore(chip, hero.firstChild); }\n    setHTML(chip, stars(avg) + '<b>' + a + '</b><span>' + n(count) + ' customer review' + (count === 1 ? '' : 's') + '</span>');\n    chip.setAttribute('aria-label', label);\n  }\n}\nfunction loadRating() {\n  showRating(ls.get(RATEKEY));   // instantly, from the last visit\n  fetch(REVIEWS_API).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {\n    if (!d) return;\n    try { localStorage.setItem(RATEKEY, JSON.stringify({ count: d.count, average: d.average })); } catch (e) {}\n    if (!(Number(d.count) > 0)) { var b = document.querySelector('.rwp-rate'), c = document.querySelector('.rwp-chip'); if (b) b.parentNode.removeChild(b); if (c) c.parentNode.removeChild(c); fitUnderNav(); return; }\n    showRating(d);\n  }).catch(function () {});\n  var t = null;\n  window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(fitUnderNav, 150); });\n}\n\n// ── Start ──────────────────────────────────────────────────────────────────\nfunction onProfile(p) { if (p && p.program) { program = Object.assign({}, program || {}, p.program); applyPublic(); } augment(p); giftBanner(); }\nfunction start() {\n  loadRating();\n  var me = document.getElementById('rw-me');\n  if (me && window.MutationObserver) {\n    new MutationObserver(function () { var RW = window.UEARW; if (RW && RW.profile) augment(RW.profile); }).observe(me, { childList: true });\n  }\n  var root = document.getElementById('rewards');\n  if (root && window.MutationObserver) {\n    var t = null;\n    new MutationObserver(function () { clearTimeout(t); t = setTimeout(applyPublic, 30); }).observe(root, { childList: true, subtree: true, characterData: true });\n  }\n  if (window.UEARW) window.UEARW.on(onProfile);\n  fetch(API + '/program').then(function (r) { return r.json(); }).then(function (p) { program = Object.assign({}, p, program || {}); applyPublic(); giftBanner(); }).catch(function () { giftBanner(); });\n}\nif (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();\n})();\n";

// ── Shop overview (owner + service writer) ──────────────────────────────────
// The writer sees workload numbers only. Money numbers are added for the owner.
router.get('/admin/overview', auth(DESK), h(async (req, res) => {
  const owner = req.staff.role === 'owner';
  const today = todayCentral();
  const d0 = new Date(`${today}T12:00:00Z`);
  const shift = n => { const x = new Date(d0); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const weekStart = shift(-((d0.getUTCDay() + 6) % 7));       // Monday
  const monthStart = today.slice(0, 8) + '01';
  const in7 = shift(7);
  const [open, paidRecent, stats, cfg] = await Promise.all([
    sb('uea_loyalty_bookings?status=eq.open&select=id,stage,sched_date,tech_id,estimate,created_at&limit=1000'),
    sb(`uea_loyalty_bookings?status=eq.paid&paid_at=gte.${shift(-40)}T00:00:00Z&select=id,paid_at,total_cents&limit=2000`),
    rpc('uea_loyalty_stats', {}).catch(() => ({})),
    getConfig()
  ]);
  const byStage = {}; STAGES.forEach(k => { byStage[k] = 0; });
  let unsched = 0, unassigned = 0, todayN = 0, next7 = 0, dueCents = 0, dueN = 0;
  open.forEach(j => {
    byStage[j.stage] = (byStage[j.stage] || 0) + 1;
    if (!j.sched_date) unsched++;
    else if (j.sched_date <= today) todayN++;
    else if (j.sched_date <= in7) next7++;
    if (!j.tech_id) unassigned++;
    if (j.stage === 'completed') {
      dueN++;
      const t = estTotals(j.estimate, cfg.parts_tax_rate);
      dueCents += (t.approved.total || t.quoted.total || 0);
    }
  });
  const cd = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const paid = paidRecent.filter(j => Number(j.total_cents) > 0).map(j => Object.assign(j, { day: cd(j.paid_at) }));
  const doneWeek = paid.filter(j => j.day >= weekStart).length;
  const doneMonth = paid.filter(j => j.day >= monthStart).length;
  const out = {
    today, week_start: weekStart, month_start: monthStart,
    work: { open: open.length, by_stage: byStage, unscheduled: unsched, unassigned, today: todayN, next_7: next7,
      done_not_paid: dueN, done_not_paid_cents: dueCents, paid_week: doneWeek, paid_month: doneMonth },
    rewards: { members: Number(stats.members) || 0, new_30d: Number(stats.new_30d) || 0, open_voucher_cents: Number(stats.open_voucher_cents) || 0,
      referrals_converted: Number(stats.referrals_converted) || 0 },
    stages: STAGES.map(k => ({ key: k, label: STAGE_LABEL[k] }))
  };
  if (owner) {
    const last30 = paid.filter(j => j.day > shift(-30));
    const rev30 = last30.reduce((s, j) => s + Number(j.total_cents), 0);
    out.money = { revenue_30d: rev30, jobs_30d: last30.length, avg_ticket_30d: last30.length ? Math.round(rev30 / last30.length) : 0,
      points_liability_cents: Math.round(Number(stats.outstanding_points || 0) * Number(cfg.cents_per_point || 0)) };
    try {
      const b = await computeBooks(monthStart, today, { light: true });
      out.money.month = b.setup_needed ? null : { income: b.totals.income, expenses: b.totals.expenses_all, net: b.totals.net, set_aside: b.totals.tax_set_aside };
    } catch (e) { out.money.month = null; }
  }
  res.json(out);
}));

// ── Books: owner-only bookkeeping ───────────────────────────────────────────
const BOOK_DEFAULTS = {
  tax_set_aside_pct: 25,
  mileage_rate_cents: 70,
  parts_cost_source: 'jobs',          // 'jobs' = part costs entered on estimates; 'expenses' = parts receipts you log
  categories: [
    { key: 'parts', name: 'Parts & materials', group: 'cogs' },
    { key: 'fuel', name: 'Gas & fuel', group: 'opex' },
    { key: 'vehicle', name: 'Work truck repairs & upkeep', group: 'opex' },
    { key: 'marketing', name: 'Marketing & advertising', group: 'opex' },
    { key: 'contractor', name: 'Contractor / tech pay', group: 'opex', is_1099: true },
    { key: 'payroll', name: 'Staff pay (service writer)', group: 'opex' },
    { key: 'tools', name: 'Tools & equipment', group: 'opex' },
    { key: 'supplies', name: 'Shop supplies', group: 'opex' },
    { key: 'insurance', name: 'Insurance', group: 'opex' },
    { key: 'software', name: 'Software & subscriptions', group: 'opex' },
    { key: 'phone', name: 'Phone & internet', group: 'opex' },
    { key: 'fees', name: 'Card & bank fees', group: 'opex' },
    { key: 'licenses', name: 'Licenses & permits', group: 'opex' },
    { key: 'training', name: 'Training & certifications', group: 'opex' },
    { key: 'meals', name: 'Meals', group: 'opex' },
    { key: 'office', name: 'Office & admin', group: 'opex' },
    { key: 'other', name: 'Other expense', group: 'opex' },
    { key: 'draw', name: 'Owner pay (draw)', group: 'transfer' }
  ],
  income_categories: [
    { key: 'job_other', name: 'Job paid outside the desk', group: 'income' },
    { key: 'fleet', name: 'FleetCare / fleet billing', group: 'income' },
    { key: 'online', name: 'Online store orders', group: 'income' },
    { key: 'refund', name: 'Refunds & rebates', group: 'income' },
    { key: 'other_in', name: 'Other income', group: 'income' },
    { key: 'contribution', name: 'Owner money put in', group: 'transfer' }
  ],
  methods: ['Business card', 'Business debit', 'Cash', 'Zelle', 'Check', 'Personal card', 'Other']
};
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const bookDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const dayShift = (iso, n) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monthShift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1 + n, 1)); return x.toISOString().slice(0, 7); };
const lastDayOf = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const bookMissing = e => /uea_book_/.test(e.message || '') && /(find the table|does not exist|schema cache|relation)/i.test(e.message || '');
const hb = fn => h(async (req, res) => {
  try { await fn(req, res); }
  catch (e) { if (bookMissing(e)) return res.json({ setup_needed: true }); throw e; }
});

let bookCfgCache = null, bookCfgAt = 0;
async function bookSettings(force) {
  if (!force && bookCfgCache && Date.now() - bookCfgAt < 60000) return bookCfgCache;
  const rows = await sb('uea_book_settings?id=eq.1&select=config');
  const c = Object.assign({}, BOOK_DEFAULTS, (rows[0] && rows[0].config) || {});
  ['categories', 'income_categories', 'methods'].forEach(k => { if (!Array.isArray(c[k]) || !c[k].length) c[k] = BOOK_DEFAULTS[k]; });
  bookCfgCache = c; bookCfgAt = Date.now();
  return c;
}
function catOf(cfg, kind, key) {
  const list = kind === 'income' ? cfg.income_categories : cfg.categories;
  const dflt = kind === 'income' ? BOOK_DEFAULTS.income_categories : BOOK_DEFAULTS.categories;
  return list.find(c => c.key === key) || dflt.find(c => c.key === key) || { key, name: key, group: kind === 'income' ? 'income' : 'opex' };
}
function jobPartsCost(est) {
  const lines = (est && est.lines) || [];
  let cost = 0, partLines = 0, missing = 0;
  lines.forEach(l => {
    if (l.type !== 'part' || l.status === 'declined') return;
    partLines++;
    if (l.cost_cents == null || l.cost_cents === '') { missing++; return; }
    cost += Math.round((Number(l.qty) || 0) * (Number(l.cost_cents) || 0));
  });
  return { cost, partLines, missing };
}

// Posts any monthly bills that have come due since they were last posted.
let recurRunAt = 0;
async function postRecurring(force) {
  if (!force && Date.now() - recurRunAt < 10 * 60 * 1000) return;
  recurRunAt = Date.now();
  const today = todayCentral();
  const recs = await sb('uea_book_recurring?active=eq.true&select=*&limit=200');
  for (const r of recs) {
    const rows = [];
    let ym = String(r.last_posted || r.start_date).slice(0, 7);
    if (r.last_posted) ym = monthShift(ym, 1);
    for (let i = 0; i < 36 && ym <= today.slice(0, 7); i++, ym = monthShift(ym, 1)) {
      const day = `${ym}-${String(Math.min(r.day_of_month, lastDayOf(ym))).padStart(2, '0')}`;
      if (day < r.start_date || day > today) continue;
      if (r.end_date && day > r.end_date) break;
      rows.push({ kind: r.kind, entry_date: day, category: r.category, vendor: r.vendor, description: r.description,
        amount_cents: r.amount_cents, method: r.method, recurring_id: r.id, created_by: 'Repeats monthly' });
    }
    if (!rows.length) continue;
    await sb('uea_book_entries?on_conflict=recurring_id,entry_date', { method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal', body: rows });
    await sb(`uea_book_recurring?id=eq.${r.id}`, { method: 'PATCH', body: { last_posted: rows[rows.length - 1].entry_date } });
  }
}

// { [booking_id]: { parts, other } } — expense cents attached to each job (owner pay excluded).
async function jobExpenseTotals(cfg, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) break;
    const rows = await sb(`uea_book_entries?booking_id=in.(${chunk.map(enc).join(',')})&kind=eq.expense&select=booking_id,category,amount_cents&limit=5000`);
    rows.forEach(e => {
      const g = catOf(cfg, 'expense', e.category).group;
      if (g === 'transfer') return;
      const o = out[e.booking_id] || (out[e.booking_id] = { parts: 0, other: 0 });
      o[g === 'cogs' ? 'parts' : 'other'] += Number(e.amount_cents) || 0;
    });
  }
  return out;
}

// Everything the owner needs for the job screen's "Job costs" tab.
async function jobCosts(b, shopCfg) {
  const cfg = await bookSettings();
  const entries = await sb(`uea_book_entries?booking_id=eq.${enc(b.id)}&select=*&order=entry_date.desc,created_at.desc&limit=500`);
  const est = jobPartsCost(b.estimate);
  const useJobCost = cfg.parts_cost_source !== 'expenses';
  let receiptParts = 0, other = 0, extraIncome = 0;
  entries.forEach(e => {
    const g = catOf(cfg, e.kind, e.category).group, amt = Number(e.amount_cents) || 0;
    if (g === 'transfer') return;
    if (e.kind === 'income') extraIncome += amt;
    else if (g === 'cogs') receiptParts += amt;
    else other += amt;
  });
  const paid = b.status === 'paid';
  const t = estTotals(b.estimate, shopCfg.parts_tax_rate);
  const jobIncome = paid ? Number(b.total_cents) || 0 : (t.approved.total || t.quoted.total || 0);
  const partsEst = useJobCost && !receiptParts ? est.cost : 0;
  const income = jobIncome + extraIncome, costs = partsEst + receiptParts + other;
  return {
    settings: cfg, entries,
    paid, income_cents: income, job_income_cents: jobIncome, extra_income_cents: extraIncome,
    parts_from: receiptParts ? 'receipts' : useJobCost ? 'estimate' : 'receipts',
    parts_est_cents: partsEst, parts_missing: useJobCost && !receiptParts ? est.missing : 0,
    parts_receipts_cents: receiptParts, other_cents: other, costs_cents: costs, profit_cents: income - costs
  };
}

async function paidJobsBetween(from, to, cols) {
  const rows = await sb(`uea_loyalty_bookings?status=eq.paid&and=(paid_at.gte.${dayShift(from, -1)}T00:00:00Z,paid_at.lte.${dayShift(to, 2)}T00:00:00Z)` +
    `&select=${cols}&order=paid_at.desc&limit=5000`);
  return rows.map(j => Object.assign(j, { day: bookDay(j.paid_at) }))
    .filter(j => j.day >= from && j.day <= to && Number(j.total_cents) > 0);
}

async function computeBooks(from, to, { light } = {}) {
  let cfg;
  try { cfg = await bookSettings(); await postRecurring(); }
  catch (e) { if (bookMissing(e)) return { setup_needed: true }; throw e; }
  const today = todayCentral();
  const trendStart = monthShift(today.slice(0, 7), -11) + '-01';
  const yearStart = today.slice(0, 4) + '-01-01';
  const lo = light ? from : [from, trendStart, yearStart].sort()[0];
  const hi = light ? to : [to, today].sort()[1];
  const [jobs, entries, miles] = await Promise.all([
    paidJobsBetween(lo, hi, 'id,order_name,customer_name,service,vehicle,paid_at,labor_cents,parts_cents,total_cents,payment_method,estimate'),
    sb(`uea_book_entries?and=(entry_date.gte.${lo},entry_date.lte.${hi})&select=*&order=entry_date.desc,created_at.desc&limit=10000`),
    sb(`uea_book_mileage?and=(trip_date.gte.${lo},trip_date.lte.${hi})&select=*&order=trip_date.desc,created_at.desc&limit=5000`)
  ]);
  const useJobCost = cfg.parts_cost_source !== 'expenses';
  jobs.forEach(j => { const c = jobPartsCost(j.estimate); j.parts_cost_cents = c.cost; j.cost_missing = (c.missing > 0 || (!c.partLines && Number(j.parts_cents) > 0)); delete j.estimate; });
  // Expenses attached to each job. Parts receipts on a job replace that job's estimate part cost,
  // so a part is never counted twice.
  const byJob = await jobExpenseTotals(cfg, jobs.map(j => j.id));
  jobs.forEach(j => {
    const a = byJob[j.id] || { parts: 0, other: 0 };
    j.receipt_parts_cents = a.parts; j.job_expense_cents = a.other;
    if (a.parts) { j.parts_cost_cents = 0; j.cost_missing = false; }
    j.job_profit_cents = Number(j.total_cents) - (useJobCost ? j.parts_cost_cents : 0) - a.parts - a.other;
  });
  const inRange = (d, a, b) => d >= a && d <= b;

  // Totals for any date window
  const sum = (a, b) => {
    const J = jobs.filter(j => inRange(j.day, a, b)), E = entries.filter(e => inRange(e.entry_date, a, b));
    const t = { job_labor: 0, job_parts: 0, job_income: 0, jobs: J.length, job_parts_cost: 0, cost_missing: 0,
      other_income: 0, cogs_expenses: 0, opex: 0, draws: 0, contributions: 0, by_cat: {}, by_income_cat: {} };
    J.forEach(j => { t.job_labor += Number(j.labor_cents) || 0; t.job_parts += Number(j.parts_cents) || 0; t.job_income += Number(j.total_cents) || 0;
      t.job_parts_cost += j.parts_cost_cents; if (j.cost_missing) t.cost_missing++; });
    E.forEach(e => {
      const c = catOf(cfg, e.kind, e.category), amt = Number(e.amount_cents) || 0;
      if (e.kind === 'income') {
        if (c.group === 'transfer') t.contributions += amt;
        else { t.other_income += amt; t.by_income_cat[c.key] = (t.by_income_cat[c.key] || 0) + amt; }
      } else {
        if (c.group === 'transfer') t.draws += amt;
        else if (c.group === 'cogs') t.cogs_expenses += amt;
        else t.opex += amt;
        if (c.group !== 'transfer') t.by_cat[c.key] = (t.by_cat[c.key] || 0) + amt;
      }
    });
    t.income = t.job_income + t.other_income;
    t.cogs = (useJobCost ? t.job_parts_cost : 0) + t.cogs_expenses;
    t.gross = t.income - t.cogs;
    t.net = t.gross - t.opex;
    t.expenses_all = t.cogs + t.opex;
    t.tax_set_aside = Math.max(0, Math.round(t.net * (Number(cfg.tax_set_aside_pct) || 0) / 100));
    t.money_in = t.income + t.contributions;
    t.money_out = t.cogs_expenses + t.opex + t.draws + (useJobCost ? t.job_parts_cost : 0);
    return t;
  };

  const totals = sum(from, to);
  const M = miles.filter(m => inRange(m.trip_date, from, to));
  const milesTotal = M.reduce((s, m) => s + Number(m.miles || 0), 0);
  const out = {
    from, to, today, settings: cfg, totals,
    mileage: { miles: Math.round(milesTotal * 10) / 10, deduction_cents: Math.round(milesTotal * Number(cfg.mileage_rate_cents || 0)) }
  };
  if (light) return out;

  out.jobs = jobs.filter(j => inRange(j.day, from, to));
  out.entries = entries.filter(e => inRange(e.entry_date, from, to));
  out.trips = M;
  out.trend = [];
  for (let i = 11; i >= 0; i--) {
    const ym = monthShift(today.slice(0, 7), -i), t = sum(`${ym}-01`, `${ym}-${lastDayOf(ym)}`);
    out.trend.push({ month: ym, income: t.income, expenses: t.expenses_all, net: t.net });
  }
  const ytd = entries.filter(e => e.kind === 'expense' && inRange(e.entry_date, yearStart, today) && catOf(cfg, 'expense', e.category).is_1099);
  const payees = {};
  ytd.forEach(e => { const k = (e.vendor || 'No name').trim(); payees[k] = (payees[k] || 0) + Number(e.amount_cents); });
  out.contractors_ytd = Object.keys(payees).map(k => ({ payee: k, cents: payees[k] })).sort((a, b) => b.cents - a.cents);
  out.year = today.slice(0, 4);
  return out;
}

function periodFrom(q) {
  const today = todayCentral();
  let from = String(q.from || ''), to = String(q.to || '');
  if (!ISO_DAY.test(from)) from = today.slice(0, 8) + '01';
  if (!ISO_DAY.test(to)) to = today;
  if (to < from) [from, to] = [to, from];
  if (from < dayShift(to, -800)) throw httpErr(400, 'Pick a range of two years or less.');
  return { from, to };
}

router.get('/admin/books', auth(OWNER), hb(async (req, res) => {
  const { from, to } = periodFrom(req.query);
  res.json(await computeBooks(from, to));
}));

router.get('/admin/books/settings', auth(OWNER), hb(async (req, res) => {
  res.json({ settings: await bookSettings(true), defaults: BOOK_DEFAULTS });
}));

router.put('/admin/books/settings', auth(OWNER), hb(async (req, res) => {
  const b = req.body || {}, cur = await bookSettings(true);
  const num = (v, min, max) => { const x = Number(v); if (!isFinite(x) || x < min || x > max) throw httpErr(400, 'Check the number fields.'); return x; };
  const cleanCats = (list, groups) => {
    if (!Array.isArray(list) || !list.length) throw httpErr(400, 'Keep at least one category.');
    const seen = new Set();
    return list.slice(0, 60).map(c => {
      const name = String(c.name || '').trim().slice(0, 60);
      if (!name) throw httpErr(400, 'Every category needs a name.');
      let key = String(c.key || '').trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'cat';
      while (seen.has(key)) key += '_2';
      seen.add(key);
      return { key, name, group: groups.includes(c.group) ? c.group : groups[0], is_1099: !!c.is_1099 };
    });
  };
  const next = Object.assign({}, cur, {
    tax_set_aside_pct: b.tax_set_aside_pct == null ? cur.tax_set_aside_pct : num(b.tax_set_aside_pct, 0, 60),
    mileage_rate_cents: b.mileage_rate_cents == null ? cur.mileage_rate_cents : Math.round(num(b.mileage_rate_cents, 0, 300)),
    parts_cost_source: b.parts_cost_source === 'expenses' ? 'expenses' : b.parts_cost_source === 'jobs' ? 'jobs' : cur.parts_cost_source,
    categories: b.categories ? cleanCats(b.categories, ['opex', 'cogs', 'transfer']) : cur.categories,
    income_categories: b.income_categories ? cleanCats(b.income_categories, ['income', 'transfer']) : cur.income_categories,
    methods: Array.isArray(b.methods) ? b.methods.map(m => String(m).trim().slice(0, 40)).filter(Boolean).slice(0, 20) : cur.methods
  });
  if (!next.methods.length) next.methods = BOOK_DEFAULTS.methods;
  await sb('uea_book_settings?id=eq.1', { method: 'PATCH', body: { config: next, updated_at: new Date().toISOString() } });
  bookCfgCache = null;
  res.json({ settings: await bookSettings(true) });
}));

function entryBody(b, cfg, partial) {
  const o = {};
  if (!partial || 'kind' in b) { if (!['expense', 'income'].includes(b.kind)) throw httpErr(400, 'Pick money in or money out.'); o.kind = b.kind; }
  if (!partial || 'entry_date' in b) { if (!ISO_DAY.test(String(b.entry_date || ''))) throw httpErr(400, 'Pick a date.'); o.entry_date = b.entry_date; }
  if (!partial || 'amount' in b) {
    const c = Math.round(parseFloat(String(b.amount || '').replace(/[$,]/g, '')) * 100);
    if (!(c > 0)) throw httpErr(400, 'Enter an amount.'); if (c > 1e10) throw httpErr(400, 'That amount looks too large.');
    o.amount_cents = c;
  }
  if (!partial || 'category' in b) { if (!b.category) throw httpErr(400, 'Pick a category.'); o.category = String(b.category).slice(0, 40); }
  ['vendor', 'description', 'method', 'job_ref'].forEach(k => { if (!partial || k in b) o[k] = b[k] ? String(b[k]).trim().slice(0, k === 'description' ? 500 : 120) || null : null; });
  if (!partial || 'booking_id' in b) {
    const id = b.booking_id ? String(b.booking_id).trim() : '';
    if (id && !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw httpErr(400, 'That job link isn\'t valid.');
    o.booking_id = id || null;
  }
  return o;
}
// Checks the job exists and labels the entry with its order # / customer.
async function linkJob(o) {
  if (!('booking_id' in o)) return;
  if (!o.booking_id) { if (!('job_ref' in o) || !o.job_ref) o.job_ref = null; return; }
  const j = (await sb(`uea_loyalty_bookings?id=eq.${enc(o.booking_id)}&select=id,order_name,customer_name,service`))[0];
  if (!j) throw httpErr(400, 'That job wasn\'t found.');
  o.job_ref = [j.order_name || 'Phone job', j.customer_name].filter(Boolean).join(' · ').slice(0, 120);
}
function receiptData(v) {
  const d = String(v || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) throw httpErr(400, 'That receipt isn\'t a photo.');
  if (d.length > 2_500_000) throw httpErr(400, 'That photo is too large.');
  return d;
}

// Recent jobs for the "Which job?" picker on an expense.
router.get('/admin/books/jobs', auth(OWNER), h(async (req, res) => {
  res.json({ jobs: await sb('uea_loyalty_bookings?status=neq.cancelled&select=id,order_name,customer_name,service,vehicle,status,sched_date,paid_at,created_at&order=created_at.desc&limit=150') });
}));

router.post('/admin/books/entries', auth(OWNER), hb(async (req, res) => {
  const b = req.body || {}, cfg = await bookSettings();
  const row = Object.assign(entryBody(b, cfg, false), { created_by: req.staff.name });
  await linkJob(row);
  const receipt = b.receipt ? receiptData(b.receipt) : null;
  if (b.repeat_monthly && !row.booking_id) {
    const rec = (await sb('uea_book_recurring', { method: 'POST', prefer: 'return=representation', body: {
      kind: row.kind, category: row.category, vendor: row.vendor, description: row.description, amount_cents: row.amount_cents, method: row.method,
      day_of_month: Number(row.entry_date.slice(8, 10)), start_date: row.entry_date, last_posted: row.entry_date, created_by: req.staff.name } }))[0];
    row.recurring_id = rec.id;
  }
  const e = (await sb('uea_book_entries', { method: 'POST', prefer: 'return=representation', body: Object.assign(row, { has_receipt: !!receipt }) }))[0];
  if (receipt) await sb('uea_book_receipts', { method: 'POST', body: { entry_id: e.id, data: receipt } });
  if (b.repeat_monthly && !row.booking_id) await postRecurring(true);
  res.json({ entry: e });
}));

router.patch('/admin/books/entries/:id', auth(OWNER), hb(async (req, res) => {
  const id = enc(req.params.id), b = req.body || {}, cfg = await bookSettings();
  const patch = entryBody(b, cfg, true);
  await linkJob(patch);
  if (b.receipt) {
    const d = receiptData(b.receipt);
    await sb('uea_book_receipts?on_conflict=entry_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { entry_id: req.params.id, data: d } });
    patch.has_receipt = true;
  } else if (b.remove_receipt) {
    await sb(`uea_book_receipts?entry_id=eq.${id}`, { method: 'DELETE' });
    patch.has_receipt = false;
  }
  patch.updated_at = new Date().toISOString();
  const e = (await sb(`uea_book_entries?id=eq.${id}`, { method: 'PATCH', prefer: 'return=representation', body: patch }))[0];
  if (!e) throw httpErr(404, 'Entry not found.');
  res.json({ entry: e });
}));

router.delete('/admin/books/entries/:id', auth(OWNER), hb(async (req, res) => {
  await sb(`uea_book_entries?id=eq.${enc(req.params.id)}`, { method: 'DELETE' });
  res.json({ ok: true });
}));

router.get('/admin/books/receipt/:id', auth(OWNER), hb(async (req, res) => {
  const r = (await sb(`uea_book_receipts?entry_id=eq.${enc(req.params.id)}&select=data`))[0];
  if (!r) throw httpErr(404, 'No receipt saved.');
  res.json({ data: r.data });
}));

router.get('/admin/books/recurring', auth(OWNER), hb(async (req, res) => {
  res.json({ recurring: await sb('uea_book_recurring?select=*&order=active.desc,created_at.desc&limit=200'), settings: await bookSettings() });
}));

router.patch('/admin/books/recurring/:id', auth(OWNER), hb(async (req, res) => {
  const b = req.body || {}, p = {};
  if ('active' in b) p.active = !!b.active;
  if ('amount' in b) { const c = Math.round(parseFloat(String(b.amount).replace(/[$,]/g, '')) * 100); if (!(c > 0)) throw httpErr(400, 'Enter an amount.'); p.amount_cents = c; }
  if ('day_of_month' in b) { const d = parseInt(b.day_of_month, 10); if (!(d >= 1 && d <= 31)) throw httpErr(400, 'Day must be 1–31.'); p.day_of_month = d; }
  if (p.active) p.last_posted = todayCentral();   // resuming doesn't back-fill the paused months
  const r = (await sb(`uea_book_recurring?id=eq.${enc(req.params.id)}`, { method: 'PATCH', prefer: 'return=representation', body: p }))[0];
  if (!r) throw httpErr(404, 'Not found.');
  res.json({ recurring: r });
}));

router.delete('/admin/books/recurring/:id', auth(OWNER), hb(async (req, res) => {
  // Stops future posts. Entries already posted stay in the books.
  await sb(`uea_book_recurring?id=eq.${enc(req.params.id)}`, { method: 'DELETE' });
  res.json({ ok: true });
}));

router.post('/admin/books/mileage', auth(OWNER), hb(async (req, res) => {
  const b = req.body || {};
  if (!ISO_DAY.test(String(b.trip_date || ''))) throw httpErr(400, 'Pick a date.');
  let miles = parseFloat(b.miles);
  if (!(miles > 0) && b.odo_start != null && b.odo_end != null) miles = parseFloat(b.odo_end) - parseFloat(b.odo_start);
  if (!(miles > 0) || miles > 5000) throw httpErr(400, 'Enter the miles driven (or start and end odometer).');
  const t = (await sb('uea_book_mileage', { method: 'POST', prefer: 'return=representation', body: {
    trip_date: b.trip_date, miles: Math.round(miles * 10) / 10, purpose: b.purpose ? String(b.purpose).trim().slice(0, 200) : null, created_by: req.staff.name } }))[0];
  res.json({ trip: t });
}));

router.delete('/admin/books/mileage/:id', auth(OWNER), hb(async (req, res) => {
  await sb(`uea_book_mileage?id=eq.${enc(req.params.id)}`, { method: 'DELETE' });
  res.json({ ok: true });
}));

// CSV for the accountant: every job payment, expense, income entry and trip in the range.
router.get('/admin/books/export', auth(OWNER), hb(async (req, res) => {
  const { from, to } = periodFrom(req.query);
  const b = await computeBooks(from, to);
  if (b.setup_needed) return res.json(b);
  const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const d = c => (Number(c || 0) / 100).toFixed(2);
  const rows = [['Date', 'Type', 'Category', 'Payee / customer', 'Description', 'Money in', 'Money out', 'Paid with', 'Reference', 'Receipt']];
  b.jobs.forEach(j => {
    rows.push([j.day, 'Job payment', 'Job labor & fees', j.customer_name, [j.order_name, j.service, j.vehicle].filter(Boolean).join(' · '), d(j.labor_cents), '', j.payment_method, j.order_name, '']);
    if (Number(j.parts_cents)) rows.push([j.day, 'Job payment', 'Job parts', j.customer_name, [j.order_name, j.service].filter(Boolean).join(' · '), d(j.parts_cents), '', j.payment_method, j.order_name, '']);
    if (b.settings.parts_cost_source !== 'expenses' && j.parts_cost_cents) rows.push([j.day, 'Parts cost (from estimate)', 'Parts & materials', '', j.order_name || '', '', d(j.parts_cost_cents), '', j.order_name, '']);
  });
  b.entries.forEach(e => {
    const c = catOf(b.settings, e.kind, e.category);
    rows.push([e.entry_date, c.group === 'transfer' ? 'Owner transfer' : e.kind === 'income' ? 'Income' : 'Expense', c.name, e.vendor, e.description,
      e.kind === 'income' ? d(e.amount_cents) : '', e.kind === 'expense' ? d(e.amount_cents) : '', e.method, e.job_ref, e.has_receipt ? 'Yes' : '']);
  });
  b.trips.forEach(t => rows.push([t.trip_date, 'Mileage', 'Business miles', '', `${t.miles} mi${t.purpose ? ' · ' + t.purpose : ''}`, '', '', '', '', '']));
  rows.splice(1, rows.length - 1, ...rows.slice(1).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
  res.json({ filename: `UEA-books-${from}-to-${to}.csv`, csv: rows.map(r => r.map(q).join(',')).join('\r\n') });
}));


router.__test = { maybeBirthdays };   // lets the test harness run the birthday check on demand
module.exports = router;
