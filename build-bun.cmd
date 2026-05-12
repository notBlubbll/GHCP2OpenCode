@echo off
setlocal enabledelayedexpansion

echo [INFO] Bun found, building standalone exe...
echo.

if not exist node_modules (
    echo [INFO] Installing dependencies...
    call bun install
    if !ERRORLEVEL! neq 0 (
        echo [ERROR] Failed to install dependencies
        endlocal
        exit /b 1
    )
)

if not exist .dist mkdir .dist

bun build --compile --target bun-windows-x64 src/server.js --outfile .dist/gc2oc.exe
if !ERRORLEVEL! neq 0 (
    echo [WARN] Baseline target failed, retrying with modern...
    bun build --compile --target bun-windows-x64-modern src/server.js --outfile .dist/gc2oc.exe
)

if not exist .dist\gc2oc.exe (
    echo [ERROR] Build failed.
    endlocal
    exit /b 1
)

if exist .env if not exist .dist\.env copy /y .env .dist\ >nul
if exist .version copy /y .version .dist\ >nul

echo.
echo ================================================
echo  Build successful
echo ================================================
echo.
echo   Output: .dist\gc2oc.exe
echo   Size:   ~112 MB
echo   Type:   Bun standalone (fully self-contained)
echo   OS:     Win 10 1809+ / Server 2019+
echo ================================================

endlocal
exit /b 0
