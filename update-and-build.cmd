@echo off
setlocal

title GHCP2OpenCode Update+Build

echo ================================================
echo  GHCP2OpenCode -- Update + Build
echo ================================================
echo.

REM Kill running proxy window by title so .dist\ghcp2opencode.exe isn't locked
taskkill /fi "WINDOWTITLE eq GHCP2OpenCode Proxy" /f >nul 2>&1

REM Step 1: Update from GitHub
echo -- STEP 1/2: Updating from GitHub --
echo.
call "%~dp0update.cmd"
set UPDATE_RESULT=%ERRORLEVEL%

if %UPDATE_RESULT% equ 1 (
    echo.
    echo [ABORT] Update failed, skipping build.
    endlocal
    pause
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
pause
