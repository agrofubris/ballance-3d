// base.cmo's start-up blocks that read or change the machine, decoded from
// the shipped DLLs (addresses per block; UNVERIFIED marks where the DLL left
// a question):
//   TT_InterfaceManager_RT.dll  TT List Driver, TT List ScreenModes, TT Change ScreenMode,
//                               TT Player Active, TT_ReadRegistry, TT Exit to System
//   TT_Toolbox_RT.dll           TT GetEnvironmentVariable, TT OperationSystem, TT GetMemoryStatus,
//                               TT_GetCurrentDirectory, TT_ReplacePath, TT_DebugON / TT_DebugOFF, TT_TextureInfo
//   Visuals.dll                 Show Mouse Cursor, Statistics
//   Controllers.dll             Key Waiter, Mouse Waiter
//   physics_RT.dll              Get Profiler Values
// Not ported: Create System Font (the CK font manager; base runs it only in debug mode).
//
// Everything the Windows API, the display driver or the input manager answers
// comes from the host through `context.system` (GraphSystemBinding).
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import { originalArraySetLayout } from './original-graph-array.ts'
import type { GraphInputManager } from './original-input-manager.ts'

/** A `VxDisplayMode`: `{ Width@0, Height@4, Bpp@8, RefreshRate@0xC }`. */
export interface GraphDisplayMode { width: number; height: number; bpp: number; refresh: number }

/** A `VxDriverDesc` as CKRenderManager::GetRenderDriverDescription returns it. */
export interface GraphDisplayDriver {
  /** `+0x000` DriverDesc. */
  description: string
  /** `+0x200` DriverName. */
  name: string
  /** `+0x400`: nonzero for drivers the list blocks report. */
  ready: boolean
  /** `+0x404` / `+0x408`: the display modes in the driver's own order (mode ids are indexes into it). */
  modes: readonly GraphDisplayMode[]
  /** `+0x418` (`>> 20` is the video memory in MB). */
  videoMemoryBytes?: number
}

/** The MEMORYSTATUS DWORDs GlobalMemoryStatus returns, in bytes. */
export interface GraphMemoryStatus {
  loadPercent: number
  totalPhysical: number
  availablePhysical: number
  totalVirtual: number
  availableVirtual: number
}

/** The OSVERSIONINFO fields GetVersionExA returns. */
export interface GraphOsVersion { platformId: number; major: number; minor: number }

/** A VxImageDescEx as the texture getters fill it: `Flags@4` (0 = uncompressed), `Height@0xC`, `BytesPerLine@0x10`. */
export interface GraphImageDesc { flags: number; height: number; bytesPerLine: number }

export interface GraphTextureEntry {
  /** CKTexture vtbl +0x70 (UNVERIFIED name: "is in video memory"). */
  inVideo: boolean
  /** vtbl +0x80 result, undefined when it fails (UNVERIFIED name: video description). */
  video?: GraphImageDesc
  /** vtbl +0x88 (UNVERIFIED name: system description); the result is not tested by the block. */
  system: GraphImageDesc
}

export interface GraphMouseState {
  /** Absolute position (vtbl +0xB4). */
  x: number
  y: number
  /** Relative wheel component (vtbl +0xB8, `z`). */
  wheel: number
  left: boolean
  right: boolean
  middle: boolean
}

export interface GraphProfileStats {
  /** `CKStats` word 0; Frame Rate = 1000 / this (ms). */
  frameMs: number
  /** The eight time floats (Interface .. Behavior Execution) in output order. */
  times: readonly number[]
  /** Active Object Executed .. Links Delayed. */
  behavior: readonly number[]
  /** Faces, Lines, Points, Objects, Vertices (VxStats). */
  render: readonly number[]
}

export interface GraphSystemBinding {
  /** Not `CKContext::IsInInterfaceMode()`: the Player is never in interface mode. */
  playerActive(): boolean
  /** HKLM `key` (verbatim, backslashes), value `name`, raw REG_DWORD; undefined when the key or value is missing. */
  registryDword(key: string, name: string): number | undefined
  /** HKLM `key`, REG_SZ value `name`. */
  registryString(key: string, name: string): string | undefined
  /** The CRT `getenv`. */
  environment(name: string): string | undefined
  /** `GetCurrentDirectoryA`; '' is a failure. */
  currentDirectory(): string
  osVersion(): GraphOsVersion
  memoryStatus(): GraphMemoryStatus
  /** CKRenderManager's driver descriptions, index = driver id. */
  displayDrivers(): readonly GraphDisplayDriver[]
  /** TT InterfaceManager +0x2C / +0x28; the Player writes them on every screen mode change. */
  readonly installed: { driver: number; mode: number }
  /** Window message 0x5FD (wParam mode, lParam driver); true when the Player switched. Updates `installed`. */
  changeScreenMode(driver: number, mode: number): boolean
  /** Window message 0x5FA. */
  exit(): void
  /** CKInputManager::ShowCursor. */
  showCursor(show: boolean): void
  /** The CKInputManager's buffered keyboard and mouse state. */
  readonly input: GraphInputManager
  mouse(): GraphMouseState
  /** TT_DebugON / TT_DebugOFF: the debug manager's byte at +0x2C. */
  debug: boolean
  /** CKContext::OutputToConsole(Ex). */
  console(message: string, beep: boolean): void
  /** CKContext::EnableProfiling. */
  enableProfiling(on: boolean): void
  /** CKContext::GetProfileStats + the render context's stats. */
  profileStats(): GraphProfileStats
  /** Every CKTexture (class 0x1F) of the context. */
  textures(): readonly GraphTextureEntry[]
  /** The counter Get Profiler Values reads at physics manager +0x2CE4 (UNVERIFIED meaning). */
  physicsProfileCount(): number
  /** `fopen(path, "rb")` + `fread` of a file of the install; undefined when it cannot be opened. */
  readFile(path: string): Uint8Array | undefined
  /** `fopen(path, "wb")` + `fwrite`; false when it cannot be opened. */
  writeFile(path: string, bytes: Uint8Array): boolean
  /** CKPathManager: the registered paths of a category (0 texture, 1 data, 2 sound). */
  paths(category: number): readonly string[]
  renamePath(category: number, index: number, to: string): void
}

const TYPE_INT = 'fd16575ad776e244'
const TYPE_FLOAT = '3f4c8847202c2c43'
const TYPE_BOOL = '8e2ad51a2019745e'
const TYPE_STRING = 'e210d06bea175611'
/** CKARRAYTYPE. */
const ARRAY_INT = 1
const ARRAY_STRING = 3
/** 1 / 1048576 as the DLLs store it (float 0x358637BD). */
const MB = Math.fround(1 / 1048576)
const f32 = Math.fround

function systemOf(context: BehaviorContext): GraphSystemBinding {
  const system = context.system
  if (!system) throw new Error(`${context.node.name} ${context.node.index} needs the host system binding`)
  return system
}

const int = (value: GraphParameterValue): number => Math.trunc(Number(value ?? 0))
const text = (value: GraphParameterValue): string => typeof value === 'string' ? value : ''
const truthy = (value: GraphParameterValue): boolean => value === true || (typeof value === 'number' && value !== 0)

/** `float(uint32 * 1/1048576)`: the DLL's `fild qword` of a zero-extended DWORD times the float constant. */
const megabytes = (bytes: number): number => f32((bytes >>> 0) * MB)

// ---------------------------------------------------------------------------
// TT_InterfaceManager_RT.dll

/** The driver and mode ids index the render manager's lists. */
function driverAt(system: GraphSystemBinding, index: number): GraphDisplayDriver | undefined {
  return index >= 0 ? system.displayDrivers()[index] : undefined
}

/** Clear(1), RemoveColumn until none, then the new layout; the rows are emptied in place. */
function resetArray(rows: GraphParameterValue[][], columns: readonly { name: string; type: number }[]): void {
  originalArraySetLayout(rows, columns)
}

/** CKDataArray::InsertRow(n): n outside 0..count appends. */
function insertRow(rows: GraphParameterValue[][], row: number, fill: GraphParameterValue[]): void {
  rows.splice(row >= 0 && row <= rows.length ? row : rows.length, 0, fill)
}

/**
 * TT List Driver (62d00456:30eb4245, run 0x10004920). Input 0 the array. Fills it with
 * `[DriverName, DriverID, DriverDesc]` for each driver the manager lists, then Installed
 * Driver = manager +0x2C; OK. A missing array is Error after a console message.
 */
export const listDriver: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  const name = context.inputObject(0)
  const rows = name === undefined ? undefined : context.array(name)
  if (!rows) {
    system.console('ListDriver: Kein DataArray-Objekt übergeben.', true)
    context.activate(1)
    return
  }
  resetArray(rows, [{ name: 'DriverName', type: ARRAY_STRING }, { name: 'DriverID', type: ARRAY_INT }, { name: 'DriverDesc', type: ARRAY_STRING }])
  const drivers = system.displayDrivers()
  for (let i = 0; i < drivers.length; i++) {
    const driver = drivers[i]!
    if (!driver.ready) continue
    insertRow(rows, i, ['', 0, ''])
    // SetElement on a row that InsertRow(i) could not place at i fails silently.
    const row = rows[i]
    if (row) { row[0] = driver.name; row[1] = i; row[2] = driver.description }
  }
  context.setOutput(0, system.installed.driver)
  context.activate(0)
}

/**
 * TT List ScreenModes (4e7a0194:040328fd, run 0x10004C20). Inputs: Driver ID, the array.
 * Rows `[Mode, Width, Height, Bpp]` for the driver's modes with Bpp > 8, skipping a mode
 * whose (Width, Height, Bpp) an earlier mode already has. Installed Mode = manager +0x28.
 */
export const listScreenModes: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  const id = int(context.input(0))
  const name = context.inputObject(1)
  const rows = name === undefined ? undefined : context.array(name)
  if (!rows) {
    system.console('ListScreenMode: Kein DataArray-Objekt übergeben.', true)
    context.activate(1)
    return
  }
  resetArray(rows, [{ name: 'Mode', type: ARRAY_INT }, { name: 'Width', type: ARRAY_INT }, { name: 'Height', type: ARRAY_INT }, { name: 'Bpp', type: ARRAY_INT }])
  const driver = driverAt(system, id)
  if (!driver) {
    system.console(`ListScreenMode: Keine Driver Description für Driver-ID '${id}' vorhanden`, true)
    context.activate(1)
    return
  }
  let count = 0
  for (let i = 0; i < driver.modes.length; i++) {
    const mode = driver.modes[i]!
    if (mode.bpp <= 8) continue
    let duplicate = false
    for (let j = 0; j < i; j++) {
      const earlier = driver.modes[j]!
      if (earlier.width === mode.width && earlier.height === mode.height && earlier.bpp === mode.bpp) { duplicate = true; break }
    }
    if (duplicate) continue
    insertRow(rows, count, [0, 0, 0, 0])
    const row = rows[count]!
    row[0] = i; row[1] = mode.width; row[2] = mode.height; row[3] = mode.bpp
    count++
  }
  context.setOutput(0, system.installed.mode)
  context.activate(0)
}

/**
 * TT Change ScreenMode (38b84d97:13932f28, run 0x10003CE0). Inputs: Driver ID, ScreenMode ID.
 * The driver must exist and the mode must be in range with Bpp >= 16; then the host answers
 * the window message 0x5FD (SendMessage: the change completed before Out). Failure is Error.
 */
export const changeScreenMode: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  const driverId = int(context.input(0))
  const modeId = int(context.input(1))
  const driver = driverAt(system, driverId)
  if (!driver) {
    system.console(`Change Screen Mode: Keine Driver Description für Driver-ID '${driverId}' vorhanden`, true)
    context.activate(1)
    return
  }
  if (modeId < 0 || modeId >= driver.modes.length || driver.modes[modeId]!.bpp < 16) {
    system.console('Change Screen Mode:ScreenMode ungültig', true)
    context.activate(1)
    return
  }
  context.activate(system.changeScreenMode(driverId, modeId) ? 0 : 1)
}

/** TT Player Active (0694658d:7ffd236f, run 0x10004FA0): Active (0) unless in interface mode, then InActive (1). */
export const playerActive: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  context.activate(system.playerActive() ? 0 : 1)
}

/** TT Exit to System (5bc50af4:41e92536, run 0x10005720): PostMessage(0x5FA) to the main window, then Out. */
export const exitToSystem: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  system.exit()
  context.activate(0)
}

/**
 * TT_ReadRegistry (460044b5:6e927b66, run 0x10007A00), single value mode. HKLM, the section
 * verbatim, `RegQueryValueExA` into a 4-byte (int, float, bool: the raw DWORD) or 256-byte
 * (string) buffer. On failure the DLL fires FAILED, prints the console message, and then still
 * SetOutputParameterValue(NULL) + fires OK (the output keeping its value is UNVERIFIED).
 * Array mode (`SaveArray-Mode`) is not used by any exported graph and fails loudly.
 */
export const readRegistry: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  if (truthy(context.local(0))) {
    throw new Error(`TT_ReadRegistry ${context.node.index} runs in SaveArray-Mode, which is not decoded for the port`)
  }
  const section = text(context.input(0))
  const entry = text(context.input(1))
  const type = context.node.outputs?.[0]?.type
  let value: GraphParameterValue | undefined
  if (type === TYPE_INT || type === TYPE_FLOAT || type === TYPE_BOOL) {
    const dword = system.registryDword(section, entry)
    if (dword !== undefined) {
      const view = new DataView(new ArrayBuffer(4))
      view.setUint32(0, dword >>> 0, true)
      value = type === TYPE_INT ? view.getInt32(0, true) : type === TYPE_FLOAT ? view.getFloat32(0, true) : view.getUint32(0, true) !== 0
    }
  } else if (type === TYPE_STRING) {
    value = system.registryString(section, entry)
  } else {
    // Any other output type: the DLL falls through without activating an output.
    return
  }
  if (value === undefined) {
    context.activate(1)
    system.console(`TT_ReadRegistry: failed to open : HKEY_LOCAL_MACHINE\\${section}`, true)
  } else {
    context.setOutput(0, value)
  }
  context.activate(0)
}

// ---------------------------------------------------------------------------
// TT_Toolbox_RT.dll

/**
 * TT GetEnvironmentVariable (4c6513e9:20e11177, run 0x1001D220). Variablename -> Found (0) with
 * Environment Variable, or Not Found (1) with a console message (no beep). The DLL returns
 * 0xA008 in both failure cases; the runtime has no return code.
 */
export const getEnvironmentVariable: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  const name = context.input(0)
  if (typeof name !== 'string') {
    context.activate(1)
    system.console('No Variablename defined.', false)
    return
  }
  const value = system.environment(name)
  if (value === undefined) {
    context.activate(1)
    system.console('No Variable with the specified name found.', false)
    return
  }
  context.setOutput(0, value)
  context.activate(0)
}

/** TT OperationSystem (4c94621d:24fe2cf3, run 0x10027050): PlattformId, MinorVersion, MajorVersion; zeros unless platform 1 or 2. */
export const operationSystem: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  const { platformId, major, minor } = system.osVersion()
  const known = platformId === 1 || platformId === 2
  context.setOutput(0, known ? platformId : 0)
  context.setOutput(1, known ? minor : 0)
  context.setOutput(2, known ? major : 0)
  context.activate(0)
}

/** TT GetMemoryStatus (3b826e04:6e764285, run 0x10026D90): MemoryLoad (%), then physical / virtual total / available in MB (floats). */
export const getMemoryStatus: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  const status = system.memoryStatus()
  context.setOutput(0, status.loadPercent >>> 0)
  context.setOutput(1, megabytes(status.totalPhysical))
  context.setOutput(2, megabytes(status.availablePhysical))
  context.setOutput(3, megabytes(status.totalVirtual))
  context.setOutput(4, megabytes(status.availableVirtual))
  context.activate(0)
}

/** TT_GetCurrentDirectory (556e6df3:24207d37, run 0x1001E4A0): the directory (also on failure); OK when non-empty, else Fail. */
export const getCurrentDirectory: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  const directory = system.currentDirectory()
  context.setOutput(0, directory)
  context.activate(directory.length > 0 ? 0 : 1)
}

/**
 * TT_ReplacePath (524a6bcb:66f67774, run 0x1001EE40). A = cwd + old, B = cwd + new; the first
 * path of the category whose name compares different from A (`jne` at 0x1001F076, which reads
 * inverted against the block's name: UNVERIFIED) is renamed to B and Ok fires; none: Failed.
 */
export const replacePath: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  const category = int(context.input(3))
  if (category < 0 || category > 2) {
    system.console('TT_ReplacePath: invalid PathIDX', true)
    context.activate(1)
    return
  }
  const cwd = text(context.input(2))
  const from = cwd + text(context.input(0))
  const to = cwd + text(context.input(1))
  const paths = system.paths(category)
  for (let i = 0; i < paths.length; i++) {
    if (paths[i] === from) continue
    system.renamePath(category, i, to)
    context.activate(0)
    return
  }
  context.activate(1)
}

/** TT_DebugON (3d00718f:2c8b33a2, run 0x10023000) / TT_DebugOFF (run 0x10022E70): the debug manager byte, then Exit. */
export const debugOn: BehaviorFn = context => {
  systemOf(context).debug = true
  context.consumeInput(context.inputSlot)
  context.activate(0)
}
export const debugOff: BehaviorFn = context => {
  systemOf(context).debug = false
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

/**
 * TT_TextureInfo (7c663b40:2f4b347e, run 0x100179B0). MaxVideoMemory = driver 0's +0x418 >> 20,
 * then over every texture: NumberOfTextures / UsedSystemMemory (all textures, system description)
 * and TexturesInVideoMemory / UsedVideoTextureMemory (video textures). Bytes are Height *
 * BytesPerLine of uncompressed descriptions (Flags == 0); compressed ones print a console message.
 */
export const textureInfo: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  const driver = driverAt(system, 0)
  if (!driver) throw new Error(`TT_TextureInfo ${context.node.index} has no render driver 0`)
  context.setOutput(0, (driver.videoMemoryBytes ?? 0) >>> 20)
  let textures = 0, systemBytes = 0, inVideo = 0, videoBytes = 0
  for (const texture of system.textures()) {
    if (texture.inVideo && texture.video) {
      inVideo++
      if (texture.video.flags === 0) videoBytes += texture.video.height * texture.video.bytesPerLine
      else system.console('Compressed Texture Found!!!', true)
    }
    textures++
    if (texture.system.flags === 0) systemBytes += texture.system.height * texture.system.bytesPerLine
    else system.console('Compressed Texture Found!!!', true)
  }
  context.setOutput(1, textures)
  context.setOutput(2, megabytes(systemBytes))
  context.setOutput(3, inVideo)
  context.setOutput(4, megabytes(videoBytes))
  context.activate(0)
}

// ---------------------------------------------------------------------------
// Visuals.dll

/** Show Mouse Cursor (16f6368f:506b60fc, run 0x25782730): Out fires first, then CKInputManager::ShowCursor(Show). */
export const showMouseCursor: BehaviorFn = context => {
  const system = systemOf(context)
  context.consumeInput(context.inputSlot)
  context.activate(0)
  system.showCursor(truthy(context.input(0)))
}

/**
 * Statistics (5fb70201:65595af3, run 0x257943B0). On: Exit On, profiling on, outputs from the
 * current stats and stay active every frame; Off: Exit Off, profiling off. Settings (locals):
 * 0 Frame Rate, 1 General Time mask (outputs 1..8), 2 Behavioral mask (9..13), 3 Rendering mask (14..18).
 * The per-field CKStats names are UNVERIFIED; the frame-rate formula is the DLL's 1000 / CKStats[0].
 */
export const statistics: BehaviorFn = context => {
  const system = systemOf(context)
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.activate(0)
    system.enableProfiling(true)
    const stats = system.profileStats()
    if (truthy(context.local(0))) context.setOutput(0, f32(1000 / stats.frameMs))
    const masks = [int(context.local(1)), int(context.local(2)), int(context.local(3))]
    const groups: [number, readonly number[], number][] = [[1, stats.times, 8], [9, stats.behavior, 5], [14, stats.render, 5]]
    groups.forEach(([first, values, count], group) => {
      for (let bit = 0; bit < count; bit++) if (masks[group]! & (1 << bit)) context.setOutput(first + bit, group === 0 ? f32(values[bit] ?? 0) : int(values[bit] ?? 0))
    })
    context.wait()
    return
  }
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.activate(1)
    system.enableProfiling(false)
  }
}

// ---------------------------------------------------------------------------
// Controllers.dll

/** Key Waiter (016d010b:017d010b, run 0x25204790): Out as soon as the key is held; otherwise stay active. */
export const keyWaiter: BehaviorFn = context => {
  if (context.isInputActive(0)) context.consumeInput(0)
  if (context.keyDown(int(context.input(0)))) {
    context.activate(0)
    return
  }
  context.wait()
}

/**
 * Mouse Waiter (014d010b:015d010b, run 0x25205240). While active it publishes the mouse state
 * to its outputs (0 position, 1 wheel, 2 Left, 3 Middle, 4 Right) and fires, in the order of
 * the enabled `Outputs` bits, Move, Left Down/Up, Right Down/Up, Middle Down/Up, Roll.
 * Off ends it when Stay Active; without Stay Active it ends on the first run that fires nothing.
 */
export const mouseWaiter: BehaviorFn = context => {
  const system = systemOf(context)
  const stayActive = truthy(context.local(0))
  if (context.isInputActive(0)) context.consumeInput(0)
  if (stayActive && context.isInputActive(1)) { context.consumeInput(1); return }
  const old = context.output(0)
  const [oldX, oldY] = Array.isArray(old) ? [Number(old[0]), Number(old[1])] : [0, 0]
  // Outputs 2, 3, 4 are Left, Middle, Right.
  const before = [truthy(context.output(2)), truthy(context.output(3)), truthy(context.output(4))]
  const mouse = system.mouse()
  const now = [mouse.left, mouse.middle, mouse.right]
  context.setOutput(0, [mouse.x, mouse.y])
  context.setOutput(1, f32(mouse.wheel))
  context.setOutput(2, mouse.left)
  context.setOutput(3, mouse.middle)
  context.setOutput(4, mouse.right)
  const mask = context.local(1) === undefined ? 0xFFFF : int(context.local(1))
  const edge = (button: number, down: boolean) => down ? !before[button]! && now[button]! : before[button]! && !now[button]!
  const events: boolean[] = [
    mouse.x !== oldX || mouse.y !== oldY, // 0x01 Move
    edge(0, true), edge(0, false), // 0x02 / 0x04 Left Down / Up
    edge(2, true), edge(2, false), // 0x08 / 0x10 Right Down / Up
    edge(1, true), edge(1, false), // 0x20 / 0x40 Middle Down / Up
    mouse.wheel !== 0, // 0x80 Roll
  ]
  let slot = 0
  let fired = false
  for (let bit = 0; bit < 8; bit++) {
    if (!(mask & (1 << bit))) continue
    if (events[bit] && slot < context.outCount) { context.activate(slot); fired = true }
    slot++
  }
  if (stayActive || !fired) context.wait()
}

// ---------------------------------------------------------------------------
// physics_RT.dll

/**
 * Get Profiler Values (1c8e61d1:32723c6f, run 0x10001FD0). Reset is checked first (counters
 * zeroed, ResetOut) and leaves Start pending; Start sets output 0 and fires Out. base.cmo's
 * Exit Level activates both together, so Out fires one run after ResetOut.
 */
export const getProfilerValues: BehaviorFn = context => {
  const system = systemOf(context)
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.activate(1)
    if (context.isInputActive(0)) context.wait()
    return
  }
  context.consumeInput(0)
  context.setOutput(0, system.physicsProfileCount())
  context.activate(0)
}

/** The registry additions, keyed by block name as ORIGINAL_BEHAVIORS is. */
export const SYSTEM_BEHAVIORS: BehaviorRegistry = {
  'TT List Driver': listDriver,
  'TT List ScreenModes': listScreenModes,
  'TT Change ScreenMode': changeScreenMode,
  'TT Player Active': playerActive,
  'TT Exit to System': exitToSystem,
  TT_ReadRegistry: readRegistry,
  'TT GetEnvironmentVariable': getEnvironmentVariable,
  'TT OperationSystem': operationSystem,
  'TT GetMemoryStatus': getMemoryStatus,
  TT_GetCurrentDirectory: getCurrentDirectory,
  TT_ReplacePath: replacePath,
  TT_DebugON: debugOn,
  TT_DebugOFF: debugOff,
  TT_TextureInfo: textureInfo,
  'Show Mouse Cursor': showMouseCursor,
  Statistics: statistics,
  'Key Waiter': keyWaiter,
  'Mouse Waiter': mouseWaiter,
  'Get Profiler Values': getProfilerValues,
}
