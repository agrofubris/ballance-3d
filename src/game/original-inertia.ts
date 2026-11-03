import * as THREE from 'three'
import type RAPIER from '@dimforge/rapier3d-compat'
import objectInertiaTable from './original-object-inertia.json' with { type: 'json' }
import fragmentInertiaTable from './original-fragment-inertia.json' with { type: 'json' }
import { SCALE } from './original-data.ts'
import { originalInertiaFrame, originalInertiaKey } from './original-inertia-frame.ts'

interface InertiaMeasurement {
  center: number[]
  inertiaPerMass: number[]
  scale: number[]
}

export const ORIGINAL_OBJECT_INERTIA = objectInertiaTable
export const ORIGINAL_FRAGMENT_INERTIA = fragmentInertiaTable

// Fragment measurements take precedence over object measurements for equal keys.
const measurements: Record<string, InertiaMeasurement> = {
  ...(objectInertiaTable.measurements as Record<string, InertiaMeasurement>),
  ...(fragmentInertiaTable.measurements as Record<string, InertiaMeasurement>),
}

export function hasOriginalConvexMass(hulls: readonly string[], matrix: THREE.Matrix4): boolean {
  return measurements[originalInertiaKey(hulls, matrix)] !== undefined
}

export function originalConvexMass(
  mass: number,
  hulls: readonly string[],
  matrix: THREE.Matrix4,
  massCenter: readonly number[] = [0, 0, 0],
): { center: THREE.Vector3; inertia: THREE.Vector3; frame: THREE.Quaternion } {
  const key = originalInertiaKey(hulls, matrix)
  const measurement = measurements[key] as InertiaMeasurement | undefined
  if (!measurement) throw new Error(`Missing native original inertia measurement: ${key}`)

  const frame = originalInertiaFrame(matrix)
  const [ix, iy, iz] = measurement.inertiaPerMass.map((value) => value * mass * SCALE * SCALE)
  const floor = Math.hypot(ix, iy, iz) * objectInertiaTable.minimumAxisFactor
  const inertia = new THREE.Vector3(Math.max(ix, floor), Math.max(iy, floor), Math.max(iz, floor))

  // The authored shift is in object axes, so z is mirrored before rotating it.
  const center = new THREE.Vector3(massCenter[0], massCenter[1], -massCenter[2])
    .multiplyScalar(SCALE)
    .applyQuaternion(frame)

  return { center, inertia, frame }
}

export function applyOriginalConvexMass(
  body: RAPIER.RigidBody,
  mass: number,
  hulls: readonly string[],
  matrix: THREE.Matrix4,
  massCenter: readonly number[] = [0, 0, 0],
): void {
  const { center, inertia, frame } = originalConvexMass(mass, hulls, matrix, massCenter)
  for (let i = 0; i < body.numColliders(); i++) {
    body.collider(i).setMass(0)
  }
  body.setAdditionalMassProperties(mass, center, inertia, frame, false)
  body.recomputeMassPropertiesFromColliders()
}
