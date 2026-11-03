import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import type { GraphForceSettings, GraphFrameBinding, GraphJointSettings, GraphPhysicsBinding, GraphPhysicsBody, GraphSpringSettings } from './original-graph-bindings.ts'
import { SCALE } from './original-data.ts'
import { applyOriginalConvexMass, hasOriginalConvexMass, ORIGINAL_OBJECT_INERTIA, ORIGINAL_FRAGMENT_INERTIA } from './original-inertia.ts'
import { originalInertiaKey } from './original-inertia-frame.ts'
import { configureBody, configureContact, ORIGINAL_PSI_HZ, ORIGINAL_TIME_FACTOR } from './original-physics.ts'
import type { Material } from './levels.ts'
import { replacePlayerCollider } from './original-player.ts'
import { springImpulse } from './original-spring.ts'
import type { SpringCoefficients } from './original-spring.ts'

const f = Math.fround

const DEFAULT_FRICTION = f(0.4)
const DEFAULT_ELASTICITY = f(0.5)
const DEFAULT_MASS = f(1)
const DEFAULT_LINEAR_DAMPING = f(0.1)
const DEFAULT_ANGULAR_DAMPING = f(0.1)
const DEFAULT_FORCE = f(10)
const FORCE_DIRECTION_EPSILON = f(1e-4)
const FIXED_ANCHOR = 'FixCube Object'
const ALT_FIXED_ANCHOR = 'FixCube'

/** Activation install order used by the removed hand-ports: hinges, then sliders. */
function jointOrder(kind: 'hinge' | 'slider' | 'ballSocket') {
  return kind === 'hinge' ? 0 : kind === 'slider' ? 1 : 2
}

interface Vector { x: number; y: number; z: number }
interface Rotation { x: number; y: number; z: number; w: number }
interface ActiveForce {
  name: string
  body: RAPIER.RigidBody
  direction: Vector
  position: Vector
  /** The position is a fixed world point rather than body-local. */
  world: boolean
  value: number
  /** Authored controller node; one controller can retarget a new body/name. */
  controller: number | string
  /** Script frame that created the controller; IVP applies it from the next tick. */
  createdFrame: number
}

interface StoredPose {
  position: Vector
  rotation: Rotation
  /** Authored 4x4 matrix in original units, used for inertia/frame transforms. */
  matrix?: number[]
}

interface JointRecord {
  joint: RAPIER.ImpulseJoint
  /** Fixed support body created by the binding, when Object2 is the world. */
  support?: RAPIER.RigidBody
  /** Named bodies the joint connects, used to remove it with either body. */
  bodies: string[]
}

interface SpringRecord {
  body: RAPIER.RigidBody
  /** Second body for a body-to-body spring; a fixed point is used otherwise. */
  body2?: RAPIER.RigidBody
  anchor1: Vector
  anchor2?: Vector
  fixed?: Vector
  coefficients: SpringCoefficients
  bodies: string[]
}

/** Render-space pose plus the authored original-units matrix for inertias. */
export interface GraphRapierPhysicsPose {
  position: [number, number, number]
  rotation: [number, number, number, number]
  matrix?: number[]
}

export interface GraphRapierPhysicsHost {
  world: RAPIER.World
  /** Shared fixed body used by all world joints, matching some hand-ports. */
  fixedBody?: RAPIER.RigidBody
  /** Per-module shared fixed joint anchor (the engine's sharedAnchor modules). */
  fixedBodyFor?(name: string): RAPIER.RigidBody | undefined
  body(name: string): RAPIER.RigidBody | undefined
  /**
   * Body-local convex points in render units (SCALE applied, Z reflected).
   * `body` disambiguates a hull mesh shared by differently-rotated bodies.
   */
  hull(name: string, body?: string): Float32Array | undefined
  /** Body-local triangle soup (nine floats per face) for a concave mesh. */
  triangles?(name: string, body?: string): Float32Array | undefined
  /**
   * The authored mesh name of a hull target, for the recovered inertia table.
   * A session graph remaps object parameters to references (`#<id>`), while the
   * measurements are keyed by the exported mesh names.
   */
  hullName?(name: string): string
  /** The engine binding enables this only for the ending's PE_Balloon modules. */
  singleHullColliderMass?(name: string): boolean
  /** Resolve a name used beside `target` to that same module copy (copies share local names). */
  resolveSibling?(target: string, name: string): string
  /** Whether an Object2 target is the authored world anchor (a context `FixCube` reference). */
  isFixedAnchor?(name: string): boolean
  /** Use the target's authored rotation and body-local hulls (its collider mesh is authored in the body frame). */
  bodyUsesAuthoredPose?(name: string): boolean
  /** Per-target overrides of the engine's module-family options (OriginalGraphModuleInstance). */
  releaseFrozenOnWake?(name: string): boolean
  releaseFrozenAwake?(name: string): boolean
  /** Whether the frozen bodies of `other` belong to the waking target's module family. */
  sameModule?(name: string, other: string): boolean
  authoredAnchors?(name: string): boolean
  wakeJoints?(name: string): boolean
  deferWakeImpulses?(name: string): boolean
  deferNewForceImpulse?(name: string): boolean
  additionalSolverIterations?(name: string): number
  /**
   * The engine player's material when this Physicalize target is the active
   * ball. The host then builds the engine's player body (see original-player.ts)
   * instead of a generic authored body.
   */
  player?(name: string): Material | undefined
  register(name: string, body: RAPIER.RigidBody, settings?: GraphPhysicsBody): void
  unregister?(name: string): void
  /** Authored body placement; `matrix` is in original units. */
  pose?(name: string): GraphRapierPhysicsPose | undefined
  /** Named authored referential frames; positions/axes in render units. */
  frame?(name: string): GraphFrameBinding | undefined
}

function material(settings: GraphPhysicsBody) {
  return {
    mass: f(settings.mass ?? DEFAULT_MASS),
    friction: f(settings.friction ?? DEFAULT_FRICTION),
    restitution: f(settings.elasticity ?? DEFAULT_ELASTICITY),
    linearDamping: f(settings.linearDamping ?? DEFAULT_LINEAR_DAMPING),
    angularDamping: f(settings.angularDamping ?? DEFAULT_ANGULAR_DAMPING),
  }
}

function quaternion(rotation: Rotation) {
  return new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
}

function rotationOf(value: readonly number[]): Rotation {
  return { x: f(value[0] ?? 0), y: f(value[1] ?? 0), z: f(value[2] ?? 0), w: f(value[3] ?? 1) }
}

function localPoint(body: RAPIER.RigidBody, point: Vector, origin?: Vector): Vector {
  const translation = origin ?? body.translation()
  const value = new THREE.Vector3(point.x - translation.x, point.y - translation.y, point.z - translation.z)
    .applyQuaternion(quaternion(body.rotation()).invert())
  return { x: value.x, y: value.y, z: value.z }
}

function worldPoint(body: RAPIER.RigidBody, point: Vector): Vector {
  const translation = body.translation()
  const value = new THREE.Vector3(point.x, point.y, point.z).applyQuaternion(quaternion(body.rotation()))
  return { x: translation.x + value.x, y: translation.y + value.y, z: translation.z + value.z }
}

function localDirection(body: RAPIER.RigidBody, direction: Vector): Vector {
  const value = new THREE.Vector3(direction.x, direction.y, direction.z)
    .applyQuaternion(quaternion(body.rotation()).invert())
  return normalize({ x: value.x, y: value.y, z: value.z }, { x: 0, y: 0, z: 1 })
}

function vector(value: readonly number[] | undefined, fallback: Vector): Vector {
  if (!value || value.length < 3) return fallback
  return { x: f(value[0]!), y: f(value[1]!), z: f(value[2]!) }
}

function normalize(value: Vector, fallback: Vector): Vector {
  const squared = value.x * value.x + value.y * value.y + value.z * value.z
  if (squared <= 1e-12) return fallback
  const length = Math.sqrt(squared)
  return { x: value.x / length, y: value.y / length, z: value.z / length }
}


function degrees(value: number) {
  return f(f(value) * f(Math.PI / 180))
}

/** Rotate an authored vector by a referential and convert to render units. */
function frameOffset(frame: GraphFrameBinding, value: Vector): Vector {
  const point = new THREE.Vector3(value.x, value.y, value.z).applyQuaternion(quaternion(rotationOf(frame.rotation)))
  point.multiplyScalar(SCALE)
  point.z *= -1
  return { x: point.x, y: point.y, z: point.z }
}

/** Full frame transform (including scale and world origin) for spring/force anchors. */
function frameAnchor(frame: GraphFrameBinding, value: Vector): Vector {
  if (frame.matrix?.length === 16) {
    const point = new THREE.Vector3(value.x, value.y, value.z).applyMatrix4(new THREE.Matrix4().fromArray(frame.matrix))
    point.multiplyScalar(SCALE)
    point.z *= -1
    return { x: point.x, y: point.y, z: point.z }
  }
  const offset = frameOffset(frame, value)
  return { x: frame.position[0] + offset.x, y: frame.position[1] + offset.y, z: frame.position[2] + offset.z }
}

/** Rotate an authored direction by a referential; SCALE does not affect a direction. */
function frameDirection(frame: GraphFrameBinding, value: Vector): Vector {
  const authored = new THREE.Vector3(value.x, value.y, value.z)
  const direction = frame.matrix?.length === 16
    ? authored.transformDirection(new THREE.Matrix4().fromArray(frame.matrix))
    : authored.applyQuaternion(quaternion(rotationOf(frame.rotation)))
  direction.z *= -1
  direction.normalize()
  return { x: direction.x, y: direction.y, z: direction.z }
}

/** The frame's render-space axis, falling back to its local Z (then world +Z). */
function frameAxis(frame: GraphFrameBinding): Vector {
  if (frame.matrix?.length === 16) {
    const axis = new THREE.Vector3(0, 0, 1).transformDirection(new THREE.Matrix4().fromArray(frame.matrix))
    axis.z *= -1
    return normalize({ x: axis.x, y: axis.y, z: axis.z }, { x: 0, y: 0, z: 1 })
  }
  if (frame.axis) return normalize(vector(frame.axis, { x: 0, y: 0, z: 1 }), { x: 0, y: 0, z: 1 })
  const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion(rotationOf(frame.rotation)))
  return normalize({ x: axis.x, y: axis.y, z: axis.z }, { x: 0, y: 0, z: 1 })
}

function fixedAnchor(name: string | undefined, host?: GraphRapierPhysicsHost): boolean {
  return name === undefined || name.length === 0 || name === FIXED_ANCHOR || name === ALT_FIXED_ANCHOR || host?.isFixedAnchor?.(name) === true
}

function sameNumbers(a: readonly number[] | undefined, b: readonly number[] | undefined) {
  if (a === undefined || b === undefined) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (f(a[i]!) !== f(b[i]!)) return false
  return true
}

export interface RapierGraphPhysicsBindingOptions {
  /** Release every frozen module body when the authored WakeUp fires. */
  releaseFrozenOnWake?: boolean
  /** Wake released bodies instead of sleeping them (chain planks). */
  releaseFrozenAwake?: boolean
  /** Resolve body-local anchors from the authored pose, not Rapier's f32 pose. */
  authoredAnchors?: boolean
  /** Wake bodies when an impulse joint is created (default true). */
  wakeJoints?: boolean
  /** Construct bodies disabled and defer controllers until `activate()`. */
  suspended?: boolean
  /** Skip controllers/springs on the frame a body is released, matching the
   * finish hand-port whose impulse pass precedes its wake update. */
  deferWakeImpulses?: boolean
  /** Start a controller's impulses on the tick after its creation frame. */
  deferNewForceImpulse?: boolean
  /** Extra Rapier solver iterations for dynamic bodies (default 4). */
  additionalSolverIterations?: number
  /** Derive single-hull mass properties from the collider, as the finish
   * hand-port does, even when a native inertia measurement exists. */
  singleHullColliderMass?: boolean
}

export class RapierGraphPhysicsBinding implements GraphPhysicsBinding {
  private readonly host: GraphRapierPhysicsHost
  private readonly releaseFrozenOnWake: boolean
  private readonly releaseFrozenAwake: boolean
  private readonly authoredAnchors: boolean
  private readonly wakeJoints: boolean
  private readonly deferWakeImpulses: boolean
  private readonly deferNewForceImpulse: boolean
  private readonly additionalSolverIterations: number
  private readonly singleHullColliderMass: boolean
  /** Script frame each body was released from its authored frozen state. */
  private readonly wakeFrames = new Map<string, number>()
  private suspended: boolean
  private readonly createdBodies = new Set<string>()
  private readonly bodySettings = new Map<string, GraphPhysicsBody>()
  /** Bodies released by a WakeUp while an activation script is still running. */
  private readonly releasedThisActivation = new Set<string>()
  private flushingJoints = false
  private pendingJoints: { kind: 'hinge' | 'slider' | 'ballSocket'; name: string; settings: GraphJointSettings }[] = []
  private pendingSprings: { name: string; settings: GraphSpringSettings }[] = []
  private readonly forces = new Map<string, ActiveForce>()
  /** Incremented before each script frame; controllers created in that frame
   * begin applying impulses on the following tick, like the native runtime. */
  private frameIndex = 0
  private readonly joints = new Map<string, JointRecord>()
  private readonly springs = new Map<string, SpringRecord>()
  /** Fixed joint anchors kept across resets, matching the removed hand-port bodies. */
  private readonly supports = new Map<string, RAPIER.RigidBody>()
  private readonly poses = new Map<string, StoredPose>()
  private readonly hulls = new Map<string, string[]>()
  /** The created collision-hull count (1 for a ball or concave surface). */
  private readonly hullCounts = new Map<string, number>()
  /** Start-frozen bodies are fixed until the authored WakeUp. */
  private readonly frozen = new Set<string>()
  /** Bodies removed when the host has no `unregister`, so a stale map entry is ignored. */
  private readonly removed = new Set<string>()
  /** WakeUps that ran before their target's Physicalize (the session's copied scripts can order them so). */
  private readonly pendingWake = new Set<string>()

  constructor(host: GraphRapierPhysicsHost, options: RapierGraphPhysicsBindingOptions = {}) {
    this.host = host
    this.releaseFrozenOnWake = options.releaseFrozenOnWake ?? false
    this.releaseFrozenAwake = options.releaseFrozenAwake ?? false
    this.authoredAnchors = options.authoredAnchors ?? false
    this.wakeJoints = options.wakeJoints ?? true
    this.deferWakeImpulses = options.deferWakeImpulses ?? false
    this.deferNewForceImpulse = options.deferNewForceImpulse ?? false
    this.additionalSolverIterations = options.additionalSolverIterations ?? 4
    this.singleHullColliderMass = options.singleHullColliderMass ?? false
    this.suspended = options.suspended ?? false
  }

  debugForces() {
    return [...this.forces].map(([name, active]) => ({ name, direction: active.direction, position: active.position }))
  }

  /** Persistent force controller keys (`<target>:<controller>`) currently installed. */
  debugForceKeys(): string[] {
    return [...this.forces.keys()]
  }

  /** The created hull count of an installed body (1 for a ball or concave surface). */
  debugHullCount(name: string): number | undefined {
    return this.hullCounts.get(name)
  }

  /** Authored joints currently installed, optionally for one target. */
  debugJointCount(name?: string): number {
    if (name === undefined) return this.joints.size
    return [...this.joints.keys()].filter(key => key.split(':')[1] === name).length
  }

  physicalize(name: string, settings: GraphPhysicsBody) {
    const properties = material(settings)
    const enabled = settings.enableCollision !== false
    const supplied = this.host.pose?.(name)
    const authored: StoredPose | undefined = supplied
      ? {
          // Keep the authored origin in double precision: joint and spring
          // anchors resolve against it like the removed hand-ports. Rapier rounds the
          // body pose itself to float32 when it is created.
          position: {
            x: supplied.position[0],
            y: supplied.position[1],
            z: supplied.position[2],
          },
          rotation: rotationOf(supplied.rotation),
          ...(supplied.matrix ? { matrix: [...supplied.matrix] } : {}),
        }
      : undefined
    const pose = authored ?? this.poses.get(name)
    const balls = settings.balls ?? []
    const concave = settings.concave ?? []
    const hulls = settings.hulls ?? (balls.length === 0 && concave.length === 0 ? this.hulls.get(name) : undefined)
    if (balls.length > 1) throw new Error(`Physicalize ${name} has ${balls.length} balls, which is not recovered`)
    if (balls.length > 0 && (concave.length > 0 || (settings.hulls?.length ?? 0) > 0)) {
      throw new Error(`Physicalize ${name} has a ball together with other surfaces, which is not recovered`)
    }
    if (concave.length > 0 && (settings.hulls?.length ?? 0) > 0) {
      throw new Error(`Physicalize ${name} has both convex and concave surfaces, which is not recovered`)
    }
    const player = balls.length > 0 ? this.host.player?.(name) : undefined
    if (player) {
      this.physicalizePlayer(name, player, settings, pose, authored, enabled)
      return
    }
    const existing = this.lookup(name)
    const shapeCount = balls.length > 0 || concave.length > 0 ? 1 : hulls?.length ?? 0
    if (existing) {
      this.configureColliders(existing, properties, settings.collisionGroup, enabled)
      configureBody(existing, properties)
      existing.setBodyType(settings.fixed ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, true)
      if (authored) {
        const previous = this.poses.get(name)
        if (!previous || this.poseChanged(previous, authored)) {
          existing.setTranslation(authored.position, true)
          existing.setRotation(authored.rotation, true)
        }
        if (hulls && hulls.length > 0) this.applyMass(existing, name, properties.mass, hulls, authored, settings)
        this.poses.set(name, authored)
      }
      if (hulls) this.hulls.set(name, [...hulls])
      if (shapeCount > 0) this.hullCounts.set(name, shapeCount)
      if (settings.startFrozen && !settings.fixed && !this.releasedThisActivation.has(name)) {
        existing.setBodyType(RAPIER.RigidBodyType.Fixed, true)
        this.frozen.add(name)
      } else {
        this.frozen.delete(name)
        existing.setBodyType(settings.fixed ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, true)
        if (!settings.fixed) existing.wakeUp()
      }
      this.createdBodies.add(name)
      this.bodySettings.set(name, { ...settings })
      this.host.register(name, existing, settings)
      if (this.suspended) existing.setEnabled(false)
      return
    }
    if (shapeCount === 0) throw new Error(`Physicalize ${name} requires at least one collision surface`)
    const description = settings.fixed
      ? RAPIER.RigidBodyDesc.fixed()
      : RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setAdditionalSolverIterations(
          this.host.additionalSolverIterations ? this.host.additionalSolverIterations(name) : this.additionalSolverIterations)
    if (pose) description.setTranslation(pose.position.x, pose.position.y, pose.position.z).setRotation(pose.rotation)
    const body = this.host.world.createRigidBody(description)
    const initial: StoredPose = pose ?? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
    try {
      if (balls.length > 0) {
        const ball = balls[0]!
        if (!(ball.radius > 0)) throw new Error(`Invalid ball radius ${ball.radius} for ${name}`)
        const shape = RAPIER.ColliderDesc.ball(f(ball.radius * SCALE))
        if (ball.position.some(component => component !== 0)) {
          shape.setTranslation(f(ball.position[0] * SCALE), f(ball.position[1] * SCALE), f(-ball.position[2] * SCALE))
        }
        this.colliderGroups(shape, settings, enabled)
        this.host.world.createCollider(configureContact(shape, properties), body)
      } else if (concave.length > 0) {
        if (!this.host.triangles) throw new Error(`The Rapier host cannot build the concave Physicalize ${name}`)
        const points: number[] = []
        for (const mesh of concave) {
          const triangles = this.host.triangles(mesh, name)
          if (triangles === undefined) throw new Error(`Missing concave collision mesh ${mesh} for ${name}`)
          if (triangles.length === 0 || triangles.length % 9 !== 0) throw new Error(`Invalid concave collision mesh ${mesh} for ${name}`)
          points.push(...triangles)
        }
        const vertices = Float32Array.from(points)
        const indices = Uint32Array.from({ length: vertices.length / 3 }, (_, index) => index)
        const shape = RAPIER.ColliderDesc.trimesh(vertices, indices)
        this.colliderGroups(shape, settings, enabled)
        this.host.world.createCollider(configureContact(shape, properties), body)
      } else {
        for (const hull of hulls!) {
          const points = this.host.hull(hull, name)
          if (!points) throw new Error(`Missing collision hull ${hull} for ${name}`)
          if (points.length < 12 || points.length % 3 !== 0) throw new Error(`Invalid collision hull ${hull} for ${name}`)
          const shape = RAPIER.ColliderDesc.convexHull(points)
          if (!shape) throw new Error(`Cannot build convex hull ${hull} for ${name}`)
          // Enable Collision false keeps the collider out of the contact graph by
          // using the empty group mask, not by disabling it: the collider still
          // contributes its shape mass, as the original Physicalize does.
          this.colliderGroups(shape, settings, enabled)
          this.host.world.createCollider(configureContact(shape, properties), body)
        }
        configureBody(body, properties)
        this.applyMass(body, name, properties.mass, hulls!, initial, settings)
      }
      if (balls.length > 0 || concave.length > 0) {
        if (!settings.fixed) {
          if (!(properties.mass > 0)) throw new Error(`Physicalize ${name} needs a positive mass for a ball or concave body`)
          const colliders = body.numColliders()
          for (let index = 0; index < colliders; index++) body.collider(index).setMass(index === 0 ? properties.mass : 0)
        }
        configureBody(body, properties)
        body.recomputeMassPropertiesFromColliders()
      }
    } catch (error) {
      this.host.world.removeRigidBody(body)
      throw error
    }
    if (settings.startFrozen && !settings.fixed) {
      body.setBodyType(RAPIER.RigidBodyType.Fixed, true)
      this.frozen.add(name)
    }
    if (this.suspended) body.setEnabled(false)
    this.createdBodies.add(name)
    this.bodySettings.set(name, { ...settings })
    this.host.register(name, body, settings)
    this.removed.delete(name)
    this.poses.set(name, initial)
    if (hulls) this.hulls.set(name, [...hulls])
    this.hullCounts.set(name, shapeCount)
    if (this.pendingWake.delete(name)) this.wake(name)
  }

  /**
   * The session's player ball: the engine keeps one dynamic body and replaces
   * its collider per material (original-engine.ts ~694-734, the table in
   * original-physics.ts and original-player.ts). The authored Physicalize
   * supplies the placement and the ball radius; mass, friction, damping,
   * inertia and the Ball collision group are the engine's, so the graph-Rapier
   * and engine-Rapier runs are comparable.
   */
  private physicalizePlayer(name: string, kind: Material, settings: GraphPhysicsBody, pose: StoredPose | undefined, authored: StoredPose | undefined, enabled: boolean) {
    let body = this.lookup(name)
    if (!body) {
      const description = RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setCanSleep(false)
      if (pose) description.setTranslation(pose.position.x, pose.position.y, pose.position.z).setRotation(pose.rotation)
      body = this.host.world.createRigidBody(description)
      this.host.register(name, body, settings)
    } else if (authored) {
      const previous = this.poses.get(name)
      if (!previous || this.poseChanged(previous, authored)) {
        body.setTranslation(authored.position, true)
        body.setRotation(authored.rotation, true)
      }
    }
    const initial = authored ?? pose ?? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }
    const vertices = kind === 'paper' ? this.host.hull(name, name) : undefined
    replacePlayerCollider(this.host.world, body, kind, vertices)
    if (!enabled) for (let index = 0; index < body.numColliders(); index++) body.collider(index).setCollisionGroups(0)
    body.setBodyType(settings.fixed ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, true)
    if (this.suspended) body.setEnabled(false)
    this.createdBodies.add(name)
    this.bodySettings.set(name, { ...settings })
    this.host.register(name, body, settings)
    this.removed.delete(name)
    this.poses.set(name, initial)
    this.hulls.set(name, [name])
    this.hullCounts.set(name, 1)
    if (this.pendingWake.delete(name)) this.wake(name)
  }

  private colliderGroups(shape: RAPIER.ColliderDesc, settings: GraphPhysicsBody, enabled: boolean) {
    if (!enabled) shape.setCollisionGroups(0)
    else if (settings.collisionGroup !== undefined) shape.setCollisionGroups(settings.collisionGroup)
  }

  unphysicalize(name: string) {
    this.frozen.delete(name)
    for (const key of [...this.forces.keys()]) if (key.startsWith(`${name}:`)) this.forces.delete(key)
    this.removeJointsFor(name)
    this.removeSpringsFor(name)
    const body = this.lookup(name)
    if (body) {
      this.host.world.removeRigidBody(body)
      if (this.host.unregister) this.host.unregister(name)
      else this.removed.add(name)
    }
    this.poses.delete(name)
    this.hulls.delete(name)
    this.hullCounts.delete(name)
  }

  force(name: string, settings: GraphForceSettings) {
    const key = this.forceKey(name, settings)
    if (!settings.create) {
      if (!this.forces.delete(key)) return
      return
    }
    // SetPhysicsForce's pre-simulate handler (physics_RT.dll 0x10004930) drops
    // the controller when FUN_10007800 finds no PhysicsObject (null check
    // 0x100049D6-0x100049E4) and only stores local 0 after a successful lookup;
    // the behavior runs the same way on every physics backend.
    const body = this.lookup(name)
    if (!body) return
    const directionRef = settings.directionRef === 'Direction Ref' ? undefined : settings.directionRef
    const directionFrame = directionRef ? this.referential(directionRef, `force ${name} direction`) : undefined
    let direction = {
      x: Number(settings.direction?.[0] ?? 1),
      y: Number(settings.direction?.[1] ?? 0),
      z: Number(settings.direction?.[2] ?? 0),
    }
    if (directionFrame) direction = frameDirection(directionFrame, direction)
    const squared = direction.x * direction.x + direction.y * direction.y + direction.z * direction.z
    if (squared <= FORCE_DIRECTION_EPSILON) {
      direction = { x: 1, y: 0, z: 0 }
    } else {
      const length = Math.sqrt(squared)
      direction = { x: direction.x / length, y: direction.y / length, z: direction.z / length }
    }
    const value = Number(settings.value ?? DEFAULT_FORCE)
    const positionFrame = settings.positionRef && settings.positionRef !== name
      ? this.referential(settings.positionRef, `force ${name} position`)
      : undefined
    // A force positioned in its own target's frame is body-local: authored zero
    // means the live body origin, which moves with the body. Resolving the
    // static authored frame here would pin a later-created drive to the body's
    // initial world origin and add a spurious torque. A distinct external
    // referential is a fixed world point, like the ending's rope forces.
    const externalPoint = !!positionFrame
    const position = positionFrame
      ? frameAnchor(positionFrame, vector(settings.position, { x: 0, y: 0, z: 0 }))
      : vector(settings.position, { x: 0, y: 0, z: 0 })
    const controller = settings.controller ?? 'default'
    // A live target change (the player's authored ball name after a material
    // swap) retargets the same authored controller; do not leave its previous
    // force active on the old target.
    for (const [existingKey, active] of this.forces) {
      if (existingKey !== key && active.controller === controller) this.forces.delete(existingKey)
    }
    this.forces.set(key, {
      name,
      body,
      direction,
      position,
      world: externalPoint,
      value,
      controller,
      // Re-authoring the same controller updates it in place; only a newly
      // created controller waits for the next tick.
      createdFrame: this.forces.get(key)?.createdFrame ?? this.frameIndex,
    })
  }

  private forceKey(name: string, settings: GraphForceSettings): string {
    return `${name}:${settings.controller ?? 'default'}`
  }

  joint(kind: 'hinge' | 'slider' | 'ballSocket', name: string, settings: GraphJointSettings) {
    const otherName = fixedAnchor(settings.object2, this.host) ? undefined
      : settings.object2 === undefined ? undefined : this.host.resolveSibling?.(name, settings.object2) ?? settings.object2
    if ((this.suspended && !this.flushingJoints) || !this.lookup(name) || (otherName !== undefined && !this.lookup(otherName))) {
      this.pendingJoints.push({ kind, name, settings })
      return
    }
    const body = this.requireBody(name)
    const frame = settings.referential ? this.referential(settings.referential, `${kind} ${name}`) : undefined
    const frame2 = kind === 'slider' && settings.referential2
      ? this.referential(settings.referential2, `slider ${name} axis`)
      : undefined
    // Keep the recovered frame coordinate in double precision until it is
    // converted into each body's local anchor. Rounding the world pivot to
    // float32 first shifts the local anchors by ~1e-6 relative to the
    // hand-ports, which is enough to change the sack's contact ordering.
    const pivot = frame
      ? { x: frame.position[0], y: frame.position[1], z: frame.position[2] }
      : body.translation()
    let axis: Vector = { x: 0, y: 0, z: 1 }
    if (kind === 'hinge' && frame) axis = frameAxis(frame)
    if (kind === 'slider' && frame && frame2) {
      // Match the removed hand-port's double-precision axis; rounding both frame
      // points to float32 first rotates the slider slightly.
      axis = normalize({
        x: frame2.position[0] - pivot.x,
        y: frame2.position[1] - pivot.y,
        z: frame2.position[2] - pivot.z,
      }, axis)
    }
    const key = this.jointKey(kind, name, settings)
    this.destroyJointKey(key)
    const shared = otherName ? undefined : this.host.fixedBody ?? this.host.fixedBodyFor?.(name)
    const support = otherName ? undefined : shared ?? this.jointSupport(key, pivot)
    const other = otherName ? this.requireBody(otherName) : support!
    if (other.handle === body.handle) throw new Error(`Joint ${kind} for ${name} cannot target itself`)
    const anchor1 = localPoint(body, pivot, this.anchorOrigin(name))
    // A joint-local fixed support was created exactly at the pivot, so its
    // anchor is zero like the removed hand-ports. A shared module anchor keeps the
    // pivot offset relative to its authored origin.
    const anchor2 = otherName
      ? localPoint(other, pivot, this.anchorOrigin(otherName))
      : shared ? localPoint(shared, pivot) : { x: 0, y: 0, z: 0 }
    const data = kind === 'hinge'
      ? (frame
          ? RAPIER.JointData.revoluteWithAxes(anchor1, anchor2, localDirection(body, axis), localDirection(other, axis))
          : RAPIER.JointData.revolute(anchor1, anchor2, axis))
      : kind === 'slider'
        ? RAPIER.JointData.prismatic(anchor1, anchor2, localDirection(body, axis))
        : RAPIER.JointData.spherical(anchor1, anchor2)
    const joint = this.host.world.createImpulseJoint(data, body, other, this.wakeJoints && (this.host.wakeJoints?.(name) ?? true))
    if (settings.limitsEnabled) {
      if (kind === 'hinge') {
        const hinge = joint as RAPIER.RevoluteImpulseJoint
        hinge.setLimits(degrees(settings.lowerLimit ?? 0), degrees(settings.upperLimit ?? 0))
      } else if (kind === 'slider') {
        // original-lift.ts/original-slider.ts scale authored slider limits by SCALE.
        const slider = joint as RAPIER.PrismaticImpulseJoint
        slider.setLimits(f(f(settings.lowerLimit ?? 0) * f(SCALE)), f(f(settings.upperLimit ?? 0) * f(SCALE)))
      }
    }
    this.joints.set(key, {
      joint,
      ...(support && !shared ? { support } : {}),
      bodies: otherName ? [name, otherName] : [name],
    })
  }

  /** Install controllers queued while the module was suspended. */
  startFrame() {
    this.frameIndex++
    this.flushPendingJoints()
    if (this.pendingSprings.length) {
      const pending = this.pendingSprings
      this.pendingSprings = []
      for (const item of pending) this.spring(item.name, item.settings)
    }
  }

  /**
   * Resume the authored module: enable bodies and install joints. Body kinds
   * stay as the just-executed script left them, so an authored WakeUp during
   * activation is not undone by the initial start-frozen state.
   */
  activate() {
    this.suspended = false
    for (const name of this.createdBodies) {
      const body = this.lookup(name)
      if (!body) continue
      const settings = this.bodySettings.get(name)
      body.setEnabled(true)
      if (!settings?.fixed && !settings?.startFrozen) body.wakeUp()
    }
    this.flushPendingJoints()
    this.releasedThisActivation.clear()
  }

  /**
   * Stop the authored module: remove controllers, restore the authored poses,
   * body kinds and frozen flags, then disable the bodies.
   */
  suspend() {
    this.suspended = true
    this.pendingJoints = []
    this.pendingSprings = []
    this.releasedThisActivation.clear()
    this.forces.clear()
    this.springs.clear()
    for (const [key, record] of [...this.joints]) {
      this.joints.delete(key)
      this.host.world.removeImpulseJoint(record.joint, true)
      const support = this.supports.get(key)
      if (support) {
        this.host.world.removeRigidBody(support)
        this.supports.delete(key)
      }
    }
    for (const name of this.createdBodies) {
      const body = this.lookup(name)
      if (!body) continue
      const settings = this.bodySettings.get(name)
      if (settings?.startFrozen && !settings.fixed) {
        body.setBodyType(RAPIER.RigidBodyType.Fixed, false)
        this.frozen.add(name)
      } else if (settings) {
        this.frozen.delete(name)
        body.setBodyType(settings.fixed ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, false)
      }
      const pose = this.poses.get(name)
      if (pose) {
        body.setTranslation(pose.position, false)
        body.setRotation(pose.rotation, false)
      }
      body.setLinvel({ x: 0, y: 0, z: 0 }, false)
      body.setAngvel({ x: 0, y: 0, z: 0 }, false)
      body.setEnabled(false)
    }
  }

  private flushPendingJoints() {
    if (this.pendingJoints.length === 0) return
    // Install hinge constraints before sliders like the removed hand-ports (the finish
    // authors its slider compound before the hinge compounds but creates both
    // at activation). Stable for equal kinds.
    const pending = [...this.pendingJoints].sort((a, b) => jointOrder(a.kind) - jointOrder(b.kind))
    this.pendingJoints = []
    this.flushingJoints = true
    try {
      for (const item of pending) this.joint(item.kind, item.name, item.settings)
    } finally {
      this.flushingJoints = false
    }
  }

  private jointKey(kind: string, name: string, settings: GraphJointSettings): string {
    return `${kind}:${name}:${settings.controller ?? ''}:${settings.object2 ?? ''}:${settings.referential ?? ''}:${settings.referential2 ?? ''}`
  }

  private destroyJointKey(key: string) {
    const record = this.joints.get(key)
    if (!record) return
    this.joints.delete(key)
    this.host.world.removeImpulseJoint(record.joint, true)
    const support = this.supports.get(key)
    if (support) {
      this.host.world.removeRigidBody(support)
      this.supports.delete(key)
    }
  }

  private jointSupport(key: string, pivot: Vector) {
    let support = this.supports.get(key)
    if (!support) {
      support = this.host.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pivot.x, pivot.y, pivot.z))
      this.supports.set(key, support)
    } else {
      support.setTranslation(pivot, false)
    }
    return support
  }

  destroyJoint(kind: 'hinge' | 'slider' | 'ballSocket', name: string, controller?: number) {
    const prefix = controller === undefined ? `${kind}:${name}:` : `${kind}:${name}:${controller}:`
    for (const key of [...this.joints.keys()]) {
      if (key.startsWith(prefix)) this.destroyJointKey(key)
    }
  }

  wake(name: string) {
    const body = this.lookup(name)
    if (!body) { this.pendingWake.add(name); return }
    // IVP propagates wake through resting contacts. Rapier does not unfreeze
    // fixed island members, so authored modules whose loose weights start
    // frozen release them explicitly when their WakeUp fires.
    const release = this.releaseFrozenOnWake || this.host.releaseFrozenOnWake?.(name) === true
    const awake = this.releaseFrozenAwake || this.host.releaseFrozenAwake?.(name) === true
    if (release) {
      for (const target of [...this.frozen]) {
        if (target === name && !awake) continue
        if (target !== name && this.host.sameModule && !this.host.sameModule(name, target)) continue
        const other = this.lookup(target)
        if (!other) continue
        this.frozen.delete(target)
        this.releasedThisActivation.add(target)
        if (this.deferWakeImpulses || this.host.deferWakeImpulses?.(target)) this.wakeFrames.set(target, this.frameIndex)
        // Do not wake the island while changing the body type: the removed hand-port
        // restores sleeping weights without disturbing their neighbours.
        other.setBodyType(RAPIER.RigidBodyType.Dynamic, false)
        if (awake) other.wakeUp()
        else other.sleep()
      }
    }
    if (this.frozen.delete(name)) {
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true)
      this.releasedThisActivation.add(name)
      if (this.deferWakeImpulses) this.wakeFrames.set(name, this.frameIndex)
    }
    body.wakeUp()
  }

  spring(name: string, settings: GraphSpringSettings) {
    if (!settings.create) {
      this.destroySpring(name)
      return
    }
    const otherName = fixedAnchor(settings.object2, this.host) ? undefined
      : settings.object2 === undefined ? undefined : this.host.resolveSibling?.(name, settings.object2) ?? settings.object2
    if (!this.lookup(name) || (otherName !== undefined && !this.lookup(otherName))) {
      this.pendingSprings.push({ name, settings })
      return
    }
    const body = this.requireBody(name)
    const frame1 = settings.referential1 ? this.referential(settings.referential1, `spring ${name} anchor 1`) : undefined
    const frame2 = settings.referential2 ? this.referential(settings.referential2, `spring ${name} anchor 2`) : undefined
    const anchor1 = frame1
      ? localPoint(body, frameAnchor(frame1, vector(settings.position1, { x: 0, y: 0, z: 0 })), this.anchorOrigin(name))
      : vector(settings.position1, { x: 0, y: 0, z: 0 })
    const record: SpringRecord = {
      body,
      anchor1,
      coefficients: {
        length: f(f(settings.length ?? 0) * f(SCALE)),
        constant: settings.constant ?? 0,
        axialDamping: settings.axialDamping ?? 0,
        globalDamping: settings.globalDamping ?? 0,
      },
      bodies: otherName ? [name, otherName] : [name],
    }
    if (otherName) {
      const other = this.requireBody(otherName)
      if (other.handle === body.handle) throw new Error(`Spring for ${name} cannot target itself`)
      record.body2 = other
      record.anchor2 = frame2
        ? localPoint(other, frameAnchor(frame2, vector(settings.position2, { x: 0, y: 0, z: 0 })), this.anchorOrigin(otherName))
        : vector(settings.position2, { x: 0, y: 0, z: 0 })
    } else {
      record.fixed = frame2
        ? frameAnchor(frame2, vector(settings.position2, { x: 0, y: 0, z: 0 }))
        : body.translation()
    }
    this.destroySpring(name)
    this.springs.set(name, record)
  }

  /** Release force controllers; used when an external target body is replaced. */
  detach() {
    this.forces.clear()
  }

  reset() {
    this.pendingJoints = []
    this.pendingSprings = []
    this.forces.clear()
    for (const record of this.joints.values()) this.host.world.removeImpulseJoint(record.joint, true)
    this.joints.clear()
    this.springs.clear()
  }

  step(deltaMs?: number) {
    // The original controller applies its authored value as an impulse per
    // PSI tick. Reproduce the removed hand-port conversion at the engine tick rate.
    const dt = deltaMs === undefined ? this.host.world.timestep : deltaMs / 1000
    for (const active of this.forces.values()) {
      if ((this.deferNewForceImpulse || this.host.deferNewForceImpulse?.(active.name)) && active.createdFrame === this.frameIndex) continue
      if (this.wokenThisFrame(active.name)) continue
      this.applyForceImpulse(active, dt)
    }
    for (const spring of this.springs.values()) {
      if (spring.bodies.some(name => this.wokenThisFrame(name))) continue
      this.applySpringImpulse(spring, dt)
    }
  }

  /** A body released by this frame's WakeUp was still fixed during the
   * hand-port's preceding impulse pass. */
  private wokenThisFrame(name: string): boolean {
    return (this.deferWakeImpulses || this.host.deferWakeImpulses?.(name) === true) && this.wakeFrames.get(name) === this.frameIndex
  }

  private applySpringImpulse(spring: SpringRecord, dt: number) {
    // The recovered spring helper (original-spring.ts) is an impulse, not a
    // Rapier constraint; the removed hand-ports integrate it once per script frame.
    const point1 = worldPoint(spring.body, spring.anchor1)
    const point2 = spring.body2 && spring.anchor2 ? worldPoint(spring.body2, spring.anchor2) : spring.fixed!
    const velocity1 = spring.body.velocityAtPoint(point1)
    const velocity2 = spring.body2 ? spring.body2.velocityAtPoint(point2) : { x: 0, y: 0, z: 0 }
    const impulse = springImpulse(
      new THREE.Vector3(point1.x - point2.x, point1.y - point2.y, point1.z - point2.z),
      new THREE.Vector3(velocity1.x - velocity2.x, velocity1.y - velocity2.y, velocity1.z - velocity2.z),
      spring.coefficients,
      dt,
    )
    const value = { x: impulse.x, y: impulse.y, z: impulse.z }
    spring.body.applyImpulseAtPoint(value, point1, true)
    if (spring.body2) {
      spring.body2.applyImpulseAtPoint({ x: -value.x, y: -value.y, z: -value.z }, point2, true)
    }
  }

  private applyForceImpulse(active: ActiveForce, dt: number) {
    const magnitude = active.value * SCALE * ORIGINAL_TIME_FACTOR ** 2 * ORIGINAL_PSI_HZ * dt
    const impulse = {
      x: active.direction.x * magnitude,
      y: active.direction.y * magnitude,
      z: active.direction.z * magnitude,
    }
    // Target-local forces follow the body origin; an external referential keeps
    // the authored fixed world point.
    const point = active.world
      ? active.position
      : worldPoint(active.body, active.position)
    active.body.applyImpulseAtPoint(impulse, point, true)
  }

  private anchorOrigin(name: string | undefined): Vector | undefined {
    return (this.authoredAnchors || this.host.authoredAnchors?.(name ?? '') === true) && name ? this.poses.get(name)?.position : undefined
  }

  private referential(name: string, context: string): GraphFrameBinding | undefined {
    if (!this.host.frame) return undefined
    const frame = this.host.frame(name)
    if (!frame) throw new Error(`Missing referential ${name} for ${context}`)
    return frame
  }

  private destroySpring(name: string) {
    this.springs.delete(name)
  }

  private removeJointsFor(name: string) {
    for (const [key, record] of [...this.joints]) {
      if (!record.bodies.includes(name)) continue
      this.joints.delete(key)
      this.host.world.removeImpulseJoint(record.joint, true)
      const support = this.supports.get(key)
      if (support) {
        this.host.world.removeRigidBody(support)
        this.supports.delete(key)
      }
    }
  }

  private removeSpringsFor(name: string) {
    for (const [key, record] of [...this.springs]) {
      if (record.bodies.includes(name)) this.springs.delete(key)
    }
  }

  private poseChanged(previous: StoredPose, pose: StoredPose): boolean {
    return f(previous.position.x) !== pose.position.x
      || f(previous.position.y) !== pose.position.y
      || f(previous.position.z) !== pose.position.z
      || f(previous.rotation.x) !== pose.rotation.x
      || f(previous.rotation.y) !== pose.rotation.y
      || f(previous.rotation.z) !== pose.rotation.z
      || f(previous.rotation.w) !== pose.rotation.w
      || !sameNumbers(previous.matrix, pose.matrix)
  }

  private applyMass(body: RAPIER.RigidBody, name: string, mass: number, hulls: readonly string[], pose: StoredPose, settings: GraphPhysicsBody) {
    // Fixed guides have no simulated mass and no recovered inertia entry.
    if (settings.fixed) return
    const matrix = pose.matrix && pose.matrix.length === 16
      ? new THREE.Matrix4().fromArray(pose.matrix)
      : new THREE.Matrix4()
    const massCenter = settings.automaticMassCenter ? [0, 0, 0] : settings.massCenter ?? [0, 0, 0]
    const names = this.host.hullName ? hulls.map(hull => this.host.hullName!(hull)) : [...hulls]
    if ((this.singleHullColliderMass || this.host.singleHullColliderMass?.(name)) && hulls.length === 1) {
      for (let i = 0; i < body.numColliders(); i++) body.collider(i).setMass(mass)
      body.setAdditionalMass(0, false)
      body.recomputeMassPropertiesFromColliders()
      return
    }
    const measured = this.measuredMatrix(matrix, names)
    if (measured) {
      applyOriginalConvexMass(body, mass, names, measured, massCenter)
      return
    }
    if (!hasOriginalConvexMass(names, matrix)) {
      // An editor-auto-filled Convex input uses the target's own mesh. The
      // ending hand-port builds those single-hull bodies from the collider mass
      // properties, so use the same path when no measured entry exists.
      if (hulls.length !== 1 || (hulls[0] !== name && names[0] !== this.host.hullName?.(name) && this.host.singleHullColliderMass === undefined)) {
        throw new Error(`Missing native original inertia measurement: ${originalInertiaKey(names, matrix)}`)
      }
      for (let i = 0; i < body.numColliders(); i++) body.collider(i).setMass(mass)
      body.setAdditionalMass(0, false)
      body.recomputeMassPropertiesFromColliders()
      return
    }
    applyOriginalConvexMass(body, mass, names, matrix, massCenter)
  }

  /**
   * The session's Levelinit copies carry the placement scale into the body
   * matrix (float drift of ~1e-5), while the native measurements are keyed by
   * the asset matrix's scale (~1e-6). The placement scale is not authored mass
   * data, so use the recovered entry's scale with the live rotation.
   */
  private measuredMatrix(matrix: THREE.Matrix4, names: readonly string[]): THREE.Matrix4 | undefined {
    const prefix = `${names.join('|')}@`
    const measurements = { ...ORIGINAL_OBJECT_INERTIA.measurements, ...ORIGINAL_FRAGMENT_INERTIA.measurements }
    const key = Object.keys(measurements).find(item => item.startsWith(prefix))
    if (key === undefined) return undefined
    const scale = key.slice(prefix.length).split(',').map(Number)
    if (scale.length !== 3 || scale.some(value => !Number.isFinite(value))) return undefined
    return new THREE.Matrix4().extractRotation(matrix).scale(new THREE.Vector3(scale[0]!, scale[1]!, scale[2]!))
  }

  private lookup(name: string): RAPIER.RigidBody | undefined {
    return this.removed.has(name) ? undefined : this.host.body(name)
  }

  private requireBody(name: string) {
    const body = this.lookup(name)
    if (!body) {
      const authored = this.host.hullName?.(name)
      throw new Error(`No physics body registered for ${name}${authored && authored !== name ? ` (${authored})` : ''}`)
    }
    return body
  }

  private configureColliders(body: RAPIER.RigidBody, properties: ReturnType<typeof material>, group: number | undefined, enabled: boolean) {
    for (let i = 0; i < body.numColliders(); i++) {
      const collider = body.collider(i)
      collider.setFriction(properties.friction)
      collider.setRestitution(properties.restitution)
      collider.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
      collider.setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
      collider.setEnabled(true)
      if (!enabled) collider.setCollisionGroups(0)
      else if (group !== undefined) collider.setCollisionGroups(group)
    }
  }
}
