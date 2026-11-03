import { ensureOriginalDataArrays, originalDataArray } from './original-data-arrays.ts'
import { ensureOriginalCameraData } from './original-camera-rig.ts'
import { ensureOriginalCollisions } from './original-collisions.ts'
import { ensureOriginalObjects } from './original-objects.ts'
import { ensureOriginalPlayerData } from './original-player.ts'
import { OriginalContext, type OriginalObjectTable, type OriginalPathKind } from './original-context.ts'
import { OriginalSession, type OriginalSessionSimulation } from './original-session.ts'
import { OriginalPlanarFilter } from './original-planar-filter.ts'
import { loadOriginalGraph } from './original-graph-loader.ts'
import { GameplayBinding } from './original-gameplay-binding.ts'
import { OriginalParticleRenderer } from './original-particle-system.ts'
import { originalRenderPackMeshes, type OriginalRenderPack } from './original-ray.ts'
import type { OriginalDocument } from './original-data.ts'
import type { OriginalGraphData } from './original-graph.ts'
import type { GraphBinding, GraphPhysicsBinding } from './original-graph-bindings.ts'
import type { GraphInputManager } from './original-input-manager.ts'
import type { GraphMovieBinding } from './original-graph-movie.ts'
import type { GraphSystemBinding } from './original-graph-system.ts'

/** The documents base's boot, the menu and Level 1 load (the probe's DOCS output). */
export const ORIGINAL_SESSION_DOCUMENTS = [
  'base', 'Intro', 'Language', 'Sound', 'Menu', 'Gameplay', 'AnimTrafo', 'Camera', 'Levelinit', 'Balls',
  'MenuLevel', 'Musicfiles', 'Level_01', 'P_Extra_Life', 'P_Extra_Point', 'P_Modul_01', 'P_Modul_34',
  'PC_TwoFlames', 'PS_FourFlames', 'PE_Balloon', 'P_Trafo_Stone', 'P_Trafo_Wood', 'P_Ball_Paper',
  'P_Ball_Stone', 'P_Ball_Wood', 'P_Box', 'P_Dome', 'Tutorial',
] as const

/** The moving-part modules the later levels place (Level 1 uses only P_Modul_01 and P_Modul_34). */
export const ORIGINAL_MODULE_DOCUMENTS = [
  'P_Modul_03', 'P_Modul_08', 'P_Modul_17', 'P_Modul_18', 'P_Modul_19', 'P_Modul_25',
  'P_Modul_26', 'P_Modul_29', 'P_Modul_30', 'P_Modul_37', 'P_Modul_41', 'P_Trafo_Paper',
] as const

/**
 * Every document a full game can load: the session set, all twelve levels and
 * every module. Load Level reads its document synchronously, so the game
 * prefetches them all; the original loaded each level file behind its loading
 * screen instead.
 */
export const ORIGINAL_GAME_DOCUMENTS: readonly string[] = [...new Set([
  ...ORIGINAL_SESSION_DOCUMENTS,
  ...Array.from({ length: 12 }, (_, index) => `Level_${String(index + 1).padStart(2, '0')}`),
  ...ORIGINAL_MODULE_DOCUMENTS,
])]

/** The authored `GameSettings` `Tutorial?` default; the original never rewrites it. */
export function originalTutorialDefault(): boolean {
  const array = originalDataArray('GameSettings')
  const column = array?.columns.findIndex(item => item.name === 'Tutorial?') ?? -1
  const value = column < 0 ? undefined : array?.rows[0]?.[column]
  if (typeof value !== 'boolean') throw new Error('The original session needs the exported GameSettings Tutorial? default')
  return value
}

const ROOT = '/original'
const FOLDERS: Record<OriginalPathKind, string> = { data: '', sound: 'Sounds/', bitmap: 'Textures/' }

export interface OriginalInstall {
  readonly files: readonly string[]
  has(path: string): boolean
  url(path: string): string
  readFile(path: string): Uint8Array | undefined
  /** A Sounds folder WAV's format rate (nSamplesPerSec), by file name; undefined when the install lacks it. */
  waveRate(file: string): number | undefined
  /** The installer's `Ballance\Settings` registry value (DWORD or string); undefined when it wrote none. */
  registry(name: string): number | string | undefined
}

export interface OriginalSessionCreated {
  context: OriginalContext
  session: OriginalSession
  install: OriginalInstall
  prefetched: readonly string[]
  /** The prefetched render exports, by lower-case document stem. */
  packs: ReadonlyMap<string, OriginalDocument | undefined>
  /** Every texture file the prefetched packs reference, unique. */
  textureFiles: readonly string[]
}

export interface CreateOriginalSessionOptions {
  system: GraphSystemBinding
  movie: GraphMovieBinding | ((install: OriginalInstall) => GraphMovieBinding)
  install?: OriginalInstall
  input?: GraphInputManager
  binding?: GraphBinding | ((context: OriginalContext) => GraphBinding)
  physics?: GraphPhysicsBinding
  /** A simulation, or a factory that builds it once the session's context exists. */
  simulation?: OriginalSessionSimulation | ((context: OriginalContext) => OriginalSessionSimulation)
  particles?: OriginalParticleRenderer
  /** The renderer's post-sprite filter list; a headless session records instead. */
  filter?: OriginalPlanarFilter
  documents?: readonly string[]
  prefetch?: readonly string[]
  play?: boolean
}

interface InstallIndex {
  files?: unknown
  waveRates?: unknown
  registry?: unknown
}

function normalize(path: string): string {
  return path.split('\\').join('/').replace(/^\.\.\//, '')
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

async function fetchBytes(url: string): Promise<Uint8Array | undefined> {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    return undefined
  }
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined
    return await response.json() as T
  } catch {
    return undefined
  }
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((byte, index) => bytes[index] === byte)) return undefined
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function defaultBinding(): GraphBinding {
  return new GameplayBinding({
    level: 1,
    object: () => undefined,
    light: { setColor: () => {} },
    scrollTexture: () => {},
    sky: { create: () => {}, update: () => {}, show: () => {}, hide: () => {} },
    activeBall: () => 'Ball_Wood',
  }, { tutorial: originalTutorialDefault(), invertRotation: false })
}

function recordingPhysics(): GraphPhysicsBinding {
  return { physicalize: () => {}, unphysicalize: () => {}, force: () => {}, joint: () => {}, wake: () => {} }
}

export async function loadOriginalInstall(): Promise<OriginalInstall> {
  const index = await fetchJson<InstallIndex>(`${ROOT}/install/files.json`)
  if (!index || !Array.isArray(index.files) || !index.files.every(file => typeof file === 'string')) {
    throw new Error('The original session needs the install files; run scripts/export-original-install-files.py')
  }
  const files = index.files.map(file => normalize(file as string))
  for (const file of files) {
    if (!file || file.startsWith('/') || file.split('/').includes('..')) throw new Error(`Invalid install file ${JSON.stringify(file)}`)
  }
  const contents = new Map<string, Uint8Array>()
  await Promise.all(files.map(async file => {
    const bytes = await fetchBytes(`${ROOT}/install/${encodePath(file)}`)
    if (!bytes) throw new Error(`Install file ${file} is listed but missing from the local pack`)
    contents.set(file, bytes)
  }))
  const url = (path: string) => `${ROOT}/install/${encodePath(normalize(path))}`
  const rates = index.waveRates
  if (!rates || typeof rates !== 'object' || !Object.values(rates).every(rate => typeof rate === 'number')) {
    throw new Error('The original session needs the wave format rates; run scripts/export-original-install-files.py')
  }
  const registry = index.registry
  if (!registry || typeof registry !== 'object' || !Object.values(registry).every(value => typeof value === 'number' || typeof value === 'string')) {
    throw new Error('The original session needs the install registry settings; run scripts/export-original-install-files.py')
  }
  return {
    files,
    has: path => contents.has(normalize(path)),
    url,
    readFile: path => contents.get(normalize(path)),
    waveRate: file => (rates as Record<string, number>)[normalize(file).split('/').pop()!.toLowerCase()],
    registry: name => {
      const entry = Object.entries(registry as Record<string, number | string>).find(([key]) => key.toLowerCase() === name.toLowerCase())
      return entry?.[1]
    },
  }
}

export async function createOriginalSession(options: CreateOriginalSessionOptions): Promise<OriginalSessionCreated> {
  const [arrays, install] = await Promise.all([
    ensureOriginalDataArrays(`${ROOT}/data-arrays.json`),
    options.install ?? loadOriginalInstall(),
    ensureOriginalCameraData(`${ROOT}/camera-data.json`),
    ensureOriginalCollisions(`${ROOT}/collision-data.json`),
    ensureOriginalObjects(`${ROOT}/object-data.json`),
    ensureOriginalPlayerData(`${ROOT}/player-data.json`),
  ])
  if (!arrays) throw new Error('The original session needs the exported Data Arrays')
  const prefetched = [...(options.prefetch ?? ORIGINAL_SESSION_DOCUMENTS)]
  const objectFiles = await Promise.all(prefetched.map(async document => {
    const table = await fetchJson<OriginalObjectTable>(`${ROOT}/objects/${encodeURIComponent(document)}.json`)
    if (!table) throw new Error(`The original session has no object table for ${document}`)
    return [document.toLowerCase(), table] as const
  }))
  const graphFiles = await Promise.all(prefetched.map(async document => {
    const graph = await loadOriginalGraph(document)
    if (!graph) throw new Error(`The original session has no behavior graph for ${document}`)
    return [document.toLowerCase(), graph] as const
  }))
  const packFiles = await Promise.all(prefetched.map(async document => {
    const pack = await fetchJson<OriginalDocument>(`${ROOT}/${encodeURIComponent(document.toLowerCase())}.json`)
    return [document.toLowerCase(), pack] as const
  }))
  const objects = new Map(objectFiles)
  const graphs = new Map<string, OriginalGraphData>(graphFiles)
  const packs = new Map<string, OriginalDocument | undefined>(packFiles)
  const meshes = new Map<string, ReturnType<typeof originalRenderPackMeshes> | undefined>()
  const sizes = new Map<string, { width: number; height: number }>()
  const textures: { file: string; document: string; name: string }[] = []
  for (const [document, pack] of packFiles) {
    meshes.set(document, pack ? originalRenderPackMeshes(pack as unknown as OriginalRenderPack) : undefined)
    for (const texture of Array.isArray(pack?.textures) ? pack.textures : []) if (typeof texture.file === 'string' && typeof texture.name === 'string') textures.push({ file: texture.file, document, name: texture.name })
  }
  const textureFiles = [...new Set(textures.map(texture => texture.file))]
  await Promise.all(textureFiles.map(async file => {
    const bytes = await fetchBytes(`${ROOT}/${encodePath(file)}`)
    if (!bytes) return
    const size = pngSize(bytes)
    if (!size) throw new Error(`Texture image ${file} is not a PNG with an IHDR`)
    for (const texture of textures) if (texture.file === file) sizes.set(`${texture.document}\n${texture.name}`, size)
  }))

  const resolveFile = (path: string, kind: OriginalPathKind): string | undefined => {
    const file = normalize(path)
    for (const candidate of [file, FOLDERS[kind] + file, FOLDERS[kind] + file.replace(/^.*\//, '')]) {
      if (candidate && install.has(candidate)) return candidate
    }
    return undefined
  }
  const context = new OriginalContext(
    stem => {
      const table = objects.get(stem.toLowerCase())
      if (!table) throw new Error(`Document ${stem} was not prefetched by the original session loader`)
      return table
    },
    resolveFile,
    (document, name) => meshes.get(document.toLowerCase())?.(name),
  )
  context.textureImageSize = texture => texture.document === undefined ? undefined : sizes.get(`${texture.document.toLowerCase()}\n${texture.name}`)
  context.waveSampleRate = sound => typeof sound.state.fileName === 'string' ? install.waveRate(sound.state.fileName) : undefined

  const binding = options.binding === undefined ? defaultBinding() : typeof options.binding === 'function' ? options.binding(context) : options.binding
  const movie = typeof options.movie === 'function' ? options.movie(install) : options.movie
  const system = options.input === undefined ? options.system : new Proxy(options.system, {
    get: (target, key, receiver) => key === 'input' ? options.input : Reflect.get(target, key, receiver),
  })
  const host = new Proxy(binding, {
    get: (target, key, receiver) => key === 'system' ? system : key === 'movie' ? movie : Reflect.get(target, key, receiver),
  })
  const simulation = typeof options.simulation === 'function' ? options.simulation(context) : options.simulation
  const session = new OriginalSession(context, document => {
    const graph = graphs.get(document.toLowerCase())
    if (!graph) throw new Error(`Document ${document} has no prefetched behavior graph`)
    return graph
  }, host, {
    particles: options.particles ?? new OriginalParticleRenderer(new Map(), 1),
    ...(options.filter ? { filter: options.filter } : {}),
    ...(simulation ? { simulation } : { physics: options.physics ?? recordingPhysics() }),
  })
  for (const document of options.documents ?? ['base']) session.add(document)
  if (options.play) session.play()
  return { context, session, install, prefetched, packs, textureFiles }
}
