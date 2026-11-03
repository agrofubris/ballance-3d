import type {
  BehaviorContext,
  BehaviorFn,
  BehaviorRegistry,
  BehaviorState,
  GraphParameterValue,
} from './original-graph.ts'
import { originalDataArray } from './original-data-arrays.ts'

const number = (value: GraphParameterValue) => typeof value === 'number' ? value : Number(value ?? 0)
const text = (value: GraphParameterValue) => typeof value === 'string' ? value : value === null ? '' : String(value)
const bool = (value: GraphParameterValue) => typeof value === 'boolean' ? value : number(value) !== 0

function printf(format: string, value: number | string): string {
  return format.replace(
    /%([-+ 0#]*)(\d+)?(?:\.(\d+))?([diufFeEgGs%])/g,
    (_match, flags: string, width: string | undefined, precision: string | undefined, type: string) => {
      if (type === '%') return '%'
      let result: string
      if (type === 'd' || type === 'i' || type === 'u') result = String(Math.trunc(Number(value)))
      else if (type === 'f' || type === 'F') result = Number(value).toFixed(precision === undefined ? 6 : Number(precision))
      else if (type === 'e' || type === 'E') result = Number(value).toExponential(precision === undefined ? 6 : Number(precision))
      else if (type === 'g' || type === 'G') result = String(Number(value))
      else result = String(value)
      if (type === 'E' || type === 'F' || type === 'G') result = result.toUpperCase()
      const size = width === undefined ? 0 : Number(width)
      if (size > result.length) {
        const pad = flags.includes('0') && !flags.includes('-') ? '0' : ' '
        result = flags.includes('-') ? result.padEnd(size, ' ') : result.padStart(size, pad)
      }
      return result
    })
}

function formatValue(value: GraphParameterValue, format: GraphParameterValue): string {
  const source = text(value)
  if (typeof format !== 'string' || format === '') return source
  if (typeof value === 'number') {
    if (/[diu]/.test(format)) return printf(format, value)
    if (/[fFeEgG]/.test(format)) return printf(format, value)
  }
  return format.endsWith('s') ? printf(format, source) : source
}

const createString: BehaviorFn = context => {
  const delimiter = text(context.input(0))
  const parts: string[] = []
  for (let i = 1; i < context.inputCount; i++) parts.push(formatValue(context.input(i), context.local(i - 1)))
  const built = parts.join(delimiter)

  if (context.isInputActive(2)) {
    context.consumeInput(2)
    context.setOutput(0, '')
    context.activate(2)
    if (!context.isInputActive(0) && !context.isInputActive(1)) return
  }

  if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.setOutput(0, built)
    context.activate(0)
  } else if (context.isInputActive(1)) {
    context.consumeInput(1)
    const current = text(context.output(0))
    const value = context.local(0) === null || current !== '' ? `${current}\n${built}` : built
    context.setOutput(0, value)
    context.activate(1)
  }
}

/** CKParameter::SetStringValue for the types a Scan String writes: a string as is, an int parsed as sscanf %d. */
function fromString(type: string | undefined, text: string, label: string): GraphParameterValue {
  if (type === 'e210d06bea175611') return text
  if (type === 'fd16575ad776e244') {
    const match = /^\s*[+-]?\d+/.exec(text)
    if (!match) throw new Error(`${label}: ${JSON.stringify(text)} is not an int`)
    return Number.parseInt(match[0], 10) | 0
  }
  throw new Error(`${label}: writing a string into type ${type ?? '?'} is not recovered`)
}

/**
 * Logics SplitString.cpp ("Scan String"): Out fires, then Text is split on
 * Delimiter (a space when empty), skipping empty pieces; piece i goes to
 * output i through SetStringValue, and Elements Found (output 0) takes the
 * count with SetOutputParameterValue (raw int bytes, whatever its type). When
 * the last piece has no output, the count is not written.
 */
const scanString: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  const text = context.input(0)
  if (typeof text !== 'string') return
  const raw = context.input(1)
  const delimiter = typeof raw === 'string' && raw !== '' ? raw : ' '
  const label = `Scan String ${context.node.index}`
  const types = context.node.outputs?.map(output => output.type) ?? []
  let elements = 0, rest = text
  for (let at = rest.indexOf(delimiter); at >= 0; at = rest.indexOf(delimiter)) {
    if (at > 0) {
      elements++
      if (elements >= context.outputCount) { rest = rest.slice(at + delimiter.length); break }
      context.setOutput(elements, fromString(types[elements], rest.slice(0, at), label))
    }
    rest = rest.slice(at + delimiter.length)
  }
  if (rest.length) {
    elements++
    if (elements >= context.outputCount) return
    context.setOutput(elements, fromString(types[elements], rest, label))
  }
  // The int's bytes; a string output reads them up to the first NUL.
  context.setOutput(0, types[0] === 'e210d06bea175611' ? String.fromCharCode(...[0, 8, 16, 24].map(shift => (elements >>> shift) & 0xff)).split('\0')[0]! : elements)
}

const getSubString: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)

  const source = context.input(0)
  if (typeof source !== 'string') return
  const length = source.length
  let start = context.input(1) === null ? 1 : number(context.input(1))
  let cutLength = context.input(2) === null ? 0 : number(context.input(2))

  if (cutLength === 0) cutLength = length - start
  else if (start + cutLength > length) cutLength = length - start

  if (start < 0) {
    cutLength += start
    start = 0
  }

  context.setOutput(0, cutLength <= 0 || start >= length ? '' : source.slice(start, start + cutLength))
}

const counter: BehaviorFn = context => {
  const maxCount = context.input(0) === null ? 10 : number(context.input(0))
  const startIndex = context.input(1) === null ? 1 : number(context.input(1))
  let step = context.input(2) === null ? 1 : number(context.input(2))
  if (!step) step = 1

  let current: number
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    current = startIndex - step
  } else {
    context.consumeInput(1)
    current = number(context.output(0))
  }

  current += step
  context.setOutput(0, current)
  const count = Math.trunc((current - startIndex) / step)
  context.activate(count >= maxCount ? 0 : 1)
}

type CalcValue = number | number[]

function scalar(value: CalcValue): number {
  return Array.isArray(value) ? value[0]! : value
}

function vector(value: CalcValue): [number, number, number] | undefined {
  return Array.isArray(value) && value.length >= 3 ? [value[0]!, value[1]!, value[2]!] : undefined
}

function calcAdd(a: CalcValue, b: CalcValue): CalcValue {
  if (typeof a === 'number' && typeof b === 'number') return a + b
  const x = vector(a), y = vector(b)
  if (x && y) return [x[0] + y[0], x[1] + y[1], x[2] + y[2]]
  return NaN
}

function calcSub(a: CalcValue, b: CalcValue): CalcValue {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const x = vector(a), y = vector(b)
  if (x && y) return [x[0] - y[0], x[1] - y[1], x[2] - y[2]]
  return NaN
}

function calcMult(a: CalcValue, b: CalcValue): CalcValue {
  const x = vector(a), y = vector(b)
  if (x && y) return x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
  if (x && typeof b === 'number') return x.map(component => component * b)
  if (typeof a === 'number' && y) return y.map(component => component * a)
  return typeof a === 'number' && typeof b === 'number' ? a * b : NaN
}

function calcDiv(a: CalcValue, b: CalcValue): CalcValue {
  const x = vector(a), y = vector(b)
  if (x && y) {
    if (y[0] === 0 || y[1] === 0 || y[2] === 0) return NaN
    return x[0] / y[0] + x[1] / y[1] + x[2] / y[2]
  }
  if (x && typeof b === 'number') return b === 0 ? NaN : x.map(component => component / b)
  if (typeof a === 'number' && y) return y.some(component => component === 0) ? NaN : y.map(component => a / component)
  return typeof a === 'number' && typeof b === 'number' ? a / b : NaN
}

function calcMod(a: CalcValue, b: CalcValue): CalcValue {
  return scalar(b) === 0 ? NaN : scalar(a) % scalar(b)
}

function calcPow(a: CalcValue, b: CalcValue): CalcValue {
  const x = vector(a), y = vector(b)
  if (x && y) return [
    x[1] * y[2] - y[1] * x[2],
    x[2] * y[0] - y[2] * x[0],
    x[0] * y[1] - y[0] * x[1],
  ]
  return Math.pow(scalar(a), scalar(b))
}

function negate(value: CalcValue): CalcValue {
  return Array.isArray(value) ? value.map(component => -component) : -value
}

function absolute(value: CalcValue): CalcValue {
  return Array.isArray(value) ? value.map(component => Math.abs(component)) : Math.abs(value)
}

function applyFunction(name: string, argument: CalcValue): CalcValue {
  const value = scalar(argument)
  switch (name) {
    case 'SIN': return Math.sin(value)
    case 'COS': return Math.cos(value)
    case 'TAN': return Math.tan(value)
    case 'ABS': return absolute(argument)
    case 'SQRT': return Math.sqrt(value)
    case 'ASIN': return Math.asin(value)
    case 'ACOS': return Math.acos(value)
    case 'ATAN': return Math.atan(value)
    case 'LN': return Math.log(value)
    case 'EXP': return Math.exp(value)
    default: return NaN
  }
}

function evaluateCalculator(expression: string, context: BehaviorContext): CalcValue {
  const source = expression.replace(/\s+/g, '').toUpperCase()
  let index = 0

  function parseAdditive(): CalcValue {
    let value = parseMultiplicative()
    while (source[index] === '+' || source[index] === '-') {
      const operator = source[index++]
      const right = parseMultiplicative()
      value = operator === '+' ? calcAdd(value, right) : calcSub(value, right)
    }
    return value
  }

  function parseMultiplicative(): CalcValue {
    let value = parsePower()
    while (source[index] === '*' || source[index] === '/' || source[index] === '\\') {
      const operator = source[index++]
      const right = parsePower()
      if (operator === '*') value = calcMult(value, right)
      else if (operator === '/') value = calcDiv(value, right)
      else value = calcMod(value, right)
    }
    return value
  }

  function parsePower(): CalcValue {
    const value = parseUnary()
    if (source[index] === '^') {
      index++
      return calcPow(value, parsePower())
    }
    return value
  }

  function parseUnary(): CalcValue {
    if (source[index] === '+') {
      index++
      return parseUnary()
    }
    if (source[index] === '-') {
      index++
      return negate(parseUnary())
    }
    return parsePostfix()
  }

  function parsePostfix(): CalcValue {
    let value = parsePrimary()
    while (source[index] === '.') {
      index++
      const axis = source[index++]
      const components = vector(value)
      value = components ? components[axis === 'X' ? 0 : axis === 'Y' ? 1 : 2]! : NaN
    }
    return value
  }

  function parsePrimary(): CalcValue {
    const character = source[index]
    if (character === undefined) return NaN
    if (character === '(') {
      index++
      const value = parseAdditive()
      if (source[index] === ')') index++
      return value
    }

    const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?/.exec(source.slice(index))
    if (numeric) {
      index += numeric[0].length
      return Number(numeric[0])
    }

    if (character >= 'A' && character <= 'Z') {
      let name = ''
      while (source[index] >= 'A' && source[index] <= 'Z') name += source[index++]
      if (name === 'PI') return Math.PI
      if (source[index] === '(') {
        index++
        const argument = parseAdditive()
        if (source[index] === ')') index++
        return applyFunction(name, argument)
      }
      if (name.length === 1) return number(context.input(name.charCodeAt(0) - 'A'.charCodeAt(0) + 1))
    }

    return NaN
  }

  const value = parseAdditive()
  return index === source.length ? value : NaN
}

const calculator: BehaviorFn = context => {
  const expression = context.input(0)
  const result = typeof expression === 'string' ? evaluateCalculator(expression, context) : NaN
  context.setOutput(0, result)
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

// The recovered Random block uses the process-wide C rand(). The runtime has no
// global seed, so each behavior instance carries a mulberry32 seed in its state.
// The seed is fixed, which makes a graph reproduce the same random sequence.
const DEFAULT_RANDOM_SEED = 0x9e3779b9

function nextRandom(state: BehaviorState): number {
  const current = typeof state.randomSeed === 'number' ? state.randomSeed : DEFAULT_RANDOM_SEED
  const seed = (current + 0x6d2b79f5) >>> 0
  state.randomSeed = seed
  let value = Math.imul(seed ^ (seed >>> 15), seed | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}

const random: BehaviorFn = (context, state) => {
  const min = context.input(0)
  const max = context.input(1)
  let value: GraphParameterValue

  if (Array.isArray(min) && Array.isArray(max)) {
    const length = Math.min(min.length, max.length)
    value = Array.from({ length }, (_, i) => number(min[i]) + nextRandom(state) * (number(max[i]) - number(min[i])))
  } else if (typeof min === 'boolean' || typeof max === 'boolean') {
    value = nextRandom(state) >= 0.5
  } else {
    const low = number(min), high = number(max)
    const unit = nextRandom(state)
    if (typeof context.output(0) === 'boolean') value = unit >= 0.5
    else if (Number.isInteger(low) && Number.isInteger(high)) value = low + Math.trunc(unit * (high - low))
    else value = low + unit * (high - low)
  }

  context.setOutput(0, value)
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

// Logics/Behaviors/SwitchOnMessage.cpp: Off stops the block. Otherwise each
// Message pin activates its output for every matching message the owner
// received last frame, and the block keeps running every frame.
const switchOnMessage: BehaviorFn = context => {
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    return
  }
  if (context.isInputActive(0)) context.consumeInput(0)
  const messages = context.lastFrameMessages()
  for (let i = 0; i < context.inputCount; i++) {
    const id = context.messageKey(i)
    if (messages.some(message => message.id === id)) context.activate(i)
  }
  context.wait()
}

// 3DTrans SetParent.cpp: a missing target is CKBR_OWNERERROR before any IO
// change; otherwise In off, Out, then SetParent(Parent) with the default
// KeepWorldPos = TRUE. A NULL Parent detaches.
const setParent: BehaviorFn = context => {
  const name = context.targetName()
  const object = context.object()
  if (!object) throw new Error(`Set Parent ${context.node.index} target ${name || '(none)'} is not in the scene`)
  context.consumeInput(context.inputSlot)
  context.activate(0)
  if (!object.setParent) throw new Error(`Set Parent ${context.node.index} needs a hierarchy binding for ${name}`)
  object.setParent(context.inputObject(0), true)
}

// Logics AddToGroup.cpp / AddObjectToGroup.cpp: a NULL Group is a parameter
// error (no output); otherwise CKGroup::AddObject, then Out. Groups are the
// context binding's; hosts without one do not model runtime groups, so the
// object is only resolved there.
const addToGroup: BehaviorFn = context => {
  const group = context.inputObject(0)
  if (context.loader) {
    if (group === undefined) { context.consumeInput(context.inputSlot); return }
    context.loader.addToGroup(group, context.targetName())
  } else {
    context.object()
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

const addObjectToGroup: BehaviorFn = context => {
  const group = context.inputObject(0)
  const object = context.inputObject(1)
  if (context.loader) {
    if (group === undefined) { context.consumeInput(context.inputSlot); return }
    if (object !== undefined) context.loader.addToGroup(group, object)
  } else if (object !== undefined) {
    context.object(object)
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

function compareOrdered<T extends number | string>(left: T, right: T, operator: number): boolean {
  switch (operator) {
    case 1: return left === right
    case 2: return left !== right
    case 3: return left < right
    case 4: return left <= right
    case 5: return left > right
    case 6: return left >= right
    default: return false
  }
}

function compareValues(left: GraphParameterValue, right: GraphParameterValue, operator: number): boolean {
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return operator === 2
    const equal = left.every((value, index) => value === right[index])
    return operator === 1 ? equal : operator === 2 ? !equal : false
  }
  if (typeof left === 'string') return compareOrdered(left, text(right), operator)
  if (typeof left === 'boolean') return compareOrdered(left ? 1 : 0, bool(right) ? 1 : 0, operator)
  if (typeof left === 'number') return compareOrdered(left, number(right), operator)
  return false
}

const testCell: BehaviorFn = context => {
  const array = context.array()
  const row = number(context.input(0))
  const column = number(context.input(1))
  const operator = context.input(2) === null ? 1 : number(context.input(2))
  const line = array?.[row]
  const pass = line !== undefined && line[column] !== undefined &&
    compareValues(line[column]!, context.input(3), operator)
  context.consumeInput(context.inputSlot)
  context.activate(pass ? 0 : 1)
}

// Logics/Behaviors/GetArray.cpp `Get Key Row`: finds the first row whose key
// column (CKDataArray::GetKeyColumn) equals the Key Value input (strcmp for
// strings, exact value otherwise) and writes every cell of it to the outputs.
// Without a key column the DLL reports "No column criterion defined" and fires
// neither output.
const getKeyRow: BehaviorFn = context => {
  const target = context.targetName()
  // A Data Array target can be a bare name (the authored local was not resolved
  // to a CK_ID); resolving it through the context would be ambiguous when two
  // arrays share the name. A reference is resolved to the object's name.
  const name = /^#\d+$/.test(target) ? context.loader?.objectName(target) ?? target : target
  const array = context.array()
  if (!array) throw new Error(`Get Key Row ${context.node.index} has no Data Array ${name}`)
  const keyColumn = originalDataArray(name)?.keyColumn
  if (keyColumn === undefined) throw new Error(`Get Key Row ${context.node.index}: ${name} has no exported key column (re-export the Data Arrays)`)
  context.consumeInput(context.inputSlot)
  if (keyColumn < 0) return
  const key = context.input(0)
  const row = array.find(line => line[keyColumn] === key)
  if (!row) { context.activate(1); return }
  for (let i = 0; i < context.outputCount; i++) context.setOutput(i, row[i] ?? null)
  context.activate(0)
}

const iterator: BehaviorFn = context => {
  const array = context.array()
  const rowCount = array?.length ?? 0
  const startingRow = context.input(0) === null ? 0 : number(context.input(0))
  if (startingRow >= rowCount) {
    context.consumeInput(context.inputSlot)
    context.activate(0)
    return
  }

  let endingRow = context.input(1) === null ? -1 : number(context.input(1))
  if (endingRow === -1) endingRow = rowCount - 1
  const backward = bool(context.input(2))

  let index: number
  let first = false
  if (context.isInputActive(0)) {
    first = true
    context.consumeInput(0)
    index = backward ? endingRow : startingRow
    context.setOutput(0, index)
  } else {
    context.consumeInput(1)
    index = number(context.output(0)) + (backward ? -1 : 1)
    if (index <= -1) index = rowCount - 1
    else if (index >= rowCount) index = 0
    context.setOutput(0, index)
  }

  if (backward) {
    endingRow = startingRow - 1
    if (endingRow === -1) endingRow = rowCount - 1
  } else {
    endingRow += 1
    if (endingRow >= rowCount) endingRow = 0
  }

  if ((!first || !rowCount) && index === endingRow) {
    context.activate(0)
    return
  }

  const row = array?.[index]
  if (row) for (let i = 0; i < row.length; i++) context.setOutput(1 + i, row[i] ?? null)
  context.activate(1)
}

const iteratorIf: BehaviorFn = context => {
  const array = context.array()
  const rowCount = array?.length ?? 0
  let index: number
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    index = 0
  } else {
    context.consumeInput(1)
    index = number(context.output(0)) + 1
  }

  if (index >= rowCount) {
    context.activate(0)
    return
  }

  const column = context.input(0) === null ? 0 : number(context.input(0))
  const operator = context.input(1) === null ? 1 : number(context.input(1))
  const reference = context.input(2)
  let found = -1
  for (let row = index; row < rowCount; row++) {
    if (compareValues(array?.[row]?.[column] ?? null, reference, operator)) {
      found = row
      break
    }
  }

  if (found < 0) {
    context.activate(0)
    return
  }

  const row = array?.[found]
  if (row) for (let i = 0; i < row.length; i++) context.setOutput(1 + i, row[i] ?? null)
  context.setOutput(0, found)
  context.activate(1)
}

/**
 * Narratives/Behaviors/ExecuteScript.cpp. In activates the Script input
 * (`CurrentScene->Activate(script, Reset?)`) and polls from the next frame on;
 * Out fires on the first poll where the script is no longer active. A script
 * of another document is reached through the session's script binding; one
 * no hosted document has fails loudly. Awake Object would activate an inactive
 * owner, which the port does not model (owners are always active).
 */
const executeScript: BehaviorFn = (context, state) => {
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    const script = context.inputObject(1)
    const name = script === undefined ? '' : context.loader?.objectName(script) ?? script
    if (!name) throw new Error(`Execute Script ${context.node.index} has no script`)
    if (context.isScriptActive(name) === undefined) {
      throw new Error(`Execute Script ${context.node.index} targets ${name}, which is not a root script of any hosted document`)
    }
    context.script(name, true, bool(context.input(0)))
    state.script = name
    context.wait()
    return
  }
  if (typeof state.script !== 'string') return
  if (context.isScriptActive(state.script)) { context.wait(); return }
  state.script = undefined
  context.activate(0)
}

/**
 * Logics/Behaviors/SendMessageToGroup.cpp (version 2): Out fires, then one
 * message reaches every member of the Group with the inputs from 2 on as its
 * parameters. The port's bus delivers a message once, so each member gets its
 * own copy. A group the binding cannot resolve fails loudly.
 */
const sendMessageToGroup: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  const id = context.messageKey(0)
  const group = text(context.input(1))
  const members = group ? context.group(group) : undefined
  if (!members) throw new Error(`Send Message To Group ${context.node.index} cannot resolve group ${group || '(none)'}`)
  const args: GraphParameterValue[] = []
  for (let i = 2; i < context.inputCount; i++) args.push(context.input(i))
  for (const member of members) context.sendMessage(id, member, args)
}

/**
 * `GetTarget()` of a TARGETABLE block: its target parameter's object, or the
 * script owner when it has no target parameter. Undefined means no object.
 */
function beTarget(context: BehaviorContext): string | undefined {
  if (context.node.targetIndex === undefined && context.node.target === undefined) return context.owner()
  return context.targetName() || undefined
}

/** The attribute a CKPGUID_ATTRIBUTE pin names, as the exporter decodes it. */
function attributeName(context: BehaviorContext): string {
  const name = context.input(0)
  if (typeof name !== 'string' || !name) {
    throw new Error(`${context.node.name} ${context.node.index} has no decoded attribute (re-export with a --managers dump)`)
  }
  return name
}

function attributes(context: BehaviorContext) {
  if (!context.attributes) throw new Error(`${context.node.name} ${context.node.index} needs an attribute binding`)
  return context.attributes
}

/** Logics/Behaviors/HasAttribute.cpp: True copies the value; no target is False. */
const hasAttribute: BehaviorFn = context => {
  context.consumeInput(0)
  const object = beTarget(context)
  if (!object) { context.activate(1); return }
  const name = attributeName(context)
  const binding = attributes(context)
  if (!binding.has(object, name)) { context.activate(1); return }
  context.activate(0)
  const value = binding.value(object, name)
  if (value !== undefined && context.outputCount > 0) context.setOutput(0, value)
}

/** Logics/Behaviors/SetAttribute.cpp: Out first; then add the attribute and copy the value. */
const setAttribute: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const object = beTarget(context)
  if (!object) return
  attributes(context).set(object, attributeName(context), context.inputCount > 1 ? context.input(1) : undefined)
}

/** Logics/Behaviors/RemoveAttribute.cpp: Out first, then the removal. */
const removeAttribute: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const object = beTarget(context)
  if (!object) return
  attributes(context).remove(object, attributeName(context))
}

/**
 * Logics/Behaviors/ObjectsWithAttributeIt.cpp: one carrier per activation from
 * the manager's engine-wide list. In restarts at 0, Loop In advances; Out fires
 * when the list is exhausted without updating the Index local.
 */
const objectsWithAttributeIterator: BehaviorFn = context => {
  const name = attributeName(context)
  const binding = attributes(context)
  const list = binding.carriers(name)
  let index = number(context.local(0))
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    index = 0
  } else {
    context.consumeInput(1)
    index++
  }
  if (index >= list.length) { context.activate(0); return }
  const object = list[index]!
  context.setOutput(0, object)
  context.setLocal(0, index)
  const value = binding.value(object, name)
  if (value !== undefined && context.outputCount > 1) context.setOutput(1, value)
  context.activate(1)
}

/** CKDefines2.h: CKCID_LEVEL. */
const CKCID_LEVEL = 21

function lifecycle(context: BehaviorContext) {
  if (!context.lifecycle) throw new Error(`${context.node.name} ${context.node.index} needs an object lifecycle binding`)
  return context.lifecycle
}

/**
 * Narratives/Behaviors/ObjectCreator.cpp: Out always fires. A Level class
 * creates nothing; otherwise the object is created (Dynamic setting) and added
 * to the current level, and its name is the Object output.
 */
const objectCreate: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const classId = number(context.input(0))
  if (classId === CKCID_LEVEL) return
  context.setOutput(0, lifecycle(context).create(classId, text(context.input(1)), bool(context.local(0))))
}

/**
 * Narratives/Behaviors/ObjectCopier.cpp: every non-null Original (inputs 1..)
 * is copied with the saved Dependency Options; copy i is output i. The
 * CKDependencies bytes go to the binding undecoded.
 */
const objectCopy: BehaviorFn = context => {
  context.consumeInput(0)
  const binding = lifecycle(context)
  const dependencies = context.inputRaw(0)
  const copies: string[] = []
  for (let i = 1; i < context.inputCount; i++) {
    const source = context.inputObject(i)
    if (source === undefined) continue
    const copy = binding.copy(source, dependencies, bool(context.local(0)), context.local(1) === null ? true : bool(context.local(1)))
    if (copy !== undefined) copies.push(copy)
  }
  copies.forEach((copy, index) => context.setOutput(index, copy))
  context.activate(0)
}

/**
 * Logics/Behaviors/GetNearestInGroup.cpp: Out fires; the nearest 3D entity of
 * the group to Position (in the Referential's frame), the Referential itself
 * excluded. Float32 squared distances in original units from FLT_MAX with a
 * strict `<`, so the first member wins ties; an empty search gives no object
 * and sqrtf(FLT_MAX).
 */
const getNearestInGroup: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const f = Math.fround
  const groupName = text(context.input(0))
  const members = groupName ? context.group(groupName) : undefined
  if (!members) throw new Error(`Get Nearest In Group ${context.node.index} cannot resolve group ${groupName || '(none)'}`)
  const position = context.input(1)
  if (Array.isArray(position) && position.some(value => Number(value) !== 0)) {
    throw new Error(`Get Nearest In Group ${context.node.index} has a non-zero Position offset, which is not authored`)
  }
  let referential = text(context.input(2))
  if (referential === 'ActiveBall') referential = context.activeBall() ?? ''
  const reference = referential ? context.object(referential) : undefined
  if (referential && !reference) throw new Error(`Get Nearest In Group ${context.node.index} cannot resolve referential ${referential}`)
  const center = reference?.position ?? [0, 0, 0]
  const scale = context.coordinateScale
  context.setOutput(0, null)
  let min = f(3.4028234663852886e38), nearest: string | null = null
  for (const member of members) {
    if (member === referential) continue
    const entity = context.object(member)
    if (!entity) continue
    // Both positions are float32 world vectors in original units before the subtraction.
    const d = [0, 1, 2].map(axis => f(f(entity.position[axis]! / scale) - f(center[axis]! / scale)))
    const squared = f(f(f(d[0]! * d[0]!) + f(d[1]! * d[1]!)) + f(d[2]! * d[2]!))
    if (squared < min) { min = squared; nearest = member }
  }
  context.setOutput(0, nearest)
  context.setOutput(1, f(Math.sqrt(min)))
}

/** Script/string/array/logic building blocks recovered from CKBuildingBlocks. */
export const SCRIPT_BEHAVIORS: BehaviorRegistry = {
  'Object Create': objectCreate,
  'Object Copy': objectCopy,
  'Get Nearest In Group': getNearestInGroup,
  'Has Attribute': hasAttribute,
  'Set Attribute': setAttribute,
  'Remove Attribute': removeAttribute,
  'Objects With Attribute Iterator': objectsWithAttributeIterator,
  'Execute Script': executeScript,
  'Send Message To Group': sendMessageToGroup,
  Iterator: iterator,
  'Iterator If': iteratorIf,
  'Create String': createString,
  'Get SubString': getSubString,
  'Scan String': scanString,
  Counter: counter,
  Calculator: calculator,
  Random: random,
  'Switch On Message': switchOnMessage,
  'Set Parent': setParent,
  'Add To Group': addToGroup,
  'Add Object To Group': addObjectToGroup,
  'Test Cell': testCell,
  'Get Key Row': getKeyRow,
}
