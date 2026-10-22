@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Euclidean extras
cd /d "%~dp0"

rem Everything Euclidean can use, installed once. Anything already on this PC is skipped.
rem   Node.js, FFmpeg, yt-dlp      (videos, links, creator stats)
rem   Python + rembg + its model    (free photo cut-outs)
rem   Ollama + Llama 3.2            (free AI on this PC, about 2 GB)
rem   Llama 3.2 Vision              (free AI that can see video, about 8 GB)
rem   whisper.cpp + English model   (free speech-to-text, about 150 MB)
rem   Visual C++ runtime            (needed by whisper.cpp)

set "PATH=%PATH%;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Microsoft\WinGet\Links;%APPDATA%\npm;%LOCALAPPDATA%\Programs\Ollama;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts"
set "W=winget install -e --accept-package-agreements --accept-source-agreements --silent --id"

rem "Install Extras.bat whisper" installs only the free speech-to-text tool (used by the app-only bat).
if /i "%~1"=="whisper" (
  echo.
  echo   Installing free speech-to-text ^(Whisper, about 150 MB, one time^)...
  call :whisper
  exit /b 0
)

echo.
echo   Euclidean extras
echo   ----------------
echo   This downloads about 11 GB the first time. Leave this window open.
echo.

where winget >nul 2>nul
if errorlevel 1 (
  echo   This PC doesn't have the Windows app installer ^(winget^).
  echo   Open the Microsoft Store, install "App Installer", then double-click this file again.
  start "" "ms-windows-store://pdp/?productid=9NBLGGH4NNS1"
  pause
  exit /b 1
)

call :tool node    OpenJS.NodeJS.LTS            "Node.js"
call :tool ffmpeg  Gyan.FFmpeg                  "FFmpeg (makes the videos)"
call :tool yt-dlp  yt-dlp.yt-dlp                "yt-dlp (downloads video links)"
call :tool python  Python.Python.3.12           "Python (for the photo cut-out tool)"
call :tool ollama  Ollama.Ollama                "Ollama (free AI on this PC)"

echo   [..] Visual C++ runtime
%W% Microsoft.VCRedist.2015+.x64 >nul 2>nul
echo   [ok] Visual C++ runtime

rem ---- Photo cut-out tool and its model
where rembg >nul 2>nul
if errorlevel 1 (
  echo   [..] Photo cut-out tool ^(a few hundred MB^)
  python -m pip install --user --upgrade --quiet "rembg[cli]" >nul 2>nul
)
python -c "from rembg import new_session; new_session('u2net_human_seg')" >nul 2>nul
if errorlevel 1 (echo   [!!] Photo cut-out tool didn't install. The app's checklist has a button to retry.) else (echo   [ok] Photo cut-out tool)

rem ---- Ollama: start it and download both models
ollama list >nul 2>nul
if errorlevel 1 (
  start "" /min ollama serve
  timeout /t 6 /nobreak >nul
)
ollama list 2>nul | findstr /i /c:"llama3.2:" | findstr /v /i "vision" >nul
if errorlevel 1 (
  echo   [..] Llama 3.2 model ^(about 2 GB^)
  ollama pull llama3.2
)
echo   [ok] Llama 3.2
ollama list 2>nul | findstr /i "llama3.2-vision" >nul
if errorlevel 1 (
  echo   [..] Llama 3.2 Vision model ^(about 8 GB, lets Euclidean see video for free^)
  ollama pull llama3.2-vision
)
echo   [ok] Llama 3.2 Vision

call :whisper

echo.
echo   All set. Anything marked [!!] can be retried from Settings, Agent Connections in the app.
echo.
exit /b 0

:whisper
rem ---- whisper.cpp and the English model, next to the app (Euclidean finds them on start)
%W% Microsoft.VCRedist.2015+.x64 >nul 2>nul
set "WH=%~dp0tools\whisper"
if not exist "%WH%" mkdir "%WH%"
dir /s /b "%WH%\whisper-cli.exe" >nul 2>nul
if errorlevel 1 (
  echo   [..] Speech-to-text tool
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; $r=Invoke-RestMethod -Headers @{'User-Agent'='Euclidean'} 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'; $a=$r.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1; if(-not $a){ $a=$r.assets | Where-Object { $_.name -match 'bin-x64.*\.zip$' -and $_.name -notmatch 'blas|cuda' } | Select-Object -First 1 }; $z=Join-Path $env:TEMP 'whisper.zip'; Invoke-WebRequest -UseBasicParsing $a.browser_download_url -OutFile $z; Expand-Archive -LiteralPath $z -DestinationPath '%WH%' -Force; Remove-Item $z" >nul 2>nul
)
if not exist "%WH%\ggml-base.en.bin" (
  echo   [..] English speech model ^(about 150 MB^)
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' -OutFile '%WH%\ggml-base.en.bin'" >nul 2>nul
)
dir /s /b "%WH%\whisper-cli.exe" >nul 2>nul
if errorlevel 1 (echo   [!!] Speech-to-text tool didn't install. The app's checklist has a button to retry.) else (if exist "%WH%\ggml-base.en.bin" (echo   [ok] Speech-to-text) else (echo   [!!] Speech model didn't download. The app's checklist has a button to retry.))

exit /b 0

:tool
where %1 >nul 2>nul
if not errorlevel 1 (echo   [ok] %~3& exit /b 0)
echo   [..] Installing %~3
%W% %2 >nul 2>nul
where %1 >nul 2>nul
if errorlevel 1 (echo   [ok] %~3 ^(installed, ready after Euclidean restarts^)) else (echo   [ok] %~3)
exit /b 0
