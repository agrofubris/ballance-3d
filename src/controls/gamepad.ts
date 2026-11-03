/**
 * Browser Gamepad API support for the original controls.
 *
 * The standard mapping is also used as a conservative fallback for DirectInput
 * devices (including the Logitech Dual Action), since those devices commonly
 * expose the same first two axes and face/shoulder buttons without reporting
 * `mapping: "standard"`.
 */

export type GamepadButtonAction =
  | 'accept'
  | 'cancel'
  | 'pause'
  | 'cameraLeft'
  | 'cameraRight'
  | 'overview'
  | 'quitTutorial'

export type GamepadAction = GamepadButtonAction
  | 'dpadUp'
  | 'dpadDown'
  | 'dpadLeft'
  | 'dpadRight'

export const GAMEPAD_BUTTON_ACTIONS: readonly GamepadButtonAction[] = [
  'accept', 'cancel', 'pause', 'cameraLeft', 'cameraRight', 'overview', 'quitTutorial',
]

export const DEFAULT_GAMEPAD_BUTTONS: Record<GamepadButtonAction, number> = {
  accept: 0,
  cancel: 1,
  pause: 9,
  cameraLeft: 4,
  cameraRight: 5,
  overview: 7,
  quitTutorial: 2,
}

export type GamepadSettings = {
  deadZone: number
  axisX: number
  axisY: number
  invertY: boolean
  cameraStick: boolean
  analogSteering: boolean
  cameraAxisX: number
  buttons: Record<GamepadButtonAction, number>
}

export const DEFAULT_GAMEPAD_SETTINGS: GamepadSettings = {
  deadZone: 0.14,
  axisX: 0,
  axisY: 1,
  invertY: false,
  cameraStick: false,
  analogSteering: false,
  cameraAxisX: 2,
  buttons: { ...DEFAULT_GAMEPAD_BUTTONS },
}

export type GamepadInfo = {
  connected: boolean
  id: string
  mapping: string
  index: number
}

export type GamepadSnapshot = GamepadInfo & {
  frame: number
  moveX: number
  moveZ: number
  cameraX: number
  pressed: ReadonlySet<GamepadAction>
  justPressed: ReadonlySet<GamepadAction>
  justPressedButtons: ReadonlySet<number>
}

const DPAD_INDEX: Record<Extract<GamepadAction, `dpad${string}`>, number> = {
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
}

const EMPTY_ACTIONS: ReadonlySet<GamepadAction> = new Set()
const EMPTY_BUTTONS: ReadonlySet<number> = new Set()

type AnalogAxis = 'x' | 'y' | 'camera'

const BUTTON_LABELS: Record<number, string> = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
  8: 'Back', 9: 'Start', 10: 'L3', 11: 'R3', 12: 'D-pad Up', 13: 'D-pad Down',
  14: 'D-pad Left', 15: 'D-pad Right',
}

export function gamepadButtonLabel(index: number) {
  return BUTTON_LABELS[index] ?? `Button ${index + 1}`
}

/**
 * The largest offset treated as a resting stick rather than a held one. A
 * worn stick can rest well outside the dead zone (the session's Logitech Dual
 * Action sits at -0.184), so its first near-rest reading becomes the zero point.
 * Port-side input handling, not game data.
 */
const REST_LIMIT = 0.35

function shapeAxis(value: number, deadZone: number) {
  const magnitude = Math.abs(value)
  if (magnitude <= deadZone) return 0
  return Math.sign(value) * Math.min(1, (magnitude - deadZone) / (1 - deadZone))
}

function clampSettings(settings: GamepadSettings): GamepadSettings {
  const deadZone = Number(settings.deadZone)
  const buttons = {...DEFAULT_GAMEPAD_BUTTONS, ...(settings.buttons ?? {})}
  return {
    deadZone: Number.isFinite(deadZone) ? Math.min(0.5, Math.max(0, deadZone)) : DEFAULT_GAMEPAD_SETTINGS.deadZone,
    axisX: Math.max(0, Math.floor(Number(settings.axisX) || 0)),
    axisY: Math.max(0, Math.floor(Number(settings.axisY) || 1)),
    invertY: Boolean(settings.invertY),
    cameraStick: Boolean(settings.cameraStick),
    analogSteering: Boolean(settings.analogSteering),
    cameraAxisX: Math.max(0, Math.floor(Number(settings.cameraAxisX) || 2)),
    buttons: Object.fromEntries(GAMEPAD_BUTTON_ACTIONS.map(action => {
      const index = Number(buttons[action])
      return [action, Number.isInteger(index) && index >= 0 ? index : DEFAULT_GAMEPAD_BUTTONS[action]]
    })) as Record<GamepadButtonAction, number>,
  }
}

function emptySnapshot(frame: number): GamepadSnapshot {
  return {
    connected: false,
    id: '',
    mapping: '',
    index: -1,
    frame,
    moveX: 0,
    moveZ: 0,
    cameraX: 0,
    pressed: EMPTY_ACTIONS,
    justPressed: EMPTY_ACTIONS,
    justPressedButtons: EMPTY_BUTTONS,
  }
}

/** A small, polling-based adapter shared by gameplay and menu input. */
export class OriginalGamepad {
  private preferredIndex: number | undefined
  private previousPressed: ReadonlySet<GamepadAction> = EMPTY_ACTIONS
  private previousPhysicalButtons: readonly boolean[] = []
  private settings: GamepadSettings = { ...DEFAULT_GAMEPAD_SETTINGS, buttons: { ...DEFAULT_GAMEPAD_BUTTONS } }
  private current: GamepadSnapshot = emptySnapshot(0)
  private disposed = false
  /**
   * Per-axis rest offset for the connected pad, captured once from a near-rest
   * reading. Until captured the axis reads 0, so a drifting stick neither steers
   * nor blocks the d-pad.
   */
  private readonly rest: Record<AnalogAxis, number | undefined> = { x: undefined, y: undefined, camera: undefined }
  private padIndex: number | undefined

  private readonly connected = (event: Event) => {
    const gamepad = (event as GamepadEvent).gamepad
    this.preferredIndex = gamepad.index
    this.resetRest()
  }

  private readonly disconnected = (event: Event) => {
    const gamepad = (event as GamepadEvent).gamepad
    if (this.preferredIndex === gamepad.index) this.preferredIndex = undefined
    this.previousPressed = EMPTY_ACTIONS
    this.resetRest()
  }

  private resetRest() {
    this.rest.x = undefined
    this.rest.y = undefined
    this.rest.camera = undefined
  }

  /**
   * Returns the axis value relative to its captured rest. Full deflection still
   * reaches +/-1, so each side is scaled by the travel left on that side.
   */
  private restAxis(raw: number, axis: AnalogAxis) {
    if (this.rest[axis] === undefined && Math.abs(raw) <= REST_LIMIT) this.rest[axis] = raw
    const rest = this.rest[axis]
    if (rest === undefined) return 0
    const value = raw - rest
    const travel = value >= 0 ? 1 - rest : 1 + rest
    return shapeAxis(Math.max(-1, Math.min(1, value / travel)), this.settings.deadZone)
  }

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', this.connected)
      window.addEventListener('gamepaddisconnected', this.disconnected)
    }
  }

  private findGamepad() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return undefined
    let pads: readonly (Gamepad | null)[] = []
    try {
      pads = navigator.getGamepads()
    } catch {
      return undefined
    }
    const preferred = this.preferredIndex === undefined ? undefined : pads[this.preferredIndex]
    if (preferred?.connected) return preferred
    return pads.find((pad): pad is Gamepad => Boolean(pad?.connected))
  }

  private isPressed(gamepad: Gamepad, action: GamepadAction) {
    const index = action in DPAD_INDEX
      ? DPAD_INDEX[action as Extract<GamepadAction, `dpad${string}`>]
      : this.settings.buttons[action as GamepadButtonAction]
    const button = gamepad.buttons[index]
    return Boolean(button?.pressed || (button?.value ?? 0) > 0.5)
  }

  poll(): GamepadSnapshot {
    if (this.disposed) return this.current
    const frame = this.current.frame + 1
    const gamepad = this.findGamepad()
    if (!gamepad) {
      this.preferredIndex = undefined
      this.padIndex = undefined
      this.previousPressed = EMPTY_ACTIONS
      this.previousPhysicalButtons = []
      this.resetRest()
      this.current = emptySnapshot(frame)
      return this.current
    }
    if (gamepad.index !== this.padIndex) {
      this.padIndex = gamepad.index
      this.resetRest()
    }

    const justPressedButtons = new Set<number>()
    const physicalButtons = Array.from(gamepad.buttons, button => Boolean(button?.pressed || (button?.value ?? 0) > 0.5))
    physicalButtons.forEach((pressed, index) => {
      if (pressed && !this.previousPhysicalButtons[index]) justPressedButtons.add(index)
    })
    this.previousPhysicalButtons = physicalButtons

    const pressed = new Set<GamepadAction>()
    for (const action of [...GAMEPAD_BUTTON_ACTIONS, 'dpadUp', 'dpadDown', 'dpadLeft', 'dpadRight'] as GamepadAction[]) {
      if (this.isPressed(gamepad, action)) pressed.add(action)
    }
    const justPressed = new Set<GamepadAction>()
    for (const action of pressed) {
      if (!this.previousPressed.has(action)) justPressed.add(action)
    }
    this.previousPressed = pressed

    const rawX = Number(gamepad.axes[this.settings.axisX] ?? 0)
    const rawY = Number(gamepad.axes[this.settings.axisY] ?? 0) * (this.settings.invertY ? -1 : 1)
    const rawCameraX = Number(gamepad.axes[this.settings.cameraAxisX] ?? 0)
    const axisX = this.restAxis(rawX, 'x')
    const axisY = this.restAxis(rawY, 'y')
    const cameraX = this.restAxis(rawCameraX, 'camera')
    const dpadX = Number(pressed.has('dpadRight')) - Number(pressed.has('dpadLeft'))
    const dpadY = Number(pressed.has('dpadDown')) - Number(pressed.has('dpadUp'))

    this.current = {
      connected: true,
      id: gamepad.id,
      mapping: gamepad.mapping || 'generic',
      index: gamepad.index,
      frame,
      // D-pad input remains useful on controllers which expose no usable axes.
      moveX: Math.abs(axisX) > 0 ? axisX : dpadX,
      moveZ: Math.abs(axisY) > 0 ? axisY : dpadY,
      cameraX,
      pressed,
      justPressed,
      justPressedButtons,
    }
    return this.current
  }

  get snapshot() {
    return this.current
  }

  get info(): GamepadInfo {
    const { connected, id, mapping, index } = this.current
    return { connected, id, mapping, index }
  }

  getSettings() {
    return { ...this.settings }
  }

  setSettings(settings: GamepadSettings) {
    this.settings = clampSettings(settings)
    this.resetRest()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (typeof window !== 'undefined') {
      window.removeEventListener('gamepadconnected', this.connected)
      window.removeEventListener('gamepaddisconnected', this.disconnected)
    }
    this.previousPressed = EMPTY_ACTIONS
    this.previousPhysicalButtons = []
    this.padIndex = undefined
    this.resetRest()
    this.current = emptySnapshot(this.current.frame + 1)
  }
}
