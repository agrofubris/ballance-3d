// Oriented bounding boxes for the original game's box tests. A box is built
// from an authored axis-aligned bounds and a placement matrix. The placement's
// axes are normalised but not made perpendicular, as the original engine does,
// so a sheared placement keeps its shear. Arithmetic is double precision.

import * as THREE from 'three'
import { OBB } from 'three/addons/math/OBB.js'

const AXIS_INDEX = [
  [0, 1, 2],
  [1, 2, 0],
  [2, 0, 1],
] as const

// Returns the three axis vectors of a matrix as a [x, y, z] triple per axis.
function matrixAxes(frame: THREE.Matrix4): [number[], number[], number[]] {
  // Column-major storage: axis i is the column at elements[4i .. 4i+2].
  const e = frame.elements
  return [
    [e[0], e[1], e[2]],
    [e[4], e[5], e[6]],
    [e[8], e[9], e[10]],
  ]
}

function assertUsableFrame(frame: THREE.Matrix4, axes: [number[], number[], number[]]): void {
  const allFinite = frame.elements.every((value) => Number.isFinite(value))
  const axisLengths = axes.map(lengthOf)
  if (!allFinite || axisLengths.some((length) => length === 0)) {
    throw new Error('Invalid original box transform')
  }
}

// Builds the oriented box of an authored bounds box placed by `frame`.
export function originalBox(bounds: THREE.Box3, frame: THREE.Matrix4): OBB {
  const axes = matrixAxes(frame)
  assertUsableFrame(frame, axes)

  const lengths = axes.map(lengthOf)
  const unit = axes.map((axis, i) => axis.map((component) => component / lengths[i]))

  // Rotation columns are the unit axes, so rows hold the components per axis.
  const rotation = new THREE.Matrix3().set(
    unit[0][0], unit[1][0], unit[2][0],
    unit[0][1], unit[1][1], unit[2][1],
    unit[0][2], unit[1][2], unit[2][2],
  )

  const center = bounds.getCenter(new THREE.Vector3()).applyMatrix4(frame)
  const size = bounds.getSize(new THREE.Vector3())
  const halfSize = new THREE.Vector3(
    (size.x * 0.5) * lengths[0],
    (size.y * 0.5) * lengths[1],
    (size.z * 0.5) * lengths[2],
  )

  return new OBB(center, halfSize, rotation)
}

// Separating-axis test over the fifteen candidate axes of two oriented boxes.
// Returns true when no axis separates them; touching counts as overlap.
export function originalBoxesIntersect(a: OBB, b: OBB): boolean {
  const aAxes = columnsOf(a.rotation)
  const bAxes = columnsOf(b.rotation)
  const e = [a.halfSize.x, a.halfSize.y, a.halfSize.z]
  const f = [b.halfSize.x, b.halfSize.y, b.halfSize.z]

  const delta = [
    b.center.x - a.center.x,
    b.center.y - a.center.y,
    b.center.z - a.center.z,
  ]

  const t = aAxes.map((axis) => dot(axis, delta))
  const R = aAxes.map((axis) => bAxes.map((other) => dot(axis, other)))
  const absR = R.map((row) => row.map((value) => Math.abs(value)))

  // The three axes of a.
  for (let i = 0; i < 3; i++) {
    const reach = e[i] + absR[i][0] * f[0] + absR[i][1] * f[1] + absR[i][2] * f[2]
    if (Math.abs(t[i]) > reach) return false
  }

  // The three axes of b, projecting delta directly onto each.
  for (let j = 0; j < 3; j++) {
    const projection = Math.abs(dot(delta, bAxes[j]))
    const reach = f[j] + absR[0][j] * e[0] + absR[1][j] * e[1] + absR[2][j] * e[2]
    if (projection > reach) return false
  }

  // The nine cross products of an a-axis with a b-axis.
  for (let i = 0; i < 3; i++) {
    const [i1, i2] = [AXIS_INDEX[i][1], AXIS_INDEX[i][2]]
    for (let j = 0; j < 3; j++) {
      const [j1, j2] = [AXIS_INDEX[j][1], AXIS_INDEX[j][2]]
      const separation = Math.abs(t[i2] * R[i1][j] - t[i1] * R[i2][j])
      const reach =
        absR[i2][j] * e[i1] +
        absR[i1][j] * e[i2] +
        absR[i][j2] * f[j1] +
        absR[i][j1] * f[j2]
      if (separation > reach) return false
    }
  }

  return true
}

// Column vectors of a rotation matrix (the three box axes).
function columnsOf(rotation: THREE.Matrix3): number[][] {
  const e = rotation.elements
  return [
    [e[0], e[1], e[2]],
    [e[3], e[4], e[5]],
    [e[6], e[7], e[8]],
  ]
}

function lengthOf(axis: number[]): number {
  return Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2])
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
