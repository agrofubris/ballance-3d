'use strict'

/**
 * Ballance Leia SR transport (Electron main process).
 *
 * Main owns the native presenter helper and its three named pipes:
 *
 *   frames  main -> helper   \\.\pipe\ballance_leia_frames
 *   ack     helper -> main   \\.\pipe\ballance_leia_ack
 *   input   helper -> main   \\.\pipe\ballance_leia_input
 *
 * Frame message (little-endian):
 *   magic u32 (0x4149454c "LEIA"), frameId u32, width u32, height u32,
 *   format u32 (1 = BGRA8 pixels, 2 = GPU shared texture), payloadBytes u32,
 *   payload
 *   format 2 payload: sourcePid u32, pixelFormat u32 (1 bgra8, 2 rgba8),
 *   flags u32 (1 = probe only), reserved u32, handle u64.
 * Ack message (little-endian): magic u32, frameId u32.
 * Input message (little-endian):
 *   magic u32 (0x59454b42 "BKEY"), kind u32 (1 = key, 2 = control), vkCode u32,
 *   scanCode u32, flags u32
 *   flags: bit 0 key up, bit 1 repeat, bit 2 extended, bit 3 shift,
 *          bit 4 control, bit 5 alt, bit 6 caps lock.
 *   control kind: vkCode = code (2 = shared texture failed), scanCode = frameId.
 *
 * One frame is in flight at a time. While it waits for the helper's ack the
 * transport drops newer paints; the helper always presents the freshest frame
 * that arrived. A shared-texture frame owns an Electron texture that must be
 * released only after the helper opened it (ack) or when it is dropped.
 */

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const LEIA_FRAME_MAGIC = 0x4149454c
const LEIA_FRAME_HEADER_BYTES = 24
const LEIA_FRAME_FORMAT_BGRA8 = 1
const LEIA_FRAME_FORMAT_SHARED_TEXTURE = 2
const LEIA_SHARED_TEXTURE_PAYLOAD_BYTES = 24
const LEIA_SHARED_PIXEL_FORMATS = { bgra: 1, rgba: 2 }
const LEIA_SHARED_PROBE = 1
const LEIA_ACK_BYTES = 8
const LEIA_INPUT_MAGIC = 0x59454b42
const LEIA_INPUT_BYTES = 20
const LEIA_INPUT_KIND_KEY = 1
const LEIA_INPUT_KIND_CONTROL = 2
const LEIA_CONTROL_SHARED_TEXTURE_FAILED = 2

const LEIA_KEY_UP = 1 << 0
const LEIA_KEY_REPEAT = 1 << 1
const LEIA_KEY_EXTENDED = 1 << 2
const LEIA_KEY_SHIFT = 1 << 3
const LEIA_KEY_CONTROL = 1 << 4
const LEIA_KEY_ALT = 1 << 5
const LEIA_KEY_CAPS_LOCK = 1 << 6

const LEIA_FRAME_PIPE = '\\\\.\\pipe\\ballance_leia_frames'
const LEIA_ACK_PIPE = '\\\\.\\pipe\\ballance_leia_ack'
const LEIA_INPUT_PIPE = '\\\\.\\pipe\\ballance_leia_input'

const LEIA_HELPER_RESTART_DELAY_MS = 1000
const LEIA_HELPER_MAX_RESTARTS = 3
const LEIA_HELPER_USER_CLOSE_EXIT = 3

function buildLeiaFrameMessage(header, payload) {
  if (!Buffer.isBuffer(payload)) throw new Error('buildLeiaFrameMessage needs a Buffer payload')
  const message = Buffer.allocUnsafe(LEIA_FRAME_HEADER_BYTES + payload.byteLength)
  message.writeUInt32LE(LEIA_FRAME_MAGIC, 0)
  message.writeUInt32LE(header.frameId >>> 0, 4)
  message.writeUInt32LE(header.width >>> 0, 8)
  message.writeUInt32LE(header.height >>> 0, 12)
  message.writeUInt32LE(header.format >>> 0, 16)
  message.writeUInt32LE(payload.byteLength >>> 0, 20)
  payload.copy(message, LEIA_FRAME_HEADER_BYTES)
  return message
}

/**
 * A GPU shared-texture frame: the helper duplicates `handle` from `sourcePid`,
 * opens it with D3D12 and presents it without a CPU copy. `release` is kept by
 * the transport and called when the helper acknowledges (or drops) the frame.
 */
function buildLeiaSharedFrameMessage(header) {
  const { frameId, width, height, sourcePid, pixelFormat, handle, probe = false } = header
  const format = LEIA_SHARED_PIXEL_FORMATS[pixelFormat]
  if (format === undefined) throw new Error(`Unsupported shared texture pixel format ${JSON.stringify(pixelFormat)}`)
  if (!(handle instanceof Uint8Array) || handle.byteLength !== 8) throw new Error('A shared texture handle must be 8 bytes')
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`A shared texture needs positive integer dimensions, got ${width}x${height}`)
  }
  const message = Buffer.allocUnsafe(LEIA_FRAME_HEADER_BYTES + LEIA_SHARED_TEXTURE_PAYLOAD_BYTES)
  message.writeUInt32LE(LEIA_FRAME_MAGIC, 0)
  message.writeUInt32LE(frameId >>> 0, 4)
  message.writeUInt32LE(width >>> 0, 8)
  message.writeUInt32LE(height >>> 0, 12)
  message.writeUInt32LE(LEIA_FRAME_FORMAT_SHARED_TEXTURE, 16)
  message.writeUInt32LE(LEIA_SHARED_TEXTURE_PAYLOAD_BYTES, 20)
  message.writeUInt32LE(sourcePid >>> 0, LEIA_FRAME_HEADER_BYTES)
  message.writeUInt32LE(format, LEIA_FRAME_HEADER_BYTES + 4)
  message.writeUInt32LE(probe ? LEIA_SHARED_PROBE : 0, LEIA_FRAME_HEADER_BYTES + 8)
  message.writeUInt32LE(0, LEIA_FRAME_HEADER_BYTES + 12)
  Buffer.from(handle.buffer, handle.byteOffset, handle.byteLength).copy(message, LEIA_FRAME_HEADER_BYTES + 16)
  return message
}

function readLeiaAcks(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('readLeiaAcks needs a Buffer')
  const acks = []
  let rest = buffer
  while (rest.length >= LEIA_ACK_BYTES) {
    const magic = rest.readUInt32LE(0)
    const frameId = rest.readUInt32LE(4)
    rest = rest.subarray(LEIA_ACK_BYTES)
    if (magic === LEIA_FRAME_MAGIC) acks.push(frameId)
  }
  return { acks, rest }
}

function buildLeiaInputMessage({ vkCode, scanCode = 0, flags = 0, kind = LEIA_INPUT_KIND_KEY }) {
  const message = Buffer.allocUnsafe(LEIA_INPUT_BYTES)
  message.writeUInt32LE(LEIA_INPUT_MAGIC, 0)
  message.writeUInt32LE(kind >>> 0, 4)
  message.writeUInt32LE(vkCode >>> 0, 8)
  message.writeUInt32LE(scanCode >>> 0, 12)
  message.writeUInt32LE(flags >>> 0, 16)
  return message
}

function readLeiaInputMessages(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('readLeiaInputMessages needs a Buffer')
  const messages = []
  let rest = buffer
  while (rest.length >= LEIA_INPUT_BYTES) {
    const magic = rest.readUInt32LE(0)
    const message = {
      kind: rest.readUInt32LE(4),
      vkCode: rest.readUInt32LE(8),
      scanCode: rest.readUInt32LE(12),
      flags: rest.readUInt32LE(16),
    }
    rest = rest.subarray(LEIA_INPUT_BYTES)
    if (magic === LEIA_INPUT_MAGIC) messages.push(message)
  }
  return { messages, rest }
}

const SIMPLE_KEY_NAMES = new Map([
  [0x08, 'Backspace'],
  [0x09, 'Tab'],
  [0x0d, 'Enter'],
  [0x13, 'Pause'],
  [0x14, 'Capslock'],
  [0x1b, 'Escape'],
  [0x20, 'Space'],
  [0x21, 'PageUp'],
  [0x22, 'PageDown'],
  [0x23, 'End'],
  [0x24, 'Home'],
  // Electron's sendInputEvent takes Accelerator key names, not DOM key
  // identifiers: "Down" becomes a DOM event with code "ArrowDown".
  [0x25, 'Left'],
  [0x26, 'Up'],
  [0x27, 'Right'],
  [0x28, 'Down'],
  [0x2d, 'Insert'],
  [0x2e, 'Delete'],
  [0x5b, 'Meta'],
  [0x5c, 'Meta'],
  [0x5d, 'ContextMenu'],
  [0x6a, 'nummult'],
  [0x6b, 'numadd'],
  [0x6d, 'numsub'],
  [0x6e, 'numdec'],
  [0x6f, 'numdiv'],
  [0x90, 'Numlock'],
  [0x91, 'Scrolllock'],
])

const OEM_KEYS = new Map([
  [0xba, [';', ':']],
  [0xbb, ['=', '+']],
  [0xbc, [',', '<']],
  [0xbd, ['-', '_']],
  [0xbe, ['.', '>']],
  [0xbf, ['/', '?']],
  [0xc0, ['`', '~']],
  [0xdb, ['[', '{']],
  [0xdc, ['\\', '|']],
  [0xdd, [']', '}']],
  [0xde, ["'", '"']],
  [0xe2, ['\\', '|']],
])

const SHIFTED_DIGITS = ')!@#$%^&*('

function keyNameForVk(vkCode) {
  if (vkCode >= 0x30 && vkCode <= 0x39) return String.fromCharCode(vkCode)
  if (vkCode >= 0x41 && vkCode <= 0x5a) return String.fromCharCode(vkCode)
  if (vkCode >= 0x60 && vkCode <= 0x69) return `num${vkCode - 0x60}`
  if (vkCode >= 0x70 && vkCode <= 0x87) return `F${vkCode - 0x6f}`
  const simple = SIMPLE_KEY_NAMES.get(vkCode)
  if (simple) return simple
  const oem = OEM_KEYS.get(vkCode)
  return oem ? oem[0] : null
}

function charForVk(vkCode, flags) {
  const shift = (flags & LEIA_KEY_SHIFT) !== 0
  const caps = (flags & LEIA_KEY_CAPS_LOCK) !== 0
  if (vkCode >= 0x30 && vkCode <= 0x39) return shift ? SHIFTED_DIGITS[vkCode - 0x30] : String.fromCharCode(vkCode)
  if (vkCode >= 0x41 && vkCode <= 0x5a) {
    const letter = String.fromCharCode(vkCode)
    return shift !== caps ? letter : letter.toLowerCase()
  }
  if (vkCode >= 0x60 && vkCode <= 0x69) return String.fromCharCode(0x30 + vkCode - 0x60)
  if (vkCode === 0x20) return ' '
  if (vkCode === 0x6a) return '*'
  if (vkCode === 0x6b) return '+'
  if (vkCode === 0x6d) return '-'
  if (vkCode === 0x6e) return '.'
  if (vkCode === 0x6f) return '/'
  const oem = OEM_KEYS.get(vkCode)
  return oem ? (shift ? oem[1] : oem[0]) : null
}

/**
 * Translate a presenter key message into the Electron sendInputEvent shape.
 * Returns null for keys Chromium has no accelerator name for.
 */
function mapWindowsKey(message) {
  if (!message || (message.kind !== undefined && message.kind !== LEIA_INPUT_KIND_KEY)) return null
  const keyCode = keyNameForVk(message.vkCode)
  if (!keyCode) return null
  const keyUp = (message.flags & LEIA_KEY_UP) !== 0
  const modifiers = []
  if (message.flags & LEIA_KEY_SHIFT) modifiers.push('shift')
  if (message.flags & LEIA_KEY_CONTROL) modifiers.push('control')
  if (message.flags & LEIA_KEY_ALT) modifiers.push('alt')
  if (message.flags & LEIA_KEY_CAPS_LOCK) modifiers.push('capsLock')
  if (message.flags & LEIA_KEY_REPEAT) modifiers.push('isAutoRepeat')
  return {
    keyCode,
    char: keyUp ? null : charForVk(message.vkCode, message.flags),
    modifiers,
    isKeyUp: keyUp,
  }
}

/** Inject one presenter key message into the offscreen game page. */
function sendLeiaKeyInput(webContents, message) {
  if (!webContents || webContents.isDestroyed()) return false
  const mapped = mapWindowsKey(message)
  if (!mapped) return false
  webContents.sendInputEvent({
    type: mapped.isKeyUp ? 'keyUp' : 'keyDown',
    keyCode: mapped.keyCode,
    modifiers: mapped.modifiers,
  })
  if (!mapped.isKeyUp && mapped.char) {
    webContents.sendInputEvent({
      type: 'char',
      keyCode: mapped.char,
      modifiers: mapped.modifiers,
    })
  }
  return true
}

/** Split a helper-argument string, honouring double and single quotes. */
function splitHelperArgs(text) {
  if (typeof text !== 'string') return []
  const args = []
  let current = ''
  let quote = null
  for (const character of text) {
    if (quote !== null) {
      if (character === quote) quote = null
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (current.length > 0) {
        args.push(current)
        current = ''
      }
    } else {
      current += character
    }
  }
  if (current.length > 0) args.push(current)
  return args
}

function buildLeiaHelperArgs({ monitor = 0, weaveSize, extraArgs = [] } = {}) {
  const width = Number(weaveSize?.width)
  const height = Number(weaveSize?.height)
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`buildLeiaHelperArgs needs a positive weave size, got ${JSON.stringify(weaveSize)}`)
  }
  const monitorIndex = Number(monitor)
  if (!Number.isInteger(monitorIndex) || monitorIndex < 0) {
    throw new Error(`buildLeiaHelperArgs needs a non-negative monitor index, got ${String(monitor)}`)
  }
  return ['--monitor', String(monitorIndex), '--weave-size', `${width}x${height}`, ...extraArgs]
}

/** Prefer the packaged presenter, then the repository build output. */
function resolveHelperPath({ resourcesPath, repoRoot, exists = fs.existsSync } = {}) {
  const packaged = typeof resourcesPath === 'string' && resourcesPath.length > 0
    ? path.join(resourcesPath, 'leia', 'BallanceLeiaPresenter.exe')
    : null
  if (packaged && exists(packaged)) return packaged
  return path.join(repoRoot, 'tools', 'leia-presenter', 'BallanceLeiaPresenter.exe')
}

function pipeLines(stream, onLine) {
  if (!stream) return
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

function createLeiaSrTransport({
  resourcesPath,
  repoRoot,
  monitor = 0,
  weaveSize,
  extraArgs = [],
  exists = fs.existsSync,
  spawnProcess = spawn,
  onInput = null,
  onControl = null,
  onSharedTextureFailure = null,
  onUserClose = null,
  onStateChange = null,
  log = console.log,
} = {}) {
  const helperPath = resolveHelperPath({ resourcesPath, repoRoot, exists })
  const helperArgs = buildLeiaHelperArgs({ monitor, weaveSize, extraArgs })
  const state = {
    helperPath,
    helperMissing: false,
    helperRunning: false,
    helperRestarts: 0,
    available: false,
    reason: 'not-started',
    mode: 'unknown',
    frameInFlight: null,
    framesSent: 0,
    framesAcked: 0,
    framesDropped: 0,
    sharedTexture: false,
    sharedTexturesSent: 0,
    sharedTextureFailures: 0,
    inputsForwarded: 0,
    fps: 0,
    lastError: null,
  }

  let quitting = false
  let framePipeServer = null
  let ackPipeServer = null
  let inputPipeServer = null
  let helperFrameSocket = null
  let helperAckSocket = null
  let helperInputSocket = null
  let helperProcess = null
  let helperOutput = ''
  let nextFrameId = 1
  let ackBuffer = Buffer.alloc(0)
  let inputBuffer = Buffer.alloc(0)
  let restartTimer = null
  let fpsTimer = null
  let lastFpsAcked = 0
  let lastFpsAt = 0
  /** Release function of the shared texture currently in flight. */
  let frameRelease = null
  const sharedWaiters = []

  const publish = () => {
    onStateChange?.({ ...state })
    return state
  }

  function resetSockets() {
    helperFrameSocket?.destroy()
    helperAckSocket?.destroy()
    helperInputSocket?.destroy()
    helperFrameSocket = null
    helperAckSocket = null
    helperInputSocket = null
    ackBuffer = Buffer.alloc(0)
    inputBuffer = Buffer.alloc(0)
    if (frameRelease) {
      const release = frameRelease
      frameRelease = null
      try { release() } catch { /* the texture is already gone */ }
    }
    state.frameInFlight = null
  }

  function startFramePipeServer() {
    if (framePipeServer) return
    framePipeServer = net.createServer((socket) => {
      helperFrameSocket?.destroy()
      helperFrameSocket = socket
      state.available = true
      state.helperRunning = true
      state.reason = 'helper-connected'
      publish()
      socket.on('error', () => {})
      socket.on('close', () => {
        if (helperFrameSocket === socket) helperFrameSocket = null
      })
    })
    framePipeServer.on('error', (error) => {
      state.lastError = `frame-pipe: ${error.message}`
      publish()
    })
    framePipeServer.listen(LEIA_FRAME_PIPE)
  }

  function startAckPipeServer() {
    if (ackPipeServer) return
    ackPipeServer = net.createServer((socket) => {
      helperAckSocket?.destroy()
      helperAckSocket = socket
      ackBuffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        ackBuffer = Buffer.concat([ackBuffer, chunk])
        const parsed = readLeiaAcks(ackBuffer)
        ackBuffer = parsed.rest
        for (const frameId of parsed.acks) {
          if (state.frameInFlight === frameId) {
            state.frameInFlight = null
            state.framesAcked += 1
            const release = frameRelease
            frameRelease = null
            try { release?.() } catch { /* the texture is already gone */ }
          }
        }
      })
      socket.on('error', () => {})
      socket.on('close', () => {
        if (helperAckSocket === socket) helperAckSocket = null
      })
    })
    ackPipeServer.on('error', (error) => {
      state.lastError = `ack-pipe: ${error.message}`
      publish()
    })
    ackPipeServer.listen(LEIA_ACK_PIPE)
  }

  function startInputPipeServer() {
    if (inputPipeServer) return
    inputPipeServer = net.createServer((socket) => {
      helperInputSocket?.destroy()
      helperInputSocket = socket
      inputBuffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        inputBuffer = Buffer.concat([inputBuffer, chunk])
        const parsed = readLeiaInputMessages(inputBuffer)
        inputBuffer = parsed.rest
        for (const message of parsed.messages) {
          if (message.kind === LEIA_INPUT_KIND_CONTROL) {
            if (message.vkCode === LEIA_CONTROL_SHARED_TEXTURE_FAILED) {
              state.sharedTextureFailures += 1
              state.lastError = 'shared texture unavailable'
              publish()
              onSharedTextureFailure?.(message)
            }
            onControl?.(message)
            continue
          }
          state.inputsForwarded += 1
          try {
            onInput?.(message)
          } catch (error) {
            state.lastError = `input: ${error instanceof Error ? error.message : String(error)}`
            publish()
          }
        }
      })
      socket.on('error', () => {})
      socket.on('close', () => {
        if (helperInputSocket === socket) helperInputSocket = null
      })
    })
    inputPipeServer.on('error', (error) => {
      state.lastError = `input-pipe: ${error.message}`
      publish()
    })
    inputPipeServer.listen(LEIA_INPUT_PIPE)
  }

  function handleHelperLine(line) {
    log(`ballance: leia presenter: ${line}`)
    helperOutput += `${line}\n`
    if (helperOutput.length > 4000) helperOutput = helperOutput.slice(-4000)
    if (line.includes('shared-texture=1') && !state.sharedTexture) {
      state.sharedTexture = true
      for (const resolve of sharedWaiters.splice(0)) resolve(true)
      publish()
    }
    if (line.includes('LeiaSR weaver initialized')) {
      if (state.mode !== 'weaving') {
        state.mode = 'weaving'
        publish()
      }
    } else if (
      line.includes('LeiaSR unavailable')
      || line.includes('built without SR-lib')
      || line.includes('presenting plain side-by-side')
      || line.includes('weave failed; falling back')
    ) {
      if (state.mode !== 'raw-sbs') {
        state.mode = 'raw-sbs'
        publish()
      }
    }
  }

  function scheduleRestart() {
    if (quitting || restartTimer !== null) return
    if (state.helperRestarts >= LEIA_HELPER_MAX_RESTARTS) {
      state.reason = 'helper-failed'
      state.lastError = helperOutput.trim().slice(-400) || state.lastError
      publish()
      return
    }
    state.helperRestarts += 1
    state.reason = 'helper-restarting'
    publish()
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!quitting) spawnHelper()
    }, LEIA_HELPER_RESTART_DELAY_MS)
  }

  function helperExited(child, code, error) {
    if (helperProcess !== child) return
    helperProcess = null
    resetSockets()
    state.helperRunning = false
    state.available = false
    state.frameInFlight = null
    if (quitting) return
    if (error) {
      state.lastError = `helper: ${error.message}`
      log(`ballance: leia presenter failed: ${error.message}`)
    }
    if (code === LEIA_HELPER_USER_CLOSE_EXIT) {
      state.reason = 'closed-by-user'
      state.lastError = null
      publish()
      onUserClose?.()
      return
    }
    state.reason = `helper-exited:${code === null ? 'unknown' : code}`
    publish()
    scheduleRestart()
  }

  function spawnHelper() {
    if (quitting || helperProcess) return
    if (!exists(helperPath)) {
      state.helperMissing = true
      state.helperRunning = false
      state.available = false
      state.reason = 'helper-missing'
      state.lastError = `The Leia presenter was not found at ${helperPath}. Build it with "npm run leia:build".`
      publish()
      return
    }
    let child
    try {
      child = spawnProcess(helperPath, helperArgs, {
        cwd: path.dirname(helperPath),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
      })
    } catch (error) {
      state.lastError = `could not start the presenter: ${error.message}`
      state.reason = 'helper-failed'
      publish()
      return
    }
    helperProcess = child
    helperOutput = ''
    state.helperMissing = false
    state.helperRunning = true
    state.reason = 'helper-starting'
    state.lastError = null
    publish()
    pipeLines(child.stdout, handleHelperLine)
    pipeLines(child.stderr, handleHelperLine)
    child.on('error', (error) => helperExited(child, null, error))
    child.on('exit', (code) => helperExited(child, code, null))
  }

  function startFpsTimer() {
    if (fpsTimer) return
    lastFpsAcked = 0
    lastFpsAt = Date.now()
    fpsTimer = setInterval(() => {
      const now = Date.now()
      const seconds = Math.max((now - lastFpsAt) / 1000, 0.001)
      state.fps = (state.framesAcked - lastFpsAcked) / seconds
      lastFpsAcked = state.framesAcked
      lastFpsAt = now
      publish()
    }, 1000)
    fpsTimer.unref?.()
  }

  function sendFrame(frame) {
    if (!frame || !Buffer.isBuffer(frame.data) || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)) {
      return false
    }
    if (!helperFrameSocket || helperFrameSocket.destroyed || state.frameInFlight !== null) {
      state.framesDropped += 1
      return false
    }
    const frameId = nextFrameId
    nextFrameId = (nextFrameId + 1) >>> 0
    state.frameInFlight = frameId
    state.framesSent += 1
    try {
      helperFrameSocket.write(buildLeiaFrameMessage(
        { frameId, width: frame.width, height: frame.height, format: 1 },
        frame.data,
      ))
    } catch (error) {
      state.frameInFlight = null
      state.framesDropped += 1
      state.lastError = `frame-pipe: ${error instanceof Error ? error.message : String(error)}`
      publish()
      return false
    }
    return true
  }

  function sendSharedFrame(frame) {
    const release = typeof frame?.release === 'function' ? frame.release : null
    if (!release || !frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)) {
      release?.()
      return false
    }
    if (!helperFrameSocket || helperFrameSocket.destroyed || state.frameInFlight !== null) {
      state.framesDropped += 1
      release()
      return false
    }
    const frameId = nextFrameId
    nextFrameId = (nextFrameId + 1) >>> 0
    state.frameInFlight = frameId
    state.framesSent += 1
    state.sharedTexturesSent += 1
    try {
      helperFrameSocket.write(buildLeiaSharedFrameMessage({
        frameId,
        width: frame.width,
        height: frame.height,
        sourcePid: frame.sourcePid,
        pixelFormat: frame.pixelFormat,
        handle: frame.handle,
        probe: frame.probe === true,
      }))
      frameRelease = release
    } catch (error) {
      state.frameInFlight = null
      state.framesDropped += 1
      state.lastError = `shared-frame-pipe: ${error instanceof Error ? error.message : String(error)}`
      publish()
      release()
      return false
    }
    return true
  }

  function waitForSharedTexture(timeoutMs = 2000) {
    if (state.sharedTexture) return Promise.resolve(true)
    if (quitting) return Promise.resolve(false)
    return new Promise(resolve => {
      let timer = null
      const finish = value => {
        if (timer !== null) clearTimeout(timer)
        const index = sharedWaiters.indexOf(waiter)
        if (index >= 0) sharedWaiters.splice(index, 1)
        resolve(value)
      }
      const waiter = value => finish(value)
      sharedWaiters.push(waiter)
      timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
      timer.unref?.()
    })
  }

  function start() {
    if (quitting) return state
    startFpsTimer()
    if (!exists(helperPath)) {
      spawnHelper()
      return state
    }
    startFramePipeServer()
    startAckPipeServer()
    startInputPipeServer()
    spawnHelper()
    return state
  }

  function stop() {
    quitting = true
    for (const resolve of sharedWaiters.splice(0)) resolve(false)
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (fpsTimer) {
      clearInterval(fpsTimer)
      fpsTimer = null
    }
    const child = helperProcess
    helperProcess = null
    resetSockets()
    if (child && child.exitCode === null) child.kill()
    framePipeServer?.close()
    ackPipeServer?.close()
    inputPipeServer?.close()
    framePipeServer = null
    ackPipeServer = null
    inputPipeServer = null
    state.available = false
    state.helperRunning = false
    state.reason = 'stopped'
    state.frameInFlight = null
    publish()
  }

  return Object.freeze({
    start,
    stop,
    sendFrame,
    sendSharedFrame,
    waitForSharedTexture,
    getState: () => ({ ...state }),
    helperPath,
    helperArgs,
  })
}

module.exports = {
  LEIA_ACK_PIPE,
  LEIA_ACK_BYTES,
  LEIA_CONTROL_SHARED_TEXTURE_FAILED,
  LEIA_FRAME_FORMAT_BGRA8,
  LEIA_FRAME_FORMAT_SHARED_TEXTURE,
  LEIA_FRAME_HEADER_BYTES,
  LEIA_FRAME_MAGIC,
  LEIA_FRAME_PIPE,
  LEIA_INPUT_BYTES,
  LEIA_INPUT_KIND_CONTROL,
  LEIA_INPUT_KIND_KEY,
  LEIA_INPUT_MAGIC,
  LEIA_INPUT_PIPE,
  LEIA_KEY_ALT,
  LEIA_KEY_CAPS_LOCK,
  LEIA_KEY_CONTROL,
  LEIA_KEY_EXTENDED,
  LEIA_KEY_REPEAT,
  LEIA_KEY_SHIFT,
  LEIA_KEY_UP,
  LEIA_HELPER_MAX_RESTARTS,
  LEIA_HELPER_USER_CLOSE_EXIT,
  LEIA_SHARED_PIXEL_FORMATS,
  LEIA_SHARED_TEXTURE_PAYLOAD_BYTES,
  buildLeiaFrameMessage,
  buildLeiaHelperArgs,
  buildLeiaInputMessage,
  buildLeiaSharedFrameMessage,
  createLeiaSrTransport,
  mapWindowsKey,
  readLeiaAcks,
  readLeiaInputMessages,
  resolveHelperPath,
  sendLeiaKeyInput,
  splitHelperArgs,
}
