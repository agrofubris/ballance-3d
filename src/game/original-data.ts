import * as THREE from 'three'
import { OriginalFixedFunctionMaterial, TEXTUREBLEND_MODULATEALPHA, type OriginalLighting } from './original-fixed-function.ts'

// Shared loader and render-conversion layer for the exported scene documents.
// Original units are scaled into render units; Z is mirrored, so triangle
// winding is flipped to keep faces front-facing.

/** Original units to render units; also the scale of the Z mirror. */
export const SCALE = 0.25

export interface OriginalObject {
  id: number
  name: string
  mesh: number
  matrix: number[]
  visible: boolean
}

export interface OriginalMesh {
  id: number
  name?: string
  positions: number[]
  normals: number[]
  uvs: number[]
  indices: number[]
  faceMaterials: number[]
  materials: number[]
}

type MaterialRecord = OriginalDocument['materials'][number]

export interface OriginalDocument {
  objects: OriginalObject[]
  meshes: OriginalMesh[]
  materials: {
    id: number
    name: string
    emissive: number[]
    texture: number
    diffuse: number[]
    ambient?: number[]
    specular?: number[]
    specularPower?: number
    AlphaBlendEnabled: boolean
    AlphaTestEnabled: boolean
    TwoSidedEnabled: boolean
    ZWriteEnabled: boolean
    alphaRef?: number
    alphaFunc?: number
    zFunc?: number
    sourceBlend?: number
    destBlend?: number
    textureBlendMode?: number
    textureAddressMode?: number
    textureMinMode?: number
    textureMagMode?: number
  }[]
  textures: {
    id: number
    file: string
    name?: string
    transparent?: boolean
    transparentColor?: number
  }[]
  groups: { name: string; members: number[] }[]
}

// D3D8 compare codes and blend codes as the export writes them.
const D3D_CMP_ALWAYS = 8
const D3D_CMP_GREATER = 5
const LEGACY_ALPHA_THRESHOLD = 0.4
const LANTERN_GRADIENT_FILE = '/Laterne_Verlauf.png'

const DEPTH_BY_D3D_CODE: readonly THREE.DepthModes[] = [
  THREE.NeverDepth, THREE.LessDepth, THREE.EqualDepth, THREE.LessEqualDepth,
  THREE.GreaterDepth, THREE.NotEqualDepth, THREE.GreaterEqualDepth, THREE.AlwaysDepth,
]

const BLEND_PAIRS: readonly { src: number; dst: number; srcFactor: THREE.BlendingSrcFactor; dstFactor: THREE.BlendingDstFactor }[] = [
  { src: 2, dst: 2, srcFactor: THREE.OneFactor, dstFactor: THREE.OneFactor },
  { src: 5, dst: 6, srcFactor: THREE.SrcAlphaFactor, dstFactor: THREE.OneMinusSrcAlphaFactor },
  { src: 2, dst: 5, srcFactor: THREE.OneFactor, dstFactor: THREE.SrcAlphaFactor },
]

/** Builds a fresh indexed geometry for a mesh placed by `matrix`; `relative` drops its translation. */
export function originalGeometry(mesh: OriginalMesh, matrix: number[], relative = false): THREE.BufferGeometry {
  const placement = new THREE.Matrix4().fromArray(matrix)
  if (relative) {
    placement.elements[12] = 0
    placement.elements[13] = 0
    placement.elements[14] = 0
  }
  const toRender = new THREE.Matrix4().makeScale(SCALE, SCALE, -SCALE).multiply(placement)

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3))
  const uvs = mesh.uvs.map((value, i) => (i % 2 === 1 ? 1 - value : value))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))

  // The mirror reverses winding: swap the last two indices of every triangle on a copy.
  const indices = mesh.indices.slice()
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const swap = indices[i + 1]
    indices[i + 1] = indices[i + 2]
    indices[i + 2] = swap
  }
  geometry.setIndex(indices)

  // Consecutive faces sharing a material index form one draw group.
  const faces = mesh.faceMaterials
  for (let start = 0; start < faces.length;) {
    let end = start + 1
    while (end < faces.length && faces[end] === faces[start]) end++
    geometry.addGroup(start * 3, (end - start) * 3, faces[start])
    start = end
  }

  geometry.applyMatrix4(toRender)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** The alpha-test threshold the export's state implies (0 disables the test). */
export function recoveredAlphaTest(m: MaterialRecord): number {
  if (!m.AlphaTestEnabled) return 0
  if (typeof m.alphaRef !== 'number' || typeof m.alphaFunc !== 'number') return LEGACY_ALPHA_THRESHOLD
  if (m.alphaFunc === D3D_CMP_ALWAYS) return 0
  if (m.alphaFunc === D3D_CMP_GREATER) return m.alphaRef / 255
  return LEGACY_ALPHA_THRESHOLD
}

/** Applies the recovered alpha test to a material; returns the threshold it set. */
export function configureRecoveredAlphaTest(material: OriginalFixedFunctionMaterial, m: MaterialRecord): number {
  const threshold = recoveredAlphaTest(m)
  material.alphaTest = threshold
  material.strictAlphaTest = threshold > 0 && m.alphaFunc === D3D_CMP_GREATER
  return threshold
}

/** Applies the export's blend pair to a material when the pair is one of the known ones. */
export function configureRecoveredBlending(material: THREE.MeshPhongMaterial, m: MaterialRecord): void {
  material.transparent = m.AlphaBlendEnabled
  if (!m.AlphaBlendEnabled || typeof m.sourceBlend !== 'number' || typeof m.destBlend !== 'number') return
  const pair = BLEND_PAIRS.find(p => p.src === m.sourceBlend && p.dst === m.destBlend)
  if (!pair) return
  material.blending = THREE.CustomBlending
  material.blendEquation = THREE.AddEquation
  material.blendEquationAlpha = THREE.AddEquation
  material.blendSrc = pair.srcFactor
  material.blendSrcAlpha = pair.srcFactor
  material.blendDst = pair.dstFactor
  material.blendDstAlpha = pair.dstFactor
}

/** Additive, no-alpha-test, no-depth-write state for the lantern light shade. */
export function configureLanternShade(material: THREE.MeshPhongMaterial & { strictAlphaTest?: boolean }): void {
  material.alphaTest = 0
  material.strictAlphaTest = false
  material.transparent = true
  material.blending = THREE.CustomBlending
  material.blendEquation = THREE.AddEquation
  material.blendEquationAlpha = THREE.AddEquation
  material.blendSrc = THREE.OneFactor
  material.blendSrcAlpha = THREE.OneFactor
  material.blendDst = THREE.OneFactor
  material.blendDstAlpha = THREE.OneFactor
  material.depthWrite = false
}

/** Builds the fixed-function material for one exported material record. */
export function originalMaterial(m: MaterialRecord, map: THREE.Texture | null, file: string | undefined, lighting: OriginalLighting): OriginalFixedFunctionMaterial {
  if (!m.ambient || typeof m.specularPower !== 'number' || !m.specular) {
    throw new Error(`Material ${m.name} lacks its exported lighting colours; regenerate the local pack`)
  }
  const material = new OriginalFixedFunctionMaterial({
    map,
    color: new THREE.Color(m.diffuse[0], m.diffuse[1], m.diffuse[2]),
    emissive: new THREE.Color(m.emissive[0], m.emissive[1], m.emissive[2]),
    shininess: m.specularPower,
    specular: new THREE.Color(m.specular[0], m.specular[1], m.specular[2]),
    opacity: m.diffuse[3],
    depthWrite: m.ZWriteEnabled,
    side: m.TwoSidedEnabled ? THREE.DoubleSide : THREE.FrontSide,
  })
  material.ambientColor.setRGB(m.ambient[0], m.ambient[1], m.ambient[2])
  material.specularEnabled = m.specularPower > 0.05
  material.textureBlendMode = m.textureBlendMode ?? TEXTUREBLEND_MODULATEALPHA
  material.lighting = lighting
  configureRecoveredAlphaTest(material, m)
  configureRecoveredBlending(material, m)

  if (m.zFunc !== undefined) {
    const code = m.zFunc
    if (!Number.isInteger(code) || code < 1 || code > DEPTH_BY_D3D_CODE.length) {
      throw new Error(`Material ${m.name} has an unknown ZFunc ${code}`)
    }
    material.depthFunc = DEPTH_BY_D3D_CODE[code - 1]
  }
  if (file !== undefined && file.endsWith(LANTERN_GRADIENT_FILE)) configureLanternShade(material)
  material.name = m.name
  return material
}
