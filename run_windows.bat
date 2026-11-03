@echo off
setlocal
cd /d "%~dp0"
title JD ANALYSIS - XAUUSD Chart Intelligence

where py >nul 2>nul
if %errorlevel%==0 (
  set "PY=py -3"
) else (
  set "PY=python"
)

if not exist ".venv\Scripts\python.exe" (
  echo [JD ANALYSIS] Creating virtual environment...
  %PY% -m venv .venv
  if errorlevel 1 goto :error
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo.
  echo [SETUP REQUIRED] A .env file was created from .env.example.
  echo Open .env in Notepad and add your Gemini and DeepSeek API keys,
  echo then run this file again.
  start notepad.exe "%~dp0.env"
  pause
  exit /b 0
)

if not exist ".venv\jd_dependencies_installed" (
  echo [JD ANALYSIS] Installing dependencies. This is needed only on first run or after requirements change.
  .venv\Scripts\python.exe -m pip install --upgrade pip
  if errorlevel 1 goto :error
  .venv\Scripts\python.exe -m pip install -r requirements.txt
  if errorlevel 1 goto :error
  echo installed>.venv\jd_dependencies_installed
)

echo.
echo [JD ANALYSIS] Starting app on port 8787 for this computer and trusted local network.
echo On this computer: http://127.0.0.1:8787
echo On your phone: http://^<this-computer-IPv4-address^>:8787
echo Keep this window open while using the dashboard. Press Ctrl+C to stop.
.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8787
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo [ERROR] Startup failed. Check that Python 3.11+ is installed and available in PATH.
echo If dependency installation failed, check internet access and try again.
pause
exit /b 1
