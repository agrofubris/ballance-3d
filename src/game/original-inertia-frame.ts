import * as THREE from 'three'

// Axis-scale factors of a placement matrix, as plain numbers.
export function originalInertiaScale(matrix: THREE.Matrix4): number[] {
  const scale = new THREE.Vector3().setFromMatrixScale(matrix)
  return [scale.x, scale.y, scale.z]
}

// Lookup key: hull names, then the scale at 12 significant digits.
export function originalInertiaKey(hulls: readonly string[], matrix: THREE.Matrix4): string {
  const digits = originalInertiaScale(matrix).map((value) => value.toPrecision(12))
  return `${hulls.join('|')}@${digits.join(',')}`
}

// Orientation of the inertia axes: the placement rotation, conjugated by a
// reflection of the z axis to match the original object axes.
export function originalInertiaFrame(matrix: THREE.Matrix4): THREE.Quaternion {
  const reflection = new THREE.Matrix4().makeScale(1, 1, -1)
  const rotation = new THREE.Matrix4().extractRotation(matrix)
  rotation.premultiply(reflection).multiply(reflection)
  return new THREE.Quaternion().setFromRotationMatrix(rotation).normalize()
}
