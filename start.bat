@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Download it from https://nodejs.org ^& pause ^& exit /b)
start "" http://localhost:3000
node server.js
pause
