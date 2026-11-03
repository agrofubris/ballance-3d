// Data Array building blocks (Logics/Array in CKBuildingBlocks) over the CK2
// CKDataArray kernel as NeMo2 reconstructs it (CKDataArray.cpp): typed columns,
// per-type equal/sort functions, MSVCRT qsort and the array's "already sorted"
// cache. Arrays are the binding's row-major cells; column formats come from
// the exported Data Array definitions.
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import { originalDataArray } from './original-data-arrays.ts'
import { crtQsort } from './original-crt-qsort.ts'
import { originalParameterClass } from './original-context.ts'

/** CKARRAYTYPE_* column types. */
const INT = 1, FLOAT = 2, STRING = 3, OBJECT = 4, PARAMETER = 5

/** CKPGUID_PARAMETERTYPE, CKPGUID_BOOL and CKPGUID_STRING as exported. */
const PARAMETER_TYPE = 'f57d513465495e04', BOOL_TYPE = '8e2ad51a2019745e', STRING_TYPE = 'e210d06bea175611'

/** CKPGUIDs as exported (the GUID's two dwords, little-endian bytes). */
const PIN_TYPE: Record<number, string> = {
  [INT]: 'fd16575ad776e244', [FLOAT]: '3f4c8847202c2c43', [STRING]: 'e210d06bea175611', [OBJECT]: '7907d871f3422f40',
}

/** CK_COMPOPERATOR: CKEQUAL = 1 ... CKGREATEREQUAL = 6. */
function opCompare(operator: number, a: number, b: number): boolean {
  switch (operator) {
    case 1: return a === b
    case 2: return a !== b
    case 3: return a < b
    case 4: return a <= b
    case 5: return a > b
    case 6: return a >= b
    default: return false
  }
}

/** `strcmp` on the Windows-1252 bytes the strings hold. */
function strcmp(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i)
    if (d) return d
  }
  return a.length - b.length
}

/** The little-endian float32/int32 bytes of a parameter value, for `memcmp`. */
function parameterBytes(value: GraphParameterValue): Uint8Array | undefined {
  if (Array.isArray(value)) return new Uint8Array(Float32Array.from(value.map(Number)).buffer)
  if (typeof value === 'number') return new Uint8Array(Float32Array.of(value).buffer)
  if (typeof value === 'boolean') return new Uint8Array(Int32Array.of(value ? 1 : 0).buffer)
  // An object parameter's data is its CK_ID; context objects travel as `#<id>`.
  if (typeof value === 'string' && /^#\d+$/.test(value)) return new Uint8Array(Int32Array.of(Number(value.slice(1))).buffer)
  return undefined
}

function memcmp(a: Uint8Array, b: Uint8Array, size: number): number {
  for (let i = 0; i < size; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return 0
}

interface ArrayFormat { name: string; names: string[]; types: number[]; guids: (string | undefined)[]; keyColumn: number }

/**
 * The column layout once Insert Column / Remove Column have changed it. The
 * exported definition is the array as saved; the CKDataArray's m_FormatArray and
 * m_KeyColumn then evolve with the rows they describe, so the layout lives next to them.
 */
const layouts = new WeakMap<GraphParameterValue[][], Omit<ArrayFormat, 'name'>>()

function format(context: BehaviorContext): { rows: GraphParameterValue[][]; format: ArrayFormat } | undefined {
  // A context reference names the array through the context.
  const target = context.targetName()
  const name = context.loader?.objectName(target) ?? target
  const rows = context.array()
  // A missing target is CKBR_OWNERERROR in every array block: no output fires.
  if (!rows) { context.consumeInput(context.inputSlot); return undefined }
  const definition = originalDataArray(name)
  if (!definition) throw new Error(`${context.node.name} ${context.node.index}: ${name} has no exported column format`)
  if (!sortedColumn.has(rows) && definition.sortColumn !== undefined) sortedColumn.set(rows, definition.sortColumn)
  const own = layouts.get(rows)
  return {
    rows,
    format: { name, ...(own ?? {
      names: definition.columns.map(column => column.name), types: definition.columns.map(column => column.type),
      guids: definition.columns.map(column => column.guid), keyColumn: definition.keyColumn,
    }) },
  }
}

/**
 * CKDataArray m_Order / m_ColumnIndex: the column the rows are sorted on.
 * Sort stores m_Order = Ascending, so only an ascending sort is remembered.
 */
const sortedColumn = new WeakMap<GraphParameterValue[][], number | false>()

/**
 * `CKDataArray::Clear`, RemoveColumn until none is left (the key column
 * becomes -1) and InsertColumn of each new column: the emptied rows take a new
 * layout (the list blocks rebuild their arrays this way).
 */
export function originalArraySetLayout(rows: GraphParameterValue[][], columns: readonly { name: string; type: number }[], keyColumn = -1): void {
  rows.length = 0
  sortedColumn.set(rows, false)
  layouts.set(rows, { names: columns.map(column => column.name), types: columns.map(column => column.type), guids: columns.map(column => PIN_TYPE[column.type]), keyColumn })
}

/** An array's current columns and key column: its live layout, or the exported definition. */
export function originalArrayLayout(name: string, rows: GraphParameterValue[][]): { columns: { name: string; type: number; guid?: string }[]; keyColumn: number } {
  const own = layouts.get(rows)
  if (own) return { columns: own.names.map((column, i) => ({ name: column, type: own.types[i]!, guid: own.guids[i] })), keyColumn: own.keyColumn }
  const definition = originalDataArray(name)
  if (!definition) throw new Error(`${name} has no exported column format`)
  return { columns: definition.columns.map(column => ({ name: column.name, type: column.type, guid: column.guid })), keyColumn: definition.keyColumn }
}

const PARAMETER_INT = 'fd16575ad776e244', PARAMETER_BOOL = '8e2ad51a2019745e'
/** CKPGUID_FLOAT, CKPGUID_TIME, CKPGUID_ANGLE and CKPGUID_PERCENTAGE. */
const PARAMETER_FLOAT_TYPES = new Set(['3f4c8847202c2c43', '2b42b4544f0f0f73', 'f52c26113a23b030', '4e4bc8f334ccfa0f'])

/**
 * `CKParameter::IsCompatibleWith` (CK2.dll 0x24008049) for the parameter-column
 * types the recovered graphs set through `Set Cell`. BOOL's compatible-type
 * list contains INT (Menu's Update Start Array writes iterator ints into
 * Menu_Start_ShowHide's BOOL cells); FLOAT does not contain BOOL (Gameplay's
 * Init Ingame BOOL write to Energy[0][4] leaves the authored 500 ms Timefactor
 * untouched). Any other pair is not recovered and fails loudly.
 */
function parameterColumnCompatible(columnGuid: string, sourceType: string): boolean {
  if (columnGuid === sourceType) return true
  if (columnGuid === PARAMETER_BOOL && sourceType === PARAMETER_INT) return true
  if (PARAMETER_FLOAT_TYPES.has(columnGuid) && sourceType === PARAMETER_BOOL) return false
  throw new Error(`Set Cell writes a ${sourceType} value into a ${columnGuid} parameter column, which is not recovered`)
}

/**
 * `Set Cell` as CKDataArray::SetElementValueFromParameter does it: a parameter
 * column copies through CKParameter::SetValue (CK2.dll 0x2400824D), which
 * returns -2 and leaves the cell untouched when IsCompatibleWith rejects the
 * source parameter's type. The block still reports Found either way.
 */
export function originalArraySetCell(context: BehaviorContext, rows: GraphParameterValue[][], row: number, column: number,
  value: GraphParameterValue): boolean {
  const line = rows[row]
  if (!line || column < 0 || column >= line.length) return false
  const target = context.targetName()
  const name = context.loader?.objectName(target) ?? target
  const format = originalArrayLayout(name, rows).columns[column]
  const sourceType = format?.type === PARAMETER
    ? context.node.inputs?.[2]?.type ?? context.node.inputs?.[2]?.pinType
    : undefined
  if (format?.type === PARAMETER && format.guid !== undefined && sourceType !== undefined &&
    !parameterColumnCompatible(format.guid, sourceType)) return true
  line[column] = value
  originalArrayChanged(rows, column)
  return true
}

/** Writes that can break the sorted order clear it (InsertRow, SetElementValue on the sort column). */
export function originalArrayChanged(rows: GraphParameterValue[][], column?: number): void {
  const order = sortedColumn.get(rows)
  if (order !== undefined && order !== false && (column === undefined || column === order)) sortedColumn.set(rows, false)
}

/**
 * ArrayGeneralFunctions.cpp GetInputValue: the key input is read only when its
 * own type is the column's (the parameter type for a parameter column).
 */
function keyInput(context: BehaviorContext, array: ArrayFormat, column: number, slot: number): GraphParameterValue | undefined {
  const type = array.types[column]!
  const expected = type === PARAMETER ? array.guids[column] : PIN_TYPE[type]
  return context.inputType(slot) === expected ? context.input(slot) : undefined
}

/** The column's equal function (`ArrayIntEqual`, ...) against a key, with an operator. */
function columnTest(type: number, operator: number, key: GraphParameterValue, label: string) {
  switch (type) {
    case INT: return (cell: GraphParameterValue) => opCompare(operator, Math.trunc(Number(cell ?? 0)), Math.trunc(Number(key ?? 0)))
    case FLOAT: return (cell: GraphParameterValue) => opCompare(operator, Math.fround(Number(cell ?? 0)), Math.fround(Number(key ?? 0)))
    case STRING: return (cell: GraphParameterValue) => opCompare(operator, strcmp(String(cell ?? ''), String(key ?? '')), 0)
    case OBJECT:
      // Object cells compare their CK_IDs; names stand for them, so only equality is defined here.
      if (operator !== 1 && operator !== 2) throw new Error(`${label}: ordering object cells needs their CK_IDs`)
      return (cell: GraphParameterValue) => opCompare(operator, cell === key ? 0 : 1, 0)
    case PARAMETER: {
      const bytes = parameterBytes(key)
      if (!bytes) throw new Error(`${label}: unsupported parameter key ${JSON.stringify(key)}`)
      return (cell: GraphParameterValue) => {
        const own = parameterBytes(cell)
        if (!own) return false
        const size = Math.min(own.length, bytes.length)
        return size !== 0 && opCompare(operator, memcmp(own, bytes, size), 0)
      }
    }
    default: throw new Error(`${label}: unknown column type ${type}`)
  }
}

/** InsertRow's cells: zero/empty, and a fresh parameter (its type's default) for parameter columns. */
function emptyCell(type: number): GraphParameterValue {
  return type === STRING || type === OBJECT ? null : 0
}

/**
 * AddArray.cpp: with Unique Key Column (local 0) and a key column, a row whose
 * key equals that column's input fires Already Present. Otherwise InsertRow
 * appends a row (zeros, NULL strings and objects, a new parameter per parameter
 * column) and ReadInputParameters writes each input that has a source and
 * whose own type is the column's: int, float, string, BeObject (only), or the
 * parameter column's type.
 */
const addRow: BehaviorFn = context => {
  const target = format(context)
  if (!target) return
  const { rows, format: array } = target
  const label = `Add Row ${context.node.index}`
  const unique = context.local(0) !== false
  if (unique && array.keyColumn >= 0) {
    const key = keyInput(context, array, array.keyColumn, array.keyColumn)
    if (key === undefined) throw new Error(`${label}: the key input's type does not match ${array.name}'s key column`)
    const test = columnTest(array.types[array.keyColumn]!, 1, key, label)
    if (rows.some(row => test(row[array.keyColumn] ?? null))) {
      context.consumeInput(0)
      context.activate(1)
      return
    }
  }
  const row = array.types.map((type, column): GraphParameterValue => {
    const written = context.inputHasSource(column) && keyInput(context, array, column, column) !== undefined
    if (written) return context.input(column)
    if (type === PARAMETER) throw new Error(`${label}: ${array.name} column ${column} keeps its parameter's default value, which is not recovered`)
    return emptyCell(type)
  })
  rows.push(row)
  originalArrayChanged(rows)
  context.consumeInput(0)
  context.activate(0)
}

/** ArrayClear.cpp: CKDataArray::Clear removes every row. */
const clearArray: BehaviorFn = context => {
  const target = format(context)
  if (!target) return
  const { rows } = target
  rows.length = 0
  context.consumeInput(0)
  context.activate(0)
}

/** ArrayValueCount.cpp: GetCount(Column, Operator, input 2). */
const valueCount: BehaviorFn = context => {
  const target = format(context)
  if (!target) return
  const { rows, format: array } = target
  const column = context.input(0) === null ? 1 : Math.trunc(Number(context.input(0)))
  const operator = context.input(1) === null ? 1 : Number(context.input(1))
  let count = 0
  if (column >= 0 && column < array.types.length) {
    const key = keyInput(context, array, column, 2)
    if (key === undefined) throw new Error(`Value Count ${context.node.index}: the key input's type does not match column ${column}`)
    const test = columnTest(array.types[column]!, operator, key, `Value Count ${context.node.index}`)
    count = rows.filter(row => test(row[column] ?? null)).length
  }
  context.setOutput(0, count)
  context.consumeInput(0)
  context.activate(0)
}

/** ArraySort.cpp: CKDataArray::Sort(Sorting Column, Ascending), skipped when already in that order. */
const sortRows: BehaviorFn = context => {
  const target = format(context)
  if (!target) return
  const { rows, format: array } = target
  const column = context.input(0) === null ? 0 : Math.trunc(Number(context.input(0)))
  const ascending = context.input(1) !== false
  if (column >= 0 && column < array.types.length) {
    if (sortedColumn.get(rows) !== column || !ascending) {
      const type = array.types[column]!
      const sign = ascending ? 1 : -1
      const label = `Sort Rows ${context.node.index}`
      const compare = (a: GraphParameterValue[], b: GraphParameterValue[]): number => {
        const x = a[column] ?? null, y = b[column] ?? null
        switch (type) {
          // ArrayIntComp: val1 - val2 (int32 wrap), negated for descending.
          case INT: return sign * ((Math.trunc(Number(x ?? 0)) - Math.trunc(Number(y ?? 0))) | 0)
          case FLOAT: { const p = Math.fround(Number(x ?? 0)), q = Math.fround(Number(y ?? 0)); return p < q ? -sign : p > q ? sign : 0 }
          case STRING: return sign * strcmp(String(x ?? ''), String(y ?? ''))
          case PARAMETER: {
            const p = parameterBytes(x), q = parameterBytes(y)
            if (!p || !q) throw new Error(`${label}: unsupported parameter cells`)
            return sign * memcmp(p, q, Math.min(p.length, q.length))
          }
          default: throw new Error(`${label}: sorting column type ${type} needs CK_IDs`)
        }
      }
      const result = crtQsort(rows, compare)
      rows.splice(0, rows.length, ...result)
      sortedColumn.set(rows, ascending ? column : false)
    }
  }
  context.consumeInput(0)
  context.activate(0)
}

/**
 * ArrayChangeValueIf.cpp: every row whose Column passes Operation against
 * input 2 takes input 3 (SetElementValueFromParameter); Found when any did.
 */
const changeValueIf: BehaviorFn = context => {
  const target = format(context)
  if (!target) return
  const { rows, format: array } = target
  const column = context.input(0) === null ? 0 : Math.trunc(Number(context.input(0)))
  const operator = context.input(1) === null ? 1 : Number(context.input(1))
  let count = 0
  if (column >= 0 && column < array.types.length) {
    const key = keyInput(context, array, column, 2)
    if (key === undefined) throw new Error(`Change Value If ${context.node.index}: the key input's type does not match column ${column}`)
    const test = columnTest(array.types[column]!, operator, key, `Change Value If ${context.node.index}`)
    // SetElementValueFromParameter copies the input's source (none: the row is still counted).
    const hasValue = context.inputHasSource(3)
    for (const row of rows) {
      if (!test(row[column] ?? null)) continue
      if (hasValue) row[column] = context.input(3)
      count++
    }
    if (count) originalArrayChanged(rows, column)
  }
  context.setOutput(0, count)
  context.consumeInput(0)
  context.activate(count ? 0 : 1)
}

/**
 * The key test of a search block (GetInputValue + the column's equal function).
 * A parameter column that holds object references (a group, an entity, ...)
 * compares the CK_IDs with memcmp; the port keeps names for them, so only
 * equality is defined and a NULL reference (id 0) is `null`.
 */
function keyTest(context: BehaviorContext, array: ArrayFormat, column: number, slot: number, operator: number, label: string) {
  if (array.types[column] === PARAMETER && originalParameterClass(array.guids[column]) !== undefined) {
    if (context.inputType(slot) !== array.guids[column]) throw new Error(`${label}: the key input's type does not match column ${column}`)
    if (operator !== 1 && operator !== 2) throw new Error(`${label}: ordering object cells needs their CK_IDs`)
    const key = context.inputObject(slot) ?? null
    return (cell: GraphParameterValue) => opCompare(operator, (cell ?? null) === key ? 0 : 1, 0)
  }
  const key = keyInput(context, array, column, slot)
  if (key === undefined) throw new Error(`${label}: the key input's type does not match column ${column}`)
  return columnTest(array.types[column]!, operator, key, label)
}

/** ArrayRemoveLine.cpp `Remove Row`: CKDataArray::RemoveRow(Row Index); Not Present for an index outside the rows. */
const removeRow: BehaviorFn = context => {
  const target = format(context)
  if (!target) return
  const { rows } = target
  const index = context.input(0) === null ? 0 : Math.trunc(Number(context.input(0)))
  context.consumeInput(0)
  if (index < 0 || index >= rows.length) { context.activate(1); return }
  // Deleting a row keeps the others in order, so a sorted array stays sorted.
  rows.splice(index, 1)
  context.activate(0)
}

/**
 * ArrayRemoveIf.cpp `Remove Row If`: FindRowIndex(Column, Operation, key, from i)
 * then RemoveRow(i), again from the same i, until nothing matches; Number
 * Removed is written either way and Found fires when it is not zero.
 */
const removeRowIf: BehaviorFn = context => {
  const target = format(context)
  if (!target) return
  const { rows, format: array } = target
  const label = `Remove Row If ${context.node.index}`
  const column = context.input(0) === null ? 0 : Math.trunc(Number(context.input(0)))
  const operator = context.input(1) === null ? 1 : Number(context.input(1))
  let count = 0
  // FindRowIndex answers -1 for a column the array does not have.
  if (column >= 0 && column < array.types.length) {
    const test = keyTest(context, array, column, 2, operator, label)
    for (let i = 0; i < rows.length;) {
      if (test(rows[i]![column] ?? null)) { rows.splice(i, 1); count++ } else i++
    }
  }
  context.setOutput(0, count)
  context.consumeInput(0)
  context.activate(count ? 0 : 1)
}

/**
 * RemoveArray.cpp `Remove Key Row`: FindRowIndex(GetKeyColumn, CKEQUAL, key)
 * and RemoveRow of the first match. An array without a key column is
 * CKBR_PARAMETERERROR ("No column criterion defined"): neither output fires.
 */
const removeKeyRow: BehaviorFn = context => {
  const target = format(context)
  if (!target) return
  const { rows, format: array } = target
  context.consumeInput(0)
  if (array.keyColumn < 0) return
  const test = keyTest(context, array, array.keyColumn, 0, 1, `Remove Key Row ${context.node.index}`)
  const index = rows.findIndex(row => test(row[array.keyColumn] ?? null))
  if (index < 0) { context.activate(1); return }
  rows.splice(index, 1)
  context.activate(0)
}

/** A CKPGUID_PARAMETERTYPE value: the type GUID, exported as 16 hex digits. */
function parameterTypeGuid(value: GraphParameterValue, label: string): string {
  if (typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)) return value
  throw new Error(`${label}: Parameter Type ${JSON.stringify(value)} is not a type GUID`)
}

/** A CKParameterOut InsertColumn creates is zero-filled; BOOL is the only type whose use needs it. */
function newParameterCell(guid: string | undefined, label: string): GraphParameterValue {
  if (guid === BOOL_TYPE) return false
  throw new Error(`${label}: a new ${guid} parameter keeps its type's default value, which is not recovered`)
}

/**
 * ArrayInsertColumn.cpp `Insert Column`. Out is activated before the target is
 * looked at (the shipped Logics.dll: ActivateInput(0, FALSE), ActivateOutput(0),
 * then CKBR_OWNERERROR without a target). CK2.dll's InsertColumn does nothing
 * for a NULL name or an Index at or past the column count (unlike NeMo2, which
 * appends); -1 or any other negative index appends, and m_KeyColumn and
 * m_ColumnIndex are not shifted. Every row gets a 0 / NULL cell, or a new
 * parameter of the column's type.
 */
const insertColumn: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const target = format(context)
  if (!target) return
  const { rows, format: array } = target
  const label = `Insert Column ${context.node.index}`
  const index = context.input(0) === null ? -1 : Math.trunc(Number(context.input(0)))
  const name = context.input(1)
  const type = context.input(2) === null ? INT : Math.trunc(Number(context.input(2)))
  if (type < INT || type > PARAMETER) throw new Error(`${label}: unknown column type ${type}`)
  // The Parameter Type input is read only for a parameter column: its own type, or the one it names.
  let guid: string | undefined
  if (type === PARAMETER && context.inputType(3) !== undefined) {
    guid = context.inputType(3)
    if (guid === PARAMETER_TYPE) guid = parameterTypeGuid(context.input(3), label)
  }
  if (typeof name !== 'string' || index >= array.types.length) return
  const at = index >= 0 ? index : array.types.length
  array.names.splice(at, 0, name)
  array.types.splice(at, 0, type)
  array.guids.splice(at, 0, guid)
  layouts.set(rows, { names: array.names, types: array.types, guids: array.guids, keyColumn: array.keyColumn })
  for (const row of rows) row.splice(at, 0, type === PARAMETER ? newParameterCell(guid, label) : emptyCell(type))
}

/**
 * ArrayRemoveColum.cpp `Remove Column`: Out first (as Insert Column), then
 * CKDataArray::RemoveColumn(Index), which ignores an index outside the columns.
 * A sort on the removed column is forgotten, one on a later column moves down,
 * and a later key column moves down (CK2.dll: the key column is not cleared when
 * it is the removed one).
 */
const removeColumn: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const target = format(context)
  if (!target) return
  const { rows, format: array } = target
  const column = context.input(0) === null ? -1 : Math.trunc(Number(context.input(0)))
  if (column < 0 || column >= array.types.length) return
  const order = sortedColumn.get(rows)
  if (order !== undefined && order !== false) {
    if (order === column) sortedColumn.set(rows, false)
    else if (order > column) sortedColumn.set(rows, order - 1)
  }
  array.names.splice(column, 1)
  array.types.splice(column, 1)
  array.guids.splice(column, 1)
  layouts.set(rows, { names: array.names, types: array.types, guids: array.guids, keyColumn: array.keyColumn > column ? array.keyColumn - 1 : array.keyColumn })
  for (const row of rows) row.splice(column, 1)
}

/** Threshold.cpp: X is clamped to [MIN, MAX]; MAX is read only when X is not below MIN, and a NaN lands in the middle. */
const threshold: BehaviorFn = context => {
  const float = (slot: number) => context.input(slot) === null ? 0 : Math.fround(Number(context.input(slot)))
  const x = float(0), min = float(1)
  context.consumeInput(0)
  let result = min
  if (x < min) context.activate(0)
  else {
    const max = float(2)
    if (x > max) { context.activate(1); result = max } else { context.activate(2); result = x }
  }
  context.setOutput(0, result)
}

/**
 * Mini Calculator.cpp: x = a op b in single precision. A string Operator uses its
 * first character (+ - * /), any other type CK_BINARYOPERATOR (CKADD 1, CKSUB 2,
 * CKMUL 3, CKDIV 4). The block leaves x uninitialised for anything else, which
 * has no defined value.
 */
const miniCalculator: BehaviorFn = context => {
  const a = Math.fround(Number(context.input(1) ?? 0)), b = Math.fround(Number(context.input(2) ?? 0))
  const label = `Mini Calculator ${context.node.index}`
  let operator: number
  if (context.inputType(0) === STRING_TYPE) {
    const symbol = String(context.input(0) ?? '')[0]
    operator = symbol === '+' ? 1 : symbol === '-' ? 2 : symbol === '*' ? 3 : symbol === '/' ? 4 : 0
  } else operator = context.input(0) === null ? 1 : Math.trunc(Number(context.input(0)))
  if (operator < 1 || operator > 4) throw new Error(`${label}: operator ${JSON.stringify(context.input(0))} leaves x undefined`)
  context.setOutput(0, Math.fround(operator === 1 ? a + b : operator === 2 ? a - b : operator === 3 ? a * b : a / b))
  context.consumeInput(0)
  context.activate(0)
}

/**
 * `CKDataArray::GetHighest(column, &row)` (CK2.dll 0x2402834D): a column out of
 * range or no rows is -1; an array sorted on the column gives its last row
 * (only ascending sorts are remembered); otherwise the first row of the largest
 * value, ties kept (int columns compare by int32 wrapping subtraction).
 */
function arrayHighest(rows: GraphParameterValue[][], array: ArrayFormat, column: number, label: string): number {
  if (column < 0 || column >= array.types.length || rows.length === 0) return -1
  if (sortedColumn.get(rows) === column) return rows.length - 1
  if (array.types[column] !== INT) throw new Error(`${label}: the highest of a type ${array.types[column]} column is not decoded`)
  let best = 0
  for (let i = 1; i < rows.length; i++) if (((Math.trunc(Number(rows[i]![column] ?? 0)) - Math.trunc(Number(rows[best]![column] ?? 0))) | 0) > 0) best = i
  return best
}

/**
 * Logics.dll Get Highest (exec 0x254976B0): input 0 Column; output 0 the row
 * (written even when not found), outputs 1+i column i of the row (0x2549AC10:
 * int, float and string cells only into a pin of the same type, object cells
 * when the object is of the pin's class, parameter cells by CopyValue). In off,
 * then Found (0) or Not Found (1).
 */
const getHighest: BehaviorFn = context => {
  const target = format(context)
  if (!target) return
  const { rows, format: array } = target
  const label = `Get Highest ${context.node.index}`
  const row = arrayHighest(rows, array, Math.trunc(Number(context.input(0) ?? 0)), label)
  context.setOutput(0, row)
  context.consumeInput(0)
  if (row < 0) { context.activate(1); return }
  for (let column = 0; column < array.types.length && column + 1 < context.outputCount; column++) {
    const slot = column + 1, cell = rows[row]![column] ?? null, pin = context.outputType(slot)
    switch (array.types[column]) {
      case INT: if (pin === PIN_TYPE[INT]) context.setOutput(slot, cell); break
      case FLOAT: if (pin === PIN_TYPE[FLOAT]) context.setOutput(slot, cell); break
      case STRING: if (pin === STRING_TYPE) context.setOutput(slot, cell); break
      case PARAMETER: context.setOutput(slot, cell); break
      default: throw new Error(`${label}: copying a type ${array.types[column]} cell needs CK_IDs`)
    }
  }
  context.activate(0)
}

export const ARRAY_BEHAVIORS: BehaviorRegistry = {
  'Get Highest': getHighest,
  'Add Row': addRow,
  'Clear Array': clearArray,
  'Value Count': valueCount,
  'Sort Rows': sortRows,
  'Change Value If': changeValueIf,
  'Remove Row': removeRow,
  'Remove Row If': removeRowIf,
  'Remove Key Row': removeKeyRow,
  'Insert Column': insertColumn,
  'Remove Column': removeColumn,
  Threshold: threshold,
  'Mini Calculator': miniCalculator,
}
