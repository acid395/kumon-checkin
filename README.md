# Kumon Check-In / Check-Out

A small self-hosted website for a Kumon center: students check themselves in and out on an
iPad or computer, and teachers see a live board of progress bars that fill up as each
student's session runs.

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
   admin password.
2. Go to **Students** and add each student: name, grade (dropdown), age (dropdown), optional
   notes, check-in time (3:30 PM to 7:00 PM, every 30 minutes), check-out time (4:00 PM to
   7:30 PM, every 30 minutes), and whether they come Monday, Thursday, or both. The session
   length is calculated.

## 3. Daily use

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
  | Orange | Over 85%: almost time to go! |
  | Red, pulsing | Past the scheduled check-out time and still here |
  | Blue | Checked out |

  Teachers can check a student out from here. When a row is done, **Remove** clears it from the
  board; on a red "time's up" row the button is **Check out & remove**, which records the
  check-out time first so the attendance record is complete. With two or more finished rows a
  **Remove all finished** link appears next to the counters. Under the board, **Expected today**
  lists who is scheduled but hasn't arrived, with their check-in time; anyone past it is marked
  late in amber.
* **Students**: add students with the form at the top; edit, delete, or check in below.
  If a student tapped the wrong name, **Undo check-in** removes that check-in.
* **Activity**: today's check-in/out log and CSV export for any date range.
* **Settings**: change the admin password.

The admin login lasts 12 hours of inactivity.

If the student page cannot reach the server (the server computer is asleep or off the Wi-Fi),
it shows an amber "Not connected" bar at the top.

## Putting a test copy on the internet

The real site should stay on a computer at the center so student data never leaves your
network.

**/ Docker:**

```bash
docker build -t kumon-checkin .
docker run -p 8787:8787 -v kumon-data:/app/data -e ADMIN_PASSWORD=yourpassword kumon-checkin
```

Environment variables: `PORT`, `HOST`, `DATA_DIR`, `ADMIN_PASSWORD` (first start only),
`DEMO=1`, `TRUST_PROXY=1` (needed behind a provider's HTTPS proxy; set automatically on Render).
