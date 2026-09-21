# Running your NGA module locally

Same guide in every NGA repo. Two steps, about fifteen minutes.

```
1. Install what your module needs (table below)
2. Double-click  start.bat
```

`start.bat` does the rest: creates your config files, installs packages, builds
your local database, and starts everything. Run it again any time — it skips
whatever is already done.

---

## 1. Install the prerequisites

Everyone needs **[Node.js](https://nodejs.org/) 20 or newer** (the LTS
download). Then, depending on your module:

| Your module | Also install | Database it creates |
|---|---|---|
| **TaskMentor** | MySQL 8, or XAMPP | `taskmentor_dev` (local MySQL) |
| **Tendo** | nothing | a SQLite file in `server/data/` |
| **Tupo** | PostgreSQL 16 + Redis | `tupo_dev` (local Postgres) |
| **Central MIS** | MySQL 8, or XAMPP | `ngarw_mis` (local MySQL) |

If you use XAMPP, open the Control Panel and press **Start** next to MySQL
before running `start.bat`.

**Every database is on your own machine.** Nothing you do locally can touch
production data.

## 2. Run start.bat

```
git clone <your module's repo>
cd <the folder it made>
start.bat
```

First run takes a few minutes (packages and database). After that it is quick.

When it finishes it prints the address to open:

| Module | Open this | API |
|---|---|---|
| **Central MIS** | http://localhost:5173 | 5001 |
| **TaskMentor** | http://localhost:5174/taskmentor | 5002 |
| **Tendo** | http://localhost:3000 | 5171 |
| **Tupo** | http://localhost:5194 | 5190 |

---

## Signing in

Your module has **no login of its own**. Click *Sign In* and you are taken to
the NGA Central MIS, which sends you straight back, signed in:

```
   your module  ──▶  MIS login page  ──▶  back to localhost, signed in
```

**Working on TaskMentor, Tendo or Tupo?** The login page is the real MIS at
**mis.amashuri.com**. **Ask your team lead for the admin login** — that account
has the permissions you need to see everything while you work.

**Working on Central MIS itself?** Your own copy is the login page. Sign in as
`superadmin` / `Admin@1234`. It then asks for a 6-digit code, which is
**printed on the login page** — no email is sent in development.

---

## If something goes wrong

**"Placeholder SSO secret" when start.bat runs**
Your repo's `.env.example` has not been filled in with the dev SSO secret yet.
Ask your team lead for it, then open `server/.env` (Tupo: `apps/api/.env`) and
put it on the `SSO_CLIENT_SECRET=` line.

**"Redirect URI not allowed" after clicking Sign In**
Your dev server is on a different port than the one registered with the MIS —
usually because the port was busy and Vite moved. Stop whatever is using the
port in the table above and start again. Do not change the port: the MIS matches
it exactly.

**"Invalid client credentials"**
The `SSO_CLIENT_SECRET` in your `.env` is wrong or stale. Ask your team lead.

**Port already in use**
Something else has the port. Find it and stop it rather than changing the port,
or sign-in breaks. `netstat -ano | findstr :5174`

**MySQL not found / not running**
Start MySQL in the XAMPP Control Panel, or install MySQL 8, then run
`start.bat` again.

**I want to start the database over**
TaskMentor: drop `taskmentor_dev` and re-run `start.bat`.
Tendo: delete `server/data/` and re-run.
Tupo: `npm run db:migrate`.
Central MIS: `cd backend && npm run db:setup -- --force`.

---

## Two things worth knowing

**Your `.env` is never pushed.** `start.bat` creates it from the committed
`.env.example`, and `.env` is git-ignored in every repo. Put your secrets there
and nowhere else — never in `.env.example`, which *is* committed.

**Never add a login that skips the password.** A "dev login" button that hands
out a session without credentials has a way of surviving into production, and
it hides the sign-in problems you actually need to see while developing. If
signing in is broken, fix the sign-in.
