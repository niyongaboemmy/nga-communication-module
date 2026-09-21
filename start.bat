@echo off
setlocal enabledelayedexpansion
title Tupo - local development
cd /d "%~dp0"

echo ===================================================
echo    NGA Tupo  -  local development
echo ===================================================
echo.

:: ---------------------------------------------------------------- 1. Node.js
echo [1/6] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [X] Node.js is not installed, or not on your PATH.
    echo       Install the LTS build from https://nodejs.org/ and run this again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%V in ('node -v') do echo   - Node %%V

:: -------------------------------------------------------- 2. .env from template
echo [2/6] Checking configuration...
for %%A in (api web files realtime worker) do (
    if not exist "apps\%%A\.env" (
        if exist "apps\%%A\.env.example" (
            copy "apps\%%A\.env.example" "apps\%%A\.env" >nul
            echo   - Created apps\%%A\.env
        )
    )
)
if not exist "packages\db\.env" (
    if exist "packages\db\.env.example" (
        copy "packages\db\.env.example" "packages\db\.env" >nul
        echo   - Created packages\db\.env
    )
)
:: These files are git-ignored: your local settings can never be pushed.
:: An .env from an earlier setup pointed sign-in at the production MIS and
:: needed a secret pasted in. Sign-in now goes through the local MIS below, so
:: that file can never work again - say so rather than fail at the login page.
set "STALE_ENV="
findstr /R /C:"^NGA_MIS_BASE_URL=https://api.amashuri.com" /C:"PASTE_DEV_SECRET_FROM_MIS_SYSTEMS_PAGE" "apps\api\.env" >nul 2>&1
if not errorlevel 1 set "STALE_ENV=1"
findstr /R /C:"^VITE_MIS_LOGIN_URL=https://mis.amashuri.com" "apps\web\.env" >nul 2>&1
if not errorlevel 1 set "STALE_ENV=1"
if defined STALE_ENV (
    echo.
    echo   [warn] Your .env files point at the production MIS ^(an older setup^).
    echo          Tupo now signs in through a Central MIS on this machine, so
    echo          SIGNING IN WILL FAIL until they are updated. Easiest fix: move
    echo          any keys you added out of apps\api\.env and apps\web\.env,
    echo          delete both files, and run start.bat again.
    echo.
)
echo   - Configuration present

:: ------------------------------------------------------------ 3. Central MIS
:: Tupo has no login of its own - users sign in through the NGA Central MIS.
:: Like the Docker stack, we run a private copy of the MIS on this machine: its
:: own start.bat builds a local database seeded with a known admin login and
:: with this module's SSO client (backend/scripts/setup-local-db.ts), which is
:: what .env.example already points at. Nothing here touches the real MIS.
::
:: It is started now, in its own window, so its first-run install and database
:: build overlap with ours below. We only wait for it right before launch.
echo [3/6] Checking Central MIS...
set "MIS_REPO=https://github.com/niyongaboemmy/nga_central_mis.git"
set "MIS_STARTED="
call :port_open 5001
if not errorlevel 1 (
    echo   - Already running on http://localhost:5001
    goto :mis_started
)

:: Where is the MIS checkout? An explicit NGA_MIS_DIR wins; otherwise a clone
:: next to this folder, then the NGAMIS workspace layout used with docker-compose.
set "MIS_DIR="
if defined NGA_MIS_DIR if exist "%NGA_MIS_DIR%\start.bat" set "MIS_DIR=%NGA_MIS_DIR%"
if "!MIS_DIR!"=="" if exist "..\nga_central_mis\start.bat" set "MIS_DIR=..\nga_central_mis"
if "!MIS_DIR!"=="" if exist "..\..\Central MIS\nga_central_mis\start.bat" set "MIS_DIR=..\..\Central MIS\nga_central_mis"

if "!MIS_DIR!"=="" (
    echo   - Not found next to this folder. Cloning it ^(one time^)...
    where git >nul 2>&1
    if errorlevel 1 (
        echo.
        echo   [warn] Git is not installed, so the Central MIS cannot be fetched.
        echo          Install it from https://git-scm.com/ and run this again.
        echo          Tupo will start, but SIGNING IN WILL NOT WORK until then.
        echo.
        goto :mis_started
    )
    git clone "!MIS_REPO!" "..\nga_central_mis"
    if errorlevel 1 (
        :: A full clone is ~30k objects and a flaky connection resets it often.
        :: Git removes its own half-finished folder; a shallow clone is a
        :: fraction of the size, and history is not needed to run the MIS.
        echo.
        echo   - Download interrupted. Trying once more with a smaller download...
        if exist "..\nga_central_mis" if not exist "..\nga_central_mis\start.bat" rmdir /s /q "..\nga_central_mis"
        git clone --depth 1 "!MIS_REPO!" "..\nga_central_mis"
    )
    if not exist "..\nga_central_mis\start.bat" (
        echo.
        echo   [warn] Could not clone the Central MIS. Either the connection dropped
        echo          ^(just run start.bat again^) or you do not have access to its
        echo          repository yet ^(ask your team lead^).
        echo          Tupo will start, but SIGNING IN WILL NOT WORK until then.
        echo.
        goto :mis_started
    )
    set "MIS_DIR=..\nga_central_mis"
)
for %%D in ("!MIS_DIR!") do set "MIS_DIR=%%~fD"
echo   - Using !MIS_DIR!
echo   - Starting it in its own window
start "Central MIS - local development" /D "!MIS_DIR!" cmd /k .\start.bat
set "MIS_STARTED=1"
:mis_started

:: ------------------------------------------------------ 4. PostgreSQL + Redis
echo [4/6] Checking PostgreSQL and Redis...

:: Gate on the port, not on psql: plenty of machines run Postgres without its
:: bin folder on PATH, and refusing to start in that case would be wrong.
call :port_open 5432
if errorlevel 1 (
    echo.
    echo   [X] PostgreSQL is not running on port 5432. Start it, or install
    echo       PostgreSQL from https://www.postgresql.org/download/windows/
    echo       and run this again.
    echo.
    pause
    exit /b 1
)
echo   - PostgreSQL ready

:: Find psql so the database can be created automatically. Versions are read
:: from disk rather than hard-coded, newest first, so a new major release does
:: not silently break this.
set "PSQL_CMD="
where psql >nul 2>&1
if not errorlevel 1 set "PSQL_CMD=psql"
for /f "delims=" %%P in ('dir /b /ad /o-n "C:\Program Files\PostgreSQL" 2^>nul') do (
    if "!PSQL_CMD!"=="" if exist "C:\Program Files\PostgreSQL\%%P\bin\psql.exe" set "PSQL_CMD=C:\Program Files\PostgreSQL\%%P\bin\psql.exe"
)

if "!PSQL_CMD!"=="" (
    echo   - psql not found; skipping automatic database creation.
    echo     If the migration step below fails, create it yourself:  CREATE DATABASE tupo_dev;
) else (
    :: -w never prompts for a password, so this can't hang the script.
    "!PSQL_CMD!" -U postgres -h localhost -w -lqt 2>nul | findstr /C:"tupo_dev" >nul 2>&1
    if errorlevel 1 (
        echo   - Creating database tupo_dev...
        "!PSQL_CMD!" -U postgres -h localhost -w -c "CREATE DATABASE tupo_dev;" >nul 2>&1
        if errorlevel 1 (
            echo     Could not create it automatically ^(Postgres wants a password^).
            echo     Create it once by hand:  CREATE DATABASE tupo_dev;
        )
    ) else (
        echo   - Database tupo_dev ready
    )
)

call :port_open 6379
if errorlevel 1 (
    echo.
    echo   [warn] Redis is not running on port 6379. Chat, notifications and the
    echo       background worker will not work until it is. Everything else
    echo       will still start.
    echo.
) else (
    echo   - Redis ready
)

:: ----------------------------------------------------------- 5. Dependencies
echo [5/6] Checking dependencies and database schema...
if not exist "node_modules" (
    echo   - Installing workspace packages ^(first run, takes a few minutes^)...
    call npm install
)
echo   - Applying migrations...
call npm run db:migrate
call npm run db:seed
echo   - Dependencies ready

:: ----------------------------------------------------------------- 6. Launch
:: The MIS was started in parallel above; give it until now to come up.
if defined MIS_STARTED (
    echo   - Waiting for Central MIS on port 5001 ^(first run: a few minutes^)
    call :wait_port 5001 900
    if errorlevel 1 (
        echo.
        echo   [warn] Central MIS is still not answering after 15 minutes. Look at
        echo          the "Central MIS" window for what it is stuck on. Tupo
        echo          starts anyway, but signing in needs the MIS running.
        echo.
    ) else (
        echo   - Central MIS ready on http://localhost:5001
    )
)
echo [6/6] Starting Tupo...
echo.
echo ===================================================
echo   Open:      http://localhost:5194
echo   API:       http://localhost:5190
echo   Realtime:  http://localhost:5191
echo.
echo   Click Sign In - it takes you to your own Central
echo   MIS at localhost:5173. Sign in as
echo.
echo       superadmin  /  Admin@1234
echo.
echo   The 6-digit code is printed on the login page.
echo   Everything is local - production is never touched.
echo.
echo   Press Ctrl+C in this window to stop.
echo ===================================================
echo.
call npm run dev
pause

goto :eof

:: ---------------------------------------------------------------- helpers
:: Both gate on the TCP port rather than on a tool being on PATH: that is what
:: "the MIS is up" actually means, and it works whether it runs natively or in
:: Docker. PowerShell is used because cmd has no socket primitive of its own.

:: port_open <port>  ->  errorlevel 0 if something is listening
:port_open
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%1)).Close();exit 0}catch{exit 1}" >nul 2>&1
exit /b %errorlevel%

:: wait_port <port> <seconds>  ->  errorlevel 0 once it opens, 1 on timeout
:wait_port
powershell -NoProfile -Command "$d=(Get-Date).AddSeconds(%2);while((Get-Date) -lt $d){try{(New-Object Net.Sockets.TcpClient('127.0.0.1',%1)).Close();Write-Host '';exit 0}catch{};Write-Host -NoNewline '.';Start-Sleep 5};Write-Host '';exit 1"
exit /b %errorlevel%
