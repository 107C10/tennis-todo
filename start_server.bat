@echo off
REM Foreground server: logs print to this window. Press Ctrl+C to stop.
REM For background autostart on logon, run install_autostart.ps1 instead.
REM ASCII-only on purpose. CJK in REM lines breaks cmd parsing under GBK code page.

chcp 65001 >nul
cd /d "%~dp0"

REM Pick venv python if .venv exists, else fall back to system python
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=%~dp0.venv\Scripts\python.exe"

cd scripts
"%PY%" server.py

echo.
echo Server has exited. See data\server.log for details.
echo Press any key to close this window.
pause >nul
