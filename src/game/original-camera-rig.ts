import { OriginalEntityGraph, originalEntityFrame, originalEntityObject } from './original-entity-graph.ts'
import type { GraphCameraBinding, GraphFrameBinding, GraphObjectBinding } from './original-graph-bindings.ts'

/** The camera rig extracted from `Camera.nmo` and `Gameplay.nmo`. */
export interface OriginalCameraData {
  source: string
  dumpSha256: Record<string, string>
  frames: Record<string, { parent: string | null; matrix: number[] }>
  projection: { horizontalFov: number; aspectWidth: number; aspectHeight: number; near: number; far: number }
}

let loaded: OriginalCameraData | undefined
let loading: Promise<void> | undefined

/** Replace the loaded camera rig (used by the local-pack loader and tests). */
export function setOriginalCameraData(data: OriginalCameraData): void {
  loaded = data
}

export function originalCameraData(): OriginalCameraData {
  if (!loaded) throw new Error('The original camera rig needs the extracted camera data; run scripts/read-original-camera.py')
  return loaded
}

/** Fetch the extracted camera rig from the local original pack once. */
export function ensureOriginalCameraData(url = '/original/camera-data.json'): Promise<void> {
  loading ??= fetch(url).then(async response => {
    if (!response.ok) throw new Error(`The original camera rig needs ${url} (${response.status}); run scripts/read-original-camera.py`)
    setOriginalCameraData(await response.json() as OriginalCameraData)
  })
  return loading
}

/**
 * Target cameras and their targets. InGameCam is a CKTargetCamera aimed at
 * Cam_Target (Camera.tsv, InGameCam's chunk 0x10000000 names object 3).
 */
const TARGET_CAMERAS: Record<string, string> = { InGameCam: 'Cam_Target' }

/** The presentation camera the rig produces each frame, in render space. */
export interface OriginalCameraView {
  /** The attached camera (`Set As Active Camera`). */
  camera: string
  position: [number, number, number]
  /** A point one unit along the view direction. */
  lookAt: [number, number, number]
  up: [number, number, number]
  near: number
  far: number
  /** Vertical field of view in degrees, from the saved horizontal FOV and 4:3 aspect. */
  verticalFov: number
}

/**
 * Camera.nmo's six frames as CK3dEntities (original units), with the parts of
 * the Gameplay binding that reach them: objects, live children, initial-state
 * restore, referential frames and the camera calls. `aim` is the render
 * manager's per-frame target-camera LookAt; `view` hands the attached camera to
 * the renderer.
 */
export class OriginalCameraRig {
  readonly graph = new OriginalEntityGraph(Object.entries(originalCameraData().frames).map(([name, frame]) =>
    ({ name, parent: frame.parent ?? undefined, matrix: frame.matrix })))
  private attached?: string
  private readonly planes = new Map<string, { near: number; far: number }>()
  private readonly coordinateScale: number

  constructor(coordinateScale: number) {
    this.coordinateScale = coordinateScale
  }

  has(name: string): boolean { return this.graph.has(name) }

  object(name: string): GraphObjectBinding | undefined {
    return this.graph.has(name) ? originalEntityObject(this.graph, name, this.coordinateScale) : undefined
  }

  frame(name: string): GraphFrameBinding | undefined {
    return this.graph.has(name) ? originalEntityFrame(this.graph, name, this.coordinateScale) : undefined
  }

  children(name: string): string[] | undefined {
    return this.graph.has(name) ? this.graph.children(name) : undefined
  }

  restoreInitial(name: string): void {
    this.graph.restore(name)
    this.planes.delete(name)
  }

  readonly camera: GraphCameraBinding = {
    attach: name => {
      if (!(name in TARGET_CAMERAS)) throw new Error(`Set As Active Camera: ${name} is not a rig camera`)
      this.attached = name
    },
    setClipping: (name, near, far) => {
      if (!(name in TARGET_CAMERAS)) throw new Error(`Set Clipping Planes: ${name} is not a rig camera`)
      this.planes.set(name, { near, far })
    },
  }

  /** Re-aim every target camera at its target, as CKRenderedScene does before drawing. */
  aim(): void {
    for (const [camera, target] of Object.entries(TARGET_CAMERAS)) this.graph.lookAt(camera, [0, 0, 0], target, false)
  }

  /** The attached camera in render space, or undefined before `Set As Active Camera`. */
  view(): OriginalCameraView | undefined {
    const camera = this.attached
    if (!camera) return undefined
    const scale = this.coordinateScale
    const world = this.graph.world(camera)
    const render = (x: number, y: number, z: number): [number, number, number] => [x * scale, y * scale, -z * scale]
    const position = render(world[12]!, world[13]!, world[14]!)
    const dir = [world[8]!, world[9]!, world[10]!]
    const length = Math.hypot(dir[0]!, dir[1]!, dir[2]!)
    const lookAt: [number, number, number] = [
      position[0] + dir[0]! / length, position[1] + dir[1]! / length, position[2] - dir[2]! / length,
    ]
    const up: [number, number, number] = [world[4]!, world[5]!, -world[6]!]
    const data = originalCameraData()
    const planes = this.planes.get(camera) ?? { near: data.projection.near, far: data.projection.far }
    const { horizontalFov, aspectWidth, aspectHeight } = data.projection
    return {
      camera, position, lookAt, up, near: planes.near * scale, far: planes.far * scale,
      verticalFov: 2 * Math.atan(Math.tan(horizontalFov / 2) * aspectHeight / aspectWidth) * 180 / Math.PI,
    }
  }
}
