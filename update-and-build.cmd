@echo off
setlocal

echo ================================================
echo  gc2oc -- Update + Build
echo ================================================
echo.

REM Kill running proxy (by window title + by port)
powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle -like 'gc2oc*' } | Stop-Process -Force" >nul 2>&1
title gc2oc Update+Build
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":11434 " ^| findstr "LISTENING" 2^>nul') do (
    taskkill /pid %%a /f >nul 2>&1
)

REM Step 1: Update from GitHub
echo -- STEP 1/2: Updating from GitHub --
echo.
call "%~dp0update.cmd"
set UPDATE_RESULT=%ERRORLEVEL%

if %UPDATE_RESULT% equ 1 (
    echo.
    echo [ABORT] Update failed, skipping build.
    endlocal
    timeout /t 5 >nul
    exit /b 1
)

REM Step 2: Build
echo.
echo -- STEP 2/2: Building --
echo.
call "%~dp0build.cmd"

endlocal
echo.
echo ================================================
echo  Update + Build complete.
echo ================================================
timeout /t 5 >nul
