// Build the BallanceLeiaPresenter helper with the installed MSVC toolchain.
//
// Usage: node tools/leia-presenter/build.mjs  (npm run leia:build)
//
// Produces BallanceLeiaPresenter.exe next to this script.
//
// LeiaSR weave support is compiled in when an SR-lib checkout is available:
// set BALLANCE_SR_LIB_ROOT or use the repository default
// .local/reference/sr-lib. The SR SDK import libraries are linked with
// /DELAYLOAD so the exe still starts on a machine without the SR Platform
// installed (the helper then presents plain side-by-side). SR.cpp is compiled
// from the SR-lib checkout; the proprietary SDK tree is never copied into this
// repository.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '..', '..');
const mainSource = path.join(here, 'main.cpp');
const output = path.join(here, 'BallanceLeiaPresenter.exe');
const objectDir = path.join(here, '.obj');

const DEFAULT_SR_LIB_ROOT = path.join(workspaceRoot, '.local', 'reference', 'sr-lib');
const SR_DELAYLOAD_DLLS = [
  'simulatedreality.dll',
  'SimulatedRealityCore.dll',
  'SimulatedRealityCameras.dll',
  'SimulatedRealityHandTrackers.dll',
  'SimulatedRealityFaceTrackers.dll',
  'SimulatedRealityUserModelers.dll',
  'SimulatedRealityDisplays.dll',
  'SimulatedRealityDirectX.dll',
  'SimulatedRealityOpenGL.dll',
  'DimencoWeaving.dll',
  'opencv_world343.dll'
];

function fail(message) {
  console.error(`build-leia-presenter: ${message}`);
  process.exit(1);
}

function resolveVcvars() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  );
  if (!fs.existsSync(vswhere)) return null;
  const installation = execFileSync(vswhere, [
    '-latest',
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath'
  ]).toString().trim();
  if (!installation) return null;
  const vcvars = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return fs.existsSync(vcvars) ? vcvars : null;
}

function resolveSrLibRoot() {
  const candidates = [process.env.BALLANCE_SR_LIB_ROOT, DEFAULT_SR_LIB_ROOT].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'SR.cpp'))
      && fs.existsSync(path.join(candidate, 'SR.hpp'))) {
      return candidate;
    }
  }
  return null;
}

function resolveSdkRoot(srLibRoot) {
  const entries = fs.readdirSync(srLibRoot)
    .filter((name) => /^SR-SDK-[0-9.]+$/.test(name))
    .sort();
  if (entries.length === 0) return null;
  const sdkRoot = path.join(srLibRoot, entries[entries.length - 1], 'x64');
  return fs.existsSync(path.join(sdkRoot, 'lib', 'SimulatedRealityCore.lib'))
    ? sdkRoot
    : null;
}

const vcvars = resolveVcvars();
if (!vcvars) fail('vcvars64.bat not found; install the MSVC x64 build tools.');

const srLibRoot = resolveSrLibRoot();
const sdkRoot = srLibRoot ? resolveSdkRoot(srLibRoot) : null;
const srEnabled = Boolean(srLibRoot && sdkRoot);
if (srEnabled) {
  console.log(`SR-lib: ${srLibRoot}`);
  console.log(`SR SDK: ${sdkRoot}`);
} else {
  console.warn('warning: SR-lib/SDK not found; building the plain-SbS fallback only.');
  console.warn(`  set BALLANCE_SR_LIB_ROOT (default checked: ${DEFAULT_SR_LIB_ROOT})`);
}

const defines = ['/DBALLANCE_LEIA_SR', '/DUNICODE', '/D_UNICODE'];
const includes = srEnabled ? [
  `/I"${srLibRoot}"`,
  `/I"${path.join(sdkRoot, 'include')}"`,
  `/I"${path.join(sdkRoot, 'third_party', 'asio', 'include')}"`,
  `/I"${path.join(sdkRoot, 'third_party', 'GLog', 'include')}"`,
  `/I"${path.join(sdkRoot, 'third_party', 'OpenCV', 'include')}"`,
  `/I"${path.join(sdkRoot, 'third_party', 'rapidxml')}"`,
  fs.existsSync(path.join(sdkRoot, 'third_party', 'Leap', 'include'))
    ? `/I"${path.join(sdkRoot, 'third_party', 'Leap', 'include')}"`
    : null
].filter(Boolean) : [];

function existingLib(candidate) {
  return fs.existsSync(candidate) ? `"${candidate}"` : null;
}

const linkInputs = srEnabled ? [
  ...[
    'simulatedreality', 'SimulatedRealityCore', 'SimulatedRealityCameras',
    'SimulatedRealityHandTrackers', 'SimulatedRealityFaceTrackers',
    'SimulatedRealityUserModelers', 'SimulatedRealityDisplays',
    'SimulatedRealityDirectX', 'SimulatedRealityOpenGL', 'DimencoWeaving'
  ].map((name) => existingLib(path.join(sdkRoot, 'lib', `${name}.lib`))),
  existingLib(path.join(sdkRoot, 'third_party', 'OpenCV', 'lib', 'x64', 'opencv_world343.lib')),
  existingLib(path.join(sdkRoot, 'third_party', 'GLog', 'lib', 'x64', 'glog.lib')),
  existingLib(path.join(sdkRoot, 'third_party', 'Leap', 'lib', 'LeapC.lib')),
  'opengl32.lib',
  'delayimp.lib',
  ...SR_DELAYLOAD_DLLS.map((dll) => `/DELAYLOAD:${dll}`),
  '/ignore:4199'
].filter(Boolean) : [];

fs.rmSync(objectDir, { recursive: true, force: true });
fs.mkdirSync(objectDir, { recursive: true });
const compileCommon = [
  'cl /nologo /std:c++17 /EHsc /O2 /W3 /DNDEBUG',
  ...defines,
  ...includes
].join(' ');
const script = [
  '@echo off',
  `call "${vcvars}" >nul 2>&1`,
  `${compileCommon} /c "${mainSource}" /Fo"${path.join(objectDir, 'main.obj')}"`,
  'if errorlevel 1 exit /b %errorlevel%',
  srEnabled
    ? `${compileCommon} /c "${path.join(srLibRoot, 'SR.cpp')}" /Fo"${path.join(objectDir, 'SR.obj')}"`
    : 'rem SR-lib not available; fallback build',
  srEnabled ? 'if errorlevel 1 exit /b %errorlevel%' : null,
  [
    'link /NOLOGO /SUBSYSTEM:WINDOWS',
    `/OUT:"${output}"`,
    `"${path.join(objectDir, 'main.obj')}"`,
    srEnabled ? `"${path.join(objectDir, 'SR.obj')}"` : null,
    'd3d12.lib dxgi.lib d3dcompiler.lib user32.lib shcore.lib',
    ...linkInputs
  ].filter(Boolean).join(' '),
  'if errorlevel 1 exit /b %errorlevel%'
].filter(Boolean).join('\r\n');
const scriptPath = path.join(objectDir, 'build.cmd');
fs.writeFileSync(scriptPath, script);
execFileSync('cmd.exe', ['/d', '/c', scriptPath], { stdio: 'inherit' });

if (!fs.existsSync(output)) fail('compiler reported success but the exe is missing.');
console.log(`helper built: ${output} (${fs.statSync(output).size} bytes, leiaSR=${srEnabled})`);

// The helper compiles its shaders at startup and links d3dcompiler.lib.
// Windows 8.1+ ships d3dcompiler_47.dll in System32, so no local copy is
// staged by default; stage one only when the system copy is missing.
const systemDll = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'd3dcompiler_47.dll'
);
const localDll = path.join(here, 'd3dcompiler_47.dll');
if (fs.existsSync(systemDll)) {
  if (fs.existsSync(localDll)) fs.rmSync(localDll, { force: true });
  console.log('d3dcompiler_47.dll resolved from System32; no local copy staged');
} else {
  const electronDll = path.join(
    workspaceRoot, 'node_modules', 'electron', 'dist', 'd3dcompiler_47.dll'
  );
  if (fs.existsSync(electronDll)) {
    fs.copyFileSync(electronDll, localDll);
    console.log(`d3dcompiler_47.dll staged from ${electronDll}`);
  } else {
    console.warn('warning: d3dcompiler_47.dll not found; the helper may fail to start on this machine');
  }
}
