@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"

set "URL=http://127.0.0.1:5173/"
set "NODE_VERSION=22.18.0"
set "NODE_DIR=%CD%\.tools\node-v%NODE_VERSION%-win-x64"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CLI_JS=%NODE_DIR%\node_modules\npm\bin\npm-cli.js"

if not exist "node_modules\vite\package.json" (
  echo Installing JavaScript dependencies...
  if exist "%NODE_EXE%" if exist "%NPM_CLI_JS%" (
    "%NODE_EXE%" "%NPM_CLI_JS%" install --no-audit --no-fund
  ) else (
    call npm install --no-audit --no-fund
  )
  if errorlevel 1 goto :failed
)

if not exist ".local\original\level_01.json" (
  echo Missing .local\original asset pack.
  echo Run Setup-Ballance.bat first, or see docs\original-import.md.
  pause
  goto :failed
)

set "READY=0"
where curl.exe >nul 2>&1
if not errorlevel 1 (
  curl.exe --silent --fail --max-time 1 "%URL%" >nul 2>&1
  if not errorlevel 1 set "READY=1"
)

if "%READY%"=="0" (
  echo Starting the contained Ballance test server...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-server.ps1" Start
  if errorlevel 1 goto :failed
) else (
  echo Using the already-running Ballance server.
)

if not "%READY%"=="1" (
  where curl.exe >nul 2>&1
  if not errorlevel 1 (
    for /l %%I in (1,1,30) do (
      curl.exe --silent --fail --max-time 1 "%URL%" >nul 2>&1
      if not errorlevel 1 (
        set "READY=1"
        goto :open
      )
      timeout /t 1 /nobreak >nul
    )
  )
)

:open
start "" "%URL%"
echo.
echo Ballance is running at %URL%
echo.
echo Test stereo: Options -^> 3D Stereo, then choose Off, SBS, Crossview,
echo Interlaced or Interlaced Reversed. Use "UI Depth" to move the HUD/menu
echo from screen depth (0%%) to maximum pop-out (100%%). Enable "Use these
echo settings by default" if you want the same mode on the next launch.
echo.
echo Stop it with Stop-Ballance.bat when you are done.
popd
exit /b 0

:failed
popd
exit /b 1
