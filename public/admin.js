'use strict';
// Admin: Live board (progress bars), Students (add/edit), Records (visit history + CSV), Settings (password).

const $ = (id) => document.getElementById(id);
const views = { setup: $('view-setup'), login: $('view-login'), app: $('view-app') };
const modalRoot = $('modal-root');
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SUBJECTS = ['Math', 'Reading'];
const ALLOWED_DAYS = [1, 4];                                   // Monday and Thursday only
const DAY_FULL = { 1: 'Monday', 4: 'Thursday' };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeRange = (from, to) => { const out = []; for (let m = from; m <= to; m += 30) out.push(hhmm(m)); return out; };
const IN_TIMES = timeRange(15 * 60 + 30, 19 * 60);            // check-in: 3:30 PM .. 7:00 PM every 30 min
const OUT_TIMES = timeRange(16 * 60, 19 * 60 + 30);           // check-out: 4:00 PM .. 7:30 PM every 30 min
const ROUTES = ['board', 'students', 'activity', 'settings'];

const state = { students: [], attendance: {}, log: [], filter: '', boardSig: '', studentsSig: '', statsSig: '', expSig: '', expOpen: false };
$('link-student').prepend(icon('external'));

Clock.start($('clock'));

function show(name) {
  for (const [k, el] of Object.entries(views)) el.classList.toggle('hidden', k !== name);
  $('btn-logout').classList.toggle('hidden', name !== 'app');
  $('link-student').classList.toggle('hidden', name !== 'app');
  $('tabs').classList.toggle('hidden', name !== 'app');
}

// ---------------------------------------------------------------- auth

async function boot() {
  const r = await api('GET', '/api/admin/me');
  if (r.offline) {
    show('login');
    $('login-error').textContent = 'Cannot reach the server. Is it running? Retrying…';
    setTimeout(boot, 3000);
    return;
  }
  $('login-error').textContent = '';
  if (r.data.setupRequired) {
    show('setup');
    $('setup-blocked').classList.toggle('hidden', r.data.setupAllowed);
    $('setup-form').classList.toggle('hidden', !r.data.setupAllowed);
  } else if (!r.data.loggedIn) {
    show('login');
    $('login-form').password.focus();
  } else {
    enterApp();
  }
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('setup-error').textContent = '';
  if (f.password.value !== f.password2.value) { $('setup-error').textContent = 'Passwords do not match.'; return; }
  const r = await api('POST', '/api/admin/setup', { password: f.password.value });
  if (!r.ok) { $('setup-error').textContent = r.data.error || 'Could not save.'; return; }
  f.reset();
  enterApp();
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('login-error').textContent = '';
  const r = await api('POST', '/api/admin/login', { password: f.password.value });
  if (!r.ok) { $('login-error').textContent = r.data.error || 'Login failed.'; return; }
  f.reset();
  enterApp();
});

$('btn-logout').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout');
  stopPolling();
  show('login');
});

function enterApp() {
  show('app');
  state.boardSig = ''; state.studentsSig = ''; state.statsSig = ''; state.expSig = '';
  refresh().then(renderPage);
  startPolling();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(refresh, 3000);
  state.tickTimer = setInterval(() => { if (route() === 'board') renderBoard(); }, 1000);
}
function stopPolling() { clearInterval(state.pollTimer); clearInterval(state.tickTimer); }

async function refresh() {
  const r = await api('GET', '/api/admin/state');
  if (r.status === 401) { stopPolling(); show('login'); return; }
  if (!r.ok) return;
  Clock.sync(r.data.serverTime);
  state.students = r.data.students;
  state.attendance = r.data.attendance;
  state.log = r.data.log;
  renderCurrent();
}

// ---------------------------------------------------------------- routing

function route() { const r = location.hash.replace('#', ''); return ROUTES.includes(r) ? r : 'board'; }
window.addEventListener('hashchange', renderPage);

function renderPage() {
  const r = route();
  for (const name of ROUTES) $(`page-${name}`).classList.toggle('hidden', name !== r);
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.route === r);
  renderCurrent(true);
}
function renderCurrent(force) {
  if (views.app.classList.contains('hidden')) return;
  const r = route();
  if (r === 'board') renderBoard(force);
  else if (r === 'students') renderStudents(force);
  else if (r === 'activity') renderActivity();
  else if (r === 'settings') renderSettings();
}

// ---------------------------------------------------------------- status / progress

// A student's times on a given weekday ({in, out}), or null when they have no class that day.
function schedOn(s, weekday) { return (s.sched && s.sched[weekday]) || null; }
function schedDays(s) { return ALLOWED_DAYS.filter((d) => schedOn(s, d)); }
function idLabel(s) { return s.kumonId ? `ID ${s.kumonId}` : ''; }
function whoLine(s) { return [idLabel(s), (s.subjects || []).join(' & ')].filter(Boolean).join(' · '); }
function lateText(min) { return min >= 60 ? `${fmtDur(min * 60000)} late` : `${min} min late`; }
const TIME_SEC = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
function fmtTimeSec(iso) { return TIME_SEC.format(new Date(iso)); }

// The check-out time that applies to today's visit: the one saved at check-in, else today's schedule.
function dueOut(s, rec, now) {
  const t = rec.schedOut || (schedOn(s, now.getDay()) || {}).out;
  return t || null;
}

// Progress of a checked-in student: fills from 0% at check-in to 100% at scheduled check-out.
function progress(s, rec, now) {
  const inAt = new Date(rec.in);
  const outT = dueOut(s, rec, now);
  const schedOut = outT ? todayAt(outT, now) : new Date(inAt.getTime() + 30 * 60000);
  const end = schedOut > inAt ? schedOut : new Date(inAt.getTime() + 60000);
  const outLabel = outT ? fmtHHMM(outT) : fmtTime(end);
  const total = end - inAt;
  if (rec.out) {
    const outAt = new Date(rec.out);
    return { kind: 'done', cls: 'blue', pct: 100, label: 'Checked out', detail: `${fmtTime(inAt)} – ${fmtTime(outAt)} · stayed ${fmtDur(outAt - inAt)}`, done: true };
  }
  const elapsed = now - inAt;
  const remaining = end - now;
  const frac = elapsed / total;
  const late = rec.schedIn ? Math.floor((inAt - todayAt(rec.schedIn, now)) / 60000) : 0;
  const inText = `In at ${fmtTime(inAt)}${late > 0 ? ` (${lateText(late)})` : ''}`;
  if (frac >= 1) return { kind: 'over', cls: 'red', pct: 100, label: `Time's up · over by ${fmtDur(-remaining)}`, detail: `${inText} · was due out ${outLabel}`, done: true };
  const cls = frac < 0.6 ? 'green' : frac < 0.85 ? 'amber' : 'orange';
  return { kind: 'in', cls, pct: frac * 100, label: `${fmtDur(remaining)} left`, detail: `${inText} · out by ${outLabel}`, done: false };
}

const TEXT_CLS = { red: 't-red', orange: 't-orange', amber: 't-amber', green: 't-green', blue: 't-blue', grey: 't-muted' };

// ---------------------------------------------------------------- live board

function boardRows(now) {
  const rows = [];
  for (const s of state.students) {
    const rec = state.attendance[s.id];
    if (!rec || !rec.in || rec.dismissed) continue;
    rows.push({ s, rec, p: progress(s, rec, now), out: dueOut(s, rec, now) || '99:99' });
  }
  // Stable order (does not shuffle as bars fill): time's up first, then whoever is due out soonest.
  const order = { over: 0, in: 1, done: 2 };
  rows.sort((a, b) => order[a.p.kind] - order[b.p.kind] || a.out.localeCompare(b.out) || a.s.name.localeCompare(b.s.name));
  return rows;
}

function renderBoard(force) {
  const now = Clock.now();
  const rows = boardRows(now);

  const n = (k) => rows.filter((r) => r.p.kind === k).length;
  const finished = rows.filter((r) => r.p.done);
  const statsSig = `${n('in')}:${n('over')}:${n('done')}:${finished.map((r) => r.s.id).join(',')}`;
  if (force || statsSig !== state.statsSig) { // rebuilt only when the numbers change, so the button is never replaced under a tap
    state.statsSig = statsSig;
    const stats = clear($('board-stats'));
    const part = (v, label, cls) => h('span', { class: v && cls ? cls : '' }, h('b', {}, String(v)), ` ${label}`);
    stats.append(part(n('in'), 'here'), ' · ', part(n('over'), "time's up", 't-red'), ' · ', part(n('done'), 'checked out'));
    if (finished.length >= 2) {
      stats.appendChild(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
        for (const r of finished) await api('POST', '/api/admin/attendance', { studentId: r.s.id, action: 'dismiss' });
        refresh();
      } }, 'Remove finished'));
    }
  }

  // Who is scheduled today but has not checked in. Names whose check-in time has passed are marked late.
  const wd = now.getDay();
  const expected = state.students
    .filter((s) => schedOn(s, wd) && !(state.attendance[s.id] && state.attendance[s.id].in))
    .sort((a, b) => schedOn(a, wd).in.localeCompare(schedOn(b, wd).in) || a.name.localeCompare(b.name));
  const isLateNow = (s) => now > todayAt(schedOn(s, wd).in, now);
  const expSig = expected.map((s) => s.id + (isLateNow(s) ? 'L' : '')).join(',') + (state.expOpen ? '+' : '');
  if (force || expSig !== state.expSig) {
    state.expSig = expSig;
    const exp = clear($('board-expected'));
    if (expected.length) {
      const late = expected.filter(isLateNow);
      const shown = state.expOpen ? expected : expected.slice(0, 12);
      exp.append(
        h('h3', { class: 'sec' }, `Not here yet (${expected.length})`, late.length ? h('span', { class: 't-amber' }, ` · ${late.length} late`) : null),
        h('div', { class: 'expected' }, shown.map((s) => {
          return h('span', { class: `exp${isLateNow(s) ? ' late' : ''}` }, s.name, h('span', { class: 'tm' }, fmtHHMM(schedOn(s, wd).in)));
        }),
        expected.length > 12 ? h('button', { class: 'linkbtn', type: 'button', onclick: () => { state.expOpen = !state.expOpen; renderBoard(true); } }, state.expOpen ? 'Show fewer' : `+ ${expected.length - 12} more`) : null));
    }
  }

  const list = $('board-list');
  const sig = rows.map((r) => `${r.s.id}:${r.p.kind}:${r.s.name}:${r.s.kumonId}:${r.out}`).join('|');
  if (!force && sig === state.boardSig && list.childElementCount === rows.length) {
    rows.forEach(({ p }, i) => updateBar(list.children[i], p));
    return;
  }
  state.boardSig = sig;
  clear(list);
  if (!rows.length) {
    list.appendChild(h('div', { class: 'empty' }, icon('clipboard'), h('b', {}, 'No one is checked in'), h('span', {}, 'Students appear here when they check in.')));
    return;
  }
  for (const { s, rec, p } of rows) {
    const acts = [];
    if (p.kind === 'in') acts.push(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => attendance(s, 'out') }, 'Check out'));
    else if (p.kind === 'over') acts.push(h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => attendance(s, 'dismiss') }, 'Check out & remove'));
    else acts.push(h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => attendance(s, 'dismiss') }, 'Remove'));
    list.appendChild(
      h('div', { class: `srow ${p.cls}${p.done ? ' done' : ''}`, 'data-id': s.id },
        h('div', { class: 'who' },
          h('div', { class: 'nm' }, s.name),
          h('div', { class: 'sub' }, whoLine(s))),
        h('div', { class: 'sched' }, boardSched(s, rec, now)),
        h('div', { class: 'prog' },
          h('div', { class: 'lbl' }, h('span', { class: TEXT_CLS[p.cls] }, p.label), h('span', { class: 'det' }, h('span', { class: 'pct' }, `${Math.round(p.pct)}%`))),
          h('div', { class: 'track' }, h('div', { class: `fill ${p.cls}${p.kind === 'over' ? ' over' : ''}`, style: { width: p.pct.toFixed(1) + '%' } })),
          h('div', { class: 'help', style: { marginTop: '4px' } }, p.detail)),
        h('div', { class: 'acts' }, acts)));
  }
}

function boardSched(s, rec, now) {
  const out = dueOut(s, rec, now);
  if (!out) return [h('div', {}, h('b', {}, `In ${fmtTime(rec.in)}`)), h('div', {}, 'No class scheduled today')];
  const end = todayAt(out, now), inAt = new Date(rec.in);
  return [h('div', {}, h('b', {}, `${fmtTime(inAt)} → ${fmtHHMM(out)}`)),
    h('div', {}, end > inAt ? `${fmtDur(end - inAt)} session` : 'Arrived after check-out time')];
}

function updateBar(row, p) {
  const lbl = row.querySelector('.lbl');
  lbl.children[0].textContent = p.label; lbl.children[0].className = TEXT_CLS[p.cls];
  row.querySelector('.pct').textContent = `${Math.round(p.pct)}%`;
  const fill = row.querySelector('.fill');
  fill.className = `fill ${p.cls}${p.kind === 'over' ? ' over' : ''}`;
  fill.style.width = p.pct.toFixed(1) + '%';
  row.className = `srow ${p.cls}${p.done ? ' done' : ''}`;
  row.querySelector('.prog .help').textContent = p.detail;
}

// ---------------------------------------------------------------- students page

function renderStudents(force) {

  const q = state.filter.trim().toLowerCase();
  const now = Clock.now();
  const list = $('student-list');
  const rows = state.students
    .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.kumonId || '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sig = rows.map((s) => [s.id, s.name, s.kumonId, (s.subjects || []).join(), s.notes, JSON.stringify(s.sched), JSON.stringify(state.attendance[s.id] || null)].join('\u0001')).join('\u0002') + `#${state.students.length}`;
  if (!force && sig === state.studentsSig) return;
  state.studentsSig = sig;
  $('student-count').textContent = state.students.length ? `${state.students.length} student${state.students.length === 1 ? '' : 's'}` : '';
  clear(list);
  if (!rows.length) {
    list.appendChild(h('div', { class: 'empty' }, icon('people'), h('b', {}, state.students.length ? 'No matches' : 'No students yet')));
    return;
  }
  for (const s of rows) {
    const rec = state.attendance[s.id];
    const status = rec && rec.in && !rec.out ? ['Checked in now', 't-green'] : rec && rec.out ? ['Checked out today', 't-blue'] : schedOn(s, now.getDay()) ? ['Expected today', 't-muted'] : ['Not scheduled today', 't-muted'];
    const acts = [
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => showRecordsFor(s) }, 'Records'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openModal(h('div', {}, h('h2', {}, 'Edit student'), studentForm(s, () => { closeModal(); toast('Saved'); refresh(); }))) }, 'Edit')];
    if (rec && rec.in && !rec.out) {
      acts.unshift(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
        if (await confirmDialog({ title: `Undo ${s.name}'s check-in?`, ok: 'Undo' })) attendance(s, 'clear');
      } }, 'Undo check-in'));
    } else {
      acts.unshift(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => attendance(s, 'in') }, 'Check in'));
    }
    list.appendChild(
      h('div', { class: 'srow simple' },
        h('div', { class: 'who' },
          h('div', { class: 'nm' }, s.name),
          h('div', { class: 'sub' }, [whoLine(s), s.notes || null].filter(Boolean).join(' · '))),
        h('div', { class: 'sched' },
          schedDays(s).length
            ? schedDays(s).map((d) => h('div', {}, `${DAY_NAMES[d]} `, h('b', {}, `${fmtHHMM(schedOn(s, d).in)} – ${fmtHHMM(schedOn(s, d).out)}`)))
            : h('div', { class: 't-amber' }, 'No class times'),
          h('div', { class: status[1] }, status[0])),
        h('div', { class: 'acts' }, acts)));
  }
}

$('btn-add').addEventListener('click', () => openModal(h('div', {}, h('h2', {}, 'Add student'), studentForm(null, () => { closeModal(); toast('Student added'); refresh(); }))));
$('btn-import').addEventListener('click', openImport);
$('filter').addEventListener('input', (e) => { state.filter = e.target.value; renderStudents(true); });

function select(options, value) {
  return h('select', { class: 'input' }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
}

// Builds the add/edit form. onSaved(student) runs after a successful save.
function studentForm(existing, onSaved) {
  const s = existing || { name: '', kumonId: '', subjects: [], notes: '', sched: { 1: { in: '15:30', out: '16:00' }, 4: { in: '15:30', out: '16:00' } } };
  const err = h('div', { class: 'error' });

  const name = h('input', { class: 'input', type: 'text', value: s.name, required: true, maxlength: 60, autocomplete: 'off', placeholder: 'First and last name' });
  const kumonId = h('input', { class: 'input', type: 'text', value: s.kumonId || '', maxlength: 24, autocomplete: 'off', inputmode: 'numeric', placeholder: 'e.g. 8402550741655', pattern: '[A-Za-z0-9-]*' });
  const notes = h('input', { class: 'input', type: 'text', value: s.notes || '', maxlength: 300, placeholder: 'Optional' });
  const subjectBoxes = SUBJECTS.map((x) => h('label', {}, h('input', { type: 'checkbox', value: x, checked: (s.subjects || []).includes(x) }), x));
  const timeOpts = (times, extra) => {
    const list = times.includes(extra) || !extra ? times : [...times, extra].sort();
    return list.map((t) => ({ value: t, label: fmtHHMM(t) }));
  };

  // one line per class day: [x] Monday  in [..]  out [..]  (30 min)
  const dayRows = ALLOWED_DAYS.map((d) => {
    const cur = schedOn(s, d);
    const on = h('input', { type: 'checkbox', checked: !!cur });
    const inTime = select(timeOpts(IN_TIMES, cur && cur.in), cur ? cur.in : '15:30');
    const outTime = select(timeOpts(OUT_TIMES, cur && cur.out), cur ? cur.out : '16:00');
    const len = h('span', { class: 'help' });
    const update = () => {
      inTime.disabled = outTime.disabled = !on.checked;
      len.textContent = !on.checked ? 'No class' : outTime.value > inTime.value ? fmtDur(todayAt(outTime.value, new Date()) - todayAt(inTime.value, new Date())) : 'Check-out must be after check-in';
    };
    inTime.addEventListener('change', () => {
      if (outTime.value <= inTime.value) { const next = OUT_TIMES.find((t) => t > inTime.value); if (next) outTime.value = next; }
      update();
    });
    outTime.addEventListener('change', update); on.addEventListener('change', update); update();
    return { d, on, inTime, outTime, el: h('div', { class: 'dayrow' }, h('label', { class: 'daycheck' }, on, DAY_FULL[d]), inTime, h('span', { class: 'help' }, 'to'), outTime, len) };
  });

  const form = h('form', { onsubmit: submit },
    h('label', { class: 'field' }, 'Full name', name),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Student ID', kumonId), h('label', { class: 'field' }, 'Notes', notes)),
    h('div', { class: 'field' }, 'Subjects', h('div', { class: 'days' }, subjectBoxes)),
    h('div', { class: 'field' }, 'Class times', h('div', { class: 'dayrows' }, dayRows.map((r) => r.el))),
    err,
    h('div', { class: 'actions' },
      existing ? h('button', { class: 'btn btn-danger', type: 'button', onclick: remove }, 'Delete') : null,
      h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save changes' : 'Add student')));

  async function submit(e) {
    e.preventDefault();
    err.textContent = '';
    const sched = {};
    for (const r of dayRows) if (r.on.checked) sched[r.d] = { in: r.inTime.value, out: r.outTime.value };
    const body = {
      name: name.value, kumonId: kumonId.value.trim(), notes: notes.value,
      subjects: subjectBoxes.map((l) => l.firstChild).filter((c) => c.checked).map((c) => c.value),
      sched,
    };
    const r = existing ? await api('PUT', `/api/admin/students/${existing.id}`, body) : await api('POST', '/api/admin/students', body);
    if (!r.ok) { err.textContent = r.data.error || 'Could not save.'; return; }
    onSaved(r.data.student);
  }
  async function remove() {
    if (!await confirmDialog({ title: `Delete ${existing.name}?`, body: 'They are taken off the student page. Their past visits stay in Records.', ok: 'Delete', danger: true })) return;
    const r = await api('DELETE', `/api/admin/students/${existing.id}`);
    if (!r.ok) { err.textContent = r.data.error || 'Could not delete.'; return; }
    closeModal();
    toast(`${existing.name} deleted`);
    refresh();
  }
  return form;
}

// ---------------------------------------------------------------- import from a schedule file

function openImport() {
  const body = h('div', {});
  const fileInput = h('input', { type: 'file', accept: '.xls,.xlsx,.csv,.tsv,.txt,.pdf', class: 'hidden' });
  const err = h('div', { class: 'error' });

  function pickStep() {
    clear(body).append(
      h('h2', {}, 'Import students'),
      h('p', { class: 'sub' }, 'Upload the class schedule. Excel (.xls or .xlsx), CSV, or a PDF printed from the spreadsheet all work.'),
      h('div', { class: 'dropzone', tabindex: '0', role: 'button',
        onclick: () => fileInput.click(),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } },
        ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
        ondragleave: (e) => e.currentTarget.classList.remove('over'),
        ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); } },
        h('b', {}, 'Choose a file'), h('span', { class: 'help' }, 'or drag it here')),
      h('p', { class: 'help', style: { marginTop: '12px' } },
        'Columns: StudentID, FirstName, LastName, Subject, Monday, Thursday. One row per subject; a time like 6:30pm, or n/a. ',
        'Each student arrives at their first subject time and leaves 30 minutes after their last one starts. ',
        'Students already on the site are matched by ID and updated. No one is deleted.'),
      err, fileInput,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel')));
  }

  async function upload(file) {
    err.textContent = '';
    if (file.size > 5 * 1024 * 1024) { err.textContent = 'That file is over 5 MB.'; return; }
    clear(body).append(h('h2', {}, 'Import students'), h('div', { class: 'result' }, h('div', { class: 'spinner' }), h('div', { class: 'time' }, `Reading ${file.name}…`)));
    let r;
    try {
      const res = await fetch('/api/admin/import/preview', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-Requested-With': 'kumon', 'Content-Type': 'application/octet-stream' }, body: file });
      r = { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    } catch (_) { r = { ok: false, data: { error: 'Not connected to the server.' } }; }
    if (r.status === 401) { closeModal(); stopPolling(); show('login'); return; }
    if (!r.ok) { pickStep(); err.textContent = r.data.error || 'Could not read the file.'; return; }
    previewStep(file.name, r.data);
  }

  function previewStep(fileName, d) {
    const n = (a) => d.students.filter((x) => x.action === a).length;
    const ACTION = { add: ['New', 't-green'], update: ['Updated', 't-blue'], same: ['No change', 't-muted'] };
    const dayCell = (x, day) => (x.sched[day] ? `${fmtHHMM(x.sched[day].in)} – ${fmtHHMM(x.sched[day].out)}` : '—');
    const toSave = d.students.filter((x) => x.action !== 'same');
    clear(body).append(...[
      h('h2', {}, 'Check before importing'),
      h('p', { class: 'sub' }, `${fileName}: ${d.students.length} students from ${d.rows} rows. `,
        h('b', {}, `${n('add')} new`), ', ', h('b', {}, `${n('update')} updated`), `, ${n('same')} unchanged.`),
      d.warnings.length ? h('div', { class: 'warnbox' }, h('b', {}, 'Please check'),
        h('ul', {}, d.warnings.map((w) => h('li', {}, w))), d.moreWarnings ? h('div', { class: 'help' }, `and ${d.moreWarnings} more`) : null) : null,
      d.notInFile.length ? h('p', { class: 'help' }, `${d.notInFile.length} student${d.notInFile.length === 1 ? ' is' : 's are'} on the site but not in this file (${d.notInFile.slice(0, 5).join(', ')}${d.notInFile.length > 5 ? '…' : ''}). They are left as they are.`) : null,
      h('div', { class: 'tablewrap importtable' }, h('table', { class: 'log' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Student'), h('th', {}, 'ID'), h('th', {}, 'Subjects'), h('th', {}, 'Monday'), h('th', {}, 'Thursday'), h('th', {}, ''))),
        h('tbody', {}, d.students.map((x) => h('tr', {},
          h('td', {}, h('b', {}, x.name)), h('td', { class: 'num' }, x.kumonId || '—'), h('td', {}, x.subjects.join(' & ') || '—'),
          h('td', { class: 'num' }, dayCell(x, 1)), h('td', { class: 'num' }, dayCell(x, 4)),
          h('td', { class: `num ${ACTION[x.action][1]}` }, ACTION[x.action][0])))))),
      err,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: pickStep }, 'Choose another file'),
        h('button', { class: 'btn btn-primary', type: 'button', disabled: !toSave.length, onclick: commit }, toSave.length ? `Import ${toSave.length} student${toSave.length === 1 ? '' : 's'}` : 'Nothing to change'))].filter(Boolean));

    async function commit(e) {
      const btn = e.currentTarget;
      btn.disabled = true;
      err.textContent = '';
      const r = await api('POST', '/api/admin/import/commit', { students: d.students.map(({ action, ...x }) => x) });
      if (!r.ok) { err.textContent = r.data.error || 'Could not import.'; btn.disabled = false; return; }
      closeModal();
      toast([r.data.added ? `${r.data.added} added` : '', r.data.updated ? `${r.data.updated} updated` : ''].filter(Boolean).join(', ') || 'Nothing changed', 4000);
      state.studentsSig = '';
      refresh();
    }
  }

  fileInput.addEventListener('change', () => { if (fileInput.files[0]) upload(fileInput.files[0]); fileInput.value = ''; });
  pickStep();
  openModal(body, 'modal-wide');
}

// ---------------------------------------------------------------- records page

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hist = { from: '', to: '', student: '', status: '', group: 'auto', sig: '', logSig: '', loading: false, preset: 'month' };

function presetRange(name, now) {
  const t = new Date(now); t.setHours(12, 0, 0, 0);
  const a = new Date(t);
  if (name === 'today') return [isoDate(t), isoDate(t)];
  if (name === 'week') { a.setDate(a.getDate() - ((a.getDay() + 6) % 7)); return [isoDate(a), isoDate(t)]; }
  if (name === 'month') { a.setDate(1); return [isoDate(a), isoDate(t)]; }
  if (name === 'year') { a.setMonth(0, 1); return [isoDate(a), isoDate(t)]; }
  a.setFullYear(a.getFullYear() - 3); return [isoDate(a), isoDate(t)]; // "all": the last 3 years
}

function initRecords() {
  const presets = $('hist-presets');
  if (presets.firstChild) return;
  for (const [key, label] of [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['all', 'Last 3 years']]) {
    presets.appendChild(h('button', { class: 'preset', type: 'button', 'data-preset': key, onclick: () => {
      [hist.from, hist.to] = presetRange(key, Clock.now()); hist.preset = key; hist.group = 'auto';
      $('hist-from').value = hist.from; $('hist-to').value = hist.to;
      loadRecords();
    } }, label));
  }
  [hist.from, hist.to] = presetRange('month', Clock.now());
  $('hist-from').value = hist.from; $('hist-to').value = hist.to;
  const onDates = () => { hist.from = $('hist-from').value || hist.from; hist.to = $('hist-to').value || hist.to; hist.preset = ''; hist.group = 'auto'; loadRecords(); };
  $('hist-from').addEventListener('change', onDates); $('hist-to').addEventListener('change', onDates);
  $('hist-student').addEventListener('change', (e) => { hist.student = e.target.value; loadRecords(); });
  $('hist-status').addEventListener('change', (e) => { hist.status = e.target.value; loadRecords(); });
  for (const [key, label] of [['visit', 'Each visit'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']]) {
    $('hist-group').appendChild(h('button', { type: 'button', 'data-group': key, onclick: () => { hist.group = key; loadRecords(); } }, label));
  }
  $('btn-export').addEventListener('click', () => { location.href = `/api/admin/export.csv?${recordParams()}`; });
}

// "1h 28m" for short totals, "1,234 h" once the number of hours gets large.
function fmtHours(min, big) { return (big == null ? min : big) >= 100 * 60 ? `${Math.round(min / 60).toLocaleString()} h` : fmtDur(min * 60000); }

function recordParams() {
  const q = new URLSearchParams({ from: hist.from, to: hist.to, group: hist.group });
  if (hist.student) q.set('student', hist.student);
  if (hist.status) q.set('status', hist.status);
  return q.toString();
}

function fillStudentFilter() {
  const sel = $('hist-student');
  const sig = state.students.map((s) => s.id + s.name).join('|');
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  clear(sel).append(h('option', { value: '' }, 'All students'), ...[...state.students].sort((a, b) => a.name.localeCompare(b.name)).map((s) => h('option', { value: s.id, selected: s.id === hist.student }, s.name)));
  if (hist.student && !state.students.some((s) => s.id === hist.student)) { hist.student = ''; sel.value = ''; }
}

async function loadRecords() {
  for (const b of document.querySelectorAll('#hist-presets .preset')) b.classList.toggle('active', b.dataset.preset === hist.preset);
  const params = recordParams();
  hist.loading = true;
  $('hist-note').textContent = 'Loading…';
  const r = await api('GET', `/api/admin/history?${params}`);
  hist.loading = false;
  if (!r.ok) { $('hist-note').textContent = r.data.error || 'Could not load records.'; return; }
  if (params !== recordParams()) return; // filters changed while loading
  hist.sig = params + ':' + hist.logSig;
  renderRecords(r.data);
}

function renderRecords(d) {
  const sum = d.summary;
  const stats = clear($('hist-stats'));
  const part = (v, label) => h('span', {}, h('b', {}, String(v)), ` ${label}`);
  const tinted = (v, label, cls) => h('span', { class: v ? cls : '' }, h('b', {}, v.toLocaleString()), ` ${label}`);
  stats.append(part(sum.visits.toLocaleString(), sum.visits === 1 ? 'visit' : 'visits'), ' · ', tinted(sum.late, 'late', 't-amber'), ' · ', tinted(sum.absent, 'absent', 't-red'), ' · ',
    part(fmtHours(sum.totalMin), 'in total'), ' · ', part(sum.avgMin ? fmtDur(sum.avgMin * 60000) : '–', 'average'));
  for (const b of $('hist-group').children) b.classList.toggle('active', b.dataset.group === d.group);
  $('hist-note').textContent = d.truncated ? `Showing ${d.rows.length.toLocaleString()} of ${d.total.toLocaleString()} rows. The CSV has all of them.` : '';

  const head = clear($('hist-head')), body = clear($('hist-body'));
  if (!d.rows.length) {
    head.appendChild(h('tr', {}, h('th', {}, 'Nothing in this range')));
    body.appendChild(h('tr', {}, h('td', { class: 't-muted' }, 'Try a wider date range, a different student, or Attendance: everyone.')));
    return;
  }
  if (d.group === 'visit') {
    head.appendChild(h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Student'), h('th', {}, 'Attendance'), h('th', {}, 'Class time'), h('th', {}, 'Checked in'), h('th', {}, 'Checked out'), h('th', {}, 'Stayed'), h('th', {}, 'Note')));
    let lastDate = '';
    for (const v of d.rows) {
      const dateCell = v.date === lastDate ? '' : new Date(`${v.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: v.date.slice(0, 4) === d.to.slice(0, 4) ? undefined : 'numeric' });
      lastDate = v.date;
      const classTime = v.schedIn && v.schedOut ? `${fmtHHMM(v.schedIn)} – ${fmtHHMM(v.schedOut)}` : '—';
      if (v.kind === 'absent') {
        body.appendChild(h('tr', { class: 'absent' },
          h('td', { class: 'date' }, dateCell), h('td', {}, nameCell(v)),
          h('td', {}, h('span', { class: 'tag red' }, 'Absent')),
          h('td', { class: 'num' }, classTime), h('td', { class: 'num t-muted' }, '—'), h('td', { class: 'num t-muted' }, '—'), h('td', { class: 'num t-muted' }, '—'),
          h('td', {}, '')));
        continue;
      }
      const att = v.lateMin == null ? h('span', { class: 't-muted' }, 'Extra visit') : v.lateMin > 0 ? h('span', { class: 'tag amber' }, lateText(v.lateMin)) : h('span', { class: 'tag green' }, 'On time');
      const note = v.open ? ['Still here', 't-green'] : v.auto ? ['No check-out', 't-amber'] : v.src === 'admin' ? ['Checked out by teacher', 't-muted'] : ['', ''];
      body.appendChild(h('tr', { class: v.open ? 'open' : '' },
        h('td', { class: 'date' }, dateCell),
        h('td', {}, nameCell(v)),
        h('td', {}, att),
        h('td', { class: 'num' }, classTime),
        h('td', { class: 'num', title: new Date(v.in).toLocaleString() }, fmtTimeSec(v.in)),
        h('td', { class: 'num', title: v.out ? new Date(v.out).toLocaleString() : '' }, v.out ? fmtTimeSec(v.out) : '—'),
        h('td', { class: 'num' }, v.open ? h('span', { class: 't-green' }, `${fmtDur(v.min * 60000)} so far`) : fmtDur(v.min * 60000)),
        h('td', { class: note[1] }, note[0])));
    }
  } else {
    const maxMin = Math.max(1, ...d.rows.map((r) => r.totalMin));
    head.appendChild(h('tr', {}, h('th', {}, d.group === 'week' ? 'Week' : d.group === 'month' ? 'Month' : 'Year'), h('th', {}, 'Student'), h('th', { class: 'num' }, 'Visits'), h('th', { class: 'num' }, 'Late'), h('th', { class: 'num' }, 'Absent'), h('th', {}, 'Total time'), h('th', { class: 'num' }, 'Average'), h('th', { class: 'num' }, 'No check-out')));
    let lastPeriod = '';
    for (const b of d.rows) {
      const periodCell = b.period === lastPeriod ? '' : b.label; lastPeriod = b.period;
      body.appendChild(h('tr', {},
        h('td', { class: 'date' }, periodCell),
        h('td', {}, nameCell(b)),
        h('td', { class: 'num' }, String(b.visits)),
        h('td', { class: `num ${b.late ? 't-amber' : 't-muted'}` }, b.late ? String(b.late) : '–'),
        h('td', { class: `num ${b.absent ? 't-red' : 't-muted'}` }, b.absent ? String(b.absent) : '–'),
        h('td', {}, h('span', { class: 'meter' }, h('span', { class: 'meter-fill', style: { width: `${Math.round((b.totalMin / maxMin) * 100)}%` } }), h('span', { class: 'meter-txt' }, fmtHours(b.totalMin, maxMin)))),
        h('td', { class: 'num' }, b.visits ? fmtDur(b.avgMin * 60000) : '–'),
        h('td', { class: `num ${b.auto ? 't-amber' : 't-muted'}` }, b.auto ? String(b.auto) : '–')));
    }
  }
}

// Student name in a records row. Clicking it narrows the view to that student (if they still exist).
function nameCell(r) {
  const label = [h('b', {}, r.name), r.kumonId ? h('span', { class: 't-muted' }, ` · ${r.kumonId}`) : null];
  if (hist.student || !state.students.some((s) => s.id === r.studentId)) return h('span', {}, label);
  return h('button', { class: 'namebtn', type: 'button', title: `Only ${r.name}`, onclick: () => { hist.student = r.studentId; $('hist-student').value = r.studentId; loadRecords(); } }, label);
}

// Called every 3 s while the page is open; reloads the table only when something changed.
function renderActivity() {
  initRecords();
  fillStudentFilter();
  hist.logSig = state.log.length ? `${state.log.length}:${state.log[0].ts}` : '0';
  if (!hist.loading && hist.sig !== recordParams() + ':' + hist.logSig) loadRecords();
}

// Jump to one student's records from the Students page.
function showRecordsFor(s) {
  initRecords();
  hist.student = s.id; hist.preset = 'year'; hist.group = 'auto'; [hist.from, hist.to] = presetRange('year', Clock.now());
  $('hist-from').value = hist.from; $('hist-to').value = hist.to;
  location.hash = '#activity';
  fillStudentFilter(); $('hist-student').value = s.id;
  loadRecords();
}

// ---------------------------------------------------------------- settings page

function renderSettings() {
  const bk = $('backup-panel');
  if (!bk.firstChild) {
    bk.append(
      h('h3', {}, 'Backup'),
      h('p', { class: 'help' }, 'Everything is saved automatically in the data folder, with daily copies kept for 30 days. Download a copy to keep on a USB drive or another computer.'),
      h('a', { class: 'btn', href: '/api/admin/backup', download: '' }, 'Download backup'));
  }

  if ($('password-panel').firstChild) return; // keep what the teacher is typing
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const next2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const err = h('div', { class: 'error' });
  clear($('password-panel')).append(
    h('h3', {}, 'Change admin password'),
    h('form', { onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        if (next.value !== next2.value) { err.textContent = 'New passwords do not match.'; return; }
        const r = await api('POST', '/api/admin/password', { current: current.value, next: next.value });
        if (!r.ok) { err.textContent = r.data.error || 'Could not change password.'; return; }
        current.value = next.value = next2.value = ''; toast('Password changed');
      } },
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Current password', current),
        h('label', { class: 'field' }, 'New password', next),
        h('label', { class: 'field' }, 'Repeat new password', next2)),
      err,
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save password')));
}

// ---------------------------------------------------------------- shared actions

async function attendance(s, action) {
  const r = await api('POST', '/api/admin/attendance', { studentId: s.id, action });
  if (!r.ok) toast(r.data.error || 'Failed');
  else if (action === 'clear') toast('Check-in undone');
  refresh();
}

function openModal(content, cls) {
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } }, h('div', { class: `modal${cls ? ' ' + cls : ''}`, role: 'dialog', 'aria-modal': 'true' }, content));
  clear(modalRoot).appendChild(overlay);
}
function closeModal() { clear(modalRoot); }

// In-page confirmation (instead of the browser's own popup). Layers above an open modal.
function confirmDialog({ title, body, ok, danger }) {
  return new Promise((resolve) => {
    let overlay;
    const done = (v) => { overlay.remove(); resolve(v); };
    const okBtn = h('button', { class: `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`, type: 'button', onclick: () => done(true) }, ok || 'OK');
    overlay = h('div', { class: 'overlay confirm', onclick: (e) => { if (e.target === overlay) done(false); } },
      h('div', { class: 'modal modal-sm', role: 'alertdialog', 'aria-modal': 'true' },
        h('h2', {}, title),
        body ? h('p', { class: 'sub' }, body) : null,
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
          okBtn)));
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    modalRoot.appendChild(overlay);
    okBtn.focus();
  });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

boot();
