@echo off
setlocal EnableExtensions

rem Start the repo-local Ballance preview and open it in the default browser.
pushd "%~dp0"
set "NODE_VERSION=22.18.0"
set "NODE_DIR=%CD%\.tools\node-v%NODE_VERSION%-win-x64"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CLI_JS=%NODE_DIR%\node_modules\npm\bin\npm-cli.js"
set "NPM_CMD=npm"
if exist "%NODE_EXE%" if exist "%NPM_CLI_JS%" (
  set "npm_config_cache=%CD%\.tools\npm-cache"
  set "NPM_CMD=%NODE_EXE% %NPM_CLI_JS%"
)

if not exist "node_modules\vite\package.json" (
  echo JavaScript dependencies are missing. Installing them in this repo...
  if exist "%NODE_EXE%" if exist "%NPM_CLI_JS%" (
    "%NODE_EXE%" "%NPM_CLI_JS%" install --no-audit --no-fund
  ) else (
    call npm install --no-audit --no-fund
  )
  if errorlevel 1 (
    popd
    exit /b 1
  )
)

if not exist ".local\original\level_01.json" (
  echo Missing .local\original asset pack.
  echo Convert the installed Ballance files first; see docs\original-import.md.
  pause
  popd
  exit /b 1
)

set "BALLANCE_URL=http://127.0.0.1:5173/"
if not exist ".local\ivp-simulation\ivp-simulation.mjs" (
  echo NOTE: exact IVP runtime not found. Starting with built-in Rapier physics.
  echo To enable exact IVP later, rerun Setup-Ballance.bat and choose Y.
  set "BALLANCE_URL=http://127.0.0.1:5173/?physics=rapier"
)
echo Starting Ballance at %BALLANCE_URL%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-server.ps1" Start
if errorlevel 1 (
  pause
  popd
  exit /b 1
)

rem Wait briefly for Vite so the browser opens on a live page. Windows 10/11
rem includes curl.exe; no additional shell scripting runtime is required here.
set "BALLANCE_READY=0"
where curl.exe >nul 2>&1
if errorlevel 1 goto :ballance_open
for /l %%I in (1,1,20) do (
  curl.exe --silent --fail --max-time 1 "%BALLANCE_URL%" >nul 2>&1
  if not errorlevel 1 (
    set "BALLANCE_READY=1"
    goto :ballance_ready
  )
  timeout /t 1 /nobreak >nul
)

:ballance_ready
if "%BALLANCE_READY%"=="0" echo The server is still starting; the browser will retry the page.
:ballance_open
start "" "%BALLANCE_URL%"
popd
exit /b 0
