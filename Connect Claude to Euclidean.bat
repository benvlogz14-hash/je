@echo off
rem Connects the Claude desktop app to the Euclidean app on this PC (adds the "euclidean" connector).
title Connect Claude to Euclidean
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mcp\connect-claude.ps1"
echo.
pause
