/** The original collision identifiers recovered from Levelinit, Balls and the modules. */
export interface OriginalCollisions {
  source: string
  floors: Record<string, string>
  players: Record<string, string>
  modules: Record<string, string[]>
  fragments: Record<string, { index: number; group: string; enabled: boolean }>
  identifiers: string[]
}

export const ORIGINAL_COLLISIONS: OriginalCollisions = {
  source: '', floors: {}, players: {}, modules: {}, fragments: {}, identifiers: [],
}

let loading: Promise<void> | undefined

/** Replace the loaded collision identifiers (used by the local-pack loader and tests). */
export function setOriginalCollisions(data: OriginalCollisions): void {
  Object.assign(ORIGINAL_COLLISIONS, data)
  PLAYER_GROUPS = originalCollisionGroups(data.players.Ball_Wood!)
}

/** Fetch the extracted collision identifiers from the local original pack once. */
export function ensureOriginalCollisions(url = '/original/collision-data.json'): Promise<void> {
  loading ??= fetch(url).then(async response => {
    if (!response.ok) throw new Error(`The original collision data needs ${url} (${response.status}); run scripts/read-original-collisions.py`)
    setOriginalCollisions(await response.json() as OriginalCollisions)
  })
  return loading
}

const COLLISION_BITS: Record<string, number> = {
  Floor: 1,
  Ball: 4,
  '': 64,
  Modul29: 128,
}

const HALF_MASK = 0xffff

/**
 * Packs an identifier into a collision group: the identifier's bit in the high
 * half, and in the low half every bit except its own (all bits for the empty
 * identifier). Two non-empty identifiers therefore only collide when different.
 */
export function originalCollisionGroups(name: string): number {
  const bit = COLLISION_BITS[name]
  if (typeof bit !== 'number') throw new Error(`Unknown original collision identifier: ${name}`)
  const low = name === '' ? HALF_MASK : HALF_MASK ^ bit
  return bit * 0x10000 + low
}
export let PLAYER_GROUPS = originalCollisionGroups('Ball')
