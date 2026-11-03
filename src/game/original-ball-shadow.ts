import * as THREE from 'three'
import type { GraphShadowSettings } from './original-graph-bindings.ts'

/** SimpleShadow.cpp `A_MAX_NUMBER_OF_FLOOR_UNDER_OBJECT`. */
const MAX_FLOORS = 50

/** A floor of the level's `Shadow` group (Levelinit `set Floor`), in original units. */
export interface ShadowFloorSource {
  name: string
  /** Authored world matrix (Virtools rows, as `THREE.Matrix4.fromArray` reads it). */
  matrix: number[]
  /** Mesh vertex positions in the floor's local frame. */
  positions: number[]
  /** The rendered floor; its vertices are in the same order as `positions`. */
  mesh: THREE.Mesh
}

/** The projector's target this frame, in original units. */
export interface ShadowTargetPose {
  /** World matrix of the target entity. */
  matrix: THREE.Matrix4
  /** Local bounding box of the target's mesh. */
  localBox: THREE.Box3
}

/** One frame's one-shot pre-render projection (`GraphRenderState.shadow`). */
export interface ShadowProjection {
  target: string
  settings: GraphShadowSettings
}

interface Floor {
  source: ShadowFloorSource
  matrix: THREE.Matrix4
  inverse: THREE.Matrix4
  scale: THREE.Vector3
  localBox: THREE.Box3
  worldBox: THREE.Box3
  overlay?: THREE.Mesh
}

const f = Math.fround

/**
 * TT_Gravity_RT/Behaviors/SimpleShadow.cpp. The shadow material (texture
 * COPY, clamp addressing) is added as an extra channel to every visible floor
 * under the target, blended ZERO/SRCCOLOR so it multiplies the floor, with
 * UVs projected straight down in the floor's local frame:
 * `u = (p.x·k + 0.5) − x·k`, `v = (p.z·k + 0.5) − z·k`, `k = scale / (Size Scale · width)`.
 * Here the channel is an overlay mesh sharing the floor's vertices.
 *
 * The behavior's per-frame projections are the session's render-context state:
 * `render` draws the latest one and clears the channel when there is none, as
 * the original callback only runs while `Ball_Shadow` does.
 */
export class OriginalBallShadow {
  private readonly floors: Floor[]
  private readonly textures: Map<string, THREE.Texture>
  private material?: THREE.MeshBasicMaterial
  private textureName: string | null | undefined
  /** Floors carrying the channel, in `A_GetFloors` order. */
  private under: Floor[] = []
  private readonly pose: (name: string) => ShadowTargetPose | undefined

  /** `pose` resolves the projector's target by its authored name (`Ball_Wood`, ...). */
  constructor(floors: ShadowFloorSource[], textures: Map<string, THREE.Texture>, pose: (name: string) => ShadowTargetPose | undefined) {
    this.textures = textures
    this.pose = pose
    this.floors = floors.map(source => {
      const matrix = new THREE.Matrix4().fromArray(source.matrix)
      const localBox = new THREE.Box3().setFromArray(source.positions)
      if (localBox.isEmpty()) throw new Error(`Shadow floor ${source.name} has no vertices`)
      if (source.mesh.geometry.attributes.position!.count !== source.positions.length / 3) {
        throw new Error(`Shadow floor ${source.name} mesh does not match its authored vertices`)
      }
      // CK3dEntity::GetScale: the lengths of the matrix axes.
      const scale = new THREE.Vector3(
        new THREE.Vector3().setFromMatrixColumn(matrix, 0).length(),
        new THREE.Vector3().setFromMatrixColumn(matrix, 1).length(),
        new THREE.Vector3().setFromMatrixColumn(matrix, 2).length(),
      )
      return { source, matrix, inverse: matrix.clone().invert(), scale, localBox, worldBox: localBox.clone().applyMatrix4(matrix) }
    })
  }

  /** Floors the channel is on, by name. */
  get floorsUnder(): string[] {
    return this.under.map(floor => floor.source.name)
  }

  /** The pre-render callback, once per rendered frame. */
  render(projections: readonly ShadowProjection[]) {
    const request = projections.at(-1)
    if (!request) {
      for (const floor of this.under) if (floor.overlay) floor.overlay.visible = false
      this.under = []
      return
    }
    const material = this.material ??= new THREE.MeshBasicMaterial({
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      transparent: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
      toneMapped: false,
    })
    const { settings } = request
    if (settings.texture !== this.textureName) {
      this.textureName = settings.texture
      const texture = settings.texture === null ? null : this.textures.get(settings.texture)
      if (texture === undefined) throw new Error(`TT Simple Shadow texture ${settings.texture} is not loaded`)
      material.map = texture
      material.needsUpdate = true
    }
    const pose = this.pose(request.target)
    if (!pose) throw new Error(`TT Simple Shadow target ${request.target} is not in the scene`)
    const zoom = f(settings.sizeScale)
    // Local bounding box width times the world X axis length.
    const width = f((pose.localBox.max.x - pose.localBox.min.x) * new THREE.Vector3().setFromMatrixColumn(pose.matrix, 0).length())
    if (zoom === 0 || width === 0) return
    const invZoom = f(1 / f(zoom * width))
    const old = this.under
    this.under = this.findFloors(pose, zoom, settings.maxHeight)
    for (const floor of old) if (!this.under.includes(floor) && floor.overlay) floor.overlay.visible = false
    const position = new THREE.Vector3().setFromMatrixPosition(pose.matrix)
    for (const floor of this.under) this.projectOnto(floor, position, invZoom, material)
  }

  /** SimpleShadow.cpp `A_GetFloors`. */
  private findFloors(pose: ShadowTargetPose, zoom: number, maxHeight: number): Floor[] {
    const box = pose.localBox.clone().applyMatrix4(pose.matrix)
    const invZoom = f(1 / f(zoom * f(box.max.x - box.min.x)))
    const position = new THREE.Vector3().setFromMatrixPosition(pose.matrix)
    const under: Floor[] = []
    for (const floor of this.floors) {
      // IsVisible; IsAllOutsideFrustrum only skips floors that are not drawn.
      if (!floor.source.mesh.visible) continue
      const world = floor.worldBox
      if (world.min.x > box.max.x || world.min.z > box.max.z || world.max.x < box.min.x || world.max.z < box.min.z) continue
      if (world.min.y > box.max.y || box.min.y - world.max.y > maxHeight) continue
      const local = position.clone().applyMatrix4(floor.inverse)
      const kx = f(invZoom * floor.scale.x), kz = f(invZoom * floor.scale.z)
      if ((floor.localBox.max.x - local.x) * kx >= -0.5 && (floor.localBox.min.x - local.x) * kx <= 0.5 &&
        (floor.localBox.max.z - local.z) * kz >= -0.5 && (floor.localBox.min.z - local.z) * kz <= 0.5) {
        if (under.length < MAX_FLOORS) under.push(floor)
      }
    }
    return under
  }

  private projectOnto(floor: Floor, position: THREE.Vector3, invZoom: number, material: THREE.Material) {
    const overlay = floor.overlay ??= this.overlay(floor)
    overlay.material = material
    overlay.visible = true
    const local = position.clone().applyMatrix4(floor.inverse)
    const kx = f(invZoom * floor.scale.x), kz = f(invZoom * floor.scale.z)
    const u0 = f(f(local.x * kx) + 0.5), v0 = f(f(local.z * kz) + 0.5)
    const positions = floor.source.positions
    const uv = overlay.geometry.attributes.uv as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) {
      // Three.js samples textures with v up, so the Virtools v is flipped as in originalGeometry.
      uv.setXY(i, f(u0 - f(positions[i * 3]! * kx)), 1 - f(v0 - f(positions[i * 3 + 2]! * kz)))
    }
    uv.needsUpdate = true
  }

  /** The shadow channel: the floor's own vertices and faces with projected UVs. */
  private overlay(floor: Floor): THREE.Mesh {
    const source = floor.source.mesh.geometry
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', source.attributes.position!)
    geometry.setIndex(source.index)
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(source.attributes.position!.count * 2), 2))
    geometry.boundingSphere = source.boundingSphere
    geometry.boundingBox = source.boundingBox
    const overlay = new THREE.Mesh(geometry)
    overlay.name = `${floor.source.name} TT_SimpleShadow`
    overlay.visible = false
    floor.source.mesh.add(overlay)
    return overlay
  }

  dispose() {
    for (const floor of this.under) if (floor.overlay) floor.overlay.visible = false
    this.under = []
    this.material?.dispose()
    this.material = undefined
    for (const floor of this.floors) {
      if (!floor.overlay) continue
      // The overlay shares the floor's vertex buffers, which the floor's owner disposes.
      floor.overlay.removeFromParent()
      floor.overlay = undefined
    }
  }
}
