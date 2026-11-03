// `Ray Intersection` over the CK object context, as the original runs it: the
// building block (RayIntersection.cpp) walks its candidates, each
// CK3dEntity::RayIntersection takes the ray into the entity's frame and the
// mesh test is CK2_3D's SSE variant (0x1002F52E, chosen at 0x1002E020 when
// CPUID reports SSE) over VxMath's ray/plane/face routines. Single-precision
// stores round with Math.fround; x87 intermediates are approximated with
// doubles, as in original-matrix.ts.
import type { OriginalVector } from './original-orientation.ts'
import { originalRotateVector } from './original-orientation.ts'
import { originalTransformPoint as transformPoint } from './original-matrix.ts'

const f = Math.fround

/** VxMathDefines.h EPSILON (VxMath.dll 0x242A01E8). */
const EPSILON = f(1.192092896e-07)

/** A mesh material as far as the ray test reads it. */
export interface OriginalRayMaterial {
  twoSided: boolean
  /** `GetAlphaRef`: a textured material with a non-zero reference needs a texture pick. */
  alphaRef: number
  textured: boolean
}

/** A CKMesh's vertices and faces, in its entity's local frame. */
export interface OriginalMeshGeometry {
  /** x, y, z per vertex (float32). */
  positions: readonly number[]
  normals: readonly number[]
  uvs: readonly number[]
  /** Three vertex indices per face. */
  indices: readonly number[]
  /** Per face: an index into `materials`, whose entry is undefined for no material. */
  faceMaterials: readonly number[]
  materials: readonly (OriginalRayMaterial | undefined)[]
}

/** `VxIntersectionDesc` of a mesh hit, in the entity's frame. */
export interface OriginalMeshHit {
  point: OriginalVector
  normal: OriginalVector
  distance: number
  faceIndex: number
}

const faceNormalCache = new WeakMap<OriginalMeshGeometry, number[]>()

/**
 * `BuildFaceNormalsSIMDFunc` (CK2_3D 0x1002E45C): (v1 − v0) × (v2 − v0) in
 * single precision, scaled by `rsqrtss` of its squared length (zero for a
 * degenerate face). rsqrtss is a CPU-specific 12-bit approximation; the exact
 * reciprocal square root rounded to float stands in for it.
 */
export function originalFaceNormals(mesh: OriginalMeshGeometry): number[] {
  const cached = faceNormalCache.get(mesh)
  if (cached) return cached
  const p = mesh.positions, normals: number[] = []
  for (let face = 0; face < mesh.indices.length / 3; face++) {
    const a = mesh.indices[face * 3]! * 3, b = mesh.indices[face * 3 + 1]! * 3, c = mesh.indices[face * 3 + 2]! * 3
    const e1 = [f(p[b]! - p[a]!), f(p[b + 1]! - p[a + 1]!), f(p[b + 2]! - p[a + 2]!)]
    const e2 = [f(p[c]! - p[a]!), f(p[c + 1]! - p[a + 1]!), f(p[c + 2]! - p[a + 2]!)]
    const n = [
      f(f(e2[2]! * e1[1]!) - f(e2[1]! * e1[2]!)),
      f(f(e2[0]! * e1[2]!) - f(e2[2]! * e1[0]!)),
      f(f(e2[1]! * e1[0]!) - f(e2[0]! * e1[1]!)),
    ]
    const length2 = f(f(f(n[1]! * n[1]!) + f(n[0]! * n[0]!)) + f(n[2]! * n[2]!))
    const scale = length2 !== 0 ? f(1 / Math.sqrt(length2)) : 0
    normals.push(f(n[0]! * scale), f(n[1]! * scale), f(n[2]! * scale))
  }
  faceNormalCache.set(mesh, normals)
  return normals
}

interface PlaneHit { point: OriginalVector; distance: number; t: number }

/**
 * `VxIntersect::RayPlane` (VxMath 0x2428BBA0) and `RayPlaneCulled`
 * (0x2428BC70) on the plane `Create(normal, pt0)`. The two-sided test rejects
 * |n·d| < EPSILON, the culled one n·d > −EPSILON; both reject t < −EPSILON.
 * The point uses the unrounded t.
 */
function rayPlane(origin: OriginalVector, direction: OriginalVector, n: readonly number[], p0: readonly number[], culled: boolean): PlaneHit | undefined {
  const d = f(-((n[0]! * p0[0]! + n[1]! * p0[1]!) + n[2]! * p0[2]!))
  const denom = (n[1]! * direction[1] + n[2]! * direction[2]) + n[0]! * direction[0]
  if (culled ? denom > -EPSILON : Math.abs(denom) < EPSILON) return undefined
  const numerator = culled
    ? ((origin[2] * n[2]! + origin[1] * n[1]!) + origin[0] * n[0]!) + d
    : ((origin[2] * n[2]! + origin[0] * n[0]!) + origin[1] * n[1]!) + d
  const t = -numerator / denom
  if (t < -EPSILON) return undefined
  return {
    t, distance: f(t),
    point: [f(t * direction[0] + origin[0]), f(f(t * direction[1]) + origin[1]), f(f(t * direction[2]) + origin[2])],
  }
}

/** `SelectFaceProjectionAxes` inside `VxIntersect::PointInFace`: drop the normal's largest axis (first wins ties). */
function projectionAxes(n: readonly number[]): [number, number] {
  let axes: [number, number] = [1, 2], largest = Math.abs(n[0]!)
  if (largest < Math.abs(n[1]!)) { axes = [0, 2]; largest = Math.abs(n[1]!) }
  if (largest < Math.abs(n[2]!)) axes = [0, 1]
  return axes
}

/** `VxIntersect::PointInFace` (VxMath 0x2428D0B0): the three edge tests share a sign (zero counts as positive). */
function pointInFace(point: OriginalVector, p0: readonly number[], p1: readonly number[], p2: readonly number[], [i, j]: [number, number]): boolean {
  const side = (from: readonly number[], to: readonly number[]) =>
    (point[i]! - from[i]!) * (to[j]! - from[j]!) - (to[i]! - from[i]!) * (point[j]! - from[j]!) >= 0
  const first = side(p0, p1)
  return side(p1, p2) === first && side(p2, p0) === first
}

/** `VxIntersect::GetPointCoefficients` (VxMath 0x2428D570): barycentric weights in the projection plane. */
function pointCoefficients(point: OriginalVector, p0: readonly number[], p1: readonly number[], p2: readonly number[], [i, j]: [number, number]): [number, number, number] {
  const a = point[i]! - p0[i]!, b = f(point[j]! - p0[j]!)
  const c = f(p1[i]! - p0[i]!), d = f(p1[j]! - p0[j]!)
  const e = p2[i]! - p0[i]!, g = f(p2[j]! - p0[j]!)
  let v2: number, v1: number
  if (c === 0) {
    v2 = a / e
    v1 = (b - v2 * g) / d
  } else {
    v2 = (c * b - d * a) / (g * c - e * d)
    v1 = (a - v2 * e) / c
  }
  const c1 = f(v1), c2 = f(v2)
  return [f(1 - (c1 + c2)), c1, c2]
}

const cross = (a: readonly number[], b: readonly number[]): OriginalVector =>
  [f(a[1]! * b[2]! - a[2]! * b[1]!), f(a[2]! * b[0]! - a[0]! * b[2]!), f(a[0]! * b[1]! - a[1]! * b[0]!)]
const dot = (a: readonly number[], b: readonly number[]) => (a[0]! * b[0]! + a[1]! * b[1]!) + a[2]! * b[2]!

/**
 * `Mesh_RayIntersectionSIMDFunc` (CK2_3D 0x1002F52E) for an infinite ray
 * (CKRAYINTERSECTIONDEFAULT): with 16 faces or more, vertices are classified
 * against two planes through the ray and faces with every vertex on one side
 * are skipped. Each face takes `RayFace` with a two-sided material and
 * `RayFaceCulled` otherwise; the nearest distance wins. The point is
 * origin + direction·distance, the normal and UV are interpolated with the
 * face coefficients.
 */
export function originalMeshRayIntersection(mesh: OriginalMeshGeometry, origin: OriginalVector, direction: OriginalVector): OriginalMeshHit | undefined {
  const faces = mesh.indices.length / 3, vertices = mesh.positions.length / 3
  if (faces === 0 || vertices === 0) return undefined
  const p = mesh.positions, normals = originalFaceNormals(mesh)
  const vertex = (index: number) => [p[index * 3]!, p[index * 3 + 1]!, p[index * 3 + 2]!]
  const flags = new Uint8Array(vertices)
  if (faces >= 16) {
    let first = cross(direction, [0, 1, 0])
    if (dot(first, first) < EPSILON) first = cross(direction, [1, 0, 0])
    const second = cross(direction, first)
    first = cross(direction, second)
    const firstOrigin = f(dot(origin, first)), secondOrigin = f(dot(origin, second))
    // SSE: ((x·a.x + y·a.y) + z·a.z) per vertex, each step in single precision.
    const project = (index: number, axis: readonly number[]) =>
      f(f(f(p[index * 3]! * axis[0]!) + f(p[index * 3 + 1]! * axis[1]!)) + f(p[index * 3 + 2]! * axis[2]!))
    for (let index = 0; index < vertices; index++) {
      flags[index] = (project(index, first) < firstOrigin ? 1 : 2) | (project(index, second) < secondOrigin ? 4 : 8)
    }
  }
  let best: { face: number; distance: number; axes: [number, number] } | undefined
  let minimum = f(1e35)
  for (let face = 0; face < faces; face++) {
    const a = mesh.indices[face * 3]!, b = mesh.indices[face * 3 + 1]!, c = mesh.indices[face * 3 + 2]!
    if (flags[a]! & flags[b]! & flags[c]!) continue
    const p0 = vertex(a), p1 = vertex(b), p2 = vertex(c)
    const normal = normals.slice(face * 3, face * 3 + 3)
    const material = mesh.materials[mesh.faceMaterials[face]!]
    const hit = rayPlane(origin, direction, normal, p0, !material?.twoSided)
    if (!hit) continue
    const axes = projectionAxes(normal)
    if (!pointInFace(hit.point, p0, p1, p2, axes)) continue
    if (hit.distance < minimum) {
      minimum = hit.distance
      best = { face, distance: hit.distance, axes }
    }
  }
  if (!best) return undefined
  const a = mesh.indices[best.face * 3]!, b = mesh.indices[best.face * 3 + 1]!, c = mesh.indices[best.face * 3 + 2]!
  const point: OriginalVector = [0, 1, 2].map(axis => f(origin[axis]! + f(direction[axis]! * best.distance))) as OriginalVector
  const [c0, c1, c2] = pointCoefficients(point, vertex(a), vertex(b), vertex(c), best.axes)
  const n = mesh.normals
  const normal = [0, 1, 2].map(axis =>
    f(f(f(c0 * n[a * 3 + axis]!) + f(c1 * n[b * 3 + axis]!)) + f(c2 * n[c * 3 + axis]!))) as OriginalVector
  const material = mesh.materials[mesh.faceMaterials[best.face]!]
  // PreciseTexturePick (0x1002E82F) samples the texture's alpha at the hit UV.
  if (material?.textured && material.alphaRef !== 0) {
    throw new Error(`Ray Intersection hit face ${best.face} of a material with alpha reference ${material.alphaRef}: texture picking is not supported`)
  }
  return { point, normal, distance: best.distance, faceIndex: best.face }
}

/** A candidate of the building block: a 3D entity with its transforms and current mesh. */
export interface OriginalRayEntity {
  reference: string
  /** Exact class, for the class lists and the character and sprite paths. */
  classId: number
  visible: boolean
  world: readonly number[]
  inverseWorld: readonly number[]
  mesh?: OriginalMeshGeometry
}

/** The building block's result in world space. */
export interface OriginalRayResult {
  entity: string
  faceIndex: number
  nearestVertex: number
  point: OriginalVector
  normal: OriginalVector
  distance: number
}

const subtract = (a: readonly number[], b: readonly number[]): OriginalVector => [f(a[0]! - b[0]!), f(a[1]! - b[1]!), f(a[2]! - b[2]!)]
const squareMagnitude = (v: readonly number[]) => f((v[0]! * v[0]! + v[1]! * v[1]!) + v[2]! * v[2]!)
const magnitude = (v: readonly number[]) => f(Math.sqrt(squareMagnitude(v)))

/** `VxVector::Normalize`: components times 1 / Magnitude, unchanged at zero length. */
export function originalNormalize(v: readonly number[]): OriginalVector {
  const length = magnitude(v)
  if (length === 0) return [v[0]!, v[1]!, v[2]!]
  const inverse = f(1 / length)
  return [f(v[0]! * inverse), f(v[1]! * inverse), f(v[2]! * inverse)]
}

/**
 * The building block (RayIntersection.cpp) after its inputs are read: the
 * origin and normalized direction in world space, the candidates in order
 * (the filter group's members, or every 3D object, character and 3D sprite).
 * Each entity's `RayIntersection(origin, origin + direction)` runs in its
 * frame; the nearest world hit within Depth wins. The bounding sphere and box
 * rejections of `Intersect` only skip entities whose mesh the ray cannot meet
 * within Depth, so they are left out.
 */
export function originalRayIntersection(candidates: readonly OriginalRayEntity[], origin: OriginalVector, direction: OriginalVector,
  depth: number, owner: string | undefined, skipTransparent: boolean, entityClass: (classId: number) => 'object' | 'character' | 'sprite' | undefined): OriginalRayResult | undefined {
  const end: OriginalVector = [f(origin[0] + direction[0]), f(origin[1] + direction[1]), f(origin[2] + direction[2])]
  let minimum = f(depth * depth)
  let best: { entity: OriginalRayEntity; hit: OriginalMeshHit } | undefined
  for (const entity of candidates) {
    if (entity.reference === owner) continue
    const kind = entityClass(entity.classId)
    if (!kind) continue
    if (skipTransparent && !entity.visible) continue
    if (kind !== 'object') throw new Error(`Ray Intersection against ${kind} ${entity.reference} is not supported`)
    if (!entity.mesh) continue
    // CK3dEntity::RayIntersection with no referential: both ends into the entity's frame.
    const localOrigin = transformPoint(entity.inverseWorld, origin), localEnd = transformPoint(entity.inverseWorld, end)
    const hit = originalMeshRayIntersection(entity.mesh, localOrigin, subtract(localEnd, localOrigin))
    if (!hit) continue
    const distance = squareMagnitude(subtract(transformPoint(entity.world, hit.point), origin))
    if (distance < minimum) {
      minimum = distance
      best = { entity, hit }
    }
  }
  if (!best || !(minimum < depth * depth)) return undefined
  const { entity, hit } = best
  const mesh = entity.mesh!, positions = mesh.positions
  const indices = [0, 1, 2].map(corner => mesh.indices[hit.faceIndex * 3 + corner]!)
  const [d1, d2, d3] = indices.map(index => magnitude(subtract([positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!], hit.point)))
  const nearestVertex = d1! < d2! ? (d1! < d3! ? indices[0]! : indices[2]!) : (d2! < d3! ? indices[1]! : indices[2]!)
  return {
    entity: entity.reference, faceIndex: hit.faceIndex, nearestVertex,
    point: transformPoint(entity.world, hit.point),
    normal: originalNormalize(originalRotateVector(entity.world, hit.normal)),
    distance: f(Math.sqrt(minimum)),
  }
}

/** The parts of a document's render export (`.local/original/<stem>.json`) the ray test reads. */
export interface OriginalRenderPack {
  meshes?: { name: string; positions: number[]; normals: number[]; uvs: number[]; indices: number[]; faceMaterials: number[]; materials: number[] }[]
  materials?: { id: number; texture?: number; TwoSidedEnabled: boolean; alphaRef: number }[]
}

/** A lookup of a render export's meshes by name; a name used twice fails loudly when asked for. */
export function originalRenderPackMeshes(pack: OriginalRenderPack): (name: string) => OriginalMeshGeometry | undefined {
  const materials = new Map((pack.materials ?? []).map(material => [material.id, material]))
  const meshes = new Map<string, OriginalMeshGeometry | null>()
  for (const mesh of pack.meshes ?? []) {
    meshes.set(mesh.name, meshes.has(mesh.name) ? null : {
      positions: mesh.positions, normals: mesh.normals, uvs: mesh.uvs, indices: mesh.indices, faceMaterials: mesh.faceMaterials,
      // The export lists a missing material as an unknown ID.
      materials: mesh.materials.map(id => {
        const material = materials.get(id)
        return material && { twoSided: material.TwoSidedEnabled, alphaRef: material.alphaRef, textured: material.texture !== undefined }
      }),
    })
  }
  return name => {
    const mesh = meshes.get(name)
    if (mesh === null) throw new Error(`Mesh ${name} appears more than once in its render export`)
    return mesh
  }
}
