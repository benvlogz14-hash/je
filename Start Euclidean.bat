@echo off
setlocal EnableExtensions
title Euclidean
cd /d "%~dp0"

rem Tools installed by winget become usable without restarting Windows.
set "PATH=%PATH%;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Microsoft\WinGet\Links;%APPDATA%\npm"

echo.
echo   Euclidean
echo   ---------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Installing Node.js ^(one time only^)...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   Node.js could not be installed automatically.
    echo   Please install "Node.js LTS" from https://nodejs.org and double-click this file again.
    start "" "https://nodejs.org"
    pause
    exit /b 1
  )
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo   Installing FFmpeg for video ^(one time only^)...
  winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements --silent
)

where yt-dlp >nul 2>nul
if errorlevel 1 (
  echo   Installing yt-dlp for YouTube/TikTok links and creator stats ^(one time only^)...
  winget install -e --id yt-dlp.yt-dlp --accept-package-agreements --accept-source-agreements --silent >nul 2>nul
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo   Setting up Euclidean ^(one time only, takes a few minutes^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   Setup failed. Check the internet connection and double-click this file again.
    pause
    exit /b 1
  )
)

rem Desktop shortcut so next time it is one click (always pointed at this copy, so an old copy never opens by mistake).
(
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Euclidean.lnk'); $s.TargetPath='%~dp0Start Euclidean.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0build\icon.ico'; $s.WindowStyle=7; $s.Save()" >nul 2>nul
)

rem Start menu entry pointing at this copy too (an old installer copy used the same name).
(
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:APPDATA+'\Microsoft\Windows\Start Menu\Programs\Euclidean.lnk'); $s.TargetPath='%~dp0Start Euclidean.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0build\icon.ico'; $s.WindowStyle=7; $s.Save()" >nul 2>nul
)

rem Free speech-to-text: install it now if this copy doesn't have it yet.
set "HAVEWH="
for /f "delims=" %%F in ('dir /s /b "%~dp0tools\whisper\whisper-cli.exe" 2^>nul') do set "HAVEWH=1"
if not defined HAVEWH if exist "%~dp0Install Extras.bat" call "%~dp0Install Extras.bat" whisper

rem Close any Euclidean still running from another folder (it hides in the tray), so this copy is the one that opens.
powershell -NoProfile -Command "Get-Process electron,Euclidean -ErrorAction SilentlyContinue | Where-Object { $_.Path -and -not $_.Path.StartsWith('%~dp0', [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force" >nul 2>nul

echo   Opening Euclidean...
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
