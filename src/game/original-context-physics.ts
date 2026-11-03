// The IVP physics host of a hosted session: bodies are keyed by context
// references (`#<id>`), hulls come from the context's mesh geometry and poses
// from the context's entity transforms, all in original units. After each
// physics step the moving bodies' poses are written back to their entities so
// the graphs read where the simulation put them.
import * as THREE from 'three'
import { IvpGraphPhysicsBinding } from './original-graph-physics-ivp.ts'
import type { GraphIvpPhysicsHost, GraphIvpPhysicsPose } from './original-graph-physics-ivp.ts'
import { originalEntityFrame } from './original-entity-graph.ts'
import { CKCID, originalIsChildClassOf, originalObjectReference, type OriginalContext } from './original-context.ts'
import type { IvpWorld } from './ivp-bridge.ts'
import type { GraphContactListener, GraphContactSettings, GraphPhysicsBinding } from './original-graph-bindings.ts'
import { OriginalIvpContact, type OriginalContactChange } from './original-ivp-contact.ts'
import { OriginalPhysicsClock } from './original-physics-clock.ts'

const f = Math.fround

/** One behavior's PhysicsContactData: the listener, its manager records and the queued output changes. */
interface ContactEntry {
  tracker: OriginalIvpContact
  changes: OriginalContactChange[]
  alive: boolean
}

/** A hull's vertices scaled by the body's world scale, duplicates dropped (as the module host does). */
function hullPoints(positions: readonly number[], scale: THREE.Vector3): Float32Array {
  const unique = new Map<string, number[]>()
  for (let i = 0; i < positions.length; i += 3) {
    const point = [f(positions[i]! * scale.x), f(positions[i + 1]! * scale.y), f(positions[i + 2]! * scale.z)]
    unique.set(point.join(' '), point)
  }
  return Float32Array.from([...unique.values()].flat())
}

/** A concave mesh's faces scaled by the body's world scale, as nine floats each. */
function trianglePoints(positions: readonly number[], indices: readonly number[], name: string, scale: THREE.Vector3): Float32Array {
  const points = new Float32Array(indices.length * 3)
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i]!
    if (index < 0 || index * 3 + 2 >= positions.length) throw new Error(`Invalid triangle index in concave mesh ${name}`)
    points[i * 3] = f(positions[index * 3]! * scale.x)
    points[i * 3 + 1] = f(positions[index * 3 + 1]! * scale.y)
    points[i * 3 + 2] = f(positions[index * 3 + 2]! * scale.z)
  }
  return points
}

export class OriginalContextPhysics {
  readonly binding: IvpGraphPhysicsBinding
  private readonly bodies = new Map<string, number>()
  /** Bodies Physicalize created fixed: they never move, so their entities are not written back. */
  private readonly fixed = new Set<string>()
  /** PhysicsContinuousContact listeners by body reference (PhysicsObject::m_ContactData). */
  private readonly contacts = new Map<string, ContactEntry>()
  private readonly clock = new OriginalPhysicsClock()
  /**
   * physics_RT.dll's time factor: Set Physics Globals stores factor * 0.001f
   * (0x1000562E) and the manager's resets store 0.001f (0x10007986,
   * 0x10007B1D, 0x10007EB3), so the factor is 1 until a block sets it.
   */
  private timeFactor = 1
  /** DeleteCollisionSurfaces waiting for the bodies to go. */
  private surfacesQueued = false
  private readonly context: OriginalContext
  private readonly world: IvpWorld

  constructor(context: OriginalContext, world: IvpWorld) {
    this.context = context
    this.world = world
    const host: GraphIvpPhysicsHost = {
      world,
      body: name => this.bodies.get(this.reference(name)),
      hull: (name, body) => {
        const mesh = this.mesh(name)
        if (!mesh) return undefined
        return hullPoints(mesh.positions, this.decompose(body ?? name).scale)
      },
      triangles: (name, body) => {
        const mesh = this.mesh(name)
        if (!mesh) return undefined
        return trianglePoints(mesh.positions, mesh.indices, name, this.decompose(body ?? name).scale)
      },
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
      pose: name => {
        const { position, rotation, matrix } = this.decompose(name)
        return { position, rotation: rotation.toArray() as GraphIvpPhysicsPose['rotation'], matrix }
      },
      frame: name => this.context.isEntity(this.id(name)) ? originalEntityFrame(this.context.entities, this.reference(name), 1) : undefined,
    }
    this.binding = new IvpGraphPhysicsBinding(host, { originalUnits: true, physicalAnchors: true })
    // The contact manager belongs to this host: the session binding is the
    // graph physics binding, so it serves PhysicsContinuousContact here.
    const binding: GraphPhysicsBinding = this.binding
    binding.continuousContact = (name, settings) => this.continuousContact(name, settings)
  }

  /** Bodies by context reference, for the engine and the harness. */
  body(reference: string): number | undefined { return this.bodies.get(reference) }

  /** The physicalized entities' references, in creation order. */
  references(): string[] { return [...this.bodies.keys()] }

  /** Authored joints installed on one context reference's body, for harness observations. */
  jointCount(reference: string): number { return this.binding.debugJointCount(reference) }

  /** The authored convex hulls one context reference's body was built from. */
  hullCount(reference: string): number | undefined { return this.binding.debugHullCount(reference) }

  /** Persistent force controller keys (`<target reference>:<controller>`) currently installed. */
  forceKeys(): string[] { return this.binding.debugForceKeys() }

  /**
   * The Ipion manager's DeleteCollisionSurfaces command (physics_RT.dll
   * 0x10008160): it fails while any body is physicalized and stays queued, to
   * be retried each frame; once it runs it empties the surface table, which the
   * port's IVP world does not keep apart from the bodies.
   */
  deleteCollisionSurfaces(): boolean {
    if (this.bodies.size === 0) return true
    this.surfacesQueued = true
    return false
  }

  /** `Set Physics Globals`: the authored gravity is the world's; the time factor scales the next steps. */
  setGlobals(gravity: readonly number[], timeFactor: number): void {
    if (gravity[0] !== 0 || gravity[1] !== -20 || gravity[2] !== 0) throw new Error(`Set Physics Globals gravity ${gravity.join(',')} differs from the IVP world's (0,-20,0)`)
    this.timeFactor = timeFactor
  }

  /**
   * physics_RT.dll PostProcess, after the frame's behaviors: the smoothed
   * frame time scaled by the time factor advances the world, then the bodies'
   * poses go back to their entities. The simulation's friction events go to
   * every continuous-contact listener and PhysicsContactManager::Process
   * advances their delayed outputs (CKIpionManager::Simulate, physics_RT.dll
   * 0x10007CE0, calls Process 0x100017A0 at 0x10007D65); both see the
   * environment's current time.
   */
  step(deltaMs: number): void {
    if (this.surfacesQueued && this.bodies.size === 0) this.surfacesQueued = false
    const seconds = this.clock.step(deltaMs, this.timeFactor)
    if (seconds > 0) this.world.step(seconds)
    const events = this.world.drainEvents()
    const time = this.world.time
    for (const entry of this.contacts.values()) {
      entry.changes.push(...entry.tracker.consume(events, body => this.contactGroup(body)))
      entry.changes.push(...entry.tracker.process(time))
    }
    this.sync()
  }

  /**
   * `PhysicsContinuousContact`'s create callback (physics_RT.dll 0x10001470):
   * a PhysicsContactData plus an IVP friction listener on the target body. No
   * data is created without a body, or when the body already has one.
   */
  continuousContact(name: string, settings: GraphContactSettings): GraphContactListener | undefined {
    const reference = this.reference(name)
    const body = this.bodies.get(reference)
    if (body === undefined || this.contacts.has(reference)) return undefined
    const entry: ContactEntry = {
      tracker: new OriginalIvpContact(body, settings.groups, settings.startDelay, settings.endDelay), changes: [], alive: true,
    }
    this.contacts.set(reference, entry)
    return {
      get alive() { return entry.alive },
      poll: () => { const changes = entry.changes; entry.changes = []; return changes },
      stop: () => {
        if (!entry.alive) return []
        const changes = entry.tracker.stop()
        this.contacts.delete(reference)
        entry.alive = false
        entry.changes = []
        return changes
      },
    }
  }

  /** PhysicsObject's destructor deletes m_ContactData and stops its listener (CKIpionManager.h). */
  private dropContact(reference: string): void {
    const entry = this.contacts.get(reference)
    if (!entry) return
    this.contacts.delete(reference)
    entry.alive = false
    entry.changes.push(...entry.tracker.stop())
  }

  /**
   * `PhysicsContactManager::GetContactID` (physics_RT.dll): the other
   * entity's `Continuous Contact ID` attribute, read as the CKPGUID_INT
   * parameter the attribute manager creates. Levelinit's Set Attribute keeps
   * some authored cells as strings, so a numeric value is read as an int.
   */
  private contactGroup(body: number): number {
    for (const [reference, handle] of this.bodies) {
      if (handle !== body) continue
      const value = this.context.get(Number(reference.slice(1)))?.attributes.get('Continuous Contact ID')
      const group = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
      return Number.isInteger(group) ? group : 0
    }
    return 0
  }

  /** Write each moving body's simulated pose back into its entity, keeping the entity's scale. */
  sync(): void {
    for (const [reference, body] of this.bodies) {
      if (this.fixed.has(reference)) continue
      const state = this.world.state(body)
      const { scale } = this.decompose(reference)
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(state[0], state[1], state[2]),
        new THREE.Quaternion(state[3], state[4], state[5], state[6]),
        scale,
      )
      this.context.entities.setWorldMatrix(reference, matrix.toArray().map(f), false)
    }
  }

  private id(name: string): number {
    const object = this.context.resolve(name)
    if (!object) throw new Error(`Physics target ${name} is not in the context`)
    return object.id
  }

  private reference(name: string): string { return originalObjectReference(this.id(name)) }

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
