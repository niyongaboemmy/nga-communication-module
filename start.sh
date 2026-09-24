#!/usr/bin/env bash
# Tupo - local development on macOS / Linux.  Windows users: start.bat
#
# Same steps as start.bat: check Node, create .env files, make sure the
# database engine is up, install packages, then start everything. Run it
# again any time - it skips whatever is already done.
set -u
cd "$(dirname "$0")" || exit 1

# ---------------------------------------------------------------- helpers
say()  { printf '  - %s\n' "$*"; }
warn() { printf '\n  [warn] %s\n' "$1"; shift; for l in "$@"; do printf '         %s\n' "$l"; done; echo; }
die()  { printf '\n  [X] %s\n' "$1"; shift; for l in "$@"; do printf '      %s\n' "$l"; done; echo; read -r -p "Press Enter to close... " _; exit 1; }

# port_open <port>: something is listening on 127.0.0.1:<port>. Bash's /dev/tcp
# needs no extra tool; nc is the fallback for shells built without it.
port_open() {
    if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then exec 3>&-; return 0; fi
    command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$1" >/dev/null 2>&1
}
# wait_port <port> <seconds>: prints a dot every 5s until it opens; 1 on timeout.
wait_port() {
    local waited=0
    until port_open "$1"; do
        [ "$waited" -ge "$2" ] && { echo; return 1; }
        sleep 5; waited=$((waited + 5)); printf '.'
    done
    echo
}
# npm_install <label> <dir> <hint> [npm args...]: install once, retry once, then stop.
npm_install() {
    local label=$1 dir=$2 hint=$3; shift 3
    say "Installing $label$hint..."
    if ! (cd "$dir" && npm install "$@"); then
        say "That did not finish (usually the connection) - trying once more..."
        (cd "$dir" && npm install "$@") || die "Installing $label failed twice - see the error above." \
            "Check your connection and run ./start.sh again."
    fi
}

echo "==================================================="
echo "   NGA Tupo  -  local development"
echo "==================================================="
echo
echo "[1/6] Checking Node.js..."
command -v node >/dev/null 2>&1 || die "Node.js is not installed, or not on your PATH." \
    "Install the LTS build from https://nodejs.org/ and run this again."
say "Node $(node -v)"

# Creating .env only when it is missing never repairs one, and an .env written
# during an earlier setup keeps pointing wherever it pointed then - for most
# people the production MIS, so sign-in redirects there and fails. The script
# fills in a missing file and, in one that exists, replaces only the settings
# that wire the modules on this machine together (URLs, SSO client id/secret).
# Your own keys are left alone and the old file is kept as .env.bak.
echo "[2/6] Checking configuration..."
node scripts/sync-local-env.cjs apps/api apps/web apps/files apps/realtime apps/worker packages/db \n    || die "Could not write the apps/*/.env files - see the error above."
# These files are git-ignored: your local settings can never be pushed.
say "Configuration present"


# ------------------------------------------------------------ 3. Central MIS
# Tupo has no login of its own - users sign in through the NGA Central MIS.
# Like the Docker stack, we run a private copy of the MIS on this machine: its
# own start.sh builds a local database seeded with a known admin login and with
# this module's SSO client (backend/scripts/setup-local-db.ts), which is what
# .env.example already points at. Nothing here touches the real MIS.
#
# It is started now, in its own window, so its first-run install and database
# build overlap with ours below. We only wait for it right before launch.
echo "[3/6] Checking Central MIS..."
MIS_REPO="https://github.com/niyongaboemmy/nga_central_mis.git"
MIS_STARTED=""
if port_open 5001; then
    say "Already running (API answering on port 5001)"
else
    # Where is the MIS checkout? An explicit NGA_MIS_DIR wins; otherwise a clone
    # next to this folder, then the NGAMIS workspace layout used with docker-compose.
    MIS_DIR=""
    if [ -n "${NGA_MIS_DIR:-}" ] && [ -f "$NGA_MIS_DIR/start.sh" ]; then MIS_DIR="$NGA_MIS_DIR"
    elif [ -f "../nga_central_mis/start.sh" ]; then MIS_DIR="../nga_central_mis"
    elif [ -f "../../Central MIS/nga_central_mis/start.sh" ]; then MIS_DIR="../../Central MIS/nga_central_mis"
    fi

    if [ -z "$MIS_DIR" ]; then
        say "Not found next to this folder. Cloning it (one time)..."
        if ! command -v git >/dev/null 2>&1; then
            warn "Git is not installed, so the Central MIS cannot be fetched." \
                 "Install it (macOS: xcode-select --install) and run this again." \
                 "Tupo will start, but SIGNING IN WILL NOT WORK until then."
        else
            if ! git clone "$MIS_REPO" "../nga_central_mis"; then
                # A full clone is ~30k objects and a flaky connection resets it often.
                # Git removes its own half-finished folder; a shallow clone is a
                # fraction of the size, and history is not needed to run the MIS.
                echo
                say "Download interrupted. Trying once more with a smaller download..."
                [ -d "../nga_central_mis" ] && [ ! -f "../nga_central_mis/start.sh" ] && rm -rf "../nga_central_mis"
                git clone --depth 1 "$MIS_REPO" "../nga_central_mis" || true
            fi
            if [ -f "../nga_central_mis/start.sh" ]; then
                MIS_DIR="../nga_central_mis"
            else
                warn "Could not clone the Central MIS. Either the connection dropped" \
                     "(just run ./start.sh again) or you do not have access to its" \
                     "repository yet (ask your team lead)." \
                     "Tupo will start, but SIGNING IN WILL NOT WORK until then."
            fi
        fi
    fi

    if [ -n "$MIS_DIR" ]; then
        MIS_DIR="$(cd "$MIS_DIR" && pwd)"
        say "Using $MIS_DIR"
        # A second window, like start.bat's: Terminal on macOS, a terminal
        # emulator on Linux, else a background process logging to a file.
        if [ "$(uname)" = "Darwin" ]; then
            say "Starting it in a new Terminal window"
            osascript -e "tell application \"Terminal\" to do script \"cd '$MIS_DIR' && bash ./start.sh\"" >/dev/null
        elif command -v x-terminal-emulator >/dev/null 2>&1; then
            say "Starting it in a new terminal window"
            x-terminal-emulator -e bash -c "cd '$MIS_DIR' && bash ./start.sh; exec bash" >/dev/null 2>&1 &
        elif command -v gnome-terminal >/dev/null 2>&1; then
            say "Starting it in a new terminal window"
            gnome-terminal -- bash -c "cd '$MIS_DIR' && bash ./start.sh; exec bash" >/dev/null 2>&1 &
        else
            MIS_LOG="${TMPDIR:-/tmp}/central-mis.log"
            say "Starting it in the background (output: $MIS_LOG)"
            (cd "$MIS_DIR" && nohup bash ./start.sh </dev/null >"$MIS_LOG" 2>&1 &)
        fi
        MIS_STARTED=1
    fi
fi

# ------------------------------------------------------ 4. PostgreSQL + Redis
echo "[4/6] Checking PostgreSQL and Redis..."
# Gate on the port, not on psql: plenty of machines run Postgres without its
# bin folder on PATH, and refusing to start in that case would be wrong.
port_open 5432 || die "PostgreSQL is not running on port 5432. Start it (macOS:" \
    "brew services start postgresql@16, or open Postgres.app) and run this again."
say "PostgreSQL ready"

# Find psql so the database can be created automatically.
PSQL_CMD=""
for c in psql /opt/homebrew/opt/postgresql@16/bin/psql /opt/homebrew/opt/postgresql@17/bin/psql \
         /usr/local/opt/postgresql@16/bin/psql /Applications/Postgres.app/Contents/Versions/latest/bin/psql; do
    if command -v "$c" >/dev/null 2>&1; then PSQL_CMD="$(command -v "$c")"; break; fi
done
if [ -z "$PSQL_CMD" ]; then
    say "psql not found; skipping automatic database creation."
    echo "    If the migration step below fails, create it yourself:  CREATE DATABASE tupo_dev;"
else
    # -w never prompts for a password, so this cannot hang the script. Homebrew's
    # Postgres has no 'postgres' role by default - the current user is the superuser.
    PG_USER="postgres"; "$PSQL_CMD" -U postgres -h localhost -w -c "SELECT 1" >/dev/null 2>&1 || PG_USER="$(id -un)"
    if "$PSQL_CMD" -U "$PG_USER" -h localhost -w -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw tupo_dev; then
        say "Database tupo_dev ready"
    else
        say "Creating database tupo_dev..."
        "$PSQL_CMD" -U "$PG_USER" -h localhost -w -c "CREATE DATABASE tupo_dev;" >/dev/null 2>&1 \
            || { echo "    Could not create it automatically (Postgres wants a password)."; echo "    Create it once by hand:  CREATE DATABASE tupo_dev;"; }
    fi
fi

if port_open 6379; then
    say "Redis ready"
else
    warn "Redis is not running on port 6379. Chat, notifications and the" \
         "background worker will not work until it is (macOS: brew services" \
         "start redis). Everything else will still start."
fi

# ----------------------------------------------------------- 5. Dependencies
echo "[5/6] Checking dependencies and database schema..."
# Test for the tool each dev script actually runs, not just the folder: an
# `npm install` cut off half-way leaves node_modules present but without its
# .bin entries, and the app then dies with "vite: command not found".
# Re-running npm install repairs such a folder, so that is the fix as well
# as the first-run path.
[ -f "node_modules/.bin/concurrently" ] || npm_install "workspace packages" . " (first run, takes a few minutes)"
say "Applying migrations..."
npm run db:migrate
npm run db:seed
say "Dependencies ready"

# ----------------------------------------------------------------- 6. Launch
# The MIS was started in parallel above; give it until now to come up.
# Two ports matter: 5001 is the API this server talks to, 5173 is the login
# page the browser is sent to. Both come from the MIS's `npm run dev`, but the
# API is the slow one, so wait on it first and confirm each.
if [ -n "$MIS_STARTED" ]; then
    say "Waiting for Central MIS (first run: a few minutes)"
    if wait_port 5001 900; then
        say "Central MIS API ready         http://localhost:5001"
        if wait_port 5173 120; then
            say "Central MIS login page ready  http://localhost:5173/login"
        else
            warn "The MIS API is up but its login page (port 5173) is not." \
                 "Check the Central MIS window for a frontend error."
        fi
    else
        warn "Central MIS is still not answering after 15 minutes. Look at" \
             "the Central MIS window for what it is stuck on. Tupo" \
             "starts anyway, but signing in needs the MIS running."
    fi
else
    if port_open 5173; then
        say "Central MIS login page ready  http://localhost:5173/login"
    else
        warn "An MIS API answers on 5001 but nothing serves its login page" \
             "on 5173, so Sign In will dead-end. Start the MIS frontend too."
    fi
fi
echo "[6/6] Starting Tupo..."
echo
echo "==================================================="
echo "  Open:      http://localhost:5194"
echo "  API:       http://localhost:5190"
echo "  Realtime:  http://localhost:5191"
echo
echo "  Click Sign In - it takes you to your own Central"
echo "  MIS at localhost:5173. Sign in as"
echo
echo "      superadmin  /  Admin@1234"
echo
echo "  or as any role - dev.teacher, dev.student,"
echo "  dev.admin ... same password. Full list in"
echo "  guides/START_HERE.pdf"
echo
echo "  Press Ctrl+C in this window to stop."
echo "==================================================="
echo
npm run dev
read -r -p "Press Enter to close... " _
