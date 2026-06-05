@echo off
cd /d "%~dp0"
title Trend Scraper Launcher

echo ========================================================
echo     Trend Report Auto-Scraper Launcher (Windows)
echo ========================================================
echo.
echo [1/3] Checking Node.js environment...
where node >nul 2>nul
if errorlevel 1 goto NoNode
echo - Node.js is ready.

echo.
echo [2/3] Checking and installing packages...
echo (This may take a few minutes for the first run)
call npm install

echo.
echo [3/3] Starting the Dashboard Server...
echo ========================================================
echo       Do NOT close this window while running!
echo       To stop the server, just close this window.
echo ========================================================

REM Wait for port 3000 to be active in the background before launching the browser
start "" powershell -WindowStyle Hidden -Command "while ($true) { try { $c = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 3000); if ($c.Connected) { $c.Close(); break } } catch {} Start-Sleep -Milliseconds 500 }; Start-Process 'http://localhost:3000'"

REM Start server
call npm run dev
exit /b

:NoNode
echo ========================================================
echo [ERROR] Node.js is not installed on this system!
echo Please download and install LTS version from: https://nodejs.org
echo Once installed, restart this file.
echo ========================================================
echo.
pause
exit /b
