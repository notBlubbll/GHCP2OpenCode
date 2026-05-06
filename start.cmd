@echo off
REM GHCP2OpenCode Launcher — requires Bun (https://bun.sh)

if exist .env (
    for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
        if not "%%a"=="" if not "%%a"=="#" (
            set "%%a=%%b"
        )
    )
)

if "%SERVER_PORT%"=="" set SERVER_PORT=11434

if "%OPENCODE_API_KEY%"=="" if "%OPENCODE_API_KEYS%"=="" (
    echo [ERROR] OPENCODE_API_KEY or OPENCODE_API_KEYS not set.
    echo Edit .env and add your key: OPENCODE_API_KEYS=["your-key"]
    exit /b 1
)

echo === GHCP2OpenCode v2 ===

REM Kill anything already on this port
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%SERVER_PORT% " ^| findstr "LISTENING"') do (
    echo Killing PID %%a on port %SERVER_PORT%
    taskkill /pid %%a /f >nul 2>&1
)

echo Starting on port %SERVER_PORT%...
echo http://localhost:%SERVER_PORT%
echo.

bun run src/server.js
