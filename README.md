# Kumon Check-In / Check-Out

A small self-hosted website for a Kumon center: students check themselves in and out on an
iPad or computer, and teachers see a live board of progress bars that fill up as each
student's session runs.

* **No cloud, no accounts, no third parties.** It runs on one computer at the center and devices
  on the same Wi-Fi connect to it. Nothing is ever sent outside your network.
* **Zero dependencies.** Only Node.js is needed. There is nothing to `npm install`.
* Loads in a few kilobytes and works on iPad Safari, Mac, and Windows browsers.

## 1. Start it

Requirements: Node.js 18 or newer (https://nodejs.org).

```bash
cd kumon-checkin
node server.js          # or double-click start.command on a Mac
```

The terminal prints the addresses, for example:

```
Admin (this computer):  http://localhost:8787/admin
Admin (on the Wi-Fi):   http://10.0.0.49:8787/admin
```

Change the port with `PORT=9000 node server.js` if 8787 is taken.

## 2. First-time setup (once)

1. On the **computer running the server**, open `http://localhost:8787/admin` and create the
   admin password. For safety this can only be done from that computer, never from the Wi-Fi.
2. Go to **Students** and add each student: name, grade (dropdown), age (dropdown), optional
   notes, check-in time (3:30 PM to 7:00 PM, every 30 minutes), check-out time (4:00 PM to
   7:30 PM, every 30 minutes), and whether they come Monday, Thursday, or both. The session
   length is calculated for you.

## 3. Student iPads / computers

Open `http://<server-ip>:8787/` on each device. That is the student page: no login, nothing
to set up. Teachers reach the admin area from the small "Staff login" link at the bottom or
by going to `/admin` directly.

iPad tips:
* In Safari, use Share → **Add to Home Screen** to get a full-screen app icon.
* Turn on **Guided Access** (Settings → Accessibility → Guided Access, then triple-click the
  side button) so students cannot leave the page.

## 4. Daily use

**Students** (main page `/`): type a few letters of their name, tap their card, tap **Check in**.
The screen shows "You're checked in" with the time and a **Close** button (it also closes by
itself after 8 seconds). When leaving, tap the card again and press **Check out**.

**Teachers** (`/admin`) have four pages:

* **Live board**: empty at the start of the day. When a student checks in, a row appears with a
  bar that fills from 0% to 100% between their check-in time and their scheduled check-out
  time. The color changes as they get closer to the end:

  | Bar | Meaning |
  | --- | --- |
  | Green | Less than 60% of the session has passed |
  | Amber | 60–85% of the session has passed |
  | Orange | Over 85%: almost time to go |
  | Red, pulsing | Past the scheduled check-out time and still here |
  | Blue | Checked out |

  Teachers can check a student out from here. When a row is done, **Remove** clears it from the
  board; on a red "time's up" row the button is **Check out & remove**, which records the
  check-out time first so the attendance record is complete. With two or more finished rows a
  **Remove all finished** link appears next to the counters. Under the board, **Expected today**
  lists who is scheduled but hasn't arrived, with their check-in time; anyone past it is marked
  late in amber.
* **Students**: add students with the form at the top; edit, delete, or check in below.
  If a student tapped the wrong name, **Undo check-in** removes that check-in (it is logged as
  "Record cleared").
* **Records**: every visit ever recorded, with check-in time, check-out time and how long the
  student stayed. Pick a preset (Today, This week, This month, This year, Last 3 years) or any
  date range, optionally one student. Short ranges list each visit; longer ranges collapse
  automatically into weeks, months or years per student (visits, total time, average stay),
  and you can override that with the "Show" dropdown. **Download CSV** exports exactly what is
  shown, with no row limit. Each student row on the Students page has a **Records** shortcut.
* **Settings**: change the admin password.

The admin login lasts 12 hours of inactivity.

If the student page cannot reach the server (the server computer is asleep or off the Wi-Fi),
it shows an amber "Not connected" bar at the top and any check-in attempt says so instead of
spinning. It recovers by itself once the server is reachable again.

## Putting a test copy on the internet

The real site should stay on a computer at the center so student data never leaves your
network. For showing the site to other people, run a separate copy with **made-up names only**.

**Render (free, one click):**

1. Go to https://render.com, sign in with GitHub, and choose **New → Blueprint**.
2. Pick this repository. Render reads `render.yaml`, asks you for `ADMIN_PASSWORD`
   (at least 8 characters), and deploys.
3. In a few minutes you get an address like `https://kumon-checkin.onrender.com`. That is the
   student page; `/admin` is the teacher login, using the password you typed.

The free plan sleeps after 15 minutes without visitors (the first visit then takes about
30 seconds) and has no permanent disk, so students and attendance reset whenever it restarts.
`DEMO=1` in `render.yaml` re-creates six sample students each time. For a copy that keeps its
data, attach a Render disk and set `DATA_DIR` to its mount path.

**Any other host / Docker:**

```bash
docker build -t kumon-checkin .
docker run -p 8787:8787 -v kumon-data:/app/data -e ADMIN_PASSWORD=yourpassword kumon-checkin
```

Environment variables: `PORT`, `HOST`, `DATA_DIR`, `ADMIN_PASSWORD` (first start only),
`DEMO=1`, `TRUST_PROXY=1` (needed behind a provider's HTTPS proxy; set automatically on Render).

## Where the data lives, and why it can't quietly disappear

Everything is in the `data` folder next to `server.js`, readable only by the user account that
runs the server:

| File | What it is |
| --- | --- |
| `data/kumon-data.json` | Password hash, students, the last two weeks of day records, recent events, logins |
| `data/kumon-data.prev.json` | The version from just before the most recent save |
| `data/backups/kumon-data-YYYY-MM-DD.json` | One snapshot per day, kept for 30 days |
| `data/history/sessions-YYYY.ndjson` | Every completed visit, one line each, one file per year, kept forever |

The main file only holds the last two weeks of day records; every finished visit is appended
to the history file for its year the moment the student checks out. Appending never rewrites
the file, so a crash cannot damage older records, and the files stay small (about 3–4 MB per
year for 150 students). The server loads them into memory at start and answers reports over
three years of data in well under a second.

If a student forgets to check out, the visit is closed automatically once the day is over, at
their scheduled check-out time, and marked "No check-out recorded" in Records and in the CSV.
Deleting a student keeps their past visits in the history under their name.

Safety rules built into the server:

* Saves are atomic (written to a temp file, then swapped in), so a crash mid-save cannot
  corrupt the file.
* If the `data` folder is deleted or moved while the server is running, the next save
  recreates it instead of failing.
* If the main file is missing at startup, the server restores it from the previous version or
  the newest backup before falling back to a fresh start.
* If the main file exists but is unreadable, the server refuses to start and tells you which
  file to restore from. It never overwrites a file it cannot read.
* Teacher logins survive a server restart.
* An unexpected error inside the server is logged and the server keeps running, so one bad
  request cannot take the check-in page down during class.

To back up off the machine, copy the `data` folder anywhere you like. To move to a new
computer, copy the whole `kumon-checkin` folder.

## Security design

The most important requirement was that student data never leaks. Here is what is in place:

* **Local only.** The server binds to your machine; devices reach it over your Wi-Fi. There are
  no CDNs, fonts, analytics, or external scripts, and the Content-Security-Policy forbids the
  pages from contacting anything except the server itself.
* **Student page sees the minimum.** Anyone on the Wi-Fi can open it, and it only ever
  receives name, grade and in/out status. Ages, notes and history require the admin login.
* **Admin password** is hashed with scrypt; the first password can only be set from localhost;
  5 wrong attempts from one device lock it out for 15 minutes.
* **Cookies** are `HttpOnly`, `SameSite=Strict`, and `Secure` when HTTPS is on.
* **Cross-site request protection**: every state-changing request must carry a custom header
  and pass `Origin` / `Sec-Fetch-Site` checks. Pages cannot be framed.
* **No inline scripts, strict CSP, nosniff, no referrer leakage,** all user text is inserted via
  DOM text nodes (no HTML injection), body-size limits, input validation, and CSV output is
  escaped against spreadsheet formula injection.
* **Atomic saves, previous-version copy and daily backups** in a mode-700 folder (see above).

### Optional: HTTPS on the local network

HTTP on a private Wi-Fi is acceptable for most centers, but if you want encryption on the
wire (recommended if the Wi-Fi is shared with the public), create a local certificate with
[mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 10.0.0.49   # use your server IP
```

Restart the server; it switches to HTTPS automatically when `certs/key.pem` and
`certs/cert.pem` exist. Install the mkcert root certificate on each iPad so the padlock shows.

### Good practice

* Stop the server computer from sleeping while the center is open (Mac: System Settings →
  Displays → Advanced → "Prevent automatic sleeping", or Energy Saver; Windows: Power & sleep →
  Never). A sleeping server shows "Not connected" on the iPads.
* Give the server computer a fixed IP address in your router so the address never changes.
* Use a Wi-Fi network the public cannot join, or a separate guest network for visitors.
* Keep the computer that runs the server locked with its own password and disk encryption
  (FileVault / BitLocker), since the data file is on its disk.
