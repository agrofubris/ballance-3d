const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, screen, session } = require('electron')
const { spawn, execFile } = require('node:child_process')
const { createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { Readable } = require('node:stream')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const importerCore = require('./importer/importer-core.cjs')
const { createLeiaCapture } = require('./leia/capture.cjs')
const { createLeiaWaitingWindow } = require('./leia/waiting-window.cjs')
const { createLeiaSrTransport, sendLeiaKeyInput, splitHelperArgs } = require('./leia/transport.cjs')

const SCHEME = 'app'
const HOST = 'ballance'
const APP_URL = `${SCHEME}://${HOST}/`
const repoRoot = path.resolve(__dirname, '..')
const distRoot = path.join(repoRoot, 'dist', 'client')
const defaultPackRoot = path.join(repoRoot, '.local', 'original')
const defaultIvpRoot = path.join(repoRoot, '.local', 'ivp-simulation')

const ORIGINAL_TYPES = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=windows-1252',
  '.avi': 'video/x-msvideo',
  '.tdb': 'application/octet-stream',
  '.bmp': 'image/bmp',
  '.wav': 'audio/wav',
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.txt': 'text/plain; charset=utf-8',
  '.tdb': 'application/octet-stream',
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

function readOption(argv, name) {
  const prefix = `${name}=`
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === name) {
      const value = argv[index + 1]
      return value && !value.startsWith('--') ? value : undefined
    }
    if (argument.startsWith(prefix)) return argument.slice(prefix.length)
  }
  return undefined
}

const remoteDebuggingPort = readOption(process.argv, '--remote-debugging-port')
if (remoteDebuggingPort) app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)
// A desktop game plays its intro music and menu sounds before the first click;
// Chromium's default policy would keep every AudioContext suspended until then.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const userDataOption = readOption(process.argv, '--user-data-dir')
if (userDataOption) {
  const directory = path.resolve(userDataOption)
  mkdirSync(directory, { recursive: true })
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
}

const DEFAULT_WEAVE_SIZE = { width: 1920, height: 1080 }

let shellStatePath = ''
let shellState = {}
let packRoot = ''
let ivpRoot = ''
let saveWindowTimer = 0
let importerWindow = null
let importerDone = null
let importerDetected = ''
let importProcess = null
let importTail = []
let importCancelled = false
let gameWindow = null
// A screen mode chosen while fullscreen; applied when the window leaves fullscreen.
let pendingScreenMode = null
let waitingWindow = null
let leiaCapture = null
let leiaTransport = null
let leiaStatus = null
/** True while the Leia window paints GPU shared textures instead of CPU bitmaps. */
let leiaSharedTexture = false
let leiaSharedFallback = false

shellStatePath = path.join(app.getPath('userData'), 'shell.json')
shellState = readShellState()

function parseWeaveSize(value) {
  const match = /^(\d+)[xX](\d+)$/.exec(String(value).trim())
  const width = match ? Number(match[1]) : 0
  const height = match ? Number(match[2]) : 0
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`--weave-size must be WxH (for example 1920x1080), got "${value}"`)
  }
  return { width, height }
}

function savedWeaveSize(value) {
  if (value === undefined) return { ...DEFAULT_WEAVE_SIZE }
  const width = value && typeof value === 'object' ? Number(value.width) : NaN
  const height = value && typeof value === 'object' ? Number(value.height) : NaN
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`shell.json weaveSize must be a positive { width, height } object, got ${JSON.stringify(value)}`)
  }
  return { width, height }
}

function savedLeiaMonitor(value) {
  if (value === undefined) return 0
  const monitor = Number(value)
  if (!Number.isInteger(monitor) || monitor < 0) {
    throw new Error(`shell.json leiaMonitor must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return monitor
}

const leiaDumpFlag = process.argv.some(argument => argument === '--leia-dump' || argument.startsWith('--leia-dump='))
const leiaDumpOption = readOption(process.argv, '--leia-dump')
const weaveSizeOption = readOption(process.argv, '--weave-size')
const leiaHelperArgsOption = readOption(process.argv, '--leia-helper-args')
const leiaHelperArgs = splitHelperArgs(leiaHelperArgsOption ?? process.env.BALLANCE_LEIA_HELPER_ARGS ?? '')
let startupError = ''
let weaveSize = { ...DEFAULT_WEAVE_SIZE }
let leiaMonitor = 0
try {
  if (leiaDumpFlag && !leiaDumpOption) throw new Error('--leia-dump needs an output directory')
  weaveSize = weaveSizeOption !== undefined ? parseWeaveSize(weaveSizeOption) : savedWeaveSize(shellState.weaveSize)
  leiaMonitor = savedLeiaMonitor(shellState.leiaMonitor)
} catch (error) {
  startupError = error instanceof Error ? error.message : String(error)
}
const leiaDumpDir = leiaDumpOption ? path.resolve(leiaDumpOption) : null
const leiaActive = process.argv.includes('--leia') || shellState.leia === true
// GPU shared textures need Electron's `offscreen.useSharedTexture` (Electron
// 33+); `--leia-pixel` / BALLANCE_LEIA_PIXEL=1 keeps the CPU bitmap path.
const leiaElectronShared = Number.parseInt(String(process.versions.electron).split('.')[0], 10) >= 33
const leiaForcePixel = process.argv.includes('--leia-pixel') || process.env.BALLANCE_LEIA_PIXEL === '1'
if (leiaActive) app.commandLine.appendSwitch('force-device-scale-factor', '1')

function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function hasDataArrays(directory) {
  return isFile(path.join(directory, 'data-arrays.json'))
}

function readShellState() {
  try {
    const parsed = JSON.parse(readFileSync(shellStatePath, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeShellState() {
  try {
    mkdirSync(path.dirname(shellStatePath), { recursive: true })
    writeFileSync(shellStatePath, `${JSON.stringify(shellState, null, 2)}\n`)
  } catch (error) {
    console.error('Ballance: could not save shell state', error)
  }
}

async function resolvePackRoot() {
  const commandLinePack = readOption(process.argv, '--pack')
  if (commandLinePack) {
    const directory = path.resolve(commandLinePack)
    if (hasDataArrays(directory)) return directory
  } else {
    const remembered = typeof shellState.pack === 'string' ? path.resolve(shellState.pack) : null
    const candidate = remembered ?? defaultPackRoot
    if (hasDataArrays(candidate)) return candidate
  }

  return openImporter()
}

function execFileText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '' })
    })
  })
}

async function detectGameFolder() {
  if (process.platform !== 'win32') return ''
  const candidates = []
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Ballance', 'HKLM\\SOFTWARE\\Ballance']) {
    const { stdout } = await execFileText('reg.exe', ['query', key, '/s'])
    candidates.push(...importerCore.parseRegistryValues(stdout, ['TargetDir', 'InstallPath', 'InstallLocation', 'GamePath']))
  }
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    const { stdout } = await execFileText('reg.exe', ['query', key, '/s', '/f', 'Ballance'])
    candidates.push(...importerCore.parseUninstallLocations(stdout))
  }
  for (const candidate of candidates) {
    const directory = path.resolve(candidate)
    if (importerCore.gameFolderStatus(directory).valid) return directory
  }
  return ''
}

function isImporterUrl(target) {
  try {
    const file = path.resolve(fileURLToPath(target))
    const root = path.resolve(__dirname, 'importer')
    return file === root || file.startsWith(root + path.sep)
  } catch {
    return false
  }
}

function importerSender(event) {
  if (!importerWindow || importerWindow.isDestroyed() || event.sender !== importerWindow.webContents) {
    throw new Error('Unexpected importer request')
  }
}

function sendImporter(channel, payload) {
  if (importerWindow && !importerWindow.isDestroyed()) importerWindow.webContents.send(channel, payload)
}

function finishImporter(directory) {
  const done = importerDone
  importerDone = null
  if (done) done.resolve(directory)
}

function appendImportLog(line) {
  importTail.push(line)
  if (importTail.length > 120) importTail.splice(0, importTail.length - 120)
}

function removeDirectory(directory) {
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch (error) {
    console.error(`Ballance: could not remove ${directory}`, error)
  }
}

function pipeLines(stream, onLine) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      onLine(line)
    }
  })
  stream.on('end', () => {
    if (buffer) onLine(buffer.replace(/\r$/, ''))
  })
}

function cancelImport() {
  importCancelled = true
  const child = importProcess
  importProcess = null
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill())
  } else {
    child.kill('SIGKILL')
  }
}

function startImport(gameFolder) {
  if (importProcess) throw new Error('An import is already running.')
  const directory = path.resolve(gameFolder)
  const status = importerCore.gameFolderStatus(directory)
  if (!status.valid) {
    throw new Error('The selected folder is not a Ballance installation: it must contain base.cmo and "3D Entities" or "3D_Entities".')
  }
  const tools = importerCore.resolveTools({ resourcesPath: process.resourcesPath, repoRoot })
  const missing = importerCore.missingTools(tools)
  if (missing.length > 0) {
    throw new Error(`The importer is missing ${missing.join(', ')}.`)
  }

  const packTarget = path.join(app.getPath('userData'), 'pack')
  const workTarget = path.join(app.getPath('userData'), 'import-work')
  try {
    rmSync(packTarget, { recursive: true, force: true })
    rmSync(workTarget, { recursive: true, force: true })
    mkdirSync(workTarget, { recursive: true })
  } catch (error) {
    throw new Error(`Could not prepare the import folders under ${app.getPath('userData')}: ${error.message}`)
  }

  importTail = []
  importCancelled = false
  const args = importerCore.buildImportArguments({
    prepare: tools.prepare,
    gameFolder: directory,
    library: tools.library,
    dumpChunks: tools.dumpChunks,
    output: packTarget,
    work: workTarget,
  })
  const child = spawn(tools.python, args, {
    cwd: path.dirname(tools.scripts),
    windowsHide: true,
    env: {
      ...process.env,
      BALLANCE_IMPORT_OUTPUT: packTarget,
      BALLANCE_IMPORT_WORK: workTarget,
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  importProcess = child

  const onLine = (line) => {
    appendImportLog(line)
    const progress = importerCore.parseStepLine(line)
    if (progress) sendImporter('importer:progress', progress)
  }
  pipeLines(child.stdout, onLine)
  pipeLines(child.stderr, onLine)

  let finished = false
  const fail = (message) => {
    if (finished) return
    finished = true
    if (importProcess === child) importProcess = null
    removeDirectory(packTarget)
    sendImporter('importer:failed', { message, tail: importTail.slice(-40) })
  }
  child.on('error', (error) => fail(`Could not start the importer: ${error.message}`))
  child.on('close', (code) => {
    if (finished) return
    if (importCancelled) {
      finished = true
      importCancelled = false
      if (importProcess === child) importProcess = null
      removeDirectory(packTarget)
      sendImporter('importer:cancelled', {})
      return
    }
    if (code === 0 && hasDataArrays(packTarget)) {
      finished = true
      if (importProcess === child) importProcess = null
      removeDirectory(workTarget)
      shellState.pack = packTarget
      writeShellState()
      finishImporter(packTarget)
      return
    }
    fail(`The import failed${code === null ? '' : ` (exit code ${code})`}.`)
  })
}

function closeImporterWindow() {
  const win = importerWindow
  importerWindow = null
  if (win && !win.isDestroyed()) win.close()
}

async function openImporter() {
  importerDetected = await detectGameFolder()
  const promise = new Promise((resolve) => {
    importerDone = { resolve }
  })
  const win = new BrowserWindow({
    width: 700,
    height: 640,
    minWidth: 560,
    minHeight: 520,
    title: 'Ballance setup',
    show: false,
    backgroundColor: '#17191c',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'importer', 'preload.cjs'),
    },
  })
  importerWindow = win
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (!isImporterUrl(target)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, target) => {
    if (!isImporterUrl(target)) event.preventDefault()
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (importerWindow === win) importerWindow = null
    cancelImport()
    const done = importerDone
    importerDone = null
    if (done) done.resolve(null)
  })
  void win.loadFile(path.join(__dirname, 'importer', 'index.html'))
  return promise
}

function registerImporterHandlers() {
  ipcMain.handle('importer:context', (event) => {
    importerSender(event)
    return { gameFolder: importerDetected, status: importerCore.gameFolderStatus(importerDetected) }
  })
  ipcMain.handle('importer:choose-game-folder', async (event) => {
    importerSender(event)
    const choice = await dialog.showOpenDialog(importerWindow, {
      title: 'Choose your Ballance game folder',
      defaultPath: importerDetected || app.getPath('home'),
      properties: ['openDirectory'],
    })
    const selected = choice.filePaths[0]
    if (choice.canceled || !selected) return { canceled: true }
    const directory = path.resolve(selected)
    const status = importerCore.gameFolderStatus(directory)
    if (status.valid) importerDetected = directory
    return { canceled: false, directory, status }
  })
  ipcMain.handle('importer:choose-pack', async (event) => {
    importerSender(event)
    if (importProcess) throw new Error('Wait for the running import to finish or cancel it first.')
    const choice = await dialog.showOpenDialog(importerWindow, {
      title: 'Choose your prepared Ballance pack folder',
      properties: ['openDirectory'],
    })
    const selected = choice.filePaths[0]
    if (choice.canceled || !selected) return { canceled: true }
    const directory = path.resolve(selected)
    if (!hasDataArrays(directory)) {
      throw new Error(`The selected folder does not contain data-arrays.json:\n${directory}\n\nPrepare the pack with scripts/prepare-original.py or import the game above.`)
    }
    shellState.pack = directory
    writeShellState()
    finishImporter(directory)
    return { canceled: false, directory }
  })
  ipcMain.handle('importer:start', (event, gameFolder) => {
    importerSender(event)
    startImport(String(gameFolder ?? ''))
    return { ok: true }
  })
  ipcMain.handle('importer:cancel', (event) => {
    importerSender(event)
    cancelImport()
    return { ok: true }
  })
}

function resolveIvpRoot() {
  const commandLineIvp = readOption(process.argv, '--ivp')
  if (commandLineIvp) return path.resolve(commandLineIvp)
  if (typeof shellState.ivp === 'string') return path.resolve(shellState.ivp)
  return defaultIvpRoot
}

function contentType(file, types) {
  return types[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function resolveInside(root, relative) {
  if (relative.includes('\0')) return null
  const file = path.resolve(root, `.${relative}`)
  if (file !== root && !file.startsWith(root + path.sep)) return null
  return isFile(file) ? file : null
}

function serveFile(file, type) {
  return new Response(Readable.toWeb(createReadStream(file)), {
    headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
  })
}

function notFound(message = 'Not found') {
  return new Response(message, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function handleAppRequest(request) {
  let url
  let pathname
  try {
    url = new URL(request.url)
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return notFound()
  }
  if (url.protocol !== `${SCHEME}:` || url.hostname !== HOST) return notFound()

  if (pathname === '/original' || pathname.startsWith('/original/')) {
    const file = resolveInside(packRoot, pathname.slice('/original'.length))
    return file ? serveFile(file, contentType(file, ORIGINAL_TYPES)) : notFound()
  }

  if (pathname.startsWith('/ivp/')) {
    const name = path.basename(pathname)
    if (name === 'ivp-simulation.mjs' || name === 'ivp-simulation.wasm') {
      const file = resolveInside(ivpRoot, `/${name}`)
      return file ? serveFile(file, contentType(file, { '.mjs': 'text/javascript', '.wasm': 'application/wasm' })) : notFound('Build the local IVP module first')
    }
  }

  const file = resolveInside(distRoot, pathname === '/' ? '/index.html' : pathname)
  return file ? serveFile(file, contentType(file, STATIC_TYPES)) : notFound()
}

function isAppUrl(target) {
  try {
    const url = new URL(target)
    return url.protocol === `${SCHEME}:` && url.hostname === HOST
  } catch {
    return false
  }
}

function intersectsAnyDisplay(x, y, width, height) {
  return screen.getAllDisplays().some(({ workArea }) => (
    x < workArea.x + workArea.width
    && x + width > workArea.x
    && y < workArea.y + workArea.height
    && y + height > workArea.y
  ))
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return
  const bounds = win.getNormalBounds()
  // At fractional scale factors a restored size reads back a DIP or two off;
  // keep the saved size then, so the window does not grow on every launch.
  const previous = shellState.window && typeof shellState.window === 'object' ? shellState.window : {}
  const near = (value, saved) => Number.isFinite(saved) && Math.abs(value - saved) <= 2 ? saved : value
  shellState.window = {
    x: bounds.x,
    y: bounds.y,
    width: near(bounds.width, previous.width),
    height: near(bounds.height, previous.height),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  }
  writeShellState()
}

function scheduleWindowStateSave(win) {
  clearTimeout(saveWindowTimer)
  saveWindowTimer = setTimeout(() => saveWindowState(win), 500)
}

/**
 * Resize the game window's content area to a physical-pixel mode, keeping its
 * centre on the screen and clamping the content to the display's work area.
 */
async function setWindowContentSize(win, widthPx, heightPx) {
  const bounds = win.getBounds()
  const display = screen.getDisplayMatching(bounds)
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  const area = display.workArea
  const width = Math.min(Math.round(widthPx / scale), area.width)
  const height = Math.min(Math.round(heightPx / scale), area.height)
  win.setContentSize(width, height)
  const outer = win.getBounds()
  const x = Math.round(bounds.x + bounds.width / 2 - outer.width / 2)
  const y = Math.round(bounds.y + bounds.height / 2 - outer.height / 2)
  const clampedX = Math.min(Math.max(x, area.x), area.x + area.width - outer.width)
  const clampedY = Math.min(Math.max(y, area.y), area.y + area.height - outer.height)
  win.setPosition(clampedX, clampedY)
  // At fractional scale factors Windows rounds the frame and client area in
  // device pixels (depending on position too), so the page can get a DIP or two
  // more or less than requested. Try the nearby requests and keep the one the
  // page measures closest to the mode in device pixels.
  const measure = () => win.webContents.executeJavaScript('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done([innerWidth, innerHeight, devicePixelRatio]))))')
  const offsets = [[0, 0], [-1, 0], [0, -1], [-1, -1], [1, 0], [0, 1], [-2, 0], [0, -2], [-2, -2], [-1, -2], [-2, -1]]
  let best = null
  for (const [dw, dh] of offsets) {
    if (win.isDestroyed()) return
    if (dw !== 0 || dh !== 0) win.setContentSize(width + dw, height + dh)
    const [pageWidth, pageHeight, pageScale] = await measure()
    // A clamped mode aims at the clamped size, so it is not searched in vain.
    const error = Math.abs(Math.min(widthPx, area.width * scale) - pageWidth * pageScale) + Math.abs(Math.min(heightPx, area.height * scale) - pageHeight * pageScale)
    if (!best || error < best.error) best = { error, dw, dh }
    if (error < 1) return
  }
  if (!win.isDestroyed()) win.setContentSize(width + best.dw, height + best.dh)
}

/** A mode as large as the window's display cannot be a window; it is shown fullscreen. */
function modeFillsDisplay(win, widthPx, heightPx) {
  const display = screen.getDisplayMatching(win.getBounds())
  const scale = display.scaleFactor > 0 ? display.scaleFactor : 1
  return widthPx >= Math.round(display.size.width * scale) && heightPx >= Math.round(display.size.height * scale)
}

function createWindow() {
  const saved = shellState.window && typeof shellState.window === 'object' ? shellState.window : {}
  const options = {
    width: 1280,
    height: 960,
    title: 'Ballance',
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  }

  const width = Number(saved.width)
  const height = Number(saved.height)
  if (Number.isFinite(width) && width >= 320) options.width = Math.round(width)
  if (Number.isFinite(height) && height >= 240) options.height = Math.round(height)
  const x = Number(saved.x)
  const y = Number(saved.y)
  if (Number.isFinite(x) && Number.isFinite(y) && intersectsAnyDisplay(x, y, options.width, options.height)) {
    options.x = Math.round(x)
    options.y = Math.round(y)
  }

  const win = new BrowserWindow(options)
  gameWindow = win

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (!isAppUrl(target)) event.preventDefault()
  })
  win.webContents.on('will-frame-navigate', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, target) => {
    if (!isAppUrl(target)) event.preventDefault()
  })
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    if (input.key === 'F11') {
      event.preventDefault()
      win.setFullScreen(!win.isFullScreen())
    }
  })
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    console.error(`Ballance: failed to load ${validatedUrl} (${code} ${description})`)
  })

  win.once('ready-to-show', () => {
    if (saved.maximized === true) win.maximize()
    if (saved.fullscreen === true) win.setFullScreen(true)
    win.show()
    const mode = shellState.screenMode
    if (mode && saved.maximized !== true && saved.fullscreen !== true) {
      if (modeFillsDisplay(win, mode.width, mode.height)) return win.setFullScreen(true)
      setWindowContentSize(win, mode.width, mode.height).catch((error) => console.error('Ballance: screen mode', error))
    }
  })
  // A size the player drags replaces the chosen mode.
  win.on('will-resize', () => {
    if (!shellState.screenMode) return
    delete shellState.screenMode
    writeShellState()
  })
  win.on('resize', () => scheduleWindowStateSave(win))
  win.on('move', () => scheduleWindowStateSave(win))
  win.on('maximize', () => saveWindowState(win))
  win.on('unmaximize', () => saveWindowState(win))
  win.on('enter-full-screen', () => saveWindowState(win))
  win.on('leave-full-screen', () => {
    const mode = pendingScreenMode
    pendingScreenMode = null
    if (!mode) return saveWindowState(win)
    // Windows restores the pre-fullscreen bounds after this event, so apply the
    // mode on the next turn and again after the restore's resize.
    const apply = () => {
      if (win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return
      setWindowContentSize(win, mode.width, mode.height).then(() => {
        shellState.screenMode = mode
        saveWindowState(win)
      }, (error) => console.error('Ballance: screen mode', error))
    }
    win.once('resize', apply)
    setTimeout(apply, 0)
  })
  win.on('close', () => {
    clearTimeout(saveWindowTimer)
    saveWindowState(win)
  })
  win.on('closed', () => {
    if (gameWindow === win) gameWindow = null
  })

  void win.loadURL(APP_URL)
}

/** Arguments for the post-Leia-toggle relaunch, dropping stale launch-mode flags. */
function relaunchArguments(leia) {
  const args = []
  const argv = process.argv.slice(1)
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--leia') continue
    if (argument === '--leia-dump') { index += 1; continue }
    if (argument.startsWith('--leia-dump=')) continue
    args.push(argument)
  }
  if (leia) args.push('--leia')
  return args
}

function stopLeiaTransport() {
  const transport = leiaTransport
  leiaTransport = null
  transport?.stop()
}

async function relaunchLeia(on) {
  stopLeiaTransport()
  shellState.leia = on
  writeShellState()
  try {
    await session.defaultSession.flushStorageData()
  } catch (error) {
    console.error('Ballance: could not flush saved settings before relaunch', error)
  }
  app.relaunch({ args: relaunchArguments(on) })
  app.exit(0)
}

/** The Leia game window: offscreen, exactly the full eye pair, at the weave size. */
function createLeiaWindow(sharedTexture = false) {
  leiaSharedTexture = sharedTexture
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: weaveSize.width * 2,
    height: weaveSize.height,
    useContentSize: true,
    title: 'Ballance',
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: sharedTexture ? { useSharedTexture: true, sharedTexturePixelFormat: 'argb' } : true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  gameWindow = win
  win.setContentSize(weaveSize.width * 2, weaveSize.height)
  console.log(`ballance: leia window content=${win.getContentSize().join('x')} bounds=${win.getBounds().width}x${win.getBounds().height} shared=${sharedTexture}`)

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (!isAppUrl(target)) event.preventDefault()
  })
  win.webContents.on('will-frame-navigate', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event, target) => {
    if (!isAppUrl(target)) event.preventDefault()
  })
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    console.error(`Ballance: failed to load ${validatedUrl} (${code} ${description})`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Ballance: Leia renderer gone (${details.reason} ${details.exitCode})`)
  })
  win.webContents.setFrameRate(60)

  leiaCapture = sharedTexture ? null : createLeiaCapture({ dumpDir: leiaDumpDir })
  let sharedPaints = 0
  let sharedSize = 'none'
  win.webContents.on('paint', (event, _dirtyRect, image) => {
    if (sharedTexture) {
      const texture = event.texture
      if (!texture) return
      const info = texture.textureInfo
      const release = () => { try { texture.release() } catch { /* already released */ } }
      if (info.pixelFormat !== 'bgra' && info.pixelFormat !== 'rgba') {
        console.error(`Ballance: Leia shared texture pixel format ${info.pixelFormat} is not supported`)
        release()
        return
      }
      if (!leiaTransport) { release(); return }
      const width = info.codedSize.width
      const height = info.codedSize.height
      sharedPaints += 1
      sharedSize = `${width}x${height}`
      try {
        leiaTransport.sendSharedFrame({
          width, height, sourcePid: process.pid, pixelFormat: info.pixelFormat,
          handle: info.handle.ntHandle, release,
        })
      } catch (error) {
        release()
        console.error('Ballance: could not send a shared Leia frame', error)
      }
      return
    }
    try {
      const frame = leiaCapture.onPaint(image)
      if (frame) leiaTransport?.sendFrame(frame)
    } catch (error) {
      console.error('Ballance: could not capture a Leia frame', error)
    }
  })

  // Compositing a 3840x1080 offscreen surface while the game loads roughly
  // quintuples the load time on this machine. Keep painting stopped until the
  // page has its canvas and has dropped the loading overlay, then capture.
  win.webContents.stopPainting()
  let started = false
  let fpsTimer = null
  let lastPaints = 0
  let lastAt = 0
  let lastPipeAcked = null
  const startCapture = () => {
    if (started || win.isDestroyed()) return
    started = true
    clearInterval(readyPoll)
    win.webContents.startPainting()
    lastAt = Date.now()
    fpsTimer = setInterval(() => {
      const now = Date.now()
      const stats = leiaCapture?.stats
      const seconds = (now - lastAt) / 1000
      const newest = stats?.newest
      const size = sharedTexture ? sharedSize : newest ? `${newest.width}x${newest.height}` : 'none'
      const frames = sharedTexture ? sharedPaints : stats?.paints ?? 0
      const dumps = stats?.dumps ?? 0
      const fps = seconds > 0 ? (frames - lastPaints) / seconds : 0
      const pipe = leiaTransport?.getState()
      const pipeStats = pipe
        ? ` pipe=${pipe.framesAcked - (lastPipeAcked ?? 0)}/${pipe.framesAcked} sent=${pipe.framesSent} dropped=${pipe.framesDropped} shared=${pipe.sharedTexturesSent}/${pipe.sharedTextureFailures} inputs=${pipe.inputsForwarded}`
        : ''
      if (pipe) lastPipeAcked = pipe.framesAcked
      console.log(`ballance: leia paint fps=${fps.toFixed(1)} frames=${frames} size=${size} dumps=${dumps}${leiaDumpDir ? ` dir=${leiaDumpDir}` : ''}${pipeStats}`)
      lastPaints = frames
      lastAt = now
    }, 1000)
    void win.webContents.executeJavaScript(
      "(() => { if (typeof navigator.getGamepads !== 'function') return 'missing'; const pads = Array.from(navigator.getGamepads()).filter(Boolean); return 'present count=' + pads.length + (pads.length ? ' [' + pads.map(p => (p.id || 'gamepad') + ' axes=' + p.axes.length).join(', ') + ']' : '') })()",
      true,
    )
      .then(result => console.log(`ballance: leia Gamepad API ${result}`))
      .catch(error => console.log(`ballance: leia Gamepad API probe failed: ${error instanceof Error ? error.message : String(error)}`))
    console.log(`ballance: leia painting started (${sharedTexture ? 'shared texture' : 'CPU bitmap'})`)
  }
  const readyPoll = setInterval(() => {
    if (started || win.isDestroyed()) return
    win.webContents.executeJavaScript("!document.querySelector('.original-loading') && !!document.querySelector('.game-canvas canvas')", true)
      .then(ready => { if (ready === true) startCapture() })
      .catch(() => {})
  }, 500)

  win.on('closed', () => {
    clearInterval(readyPoll)
    clearInterval(fpsTimer)
    if (gameWindow === win) {
      leiaCapture?.stop()
      leiaCapture = null
      gameWindow = null
    }
  })

  void win.loadURL(APP_URL)
  return win
}

function createGameWindow(sharedTexture = false) {
  return leiaActive ? createLeiaWindow(sharedTexture) : createWindow()
}

function updateLeiaStatus(status) {
  leiaStatus = status
  const win = waitingWindow
  if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return
  win.webContents.send('ballance:leia-status', status)
}

/**
 * A helper that cannot open Electron's shared texture (another GPU adapter, an
 * old driver, a lost device) asks for CPU bitmaps through a control message.
 * Recreate the offscreen window without `useSharedTexture`; the game restarts
 * its load, but the fallback path is exactly the original one.
 */
function fallbackLeiaSharedTexture(reason) {
  if (!leiaSharedTexture || leiaSharedFallback) return
  leiaSharedFallback = true
  leiaSharedTexture = false
  console.error(`ballance: Leia shared texture unavailable (${reason}); restarting the offscreen window with CPU bitmap frames`)
  const old = gameWindow
  if (!old || old.isDestroyed()) return
  try { old.webContents.stopPainting() } catch { /* already destroyed */ }
  old.destroy()
  setImmediate(() => {
    if (leiaActive && !gameWindow) createGameWindow(false)
  })
}

function createWaitingWindow() {
  const win = createLeiaWaitingWindow({ onReturn: () => { void relaunchLeia(false) } })
  waitingWindow = win
  win.webContents.on('did-finish-load', () => {
    if (leiaStatus) updateLeiaStatus(leiaStatus)
  })
  win.on('closed', () => {
    if (waitingWindow === win) waitingWindow = null
    // Closing the only visible window must not leave the hidden offscreen game
    // running with no way back. Relaunching/returning exits before this runs.
    if (leiaActive) app.quit()
  })
  return win
}

async function start() {
  if (startupError) throw new Error(startupError)

  if (!isFile(path.join(distRoot, 'index.html'))) {
    throw new Error(`The production build is missing at ${distRoot}.\n\nRun npm run build first.`)
  }

  if (shellState.weaveSize?.width !== weaveSize.width || shellState.weaveSize?.height !== weaveSize.height) {
    shellState.weaveSize = { ...weaveSize }
    writeShellState()
  }

  registerImporterHandlers()
  ipcMain.handle('ballance:set-leia', async (event, on) => {
    if (!gameWindow || gameWindow.isDestroyed() || event.sender !== gameWindow.webContents) {
      throw new Error('Unexpected Leia request')
    }
    await relaunchLeia(on === true)
    return { ok: true }
  })
  // TT Exit to System: the menu's Exit quits the app.
  ipcMain.handle('ballance:quit', (event) => {
    if (!gameWindow || gameWindow.isDestroyed() || event.sender !== gameWindow.webContents) return false
    setImmediate(() => app.quit())
    return true
  })
  ipcMain.handle('ballance:set-screen-mode', async (event, width, height) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    // Fullscreen keeps its size, and the Leia offscreen window has a fixed eye pair.
    if (!win || win.isDestroyed() || win !== gameWindow || leiaActive) return false
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false
    const fills = modeFillsDisplay(win, width, height)
    if (win.isFullScreen()) {
      pendingScreenMode = fills ? null : { width, height }
      return fills
    }
    pendingScreenMode = null
    if (fills) {
      // The saved fullscreen flag restores it; a stored window mode would not.
      delete shellState.screenMode
      win.setFullScreen(true)
      return true
    }
    if (win.isMaximized()) win.unmaximize()
    await setWindowContentSize(win, width, height)
    // Restored outer bounds read back a few DIP off at fractional scale factors,
    // so the chosen mode itself is re-applied at the next launch.
    shellState.screenMode = { width, height }
    saveWindowState(win)
    return true
  })
  ipcMain.handle('ballance:leia-return', async (event) => {
    if (!waitingWindow || waitingWindow.isDestroyed() || event.sender !== waitingWindow.webContents) {
      throw new Error('Unexpected Leia return request')
    }
    await relaunchLeia(false)
    return { ok: true }
  })

  packRoot = await resolvePackRoot()
  if (!packRoot) {
    app.quit()
    return
  }
  ivpRoot = resolveIvpRoot()

  protocol.handle(SCHEME, handleAppRequest)
  Menu.setApplicationMenu(null)
  ipcMain.on('ballance:shell-info', (event) => {
    event.returnValue = {
      version: app.getVersion(),
      leia: { available: true, active: leiaActive, weaveSize: { ...weaveSize } },
    }
  })
  if (leiaActive) {
    createWaitingWindow()
    leiaTransport = createLeiaSrTransport({
      resourcesPath: process.resourcesPath,
      repoRoot,
      monitor: leiaMonitor,
      weaveSize,
      extraArgs: leiaHelperArgs,
      onInput: (message) => {
        const win = gameWindow
        if (win && !win.isDestroyed()) sendLeiaKeyInput(win.webContents, message)
      },
      onSharedTextureFailure: (message) => fallbackLeiaSharedTexture(`frame ${message.scanCode}`),
      onUserClose: () => { void relaunchLeia(false) },
      onStateChange: updateLeiaStatus,
    })
    leiaTransport.start()
    // The helper advertises the shared-texture protocol on stdout. Choosing
    // before the window exists avoids an empty CPU paint path: Electron's
    // shared-texture mode never provides `image` pixels.
    const shared = leiaElectronShared && !leiaForcePixel && await leiaTransport.waitForSharedTexture(2500)
    console.log(`ballance: leia ${shared ? 'shared texture' : 'CPU bitmap'} mode${leiaForcePixel ? ' (forced pixel)' : ''}`)
    createGameWindow(shared)
  } else {
    createGameWindow()
  }
  closeImporterWindow()
}

app.whenReady().then(start).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('Ballance:', message)
  dialog.showErrorBox('Ballance', message)
  app.quit()
})

app.on('before-quit', () => {
  stopLeiaTransport()
  if (importProcess) cancelImport()
})
app.on('window-all-closed', () => app.quit())
