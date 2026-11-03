
// Recovered physics settings of the original game's loose objects (crates,
// paper, wood and stone balls, domes), loaded from the local object table.
// The graph session physicalizes the objects from their authored scripts; the
// table tells the Rapier fallback which documents are loose objects.

export type OriginalObjectKind = 'P_Box' | 'P_Ball_Paper' | 'P_Dome' | 'P_Ball_Wood' | 'P_Ball_Stone'

interface OriginalBodySettings {
  source: string
  activation: number
  reset: number
  fixed: boolean
  friction: number
  restitution: number
  mass: number
  collisionGroup: string
  startFrozen: boolean
  enableCollision: boolean
  automaticMassCenter: boolean
  linearDamping: number
  angularDamping: number
  massCenter: number[]
}

export interface OriginalConvexObjectSettings extends OriginalBodySettings {
  shape: 'convex'
}

export interface OriginalSphereObjectSettings extends OriginalBodySettings {
  shape: 'sphere'
  radius: number
  ballCenter: number[]
}

export type OriginalObjectSettings = OriginalConvexObjectSettings | OriginalSphereObjectSettings

export type OriginalObjectTable = Record<OriginalObjectKind, OriginalObjectSettings>

/** Filled by `setOriginalObjects`; the object's identity never changes. */
export const ORIGINAL_OBJECTS = {} as OriginalObjectTable

export function setOriginalObjects(data: OriginalObjectTable): void {
  Object.assign(ORIGINAL_OBJECTS, data)
}

let objectsLoading: Promise<void> | undefined

export function ensureOriginalObjects(url = '/original/object-data.json'): Promise<void> {
  objectsLoading ??= loadObjectTable(url)
  return objectsLoading
}

async function loadObjectTable(url: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`The original object table needs ${url} (${response.status}); run scripts/read-original-objects.py`)
  }
  setOriginalObjects(await response.json())
}
