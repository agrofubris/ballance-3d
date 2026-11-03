export interface OriginalHinge {
  source: string
  physicalizeIndex: number
  hingeIndex: number
  target: string
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
  hulls: string[]
  massCenter: number[]
  anchorObject: string
  hingeFrame: number[]
  limitsEnabled: boolean
  lowerLimit: number
  upperLimit: number
  wakeDistance: number | null
}

export type HingeKind = string

async function loadHinges(): Promise<Record<string, OriginalHinge>> {
  const response = await fetch('/original/hinge-data.json')
  if (!response.ok) throw new Error(`The original session needs the exported hinge data; run scripts/prepare-original.py (${response.status})`)
  return await response.json() as Record<string, OriginalHinge>
}

export const ORIGINAL_HINGES = await loadHinges()
