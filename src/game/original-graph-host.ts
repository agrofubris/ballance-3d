import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { OriginalAvi } from './original-avi.ts'
import { OriginalBallShadow, type ShadowFloorSource } from './original-ball-shadow.ts'
import { correctTutorialText } from './original-text-corrections.ts'
import { CKCID, originalIsChildClassOf, originalObjectReference, type OriginalContext, type OriginalObject } from './original-context.ts'
import { OriginalContextView, original2dPlacement, original2dViewport, type OriginalViewMaterial, type OriginalViewPrelit } from './original-context-view.ts'
import { ensureOriginalDataArrays, originalDataArray } from './original-data-arrays.ts'
import { SCALE, originalMaterial } from './original-data.ts'
import { loadOriginalTexture } from './original-texture-key.ts'
import { OriginalContextPhysics } from './original-context-physics.ts'
import { OriginalContextPhysicsRapier } from './original-context-physics-rapier.ts'
import { OriginalGraphAudio } from './original-graph-audio.ts'
import { OriginalHostSky } from './original-graph-sky.ts'
import { loadOriginalPackFormats, originalAudioFile, type OriginalAudioFormat } from './original-pack-formats.ts'
import { OriginalFixedFunctionMaterial, OriginalLighting, ORIGINAL_SCENE_AMBIENT } from './original-fixed-function.ts'
import { OriginalPlanarFilter } from './original-planar-filter.ts'
import type { GraphFilterSettings } from './original-graph-bindings.ts'
import type { GraphDisplayMode } from './original-graph-system.ts'
import { IvpWorld } from './ivp-bridge.ts'
import { GameplayBinding } from './original-gameplay-binding.ts'
import { ORIGINAL_ACCEPT_KEY, ORIGINAL_CANCEL_KEY, OriginalGraphKeyState, originalGraphKeyMap, originalGraphPressedButton, originalPadKeys, originalTouchKeys, readOriginalGraphGamepadSettings, type OriginalGraphKeyMap } from './original-graph-input.ts'
import { OriginalInputManager } from './original-input-manager.ts'
import { originalPlayerData } from './original-player.ts'
import { GRAVITY, PHYSICS_STEP } from './original-physics.ts'
import { OriginalParticleRenderer } from './original-particle-system.ts'
import type { OriginalSessionSimulation } from './original-session.ts'
import { createOriginalSession, loadOriginalInstall, originalTutorialDefault, type OriginalInstall } from './original-session-loader.ts'
import { loadSkyTextures } from './original-sky-box.ts'
import { DEFAULT_STEREO_SETTINGS, LEIA_STEREO_MODE, StereoRenderer, computeStereoBufferScale, shellLeiaActive, type StereoSettings } from './stereo-renderer.ts'
import { OriginalGamepad } from '../controls/gamepad.ts'
import type { GamepadInfo, GamepadSettings, GamepadSnapshot } from '../controls/gamepad.ts'
import type { Axes } from '../controls/mobile-input.ts'
import { canvasBox, pointerLayout, stagePointer } from '../ui/original-art.ts'

/** A camera turn's pulsed keys stay down long enough for the authored 250 ms Bezier. */
const TURN_HOLD_MS = 300
let rapierReady: Promise<void> | undefined

export const ORIGINAL_DIK_CODES: Readonly<Record<string, number>> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07,
  Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e,
  Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16,
  KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c,
  ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a,
  Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31,
  KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37,
  AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f,
  F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47,
  Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d,
  NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  IntlBackslash: 0x56, F11: 0x57, F12: 0x58, KanaMode: 0x70, Lang2: 0x71, Lang1: 0x72, IntlRo: 0x73,
  Convert: 0x79, NonConvert: 0x7b, IntlYen: 0x7d, NumpadComma: 0x7e, NumpadEnter: 0x9c,
  ControlRight: 0x9d, NumpadDivide: 0xb5, PrintScreen: 0xb7, AltRight: 0xb8, Pause: 0xc5,
  Home: 0xc7, ArrowUp: 0xc8, PageUp: 0xc9, ArrowLeft: 0xcb, ArrowRight: 0xcd, End: 0xcf,
  ArrowDown: 0xd0, PageDown: 0xd1, Insert: 0xd2, Delete: 0xd3, MetaLeft: 0xdb, MetaRight: 0xdc,
  ContextMenu: 0xdd,
}

export function originalScanCode(code: string): number | undefined {
  return ORIGINAL_DIK_CODES[code]
}

export type OriginalAnalogDirection = 'right' | 'left' | 'backward' | 'forward'

export function originalAnalogSteeringScales(
  pad: Pick<GamepadSnapshot, 'moveX' | 'moveZ'>,
  forceBehavior: Readonly<Partial<Record<OriginalAnalogDirection, number>>>,
  digital: Readonly<Record<OriginalAnalogDirection, boolean>>,
): Map<number, number> {
  const scales = new Map<number, number>()
  const publish = (direction: OriginalAnalogDirection, component: number) => {
    if (component === 0) return
    const behavior = forceBehavior[direction]
    if (behavior === undefined || !Number.isInteger(behavior) || behavior < 0) {
      throw new Error(`Analog steering has no force behavior for ${direction}`)
    }
    scales.set(behavior, digital[direction] ? 1 : Math.min(1, Math.abs(component)))
  }
  if (pad.moveX < 0) publish('left', pad.moveX)
  else if (pad.moveX > 0) publish('right', pad.moveX)
  if (pad.moveZ < 0) publish('forward', pad.moveZ)
  else if (pad.moveZ > 0) publish('backward', pad.moveZ)
  return scales
}

/**
 * The tutorial text file the script loads. The authored name is the install
 * folder plus `Text\Tutorial<language>.txt`; the exported graph does not carry
 * the language pin of its `Create String`, so the name arrives without the
 * language digit. Any `tutorial*.txt` file therefore resolves to the host's
 * selected language text.
 */
export function isTutorialTextFile(name: string): boolean {
  const file = name.split(/[\\/]/).pop() ?? ''
  return /^tutorial\d*\.txt$/i.test(file)
}

/** Map a window pointer to render-context pixels through the session canvas (the 4:3 stage, or the whole window in widescreen). */
export function originalPointerPixels(x: number, y: number, width: number, height: number, mode: string, viewportWidth: number, viewportHeight: number, widescreen: boolean): { x: number; y: number } {
  // Leia SR's page is the pair; fold x into one half and map inside that
  // half's eye frame, exactly like one eye of sbs-full.
  const leia = mode === LEIA_STEREO_MODE
  const frameWidth = leia ? width / 2 : width
  const box = leia ? canvasBox(frameWidth, height, widescreen) : canvasBox(width, height, widescreen)
  const point = stagePointer(x, y, width, height, pointerLayout(mode), box, leia ? frameWidth : undefined)
  return { x: point.u * viewportWidth, y: point.v * viewportHeight }
}

/** The standard 4:3 sizes the original screen-mode list offers, tallest last. */
const ORIGINAL_DISPLAY_SIZES: readonly (readonly [number, number])[] = [
  [640, 480], [800, 600], [1024, 768], [1152, 864], [1280, 960], [1400, 1050], [1440, 1080], [1600, 1200],
]

/**
 * Port-only widescreen sizes, kept after the authored Screen Modes filter
 * (which keeps only 4:3, 16-bit modes no wider than 1600). The selected mode's
 * height is the render scale; in widescreen the canvas is the window, so the
 * 3D background is Hor+ while the 2D art stays in its 4:3 area.
 */
const WIDESCREEN_DISPLAY_SIZES: readonly (readonly [number, number])[] = [
  [1280, 720], [1366, 768], [1280, 800], [1440, 900], [1600, 900], [1680, 1050], [1920, 1080],
  [1920, 1200], [2560, 1440], [2560, 1600], [3440, 1440], [3840, 2160],
]

/**
 * The host driver's modes: each standard 4:3 size the monitor's physical height
 * fits, then the widescreen sizes it can show, each as a 16-bit entry followed
 * by its 32-bit entry (base's menu keeps only the 16-bit ones). Mode ids are
 * indexes into this list.
 */
export function originalDisplayModes(monitorHeight: number, monitorWidth = Number.POSITIVE_INFINITY): GraphDisplayMode[] {
  const sizes = [...ORIGINAL_DISPLAY_SIZES]
  const seen = new Set(sizes.map(([width, height]) => `${width}x${height}`))
  const add = (width: number, height: number) => {
    if (width <= 0 || height <= 0 || height > monitorHeight || width > monitorWidth) return
    const key = `${width}x${height}`
    if (seen.has(key)) return
    seen.add(key)
    sizes.push([width, height])
  }
  for (const [width, height] of WIDESCREEN_DISPLAY_SIZES) add(width, height)
  const modes: GraphDisplayMode[] = []
  for (const [width, height] of sizes) {
    if (height > monitorHeight) continue
    modes.push({ width, height, bpp: 16, refresh: 60 }, { width, height, bpp: 32, refresh: 60 })
  }
  return modes
}

/** `VideoMode`'s HIWORD width and LOWORD height, as the launcher writes it. */
export function originalVideoModeSize(value: number): { width: number; height: number } {
  return { width: (value >>> 16) & 0xffff, height: value & 0xffff }
}

/** The launcher's `VideoMode` DWORD for a size. */
export function originalVideoModeValue(width: number, height: number): number {
  return ((width << 16) | height) >>> 0
}

/**
 * The installed mode id: the 16-bit entry of the launcher's `VideoMode` size.
 * The launcher stores no depth, and base keeps only 16-bit modes. A size this
 * monitor cannot show (taller than it, or not a listed 4:3 size) starts at the
 * largest listed 16-bit mode instead; `VideoMode` itself is left as it is until
 * the player chooses a mode.
 */
export function originalInstalledMode(modes: readonly GraphDisplayMode[], videoMode: number | undefined, widescreen = true): number {
  if (videoMode === undefined) throw new Error('The graph session needs the install VideoMode registry setting; run scripts/export-original-install-files.py')
  const { width, height } = originalVideoModeSize(videoMode)
  const fits = (mode: GraphDisplayMode) => widescreen || mode.width * 3 === mode.height * 4
  const index = modes.findIndex(mode => fits(mode) && mode.width === width && mode.height === height && mode.bpp === 16)
  if (index >= 0) return index
  const largest = modes.findLastIndex(mode => fits(mode) && mode.bpp === 16)
  if (largest < 0) throw new Error(`This monitor is too short for any original screen mode (the smallest is 640x480); VideoMode is ${width}x${height}`)
  return largest
}

/**
 * The render pixel ratio that makes the 4:3 2D area `modeHeight` drawing-buffer
 * pixels tall. Its CSS height is the canvas box height when the box is at least
 * 4:3, otherwise the box width at 4:3; the width follows the window.
 */
export function originalRenderPixelRatio(modeHeight: number, canvasWidth: number, canvasHeight: number): number {
  const areaHeight = canvasWidth / canvasHeight >= 4 / 3 ? canvasHeight : canvasWidth * 3 / 4
  return modeHeight / areaHeight
}

function cp1252(character: string): number {
  if (character.length === 0 || [...character].length !== 1) return 0
  const code = character.codePointAt(0) ?? 0
  if (code < 256) return code
  const table: Record<number, number> = { 0x20ac: 0x80, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99 }
  return table[code] ?? 0
}

export function readDisplaySettings(): { widescreen: boolean } {
  let saved: unknown = null
  try { saved = JSON.parse(localStorage.getItem('ballance-original-display') ?? 'null') } catch { saved = null }
  const widescreen = typeof saved === 'object' && saved !== null ? (saved as { widescreen?: unknown }).widescreen : undefined
  // Widescreen is the default; only a saved `false` keeps the original 4:3 stage.
  return { widescreen: widescreen !== false }
}

export function readStereoSettings(): StereoSettings {
  let saved: Partial<StereoSettings> = {}
  try { saved = JSON.parse(localStorage.getItem('ballance-original-stereo') ?? 'null') as Partial<StereoSettings> ?? {} } catch { saved = {} }
  const modes = ['off', 'sbs', 'crossview', 'sbs-full', 'tab', 'tab-full', LEIA_STEREO_MODE, 'interlaced', 'interlaced-reversed'] as const
  const savedMode = modes.find(item => item === saved.mode) ?? DEFAULT_STEREO_SETTINGS.mode
  // Leia is a launch mode: the offscreen pair always starts in it, and a saved
  // id without the pair (browser or a normal shell window) falls back to the
  // default mode instead of rendering a broken layout.
  const active = shellLeiaActive()
  const mode = active ? LEIA_STEREO_MODE : savedMode === LEIA_STEREO_MODE ? DEFAULT_STEREO_SETTINGS.mode : savedMode
  const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    mode: active || saved.defaultEnabled === true ? mode : 'off',
    separation: number(saved.separation, DEFAULT_STEREO_SETTINGS.separation),
    convergence: number(saved.convergence, DEFAULT_STEREO_SETTINGS.convergence),
    uiDepth: Math.min(100, Math.max(0, number(saved.uiDepth, DEFAULT_STEREO_SETTINGS.uiDepth))),
    defaultEnabled: saved.defaultEnabled === true,
  }
}

class BrowserMovieBinding {
  private readonly install: OriginalInstall
  private readonly movies = new Map<string, OriginalAvi>()
  private readonly textures = new Map<string, THREE.DataTexture>()

  constructor(install: OriginalInstall) {
    this.install = install
  }

  texture(reference: string): THREE.DataTexture | undefined {
    return this.textures.get(reference)
  }

  readonly binding = {
    open: (texture: string, file: string) => {
      const bytes = this.install.readFile(file)
      if (!bytes) return undefined
      const avi = OriginalAvi.parse(bytes)
      const image = new Uint8Array(avi.info.width * avi.info.height * 4)
      const data = new THREE.DataTexture(image, avi.info.width, avi.info.height, THREE.RGBAFormat)
      data.colorSpace = THREE.SRGBColorSpace
      // decodeFrame writes rows top first, like a decoded image file; the mesh
      // UVs expect the same vertical flip as every image texture.
      data.flipY = true
      data.needsUpdate = true
      this.movies.set(texture, avi)
      this.textures.set(texture, data)
      return { frames: avi.info.frames, width: avi.info.width, height: avi.info.height, framePeriodMs: avi.info.framePeriodMs }
    },
    showFrame: (texture: string, frame: number) => {
      const avi = this.movies.get(texture)
      const data = this.textures.get(texture)
      if (!avi || !data) return false
      let pixels: Uint8Array
      try { pixels = avi.decodeFrame(frame) } catch { return false }
      ;(data.image.data as Uint8Array).set(pixels)
      data.needsUpdate = true
      return true
    },
    close: (texture: string) => {
      this.movies.delete(texture)
      this.textures.get(texture)?.dispose()
      this.textures.delete(texture)
    },
  }
}

class BrowserAudio {
  private context?: AudioContext
  private readonly install: OriginalInstall
  private readonly voices = new Map<string, { source: AudioBufferSourceNode; gain: GainNode; panner?: StereoPannerNode }>()
  private readonly buffers = new Map<string, Promise<AudioBuffer | undefined>>()
  /** The play request still waiting for its buffer, per sound; stop() cancels it. */
  private readonly pending = new Map<string, object>()
  private readonly contextOf: () => OriginalContext

  constructor(install: OriginalInstall, context: () => OriginalContext) {
    this.install = install
    this.contextOf = context
  }

  unlock() {
    this.ensureContext()
  }

  private ensureContext(): AudioContext | undefined {
    if (this.context) { void this.context.resume(); return this.context }
    try { this.context = new AudioContext() } catch { return undefined }
    return this.context
  }

  /** A graph target is a `#id` reference (CKBehavior::GetTarget), so resolve it by id; a bare name is looked up by name. */
  private soundObject(name: string) {
    const context = this.contextOf()
    const sound = /^#\d+$/.test(name) ? context.resolve(name) : context.findByClass(name, CKCID.WAVESOUND)
    return sound && originalIsChildClassOf(sound.classId, CKCID.WAVESOUND) ? sound : undefined
  }

  private soundFile(name: string): string | undefined {
    const sound = this.soundObject(name)
    return sound && typeof sound.state.fileName === 'string' ? sound.state.fileName : undefined
  }

  /** The first recorded format the browser decodes; the pack's order is the preference. */
  private packFormat(formats: readonly OriginalAudioFormat[]): OriginalAudioFormat | undefined {
    if (typeof Audio === 'undefined') return formats[0]
    const probe = new Audio()
    return formats.find(format => format === 'wav' ||
      probe.canPlayType(format === 'ogg' ? 'audio/ogg; codecs="vorbis"' : 'audio/mp4') !== '') ?? formats[0]
  }

  /** An install WAV when the installer's files index has it, else the pack's audio file. */
  private async bytes(file: string): Promise<ArrayBuffer | undefined> {
    // CKSound names are bare (ATARI.wav); the install's sound path is Sounds/.
    const install = this.install.readFile(file) ?? (file.includes('/') ? undefined : this.install.readFile(`Sounds/${file}`))
    if (install) return install.slice().buffer
    const formats = await loadOriginalPackFormats()
    const format = this.packFormat(formats.audio)
    if (!format) return undefined
    const response = await fetch(`/original/${originalAudioFile(file, format)}`)
    return response.ok ? response.arrayBuffer() : undefined
  }

  private buffer(file: string): Promise<AudioBuffer | undefined> {
    let pending = this.buffers.get(file)
    if (pending) return pending
    pending = (async () => {
      const context = this.ensureContext()
      const bytes = await this.bytes(file)
      if (!context || !bytes) return undefined
      try { return await context.decodeAudioData(bytes) } catch { return undefined }
    })()
    this.buffers.set(file, pending)
    return pending
  }

  play(name: string, options?: { loop?: boolean; volume?: number }) {
    const file = this.soundFile(name)
    const context = this.ensureContext()
    if (!file || !context) return
    this.stop(name)
    const request = {}
    this.pending.set(name, request)
    void this.buffer(file).then(buffer => {
      // A stop() while the buffer loaded cancels the request, as it would have
      // stopped a voice that was already playing.
      if (this.pending.get(name) !== request) return
      this.pending.delete(name)
      if (!buffer || this.voices.has(name)) return
      const source = context.createBufferSource()
      source.buffer = buffer
      source.loop = options?.loop === true
      const gain = context.createGain()
      const state = this.soundObject(name)?.state ?? {}
      gain.gain.value = Number(state.gain ?? options?.volume ?? 1)
      source.connect(gain)
      const panner = typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : undefined
      const voice = { source, gain, ...(panner ? { panner } : {}) }
      if (panner) {
        panner.pan.value = Number(state.pan ?? 0)
        gain.connect(panner)
        panner.connect(context.destination)
      } else gain.connect(context.destination)
      this.voices.set(name, voice)
      source.onended = () => { if (this.voices.get(name)?.source === source) this.voices.delete(name) }
      source.start()
    }).catch(error => { console.error(error) })
  }

  stop(name: string) {
    this.pending.delete(name)
    const voice = this.voices.get(name)
    if (!voice) return
    this.voices.delete(name)
    try { voice.source.stop() } catch { /* already stopped */ }
    try { voice.gain.disconnect() } catch { /* already disconnected */ }
    try { voice.panner?.disconnect() } catch { /* already disconnected */ }
  }

  gain(name: string, value: number) {
    const voice = this.voices.get(name)
    if (voice) voice.gain.gain.value = value
  }

  pitch(name: string, value: number) {
    const voice = this.voices.get(name)
    if (voice) voice.source.playbackRate.value = value
  }

  pan(name: string, value: number) {
    const voice = this.voices.get(name)
    if (voice?.panner) voice.panner.pan.value = value
  }

  properties(name: string) {
    const sound = this.soundObject(name)
    if (!sound) return undefined
    const state = sound.state
    if (typeof state.gain !== 'number' || typeof state.pitch !== 'number' || typeof state.pan !== 'number') return undefined
    return { gain: state.gain, pitch: state.pitch, pan: state.pan }
  }

  /** `CKWaveSound::IsPlaying`: a decoded voice or a play request still loading its file. */
  playing(name: string): boolean {
    return this.pending.has(name) || this.voices.has(name)
  }

  dispose() {
    for (const name of [...this.voices.keys()]) this.stop(name)
    void this.context?.close()
  }
}

const FALLBACK_MATERIAL: OriginalViewMaterial = {
  id: -1, name: 'Default Mat', texture: -1,
  diffuse: [1, 1, 1, 1], ambient: [0, 0, 0, 1], specular: [0, 0, 0, 1], emissive: [0, 0, 0, 1], specularPower: 0,
  AlphaBlendEnabled: false, AlphaTestEnabled: false, TwoSidedEnabled: false, ZWriteEnabled: true,
  sourceBlend: 2, destBlend: 1, textureBlendMode: 4, textureMinMode: 2, textureMagMode: 2, textureAddressMode: 1,
}

/** VXTEXTURE_ADDRESSMODE (CKMaterial::SetTextureAddressMode): WRAP, MIRROR, CLAMP. */
const TEXTURE_ADDRESS: Readonly<Record<number, THREE.Wrapping>> = {
  1: THREE.RepeatWrapping, 2: THREE.MirroredRepeatWrapping, 3: THREE.ClampToEdgeWrapping,
}

/** VXBLEND_MODE as the custom-blending factor the planar filter's SetState uses. */
const FILTER_BLEND: Readonly<Record<number, THREE.BlendingDstFactor>> = {
  1: THREE.ZeroFactor, 2: THREE.OneFactor, 3: THREE.SrcColorFactor, 4: THREE.OneMinusSrcColorFactor,
  5: THREE.SrcAlphaFactor, 6: THREE.OneMinusSrcAlphaFactor, 7: THREE.DstAlphaFactor,
  8: THREE.OneMinusDstAlphaFactor, 9: THREE.DstColorFactor, 10: THREE.OneMinusDstColorFactor,
}

/** VXTEXTURE_FILTERMODE as Three's minification filter. */
const FILTER_MIN: Readonly<Record<number, THREE.MinificationTextureFilter>> = {
  1: THREE.NearestFilter, 2: THREE.LinearFilter, 3: THREE.NearestMipmapNearestFilter,
  4: THREE.LinearMipmapNearestFilter, 5: THREE.NearestMipmapLinearFilter, 6: THREE.LinearMipmapLinearFilter,
}

/** VXTEXTURE_FILTERMODE as Three's magnification filter (mip modes do not magnify). */
const FILTER_MAG: Readonly<Record<number, THREE.MagnificationTextureFilter>> = {
  1: THREE.NearestFilter, 2: THREE.LinearFilter,
}

/** The planar filter draws after the 2D and HUD quads but under the stereo cursor (100000). */
const FILTER_RENDER_ORDER = 90000

export interface OriginalGraphHostCallbacks {
  onProgress?: (message: string) => void
  onReady?: () => void
  onError?: (error: Error) => void
}

export class OriginalGraphHost {
  private readonly host: HTMLElement
  private readonly callbacks: OriginalGraphHostCallbacks
  private renderer?: THREE.WebGLRenderer
  private stereo?: StereoRenderer
  private view?: OriginalContextView
  private sky?: OriginalHostSky
  private skyTextures: THREE.Texture[] = []
  private gameplayBinding?: GameplayBinding
  private ivp?: IvpWorld
  private particles?: OriginalParticleRenderer
  private lighting?: OriginalLighting
  /** TT Simple Shadow's floor channel and the level Shadow group it was built from. */
  private ballShadow?: OriginalBallShadow
  private shadowSignature?: string
  private shadowTexture?: THREE.Texture
  private audio?: BrowserAudio
  private session?: Awaited<ReturnType<typeof createOriginalSession>>['session']
  private packs?: Awaited<ReturnType<typeof createOriginalSession>>['packs']
  private context?: OriginalContext
  private input?: OriginalInputManager
  private movie?: BrowserMovieBinding
  /** The install's tutorial texts by lower-case file name (`tutorial<n>.txt`). */
  private readonly tutorialTexts = new Map<string, string>()
  /** The session's post-sprite filter list; this host draws it after the 2D layer. */
  readonly planarFilter = new OriginalPlanarFilter()
  private readonly filterMeshes = new Map<string, { mesh: THREE.Mesh; signature: string; material: OriginalFixedFunctionMaterial }>()
  private readonly scene = new THREE.Scene()
  private readonly emptyScene = new THREE.Scene()
  private frame = 0
  private last = 0
  private clock = 0
  private settings = readStereoSettings()
  private display = readDisplaySettings()
  private readonly pointer = { x: 0, y: 0, inside: false }
  private cursor?: THREE.Mesh
  private cursorTexture?: THREE.Texture
  private readonly physicalHeld = new Set<number>()
  /** The DOM Options panels own keyboard/pad input while they are open. */
  private menuInputHeld = false
  /** Pad buttons still held from a DOM panel; they reach the graph only after a release. */
  private padReleaseWait = new Set<'accept' | 'cancel'>()
  private readonly keys = new OriginalGraphKeyState((key, pressed, time) => this.input?.key(key, pressed, time))
  private readonly gamepad = new OriginalGamepad()
  private gamepadSettings = readOriginalGraphGamepadSettings()
  private readonly analogForceScales = new Map<number, number>()
  private analogForceBehavior?: Record<OriginalAnalogDirection, number>
  private keyMap?: OriginalGraphKeyMap
  private cameraStickDirection = 0
  private readonly turnQueue: ('left' | 'right')[] = []
  private turnPulse?: { direction: 'left' | 'right'; started: number; frames: number }
  private pauseFrames = 0
  private touchAxes: Axes = { x: 0, z: 0 }
  private touchView = false
  private backend: 'ivp' | 'rapier' = 'rapier'
  private rapierWorld?: RAPIER.World
  private readonly ascii = new Map<number, number>()
  private readonly lights = new Map<number, THREE.DirectionalLight | THREE.PointLight>()
  private readonly lightTargets = new Map<number, THREE.Object3D>()
  private readonly particleTextures = new Map<string, THREE.Texture>()
  private readonly loadedTextures = new Map<string, THREE.Texture>()
  /** Texture variants by `file|address mode`, because CK sampler state is per material while a Three map is per texture. */
  private readonly sampledTextures = new Map<string, THREE.Texture>()
  private flameTexture?: THREE.Texture
  private cursorShown = true
  private resizeObserver?: ResizeObserver
  private system?: ReturnType<OriginalGraphHost['systemBinding']>
  private failed = false
  private disposed = false

  constructor(host: HTMLElement, callbacks: OriginalGraphHostCallbacks = {}) {
    this.host = host
    this.callbacks = callbacks
  }

  get stereoSettings(): StereoSettings { return this.settings }

  /** Read-only: whether the canvas fills the window (widescreen) instead of the centered 4:3 stage. */
  get widescreen(): boolean { return this.display.widescreen }

  setStereo(settings: StereoSettings) {
    const previousMode = this.settings.mode
    const previous = computeStereoBufferScale(previousMode)
    this.settings = settings
    this.stereo?.setSettings(settings)
    // Full layouts pack two eye frames into a doubled drawing buffer. Only a
    // packing change needs the renderer resized; separation, convergence and
    // UI Depth changes leave the buffers alone (and interlaced's DPR rule).
    // Leia SR also sizes the canvas from the whole pair even though its
    // packing is 1:1, so any transition into or out of it resizes too.
    const packing = computeStereoBufferScale(settings.mode)
    if (packing.width !== previous.width || packing.height !== previous.height
      || previousMode === LEIA_STEREO_MODE || settings.mode === LEIA_STEREO_MODE) this.resize()
  }

  setWidescreen(on: boolean) {
    this.display = { widescreen: on }
    try { localStorage.setItem('ballance-original-display', JSON.stringify(this.display)) } catch { /* storage may be unavailable */ }
    this.patchScreenModes()
    this.resize()
  }

  /**
   * Base's Screen Modes script filters the host list to 4:3, 16-bit modes no
   * wider than 1600. Once it has run, extend the menu's ScreenModes array with
   * the host's widescreen entries (they are port modes, so they sit after the
   * authored filter instead of changing it). Widescreen fills the canvas; the
   * selected mode's height still sets the render scale.
   */
  private patchScreenModes() {
    if (!this.display.widescreen) return
    const rows = this.gameplayBinding?.array('ScreenModes')
    const modes = this.system?.displayDrivers()[0]?.modes
    if (!rows?.length || !modes) return
    const widescreen = new Set<number>()
    for (let index = 0; index < modes.length; index++) {
      const mode = modes[index]!
      if (mode.bpp === 16 && mode.width * 3 !== mode.height * 4) widescreen.add(index)
    }
    if (rows.some(row => widescreen.has(Number(row[0])))) {
      this.extendGraphicsModeCounter(rows.length)
      return
    }
    // The authored filters have finished when every row is a 16-bit 4:3 mode.
    if (!rows.every(row => row.length === 4 && Number(row[3]) === 16 && Number(row[1]) * 3 === Number(row[2]) * 4)) return
    for (const index of widescreen) {
      const mode = modes[index]!
      rows.push([index, mode.width, mode.height, mode.bpp])
    }
    this.extendGraphicsModeCounter(rows.length)
  }

  /**
   * The authored Graphics resolution counter (the TT_Counter in Menu's
   * Resolution script) has an inclusive maximum of 9: ten rows from the
   * original driver list. The port appended widescreen rows; raise that
   * maximum (the local feeding the counter's third input) to the live row
   * count so they are selectable.
   */
  private extendGraphicsModeCounter(count: number) {
    const menu = this.session?.runtime('Menu')
    if (!menu || count <= 0) return
    const nodes = Object.values(menu.data.nodes)
    const resolution = nodes.find(node => node.name === 'Resolution')
    const counter = nodes.find(node => node.name === 'TT_Counter' && resolution?.children?.includes(node.index))
    const max = counter?.inputs?.[2]?.source
    if (max === undefined || typeof menu.value(max) !== 'number') throw new Error('Menu Resolution TT_Counter maximum not found; cannot list the appended screen modes')
    if (menu.value(max) !== count - 1) menu.setValue(max, count - 1)
  }

  /**
   * The install's language as base reads it (TT_ReadRegistry 709,
   * `Software\Ballance\Settings\` `Language`): the language table's column
   * after `description` (0 German, 1 English, 2 Spanish, 3 Italian, 4 French).
   * Undefined until the session has its system binding.
   */
  language(): number | undefined {
    return this.system?.registryDword('Software\\Ballance\\Settings\\', 'Language')
  }

  /** Read-only: whether the authored Options screen is up. */
  isMenuOptionsActive(): boolean {
    return this.session?.runtime('Menu')?.isScriptActive('Menu_Options') ?? false
  }

  /** The physics engine in use: IVP (the original's), or Rapier when the IVP module is unavailable (approximate). */
  get physicsBackend(): 'ivp' | 'rapier' { return this.backend }

  /** Read-only: whether the authored main menu is up. */
  isMenuMainActive(): boolean {
    return this.session?.runtime('Menu')?.isScriptActive('Menu_Main') ?? false
  }

  /** Read-only: whether the authored Graphics screen is up. */
  isMenuGraphicsActive(): boolean {
    return this.session?.runtime('Menu')?.isScriptActive('Menu_Opt_Graphics') ?? false
  }

  /**
   * Hide the authored Options screen through its own `Exit` compound
   * (Menu_Options 10658: Iterator 10633, Hide 10639, Deactivate Script 10644,
   * Hide title 10651) while a DOM Extras panel takes over.
   */
  openExtraPanel(): boolean {
    const runtime = this.session?.runtime('Menu')
    if (!runtime || !(runtime.isScriptActive('Menu_Options') ?? false) || this.menuInputHeld) return false
    if (runtime.data.nodes['10658']?.name !== 'Exit') throw new Error('Menu_Options Exit node 10658 is not in the Menu graph')
    this.setMenuInputHold(true)
    runtime.activateNow(10658)
    return true
  }

  /**
   * Return from a DOM Extras panel through the authored path the Options
   * sub-screens use (Menu_Opt_Keys' Exit 13908, Activate Script 13883:
   * `Menu_Options`, reset true).
   */
  closeExtraPanel(): void {
    const runtime = this.session?.runtime('Menu')
    if (!runtime) throw new Error('The graph session has no Menu document')
    if (runtime.data.nodes['13883']?.name !== 'Activate Script') throw new Error('Menu_Opt_Keys Activate Script node 13883 is not in the Menu graph')
    this.setMenuInputHold(false)
    runtime.runIsolated(13883)
  }

  /** Hold the authored menu input while a DOM panel owns the keyboard and pad. */
  setMenuInputHold(held: boolean) {
    if (this.menuInputHeld === held) return
    this.menuInputHeld = held
    if (!held) {
      // The press that closed a panel must not also act on the menu behind it.
      const pressed = this.gamepad.snapshot.pressed
      this.padReleaseWait = new Set((['accept', 'cancel'] as const).filter(action => pressed.has(action)))
      return
    }
    this.physicalHeld.clear()
    this.touchAxes = { x: 0, z: 0 }
    this.touchView = false
    this.turnQueue.length = 0
    this.turnPulse = undefined
    this.pauseFrames = 0
    this.cameraStickDirection = 0
    this.keys.setSources({ keyboard: [], gamepad: [], touch: [], turn: [], pause: [] })
  }

  getGamepadSnapshot(): GamepadSnapshot { return this.gamepad.snapshot }

  getGamepadInfo(): GamepadInfo { return this.gamepad.info }

  /** The raw button first pressed this poll, for the Controller binding flow. */
  gamepadBindingPress(): number | undefined { return originalGraphPressedButton(this.gamepad.snapshot) }

  setGamepadSettings(settings: GamepadSettings) {
    this.gamepadSettings = { ...settings, analogSteering: settings.analogSteering === true }
    this.gamepad.setSettings(this.gamepadSettings)
  }

  /** Re-read `ballance-original-gamepad` when the Controller panel opens. */
  reloadGamepadSettings() {
    this.setGamepadSettings(readOriginalGraphGamepadSettings())
  }

  playMenuSound(name = 'Menu_click') {
    this.audio?.unlock()
    this.audio?.play(name)
  }

  async start() {
    try {
      await this.load()
      if (this.disposed) return
      this.callbacks.onReady?.()
      this.frame = requestAnimationFrame(this.loop)
    } catch (error) {
      this.fail(error)
    }
  }

  private fail(error: unknown) {
    if (this.failed) return
    this.failed = true
    cancelAnimationFrame(this.frame)
    const message = error instanceof Error ? error.message : String(error)
    console.error(error)
    this.callbacks.onError?.(error instanceof Error ? error : new Error(message))
  }

  private async load() {
    this.callbacks.onProgress?.('Loading original files')
    const install = await loadOriginalInstall()
    if (this.disposed) { this.dispose(); return }
    await ensureOriginalDataArrays()
    if (this.disposed) { this.dispose(); return }
    await this.loadTutorialTexts()
    if (this.disposed) { this.dispose(); return }
    this.callbacks.onProgress?.('Loading menu scene')
    const allLevel = originalDataArray('AllLevel')
    const skyColumn = allLevel?.columns.findIndex(column => column.name === 'Sky') ?? 3
    // Every level's sky set is small (five images); load them all so the gameplay
    // TT Sky (Sky_*) and the menu's (MSky_*) can resolve their face materials.
    const menuLetter = String(allLevel?.rows[4]?.[skyColumn] ?? 'Sky_C').slice(4)
    const letters = [...new Set([
      menuLetter,
      ...(allLevel?.rows ?? []).map(row => String(row[skyColumn] ?? '')).filter(value => value.length > 4).map(value => value.slice(4)),
    ])]
    const skySets = new Map<string, Map<string, THREE.Texture>>()
    await Promise.all(letters.map(async letter => {
      skySets.set(letter, await loadSkyTextures(letter, 'MSky'))
    }))
    if (this.disposed) { this.dispose(); return }
    for (const set of skySets.values()) this.skyTextures.push(...set.values())
    const menuSky = skySets.get(menuLetter) ?? skySets.get('C')!
    this.sky = new OriginalHostSky({
      menu: menuSky,
      level: () => {
        const row = Number(this.gameplayBinding?.array('CurrentLevel')?.[0]?.[0] ?? 1)
        const letter = String(allLevel?.rows[row - 1]?.[skyColumn] ?? 'Sky_L').slice(4)
        return skySets.get(letter) ?? menuSky
      },
    })
    const flame = await new THREE.TextureLoader().loadAsync('/original/textures/Particle_Flames.png')
    if (this.disposed) { this.dispose(); return }
    flame.colorSpace = THREE.SRGBColorSpace
    this.flameTexture = flame
    this.particleTextures.set('I_Particle_Flames', flame)
    this.particleTextures.set('Particle_Flames', flame)
    // Particle positions and sizes are authored in original units; the group
    // converts them to render space like the level root.
    this.particles = new OriginalParticleRenderer(this.particleTextures, SCALE)
    this.lighting = new OriginalLighting(1)
    this.movie = new BrowserMovieBinding(install)
    this.input = new OriginalInputManager(dik => this.ascii.get(dik) ?? 0)
    const audio = new BrowserAudio(install, () => this.context!)
    this.audio = audio
    const system = this.systemBinding(install)
    this.system = system
    const simulation = await this.createSimulation()
    if (this.disposed) { this.dispose(); return }
    const session = await createOriginalSession({
      install, system, movie: this.movie.binding, input: this.input, particles: this.particles,
      binding: context => this.createBinding(context),
      simulation,
      filter: this.planarFilter,
      play: true,
    })
    if (this.disposed) { this.dispose(); return }
    this.context = session.context
    this.session = session.session
    this.packs = session.packs
    this.gamepad.setSettings(this.gamepadSettings)
    if (!this.gameplayBinding) throw new Error('The graph session did not create its Gameplay binding')
    this.keyMap = originalGraphKeyMap(this.gameplayBinding.array('Keyboard'))
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')) {
      (window as unknown as { __originalGraph?: unknown }).__originalGraph = {
        context: this.context, session: this.session, host: this, input: this.input,
      }
    }
    this.syncParticleTextures()
    this.callbacks.onProgress?.('Loading textures')
    const textureKeys = new Map<string, number | null>()
    for (const pack of session.packs.values()) for (const texture of pack?.textures ?? []) {
      if (texture.transparent === true && typeof texture.transparentColor !== 'number') throw new Error(`Texture ${texture.file} is transparent without an exported colour key; regenerate the local pack`)
      const key = texture.transparent === true ? texture.transparentColor! : null
      if (textureKeys.has(texture.file) && textureKeys.get(texture.file) !== key) throw new Error(`Texture ${texture.file} maps to conflicting colour keys`)
      textureKeys.set(texture.file, key)
    }
    const textureFiles = [...new Set([...session.textureFiles, 'textures/Cursor.png', 'textures/Wolken_intro.png', 'textures/Gravitylogo_intro.png'])]
    const textures = new Map<string, THREE.Texture>()
    await Promise.all(textureFiles.map(async file => {
      try {
        const texture = await loadOriginalTexture(file, textureKeys.get(file) ?? undefined)
        texture.colorSpace = THREE.SRGBColorSpace
        textures.set(file, texture)
      } catch { /* a missing intro texture is reported when it is drawn */ }
    }))
    if (this.disposed) { this.dispose(); return }
    for (const [file, texture] of textures) this.loadedTextures.set(file, texture)
    this.shadowTexture = textures.get('textures/HardShadow.png')
    this.cursorTexture = textures.get('textures/Cursor.png')
    this.createRenderer()
    this.renderer!.domElement.dataset.physicsBackend = this.backend
    if (this.disposed) { this.dispose(); return }
    this.view = new OriginalContextView(session.context, {
      pack: document => session.packs.get(document.toLowerCase()),
      material: (description, file, prelit) => this.createMaterial(description, file, prelit, textures),
      fallbackMaterial: material => this.fallbackMaterial(material),
      hostTexture: texture => texture.name === 'Movie_dummy' ? this.movie?.texture(originalObjectReference(texture.id)) ?? null
        : textures.get(`textures/${texture.name}.png`) ?? null,
    })
    this.scene.add(this.view.root)
    this.scene.add(this.particles.group)
    this.createCursor()
    this.syncLights()
    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.host)
    window.addEventListener('resize', this.resize)
    window.addEventListener('pointermove', this.pointerMove)
    window.addEventListener('pointerdown', this.pointerDown)
    window.addEventListener('pointerup', this.pointerUp)
    window.addEventListener('keydown', this.keyDown)
    window.addEventListener('keyup', this.keyUp)
    window.addEventListener('contextmenu', this.contextMenu)
    this.renderer!.domElement.addEventListener('pointerdown', () => { audio.unlock() })
    this.callbacks.onProgress?.('Starting')
  }

  /**
   * IVP when its module is configured and loads, otherwise the engine's Rapier
   * fallback (world, gravity and timestep as the harness graph runtime builds
   * it). `?solver=rapier` forces it and `?solver=ivp` refuses to fall back.
   */
  private async createSimulation(): Promise<(context: OriginalContext) => OriginalSessionSimulation> {
    const requested = new URLSearchParams(window.location.search).get('solver')
    if (requested !== null && requested !== 'ivp' && requested !== 'rapier') {
      throw new Error(`Unknown solver ${requested}; expected ivp or rapier`)
    }
    let simulation: ((context: OriginalContext) => OriginalSessionSimulation) | undefined
    if (requested !== 'rapier') {
      const url = import.meta.env.VITE_IVP_MODULE_URL
      if (!url) {
        if (requested === 'ivp') throw new Error('The IVP solver was requested but VITE_IVP_MODULE_URL is unset')
        console.warn('Original graph physics: VITE_IVP_MODULE_URL is unset; using Rapier')
      } else {
        try {
          const { default: createIvp } = await import(/* @vite-ignore */ url)
          const ivp = new IvpWorld(await createIvp())
          this.ivp = ivp
          this.backend = 'ivp'
          simulation = context => this.withAnalogSteering(new OriginalContextPhysics(context, ivp))
        } catch (error) {
          if (requested === 'ivp') throw error
          console.warn('Original graph physics: the IVP module failed to load; using Rapier', error)
        }
      }
    }
    if (!simulation) {
      await (rapierReady ??= RAPIER.init())
      const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 })
      world.timestep = PHYSICS_STEP
      this.rapierWorld = world
      this.backend = 'rapier'
      simulation = context => this.withAnalogSteering(new OriginalContextPhysicsRapier(context, world))
    }
    console.info(`Original graph physics backend: ${this.backend === 'ivp' ? 'IVP' : 'Rapier'}`)
    return simulation
  }

  private withAnalogSteering(simulation: OriginalSessionSimulation): OriginalSessionSimulation {
    simulation.binding.forceScale = behavior => this.analogForceScales.get(behavior)
    return simulation
  }

  private createBinding(context: OriginalContext): GameplayBinding {
    let binding: GameplayBinding | undefined
    binding = new GameplayBinding({
      level: 1,
      object: () => undefined,
      light: {
        setColor: (name, color) => {
          const light = context.resolve(name)
          if (!light?.light) throw new Error(`Set Light Color on ${name}, which is not a context light`)
          light.light.color = [color[0], color[1], color[2], color[3]]
        },
      },
      scrollTexture: (name, vector, channel) => {
        const entity = context.resolve(name)
        const mesh = entity && (originalIsChildClassOf(entity.classId, CKCID.MESH) ? entity : context.currentMesh(entity.id))
        if (!mesh?.geometry || mesh.geometry.uvs.length < 2) throw new Error(`Texture Scroller on ${name} (${entity?.name ?? name}), which has no mesh UVs`)
        const uvs = [...mesh.geometry.uvs]
        const du = vector[0] - Math.trunc(uvs[0]!)
        const dv = vector[1] - Math.trunc(uvs[1]!)
        for (let i = 0; i < uvs.length; i += 2) { uvs[i] = uvs[i]! + du; uvs[i + 1] = uvs[i + 1]! + dv }
        mesh.geometry = { ...mesh.geometry, uvs }
        mesh.state.uvRevision = Number(mesh.state.uvRevision ?? 0) + (channel === -1 ? 1 : 0)
      },
      sky: this.sky!.binding,
      activeBall: () => {
        // During the GameplayBinding constructor there is no binding yet; the
        // authored initial level uses Ball_Wood. Later, Levelinit rewrites
        // CurrentLevel column 1 when the level creates its active ball.
        const value = binding?.array('CurrentLevel')?.[0]?.[1]
        const name = typeof value === 'string' ? context.resolve(value)?.name ?? value : undefined
        return name ?? 'Ball_Wood'
      },
      audio: new OriginalGraphAudio(this.audio!),
    }, {
      tutorial: originalTutorialDefault(),
      invertRotation: false,
      loadString: name => {
        if (!isTutorialTextFile(name)) throw new Error(`Load String ${name} is not a tutorial text the host preloads`)
        // A file the install lacks takes Load String's File Error output.
        return this.tutorialTexts.get(name.split(/[\\/]/).pop()!.toLowerCase())
      },
    })
    this.gameplayBinding = binding
    return binding
  }

  /**
   * Gameplay's `load Tutorialtext` asks for `Text\Tutorial<Language>.txt`, where
   * Language is base's registry value plus one (`Set Language`, Op 738). The
   * language table's columns after `description` are those languages, so each
   * numbered text the install has is preloaded for the synchronous Load String.
   */
  private async loadTutorialTexts() {
    const languages = originalDataArray('language')
    if (!languages) throw new Error('The graph session needs the exported language Data Array; regenerate the local pack')
    for (let language = 1; language < languages.columns.length; language++) {
      const url = `/original/text/tutorial${language}.txt`
      const response = await fetch(url)
      if (response.status === 404) continue
      if (!response.ok) throw new Error(`Tutorial text ${url} failed to load (${response.status})`)
      const file = `tutorial${language}.txt`
      this.tutorialTexts.set(file, correctTutorialText(file, new TextDecoder('windows-1252').decode(await response.arrayBuffer()).replace(/\r\n/g, '\n')))
    }
  }

  private systemBinding(install: OriginalInstall) {
    const input = this.input!
    const written = new Map<string, Uint8Array>()
    const key = (path: string) => path.split('\\').join('/').replace(/^\.\.\//, '')
    const registryDword = (section: string, name: string) => {
      try {
        const value = localStorage.getItem(`ballance-graph-registry-${section}-${name}`)
        if (value !== null) return Number(value)
      } catch { /* storage may be unavailable */ }
      const value = /ballance.settings/i.test(section) ? install.registry(name) : undefined
      return typeof value === 'number' ? value : undefined
    }
    const registryString = (section: string, name: string) => {
      try {
        const value = localStorage.getItem(`ballance-graph-registry-${section}-${name}`)
        if (value !== null) return value
      } catch { /* storage may be unavailable */ }
      const value = /ballance.settings/i.test(section) ? install.registry(name) : undefined
      return typeof value === 'string' ? value : undefined
    }
    // Offscreen windows (the Leia pair) report no screen; their own height is
    // the panel height the authored 4:3 mode list must fit.
    const monitorWidth = Math.round(window.screen.width * window.devicePixelRatio) || Math.round(window.innerWidth)
    const monitorHeight = Math.round(window.screen.height * window.devicePixelRatio) || Math.round(window.innerHeight)
    const modes = originalDisplayModes(monitorHeight, monitorWidth)
    const drivers = [{
      description: 'Direct3D HAL', name: 'Direct3D HAL', ready: true,
      modes, videoMemoryBytes: 64 * 2 ** 20,
    }]
    let installed = { driver: 0, mode: originalInstalledMode(modes, registryDword('Software\\Ballance\\Settings\\', 'VideoMode'), this.display.widescreen) }
    return {
      input,
      playerActive: () => true,
      registryDword,
      registryString,
      environment: () => undefined,
      currentDirectory: () => 'C:/games/ballance/Bin',
      osVersion: () => ({ platformId: 2, major: 5, minor: 1 }),
      memoryStatus: () => ({ loadPercent: 30, totalPhysical: 512 * 2 ** 20, availablePhysical: 256 * 2 ** 20, totalVirtual: 2047 * 2 ** 20, availableVirtual: 1900 * 2 ** 20 }),
      displayDrivers: () => drivers,
      get installed() { return installed },
      changeScreenMode: (driver: number, mode: number) => {
        const selected = drivers[driver]?.modes[mode]
        if (!selected) throw new Error(`The host has no display mode ${driver}/${mode}`)
        installed = { driver, mode }
        // The player's Graphics choice also sizes the desktop window; base's startup probe does not.
        if (this.isMenuGraphicsActive()) void window.ballanceShell?.setScreenMode?.(selected.width, selected.height)
        // Only the player's choice (Menu_Opt_Graphics' Update Settings) is remembered; base's startup
        // probe (640, then back to the installed mode) must not overwrite VideoMode.
        if (this.isMenuGraphicsActive()) {
          try {
            localStorage.setItem(`ballance-graph-registry-Software\\Ballance\\Settings\\-VideoMode`, String(originalVideoModeValue(selected.width, selected.height)))
          } catch { /* storage may be unavailable */ }
        }
        this.resize()
        return true
      },
      exit: () => {
        // The desktop app quits like the original; the browser has no system to exit to.
        const quit = window.ballanceShell?.quit
        if (!quit) throw new Error('TT Exit to System')
        void quit()
      },
      showCursor: (show: boolean) => { this.cursorShown = show; this.input?.showCursor(show) },
      mouse: () => {
        const [x, y] = input.mousePosition()
        return { x, y, wheel: 0, left: input.mouseButtonDown(0), right: input.mouseButtonDown(1), middle: input.mouseButtonDown(2) }
      },
      debug: false,
      console: (message: string, beep: boolean) => { void beep; console.log(message) },
      enableProfiling: () => {},
      profileStats: () => ({ frameMs: 15, times: [], behavior: [], render: [] }),
      textures: () => [],
      physicsProfileCount: () => 0,
      readFile: (path: string) => {
        const file = key(path)
        const stored = written.get(file)
        if (stored) return stored
        try {
          const value = localStorage.getItem(`ballance-graph-file-${file}`)
          if (value !== null) return Uint8Array.from(atob(value), character => character.charCodeAt(0))
        } catch { /* storage may be unavailable */ }
        return install.readFile(file)
      },
      writeFile: (path: string, bytes: Uint8Array) => {
        const file = key(path)
        written.set(file, bytes)
        try { localStorage.setItem(`ballance-graph-file-${file}`, btoa(String.fromCharCode(...bytes))) } catch { /* storage may be unavailable */ }
        return true
      },
      paths: () => [],
      renamePath: () => {},
    }
  }

  private createMaterial(description: OriginalViewMaterial, file: string | null, prelit: OriginalViewPrelit | null, textures: ReadonlyMap<string, THREE.Texture>): THREE.Material {
    const map = file === null ? null : file.startsWith('host:') ? this.view?.hostTexture(file) ?? null : textures.get(file) ?? null
    if (file !== null && !map) throw new Error(`Texture ${file} is not loaded`)
    const sampled = map === null ? null : this.sampledTexture(file!, map, description.textureAddressMode)
    const material = originalMaterial(description, sampled, file ?? undefined, this.lighting!)
    if (prelit) {
      const color = new THREE.Vector4(prelit.color[0] / 255, prelit.color[1] / 255, prelit.color[2] / 255, prelit.color[3] / 255)
      const specular = new THREE.Color(prelit.specular[0] / 255, prelit.specular[1] / 255, prelit.specular[2] / 255)
      material.prelit = { color, specular }
    }
    return material
  }

  /**
   * The texture as the material's `SetTextureAddressMode` samples it (WRAP
   * when the export has no mode, the CKMaterial default). A texture is shared
   * by every material that links it, but the address mode is material state,
   * so a different mode gets its own variant instead of changing the shared
   * texture (Button01_special is used both WRAP and CLAMP in camera/menu).
   */
  private sampledTexture(file: string, texture: THREE.Texture, address: number | undefined): THREE.Texture {
    const mode = address ?? 1
    const wrap = TEXTURE_ADDRESS[mode]
    if (wrap === undefined) throw new Error(`Material texture address mode ${mode} is not implemented`)
    if (texture.wrapS === wrap && texture.wrapT === wrap) return texture
    // A host texture is a movie's live DataTexture with one material: set it in
    // place, because a clone would share the source but not the upload version.
    if (file.startsWith('host:')) { texture.wrapS = texture.wrapT = wrap; texture.needsUpdate = true; return texture }
    const key = `${file}|${mode}`
    let variant = this.sampledTextures.get(key)
    if (!variant) {
      variant = texture.clone()
      variant.wrapS = variant.wrapT = wrap
      variant.needsUpdate = true
      this.sampledTextures.set(key, variant)
    }
    return variant
  }

  private fallbackMaterial(material: OriginalObject): OriginalViewMaterial {
    const saved = material.material
    const description: OriginalViewMaterial = {
      ...FALLBACK_MATERIAL,
      AlphaBlendEnabled: true, sourceBlend: 5, destBlend: 6, ZWriteEnabled: false,
      ...(saved ? { diffuse: saved.diffuse, ambient: saved.ambient, specular: saved.specular, emissive: saved.emissive, specularPower: saved.specularPower } : {}),
    }
    const context = this.context!
    const textureName = material.name === 'Atari-Movie' ? 'Movie_dummy'
      : material.name === 'Wolken' ? 'Wolken_intro'
      : material.name === 'Logo' ? 'Gravitylogo_intro' : undefined
    const texture = textureName ? context.findByClass(textureName, CKCID.TEXTURE) : undefined
    if (texture) description.texture = texture.id
    return description
  }

  private createRenderer() {
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x000000, 1)
    renderer.domElement.style.position = 'absolute'
    this.host.append(renderer.domElement)
    this.renderer = renderer
    this.stereo = new StereoRenderer(renderer)
    this.stereo.setSettings(this.settings)
  }

  private createCursor() {
    if (!this.cursorTexture || !this.view) return
    const material = new THREE.MeshBasicMaterial({ map: this.cursorTexture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
    mesh.name = 'Original Cursor'
    mesh.frustumCulled = false
    mesh.renderOrder = 100000
    this.view.overlay.add(mesh)
    this.cursor = mesh
  }

  private resize = () => {
    if (!this.renderer || !this.context) return
    // Leia SR's page CSS box is the whole eye pair: the canvas fills the
    // window, the drawing buffer equals it (no doubling) and every 2D/HUD
    // measure is taken for one half, exactly like one eye frame of sbs-full.
    const leia = this.settings.mode === LEIA_STEREO_MODE
    const box = leia
      ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      : canvasBox(window.innerWidth, window.innerHeight, this.display.widescreen)
    const canvas = this.renderer.domElement
    canvas.style.left = `${box.left}px`
    canvas.style.top = `${box.top}px`
    canvas.style.width = `${box.width}px`
    canvas.style.height = `${box.height}px`
    const system = this.system
    if (!system) throw new Error('The graph host has no system binding for its screen mode')
    const mode = system.displayDrivers()[system.installed.driver]?.modes[system.installed.mode]
    if (!mode) throw new Error(`The installed screen mode ${system.installed.driver}/${system.installed.mode} is not in the display driver list`)
    const devicePixelRatio = window.devicePixelRatio || 1
    // Leia renders both halves at the window's full resolution; the shell
    // forces device scale 1, so this hands the presenter an exact pair.
    const ratio = leia ? devicePixelRatio : originalRenderPixelRatio(mode.height, box.width, box.height)
    // The screen mode sizes one eye frame; full stereo layouts pack two frames
    // into a doubled drawing buffer while the CSS display box stays mono-sized.
    const packing = computeStereoBufferScale(this.settings.mode)
    this.renderer.setPixelRatio(ratio)
    if (leia) this.renderer.setSize(box.width, box.height, false)
    else this.renderer.setSize(box.width * packing.width, box.height * packing.height, false)
    const drawingBuffer = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    const buffer = leia
      ? { width: Math.max(1, Math.floor(drawingBuffer.x / 2)), height: Math.max(1, Math.floor(drawingBuffer.y)) }
      : {
        width: Math.max(1, Math.floor(drawingBuffer.x / packing.width)),
        height: Math.max(1, Math.floor(drawingBuffer.y / packing.height)),
      }
    this.context.render.canvas = buffer
    this.context.render.viewport = leia || this.display.widescreen ? original2dViewport(buffer) : { ...buffer }
    this.stereo?.setBudgetScale(ratio, ratio, devicePixelRatio)
  }

  private pointerMove = (event: PointerEvent) => {
    if (this.menuInputHeld) return
    this.pointer.inside = event.clientX >= 0 && event.clientY >= 0 && event.clientX <= window.innerWidth && event.clientY <= window.innerHeight
    this.updatePointer(event.clientX, event.clientY)
  }

  private updatePointer(clientX: number, clientY: number) {
    if (!this.context || !this.input) return
    const viewport = this.context.render.viewport
    if (!viewport) return
    const canvas = this.context.render.canvas ?? viewport
    const point = originalPointerPixels(clientX, clientY, window.innerWidth, window.innerHeight, this.settings.mode, canvas.width, canvas.height, this.display.widescreen)
    this.pointer.x = point.x
    this.pointer.y = point.y
    const placement = original2dPlacement(canvas, viewport)
    this.input.move(point.x - placement.x, point.y - placement.y)
  }

  private pointerDown = (event: PointerEvent) => {
    if (event.button > 2 || this.menuInputHeld) return
    this.updatePointer(event.clientX, event.clientY)
    this.input?.button(event.button === 1 ? 2 : event.button === 2 ? 1 : 0, true)
  }

  private pointerUp = (event: PointerEvent) => {
    if (event.button > 2 || this.menuInputHeld) return
    this.input?.button(event.button === 1 ? 2 : event.button === 2 ? 1 : 0, false)
  }

  private contextMenu = (event: Event) => event.preventDefault()

  private keyDown = (event: KeyboardEvent) => {
    if (this.menuInputHeld) return
    const dik = originalScanCode(event.code)
    if (dik === undefined) return
    if (event.repeat) { event.preventDefault(); return }
    this.updateAscii(dik, event.key)
    this.physicalHeld.add(dik)
    this.keys.setSource('keyboard', this.physicalHeld)
    this.audio?.unlock()
    event.preventDefault()
  }

  private keyUp = (event: KeyboardEvent) => {
    const dik = originalScanCode(event.code)
    if (dik === undefined) return
    if (this.menuInputHeld) { this.physicalHeld.delete(dik); return }
    this.physicalHeld.delete(dik)
    this.keys.setSource('keyboard', this.physicalHeld)
    event.preventDefault()
  }

  private updateAscii(dik: number, key: string) {
    const value = cp1252(key)
    if (value === 0) this.ascii.delete(dik)
    else this.ascii.set(dik, value)
  }

  /** The touch overlay's steering axes (`MobileControls.onInput`). */
  setTouchAxes(axes: Axes) {
    this.touchAxes = { x: axes.x, z: axes.z }
    this.syncTouchSource()
  }

  /** The touch overlay's view button (`MobileControls.onView`). */
  setTouchView(held: boolean) {
    this.touchView = held
    this.syncTouchSource()
  }

  /** One discrete camera turn (`MobileControls.onRotate`, a pad camera button). */
  rotateCamera(direction: 'left' | 'right') {
    if (this.menuInputHeld) return
    this.turnQueue.push(direction)
  }

  private syncTouchSource() {
    const map = this.keyMap
    this.keys.setSource('touch', map && !this.menuInputHeld ? originalTouchKeys(this.touchAxes, this.touchView, map) : [])
  }

  /**
   * One host frame of pad input, plus the frame-scheduled turn and pause
   * pulses, as key edges on the authored DIK codes. The Keyboard Data Array is
   * re-read every frame so an authored Options rebinding also applies here.
   */
  private pollInput() {
    this.keys.setTime(this.clock)
    if (this.gameplayBinding) this.keyMap = originalGraphKeyMap(this.gameplayBinding.array('Keyboard'))
    const map = this.keyMap
    const controller = this.gamepad.poll()
    this.analogForceScales.clear()
    if (this.menuInputHeld) {
      this.keys.setSources({ keyboard: [], gamepad: [], touch: [], turn: [], pause: [] })
      return
    }
    for (const action of [...this.padReleaseWait]) if (!controller.pressed.has(action)) this.padReleaseWait.delete(action)
    const pad = map && controller.connected ? originalPadKeys(controller, map) : new Set<number>()
    if (this.padReleaseWait.has('accept')) pad.delete(ORIGINAL_ACCEPT_KEY)
    if (this.padReleaseWait.has('cancel')) pad.delete(ORIGINAL_CANCEL_KEY)
    this.publishAnalogSteering(controller, map)
    if (map && controller.connected) {
      if (controller.justPressed.has('pause')) this.pauseFrames = 1
      if (controller.justPressed.has('cameraLeft')) this.rotateCamera('left')
      if (controller.justPressed.has('cameraRight')) this.rotateCamera('right')
      const direction = this.gamepadSettings.cameraStick
        ? controller.cameraX < -0.65 ? -1 : controller.cameraX > 0.65 ? 1 : 0
        : 0
      if (!direction) this.cameraStickDirection = 0
      else if (direction !== this.cameraStickDirection) {
        this.cameraStickDirection = direction
        this.rotateCamera(direction < 0 ? 'left' : 'right')
      }
    } else {
      this.cameraStickDirection = 0
    }
    const pause = new Set<number>()
    if (this.pauseFrames > 0 && map) {
      pause.add(map.pause)
      this.pauseFrames--
    }
    this.keys.setSources({
      gamepad: pad,
      touch: map ? originalTouchKeys(this.touchAxes, this.touchView, map) : [],
      turn: map ? this.turnKeys(map) : [],
      pause,
    })
  }

  private publishAnalogSteering(controller: GamepadSnapshot, map: OriginalGraphKeyMap | undefined) {
    if (this.gamepadSettings.analogSteering !== true) return
    const forceBehavior = this.analogForceBehavior ?? this.readAnalogForceBehavior()
    if (!forceBehavior) return
    this.analogForceBehavior = forceBehavior
    if (!map || !controller.connected) return
    const digital = {
      right: this.physicalHeld.has(map.right) || this.touchAxes.x > 0 || controller.pressed.has('dpadRight'),
      left: this.physicalHeld.has(map.left) || this.touchAxes.x < 0 || controller.pressed.has('dpadLeft'),
      backward: this.physicalHeld.has(map.down) || this.touchAxes.z > 0 || controller.pressed.has('dpadDown'),
      forward: this.physicalHeld.has(map.up) || this.touchAxes.z < 0 || controller.pressed.has('dpadUp'),
    }
    for (const [behavior, scale] of originalAnalogSteeringScales(controller, forceBehavior, digital)) {
      this.analogForceScales.set(behavior, scale)
    }
  }

  private readAnalogForceBehavior(): Record<OriginalAnalogDirection, number> | undefined {
    const runtime = this.session?.runtime('Gameplay')
    if (!runtime) return undefined
    const keys = originalPlayerData().input.keys
    const result = {} as Record<OriginalAnalogDirection, number>
    for (const direction of ['right', 'left', 'backward', 'forward'] as const) {
      const key = keys.find(item => item.name === direction)
      if (!key) throw new Error(`Analog steering needs the player data's ${direction} drive key`)
      const node = runtime.data.nodes[String(key.forceBehavior)]
      if (!node || (node.name !== 'SetPhysicsForce' && node.name !== 'Physics Force')) {
        throw new Error(`Analog steering maps ${direction} to behavior ${key.forceBehavior}, which is not a Set Physics Force node in Gameplay`)
      }
      result[direction] = key.forceBehavior
    }
    return result
  }

  /**
   * Cam Navigation needs the rotation key held while the direction key's
   * Secure Key arms; hold both for at least two host frames and the authored
   * 250 ms turn, then release. A queued turn starts after the previous one.
   */
  private turnKeys(map: OriginalGraphKeyMap): Set<number> {
    if (!this.turnPulse && this.turnQueue.length > 0) {
      this.turnPulse = { direction: this.turnQueue.shift()!, started: this.clock, frames: 0 }
    }
    const pulse = this.turnPulse
    if (!pulse) return new Set()
    const held = new Set([map.rotation, pulse.direction === 'left' ? map.left : map.right])
    pulse.frames++
    if (pulse.frames >= 2 && this.clock - pulse.started >= TURN_HOLD_MS) this.turnPulse = undefined
    return held
  }

  private syncParticleTextures() {
    if (!this.context) return
    for (const texture of this.context.objectsOfClass(CKCID.TEXTURE)) {
      if (this.flameTexture && (texture.name === 'I_Particle_Flames' || texture.name === 'Particle_Flames')) {
        this.particleTextures.set(originalObjectReference(texture.id), this.flameTexture)
        continue
      }
      const pack = texture.document === undefined ? undefined : this.packs?.get(texture.document.toLowerCase())
      const entry = pack?.textures.find(item => item.name === texture.name)
      const file = entry?.file ? this.loadedTextures.get(entry.file) : undefined
      if (file) this.particleTextures.set(originalObjectReference(texture.id), file)
    }
  }

  /**
   * The frame's post-sprite `Planar Filter` callbacks (Visuals.dll 0x25787CD0):
   * one full-view quad per shown filter, in registration order, reading its
   * inputs now. It draws after the foreground 2D layer (the HUD included) with
   * the decoded states; the material uses MODULATEALPHA, no Z test or write,
   * cull off, clamp addressing and the authored filters.
   */
  private syncPlanarFilters(size: { width: number; height: number }) {
    if (!this.view || !this.context) return
    const items = this.planarFilter.items()
    const live = new Set(items.map(item => item.key))
    for (const [key, entry] of this.filterMeshes) {
      if (live.has(key)) continue
      entry.mesh.removeFromParent()
      entry.mesh.geometry.dispose()
      entry.material.map?.dispose()
      entry.material.dispose()
      this.filterMeshes.delete(key)
    }
    for (const { key, settings } of items) {
      const texture = this.filterTexture(settings.texture)
      const signature = [settings.texture ?? '', settings.sourceBlend, settings.destBlend, settings.magFilter, settings.minFilter, texture?.file ?? ''].join('|')
      let entry = this.filterMeshes.get(key)
      if (!entry || entry.signature !== signature) {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3))
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2))
        geometry.setIndex([0, 1, 2, 0, 2, 3])
        const material = this.filterMaterial(settings, texture?.file ?? null)
        if (!entry) {
          const mesh = new THREE.Mesh(geometry, material)
          mesh.name = `Planar Filter ${key}`
          mesh.frustumCulled = false
          mesh.renderOrder = FILTER_RENDER_ORDER
          this.view.overlay.add(mesh)
          entry = { mesh, signature, material }
          this.filterMeshes.set(key, entry)
        } else {
          entry.mesh.geometry.dispose()
          entry.mesh.geometry = geometry
          entry.material.map?.dispose()
          entry.material.dispose()
          entry.material = material
          entry.mesh.material = material
          entry.signature = signature
        }
      }
      const position = entry.mesh.geometry.getAttribute('position') as THREE.BufferAttribute
      position.array.set([0, 0, 0, size.width, 0, 0, size.width, size.height, 0, 0, size.height, 0])
      position.needsUpdate = true
      const prelit = entry.material.prelit
      if (!prelit) throw new Error(`Planar Filter ${key} has no prelit colours`)
      prelit.color.set(settings.color[0] / 255, settings.color[1] / 255, settings.color[2] / 255, settings.color[3] / 255)
      prelit.specular.setRGB(settings.specular[0] / 255, settings.specular[1] / 255, settings.specular[2] / 255)
      entry.mesh.visible = true
    }
  }

  /** The context texture and exported file a `Planar Filter` Texture input names. */
  private filterTexture(reference: string | null): { file: string } | null {
    if (reference === null) return null
    const texture = this.context!.resolve(reference)
    if (!texture) throw new Error(`Planar Filter texture ${reference} is not in the context`)
    if (texture.classId !== CKCID.TEXTURE) throw new Error(`Planar Filter texture ${texture.name} is not a texture`)
    const pack = texture.document === undefined ? undefined : this.packs?.get(texture.document.toLowerCase())
    const entry = pack?.textures.find(item => item.name === texture.name)
    if (!entry) throw new Error(`Planar Filter texture ${texture.name} has no render export`)
    return { file: entry.file }
  }

  /** The decoded post-sprite state (Visuals.dll 0x25787CD0) as a fixed-function material. */
  private filterMaterial(settings: GraphFilterSettings, file: string | null): OriginalFixedFunctionMaterial {
    const description: OriginalViewMaterial = {
      id: -1, name: 'Planar Filter', texture: -1,
      diffuse: [1, 1, 1, 1], ambient: [0, 0, 0, 1], specular: [0, 0, 0, 1], emissive: [0, 0, 0, 1], specularPower: 0,
      AlphaBlendEnabled: true, AlphaTestEnabled: false, TwoSidedEnabled: true, ZWriteEnabled: false,
      sourceBlend: settings.sourceBlend, destBlend: settings.destBlend,
      textureBlendMode: 4, textureMinMode: settings.minFilter, textureMagMode: settings.magFilter,
      textureAddressMode: 3,
    }
    const source = FILTER_BLEND[settings.sourceBlend], dest = FILTER_BLEND[settings.destBlend]
    if (!source || !dest) throw new Error(`Planar Filter blend ${settings.sourceBlend}/${settings.destBlend} is not implemented`)
    const min = FILTER_MIN[settings.minFilter], mag = FILTER_MAG[settings.magFilter]
    if (!min) throw new Error(`Planar Filter min filter ${settings.minFilter} is not implemented`)
    if (!mag) throw new Error(`Planar Filter mag filter ${settings.magFilter} is not implemented`)
    const sourceTexture = file === null ? undefined : this.loadedTextures.get(file)
    if (file !== null && !sourceTexture) throw new Error(`Planar Filter texture ${file} is not loaded`)
    const map = sourceTexture?.clone() ?? null
    if (map) {
      map.wrapS = map.wrapT = TEXTURE_ADDRESS[3]!
      map.minFilter = min
      map.magFilter = mag
      map.needsUpdate = true
    }
    const textures = file === null ? this.loadedTextures : new Map([[file, map!]])
    const material = this.createMaterial(description, file,
      { color: settings.color, specular: settings.specular }, textures) as OriginalFixedFunctionMaterial
    material.depthTest = false
    material.depthWrite = false
    material.blending = THREE.CustomBlending
    material.blendEquation = THREE.AddEquation
    material.blendEquationAlpha = THREE.AddEquation
    material.blendSrc = material.blendSrcAlpha = source
    material.blendDst = material.blendDstAlpha = dest
    material.toneMapped = false
    material.fog = false
    material.needsUpdate = true
    return material
  }

  /**
   * TT Simple Shadow's floors: the members of the level's `Shadow` group
   * (Levelinit's `set Floor`), with the context's live world matrices, their
   * current meshes' local vertices and the meshes the view draws for them.
   * The drawer is rebuilt when the group or its members change (a level load).
   */
  private syncBallShadow() {
    const context = this.context, view = this.view
    if (!context || !view) return
    const group = context.findByClass('Shadow', CKCID.GROUP)
    const signature = group === undefined ? undefined : `${group.id}|${(group.members ?? []).join(',')}`
    if (signature === this.shadowSignature) return
    this.ballShadow?.dispose()
    this.ballShadow = undefined
    this.shadowSignature = signature
    if (!group) return
    const members = group.members ?? []
    if (members.length === 0) throw new Error('The level Shadow group has no floors')
    const floors: ShadowFloorSource[] = members.map(id => {
      const object = context.get(id)
      if (!object) throw new Error(`Shadow floor #${id} is not in the context`)
      if (!context.isEntity(id)) throw new Error(`Shadow floor ${object.name} is not a 3D entity`)
      const matrix = context.worldMatrix(id)
      if (!matrix) throw new Error(`Shadow floor ${object.name} has no world matrix`)
      const mesh = context.currentMesh(id)
      if (!mesh?.geometry) throw new Error(`Shadow floor ${object.name} has no mesh geometry`)
      const drawn = view.object(id)
      if (!drawn) throw new Error(`Shadow floor ${object.name} is not drawn by the context view`)
      return { name: object.name, matrix: [...matrix], positions: [...mesh.geometry.positions], mesh: drawn }
    })
    const texture = this.shadowTexture
    if (!texture) throw new Error('The original session has no HardShadow texture for TT Simple Shadow')
    this.ballShadow = new OriginalBallShadow(floors, new Map([['HardShadow', texture]]), target => {
      const object = context.resolve(target)
      if (!object) return undefined
      if (!context.isEntity(object.id)) throw new Error(`TT Simple Shadow target ${target} is not a 3D entity`)
      const matrix = context.worldMatrix(object.id)
      if (!matrix) throw new Error(`TT Simple Shadow target ${object.name} has no world matrix`)
      const mesh = context.currentMesh(object.id)
      if (!mesh?.geometry) throw new Error(`TT Simple Shadow target ${object.name} has no mesh geometry`)
      return { matrix: new THREE.Matrix4().fromArray(matrix), localBox: new THREE.Box3().setFromArray(mesh.geometry.positions) }
    })
  }

  /** This frame's TT Simple Shadow requests, with the Texture input (a context reference such as `#536`) resolved to its name. */
  private shadowProjections() {
    const context = this.context!
    return (context.render.shadow?.projections ?? []).map(projection => {
      const reference = projection.settings.texture
      if (reference === null) return projection
      const texture = context.resolve(reference)
      if (!texture) throw new Error(`TT Simple Shadow texture ${reference} is not in the context`)
      return { ...projection, settings: { ...projection.settings, texture: texture.name } }
    })
  }

  private syncLights() {
    if (!this.context || !this.lighting) return
    const live = new Set<number>()
    for (const object of [...this.context.objectsOfClass(CKCID.LIGHT), ...this.context.objectsOfClass(CKCID.TARGETLIGHT)]) {
      const state = object.light
      if (!state) throw new Error(`Light ${object.name} has no saved light state`)
      live.add(object.id)
      let light = this.lights.get(object.id) as THREE.DirectionalLight | THREE.PointLight | undefined
      if (!light) {
        if (state.type === 3) light = new THREE.DirectionalLight()
        else if (state.type === 1) light = new THREE.PointLight()
        else throw new Error(`Spot light ${object.name} is not drawn by the view`)
        light.name = object.name
        this.lights.set(object.id, light)
        if (light instanceof THREE.DirectionalLight) {
          const target = new THREE.Object3D()
          this.lightTargets.set(object.id, target)
          this.scene.add(target)
          light.target = target
        }
        this.scene.add(light)
        this.lighting.add({
          light, specular: (state.flags & 0x200) !== 0,
          ...(light instanceof THREE.PointLight ? { attenuation: state.attenuation, range: state.range } : {}),
        })
      }
      const world = this.context.entities.world(originalObjectReference(object.id))
      if (!world) throw new Error(`Light ${object.name} has no world matrix`)
      const position = new THREE.Vector3(world[12]! * SCALE, world[13]! * SCALE, -world[14]! * SCALE)
      light.color.setRGB(state.color[0], state.color[1], state.color[2])
      light.intensity = state.power
      light.visible = this.context.entities.visible(originalObjectReference(object.id))
      if (light instanceof THREE.DirectionalLight) {
        const toward = new THREE.Vector3(-world[8]!, -world[9]!, world[10]!).normalize()
        light.position.copy(position).addScaledVector(toward, 50)
        light.target.position.copy(position)
        light.target.updateMatrixWorld()
      } else {
        light.position.copy(position)
        light.distance = state.range
        light.decay = 0
      }
    }
    for (const [id, light] of [...this.lights]) {
      if (live.has(id)) continue
      this.lights.delete(id)
      this.lightTargets.get(id)?.removeFromParent()
      this.lightTargets.delete(id)
      light.removeFromParent()
      const index = this.lighting.sources.findIndex(source => source.light === light)
      if (index >= 0) this.lighting.sources.splice(index, 1)
    }
    const ambient = this.context.render.ambientColor
    if (ambient !== undefined) {
      const r = (ambient >>> 16) & 0xff, g = (ambient >>> 8) & 0xff, b = ambient & 0xff
      this.lighting.uniforms.ffAmbient.value.set(r / 255, g / 255, b / 255)
    } else {
      this.lighting.uniforms.ffAmbient.value.setScalar(ORIGINAL_SCENE_AMBIENT)
    }
    this.lighting.update()
  }

  private updateEnvironment() {
    if (!this.context || !this.renderer) return
    const background = this.context.render.backgroundColor
    if (background && background.length >= 3) this.renderer.setClearColor(new THREE.Color(background[0]!, background[1]!, background[2]!), background[3] ?? 1)
    else this.renderer.setClearColor(0x000000, 1)
    const fog = this.context.render.fog
    if (fog && fog.mode !== 0) {
      const color = new THREE.Color(((fog.color >>> 16) & 0xff) / 255, ((fog.color >>> 8) & 0xff) / 255, (fog.color & 0xff) / 255)
      this.scene.fog = new THREE.Fog(color, fog.start * SCALE, fog.end * SCALE)
    } else this.scene.fog = null
  }

  private updateCursor() {
    if (!this.cursor) return
    const stereo = this.settings.mode !== 'off'
    this.cursor.visible = stereo && this.pointer.inside
    if (this.cursor.visible) {
      const size = 32
      // The overlay camera has screen-down Y; a positive plane Y would show
      // Cursor.png upside down.
      this.cursor.scale.set(size, -size, 1)
      this.cursor.position.set(this.pointer.x + size / 2, this.pointer.y + size / 2, 0)
    }
    const visible = this.input?.cursorVisible() ?? this.cursorShown
    if (this.renderer) this.renderer.domElement.style.cursor = visible && !stereo ? 'default' : 'none'
  }

  private loop = (now: number) => {
    if (this.failed || this.disposed) return
    this.frame = requestAnimationFrame(this.loop)
    try {
      const elapsed = this.last === 0 ? 0 : Math.max(0, now - this.last)
      this.last = now
      this.clock += elapsed
      this.pollInput()
      this.session!.step(elapsed, this.keys.heldKeys)
      this.patchScreenModes()
      this.view!.sync()
      this.syncLights()
      this.updateEnvironment()
      const camera = this.view!.camera
      const hasCamera = this.view!.syncCamera()
      const viewport = this.context!.render.viewport!
      const canvas = this.context!.render.canvas ?? viewport
      this.view!.sync2d(this.session!.frame2d, viewport, canvas)
      this.syncPlanarFilters(canvas)
      this.updateCursor()
      this.syncParticleTextures()
      this.particles!.render(camera)
      this.syncBallShadow()
      this.ballShadow?.render(this.shadowProjections())
      const scene = hasCamera ? this.scene : this.emptyScene
      // In Leia SR the overlay camera spans one half; its UI Depth shift is
      // measured against that half's CSS width, not the whole pair.
      const overlayWidth = this.settings.mode === LEIA_STEREO_MODE
        ? window.innerWidth / 2
        : canvasBox(window.innerWidth, window.innerHeight, this.display.widescreen).width
      this.stereo!.render(scene, camera, this.sky, { scene: this.view!.overlay, camera: this.view!.overlayCamera, cssWidth: overlayWidth })
      this.updateCursor()
    } catch (error) {
      this.fail(error)
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver?.disconnect()
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('pointermove', this.pointerMove)
    window.removeEventListener('pointerdown', this.pointerDown)
    window.removeEventListener('pointerup', this.pointerUp)
    window.removeEventListener('keydown', this.keyDown)
    window.removeEventListener('keyup', this.keyUp)
    window.removeEventListener('contextmenu', this.contextMenu)
    this.cursor?.geometry.dispose()
    ;(this.cursor?.material as THREE.Material | undefined)?.dispose()
    this.ballShadow?.dispose()
    this.ballShadow = undefined
    this.view?.dispose()
    for (const entry of this.filterMeshes.values()) {
      entry.mesh.geometry.dispose()
      entry.material.map?.dispose()
      entry.material.dispose()
    }
    this.filterMeshes.clear()
    this.sky?.dispose()
    for (const texture of this.skyTextures) texture.dispose()
    this.skyTextures = []
    for (const texture of this.sampledTextures.values()) texture.dispose()
    this.sampledTextures.clear()
    this.particles?.dispose()
    this.ivp?.dispose()
    this.rapierWorld?.free()
    this.gamepad.dispose()
    this.audio?.dispose()
    this.stereo?.dispose()
    this.renderer?.dispose()
    this.renderer?.domElement.remove()
  }
}
