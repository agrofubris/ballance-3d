// 3DTransfo.dll Play Global Animation (declaration 0x25007620, creation
// 0x250076B0, execution 0x250077B0, curve interpolation helper 0x25007A20).
//
// The block steps a CKKeyedAnimation (class 18): each run adds DeltaTime /
// Duration to a normalised step, the Progression Curve shapes that step, and
// the keyed animation applies it to every sub-CKObjectAnimation's driven
// entity. The authored PE_Balloon grab uses TCB rotation keys and a one-key
// linear scale track; both are evaluated here. The rotation evaluation is the
// recovered CK2_3D quaternion track (`UfoRotationTrack`).
import {ck2dCurveGetY, composeLocalMatrix, evaluateLinearRotation, evaluateLinearVector,
  type OriginalAnimationController, type OriginalAnimationData, type Quat, type Vec3} from './original-graph-curve.ts'
import {UfoRotationTrack, type UfoRotationKey} from './original-ufo-animation.ts'
import {decodeOriginal2dCurve} from './original-2d-curve.ts'
import type {UfoCurvePoint} from './original-ufo-animation.ts'
import {originalInverseMatrix, originalMultiplyMatrix} from './original-matrix.ts'
import {CKCID, originalIsChildClassOf} from './original-context.ts'
import type {GraphContextBinding} from './original-graph-bindings.ts'
import type {BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue} from './original-graph.ts'

const f = Math.fround
const number = (value: GraphParameterValue): number => typeof value === 'number' ? value : Number(value ?? 0)
const bool = (value: GraphParameterValue): boolean => typeof value === 'boolean' ? value : Number(value ?? 0) !== 0

/** CK_3DENTITY_IGNOREANIMATION: SetStep returns without touching such an entity. */
const IGNORE_ANIMATION = 0x400
/** CKObjectAnimation track flags ([this+0x20]): rotation/scale disabled, merged animation. */
const ROTATION_OFF = 0x08, SCALE_OFF = 0x10, MERGED = 0x80

interface KeyedSubAnimation {
  name: string
  data: OriginalAnimationData
  /** TCB rotation keys (CK2_3D 0x10051040), when the controller is TCB. */
  tcbRotation?: UfoRotationTrack
  /** Linear rotation controller, when the controller is linear. */
  linearRotation?: OriginalAnimationController
  scale?: OriginalAnimationController
  position?: OriginalAnimationController
}

interface PlayGlobalAnimationState {
  metadata?: unknown
  subs?: KeyedSubAnimation[]
  curveRaw?: string
  curve?: UfoCurvePoint[]
  parents?: Map<string, string>
}

function loaderOf(context: BehaviorContext): GraphContextBinding {
  if (!context.loader) throw new Error(`${context.node.name} ${context.node.index} needs the CK object context`)
  return context.loader
}

/** TCB rotation controller (type 0x45B52A02): time, quaternion, tension, continuity, bias, ease. */
function tcbRotation(controller: OriginalAnimationController, animation: string): UfoRotationTrack {
  if (controller.track !== 'rotation' || controller.stride !== 10) {
    throw new Error(`CKObjectAnimation ${animation}: unsupported TCB ${controller.track} controller`)
  }
  const keys: UfoRotationKey[] = []
  for (let i = 0; i < controller.keys; i++) {
    const at = i * 10, d = controller.data
    const continuity = d[at + 6]!, bias = d[at + 7]!, easeTo = d[at + 8]!, easeFrom = d[at + 9]!
    if (continuity !== 0 || bias !== 0 || easeTo !== 0 || easeFrom !== 0) {
      throw new Error(`CKObjectAnimation ${animation}: TCB rotation key ${i} has continuity/bias/ease, which the recovered track does not evaluate`)
    }
    keys.push({time: d[at]!, rotation: [d[at + 1]!, d[at + 2]!, d[at + 3]!, d[at + 4]!], tension: d[at + 5]!})
  }
  return new UfoRotationTrack(keys)
}

/** The sub-animations of the input keyed animation, with their evaluated tracks. */
function subAnimations(context: BehaviorContext, state: PlayGlobalAnimationState): KeyedSubAnimation[] {
  const metadata = context.node.inputs?.[0]?.keyedAnimation
  if (!metadata) {
    throw new Error(`${context.node.name} ${context.node.index}: the Animation input is not an exported CKKeyedAnimation (re-export the graph)`)
  }
  if (state.metadata === metadata && state.subs) return state.subs
  const loader = loaderOf(context)
  const subs: KeyedSubAnimation[] = []
  for (const name of metadata.animations) {
    // The driven entity has the same name as its CKObjectAnimation, so resolve
    // the animation by class (CKContext::GetObjectByNameAndParentClass).
    const reference = loader.find(name, CKCID.OBJECTANIMATION)
    const animation = reference === undefined ? undefined : loader.animation(reference)
    if (!animation) throw new Error(`${context.node.name} ${context.node.index}: ${name} is not a CKObjectAnimation in the context`)
    const data: OriginalAnimationData = {...animation, name}
    if (data.flags & MERGED) throw new Error(`CKObjectAnimation ${name} is a merged animation, which is not decoded`)
    const sub: KeyedSubAnimation = {name, data}
    for (const controller of data.controllers) {
      if (!['position', 'rotation', 'scale'].includes(controller.track)) {
        throw new Error(`CKObjectAnimation ${name}: ${controller.track} controllers are not implemented`)
      }
      if (controller.track === 'rotation') {
        if (controller.interpolation === 'tcb') sub.tcbRotation = tcbRotation(controller, name)
        else if (controller.interpolation === 'linear') sub.linearRotation = controller
        else throw new Error(`CKObjectAnimation ${name}: ${controller.interpolation} rotation keys are not decoded`)
      } else if (controller.interpolation !== 'linear') {
        throw new Error(`CKObjectAnimation ${name}: ${controller.interpolation} ${controller.track} keys are not decoded`)
      } else if (controller.track === 'scale') {
        sub.scale = controller
      } else {
        sub.position = controller
      }
    }
    subs.push(sub)
  }
  state.metadata = metadata
  state.subs = subs
  return subs
}

/** The entity's saved child -> parent relation (the graph's exported scene hierarchy). */
function parentMap(context: BehaviorContext, state: PlayGlobalAnimationState): Map<string, string> {
  if (!state.parents) {
    const parents = new Map<string, string>()
    for (const [parent, children] of Object.entries(context.hierarchy ?? {})) {
      for (const child of children) parents.set(child, parent)
    }
    state.parents = parents
  }
  return state.parents
}

function localMatrix(loader: GraphContextBinding, entity: string, name: string, parents: Map<string, string>): number[] {
  const world = loader.matrix(entity)
  if (!world) throw new Error(`Play Global Animation: ${name} has no world matrix`)
  const parent = parents.get(name)
  if (parent === undefined) return [...world]
  // The driven entity and its CKObjectAnimation share a name, so look the
  // parent up by class instead of by unambiguous-name resolution.
  const parentReference = loader.find(parent, CKCID['3DENTITY'])
  const parentWorld = parentReference === undefined ? undefined : loader.matrix(parentReference)
  if (!parentWorld) throw new Error(`Play Global Animation: the parent ${parent} of ${name} has no world matrix`)
  const inverse = originalInverseMatrix(parentWorld)
  if (!inverse) throw new Error(`Play Global Animation: the parent ${parent} of ${name} has a singular world matrix`)
  return originalMultiplyMatrix(inverse, world)
}

/** A_CurveInterpolation (0x25007A20): local/output = step, then SetStep(curve->GetY(step)). */
function applyStep(context: BehaviorContext, state: PlayGlobalAnimationState, step: number): void {
  const loader = loaderOf(context)
  const curve = state.curve
  if (!curve) throw new Error(`${context.node.name} ${context.node.index} has no Progression Curve`)
  const y = ck2dCurveGetY(curve, step)
  const parents = parentMap(context, state)
  for (const sub of subAnimations(context, state)) {
    const entity = sub.data.entity
    if (loader.entityFlags(entity) & IGNORE_ANIMATION) continue
    const name = loader.objectName(entity) ?? entity
    if (sub.data.flags & (ROTATION_OFF | SCALE_OFF)) {
      throw new Error(`CKObjectAnimation ${sub.name}: a partial track set reads the entity's matrix back (0x1005695C), which is not recovered`)
    }
    if (!sub.scale) throw new Error(`CKObjectAnimation ${sub.name}: a written scale track needs its controller (partial track set is not recovered)`)
    const local = localMatrix(loader, entity, name, parents)
    const frame = f(y * sub.data.length)
    const position: Vec3 = sub.position
      ? evaluateLinearVector(sub.position, frame) ?? [local[12]!, local[13]!, local[14]!]
      : [local[12]!, local[13]!, local[14]!]
    const scaling = evaluateLinearVector(sub.scale, frame) ?? [1, 1, 1]
    let rotation: Quat
    if (sub.tcbRotation) rotation = sub.tcbRotation.sample(frame).toArray() as Quat
    else if (sub.linearRotation) rotation = evaluateLinearRotation(sub.linearRotation, frame) ?? [0, 0, 0, 1]
    else throw new Error(`CKObjectAnimation ${sub.name}: a written rotation track needs its controller (partial track set is not recovered)`)
    loader.setLocalMatrix(entity, composeLocalMatrix(position, scaling, rotation))
  }
}

/** The On branch for a keyed animation: characters are the only special case. */
function beginGlobal(context: BehaviorContext, state: PlayGlobalAnimationState): void {
  const loader = loaderOf(context)
  for (const sub of subAnimations(context, state)) {
    const classId = loader.classId(sub.data.entity)
    if (classId !== undefined && originalIsChildClassOf(classId, CKCID.BODYPART)) {
      throw new Error(`${context.node.name} ${context.node.index}: character body part ${sub.name} needs SetAutomaticProcess/SetWorldMatrix, which is not implemented`)
    }
  }
}

const playGlobalAnimation: BehaviorFn = (context, state_) => {
  const state = state_ as PlayGlobalAnimationState
  const duration = f(number(context.input(1)))
  // "Patch for intermediary version": an INT-typed Duration still arrives as a
  // number here; both paths end in the same millisecond value.
  if (!(duration >= f(0.001))) return
  const raw = context.inputRaw(2)
  if (!raw) throw new Error(`${context.node.name} ${context.node.index} has no exported Progression Curve`)
  if (state.curveRaw !== raw) { state.curveRaw = raw; state.curve = decodeOriginal2dCurve(raw) }
  const animation = context.inputObject(0)
  let step = f(number(context.local(0)))
  if (context.isInputActive(1)) { context.consumeInput(1); return }
  step = f(f(context.deltaMs) / duration + step)
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    step = 0
    beginGlobal(context, state)
  }
  const interpolate = (value: number) => {
    context.setLocal(0, value)
    context.setOutput(0, value)
    applyStep(context, state, value)
  }
  if (step > 1) {
    context.activate(0)
    if (bool(context.input(3))) step = f(step - Math.trunc(step))
    else {
      if (!animation) throw new Error(`${context.node.name} ${context.node.index}: One Loop Played with no Animation (CKBR_PARAMETERERROR)`)
      interpolate(1)
      return
    }
  }
  if (!animation) { context.wait(); return }
  interpolate(step)
  context.wait()
}

export const ANIMATION_BEHAVIORS: BehaviorRegistry = {
  'Play Global Animation': playGlobalAnimation,
}
