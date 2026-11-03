// VxMath.dll matrix routines, in Virtools coordinates: row-vector matrices
// stored row-major (m[i][j] at i*4+j), rows 0-2 the axes and row 3 the
// position. THREE's `elements` of the column-vector form hold the same array.
// VxMath picks an SSE path when CPUID reports SSE (the flag at 0x242BE8DC);
// every machine the original shipped for since then takes it, so the SSE
// paths are the ones ported here. Each SSE operation rounds to float32.
import type { OriginalVector } from './original-orientation.ts'

const f = Math.fround

export type OriginalMatrix = number[]

export const originalIdentityMatrix = (): OriginalMatrix => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/**
 * `Vx3DMultiplyMatrix(Dest, A, B)` (export 0x242840C0, SSE path 0x24284249):
 * each row of B transformed by A, so `Dest = B · A` in row-vector terms (B's
 * frame expressed in A's parent frame). Rows 0-2 add (b0·a0 + b1·a1) + b2·a2;
 * row 3 adds (b2·a2 + a3) + (b0·a0 + b1·a1). Column 3 is A's, then [3][3] = 1.
 */
export function originalMultiplyMatrix(a: readonly number[], b: readonly number[]): OriginalMatrix {
  const result = new Array<number>(16)
  for (let row = 0; row < 4; row++) {
    for (let j = 0; j < 4; j++) {
      const p0 = f(b[row * 4]! * a[j]!), p1 = f(b[row * 4 + 1]! * a[4 + j]!), p2 = f(b[row * 4 + 2]! * a[8 + j]!)
      result[row * 4 + j] = row < 3 ? f(f(p0 + p1) + p2) : f(f(p2 + a[12 + j]!) + f(p0 + p1))
    }
  }
  result[15] = 1
  return result
}

/** `Vx3DMultiplyMatrixVector` (export 0x242838F0, SSE path 0x24283962): ((v0·r0 + v1·r1) + v2·r2) + r3. */
export function originalTransformPoint(m: readonly number[], v: OriginalVector): OriginalVector {
  return [0, 1, 2].map(j =>
    f(f(f(f(v[0] * m[j]!) + f(v[1] * m[4 + j]!)) + f(v[2] * m[8 + j]!)) + m[12 + j]!)) as OriginalVector
}

/**
 * `Vx3DInverseMatrix(Dest, Src)` (export 0x2429AD50, x87 only): the affine
 * inverse of Graphics Gems. The determinant's six terms go to separate positive
 * and negative sums (the first term rounded to float); a zero determinant, or
 * |det / (pos - neg)| below 1e-15, leaves Dest untouched (undefined here).
 * Cofactors times 1/det fill the 3x3, then the translation is -(t · inverse).
 * x87 intermediates are approximated with doubles; each store rounds to float.
 */
export function originalInverseMatrix(m: readonly number[]): OriginalMatrix | undefined {
  const [m00, m01, m02, , m10, m11, m12, , m20, m21, m22] = m as number[]
  let positive = 0, negative = 0
  const add = (term: number) => { if (term >= 0) positive += term; else negative += term }
  const a = f(m11! * m22!)
  const first = a * m00!
  if (f(first) >= 0) positive = f(first); else negative = f(first)
  add(m12! * m20! * m01!)
  add(m02! * m10! * m21!)
  add(-(m02! * m20! * m11!))
  add(-(m10! * m22! * m01!))
  const b = f(m12! * m21!)
  add(-(b * m00!))
  const det = f(negative + positive)
  if (det === 0) return undefined
  if (Math.abs(det / (positive - negative)) < 1e-15) return undefined
  const inverse = 1 / det
  const r: OriginalMatrix = new Array<number>(16).fill(0)
  r[0] = f((a - b) * inverse)
  r[4] = f(-((m10! * m22! - m12! * m20!) * inverse))
  r[8] = f((m10! * m21! - m20! * m11!) * inverse)
  r[1] = f(-((m22! * m01! - m02! * m21!) * inverse))
  r[5] = f((m00! * m22! - m02! * m20!) * inverse)
  r[9] = f(-((m00! * m21! - m20! * m01!) * inverse))
  r[2] = f((m12! * m01! - m02! * m11!) * inverse)
  r[6] = f(-((m12! * m00! - m02! * m10!) * inverse))
  r[10] = f((m11! * m00! - m10! * m01!) * inverse)
  const [t0, t1, t2] = [m[12]!, m[13]!, m[14]!]
  r[12] = f(-((t1 * r[4]! + r[0]! * t0) + r[8]! * t2))
  r[13] = f(-((r[5]! * t1 + r[1]! * t0) + t2 * r[9]!))
  r[14] = f(-((r[10]! * t2 + t1 * r[6]!) + t0 * r[2]!))
  r[15] = 1
  return r
}

/** VxMath `Vx3DMatrixFromRotation`: normalises the axis, then the stores below (0x2429AF90). Row-major [row][col]. */
export function originalMatrixFromRotation(axis: OriginalVector, angle: number): OriginalMatrix {
  const length = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2])
  const inv = 1 / length
  const x = f(axis[0] * inv), y = f(axis[1] * inv), z = f(axis[2] * inv)
  const xx = x * x, yy = y * y
  const zz = f(z * z)
  const xy = y * x, xz = z * x
  const yz = f(z * y)
  const c = f(Math.cos(angle)), s = f(Math.sin(angle))
  const omc = 1 - c
  const omcF = f(omc)
  const m = new Array<number>(16).fill(0)
  m[0] = f((1 - xx) * c + xx)
  const t1 = f(omc * xy)
  const szF = f(s * z)
  m[4] = f(s * z + t1)
  const t2 = f(omcF * xz)
  const syF = f(s * y)
  m[8] = f(t2 - syF)
  m[1] = f(t1 - szF)
  m[5] = f((1 - yy) * c + yy)
  const sx = s * x
  m[9] = f(sx + omcF * yz)
  m[2] = f(syF + t2)
  m[6] = f(omcF * yz - sx)
  m[10] = f((1 - zz) * c + zz)
  m[15] = 1
  return m
}
