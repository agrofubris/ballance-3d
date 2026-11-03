// Range watcher for the original's "Scaleable Proximity" behaviour. It measures
// the distance between two points over a chosen set of axes, reports entering
// and leaving the range as bit flags, and sets how many script frames to wait
// before the next measurement. The wait grows with the distance inside the
// interpolation band, so far-off pairs are sampled rarely.

import type * as THREE from 'three'
import { SCALE } from './original-data.ts'

export interface ProximitySettings {
  /** Range threshold, before the squared rule is applied. */
  distance: number
  /** Axis bit mask: 1 = X, 2 = Y, 4 = Z. */
  axes: number
  /** Lower bound of the interpolation band. */
  exactnessMin: number
  /** Upper bound of the interpolation band. */
  exactnessMax: number
  /** Countdown (frames) at and below the lower band bound. */
  minFrameDelay: number
  /** Countdown (frames) at and beyond the upper band bound. */
  maxFrameDelay: number
  /** Unless `false`, distances are compared in squared form. */
  squared?: boolean
  /** Bit mask of the output flags that may be reported; default 15. */
  outputFlags?: number
}

const FLAG_IN_RANGE = 1
const FLAG_OUT_OF_RANGE = 2
const FLAG_ENTER_RANGE = 4
const FLAG_EXIT_RANGE = 8
const ALL_FLAGS = 15

const AXIS_X = 1
const AXIS_Y = 2
const AXIS_Z = 4

export class OriginalProximity {
  data: ProximitySettings
  /** Frames left before the next measurement; starts at 1. */
  remaining = 1
  /** Last measured range state; undefined until the first measurement. */
  inside: boolean | undefined = undefined
  private readonly coordinateScale: number

  constructor(data: ProximitySettings, coordinateScale: number = SCALE) {
    this.data = data
    this.coordinateScale = coordinateScale
  }

  // True when the latest sample reports an entry into the range.
  enter(a: THREE.Vector3, b: THREE.Vector3): boolean {
    return this.sample(a, b) === FLAG_ENTER_RANGE
  }

  // Forgets the previous range state; the countdown is left as it is.
  restart(): void {
    this.inside = undefined
  }

  // Takes one measurement if the countdown allows it. Returns the reported
  // flags, or 0 when the countdown suppressed the measurement.
  sample(a: THREE.Vector3, b: THREE.Vector3): number {
    this.remaining -= 1
    if (this.remaining > 0) return 0

    const data = this.data
    const squared = data.squared !== false
    const scale = this.coordinateScale

    const enabled = data.axes
    let sumOfSquares = 0
    if (enabled & AXIS_X) sumOfSquares += (a.x - b.x) * (a.x - b.x)
    if (enabled & AXIS_Y) sumOfSquares += (a.y - b.y) * (a.y - b.y)
    if (enabled & AXIS_Z) sumOfSquares += (a.z - b.z) * (a.z - b.z)

    const current = squared
      ? sumOfSquares / (scale * scale)
      : Math.sqrt(sumOfSquares) / scale

    const lower = squared ? data.exactnessMin * data.exactnessMin : data.exactnessMin
    const upper = squared ? data.exactnessMax * data.exactnessMax : data.exactnessMax
    const minDelay = data.minFrameDelay
    const maxDelay = data.maxFrameDelay

    let countdown: number
    if (current < upper) {
      if (current > lower) {
        const fraction = ((current - lower) / (upper - lower)) * (maxDelay - minDelay)
        countdown = minDelay + Math.trunc(fraction)
      } else {
        countdown = minDelay
      }
    } else {
      countdown = maxDelay
    }
    this.remaining = Math.max(1, countdown)

    const threshold = squared ? data.distance * data.distance : data.distance
    const isInside = current < threshold

    let flag: number
    if (isInside) {
      flag = this.inside === true ? FLAG_IN_RANGE : FLAG_ENTER_RANGE
    } else {
      flag = this.inside === false ? FLAG_OUT_OF_RANGE : FLAG_EXIT_RANGE
    }
    this.inside = isInside

    return flag & (data.outputFlags ?? ALL_FLAGS)
  }
}
