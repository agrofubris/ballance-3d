import * as THREE from 'three'

export interface UfoRotationKey {
  time: number
  rotation: readonly number[]
  tension: number
}

export interface UfoCurvePoint {
  flags: number
  position: readonly number[]
  incoming: readonly number[]
  outgoing: readonly number[]
}

const NEAR_ZERO = 1e-10
const LINEAR_FLAG = 2

type Controls = { incoming: THREE.Quaternion; outgoing: THREE.Quaternion }

/** Logarithm of the relative rotation from one quaternion to another, as a rotation vector. */
function rotationLog(from: THREE.Quaternion, to: THREE.Quaternion): THREE.Vector3 {
  const relative = new THREE.Quaternion().copy(from).conjugate().multiply(to).normalize()
  const length = Math.sqrt(relative.x * relative.x + relative.y * relative.y + relative.z * relative.z)
  const scale = length > NEAR_ZERO ? Math.atan2(length, relative.w) / length : 1
  return new THREE.Vector3(relative.x, relative.y, relative.z).multiplyScalar(scale)
}

/** Exponential of a rotation vector, returned as an unnormalised quaternion. */
function rotationExp(vector: THREE.Vector3): THREE.Quaternion {
  const angle = vector.length()
  const scale = angle > NEAR_ZERO ? Math.sin(angle) / angle : 1
  return new THREE.Quaternion(vector.x * scale, vector.y * scale, vector.z * scale, Math.cos(angle))
}

function toQuaternion(values: readonly number[]): THREE.Quaternion {
  return new THREE.Quaternion(values[0], values[1], values[2], values[3]).normalize()
}

/** Keyed rotation track with TCB-style tangents, sampled by slerp along the authored curve. */
export class UfoRotationTrack {
  private readonly keys: readonly UfoRotationKey[]
  private readonly rotations: THREE.Quaternion[]
  private readonly controls: Controls[]

  constructor(keys: readonly UfoRotationKey[]) {
    this.keys = keys
    this.rotations = keys.map(key => toQuaternion(key.rotation))
    this.controls = keys.map((_, index) => this.tangentsAt(index))
  }

  private tangentsAt(index: number): Controls {
    const { keys, rotations } = this
    const current = rotations[index]!
    const hasBefore = index > 0
    const hasAfter = index < keys.length - 1
    const before = hasBefore ? this.alignedTo(rotations[index - 1]!, current) : undefined
    const after = hasAfter ? this.alignedTo(rotations[index + 1]!, current) : undefined
    const a = before ? rotationLog(before, current) : rotationLog(current, after!)
    const b = after ? rotationLog(current, after) : a.clone()
    const span = hasBefore && hasAfter ? keys[index + 1]!.time - keys[index - 1]!.time : 0
    const left = hasBefore && hasAfter ? 2 * (keys[index]!.time - keys[index - 1]!.time) / span : 1
    const right = hasBefore && hasAfter ? 2 * (keys[index + 1]!.time - keys[index]!.time) / span : 1
    const factor = (1 - keys[index]!.tension) * 0.5
    const incomingVector = a.clone().multiplyScalar((1 - factor * left) * 0.5)
      .add(b.clone().multiplyScalar(-factor * left * 0.5))
    const outgoingVector = a.clone().multiplyScalar(factor * right * 0.5)
      .add(b.clone().multiplyScalar((factor * right - 1) * 0.5))
    return {
      incoming: new THREE.Quaternion().copy(current).multiply(rotationExp(incomingVector)),
      outgoing: new THREE.Quaternion().copy(current).multiply(rotationExp(outgoingVector)),
    }
  }

  private alignedTo(neighbour: THREE.Quaternion, current: THREE.Quaternion): THREE.Quaternion {
    if (current.dot(neighbour) >= 0) return neighbour.clone()
    return new THREE.Quaternion(-neighbour.x, -neighbour.y, -neighbour.z, -neighbour.w)
  }

  sample(time: number): THREE.Quaternion {
    const { keys, rotations, controls } = this
    const first = keys[0]!
    const last = keys[keys.length - 1]!
    if (time <= first.time) return rotations[0]!.clone()
    if (time >= last.time) return rotations[rotations.length - 1]!.clone()
    const end = keys.findIndex(key => key.time > time)
    const start = end - 1
    const t = (time - keys[start]!.time) / (keys[end]!.time - keys[start]!.time)
    const outer = new THREE.Quaternion().copy(rotations[start]!).slerp(rotations[end]!, t)
    const inner = new THREE.Quaternion().copy(controls[start]!.outgoing).slerp(controls[end]!.incoming, t)
    return new THREE.Quaternion().copy(outer).slerp(inner, 2 * t * (1 - t)).normalize()
  }
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1)

/** Value of the authored progress curve at the given progress (clamped to [0, 1]). */
export function ufoCurve(points: readonly UfoCurvePoint[], progress: number): number {
  const x = clamp01(progress)
  const end = points.findIndex((point, index) => index > 0 && point.position[0]! >= x)
  if (end < 0) return points.at(-1)!.position[1]!
  const a = points[end - 1]!
  const b = points[end]!
  if (x === a.position[0]) return a.position[1]!
  if (x === b.position[0]) return b.position[1]!
  if (a.flags & LINEAR_FLAG) {
    return a.position[1]! + (b.position[1]! - a.position[1]!) * (x - a.position[0]!) / (b.position[0]! - a.position[0]!)
  }
  let low = 0
  let high = 1
  let y = 0
  for (let iteration = 0; iteration < 100; iteration++) {
    const t = (low + high) * 0.5
    const t2 = t * t
    const t3 = t2 * t
    const h0 = 2 * t3 - 3 * t2 + 1
    const h1 = -2 * t3 + 3 * t2
    const h2 = t3 - 2 * t2 + t
    const h3 = t3 - t2
    const hermite = (axis: number) =>
      h0 * a.position[axis]! + h1 * b.position[axis]! + h2 * a.outgoing[axis]! + h3 * b.incoming[axis]!
    const sample = hermite(0)
    y = hermite(1)
    if (Math.abs(sample - x) < 1e-5) break
    if (sample < x) low = t
    else high = t
  }
  return clamp01(y)
}
