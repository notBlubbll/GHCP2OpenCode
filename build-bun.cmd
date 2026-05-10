@echo off
setlocal enabledelayedexpansion

echo ================================================
echo  Build Bun Standalone EXE
echo ================================================
echo.

bun --version >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo [ERROR] Bun is required. Install from: https://bun.sh
    exit /b 1
)

echo [INFO] Bun found

if not exist node_modules (
    echo [INFO] Installing dependencies...
    call bun install
    if !ERRORLEVEL! neq 0 (
        echo [ERROR] Failed to install dependencies
        exit /b 1
    )
)

if not exist .dist mkdir .dist
for /d %%i in (.dist\*) do rmdir /s /q "%%i" 2>nul
for %%i in (.dist\*) do (
    set "_f=%%~nxi"
    if "!_f:~0,1!" neq "." del /q "%%i" 2>nul
)
if not exist .dist mkdir .dist

echo [INFO] Building...
echo.

bun build --compile --target bun-windows-x64 src/server.js --outfile .dist/ghcp2opencode.exe

if !ERRORLEVEL! neq 0 (
    echo [WARN] Baseline failed, trying modern...
    bun build --compile --target bun-windows-x64-modern src/server.js --outfile .dist/ghcp2opencode.exe
)

if exist .dist\ghcp2opencode.exe (
    if exist .env copy /y .env .dist\ >nul
    if exist .version copy /y .version .dist\ >nul
    echo.
    echo ================================================
    echo  Build successful
echo ================================================
    echo.
    echo   Output: .dist\ghcp2opencode.exe
    echo   Size:   ~112 MB
    echo   Type:   Bun standalone
echo   OS:     Win 10 1809+ / Server 2019+
    echo ================================================
) else (
    echo [ERROR] Build failed.
    exit /b 1
)

endlocal
