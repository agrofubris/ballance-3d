// GraphPhysicsBinding backed by the original IVP runtime. Points handed out by
// the host are already in the original body-local coordinates; forces use the
// native core-space convention (see ivp-bridge.ts).
//
// Placement and referential frames arrive in render units (SCALE applied, Z
// reflected) to mirror the Rapier binding. The IVP world keeps the original
// runtime's unit/axis convention, so the descriptors below forward those render
// poses/anchors unchanged: the host is responsible for the unit bridge until
// the engine wiring provides the original-unit world.
import * as THREE from 'three'
import { ORIGINAL_COLLISIONS, originalCollisionGroups } from './original-collisions.ts'
import { SCALE } from './original-data.ts'
import type { GraphForceSettings, GraphFrameBinding, GraphJointSettings, GraphPhysicsBinding, GraphPhysicsBody, GraphSpringSettings } from './original-graph-bindings.ts'
import type { IvpBodyDescriptor, IvpJointDescriptor, IvpSpringDescriptor, IvpWorld } from './ivp-bridge.ts'

const f = Math.fround
const FIXED_ANCHOR = 'FixCube Object'
const ALT_FIXED_ANCHOR = 'FixCube'

type Vector = [number, number, number]

/** Render-space pose, matching the Rapier host contract. */
export interface GraphIvpPhysicsPose {
  position: Vector
  rotation: [number, number, number, number]
  /** Authored 4x4 matrix in original units, retained for parity with Rapier. */
  matrix?: number[]
}

/** Named original bodies and hull meshes the binding resolves from the scene. */
export interface GraphIvpPhysicsHost {
  world: IvpWorld
  body(name: string): number | undefined
  /** Body-local points; `body` disambiguates hull meshes shared by targets. */
  hull(name: string, body?: string): Float32Array | undefined
  /** Body-local triangle soup (nine floats per face) for a concave mesh. */
  triangles?(name: string, body?: string): Float32Array | undefined
  /** A Physicalize created `body` for `name` with these settings. */
  register(name: string, body: number, settings?: GraphPhysicsBody): void
  unregister?(name: string): void
  /** Authored body placement in render units. */
  pose?(name: string): GraphIvpPhysicsPose | undefined
  /** Named authored referential frames; positions/axes in render units. */
  frame?(name: string): GraphFrameBinding | undefined
}

interface JointRecord {
  handle: number
  /** Named bodies the joint connects, used to remove it with either body. */
  bodies: string[]
}

interface SpringRecord {
  handle: number
  /** Fixed support body created because IVP springs need two bodies. */
  support?: number
  bodies: string[]
}

// Recovered Physicalize execution defaults (physics_RT.dll). The graph
// behavior normally supplies every value; these cover direct host callers.
const DEFAULTS = {
  mass: 1,
  friction: 0.4,
  restitution: 0.5,
  linearDamping: 0.1,
  angularDamping: 0.1,
}

const IDENTITY_POSE: GraphIvpPhysicsPose = { position: [0, 0, 0], rotation: [0, 0, 0, 1] }

function collisionGroupName(group: number): string {
  for (const name of ORIGINAL_COLLISIONS.identifiers) {
    if (originalCollisionGroups(name) === group) return name
  }
  throw new Error(`Unknown original collision group: ${group}`)
}

function bodyDescriptor(settings: GraphPhysicsBody, pose: GraphIvpPhysicsPose): IvpBodyDescriptor {
  return {
    // The host's hull points are body-local, so the descriptor only carries the
    // authored placement; the render pose is never pushed into the hulls.
    position: pose.position,
    rotation: pose.rotation,
    mass: settings.mass ?? DEFAULTS.mass,
    friction: settings.friction ?? DEFAULTS.friction,
    restitution: settings.elasticity ?? DEFAULTS.restitution,
    linearDamping: settings.linearDamping ?? DEFAULTS.linearDamping,
    angularDamping: settings.angularDamping ?? DEFAULTS.angularDamping,
    fixed: settings.fixed ?? false,
    collisionEnabled: settings.enableCollision ?? true,
    frozen: settings.startFrozen ?? false,
    ...(settings.collisionGroup !== undefined ? { collisionGroup: collisionGroupName(settings.collisionGroup) } : {}),
    ...(settings.massCenter !== undefined ? { massCenter: settings.massCenter } : {}),
  }
}

function vector(value: readonly number[] | undefined): Vector | undefined {
  if (!value || value.length < 3) return undefined
  return [f(value[0]!), f(value[1]!), f(value[2]!)]
}

function rotation(value: readonly number[] | undefined): [number, number, number, number] {
  if (!value || value.length < 4) return [0, 0, 0, 1]
  return [f(value[0]!), f(value[1]!), f(value[2]!), f(value[3]!)]
}

function quaternion(value: readonly number[]): THREE.Quaternion {
  const [x, y, z, w] = rotation(value)
  return new THREE.Quaternion(x, y, z, w)
}

function normalize(value: Vector, fallback: Vector): Vector {
  const squared = f(f(f(value[0] * value[0]) + f(value[1] * value[1])) + f(value[2] * value[2]))
  if (squared <= f(1e-12)) return fallback
  const length = f(Math.sqrt(squared))
  return [f(value[0] / length), f(value[1] / length), f(value[2] / length)]
}

function subtract(a: Vector, b: Vector): Vector {
  return [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])]
}

/** Rotate an authored vector by a referential and convert to render units. */
function frameOffset(frame: GraphFrameBinding, value: Vector, originalUnits: boolean): Vector {
  const point = new THREE.Vector3(value[0], value[1], value[2]).applyQuaternion(quaternion(frame.rotation))
  if (originalUnits) return [point.x, point.y, point.z]
  point.multiplyScalar(SCALE)
  point.z *= -1
  return [f(point.x), f(point.y), f(point.z)]
}

/** Full frame transform (including scale and world origin) for spring/force anchors. */
function frameAnchor(frame: GraphFrameBinding, value: Vector, originalUnits: boolean): Vector {
  if (frame.matrix?.length === 16) {
    const point = new THREE.Vector3(value[0], value[1], value[2]).applyMatrix4(new THREE.Matrix4().fromArray(frame.matrix))
    if (originalUnits) return [point.x, point.y, point.z]
    point.multiplyScalar(SCALE)
    point.z *= -1
    return [f(point.x), f(point.y), f(point.z)]
  }
  const offset = frameOffset(frame, value, originalUnits)
  return [frame.position[0] + offset[0], frame.position[1] + offset[1], frame.position[2] + offset[2]]
}

/** Rotate an authored direction by a referential; SCALE does not affect a direction. */
function frameDirection(frame: GraphFrameBinding, value: Vector, originalUnits: boolean): Vector {
  if (originalUnits && frame.matrix?.length === 16) {
    const direction = new THREE.Vector3(value[0], value[1], value[2]).transformDirection(new THREE.Matrix4().fromArray(frame.matrix))
    return [direction.x, direction.y, direction.z]
  }
  const direction = new THREE.Vector3(value[0], value[1], value[2]).applyQuaternion(quaternion(frame.rotation))
  if (!originalUnits) direction.z *= -1
  return normalize([direction.x, direction.y, direction.z], [1, 0, 0])
}

/** The frame's render-space axis, falling back to its local Z (then world +Z). */
function frameAxis(frame: GraphFrameBinding, originalUnits: boolean): Vector {
  if (originalUnits && frame.matrix?.length === 16) {
    const axis = new THREE.Vector3().setFromMatrixColumn(new THREE.Matrix4().fromArray(frame.matrix), 2).normalize()
    return [axis.x, axis.y, axis.z]
  }
  const authored = originalUnits && frame.axis
    ? [frame.axis[0], frame.axis[1], frame.axis[2]] as Vector
    : vector(frame.axis)
  if (authored) return normalize(authored, [0, 0, 1])
  const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion(frame.rotation))
  if (!originalUnits) axis.z *= -1
  return normalize([axis.x, axis.y, axis.z], [0, 0, 1])
}

function degrees(value: number): number {
  return f(f(value) * f(Math.PI / 180))
}

function fixedAnchor(name: string | undefined): boolean {
  return name === undefined || name.length === 0 || name === FIXED_ANCHOR || name === ALT_FIXED_ANCHOR
}

export interface IvpGraphPhysicsBindingOptions {
  /** The native world and host already use original units and axes. */
  originalUnits?: boolean
  /** Script frames to defer authored force creation (IVP force is persistent). */
  startupFrames?: number
  /**
   * Object2 `FixCube Object` is the module's physicalized FixCube body: the
   * hinge, slider and spring handlers constrain against
   * `GetPhysicsObject(Object2)->m_RealObject` (physics_RT 0x100059d0,
   * 0x10005f10, 0x10006490). Without it a fixed anchor is the IVP world.
   */
  physicalAnchors?: boolean
}

export class IvpGraphPhysicsBinding implements GraphPhysicsBinding {
  private host: GraphIvpPhysicsHost
  private readonly originalUnits: boolean
  private readonly physicalAnchors: boolean
  private forces = new Map<string, number>()
  private forceTargets = new Map<string, number>()
  private forceControllers = new Map<string, number | string>()
  private joints = new Map<string, JointRecord>()
  private springs = new Map<string, SpringRecord>()
  private poses = new Map<string, GraphIvpPhysicsPose>()
  /** The hulls each body was built from (the authored convex count). */
  private readonly hulls = new Map<string, number>()
  /** Bodies removed when the host has no `unregister`, so a stale map entry is ignored. */
  private removed = new Set<string>()
  private startupFrames: number
  private readonly pendingForces = new Map<string, { name: string; settings: GraphForceSettings }>()

  constructor(host: GraphIvpPhysicsHost, options: IvpGraphPhysicsBindingOptions = {}) {
    this.host = host
    this.originalUnits = options.originalUnits ?? false
    this.startupFrames = options.startupFrames ?? 0
    this.physicalAnchors = options.physicalAnchors ?? false
  }

  /** Persistent force controllers currently installed. */
  debugForceCount(): number {
    return this.forces.size
  }

  /** Authored joints currently installed, optionally for one target. */
  debugJointCount(name?: string): number {
    if (name === undefined) return this.joints.size
    return [...this.joints.keys()].filter(key => key.split(':')[1] === name).length
  }

  /** The created hull count of an installed body (1 for a ball, the authored convex count otherwise). */
  debugHullCount(name: string): number | undefined {
    return this.hulls.get(name)
  }

  /** Persistent force controller keys (`<target>:<controller>`) currently installed. */
  debugForceKeys(): string[] {
    return [...this.forces.keys()]
  }

  physicalize(name: string, settings: GraphPhysicsBody): void {
    const existing = this.lookup(name)
    if (existing !== undefined) {
      this.host.world.wake(existing)
      return
    }
    const concave = settings.concave ?? []
    const balls = settings.balls ?? []
    if (balls.length > 1) throw new Error(`Physicalize ${name} has ${balls.length} balls, which is not recovered`)
    if (balls.length === 0 && concave.length > 0 && (settings.hulls?.length ?? 0) > 0) throw new Error(`Physicalize ${name} has both convex and concave surfaces, which is not recovered`)
    if (balls.length === 0 && concave.length === 0 && (!settings.hulls || settings.hulls.length === 0)) throw new Error(`Missing IVP hulls for ${name}`)
    const supplied = this.host.pose?.(name)
    const pose: GraphIvpPhysicsPose = supplied
      ? this.originalUnits
        ? { position: [supplied.position[0], supplied.position[1], supplied.position[2]], rotation: [supplied.rotation[0], supplied.rotation[1], supplied.rotation[2], supplied.rotation[3]] }
        : { position: vector(supplied.position) ?? [0, 0, 0], rotation: rotation(supplied.rotation) }
      : this.poses.get(name) ?? IDENTITY_POSE
    const descriptor = bodyDescriptor(settings, pose)
    let body: number
    if (balls.length > 0) {
      // physics_RT.dll's ball branch (0x100023F7 -> 0x100075D0) creates an
      // IVP_Ball (0x10013A10 -> 0x10030010) at the target's pose. Its authored
      // position is the template's mass-center override, zero in every graph.
      const ball = balls[0]!
      if (!(ball.radius > 0)) throw new Error(`Invalid IVP ball radius ${ball.radius} for ${name}`)
      if (ball.position.some(component => component !== 0)) throw new Error(`Physicalize ${name} has a nonzero ball position, which is not recovered`)
      body = this.host.world.sphere(ball.radius, descriptor)
    } else if (concave.length > 0) {
      // A concave Physicalize is a ledge soup of the authored faces, not a
      // convex hull of their vertices (physics_RT.dll 0x100076F0).
      if (!this.host.triangles) throw new Error(`The IVP host cannot build the concave Physicalize ${name}`)
      const triangles: number[] = []
      for (const mesh of concave) {
        const vertices = this.host.triangles(mesh, name)
        if (vertices === undefined) throw new Error(`Missing IVP concave mesh ${mesh}`)
        if (vertices.length % 9 !== 0) throw new Error(`Invalid IVP concave mesh ${mesh}`)
        triangles.push(...vertices)
      }
      body = this.host.world.triangles(Float32Array.from(triangles), descriptor)
    } else {
      const points = settings.hulls!.map(hull => {
        const vertices = this.host.hull(hull, name)
        if (vertices === undefined) throw new Error(`Missing IVP hull ${hull}`)
        return vertices
      })
      // One ledge-soup surface for every hull count: the bridge's convex and
      // compound paths make the same IVP calls for a single hull.
      body = this.host.world.compound(points, descriptor)
    }
    this.host.register(name, body, settings)
    this.removed.delete(name)
    this.poses.set(name, pose)
    this.hulls.set(name, balls.length > 0 || concave.length > 0 ? 1 : settings.hulls!.length)
  }

  unphysicalize(name: string): void {
    // The original's delete_silently destroys the body and its controllers.
    this.destroyForcesFor(name)
    this.removeSpringsFor(name)
    this.removeJointsFor(name)
    const body = this.lookup(name)
    if (body !== undefined) {
      this.host.world.remove(body)
      if (this.host.unregister) this.host.unregister(name)
      else this.removed.add(name)
    }
    this.poses.delete(name)
    this.hulls.delete(name)
  }

  force(name: string, settings: GraphForceSettings): void {
    const key = this.forceKey(name, settings)
    if (settings.create) {
      if (this.startupFrames > 0) {
        this.pendingForces.set(key, { name, settings })
        return
      }
      // SetPhysicsForce's queued pre-simulate handler (physics_RT.dll
      // 0x10004930) looks the target's PhysicsObject up with FUN_10007800
      // (0x10007800); the null check at 0x100049D6-0x100049E4 returns before
      // the controller is allocated and before local 0 is written, so a force
      // requested while the target has no body is dropped, not kept for the
      // later physicalization. The destroy branch needs no body either: it
      // only deletes an existing local 0 handle (0x100048D6-0x10004905).
      const body = this.lookup(name)
      if (body === undefined) return
      // The native controller creation is idempotent while it targets the same
      // body; a target change (player material swap/respawn) must destroy the
      // old controller first.
      if (this.forces.has(key)) {
        if (this.forceTargets.get(key) === body) return
        this.destroyForceKey(key)
      }
      const controller = settings.controller ?? 'default'
      for (const [existingKey, existingController] of this.forceControllers) {
        if (existingKey !== key && existingController === controller) this.destroyForceKey(existingKey)
      }
      const directionRef = settings.directionRef === 'Direction Ref' ? undefined : settings.directionRef
      const directionFrame = directionRef ? this.referential(directionRef, `force ${name} direction`) : undefined
      let direction = vector(settings.direction) ?? [1, 0, 0]
      if (directionFrame) direction = frameDirection(directionFrame, direction, this.originalUnits)
      // Without a referential, or in the target's own frame, the authored point
      // stays body-local. Resolving the static authored frame would pin a
      // later-created drive to the body's initial world origin. A distinct
      // external referential is a fixed world point, like the ending's ropes.
      const positionFrame = settings.positionRef && settings.positionRef !== name
        ? this.referential(settings.positionRef, `force ${name} position`)
        : undefined
      const position = positionFrame
        ? frameAnchor(positionFrame, vector(settings.position) ?? [0, 0, 0], this.originalUnits)
        : vector(settings.position) ?? [0, 0, 0]
      const handle = this.host.world.force({
        body,
        position,
        positionSpace: positionFrame ? 'world' : 'core',
        // The bridge normalizes and falls back to (1,0,0) like the original.
        direction,
        value: settings.value ?? 10,
      })
      this.forces.set(key, handle)
      this.forceTargets.set(key, body)
      this.forceControllers.set(key, controller)
      return
    }
    this.pendingForces.delete(key)
    this.destroyForceKey(key)
  }

  /** Drop persistent controllers when the host replaces the player body. */
  detach(): void {
    for (const key of [...this.forces.keys()]) this.destroyForceKey(key)
    this.pendingForces.clear()
  }

  step(): void {
    if (this.startupFrames <= 0) return
    this.startupFrames--
    if (this.startupFrames > 0) return
    for (const { name, settings } of this.pendingForces.values()) this.force(name, settings)
    this.pendingForces.clear()
  }

  beginStartup(frames = 1): void {
    this.pendingForces.clear()
    this.startupFrames = frames
  }

  joint(kind: 'hinge' | 'slider' | 'ballSocket', name: string, settings: GraphJointSettings): void {
    const reference = this.requireBody(name)
    const frame = settings.referential ? this.referential(settings.referential, `${kind} ${name}`) : undefined
    const frame2 = kind === 'slider' && settings.referential2
      ? this.referential(settings.referential2, `slider ${name} axis`)
      : undefined
    const pose = this.poses.get(name) ?? IDENTITY_POSE
    const pivot: Vector = frame
      ? this.originalUnits
        ? [frame.position[0], frame.position[1], frame.position[2]]
        : vector(frame.position) ?? [0, 0, 0]
      : pose.position
    let axis: Vector = [0, 0, 1]
    if (kind === 'hinge' && frame) axis = frameAxis(frame, this.originalUnits)
    if (kind === 'slider' && frame && frame2) {
      if (this.originalUnits) {
        // Set Physics Slider (physics_RT 0x10005f10) subtracts the two float
        // positions on the x87 stack; y and z are stored as floats first, x goes
        // to the double axis straight from the register. The axis is not
        // normalized: set_constraint_ws normalizes it.
        axis = [
          f(frame2.position[0]) - f(pivot[0]),
          f(f(frame2.position[1]) - f(pivot[1])),
          f(f(frame2.position[2]) - f(pivot[2])),
        ]
      } else {
        const second = vector(frame2.position) ?? [0, 0, 0]
        axis = normalize(subtract(second, pivot), axis)
      }
    }
    let attached = 0
    const otherName = this.anchorName(settings.object2)
    const key = this.jointKey(kind, name, settings)
    this.destroyJointKey(key)
    if (otherName !== undefined) {
      const other = this.lookup(otherName)
      if (other === undefined) throw new Error(`Missing IVP joint body ${otherName}`)
      if (other === reference) throw new Error(`Joint ${kind} for ${name} cannot target itself`)
      attached = other
    }
    const descriptor: IvpJointDescriptor = {
      kind,
      reference,
      attached,
      anchor: pivot,
      ...(kind === 'ballSocket' ? {} : { axis }),
      ...(settings.limitsEnabled && kind !== 'ballSocket'
        ? {
            limits: (kind === 'hinge'
              ? [degrees(settings.lowerLimit ?? 0), degrees(settings.upperLimit ?? 0)]
              : this.originalUnits
                ? [f(settings.lowerLimit ?? 0), f(settings.upperLimit ?? 0)]
                : [f(f(settings.lowerLimit ?? 0) * f(SCALE)), f(f(settings.upperLimit ?? 0) * f(SCALE))]) as [number, number],
          }
        : {}),
    }
    const handle = this.host.world.joint(descriptor)
    this.joints.set(key, {
      handle,
      bodies: otherName === undefined ? [name] : [name, otherName],
    })
  }

  /** The Object2 body name, or undefined for the IVP world (a fixed anchor outside a session). */
  private anchorName(object2: string | undefined): string | undefined {
    if (!fixedAnchor(object2)) return object2!
    if (!this.physicalAnchors) return undefined
    if (!object2) throw new Error('A physics constraint has no Object2; the shipped modules always name FixCube Object')
    return object2
  }

  private jointKey(kind: string, name: string, settings: GraphJointSettings): string {
    return `${kind}:${name}:${settings.controller ?? ''}:${settings.object2 ?? ''}:${settings.referential ?? ''}:${settings.referential2 ?? ''}`
  }

  private destroyJointKey(key: string) {
    const record = this.joints.get(key)
    if (!record) return
    this.joints.delete(key)
    this.host.world.removeJoint(record.handle)
  }

  destroyJoint(kind: 'hinge' | 'slider' | 'ballSocket', name: string, controller?: number): void {
    const prefix = controller === undefined ? `${kind}:${name}:` : `${kind}:${name}:${controller}:`
    for (const key of [...this.joints.keys()]) {
      if (key.startsWith(prefix)) this.destroyJointKey(key)
    }
  }

  wake(name: string): void {
    // Physics WakeUp's queued command (physics_RT.dll 0x10004DE0) looks the
    // target's PhysicsObject up with FUN_10007800 (0x10007800) and returns
    // without waking when there is none (0x10004DFA/0x10004DFF): a target
    // entity without an IVP body is a no-op, not an error.
    const body = this.lookup(name)
    if (body === undefined) return
    this.host.world.wake(body)
  }

  spring(name: string, settings: GraphSpringSettings): void {
    if (!settings.create) {
      this.destroySpring(name)
      return
    }
    const reference = this.requireBody(name)
    const frame1 = settings.referential1 ? this.referential(settings.referential1, `spring ${name} anchor 1`) : undefined
    const frame2 = settings.referential2 ? this.referential(settings.referential2, `spring ${name} anchor 2`) : undefined
    const anchor1 = frame1
      ? frameAnchor(frame1, vector(settings.position1) ?? [0, 0, 0], this.originalUnits)
      : vector(settings.position1) ?? [0, 0, 0]
    const otherName = this.anchorName(settings.object2)
    let attached: number
    let anchor2: Vector
    let support: number | undefined
    if (otherName !== undefined) {
      const other = this.lookup(otherName)
      if (other === undefined) throw new Error(`Missing IVP spring body ${otherName}`)
      if (other === reference) throw new Error(`Spring for ${name} cannot target itself`)
      attached = other
      anchor2 = frame2
        ? frameAnchor(frame2, vector(settings.position2) ?? [0, 0, 0], this.originalUnits)
        : vector(settings.position2) ?? [0, 0, 0]
    } else {
      // Outside a session there is no FixCube body, and IVP springs need a real
      // body on both ends, so a fixed support stands in for the world.
      anchor2 = frame2
        ? frameAnchor(frame2, vector(settings.position2) ?? [0, 0, 0], this.originalUnits)
        : vector(settings.position2) ?? [0, 0, 0]
      support = this.host.world.sphere(0.1, {
        position: anchor1,
        mass: 1,
        friction: 0,
        restitution: 0,
        linearDamping: 0,
        angularDamping: 0,
        fixed: true,
        collisionEnabled: false,
      })
      attached = support
    }
    const descriptor: IvpSpringDescriptor = {
      reference,
      attached,
      anchor1,
      anchor2,
      length: this.originalUnits ? f(settings.length ?? 0) : f(f(settings.length ?? 0) * f(SCALE)),
      constant: settings.constant ?? 0,
      axialDamping: settings.axialDamping ?? 0,
      globalDamping: settings.globalDamping ?? 0,
    }
    this.destroySpring(name)
    let handle: number
    try {
      handle = this.host.world.spring(descriptor)
    } catch (error) {
      if (support !== undefined) this.host.world.remove(support)
      throw error
    }
    this.springs.set(name, {
      handle,
      ...(support !== undefined ? { support } : {}),
      bodies: otherName === undefined ? [name] : [name, otherName],
    })
  }

  private referential(name: string, context: string): GraphFrameBinding | undefined {
    if (!this.host.frame) return undefined
    const frame = this.host.frame(name)
    if (!frame) throw new Error(`Missing referential ${name} for ${context}`)
    return frame
  }

  private forceKey(name: string, settings: GraphForceSettings): string {
    return `${name}:${settings.controller ?? 'default'}`
  }

  private destroyForceKey(key: string): void {
    this.forceTargets.delete(key)
    this.forceControllers.delete(key)
    const handle = this.forces.get(key)
    if (handle === undefined) return
    this.forces.delete(key)
    this.host.world.removeForce(handle)
  }

  private destroyForcesFor(name: string): void {
    const prefix = `${name}:`
    for (const key of [...this.forces.keys()]) if (key.startsWith(prefix)) this.destroyForceKey(key)
  }

  private destroySpring(name: string): void {
    const record = this.springs.get(name)
    if (!record) return
    this.springs.delete(name)
    this.host.world.removeSpring(record.handle)
    if (record.support !== undefined) this.host.world.remove(record.support)
  }

  private removeJointsFor(name: string): void {
    for (const [key, record] of [...this.joints]) {
      if (!record.bodies.includes(name)) continue
      this.joints.delete(key)
      this.host.world.removeJoint(record.handle)
    }
  }

  private removeSpringsFor(name: string): void {
    for (const [key, record] of [...this.springs]) {
      if (!record.bodies.includes(name)) continue
      this.springs.delete(key)
      this.host.world.removeSpring(record.handle)
      if (record.support !== undefined) this.host.world.remove(record.support)
    }
  }

  private lookup(name: string): number | undefined {
    return this.removed.has(name) ? undefined : this.host.body(name)
  }

  private requireBody(name: string): number {
    const body = this.lookup(name)
    if (body === undefined) throw new Error(`Missing IVP body ${name}`)
    return body
  }
}
