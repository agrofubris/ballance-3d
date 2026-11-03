@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem One-click, CMD-only setup for the asset-free source package.
rem All downloaded tools and generated files stay below this repository.
cd /d "%~dp0"
set "ROOT=%CD%"
set "TOOLS=%ROOT%\.tools"
set "DOWNLOADS=%TOOLS%\downloads"
set "LOCAL=%ROOT%\.local"
set "SOURCE_ROOT=%LOCAL%\tooling\src"
set "BUILD_ROOT=%LOCAL%\tooling\build"
set "INSTALL_ROOT=%LOCAL%\tooling\install"
set "npm_config_cache=%TOOLS%\npm-cache"
set "npm_config_offline=false"
set "NODE_VERSION=22.18.0"
set "CMAKE_VERSION=4.4.3"
set "PYTHON_VERSION=3.12.10"
set "GIT_VERSION=2.55.0.3"
set "GIT_TAG=v2.55.0.windows.3"
set "LLVM_VERSION=23.1.1"
set "EMSDK_REVISION=5eb0bde7585670252e8ba05e9d361627bffd08b5"
set "EMSCRIPTEN_VERSION=6.0.2"
set "IVP_REVISION=7579664996e68040dd0158081b04f612e6a2d515"
set "LIBCMO_REVISION=a5aee0a464e6936e726af4eb3219140c447dbe36"
set "YYC_REVISION=422aa152ff36a9f545d9c7a8d127b996e3f13f73"
set "STB_REVISION=2e2bef463a5b53ddf8bb788e25da6b8506314c08"

rem SHA-256 of every downloaded tool archive. The download helper verifies the
rem hash with certutil and rejects mismatching files. FFmpeg is pinned to a
rem versioned package because gyan.dev also serves a rolling "release" name.
set "NODE_SHA256=c95d8a7e1c99e669cc08c9f1176e068c1f50847c37908fcb8c35b62482366511"
set "PYTHON_SHA256=4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
set "CMAKE_SHA256=4d52ebab7193a698651639ed80d8d04fd903358843572cf44c7fd234cb7c26ab"
set "FFMPEG_VERSION=9.0.1"
set "FFMPEG_SHA256=fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9"
set "GIT_SHA256=f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05"
set "LLVM_SHA256=c54ac8146b420fe72e11e6fdd56498d6818011ad23267196b6ab37b5ac9264c3"

rem Non-interactive path check used by tests and scripted installs:
rem   Setup-Ballance.bat --check-game "<folder>"
if /i "%~1"=="--check-game" goto :check_game
rem Optional exact physics only (Build-IVP.bat):
rem   Setup-Ballance.bat --ivp ["<installed Ballance desktop app folder>"]
if /i "%~1"=="--ivp" goto :ivp_only

echo.
echo  BALLANCE 3D STEREO - LOCAL SETUP WIZARD
echo  =========================================
echo  This wizard uses CMD only. It never copies original game files into the
echo  source package and never installs a system-wide dependency.
echo.
echo  It can download open-source tools and pinned source code into .tools and
echo  .local, then build the private asset converter and IVP WebAssembly runtime.
echo  Your legally obtained Ballance installation is never downloaded; if you
echo  only own an ISO, install from it first. The wizard reads an installed
echo  folder and never mounts an ISO by itself.
echo  After accepting, the only information requested is your Ballance folder.
echo  License URLs and notices are listed in THIRD_PARTY.md.
echo.
choice /C YN /N /M "Accept the external open-source licenses and continue [Y/N]"
if errorlevel 2 goto :cancel
if not exist "%TOOLS%" md "%TOOLS%"
if not exist "%DOWNLOADS%" md "%DOWNLOADS%"
if not exist "%LOCAL%" md "%LOCAL%"

call :require_windows_tools
if errorlevel 1 goto :failed
call :ensure_node
if errorlevel 1 goto :failed
call :ensure_python
if errorlevel 1 goto :failed
call :ensure_ffmpeg
if errorlevel 1 goto :failed

echo.
  echo Installing JavaScript dependencies locally...
  "%NODE_EXE%" "%NPM_CLI_JS%" ci --no-audit --no-fund
  if errorlevel 1 (
    echo npm ci failed. Check the network connection and run this wizard again.
    goto :failed
  )

echo.
call :prepare_assets
if errorlevel 1 goto :failed

echo.
echo Exact IVP physics is optional. Without it the game starts with built-in
echo Rapier physics. Building IVP takes 10-20 minutes and downloads Emscripten.
choice /C YN /N /M "Build exact IVP physics now [Y/N]"
if errorlevel 2 goto :skip_ivp
call :prepare_ivp
if errorlevel 1 goto :failed
:skip_ivp

echo.
if exist ".local\original\level_01.json" (
  echo Setup is complete. Launch-Ballance.bat will now start the game.
  call Launch-Ballance.bat
) else (
  echo Setup finished without the private asset pack.
  echo Read SHARE_INSTRUCTIONS.txt and rerun this wizard after correcting the error.
)
exit /b 0

:require_windows_tools
where curl.exe >nul 2>&1
if errorlevel 1 (
  echo Windows curl.exe is required. Use a current Windows 10/11 installation.
  exit /b 1
)
where tar.exe >nul 2>&1
if errorlevel 1 (
  echo Windows tar.exe is required for portable ZIP extraction.
  exit /b 1
)
exit /b 0

:ensure_node
set "NODE_DIR=%TOOLS%\node-v%NODE_VERSION%-win-x64"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM_CLI_JS=%NODE_DIR%\node_modules\npm\bin\npm-cli.js"
if exist "%NODE_EXE%" if exist "%NPM_CLI_JS%" exit /b 0
set "NODE_ZIP=%DOWNLOADS%\node-v%NODE_VERSION%-win-x64.zip"
call :download "https://nodejs.org/dist/v%NODE_VERSION%/node-v%NODE_VERSION%-win-x64.zip" "%NODE_ZIP%" "%NODE_SHA256%"
if errorlevel 1 exit /b 1
tar.exe -xf "%NODE_ZIP%" -C "%TOOLS%"
if errorlevel 1 exit /b 1
if not exist "%NODE_EXE%" (
  echo Portable Node.js extraction did not produce the expected directory.
  exit /b 1
)
if not exist "%NPM_CLI_JS%" (
  echo Portable Node.js extraction did not include npm.
  exit /b 1
)
exit /b 0

:ensure_python
set "PYTHON_DIR=%TOOLS%\python-%PYTHON_VERSION%-embed-amd64"
set "PYTHON_EXE=%PYTHON_DIR%\python.exe"
if exist "%PYTHON_DIR%\python.exe" (
  exit /b 0
)
set "PYTHON_ZIP=%DOWNLOADS%\python-%PYTHON_VERSION%-embed-amd64.zip"
call :download "https://www.python.org/ftp/python/%PYTHON_VERSION%/python-%PYTHON_VERSION%-embed-amd64.zip" "%PYTHON_ZIP%" "%PYTHON_SHA256%"
if errorlevel 1 exit /b 1
if not exist "%PYTHON_DIR%" md "%PYTHON_DIR%"
tar.exe -xf "%PYTHON_ZIP%" -C "%PYTHON_DIR%"
if errorlevel 1 exit /b 1
if not exist "%PYTHON_DIR%\python.exe" (
  echo Portable Python extraction did not produce python.exe.
  exit /b 1
)
set "PYTHON_EXE=%PYTHON_DIR%\python.exe"
exit /b 0

:ensure_cmake
set "CMAKE_DIR=%TOOLS%\cmake-%CMAKE_VERSION%-windows-x86_64"
set "CMAKE_EXE=%CMAKE_DIR%\bin\cmake.exe"
if exist "%CMAKE_DIR%\bin\cmake.exe" (
  set "PATH=%CMAKE_DIR%\bin;%PATH%"
  exit /b 0
)
set "CMAKE_ZIP=%DOWNLOADS%\cmake-%CMAKE_VERSION%-windows-x86_64.zip"
call :download "https://github.com/Kitware/CMake/releases/download/v%CMAKE_VERSION%/cmake-%CMAKE_VERSION%-windows-x86_64.zip" "%CMAKE_ZIP%" "%CMAKE_SHA256%"
if errorlevel 1 exit /b 1
tar.exe -xf "%CMAKE_ZIP%" -C "%TOOLS%"
if errorlevel 1 exit /b 1
if not exist "%CMAKE_DIR%\bin\cmake.exe" (
  echo Portable CMake extraction did not produce the expected directory.
  exit /b 1
)
set "CMAKE_EXE=%CMAKE_DIR%\bin\cmake.exe"
set "PATH=%CMAKE_DIR%\bin;%PATH%"
exit /b 0

:ensure_ffmpeg
set "FFMPEG_EXE="
set "FFMPEG_ROOT=%TOOLS%\ffmpeg-%FFMPEG_VERSION%"
for /r "%FFMPEG_ROOT%" %%F in (ffmpeg.exe) do if not defined FFMPEG_EXE set "FFMPEG_EXE=%%F"
if defined FFMPEG_EXE exit /b 0
set "FFMPEG_ZIP=%DOWNLOADS%\ffmpeg-%FFMPEG_VERSION%-essentials_build.zip"
call :download "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-%FFMPEG_VERSION%-essentials_build.zip" "%FFMPEG_ZIP%" "%FFMPEG_SHA256%"
if errorlevel 1 exit /b 1
if not exist "%FFMPEG_ROOT%" md "%FFMPEG_ROOT%"
tar.exe -xf "%FFMPEG_ZIP%" -C "%FFMPEG_ROOT%"
if errorlevel 1 exit /b 1
for /r "%FFMPEG_ROOT%" %%F in (ffmpeg.exe) do if not defined FFMPEG_EXE set "FFMPEG_EXE=%%F"
if not defined FFMPEG_EXE (
  echo FFmpeg extraction did not produce ffmpeg.exe.
  exit /b 1
)
exit /b 0

:ensure_git
set "GIT_DIR=%TOOLS%\mingit-%GIT_VERSION%-64-bit"
set "GIT_EXE=%GIT_DIR%\cmd\git.exe"
if exist "%GIT_DIR%\cmd\git.exe" (
  set "PATH=%GIT_DIR%\cmd;%GIT_DIR%\mingw64\bin;%PATH%"
  exit /b 0
)
set "GIT_ZIP=%DOWNLOADS%\MinGit-%GIT_VERSION%-64-bit.zip"
call :download "https://github.com/git-for-windows/git/releases/download/%GIT_TAG%/MinGit-%GIT_VERSION%-64-bit.zip" "%GIT_ZIP%" "%GIT_SHA256%"
if errorlevel 1 exit /b 1
if not exist "%GIT_DIR%" md "%GIT_DIR%"
tar.exe -xf "%GIT_ZIP%" -C "%GIT_DIR%"
if errorlevel 1 exit /b 1
if not exist "%GIT_DIR%\cmd\git.exe" (
  echo Portable Git extraction did not produce cmd\git.exe.
  exit /b 1
)
set "GIT_EXE=%GIT_DIR%\cmd\git.exe"
set "PATH=%GIT_DIR%\cmd;%GIT_DIR%\mingw64\bin;%PATH%"
exit /b 0

:ensure_compiler
set "LLVM_ROOT=%TOOLS%\llvm-%LLVM_VERSION%"
set "CLANGPP_EXE="
for /r "%LLVM_ROOT%" %%C in (clang++.exe) do if not defined CLANGPP_EXE set "CLANGPP_EXE=%%C"
if defined CLANGPP_EXE (
  for %%C in ("%CLANGPP_EXE%") do set "PATH=%%~dpC;%PATH%"
  exit /b 0
)
where link.exe >nul 2>&1
if errorlevel 1 echo NOTE: MSVC link.exe not found. Native BMap build may need Visual Studio Build Tools.
set "LLVM_ZIP=%DOWNLOADS%\clang+llvm-%LLVM_VERSION%-x86_64-pc-windows-msvc.tar.xz"
call :download "https://github.com/llvm/llvm-project/releases/download/llvmorg-%LLVM_VERSION%/clang+llvm-%LLVM_VERSION%-x86_64-pc-windows-msvc.tar.xz" "%LLVM_ZIP%" "%LLVM_SHA256%"
if errorlevel 1 exit /b 1
if not exist "%LLVM_ROOT%" md "%LLVM_ROOT%"
tar.exe -xf "%LLVM_ZIP%" -C "%LLVM_ROOT%"
if errorlevel 1 exit /b 1
set "CLANGPP_EXE="
for /r "%LLVM_ROOT%" %%C in (clang++.exe) do if not defined CLANGPP_EXE set "CLANGPP_EXE=%%C"
if not defined CLANGPP_EXE (
  echo Portable LLVM extraction did not produce clang++.exe.
  exit /b 1
)
for %%C in ("%CLANGPP_EXE%") do set "PATH=%%~dpC;%PATH%"
exit /b 0

:prepare_assets
echo.
echo PRIVATE ASSET PREPARATION
echo The next step reads only files from your own installed Ballance copy and
echo writes the converted pack to .local\original. Nothing is uploaded.
call :ensure_python
if errorlevel 1 exit /b 1
call :ensure_ffmpeg
if errorlevel 1 exit /b 1
  set "GAME_DIR="
  set "GAME_INPUT="
  call :resolve_game_dir
if errorlevel 1 exit /b 1
set "BMAP_DLL="
call :ensure_bmap_prebuilt
if errorlevel 1 (
  echo Vendored converter missing. Falling back to source build.
  call :build_bmap
)
if errorlevel 1 exit /b 1
if not exist "%BMAP_DLL%" (
  echo BMap.dll was not found: %BMAP_DLL%
  exit /b 1
)
for %%F in ("%FFMPEG_EXE%") do set "FFMPEG_BIN=%%~dpF"
set "PATH=%FFMPEG_BIN%;%PATH%"
echo Converting your private Ballance files...
"%PYTHON_EXE%" scripts\prepare-original.py --library "%BMAP_DLL%" --game "%GAME_DIR%" --dump-chunks "%ROOT%\vendor\bmap-win-x64\dump-chunks.exe"
if errorlevel 1 (
  echo Asset conversion failed. See the detailed instructions in docs\original-import.md.
  exit /b 1
)
echo Private asset pack ready in .local\original.
exit /b 0

:resolve_game_dir
if not defined GAME_INPUT set /p "GAME_INPUT=Enter your installed Ballance folder (for example C:\Games\Ballance): "
set "GAME_INPUT=%GAME_INPUT:"=%"
if not defined GAME_INPUT (
  echo No path entered. This wizard reads an installed Ballance folder, not an
  echo ISO. If you only have an ISO, double-click it in Explorer to mount it,
  echo install Ballance once, then enter that installed folder here.
  exit /b 1
)
if exist "%GAME_INPUT%\3D Entities" set "GAME_DIR=%GAME_INPUT%"
if exist "%GAME_INPUT%\3D_Entities" set "GAME_DIR=%GAME_INPUT%"
if defined GAME_DIR exit /b 0
if exist "%GAME_INPUT%" (
  echo "%GAME_INPUT%" contains neither "3D Entities" nor "3D_Entities".
  echo Install Ballance from your ISO first, then enter the installed folder.
  echo Example: C:\Games\Ballance containing 3D Entities.
  exit /b 1
)
echo Path not found: %GAME_INPUT%
exit /b 1

:ensure_bmap_prebuilt
set "BMAP_DLL=%TOOLS%\bmap\BMap.dll"
if exist "%BMAP_DLL%" exit /b 0
if exist "%ROOT%\vendor\bmap-win-x64\BMap.dll" (
  if not exist "%TOOLS%\bmap" md "%TOOLS%\bmap%"
  copy /y "%ROOT%\vendor\bmap-win-x64\BMap.dll" "%TOOLS%\bmap\BMap.dll" >nul
  copy /y "%ROOT%\vendor\bmap-win-x64\zlib.dll" "%TOOLS%\bmap\zlib.dll" >nul
  set "BMAP_DLL=%TOOLS%\bmap\BMap.dll"
  if exist "%BMAP_DLL%" exit /b 0
)
set "BMAP_DLL="
for /r "%LOCAL%\tooling" %%F in (BMap.dll) do if not defined BMAP_DLL set "BMAP_DLL=%%F"
if defined BMAP_DLL exit /b 0
exit /b 1

:build_bmap
echo Gathering and building the private LibCmo21/BMap converter...
call :ensure_git
if errorlevel 1 exit /b 1
call :ensure_cmake
if errorlevel 1 exit /b 1
call :ensure_compiler
if errorlevel 1 exit /b 1
call :clone_pinned "https://github.com/yyc12345/YYCCommonplace.git" "%SOURCE_ROOT%\yyccommonplace" "%YYC_REVISION%"
if errorlevel 1 exit /b 1
call :clone_pinned "https://github.com/yyc12345/libcmo21.git" "%SOURCE_ROOT%\libcmo21" "%LIBCMO_REVISION%"
if errorlevel 1 exit /b 1
call :clone_pinned "https://github.com/nothings/stb.git" "%SOURCE_ROOT%\stb" "%STB_REVISION%"
if errorlevel 1 exit /b 1
set "YYC_PREFIX=%INSTALL_ROOT%\yyccommonplace"
set "LIBCMO_PREFIX=%INSTALL_ROOT%\libcmo21"
"%CMAKE_EXE%" -S "%SOURCE_ROOT%\yyccommonplace" -B "%BUILD_ROOT%\yyccommonplace" -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON "-DCMAKE_INSTALL_PREFIX=%YYC_PREFIX%"
if errorlevel 1 exit /b 1
"%CMAKE_EXE%" --build "%BUILD_ROOT%\yyccommonplace" --target install --config Release
if errorlevel 1 exit /b 1
"%CMAKE_EXE%" -S "%SOURCE_ROOT%\libcmo21" -B "%BUILD_ROOT%\libcmo21" -DCMAKE_BUILD_TYPE=Release -DNEMO_BUILD_UNVIRT=OFF -DNEMO_BUILD_BALLANCE=ON -DNEMO_BUILD_BMAP=ON "-DYYCCommonplace_ROOT=%YYC_PREFIX%" "-DSTB_ROOT=%SOURCE_ROOT%\stb" "-DCMAKE_INSTALL_PREFIX=%LIBCMO_PREFIX%"
if errorlevel 1 exit /b 1
"%CMAKE_EXE%" --build "%BUILD_ROOT%\libcmo21" --target BMap --config Release
if errorlevel 1 exit /b 1
"%CMAKE_EXE%" --install "%BUILD_ROOT%\libcmo21" --config Release
if errorlevel 1 exit /b 1
for /r "%LIBCMO_PREFIX%" %%F in (BMap.dll) do if not defined BMAP_DLL set "BMAP_DLL=%%F"
for /r "%BUILD_ROOT%\libcmo21" %%F in (BMap.dll) do if not defined BMAP_DLL set "BMAP_DLL=%%F"
if not defined BMAP_DLL (
  echo LibCmo21 built but BMap.dll was not found.
  exit /b 1
)
echo Built private converter: %BMAP_DLL%
exit /b 0

:prepare_ivp
echo.
echo Gathering and building the private IVP WebAssembly runtime...
call :ensure_python
if errorlevel 1 exit /b 1
call :ensure_cmake
if errorlevel 1 exit /b 1
call :ensure_git
if errorlevel 1 exit /b 1
set "IVP_SOURCE=%SOURCE_ROOT%\ivp"
if not exist "%IVP_SOURCE%\.git" call :clone_pinned "https://github.com/doyaGu/ivp.git" "%IVP_SOURCE%" "%IVP_REVISION%"
if errorlevel 1 exit /b 1
set "EMSDK_DIR=%SOURCE_ROOT%\emsdk"
if not exist "%EMSDK_DIR%\emsdk.bat" call :clone_pinned "https://github.com/emscripten-core/emsdk.git" "%EMSDK_DIR%" "%EMSDK_REVISION%"
if errorlevel 1 exit /b 1
call "%EMSDK_DIR%\emsdk.bat" install %EMSCRIPTEN_VERSION%
if errorlevel 1 exit /b 1
call "%EMSDK_DIR%\emsdk.bat" activate %EMSCRIPTEN_VERSION%
if errorlevel 1 exit /b 1
set "EM_CACHE=%LOCAL%\ivp-simulation\emscripten-cache"
set "EM_CONFIG=%LOCAL%\tooling\emscripten-config"
set "EM_PORTS=%LOCAL%\tooling\emscripten-ports"
if not exist "%LOCAL%\ivp-simulation" md "%LOCAL%\ivp-simulation"
call "%EMSDK_DIR%\emsdk_env.bat"
if errorlevel 1 exit /b 1
echo Building the IVP WebAssembly module. This can take several minutes...
"%PYTHON_EXE%" scripts\build-ivp-simulation.py "%IVP_SOURCE%" "%LOCAL%\ivp-simulation"
if errorlevel 1 (
  echo IVP build failed. See .local\ivp-simulation\*-compile.log and docs\original-ivp-wasm.md.
  exit /b 1
)
if not exist "%LOCAL%\ivp-simulation\ivp-simulation.mjs" exit /b 1
echo IVP runtime ready in .local\ivp-simulation.
exit /b 0

:ivp_only
set "APP_DIR=%~2"
echo.
echo  BALLANCE 3D STEREO - OPTIONAL IVP PHYSICS
echo  ==========================================
echo  This downloads the pinned IVP source (github.com/doyaGu/ivp), Emscripten,
echo  CMake, Git and Python into .tools and .local, and builds the IVP physics
echo  module the original game used. It takes 10-20 minutes. The module is for
echo  your own use only: do not share the built files.
echo.
choice /C YN /N /M "Continue [Y/N]"
if errorlevel 2 goto :cancel
if not exist "%TOOLS%" md "%TOOLS%"
if not exist "%DOWNLOADS%" md "%DOWNLOADS%"
if not exist "%LOCAL%" md "%LOCAL%"
call :require_windows_tools
if errorlevel 1 goto :failed
call :prepare_ivp
if errorlevel 1 goto :failed
if not defined APP_DIR goto :ivp_done
if not exist "%APP_DIR%\resources\app" (
  echo "%APP_DIR%" is not an unpacked Ballance desktop app: resources\app is missing.
  goto :failed
)
if not exist "%APP_DIR%\resources\app\.local\ivp-simulation" md "%APP_DIR%\resources\app\.local\ivp-simulation"
copy /y "%LOCAL%\ivp-simulation\ivp-simulation.mjs" "%APP_DIR%\resources\app\.local\ivp-simulation\" >nul
if errorlevel 1 goto :failed
copy /y "%LOCAL%\ivp-simulation\ivp-simulation.wasm" "%APP_DIR%\resources\app\.local\ivp-simulation\" >nul
if errorlevel 1 goto :failed
echo Installed into %APP_DIR%. Restart Ballance to use IVP physics.
exit /b 0
:ivp_done
echo The browser build picks it up on its next npm run build. For the desktop
echo app, run this again with its folder, or copy ivp-simulation.mjs and
echo ivp-simulation.wasm into its resources\app\.local\ivp-simulation folder.
exit /b 0

:clone_pinned
set "CLONE_URL=%~1"
set "CLONE_DIR=%~2"
set "CLONE_REVISION=%~3"
if exist "%CLONE_DIR%\.git" (
  "%GIT_EXE%" -C "%CLONE_DIR%" fetch --quiet --depth 1 origin "%CLONE_REVISION%"
  if errorlevel 1 exit /b 1
  "%GIT_EXE%" -C "%CLONE_DIR%" checkout --quiet "%CLONE_REVISION%"
  exit /b %errorlevel%
)
if exist "%CLONE_DIR%" rd /s /q "%CLONE_DIR%"
"%GIT_EXE%" clone --filter=blob:none --no-checkout "%CLONE_URL%" "%CLONE_DIR%"
if errorlevel 1 exit /b 1
"%GIT_EXE%" -C "%CLONE_DIR%" checkout --quiet "%CLONE_REVISION%"
if errorlevel 1 exit /b 1
exit /b 0

:download
set "DOWNLOAD_URL=%~1"
set "DOWNLOAD_FILE=%~2"
set "DOWNLOAD_SHA256=%~3"
if exist "%DOWNLOAD_FILE%" (
  call :verify_sha256 "%DOWNLOAD_FILE%" "%DOWNLOAD_SHA256%"
  if not errorlevel 1 exit /b 0
  echo Cached file failed its SHA-256 check; downloading again.
  del /q "%DOWNLOAD_FILE%" >nul 2>&1
)
echo Downloading %DOWNLOAD_URL%
curl.exe --fail --location --retry 3 --output "%DOWNLOAD_FILE%" "%DOWNLOAD_URL%"
if errorlevel 1 exit /b 1
call :verify_sha256 "%DOWNLOAD_FILE%" "%DOWNLOAD_SHA256%"
if errorlevel 1 (
  echo ERROR: SHA-256 mismatch for "%DOWNLOAD_FILE%"
  echo Expected %DOWNLOAD_SHA256%
  del /q "%DOWNLOAD_FILE%" >nul 2>&1
  exit /b 1
)
exit /b 0

:verify_sha256
set "EXPECTED_SHA256=%~2"
set "ACTUAL_SHA256="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "%~1" SHA256') do if not defined ACTUAL_SHA256 set "ACTUAL_SHA256=%%H"
if not defined ACTUAL_SHA256 exit /b 1
set "ACTUAL_SHA256=%ACTUAL_SHA256: =%"
if /i "%ACTUAL_SHA256%"=="%EXPECTED_SHA256%" exit /b 0
echo SHA-256 check failed for "%~1"
echo   expected %EXPECTED_SHA256%
echo   actual   %ACTUAL_SHA256%
exit /b 1

:cancel
echo Setup cancelled. No external download was started.
exit /b 2

:check_game
if "%~2"=="" (
  echo Usage: Setup-Ballance.bat --check-game "C:\path\to\installed\Ballance"
  exit /b 1
)
set "GAME_INPUT=%~2"
call :resolve_game_dir
if errorlevel 1 (
  echo Game folder check failed.
  exit /b 1
)
echo Game folder accepted: "%GAME_DIR%"
exit /b 0

:failed
echo.
echo Setup stopped. No tracked source files were changed; partial tools/cache
echo remain under .tools and .local so a later run can continue.
pause
exit /b 1
