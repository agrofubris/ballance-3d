// Generic Virtools primitives shared by the authored NMO/CMO graphs. These are
// the pure data/logic behaviors that appear across almost every file (Op, Get
// Cell, Binary Switch, Identity, ...). Semantics follow the standard CKBehavior
// contracts; the level-specific graph wiring still needs per-instance
// verification against the dumped graphs.
const f = Math.fround

export type OriginalOpKind =
  | 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo'
  | 'min' | 'max' | 'abs' | 'negate' | 'power'
  | 'and' | 'or' | 'xor'
  | 'equal' | 'notEqual' | 'greater' | 'greaterOrEqual' | 'less' | 'lessOrEqual'

/** Virtools `Op`: one arithmetic, bitwise or comparison operation on two inputs. */
export function originalOp(kind: OriginalOpKind, a: number, b = 0): number | boolean {
  const x = f(a), y = f(b)
  switch (kind) {
    case 'add': return f(x + y)
    case 'subtract': return f(x - y)
    case 'multiply': return f(x * y)
    case 'divide': return f(x / y)
    case 'modulo': return f(x % y)
    case 'min': return Math.min(x, y)
    case 'max': return Math.max(x, y)
    case 'abs': return Math.abs(x)
    case 'negate': return f(-x)
    case 'power': return f(Math.pow(x, y))
    case 'and': return (x !== 0) && (y !== 0)
    case 'or': return (x !== 0) || (y !== 0)
    case 'xor': return (x !== 0) !== (y !== 0)
    case 'equal': return x === y
    case 'notEqual': return x !== y
    case 'greater': return x > y
    case 'greaterOrEqual': return x >= y
    case 'less': return x < y
    case 'lessOrEqual': return x <= y
  }
}

/** Virtools `Linear Progression`: maps the input range onto the output range. */
export function originalLinearProgression(
  input: number, inputStart: number, inputEnd: number,
  outputStart: number, outputEnd: number, clamp = false,
): number {
  const span = inputEnd - inputStart
  const progress = span === 0 ? 0 : (input - inputStart) / span
  const value = progress * (outputEnd - outputStart) + outputStart
  return clamp ? Math.min(Math.max(value, Math.min(outputStart, outputEnd)), Math.max(outputStart, outputEnd)) : value
}

/** Virtools `Binary Switch`: routes its input to `out0` (false) or `out1` (true). */
export function originalBinarySwitch<T>(condition: boolean, input: T): { out0: T | undefined; out1: T | undefined } {
  return condition ? { out0: undefined, out1: input } : { out0: input, out1: undefined }
}

/** Virtools `Identity`: forwards its input unchanged. */
export function originalIdentity<T>(input: T): T {
  return input
}

/** Virtools `Get Cell`: reads a column cell from a row-major array. */
export function originalGetCell<T>(array: readonly (readonly T[])[], row: number, column: number): T | undefined {
  return array[row]?.[column]
}

/** Virtools `Set Cell`: writes a column cell in a row-major array. Returns
 * whether the cell existed. */
export function originalSetCell<T>(array: T[][], row: number, column: number, value: T): boolean {
  const line = array[row]
  if (!line || column < 0 || column >= line.length) return false
  line[column] = value
  return true
}

/** Virtools `Group Iterator`: walks a snapshot of a group one element per call. */
export class OriginalGroupIterator<T> {
  private index = -1
  private items: readonly T[]
  constructor(items: readonly T[]) { this.items = items }
  /** Reset to the group's first element; returns false for an empty group. */
  begin(): boolean { this.index = 0; return this.items.length > 0 }
  get current(): T | undefined { return this.items[this.index] }
  get isLast(): boolean { return this.index === this.items.length - 1 }
  /** Advance to the next element; returns false when the group is exhausted. */
  next(): boolean { this.index++; return this.index < this.items.length }
}

export interface OriginalMessage { name: string; args: readonly unknown[] }

/** Virtools `Send Message` / `Wait Message`: a named message queue. */
export class OriginalMessageBus {
  private queue: OriginalMessage[] = []
  send(name: string, ...args: unknown[]): void { this.queue.push({ name, args }) }
  /** Removes and returns the next message with the given name, if any. */
  receive(name: string): OriginalMessage | undefined {
    const index = this.queue.findIndex(message => message.name === name)
    if (index < 0) return undefined
    return this.queue.splice(index, 1)[0]
  }
  has(name: string): boolean { return this.queue.some(message => message.name === name) }
  clear(): void { this.queue.length = 0 }
}
