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
echo set GC2OC_WRAPPED=1
echo.
echo title gc2oc ^(Node^)
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
echo [INFO] Compiling start.exe (C# wrapper)...

REM -- extract C# from this file + compile in-memory via PowerShell Add-Type
powershell -NoProfile -Command "$txt=Get-Content '%~f0' -Raw; $s=$txt.LastIndexOf('===CS_START===')+14; $e=$txt.LastIndexOf('===CS_END==='); $cs=$txt.Substring($s,$e-$s).Trim(); try{Add-Type -TypeDefinition $cs -OutputAssembly '.dist\start.exe' -OutputType ConsoleApplication -ReferencedAssemblies 'System.Core.dll' -ErrorAction Stop; Write-Host '[INFO] compiled (PowerShell Add-Type)'}catch{Write-Host $_.Exception.Message; exit 1}"
if !ERRORLEVEL! equ 0 goto :skip_startexe

REM -- fallback: extract C# to temp .cs, write .csproj, compile with dotnet publish
if not exist .buildtmp mkdir .buildtmp

powershell -NoProfile -Command "$txt=Get-Content '%~f0' -Raw; $s=$txt.LastIndexOf('===CS_START===')+14; $e=$txt.LastIndexOf('===CS_END==='); $cs=$txt.Substring($s,$e-$s).Trim(); $csproj='<Project Sdk=''Microsoft.NET.Sdk''><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework><ImplicitUsings>disable</ImplicitUsings><Nullable>disable</Nullable><AssemblyName>start</AssemblyName></PropertyGroup></Project>'; [IO.File]::WriteAllText('.buildtmp\start.csproj',$csproj); [IO.File]::WriteAllText('.buildtmp\start.cs',$cs)"

dotnet --version >nul 2>&1
if !ERRORLEVEL! equ 0 (
    dotnet publish .buildtmp\start.csproj -c Release -r win-x64 --self-contained false -p:DebugType=none -o .dist
    if !ERRORLEVEL! equ 0 (
        del /q .dist\start.pdb 2>nul
    )
    for %%F in (".dist\start.exe") do if %%~zF gtr 102400 (
        echo [INFO]   ^> .dist\start.exe compiled successfully ^(dotnet publish^)
        goto :cleanup_startexe
    )
    echo [WARN]   ^> dotnet publish produced no valid exe, falling back...
    del /q .dist\start.exe 2>nul
)

REM -- last resort: .NET Framework csc.exe
for %%v in ("%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319" "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319") do (
    if exist "%%~v\csc.exe" (
        "%%~v\csc.exe" /nologo /target:exe /platform:x64 /out:.dist\start.exe .buildtmp\start.cs >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            echo [INFO]   ^> .dist\start.exe compiled successfully ^(csc.exe^)
        ) else (
            echo [WARN]   ^> csc.exe failed, start.exe not created
        )
        goto :cleanup_startexe
    )
)
echo [WARN]   ^> no C# compiler available, start.exe not created

:cleanup_startexe
rmdir /s /q .buildtmp 2>nul
:skip_startexe

echo.
echo ================================================
echo  Build successful
echo ================================================
echo.
echo   Output: .dist\  (portable folder)
echo   Type:   Node.js portable distribution
echo   OS:     Any Windows (Server 2016+)
echo   Run:    .dist\start.exe   OR   .dist\start.cmd
echo ================================================

endlocal
exit /b 0

REM ── Everything below is embedded C# source (not parsed by batch) ──

===CS_START===
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

class StartWrapper
{
    static int Main()
    {
        Environment.SetEnvironmentVariable("GC2OC_WRAPPED", "1");
        SafeSetTitle("gc2oc");

        string baseDir = AppDomain.CurrentDomain.BaseDirectory;

        while (true)
        {
            SafeClear();

            string envPath = Path.Combine(baseDir, ".env");
            if (File.Exists(envPath))
            {
                foreach (string rawLine in File.ReadAllLines(envPath))
                {
                    string line = rawLine.Trim();
                    if (string.IsNullOrEmpty(line) || line.StartsWith("#"))
                        continue;

                    int eqIdx = line.IndexOf('=');
                    if (eqIdx > 0)
                    {
                        string key = line.Substring(0, eqIdx).Trim();
                        string value = line.Substring(eqIdx + 1).Trim();
                        Environment.SetEnvironmentVariable(key, value);
                    }
                }
            }

            string portStr = Environment.GetEnvironmentVariable("SERVER_PORT") ?? "11434";
            int serverPort;
            if (!int.TryParse(portStr, out serverPort) || serverPort <= 0)
                serverPort = 11434;
            Environment.SetEnvironmentVariable("SERVER_PORT", serverPort.ToString());

            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("UV_THREADPOOL_SIZE")))
                Environment.SetEnvironmentVariable("UV_THREADPOOL_SIZE", "8");

            KillPortProcess(serverPort);

            string bunExe = FindExe("bun");
            if (bunExe != null)
            {
                Log("[INFO] Runtime: Bun");

                string nodeModules = Path.Combine(baseDir, "node_modules");
                if (!Directory.Exists(nodeModules))
                {
                    Log("[INFO] Installing dependencies...");
                    RunProcess(bunExe, "install", baseDir);
                }

                Log("");
                int exitCode = RunProcess(bunExe, "--smol run src/server.js", baseDir);

                if (exitCode == 43)
                {
                    Log("[UPDATE] Running updater...");
                    RunCmdScript("update.cmd", baseDir);
                }
                if (exitCode == 43 || exitCode == 42)
                    continue;
                return exitCode;
            }

            string nodeExe = FindExe("node");
            if (nodeExe == null)
            {
                string bundled = Path.Combine(baseDir, "node.exe");
                if (File.Exists(bundled))
                    nodeExe = bundled;
            }

            if (nodeExe != null)
            {
                Log("[INFO] Runtime: Node.js");

                string lockFile = Path.Combine(baseDir, "node_modules", ".package-lock.json");
                if (!File.Exists(lockFile))
                {
                    Log("[INFO] Installing dependencies...");
                    string npmExe = FindExe("npm");
                    if (npmExe != null)
                    {
                        RunProcess(npmExe, "install hono undici --no-bin-links", baseDir);
                    }
                }

                Log("");
                int exitCode = RunProcess(nodeExe, "--expose-gc --max-old-space-size=4096 src/server.js", baseDir);

                if (exitCode == 43)
                {
                    Log("[UPDATE] Running updater...");
                    RunCmdScript("update.cmd", baseDir);
                }
                if (exitCode == 43 || exitCode == 42)
                    continue;
                return exitCode;
            }

            LogErr("[ERROR] Neither Bun nor Node.js found in PATH.");
            LogErr("       Install Bun: https://bun.sh");
            LogErr("       Install Node: https://nodejs.org");
            Log("Press any key to exit...");
            try { Console.ReadKey(true); } catch { }
            return 1;
        }
    }

    static void SafeClear() { try { Console.Clear(); } catch { } }
    static void SafeSetTitle(string t) { try { Console.Title = t; } catch { } }
    static void Log(string msg) { try { Console.WriteLine(msg); } catch { } }
    static void LogErr(string msg) { try { Console.Error.WriteLine(msg); } catch { } }

    static int RunProcess(string exe, string args, string workDir)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            Arguments = args,
            WorkingDirectory = workDir,
            UseShellExecute = false,
        };
        var proc = Process.Start(psi);
        proc.WaitForExit();
        return proc.ExitCode;
    }

    static void RunCmdScript(string script, string workDir)
    {
        RunProcess("cmd.exe", "/c \"\"" + script + "\"\"", workDir);
    }

    static string FindExe(string name)
    {
        string pathExt = Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT";
        string[] paths = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';');
        string[] exts = pathExt.Split(';');

        foreach (string dir in paths)
        {
            string d = dir.Trim();
            if (string.IsNullOrEmpty(d)) continue;

            foreach (string ext in exts)
            {
                string e = ext.Trim();
                if (string.IsNullOrEmpty(e)) continue;

                string full = Path.Combine(d, name + e);
                if (File.Exists(full))
                    return full;
            }
        }
        return null;
    }

    static void KillPortProcess(int port)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c netstat -ano | findstr \":" + port + " \" | findstr \"LISTENING\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };

            var proc = Process.Start(psi);
            string output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit();

            if (string.IsNullOrWhiteSpace(output))
                return;

            var seenPids = new HashSet<int>();
            foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string[] parts = line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 5)
                {
                    int pid;
                    if (int.TryParse(parts[parts.Length - 1], out pid) && pid > 0)
                    {
                        if (seenPids.Add(pid))
                        {
                            try
                            {
                                var killPsi = new ProcessStartInfo
                                {
                                    FileName = "taskkill.exe",
                                    Arguments = "/pid " + pid + " /f",
                                    UseShellExecute = false,
                                    RedirectStandardOutput = true,
                                    RedirectStandardError = true,
                                    CreateNoWindow = true,
                                };
                                var killProc = Process.Start(killPsi);
                                killProc.WaitForExit();
                            }
                            catch { }
                        }
                    }
                }
            }
        }
        catch { }
    }
}
===CS_END===
