// CKPGUID_BOX values and CK3dEntity::GetBoundingBox, decoded from the shipped
// DLLs (ParameterOperations, CK2_3D, VxMath).
//
// A CKPGUID_BOX value is VxBbox in memory order
// [Max.x, Max.y, Max.z, Min.x, Min.y, Min.z] (VxBbox declares Max before Min;
// ParameterOperations 0x24B4A860, Min(Box) -> Vector, reads the vector at
// box + 0xC). GraphObjectBinding.bounds is (min, max) instead.
import type { OriginalContext } from './original-context.ts'

const f = Math.fround

/** A VxBbox as six float32 values: Max xyz, then Min xyz (CKPGUID_BOX). */
export type OriginalBox = [number, number, number, number, number, number]

/**
 * RCKMesh::UpdateBoundingVolumes (CK2_3D.dll 0x1001F1C4): the box is the
 * per-axis min and max of the vertex positions, starting from vertex 0 and
 * replacing with strict comparisons (`min > v` / `max < v`), so a NaN or an
 * equal value never replaces. No vertices give an all-zero box (0x1001F438).
 * RCKMesh::GetLocalBox (0x1001F163) returns it, recomputing when
 * VXMESH_BOUNDINGUPTODATE (flag 1 at mesh+0x50) is clear. The box lives at
 * mesh+0x64 (Max) and mesh+0x70 (Min).
 */
export function originalMeshLocalBox(positions: readonly number[]): OriginalBox {
  if (positions.length < 3) return [0, 0, 0, 0, 0, 0]
  const max = [f(positions[0]!), f(positions[1]!), f(positions[2]!)]
  const min = [...max]
  for (let i = 3; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = f(positions[i + axis]!)
      if (min[axis]! > v) min[axis] = v
      if (max[axis]! < v) max[axis] = v
    }
  }
  return [max[0]!, max[1]!, max[2]!, min[0]!, min[1]!, min[2]!]
}

/**
 * VxBbox::TransformFrom(src, matrix) (VxMath.dll export 0x2428EAA0, SSE path
 * 0x2428EABD, taken whenever CPUID reports SSE, the flag at 0x242BE8DC; the x87
 * fallback at 0x2428EB6E is for CPUs without SSE and is not ported).
 * Every packed operation rounds to float32:
 *   c = (min + max) * 0.5            h = (min - max) * 0.5     (h <= 0)
 *   center = ((row3 + c.y*row1) + c.x*row0) + c.z*row2
 *   ext    = (|row0*h.x| + |row1*h.y|) + |row2*h.z|     per output axis
 *   Max = center + ext, Min = center - ext
 * The constants are 0.5 (table entry 0x242A794C) and the abs mask 0x7FFFFFFF
 * (0x242A7954), both set up by 0x24282150 / 0x24282110. `m` is the Virtools
 * row-major matrix (m[i*4+j], rows 0-2 axes, row 3 position).
 */
export function originalTransformBox(box: readonly number[], m: readonly number[]): OriginalBox {
  const half = 0.5
  const c: number[] = [], h: number[] = []
  for (let axis = 0; axis < 3; axis++) {
    const max = box[axis]!, min = box[3 + axis]!
    c.push(f(f(min + max) * half))
    h.push(f(f(min - max) * half))
  }
  const result: number[] = [0, 0, 0, 0, 0, 0]
  for (let j = 0; j < 3; j++) {
    const center = f(f(f(m[12 + j]! + f(c[1]! * m[4 + j]!)) + f(c[0]! * m[j]!)) + f(c[2]! * m[8 + j]!))
    const extent = f(f(Math.abs(f(m[j]! * h[0]!)) + Math.abs(f(m[4 + j]! * h[1]!))) + Math.abs(f(m[8 + j]! * h[2]!)))
    result[j] = f(center + extent)
    result[3 + j] = f(center - extent)
  }
  return result as OriginalBox
}

/**
 * CK3dEntity::GetBoundingBox(Local) (CK2_3D.dll vtable slot 0x1C0 = 0x10009144):
 * UpdateBox (slot 0x1BC = 0x10006113) then the world box (entity+0x164) for
 * Local FALSE, the local box (entity+0x14C) for TRUE.
 *   - With a current mesh (entity+0x68): local = RCKMesh::GetLocalBox, world =
 *     TransformFrom(local, world matrix). (A skin (entity+0x7C) would merge its
 *     bone box into local via 0x100407B0; the context has no skins, UNVERIFIED
 *     that no Ballance entity has one.) The recompute is skipped only while
 *     entity flag UPTODATE (4) and the mesh's BOUNDINGUPTODATE are both set, a
 *     cache of the same value.
 *   - Without a mesh: world Max = Min = the world matrix's position row, local
 *     = all zero (0x10006177-0x100061E5).
 *   - A user box (SetBoundingBox, entity flag 0x10) is the other branch
 *     (0x1000612E); no building block of the graphs sets one, so it is not modelled.
 * Undefined for a non-entity.
 */
export function originalEntityBoundingBox(context: OriginalContext, id: number, local: boolean): OriginalBox | undefined {
  const world = context.worldMatrix(id)
  if (!world) return undefined
  const mesh = context.currentMesh(id)
  if (!mesh) return local ? [0, 0, 0, 0, 0, 0] : [world[12]!, world[13]!, world[14]!, world[12]!, world[13]!, world[14]!]
  const box = originalMeshLocalBox(mesh.geometry!.positions)
  return local ? box : originalTransformBox(box, world)
}
