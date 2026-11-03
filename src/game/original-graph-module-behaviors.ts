import * as THREE from 'three'
import { OriginalProximity } from './original-proximity.ts'
import { originalBox, originalBoxesIntersect } from './original-box.ts'
import { ANIMATION_BEHAVIORS } from './original-graph-animation.ts'
import type { ProximitySettings } from './original-proximity.ts'
import type {
  BehaviorContext,
  BehaviorFn,
  BehaviorRegistry,
  GraphObjectBinding,
  GraphParameterValue,
} from './original-graph.ts'
import type { GraphPlanarParticleSettings } from './original-graph-bindings.ts'

const number = (value: GraphParameterValue): number => typeof value === 'number' ? value : Number(value ?? 0)
const bool = (value: GraphParameterValue): boolean => typeof value === 'boolean' ? value : number(value) !== 0
const color = (value: GraphParameterValue): [number, number, number, number] =>
  Array.isArray(value) && value.length >= 4
    ? [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])]
    : [0, 0, 0, 0]

function objectBinding(context: BehaviorContext, slot: number): GraphObjectBinding | undefined {
  const name = context.input(slot)
  return typeof name === 'string' ? context.object(name) : undefined
}

function objectPosition(context: BehaviorContext, slot: number): THREE.Vector3 | undefined {
  const object = objectBinding(context, slot)
  return object ? new THREE.Vector3(object.position[0], object.position[1], object.position[2]) : undefined
}

// TT_Toolbox_RT.dll TT Restore IC (declaration 0x1001CA60, creation 0x1001CB20,
// execution 0x1001CBC0). The DLL fires Out, resolves the behavior target (the
// script owner when none is authored), and if the context scene holds an
// initial state for it calls CKReadObjectState. The authored boolean input 0
// repeats that for every descendant (HierarchyParser) when the target is an
// entity of class 0x21..0x2B. Restoring is a binding concern because the
// initial state is the scene's saved state, see `GraphBinding.restoreInitial`.
const ttRestoreInitialCondition: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  context.restoreInitial(undefined, bool(context.input(0)))
}

// Narratives.dll Restore IC (declaration 0x256843E0, creation 0x25684470,
// execution 0x256844D0). The same scene initial-state restore for the target
// alone, without the children recursion.
const restoreInitialCondition: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  context.restoreInitial(undefined, false)
}

interface ProximityState {
  proximity?: OriginalProximity
  active?: boolean
}

// TT_Toolbox_RT.dll TT Scaleable Proximity (execution 0x1001BB70).
// Inputs: 0 distance, 1 object, 2 object, 3 barycenter, 4 exactness min,
// 5 exactness max, 6 min frame delay, 7 max frame delay.
// Locals: 0 transition sentinel, 1 polling countdown, 2 Use Outputs mask,
// 3 axes mask (X=1, Y=2, Z=4), 4 squared distance.
function proximitySettings(context: BehaviorContext): ProximitySettings {
  const settings: ProximitySettings = {
    distance: number(context.input(0)),
    axes: Math.trunc(number(context.local(3))),
    exactnessMin: number(context.input(4)),
    exactnessMax: number(context.input(5)),
    minFrameDelay: number(context.input(6)),
    maxFrameDelay: number(context.input(7)),
  }
  const squared = context.local(4)
  if (typeof squared === 'boolean') settings.squared = squared
  const outputs = context.local(2)
  if (typeof outputs === 'number') settings.outputFlags = Math.trunc(outputs)
  return settings
}

const PROXIMITY_BITS = [1, 2, 4, 8] as const

// The DLL only creates the outputs selected by Use Outputs and activates them
// in ascending bit order: InRange=1, OutRange=2, EnterRange=4, ExitRange=8.
function activateProximity(context: BehaviorContext, activation: number) {
  const outputs = context.local(2)
  const mask = typeof outputs === 'number' ? Math.trunc(outputs) : 15
  let slot = 0
  for (const bit of PROXIMITY_BITS) {
    if ((mask & bit) === 0) continue
    if ((activation & bit) !== 0) context.activate(slot)
    slot++
  }
}

const scaleableProximity: BehaviorFn = (context, state) => {
  const proximity = state as ProximityState
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    proximity.active = false
    return
  }
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    proximity.active = true
    // Restart resets only the transition sentinel; the countdown is kept.
    if (proximity.proximity) proximity.proximity.restart()
    else {
      proximity.proximity = new OriginalProximity(proximitySettings(context), context.coordinateScale)
      // Local 1 is the saved polling countdown. The ending assembly's outer
      // proximity is saved at its ten-frame minimum.
      const remaining = context.local(1)
      if (typeof remaining === 'number' && remaining >= 1) proximity.proximity.remaining = Math.trunc(remaining)
    }
  }
  if (!proximity.active || !proximity.proximity) return
  const first = objectPosition(context, 1)
  const second = objectPosition(context, 2)
  if (!first || !second) { context.wait(); return }
  const activation = proximity.proximity.sample(first, second)
  if (activation !== 0) activateProximity(context, activation)
  context.wait()
}

// TT_Gravity_RT.dll TT ProximityVolumeControl (execution 0x100031A0).
// Measures object 0 in object 1's local frame, squares the near/far inputs,
// maps the range to 1..0 and calls CKWaveSound::SetGain(input 4) with
// 0.02 * 50^t (0..1), 1 above, 0 below (gain helper 0x10003150).
export function originalProximityVolumeGain(value: number): number {
  if (value > 1) return 1
  if (value < 0) return 0
  return 0.02 * 50 ** value
}

function localDistanceSquared(observer: GraphObjectBinding, target: GraphObjectBinding): number {
  const point = new THREE.Vector3(
    target.position[0] - observer.position[0],
    target.position[1] - observer.position[1],
    target.position[2] - observer.position[2],
  )
  point.applyQuaternion(new THREE.Quaternion(
    observer.rotation[0], observer.rotation[1], observer.rotation[2], observer.rotation[3],
  ).invert())
  const scale = observer.scale
  point.set(point.x / (scale[0] || 1), point.y / (scale[1] || 1), point.z / (scale[2] || 1))
  return point.lengthSq()
}

interface VolumeState {
  active?: boolean
  gain?: number
}

const proximityVolumeControl: BehaviorFn = (context, state) => {
  const volume = state as VolumeState
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    volume.active = false
  } else if (context.isInputActive(0)) {
    context.consumeInput(0)
    volume.active = true
    context.activate(0)
  }
  const observer = objectBinding(context, 0)
  const target = objectBinding(context, 1)
  if (!observer || !target) return
  const near = number(context.input(2))
  const far = number(context.input(3))
  const distance = localDistanceSquared(observer, target)
  const nearSquared = near ** 2
  const farSquared = far ** 2
  const normalized = distance < farSquared
    ? distance > nearSquared
      ? farSquared > nearSquared ? 1 - (distance - nearSquared) / (farSquared - nearSquared) : 0
      : 1
    : 0
  volume.gain = originalProximityVolumeGain(normalized)
  // Input 4 is the live wave-sound object selected by the PlaySound script.
  const sound = context.input(4)
  if (volume.active && typeof sound === 'string') context.audio?.gain?.(sound, volume.gain)
  if (volume.active) context.wait()
  else context.activate(1)
}

// TT_ParticleSystems_RT.dll PlanarParticleSystem registers the shared
// GeneralParticleSystem prototype (creation 0x25084C50, execution 0x250853A0).
// Activation inputs are On=0, Off=1, Freeze=2; outputs Exit On=0, Exit Off=1,
// Exit Freeze=2. The authored inputs are the recovered GeneralParticleSystem
// settings (dump parameter names), so the effect binding receives them all in
// original units; it emits continuously and owns the per-frame particle clock.
export function originalPlanarParticleSettings(context: BehaviorContext): GraphPlanarParticleSettings {
  return {
    emissionDelayMs: number(context.input(0)),
    emissionDelayVarianceMs: number(context.input(1)),
    yawVariance: number(context.input(2)),
    pitchVariance: number(context.input(3)),
    speed: number(context.input(4)),
    speedVariance: number(context.input(5)),
    angularSpeed: number(context.input(6)),
    angularSpeedVariance: number(context.input(7)),
    lifespanMs: number(context.input(8)),
    lifespanVarianceMs: number(context.input(9)),
    maximumNumber: Math.max(0, Math.trunc(number(context.input(10)))),
    emission: Math.max(0, Math.trunc(number(context.input(11)))),
    emissionVariance: Math.max(0, Math.trunc(number(context.input(12)))),
    initialSize: number(context.input(13)),
    initialSizeVariance: number(context.input(14)),
    endingSize: number(context.input(15)),
    endingSizeVariance: number(context.input(16)),
    bounce: number(context.input(17)),
    bounceVariance: number(context.input(18)),
    weight: number(context.input(19)),
    weightVariance: number(context.input(20)),
    initialColor: color(context.input(23)),
    endingColor: color(context.input(25)),
    texture: typeof context.input(27) === 'string' ? String(context.input(27)) : '',
    initialTextureFrame: number(context.input(28)),
    textureSpeed: number(context.input(30)),
    textureFrameCount: Math.max(0, Math.trunc(number(context.input(32)))),
    textureLoop: bool(context.input(33)),
    realTimeMode: bool(context.input(34)),
    deltaTimeMs: number(context.input(35)),
  }
}

const planarParticleSystem: BehaviorFn = context => {
  const name = context.node.target ?? `#${context.node.index}`
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    if (context.effect?.planar) context.effect.planar(name, originalPlanarParticleSettings(context))
    else context.effect?.emit(name)
    context.activate(0)
    return
  }
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    if (context.effect?.stopPlanar) context.effect.stopPlanar(name)
    else context.effect?.stop(name)
    context.activate(1)
    return
  }
  if (context.isInputActive(2)) {
    context.consumeInput(2)
    context.effect?.freezePlanar?.(name, true)
    context.activate(2)
  }
}

// Lights.dll Set Light Color (declaration 0x25401000, creation 0x25401090,
// execution 0x25401110). The prototype declares one activation input (`In`),
// one activation output (`Out`) and one input parameter `Color` of CKColor type
// (GUID ee2fd457:913bbb7c) with the default `255,255,255,255`. Execution
// resolves the CKLight target, reads input 0 into a VxColor, calls
// CKLight::SetColor through vtable +0x1D4, then fires Out. The exporter decodes
// the serialized color, so linked and authored values arrive as RGBA; an
// unconnected input keeps the recovered white default.
const setLightColor: BehaviorFn = context => {
  const target = context.targetName()
  if (!target) throw new Error(`Set Light Color ${context.node.index} has no target`)
  const input = context.input(0)
  let rgba: [number, number, number, number]
  if (input === null) {
    rgba = [1, 1, 1, 1]
  } else if (Array.isArray(input) && input.length >= 3) {
    rgba = [Number(input[0]), Number(input[1]), Number(input[2]), Number(input[3] ?? 1)]
  } else {
    throw new Error(`Set Light Color ${context.node.index} input 0 is not a CKColor`)
  }
  if (!context.light) throw new Error(`Set Light Color ${context.node.index} has no light binding for ${target}`)
  context.light.setColor(target, rgba)
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

// Collisions.dll Collisions/Intersection Box Box Intersection (declaration
// 0x253056E0, creation 0x25305780, execution 0x25305850; image base 0x25300000).
// Inputs: Entity 0, Entity 1 (CKPGUID_3DENTITY), Hierarchy 0, Hierarchy 1
// (BOOL, default FALSE). Outputs: True 0, False 1.
//
// Execution gets the Collision Manager (GUID 38244712:0, NeedManager at
// 0x253187C0) and calls its vtable +0xAC (0x25312430). A NULL entity selects
// False. Otherwise the manager pairs each entity's world matrix (vtable +0x174,
// CK2_3D 0x100088F6) with its box: with Hierarchy FALSE `GetBoundingBox(TRUE)`
// (vtable +0x1C0, CK2_3D 0x10009144; the local mesh box at entity+0x14C, all
// zeros for a meshless entity), with Hierarchy TRUE the hierarchical box
// (vtable +0x1C8, CK2_3D 0x1000926B). It builds two VxOBBs through the helper at
// 0x253141E0 and calls VxIntersect::OBBOBB (VxMath.dll 0x24287830, import at
// Collisions.dll 0x2531A25C). Both authored Hierarchy inputs in the pack are
// FALSE; the hierarchy box itself is not decoded, so a TRUE input fails loudly.
const boxBoxIntersection: BehaviorFn = context => {
  const entityBox = (slot: number): { bounds: [number, number, number, number, number, number]; matrix: number[] } | null => {
    const value = context.input(slot)
    // GetInputParameterObject: a NULL entity input always takes False.
    if (value === null || value === undefined) return null
    if (typeof value !== 'string') throw new Error(`Box Box Intersection ${context.node.index} input ${slot} is not a 3D entity: ${JSON.stringify(value)}`)
    const binding = context.object(value)
    const bounds = binding?.bounds, matrix = binding?.matrix
    if (!bounds || !matrix) throw new Error(`Box Box Intersection ${context.node.index} input ${slot} (${value}) has no decoded box`)
    return { bounds: [...bounds], matrix: [...matrix] }
  }
  if (bool(context.input(2)) || bool(context.input(3))) {
    throw new Error(`Box Box Intersection ${context.node.index} uses a hierarchical box, which is not decoded`)
  }
  const a = entityBox(0), b = entityBox(1)
  let intersect = false
  if (a && b) {
    const box = (value: [number, number, number, number, number, number]) =>
      new THREE.Box3(new THREE.Vector3(value[0], value[1], value[2]), new THREE.Vector3(value[3], value[4], value[5]))
    const frame = (value: number[]) => new THREE.Matrix4().fromArray(value)
    intersect = originalBoxesIntersect(originalBox(box(a.bounds), frame(a.matrix)), originalBox(box(b.bounds), frame(b.matrix)))
  }
  context.consumeInput(context.inputSlot)
  context.activate(intersect ? 0 : 1)
}

// Logics.dll Row Search (declaration 0x25497E30, exec 0x25497FB0). Target:
// the CKDataArray. Inputs: 0 Column (int), 1 First Search Row (int), 2
// Operation (CK_COMPOPERATOR: Equal 1, Not Equal 2, Less 3, Less or Equal 4,
// Greater 5, Greater or Equal 6), 3 Reference Value (the column's type).
// Output 0 First Row Found (int); Found/Not Found. A NULL target returns
// CKBR_OWNERERROR (0xA004) without activating an output.
const rowSearch: BehaviorFn = context => {
  const rows = context.array()
  context.consumeInput(context.inputSlot)
  if (!rows) return
  const column = Math.trunc(number(context.input(0)))
  const start = Math.max(0, Math.trunc(number(context.input(1))))
  const operation = Math.trunc(number(context.input(2)))
  const reference = context.input(3)
  if (operation < 1 || operation > 6) throw new Error(`Row Search ${context.node.index} operation ${operation} is not a CK_COMPOPERATOR`)
  for (let row = start; row < rows.length; row++) {
    const value = rows[row]?.[column] ?? null
    let order: number
    if (typeof value === 'number' && typeof reference === 'number') order = value - reference
    else if (typeof value === 'string' && typeof reference === 'string') order = value < reference ? -1 : value > reference ? 1 : 0
    else if (typeof value === 'boolean' && typeof reference === 'boolean') order = Number(value) - Number(reference)
    else if (value === null && reference === null) order = 0
    else throw new Error(`Row Search ${context.node.index} cannot compare ${JSON.stringify(value)} with ${JSON.stringify(reference)}`)
    const match = operation === 1 ? order === 0 : operation === 2 ? order !== 0 : operation === 3 ? order < 0
      : operation === 4 ? order <= 0 : operation === 5 ? order > 0 : order >= 0
    if (match) {
      context.setOutput(0, row)
      context.activate(0)
      return
    }
  }
  context.activate(1)
}

/** Behaviors used by the gameplay module graphs that are not in the physics,
 * effect or script registries. */
export const MODULE_BEHAVIORS: BehaviorRegistry = {
  ...ANIMATION_BEHAVIORS,
  'Box Box Intersection': boxBoxIntersection,
  'Row Search': rowSearch,
  'TT Restore IC': ttRestoreInitialCondition,
  'Restore IC': restoreInitialCondition,
  'TT Scaleable Proximity': scaleableProximity,
  'TT ProximityVolumeControl': proximityVolumeControl,
  PlanarParticleSystem: planarParticleSystem,
  'Set Light Color': setLightColor,
}
