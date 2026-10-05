@echo off
setlocal
title Mini-AI-IDE
cd /d "%~dp0"
if errorlevel 1 goto :failed

where pnpm.cmd >nul 2>&1
if errorlevel 1 (
  echo pnpm was not found. Install Node.js and pnpm, then try again.
  goto :failed
)

call pnpm.cmd start
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo Mini-AI-IDE could not start. See the error above.
pause
exit /b 1
