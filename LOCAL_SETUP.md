# Running your NGA module locally

Same guide in every NGA repo. Two steps, about fifteen minutes.

```
1. Install what your module needs (table below)
2. Double-click  start.bat
```

`start.bat` does the rest: creates your config files, installs packages, builds
your local database, **starts your own copy of the Central MIS**, and starts
your module. Run it again any time — it skips whatever is already done.

---

## 1. Install the prerequisites

Everyone needs:

- **[Node.js](https://nodejs.org/) 20 or newer** (the LTS download)
- **[Git](https://git-scm.com/)** — `start.bat` uses it to fetch the Central MIS
- **MySQL 8, or [XAMPP](https://www.apachefriends.org/)** — the Central MIS
  keeps its database there. If you use XAMPP, open the Control Panel and press
  **Start** next to MySQL before running `start.bat`.

Then, depending on your module:

| Your module | Also install | Databases it creates (all on your machine) |
|---|---|---|
| **TaskMentor** | nothing more | `taskmentor_dev` + `ngarw_mis` (MySQL) |
| **Tendo** | nothing more | a SQLite file in `server/data/` + `ngarw_mis` (MySQL) |
| **Tupo** | PostgreSQL 16 + Redis | `tupo_dev` (Postgres) + `ngarw_mis` (MySQL) |
| **Central MIS** | nothing more | `ngarw_mis` (MySQL) |

**Every database is on your own machine.** Nothing you do locally can touch
production data.

## 2. Run start.bat

```
git clone <your module's repo>
cd <the folder it made>
start.bat
```

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

**Every local account uses the password `Admin@1234`:**

| Username | Role | Notes |
|---|---|---|
| `superadmin` | SUPER_ADMIN | sees everything |
| `dev.admin` | ADMIN | |
| `dev.headteacher` | HEAD_TEACHER | |
| `dev.teacher` | TEACHER | 3 subjects in the current year's main class |
| `dev.classteacher` | CLASS_TEACHER + TEACHER | class teacher of that class |
| `dev.student` | STUDENT | enrolled in that class and its subjects |
| `dev.parent` | PARENT | parent of `dev.student` |
| `dev.accountant` | ACCOUNTANT | |
| `dev.staff` | STAFF | |
| `dev.programmanager` | PROGRAM_MANAGER | leads that class's program |

The same logins work in TaskMentor, Tendo and Tupo, which read the role from
the MIS. These accounts exist only in the `ngarw_mis` database on your machine
(their `@nga.test` emails cannot receive mail); production has none of them.
The MIS's `npm run db:setup` creates them, and its `start.bat` re-applies them
on every start (`db:setup -- --refresh`), so a database built before they
existed gets them too. A printable one-page version is `guides/START_HERE.pdf`.

---

## How the Central MIS gets there

The satellite modules (TaskMentor, Tendo, Tupo) need a Central MIS to sign in
against, exactly as the Docker stack does. Their `start.bat` looks for it in
this order and uses the first hit:

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

**"Your .env files point at the production MIS" when start.bat runs**
You ran an older `start.bat` that pointed sign-in at `mis.amashuri.com`. Move
any API keys you added out of `server/.env` and `client/.env` (Tupo:
`apps/api/.env` and `apps/web/.env`), delete both files, and run `start.bat`
again — it recreates them from the current templates.

**The Central MIS window shows an error**
Read it — it says what is missing. The usual one is MySQL not running: start it
in the XAMPP Control Panel and press a key in that window to retry. Your module
keeps waiting for the MIS for up to 15 minutes, then starts without it.

**"Redirect URI not allowed" after clicking Sign In**
Your dev server is on a different port than the one registered with the MIS —
usually because the port was busy and Vite moved. Stop whatever is using the
port in the table above and start again. Do not change the port: the MIS matches
it exactly.

**"Invalid client credentials"**
The `SSO_CLIENT_SECRET` in your `.env` does not match your MIS database. Both
should be `local-dev-secret-<client_id>`; if you changed one, restore it, or
rebuild the MIS database: `cd backend && npm run db:setup -- --force`.

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

**Your `.env` is never pushed.** `start.bat` creates it from the committed
`.env.example`, and `.env` is git-ignored in every repo. Put your own API keys
there and nowhere else — never in `.env.example`, which *is* committed. The
SSO values in `.env.example` are the one exception, on purpose: they only work
against a database on your machine, so they are not secrets.

**Never add a login that skips the password.** A "dev login" button that hands
out a session without credentials has a way of surviving into production, and
it hides the sign-in problems you actually need to see while developing. If
signing in is broken, fix the sign-in.
