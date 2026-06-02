@echo off
REM ── LabMate launcher ───────────────────────────────────────────────────
REM Double-click this file to start LabMate. It launches the local
REM server and opens the app in your default browser.
cd /d "%~dp0"
echo Starting LabMate...
echo.
echo The app will open in your browser. Keep this window open while using it.
echo Close this window to stop the app.
echo.
node server.js
pause
