@echo off
title Euclidean phone app
cd /d "%~dp0mobile"
where node >nul 2>nul || (echo Node.js is missing. Run "Start Euclidean.bat" once first, then try again. & pause & exit /b 1)
if not exist node_modules (
  echo Getting the phone app ready. This takes a few minutes the first time...
  call npm install --no-fund --no-audit || (echo Could not download the phone app's parts. Check the internet connection and try again. & pause & exit /b 1)
)
echo.
echo  1. On your iPhone, install "Expo Go" from the App Store (free).
echo  2. Make sure the iPhone is on the same Wi-Fi as this computer.
echo  3. Scan the QR code below with the iPhone Camera app and tap "Open in Expo Go".
echo  4. In the app, tap "Scan the code" and scan the code in Euclidean:
echo     Settings ^> General ^> Use on your iPhone.
echo.
echo  If Windows asks about network access, click Allow.
echo  If the phone can't connect, close this window and run it again with: Start Phone App.bat tunnel
echo.
if /i "%~1"=="tunnel" (call npx expo start --tunnel) else (call npx expo start --lan)
pause
