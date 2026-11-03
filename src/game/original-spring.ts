// Damped spring between a point on a physics body and a fixed world point. The
// spring is applied as an impulse once per step, not as a Rapier constraint:
// stiffness is scaled by the original's time factor squared and damping by the
// time factor once, following the recovered original model.

import * as THREE from 'three'
import { ORIGINAL_TIME_FACTOR } from './original-physics.ts'

export interface SpringCoefficients {
  /** Rest length in world units (already scaled). */
  length: number
  /** Stiffness in the original's units. */
  constant: number
  /** Damping along the spring axis in the original's units. */
  axialDamping: number
  /** Damping of the full relative velocity in the original's units. */
  globalDamping: number
}

// Below this length the spring has no defined direction and exerts no force.
const COINCIDENT_LENGTH = 1e-7

// Impulse that a spring with the given displacement and relative velocity
// applies over one step of `dt` seconds. The inputs are not modified.
export function springImpulse(
  displacement: THREE.Vector3,
  relativeVelocity: THREE.Vector3,
  coefficients: SpringCoefficients,
  dt: number,
): THREE.Vector3 {
  const stretch = displacement.length()
  if (stretch < COINCIDENT_LENGTH) return new THREE.Vector3()

  const direction = displacement.clone().divideScalar(stretch)
  const factor = ORIGINAL_TIME_FACTOR

  const stiffnessForce = -(stretch - coefficients.length) * coefficients.constant * factor * factor
  const dampingForce = -relativeVelocity.dot(direction) * coefficients.axialDamping * factor
  const axialForce = stiffnessForce + dampingForce

  const impulse = direction
    .multiplyScalar(axialForce)
    .add(relativeVelocity.clone().multiplyScalar(-coefficients.globalDamping * factor))

  return impulse.multiplyScalar(dt)
}
