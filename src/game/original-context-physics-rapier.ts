// The Rapier physics host of a hosted session. It mirrors
// OriginalContextPhysics (IVP): bodies are keyed by context references
// (`#<id>`), poses come from the context's entity transforms and every
// physicalized body is written back into its entity after each step. Rapier's
// world uses the engine's render units (SCALE applied, Z reflected); the
// context stays in original units, so poses and meshes are converted here.
import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { RapierGraphPhysicsBinding } from './original-graph-physics-rapier.ts'
import type { GraphRapierPhysicsHost, GraphRapierPhysicsPose } from './original-graph-physics-rapier.ts'
import { originalEntityFrame } from './original-entity-graph.ts'
import { ORIGINAL_OBJECTS } from './original-objects.ts'
import { CKCID, originalIsChildClassOf, originalObjectReference, type OriginalContext } from './original-context.ts'
import { SCALE } from './original-data.ts'
import { GRAVITY } from './original-physics.ts'
import type { Material } from './levels.ts'
import type { GraphContactListener, GraphContactSettings, GraphPhysicsBinding } from './original-graph-bindings.ts'
import { OriginalIvpContact, type OriginalContactChange } from './original-ivp-contact.ts'
import type { IvpCollisionEvent } from './ivp-bridge.ts'

const f = Math.fround

function sameMatrix(a: readonly number[] | undefined, b: readonly number[] | undefined) {
  if (a === undefined || b === undefined || a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (f(a[index]!) !== f(b[index]!)) return false
  return true
}

/** One behavior's PhysicsContactData: the listener, its manager records and the queued output changes. */
interface ContactEntry {
  tracker: OriginalIvpContact
  changes: OriginalContactChange[]
  alive: boolean
  body: RAPIER.RigidBody
  /** Live collider-pair contact ids, so Rapier pairs become IVP-style start/end events. */
  active: Map<string, number>
  nextContact: number
}

/** One collider pair's observation, in render units as the engine Rapier observer reports. */
export interface GraphRapierContact {
  other: RAPIER.RigidBody
  normal: [number, number, number]
  point: [number, number, number] | null
  separation: number | null
  normalImpulse: number | null
  tangentImpulse: [number, number] | null
  feature1: number | null
  feature2: number | null
}

export interface GraphRapierContactSample {
  count: number
  contacts: GraphRapierContact[]
}

function isPlayerName(name: string): Material | undefined {
  const match = /^Ball_(Paper|Wood|Stone)$/i.exec(name)?.[1]?.toLowerCase()
  return match === 'paper' || match === 'wood' || match === 'stone' ? match : undefined
}

export class OriginalContextPhysicsRapier {
  readonly binding: RapierGraphPhysicsBinding
  readonly world: RAPIER.World
  private readonly bodies = new Map<string, RAPIER.RigidBody>()
  /** Bodies Physicalize created fixed: they never move, so their entities are not written back. */
  private readonly fixed = new Set<string>()
  /** PhysicsContinuousContact listeners by body reference (PhysicsObject::m_ContactData). */
  private readonly contactListeners = new Map<string, ContactEntry>()
  /** Seconds advanced by the simulation (Rapier contact delays use the authored clock). */
  private steppedSeconds = 0
  /** `Set Physics Globals` factor. The engine's Rapier path bakes the authored 2x. */
  private timeFactor = 2
  /** DeleteCollisionSurfaces waiting for the bodies to go. */
  private surfacesQueued = false
  private readonly context: OriginalContext
  /** Per-module fixed joint anchors (the engine's sharedAnchor option). */
  private readonly anchors = new Map<string, RAPIER.RigidBody>()
  /** Authored body placements, kept across body syncs (the engine catalog's are static per placement). */
  private readonly authoredPoses = new Map<string, number[]>()
  /** The matrix the last sync wrote to each entity, to tell a body pose from a later placement. */
  private readonly syncedPoses = new Map<string, number[]>()

  constructor(context: OriginalContext, world: RAPIER.World) {
    this.context = context
    this.world = world
    const host: GraphRapierPhysicsHost = {
      world,
      body: name => this.bodies.get(this.reference(name)),
      fixedBodyFor: name => this.sharedAnchor(name),
      resolveSibling: (target, name) => this.resolveSibling(target, name),
      bodyUsesAuthoredPose: name => !['P_Modul_34', 'P_Modul_25', 'PE_Balloon'].includes(this.documentOf(name) ?? ''),
      hull: (name, body) => this.hull(name, body),
      triangles: (name, body) => this.triangles(name, body),
      hullName: name => this.hullName(name),
      singleHullColliderMass: name => this.documentOf(name) === 'PE_Balloon',
      releaseFrozenOnWake: name => ['P_Modul_03', 'P_Modul_34', 'P_Modul_29', 'PE_Balloon'].includes(this.documentOf(name) ?? ''),
      releaseFrozenAwake: name => ['P_Modul_29', 'PE_Balloon'].includes(this.documentOf(name) ?? ''),
      sameModule: (name, other) => this.moduleKey(name) !== undefined && this.moduleKey(name) === this.moduleKey(other),
      authoredAnchors: name => ['P_Modul_03', 'P_Modul_17', 'P_Modul_34', 'P_Modul_19', 'P_Modul_25', 'P_Modul_30', 'P_Modul_37', 'P_Modul_41'].includes(this.documentOf(name) ?? ''),
      wakeJoints: name => !['P_Modul_29', 'P_Modul_34', 'P_Modul_19', 'P_Modul_25', 'P_Modul_30', 'P_Modul_37', 'P_Modul_41'].includes(this.documentOf(name) ?? ''),
      deferWakeImpulses: name => this.documentOf(name) === 'PE_Balloon',
      deferNewForceImpulse: name => this.documentOf(name) === 'PE_Balloon',
      additionalSolverIterations: name => {
        const document = this.documentOf(name)
        // The removed hand-port level props (OriginalSectorObject) do not add
        // solver iterations; only its graph modules do.
        return document === 'PE_Balloon' || (document !== undefined && document in ORIGINAL_OBJECTS) ? 0 : 4
      },
      player: name => this.playerMaterial(name),
      register: (name, body, settings) => {
        const reference = this.reference(name)
        // A replacement body starts without contact data (PhysicsObject::m_ContactData).
        if (this.bodies.get(reference) !== body) this.dropContact(reference)
        this.bodies.set(reference, body)
        if (settings?.fixed) this.fixed.add(reference); else this.fixed.delete(reference)
      },
      unregister: name => {
        const reference = this.reference(name)
        this.dropContact(reference)
        this.bodies.delete(reference)
        this.fixed.delete(reference)
      },
      pose: name => this.pose(name),
      frame: name => {
        // The engine's per-placement catalog frames are static, but a session
        // pool copy is re-placed between sectors (Levelinit's Set World Matrix),
        // so a referential must be read live or joints/forces keep the pose of
        // the sector that first used the copy.
        if (!this.context.isEntity(this.id(name))) return undefined
        return originalEntityFrame(this.context.entities, this.reference(name), SCALE)
      },
    }
    this.binding = new RapierGraphPhysicsBinding(host)
    const binding: GraphPhysicsBinding = this.binding
    binding.continuousContact = (name, settings) => this.continuousContact(name, settings)
  }

  /** Bodies by context reference, for the engine and the harness. */
  body(reference: string): RAPIER.RigidBody | undefined { return this.bodies.get(reference) }

  /** The physicalized entities' references, in creation order. */
  references(): string[] { return [...this.bodies.keys()] }

  /** Authored joints installed on one context reference's body, for harness observations. */
  jointCount(reference: string): number { return this.binding.debugJointCount(reference) }

  /** The authored collision surfaces one context reference's body was built from. */
  hullCount(reference: string): number | undefined { return this.binding.debugHullCount(reference) }

  /** Persistent force controller keys (`<target reference>:<controller>`) currently installed. */
  forceKeys(): string[] { return this.binding.debugForceKeys() }

  /** The body's raw Rapier state: translation, rotation, linear and angular velocity (render units). */
  state(body: RAPIER.RigidBody): number[] {
    const translation = body.translation(), rotation = body.rotation()
    const linear = body.linvel(), angular = body.angvel()
    return [
      translation.x, translation.y, translation.z,
      rotation.x, rotation.y, rotation.z, rotation.w,
      linear.x, linear.y, linear.z,
      angular.x, angular.y, angular.z,
    ]
  }

  /** The context object a live body belongs to. */
  objectOf(body: RAPIER.RigidBody) {
    for (const reference of this.bodies.keys()) {
      if (this.bodies.get(reference)?.handle === body.handle) return this.context.get(Number(reference.slice(1)))
    }
    return undefined
  }

  bodyCount(): number { return this.world.bodies.len() }

  colliderEnabled(body: RAPIER.RigidBody): boolean {
    return body.numColliders() > 0 && body.collider(0).isEnabled()
  }

  /**
   * The Ipion manager's DeleteCollisionSurfaces command (physics_RT.dll
   * 0x10008160): it fails while any body is physicalized and stays queued, to
   * be retried each frame. Rapier has no separate surface table, so once no
   * body remains the command completes, as the session IVP host does.
   */
  deleteCollisionSurfaces(): boolean {
    if (this.bodies.size === 0) return true
    this.surfacesQueued = true
    return false
  }

  /** `Set Physics Globals`: the engine's Rapier world is fixed at the authored gravity and 2x clock. */
  setGlobals(gravity: readonly number[], timeFactor: number): void {
    if (gravity[0] !== 0 || gravity[1] !== -20 || gravity[2] !== 0) {
      throw new Error(`Set Physics Globals gravity ${gravity.join(',')} differs from the Rapier world's (0,-20,0)`)
    }
    if (timeFactor !== 0 && timeFactor !== 2) {
      throw new Error(`Set Physics Globals time factor ${timeFactor} has no Rapier engine equivalent (authored values are 0 and 2)`)
    }
    if (f(this.world.gravity.y) !== f(GRAVITY)) {
      throw new Error(`The session Rapier world gravity ${this.world.gravity.y} differs from the engine's ${GRAVITY}`)
    }
    this.timeFactor = timeFactor
  }

  /**
   * The session's PostProcess: the authored force controllers apply their
   * impulses, Rapier advances, contact listeners consume the new pairs, then
   * the moving bodies' poses go back to their entities. The engine sets the
   * world timestep to the frame time, so the session does the same; a 0 factor
   * is the authored pause.
   */
  step(deltaMs: number): void {
    if (this.surfacesQueued && this.bodies.size === 0) this.surfacesQueued = false
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new Error('Invalid Rapier frame time')
    const seconds = f(deltaMs / 1000)
    if (this.timeFactor !== 0) {
      this.binding.step(deltaMs)
      this.world.timestep = seconds
      this.world.step()
      this.steppedSeconds += seconds
    }
    this.advanceContacts()
    this.sync()
    // OriginalGraphModuleInstance calls startFrame before its script frame.
    // Here the graphs already ran this frame, so advance the controller clock
    // for the next frame: a force created during that frame is then deferred
    // exactly one tick, as the native runtime does.
    this.binding.startFrame()
  }

  /**
   * `PhysicsContinuousContact`'s create callback (physics_RT.dll 0x10001470):
   * a PhysicsContactData plus a contact listener on the target body. No data
   * is created without a body, or when the body already has one.
   */
  continuousContact(name: string, settings: GraphContactSettings): GraphContactListener | undefined {
    const reference = this.reference(name)
    const body = this.bodies.get(reference)
    if (body === undefined || this.contactListeners.has(reference)) return undefined
    const entry: ContactEntry = {
      tracker: new OriginalIvpContact(body.handle, settings.groups, settings.startDelay, settings.endDelay),
      changes: [], alive: true, body, active: new Map(), nextContact: 1,
    }
    this.seedContacts(entry)
    this.contactListeners.set(reference, entry)
    return {
      get alive() { return entry.alive },
      poll: () => { const changes = entry.changes; entry.changes = []; return changes },
      stop: () => {
        if (!entry.alive) return []
        const changes = entry.tracker.stop()
        this.contactListeners.delete(reference)
        entry.alive = false
        entry.changes = []
        return changes
      },
    }
  }

  /** PhysicsObject's destructor deletes m_ContactData and stops its listener (CKIpionManager.h). */
  private dropContact(reference: string): void {
    const entry = this.contactListeners.get(reference)
    if (!entry) return
    this.contactListeners.delete(reference)
    entry.alive = false
    entry.changes.push(...entry.tracker.stop())
  }

  /** Seed a new listener with pairs already touching, as IVP does not re-fire existing contacts. */
  private seedContacts(entry: ContactEntry): void {
    for (let index = 0; index < entry.body.numColliders(); index++) {
      const collider = entry.body.collider(index)
      this.world.contactPairsWith(collider, other => {
        let touching = false
        this.world.contactPair(collider, other, manifold => { if (manifold.numContacts() > 0) touching = true })
        if (touching) entry.active.set(`${collider.handle}:${other.handle}`, entry.nextContact++)
      })
    }
  }

  /** Translate this frame's Rapier pairs into the IVP friction events the contact manager consumed. */
  private advanceContacts(): void {
    const time = this.steppedSeconds
    for (const entry of this.contactListeners.values()) {
      const events: IvpCollisionEvent[] = []
      const current = new Map<string, number>()
      for (let index = 0; index < entry.body.numColliders(); index++) {
        const collider = entry.body.collider(index)
        this.world.contactPairsWith(collider, other => {
          let touching = false
          this.world.contactPair(collider, other, manifold => { if (manifold.numContacts() > 0) touching = true })
          if (!touching) return
          const key = `${collider.handle}:${other.handle}`
          const id = entry.active.get(key) ?? entry.nextContact++
          current.set(key, id)
          if (entry.active.has(key)) return
          const otherBody = other.parent()
          if (!otherBody) return
          events.push({ kind: 'contactStart', time, contact: id, bodies: [entry.body.handle, otherBody.handle] })
        })
      }
      for (const [key, id] of entry.active) {
        if (current.has(key)) continue
        const otherHandle = Number(key.slice(key.indexOf(':') + 1))
        events.push({ kind: 'contactEnd', time, contact: id, bodies: [entry.body.handle, otherHandle] })
      }
      entry.active = current
      entry.changes.push(...entry.tracker.consume(events, body => this.contactGroup(body)))
      entry.changes.push(...entry.tracker.process(time))
    }
  }

  /**
   * `PhysicsContactManager::GetContactID` (physics_RT.dll): the other
   * entity's `Continuous Contact ID` attribute.
   */
  private contactGroup(body: number): number {
    for (const [reference, handle] of this.bodies) {
      if (handle.handle !== body) continue
      const value = this.context.get(Number(reference.slice(1)))?.attributes.get('Continuous Contact ID')
      const group = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
      return Number.isInteger(group) ? group : 0
    }
    return 0
  }

  /**
   * The engine Rapier observer's contact sample: every narrow-phase contact
   * counts and the list carries the manifold's render-space normal.
   */
  contacts(body: RAPIER.RigidBody, detail: boolean): GraphRapierContactSample {
    const sample: GraphRapierContactSample = { count: 0, contacts: [] }
    if (body.numColliders() === 0) return sample
    const player = body.collider(0)
    this.world.contactPairsWith(player, other => {
      this.world.contactPair(player, other, (manifold, flipped) => {
        const count = manifold.numContacts()
        sample.count += count
        if (!count) return
        const otherBody = other.parent()
        if (!otherBody) return
        const raw = manifold.normal()
        const normal: [number, number, number] = flipped ? [raw.x, raw.y, raw.z] : [-raw.x, -raw.y, -raw.z]
        for (let index = 0; index < count; index++) {
          let point: [number, number, number] | null = null
          if (detail) {
            const local = flipped ? manifold.localContactPoint1(index) : manifold.localContactPoint2(index)
            if (local) {
              const value = new THREE.Vector3(local.x, local.y, local.z)
                .applyQuaternion(new THREE.Quaternion(other.rotation().x, other.rotation().y, other.rotation().z, other.rotation().w))
              value.add(new THREE.Vector3(other.translation().x, other.translation().y, other.translation().z))
              point = [value.x, value.y, value.z]
            }
          }
          sample.contacts.push({
            other: otherBody,
            normal,
            point,
            separation: detail ? manifold.contactDist(index) : null,
            normalImpulse: detail ? manifold.contactImpulse(index) : null,
            tangentImpulse: detail ? [manifold.contactTangentImpulseX(index), manifold.contactTangentImpulseY(index)] : null,
            feature1: detail ? manifold.contactFid1(index) : null,
            feature2: detail ? manifold.contactFid2(index) : null,
          })
        }
      })
    })
    return sample
  }

  /** Write each moving body's simulated pose back into its entity, keeping the entity's scale. */
  sync(): void {
    for (const [reference, body] of this.bodies) {
      if (this.fixed.has(reference)) continue
      const translation = body.translation(), rotation = body.rotation()
      const { scale } = this.decompose(reference)
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(translation.x / SCALE, translation.y / SCALE, -translation.z / SCALE),
        new THREE.Quaternion(-rotation.x, -rotation.y, rotation.z, rotation.w),
        scale,
      )
      const values = matrix.toArray().map(f)
      this.context.entities.setWorldMatrix(reference, values, false)
      this.syncedPoses.set(reference, values)
    }
  }

  /** A physicalize target's authored placement in render units, with the original matrix for inertia. */
  private pose(name: string): GraphRapierPhysicsPose {
    const document = this.documentOf(name)
    // The removed hand-port level props (OriginalSectorObject) sit at their
    // placement matrix: the level object times the module document's `_MF`
    // matrix. The Levelinit copy is that placement times its own local offset,
    // so use the copy's placement root here.
    if (document !== undefined && document in ORIGINAL_OBJECTS) {
      const root = this.moduleRoot(name)
      if (!root) throw new Error(`Physicalize ${name} has no placement root`)
      const matrix = root.matrix
      return {
        position: [f(matrix[12]! * SCALE), f(matrix[13]! * SCALE), f(-matrix[14]! * SCALE)],
        rotation: [0, 0, 0, 1],
        matrix,
      }
    }
    const { position, rotation, matrix } = this.decompose(name)
    // The engine's module host places bodies with an identity rotation and
    // encodes the authored orientation in their hull points; its player body
    // keeps the ball's own rotation (a sphere for wood/stone).
    const player = this.playerMaterial(name) !== undefined
    if (player) {
      return {
        position: [f(position[0] * SCALE), f(position[1] * SCALE), f(-position[2] * SCALE)],
        rotation: [f(-rotation.x), f(-rotation.y), rotation.z, rotation.w],
        matrix,
      }
    }
    const reference = this.reference(name)
    const synced = this.syncedPoses.get(reference)
    let authored = this.authoredPoses.get(reference)
    // A sync writes the body pose (identity rotation) back to the entity; a
    // later Levelinit placement changes the entity again. Only the latter is
    // the authored placement the engine catalog keeps.
    if (authored === undefined || (synced !== undefined && !sameMatrix(matrix, synced))) {
      authored = matrix.slice()
      this.authoredPoses.set(reference, authored)
    }
    return {
      position: [f(authored[12]! * SCALE), f(authored[13]! * SCALE), f(-authored[14]! * SCALE)],
      rotation: [0, 0, 0, 1],
      matrix: authored,
    }
  }

  /**
   * Body-local convex points in render units: the target body's world rotation
   * with the translation removed, then the render scale and Z reflection.
   */
  private hull(name: string, body?: string): Float32Array | undefined {
    const mesh = this.mesh(name)
    if (!mesh) return undefined
    const { matrix, local } = this.collisionFrame(name, body)
    return this.transformPoints(mesh.positions, matrix, name, local)
  }

  /**
   * The frame collision points are built in. The removed hand-port level
   * props (`OriginalSectorObject`) bake their placement rotation into the
   * points (world-rotated, body rotation identity); graph modules and the
   * player keep body-local points and the body pose carries the rotation.
   */
  private collisionFrame(name: string, body?: string): { matrix: readonly number[]; local: boolean } {
    const document = this.documentOf(body ?? name)
    if (document !== undefined && document in ORIGINAL_OBJECTS) {
      const root = this.moduleRoot(body ?? name)
      if (!root) throw new Error(`Collision surface ${name} has no placement root`)
      return { matrix: root.matrix, local: false }
    }
    return { matrix: this.decompose(body ?? name).matrix, local: this.playerMaterial(name) !== undefined }
  }

  /** Body-local triangle soup for a concave Physicalize, in render units. */
  private triangles(name: string, body?: string): Float32Array | undefined {
    const mesh = this.mesh(name)
    if (!mesh) return undefined
    const { matrix, local } = this.collisionFrame(name, body)
    const points = this.transformPoints(mesh.positions, matrix, name, local)
    const triangles = new Float32Array(mesh.indices.length * 3)
    for (let index = 0; index < mesh.indices.length; index++) {
      const vertex = mesh.indices[index]!
      if (vertex < 0 || vertex * 3 + 2 >= points.length) throw new Error(`Invalid triangle index in concave mesh ${name}`)
      triangles[index * 3] = points[vertex * 3]!
      triangles[index * 3 + 1] = points[vertex * 3 + 1]!
      triangles[index * 3 + 2] = points[vertex * 3 + 2]!
    }
    return triangles
  }

  /**
   * Body-local collision points in render units. The exported mesh positions
   * are in the target body's own frame (the source modules place their
   * collision meshes at the module origin), so only the body's world scale and
   * the render Z reflection apply; the body pose carries the orientation, as
   * in OriginalContextPhysics' IVP hulls.
   */
  private transformPoints(positions: readonly number[], world: readonly number[], name: string, local = true): Float32Array {
    if (positions.length === 0 || positions.length % 3 !== 0) throw new Error(`Mesh ${name} has malformed collision positions`)
    if (local) {
      const scale = new THREE.Vector3().setFromMatrixScale(new THREE.Matrix4().fromArray(world))
      const points = new Float32Array(positions.length)
      for (let index = 0; index < positions.length; index += 3) {
        points[index] = f(f(positions[index]!) * f(scale.x * SCALE))
        points[index + 1] = f(f(positions[index + 1]!) * f(scale.y * SCALE))
        points[index + 2] = f(f(positions[index + 2]!) * f(-scale.z * SCALE))
      }
      return points
    }
    const localWorld = new THREE.Matrix4().fromArray(world)
    localWorld.setPosition(0, 0, 0)
    localWorld.premultiply(new THREE.Matrix4().makeScale(SCALE, SCALE, -SCALE))
    const points = new Float32Array(positions.length)
    const vertex = new THREE.Vector3()
    for (let index = 0; index < positions.length; index += 3) {
      vertex.set(f(positions[index]!), f(positions[index + 1]!), f(positions[index + 2]!)).applyMatrix4(localWorld)
      points[index] = vertex.x
      points[index + 1] = vertex.y
      points[index + 2] = vertex.z
    }
    return points
  }

  private id(name: string): number {
    const object = this.context.resolve(name)
    if (!object) throw new Error(`Physics target ${name} is not in the context`)
    return object.id
  }

  private reference(name: string): string { return originalObjectReference(this.id(name)) }

  private documentOf(name: string): string | undefined {
    return this.context.resolve(name)?.document
  }

  private playerMaterial(name: string): Material | undefined {
    const object = this.context.resolve(name)
    return object ? isPlayerName(object.name) : undefined
  }

  /**
   * The engine hostile binding gives P_Modul_26, P_Modul_29 and PE_Balloon one
   * fixed anchor at the placement origin (OriginalGraphModuleInstance's
   * sharedAnchor). The module MF entity's world pose is that placement origin
   * (its local matrix is the identity).
   */
  private sharedAnchor(name: string): RAPIER.RigidBody | undefined {
    const document = this.documentOf(name)
    if (!document || !['P_Modul_26', 'P_Modul_29', 'PE_Balloon'].includes(document)) return undefined
    const existing = this.anchors.get(document)
    if (existing) return existing
    const mf = this.context.byName(`${document}_MF`).find(item => item.document === document && this.context.isEntity(item.id))
    const matrix = mf ? this.context.worldMatrix(mf.id) : undefined
    if (!matrix) throw new Error(`The ${document}_MF shared joint anchor is missing`)
    const anchor = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(
      f(matrix[12]! * SCALE), f(matrix[13]! * SCALE), f(-matrix[14]! * SCALE),
    ))
    this.anchors.set(document, anchor)
    return anchor
  }

  /**
   * The module instance a target belongs to: the root entity above it (the
   * level placement, or the module MF for a document's own objects). Two
   * copies with identical local names must not share joints or frozen state.
   */
  private moduleRoot(name: string): { key: string; matrix: number[] } | undefined {
    let object = this.context.resolve(name)
    if (!object) return undefined
    while (true) {
      const parent = this.context.parentOf(object.id)
      if (parent === undefined) break
      const next = this.context.get(parent)
      if (!next) break
      object = next
    }
    const matrix = this.context.worldMatrix(object.id)
    return matrix ? { key: originalObjectReference(object.id), matrix } : undefined
  }

  private moduleKey(name: string): string | undefined {
    return this.moduleRoot(name)?.key
  }

  private resolveSibling(target: string, name: string): string {
    if (/^#\d+$/.test(name)) return name
    const key = this.moduleKey(target)
    if (key === undefined) return name
    const candidate = this.context.byName(name)
      .find(object => this.context.isEntity(object.id) && this.moduleKey(originalObjectReference(object.id)) === key)
    return candidate ? originalObjectReference(candidate.id) : name
  }

  /** The exported mesh name behind a hull reference, with a Levelinit copy suffix removed. */
  private hullName(name: string): string {
    const object = this.context.resolve(name)
    if (!object) return name
    if (!/\d{3}$/.test(object.name)) return object.name
    const base = object.name.slice(0, -3)
    const original = this.context.byName(base).some(item => item.document === object.document && item.classId === object.classId)
    return original ? base : object.name
  }

  /** A Physicalize hull: a mesh, or an entity's current mesh. */
  private mesh(name: string) {
    const object = this.context.get(this.id(name))!
    const meshId = originalIsChildClassOf(object.classId, CKCID.MESH) ? object.id : object.meshes?.[0]
    if (meshId === undefined) return undefined
    const mesh = this.context.get(meshId)
    if (!mesh?.geometry) throw new Error(`Mesh of physics hull ${object.name} has no exported geometry`)
    return mesh.geometry
  }

  private decompose(name: string) {
    const matrix = this.context.worldMatrix(this.id(name))
    if (!matrix) throw new Error(`Physics target ${name} is not a 3D entity`)
    const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3()
    new THREE.Matrix4().fromArray(matrix).decompose(position, rotation, scale)
    rotation.normalize()
    return { position: position.toArray() as [number, number, number], rotation, scale, matrix }
  }
}
