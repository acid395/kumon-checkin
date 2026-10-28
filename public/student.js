'use strict';
// Student page: search your name, tap your card, tap Check in / Check out.

const state = { students: [], query: '', loaded: false, modalOpen: false, sig: '' };
const grid = document.getElementById('grid');
const search = document.getElementById('search');
const modalRoot = document.getElementById('modal-root');

Clock.start(document.getElementById('clock'));
document.getElementById('searchwrap').prepend(icon('search'));
document.getElementById('staff-link').prepend(icon('lock'));

const offlineBar = document.getElementById('offline');
function setOffline(on) { offlineBar.classList.toggle('hidden', !on); }

async function load() {
  try {
    const r = await api('GET', '/api/student/students');
    setOffline(!!r.offline);
    if (!r.ok) return;
    Clock.sync(r.data.serverTime);
    // Only touch the DOM when something actually changed, so a tap never lands on a rebuilt card.
    const sig = JSON.stringify(r.data.students);
    if (sig === state.sig && state.loaded) return;
    state.sig = sig;
    state.students = r.data.students;
    state.loaded = true;
    render();
  } catch (_) { /* server unreachable: keep showing last list */ }
}

function matches(name, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const n = name.toLowerCase();
  const words = n.split(/\s+/);
  // every typed token must start some word of the name, or appear anywhere in it
  return q.split(/\s+/).every((tok) => words.some((w) => w.startsWith(tok)) || n.includes(tok));
}

// Typing digits also finds a student by their ID (at least 3 characters, from the start of the ID).
function matchesId(id, query) {
  const q = query.trim().replace(/\s+/g, '');
  return !!id && q.length >= 3 && id.toLowerCase().startsWith(q.toLowerCase());
}

function render() {
  clear(grid);
  const list = state.students.filter((s) => matches(s.name, state.query) || matchesId(s.kumonId, state.query));
  if (!state.loaded) return;
  if (!list.length) {
    grid.appendChild(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, icon('people'),
      h('b', {}, state.students.length ? `No one named “${state.query.trim()}”` : 'No students yet')));
    return;
  }
  for (const s of list) {
    const statusText = s.status === 'in' ? `Here since ${fmtTime(s.since)}` : s.status === 'done' ? 'Left for today' : s.status === 'wait' ? 'Ask a teacher' : 'Not here yet';
    const card = h('button', { class: `card ${s.status}`, type: 'button', onclick: () => openModal(s) },
        avatar(s.name),
        h('span', { class: 'body' },
          h('span', { class: 'name' }, s.name),
          h('span', { class: 'meta' }, s.kumonId ? h('span', { class: 'badge' }, `ID ${s.kumonId}`) : null, h('span', { class: 'status-text' }, s.status === 'wait' ? icon('lock') : null, statusText))));
    card.style.setProperty('--hue', String(hueFor(s.name)));
    grid.appendChild(card);
  }
}

search.addEventListener('input', () => { state.query = search.value; render(); });

// ---- modal flow
let autoCloseTimer = null;
let lockPoll = null;
function closeModal() {
  clearTimeout(autoCloseTimer);
  clearInterval(lockPoll); lockPoll = null;
  clear(modalRoot);
  state.modalOpen = false;
  search.value = ''; state.query = '';
  render();
  load();
}

function openModal(s) {
  state.modalOpen = true;
  const action = s.status === 'in' ? 'out' : 'in';
  const body = h('div', {});
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, body));

  function showConfirm() {
    clear(body);
    body.append(
      h('div', { class: 'who-head' }, avatar(s.name, 'lg'), h('div', {},
        h('h2', {}, s.name),
        h('div', { class: 'sub', style: { marginBottom: '0' } }, [s.kumonId ? `ID ${s.kumonId}` : null, s.status === 'in' ? `Checked in at ${fmtTime(s.since)}` : null].filter(Boolean).join(' · ')))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-lg', type: 'button', onclick: closeModal }, 'Cancel'),
        h('button', { class: `btn btn-lg ${action === 'in' ? 'btn-green' : 'btn-blue'}`, type: 'button', onclick: doAction, id: 'primary-action' }, action === 'in' ? 'Check in' : 'Check out')));
  }

  async function doAction() {
    clear(body);
    body.append(h('div', { class: 'result' }, h('div', { class: 'spinner' }), h('div', { class: 'time' }, action === 'in' ? 'Checking in…' : 'Checking out…')));
    const started = Date.now();
    const r = await api('POST', '/api/student/toggle', { id: s.id, action });
    const wait = Math.max(0, 100 - (Date.now() - started)); // show the spinner for about 0.1 s
    setTimeout(() => (r.status === 423 ? showLocked(r.data) : showResult(r)), wait);
  }

  // Too early or too late: the check-in did not go through. The message can be closed like any
  // other; a teacher can still let the student in from the admin page, and if that happens while
  // the message is open it turns into the normal "You're checked in".
  function showLocked(info) {
    clearTimeout(autoCloseTimer);
    const late = info.kind === 'late';
    clear(body);
    body.closest('.modal').classList.add('locked', late ? 'is-late' : 'is-early');
    body.append(
      h('div', { class: 'result' },
        h('div', { class: 'mark lock' }, icon('lock')),
        h('h2', {}, `You're ${minutesText(info.min)} ${late ? 'late' : 'early'}`),
        h('div', { class: 'time' }, `Your class starts at ${fmtHHMM(info.schedIn)}.`),
        h('p', { class: 'ask' }, late ? 'Please ask a teacher to check you in.' : 'You can check in from ' + fmtHHMM(minus(info.schedIn, 10)) + ', or ask a teacher.'),
        h('div', { class: 'waiting' }, 'Not checked in')),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-lg btn-primary', type: 'button', onclick: closeModal }, 'Close')));
    lockPoll = setInterval(async () => {
      const r = await api('GET', '/api/student/students');
      if (!r.ok) return;
      const me = r.data.students.find((x) => x.id === s.id);
      if (!me || me.status === 'wait') return;
      clearInterval(lockPoll); lockPoll = null;
      clearTimeout(autoCloseTimer);
      body.closest('.modal').classList.remove('locked', 'is-late', 'is-early');
      if (me.status === 'in') showResult({ ok: true, data: { time: me.since } });
      else showSentAway();
    }, 2000);
    autoCloseTimer = setTimeout(closeModal, 15000);
    body.querySelector('.actions .btn').focus();
  }

  function showSentAway() {
    clear(body);
    body.append(
      h('div', { class: 'result' },
        h('div', { class: 'mark warn' }, icon('warn')),
        h('h2', {}, 'Not yet'),
        h('div', { class: 'time' }, 'A teacher will help you. Try again a little later.')),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-lg btn-primary', type: 'button', onclick: closeModal }, 'Close')));
    autoCloseTimer = setTimeout(closeModal, 8000);
  }

  function showResult(r) {
    clear(body);
    if (r.ok) {
      const t = fmtTime(r.data.time);
      body.append(
        h('div', { class: 'result' },
          h('div', { class: `mark ${action === 'in' ? 'ok' : 'bye'}` }, icon(action === 'in' ? 'check' : 'wave')),
          h('h2', {}, action === 'in' ? `You're checked in, ${firstName(s.name)}!` : `See you next time, ${firstName(s.name)}!`),
          h('div', { class: 'time' }, `${action === 'in' ? 'Checked in' : 'Checked out'} at ${t}`)),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-lg btn-primary', type: 'button', onclick: closeModal }, 'Close')));
      autoCloseTimer = setTimeout(closeModal, 8000);
    } else {
      setOffline(!!r.offline);
      body.append(
        h('div', { class: 'result' },
          h('div', { class: 'mark warn' }, icon('warn')),
          h('h2', {}, r.offline ? 'Not connected' : 'Something went wrong'),
          h('div', { class: 'time' }, r.offline ? 'Please tell a teacher.' : (r.data.error || 'Please tell a teacher.'))),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-lg btn-primary', type: 'button', onclick: closeModal }, 'Close')));
      autoCloseTimer = setTimeout(closeModal, 8000);
    }
    const closeBtn = body.querySelector('.actions .btn'); if (closeBtn) closeBtn.focus();
  }

  if (s.status === 'wait') showLocked(s); else showConfirm();
  modalRoot.appendChild(overlay);
  const primary = body.querySelector('#primary-action'); if (primary) primary.focus();
}

function firstName(n) { return n.split(' ')[0]; }
function minutesText(min) {
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const hh = Math.floor(min / 60), mm = min % 60;
  return `${hh} hour${hh === 1 ? '' : 's'}${mm ? ` ${mm} min` : ''}`;
}
function minus(hhmm, n) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const t = hh * 60 + mm - n;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.modalOpen) closeModal(); });

load();
setInterval(() => { if (!state.modalOpen) load(); }, 5000);
