'use strict';
// Admin: Live board (progress bars), Students (add/edit), Activity (log + CSV), Settings (password).

const $ = (id) => document.getElementById(id);
const views = { setup: $('view-setup'), login: $('view-login'), app: $('view-app') };
const modalRoot = $('modal-root');
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GRADES = ['Pre-K', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const AGES = Array.from({ length: 17 }, (_, i) => String(i + 3)); // 3..19
const ALLOWED_DAYS = [1, 4];                                   // Monday and Thursday only
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeRange = (from, to) => { const out = []; for (let m = from; m <= to; m += 30) out.push(hhmm(m)); return out; };
const IN_TIMES = timeRange(15 * 60 + 30, 19 * 60);            // check-in: 3:30 PM .. 7:00 PM every 30 min
const OUT_TIMES = timeRange(16 * 60, 19 * 60 + 30);           // check-out: 4:00 PM .. 7:30 PM every 30 min
const ROUTES = ['board', 'students', 'activity', 'settings'];

const state = { students: [], attendance: {}, log: [], addresses: [], filter: '', boardSig: '', studentsSig: '', statsSig: '' };
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
  state.boardSig = ''; state.studentsSig = ''; state.statsSig = '';
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
  state.addresses = r.data.addresses || [];
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

function gradeLabel(g) { return !g ? '' : /^\d+$/.test(g) ? `Grade ${g}` : g; }

// Progress of a checked-in student: fills from 0% at check-in to 100% at scheduled check-out.
function progress(s, rec, now) {
  const inAt = new Date(rec.in);
  const schedOut = todayAt(s.outTime, now);
  const end = schedOut > inAt ? schedOut : new Date(inAt.getTime() + 60000);
  const total = end - inAt;
  if (rec.out) {
    const outAt = new Date(rec.out);
    return { kind: 'done', cls: 'blue', pct: 100, label: 'Checked out', detail: `${fmtTime(inAt)} – ${fmtTime(outAt)} · stayed ${fmtDur(outAt - inAt)}`, done: true };
  }
  const elapsed = now - inAt;
  const remaining = end - now;
  const frac = elapsed / total;
  if (frac >= 1) return { kind: 'over', cls: 'red', pct: 100, label: `Time's up · over by ${fmtDur(-remaining)}`, detail: `In at ${fmtTime(inAt)} · was due out ${fmtHHMM(s.outTime)}`, done: true };
  const cls = frac < 0.6 ? 'green' : frac < 0.85 ? 'amber' : 'orange';
  return { kind: 'in', cls, pct: frac * 100, label: `${fmtDur(remaining)} left`, detail: `In at ${fmtTime(inAt)} · out by ${fmtHHMM(s.outTime)}`, done: false };
}

const TEXT_CLS = { red: 't-red', orange: 't-orange', amber: 't-amber', green: 't-green', blue: 't-blue', grey: 't-muted' };

// ---------------------------------------------------------------- live board

function boardRows(now) {
  const rows = [];
  for (const s of state.students) {
    const rec = state.attendance[s.id];
    if (!rec || !rec.in || rec.dismissed) continue;
    rows.push({ s, rec, p: progress(s, rec, now) });
  }
  // Stable order (does not shuffle as bars fill): time's up first, then whoever is due out soonest.
  const order = { over: 0, in: 1, done: 2 };
  rows.sort((a, b) => order[a.p.kind] - order[b.p.kind] || a.s.outTime.localeCompare(b.s.outTime) || a.s.name.localeCompare(b.s.name));
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
    const chip = (label, v) => h('span', { class: 'chip' }, h('b', {}, String(v)), ` ${label}`);
    stats.append(chip('here now', n('in')), chip("time's up", n('over')), chip('checked out', n('done')));
    if (finished.length >= 2) {
      stats.appendChild(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
        for (const r of finished) await api('POST', '/api/admin/attendance', { studentId: r.s.id, action: 'dismiss' });
        refresh();
      } }, 'Remove finished'));
    }
  }

  // Who is scheduled today but has not checked in. Names whose check-in time has passed are marked late.
  const expected = state.students
    .filter((s) => s.days.includes(now.getDay()) && !(state.attendance[s.id] && state.attendance[s.id].in))
    .sort((a, b) => a.inTime.localeCompare(b.inTime) || a.name.localeCompare(b.name));
  const exp = clear($('board-expected'));
  if (expected.length) {
    exp.append(
      h('h3', { class: 'sec' }, `Expected today (${expected.length})`),
      h('div', { class: 'expected' }, expected.map((s) => {
        const late = now > todayAt(s.inTime, now);
        return h('span', { class: `exp${late ? ' late' : ''}`, title: late ? 'Past their check-in time' : '' }, avatar(s.name, 'sm'), h('span', {}, s.name), h('span', { class: 'tm' }, fmtHHMM(s.inTime)));
      })));
  }

  const list = $('board-list');
  const sig = rows.map((r) => `${r.s.id}:${r.p.kind}:${r.s.name}:${r.s.grade}:${r.s.outTime}`).join('|');
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
        h('div', { class: 'who' }, avatar(s.name), h('div', {},
          h('div', { class: 'nm' }, s.name),
          h('div', { class: 'sub' }, [gradeLabel(s.grade), s.age != null ? `Age ${s.age}` : null].filter(Boolean).join(' · ')))),
        h('div', { class: 'sched' },
          h('div', {}, h('b', {}, `${fmtTime(rec.in)} → ${fmtHHMM(s.outTime)}`)),
          h('div', {}, todayAt(s.outTime, now) > new Date(rec.in) ? `${fmtDur(todayAt(s.outTime, now) - new Date(rec.in))} session` : 'Arrived after check-out time')),
        h('div', { class: 'prog' },
          h('div', { class: 'lbl' }, h('span', { class: TEXT_CLS[p.cls] }, p.label), h('span', { class: 'det' }, h('span', { class: 'pct' }, `${Math.round(p.pct)}%`))),
          h('div', { class: 'track' }, h('div', { class: `fill ${p.cls}${p.kind === 'over' ? ' over' : ''}`, style: { width: p.pct.toFixed(1) + '%' } })),
          h('div', { class: 'help', style: { marginTop: '4px' } }, p.detail)),
        h('div', { class: 'acts' }, acts)));
  }
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
  const panel = $('add-panel');
  if (!panel.firstChild) {
    panel.append(h('h3', {}, 'Add a student'), studentForm(null, () => { toast('Student added'); refresh(); }));
  }
  const q = state.filter.trim().toLowerCase();
  const now = Clock.now();
  const list = $('student-list');
  const rows = state.students
    .filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.grade).toLowerCase() === q)
    .sort((a, b) => a.name.localeCompare(b.name));
  const sig = rows.map((s) => [s.id, s.name, s.grade, s.age, s.notes, s.inTime, s.outTime, s.days.join(''), JSON.stringify(state.attendance[s.id] || null)].join('\u0001')).join('\u0002') + `#${state.students.length}`;
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
    const status = rec && rec.in && !rec.out ? ['Checked in now', 't-green'] : rec && rec.out ? ['Checked out today', 't-blue'] : s.days.includes(now.getDay()) ? ['Expected today', 't-muted'] : ['Not scheduled today', 't-muted'];
    const acts = [h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openModal(h('div', {}, h('h2', {}, 'Edit student'), studentForm(s, () => { closeModal(); toast('Saved'); refresh(); }))) }, 'Edit')];
    if (rec && rec.in && !rec.out) {
      acts.unshift(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
        if (await confirmDialog({ title: `Undo ${s.name}'s check-in?`, ok: 'Undo' })) attendance(s, 'clear');
      } }, 'Undo check-in'));
    } else {
      acts.unshift(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => attendance(s, 'in') }, 'Check in'));
    }
    list.appendChild(
      h('div', { class: 'srow simple' },
        h('div', { class: 'who' }, avatar(s.name), h('div', {},
          h('div', { class: 'nm' }, s.name),
          h('div', { class: 'sub' }, [gradeLabel(s.grade), s.age != null ? `Age ${s.age}` : null, s.notes || null].filter(Boolean).join(' · ')))),
        h('div', { class: 'sched' },
          h('div', {}, h('b', {}, `${fmtHHMM(s.inTime)} – ${fmtHHMM(s.outTime)}`), ` · ${fmtDur(todayAt(s.outTime, now) - todayAt(s.inTime, now))}`),
          h('div', {}, s.days.map((d) => DAY_NAMES[d]).join(' & ')),
          h('div', { class: status[1] }, status[0])),
        h('div', { class: 'acts' }, acts)));
  }
}

$('filter').addEventListener('input', (e) => { state.filter = e.target.value; renderStudents(true); });

function select(options, value) {
  return h('select', { class: 'input' }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
}

// Builds the add/edit form. onSaved(student) runs after a successful save.
function studentForm(existing, onSaved) {
  const s = existing || { name: '', grade: '', age: null, notes: '', inTime: '15:30', outTime: '16:30', days: [1, 4] };
  const err = h('div', { class: 'error' });
  const lengthNote = h('div', { class: 'help' });

  const name = h('input', { class: 'input', type: 'text', value: s.name, required: true, maxlength: 60, autocomplete: 'off', placeholder: 'First and last name' });
  const grade = select([{ value: '', label: 'Select grade…' }, ...GRADES.map((g) => ({ value: g, label: gradeLabel(g) }))], s.grade || '');
  const age = select([{ value: '', label: 'Optional' }, ...AGES.map((a) => ({ value: a, label: a }))], s.age == null ? '' : String(s.age));
  const notes = h('input', { class: 'input', type: 'text', value: s.notes || '', maxlength: 300, placeholder: 'Optional' });
  const timeOpts = (times, extra) => {
    const list = times.includes(extra) || !extra ? times : [...times, extra].sort();
    return list.map((t) => ({ value: t, label: fmtHHMM(t) }));
  };
  const inTime = select(timeOpts(IN_TIMES, s.inTime), s.inTime);
  const outTime = select(timeOpts(OUT_TIMES, s.outTime), s.outTime);
  const dayBoxes = ALLOWED_DAYS.map((i) => h('label', {}, h('input', { type: 'checkbox', value: i, checked: s.days.includes(i) }), DAY_NAMES[i] === 'Mon' ? 'Monday' : 'Thursday'));

  function updateLength() {
    const now = new Date();
    lengthNote.textContent = outTime.value > inTime.value ? `Session length: ${fmtDur(todayAt(outTime.value, now) - todayAt(inTime.value, now))}` : 'Check-out must be after check-in.';
  }
  // If the check-in moves past the check-out, bump the check-out to the next slot.
  inTime.addEventListener('change', () => {
    if (outTime.value <= inTime.value) { const next = OUT_TIMES.find((t) => t > inTime.value); if (next) outTime.value = next; }
    updateLength();
  });
  outTime.addEventListener('change', updateLength); updateLength();

  const form = h('form', { onsubmit: submit },
    h('label', { class: 'field' }, 'Full name', name),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Grade', grade), h('label', { class: 'field' }, 'Age', age)),
    h('label', { class: 'field' }, 'Notes', notes),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Should check in at', inTime), h('label', { class: 'field' }, 'Should check out at', outTime)),
    lengthNote,
    h('label', { class: 'field', style: { marginTop: '12px' } }, 'Days', h('div', { class: 'days' }, dayBoxes)),
    err,
    h('div', { class: 'actions' },
      existing ? h('button', { class: 'btn btn-danger', type: 'button', onclick: remove }, 'Delete') : null,
      existing ? h('button', { class: 'btn', type: 'button', onclick: closeModal }, 'Cancel') : null,
      h('button', { class: 'btn btn-primary', type: 'submit' }, existing ? 'Save changes' : 'Add student')));

  async function submit(e) {
    e.preventDefault();
    err.textContent = '';
    const body = {
      name: name.value, grade: grade.value, age: age.value, notes: notes.value,
      inTime: inTime.value, outTime: outTime.value,
      days: dayBoxes.map((l) => l.firstChild).filter((c) => c.checked).map((c) => Number(c.value)),
    };
    const r = existing ? await api('PUT', `/api/admin/students/${existing.id}`, body) : await api('POST', '/api/admin/students', body);
    if (!r.ok) { err.textContent = r.data.error || 'Could not save.'; return; }
    if (!existing) { name.value = ''; grade.value = ''; age.value = ''; notes.value = ''; name.focus(); }
    onSaved(r.data.student);
  }
  async function remove() {
    if (!await confirmDialog({ title: `Delete ${existing.name}?`, body: 'Their attendance records are deleted too.', ok: 'Delete', danger: true })) return;
    const r = await api('DELETE', `/api/admin/students/${existing.id}`);
    if (!r.ok) { err.textContent = r.data.error || 'Could not delete.'; return; }
    closeModal();
    toast(`${existing.name} deleted`);
    refresh();
  }
  return form;
}

// ---------------------------------------------------------------- activity page

function renderActivity() {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (!$('exp-to').value) { const t = Clock.now(); $('exp-to').value = iso(t); $('exp-from').value = iso(new Date(t.getTime() - 29 * 86400000)); }
  const tb = clear($('log'));
  if (!state.log.length) { tb.appendChild(h('tr', {}, h('td', { colspan: 4, class: 't-muted' }, 'Nothing yet today.'))); return; }
  for (const e of state.log) {
    const ev = e.type === 'in' ? ['Checked in', 'ev-in'] : e.type === 'out' ? ['Checked out', 'ev-out'] : ['Record cleared', 'ev-clear'];
    tb.appendChild(h('tr', {}, h('td', {}, fmtTime(e.ts)), h('td', {}, e.name), h('td', { class: ev[1] }, ev[0]), h('td', { class: 't-muted' }, e.source === 'student' ? 'student page' : e.source)));
  }
}
$('btn-export').addEventListener('click', () => { location.href = `/api/admin/export.csv?from=${$('exp-from').value}&to=${$('exp-to').value}`; });

// ---------------------------------------------------------------- settings page

function renderSettings() {
  const addr = clear($('address-panel'));
  addr.append(
    h('h3', {}, 'Addresses on your Wi-Fi'),
    h('p', { class: 'help' }, 'Open these on the iPads and computers.'),
    h('div', { class: 'addr' }, (state.addresses.length ? state.addresses : [location.origin]).flatMap((a) => [
      h('code', { class: 'url' }, h('span', { class: 'muted' }, 'Students:  '), `${a}/`),
      h('code', { class: 'url' }, h('span', { class: 'muted' }, 'Teachers:  '), `${a}/admin`)])));

  const bk = clear($('backup-panel'));
  bk.append(
    h('h3', {}, 'Your data'),
    h('p', { class: 'help' }, 'Saved in the "data" folder next to the program. Daily backups are kept for 30 days.'));

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

function openModal(content) {
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } }, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, content));
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
