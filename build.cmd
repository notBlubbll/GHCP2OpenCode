@echo off
setlocal enabledelayedexpansion

echo ================================================
echo  GHCP2OpenCode -- Build
echo ================================================
echo.

REM -- Clean previous build
REM -- Clean .dist but preserve dotfiles (.env, .version, etc.)
if not exist .dist mkdir .dist
for /d %%i in (.dist\*) do rmdir /s /q "%%i" 2>nul
for %%i in (.dist\*) do (
    set "_f=%%~nxi"
    if "!_f:~0,1!" neq "." del /q "%%i" 2>nul
)

REM ====== Try Bun first ======
bun --version >nul 2>&1
if !ERRORLEVEL! equ 0 (
    echo [INFO] Bun found, building standalone exe...
    echo.
    call bun build --compile --target bun-windows-x64 src/server.js --outfile .dist/ghcp2opencode.exe
    if !ERRORLEVEL! neq 0 (
        echo [WARN] Baseline target failed, retrying with modern...
        bun build --compile --target bun-windows-x64-modern src/server.js --outfile .dist/ghcp2opencode.exe
    )
    if exist .dist\ghcp2opencode.exe (
        if exist .env if not exist .dist\.env copy /y .env .dist\ >nul
        if exist .version copy /y .version .dist\ >nul
        echo.
        echo ================================================
        echo  Build successful
echo ================================================
        echo.
        echo   Output: .dist\ghcp2opencode.exe
        echo   Size:   ~112 MB
        echo   Type:   Bun standalone (fully self-contained)
        echo   OS:     Win 10 1809+ / Server 2019+
        echo ================================================
        endlocal
        exit /b 0
    )
)

REM ====== Fallback to Node.js ======
echo [WARN] Bun not available, falling back to Node.js...
echo.

node --version >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo [ERROR] Neither Bun nor Node.js found.
    echo        Install Bun:  https://bun.sh
    echo        Install Node: https://nodejs.org
    endlocal
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODEVER=%%i
echo [INFO] Node !NODEVER! found
echo.

REM -- Copy source
echo [INFO] Copying source files...
xcopy /s /i /q src .dist\src >nul
copy /y package.json .dist\ >nul

REM -- Install production deps
echo [INFO] Installing production dependencies...
pushd .dist
call npm install --omit=dev --no-audit --no-fund --loglevel=error
popd

REM -- Copy node.exe
set NODEPATH=
for /f "tokens=*" %%i in ('where node 2^>nul') do (
    if "!NODEPATH!"=="" set NODEPATH=%%i
)
if exist "!NODEPATH!" (
    echo [INFO] Copying node.exe...
    copy /y "!NODEPATH!" .dist\node.exe >nul
)

REM -- Seed .env on first build only, always update .version
if exist .env if not exist .dist\.env (
    echo [INFO] Copying .env...
    copy /y .env .dist\ >nul
)
if exist .version copy /y .version .dist\ >nul

REM -- Create start.cmd
echo [INFO] Creating start.cmd...
(
echo @echo off
echo title GHCP2OpenCode Proxy ^(Node^)
echo.
echo :restart
echo "%%~dp0node.exe" "%%~dp0src\server.js"
echo if %%ERRORLEVEL%% equ 42 goto restart
echo.
) > .dist\start.cmd

echo.
echo ================================================
echo  Build successful
echo ================================================
    echo.
echo   Output: .dist\  (portable folder)
echo   Type:   Node.js portable distribution
echo   OS:     Any Windows (Server 2016+)
echo   Run:    .dist\start.cmd
echo ================================================

endlocal
