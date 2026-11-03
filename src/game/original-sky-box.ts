import * as THREE from 'three'
import type { GraphObjectBinding, GraphSkyBinding, GraphSkySettings } from './original-graph-bindings.ts'
import { loadOriginalPackFormats, originalSkyFile } from './original-pack-formats.ts'
import type { StereoBackground } from './stereo-renderer.ts'

/** TT Sky's own clipping planes (SkyPreRenderCallback). */
const SKY_NEAR = 1
const SKY_FAR = 200

/** Vertices and faces of one TT Sky mesh, in original (Virtools) units and face order. */
export interface SkyBoxMesh {
  positions: number[]
  /** Virtools texture coordinates (v down). */
  uvs: number[]
  /** Triangles as authored: (c,a,b),(c,d,a) per side, then the top and bottom fans. */
  indices: number[]
  /** Material slot per face: side index, then `sides` for the top and the next slot for the bottom. */
  faceMaterials: number[]
}

/**
 * TT_Gravity_RT/Behaviors/Sky.cpp mesh construction: per side face four
 * vertices, then three for the top and three for the bottom triangle when
 * those materials are enabled. Angles start at 1.25π, side UVs are
 * (1,1)(0,1)(0,0)(1,0), and quadratic sides take the chord as their height.
 */
export function buildSkyBoxMesh(settings: GraphSkySettings): SkyBoxMesh {
  const f = Math.fround
  const { sides, top, bottom, radius, y } = settings
  if (!Number.isInteger(sides) || sides < 4) throw new Error(`TT Sky needs at least 4 side materials, got ${sides}`)
  let height = settings.sideHeight
  const step = f(2 * Math.PI / sides)
  if (settings.quadratic) {
    const cr = f(Math.cos(step) * radius), sr = f(Math.sin(step) * radius)
    height = f(Math.sqrt(sr * sr + (radius - cr) * (radius - cr)))
  }
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [], faceMaterials: number[] = []
  const r = f(Math.sin(Math.PI / 4))
  const yt = f(y + height * 0.5), yb = f(y - height * 0.5)
  const vertex = (x: number, vy: number, z: number, u: number, v: number) => { positions.push(x, vy, z); uvs.push(u, v) }
  const fan = (x: number, z: number) => {
    const inv = f(1 / Math.sqrt(z * z + x * x))
    return [f(x * inv * r + 0.5), f(-z * inv * r + 0.5)] as const
  }
  for (let side = 0; side < sides; side++) {
    const bpi = f(step * side + 1.25 * Math.PI), api = f(step * (side + 1) + 1.25 * Math.PI)
    const cb = f(Math.cos(bpi) * radius), ca = f(Math.cos(api) * radius)
    const sb = f(Math.sin(bpi) * radius), sa = f(Math.sin(api) * radius)
    vertex(cb, yb, sb, 1, 1)
    vertex(ca, yb, sa, 0, 1)
    vertex(ca, yt, sa, 0, 0)
    vertex(cb, yt, sb, 1, 0)
    if (top) {
      vertex(cb, yt, sb, ...fan(cb, sb))
      vertex(ca, yt, sa, ...fan(ca, sa))
      vertex(0, yt, 0, 0.5, 0.5)
    }
    if (bottom) {
      vertex(cb, yb, sb, ...fan(cb, sb))
      vertex(0, yb, 0, 0.5, 0.5)
      vertex(ca, yb, sa, ...fan(ca, sa))
    }
  }
  let a = 0, b = 1, c = 2, d = 3
  for (let side = 0; side < sides; side++) {
    indices.push(c, a, b, c, d, a)
    faceMaterials.push(side, side)
    a += 4; b += 4; c += 4; d += 4
    if (top) {
      indices.push(a, b, c)
      faceMaterials.push(sides)
      a += 3; b += 3; c += 3; d += 3
    }
    if (bottom) {
      indices.push(a, b, c)
      faceMaterials.push(sides + Number(top))
      a += 3; b += 3; c += 3; d += 3
    }
  }
  return { positions, uvs, indices, faceMaterials }
}

/**
 * The geometry in render orientation: original units (the sky is drawn with
 * its own camera, so the level scale does not apply), Z reflected, winding
 * swapped to keep the faces turned inwards and v flipped for Three.js.
 */
export function skyBoxGeometry(mesh: SkyBoxMesh): THREE.BufferGeometry {
  const positions = Float32Array.from(mesh.positions, (value, i) => (i % 3 === 2 ? -value : value))
  const uvs = Float32Array.from(mesh.uvs, (value, i) => (i % 2 === 1 ? 1 - value : value))
  const indices = mesh.indices.slice()
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const second = indices[t + 1]!
    indices[t + 1] = indices[t + 2]!
    indices[t + 2] = second
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)

  // One group per run of consecutive faces that share a material slot.
  const faces = mesh.faceMaterials
  let runStart = 0
  for (let face = 1; face <= faces.length; face++) {
    if (face === faces.length || faces[face] !== faces[runStart]) {
      geometry.addGroup(runStart * 3, (face - runStart) * 3, faces[runStart]!)
      runStart = face
    }
  }
  return geometry
}

/**
 * SkyPreRenderCallback's projection: the view's horizontal field of view
 * widened by `distortion` of what is left to π, the same aspect, and near 1 /
 * far 200. The eye projection's off-axis terms are kept so stereo eyes see the
 * sky with the same parallax as the scene's background plane.
 */
export function skyProjection(eye: THREE.Matrix4, distortion: number, target = new THREE.Matrix4()): THREE.Matrix4 {
  const e = eye.elements
  const fov = Math.abs(2 * Math.atan(1 / e[0]!))
  const widened = fov + distortion * (Math.PI - fov)
  const x = Math.cos(widened * 0.5) / Math.sin(widened * 0.5)
  const aspect = e[5]! / e[0]!
  const depth = 1 / (SKY_FAR - SKY_NEAR)
  target.set(
    x, 0, e[8]!, 0,
    0, x * aspect, e[9]!, 0,
    0, 0, -(SKY_FAR + SKY_NEAR) * depth, -2 * SKY_FAR * SKY_NEAR * depth,
    0, 0, -1, 0,
  )
  return target
}

/** RGBAFTOCOLOR: each channel truncated to a byte. */
const byte = (value: number) => Math.trunc(Math.min(1, Math.max(0, value)) * 255) / 255

/**
 * The TT Sky entity as a background pass: created by the graph's `On`,
 * textured per face from the level's `Load Sky-Textures` set, drawn before
 * the scene without depth test or write and centred on the camera.
 */
export class OriginalSkyBox implements StereoBackground {
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera()
  private readonly entity = new THREE.Group()
  private readonly textures = new Map<string, THREE.Texture>()
  private readonly materials = new Map<string, THREE.MeshBasicMaterial>()
  private mesh?: THREE.Mesh
  private settings?: GraphSkySettings
  private shown = false

  /**
   * `textures` maps the authored material names (`Sky_Back`, ...) to the
   * level's loaded sky textures.
   */
  constructor(textures: Map<string, THREE.Texture>) {
    for (const [name, texture] of textures) this.textures.set(name, texture)
    // The renderer must not rebuild the sky camera from its (unused) position and rotation.
    this.camera.matrixAutoUpdate = false
    this.camera.matrixWorldAutoUpdate = false
    this.scene.add(this.entity)
  }

  get visible() {
    return this.shown && !!this.mesh
  }

  readonly binding: GraphSkyBinding = {
    create: settings => this.create(settings),
    update: (materials, color) => this.update(materials, color),
    show: orientation => this.show(orientation),
    hide: () => { this.shown = false },
  }

  private create(settings: GraphSkySettings) {
    if (this.mesh) throw new Error('TT Sky was turned on twice without a reset')
    this.settings = settings
    const geometry = skyBoxGeometry(buildSkyBoxMesh(settings))
    const slots = settings.sides + Number(settings.top) + Number(settings.bottom)
    const colors = new Float32Array(geometry.attributes.position!.count * 3).fill(1)
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    this.mesh = new THREE.Mesh(geometry, Array.from({ length: slots }, () => this.material(null)))
    this.mesh.frustumCulled = false
    this.mesh.name = 'TT_Sky_Entity'
    this.entity.add(this.mesh)
  }

  private material(name: string | null): THREE.MeshBasicMaterial {
    const key = name ?? ''
    let material = this.materials.get(key)
    if (material) return material
    let map: THREE.Texture | null = null
    if (name !== null) {
      map = this.textures.get(name) ?? null
      if (!map) throw new Error(`TT Sky face material ${name} has no loaded sky texture`)
    }
    material = new THREE.MeshBasicMaterial({ map, vertexColors: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false })
    this.materials.set(key, material)
    return material
  }

  private update(names: (string | null)[], color: [number, number, number, number]) {
    if (!this.mesh) throw new Error('TT Sky updated before it was created')
    this.mesh.material = names.map(name => this.material(name))
    const colors = this.mesh.geometry.attributes.color as THREE.BufferAttribute
    const prelit = new THREE.Color().setRGB(byte(color[0]), byte(color[1]), byte(color[2]), THREE.SRGBColorSpace)
    if (colors.getX(0) !== prelit.r || colors.getY(0) !== prelit.g || colors.getZ(0) !== prelit.b) {
      for (let i = 0; i < colors.count; i++) colors.setXYZ(i, prelit.r, prelit.g, prelit.b)
      colors.needsUpdate = true
    }
  }

  /** Oriented by the Orientation Object's world rotation; positioned at the camera by the sky camera itself. */
  private show(orientation: GraphObjectBinding | undefined) {
    if (!this.mesh) throw new Error('TT Sky shown before it was created')
    const rotation = orientation?.rotation ?? [0, 0, 0, 1]
    this.entity.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3])
    this.shown = true
  }

  /** Draw the sky into the current target, clearing it first, for one eye. */
  render(renderer: THREE.WebGLRenderer, eye: THREE.PerspectiveCamera) {
    if (!this.settings) return
    eye.updateMatrixWorld()
    // The sky sits at the camera: only the eye's rotation applies.
    this.camera.matrixWorld.extractRotation(eye.matrixWorld)
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert()
    skyProjection(eye.projectionMatrix, this.settings.distortion, this.camera.projectionMatrix)
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert()
    renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.mesh?.geometry.dispose()
    for (const material of this.materials.values()) material.dispose()
    for (const texture of this.textures.values()) texture.dispose()
    this.scene.clear()
  }
}

/** The five faces `Load Sky-Textures` fills, by authored material name. */
export const SKY_FACES = ['Back', 'Right', 'Front', 'Left', 'Down'] as const

/**
 * Load a sky set (`/original/sky/Sky_<letter>_<Face>.<format>`, as the pack
 * manifest records it) keyed by the materials `Load Sky-Textures` fills:
 * `Sky_<Face>` in levels, `MSky_<Face>` in MenuLevel.
 */
export async function loadSkyTextures(letter: string, materialPrefix = 'Sky'): Promise<Map<string, THREE.Texture>> {
  const formats = await loadOriginalPackFormats()
  const loader = new THREE.TextureLoader()
  const textures = await Promise.all(SKY_FACES.map(face => loader.loadAsync(`/original/${originalSkyFile(letter, face, formats)}`)))
  return new Map(textures.map((texture, i) => {
    texture.colorSpace = THREE.SRGBColorSpace
    return [`${materialPrefix}_${SKY_FACES[i]}`, texture]
  }))
}
