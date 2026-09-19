@echo off
setlocal enabledelayedexpansion
title Tupo - 1-Click Dev Launcher
cd /d "%~dp0"

echo ===================================================
echo       NGA Tupo - 1-Click Local Dev
echo ===================================================
echo.

:: 1. Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js (v20+) from https://nodejs.org/
    pause
    exit /b 1
)

:: 2. Install dependencies if needed
echo [1/3] Checking dependencies...
if not exist "node_modules" (
    echo   - Installing monorepo workspace dependencies...
    call npm install
)

:: 3. Database migrations & seeds
echo [2/3] Setting up database...
call npm run db:migrate
call npm run db:seed

:: 4. Start development servers
echo [3/3] Starting Tupo services...
echo.
echo ===================================================
echo   Web:      http://localhost:5194
echo   API:      http://localhost:5190
echo   Realtime: http://localhost:5191
echo ===================================================
echo.
call npm run dev
pause
