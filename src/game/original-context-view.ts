// The renderer's view of the CK context: one Three.js mesh per 3D object with
// a current mesh, built from the context's mesh geometry and its documents'
// render exports, with transforms and visibility read from `context.entities`
// on every sync. Everything below `root` is in original (Virtools) units; the
// root alone converts to render space (SCALE and the Z reflection of
// `originalGeometry`). The reflection makes every world matrix's determinant
// negative, so Three draws the authored winding unswapped, as
// `originalGeometry` gets by swapping it.
import * as THREE from 'three'
import { CKCID, originalIsChildClassOf, originalObjectReference, type OriginalContext, type OriginalObject } from './original-context.ts'
import { SCALE, type OriginalDocument } from './original-data.ts'
import type { OriginalMeshGeometry } from './original-ray.ts'
import type { Original2dDrawItem } from './original-2d-render.ts'
import type { Original2dRect, Original2dScreen } from './original-2d-entity.ts'
import { originalColorFromFloats } from './original-color.ts'

export type OriginalViewMaterial = OriginalDocument['materials'][number]

export interface OriginalContextViewOptions {
  /** A document's render export (its materials and textures by name), or undefined when it has none. */
  pack: (document: string) => OriginalDocument | undefined
  /**
   * A context material's Three material: its exported description, its
   * texture (the exported file, or null) and, on a prelit mesh, the vertex
   * colours that replace lighting.
   */
  material: (description: OriginalViewMaterial, texture: string | null, prelit: OriginalViewPrelit | null) => THREE.Material
  /** A material description for a document without a render export (the intro's 2D art). */
  fallbackMaterial?: (material: OriginalObject) => OriginalViewMaterial | undefined
  /** A host texture for a context texture without an exported file (a movie). */
  hostTexture?: (texture: OriginalObject) => THREE.Texture | null
}

/** A prelit mesh's vertex colour and specular colour (RGBA bytes, uniform over its vertices). */
export interface OriginalViewPrelit {
  color: readonly [number, number, number, number]
  specular: readonly [number, number, number, number]
}

/** CKMesh state the view draws; any other mesh state fails loudly. */
const MESH_STATE = new Set(['uvRevision', 'litMode', 'vertexColor', 'vertexSpecularColor'])
/** VXMESH_LITMODE: VX_PRELITMESH. */
const PRELIT = 0
/** VXCMPFUNC: the text batches draw with Z disabled. */
const VXCMP_ALWAYS = 8

interface ViewEntity {
  readonly mesh: THREE.Mesh
  /** The context mesh it draws. */
  readonly meshId: number
  /** The context material of each face-material slot; undefined draws the default material. */
  readonly slots: readonly (number | undefined)[]
}

interface ViewMaterial {
  readonly material: THREE.Material
  /** The description and texture it was built from. */
  readonly key: string
}

/**
 * CKMaterial members the material blocks write to `object.state`, by the
 * exported description field they override. Any other material state fails
 * loudly, so a block that writes new state is not silently ignored.
 */
const MATERIAL_STATE: Record<string, keyof OriginalViewMaterial> = {
  alphaBlendEnabled: 'AlphaBlendEnabled', alphaTestEnabled: 'AlphaTestEnabled', zWriteEnabled: 'ZWriteEnabled',
  sourceBlend: 'sourceBlend', destBlend: 'destBlend', textureBlendMode: 'textureBlendMode',
  alphaFunc: 'alphaFunc', alphaRef: 'alphaRef', zFunc: 'zFunc', textureMinMode: 'textureMinMode', textureMagMode: 'textureMagMode',
  diffuse: 'diffuse', emissive: 'emissive',
}

interface ViewGeometry {
  readonly geometry: THREE.BufferGeometry
  readonly source: OriginalMeshGeometry
}

/**
 * RCKRenderManager's "Default Mat", which draws faces without a material: a
 * fresh CKMaterial (CK2_3D RCKMaterial::RCKMaterial at 0x10062870: ambient
 * 0.3, diffuse 0.7, black specular and emissive, power 0, ZWrite and
 * perspective correction, MODULATEALPHA, linear filters, ONE/ZERO, wrap).
 */
const DEFAULT_MATERIAL: OriginalViewMaterial = {
  id: -1, name: 'Default Mat', texture: -1,
  diffuse: [0.7, 0.7, 0.7, 1].map(Math.fround), ambient: [0.3, 0.3, 0.3, 1].map(Math.fround), specular: [0, 0, 0, 1], emissive: [0, 0, 0, 1], specularPower: 0,
  AlphaBlendEnabled: false, AlphaTestEnabled: false, TwoSidedEnabled: false, ZWriteEnabled: true,
  sourceBlend: 2, destBlend: 1, textureBlendMode: 4, textureMinMode: 2, textureMagMode: 2, textureAddressMode: 1,
}

/** Find the one entry with this name in an export list, failing loudly on duplicates. */
function named<T extends { name?: string }>(items: readonly T[], name: string, what: string, document: string): T | undefined {
  const found = items.filter(item => item.name === name)
  if (found.length > 1) throw new Error(`${what} ${name} appears more than once in the render export of ${document}`)
  return found[0]
}

/**
 * The vertical FOV in degrees of a saved perspective camera at a viewport
 * aspect. At or above the saved aspect the authored vertical FOV (the saved
 * horizontal FOV converted at the saved aspect) is kept, so wider windows see
 * more at the sides (Hor+). Below it the authored horizontal FOV is kept
 * instead, which grows the vertical FOV.
 */
export function originalCameraFov(horizontalFov: number, savedAspect: readonly [number, number], viewportAspect: number): number {
  return viewportAspect >= savedAspect[0] / savedAspect[1]
    ? 2 * Math.atan(Math.tan(horizontalFov / 2) * savedAspect[1] / savedAspect[0]) * 180 / Math.PI
    : 2 * Math.atan(Math.tan(horizontalFov / 2) / viewportAspect) * 180 / Math.PI
}

/** The largest 4:3 pixel rect that fits a drawing buffer (the render context's 2D size). */
export function original2dViewport(canvas: { width: number; height: number }): { width: number; height: number } {
  if (canvas.width * 3 === canvas.height * 4) return { width: canvas.width, height: canvas.height }
  return canvas.width / canvas.height >= 4 / 3
    ? { width: Math.round(canvas.height * 4 / 3), height: canvas.height }
    : { width: canvas.width, height: Math.round(canvas.width * 3 / 4) }
}

export interface Original2dPlacement {
  /** Added to the entity's pixels (text ops always use it). */
  readonly x: number
  readonly y: number
  /** The quad's destination rect in drawing-buffer pixels; undefined for a text-only item. */
  readonly rect?: Original2dRect
}

/**
 * Where a 2D entity authored against the 4:3 render context lands in the
 * drawing buffer: the centered 2D area, a quad spanning the viewport width
 * stretched across the canvas, or a named HUD group anchored to the canvas
 * corners. A full-width quad's text ops keep the default offset.
 */
export function original2dPlacement(canvas: { width: number; height: number }, viewport: { width: number; height: number },
  name = '', rect?: Original2dRect): Original2dPlacement {
  // Whole pixels, so the original's pixel-exact art and glyphs are not resampled; the HUD
  // anchors use the exact spare width and height.
  const spareX = canvas.width - viewport.width, spareY = canvas.height - viewport.height
  const x0 = Math.floor(spareX / 2), y0 = Math.floor(spareY / 2)
  const fullWidth = rect !== undefined && rect[0] <= 0 && rect[2] >= viewport.width
  const fullHeight = rect !== undefined && fullWidth && rect[1] <= 0 && rect[3] >= viewport.height
  const [x, y] = fullWidth ? [x0, y0]
    : name.startsWith('Interface_Points') ? [0, spareY]
    : name.startsWith('Interface_Life') ? [spareX, spareY]
    : [x0, y0]
  if (rect === undefined) return { x, y }
  if (fullWidth) return { x, y, rect: [0, fullHeight ? 0 : rect[1] + y0, canvas.width, fullHeight ? canvas.height : rect[3] + y0] }
  return { x, y, rect: [rect[0] + x, rect[1] + y, rect[2] + x, rect[3] + y] }
}

export class OriginalContextView {
  /** Render space: original units scaled by SCALE with Z reflected. */
  readonly root = new THREE.Group()
  private readonly context: OriginalContext
  private readonly options: OriginalContextViewOptions
  private readonly entities = new Map<number, ViewEntity>()
  private readonly geometries = new Map<number, ViewGeometry>()
  /** Built materials by context material (`default` for the default material) and prelit colours. */
  private readonly materials = new Map<string, ViewMaterial>()
  /** The materials checked against their state in the current sync. */
  private readonly checked = new Set<string>()
  /**
   * The 2D passes in window pixels (y down, z 0): drawn after the 3D scene,
   * each item's renderOrder its draw order. A stereo host draws it per eye.
   */
  readonly overlay = new THREE.Scene()
  readonly overlayCamera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1)
  /** The attached CK camera in render space; `syncCamera` updates it every frame. */
  readonly camera = new THREE.PerspectiveCamera()
  private readonly quads: THREE.Mesh[] = []
  private readonly hostTextures = new Map<string, THREE.Texture>()

  constructor(context: OriginalContext, options: OriginalContextViewOptions) {
    this.context = context
    this.options = options
    this.root.name = 'OriginalContextView'
    this.root.matrixAutoUpdate = false
    this.root.matrix.makeScale(SCALE, SCALE, -SCALE)
  }

  /** The Three mesh drawing a context entity, after the last sync. */
  object(id: number): THREE.Mesh | undefined { return this.entities.get(id)?.mesh }

  /**
   * RCKRenderContext's attached camera (`Set As Active Camera`) in render
   * space. A target camera aims at its target with the world +Y up vector; a
   * plain camera uses its saved right/up/direction rows. Returns false while
   * no camera is attached (the boot and intro can run without a 3D view).
   */
  syncCamera(): boolean {
    const id = this.context.render.camera
    if (id === undefined) return false
    const object = this.context.get(id)
    if (!object) {
      // A document unload deleted the attached camera (Load Level deletes Cam_MenuLevel before
      // Gameplay_Ingame attaches InGameCam). The render context's viewpoint cannot name a dead
      // object; CKLevel::LaunchScene only attaches a starting camera when it has none, so drop the
      // stale attachment and draw the 2D loading layer until Set As Active Camera runs again.
      this.context.render.camera = undefined
      return false
    }
    if (!originalIsChildClassOf(object.classId, CKCID.CAMERA)) throw new Error(`The attached object ${object.name} is not a camera`)
    const state = object.camera
    if (!state) throw new Error(`Camera ${object.name} has no saved projection`)
    if (state.projection !== 'perspective') throw new Error(`Camera ${object.name} is orthographic, which the view does not draw`)
    const world = this.context.entities.world(originalObjectReference(id))
    if (!world) throw new Error(`Camera ${object.name} has no world matrix`)
    const camera = this.camera
    const position = new THREE.Vector3(world[12]! * SCALE, world[13]! * SCALE, -world[14]! * SCALE)
    camera.position.copy(position)
    if (object.target !== undefined) {
      const target = this.context.entities.world(originalObjectReference(object.target))
      if (!target) throw new Error(`Target camera ${object.name} has no target ${object.target}`)
      camera.up.set(0, 1, 0)
      camera.lookAt(target[12]! * SCALE, target[13]! * SCALE, -target[14]! * SCALE)
    } else {
      camera.up.set(world[4]!, world[5]!, -world[6]!)
      camera.lookAt(position.x + world[8]!, position.y + world[9]!, position.z - world[10]!)
    }
    const size = this.context.render.canvas ?? this.context.render.viewport
    const viewportAspect = size ? size.width / size.height : state.aspect[0] / state.aspect[1]
    camera.aspect = viewportAspect
    camera.fov = originalCameraFov(state.horizontalFov, state.aspect, viewportAspect)
    // CKCamera's zoom is the orthographic zoom; a perspective camera ignores it.
    camera.near = state.near * SCALE
    camera.far = state.far * SCALE
    camera.updateProjectionMatrix()
    return true
  }

  /**
   * Follow the context: create meshes for new 3D objects, drop destroyed ones,
   * rebuild an entity whose current mesh changed, rebuild a material whose
   * state changed, and copy every world matrix and visibility flag.
   */
  sync(): void {
    const live = new Set<number>()
    this.checked.clear()
    for (const object of this.context.objectsOfClass(CKCID['3DOBJECT'])) {
      const reference = originalObjectReference(object.id)
      if (!this.context.isEntity(object.id)) continue
      if (object.document !== undefined && !this.options.pack(object.document)) continue
      const meshId = object.meshes?.[0]
      const current = meshId === undefined ? undefined : this.context.get(meshId)
      if (current && !current.geometry) throw new Error(`Mesh ${current.name} of ${object.name} has no exported geometry`)
      let entity = this.entities.get(object.id)
      if (entity && entity.meshId !== current?.id) { this.root.remove(entity.mesh); this.entities.delete(object.id); entity = undefined }
      if (!current) continue
      live.add(object.id)
      if (!entity) {
        const mesh = new THREE.Mesh(this.geometry(current))
        mesh.name = object.name
        mesh.matrixAutoUpdate = false
        this.root.add(mesh)
        entity = { mesh, meshId: current.id, slots: this.context.materialSlots(current.id) }
        this.entities.set(object.id, entity)
      }
      const prelit = this.prelit(current)
      entity.mesh.material = entity.slots.map(id => this.material(id, prelit))
      this.refreshUVs(current)
      entity.mesh.matrix.fromArray(this.context.entities.world(reference))
      entity.mesh.matrixWorldNeedsUpdate = true
      entity.mesh.visible = this.context.entities.visible(reference)
    }
    for (const [id, entity] of this.entities) {
      if (!live.has(id)) { this.root.remove(entity.mesh); this.entities.delete(id) }
    }
    for (const id of this.geometries.keys()) {
      if (!this.context.get(id)) { this.geometries.get(id)!.geometry.dispose(); this.geometries.delete(id) }
    }
    for (const [id, cached] of this.materials) {
      if (!this.checked.has(id)) { cached.material.dispose(); this.materials.delete(id) }
    }
  }

  /**
   * The frame's 2D draw list (`original2dRender`) as meshes in issue order.
   * RCK2dEntity::Draw sends four pre-transformed vertices at the integer pixel
   * rect, UVs from the clipped source rect, every vertex coloured with
   * RGBAFTOCOLOR of the material's diffuse (alpha included) instead of
   * lighting, culling off. A 2D Text draw follows its entity: the background
   * and caret quads with their materials, the glyph batches with the font
   * texture under TEXT_RENDER_STATES (MODULATEALPHA, SRCALPHA/INVSRCALPHA, no Z,
   * clamped, linear filters). The overlay covers the drawing buffer; the items
   * keep the render context's pixel coordinates through `original2dPlacement`.
   */
  sync2d(items: readonly Original2dDrawItem[], screen: Original2dScreen, canvas: Original2dScreen = screen): void {
    const camera = this.overlayCamera
    if (camera.right !== canvas.width || camera.bottom !== canvas.height) {
      camera.right = canvas.width; camera.bottom = canvas.height; camera.updateProjectionMatrix()
    }
    if (items.some(item => item.pass === 'background')) throw new Error('A background 2D entity is drawn before the 3D scene, which the view does not do yet')
    const draws: { name: string; positions: number[]; uvs: number[]; material: THREE.Material }[] = []
    const quad = (corners: readonly (readonly [number, number, number, number])[]) => ({
      positions: corners.flatMap(([x, y]) => [x, y, 0]), uvs: corners.flatMap(([, , u, v]) => [u, 1 - v]),
    })
    const shifted = (corners: readonly (readonly [number, number, number, number])[], x: number, y: number) =>
      quad(corners.map(([cx, cy, u, v]) => [cx + x, cy + y, u, v] as const))
    const quadRects = new Map<number, Original2dRect>()
    for (const item of items) if (item.kind === 'quad') quadRects.set(item.id, item.pixelRect)
    const diffuseColor = (material: number) => {
      const diffuse = this.describe(material).description.diffuse
      const color = originalColorFromFloats(diffuse[0]!, diffuse[1]!, diffuse[2]!, diffuse[3]!)
      return { color: [color[0], color[1], color[2], color[3]] as const, specular: [0, 0, 0, 0] as const }
    }
    for (const item of items) {
      const name = this.context.get(item.id)?.name ?? ''
      if (item.kind === 'quad') {
        const [ul, vt, ur, vb] = item.uvRect
        const [l, t, r, b] = original2dPlacement(canvas, screen, name, item.pixelRect).rect!
        draws.push({ name, ...quad([[l, t, ul, vt], [r, t, ur, vt], [r, b, ur, vb], [l, b, ul, vb]]), material: this.material(item.material, diffuseColor(item.material), true) })
        continue
      }
      const placement = original2dPlacement(canvas, screen, name, quadRects.get(item.id))
      for (const op of item.ops) {
        if (op.kind === 'background') {
          const [l, t, r, b] = op.rect
          draws.push({ name, ...shifted([[l, t, 0, 0], [r, t, 1, 0], [r, b, 1, 1], [l, b, 0, 1]], placement.x, placement.y), material: this.material(item.backgroundMaterial!, diffuseColor(item.backgroundMaterial!), true) })
        } else if (op.kind === 'caret') {
          if (item.caretMaterial === undefined) throw new Error(`The caret of ${name} without a Caret Material is not drawn by the view`)
          draws.push({ name, ...shifted(op.quad.map(v => [v.x, v.y, v.u, v.v] as const), placement.x, placement.y), material: this.material(item.caretMaterial, diffuseColor(item.caretMaterial), true) })
        } else {
          const color = op.quads[0]![0].color
          if (op.quads.some(q => q.some(v => v.color !== color))) throw new Error(`The text of ${name} has a gradient, which the view does not draw`)
          const positions: number[] = [], uvs: number[] = []
          for (const q of op.quads) { const part = shifted(q.map(v => [v.x, v.y, v.u, v.v] as const), placement.x, placement.y); positions.push(...part.positions); uvs.push(...part.uvs) }
          const argb = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, (color >>> 24) & 255] as const
          draws.push({ name, positions, uvs, material: this.textMaterial(item.texture, { color: argb, specular: [0, 0, 0, 0] }) })
        }
      }
    }
    while (this.quads.length < draws.length) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry())
      mesh.frustumCulled = false
      this.quads.push(mesh)
      this.overlay.add(mesh)
    }
    this.quads.forEach((mesh, i) => {
      const draw = draws[i]
      mesh.visible = draw !== undefined
      if (!draw) return
      const count = draw.positions.length / 3
      let geometry = mesh.geometry
      if ((geometry.getAttribute('position') as THREE.BufferAttribute | undefined)?.count !== count) {
        geometry.dispose()
        geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3))
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2))
        geometry.setIndex(Array.from({ length: count / 4 }, (_, q) => [0, 1, 2, 0, 2, 3].map(k => q * 4 + k)).flat())
        mesh.geometry = geometry
      }
      const position = geometry.getAttribute('position') as THREE.BufferAttribute
      position.array.set(draw.positions); position.needsUpdate = true
      const uv = geometry.getAttribute('uv') as THREE.BufferAttribute
      uv.array.set(draw.uvs); uv.needsUpdate = true
      mesh.material = draw.material
      mesh.renderOrder = i
      mesh.name = draw.name
    })
  }

  /** The glyph material of a font texture: TEXT_RENDER_STATES as a material description, the batch colour as its vertex colour. */
  private textMaterial(texture: number, prelit: OriginalViewPrelit): THREE.Material {
    const slot = `text:${texture}|${JSON.stringify(prelit)}`
    const cached = this.materials.get(slot)
    this.checked.add(slot)
    if (cached) return cached.material
    const object = this.context.get(texture)
    if (!object) throw new Error(`Font texture #${texture} is not in the context`)
    const description: OriginalViewMaterial = {
      ...DEFAULT_MATERIAL, name: '2D Text', diffuse: [1, 1, 1, 1],
      AlphaBlendEnabled: true, TwoSidedEnabled: true, ZWriteEnabled: false, zFunc: VXCMP_ALWAYS,
      sourceBlend: 5, destBlend: 6, textureBlendMode: 4, textureMinMode: 2, textureMagMode: 2, textureAddressMode: 3,
    }
    const material = this.options.material(description, this.textureFile(object, '2D Text'), prelit)
    this.materials.set(slot, { material, key: '' })
    return material
  }

  /** A context mesh's geometry in its own frame, shared by every entity that draws it. */
  private geometry(mesh: OriginalObject): THREE.BufferGeometry {
    const cached = this.geometries.get(mesh.id)
    if (cached) return cached.geometry
    const source = mesh.geometry!
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(source.positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(source.normals, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(source.uvs.map((v, i) => i % 2 ? 1 - v : v), 2))
    geometry.setIndex([...source.indices])
    let start = 0
    for (let i = 1; i <= source.faceMaterials.length; i++) {
      if (i === source.faceMaterials.length || source.faceMaterials[i] !== source.faceMaterials[start]) {
        geometry.addGroup(start * 3, (i - start) * 3, source.faceMaterials[start]); start = i
      }
    }
    geometry.computeBoundingBox(); geometry.computeBoundingSphere()
    this.geometries.set(mesh.id, { geometry, source })
    return geometry
  }

  /** A block replaced the mesh's UVs (`setMeshUVs` swaps the geometry record). */
  private refreshUVs(mesh: OriginalObject): void {
    const cached = this.geometries.get(mesh.id)
    if (!cached || cached.source === mesh.geometry) return
    const source = mesh.geometry!
    if (source.positions !== cached.source.positions || source.indices !== cached.source.indices) {
      throw new Error(`Mesh ${mesh.name} changed more than its UVs, which the view does not follow`)
    }
    const uv = cached.geometry.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < source.uvs.length; i++) uv.array[i] = i % 2 ? 1 - source.uvs[i]! : source.uvs[i]!
    uv.needsUpdate = true
    this.geometries.set(mesh.id, { geometry: cached.geometry, source })
  }

  /** The mesh's prelit colours when its lit mode is VX_PRELITMESH (`Set Prelit Color`), else null. */
  private prelit(mesh: OriginalObject): OriginalViewPrelit | null {
    for (const key of Object.keys(mesh.state)) {
      if (!MESH_STATE.has(key)) throw new Error(`Mesh ${mesh.name} has state ${key}, which the view does not draw`)
    }
    if (mesh.state.litMode === undefined) return null
    if (mesh.state.litMode !== PRELIT) throw new Error(`Mesh ${mesh.name} has lit mode ${String(mesh.state.litMode)}, which the view does not draw`)
    return { color: mesh.state.vertexColor as OriginalViewPrelit['color'], specular: mesh.state.vertexSpecularColor as OriginalViewPrelit['specular'] }
  }

  /**
   * A face-material slot's material: the default material, or a context
   * material's exported description with the CK state the blocks wrote over it.
   */
  private material(id: number | undefined, prelit: OriginalViewPrelit | null, flat = false): THREE.Material {
    const slot = `${id ?? 'default'}|${prelit ? JSON.stringify(prelit) : ''}|${flat ? 1 : 0}`
    const cached = this.materials.get(slot)
    if (cached && this.checked.has(slot)) return cached.material
    this.checked.add(slot)
    if (id === undefined) {
      if (cached) return cached.material
      const material = this.options.material(DEFAULT_MATERIAL, null, prelit)
      this.materials.set(slot, { material, key: '' })
      return material
    }
    const { description, texture } = this.describe(id)
    if (flat) description.TwoSidedEnabled = true
    const key = JSON.stringify([description, texture])
    if (cached?.key === key) return cached.material
    cached?.material.dispose()
    const material = this.options.material(description as OriginalViewMaterial, texture, prelit)
    this.materials.set(slot, { material, key })
    return material
  }

  /** A context material's exported description with the CK state the blocks wrote over it, and its texture file. */
  private describe(id: number): { description: OriginalViewMaterial; texture: string | null } {
    const object = this.context.get(id)
    if (!object) throw new Error(`Material #${id} is not in the context`)
    const pack = object.document === undefined ? undefined : this.options.pack(object.document)
    const exported = pack ? named(pack.materials, object.name, 'Material', object.document!) : undefined
    let description: OriginalViewMaterial
    if (exported) {
      description = { ...exported }
    } else {
      const fallback = this.options.fallbackMaterial?.(object)
      if (!fallback) {
        throw new Error(`Material ${object.name} has no render export to describe it`)
      }
      description = { ...fallback, ...(object.material ?? {}), texture: fallback.texture }
    }
    for (const [key, value] of Object.entries(object.state)) {
      const field = MATERIAL_STATE[key]
      if (!field) throw new Error(`Material ${object.name} has state ${key}, which the view does not draw`)
      description[field] = value as never
    }
    return { description, texture: this.texture(object, description, exported === undefined, pack) }
  }

  /**
   * The exported file of a material's texture, by its context link; a fallback
   * description's texture is the saved slot 0 (a context id), an exported
   * one's is a render-export id.
   */
  private texture(material: OriginalObject, description: OriginalViewMaterial, fallback: boolean, pack: OriginalDocument | undefined): string | null {
    const id = material.textures?.[0] ?? (fallback && description.texture > 0 ? description.texture : undefined)
    if (id === undefined) {
      if (pack?.textures.some(texture => texture.id === description.texture)) throw new Error(`Material ${material.name} has an exported texture the context does not link`)
      return null
    }
    const texture = this.context.get(id)
    if (!texture) throw new Error(`Texture #${id} of ${material.name} is not in the context`)
    return this.textureFile(texture, material.name)
  }

  /** A context texture's exported file, or a host texture key when the document has no export. */
  private textureFile(texture: OriginalObject, user: string): string {
    const exported = texture.document === undefined ? undefined : this.options.pack(texture.document)
    const entry = exported && named(exported.textures, texture.name, 'Texture', texture.document!)
    if (entry) return entry.file
    const host = this.options.hostTexture?.(texture)
    if (host) {
      const key = `host:${texture.id}`
      this.hostTextures.set(key, host)
      return key
    }
    throw new Error(`Texture ${texture.name} of ${user} is not in a render export`)
  }

  /** A host texture registered by `textureFile` under its `host:<id>` key. */
  hostTexture(key: string): THREE.Texture | undefined {
    return this.hostTextures.get(key)
  }

  dispose(): void {
    for (const { geometry } of this.geometries.values()) geometry.dispose()
    for (const { material } of this.materials.values()) material.dispose()
    for (const quad of this.quads) quad.geometry.dispose()
    this.geometries.clear(); this.materials.clear(); this.entities.clear(); this.quads.length = 0
    this.root.clear(); this.overlay.clear()
  }
}
