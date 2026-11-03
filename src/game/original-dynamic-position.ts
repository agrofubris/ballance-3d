// Per-axis position controller for the original's "Set Dynamic Position"
// behaviour. Each update pulls a position toward a target with a force term
// scaled by elapsed time, and adds a damped copy of the previous frame's
// displacement. Nothing clamps the result, so it can overshoot and oscillate.
// Values are rounded to single precision at the same points as the original;
// intermediate products are kept in double precision.

export type Position3 = readonly [number, number, number]

const MS_TO_SECONDS = 0.001

const toSingle = Math.fround

// Next position after one update, using the previous position for the damping term.
export function originalDynamicPositionStep(
  current: Position3,
  previous: Position3,
  target: Position3,
  force: Position3,
  damping: Position3,
  deltaMs: number,
  offset: Position3 = [0, 0, 0],
): [number, number, number] {
  const seconds = toSingle(toSingle(deltaMs) * toSingle(MS_TO_SECONDS))
  const next: [number, number, number] = [0, 0, 0]

  for (let axis = 0; axis < 3; axis++) {
    const position = toSingle(current[axis])
    const displacement = toSingle(position - toSingle(previous[axis]))
    const error = toSingle(toSingle(target[axis]) - position)
    const scaledForce = toSingle(toSingle(force[axis]) * seconds)
    const dampingTerm = displacement * toSingle(damping[axis])
    const forceTerm = (error - toSingle(offset[axis])) * scaledForce
    next[axis] = toSingle(forceTerm + dampingTerm + position)
  }

  return next
}
