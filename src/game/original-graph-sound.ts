// Sounds.dll Volume / Pitch / Panning Control and TT_Gravity_RT.dll
// TT_GetSoundProperties / TT SpeedOMeter, decoded from the shipped DLLs (the
// reconstructed CKBuildingBlocks sources differ for the two TT blocks).
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import type { GraphObjectBinding, GraphSoundSettings } from './original-graph-bindings.ts'
import { CKCID } from './original-context.ts'

const f32 = Math.fround

function float(context: BehaviorContext, slot: number, what: string): number {
  const value: GraphParameterValue = context.input(slot)
  if (typeof value !== 'number') throw new Error(`${context.node.name} ${context.node.index} ${what} is not a number`)
  return f32(value)
}

// CKWaveSound::SetPitch (CK2.dll 0x24018F1E) and SetPan (0x24019743) pass the
// value to the sound manager's source (m_Source + 58h, vtable + 0BCh) only
// when a source exists; SetGain (0x240196D1) stores m_Gain (+ 8Ch) as is and
// then syncs the source volume. GetPitch (0x24018F62) / GetPan (0x2401978A)
// read the source back, so a set value is quantised before Get sees it.
//
// DX7SoundManager.dll's manager method (vtable + 0BCh = 0x24BC1E68 on the
// manager vtables 0x24BC4128 / 0x24BC4210) calls IDirectSoundBuffer:
//  - pitch: GetFormat (+ 14h) gives nSamplesPerSec (WAVEFORMATEX + 4); SetPitch
//    calls SetFrequency (+ 44h) with _ftol(rate * pitch) (MSVCRT 0x24BC314C);
//    GetPitch is GetFrequency (+ 20h) / rate (24BC1EA1-24BC1F45);
//  - pan: SetPan (+ 40h) gets the millibel mapping 0x24BC2949, GetPan (+ 1Ch)
//    maps back with 0x24BC2995 (24BC1ED5-24BC1F63);
//  - gain: SetVolume/GetVolume through 0x24BC28D5 / 0x24BC2907.
// No DirectSound frequency-range clamp or HRESULT check appears in the
// manager method. The millibel constants at 0x24BC4300 (0.0f), 0x24BC4314
// (1.0f), 0x24BC4308 (10.0), 0x24BC4310 (0.0005f) and 0x24BC42F8 (2000.0).
const MILLIBEL_SCALE = 0.0005000000237487257 // float 0x24BC4310
const MILLIBEL_SILENCE = -10000 // DirectSound pan/volume full attenuation

/** 0x24BC28D5: linear amplitude -> centibels, truncating log10(v) * 2000.0; v <= 0 is -10000. */
function linearToMillibels(value: number): number {
  if (!(value > 0)) return MILLIBEL_SILENCE
  return Math.trunc(Math.log10(value) * 2000)
}

/** 0x24BC2907: centibels -> linear amplitude, pow(10.0, mB * 0.0005f) in double, stored float32. */
function millibelsToLinear(millibels: number): number {
  if (millibels <= MILLIBEL_SILENCE) return 0
  if (millibels > 0) return 1
  return f32(Math.pow(10, millibels * MILLIBEL_SCALE))
}

/** 0x24BC2949: linear pan [-1, 1] -> DirectSound pan millibels. */
function panToMillibels(pan: number): number {
  if (pan === 0) return 0
  if (pan > 0) return -linearToMillibels(f32(1 - pan))
  return linearToMillibels(f32(pan + 1))
}

/** 0x24BC2995: DirectSound pan millibels -> linear pan, stored float32. */
function millibelsToPan(millibels: number): number {
  if (millibels > 0) return f32(1 - millibelsToLinear(-millibels))
  return f32(millibelsToLinear(millibels) - 1)
}

/** The source frequency a Pitch Control leaves behind, then GetPitch's frequency / rate. */
function pitchReadBack(pitch: number, state: Record<string, unknown>, what: string): number {
  // SetFrequency(0) is DSBFREQUENCY_ORIGINAL: the buffer's format rate, so
  // GetFrequency / rate is exactly 1.0; pitch 1 requests that same rate.
  if (pitch === 0 || pitch === 1) return 1
  const rate = state.sampleRate
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`${what} needs the wave's format sample rate, which the object export does not carry`)
  }
  const requested = Math.trunc(rate * pitch) >>> 0
  // SetFrequency(0) (DSBFREQUENCY_ORIGINAL) restores the format rate.
  return f32((requested === 0 ? rate : requested) / rate)
}

function soundControl(setter: 'gain' | 'pitch' | 'pan', what: string): BehaviorFn {
  return context => {
    context.consumeInput(0)
    context.activate(0)
    const sound = context.targetName()
    if (!sound) return
    const value = float(context, 0, what)
    const loader = context.loader
    if (loader?.has(sound)) {
      const state = loader.state(sound)
      // GetGain returns the stored float (0x2401972F); GetPitch / GetPan return
      // the source read-back, so the state keeps what a later getter sees.
      if (setter === 'gain') state.gain = value
      else if (setter === 'pitch') state.pitch = pitchReadBack(value, state, `Pitch Control ${context.node.index}`)
      else state.pan = millibelsToPan(panToMillibels(value))
    }
    context.audio?.[setter]?.(sound, value)
  }
}

/** Sounds.dll Volume Control (decl 0x25701A30, GUID 33613f21:776b185b, execution 0x25701C10): SetGain(Volume), default 1.0. */
export const volumeControl: BehaviorFn = soundControl('gain', 'Volume')
/** Sounds.dll Pitch Control (decl 0x257015E0, GUID 7b7c731e:175b27a3, execution 0x257017B0): SetPitch(Frequency). */
export const pitchControl: BehaviorFn = soundControl('pitch', 'Frequency')
/** Sounds.dll Panning Control (decl 0x25701800, GUID 6a5f17af:63480864, execution 0x257019D0): SetPan(Position), default 0.0. */
export const panningControl: BehaviorFn = soundControl('pan', 'Position')

/**
 * A context sound's GetGain (m_Gain), GetPitch and GetPan. A saved value or a
 * Pitch/Panning Control already holds the source read-back (soundControl).
 */
function contextSoundProperties(context: BehaviorContext, sound: string): GraphSoundSettings {
  const loader = context.loader!
  const classId = loader.classId(sound)
  if (classId !== CKCID.WAVESOUND) throw new Error(`TT_GetSoundProperties ${context.node.index} targets ${loader.objectName(sound)} (class ${classId}), not a wave sound`)
  const state = loader.state(sound)
  const { gain, pitch, pan } = state
  if (typeof gain !== 'number' || typeof pitch !== 'number' || typeof pan !== 'number') {
    throw new Error(`TT_GetSoundProperties ${context.node.index}: ${loader.objectName(sound)} has no saved gain, pitch and pan`)
  }
  return { gain, pitch, pan }
}

/**
 * TT_Gravity_RT.dll TT_GetSoundProperties (decl 0x10002DF0, creation 0x10002E70, GUID
 * 30fa6a70:3b3f728a, execution 0x10002F20). The DLL dereferences GetTarget()
 * without a NULL check, so a missing sound fails loudly here. It reads
 * GetGain, GetPitch, GetPan (in that order), writes outputs 0..2, then
 * ActivateInput(0, FALSE) and ActivateOutput(0, TRUE).
 */
export const ttGetSoundProperties: BehaviorFn = context => {
  const sound = context.targetName()
  if (!sound) throw new Error(`TT_GetSoundProperties ${context.node.index} has no wave sound target`)
  const properties = context.loader ? contextSoundProperties(context, sound) : context.audio?.properties?.(sound)
  if (!properties) throw new Error(`TT_GetSoundProperties ${context.node.index} needs an audio binding that knows ${sound}`)
  context.setOutput(0, f32(properties.gain))
  context.setOutput(1, f32(properties.pitch))
  context.setOutput(2, f32(properties.pan))
  context.consumeInput(0)
  context.activate(0)
}

/** Inverse of authoredVectorToBinding: a binding-unit position in original units. */
function bindingVectorToAuthored(vector: readonly number[], coordinateScale: number): [number, number, number] {
  if (coordinateScale === 1) return [vector[0]!, vector[1]!, vector[2]!]
  return [vector[0]! / coordinateScale, vector[1]! / coordinateScale, -vector[2]! / coordinateScale]
}

/**
 * TT_Gravity_RT.dll TT SpeedOMeter (decl 0x10006380, GUID 51bd5521:672c67bf,
 * execution 0x100064E0), disassembled; it differs from the reconstructed
 * SpeedOMeter.cpp:
 *  - no `delta <= 0 -> 1` guard: speed divides by the float delta as is;
 *  - no `range == 0` guard: the relative ratio is (speed-min)/(max-min) in
 *    IEEE arithmetic, then NaN -> 0 and clamp to [0, 1];
 *  - a NULL target returns 0xA004 (CKBR_OWNERERROR) before any activation.
 * Locals: 0 Last Position (vector), 1 Calculate relative speed? (bool),
 * 2 Loop-Framedelay? (int). Inputs (relative only): 0 Minimum Speed,
 * 1 Maximum Speed. Outputs: 0 Absolute Speed, 1 Relative Speed (relative only).
 * Order: output 0, optional output 1, SetLocal(0, pos), In off, Out on.
 * Single-precision stores (fstp dword) are modelled with Math.fround; x87
 * intermediates are carried in double (the control word is UNVERIFIED).
 */
export const ttSpeedOMeter: BehaviorFn = context => {
  const name = context.targetName()
  const entity: GraphObjectBinding | undefined = name ? context.object(name) : undefined
  if (!entity) throw new Error(`TT SpeedOMeter ${context.node.index} has no 3D entity target (CKBR_OWNERERROR)`)
  const relative = context.local(1) === true
  const frameDelay = context.local(2)
  if (typeof frameDelay !== 'number') throw new Error(`TT SpeedOMeter ${context.node.index} has no Loop-Framedelay setting`)
  let delta = f32(context.deltaMs)
  if (Math.trunc(frameDelay) > 1) delta = f32(Math.trunc(frameDelay) * delta)
  const last = context.local(0)
  if (!Array.isArray(last) || last.length < 3) throw new Error(`TT SpeedOMeter ${context.node.index} has no Last Position`)
  const position = bindingVectorToAuthored(entity.position, context.coordinateScale).map(f32) as [number, number, number]
  const dx = f32(position[0] - f32(Number(last[0])))
  const dy = f32(position[1] - f32(Number(last[1])))
  const dz = f32(position[2] - f32(Number(last[2])))
  // fld dz; fmul; fld dy; fmul; faddp; fld dx; fmul; faddp; fsqrt; * 1000; / delta
  const speed = f32(Math.sqrt(dz * dz + dy * dy + dx * dx) * 1000 / delta)
  context.setOutput(0, speed)
  if (relative) {
    const hasInputs = context.inputCount >= 2
    const hasOutput = context.outputCount >= 2
    if (hasInputs !== hasOutput) throw new Error(`TT SpeedOMeter ${context.node.index} has an inconsistent relative-speed pin layout`)
    // Sound.json's instance keeps the setting on without the extra pins: the
    // DLL's GetInput/SetOutputParameterValue calls then fail (-1) without effect.
    if (hasInputs) {
      const minimum = float(context, 0, 'Minimum Speed')
      const maximum = float(context, 1, 'Maximum Speed')
      const ratio = (speed - minimum) / (maximum - minimum) // the x87 register, not yet rounded
      let result = f32(ratio)
      if (ratio > 1) result = 1
      else if (ratio < 0 || Number.isNaN(ratio)) result = 0
      context.setOutput(1, result)
    }
  }
  context.setLocal(0, position)
  context.consumeInput(0)
  context.activate(0)
}

export const SOUND_BEHAVIORS: BehaviorRegistry = {
  'Volume Control': volumeControl,
  'Pitch Control': pitchControl,
  'Panning Control': panningControl,
  TT_GetSoundProperties: ttGetSoundProperties,
  'TT SpeedOMeter': ttSpeedOMeter,
}
