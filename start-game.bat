@echo off
rem Starts the game server and the Cloudflare Tunnel. Close the window or press Ctrl+C to stop.
title Color Block Co-op
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
node scripts\start-game.js %*
pause
