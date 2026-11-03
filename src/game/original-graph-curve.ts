// MenuLevel.nmo's camera curve and ball animation blocks over the CK object
// context, decoded from the shipped DLLs.
//
//   3DTransfo.dll       Position On Curve        676776d0:20d457bd  exec 0x25006CA0
//   3DTransfo.dll       Play Animation 3D Entity 64221225:769a143f  exec 0x250073C0
//   CK2_3D.dll          CKCurve::GetPos / Update, CKObjectAnimation::SetStep, the linear key controllers
//   CK2.dll             CK2dCurve::GetY (0x24001B36)
//   VxMath.dll          Slerp (0x2429C8F0), VxQuaternion::ToMatrix (0x242836E0)
//
// Float conventions: every `fstp dword` rounds to float32 (`f`). x87 chains that the DLL keeps in
// registers between stores are done in doubles here (the control word is not verified; see notes.md).
// VxMath picks its SSE paths on every machine since 1999, so the SSE bodies are the ones ported.
import type { BehaviorContext, BehaviorFn, BehaviorRegistry } from './original-graph.ts'
import type { GraphContextBinding } from './original-graph-bindings.ts'
import { originalTransformPoint } from './original-matrix.ts'
import { decodeOriginal2dCurve } from './original-2d-curve.ts'
import type { UfoCurvePoint } from './original-ufo-animation.ts'
import { authoredVectorToBinding } from './original-graph-bindings.ts'

const f = Math.fround
export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

// ---------------------------------------------------------------------------
// float32 vector helpers (VxVector operators in CK2_3D.dll)
// ---------------------------------------------------------------------------
/** 0x1000BFF0: `fld scalar; fmul comp; fstp` per component. */
const scale = (v: Vec3, s: number): Vec3 => [f(s * v[0]), f(s * v[1]), f(s * v[2])]
/** 0x100132C0 */
const add = (a: Vec3, b: Vec3): Vec3 => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])]
/** 0x1000C120 */
const sub = (a: Vec3, b: Vec3): Vec3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])]
/**
 * VxVector::Magnitude (0x1000BF10): the dot product is accumulated x87-style and STORED as a float,
 * then the CRT sqrt of that float is returned unrounded (the caller rounds when it stores).
 */
const magnitude = (v: Vec3): number => Math.sqrt(f(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]))

// ---------------------------------------------------------------------------
// CK2dCurve::GetY (CK2.dll 0x24001B36) - exact port. The existing `ufoCurve` bisects from t = 0.5 and
// therefore differs for Hermite segments; linear (flag 2) segments agree.
// ---------------------------------------------------------------------------
/** The first point whose x is not below `x` selects the segment; the previous point starts it. */
export function ck2dCurveGetY(points: readonly UfoCurvePoint[], input: number): number {
  const n = points.length
  let x = f(input)
  if (x > 1) x = 1
  if (x < 0) x = 0
  if (n <= 1) return 0
  let end = 0
  while (end < n && points[end]!.position[0] < x) end++
  if (end >= n) return 0
  let start = end - 1
  if (start < 0) start = 0
  else if (start >= n) start = n - 1
  const a = points[start]!, b = points[end]!
  let y = 0
  if (a.position[0] === b.position[0]) {
    y = a.position[1]
  } else if (a.flags & 2) {
    // linear: ((b.y - a.y) * (x - a.x)) / (b.x - a.x) + a.y, one store
    y = f(((b.position[1] - a.position[1]) * (x - a.position[0])) / (b.position[0] - a.position[0]) + a.position[1])
  } else {
    // Hermite: t starts at the linear guess, the interval is then narrowed around the NEXT midpoint
    // (a quirk of the original: bounds follow tNext, not the t that was just evaluated).
    let t = f((x - a.position[0]) / (b.position[0] - a.position[0]))
    let lo = 0, hi = 1
    for (let iteration = 0; iteration < 1000; iteration++) {
      const m34 = f((t - 1) * b.incoming[0] * t * t)
      const m38 = f((t - 1) * b.incoming[1])
      const m30 = f(m38 * t * t)
      const u = (t - 2) * t + 1
      const m2c = f(u * a.outgoing[0] * t)
      const m40 = f(u * a.outgoing[1])
      const m28 = f(m40 * t)
      const w = 3 - (t + t)
      const m24 = f(w * b.position[0] * t * t)
      const m48 = f(w * b.position[1])
      const m20 = f(m48 * t * t)
      const h1 = (2 * t - 3) * t * t + 1
      const m50 = f(h1 * a.position[1])
      const m5c = f(h1 * a.position[0] + m24 + m2c)
      const px = f(m5c + m34)
      y = f(m50 + m20 + m28 + m30)
      const next = f((hi + lo) * 0.5)
      if (px < x) lo = next
      if (px > x) hi = next
      t = next
      if (!(Math.abs(px - x) > 9.999999747378752e-06)) break
    }
  }
  if (y > 1) return 1
  if (y < 0) return 0
  return y
}

// ---------------------------------------------------------------------------
// CKCurve (CK2_3D.dll, vtable 0x10084238) and CKCurvePoint (vtable 0x10084488)
// ---------------------------------------------------------------------------
export interface OriginalCurvePointData {
  name: string
  /** CKCurvePoint tension/continuity/bias ([+0x1AC], [+0x1B0], [+0x1B4]). */
  tension: number
  continuity: number
  bias: number
  /** [+0x1F0]: the segment starting at this point is a straight line. */
  linear: boolean
  /** [+0x1EC] != 0: keep the saved tangents (never set by the shipped files). */
  savedTangents: boolean
  incoming: Vec3
  outgoing: Vec3
}
export interface OriginalCurveData {
  name: string
  /** [+0x1B4] == 0. A closed curve loops: Progression wraps. */
  closed: boolean
  /** [+0x1C0] fitting coefficient. */
  fitting: number
  points: OriginalCurvePointData[]
}

/** The VxVector pair CKCurve::GetPos returns (curve-local space). */
export interface CurveSample { position: Vec3; tangent?: Vec3 }

/**
 * CKCurve evaluation. `localPosition(i)` is `point_i->GetPosition(&p, curve)` (original units, float32):
 * when the curve is the point's parent it is the translation row of the point's LOCAL matrix.
 * The result of `getPos` is in the curve's own space; CKCurve::GetPos finishes with
 * `Vx3DMultiplyMatrixVector(out, curve.worldMatrix, p)` which `positionOnCurve` does.
 */
export class OriginalCurve {
  /** [+0x1B8]: total length. */
  length = 0
  private raw: Vec3[] = []        // CKCurvePoint [+0x1BC]
  private fitted: Vec3[] = []     // CKCurvePoint [+0x1E0]: the position GetPos and the lengths use
  private tangentIn: Vec3[] = []  // [+0x1C8]
  private tangentOut: Vec3[] = [] // [+0x1D4]
  private lengths: number[] = []  // [+0x1B8] of each point: cumulative length at its start
  private upToDate = false

  readonly data: OriginalCurveData
  private readonly localPosition: (point: number) => Vec3

  constructor(data: OriginalCurveData, localPosition: (point: number) => Vec3) {
    this.data = data
    this.localPosition = localPosition
  }

  /** CKObject::ModifyObjectFlags(0, 0x400): a point or the fitting changed. */
  invalidate() { this.upToDate = false }

  /** 0x1001603E: neighbour index for the closed/open curve. */
  private neighbour(i: number): number {
    const n = this.data.points.length
    if (i < 0) return this.data.closed ? (i + n) % n : 0
    if (i >= n) return this.data.closed ? i % n : n - 1
    return i
  }

  /** Curve vtable +0x1F0: Kochanek-Bartels tangents of point i, or the saved ones. */
  private tangentsOf(i: number): [Vec3, Vec3] {
    const point = this.data.points[i]!
    if (point.savedTangents) return [point.incoming, point.outgoing]
    const t = point.tension, c = point.continuity, b = point.bias
    const here = this.raw[i]!
    const behind = sub(here, this.raw[this.neighbour(i - 1)]!)  // [ebp-40h] = P - Pprev
    const ahead = sub(this.raw[this.neighbour(i + 1)]!, here)   // [ebp-0Ch] = Pnext - P
    const half = f(1 / 2)
    // outgoing (second pointer): 0.5 * ((1-t)(1+c)(1+b) * behind + (1-t)(1-c)(1-b) * ahead)
    const outgoing = scale(add(scale(behind, f((1 - t) * (1 + c) * (1 + b))), scale(ahead, f((1 - t) * (1 - c) * (1 - b)))), half)
    // incoming (first pointer): 0.5 * ((1-t)(1-c)(1+b) * behind + (1-t)(1+c)(1-b) * ahead)
    const incoming = scale(add(scale(behind, f((1 - t) * (1 - c) * (1 + b))), scale(ahead, f((1 - t) * (1 + c) * (1 - b)))), half)
    return [incoming, outgoing]
  }

  /** The cubic Hermite basis both Update and GetPos evaluate: ((Q1 + Q2) + Q3) + Q4, float32 steps. */
  private static hermite(start: Vec3, end: Vec3, startOut: Vec3, endIn: Vec3, t: number): Vec3 {
    const q4 = scale(scale(scale(endIn, f(t - 1)), t), t)
    const q3 = scale(scale(startOut, f((t - 2) * t + 1)), t)
    const q2 = scale(scale(scale(end, f(-2 * t + 3)), t), t)
    const q1 = scale(start, f((2 * t - 3) * t * t + 1))
    return add(add(add(q1, q2), q3), q4)
  }

  /** CKCurve::Update (0x1001586D), run lazily by GetPos when flag 0x400 is clear. */
  update() {
    const n = this.data.points.length
    this.raw = []
    this.fitted = []
    for (let i = 0; i < n; i++) {
      const p = this.localPosition(i)
      this.raw.push(p)
      this.fitted.push(p)
    }
    this.tangentIn = []
    this.tangentOut = []
    for (let i = 0; i < n; i++) {
      const [a, b] = this.tangentsOf(i)
      this.tangentIn.push(a)
      this.tangentOut.push(b)
    }
    if (this.data.fitting > 0) {
      // pull every point toward the midpoint of its neighbours by the coefficient (reads the unfitted copies)
      for (let i = 0; i < n; i++) {
        const mid = scale(add(this.raw[this.neighbour(i - 1)]!, this.raw[this.neighbour(i + 1)]!), f(1 / 2))
        this.fitted[i] = add(this.raw[i]!, scale(sub(mid, this.raw[i]!), this.data.fitting))
      }
    }
    this.length = 0
    this.lengths = new Array<number>(n).fill(0)
    const segments = this.data.closed ? n : n - 1
    if (n > 1) {
      for (let i = 0; i < segments; i++) {
        const start = this.fitted[i]!
        this.lengths[i] = this.length
        const next = i + 1 < n ? i + 1 : 0
        const end = this.fitted[next]!
        if (!this.data.points[i]!.linear) {
          let previous = start
          for (let k = 1; k <= 100; k++) {
            const u = f(k / 100)
            const current = OriginalCurve.hermite(start, end, this.tangentOut[i]!, this.tangentIn[next]!, u)
            this.length = f(this.length + magnitude(sub(current, previous)))
            previous = current
          }
        } else {
          this.length = f(this.length + magnitude(sub(end, start)))
        }
        if (i !== n - 1) this.lengths[next] = this.length
      }
    }
    this.upToDate = true
  }

  /**
   * CKCurve::GetPos(step, &pos, &tangent) (0x10014195), in the curve's space. Throws where the DLL
   * returns -1 (fewer than two control points).
   */
  getPos(input: number, wantTangent = false): CurveSample {
    if (!this.upToDate) this.update()
    const { closed, points } = this.data
    const n = points.length
    let step = f(input)
    if (!closed) {
      if (step > 1) step = 1
      if (step < 0) step = 0
    } else {
      if (step > 1) step = f(step - Math.trunc(step))
      while (step < 0) step = f(step + 1)
    }
    if (n <= 1) throw new Error(`CKCurve ${this.data.name} has ${n} control points (GetPos fails)`)
    const distance = f(step * this.length)
    let end = closed ? 0 : n - 1
    for (let k = 0; k < n; k++) {
      if (this.lengths[k]! > distance) { end = k; break }
    }
    let start = end - 1
    if (start < 0) start = closed ? n - 1 : 0
    const from = this.lengths[start]!
    const to = end === 0 ? this.length : this.lengths[end]!
    const span = f(to - from)
    const t = span !== 0 ? f((distance - from) / span) : 0
    const a = this.fitted[start]!, b = this.fitted[end]!
    if (points[start]!.linear) {
      const position = add(a, scale(sub(b, a), t))
      return wantTangent ? { position, tangent: sub(b, a) } : { position }
    }
    const position = OriginalCurve.hermite(a, b, this.tangentOut[start]!, this.tangentIn[end]!, t)
    if (!wantTangent) return { position }
    const next = OriginalCurve.hermite(a, b, this.tangentOut[start]!, this.tangentIn[end]!, f(t + f(0.01)))
    return { position, tangent: sub(next, position) }
  }
}

// ---------------------------------------------------------------------------
// CKObjectAnimation (CK2_3D.dll vtable 0x10086160): linear key controllers, SetStep
// ---------------------------------------------------------------------------
export interface OriginalAnimationController {
  track: 'position' | 'rotation' | 'scale' | 'scaleaxis'
  /** Only 'linear' is decoded; others fail when the animation is built. */
  interpolation: string
  keys: number
  /** Floats per key: time then the value (3 or 4). */
  stride: number
  data: number[]
}
export interface OriginalAnimationData {
  name: string
  /** The CK3dEntity the animation drives ([this+0x24]); NOT the behavior's owner. */
  entity: string
  /** [this+0x20]: 0x4 position, 0x8 rotation, 0x10 scale disabled; 0x80 merged. */
  flags: number
  /** Controller length in frames; SetStep multiplies the step by it. */
  length: number
  controllers: OriginalAnimationController[]
}

/**
 * CKLinearPositionController / CKLinearScaleController::Evaluate (0x1004B8DF) and
 * CKLinearRotationController::Evaluate (0x1004C150): clamp outside the keys, binary search
 * (`mid = (lo + hi) >> 1`, `lo = mid` while key[mid].time < time), then the fraction between the two keys.
 */
function segment(c: OriginalAnimationController, time: number): { a: number; b: number; fraction: number } | { clamp: number } {
  const n = c.keys, stride = c.stride, d = c.data
  const timeOf = (i: number) => d[i * stride]!
  if (!(time > timeOf(0))) return { clamp: 0 }
  if (!(time < timeOf(n - 1))) return { clamp: n - 1 }
  let lo = 0, hi = n - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (timeOf(mid) < time) lo = mid
    else hi = mid
  }
  const t0 = timeOf(hi - 1), t1 = timeOf(hi)
  return { a: hi - 1, b: hi, fraction: f((time - t0) / (t1 - t0)) }
}

export function evaluateLinearVector(c: OriginalAnimationController, time: number): Vec3 | undefined {
  if (c.keys <= 0) return undefined
  const value = (i: number): Vec3 => [c.data[i * 4 + 1]!, c.data[i * 4 + 2]!, c.data[i * 4 + 3]!]
  const s = segment(c, time)
  if ('clamp' in s) return value(s.clamp)
  const a = value(s.a)
  // p = a + (b - a) * fraction (0x1000C120, 0x10016890, 0x100132C0)
  return add(a, scale(sub(value(s.b), a), s.fraction))
}

/**
 * VxMath Slerp(Theta, Q1, Q2) (0x2429C8F0). The cosine is the x87 sum ((z.z + y.y) + x.x) + w.w, stored as a float;
 * a negative cosine flips Q2 (shortest arc); within 0.01 of parallel it blends linearly. The x and y results add the
 * unrounded `s0 * q1` to the rounded `s1 * q2`; z rounds both products; w adds the unrounded `s1 * q2.w`.
 */
export function vxSlerp(theta: number, q1: Quat, q2: Quat): Quat {
  const cosine = q1[2] * q2[2] + q1[1] * q2[1] + q1[0] * q2[0] + q2[3] * q1[3]
  let c = f(cosine)
  let s0: number, s1: number
  if (cosine >= 0) {
    if (!(1 - c > 0.01)) { s0 = 1 - theta; s1 = theta } else {
      const angle = Math.acos(c)
      const inverse = f(1 / Math.sin(angle))
      const angleF = f(angle)
      s0 = Math.sin((1 - theta) * angleF) * inverse
      s1 = Math.sin(angleF * theta) * inverse
    }
  } else {
    c = f(-c)
    if (!(1 - c > 0.01)) { s0 = 1 - theta; s1 = -theta } else {
      const angle = Math.acos(c)
      const inverse = f(1 / Math.sin(angle))
      const angleF = f(angle)
      s0 = Math.sin((1 - theta) * angleF) * inverse
      s1 = -(Math.sin(angleF * theta) * inverse)
    }
  }
  return [
    f(s0 * q1[0] + f(s1 * q2[0])),
    f(s0 * q1[1] + f(s1 * q2[1])),
    f(f(s0 * q1[2]) + f(s1 * q2[2])),
    f(f(s0 * q1[3]) + s1 * q2[3]),
  ]
}

export function evaluateLinearRotation(c: OriginalAnimationController, time: number): Quat | undefined {
  if (c.keys <= 0) return undefined
  const value = (i: number): Quat => [c.data[i * 5 + 1]!, c.data[i * 5 + 2]!, c.data[i * 5 + 3]!, c.data[i * 5 + 4]!]
  const s = segment(c, time)
  if ('clamp' in s) return value(s.clamp)
  return vxSlerp(s.fraction, value(s.a), value(s.b))
}

/**
 * VxQuaternion::ToMatrix (0x242836E0, SSE path 0x24283701): s = 2 / (x² + y² + z² + w²) is built with
 * `rcpps` and one Newton step, so a unit quaternion yields rows of length 1 - 2^-24, not 1. Row-vector
 * layout, translation row (0,0,0,1). `rcp` stands for the CPU's RCPPS approximation (UNVERIFIED: the table
 * differs between Intel and AMD); the default is the exact reciprocal, which gives s = 2 for unit quaternions.
 */
export function quaternionToMatrix(q: Quat, rcp: (n: number) => number = n => f(1 / n)): number[] {
  const [x, y, z, w] = q
  const x2 = f(x * x), y2 = f(y * y), z2 = f(z * z), w2 = f(w * w)
  const n = f(f(x2 + y2) + f(z2 + w2))
  const r = rcp(n)
  // xmm2 = r; xmm7 = (n*r)*r; xmm2 = (r + r) - xmm7; s = xmm2 + xmm2
  const refined = f(f(r + r) - f(f(n * r) * r))
  const s = f(refined + refined)
  const xs = f(x * s), ys = f(y * s), zs = f(z * s)
  const x2s = f(x2 * s), y2s = f(y2 * s), z2s = f(z2 * s)
  const xw = f(w * xs), yw = f(w * ys), zw = f(w * zs)
  const zx = f(zs * x), xy = f(xs * y), yz = f(ys * z)
  return [
    f(1 - f(y2s + z2s)), f(xy - zw), f(zx + yw), 0,
    f(xy + zw), f(1 - f(z2s + x2s)), f(yz - xw), 0,
    f(zx - yw), f(yz + xw), f(1 - f(x2s + y2s)), 0,
    0, 0, 0, 1,
  ]
}

/** 0x1000C230: ToMatrix, rows 0-2 times the scale components row by row, translation from `position`. */
export function composeLocalMatrix(position: Vec3, scaling: Vec3, rotation: Quat, rcp?: (n: number) => number): number[] {
  const m = quaternionToMatrix(rotation, rcp)
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) m[row * 4 + column] = f(m[row * 4 + column]! * scaling[row]!)
  m[12] = position[0]; m[13] = position[1]; m[14] = position[2]
  return m
}

/** CKAnimation flags (CKObjectAnimation [this+0x20]). */
const ANIMATION_POSITION_OFF = 0x04, ANIMATION_ROTATION_OFF = 0x08, ANIMATION_SCALE_OFF = 0x10, ANIMATION_MERGED = 0x80
/** CK_3DENTITY_IGNOREANIMATION: SetStep returns without touching an entity that has it. */
export const CK_3DENTITY_IGNOREANIMATION = 0x400

export type SetStepResult =
  | { applied: false }
  | { applied: true; kind: 'matrix'; matrix: number[] }
  | { applied: true; kind: 'translation'; position: Vec3 }

export class OriginalObjectAnimation {
  /** [this+0x28]: the last step handed to SetStep. */
  currentStep = 0
  private readonly tracks = new Map<string, OriginalAnimationController>()
  readonly data: OriginalAnimationData
  private readonly rcp: ((n: number) => number) | undefined

  constructor(data: OriginalAnimationData, rcp?: (n: number) => number) {
    this.data = data
    this.rcp = rcp
    if (data.flags & ANIMATION_MERGED) throw new Error(`Merged CKObjectAnimation ${data.name} is not decoded`)
    for (const controller of data.controllers) {
      if (controller.interpolation !== 'linear') throw new Error(`CKObjectAnimation ${data.name}: ${controller.interpolation} ${controller.track} keys are not decoded`)
      this.tracks.set(controller.track, controller)
    }
  }

  evaluatePosition(frame: number): Vec3 | undefined {
    if (this.data.flags & ANIMATION_POSITION_OFF) return undefined
    const c = this.tracks.get('position')
    return c ? evaluateLinearVector(c, frame) : undefined
  }
  evaluateScale(frame: number): Vec3 | undefined {
    if (this.data.flags & ANIMATION_SCALE_OFF) return undefined
    const c = this.tracks.get('scale')
    return c ? evaluateLinearVector(c, frame) : undefined
  }
  evaluateRotation(frame: number): Quat | undefined {
    if (this.data.flags & ANIMATION_ROTATION_OFF) return undefined
    const c = this.tracks.get('rotation')
    return c ? evaluateLinearRotation(c, frame) : undefined
  }

  /**
   * CKObjectAnimation::SetStep(step, NULL) (0x100578CA). `frame = float(step * length)` is the controllers' time
   * (keys are stored in frames). Position, rotation and scale all present: the entity's LOCAL matrix is
   * replaced (0x1000C230) and LocalMatrixChanged(FALSE, 0) follows. Position only writes the translation row.
   * Any other mix reads the missing parts back from the entity's matrix (0x1005695C) and is not decoded.
   */
  setStep(step: number, entityFlags: number): SetStepResult {
    this.currentStep = step
    const frame = f(step * this.data.length)
    if (entityFlags & CK_3DENTITY_IGNOREANIMATION) return { applied: false }
    const position = this.evaluatePosition(frame)
    const scaling = this.evaluateScale(frame)
    const rotation = this.evaluateRotation(frame)
    if (this.tracks.has('scaleaxis')) throw new Error(`CKObjectAnimation ${this.data.name} has a scale-axis track (not decoded)`)
    if (position && scaling && rotation) return { applied: true, kind: 'matrix', matrix: composeLocalMatrix(position, scaling, rotation, this.rcp) }
    if (position && !scaling && !rotation) return { applied: true, kind: 'translation', position }
    if (!position && !scaling && !rotation) return { applied: false }
    throw new Error(`CKObjectAnimation ${this.data.name}: partial track set needs the entity's current matrix (not decoded)`)
  }
}

// ---------------------------------------------------------------------------
// BehaviorFns
// ---------------------------------------------------------------------------
const number = (value: unknown) => typeof value === 'number' ? value : Number(value ?? 0)
const bool = (value: unknown) => typeof value === 'boolean' ? value : Number(value ?? 0) !== 0

function loaderOf(context: BehaviorContext): GraphContextBinding {
  if (!context.loader) throw new Error(`${context.node.name} ${context.node.index} needs the CK object context`)
  return context.loader
}

/**
 * 3DTransfo.dll Position On Curve (exec 0x25006CA0). Inputs 0 Curve, 1
 * Progression (0.5), 2 Follow, 3 Bank, 4 Bank Amount, 5 Direction, 6 Hierarchy
 * (TRUE). In off and Out first; the block never stays active. pos =
 * CKCurve::GetPos(Progression) in the curve's frame, through its world matrix,
 * then target->SetPosition(pos, NULL, KeepChildren = !Hierarchy). The Follow /
 * Bank orientation helper (0x2500AA80) is not decoded; no shipped instance uses it.
 * The fitted curve is kept while its points stay where they are (no point moves in MenuLevel).
 */
const positionOnCurve: BehaviorFn = (context, state) => {
  const loader = loaderOf(context)
  context.consumeInput(0)
  context.activate(0)
  const targetName = context.targetName()
  if (!targetName) throw new Error(`Position On Curve ${context.node.index} has no target (CKBR_OWNERERROR)`)
  const curveName = context.inputObject(0)
  if (!curveName) throw new Error(`Position On Curve ${context.node.index} has no curve (CKBR_PARAMETERERROR)`)
  if (bool(context.input(2)) || bool(context.input(3))) throw new Error(`Position On Curve ${context.node.index}: Follow/Bank (orientation helper 0x2500AA80) is not decoded`)
  const target = context.object(targetName)
  if (!target?.setPositionIn) throw new Error(`Position On Curve ${context.node.index} target ${targetName} cannot be placed`)
  let curve = state.curve as OriginalCurve | undefined
  if (!curve || state.curveName !== curveName) {
    const data = loader.curve(curveName)
    if (!data) throw new Error(`Position On Curve ${context.node.index}: ${curveName} is not a CKCurve in the context`)
    curve = new OriginalCurve({ name: curveName, closed: data.closed, fitting: data.fitting, points: data.points.map(point => ({ ...point, name: point.reference })) },
      index => loader.entityPosition(data.points[index]!.reference, curveName))
    state.curve = curve
    state.curveName = curveName
  }
  const local = curve.getPos(f(number(context.input(1)))).position
  const world = loader.matrix(curveName)
  if (!world) throw new Error(`Position On Curve ${context.node.index}: ${curveName} has no world matrix`)
  target.setPositionIn(authoredVectorToBinding(originalTransformPoint(world, local), context.coordinateScale), undefined, !bool(context.input(6)))
}

/**
 * 3DTransfo.dll Play Animation 3D Entity (exec 0x250073C0). Inputs 0
 * Animation, 1 Duration (ms), 2 Progression Curve, 3 Loop; output 0 and local 0
 * the progression. A duration under 0.001 returns at once. Off ends it. Each
 * run adds deltaMs / Duration; past 1 it fires One Loop Played and wraps (or,
 * without Loop, ends at 1). The step shaped by CK2dCurve::GetY goes to
 * CKObjectAnimation::SetStep, which replaces the driven entity's local matrix.
 */
const playAnimation3DEntity: BehaviorFn = (context, state) => {
  const loader = loaderOf(context)
  const animationName = context.inputObject(0)
  if (!animationName) throw new Error(`Play Animation 3D Entity ${context.node.index} has no animation (CKBR_PARAMETERERROR)`)
  const duration = f(number(context.input(1)))
  if (!(duration >= 0.001)) return
  const raw = context.inputRaw(2)
  if (!raw) throw new Error(`Play Animation 3D Entity ${context.node.index} has no exported Progression Curve`)
  if (state.curveRaw !== raw) { state.curveRaw = raw; state.progression = decodeOriginal2dCurve(raw) }
  const progression = state.progression as UfoCurvePoint[]
  const loop = bool(context.input(3))
  let step = f(number(context.local(0)))
  if (context.isInputActive(1)) { context.consumeInput(1); return }
  step = f(step + context.deltaMs / duration)
  const interpolate = (value: number) => {
    context.setLocal(0, value)
    context.setOutput(0, value)
    let animation = state.animation as OriginalObjectAnimation | undefined
    if (!animation || animation.data.name !== animationName) {
      const data = loader.animation(animationName)
      if (!data) throw new Error(`Play Animation 3D Entity ${context.node.index}: ${animationName} is not a CKObjectAnimation in the context`)
      animation = new OriginalObjectAnimation({ ...data, name: animationName })
      state.animation = animation
    }
    const result = animation.setStep(f(ck2dCurveGetY(progression, value)), loader.entityFlags(animation.data.entity))
    if (!result.applied) return
    if (result.kind !== 'matrix') throw new Error(`CKObjectAnimation ${animationName} writes only a translation, which is not ported`)
    loader.setLocalMatrix(animation.data.entity, result.matrix)
  }
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    interpolate(0)
    context.wait()
    return
  }
  if (step > 1) {
    context.activate(0)
    if (!loop) { interpolate(1); return }
    step = f(step - Math.trunc(step))
  }
  interpolate(step)
  context.wait()
}

export const CURVE_BEHAVIORS: BehaviorRegistry = {
  'Position On Curve': positionOnCurve,
  'Play Animation 3D Entity': playAnimation3DEntity,
}
