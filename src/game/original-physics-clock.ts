const SMOOTHING_KEEP = 3
const SMOOTHING_DIVISOR = 4
const MS_TO_SECONDS = 0.001
const DEFAULT_TIME_FACTOR = 2

function assertFrameInput(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid physics frame time')
}

/**
 * Converts the wall-clock length of each frame into the physics step. The frame
 * length is smoothed against the previous smoothed value, then scaled by a time
 * factor. Stored and returned values are single precision, as in the original.
 */
export class OriginalPhysicsClock {
  /** Smoothed frame length in milliseconds (single precision). */
  filteredMs = 0

  step(deltaMs: number, timeFactor = DEFAULT_TIME_FACTOR): number {
    assertFrameInput(deltaMs)
    assertFrameInput(timeFactor)

    const frame = Math.fround(deltaMs)
    const smoothedExact = (SMOOTHING_KEEP * this.filteredMs + frame) / SMOOTHING_DIVISOR
    this.filteredMs = Math.fround(smoothedExact)

    const scale = Math.fround(Math.fround(timeFactor) * Math.fround(MS_TO_SECONDS))
    return Math.fround(smoothedExact * scale)
  }
}
