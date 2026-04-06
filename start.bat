@echo off
title Solana Universal Indexer

echo === Solana Universal Indexer ===
echo.

:: Setup .env if missing
if not exist .env (
    echo [SETUP] Copying .env.example to .env...
    copy .env.example .env >nul
    echo [SETUP] .env created. Edit it with your PROGRAM_ID and RPC_URL, then re-run.
    echo.
    notepad .env
    pause
    exit /b 0
)

:: Install dependencies if node_modules missing
if not exist node_modules (
    echo [SETUP] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
)

:: Build TypeScript
echo [BUILD] Compiling TypeScript...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)

:: Start server
echo.
echo [START] Starting indexer on http://localhost:3000
echo [START] Dashboard: http://localhost:3000/dashboard
echo [START] Press Ctrl+C to stop
echo.
call npm start
pause
