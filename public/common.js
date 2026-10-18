'use strict';
// Shared helpers for the student and admin pages. No external libraries.

async function api(method, path, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-Requested-With': 'kumon' },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(path, opts); }
  catch (_) {
    // Server computer asleep / Wi-Fi dropped. Never throw: callers show a message instead.
    return { status: 0, ok: false, offline: true, data: { error: 'Not connected to the server.' } };
  }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, ok: res.ok, data: data || {} };
}

// Tiny DOM builder: h('div', {class:'x', onclick: fn}, 'text', childNode, ...)
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
function fmtTime(d) { return TIME_FMT.format(d instanceof Date ? d : new Date(d)); }
function fmtHHMM(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(hh, mm, 0, 0);
  return fmtTime(d);
}
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
}
function todayAt(hhmm, now) {
  const [hh, mm] = hhmm.split(':').map(Number);
  const d = new Date(now); d.setHours(hh, mm, 0, 0);
  return d;
}

// Keeps a clock element ticking and offers server-synchronised "now".
const Clock = {
  offset: 0,
  sync(serverIso) { if (serverIso) this.offset = new Date(serverIso).getTime() - Date.now(); },
  now() { return new Date(Date.now() + this.offset); },
  start(el) {
    const tick = () => { el.textContent = this.now().toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
    tick(); setInterval(tick, 1000);
  },
};

function toast(msg, ms = 2500) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---- small visual helpers (initial avatars, inline icons)
function initials(name) {
  const p = String(name).trim().split(/\s+/);
  return ((p[0] || '')[0] || '').toUpperCase() + ((p.length > 1 ? p[p.length - 1] : '')[0] || '').toUpperCase();
}
function hueFor(name) {
  let x = 7;
  for (const ch of String(name).toLowerCase()) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 360;
}
function avatar(name, cls) {
  const el = h('span', { class: `avatar ${cls || ''}`, 'aria-hidden': 'true' }, initials(name));
  el.style.setProperty('--hue', String(hueFor(name)));
  return el;
}
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  wave: '<path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11m0-6a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V13m0-1a1.5 1.5 0 0 1 3 0v3a7 7 0 0 1-7 7h-1a7 7 0 0 1-6.3-3.9L3 13.5a1.6 1.6 0 0 1 2.7-1.6L7 13.5"/>',
  warn: '<path d="M12 9v4m0 4h.01M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  external: '<path d="M14 4h6v6m0-6L10 14M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 13.5a6 6 0 0 1 3.5 6.5"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 11h6M9 15h4"/>',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}
function greeting(d) {
  const hr = d.getHours();
  return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
}
