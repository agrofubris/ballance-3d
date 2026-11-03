// Modern input for the graph host: the pad and the touch overlay produce the
// DIK key edges the authored scripts poll. Steering holds an arrow key while a
// stick/d-pad/touch axis is off zero (the engine's IVP path); camera turns pulse
// the authored rotation key plus the direction key for at least two frames so
// Cam Navigation's Secure Keys arm.
import {
  DEFAULT_GAMEPAD_SETTINGS,
  GAMEPAD_BUTTON_ACTIONS,
  type GamepadSettings,
  type GamepadSnapshot,
} from '../controls/gamepad.ts'
import { originalDataArray } from './original-data-arrays.ts'
import type { GraphParameterValue } from './original-graph.ts'

/** The authored keys the graph Key Events poll. */
export interface OriginalGraphKeyMap {
  up: number
  down: number
  left: number
  right: number
  rotation: number
  overview: number
  pause: number
}

/**
 * `Gameplay_Events` watches DIK 1 (Escape) for Pause Level and the pause menu's
 * Secure Key is the same code; the Keyboard Data Array has no pause column.
 */
const PAUSE_KEY = 1

/** The Keyboard row the Options menu rewrites: up, down, left, right, rotation, camup. */
export function originalGraphKeyMap(keyboard: GraphParameterValue[][] | undefined): OriginalGraphKeyMap {
  const columns = originalDataArray('Keyboard')?.columns
  if (!columns?.length) throw new Error('The graph host needs the exported Keyboard Data Array; regenerate the original pack')
  const row = keyboard?.[0]
  if (!row) throw new Error('The Keyboard Data Array has no row')
  const cell = (name: string) => {
    const index = columns.findIndex(column => column.name === name)
    if (index < 0) throw new Error(`The Keyboard Data Array has no ${name} column`)
    const value = row[index]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new Error(`Keyboard ${name} is ${String(value)}, not a DIK code`)
    }
    return value
  }
  return {
    up: cell('up'), down: cell('down'), left: cell('left'), right: cell('right'),
    rotation: cell('rotation'), overview: cell('camup'), pause: PAUSE_KEY,
  }
}

/** The saved controller settings (`ballance-original-gamepad`). */
export function readOriginalGraphGamepadSettings(): GamepadSettings {
  let saved: Partial<GamepadSettings> = {}
  try { saved = JSON.parse(localStorage.getItem('ballance-original-gamepad') ?? 'null') as Partial<GamepadSettings> ?? {} } catch { saved = {} }
  const deadZone = typeof saved.deadZone === 'number' && Number.isFinite(saved.deadZone) ? Math.min(.5, Math.max(0, saved.deadZone)) : DEFAULT_GAMEPAD_SETTINGS.deadZone
  const buttons = Object.fromEntries(GAMEPAD_BUTTON_ACTIONS.map(action => {
    const index = Number(saved.buttons?.[action])
    return [action, Number.isInteger(index) && index >= 0 ? index : DEFAULT_GAMEPAD_SETTINGS.buttons[action]]
  })) as GamepadSettings['buttons']
  return {
    ...DEFAULT_GAMEPAD_SETTINGS, ...saved, deadZone,
    cameraStick: saved.cameraStick === true,
    cameraAxisX: typeof saved.cameraAxisX === 'number' && Number.isInteger(saved.cameraAxisX) && saved.cameraAxisX >= 0 ? saved.cameraAxisX : DEFAULT_GAMEPAD_SETTINGS.cameraAxisX,
    buttons,
  }
}

/** The first raw button pressed this poll, for the Controller panel's binding flow. */
export function originalGraphPressedButton(snapshot: GamepadSnapshot): number | undefined {
  return [...snapshot.justPressedButtons][0]
}

/** DIK_RETURN and DIK_ESCAPE: the menus' Key Events select with Return and go back with Escape; the tutorial continues on Return. */
export const ORIGINAL_ACCEPT_KEY = 28
export const ORIGINAL_CANCEL_KEY = 1
/** DIK_Q: the tutorial's quit key ("quit the tutorial by pressing Q"). */
export const ORIGINAL_QUIT_TUTORIAL_KEY = 16

/** The DIK arrows the Menu Key Events poll whatever the Keyboard row says. */
const MENU_ARROWS = { up: 200, down: 208, left: 203, right: 205 } as const

/**
 * Any non-zero stick/d-pad component holds that direction's authored key and,
 * for the menus, its fixed arrow unless the Keyboard row binds that arrow to
 * another function. Accept and cancel hold Return and Escape; Quit tutorial holds Q.
 */
export function originalPadKeys(pad: GamepadSnapshot, keys: OriginalGraphKeyMap): Set<number> {
  const held = new Set<number>()
  const direction = (name: keyof typeof MENU_ARROWS) => {
    held.add(keys[name])
    const arrow = MENU_ARROWS[name]
    const taken = (Object.keys(keys) as (keyof OriginalGraphKeyMap)[]).some(other => other !== name && keys[other] === arrow)
    if (!taken) held.add(arrow)
  }
  if (pad.moveX < 0) direction('left')
  else if (pad.moveX > 0) direction('right')
  if (pad.moveZ < 0) direction('up')
  else if (pad.moveZ > 0) direction('down')
  if (pad.pressed.has('overview')) held.add(keys.overview)
  if (pad.pressed.has('accept')) held.add(ORIGINAL_ACCEPT_KEY)
  if (pad.pressed.has('cancel')) held.add(ORIGINAL_CANCEL_KEY)
  if (pad.pressed.has('quitTutorial')) held.add(ORIGINAL_QUIT_TUTORIAL_KEY)
  return held
}

/** The touch overlay's axes by sign; view holds the overview key. */
export function originalTouchKeys(axes: { x: number; z: number }, view: boolean, keys: OriginalGraphKeyMap): Set<number> {
  const held = new Set<number>()
  if (axes.x < 0) held.add(keys.left)
  else if (axes.x > 0) held.add(keys.right)
  if (axes.z < 0) held.add(keys.up)
  else if (axes.z > 0) held.add(keys.down)
  if (view) held.add(keys.overview)
  return held
}

/**
 * The union of every input source as input-manager key edges. A key is
 * released only when no source holds it, so a pad key cannot fight the
 * keyboard. The sink queues the edge on the host's input manager clock.
 */
export class OriginalGraphKeyState {
  private readonly sources = new Map<string, ReadonlySet<number>>()
  private readonly held = new Set<number>()
  private readonly sink: (key: number, pressed: boolean, time: number) => void
  private time = 0

  constructor(sink: (key: number, pressed: boolean, time: number) => void) {
    this.sink = sink
  }

  setTime(time: number) {
    this.time = time
  }

  setSource(name: string, keys: Iterable<number>) {
    this.sources.set(name, new Set(keys))
    this.sync()
  }

  setSources(sources: Readonly<Record<string, Iterable<number>>>) {
    for (const [name, keys] of Object.entries(sources)) this.sources.set(name, new Set(keys))
    this.sync()
  }

  get heldKeys(): ReadonlySet<number> { return this.held }

  private sync() {
    const desired = new Set<number>()
    for (const keys of this.sources.values()) for (const key of keys) desired.add(key)
    for (const key of [...this.held]) {
      if (desired.has(key)) continue
      this.held.delete(key)
      this.sink(key, false, this.time)
    }
    for (const key of desired) {
      if (this.held.has(key)) continue
      this.held.add(key)
      this.sink(key, true, this.time)
    }
  }
}
