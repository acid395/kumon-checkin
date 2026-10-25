#!/usr/bin/env node
'use strict';
/*
 * Kumon check-in / check-out server. Plain Node, no packages.
 *
 * Security notes:
 *  - Runs on one computer at the center; iPads and laptops on the same Wi-Fi connect to it.
 *    Nothing is sent to any outside service.
 *  - Data lives in ./data (folder mode 0700, files 0600). The folder is not part of the code,
 *    so updating the code never touches it.
 *  - The admin password is hashed with scrypt and can only be created the first time from the
 *    server computer itself.
 *  - Admin logins are held in memory only and need both an HttpOnly cookie and a key the
 *    browser tab keeps for itself, so closing the tab or restarting the server logs out.
 *  - The student page only gets each student's name, student ID and in/out status.
 *  - SameSite=Strict cookies, login rate limiting, CSRF checks (custom header plus
 *    Origin/Sec-Fetch-Site), strict CSP with no inline scripts, body size limits,
 *    input validation on everything that is saved.
 *  - Optional HTTPS: put certs/key.pem and certs/cert.pem next to this file.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { parseSchedule, ImportError } = require('./importer');

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
const SESSION_IDLE_MS = 20 * 60 * 1000;         // admin login ends after 20 minutes with the page closed
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;      // and after 12 hours no matter what
const DATA_VERSION = 2;                          // bump when the data file layout changes
const KEEP_SNAPSHOTS = 10;                       // startup and before-restore copies kept of each kind
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESTORE_BYTES = 64 * 1024 * 1024;      // a downloaded backup, which includes every visit
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;   // a schedule spreadsheet or PDF
const MAX_IMPORT_JSON_BYTES = 2 * 1024 * 1024;   // the checked student list sent back to be saved
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
  return { version: DATA_VERSION, adminHash: null, students: [], attendance: {}, log: [] };
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
    if (Number(parsed.version) > DATA_VERSION) {
      // Older code must not rewrite data saved by newer code.
      console.error(`\n  The data in ${DATA_DIR} was saved by a newer version of this program.`);
      console.error('  Update the code (git pull) and start again. Nothing was changed.\n');
      process.exit(1);
    }
    snapshot('start'); // a copy as it was before this version of the code touched it
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
  delete d.kioskKey; delete d.settings; delete d.sessions; // leftovers from earlier versions
  d.version = DATA_VERSION;
  for (const s of d.students) migrateStudent(s);
  return d;
}

// Older versions kept one check-in/check-out time for every day plus grade and age.
// Students now have a Kumon student ID, subjects, and their own times for each day.
function migrateStudent(s) {
  if (!s.sched || typeof s.sched !== 'object') {
    s.sched = {};
    for (const d of Array.isArray(s.days) ? s.days : []) if (s.inTime && s.outTime) s.sched[String(d)] = { in: s.inTime, out: s.outTime };
  }
  if (typeof s.kumonId !== 'string') s.kumonId = '';
  if (!Array.isArray(s.subjects)) s.subjects = [];
  if (typeof s.notes !== 'string') s.notes = '';
  delete s.days; delete s.inTime; delete s.outTime; delete s.grade; delete s.age;
  return s;
}
function schedOn(s, weekday) { return (s && s.sched && s.sched[String(weekday)]) || null; }
function weekdayOf(dateKey) { return new Date(`${dateKey}T12:00:00`).getDay(); }

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

// Extra copies taken when the server starts and before a restore; the newest few of each are kept.
const SNAPSHOT_RE = /^(start|before-restore)-(\d{4}-\d{2}-\d{2})-(\d{6,9})\.json$/;
function snapshot(kind) {
  if (!fs.existsSync(DATA_FILE)) return;
  const d = new Date();
  const name = `${kind}-${localDateKey(d)}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}.json`;
  try {
    ensureDirs();
    const target = path.join(BACKUP_DIR, name);
    fs.copyFileSync(DATA_FILE, target); fs.chmodSync(target, 0o600);
    const same = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(kind + '-') && SNAPSHOT_RE.test(f)).sort();
    for (const f of same.slice(0, Math.max(0, same.length - KEEP_SNAPSHOTS))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (err) { console.error('copy failed:', err.message); }
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
    ['Mia Chen', '1000001', ['Math', 'Reading'], '15:30', '16:30'], ['Noah Patel', '1000002', ['Math'], '16:00', '16:30'],
    ['Ava Rodriguez', '1000003', ['Reading'], '17:30', '18:00'], ['Liam Nguyen', '1000004', ['Math'], '15:30', '16:00'],
    ['Sofia Kim', '1000005', ['Math', 'Reading'], '18:00', '19:00'], ['Ethan Brooks', '1000006', ['Reading'], '16:30', '17:00'],
  ];
  for (const [name, kumonId, subjects, inTime, outTime] of sample) {
    data.students.push({ id: randomToken(9), createdAt: new Date().toISOString(), name, kumonId, subjects, notes: '', sched: { 1: { in: inTime, out: outTime }, 4: { in: inTime, out: outTime } } });
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
  const sc = schedOn(s, weekdayOf(dateKey));
  const inAt = new Date(rec.in), outAt = new Date(rec.out);
  const v = {
    id: `${studentId}-${rec.in}`,
    date: dateKey,
    studentId,
    name: rec.name || (s && s.name) || 'Unknown',
    kumonId: rec.kumonId ?? (s ? s.kumonId : ''),
    in: rec.in,
    out: rec.out,
    min: Math.max(0, Math.round((outAt - inAt) / 60000)),
    schedIn: rec.schedIn ?? (sc ? sc.in : ''),
    schedOut: rec.schedOut ?? (sc ? sc.out : ''),
    src: rec.outSrc || 'student',
    auto: !!rec.auto,
  };
  v.lateMin = lateMinOf(v);
  return v;
}

// Whole minutes between the scheduled check-in and the actual check-in (0 = on time).
// null when the student had no scheduled time that day (a make-up visit, for example).
function lateMinOf(v) {
  if (v.kind === 'absent' || !v.in || !HHMM.test(v.schedIn || '')) return null;
  if (typeof v.lateMin === 'number') return v.lateMin;
  const due = new Date(`${v.date}T${v.schedIn}:00`);
  return Math.max(0, Math.floor((new Date(v.in) - due) / 60000));
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
        const sc = schedOn(s, weekdayOf(dateKey));
        const sched = rec.schedOut || (sc && sc.out) || '';
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

// ---------------------------------------------------------------- absences
//
// Once a class day is over (30 minutes after the last scheduled check-out), every student who
// was scheduled that day and never checked in gets an "absent" line in the history file.
// A day where nobody at all checked in is taken as a day the center was closed (a holiday),
// so no one is marked absent for it. data.absentDone is the last day already checked.
function addDays(dateKey, n) { const d = new Date(`${dateKey}T12:00:00`); d.setDate(d.getDate() + n); return localDateKey(d); }
function dayClosesAt(dateKey) {
  const wd = weekdayOf(dateKey);
  let last = '19:30';
  for (const s of data.students) { const sc = schedOn(s, wd); if (sc && sc.out > last) last = sc.out; }
  return new Date(new Date(`${dateKey}T${last}:00`).getTime() + 30 * 60000);
}

function markAbsences(now = new Date()) {
  const today = localDateKey(now);
  if (!data.absentDone) { data.absentDone = addDays(today, -1); save(); } // start counting from today, never back-fill
  let d = addDays(data.absentDone, 1);
  let presentByDay = null;
  let changed = false;
  for (let guard = 0; d <= today && guard < 1200; guard++, d = addDays(d, 1)) {
    if (d === today && now < dayClosesAt(d)) break;
    const wd = weekdayOf(d);
    if (ALLOWED_DAYS.includes(wd)) {
      if (!presentByDay) {
        presentByDay = new Map();
        for (const v of history) if (v.kind !== 'absent' && v.date > data.absentDone) { if (!presentByDay.has(v.date)) presentByDay.set(v.date, new Set()); presentByDay.get(v.date).add(v.studentId); }
      }
      const present = new Set(presentByDay.get(d) || []);
      for (const [sid, rec] of Object.entries(data.attendance[d] || {})) if (rec.in) present.add(sid);
      if (present.size) {
        for (const s of data.students) {
          const sc = schedOn(s, wd);
          if (!sc || present.has(s.id)) continue;
          const due = new Date(`${d}T${sc.in}:00`);
          if (new Date(s.createdAt) > due) continue; // added after that class started
          appendVisit({ id: `${s.id}-absent-${d}`, kind: 'absent', date: d, studentId: s.id, name: s.name, kumonId: s.kumonId || '', in: null, out: null, due: due.toISOString(), min: 0, schedIn: sc.in, schedOut: sc.out, src: '', auto: false, lateMin: null });
        }
      }
    }
    data.absentDone = d; changed = true;
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

// status: '' (everything), 'late', 'absent', 'ontime'
function queryHistory({ from, to, studentId, group, status }) {
  const today = localDateKey(new Date());
  let rows = [];
  const present = new Set();
  for (const v of history) {
    if (v.date < from || v.date > to || (studentId && v.studentId !== studentId)) continue;
    if (v.kind !== 'absent') present.add(`${v.studentId}|${v.date}`);
    rows.push(v);
  }
  // visits in progress right now (today only) so the Records page matches the board
  if (to >= today && from <= today) {
    for (const [sid, rec] of Object.entries(data.attendance[today] || {})) {
      if (!rec.in || rec.out || (studentId && sid !== studentId)) continue;
      const s = data.students.find((x) => x.id === sid);
      const sc = schedOn(s, weekdayOf(today));
      const v = { id: `${sid}-${rec.in}`, date: today, studentId: sid, name: rec.name || (s && s.name) || 'Unknown', kumonId: rec.kumonId ?? (s ? s.kumonId : ''), in: rec.in, out: null, min: Math.max(0, Math.round((Date.now() - new Date(rec.in)) / 60000)), schedIn: rec.schedIn ?? (sc ? sc.in : ''), schedOut: rec.schedOut ?? (sc ? sc.out : ''), src: '', auto: false, open: true };
      v.lateMin = lateMinOf(v);
      present.add(`${sid}|${today}`);
      rows.push(v);
    }
  }
  // an absence is dropped if the student did turn up that day after all
  rows = rows.filter((r) => r.kind !== 'absent' || !present.has(`${r.studentId}|${r.date}`));
  const isLate = (r) => r.kind !== 'absent' && (r.lateMin ?? lateMinOf(r)) > 0;
  if (status === 'late') rows = rows.filter(isLate);
  else if (status === 'absent') rows = rows.filter((r) => r.kind === 'absent');
  else if (status === 'ontime') rows = rows.filter((r) => r.kind !== 'absent' && !isLate(r));

  const days = daysBetween(from, to);
  if (!['visit', 'week', 'month', 'year'].includes(group)) group = days <= 35 ? 'visit' : days <= 190 ? 'week' : days <= 800 ? 'month' : 'year';

  const visits = rows.filter((r) => r.kind !== 'absent');
  const students = new Set(rows.map((r) => r.studentId));
  const totalMin = visits.reduce((a, r) => a + (r.open ? 0 : r.min), 0);
  const completed = visits.filter((r) => !r.open).length;
  const summary = { visits: visits.length, open: visits.length - completed, late: visits.filter(isLate).length, absent: rows.length - visits.length, totalMin, students: students.size, avgMin: completed ? Math.round(totalMin / completed) : 0 };

  if (group === 'visit') {
    const at = (r) => r.in || r.due || r.date;
    for (const r of rows) if (r.kind !== 'absent' && r.lateMin == null) r.lateMin = lateMinOf(r);
    rows.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
    return { group, days, summary, total: rows.length, rows: rows.slice(0, MAX_VIEW_ROWS), all: rows };
  }
  const buckets = new Map();
  for (const r of rows) {
    if (r.open) continue;
    const p = periodOf(r.date, group);
    const k = `${p.key}|${r.studentId}`;
    let b = buckets.get(k);
    if (!b) { b = { period: p.key, start: p.start, label: p.label, studentId: r.studentId, name: r.name, kumonId: r.kumonId || '', visits: 0, late: 0, absent: 0, totalMin: 0, auto: 0 }; buckets.set(k, b); }
    if (r.kind === 'absent') b.absent++;
    else { b.visits++; b.totalMin += r.min; if (r.auto) b.auto++; if (isLate(r)) b.late++; }
    b.name = r.name; if (r.kumonId) b.kumonId = r.kumonId;
  }
  const agg = [...buckets.values()].map((b) => Object.assign(b, { avgMin: b.visits ? Math.round(b.totalMin / b.visits) : 0 }));
  agg.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : a.name.localeCompare(b.name)));
  return { group, days, summary, total: agg.length, rows: agg.slice(0, MAX_VIEW_ROWS), all: agg };
}

function fmtMin(min) { const hh = Math.floor(min / 60), mm = min % 60; return hh ? (mm ? `${hh}h ${mm}m` : `${hh}h`) : `${mm} min`; }
function fmtClock(iso) { const d = new Date(iso); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function historyCsv(q) {
  const r = queryHistory(q);
  const rows = [];
  if (r.group === 'visit') {
    rows.push(['Date', 'Weekday', 'Student ID', 'Student', 'Attendance', 'Minutes late', 'Scheduled in', 'Checked in', 'Scheduled out', 'Checked out', 'Minutes', 'Stayed', 'Note']);
    for (const v of r.all) {
      const wd = WEEKDAYS[weekdayOf(v.date)];
      if (v.kind === 'absent') { rows.push([v.date, wd, v.kumonId || '', v.name, 'Absent', '', v.schedIn, '', v.schedOut, '', '', '', '']); continue; }
      const late = v.lateMin ?? lateMinOf(v);
      const note = [v.open ? 'Still here' : v.auto ? 'No check-out recorded; closed at scheduled time' : v.src === 'admin' ? 'Checked out by teacher' : '', late == null ? 'Not scheduled that day' : ''].filter(Boolean).join('; ');
      rows.push([v.date, wd, v.kumonId || '', v.name, late > 0 ? 'Late' : 'Present', late > 0 ? late : '', v.schedIn, fmtClock(v.in), v.schedOut, v.out ? fmtClock(v.out) : '', v.open ? '' : v.min, v.open ? '' : fmtMin(v.min), note]);
    }
  } else {
    rows.push(['Period', 'Period start', 'Student ID', 'Student', 'Visits', 'Late', 'Absent', 'Total minutes', 'Total time', 'Average minutes', 'Visits without check-out']);
    for (const b of r.all) rows.push([b.label, b.start, b.kumonId || '', b.name, b.visits, b.late, b.absent, b.totalMin, fmtMin(b.totalMin), b.avgMin, b.auto]);
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
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* malformed cookie */ }
  }
  return out;
}

function isLocalhost(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function clientIp(req) { return req.socket.remoteAddress || 'unknown'; }

// ---------------------------------------------------------------- sessions & throttling

// Logins are kept in memory only (never written to disk), so restarting the server logs
// everyone out. A login needs two things: the HttpOnly cookie, and a second key the admin page
// keeps in sessionStorage and sends as a header. sessionStorage is gone once the tab is closed,
// so opening the admin page again asks for the password. The page polls every few seconds while
// it is open; once it stops, the login runs out after SESSION_IDLE_MS.
const sessions = new Map(); // sha256(cookie token) -> { key, idleUntil, endsAt }
function tokenHash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function newSession() {
  const token = randomToken(32), key = randomToken(32), now = Date.now();
  sessions.set(tokenHash(token), { key, idleUntil: now + SESSION_IDLE_MS, endsAt: now + SESSION_MAX_MS });
  return { token, key };
}
function getSession(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const id = tokenHash(token);
  const s = sessions.get(id);
  if (!s) return null;
  const now = Date.now();
  if (s.idleUntil < now || s.endsAt < now) { sessions.delete(id); return null; }
  if (!safeEqual(req.headers['x-admin-key'] || '', s.key)) return null;
  s.idleUntil = now + SESSION_IDLE_MS;
  return id;
}
function endSession(req) {
  const token = parseCookies(req).sid;
  if (token) sessions.delete(tokenHash(token));
}
// Logs in this browser tab: cookie in the header, tab key in the body.
function loggedIn(req, res) {
  const { token, key } = newSession();
  return json(res, 200, { ok: true, key }, { 'Set-Cookie': cookieHeader(req, 'sid', token) });
}
setInterval(() => {
  try {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.idleUntil < now || s.endsAt < now) sessions.delete(id);
    for (const [ip, r] of loginFails) if (r.resetAt < now) loginFails.delete(ip);
    closeStaleDays();
    markAbsences();
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

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > limit) { reject(new Error('body too large')); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readBody(req, limit = MAX_BODY_BYTES) {
  const buf = await readRaw(req, limit);
  if (!buf.length) return {};
  let b;
  try { b = JSON.parse(buf.toString('utf8')); } catch (_) { throw new Error('invalid json'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('invalid json');
  return b;
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

const SUBJECT_RE = /^[A-Za-z][A-Za-z ]{0,19}$/;
const KUMON_ID_RE = /^[A-Za-z0-9-]{1,24}$/;

// opts.self: the student being edited (null when adding); opts.allowNoDays: allowed for imports
function validateStudent(b, opts = {}) {
  const errors = [];
  if (!b || typeof b !== 'object') return { errors: ['Bad request.'], value: null };
  const name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) errors.push('Name is required.');
  if (name.length > 60) errors.push('Name is too long.');
  const kumonId = String(b.kumonId ?? '').trim();
  if (kumonId && !KUMON_ID_RE.test(kumonId)) errors.push('Student ID can only have letters, numbers and dashes.');
  const self = opts.self || null;
  if (kumonId && !opts.skipDuplicateCheck && (!self || self.kumonId !== kumonId)) {
    const other = data.students.find((x) => x.kumonId === kumonId && (!self || x.id !== self.id));
    if (other) errors.push(`Student ID ${kumonId} already belongs to ${other.name}.`);
  }
  const subjects = [...new Set((Array.isArray(b.subjects) ? b.subjects : []).map((x) => String(x).trim()).filter((x) => SUBJECT_RE.test(x)))].slice(0, 4);
  const notes = String(b.notes ?? '').trim().slice(0, 300);
  const sched = {};
  const src = b.sched && typeof b.sched === 'object' ? b.sched : {};
  for (const d of ALLOWED_DAYS) {
    const t = src[d] ?? src[String(d)];
    if (!t) continue;
    const label = d === 1 ? 'Monday' : 'Thursday';
    const inT = String(t.in ?? ''), outT = String(t.out ?? '');
    if (!HHMM.test(inT) || !HHMM.test(outT)) { errors.push(`${label}: check-in and check-out times are required.`); continue; }
    if (outT <= inT) { errors.push(`${label}: check-out must be after check-in.`); continue; }
    sched[String(d)] = { in: inT, out: outT };
  }
  if (!errors.length && !Object.keys(sched).length && !opts.allowNoDays) errors.push('Pick Monday, Thursday, or both.');
  return { errors, value: { name, kumonId, subjects, notes, sched } };
}

// ---------------------------------------------------------------- import from a schedule file
//
// Each student in the file is matched to an existing one by student ID (and name when two
// students share an ID), or by name for students who have no ID yet. Matched students get the
// new name, ID, subjects and times; their notes and history are kept. Nobody is deleted.
function planImport(list) {
  const used = new Set();
  const plan = [];
  const fileIds = new Map();
  for (const st of list) if (st.kumonId) fileIds.set(st.kumonId, (fileIds.get(st.kumonId) || 0) + 1);
  const lower = (x) => x.toLowerCase();
  for (const st of list) {
    let match = null;
    if (st.kumonId) {
      const sameId = data.students.filter((x) => x.kumonId === st.kumonId && !used.has(x.id));
      match = sameId.find((x) => lower(x.name) === lower(st.name)) || (sameId.length === 1 && fileIds.get(st.kumonId) === 1 ? sameId[0] : null);
    }
    if (!match) match = data.students.find((x) => !used.has(x.id) && lower(x.name) === lower(st.name) && (!x.kumonId || !st.kumonId || x.kumonId === st.kumonId)) || null;
    if (match) used.add(match.id);
    let action = 'add';
    if (match) {
      const same = match.name === st.name && match.kumonId === st.kumonId && JSON.stringify([...match.subjects].sort()) === JSON.stringify([...st.subjects].sort()) && JSON.stringify(match.sched) === JSON.stringify(st.sched);
      action = same ? 'same' : 'update';
    }
    plan.push({ st, match, action });
  }
  const notInFile = data.students.filter((x) => !used.has(x.id)).map((x) => x.name);
  return { plan, notInFile };
}

function cleanImportList(raw) {
  if (!Array.isArray(raw)) return { errors: ['Bad request.'] };
  if (raw.length > 5000) return { errors: ['Too many students in one import.'] };
  const errors = [], list = [];
  raw.forEach((b, i) => {
    const { errors: e, value } = validateStudent(b, { allowNoDays: true, skipDuplicateCheck: true });
    if (e.length) errors.push(`${(b && b.name) || `Student ${i + 1}`}: ${e.join(' ')}`);
    else list.push(value);
  });
  return { errors, list };
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
    const sc = schedOn(student, now.getDay());
    day[student.id] = { in: iso, out: null, dismissed: false, name: student.name, kumonId: student.kumonId || '', schedIn: sc ? sc.in : '', schedOut: sc ? sc.out : '' };
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
      data.log.push({ ts: iso, studentId: student.id, name: student.name, type: 'out', source });
      archiveRecord(student.id, key, rec);
    }
    rec.dismissed = true;
    day[student.id] = rec;
    save();
    return { ok: true, time: iso, record: rec };
  } else {
    return { error: 'Unknown action.' };
  }
  data.log.push({ ts: iso, studentId: student.id, name: student.name, type: action, source });
  save();
  return { ok: true, time: iso, record: day[student.id] || null };
}

function kioskView() {
  const recs = todayRecords();
  return data.students
    .map((s) => {
      const r = recs[s.id];
      const status = r && r.in && !r.out ? 'in' : r && r.out ? 'done' : 'out';
      return { id: s.id, name: s.name, kumonId: s.kumonId || '', status, since: status === 'in' ? r.in : null };
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

// ---------------------------------------------------------------- restore
//
// A restore replaces the students and the recent day records with the ones in the backup.
// Visit history is only ever added to: visits in the backup that are missing here are put back,
// and nothing already recorded is removed. The admin password is not changed. The current data
// is copied to backups/ first, so a restore can be undone from the same list.

class RestoreError extends Error {}
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const hhmmOr = (v) => (HHMM.test(v || '') ? v : '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Saved copies in data/backups that can be restored from the Settings page.
function savedCopies() {
  let files = [];
  try { files = fs.readdirSync(BACKUP_DIR); } catch (_) {}
  const out = [];
  for (const f of files) {
    const daily = /^kumon-data-\d{4}-\d{2}-\d{2}\.json$/.test(f);
    const snap = f.match(SNAPSHOT_RE);
    if (!daily && !snap) continue;
    const full = path.join(BACKUP_DIR, f);
    let when;
    try { when = fs.statSync(full).mtime.toISOString(); } catch (_) { continue; }
    const parsed = tryParse(full);
    out.push({ file: f, full, kind: daily ? 'daily' : snap[1], when, students: parsed && Array.isArray(parsed.students) ? parsed.students.length : null });
  }
  return out.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
}

function cleanVisit(v) {
  if (!isObj(v) || typeof v.id !== 'string' || v.id.length > 120 || !DATE_RE.test(v.date || '') || !ID_RE.test(v.studentId || '')) return null;
  const out = { id: v.id, date: v.date, studentId: v.studentId, name: str(v.name, 60) || 'Unknown', kumonId: str(v.kumonId, 24), schedIn: hhmmOr(v.schedIn), schedOut: hhmmOr(v.schedOut) };
  if (v.kind === 'absent') {
    if (!isIso(v.due)) return null;
    return Object.assign(out, { kind: 'absent', in: null, out: null, due: v.due, min: 0, src: '', auto: false, lateMin: null });
  }
  if (!isIso(v.in) || !isIso(v.out) || new Date(v.out) < new Date(v.in)) return null;
  Object.assign(out, { in: v.in, out: v.out, min: Math.round((new Date(v.out) - new Date(v.in)) / 60000), src: ['student', 'admin', 'auto'].includes(v.src) ? v.src : 'student', auto: !!v.auto });
  out.lateMin = Number.isInteger(v.lateMin) && v.lateMin >= 0 && v.lateMin < 1440 ? v.lateMin : lateMinOf(out);
  return out;
}

// Checks a backup (a downloaded file or a saved copy) and keeps only fields this program uses.
function cleanBackup(b) {
  if (!isObj(b) || !Array.isArray(b.students)) throw new RestoreError('This is not a backup from this check-in system.');
  if (Number(b.version) > DATA_VERSION) throw new RestoreError('This backup was made by a newer version. Update the code first.');
  if (b.students.length > 5000) throw new RestoreError('This backup has too many students.');
  const skipped = [], students = [], ids = new Set();
  for (const raw of b.students) {
    if (!isObj(raw) || !ID_RE.test(raw.id || '') || ids.has(raw.id)) { skipped.push(`${str(raw && raw.name, 60) || 'A student'}: missing or repeated record ID.`); continue; }
    const { errors, value } = validateStudent(migrateStudent(Object.assign({}, raw)), { allowNoDays: true, skipDuplicateCheck: true });
    if (errors.length) { skipped.push(`${str(raw.name, 60) || 'A student'}: ${errors.join(' ')}`); continue; }
    ids.add(raw.id);
    students.push(Object.assign({ id: raw.id, createdAt: isIso(raw.createdAt) ? raw.createdAt : new Date().toISOString() }, value));
  }
  if (!students.length && b.students.length) throw new RestoreError('None of the students in this backup could be read.');

  const attendance = {};
  for (const [day, recs] of Object.entries(isObj(b.attendance) ? b.attendance : {})) {
    if (!DATE_RE.test(day) || !isObj(recs)) continue;
    for (const [sid, r] of Object.entries(recs)) {
      if (!ids.has(sid) || !isObj(r) || !isIso(r.in) || (r.out != null && !isIso(r.out))) continue;
      const rec = { in: r.in, out: r.out || null, dismissed: !!r.dismissed, name: str(r.name, 60), kumonId: str(r.kumonId, 24), schedIn: hhmmOr(r.schedIn), schedOut: hhmmOr(r.schedOut) };
      if (['student', 'admin', 'auto'].includes(r.outSrc)) rec.outSrc = r.outSrc;
      if (r.auto) rec.auto = true;
      if (r.archived) rec.archived = true;
      (attendance[day] = attendance[day] || {})[sid] = rec;
    }
  }

  const log = [];
  for (const e of Array.isArray(b.log) ? b.log.slice(-20000) : []) {
    if (!isObj(e) || !isIso(e.ts) || !ID_RE.test(e.studentId || '') || !['in', 'out', 'clear', 'dismiss'].includes(e.type)) continue;
    log.push({ ts: e.ts, studentId: e.studentId, name: str(e.name, 60), type: e.type, source: e.source === 'admin' ? 'admin' : 'student' });
  }
  log.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));

  const visits = [];
  const vids = new Set();
  for (const raw of Array.isArray(b.visits) ? b.visits : []) {
    const v = cleanVisit(raw);
    if (v && !vids.has(v.id)) { vids.add(v.id); visits.push(v); }
  }
  return { students, attendance, log, visits, skipped, exported: isIso(b.exported) ? b.exported : null };
}

function applyRestore(r) {
  snapshot('before-restore');
  data.students = r.students;
  data.attendance = r.attendance;
  data.log = r.log;
  for (const v of r.visits) appendVisit(v); // skips visits that are already recorded
  save();
  closeStaleDays();
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
      return json(res, 200, { setupRequired, setupAllowed: setupRequired && isLocalhost(req), loggedIn: !setupRequired && !!getSession(req) });
    }

    if (m === 'POST' && p === '/api/admin/setup') {
      if (!setupRequired) return json(res, 409, { error: 'Already set up.' });
      if (!isLocalhost(req)) return json(res, 403, { error: 'Initial setup must be done on the server computer (localhost).' });
      const b = await readBody(req);
      const pw = String(b.password || '');
      if (pw.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters.' });
      data.adminHash = hashPassword(pw);
      save();
      return loggedIn(req, res);
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
      return loggedIn(req, res);
    }

    if (m === 'POST' && p === '/api/admin/logout') {
      endSession(req);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, 'sid', '', 0) });
    }

    // everything below requires a session
    const sid = getSession(req);
    if (!sid) return json(res, 401, { error: 'Please log in.' });

    if (m === 'GET' && p === '/api/admin/state') {
      return json(res, 200, adminState());
    }

    if (m === 'POST' && p === '/api/admin/import/preview') {
      // The raw file. Read into memory (5 MB at most), parsed, and then thrown away; it is never saved.
      const buf = await readRaw(req, MAX_IMPORT_FILE_BYTES);
      let parsed;
      try { parsed = parseSchedule(buf); }
      catch (err) {
        if (!(err instanceof ImportError)) console.error('import failed:', err.message);
        return json(res, 400, { error: err instanceof ImportError ? err.message : 'This file could not be read. Try saving it as .xlsx or .csv.' });
      }
      const { errors, list } = cleanImportList(parsed.students);
      const warnings = parsed.warnings.concat(errors);
      const { plan, notInFile } = planImport(list);
      return json(res, 200, {
        rows: parsed.rows, warnings: warnings.slice(0, 200), moreWarnings: Math.max(0, warnings.length - 200),
        students: plan.map((x) => Object.assign({ action: x.action }, x.st)), notInFile,
      });
    }

    if (m === 'POST' && p === '/api/admin/import/commit') {
      const b = await readBody(req, MAX_IMPORT_JSON_BYTES);
      const { errors, list } = cleanImportList(b.students);
      if (errors.length) return json(res, 400, { error: errors.slice(0, 5).join(' ') });
      const { plan } = planImport(list);
      const counts = { added: 0, updated: 0, same: 0 };
      const now = new Date().toISOString();
      for (const { st, match, action } of plan) {
        if (action === 'add') data.students.push(Object.assign({ id: randomToken(9), createdAt: now }, st));
        else if (action === 'update') Object.assign(match, { name: st.name, kumonId: st.kumonId, subjects: st.subjects, sched: st.sched });
        counts[action === 'add' ? 'added' : action === 'update' ? 'updated' : 'same']++;
      }
      save();
      return json(res, 200, Object.assign({ ok: true }, counts));
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
        const { errors, value } = validateStudent(await readBody(req), { self: s });
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
      const ip = clientIp(req);
      if (loginThrottled(ip)) return json(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
      if (!verifyPassword(String(b.current || ''), data.adminHash)) { noteLoginFail(ip); return json(res, 401, { error: 'Current password is incorrect.' }); }
      const next = String(b.next || '');
      if (next.length < 8) return json(res, 400, { error: 'New password must be at least 8 characters.' });
      data.adminHash = hashPassword(next);
      save();
      sessions.clear(); // log out every other device
      return loggedIn(req, res);
    }

    if (m === 'GET' && p === '/api/admin/backups') {
      return json(res, 200, { backups: savedCopies().map(({ file, kind, when, students }) => ({ file, kind, when, students })) });
    }

    if (m === 'POST' && p === '/api/admin/restore') {
      const b = await readBody(req, MAX_RESTORE_BYTES);
      let raw;
      if (b.source === 'saved') {
        const copy = savedCopies().find((x) => x.file === b.file); // only names from the list, never a path
        if (!copy) return json(res, 404, { error: 'That saved copy no longer exists.' });
        raw = tryParse(copy.full);
        if (!raw) return json(res, 400, { error: 'That saved copy could not be read.' });
      } else if (b.source === 'file') {
        raw = b.backup;
      } else {
        return json(res, 400, { error: 'Bad request.' });
      }
      let r;
      try { r = cleanBackup(raw); }
      catch (err) {
        if (err instanceof RestoreError) return json(res, 400, { error: err.message });
        throw err;
      }
      const newVisits = r.visits.filter((v) => !historyIds.has(v.id)).length;
      const summary = { students: r.students.length, newVisits, skipped: r.skipped.slice(0, 20), moreSkipped: Math.max(0, r.skipped.length - 20), exported: r.exported };
      if (b.dryRun) return json(res, 200, summary);
      // Restoring replaces every student, so it asks for the password again.
      const ip = clientIp(req);
      if (loginThrottled(ip)) return json(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
      if (!verifyPassword(String(b.password || ''), data.adminHash)) { noteLoginFail(ip); return json(res, 401, { error: 'Incorrect password.', wrongPassword: true }); }
      applyRestore(r);
      return json(res, 200, Object.assign({ ok: true }, summary));
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
      const status = ['late', 'absent', 'ontime'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '';
      const today = localDateKey(new Date());
      const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(new Date(`${v}T12:00:00`).getTime());
      let from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : today;
      let to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : today;
      if (from > to) [from, to] = [to, from];
      const studentId = /^[A-Za-z0-9_-]{1,40}$/.test(url.searchParams.get('student') || '') ? url.searchParams.get('student') : '';
      const group = url.searchParams.get('group') || 'auto';
      if (p === '/api/admin/history') {
        const r = queryHistory({ from, to, studentId, group, status });
        return json(res, 200, { from, to, group: r.group, days: r.days, summary: r.summary, total: r.total, rows: r.rows, truncated: r.total > r.rows.length });
      }
      const { group: g, body } = historyCsv({ from, to, studentId, group, status });
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
try { markAbsences(); } catch (err) { console.error('Could not mark absences:', err.message); }
start();
