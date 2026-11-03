// Building blocks of Menu.nmo over the CK object context, decoded from the
// shipped DLLs: Visuals.dll Set 2D Material, TT_Toolbox_RT.dll TT_Counter,
// TT_LinearVolume and TT_Key Waiter, and the text entry blocks Controllers.dll
// Input String (exec 0x25202C70) and TT_Toolbox_RT.dll TT InputString (exec
// 0x1001FA80) over the input manager's key buffer.
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import type { GraphContextBinding } from './original-graph-bindings.ts'
import { CKCID, originalIsChildClassOf } from './original-context.ts'
import type { GraphInputManager } from './original-input-manager.ts'

const int = (value: GraphParameterValue): number => Math.trunc(Number(value ?? 0)) | 0

function loaderOf(context: BehaviorContext): GraphContextBinding {
  if (!context.loader) throw new Error(`${context.node.name} ${context.node.index} needs the CK object context`)
  return context.loader
}

/**
 * Visuals.dll Set 2D Material (exec 0x2578E160): a NULL target is
 * CKBR_OWNERERROR with nothing activated; otherwise In off, Out, then
 * `SetMaterial(input 0)`, which stores the pointer alone (NULL included).
 */
const set2dMaterial: BehaviorFn = context => {
  const loader = loaderOf(context)
  const target = context.targetName()
  if (!target || !loader.has(target)) return
  context.consumeInput(0)
  context.activate(0)
  const classId = loader.classId(target)!
  // SetMaterial is a CK2dEntity method; the DLL casts without a check.
  if (!originalIsChildClassOf(classId, CKCID['2DENTITY'])) throw new Error(`Set 2D Material ${context.node.index} targets ${loader.objectName(target)}, not a 2D entity`)
  const material = context.inputObject(0)
  if (material !== undefined && loader.classId(material) !== CKCID.MATERIAL) throw new Error(`Set 2D Material ${context.node.index}: ${material} is not a material in the context`)
  loader.setMaterial2d(target, material)
}

/**
 * TT_Toolbox_RT.dll TT_Counter (exec 0x1000F0A0): inputs 0 Start, 1 Min,
 * 2 Max; local 0 the count. Every run checks Start (an invalid one is logged
 * and replaced by Min), then handles Initialize, Count Up (wrapping to Min)
 * and Count Down (wrapping to Max) in that order, each firing its own output,
 * and writes the count to the local and output 0.
 */
const ttCounter: BehaviorFn = context => {
  const min = int(context.input(1)), max = int(context.input(2))
  let start = int(context.input(0)), count = int(context.local(0))
  if (start < min || start > max) {
    if (!context.system) throw new Error(`TT_Counter ${context.node.index} logs to the console, which needs the host system binding`)
    context.system.console('TT_Counter: Start value invalid!', true)
    start = min
  }
  if (context.isInputActive(0)) { context.consumeInput(0); count = start; context.activate(0) }
  if (context.isInputActive(1)) { context.consumeInput(1); count = (count + 1) | 0; if (count > max) count = min; context.activate(1) }
  if (context.isInputActive(2)) { context.consumeInput(2); count = (count - 1) | 0; if (count < min) count = max; context.activate(2) }
  context.setLocal(0, count)
  context.setOutput(0, count)
}

/**
 * TT_Toolbox_RT.dll TT_LinearVolume's curve (0x10021590): above 1 is 1, at or
 * below 0.01 (a double compare) is 0, otherwise pow(50, x) * 0.02 in double,
 * stored as a float. The input is a 0..1 fraction despite its "dB" name.
 */
export function originalLinearVolume(volume: number): number {
  const x = Math.fround(volume)
  if (x > 1) return 1
  if (!(x > 0.01)) return 0
  return Math.fround(Math.pow(50, x) * 0.02)
}

/** TT_LinearVolume (exec 0x10021600): In off, the curve into output 0, Out. */
const ttLinearVolume: BehaviorFn = context => {
  context.consumeInput(0)
  context.setOutput(0, originalLinearVolume(Number(context.input(0) ?? 0)))
  context.activate(0)
}

const SLOT = {
  maxSize: 0, repetition: 1, multiline: 2, disable: 3, useCaret: 4, caretPos: 5, buffer: 6, running: 7,
} as const
const DIK = { back: 0x0e, return: 0x1c, numpadMultiply: 0x37, numpadMinus: 0x4a, numpadPlus: 0x4e, numpadPeriod: 0x53, numpadSlash: 0xb5,
  numpadComma: 0xb3, numpadEquals: 0x8d, numpadEnter: 0x9c, left: 0xcb, right: 0xcd, home: 0xc7, end: 0xcf, pageUp: 0xc9, pageDown: 0xd1, delete: 0xd3 } as const
/** keypad key -> the character it inserts, regardless of NumLock (0x25203454.. handlers). */
const KEYPAD_CHARS = new Map<number, number>([
  [0x52, 0x30], [0x4f, 0x31], [0x50, 0x32], [0x51, 0x33], [0x4b, 0x34], [0x4c, 0x35], [0x4d, 0x36], [0x47, 0x37], [0x48, 0x38], [0x49, 0x39],
  [DIK.numpadMultiply, 0x2a], [DIK.numpadMinus, 0x2d], [DIK.numpadPlus, 0x2b], [DIK.numpadPeriod, 0x2e], [DIK.numpadSlash, 0x2f],
  [DIK.numpadComma, 0x2c], [DIK.numpadEquals, 0x3d], [DIK.numpadEnter, 0x0a],
])
/** TT InputString refuses these in Insert (0x1001F950). */
const TT_FORBIDDEN = new Set('\\/:*?"<>|'.split('').map(c => c.charCodeAt(0)))
const CARET = '\b'

const toNumber = (value: unknown): number => typeof value === 'number' ? value : value === true ? 1 : value === false || value == null ? 0 : Number(value)

function inputOf(context: BehaviorContext): GraphInputManager {
  if (!context.system) throw new Error(`${context.node.name} ${context.node.index} needs the input manager (the host system binding)`)
  return context.system.input
}

/** The edit buffer: text with the caret as a 0x08 character at index `pos`. `len` is always `buf.length`. */
interface Editor { buf: string; pos: number }

const removeCaret = (text: string, pos: number): string => text.slice(0, pos) + text.slice(pos + 1)
const stripAllCarets = (text: string): string => text.split(CARET).join('')
const ch = (code: number) => String.fromCharCode(code)

/** 0x252029E0 / 0x1001F6F0. */
function toStart(e: Editor): void {
  e.buf = CARET + e.buf.slice(0, e.pos) + e.buf.slice(e.pos + 1)
  e.pos = 0
}

/** 0x25202A10 / 0x1001F730. Returns whether the caret moved (the caller stores it as `changed`). */
function home(e: Editor, multiline: boolean): boolean {
  if (e.pos <= 0 || e.buf[e.pos - 1] === '\n') { e.pos = 0; return false } // faithful: pos zeroed without moving the caret char
  if (!multiline) { toStart(e); return true }
  const newline = e.buf.lastIndexOf('\n', e.pos - 1)
  const start = newline < 0 ? 0 : newline + 1
  e.buf = e.buf.slice(0, start) + CARET + e.buf.slice(start, e.pos) + e.buf.slice(e.pos + 1)
  e.pos = start
  return true
}

/** 0x25202AA0 / 0x1001F7F0: End of the whole text (also PgDn). */
function endOfText(e: Editor, max: number): boolean {
  const len = e.buf.length
  if (e.pos >= len - 1) return false
  const text = removeCaret(e.buf, e.pos) // len-1 characters
  if (len - 1 !== max) { e.buf = text + CARET; e.pos = len - 1 }
  else { e.buf = text.slice(0, len - 2) + CARET + text[len - 2]; e.pos = len - 2 } // full: caret before the last char
  return true
}

/** 0x25202B10 / 0x1001F880: End key. */
function endOfLine(e: Editor, multiline: boolean, max: number): boolean {
  if (!multiline) return endOfText(e, max)
  const q = e.buf.indexOf('\n', e.pos)
  if (q < 0) return endOfText(e, max)
  // memmove(buf+pos, buf+pos+1, q-pos-1); pos=q-1; buf[pos]=8
  e.buf = e.buf.slice(0, e.pos) + e.buf.slice(e.pos + 1, q) + CARET + e.buf.slice(q)
  e.pos = q - 1
  return true
}

/** 0x25202BB0 / 0x1001F950. The callers ignore the result and mark the buffer changed. */
function insert(e: Editor, code: number, max: number, tt: boolean): boolean {
  const len = e.buf.length
  const c = ch(code)
  if (len - 1 === max && e.pos === len - 2) { // full, caret before the last char: overtype it
    if (code === 0x0a) return false
    if (tt && TT_FORBIDDEN.has(code)) return false
    e.buf = e.buf.slice(0, e.pos + 1) + c
    return true
  }
  if (len === max && e.pos === len - 1) { // one slot left, caret at the end: the new char goes after the caret
    if (code === 0x0a) return false
    if (tt && TT_FORBIDDEN.has(code)) return false
    e.buf = e.buf.slice(0, e.pos + 1) + c
    return true
  }
  if (tt && TT_FORBIDDEN.has(code)) return false
  // n = (len-1 == max) ? max : len ; memmove(buf+pos+1, buf+pos, n-pos); buf[pos]=ch; pos++; buf[n+1]=0
  const n = len - 1 === max ? max : len
  e.buf = e.buf.slice(0, e.pos) + c + e.buf.slice(e.pos, n)
  e.pos++
  return true
}

/** Backspace / Delete / Left / Right as in the 0x25203267.. handlers. Return whether anything changed. */
function backspace(e: Editor, max: number): boolean {
  const len = e.buf.length
  if (e.pos <= 0) return false
  if (len - 1 === max && e.pos === len - 2) { e.buf = e.buf.slice(0, e.pos + 1); return true } // removes the LAST char
  e.buf = e.buf.slice(0, e.pos - 1) + e.buf.slice(e.pos, len)
  e.pos--
  return true
}
function deleteForward(e: Editor, max: number): boolean {
  const len = e.buf.length
  if (len <= 1) return false
  if (len - 1 === max && e.pos === len - 2) { e.buf = e.buf.slice(0, e.pos + 1); return true }
  if (e.pos >= len - 1) return false
  e.buf = e.buf.slice(0, e.pos + 1) + e.buf.slice(e.pos + 2)
  return true
}
function left(e: Editor): boolean {
  if (e.pos <= 0) return false
  e.buf = e.buf.slice(0, e.pos - 1) + CARET + e.buf[e.pos - 1] + e.buf.slice(e.pos + 1)
  e.pos--
  return true
}
function right(e: Editor, max: number): boolean {
  const len = e.buf.length
  if (e.pos >= len - 1 || e.pos + 1 >= max) return false
  e.buf = e.buf.slice(0, e.pos) + e.buf[e.pos + 1] + CARET + e.buf.slice(e.pos + 2)
  e.pos++
  return true
}

interface Variant {
  tt: boolean
  /** Output parameter slot of `Key`. */
  keySlot: number
}
const INPUT_STRING: Variant = { tt: false, keySlot: 1 }
const TT_INPUT_STRING: Variant = { tt: true, keySlot: 2 }

/** CKBehavior::ActivateOutput + CKBR_OK/ACTIVATENEXTFRAME bookkeeping of the port's runtime. */
function run(context: BehaviorContext, variant: Variant): void {
  const keyboard = inputOf(context)
  const max = context.local(SLOT.maxSize) === undefined ? 0x20 : int(context.local(SLOT.maxSize))
  const repetition = toNumber(context.local(SLOT.repetition)) !== 0
  const useCaret = toNumber(context.local(SLOT.useCaret)) !== 0
  const stored = context.local(SLOT.buffer)
  const e: Editor = { buf: typeof stored === 'string' ? stored : '', pos: int(context.local(SLOT.caretPos)) }

  // --- Off (input 1) is tested first
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    if (repetition) keyboard.enableKeyboardRepetition(false)
    if (!variant.tt) {
      if (toNumber(context.local(SLOT.running)) !== 0) {
        context.setOutput(0, removeCaret(e.buf, e.pos))
        context.setLocal(SLOT.running, false)
      }
    } else {
      const text = removeCaret(e.buf, e.pos)
      context.setLocal(SLOT.buffer, text) // stripped in place
      context.setLocal(SLOT.caretPos, 0)
      context.setOutput(0, text)
    }
    context.activate(1) // Off
    return // CKBR_OK
  }

  // --- On (input 0)
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    if (!variant.tt) context.setLocal(SLOT.running, true)
    if (repetition) keyboard.enableKeyboardRepetition(true)
    const supplied = String(context.input(0) ?? '')
    const reset = variant.tt ? supplied : stripAllCarets(supplied)
    if (variant.tt) context.setOutput(1, reset) // StringWithoutCaret = the raw reset string
    if (max < 1) throw new Error(`${context.node.name} ${context.node.index}: Max Size ${max}`)
    if (reset.length < max) { e.buf = reset + CARET; e.pos = reset.length }
    else { e.buf = reset.slice(0, max - 1) + CARET + reset[max - 1]; e.pos = max - 1 } // truncate, caret before the last char
    context.setLocal(SLOT.buffer, e.buf)
    context.setLocal(SLOT.caretPos, e.pos)
    context.setOutput(0, useCaret ? e.buf : removeCaret(e.buf, e.pos))
    context.activate(0) // On
    context.wait() // CKBR_ACTIVATENEXTFRAME
    return
  }

  // --- per frame: process this frame's buffered key presses
  const multiline = toNumber(context.local(SLOT.multiline)) !== 0
  const endKey = multiline ? int(context.input(1)) : 0
  const disabled = int(context.local(SLOT.disable))
  let changed = false
  for (const event of keyboard.keyBuffer()) {
    if (!event.pressed) continue // GetKeyFromBuffer == KS_PRESSED only
    const key = event.key
    context.setOutput(variant.keySlot, key)
    const ends = variant.tt
      ? multiline && endKey !== 0 && key === endKey
      : multiline ? endKey !== 0 && key === endKey : key === DIK.return || key === DIK.numpadEnter
    if (ends) {
      const text = removeCaret(e.buf, e.pos)
      context.setLocal(SLOT.buffer, text)
      if (variant.tt) context.setLocal(SLOT.caretPos, 0) // RemoveCaret zeroes the real pos in the TT build
      context.setOutput(0, text)
      context.activate(1) // Off
      return // CKBR_OK; the rest of the frame's events are dropped
    }
    switch (key) {
      case DIK.back: changed = backspace(e, max) || changed; break
      case DIK.delete: changed = deleteForward(e, max) || changed; break
      case DIK.return:
        // Controllers only gets here when multiline; TT requires Multiline.
        if (variant.tt && !multiline) break
        insert(e, 0x0a, max, variant.tt); changed = true
        break
      case DIK.left: if (!(disabled & 2)) changed = left(e) || changed; break
      case DIK.right: if (!(disabled & 2)) changed = right(e, max) || changed; break
      case DIK.home: if (!(disabled & 2)) changed = home(e, multiline); break // assignment, not OR (faithful)
      case DIK.end: if (!(disabled & 2)) changed = endOfLine(e, multiline, max); break
      case DIK.pageUp: if (!(disabled & 2) && e.pos > 0) { toStart(e); changed = true } break
      case DIK.pageDown: if (!(disabled & 2)) changed = endOfText(e, max); break
      default: {
        const keypad = KEYPAD_CHARS.get(key)
        if (keypad !== undefined) {
          if (!(disabled & 1)) { insert(e, keypad, max, variant.tt); changed = true }
          break
        }
        const code = keyboard.scanCodeToAscii(key)
        if (code === 0 || code === 0x1b) break
        insert(e, code, max, variant.tt); changed = true
      }
    }
  }
  if (changed) {
    context.setLocal(SLOT.buffer, e.buf)
    context.setLocal(SLOT.caretPos, e.pos)
    const plain = removeCaret(e.buf, e.pos)
    context.setOutput(0, useCaret ? e.buf : plain)
    if (variant.tt) context.setOutput(1, plain) // StringWithoutCaret
    context.activate(2) // Updated String (Controllers: output 1 if the legacy-version byte at 0x25208B78 is set; never the case for authored files)
  }
  context.wait() // CKBR_ACTIVATENEXTFRAME, also when nothing changed
}

/** Controllers.dll Input String (exec 0x25202C70). */
export const inputString: BehaviorFn = context => run(context, INPUT_STRING)
/** TT_Toolbox_RT.dll TT InputString (exec 0x1001FA80). */
export const ttInputString: BehaviorFn = context => run(context, TT_INPUT_STRING)

/**
 * TT_Toolbox_RT.dll TT_Key Waiter. Setting 0 Wait For Any Key picks the exec
 * at load (callback 0x10024C80): TRUE (every authored instance) is 0x10024E50,
 * which fires Out with the Key output only when the first event of this
 * frame's key buffer is a press; FALSE (0x10024D90) waits for input 0 held.
 * Off (input 1) ends the block without Out.
 */
const ttKeyWaiter: BehaviorFn = context => {
  const input = inputOf(context)
  if (context.isInputActive(1)) { context.consumeInput(1); return }
  if (context.local(0) === true) {
    const first = input.keyBuffer()[0]
    if (first?.pressed) { context.consumeInput(0); context.activate(0); context.setOutput(0, first.key); return }
  } else if (input.isKeyDown(int(context.input(0)))) { context.consumeInput(0); context.activate(0); return }
  context.wait()
}

/**
 * TT_Toolbox_RT.dll TT PushButton2 (exec 0x10021130). Locals: 0 the state
 * (bit 0 pointer over), 1 the button-was-down flag. On resets the state; its
 * flag is written from a one-byte bool that leaks stack bytes into the CKBOOL,
 * so it reads nonzero: a button held while On runs gives no Mouse Down. Off
 * ends the block. Every run: Pick2D of the cursor (GetMousePosition(FALSE) +
 * the window rect's origin, which Pick2D takes off again) is the target while
 * the cursor shows; Released (0) when the pointer leaves, Roll Over (1) when it
 * enters, Mouse Down (2) on the left button's press edge while over it. The
 * block changes nothing on its target and stays active. The
 * GetCursorVisibility result gates the pointer-over bit itself (0x1002121F:
 * `test eax,eax` then 0x10021271 reads the stored bool before the Pick2D
 * comparison), so a hidden cursor can never produce Roll Over or Mouse Down.
 */
const ttPushButton2: BehaviorFn = context => {
  const input = inputOf(context)
  const loader = loaderOf(context)
  const target = context.targetName()
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.setLocal(0, 0)
    context.setLocal(1, true)
  }
  if (context.isInputActive(1)) { context.consumeInput(1); return }
  const oldState = int(context.local(0)), oldDown = toNumber(context.local(1)) !== 0
  let state = 0
  const [x, y] = input.mousePosition()
  if (loader.pick2d([Math.fround(x), Math.fround(y)]) === target && input.cursorVisible()) state |= 1
  const down = input.mouseButtonDown(0)
  let changed = false
  if (down) { if (!oldDown) { context.setLocal(1, true); changed = true } }
  else if (oldDown) { context.setLocal(1, false); changed = true }
  if (state !== oldState) {
    context.setLocal(0, state)
    if (oldState & 1 && !(state & 1)) context.activate(0)
    else if (!(oldState & 1) && state & 1) context.activate(1)
  }
  if (changed && state === 1 && down) context.activate(2)
  context.wait()
}

/**
 * Logics.dll Streaming Event (declaration 0x254868D0, prototype 0x25486960,
 * execution 0x25486AA0): Out i fires only when input i *becomes* active. A
 * per-input bit in local 0 (`Value`) remembers the ones already fired; a run
 * with input i inactive clears its bit, re-arming it. Output 0
 * (`Last Activated Output`, -1 until one fires) is the index of the input whose
 * output just fired. Gameplay_Events gates its pause Key Event with it: firing
 * on every activation would re-arm the key each frame, so an Escape unpause
 * would see the still-held key and pause again.
 */
const streamingEvent: BehaviorFn = context => {
  let mask = int(context.local(0))
  for (let i = 0; i < context.inCount; i++) {
    const bit = 1 << i
    if (!context.isInputActive(i)) { mask &= ~bit; continue }
    context.consumeInput(i)
    if (mask & bit) continue
    mask |= bit
    context.setOutput(0, i)
    context.activate(i)
  }
  context.setLocal(0, mask)
}

export const MENU_BEHAVIORS: BehaviorRegistry = {
  'TT PushButton2': ttPushButton2,
  'TT_Key Waiter': ttKeyWaiter,
  'Input String': inputString,
  'TT InputString': ttInputString,
  'Set 2D Material': set2dMaterial,
  TT_Counter: ttCounter,
  TT_LinearVolume: ttLinearVolume,
  'Streaming Event': streamingEvent,
}
