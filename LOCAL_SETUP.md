# Running your NGA module locally

Same guide in every NGA repo. Two steps, about fifteen minutes.

```
1. Install what your module needs (table below)
2. Windows: double-click  start.bat
   Mac:     open Terminal in the folder and run  ./start.sh
```

The launcher does the rest: creates your config files, installs packages, builds
your local database, **starts your own copy of the Central MIS**, and starts
your module. Run it again any time — it skips whatever is already done.

---

## 1. Install the prerequisites

Everyone needs:

- **[Node.js](https://nodejs.org/) 20 or newer** (the LTS download)
- **[Git](https://git-scm.com/)** — the launcher uses it to fetch the Central MIS
  (Mac: `xcode-select --install` provides it)
- **MySQL 8, or [XAMPP](https://www.apachefriends.org/)** — the Central MIS
  keeps its database there. Windows/XAMPP: open the Control Panel and press
  **Start** next to MySQL before running the launcher. Mac:
  `brew install mysql && brew services start mysql`.

Then, depending on your module:

| Your module | Also install | Databases it creates (all on your machine) |
|---|---|---|
| **TaskMentor** | nothing more | `taskmentor_dev` + `ngarw_mis` (MySQL) |
| **Tendo** | nothing more | a SQLite file in `server/data/` + `ngarw_mis` (MySQL) |
| **Tupo** | PostgreSQL 16 + Redis (Mac: `brew install postgresql@16 redis`) | `tupo_dev` (Postgres) + `ngarw_mis` (MySQL) |
| **Central MIS** | nothing more | `ngarw_mis` (MySQL) |

**Every database is on your own machine.** Nothing you do locally can touch
production data.

## 2. Run start.bat

```
git clone <your module's repo>
cd <the folder it made>
start.bat          # Windows
./start.sh         # Mac / Linux
```

`start.sh` is the same launcher, step for step. On a Mac the Central MIS opens
in a new Terminal window; on Linux in a terminal emulator if one is found,
otherwise in the background with its output in `/tmp/central-mis.log`.

First run takes a few minutes (packages and databases). After that it is quick.

Two windows open: your module, and **Central MIS**. Keep both. When they finish
they print the addresses:

| Module | Open this | API |
|---|---|---|
| **Central MIS** | http://localhost:5173 | 5001 |
| **TaskMentor** | http://localhost:5174/taskmentor | 5002 |
| **Tendo** | http://localhost:3000 | 5171 |
| **Tupo** | http://localhost:5194 | 5190 |

---

## Signing in

Your module has **no login of its own**. Click *Sign In* and you are taken to
your own Central MIS, which sends you straight back, signed in:

```
   your module  ──▶  your Central MIS (localhost:5173)  ──▶  back, signed in
```

It then asks for a 6-digit code, which is **printed on the login page** — no
email is sent in development.

**Every local account uses the password `Admin@1234`.** Each module has its
own roles and works them out from the MIS account, so pick the login for the
role you want to see in *your* module:

| | Sign in as | Lands as |
|---|---|---|
| **Tendo** | `superadmin` / `dev.admin` | admin |
| | `dev.teacher` / `dev.classteacher` | teacher |
| | `dev.student` | student |
| | `dev.accountant` | unassigned (the pending screen) |
| **TaskMentor** | `superadmin` / `dev.admin` | admin |
| | `dev.teacher` / `dev.classteacher` | instructor |
| | `dev.student` | student |
| **Tupo** | `superadmin` | super_admin |
| | `dev.programmanager` | program_lead |
| | `dev.classteacher` | class_teacher |
| | `dev.teacher` / `dev.admin` | staff |
| | `dev.student` | student |
| | `dev.parent` | parent |
| **Central MIS** | any of them | exactly its MIS role |

All ten accounts, with what each becomes everywhere (measured, not assumed):

| MIS account | MIS role | Tendo | TaskMentor | Tupo |
|---|---|---|---|---|
| `superadmin` | SUPER_ADMIN | admin | admin | super_admin |
| `dev.admin` | ADMIN | admin | admin | staff |
| `dev.headteacher` | HEAD_TEACHER | teacher | admin | staff |
| `dev.teacher` | TEACHER | teacher | instructor | staff |
| `dev.classteacher` | CLASS_TEACHER + TEACHER | teacher | instructor | class_teacher |
| `dev.student` | STUDENT | student | student | student |
| `dev.parent` | PARENT | student | student | parent |
| `dev.accountant` | ACCOUNTANT | unassigned | student | staff |
| `dev.staff` | STAFF | student | student | staff |
| `dev.programmanager` | PROGRAM_MANAGER | teacher | admin | program_lead |

The accounts are wired into the current academic year's main class (teachers
teach its subjects, the class teacher leads it, the student is enrolled, the
parent is that student's parent, the program manager leads its program). They
exist only in the `ngarw_mis` database on your machine (their `@nga.test`
emails cannot receive mail); production has none of them. The MIS's
`npm run db:setup` creates them, and its `start.bat` re-applies them on every
start (`db:setup -- --refresh`), so a database built before they existed gets
them too. A printable version is `guides/START_HERE.pdf`.

---

## How the Central MIS gets there

The satellite modules (TaskMentor, Tendo, Tupo) need a Central MIS to sign in
against, exactly as the Docker stack does. Their `start.bat` looks for it in
this order and uses the first hit (`start.sh` looks for `start.sh`):

1. the folder in the `NGA_MIS_DIR` environment variable, if you set one
2. `..\nga_central_mis` — a checkout **next to** your module's folder
3. `..\..\Central MIS\nga_central_mis` — the NGAMIS workspace layout

If none exists it runs `git clone` **once** into `..\nga_central_mis`. You need
read access to the `nga_central_mis` repository for that — ask your team lead.
Git may open a browser window the first time to sign you in to GitHub.

The MIS is started in its own window and your module waits for it (port 5001)
before starting. If something is already listening on 5001 — the Docker stack,
or an MIS you started yourself — it is used as-is and nothing is started twice.

Inside the MIS, `npm run db:setup` builds `ngarw_mis` from the committed
snapshot, sets the `superadmin` password, and registers each module's SSO
client with a secret of the form `local-dev-secret-<client_id>`. That is why
your module's committed `.env.example` already contains a working secret: it
only means anything to the database on your machine.

---

## If something goes wrong

**Sign In sends me to `mis.amashuri.com` (the real MIS)**
Your `.env` is from an older setup. Just run `start.bat` / `./start.sh` again:
on every start it repairs `.env` (and `.env.local` / `.env.development`) so
every URL points at this machine and the SSO client id and secret match the
local MIS. It prints each value it changed and keeps your old file as
`.env.bak`. Your own API keys, ports and database settings are not touched.
Restart the dev server after a repair — Vite only reads `.env` when it starts.

**The local MIS says "Invalid credentials" for a `dev.*` account**
Check the address bar first: if the MIS page is not on `localhost:5173`, see
the item above. Otherwise the local database was left half-built; `start.bat`
now detects that and rebuilds it, or do it by hand:
`cd backend && npm run db:setup -- --force` in the Central MIS folder.

**The Central MIS window shows an error**
Read it — it says what is missing. The usual one is MySQL not running: start it
(XAMPP Control Panel; Mac: `brew services start mysql`) and press a key in that
window to retry. If your MySQL root has a password, put it in the MIS's
`backend/.env` as `DB_PASSWORD` (TaskMentor: `server/.env` `DB_PASS`). Your module
keeps waiting for the MIS for up to 15 minutes, then starts without it.

**"Redirect URI not allowed" after clicking Sign In**
Your dev server is on a different port than the one registered with the MIS —
usually because the port was busy and Vite moved. Stop whatever is using the
port in the table above and start again. Do not change the port: the MIS matches
it exactly.

**"Invalid client credentials"**
The `SSO_CLIENT_SECRET` in your `.env` does not match your MIS database. Both
should be `local-dev-secret-<client_id>`; running `start.bat` again restores the
`.env` side, and `cd backend && npm run db:setup -- --force` the database side.

**Port already in use**
Something else has the port. Find it and stop it rather than changing the port,
or sign-in breaks. `netstat -ano | findstr :5174`

**MySQL not found / not running**
Start MySQL in the XAMPP Control Panel, or install MySQL 8, then run
`start.bat` again.

**I want to start a database over**
TaskMentor: drop `taskmentor_dev` and re-run `start.bat`.
Tendo: delete `server/data/` and re-run.
Tupo: `npm run db:migrate`.
Central MIS: `cd backend && npm run db:setup -- --force`.

---

## Two things worth knowing

**Your `.env` is never pushed, and never reaches production.** `start.bat`
creates it from the committed `.env.example`, and `.env` is git-ignored in every
repo; the deployed servers have their own settings. Changing your local `.env`
cannot affect the live site. Put your own API keys
there and nowhere else — never in `.env.example`, which *is* committed. The
SSO values in `.env.example` are the one exception, on purpose: they only work
against a database on your machine, so they are not secrets.

**Never add a login that skips the password.** A "dev login" button that hands
out a session without credentials has a way of surviving into production, and
it hides the sign-in problems you actually need to see while developing. If
signing in is broken, fix the sign-in.
