@echo off
rem One-time setup: puts the game online at your own domain through a Cloudflare Tunnel.
title Color Block Co-op - tunnel setup
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
node scripts\setup-tunnel.js %*
pause
