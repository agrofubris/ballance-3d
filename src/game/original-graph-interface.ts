// TT_Toolbox_RT.dll TT Set_2DSprite and TT ConvertPixel-Homogen over the 2D
// entities' context state (original-2d-entity.ts), and Interface.dll
// `Text Display` over the CK object context, decoded from the
// shipped DLL (declaration 0x25385B70, execution 0x25385D90, callback
// 0x25386080). Its CKSpriteText is a context object created when the behavior
// loads and kept in local 0; the block writes the sprite's CK state:
//
// CKSpriteText: visible, clipToCamera, width, height (Create), position
//               (pixels, SetPosition non-homogeneous), textColor (ARGB dword),
//               align (CKSPRITETEXT_ALIGNMENT), font { face, size, weight,
//               italic, underline }, text (undefined until SetText)
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, BehaviorState, GraphParameterValue } from './original-graph.ts'
import type { GraphContextBinding } from './original-graph-bindings.ts'
import { CKCID, originalIsChildClassOf } from './original-context.ts'
import {
  original2dHomogeneousPosition,
  original2dHomogeneousSize,
  original2dSetHomogeneousCoordinates,
  original2dSetHomogeneousRect,
  type Original2dRect,
  type Original2dScreen,
  type Original2dState,
} from './original-2d-entity.ts'
import { originalColorFromFloats } from './original-color.ts'

const TYPE_STRING = 'e210d06bea175611'
const TYPE_INT = 'fd16575ad776e244'

function loaderOf(context: BehaviorContext): GraphContextBinding {
  if (!context.loader) throw new Error(`${context.node.name} ${context.node.index} needs the CK object context`)
  return context.loader
}

function floats(value: GraphParameterValue, count: number, what: string): number[] {
  if (!Array.isArray(value) || value.length < count) throw new Error(`${what} is not a ${count}-float value`)
  return value.slice(0, count).map(Number)
}

/** tdFontInfo as saved in local 1 (VOIDBUF, 64 bytes): face[56], weight, style (1 italic, 2 underline). */
export function decodeTextDisplayFont(raw: string): { face: string; weight: number; style: number } {
  const bytes = new Uint8Array(raw.match(/../g)?.map(byte => parseInt(byte, 16)) ?? [])
  if (bytes.length < 64) throw new Error('Text Display font info is truncated')
  const data = bytes.subarray(bytes.length - 64)
  const view = new DataView(data.buffer, data.byteOffset, 64)
  const end = data.indexOf(0)
  return { face: String.fromCharCode(...data.subarray(0, end < 0 || end > 56 ? 56 : end)), weight: view.getUint32(56, true), style: view.getUint32(60, true) }
}

/** CKParameter::GetStringValue for the types the exported Text Display instances feed. */
function parameterString(context: BehaviorContext, slot: number): string {
  const value = context.input(slot)
  const type = context.inputType(slot)
  if (type === TYPE_STRING) return typeof value === 'string' ? value : ''
  if (type === TYPE_INT && typeof value === 'number') return String(Math.trunc(value))
  // Other types print through their registered string function (UNVERIFIED formats).
  throw new Error(`Text Display ${context.node.index} input ${slot} has type ${type}, whose string form is not decoded`)
}

/** The sprite local 0 holds (created at load). */
function sprite(context: BehaviorContext): string {
  const reference = context.local(0)
  if (typeof reference !== 'string' || !loaderOf(context).has(reference)) throw new Error(`Text Display ${context.node.index} has no sprite text`)
  return reference
}

/**
 * CKM_BEHAVIORLOAD: `CreateObject(CKCID_SPRITETEXT, "TextDisplay Sprite")`,
 * `EnableClipToCamera(FALSE)`, `Create(w, h, 32)` from the Sprite Size
 * setting (local 4), hidden, kept in local 0. Hosts without a context have
 * no sprite to create; the block then fails loudly if it runs.
 */
export const textDisplayLoad = (context: BehaviorContext): void => {
  const loader = context.loader
  if (!loader) return
  const [w, h] = floats(context.local(4), 2, `Text Display ${context.node.index} Sprite Size`)
  const reference = loader.create(CKCID.SPRITETEXT, 'TextDisplay Sprite', false)
  Object.assign(loader.state(reference), { visible: false, clipToCamera: false, width: Math.trunc(w!), height: Math.trunc(h!) })
  context.setLocal(0, reference)
}

/**
 * On (0) shows the sprite and forces a redraw; Off (1) hides it and ends.
 * Inputs: 0 Offset (pixels), 1 Color (VxColor floats), 2 Alignment, 3 Size,
 * 4.. any parameters, each printed followed by one space (empty strings
 * skipped). Every run sets the position; colour, alignment, font and text are
 * re-applied only when the built string differs from the sprite's text. The
 * block stays active.
 */
const textDisplay: BehaviorFn = context => {
  const state = loaderOf(context).state(sprite(context))
  let current = state.text as string | undefined
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.activate(1)
    state.visible = false
    return
  }
  if (context.isInputActive(0)) {
    current = undefined
    context.consumeInput(0)
    context.activate(0)
    state.visible = true
  }
  let buffer = ''
  for (let slot = 4; slot < context.inputCount; slot++) {
    const text = parameterString(context, slot)
    if (text !== '') buffer += `${text} `
  }
  const [x, y] = floats(context.input(0), 2, `Text Display ${context.node.index} Offset`)
  state.position = [x!, y!]
  if (current === undefined || buffer !== current) {
    const [r, g, b, a] = floats(context.input(1), 4, `Text Display ${context.node.index} Color`)
    const bytes = originalColorFromFloats(r!, g!, b!, a!)
    const raw = context.localRaw(1)
    if (!raw) throw new Error(`Text Display ${context.node.index} has no font info`)
    const font = decodeTextDisplayFont(raw)
    state.textColor = ((bytes[3] << 24) | (bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) >>> 0
    state.align = Math.trunc(Number(context.input(2)))
    state.font = { face: font.face, size: Math.trunc(Number(context.input(3))), weight: font.weight, italic: (font.style & 1) !== 0, underline: (font.style & 2) !== 0 }
    state.text = buffer
  }
  context.wait()
}

/** The render context's size; the 2D conversions need the host's viewport. */
function viewport(context: BehaviorContext): Original2dScreen {
  const screen = loaderOf(context).render.viewport
  if (!screen) throw new Error(`${context.node.name} ${context.node.index} needs the render context's viewport`)
  return screen
}

/** The target CK2dEntity's state. */
function entity2d(context: BehaviorContext): Original2dState {
  const loader = loaderOf(context)
  const target = context.targetName()
  if (!target) throw new Error(`${context.node.name} ${context.node.index} has no target (CKBR_OWNERERROR)`)
  const classId = loader.classId(target)
  if (classId === undefined || !originalIsChildClassOf(classId, CKCID['2DENTITY'])) throw new Error(`${context.node.name} ${context.node.index} targets ${loader.objectName(target)}, not a 2D entity`)
  return loader.state(target) as unknown as Original2dState
}

/**
 * TT_Toolbox_RT.dll TT Set_2DSprite (exec 0x100254C0): In off and Out, then
 * the setting (local 0) picks the pins as thresholds: >= 4 Position, >= 2
 * Size, >= 1 UV-Rect, in that order. A missing Position or Size is the
 * target's homogeneous one; the UV-Rect is SetSourceRect at once. Then
 * SetHomogeneousCoordinates(TRUE) and SetHomogeneousRect(pos, pos + size).
 */
const ttSet2dSprite: BehaviorFn = context => {
  if (context.isInputActive(0)) { context.consumeInput(0); context.activate(0) }
  const state = entity2d(context)
  let flags = Math.trunc(Number(context.local(0) ?? 0))
  let slot = 0
  let position: [number, number], size: [number, number]
  if (flags >= 4) { flags -= 4; position = floats(context.input(slot++), 2, `Set_2DSprite ${context.node.index} Position`).map(Math.fround) as [number, number] }
  else position = original2dHomogeneousPosition(state)
  if (flags >= 2) { flags -= 2; size = floats(context.input(slot++), 2, `Set_2DSprite ${context.node.index} Size`).map(Math.fround) as [number, number] }
  else size = original2dHomogeneousSize(state)
  if (flags >= 1) state.sourceRect = floats(context.input(slot++), 4, `Set_2DSprite ${context.node.index} UV-Rect`).map(Math.fround) as Original2dRect
  const screen = viewport(context)
  original2dSetHomogeneousCoordinates(state, true, screen)
  original2dSetHomogeneousRect(state, [position[0], position[1], Math.fround(position[0] + size[0]), Math.fround(position[1] + size[1])], screen)
}

/**
 * TT_Toolbox_RT.dll TT ConvertPixel-Homogen (exec 0x1000E9E0): In off and Out
 * at once; the setting (local 0, a BOOL read as a byte) divides by the render
 * width and height, else multiplies and truncates to whole pixels. Outputs X,
 * Y and the 2D vector.
 */
const ttConvertPixelHomogen: BehaviorFn = context => {
  const screen = viewport(context)
  context.consumeInput(0)
  context.activate(0)
  const [x, y] = floats(context.input(0), 2, `ConvertPixel ${context.node.index} Position`).map(Math.fround)
  const local = context.local(0)
  const toHomogeneous = typeof local === 'boolean' ? local : (Number(local ?? 0) & 0xff) !== 0
  const pair = toHomogeneous
    ? [Math.fround(x! / screen.width), Math.fround(y! / screen.height)]
    : [Math.fround(Math.trunc(x! * screen.width)), Math.fround(Math.trunc(y! * screen.height))]
  context.setOutput(0, pair[0]!)
  context.setOutput(1, pair[1]!)
  context.setOutput(2, pair)
}

export const INTERFACE_BEHAVIORS: BehaviorRegistry = {
  'Text Display': textDisplay,
  'TT Set_2DSprite': ttSet2dSprite,
  'TT ConvertPixel-Homogen': ttConvertPixelHomogen,
}

/** CKM_BEHAVIORLOAD callbacks by block name. */
export const INTERFACE_LOAD_CALLBACKS: Record<string, (context: BehaviorContext, state: BehaviorState) => void> = {
  'Text Display': textDisplayLoad,
}
