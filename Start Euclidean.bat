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

rem Desktop shortcut so next time it is one click.
if not exist "%USERPROFILE%\Desktop\Euclidean.lnk" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Euclidean.lnk'); $s.TargetPath='%~dp0Start Euclidean.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0build\icon.ico'; $s.WindowStyle=7; $s.Save()" >nul 2>nul
)

echo   Opening Euclidean...
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
