@echo off
title Delete rejected videos
rem Deletes the rendered videos (.mp4) of clips you rejected, to free disk space. Footage and every other clip stay.
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node "scripts\delete-rejected.js"
) else (
  set ELECTRON_RUN_AS_NODE=1
  "node_modules\electron\dist\electron.exe" "scripts\delete-rejected.js"
)
echo.
pause
