import * as THREE from 'three'
import { originalArrayChanged } from './original-graph-array.ts'
import type { BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import { TEXT_CONTEXT_BEHAVIORS } from './original-graph-text.ts'

// Behaviors used by the authored Gameplay_Tutorial script. Their presentation
// (2D text, fonts, loaded strings) and time controls go through the
// GraphTutorialBinding supplied by the tutorial host; without a host they are
// inert and keep the authored activation flow.

const number = (value: GraphParameterValue) => typeof value === 'number' ? value : Number(value ?? 0)
const numbers = (value: GraphParameterValue) => Array.isArray(value) ? value.map(Number) : undefined

// Interface.dll `Set Font Properties` input order, as read from its declaration:
// 0 Font, 1 Space, 2 Scale, 3 Angle, 4 Color, 5 End Color, 6 Shadow Color,
// 7 Shadow Angle, 8 Shadow Distance, 9 Shadow Scale, 10 Material.
const setFontProperties: BehaviorFn = (context, state) => {
  if (context.loader) return TEXT_CONTEXT_BEHAVIORS['Set Font Properties'](context, state)
  const font = context.input(0)
  if (typeof font === 'string') {
    context.tutorial?.setFont(font, {
      space: numbers(context.input(1)),
      scale: numbers(context.input(2)),
      angle: number(context.input(3)),
      color: numbers(context.input(4)),
      shadowColor: numbers(context.input(6)),
      shadowDistance: number(context.input(8)),
    })
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

// TT_Toolbox_RT.dll TT CreateFontEx: the font is identified by its authored name.
const createFontEx: BehaviorFn = (context, state) => {
  if (context.loader) return TEXT_CONTEXT_BEHAVIORS['TT CreateFontEx'](context, state)
  const name = context.input(0)
  if (typeof name !== 'string' || name === '') throw new Error('TT CreateFontEx has no font name')
  context.tutorial?.createFont(name)
  context.setOutput(0, name)
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

// Interface.dll `2D Text` (execution 0x253868E0): the Off input fires Exit Off
// and the On input fires Exit On immediately; there is no fit test in the DLL.
const text2D: BehaviorFn = (context, state) => {
  if (context.loader) return TEXT_CONTEXT_BEHAVIORS['2D Text'](context, state)
  const entity = context.targetName()
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.tutorial?.hideText(entity)
    context.activate(1)
  }
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.tutorial?.showText(entity, String(context.input(0) ?? ''), String(context.input(1) ?? ''))
    context.activate(0)
  }
}

// TT_Toolbox_RT.dll TT_SplitString: output 0 is the part count, outputs 1..n the parts.
const splitString: BehaviorFn = context => {
  const delimiter = String(context.input(1) ?? '')
  if (delimiter === '') throw new Error('TT_SplitString has no delimiter')
  const parts = String(context.input(0) ?? '').split(delimiter)
  const slots = context.outputCount - 1
  if (parts.length > slots) throw new Error(`TT_SplitString produced ${parts.length} parts for ${slots} outputs`)
  context.setOutput(0, parts.length)
  for (let i = 0; i < slots; i++) context.setOutput(i + 1, parts[i] ?? '')
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

// Logics.dll `Get Row`: Found (output 0) copies the row's cells to the outputs.
const getRow: BehaviorFn = context => {
  const row = context.array()?.[Math.trunc(number(context.input(0)))]
  context.consumeInput(context.inputSlot)
  if (!row) { context.activate(1); return }
  for (let i = 0; i < context.outputCount; i++) context.setOutput(i, row[i] ?? null)
  context.activate(0)
}

// Logics.dll `Set Row`: writes inputs 1..n into the row named by input 0.
const setRow: BehaviorFn = context => {
  const row = context.array()?.[Math.trunc(number(context.input(0)))]
  context.consumeInput(context.inputSlot)
  if (!row) { context.activate(1); return }
  if (row.length !== context.inputCount - 1) throw new Error(`Set Row writes ${context.inputCount - 1} cells into a ${row.length}-cell row`)
  for (let i = 1; i < context.inputCount; i++) row[i - 1] = context.input(i)
  originalArrayChanged(context.array()!)
  context.activate(0)
}

// Logics.dll `Load String`: Out carries the file's text, File Error (output 1) a missing file.
const loadString: BehaviorFn = context => {
  const text = context.tutorial?.loadString(String(context.input(0) ?? ''))
  context.consumeInput(context.inputSlot)
  if (text === undefined) { context.activate(1); return }
  context.setOutput(0, text)
  context.activate(0)
}

// `Set Current Slot` selects a frame of the HUD life-ball sprite. The React HUD
// owns that sprite and already shows the lives, so the tutorial host has no
// texture state to change.
const setCurrentSlot: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

// physics_RT.dll `Set Physics Globals`: input 0 gravity, input 1 time factor.
const setPhysicsGlobals: BehaviorFn = context => {
  const gravity = numbers(context.input(0))
  if (gravity) context.tutorial?.setGlobals(gravity, number(context.input(1)))
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

// The tutorial scene is built with S * M * S^-1, S = (s, s, -s). The DLL works
// in original space, so vectors and rotations are converted there and back.
const sceneMatrix = (scale: number) => new THREE.Matrix4().makeScale(scale, scale, -scale)
const sceneInverse = (scale: number) => new THREE.Matrix4().makeScale(1 / scale, 1 / scale, -1 / scale)

function renderPointToOriginal(point: readonly number[], scale: number, out: THREE.Vector3): THREE.Vector3 {
  const inverse = sceneInverse(scale)
  return out.set(point[0]!, point[1]!, point[2]!).applyMatrix4(inverse)
}

function renderQuaternionToOriginal(quaternion: readonly number[], scale: number): THREE.Quaternion {
  const rotation = new THREE.Matrix4().makeRotationFromQuaternion(
    new THREE.Quaternion(quaternion[0]!, quaternion[1]!, quaternion[2]!, quaternion[3]!),
  )
  // Render = S * Original * S^-1, so Original = S^-1 * Render * S.
  const converted = sceneInverse(scale).multiply(rotation).multiply(sceneMatrix(scale))
  return new THREE.Quaternion().setFromRotationMatrix(converted).normalize()
}

function originalQuaternionToRender(quaternion: THREE.Quaternion, scale: number): THREE.Quaternion {
  const rotation = new THREE.Matrix4().makeRotationFromQuaternion(quaternion)
  const converted = sceneMatrix(scale).multiply(rotation).multiply(sceneInverse(scale))
  return new THREE.Quaternion().setFromRotationMatrix(converted).normalize()
}

/** The local axis the authored Direction selects: 1/2 X, 3/4 Y, 5/6 Z. */
function lookAxis(direction: number): THREE.Vector3 | undefined {
  if (direction === 1 || direction === 2) return new THREE.Vector3(1, 0, 0)
  if (direction === 3 || direction === 4) return new THREE.Vector3(0, 1, 0)
  if (direction === 5 || direction === 6) return new THREE.Vector3(0, 0, 1)
  return undefined
}

/**
 * TT_Toolbox_RT.dll `TT LookAt`, recovered from execution 0x10010E00 and its
 * core 0x10011190. It interpolates the target's selected axis toward the aim
 * point by Following Speed, rebuilds a right-handed basis around that axis and
 * calls SetOrientation; Roll then rotates around the selected local axis.
 */
const lookAt: BehaviorFn = context => {
  const target = context.object()
  if (!target) throw new Error(`TT LookAt target ${context.targetName()} is not in the scene`)
  const scale = context.coordinateScale
  const position = context.input(0)
  const aim = renderPointToOriginal(
    Array.isArray(position) ? position : [0, 0, 0],
    scale,
    new THREE.Vector3(),
  )
  const referential = context.input(1)
  if (typeof referential === 'string') {
    const reference = context.object(referential)
    // The authored `InGameCam` / `Referential` names may be absent; the DLL
    // then gets a null referential and treats Position as world coordinates.
    if (reference) {
      const matrix = new THREE.Matrix4().compose(
        renderPointToOriginal(reference.position, scale, new THREE.Vector3()),
        renderQuaternionToOriginal(reference.rotation, scale),
        new THREE.Vector3(reference.scale[0]!, reference.scale[1]!, reference.scale[2]!),
      )
      aim.applyMatrix4(matrix)
    }
  }
  const targetPosition = renderPointToOriginal(target.position, scale, new THREE.Vector3())
  const delta = aim.sub(targetPosition)
  // The DLL skips the rotation only when the raw delta is zero; the axis locks
  // are applied afterwards and can still leave a zero vector for the core.
  if (delta.lengthSq() === 0) {
    context.consumeInput(context.inputSlot)
    context.activate(0)
    return
  }
  if (context.input(4)) delta.x = 0
  if (context.input(5)) delta.y = 0
  if (context.input(6)) delta.z = 0
  if (delta.lengthSq() > 0) delta.normalize()
  const direction = Math.trunc(number(context.local(1)))
  if (direction % 2 === 0) delta.negate()
  const axis = lookAxis(direction)
  if (!axis) {
    context.consumeInput(context.inputSlot)
    context.activate(0)
    return
  }

  let speed = number(context.input(2))
  if (context.local(0)) speed *= context.deltaMs * 0.07
  if (speed > 1) speed = 1

  const targetQuaternion = renderQuaternionToOriginal(target.rotation, scale)
  const current = axis.clone().applyQuaternion(targetQuaternion)
  const look = current.clone().add(delta.clone().sub(current).multiplyScalar(speed))
  if (look.lengthSq() === 0) {
    context.consumeInput(context.inputSlot)
    context.activate(0)
    return
  }
  look.normalize()
  const worldUp = new THREE.Vector3(0, 1, 0)
  let right: THREE.Vector3
  let up: THREE.Vector3
  let dir: THREE.Vector3
  if (direction === 1 || direction === 2) {
    right = look.clone()
    const cross = look.clone().cross(worldUp).normalize()
    dir = cross.clone()
    up = cross.clone().cross(look).normalize()
  } else if (direction === 3 || direction === 4) {
    up = look.clone()
    const cross = look.clone().cross(worldUp).normalize()
    dir = cross.clone()
    right = look.clone().cross(cross).normalize()
  } else {
    dir = look.clone()
    const cross = worldUp.clone().cross(look).normalize()
    right = cross.clone()
    up = look.clone().cross(cross).normalize()
  }
  if (right.lengthSq() === 0 || up.lengthSq() === 0 || dir.lengthSq() === 0) {
    context.consumeInput(context.inputSlot)
    context.activate(0)
    return
  }
  const roll = number(context.local(2))
  if (target.setOrientation) {
    if (roll !== 0) throw new Error(`TT LookAt roll ${roll} on ${context.targetName()} is not decoded`)
    target.setOrientation(
      dir.toArray() as [number, number, number],
      up.toArray() as [number, number, number],
      right.toArray() as [number, number, number],
      undefined,
      false,
    )
  } else {
    const orientation = new THREE.Matrix4().makeBasis(right, up, dir)
    const result = new THREE.Quaternion().setFromRotationMatrix(orientation).normalize()
    if (roll !== 0) result.multiply(new THREE.Quaternion().setFromAxisAngle(axis, roll))
    const rendered = originalQuaternionToRender(result, scale)
    target.rotation = [rendered.x, rendered.y, rendered.z, rendered.w]
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

export const TUTORIAL_BEHAVIORS: BehaviorRegistry = {
  'Set Font Properties': setFontProperties,
  'TT CreateFontEx': createFontEx,
  '2D Text': text2D,
  TT_SplitString: splitString,
  'Get Row': getRow,
  'Set Row': setRow,
  'Load String': loadString,
  'Set Current Slot': setCurrentSlot,
  'Set Physics Globals': setPhysicsGlobals,
  'TT LookAt': lookAt,
}
