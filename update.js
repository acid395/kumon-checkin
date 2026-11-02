'use strict';
// Gets the newest code from GitHub without touching the data folder.
//
//   node update.js        (or double-click update.command on a Mac, update.bat on Windows)
//
// It saves a copy of the data to data/backups first (listed under Settings, Restore as
// "Before an update"), then:
//   * in a folder made with git clone: runs `git pull --ff-only`. It never resets, stashes or
//     cleans, so if the code folder has local changes the pull simply stops and nothing is lost.
//   * in a folder made from a downloaded ZIP: downloads the newest code from GitHub over HTTPS
//     and writes the code files over the old ones. Nothing under data/ is ever written, and no
//     file is deleted. Nothing is sent to GitHub except the download request itself.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'kumon-data.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const ARCHIVE_URL = 'https://codeload.github.com/acid395/kumon-checkin/tar.gz/refs/heads/main';
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const KEEP = 10;
const pad = (n, w = 2) => String(n).padStart(w, '0');

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

function backupData() {
  if (!fs.existsSync(DATA_FILE)) return;
  const d = new Date();
  const name = `before-update-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}.json`;
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(BACKUP_DIR, name);
  fs.copyFileSync(DATA_FILE, target);
  try { fs.chmodSync(target, 0o600); } catch (_) {}
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^before-update-\d{4}-\d{2}-\d{2}-\d{9}\.json$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  console.log(`  Saved a copy of the data: ${target}`);
}

function updateWithGit() {
  // The data folder must be ignored by git, or a pull could change it.
  const ignored = spawnSync('git', ['check-ignore', '-q', 'data/kumon-data.json'], { cwd: ROOT });
  if (ignored.error) fail('This folder was made with git, but git is not installed or not on the PATH.');
  if (ignored.status !== 0) fail('The data folder is not ignored by git (.gitignore was changed). Nothing was updated.');
  backupData();
  const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: ROOT, stdio: 'inherit' });
  if (pull.status !== 0) fail('The update did not go through (see the message above). Your data was not changed.');
}

// Reads a .tar archive into [{ name, mode, body }] for regular files only.
function untar(buf) {
  const files = [];
  let nextName = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = field(156, 157) || '0';
    const prefix = field(345, 500);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { // per-file extended header: may carry a long path
      const m = body.toString('utf8').match(/^\d+ path=(.*)$/m);
      if (m) nextName = m[1];
      continue;
    }
    const name = nextName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    nextName = null;
    if (type === '0') files.push({ name, mode: parseInt(field(100, 108).trim() || '644', 8), body: Buffer.from(body) });
  }
  return files;
}

async function updateFromGitHub() {
  console.log('  Downloading the newest version from GitHub...');
  let res;
  try { res = await fetch(ARCHIVE_URL); } catch (_) { fail('Could not reach GitHub. Check the internet connection. Nothing was changed.'); }
  if (!res.ok) fail(`GitHub answered ${res.status}. Nothing was changed.`);
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.length > MAX_DOWNLOAD) fail('The download was larger than expected. Nothing was changed.');

  let entries;
  try { entries = untar(zlib.gunzipSync(gz, { maxOutputLength: MAX_DOWNLOAD * 4 })); } catch (_) { fail('The download was damaged. Nothing was changed.'); }

  // Every path is inside the top folder GitHub adds ("kumon-checkin-main/"); strip it and keep
  // only plain relative paths outside data/.
  const files = [];
  for (const e of entries) {
    const rel = e.name.split('/').slice(1).join('/');
    if (!rel) continue;
    const parts = rel.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..') || path.isAbsolute(rel) || /[\\:]/.test(rel)) fail(`Unexpected file in the download (${rel}). Nothing was changed.`);
    if (parts[0] === 'data' || parts[0] === '.git') continue;
    files.push({ rel, mode: e.mode, body: e.body });
  }
  if (!files.some((f) => f.rel === 'server.js') || !files.some((f) => f.rel === 'public/student.html')) fail('The download does not look like this program. Nothing was changed.');

  // Check every script compiles before any file is replaced.
  for (const f of files.filter((x) => x.rel.endsWith('.js'))) {
    try { new vm.Script(`(function (exports, require, module, __filename, __dirname) {${f.body.toString('utf8').replace(/^#!.*/, '')}\n})`, { filename: f.rel }); } catch (err) { fail(`The new ${f.rel} has an error (${err.message}). Nothing was changed.`); }
  }

  backupData();
  let changed = 0;
  for (const f of files) {
    const target = path.join(ROOT, f.rel);
    if (fs.existsSync(target) && fs.readFileSync(target).equals(f.body)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.new';
    fs.writeFileSync(tmp, f.body, { mode: f.mode & 0o755 });
    fs.renameSync(tmp, target);
    console.log(`  updated ${f.rel}`);
    changed++;
  }
  if (!changed) console.log('  Already up to date.');
}

(async () => {
  if (fs.existsSync(path.join(ROOT, '.git'))) updateWithGit();
  else await updateFromGitHub();
  console.log('\n  Done. Stop the server (Ctrl+C) and start it again to use the new version.\n');
})();
