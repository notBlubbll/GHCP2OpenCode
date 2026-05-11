@echo off
setlocal enabledelayedexpansion

for /f "tokens=*" %%i in ('node --version') do set NODEVER=%%i
echo [INFO] Node !NODEVER! found
echo.

if not exist .dist mkdir .dist

echo [INFO] Copying source files...
xcopy /s /i /q /y src .dist\src >nul
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
echo setlocal enabledelayedexpansion
echo.
echo title GHCP2OpenCode Proxy ^(Node^)
echo.
echo :restart
echo cls
echo.
echo REM Load .env
echo if exist "%%~dp0.env" ^(
echo     for /f "usebackq delims=" %%%%x in ^("%%~dp0.env"^) do ^(
echo         set "line=%%%%x"
echo         if not "^!line:~0,1^!"=="#" set "%%%%x"
echo     ^)
echo ^)
echo.
echo if "%%SERVER_PORT%%"=="" set SERVER_PORT=11434
echo.
echo REM Port Cleanup
echo for /f "tokens=5" %%%%a in ^('netstat -ano ^^^| findstr ":%%SERVER_PORT%% " ^^^| findstr "LISTENING" 2^^^>nul'^) do ^(
echo     taskkill /pid %%%%a /f ^>nul 2^>^&1
echo ^)
echo.
echo REM Set libuv thread pool size for DNS/file I/O concurrency
echo if "%%UV_THREADPOOL_SIZE%%"=="" set UV_THREADPOOL_SIZE=8
echo.
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
