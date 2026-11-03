import * as THREE from 'three'
import { ufoCurve } from './original-ufo-animation.ts'
import type { UfoCurvePoint } from './original-ufo-animation.ts'
import { decodeOriginal2dCurve } from './original-2d-curve.ts'
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import { authoredMatrixToBinding } from './original-graph-bindings.ts'
import { CKCID } from './original-context.ts'

const number = (value: GraphParameterValue) => typeof value === 'number' ? value : Number(value ?? 0)

function vector(value: GraphParameterValue, length: number): number[] | undefined {
  return Array.isArray(value) && value.length >= length ? value.slice(0, length).map(Number) : undefined
}

const timer: BehaviorFn = context => {
  let elapsed = number(context.output(0))
  if (context.isInputActive(0)) { context.consumeInput(0); elapsed = 0 }
  if (context.isInputActive(1)) context.consumeInput(1)
  elapsed += context.deltaMs
  context.setOutput(0, elapsed)
  if (elapsed >= number(context.input(0))) context.activate(0)
  else context.activate(1)
}

// Logics BezierProgression.cpp (time based, version 0x10005): In restarts the
// clock and sets the previous value to the curve's start; every run then adds
// DeltaTime, samples the authored Progression Curve (CK2dCurve::GetY) and fires
// Out once the clock has passed the duration, Loop Out otherwise. Elapsed time,
// progression, value and delta are float locals.
const bezierProgression: BehaviorFn = (context, state) => {
  const raw = context.inputRaw(3)
  if (!raw) throw new Error(`Bezier Progression ${context.node.index} has no exported Progression Curve`)
  if (state.raw !== raw) { state.raw = raw; state.curve = decodeOriginal2dCurve(raw) }
  const curve = state.curve as UfoCurvePoint[]
  const f = Math.fround
  const duration = f(number(context.input(0)))
  const A = f(number(context.input(1)))
  const B = f(number(context.input(2)))
  const sample = (progression: number) => f(A + f(f(B - A) * f(ufoCurve(curve, progression))))
  let elapsed: number
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    elapsed = 0
    context.setOutput(1, sample(0))
    context.setOutput(2, 0)
    context.setOutput(3, 0)
  } else {
    context.consumeInput(1)
    elapsed = number(context.output(0))
  }
  // The Time Based setting (local 0) counts milliseconds; otherwise frames.
  elapsed = context.local(0) === false ? elapsed + 1 : f(elapsed + f(context.deltaMs))
  context.setOutput(0, elapsed)
  const progression = Math.min(1, f(elapsed / duration))
  const value = sample(progression)
  const previous = number(context.output(1))
  context.setOutput(1, value)
  context.setOutput(2, f(value - previous))
  context.setOutput(3, progression)
  if (elapsed > duration) context.activate(0)
  else context.activate(1)
}

const exit: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.script('__exit__', true)
  context.activate(0)
}

/**
 * 3DTrans SetWorldMatrix.cpp: In off and Out, then (with a target)
 * SetWorldMatrix(World Matrix, KeepChildren = !Hierarchy). Bindings without a
 * hierarchy take the matrix's position, rotation and scale instead.
 */
function setWorldMatrix(context: BehaviorContext) {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  const object = context.object()
  const matrix = context.input(0)
  if (!object) return
  if (Array.isArray(matrix) && matrix.length >= 16) {
    const converted = authoredMatrixToBinding(matrix.map(Number), context.coordinateScale)
    if (object.setWorldMatrix) {
      const hierarchy = context.input(1)
      object.setWorldMatrix(converted, hierarchy === null ? false : hierarchy !== true)
      return
    }
    const transform = new THREE.Matrix4().fromArray(converted)
    const position = new THREE.Vector3()
    const rotation = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    transform.decompose(position, rotation, scale)
    object.position = position.toArray() as [number, number, number]
    object.rotation = rotation.toArray() as [number, number, number, number]
    object.scale = scale.toArray() as [number, number, number]
  } else {
    const position = vector(matrix, 3)
    const rotation = vector(context.input(1), 4)
    const scale = vector(context.input(2), 3)
    if (position) object.position = [position[0]!, position[1]!, position[2]!]
    if (rotation) object.rotation = [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!]
    if (scale) object.scale = [scale[0]!, scale[1]!, scale[2]!]
  }
}

/** A colour input as VxColor floats, with the block's default for a missing pin. */
function vxColor(value: GraphParameterValue, fallback: number[]): number[] {
  return Array.isArray(value) && value.length >= 4 ? value.slice(0, 4).map(component => Math.fround(Number(component))) : fallback
}

/** The target CKMaterial's state over the CK context; undefined for a NULL target (CKBR_OWNERERROR). */
function contextMaterial(context: BehaviorContext): Record<string, unknown> | undefined {
  const loader = context.loader!
  const target = context.targetName()
  if (!target || !loader.has(target)) return undefined
  if (loader.classId(target) !== CKCID.MATERIAL) throw new Error(`${context.node.name} ${context.node.index} targets ${loader.objectName(target)}, not a material`)
  return loader.state(target)
}

/**
 * Materials.dll Set Diffuse (exec 0x25501C00) over the CK context: a NULL
 * target fires nothing; the colour (default 1,1,1,1) keeps the material's
 * current alpha with Keep Alpha; SetDiffuse, then In off and Out. Behaviors
 * saved before version 0x20000 also switch alpha blending; every authored one
 * is 0x20000.
 */
const setDiffuse: BehaviorFn = context => {
  const color = context.input(0)
  if (context.loader) {
    if ((context.node.version ?? 0) < 0x20000) throw new Error(`Set Diffuse ${context.node.index} is a pre-0x20000 behavior, whose blend switch is not ported`)
    const state = contextMaterial(context)
    if (!state) return
    const diffuse = vxColor(color, [1, 1, 1, 1])
    if (context.input(1) === true) {
      const current = state.diffuse as number[] | undefined
      if (!current) throw new Error(`Set Diffuse ${context.node.index} keeps an alpha the context does not hold (the authored diffuse is not loaded)`)
      diffuse[3] = current[3]!
    }
    state.diffuse = diffuse
    context.consumeInput(context.inputSlot)
    context.activate(0)
    return
  }
  if (context.effect && Array.isArray(color)) {
    const rgba: [number, number, number, number] = [
      Number(color[0] ?? 0),
      Number(color[1] ?? 0),
      Number(color[2] ?? 0),
      Number(color[3] ?? 1),
    ]
    context.effect.setDiffuse(context.targetName(), rgba)
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

// Materials-Textures SetEmissive.cpp: the target material's emissive colour.
const setEmissive: BehaviorFn = context => {
  const color = context.input(0)
  // Materials.dll exec 0x25501E30 over the CK context: In off and Out first, then a NULL target
  // does nothing (CKBR_OWNERERROR); SetEmissive(colour, default 0,0,0,1).
  if (context.loader) {
    context.consumeInput(context.inputSlot)
    context.activate(0)
    const state = contextMaterial(context)
    if (state) state.emissive = vxColor(color, [0, 0, 0, 1])
    return
  }
  if (context.effect && Array.isArray(color)) {
    if (!context.effect.setEmissive) throw new Error(`Set Emissive ${context.node.index} has no material binding`)
    context.effect.setEmissive(context.targetName(), [Number(color[0] ?? 0), Number(color[1] ?? 0), Number(color[2] ?? 0), Number(color[3] ?? 1)])
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

/** CKPGUID_VOIDBUF, the type GUID of a saved buffer parameter. */
const VOIDBUF_GUID = '902c084da239830c'

/** The VxUV array a saved VOIDBUF parameter holds (byte count at 28, data at 32). */
export function decodeSavedUVs(hex: string): Float32Array {
  const bytes = new Uint8Array(hex.match(/../g)?.map(byte => parseInt(byte, 16)) ?? [])
  const view = new DataView(bytes.buffer)
  const guid = [...bytes.subarray(16, 24)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const size = bytes.length >= 32 ? view.getUint32(28, true) : -1
  if (guid !== VOIDBUF_GUID || size % 8 !== 0 || bytes.length < 32 + size) throw new Error('Parameter is not a saved VxUV buffer')
  const uvs = new Float32Array(size / 4)
  for (let i = 0; i < uvs.length; i++) uvs[i] = view.getFloat32(32 + i * 4, true)
  return uvs
}

// TT_Gravity_RT TextureSine.cpp: each vertex's UV moves toward or away from
// the texture centre by `amplitude · cos/sin(t)`, with t = (i/n − ½)·4 +
// time·velocity. The base UVs are the ones saved when the behavior was
// attached (local 0), not the mesh's current UVs; the clock (local 1) advances
// by DeltaTime in seconds and wraps after a full period.
const textureSine: BehaviorFn = (context, state) => {
  const effect = context.effect
  if (effect) {
    const input = (slot: number, fallback: number) => { const value = context.input(slot); return typeof value === 'number' ? value : fallback }
    const xamp = input(0, 0.1), yamp = input(1, 0.1), velocity = input(2, 1), channel = input(3, -1)
    if (channel !== -1) throw new Error(`TT_TextureSine ${context.node.index} channel ${channel} is not implemented`)
    const mesh = effect.meshUVs?.(context.targetName())
    if (!mesh) throw new Error(`TT_TextureSine ${context.node.index} mesh ${context.targetName()} is not bound`)
    if (!state.saved) {
      const raw = context.localRaw(0)
      if (!raw) throw new Error(`TT_TextureSine ${context.node.index} has no saved UVs`)
      state.saved = decodeSavedUVs(raw)
    }
    const saved = state.saved as Float32Array
    const count = mesh.uvs.length / 2
    if (saved.length !== mesh.uvs.length) throw new Error(`TT_TextureSine ${context.node.index} saved ${saved.length / 2} UVs for ${count} vertices`)
    let time = number(context.local(1))
    for (let i = 0; i < count; i++) {
      const t = Math.fround(Math.fround(i / count - 0.5) * 4 + Math.fround(time * velocity))
      const u = saved[i * 2]!, v = saved[i * 2 + 1]!
      mesh.uvs[i * 2] = u + (0.5 - u) * xamp * Math.cos(t)
      mesh.uvs[i * 2 + 1] = v + (0.5 - v) * yamp * Math.sin(t)
    }
    mesh.commit()
    time = Math.fround(time + context.deltaMs * 0.001)
    // 0x10006A75: the wrap tests time·velocity > 2π (a negative product never wraps).
    if (velocity !== 0 && time * velocity > 2 * Math.PI) time = Math.fround(time - 2 * Math.PI / velocity)
    context.setLocal(1, time)
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

const setTexture: BehaviorFn = context => {
  const texture = context.input(0)
  if (context.effect && typeof texture === 'string') {
    context.effect.setTexture(context.node.target ?? '', texture)
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

const playSoundInstance: BehaviorFn = context => {
  const input = context.input(0)
  const loop = typeof input === 'boolean' ? input : false
  const inputVolume = context.input(5)
  const volume = typeof inputVolume === 'number' ? inputVolume : 1
  context.audio?.play(context.node.target ?? '', { loop, volume })
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

const wavePlayer: BehaviorFn = (context, state) => {
  const name = context.targetName()
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    // The target and loop flag can be live parameters; resolve both now.
    const loop = context.input(2) === true
    context.audio?.play(name, { loop })
    context.activate(0)
    // Sounds.dll Wave Player stays active while CKWaveSound::IsPlaying and
    // fires End Playing when it stops.
    if (context.audio?.playing?.(name) !== undefined) {
      state.playing = true
      state.timed = false
    } else if (!loop && context.loader?.has(name)) {
      // A sink without IsPlaying (the headless graph runtime): the authored
      // CKWaveSound duration stands in for the media clock.
      const duration = Number(context.loader.state(name).duration)
      if (Number.isFinite(duration) && duration >= 0) {
        state.playing = false
        state.timed = true
        state.elapsed = 0
        state.duration = duration
      }
    }
  }
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.audio?.stop(name)
    state.playing = false
    state.timed = false
    context.activate(1)
  }
  if (state.playing) {
    const live = context.audio?.playing?.(name)
    if (live === undefined) state.playing = false
    else if (live) context.wait()
    else {
      state.playing = false
      context.activate(1)
    }
  } else if (state.timed) {
    const elapsed = Number(state.elapsed ?? 0) + context.deltaMs
    if (elapsed >= Number(state.duration)) {
      state.timed = false
      context.activate(1)
    } else {
      state.elapsed = elapsed
      context.wait()
    }
  }
  context.consumeInput(context.inputSlot)
}

/** Recovered-effect and audio behaviors. Engine access is optional so the
 * runtime can still execute graphs before their bindings are supplied. */
export const EFFECT_BEHAVIORS: BehaviorRegistry = {
  Timer: timer,
  'Bezier Progression': bezierProgression,
  Exit: exit,
  'Set World Matrix': setWorldMatrix,
  'Set Diffuse': setDiffuse,
  'Set Emissive': setEmissive,
  TT_TextureSine: textureSine,
  'Set Texture': setTexture,
  'Play Sound Instance': playSoundInstance,
  'Wave Player': wavePlayer,
}
