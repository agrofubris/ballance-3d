// A hierarchy of CK3dEntity transforms in original units, for graph-driven
// frames that have no body or mesh in the port (the Camera.nmo rig). It follows
// RCK3dEntity (doyaGu/CKRenderEngine CK3dEntity.cpp, the IDA reconstruction of
// CK2_3D.dll): each entity keeps its world and local matrices and a lazily
// computed inverse world matrix, and the VxMath routines round as the original.
import * as THREE from 'three'
import { authoredMatrixToBinding, authoredVectorToBinding, type GraphFrameBinding, type GraphObjectBinding } from './original-graph-bindings.ts'
import { originalRotateVector, originalSetOrientation, type OriginalVector } from './original-orientation.ts'
import {
  originalIdentityMatrix,
  originalInverseMatrix,
  originalMatrixFromRotation,
  originalMultiplyMatrix,
  originalTransformPoint,
  type OriginalMatrix,
} from './original-matrix.ts'

const f = Math.fround

/** VxMathDefines.h EPSILON as the float32 constant at CK2_3D 0x10083828 (2^-23). */
const ENTITY_EPSILON = 1.1920928955078125e-07
/** CK2_3D's 0.0f (0x10083824) test turns a zero scale component into the float 358637BDh. */
const SCALE_FLOOR = f(.000001)

/**
 * One row of `RCK3dEntity::SetScale` (CK2_3D 0x1000791A):
 * `VxVector::operator*(Normalize(row), s)`. Normalize (0x1000BEC0) is x87:
 * dot = x*x + y*y + z*z (0x1000BF50, unrounded), stored as float, sqrt, then
 * inverse = float(1 / sqrt) (0x1000BEF0, `fdivr` by 1.0f and `fstp dword`); each
 * component is float(row * inverse) (0x1000BFF0), then float(s * that).
 * UNVERIFIED: the x87 precision control. This uses double sums (53 bit); a 24-bit
 * control word would round every product and sum to float (see notes.md).
 * A zero-length row would give NaN in the original; here it fails loudly.
 */
function scaledAxis(row: readonly number[], scale: number): [number, number, number] {
  const dot = f(row[0]! * row[0]! + row[1]! * row[1]! + row[2]! * row[2]!)
  if (!(dot > 0)) throw new Error('SetScale of a zero-length axis row has no defined result in the original (NaN)')
  const inverse = f(1 / Math.sqrt(dot))
  return [f(scale * f(row[0]! * inverse)), f(scale * f(row[1]! * inverse)), f(scale * f(row[2]! * inverse))]
}


/** A saved entity: its world matrix (Virtools row-major) and parent name. */
export interface OriginalEntityState {
  name: string
  parent?: string
  matrix: readonly number[]
  visible?: boolean
}

interface Entity {
  readonly name: string
  parent?: Entity
  readonly children: Entity[]
  world: OriginalMatrix
  local: OriginalMatrix
  /** m_InverseWorldMatrix and VX_MOVEABLE_INVERSEWORLDMATVALID. */
  inverse: OriginalMatrix
  inverseValid: boolean
  visible: boolean
  /** The scene initial value: the load-time state, or what TT Save IC saved. */
  initial: OriginalEntityState
}

export class OriginalEntityGraph {
  private readonly entities = new Map<string, Entity>()

  /**
   * Load the saved states in order, as CK3dEntity::Load does for each:
   * `SetParent(parent, TRUE)`, then `SetWorldMatrix(world, TRUE)`.
   */
  constructor(states: readonly OriginalEntityState[] = []) {
    this.add(states)
  }

  /** Load more entities (a document load or a copy); parents may be new or existing entities. */
  add(states: readonly OriginalEntityState[]): void {
    for (const state of states) {
      if (this.entities.has(state.name)) throw new Error(`Entity ${state.name} is listed twice`)
      const identity = originalIdentityMatrix()
      this.entities.set(state.name, {
        name: state.name, children: [], world: identity, local: [...identity], inverse: [...identity],
        inverseValid: false, visible: state.visible ?? true, initial: { ...state, matrix: [...state.matrix] },
      })
    }
    for (const state of states) {
      if (state.parent !== undefined && !this.entities.has(state.parent)) throw new Error(`Entity ${state.name} has an unknown parent ${state.parent}`)
      this.restore(state.name)
    }
  }

  has(name: string): boolean { return this.entities.has(name) }

  /** A destroyed entity: its children keep their world pose without a parent. */
  remove(name: string): void {
    const entity = this.entities.get(name)
    if (!entity) return
    for (const child of [...entity.children]) this.setParent(child.name, undefined, true)
    if (entity.parent) entity.parent.children.splice(entity.parent.children.indexOf(entity), 1)
    this.entities.delete(name)
  }

  /** `CKScene::SetObjectInitialValue` of the current state (TT Save IC). */
  saveInitial(name: string): void {
    const entity = this.entity(name)
    entity.initial = { name, ...(entity.parent ? { parent: entity.parent.name } : {}), matrix: [...entity.world], visible: entity.visible }
  }

  names(): string[] { return [...this.entities.keys()] }

  private entity(name: string): Entity {
    const entity = this.entities.get(name)
    if (!entity) throw new Error(`Entity ${name} is not in the scene`)
    return entity
  }

  private optional(name: string | undefined): Entity | undefined {
    return name === undefined ? undefined : this.entity(name)
  }

  world(name: string): OriginalMatrix { return [...this.entity(name).world] }

  local(name: string): OriginalMatrix { return [...this.entity(name).local] }

  parent(name: string): string | undefined { return this.entity(name).parent?.name }

  /** Children in m_Children order (SetParent appends). */
  children(name: string): string[] { return this.entity(name).children.map(child => child.name) }

  visible(name: string): boolean { return this.entity(name).visible }

  setVisible(name: string, visible: boolean): void { this.entity(name).visible = visible }

  /** `GetInverseWorldMatrix`: recomputed only when invalid; a singular matrix keeps the old one. */
  /** `GetInverseWorldMatrix`, computed when the world matrix last changed. */
  inverse(name: string): OriginalMatrix { return [...this.inverseWorld(this.entity(name))] }

  private inverseWorld(entity: Entity): OriginalMatrix {
    if (!entity.inverseValid) {
      entity.inverseValid = true
      entity.inverse = originalInverseMatrix(entity.world) ?? entity.inverse
    }
    return entity.inverse
  }

  /** `CKReadObjectState` of the load-time state: SetParent(parent, TRUE), then SetWorldMatrix(world, TRUE). */
  restore(name: string): void {
    const entity = this.entity(name)
    this.setParent(name, entity.initial.parent, true)
    this.setWorldMatrix(name, entity.initial.matrix, true)
    entity.visible = entity.initial.visible ?? true
  }

  /**
   * `SetParent(Parent, KeepWorldPos)`: no-op for the same parent, refused for
   * itself or a descendant. With KeepWorldPos the local matrix becomes
   * inverse(parent world) · world; otherwise the world follows the old local.
   */
  setParent(name: string, parentName: string | undefined, keepWorld = true): boolean {
    const entity = this.entity(name), parent = this.optional(parentName)
    if (parent === entity) return false
    if (entity.parent === parent) return true
    for (let ancestor = parent?.parent; ancestor; ancestor = ancestor.parent) if (ancestor === entity) return false
    if (entity.parent) entity.parent.children.splice(entity.parent.children.indexOf(entity), 1)
    entity.parent = parent
    parent?.children.push(entity)
    if (keepWorld) entity.local = parent ? originalMultiplyMatrix(this.inverseWorld(parent), entity.world) : [...entity.world]
    else this.localMatrixChanged(entity, false)
    return true
  }

  /** `SetWorldMatrix(Mat, KeepChildren)`. */
  setWorldMatrix(name: string, matrix: readonly number[], keepChildren: boolean): void {
    const entity = this.entity(name)
    entity.world = matrix.map(f)
    this.worldMatrixChanged(entity, keepChildren)
  }

  /**
   * `GetPosition(&pos, Ref)`: the local translation when Ref is the parent,
   * Ref's inverse world transform of the world translation for another Ref,
   * the world translation without one.
   */
  position(name: string, referential?: string): OriginalVector {
    const entity = this.entity(name), reference = this.optional(referential)
    const translation = (m: OriginalMatrix): OriginalVector => [m[12]!, m[13]!, m[14]!]
    if (!reference) return translation(entity.world)
    if (reference === entity.parent) return translation(entity.local)
    return originalTransformPoint(this.inverseWorld(reference), translation(entity.world))
  }

  /** `SetPosition(&pos, Ref, KeepChildren)`: Ref->Transform into world, then WorldPositionChanged. */
  setPosition(name: string, position: OriginalVector, referential: string | undefined, keepChildren: boolean): void {
    const entity = this.entity(name), reference = this.optional(referential)
    const world = reference ? originalTransformPoint(reference.world, position) : position.map(f) as OriginalVector
    entity.world[12] = world[0]
    entity.world[13] = world[1]
    entity.world[14] = world[2]
    this.worldPositionChanged(entity, keepChildren)
  }

  /** `Transform(&dest, &src, NULL)`: a point in this entity's frame, in world coordinates. */
  transform(name: string, point: OriginalVector): OriginalVector {
    return originalTransformPoint(this.entity(name).world, point)
  }

  /** `SetOrientation(Dir, Up, Right, Ref, KeepChildren)`, then WorldMatrixChanged. */
  setOrientation(name: string, dir: OriginalVector, up: OriginalVector, right: OriginalVector | undefined,
    referential: string | undefined, keepChildren: boolean): void {
    const entity = this.entity(name), reference = this.optional(referential)
    entity.world = originalSetOrientation(entity.world, dir, up, right, reference?.world)
    this.worldMatrixChanged(entity, keepChildren)
  }

  /**
   * `LookAt(Pos, Ref, KeepChildren)` (CK2_3D 0x10007D68): aim the Z axis at
   * Pos (in Ref's frame) with world Y as the up reference. Nothing changes
   * for a target closer than EPSILON, one already along the Z axis, or a
   * vertical aim; the up axis keeps its side, then SetOrientation applies.
   */
  lookAt(name: string, position: OriginalVector, referential: string | undefined, keepChildren: boolean): void {
    const entity = this.entity(name), reference = this.optional(referential)
    const world = entity.world
    const target = reference ? originalTransformPoint(reference.world, position) : position.map(f) as OriginalVector
    const cross = (a: OriginalVector, b: OriginalVector): OriginalVector =>
      [f(f(a[1] * b[2]) - f(a[2] * b[1])), f(f(a[2] * b[0]) - f(a[0] * b[2])), f(f(a[0] * b[1]) - f(a[1] * b[0]))]
    const dot = (a: OriginalVector, b: OriginalVector) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]))
    let dir: OriginalVector = [f(target[0] - world[12]!), f(target[1] - world[13]!), f(target[2] - world[14]!)]
    const length = f(Math.sqrt(dot(dir, dir)))
    if (length < 1.192092896e-7) return
    const sideways = cross(dir, [world[8]!, world[9]!, world[10]!])
    if (dot(sideways, sideways) === 0) return
    const inverse = f(1 / length)
    dir = dir.map(c => f(c * inverse)) as OriginalVector
    let right = cross([0, 1, 0], dir)
    let up = cross(dir, right)
    if (up[1] === 0) return
    if (dot(up, [world[4]!, world[5]!, world[6]!]) < 0) {
      right = right.map(c => f(-c)) as OriginalVector
      up = up.map(c => f(-c)) as OriginalVector
    }
    this.setOrientation(name, dir, up, right, undefined, keepChildren)
  }

  /** `SetLocalMatrix(Mat, KeepChildren)` (vtable +0x168, 0x10008874): copy into m_LocalMatrix, then LocalMatrixChanged(KeepChildren, TRUE). */
  setLocalMatrix(name: string, matrix: readonly number[], keepChildren: boolean): void {
    const entity = this.entity(name)
    entity.local = matrix.map(f)
    this.localMatrixChanged(entity, keepChildren)
  }

  /**
   * `SetScale(&Scale, KeepChildren, Local)` (vtable +0x140, 0x1000791A). Each of
   * the three axis rows of the local (Local) or world matrix is replaced by its
   * normalised self times the scale component, a zero component becoming
   * 1e-6f; the translation row is untouched. Then LocalMatrixChanged or
   * WorldMatrixChanged(KeepChildren, TRUE). The Scale / Set Scale building
   * blocks always pass Local = TRUE (the default argument).
   */
  setScale(name: string, scale: readonly number[], keepChildren: boolean, local = true): void {
    const entity = this.entity(name)
    const matrix = [...(local ? entity.local : entity.world)]
    for (let row = 0; row < 3; row++) {
      const component = scale[row]! === 0 ? SCALE_FLOOR : f(scale[row]!)
      const axis = scaledAxis(matrix.slice(row * 4, row * 4 + 3), component)
      for (let j = 0; j < 3; j++) matrix[row * 4 + j] = axis[j]!
    }
    if (local) { entity.local = matrix; this.localMatrixChanged(entity, keepChildren) }
    else { entity.world = matrix; this.worldMatrixChanged(entity, keepChildren) }
  }

  /**
   * `AddScale(&Scale, KeepChildren, Local = TRUE)` (vtable +0x11C, 0x10007C09):
   * a diagonal matrix (zero components 1e-6f), `Vx3DMultiplyMatrix(new, local, diag)`
   * (rows of diag through local: row i of local times s_i), then SetLocalMatrix.
   * The DLL's Local = FALSE branch skips the multiply and would call
   * SetWorldMatrix on an unfilled matrix; the building block never takes it.
   */
  addScale(name: string, scale: readonly number[], keepChildren: boolean): void {
    const entity = this.entity(name)
    const diagonal = originalIdentityMatrix()
    for (let i = 0; i < 3; i++) diagonal[i * 5] = scale[i]! === 0 ? SCALE_FLOOR : f(scale[i]!)
    this.setLocalMatrix(name, originalMultiplyMatrix(entity.local, diagonal), keepChildren)
  }

  /**
   * `Rotate(&Axis, Angle, Ref, KeepChildren)` (vtable +0x10C, 0x100077F5). Nothing
   * happens for |Angle| < EPSILON (2^-23; NaN passes). The axis goes through the
   * referential's world 3x3 (`Vx3DRotateVector`, SSE path), then
   * `Vx3DMatrixFromRotation`, `Vx3DMultiplyMatrix(new, rotation, world)` (so
   * new = world · rotation, a rotation about the world axis), the translation
   * row restored from the old world matrix, then SetWorldMatrix(new, KeepChildren).
   * UNVERIFIED bit-exactness: `Vx3DMatrixFromRotation` normalises its axis with
   * `VxVector::Normalize` 0x24282C00, which on SSE CPUs is `rsqrtss` (a CPU-specific
   * 12-bit approximation); originalMatrixFromRotation uses the exact reciprocal.
   */
  rotate(name: string, axis: readonly number[], angle: number, referential: string | undefined, keepChildren: boolean): void {
    const entity = this.entity(name), reference = this.optional(referential)
    const turn = f(angle)
    if (Math.abs(turn) < ENTITY_EPSILON) return
    const direction: [number, number, number] = [f(axis[0]!), f(axis[1]!), f(axis[2]!)]
    const worldAxis = reference ? originalRotateVector(reference.world, direction) : direction
    if (worldAxis[0] === 0 && worldAxis[1] === 0 && worldAxis[2] === 0) {
      throw new Error('Rotate about a zero axis has no defined result in the original (rsqrtss of 0 gives NaN)')
    }
    const next = originalMultiplyMatrix(originalMatrixFromRotation(worldAxis, turn), entity.world)
    next[12] = entity.world[12]!
    next[13] = entity.world[13]!
    next[14] = entity.world[14]!
    this.setWorldMatrix(name, next, keepChildren)
  }

  private updateLocal(entity: Entity): void {
    entity.local = entity.parent ? originalMultiplyMatrix(this.inverseWorld(entity.parent), entity.world) : [...entity.world]
  }

  /** Children keep their world (recompute locals) or follow (LocalMatrixChanged(FALSE)). */
  private updateChildren(entity: Entity, keepChildren: boolean): void {
    if (keepChildren) {
      const inverse = this.inverseWorld(entity)
      for (const child of entity.children) child.local = originalMultiplyMatrix(inverse, child.world)
    } else {
      for (const child of entity.children) this.localMatrixChanged(child, false)
    }
  }

  /** `WorldMatrixChanged(updateChildren)`: clears the inverse, recomputes the local matrix. */
  private worldMatrixChanged(entity: Entity, keepChildren: boolean): void {
    entity.inverseValid = false
    this.updateLocal(entity)
    this.updateChildren(entity, keepChildren)
  }

  /** `LocalMatrixChanged(updateChildren)`: world = local in the parent's world. */
  private localMatrixChanged(entity: Entity, keepChildren: boolean): void {
    entity.inverseValid = false
    entity.world = entity.parent ? originalMultiplyMatrix(entity.parent.world, entity.local) : [...entity.local]
    this.updateChildren(entity, keepChildren)
  }

  /**
   * `WorldPositionChanged` (CK2_3D 0x1000666B): keeps a valid inverse and
   * rewrites only its translation, inv[3][j] = -(inv[2][j]·t2 + (inv[1][j]·t1 + inv[0][j]·t0)),
   * each partial sum stored as float.
   */
  private worldPositionChanged(entity: Entity, keepChildren: boolean): void {
    this.updateLocal(entity)
    if (entity.inverseValid) {
      const inverse = entity.inverse, world = entity.world
      for (let j = 0; j < 3; j++) {
        const t0 = f(inverse[j]! * world[12]!)
        const t1 = f(inverse[4 + j]! * world[13]! + t0)
        inverse[12 + j] = f(-(inverse[8 + j]! * world[14]! + t1))
      }
    }
    this.updateChildren(entity, keepChildren)
  }
}

/** A binding-space vector (render space when `scale` is not 1) in original units. */
function bindingVectorToOriginal(vector: readonly number[], scale: number): OriginalVector {
  if (scale === 1) return [vector[0]!, vector[1]!, vector[2]!]
  return [vector[0]! / scale, vector[1]! / scale, -vector[2]! / scale]
}

/** The inverse of `authoredMatrixToBinding`. */
function bindingMatrixToOriginal(matrix: readonly number[], scale: number): OriginalMatrix {
  if (scale === 1) return [...matrix]
  const result = [...matrix]
  for (const index of [2, 6, 8, 9]) result[index] = -result[index]!
  const [x, y, z] = bindingVectorToOriginal([matrix[12]!, matrix[13]!, matrix[14]!], scale)
  result[12] = x; result[13] = y; result[14] = z
  return result
}

/**
 * A graph object over one entity, in a binding's units: original units for
 * `coordinateScale` 1, otherwise render space (scaled, Z reflected). The
 * entity graph itself stays in original units; the power-of-two scale and the
 * sign flip convert exactly. Orientation axes are Virtools coordinates.
 * Rotation and scale are read from the world matrix; behaviors change them
 * through the CK3dEntity calls, not by assignment.
 */
export function originalEntityObject(graph: OriginalEntityGraph, name: string, coordinateScale = 1,
  bounds?: () => GraphObjectBinding['bounds']): GraphObjectBinding {
  if (!graph.has(name)) throw new Error(`Entity ${name} is not in the scene`)
  const toBinding = (vector: OriginalVector) => authoredVectorToBinding(vector, coordinateScale)
  const toOriginal = (vector: readonly number[]) => bindingVectorToOriginal(vector, coordinateScale)
  const matrix = () => authoredMatrixToBinding(graph.world(name), coordinateScale)
  return {
    get position() { return toBinding(graph.position(name)) },
    set position(value) { graph.setPosition(name, toOriginal(value), undefined, false) },
    get rotation() {
      const m = matrix()
      const scale = [0, 1, 2].map(row => Math.hypot(m[row * 4]!, m[row * 4 + 1]!, m[row * 4 + 2]!))
      const basis = new THREE.Matrix4().fromArray(m).scale(new THREE.Vector3(1 / scale[0]!, 1 / scale[1]!, 1 / scale[2]!))
      return new THREE.Quaternion().setFromRotationMatrix(basis).toArray() as [number, number, number, number]
    },
    set rotation(_value) { throw new Error(`Entity ${name} changes orientation through SetOrientation`) },
    get scale() {
      const world = graph.world(name)
      return [0, 1, 2].map(row => Math.hypot(world[row * 4]!, world[row * 4 + 1]!, world[row * 4 + 2]!)) as [number, number, number]
    },
    set scale(_value) { throw new Error(`Entity ${name} has no scale setter`) },
    get visible() { return graph.visible(name) },
    set visible(value) { graph.setVisible(name, value) },
    // `GetBoundingBox(TRUE)` of the current mesh, in binding units, when the host supplies it.
    get bounds() { return bounds?.() },
    get matrix() { return matrix() },
    toWorld: point => toBinding(graph.transform(name, toOriginal(point))),
    toWorldVector: vector => toBinding(originalRotateVector(graph.world(name), toOriginal(vector))),
    positionIn: referential => toBinding(graph.position(name, referential)),
    setPositionIn: (position, referential, keepChildren) => graph.setPosition(name, toOriginal(position), referential, keepChildren),
    setWorldMatrix: (value, keepChildren) => graph.setWorldMatrix(name, bindingMatrixToOriginal(value, coordinateScale), keepChildren),
    setParent: (parent, keepWorld) => { graph.setParent(name, parent, keepWorld) },
    setOrientation: (dir, up, right, referential, keepChildren) => graph.setOrientation(name, dir, up, right, referential, keepChildren),
    setScale: (scale, keepChildren) => graph.setScale(name, scale, keepChildren, true),
    addScale: (scale, keepChildren) => graph.addScale(name, scale, keepChildren),
    rotate: (axis, angle, referential, keepChildren) => graph.rotate(name, axis, angle, referential, keepChildren),
  }
}

/**
 * The entity as an authored referential frame for the physics bindings:
 * position and rotation in the binding's units, `matrix` the live world matrix
 * in original units.
 */
export function originalEntityFrame(graph: OriginalEntityGraph, name: string, coordinateScale = 1): GraphFrameBinding {
  const object = originalEntityObject(graph, name, coordinateScale)
  return { position: object.position, rotation: object.rotation, matrix: graph.world(name) }
}
