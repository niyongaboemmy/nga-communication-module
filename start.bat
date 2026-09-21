@echo off
setlocal enabledelayedexpansion
title Tupo - local development
cd /d "%~dp0"

echo ===================================================
echo    NGA Tupo  -  local development
echo ===================================================
echo.

:: ---------------------------------------------------------------- 1. Node.js
echo [1/5] Checking Node.js...
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
echo [2/5] Checking configuration...
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
findstr /C:"PASTE_DEV_SECRET_FROM_MIS_SYSTEMS_PAGE" "apps\api\.env" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo   [X] apps\api\.env still has a placeholder SSO secret, so signing in
    echo       will fail. Ask the team lead for the Tupo dev SSO secret, then
    echo       put it in apps\api\.env as:
    echo           SSO_CLIENT_SECRET=...
    echo.
    pause
    exit /b 1
)
echo   - Configuration present

:: ------------------------------------------------------ 3. PostgreSQL + Redis
echo [3/5] Checking PostgreSQL and Redis...

:: Gate on the port, not on psql: plenty of machines run Postgres without its
:: bin folder on PATH, and refusing to start in that case would be wrong.
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',5432)).Close();exit 0}catch{exit 1}" >nul 2>&1
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

powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',6379)).Close();exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [warn] Redis is not running on port 6379. Chat, notifications and the
    echo       background worker will not work until it is. Everything else
    echo       will still start.
    echo.
) else (
    echo   - Redis ready
)

:: ----------------------------------------------------------- 4. Dependencies
echo [4/5] Checking dependencies and database schema...
if not exist "node_modules" (
    echo   - Installing workspace packages ^(first run, takes a few minutes^)...
    call npm install
)
echo   - Applying migrations...
call npm run db:migrate
call npm run db:seed
echo   - Dependencies ready

:: ----------------------------------------------------------------- 5. Launch
echo [5/5] Starting Tupo...
echo.
echo ===================================================
echo   Open:      http://localhost:5194
echo   API:       http://localhost:5190
echo   Realtime:  http://localhost:5191
echo.
echo   Clicking Sign In takes you to the real MIS at
echo   mis.amashuri.com, which sends you straight back
echo   here once you are logged in.
echo.
echo   Ask your team lead for the MIS admin login.
echo.
echo   Press Ctrl+C in this window to stop.
echo ===================================================
echo.
call npm run dev
pause
