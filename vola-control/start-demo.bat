@echo off
title VOLA Control (demo)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   1. Open https://nodejs.org
  echo   2. Install the LTS version ^(use the default choices^)
  echo   3. Double-click start-demo.bat again
  echo.
  pause
  exit /b 1
)

echo.
echo   Demo mode: the bots are pretend. The password is: demo
node server.js --demo --open %*
echo.
echo   VOLA Control has stopped.
pause
