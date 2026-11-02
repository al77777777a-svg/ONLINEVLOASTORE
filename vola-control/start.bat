@echo off
title VOLA Control
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   1. Open https://nodejs.org
  echo   2. Install the LTS version ^(use the default choices^)
  echo   3. Double-click start.bat again
  echo.
  pause
  exit /b 1
)

node server.js --open %*
echo.
echo   VOLA Control has stopped.
pause
