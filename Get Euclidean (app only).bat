@echo off
setlocal EnableExtensions
title Get Euclidean (app only)

rem App only: downloads the latest Euclidean into your user folder (or updates it), then starts it.
rem For PCs that already have Ollama, the AI models and the other tools. Use "Get Euclidean.bat" for a full setup.
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
del /q "%TMPZIP%" >nul 2>nul
rmdir /s /q "%TMPDIR%" >nul 2>nul

if not exist "%DEST%\Start Euclidean.bat" (
  echo.
  echo   Something went wrong copying the files. Try again.
  pause
  exit /b 1
)

echo   Done. Starting Euclidean ...
echo.
call "%DEST%\Start Euclidean.bat"
