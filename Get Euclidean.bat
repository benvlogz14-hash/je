@echo off
setlocal EnableExtensions
title Get Euclidean

rem Downloads the latest Euclidean into your user folder (or updates it), then starts it.
rem Your clients, settings and keys live in a separate data folder and are never touched.
set "BRANCH=claude/agent-connections-setup-i1v6qt"
set "URL=https://github.com/benvlogz14-hash/je/archive/refs/heads/%BRANCH%.zip"
set "DEST=%USERPROFILE%\Euclidean"
set "TMPZIP=%TEMP%\euclidean-download.zip"
set "TMPDIR=%TEMP%\euclidean-download"

echo.
echo   Getting Euclidean
echo   -----------------
echo.
echo   Closing any Euclidean that is still running in the background...
taskkill /f /im electron.exe >nul 2>nul
taskkill /f /im Euclidean.exe >nul 2>nul
rem An older copy made with the installer would keep opening instead of this one: remove it (your clients, keys and settings stay).
for %%U in ("%LOCALAPPDATA%\Programs\Euclidean\Uninstall Euclidean.exe" "%LOCALAPPDATA%\Programs\euclidean\Uninstall Euclidean.exe" "%ProgramFiles%\Euclidean\Uninstall Euclidean.exe") do if exist %%U (
  echo   Removing an older installed copy of Euclidean ^(your clients and settings stay^)...
  start "" /wait %%U /S
  timeout /t 6 /nobreak >nul
)
timeout /t 2 /nobreak >nul
echo   Downloading the latest version...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%TMPZIP%'"
if not exist "%TMPZIP%" (
  echo.
  echo   The download didn't work. Check your internet connection and try again.
  pause
  exit /b 1
)

echo   Unpacking...
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%TMPZIP%' -DestinationPath '%TMPDIR%' -Force"
set "SRC="
for /d %%D in ("%TMPDIR%\*") do set "SRC=%%D"
if not defined SRC (
  echo.
  echo   The download was damaged. Try again.
  pause
  exit /b 1
)

echo   Installing to %DEST% ...
if not exist "%DEST%" mkdir "%DEST%"
robocopy "%SRC%" "%DEST%" /E /NFL /NDL /NJH /NJS /NP /XD node_modules >nul
rem Version stamp: the bottom bar of the app shows it, so you can see the new copy is the one open.
>"%DEST%\BUILD.txt" echo %date% %time:~0,5%
del /q "%TMPZIP%" >nul 2>nul
rmdir /s /q "%TMPDIR%" >nul 2>nul

if not exist "%DEST%\Start Euclidean.bat" (
  echo.
  echo   Something went wrong copying the files. Try again.
  pause
  exit /b 1
)

echo   Installing everything Euclidean uses (skips anything you already have)...
call "%DEST%\Install Extras.bat"

echo   Done. Starting Euclidean (the first start installs what it needs and takes a few minutes)...
echo.
call "%DEST%\Start Euclidean.bat"
