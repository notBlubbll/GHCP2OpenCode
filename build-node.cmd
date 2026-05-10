@echo off
setlocal enabledelayedexpansion

echo ================================================
echo  Build Node.js Portable Distribution
echo ================================================
echo.

node --version >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo [ERROR] Node.js is required. Install from: https://nodejs.org
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODEVER=%%i
echo [INFO] Node !NODEVER! found
echo.

if not exist .dist mkdir .dist
for /d %%i in (.dist\*) do rmdir /s /q "%%i" 2>nul
for %%i in (.dist\*) do (
    set "_f=%%~nxi"
    if "!_f:~0,1!" neq "." del /q "%%i" 2>nul
)
if not exist .dist mkdir .dist

echo [INFO] Copying source files...
xcopy /s /i /q src .dist\src >nul
copy /y package.json .dist\ >nul

echo [INFO] Installing production dependencies...
pushd .dist
call npm install --omit=dev --no-audit --no-fund --loglevel=error
popd

set NODEPATH=
for /f "tokens=*" %%i in ('where node 2^>nul') do (
    if "!NODEPATH!"=="" set NODEPATH=%%i
)
if exist "!NODEPATH!" (
    echo [INFO] Copying node.exe...
    copy /y "!NODEPATH!" .dist\node.exe >nul
)

if exist .env if not exist .dist\.env (
    echo [INFO] Copying .env...
    copy /y .env .dist\ >nul
)
if exist .version copy /y .version .dist\ >nul

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
echo   Run:    .dist\start.cmd
echo   OS:     Any Windows (Server 2016+)
echo ================================================

endlocal
