import RAPIER from '@dimforge/rapier3d-compat'
import inertiaMeasurements from './original-player-inertia.json' with { type: 'json' }
import type { Material } from './levels.ts'
import { SCALE } from './original-data.ts'
import { PLAYER_PHYSICS, configureBody, configureContact } from './original-physics.ts'
import { PLAYER_GROUPS } from './original-collisions.ts'

export const ORIGINAL_PLAYER_INERTIA = inertiaMeasurements

export interface OriginalPlayerBody {
  index: number
  fixed: boolean
  startFrozen: boolean
  enableCollision: boolean
  automaticMassCenter: boolean
  massCenter: number[]
  shape: 'convex' | 'sphere'
  center?: number[]
  radius?: number
}

export interface OriginalPlayerKey {
  name: 'right' | 'left' | 'backward' | 'forward'
  keyBehavior: number
  forceBehavior: number
  direction: number[]
  directionReference: string
  wakeOnCreate: boolean
  wakeOnShutdown: boolean
}

export interface OriginalPlayerData {
  source: string
  bodies: OriginalPlayerBody[]
  input: { wakeBehavior: number; keys: OriginalPlayerKey[] }
}

const SOLID_SPHERE_FACTOR = 0.4

let stored: OriginalPlayerData | undefined
let loading: Promise<void> | undefined

export function setOriginalPlayerData(data: OriginalPlayerData): void {
  stored = data
}

export function originalPlayerData(): OriginalPlayerData {
  if (!stored) throw new Error('The original player needs the extracted player data; run scripts/read-original-player.py')
  return stored
}

/** Load the extracted player settings from the local pack once; later calls reuse the first request. */
export function ensureOriginalPlayerData(url = '/original/player-data.json'): Promise<void> {
  loading ??= fetch(url).then(async response => {
    if (!response.ok) throw new Error(`The original player needs ${url} (${response.status}); run scripts/read-original-player.py`)
    setOriginalPlayerData(await response.json() as OriginalPlayerData)
  })
  return loading
}

function sphereRadius(): number {
  return originalPlayerData().bodies.find(b => b.shape === 'sphere')!.radius!
}

/** Principal inertia of a player ball of the given material, in render units. */
export function playerInertia(kind: Material): { x: number; y: number; z: number } {
  const perMass = kind === 'paper'
    ? ORIGINAL_PLAYER_INERTIA.measurements.paper.inertiaPerMass as number[]
    : Array.from({ length: 3 }, () => SOLID_SPHERE_FACTOR * sphereRadius() ** 2)
  const mass = PLAYER_PHYSICS[kind].mass
  const values = perMass.map(v => v * mass * SCALE ** 2)
  const length = Math.sqrt(values[0]! * values[0]! + values[1]! * values[1]! + values[2]! * values[2]!)
  const minimum = length * ORIGINAL_PLAYER_INERTIA.minimumAxisFactor
  return {
    x: Math.max(values[0]!, minimum),
    y: Math.max(values[1]!, minimum),
    z: Math.max(values[2]!, minimum),
  }
}

/** Swap the player body's collider for the given material, keeping the body itself. */
export function replacePlayerCollider(world: RAPIER.World, body: RAPIER.RigidBody, kind: Material, vertices?: Float32Array): RAPIER.Collider {
  const settings = originalPlayerData().bodies.find(b => b.shape === (kind === 'paper' ? 'convex' : 'sphere'))!
  const material = PLAYER_PHYSICS[kind]
  if (kind === 'paper' && !vertices) throw new Error('Original paper player requires its convex mesh')
  const shape = kind === 'paper'
    ? RAPIER.ColliderDesc.convexHull(vertices!)
    : RAPIER.ColliderDesc.ball(settings.radius! * SCALE)
  if (!shape) throw new Error(`Unable to build original ${kind} player collision shape`)
  while (body.numColliders() > 0) world.removeCollider(body.collider(0), false)
  shape.setMass(material.mass).setCollisionGroups(settings.enableCollision ? PLAYER_GROUPS : 0)
  const collider = world.createCollider(configureContact(shape, material), body)
  body.recomputeMassPropertiesFromColliders()
  const centre = { x: settings.massCenter[0]! * SCALE, y: settings.massCenter[1]! * SCALE, z: -settings.massCenter[2]! * SCALE }
  collider.setMassProperties(material.mass, centre, playerInertia(kind), { w: 1, x: 0, y: 0, z: 0 })
  body.recomputeMassPropertiesFromColliders()
  configureBody(body, material)
  return collider
}
