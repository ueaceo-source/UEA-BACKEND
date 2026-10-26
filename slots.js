// ============================================================================
// Upper Echelon Automotive — Live booking availability
// File name in your backend repo:  slots.js   (next to loyalty.js)
// server.js mounts it at /slots.
//
// What it does:
//   GET  /slots/windows        → the 2-hour arrival windows and how full each one is
//   GET  /slots/taken          → older hourly view, kept so an older website copy keeps working
//   POST /slots/hold           → reserves a window (or a run of windows for long jobs)
//   POST /slots/cancel         → the website frees its own hold if checkout fails
//   GET  /slots/admin          → owner page: see reserved times and release no-shows
//
// Env vars (Render → your service → Environment):
//   SUPABASE_URL               already set
//   SUPABASE_SERVICE_KEY       already set (SUPABASE_SERVICE_ROLE_KEY also works)
//   LOYALTY_ADMIN_PASSWORD     owner password, same one the service desk uses
//   SLOT_CAPACITY              optional fallback for jobs per window (desk Settings wins)
//
// Arrival windows and "Jobs per time window" come from the service desk:
// Settings → Shop. Change them there and the website follows within a minute.
// ============================================================================
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// ── Schedule rules (keep in sync with theme.liquid) ─────────────────────────
const TIME_SLOTS = ['7:00 AM', '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM',
  '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM', '10:00 PM'];
const WEEKDAY_START = '9:00 AM';   // Monday–Friday bookings start here
const DAYS_AHEAD = 60;             // how far out customers can book
const LEAD_MINUTES = 120;          // online bookings need this much notice unless rush is paid
const TZ = 'America/Chicago';
const CAPACITY = Math.max(1, parseInt(process.env.SLOT_CAPACITY, 10) || 1);

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const ADMIN_PASSWORD = process.env.LOYALTY_ADMIN_PASSWORD || '';
const supabase = SB_URL && SB_KEY ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;

// ── Arrival windows (from desk Settings) ────────────────────────────────────
const OLD_DEFAULT_WINDOWS = ['8–10 AM', '10 AM–12 PM', '12–2 PM', '2–4 PM', '4–6 PM'];
const DEFAULT_WINDOWS = ['8–10 AM', '10 AM–12 PM', '12–2 PM', '2–4 PM', '4–6 PM', '6–8 PM', '8–10 PM'];
const WEEKDAY_START_MIN = 9 * 60;   // Monday–Friday, windows that start before 9 AM aren't offered online
const MAX_SPAN = 3;                 // a long job can hold up to 3 windows in a row

// "8–10 AM", "10 AM–12 PM", "12:30–2:30 PM" → { label, start, end } in minutes after midnight.
function parseWindow(label) {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*[–—-]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*$/i.exec(String(label || ''));
  if (!m) return null;
  const to24 = (h, mer) => (Number(h) % 12) + (/pm/i.test(mer) ? 12 : 0);
  const end = to24(m[4], m[6]) * 60 + Number(m[5] || 0);
  let start = to24(m[1], m[3] || m[6]) * 60 + Number(m[2] || 0);
  if (!m[3] && start >= end) start = to24(m[1], 'AM') * 60 + Number(m[2] || 0);
  if (start >= end) return null;
  return { label: String(label).trim(), start, end };
}
let winCache = { at: 0, data: null };
async function windowSettings() {
  if (winCache.data && Date.now() - winCache.at < 60000) return winCache.data;
  let cfg = {};
  if (supabase) {
    const { data } = await supabase.from('uea_loyalty_settings').select('config').eq('id', 1).maybeSingle();
    cfg = (data && data.config) || {};
  }
  let labels = Array.isArray(cfg.time_windows) && cfg.time_windows.length ? cfg.time_windows : DEFAULT_WINDOWS;
  if (JSON.stringify(labels) === JSON.stringify(OLD_DEFAULT_WINDOWS)) labels = DEFAULT_WINDOWS;
  let windows = labels.map(parseWindow).filter(Boolean).sort((a, b) => a.start - b.start);
  if (!windows.length) windows = DEFAULT_WINDOWS.map(parseWindow);
  const capacity = Math.max(1, Math.round(Number(cfg.jobs_per_window) || 0) || CAPACITY);
  winCache = { at: Date.now(), data: { windows, capacity } };
  return winCache.data;
}
function windowsForDate(iso, windows) {
  const dow = weekday(iso);
  return dow >= 1 && dow <= 5 ? windows.filter(w => w.start >= WEEKDAY_START_MIN) : windows.slice();
}
// Which window a stored time belongs to (older bookings were saved as "9:00 AM").
function windowOf(slotTime, windows) {
  const w = windows.find(x => x.label === slotTime);
  if (w) return w.label;
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(slotTime || '');
  if (!m) return null;
  const min = slotMinutes(slotTime);
  const hit = windows.find(x => min >= x.start && min < x.end);
  return hit ? hit.label : null;
}
async function windowUsage(windows, fromDate, toDate) {
  const { data, error } = await supabase.from('uea_booked_slots').select('slot_date, slot_time')
    .eq('status', 'held').gte('slot_date', fromDate).lte('slot_date', toDate).limit(5000);
  if (error) throw error;
  const usage = {};
  data.forEach(r => {
    const lab = windowOf(r.slot_time, windows);
    if (!lab) return;
    const d = usage[r.slot_date] || (usage[r.slot_date] = {});
    d[lab] = (d[lab] || 0) + 1;
  });
  return usage;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function nowInTZ() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function slotMinutes(t) {
  const m = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(t);
  if (!m) { const w = parseWindow(t); return w ? w.start : 0; }
  let h = Number(m[1]) % 12;
  if (m[3] === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}
function slotsForDate(iso) {
  const dow = weekday(iso);
  return dow >= 1 && dow <= 5 ? TIME_SLOTS.slice(TIME_SLOTS.indexOf(WEEKDAY_START)) : TIME_SLOTS.slice();
}
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  if (!err.status) console.error('[slots]', err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please call (251) 289-0740.' });
});
function requireDb() {
  if (!supabase) throw httpErr(503, 'Booking availability is not set up yet (missing Supabase settings on the server).');
}
function checkSlot(date, time, rush) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpErr(400, 'Pick a date.');
  if (!TIME_SLOTS.includes(time)) throw httpErr(400, 'Pick a time.');
  const now = nowInTZ();
  if (date < now.date || date > addDays(now.date, DAYS_AHEAD)) throw httpErr(400, 'That date can’t be booked online. Pick another date.');
  if (!slotsForDate(date).includes(time)) throw httpErr(400, 'That time isn’t available on that day. Pick another time.');
  if (date === now.date && slotMinutes(time) <= now.minutes) throw httpErr(400, 'That time has already passed. Pick a later time.');
  if (!rush && date === now.date && slotMinutes(time) < now.minutes + LEAD_MINUTES) {
    throw httpErr(400, 'Online bookings need at least 2 hours\u2019 notice. Pick a later time, or choose Rush dispatch.');
  }
}

// Small per-visitor limit so nobody can fill the calendar with fake holds.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 8;
}

function adminOk(req) {
  const pw = req.get('x-admin-password') || '';
  if (!ADMIN_PASSWORD || !pw) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(pw)), Buffer.from(sha256(ADMIN_PASSWORD)));
}
function requireAdmin(req) {
  if (!ADMIN_PASSWORD) throw httpErr(500, 'Set LOYALTY_ADMIN_PASSWORD on Render first.');
  if (!adminOk(req)) throw httpErr(401, 'Wrong password.');
}

// Full slots barely change, so cache them briefly to keep the page fast.
let cache = { at: 0, data: null };

// ── Public routes ───────────────────────────────────────────────────────────
router.get('/health', h(async (req, res) => {
  const out = { route: 'ok', supabase: !!supabase, admin_password: !!ADMIN_PASSWORD, capacity: CAPACITY, table: 'unknown' };
  if (supabase) {
    const { error } = await supabase.from('uea_booked_slots').select('id').limit(1);
    out.table = error ? `error: ${error.message}` : 'ok';
  }
  res.json(out);
}));

router.get('/windows', h(async (req, res) => {
  requireDb();
  res.set('Cache-Control', 'no-store');
  const { windows, capacity } = await windowSettings();
  const today = nowInTZ().date;
  const usage = await windowUsage(windows, today, addDays(today, DAYS_AHEAD));
  res.json({ windows, capacity, usage, weekday_start: WEEKDAY_START_MIN, lead_minutes: LEAD_MINUTES, days_ahead: DAYS_AHEAD, max_span: MAX_SPAN });
}));

router.get('/taken', h(async (req, res) => {
  requireDb();
  res.set('Cache-Control', 'no-store');
  if (cache.data && Date.now() - cache.at < 15000) return res.json(cache.data);
  const today = nowInTZ().date;
  const { data, error } = await supabase
    .from('uea_booked_slots')
    .select('slot_date, slot_time')
    .eq('status', 'held')
    .gte('slot_date', today)
    .lte('slot_date', addDays(today, DAYS_AHEAD))
    .limit(5000);
  if (error) throw error;
  const counts = {};
  data.forEach(r => { const k = `${r.slot_date}|${r.slot_time}`; counts[k] = (counts[k] || 0) + 1; });
  const full = {};
  Object.keys(counts).forEach(k => {
    if (counts[k] < CAPACITY) return;
    const [d, t] = k.split('|');
    (full[d] = full[d] || []).push(t);
  });
  cache = { at: Date.now(), data: { capacity: CAPACITY, full } };
  res.json(cache.data);
}));

router.post('/hold', h(async (req, res) => {
  requireDb();
  const b = req.body || {};
  if (b.website) return res.status(400).json({ error: 'Request blocked.' });   // spam trap
  // Render sits behind a proxy, so the visitor's address is the first x-forwarded-for entry.
  const ip = String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
  if (rateLimited(ip)) throw httpErr(429, 'Too many booking attempts. Please call (251) 289-0740.');
  const date = clean(b.date, 10), time = clean(b.time, 20);
  const name = clean(b.name, 80), phone = clean(b.phone, 30);
  if (!name || !phone) throw httpErr(400, 'Name and phone are required.');
  if (!TIME_SLOTS.includes(time)) return holdWindows(req, res, b, date, time, name, phone);   // arrival windows
  checkSlot(date, time, !!b.rush);

  const token = crypto.randomBytes(24).toString('hex');
  const { data: id, error } = await supabase.rpc('uea_hold_slot', {
    p_date: date, p_time: time, p_capacity: CAPACITY,
    p_name: name, p_phone: phone, p_service: clean(b.service, 120), p_vehicle: clean(b.vehicle, 120),
    p_rush: !!b.rush, p_token_hash: sha256(token)
  });
  if (error) throw error;
  cache.at = 0;
  if (!id) throw httpErr(409, 'Someone just booked that time. Please pick another.');
  res.json({ ok: true, id, token });
}));

// Reserve a window, plus the windows right after it when the job runs long.
async function holdWindows(req, res, b, date, label, name, phone) {
  const { windows, capacity } = await windowSettings();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpErr(400, 'Pick a date.');
  const now = nowInTZ();
  if (date < now.date || date > addDays(now.date, DAYS_AHEAD)) throw httpErr(400, 'That date can’t be booked online. Pick another date.');
  const day = windowsForDate(date, windows);
  const idx = day.findIndex(w => w.label === label);
  if (idx < 0) throw httpErr(400, 'Pick an arrival window.');
  const first = day[idx];
  if (date === now.date) {
    if (b.rush ? first.end <= now.minutes + 30 : first.start < now.minutes + LEAD_MINUTES) {
      throw httpErr(400, b.rush ? 'That window has already passed. Pick a later one.' : 'Online bookings need at least 2 hours’ notice. Pick a later window, or choose Rush dispatch.');
    }
  }
  const span = Math.min(MAX_SPAN, Math.max(1, parseInt(b.span, 10) || 1));
  const run = [first];
  for (let k = 1; k < span && day[idx + k] && day[idx + k].start === run[run.length - 1].end; k++) run.push(day[idx + k]);
  const usage = (await windowUsage(windows, date, date))[date] || {};
  if (run.some(w => (usage[w.label] || 0) >= capacity)) throw httpErr(409, 'Someone just booked that window. Please pick another.');

  const token = crypto.randomBytes(24).toString('hex'), got = [];
  for (const w of run) {
    const { data: id, error } = await supabase.rpc('uea_hold_slot', {
      p_date: date, p_time: w.label, p_capacity: capacity,
      p_name: name, p_phone: phone, p_service: clean(b.service, 120) + (run.length > 1 ? ` (${run.length} windows)` : ''), p_vehicle: clean(b.vehicle, 120),
      p_rush: !!b.rush, p_token_hash: sha256(token)
    });
    if (error || !id) {
      if (got.length) await supabase.from('uea_booked_slots').update({ status: 'released', released_at: new Date().toISOString() }).in('id', got);
      cache.at = 0;
      if (error) throw error;
      throw httpErr(409, 'Someone just booked that window. Please pick another.');
    }
    got.push(id);
  }
  cache.at = 0;
  res.json({ ok: true, id: got[0], token, windows: run.map(w => w.label) });
}

// The website calls this with the token it got from /hold, e.g. when checkout fails
// or the same customer resubmits the same time.
router.post('/cancel', h(async (req, res) => {
  requireDb();
  const id = clean(req.body && req.body.id, 40), token = clean(req.body && req.body.token, 100);
  if (!id || !token) throw httpErr(400, 'Missing hold.');
  // One token covers every window a long job held.
  const { data: own } = await supabase.from('uea_booked_slots').select('id').eq('id', id).eq('release_token_hash', sha256(token)).limit(1);
  if (!own || !own.length) return res.json({ ok: true });
  const { error } = await supabase
    .from('uea_booked_slots')
    .update({ status: 'released', released_at: new Date().toISOString() })
    .eq('release_token_hash', sha256(token)).eq('status', 'held');
  if (error) throw error;
  cache.at = 0;
  res.json({ ok: true });
}));

// ── Owner page ──────────────────────────────────────────────────────────────
router.get('/admin/list', h(async (req, res) => {
  requireAdmin(req);
  requireDb();
  const today = nowInTZ().date;
  const { data, error } = await supabase
    .from('uea_booked_slots')
    .select('id, slot_date, slot_time, customer_name, phone, service, vehicle, rush, created_at')
    .eq('status', 'held')
    .gte('slot_date', today)
    .order('slot_date', { ascending: true })
    .limit(1000);
  if (error) throw error;
  data.sort((a, b) => a.slot_date === b.slot_date ? slotMinutes(a.slot_time) - slotMinutes(b.slot_time) : (a.slot_date < b.slot_date ? -1 : 1));
  res.json({ capacity: (await windowSettings()).capacity, slots: data });
}));

router.post('/admin/release', h(async (req, res) => {
  requireAdmin(req);
  requireDb();
  const id = clean(req.body && req.body.id, 40);
  if (!id) throw httpErr(400, 'Missing slot.');
  const { error } = await supabase
    .from('uea_booked_slots')
    .update({ status: 'released', released_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'held');
  if (error) throw error;
  cache.at = 0;
  res.json({ ok: true });
}));

router.get('/admin', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('X-Robots-Tag', 'noindex');
  res.send(ADMIN_HTML);
});

const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Reserved times · Upper Echelon</title>
<style>
:root{--bg:#0B0A10;--card:#1A1428;--line:rgba(226,214,255,.12);--text:#F3EFE8;--muted:rgba(243,239,232,.65);--gold:#CBA135;--red:#f87171}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px 64px}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:1.5rem;margin-bottom:4px}
.sub{color:var(--muted);font-size:.9rem;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
input{width:100%;min-height:46px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);font-size:16px;padding:10px 12px;margin:10px 0}
button{min-height:44px;padding:0 18px;border:0;border-radius:6px;background:var(--gold);color:#0B0A10;font-weight:700;font-size:.95rem;cursor:pointer}
button.ghost{background:transparent;color:var(--gold);border:1px solid rgba(203,161,53,.5)}
button:disabled{opacity:.5;cursor:default}
.err{color:var(--red);font-size:.9rem;min-height:1.3em}
.day{font-weight:700;color:var(--gold);margin:20px 0 8px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.t{font-weight:700;font-variant-numeric:tabular-nums;min-width:80px}
.who{flex:1;min-width:0}
.who small{display:block;color:var(--muted);overflow-wrap:anywhere}
.rush{color:var(--red);font-weight:700;font-size:.8rem}
.empty{color:var(--muted)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
</style></head><body><div class="wrap">
<div class="top"><div><h1>Reserved times</h1><p class="sub">Times customers booked on ueauto.store. Release a time to put it back on the website.</p></div>
<button class="ghost" id="refresh" hidden>Refresh</button></div>
<div class="card" id="login"><label for="pw">Owner password</label><input id="pw" type="password" autocomplete="current-password">
<button id="go">Sign in</button><p class="err" id="lerr"></p></div>
<div id="list" hidden></div>
</div><script>
(function(){
var pw='',$=function(i){return document.getElementById(i)};
try{pw=sessionStorage.getItem('uea_slots_pw')||''}catch(e){}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmt(d){return new Date(d+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})}
function api(path,body){return fetch('/slots'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-admin-password':pw},body:body?JSON.stringify(body):undefined})
 .then(function(r){return r.json().catch(function(){return{}}).then(function(d){if(!r.ok)throw Object.assign(new Error(d.error||'Error'),{status:r.status});return d})})}
function load(){
 $('lerr').textContent='';
 return api('/admin/list').then(function(d){
  try{sessionStorage.setItem('uea_slots_pw',pw)}catch(e){}
  $('login').hidden=true;$('list').hidden=false;$('refresh').hidden=false;
  if(!d.slots.length){$('list').innerHTML='<div class="card empty">No upcoming reserved times.</div>';return}
  var html='',day='';
  d.slots.forEach(function(s){
   if(s.slot_date!==day){if(day)html+='</div>';day=s.slot_date;html+='<p class="day">'+esc(fmt(day))+'</p><div class="card">'}
   html+='<div class="row"><span class="t">'+esc(s.slot_time)+'</span><div class="who">'+esc(s.customer_name)+(s.rush?' <span class="rush">RUSH</span>':'')+
   '<small>'+esc(s.phone)+' · '+esc(s.service)+(s.vehicle?' · '+esc(s.vehicle):'')+'</small></div>'+
   '<button class="ghost" data-id="'+esc(s.id)+'" data-label="'+esc(s.slot_time+' on '+fmt(s.slot_date)+' ('+s.customer_name+')')+'">Release</button></div>'});
  $('list').innerHTML=html+'</div>';
 }).catch(function(e){
  $('login').hidden=false;$('list').hidden=true;$('refresh').hidden=true;
  if(e.status===401){try{sessionStorage.removeItem('uea_slots_pw')}catch(x){}}
  $('lerr').textContent=e.message;
 });
}
$('go').onclick=function(){pw=$('pw').value;load()};
$('pw').onkeydown=function(e){if(e.key==='Enter'){pw=$('pw').value;load()}};
$('refresh').onclick=load;
$('list').onclick=function(e){
 var b=e.target.closest('button[data-id]');if(!b)return;
 if(!confirm('Release '+b.getAttribute('data-label')+'? The time goes back on the website.'))return;
 b.disabled=true;b.textContent='Releasing…';
 api('/admin/release',{id:b.getAttribute('data-id')}).then(load).catch(function(err){alert(err.message);b.disabled=false;b.textContent='Release'});
};
if(pw)load();
})();
</script></body></html>`;

module.exports = router;
