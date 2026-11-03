// VxMath's Euler matrix and CK3dEntity::SetOrientation, in Virtools
// coordinates: row-vector matrices stored row-major (m[i][j] at i*4+j), with
// rows 0/1/2 the right/up/dir axes and row 3 the position.
const f = Math.fround

export type OriginalVector = [number, number, number]

/** VxMathDefines.h EPSILON. */
const EPSILON = 1.192092896e-07

/**
 * `Vx3DMatrixFromEulerAngles` (VxMatrix.inl): each angle under EPSILON uses
 * c = 1, s = angle; otherwise cosf/sinf. Returns the right/up/dir rows.
 */
export function originalMatrixFromEulerAngles(x: number, y: number, z: number) {
  const cs = (angle: number) => Math.abs(angle) <= EPSILON ? [1, f(angle)] : [f(Math.cos(angle)), f(Math.sin(angle))]
  const [cx, sx] = cs(f(x)), [cy, sy] = cs(f(y)), [cz, sz] = cs(f(z))
  const right: OriginalVector = [f(cy! * cz!), f(cy! * sz!), f(-sy!)]
  const up: OriginalVector = [f(f(f(sx! * sy!) * cz!) - f(cx! * sz!)), f(f(f(sx! * sy!) * sz!) + f(cx! * cz!)), f(sx! * cy!)]
  const dir: OriginalVector = [f(f(f(cx! * sy!) * cz!) + f(sx! * sz!)), f(f(f(cx! * sy!) * sz!) - f(sx! * cz!)), f(cx! * cy!)]
  return { right, up, dir }
}

/** `Vx3DRotateVector`: v times the 3x3 of a row-major matrix. */
export function originalRotateVector(matrix: readonly number[], v: OriginalVector): OriginalVector {
  return [0, 1, 2].map(j => f(f(f(v[0] * matrix[j]!) + f(v[1] * matrix[4 + j]!)) + f(v[2] * matrix[8 + j]!))) as OriginalVector
}

const magnitude = (v: OriginalVector) => f(Math.sqrt(f(f(f(v[0] * v[0]) + f(v[1] * v[1])) + f(v[2] * v[2]))))

/**
 * `RCK3dEntity::SetOrientation` (CKRenderEngine CK3dEntity.cpp, IDA 0x10006CC3)
 * on a world matrix. With a referential the axes are rotated by its world 3x3;
 * a missing Right is Up × Dir. Zero components become 1e-6, then each axis is
 * normalised (`1.0 / (double)Magnitude`) and given the previous world scale of
 * its row. The position row is kept. Returns the new world matrix.
 */
export function originalSetOrientation(world: readonly number[], dir: OriginalVector, up: OriginalVector,
  right: OriginalVector | undefined, referential?: readonly number[]): number[] {
  const eps = f(.000001)
  const scale = [0, 1, 2].map(row => {
    const value = magnitude([world[row * 4]!, world[row * 4 + 1]!, world[row * 4 + 2]!])
    return value === 0 ? eps : value
  })
  const cross = (a: OriginalVector, b: OriginalVector): OriginalVector => [
    f(f(a[1] * b[2]) - f(a[2] * b[1])), f(f(a[2] * b[0]) - f(a[0] * b[2])), f(f(a[0] * b[1]) - f(a[1] * b[0])),
  ]
  let axes: OriginalVector[]
  if (referential) {
    const d = originalRotateVector(referential, dir), u = originalRotateVector(referential, up)
    axes = [right ? originalRotateVector(referential, right) : cross(u, d), u, d]
  } else {
    axes = [right ?? cross(up, dir), up, dir]
  }
  const result = [...world]
  axes.forEach((axis, row) => {
    const value = axis.map(c => c === 0 ? eps : f(c)) as OriginalVector
    const inverse = f(1 / magnitude(value))
    for (let j = 0; j < 3; j++) result[row * 4 + j] = f(f(value[j]! * inverse) * scale[row]!)
  })
  return result
}
