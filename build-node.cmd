@echo off
setlocal enabledelayedexpansion

for /f "tokens=*" %%i in ('node --version') do set NODEVER=%%i
echo [INFO] Node !NODEVER! found
echo.

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
echo "%%~dp0node.exe" --expose-gc --max-old-space-size=4096 "%%~dp0src\server.js"
echo if %%ERRORLEVEL%% equ 43 ^(
echo     echo [UPDATE] Running updater...
echo     call "%%~dp0update.cmd"
echo     goto :restart
echo ^)
echo if %%ERRORLEVEL%% equ 42 goto :restart
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
exit /b 0
