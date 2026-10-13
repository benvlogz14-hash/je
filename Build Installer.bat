@echo off
setlocal EnableExtensions
title Build Euclidean installer
cd /d "%~dp0"
set "PATH=%PATH%;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Microsoft\WinGet\Links"

where node >nul 2>nul
if errorlevel 1 (
  echo Run "Start Euclidean.bat" once first: it installs everything needed.
  pause
  exit /b 1
)
echo Installing packages...
call npm install --no-audit --no-fund || goto :fail
echo Building the installer (this takes a few minutes)...
call npm run dist || goto :fail
echo.
echo Done. The installer is in the "dist" folder.
start "" "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo The build failed. Scroll up to see why.
pause
exit /b 1
