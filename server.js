#!/usr/bin/env node
'use strict';
/*
 * Kumon Check-In / Check-Out — self-hosted, zero-dependency server.
 *
 * Security model (summary):
 *  - Runs on ONE computer at the center. iPads/laptops on the same Wi-Fi connect to it.
 *    Nothing is sent to any cloud service, CDN, analytics or third party.
 *  - All data lives in ./data/kumon-data.json (file mode 0600, directory 0700).
 *  - Admin pages require a password (scrypt-hashed). The password can only be
 *    created the first time from the server computer itself (localhost).
 *  - The student page (the site's main page) exposes only name, grade and in/out
 *    status — never age, notes or history.
 *  - HttpOnly + SameSite=Strict session cookies, login rate limiting,
 *    CSRF checks (custom header + Origin/Sec-Fetch-Site), strict CSP,
 *    no inline scripts, request body size limits, input validation.
 *  - Optional HTTPS: drop certs/key.pem and certs/cert.pem next to this file.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'kumon-data.json');
const PREV_FILE = path.join(DATA_DIR, 'kumon-data.prev.json');   // the version before the last save
const BACKUP_DIR = path.join(DATA_DIR, 'backups');                // one snapshot per day, kept 30 days
const KEEP_BACKUP_DAYS = 30;
const CERT_DIR = path.join(ROOT, 'certs');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;      // admin login lasts 12h of inactivity
const MAX_BODY_BYTES = 64 * 1024;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const KEEP_RECENT_DAYS = 14;   // day records kept in the main file (completed visits live in history/)
const KEEP_LOG_DAYS = 7;       // event log (today's activity) kept in the main file
const HISTORY_DIR = path.join(DATA_DIR, 'history');   // sessions-YYYY.ndjson, one visit per line, kept forever
const MAX_VIEW_ROWS = 1500;    // most rows the Records page shows at once (CSV export has no cap)

// Hosting options (all optional; none are needed when running on a computer at the center):
//   TRUST_PROXY=1     behind a hosting provider's HTTPS proxy (Render, Fly, Railway...). Set
//                     automatically on Render. Uses X-Forwarded-Proto for cookie/CSRF checks.
//   ADMIN_PASSWORD    creates the admin password on first start when none exists, since there
//                     is no "localhost" to do the first-run setup from on a hosted server.
//   DEMO=1            seeds a few made-up students when the student list is empty (test sites).
//   DATA_DIR          where to keep the data folder (e.g. a persistent disk mount).
const BEHIND_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '') || !!process.env.RENDER;
const DEMO = /^(1|true|yes)$/i.test(process.env.DEMO || '');

// ---------------------------------------------------------------- storage

function randomToken(bytes) { return crypto.randomBytes(bytes).toString('base64url'); }

function defaultData() {
  return { version: 2, adminHash: null, students: [], attendance: {}, log: [], sessions: {} };
}

function ensureDirs() {
  for (const dir of [DATA_DIR, BACKUP_DIR, HISTORY_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
  }
}

function tryParse(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function latestBackup() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^kumon-data-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map((f) => path.join(BACKUP_DIR, f)).pop() || null;
  } catch (_) { return null; }
}

// Load order: main file -> previous version -> newest daily backup -> fresh start.
// A main file that exists but cannot be parsed is never overwritten: we stop and say so.
function loadData() {
  ensureDirs();
  if (fs.existsSync(DATA_FILE)) {
    const parsed = tryParse(DATA_FILE);
    if (!parsed) {
      console.error(`\n  The data file ${DATA_FILE} exists but could not be read as JSON.`);
      console.error('  Nothing was changed. Restore it from kumon-data.prev.json or the backups/ folder, then start again.\n');
      process.exit(1);
    }
    return normalise(parsed);
  }
  for (const candidate of [PREV_FILE, latestBackup()]) {
    if (candidate && fs.existsSync(candidate)) {
      const parsed = tryParse(candidate);
      if (parsed && parsed.adminHash) {
        console.log(`  Main data file was missing; restored from ${candidate}`);
        const d = normalise(parsed);
        writeData(d);
        return d;
      }
    }
  }
  const d = defaultData();
  writeData(d);
  return d;
}

function normalise(parsed) {
  const d = Object.assign(defaultData(), parsed);
  delete d.kioskKey; delete d.settings; // leftovers from earlier versions
  if (!d.sessions || typeof d.sessions !== 'object') d.sessions = {};
  return d;
}

function writeData(d) {
  ensureDirs(); // recreate folders if they went missing while running
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 });
  if (fs.existsSync(DATA_FILE)) {
    try { fs.copyFileSync(DATA_FILE, PREV_FILE); fs.chmodSync(PREV_FILE, 0o600); } catch (_) {}
    dailyBackup();
  }
  fs.renameSync(tmp, DATA_FILE);
  try { fs.chmodSync(DATA_FILE, 0o600); } catch (_) {}
}

// First save of each day snapshots the file as it was before that save; old snapshots are pruned.
function dailyBackup() {
  const today = localDateKey(new Date());
  const target = path.join(BACKUP_DIR, `kumon-data-${today}.json`);
  if (fs.existsSync(target)) return;
  try {
    fs.copyFileSync(DATA_FILE, target); fs.chmodSync(target, 0o600);
    const cutoff = localDateKey(new Date(Date.now() - KEEP_BACKUP_DAYS * 86400000));
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      const m = f.match(/^kumon-data-(\d{4}-\d{2}-\d{2})\.json$/);
      if (m && m[1] < cutoff) fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  } catch (err) { console.error('backup failed:', err.message); }
}

let data = loadData();

// Hosted test sites: password from the environment, optional made-up students.
if (!data.adminHash && process.env.ADMIN_PASSWORD) {
  if (process.env.ADMIN_PASSWORD.length < 8) {
    console.error('\n  ADMIN_PASSWORD must be at least 8 characters.\n');
    process.exit(1);
  }
  data.adminHash = hashPassword(process.env.ADMIN_PASSWORD);
  writeData(data);
  console.log('  Admin password set from ADMIN_PASSWORD.');
}
if (DEMO && data.students.length === 0) {
  const sample = [
    ['Mia Chen', '3', 8, '15:30', '16:30'], ['Noah Patel', 'K', 5, '16:00', '17:00'],
    ['Ava Rodriguez', '7', 12, '17:30', '19:00'], ['Liam Nguyen', '1', 6, '15:30', '16:00'],
    ['Sofia Kim', '5', 10, '18:00', '19:30'], ['Ethan Brooks', 'Pre-K', 4, '16:30', '17:00'],
  ];
  for (const [name, grade, age, inTime, outTime] of sample) {
    data.students.push({ id: randomToken(9), createdAt: new Date().toISOString(), name, grade, age, notes: '', inTime, outTime, days: [1, 4] });
  }
  writeData(data);
  console.log('  DEMO: added sample students.');
}

function save() {
  // The main file only keeps recent days; every completed visit is already in history/.
  const dayCutoff = localDateKey(new Date(Date.now() - KEEP_RECENT_DAYS * 86400000));
  for (const k of Object.keys(data.attendance)) if (k < dayCutoff) delete data.attendance[k];
  const logCutoff = new Date(Date.now() - KEEP_LOG_DAYS * 86400000).toISOString();
  if (data.log.length && data.log[0].ts < logCutoff) data.log = data.log.filter((e) => e.ts >= logCutoff);
  writeData(data);
}

// ---------------------------------------------------------------- visit history (permanent)
//
// Every completed visit (check-in + check-out) is appended as one JSON line to
// data/history/sessions-YYYY.ndjson. Appending is cheap and crash-safe, the files are never
// rewritten, and they stay small (roughly 150 bytes per visit, so a few MB per year even for
// a large center). All lines are also held in memory for fast reports.

let history = [];                 // all visits, in the order they were written
const historyIds = new Set();

function loadHistory() {
  ensureDirs();
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => /^sessions-\d{4}\.ndjson$/.test(f)).sort();
  for (const f of files) {
    const text = fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && v.id && !historyIds.has(v.id)) { historyIds.add(v.id); history.push(v); }
      } catch (_) { /* a half-written last line after a power cut: skip it */ }
    }
  }
}

function appendVisit(v) {
  if (historyIds.has(v.id)) return;
  ensureDirs();
  const file = path.join(HISTORY_DIR, `sessions-${v.date.slice(0, 4)}.ndjson`);
  fs.appendFileSync(file, JSON.stringify(v) + '\n', { mode: 0o600 });
  historyIds.add(v.id); history.push(v);
}

// Build the permanent record for a day record that has both in and out.
function visitFrom(studentId, dateKey, rec) {
  const s = data.students.find((x) => x.id === studentId);
  const inAt = new Date(rec.in), outAt = new Date(rec.out);
  return {
    id: `${studentId}-${rec.in}`,
    date: dateKey,
    studentId,
    name: rec.name || (s && s.name) || 'Unknown',
    grade: rec.grade ?? (s ? s.grade : ''),
    in: rec.in,
    out: rec.out,
    min: Math.max(0, Math.round((outAt - inAt) / 60000)),
    schedIn: rec.schedIn || (s && s.inTime) || '',
    schedOut: rec.schedOut || (s && s.outTime) || '',
    src: rec.outSrc || 'student',
    auto: !!rec.auto,
  };
}

function archiveRecord(studentId, dateKey, rec) {
  if (!rec.in || !rec.out || rec.archived) return;
  appendVisit(visitFrom(studentId, dateKey, rec));
  rec.archived = true;
}

// Once a day has passed, any visit still open (student forgot to check out) is closed at the
// scheduled check-out time and marked as closed automatically, so every visit has a duration.
function closeStaleDays() {
  const today = localDateKey(new Date());
  let changed = false;
  for (const [dateKey, day] of Object.entries(data.attendance)) {
    if (dateKey >= today) continue;
    for (const [studentId, rec] of Object.entries(day)) {
      if (rec.in && !rec.out) {
        const s = data.students.find((x) => x.id === studentId);
        const sched = rec.schedOut || (s && s.outTime) || '';
        let outAt = HHMM.test(sched) ? new Date(`${dateKey}T${sched}:00`) : null;
        if (!outAt || !(outAt > new Date(rec.in))) outAt = new Date(new Date(rec.in).getTime() + 60000);
        rec.out = outAt.toISOString(); rec.auto = true; rec.outSrc = 'auto'; rec.dismissed = true;
        changed = true;
      }
      if (!rec.archived) { archiveRecord(studentId, dateKey, rec); changed = true; }
    }
  }
  if (changed) save();
}

// Reports: visits in a date range, optionally one student, grouped by visit/week/month/year.
function weekStart(dateKey) {
  const d = new Date(`${dateKey}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return localDateKey(d);
}
const periodCache = new Map(); // "group|date" -> period; there are only ~1,100 dates in 3 years, so this stays tiny
function periodOf(dateKey, group) {
  const ck = `${group}|${dateKey}`;
  let p = periodCache.get(ck);
  if (p) return p;
  if (group === 'week') { const ws = weekStart(dateKey); p = { key: ws, start: ws, label: `Week of ${fmtDateLabel(ws)}` }; }
  else if (group === 'month') { const k = dateKey.slice(0, 7); p = { key: k, start: k + '-01', label: new Date(`${k}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) }; }
  else { const y = dateKey.slice(0, 4); p = { key: y, start: y + '-01-01', label: y }; }
  periodCache.set(ck, p);
  return p;
}
function fmtDateLabel(dateKey) { return new Date(`${dateKey}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function daysBetween(a, b) { return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000) + 1; }

function queryHistory({ from, to, studentId, group }) {
  const today = localDateKey(new Date());
  const rows = [];
  for (const v of history) if (v.date >= from && v.date <= to && (!studentId || v.studentId === studentId)) rows.push(v);
  // visits in progress right now (today only) so the Records page matches the board
  if (to >= today && from <= today) {
    for (const [sid, rec] of Object.entries(data.attendance[today] || {})) {
      if (!rec.in || rec.out || (studentId && sid !== studentId)) continue;
      const s = data.students.find((x) => x.id === sid);
      rows.push({ id: `${sid}-${rec.in}`, date: today, studentId: sid, name: rec.name || (s && s.name) || 'Unknown', grade: rec.grade ?? (s ? s.grade : ''), in: rec.in, out: null, min: Math.max(0, Math.round((Date.now() - new Date(rec.in)) / 60000)), schedIn: rec.schedIn || (s && s.inTime) || '', schedOut: rec.schedOut || (s && s.outTime) || '', src: '', auto: false, open: true });
    }
  }
  const days = daysBetween(from, to);
  if (!['visit', 'week', 'month', 'year'].includes(group)) group = days <= 35 ? 'visit' : days <= 190 ? 'week' : days <= 800 ? 'month' : 'year';

  const students = new Set(rows.map((r) => r.studentId));
  const totalMin = rows.reduce((a, r) => a + (r.open ? 0 : r.min), 0);
  const completed = rows.filter((r) => !r.open).length;
  const summary = { visits: rows.length, open: rows.length - completed, totalMin, students: students.size, avgMin: completed ? Math.round(totalMin / completed) : 0 };

  if (group === 'visit') {
    rows.sort((a, b) => (a.in < b.in ? 1 : a.in > b.in ? -1 : 0));
    return { group, days, summary, total: rows.length, rows: rows.slice(0, MAX_VIEW_ROWS), all: rows };
  }
  const buckets = new Map();
  for (const r of rows) {
    if (r.open) continue;
    const p = periodOf(r.date, group);
    const k = `${p.key}|${r.studentId}`;
    let b = buckets.get(k);
    if (!b) { b = { period: p.key, start: p.start, label: p.label, studentId: r.studentId, name: r.name, grade: r.grade, visits: 0, totalMin: 0, auto: 0 }; buckets.set(k, b); }
    b.visits++; b.totalMin += r.min; if (r.auto) b.auto++; b.name = r.name; b.grade = r.grade;
  }
  const agg = [...buckets.values()].map((b) => Object.assign(b, { avgMin: Math.round(b.totalMin / b.visits) }));
  agg.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : a.name.localeCompare(b.name)));
  return { group, days, summary, total: agg.length, rows: agg.slice(0, MAX_VIEW_ROWS), all: agg };
}

function fmtMin(min) { const hh = Math.floor(min / 60), mm = min % 60; return hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm} min`; }
function fmtClock(iso) { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function historyCsv(q) {
  const r = queryHistory(q);
  const rows = [];
  if (r.group === 'visit') {
    rows.push(['Date', 'Weekday', 'Student', 'Grade', 'Check in', 'Check out', 'Minutes', 'Stayed', 'Scheduled in', 'Scheduled out', 'Note']);
    for (const v of r.all) {
      const note = v.open ? 'Still here' : v.auto ? 'No check-out recorded; closed at scheduled time' : v.src === 'admin' ? 'Checked out by teacher' : '';
      rows.push([v.date, WEEKDAYS[new Date(`${v.date}T12:00:00`).getDay()], v.name, v.grade || '', fmtClock(v.in), v.out ? fmtClock(v.out) : '', v.open ? '' : v.min, v.open ? '' : fmtMin(v.min), v.schedIn, v.schedOut, note]);
    }
  } else {
    rows.push(['Period', 'Period start', 'Student', 'Grade', 'Visits', 'Total minutes', 'Total time', 'Average minutes', 'Visits without check-out']);
    for (const b of r.all) rows.push([b.label, b.start, b.name, b.grade || '', b.visits, b.totalMin, fmtMin(b.totalMin), b.avgMin, b.auto]);
  }
  return { group: r.group, body: rows.map((x) => x.map(csvCell).join(',')).join('\r\n') + '\r\n' };
}

// ---------------------------------------------------------------- helpers

function pad2(n) { return String(n).padStart(2, '0'); }
function localDateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
function verifyPassword(pw, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(rec.salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const stored = Buffer.from(rec.hash, 'hex');
  return hash.length === stored.length && crypto.timingSafeEqual(hash, stored);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isLocalhost(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function clientIp(req) { return req.socket.remoteAddress || 'unknown'; }

// ---------------------------------------------------------------- sessions & throttling

// Sessions live in data.sessions (token -> expiresAt) so a server restart keeps teachers logged in.
const sessions = {
  get(t) { return data.sessions[t]; },
  set(t, exp, persist) { data.sessions[t] = exp; if (persist) save(); },
  delete(t) { if (t in data.sessions) { delete data.sessions[t]; save(); } },
  clear() { data.sessions = {}; save(); },
};
function newSession() {
  const t = randomToken(32);
  sessions.set(t, Date.now() + SESSION_TTL_MS, true);
  return t;
}
function getSession(req) {
  const t = parseCookies(req).sid;
  if (!t) return null;
  const exp = sessions.get(t);
  if (!exp) return null;
  if (exp < Date.now()) { sessions.delete(t); return null; }
  sessions.set(t, Date.now() + SESSION_TTL_MS, false); // rolling expiry, persisted with the next save
  return t;
}
setInterval(() => {
  try {
    const now = Date.now();
    let changed = false;
    for (const [t, e] of Object.entries(data.sessions)) if (e < now) { delete data.sessions[t]; changed = true; }
    if (changed) save();
    closeStaleDays();
  } catch (err) { console.error('housekeeping failed:', err.message); }
}, 60000).unref();

const loginFails = new Map(); // ip -> {count, resetAt}
function loginThrottled(ip) {
  const r = loginFails.get(ip);
  if (!r) return false;
  if (r.resetAt < Date.now()) { loginFails.delete(ip); return false; }
  return r.count >= LOGIN_MAX_FAILS;
}
function noteLoginFail(ip) {
  const r = loginFails.get(ip);
  if (!r || r.resetAt < Date.now()) loginFails.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else r.count++;
}

// ---------------------------------------------------------------- http helpers

let TLS = false;

function baseHeaders(extra) {
  return Object.assign({
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }, TLS ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}, extra || {});
}

function send(res, status, body, headers) {
  res.writeHead(status, baseHeaders(headers));
  res.end(body);
}
function json(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
}
// Whether the browser is talking to us over HTTPS (directly, or via a trusted proxy).
function isSecure(req) {
  return TLS || (BEHIND_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}
function cookieHeader(req, name, value, maxAgeSec) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict`;
  if (isSecure(req)) c += '; Secure';
  if (maxAgeSec != null) c += `; Max-Age=${maxAgeSec}`;
  return c;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// CSRF / cross-site protection for every state-changing request.
function sameOriginOk(req) {
  if ((req.headers['x-requested-with'] || '') !== 'kumon') return false;
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  const origin = req.headers.origin;
  if (origin) {
    const expected = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}`;
    if (origin !== expected) return false;
  }
  return true;
}

// ---------------------------------------------------------------- static files

const STATIC = {
  '/': ['student.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
  '/student.js': ['student.js', 'text/javascript; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/favicon.ico': ['icon.svg', 'image/svg+xml'],
};

function serveStatic(req, res, entry) {
  const [file, type] = entry;
  let buf;
  try { buf = fs.readFileSync(path.join(PUBLIC_DIR, file)); }
  catch (_) { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('base64url') + '"';
  if (req.headers['if-none-match'] === etag) return send(res, 304, '', { ETag: etag });
  const isHtml = type.startsWith('text/html');
  send(res, 200, buf, { 'Content-Type': type, ETag: etag, 'Cache-Control': isHtml ? 'no-store' : 'no-cache' });
}

// ---------------------------------------------------------------- domain logic

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ALLOWED_DAYS = [1, 4]; // Monday and Thursday

function validateStudent(b) {
  const errors = [];
  const name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.push('Name is required.');
  if (name.length > 60) errors.push('Name is too long.');
  const grade = String(b.grade ?? '').trim().slice(0, 20);
  let age = null;
  if (b.age !== '' && b.age != null) {
    age = Number(b.age);
    if (!Number.isInteger(age) || age < 2 || age > 99) errors.push('Age must be a whole number.');
  }
  const notes = String(b.notes ?? '').trim().slice(0, 300);
  const inTime = String(b.inTime ?? ''), outTime = String(b.outTime ?? '');
  if (!HHMM.test(inTime) || !HHMM.test(outTime)) errors.push('Check-in and check-out times are required (HH:MM).');
  else if (outTime <= inTime) errors.push('Check-out time must be after check-in time.');
  let days = Array.isArray(b.days) ? b.days.map(Number).filter((d) => ALLOWED_DAYS.includes(d)) : [];
  days = [...new Set(days)].sort();
  if (!days.length) errors.push('Pick Monday, Thursday, or both.');
  return { errors, value: { name, grade, age, notes, inTime, outTime, days } };
}

function todayRecords() {
  const key = localDateKey(new Date());
  return data.attendance[key] || {};
}

function recordEvent(student, action, source) {
  const now = new Date();
  const key = localDateKey(now);
  const day = (data.attendance[key] = data.attendance[key] || {});
  const rec = day[student.id] || { in: null, out: null };
  const iso = now.toISOString();
  if (action === 'in') {
    if (rec.in && !rec.out) return { error: `${student.name} is already checked in.` };
    if (rec.out) archiveRecord(student.id, key, rec); // second visit the same day: keep the first one
    // snapshot name/schedule so the permanent record is right even if the student is edited later
    day[student.id] = { in: iso, out: null, dismissed: false, name: student.name, grade: student.grade, schedIn: student.inTime, schedOut: student.outTime };
  } else if (action === 'out') {
    if (!rec.in || rec.out) return { error: `${student.name} is not checked in.` };
    rec.out = iso; rec.outSrc = source;
    day[student.id] = rec;
    archiveRecord(student.id, key, rec);
  } else if (action === 'clear') {
    // Undo a mistaken check-in (e.g. a student tapped the wrong name). Only an open visit can be undone.
    if (!rec.in || rec.out) return { error: `${student.name} is not checked in.` };
    delete day[student.id];
  } else if (action === 'dismiss') {
    // Remove from the live board. A student who is still checked in is checked out first,
    // so the attendance record always has a check-out time.
    if (!rec.in) return { error: `${student.name} has not checked in today.` };
    if (!rec.out) {
      rec.out = iso; rec.outSrc = source;
      data.log.push({ ts: iso, studentId: student.id, name: student.name, grade: student.grade, type: 'out', source });
      archiveRecord(student.id, key, rec);
    }
    rec.dismissed = true;
    day[student.id] = rec;
    save();
    return { ok: true, time: iso, record: rec };
  } else {
    return { error: 'Unknown action.' };
  }
  data.log.push({ ts: iso, studentId: student.id, name: student.name, grade: student.grade, type: action, source });
  save();
  return { ok: true, time: iso, record: day[student.id] || null };
}

function kioskView() {
  const recs = todayRecords();
  return data.students
    .map((s) => {
      const r = recs[s.id];
      const status = r && r.in && !r.out ? 'in' : r && r.out ? 'done' : 'out';
      return { id: s.id, name: s.name, grade: s.grade, status, since: status === 'in' ? r.in : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function adminState() {
  const key = localDateKey(new Date());
  return {
    serverTime: new Date().toISOString(),
    today: key,
    students: data.students,
    attendance: data.attendance[key] || {},
    log: data.log.filter((e) => localDateKey(new Date(e.ts)) === key).slice(-300).reverse(),
  };
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ---------------------------------------------------------------- router

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (m !== 'GET' && m !== 'HEAD' && !sameOriginOk(req)) return json(res, 403, { error: 'Cross-site request blocked.' });

  // ---- pages
  if (m === 'GET' && (p === '/index.html' || p === '/student' || p === '/kiosk')) return send(res, 302, '', { Location: '/' });

  if (m === 'GET' && STATIC[p]) return serveStatic(req, res, STATIC[p]);

  // ---- student page API (open to every device on the network; minimal data only)
  if (p.startsWith('/api/student/')) {
    if (m === 'GET' && p === '/api/student/students') return json(res, 200, { serverTime: new Date().toISOString(), students: kioskView() });
    if (m === 'POST' && p === '/api/student/toggle') {
      const b = await readBody(req);
      const s = data.students.find((x) => x.id === b.id);
      if (!s) return json(res, 404, { error: 'Student not found.' });
      if (b.action !== 'in' && b.action !== 'out') return json(res, 400, { error: 'Bad action.' });
      const r = recordEvent(s, b.action, 'student');
      if (r.error) return json(res, 409, { error: r.error });
      return json(res, 200, { ok: true, time: r.time, action: b.action, name: s.name });
    }
    return json(res, 404, { error: 'Not found' });
  }

  // ---- admin API
  if (p.startsWith('/api/admin/')) {
    const setupRequired = !data.adminHash;

    if (m === 'GET' && p === '/api/admin/me') {
      return json(res, 200, { setupRequired, setupAllowed: setupRequired && isLocalhost(req), loggedIn: !!getSession(req) });
    }

    if (m === 'POST' && p === '/api/admin/setup') {
      if (!setupRequired) return json(res, 409, { error: 'Already set up.' });
      if (!isLocalhost(req)) return json(res, 403, { error: 'Initial setup must be done on the server computer (localhost).' });
      const b = await readBody(req);
      const pw = String(b.password || '');
      if (pw.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters.' });
      data.adminHash = hashPassword(pw);
      save();
      const t = newSession();
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'sid', t) });
    }

    if (m === 'POST' && p === '/api/admin/login') {
      if (setupRequired) return json(res, 409, { error: 'Setup required.' });
      const ip = clientIp(req);
      if (loginThrottled(ip)) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const b = await readBody(req);
      if (!verifyPassword(String(b.password || ''), data.adminHash)) {
        noteLoginFail(ip);
        return json(res, 401, { error: 'Incorrect password.' });
      }
      loginFails.delete(ip);
      const t = newSession();
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'sid', t) });
    }

    if (m === 'POST' && p === '/api/admin/logout') {
      const t = parseCookies(req).sid;
      if (t) sessions.delete(t);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'sid', '', 0) });
    }

    // everything below requires a session
    const sid = getSession(req);
    if (!sid) return json(res, 401, { error: 'Please log in.' });

    if (m === 'GET' && p === '/api/admin/state') {
      return json(res, 200, adminState());
    }

    if (m === 'POST' && p === '/api/admin/students') {
      const { errors, value } = validateStudent(await readBody(req));
      if (errors.length) return json(res, 400, { error: errors.join(' ') });
      const s = Object.assign({ id: randomToken(9), createdAt: new Date().toISOString() }, value);
      data.students.push(s);
      save();
      return json(res, 200, { ok: true, student: s });
    }

    const sm = p.match(/^\/api\/admin\/students\/([A-Za-z0-9_-]+)$/);
    if (sm) {
      const s = data.students.find((x) => x.id === sm[1]);
      if (!s) return json(res, 404, { error: 'Student not found.' });
      if (m === 'PUT') {
        const { errors, value } = validateStudent(await readBody(req));
        if (errors.length) return json(res, 400, { error: errors.join(' ') });
        Object.assign(s, value);
        save();
        return json(res, 200, { ok: true, student: s });
      }
      if (m === 'DELETE') {
        // Past visits stay in the history files (under the student's name) so reports remain complete.
        for (const [dateKey, day] of Object.entries(data.attendance)) {
          if (day[s.id]) { archiveRecord(s.id, dateKey, day[s.id]); delete day[s.id]; }
        }
        data.students = data.students.filter((x) => x.id !== s.id);
        save();
        return json(res, 200, { ok: true });
      }
    }

    if (m === 'POST' && p === '/api/admin/attendance') {
      const b = await readBody(req);
      const s = data.students.find((x) => x.id === b.studentId);
      if (!s) return json(res, 404, { error: 'Student not found.' });
      const r = recordEvent(s, String(b.action), 'admin');
      if (r.error) return json(res, 409, { error: r.error });
      return json(res, 200, { ok: true, time: r.time });
    }

    if (m === 'POST' && p === '/api/admin/password') {
      const b = await readBody(req);
      if (!verifyPassword(String(b.current || ''), data.adminHash)) return json(res, 401, { error: 'Current password is incorrect.' });
      const next = String(b.next || '');
      if (next.length < 8) return json(res, 400, { error: 'New password must be at least 8 characters.' });
      data.adminHash = hashPassword(next);
      save();
      sessions.clear();
      const t = newSession();
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'sid', t) });
    }

    if (m === 'GET' && p === '/api/admin/backup') {
      // Everything needed to rebuild the center's records. The password hash and logins are left out.
      const body = JSON.stringify({ exported: new Date().toISOString(), version: data.version, students: data.students, attendance: data.attendance, log: data.log, visits: history }, null, 1);
      return send(res, 200, body, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="kumon-backup-${localDateKey(new Date())}.json"`,
        'Cache-Control': 'no-store',
      });
    }

    if (m === 'GET' && (p === '/api/admin/history' || p === '/api/admin/export.csv')) {
      const today = localDateKey(new Date());
      const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(new Date(`${v}T12:00:00`).getTime());
      let from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : today;
      let to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : today;
      if (from > to) [from, to] = [to, from];
      const studentId = /^[A-Za-z0-9_-]{1,40}$/.test(url.searchParams.get('student') || '') ? url.searchParams.get('student') : '';
      const group = url.searchParams.get('group') || 'auto';
      if (p === '/api/admin/history') {
        const r = queryHistory({ from, to, studentId, group });
        return json(res, 200, { from, to, group: r.group, days: r.days, summary: r.summary, total: r.total, rows: r.rows, truncated: r.total > r.rows.length });
      }
      const { group: g, body } = historyCsv({ from, to, studentId, group });
      return send(res, 200, body, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="kumon-attendance-${from}_to_${to}-by-${g}.csv"`,
        'Cache-Control': 'no-store',
      });
    }

    return json(res, 404, { error: 'Not found' });
  }

  send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

// ---------------------------------------------------------------- boot

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function start() {
  const onRequest = (req, res) => {
    handle(req, res).catch((err) => {
      const status = /too large|invalid json/.test(err.message) ? 400 : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: status === 400 ? err.message : 'Server error' });
      else res.end();
    });
  };

  let server;
  const keyPath = path.join(CERT_DIR, 'key.pem'), certPath = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    TLS = true;
    server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, onRequest);
  } else {
    server = http.createServer(onRequest);
  }
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use. Is the server already running in another window?`);
      console.error(`  To use a different port: PORT=9000 node server.js\n`);
    } else {
      console.error('\n  Could not start the server:', err.message, '\n');
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const proto = TLS ? 'https' : 'http';
    console.log('');
    console.log('  Kumon Check-In / Check-Out is running' + (TLS ? ' (HTTPS)' : ''));
    console.log('  --------------------------------------');
    console.log(`  Admin (this computer):  ${proto}://localhost:${PORT}/admin`);
    for (const a of lanAddresses()) console.log(`  Admin (on the Wi-Fi):   ${proto}://${a}:${PORT}/admin`);
    for (const a of lanAddresses()) console.log(`  Students (on the Wi-Fi): ${proto}://${a}:${PORT}/`);
    if (!data.adminHash) {
      console.log('');
      console.log('  FIRST RUN: open the localhost admin link above ON THIS COMPUTER to create the admin password.');
    }
    console.log(`  Data file: ${DATA_FILE}  (daily backups in ${BACKUP_DIR})`);
    console.log(`  Visit history: ${HISTORY_DIR}  (${history.length} visits on record)`);
    console.log('');
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { save(); } catch (_) {} process.exit(0); });
}
// Never let one unexpected error take the check-in system down mid-class; log it and carry on.
process.on('uncaughtException', (err) => { console.error('Unexpected error (server kept running):', err); });
process.on('unhandledRejection', (err) => { console.error('Unexpected error (server kept running):', err); });

try { loadHistory(); } catch (err) { console.error('Could not read history files:', err.message); }
try { closeStaleDays(); } catch (err) { console.error('Could not close old visits:', err.message); }
start();
