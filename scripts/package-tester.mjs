// Build the E5 tester package: an unpacked Electron app plus a zip.
//
// This packages the maintainer's local IVP module and SR presenter as-is (the
// maintainer's decision, 2026-10-30); see docs/tester-build.md for the licence
// caveats and the list of excluded files.
//
// Usage: node scripts/package-tester.mjs [--no-ivp] [--no-leia] [--release]
// Requires `npm run build` (or build:rapier) and `npm run leia:build` first.
// --release builds the public desktop asset (docs/release.md): it needs
// --no-ivp, and names the app and zip Ballance-3D-Stereo.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const args = new Set(process.argv.slice(2))
const includeIvp = !args.has('--no-ivp')
const includeLeia = !args.has('--no-leia')
const release = args.has('--release')
if (release && includeIvp) throw new Error('--release needs --no-ivp: the IVP module may not be redistributed')
const appName = release ? 'Ballance-3D-Stereo' : 'Ballance-Tester'

const releaseRoot = path.join(root, '.local', 'release')
const stage = path.join(releaseRoot, appName)
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
const presenter = path.join(root, 'tools', 'leia-presenter', 'BallanceLeiaPresenter.exe')
const ivpDir = path.join(root, '.local', 'ivp-simulation')
const pythonDir = path.join(root, '.tools', 'python-3.12.10-embed-amd64')
const bmapDir = path.join(root, 'vendor', 'bmap-win-x64')
const dumpChunks = path.join(root, 'vendor', 'bmap-win-x64', 'dump-chunks.exe')
const srRoot = path.join(root, '.local', 'reference', 'sr-lib', 'SR-SDK-1.34.10')

function requirePath(candidate, label) {
  if (!existsSync(candidate)) throw new Error(`${label} is missing: ${candidate}`)
  return candidate
}

function copy(source, target) {
  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true, dereference: false })
}

function copyFile(source, target) {
  copy(requirePath(source, path.basename(source)), target)
}

function write(target, text) {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text)
}

requirePath(path.join(root, 'dist', 'client', 'index.html'), 'the browser build (run npm run build)')
requirePath(path.join(electronDist, 'electron.exe'), 'the Electron runtime (npm install electron)')
if (includeLeia) requirePath(presenter, 'the Leia presenter (run npm run leia:build)')
if (includeIvp) requirePath(path.join(ivpDir, 'ivp-simulation.mjs'), 'the IVP module (.local/ivp-simulation)')

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// Electron runtime, with the app's own resources/app loaded by default.
copy(electronDist, stage)
rmSync(path.join(stage, 'resources', 'default_app.asar'), { force: true })
cpSync(path.join(stage, 'electron.exe'), path.join(stage, 'Ballance.exe'))
rmSync(path.join(stage, 'electron.exe'), { force: true })

const app = path.join(stage, 'resources', 'app')
copy(path.join(root, 'electron'), path.join(app, 'electron'))
copy(path.join(root, 'dist', 'client'), path.join(app, 'dist', 'client'))
copyFile(path.join(root, 'package.json'), path.join(app, 'package.json'))
copyFile(path.join(root, 'docs', 'tester-build.md'), path.join(app, 'docs', 'tester-build.md'))
if (release) {
  copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE.txt'))
  copyFile(path.join(root, 'THIRD_PARTY.md'), path.join(stage, 'THIRD_PARTY.md'))
}
if (includeIvp) {
  const target = path.join(app, '.local', 'ivp-simulation')
  mkdirSync(target, { recursive: true })
  for (const file of ['ivp-simulation.mjs', 'ivp-simulation.wasm']) {
    copyFile(path.join(ivpDir, file), path.join(target, file))
  }
  const build = JSON.parse(readFileSync(path.join(ivpDir, 'build.json'), 'utf8'))
  delete build.source
  write(path.join(target, 'build.json'), `${JSON.stringify(build, null, 2)}\n`)
  // The app serves /ivp/<hash>/... from the folder above; the browser build's
  // copy is redundant in an Electron package.
  rmSync(path.join(app, 'dist', 'client', 'ivp'), { recursive: true, force: true })
}

if (includeLeia) copyFile(presenter, path.join(stage, 'resources', 'leia', 'BallanceLeiaPresenter.exe'))

// One-click importer tools.
const importer = path.join(stage, 'resources', 'importer')
copy(requirePath(pythonDir, 'the Python embeddable'), path.join(importer, 'python'))
copy(requirePath(bmapDir, 'BMap'), path.join(importer, 'bmap'))
copyFile(requirePath(dumpChunks, 'dump-chunks'), path.join(importer, 'dump-chunks.exe'))
copy(path.join(root, 'scripts'), path.join(importer, 'scripts'))
for (const entry of readdirSync(path.join(importer, 'scripts'))) {
  // The importer runs the Python scripts only; keep the shipped tree small.
  if (/\.(?:ts|mjs|cpp|h)$/.test(entry)) rmSync(path.join(importer, 'scripts', entry), { force: true })
  if (entry === '__pycache__') rmSync(path.join(importer, 'scripts', entry), { recursive: true, force: true })
}

// Notices.
const licenses = path.join(stage, 'LICENSES')
copyFile(path.join(electronDist, 'LICENSE'), path.join(licenses, 'Electron-LICENSE.txt'))
copyFile(path.join(electronDist, 'LICENSES.chromium.html'), path.join(licenses, 'Chromium-LICENSES.html'))
copyFile(path.join(pythonDir, 'LICENSE.txt'), path.join(licenses, 'Python-LICENSE.txt'))
copyFile(path.join(bmapDir, 'README.txt'), path.join(licenses, 'BMap-README.txt'))
if (includeLeia && existsSync(path.join(srRoot, 'License.txt'))) {
  // The SDK's permission notice; the SR runtime DLLs come with the player's SR Platform.
  copyFile(path.join(srRoot, 'License.txt'), path.join(licenses, 'LeiaSR-SDK-License.txt'))
}
if (includeIvp) {
  const build = JSON.parse(readFileSync(path.join(ivpDir, 'build.json'), 'utf8'))
  write(path.join(licenses, 'IVP-NOTICE.txt'), [
    'IVP physics module',
    '',
    'Source: https://github.com/doyaGu/ivp (fork of nillerusr/source-physics)',
    `Revision: ${build.revision}`,
    'The source tree has no LICENSE file; its ivp_docs/ivp_manual.rtf is an',
    'Ipion evaluation-copy manual (Copyright 2000, Ipion Software GmbH). This',
    'module is included in this tester build as-is by the maintainer decision of',
    '2026-10-30; do not redistribute it further without permission.',
    '',
  ].join('\n'))
}

const electronVersion = JSON.parse(readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
write(path.join(stage, 'VERSION.txt'), [
  `${release ? 'Ballance 3D Stereo' : 'Ballance tester build'} ${pkg.version}`,
  `Electron ${electronVersion}`,
  `Built ${new Date().toISOString()}`,
  `IVP module: ${includeIvp ? 'included' : 'omitted (Rapier fallback)'}`,
  `Leia presenter: ${includeLeia ? 'included' : 'omitted'}`,
  '',
].join('\n'))
if (release) write(path.join(stage, 'README.txt'), [
  `Ballance 3D Stereo ${pkg.version}`,
  '',
  'No Ballance game files are included. Install Ballance from your own copy first.',
  '',
  '1. Run Ballance.exe.',
  '2. On first start choose your installed Ballance folder (for example',
  '   C:\\Games\\Ballance). The importer converts it on this computer.',
  '3. Options > 3D Stereo lists the stereo modes; Options > Controller sets up',
  '   a gamepad. Leia SR needs the SR Platform from Leia installed; without it',
  '   the mode falls back to side-by-side.',
  '',
  'Physics: this build uses the built-in Rapier solver. For the original IVP',
  'physics, get the source from the project page and run',
  '  Build-IVP.bat "<this folder>"',
  'which builds the IVP module from its public source and installs it here.',
  '',
  'The executable is unsigned, so Windows SmartScreen may ask for "More info" >',
  '"Run anyway". Licences: LICENSE.txt, THIRD_PARTY.md and LICENSES/.',
  '',
].join('\r\n'))
else write(path.join(stage, 'README-tester.txt'), [
  'Ballance tester build',
  '',
  '1. Run Ballance.exe.',
  '2. If no pack is remembered, the setup window imports your installed Ballance',
  '   game (choose its folder) or opens an existing prepared pack.',
  '3. Graphics has Widescreen? and the resolution field; 3D Stereo lists the',
  '   stereo modes. The Leia SR mode relaunches into the presenter window.',
  '',
  'The full checklist and licence notes are in resources/app/docs/tester-build.md',
  'and LICENSES/. The executable is unsigned, so Windows SmartScreen may ask for',
  '"More info" > "Run anyway".',
  '',
].join('\n'))

const zip = path.join(releaseRoot, release ? `${appName}-v${pkg.version}-win-x64.zip` : `Ballance-Tester-${pkg.version}.zip`)
rmSync(zip, { force: true })
// Windows' own bsdtar writes zips; a GNU tar earlier on PATH (Git Bash) does not.
const windowsTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
execFileSync(windowsTar, ['-a', '-c', '-f', zip, '-C', stage, '.'], { stdio: 'inherit' })
const bytes = statSync(zip).size
console.log(`tester package: ${stage}`)
console.log(`tester zip: ${zip} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
