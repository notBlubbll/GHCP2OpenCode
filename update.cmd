@echo off
setlocal disabledelayedexpansion

echo ================================================
echo  GHCP2OpenCode -- Self-Updater
echo ================================================
echo.

REM Pass the dest root as an env var so PS can read it easily
set "DEST_ROOT=%CD%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$destRoot=$env:DEST_ROOT;$tempDir=Join-Path $env:TEMP 'ghcp-update';$zipFile=Join-Path $tempDir 'main.zip';$extractDir=Join-Path $tempDir 'repo';$preserve=@('.env','.cache','.dist','node_modules','.git','.gitignore','.gitattributes');function skip($r){foreach($p in $preserve){if($r -eq $p -or $r.StartsWith($p+'\')){return $true}};return $false};try{$verUrl='https://raw.githubusercontent.com/notBlubbll/GHCP2OpenCode/main/.version';$remoteVer='';try{$remoteVer=(Invoke-WebRequest -Uri $verUrl -UseBasicParsing).Content.Trim()}catch{};$localVer='';$vf=Join-Path $destRoot '.version';if(Test-Path $vf){$localVer=(Get-Content -LiteralPath $vf -Raw).Trim()};if($remoteVer -and $localVer -and $remoteVer -eq $localVer){Write-Host 'Up to date (version match) - nothing to download.';exit 0};if(Test-Path $tempDir){Remove-Item -LiteralPath $tempDir -Recurse -Force};New-Item -ItemType Directory -Path $tempDir -Force | Out-Null;Write-Host '[1/4] Downloading latest from GitHub...';[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;Invoke-WebRequest -Uri 'https://github.com/notBlubbll/GHCP2OpenCode/archive/refs/heads/main.zip' -OutFile $zipFile -UseBasicParsing;Write-Host '[2/4] Extracting...';Expand-Archive -LiteralPath $zipFile -DestinationPath $extractDir -Force;$inner=Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1;if(-not $inner){throw 'No source folder inside zip'};$srcRoot=$inner.FullName;Write-Host ('       Source: '+$inner.Name);Write-Host '[3/4] Comparing and updating changed files...';$updated=0;$skipped=0;Get-ChildItem -LiteralPath $srcRoot -Recurse -File | ForEach-Object {$rel=$_.FullName.Substring($srcRoot.Length+1) -replace '/','\';if(skip $rel){$global:skipped++;Write-Host ('  SKIP '+$rel+' (preserved)');return};$dest=Join-Path $destRoot $rel;$destDir=Split-Path $dest -Parent;if(-not (Test-Path $destDir)){New-Item -ItemType Directory -Path $destDir -Force | Out-Null};if(-not (Test-Path $dest)){Copy-Item -LiteralPath $_.FullName -Destination $dest -Force;$global:updated++;Write-Host ('  NEW  '+$rel);return};$srcHash=(Get-FileHash -LiteralPath $_.FullName -Algorithm MD5).Hash;$dstHash=(Get-FileHash -LiteralPath $dest -Algorithm MD5).Hash;if($srcHash -ne $dstHash){Copy-Item -LiteralPath $_.FullName -Destination $dest -Force;$global:updated++;Write-Host ('  UPD  '+$rel)}};Write-Host '';Write-Host ('Updated: '+$updated+' file(s), Skipped: '+$skipped+' file(s)');Write-Host '[4/4] Cleaning up...';Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue;Write-Host '';if($updated -gt 0){Write-Host '================================================';Write-Host '  Update applied. Restart proxy to use new code.';Write-Host '================================================';exit 42}else{Write-Host '================================================';Write-Host '  Already up to date.';Write-Host '================================================';exit 0}}catch{Write-Host '';Write-Host ('[ERROR] '+$_);Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue;exit 1}"

set RESULT=%ERRORLEVEL%

echo.
if %RESULT% equ 42 (
    timeout /t 2 >nul
    exit /b 42
)

endlocal
pause
