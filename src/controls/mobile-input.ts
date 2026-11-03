// Touch and device-tilt steering helpers. Everything here is a pure mapping
// from raw sensor or pointer geometry to two unitless steering axes, except the
// TouchPointers table, which remembers the last axes assigned to each pointer.

export type Axes = { x: number; z: number }

const TILT_DEAD_ZONE = 0.035
const TILT_SPAN = 0.3
const PAD_CENTRE_DEAD_ZONE = 0.22
const PAD_SECTOR = Math.PI / 4
const DEFAULT_PAD_RADIUS = 44

const clampUnit = (value: number): number => Math.min(1, Math.max(-1, value))

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

// Projects the gravity vector onto the screen. The device-frame gravity is
// built from the front-back and left-right tilts, then turned by the screen
// rotation so that the axes follow what the player sees.
export function screenTilt(beta: number, gamma: number, angle: number): Axes {
  const tiltX = toRadians(beta)
  const tiltY = toRadians(gamma)
  const screen = toRadians(angle)

  const deviceX = Math.sin(tiltY) * Math.cos(tiltX)
  const deviceY = Math.sin(tiltX)

  const cosScreen = Math.cos(screen)
  const sinScreen = Math.sin(screen)
  return {
    x: deviceX * cosScreen + deviceY * sinScreen,
    z: deviceY * cosScreen - deviceX * sinScreen,
  }
}

// Removes the calibrated neutral pose from a tilt reading, applies a dead zone
// around it, and scales what remains into the -1..1 range.
export function tiltAxes(value: Axes, neutral: Axes, sensitivity = 1): Axes {
  const shape = (delta: number): number => {
    const magnitude = Math.abs(delta)
    if (magnitude < TILT_DEAD_ZONE) return 0
    const direction = delta < 0 ? -1 : 1
    return clampUnit(((direction * (magnitude - TILT_DEAD_ZONE)) / TILT_SPAN) * sensitivity)
  }
  return {
    x: shape(value.x - neutral.x),
    z: shape(value.z - neutral.z),
  }
}

// Maps a point on a square pad (origin at the top-left, y down) to one of the
// eight compass directions. Points inside the centre dead zone map to rest.
export function padAxes(x: number, y: number, size: number): Axes {
  const half = size / 2
  const nx = (x - half) / half
  const ny = (y - half) / half

  if (Math.sqrt(nx * nx + ny * ny) < PAD_CENTRE_DEAD_ZONE) return { x: 0, z: 0 }

  const sector = Math.round(Math.atan2(ny, nx) / PAD_SECTOR)
  const snapped = sector * PAD_SECTOR
  return {
    x: Math.round(Math.cos(snapped)),
    z: Math.round(Math.sin(snapped)),
  }
}

// A pad that follows the touch: the thumb is clamped to a circle, while the
// steering is still read from the unclamped offset.
export function floatingPad(dx: number, dy: number, radius = DEFAULT_PAD_RADIUS): { dx: number; dy: number; axes: Axes } {
  const distance = Math.sqrt(dx * dx + dy * dy)
  const scale = distance > radius ? radius / distance : 1
  return {
    dx: dx * scale,
    dy: dy * scale,
    axes: padAxes(dx + radius, dy + radius, radius * 2),
  }
}

// Tracks several simultaneous pointers and reports their combined steering.
export class TouchPointers {
  readonly held = new Map<number, Axes>()

  set(id: number, axes: Axes): Axes {
    this.held.set(id, axes)
    return this.axes
  }

  release(id: number): Axes {
    this.held.delete(id)
    return this.axes
  }

  clear(): void {
    this.held.clear()
  }

  get axes(): Axes {
    let x = 0
    let z = 0
    for (const axes of this.held.values()) {
      x += axes.x
      z += axes.z
    }
    return { x: clampUnit(x), z: clampUnit(z) }
  }
}
