'use strict';
// Gets the newest code from GitHub without touching the data folder.
//
//   node update.js        (or double-click update.command on a Mac, update.bat on Windows)
//
// It saves a copy of the data to data/backups first (listed under Settings, Restore as
// "Before an update"), then runs `git pull --ff-only`. It never resets, stashes or cleans, so if
// the code folder has local changes the pull simply stops and nothing is lost.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'kumon-data.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = 10;
const pad = (n, w = 2) => String(n).padStart(w, '0');

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, '.git'))) {
  fail('This folder was not set up with git clone, so it cannot update itself.\n  Download the new ZIP, then copy the data folder from this folder into the new one.');
}

// The data folder must be ignored by git, or a pull could change it.
const ignored = spawnSync('git', ['check-ignore', '-q', 'data/kumon-data.json'], { cwd: ROOT });
if (ignored.error) fail('git is not installed or not on the PATH.');
if (ignored.status !== 0) fail('The data folder is not ignored by git (.gitignore was changed). Nothing was updated.');

if (fs.existsSync(DATA_FILE)) {
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

const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: ROOT, stdio: 'inherit' });
if (pull.status !== 0) fail('The update did not go through (see the message above). Your data was not changed.');

console.log('\n  Updated. Stop the server (Ctrl+C) and start it again to use the new version.\n');
