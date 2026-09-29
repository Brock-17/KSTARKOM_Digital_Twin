@echo off
REM ============================================================
REM K'STARKOM Digital Twin - one-click Windows launcher
REM Double-click this file to set up (first run) and start the
REM backend + dashboard. Then open http://127.0.0.1:8000
REM ============================================================

cd /d "%~dp0"

if not exist venv (
    echo Creating virtual environment for the first time...
    python -m venv venv
)

echo Activating virtual environment...
call venv\Scripts\activate.bat

echo Installing/checking required packages...
pip install -r backend\requirements.txt

echo.
echo ============================================================
echo Starting K'STARKOM backend...
echo Once you see "Backend ready", open this in your browser:
echo     http://127.0.0.1:8000
echo Press CTRL+C in this window to stop the server.
echo ============================================================
echo.

python backend\main.py

pause
