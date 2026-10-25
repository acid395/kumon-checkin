# Kumon Check-In / Check-Out

A small self-hosted website for a Kumon center: students check themselves in and out on an
iPad or computer, and teachers see a live board of progress bars that fill up as each
student's session runs.

## 1. Run it on any computer

The server is one folder plus Node.js, so it runs the same on a Mac, Windows PC or Linux
machine. Nothing else is installed and nothing is sent to the internet.

### Step 1: install Node.js (once per computer)

Download the LTS version from https://nodejs.org and install it. Then open a terminal
(Mac: Terminal. Windows: PowerShell. Linux: any terminal) and check it worked:

```bash
node --version      # should print v18 or higher
```

### Step 2: get the code

```bash
git clone https://github.com/acid395/kumon-checkin.git
cd kumon-checkin
```

No git? On the GitHub page choose **Code, then Download ZIP**, unzip it, and `cd` into the folder.

### Step 3: start it with your own password

Pick your own password (at least 8 characters) and start the server. The password is only
used the first time, when the computer has no data yet. Replace `MyOwnPassword123` with yours.

**Mac or Linux:**

```bash
ADMIN_PASSWORD='MyOwnPassword123' node server.js
```

**Windows PowerShell:**

```powershell
$env:ADMIN_PASSWORD = "MyOwnPassword123"
node server.js
```

**Windows Command Prompt (cmd):**

```bat
set ADMIN_PASSWORD=MyOwnPassword123
node server.js
```

Prefer to type the password in the browser instead? Just run `node server.js`, open
http://localhost:8787/admin **on that same computer**, and you will be asked to create one.

The terminal prints the addresses, for example:

```
Admin (this computer):   http://localhost:8787/admin
Admin (on the Wi-Fi):    http://192.168.1.25:8787/admin
Students (on the Wi-Fi): http://192.168.1.25:8787/
```

Leave that window open while the center is running. Press Ctrl+C to stop it.

### Step 4: connect the iPads and other computers

On any device on the same Wi-Fi, open the **Students** address from the terminal in the
browser. Teachers open the **Admin** address and log in with the password from step 3.

If other devices cannot connect:
* Make sure they are on the same Wi-Fi as the server computer.
* Windows: when asked, allow Node.js through the firewall for **private networks**.
  Mac: System Settings, Network, Firewall, allow incoming connections for Node.
* Keep the server computer awake (Mac: System Settings, Lock Screen or Displays, prevent
  sleeping. Windows: Power and sleep, set sleep to Never).

### Changing the password later

Log in, then go to **Settings, Change admin password**. If the password is forgotten, stop
the server, delete `data/kumon-data.json` and `data/kumon-data.prev.json` (this removes the
student list, so copy the `data` folder somewhere first), and start again with a new password.

### Other options

Different port (if 8787 is taken):

```bash
PORT=9000 node server.js                          # Mac / Linux
$env:PORT = "9000"; node server.js                # Windows PowerShell
```

Docker (works on any computer with Docker installed):

```bash
docker build -t kumon-checkin .
docker run -p 8787:8787 -v kumon-data:/app/data -e ADMIN_PASSWORD='MyOwnPassword123' kumon-checkin
```

Keep it running after you close the terminal (Mac / Linux):

```bash
nohup env ADMIN_PASSWORD='MyOwnPassword123' node server.js > server.log 2>&1 &
```

On a Mac you can also double-click `start.command`.

## 2. First-time setup (once)

1. Log in at `http://localhost:8787/admin` with the password from step 3 above (or create it
   there if you started without `ADMIN_PASSWORD`).
2. Go to **Students** and press **Import from file** to add everyone from the class schedule.
   It reads Excel (.xls or .xlsx), CSV, or a PDF printed from the spreadsheet, with the columns
   StudentID, FirstName, LastName, Subject, Monday, Thursday (one row per subject, times like
   `6:30pm` or `n/a`). Each student arrives at their first subject time and leaves 30 minutes
   after their last subject starts. You see every student and any problems before anything is
   saved. Importing again later updates students by their ID and never deletes anyone.
3. Or add a student by hand with **Add student**: name, student ID, subjects, optional notes, and
   a check-in and check-out time for Monday and for Thursday.

## 3. Daily use

**Students** (main page `/`): type a few letters of their name (or the start of their student
ID), tap their card, tap **Check in**.
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
  late in amber. A student who checks in after their time shows how late they were.
* **Students**: add students with the form at the top; edit, delete, or check in below.
  If a student tapped the wrong name, **Undo check-in** removes that check-in.
* **Records**: every visit, with the exact check-in and check-out time (to the second), how
  long the student stayed, and whether they were **on time**, **late** (and by how many
  minutes), or **absent**, going back years. Pick Today / This week / This month / This year /
  Last 3 years or any date range, one student, and Everyone / Late only / Absent only / On time
  only. Short ranges list each visit; long ranges are grouped by week, month or year per
  student (visits, late, absent, total time, average). **Download CSV** exports what is shown.
  Visits with no check-out are closed at the scheduled time and marked.

  Absences are filled in once a class day is over (30 minutes after the last scheduled
  check-out): everyone scheduled that day who never checked in is marked absent. If nobody at
  all checked in that day, it is treated as a day the center was closed and no one is marked
  absent. Absences are counted from the day this version is first started, never backwards.
* **Settings**: change the admin password and download a backup of all records.

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
