@echo off
setlocal EnableExtensions
title Open Euclidean
rem Opens the newest Euclidean (the copy Get Euclidean puts in your user folder) and fixes the desktop shortcut to point at it.
set "DEST=%USERPROFILE%\Euclidean"
if not exist "%DEST%\Start Euclidean.bat" (
  echo.
  echo   The new Euclidean isn't on this PC yet.
  echo   Double-click "Get Euclidean (app only).bat" first, then this file.
  echo.
  pause
  exit /b 1
)
del /q "%USERPROFILE%\Desktop\Euclidean.lnk" >nul 2>nul
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do del /q "%%D\Euclidean.lnk" >nul 2>nul
call "%DEST%\Start Euclidean.bat"
