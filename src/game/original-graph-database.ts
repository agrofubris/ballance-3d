// base.cmo's database, time and scene start-up blocks, decoded from the
// shipped DLLs:
//   TT_DatabaseManager_RT.dll  Set Database Properties, Register Array,
//                              Load Database, Save Database (+ the manager)
//   BuildingBlocksAddons1.dll  Time Settings (+ CK2.dll CKTimeManager)
//   Logics.dll                 Set Component
//   Narratives.dll             Deactivate Object, Delete Dynamic Objects
//   physics_RT.dll             DeleteCollisionSurfaces
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'

const f32 = Math.fround

// ---------------------------------------------------------------------------
// Database.tdb format (TT_DatabaseManager_RT.dll Load 0x10001E40, Save 0x10002420)
// ---------------------------------------------------------------------------

/** CKARRAYTYPE_INT / FLOAT / STRING: the only column types the file can hold. */
export const TDB_INT = 1, TDB_FLOAT = 2, TDB_STRING = 3

/** The status codes the manager returns to the blocks. */
export const DB_OK = 1
export const DB_REGISTER_FAILED = 0x14, DB_ALREADY_REGISTERED = 0x15
export const DB_OPEN_FAILED = 0x1f, DB_BAD_CONTENT = 0x20, DB_NO_ARRAY = 0x21
export const DB_SAVE_OPEN_FAILED = 0x29, DB_ARRAY_MISSING = 0x2a

export type DatabaseCell = number | string
export interface DatabaseColumn { name: string; type: number }
/** One CKDataArray as the file holds it. A key column of -1 means none. */
export interface DatabaseTable { name: string; columns: DatabaseColumn[]; keyColumn: number; rows: DatabaseCell[][] }

export class DatabaseFormatError extends Error {
  readonly code = DB_BAD_CONTENT
}

const rol8 = (value: number, bits: number) => ((value << bits) | (value >> (8 - bits))) & 0xff
const ror8 = (value: number, bits: number) => ((value >> bits) | (value << (8 - bits))) & 0xff

/** Load: `rol al,3; xor al,0AFh; neg al` per byte (0x10001EC4). The Crypted setting is never read. */
export function decryptDatabase(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = -(rol8(bytes[i]!, 3) ^ 0xaf) & 0xff
  return out
}

/** Save: `neg al; xor al,0AFh; ror al,3` per byte (0x1000281E). */
export function encryptDatabase(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = ror8(-bytes[i]! & 0xff ^ 0xaf, 3)
  return out
}

function cstring(bytes: Uint8Array, offset: number, what: string): { text: string; next: number } {
  const end = bytes.indexOf(0, offset)
  if (end < 0) throw new DatabaseFormatError(`${what} is not terminated`)
  let text = ''
  for (let i = offset; i < end; i++) text += String.fromCharCode(bytes[i]!)
  return { text, next: end + 1 }
}

export interface DatabaseRecord { name: string; payload: Uint8Array }

/** Split the decrypted file into records: `name\0, u32 size, payload[size]`. */
export function splitDatabase(plain: Uint8Array): DatabaseRecord[] {
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  const records: DatabaseRecord[] = []
  let offset = 0
  while (offset < plain.length) {
    const { text, next } = cstring(plain, offset, 'array name')
    if (next + 4 > plain.length) throw new DatabaseFormatError(`record ${text} has no size`)
    const size = view.getUint32(next, true)
    if (next + 4 + size > plain.length) throw new DatabaseFormatError(`record ${text} is truncated`)
    records.push({ name: text, payload: plain.subarray(next + 4, next + 4 + size) })
    offset = next + 4 + size
  }
  return records
}

/**
 * One record's payload: `i32 columns, i32 rows, i32 keyColumn`, then per column
 * `name\0, u32 type`, then the cells column by column, row by row: int32 and
 * float32 as 4 bytes, strings NUL-terminated. The DLL rejects negative counts
 * and a key column outside -1..columns-1 (0x20); other column types are not
 * stored, so they fail loudly here.
 */
export function decodeTable(name: string, payload: Uint8Array): DatabaseTable {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  if (payload.length < 12) throw new DatabaseFormatError(`${name} has no header`)
  const columnCount = view.getInt32(0, true), rowCount = view.getInt32(4, true), keyColumn = view.getInt32(8, true)
  if (columnCount < 0 || rowCount < 0 || keyColumn >= columnCount || keyColumn < -1) throw new DatabaseFormatError(`${name} has an invalid header`)
  let offset = 12
  const columns: DatabaseColumn[] = []
  for (let c = 0; c < columnCount; c++) {
    const { text, next } = cstring(payload, offset, `${name} column name`)
    if (next + 4 > payload.length) throw new DatabaseFormatError(`${name} is truncated`)
    const type = view.getUint32(next, true)
    if (type !== TDB_INT && type !== TDB_FLOAT && type !== TDB_STRING) throw new DatabaseFormatError(`${name} column ${text} has type ${type}, which the file format does not store`)
    columns.push({ name: text, type })
    offset = next + 4
  }
  const rows: DatabaseCell[][] = Array.from({ length: rowCount }, () => new Array<DatabaseCell>(columnCount))
  for (let c = 0; c < columnCount; c++) {
    for (let r = 0; r < rowCount; r++) {
      if (columns[c]!.type === TDB_STRING) {
        const { text, next } = cstring(payload, offset, `${name} cell`)
        rows[r]![c] = text
        offset = next
      } else {
        if (offset + 4 > payload.length) throw new DatabaseFormatError(`${name} is truncated`)
        rows[r]![c] = columns[c]!.type === TDB_INT ? view.getInt32(offset, true) : view.getFloat32(offset, true)
        offset += 4
      }
    }
  }
  return { name, columns, keyColumn, rows }
}

/** Every table of an encrypted file, in file order. */
export function decodeDatabase(bytes: Uint8Array): DatabaseTable[] {
  return splitDatabase(decryptDatabase(bytes)).map(record => decodeTable(record.name, record.payload))
}

function latin1(text: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0xff || code === 0) throw new Error(`database string ${JSON.stringify(text)} is not a NUL-free single-byte string`)
    bytes.push(code)
  }
  return bytes
}

/** One record as Save writes it (the plain, unencrypted bytes). */
export function encodeTable(table: DatabaseTable): Uint8Array {
  const out: number[] = []
  const u32 = (value: number) => { const v = new DataView(new ArrayBuffer(4)); v.setUint32(0, value >>> 0, true); out.push(...new Uint8Array(v.buffer)) }
  const f32le = (value: number) => { const v = new DataView(new ArrayBuffer(4)); v.setFloat32(0, value, true); out.push(...new Uint8Array(v.buffer)) }
  out.push(...latin1(table.name), 0)
  const sizeAt = out.length
  u32(0)
  const payloadAt = out.length
  u32(table.columns.length); u32(table.rows.length); u32(table.keyColumn)
  for (const column of table.columns) {
    // The DLL writes type 0 for any other type and then no cells; the loader cannot read that back.
    if (column.type !== TDB_INT && column.type !== TDB_FLOAT && column.type !== TDB_STRING) throw new Error(`${table.name} column ${column.name} has type ${column.type}, which Save Database cannot store`)
    out.push(...latin1(column.name), 0)
    u32(column.type)
  }
  table.columns.forEach((column, c) => {
    for (const row of table.rows) {
      const cell = row[c]
      if (column.type === TDB_STRING) out.push(...latin1(String(cell ?? '')), 0)
      else if (column.type === TDB_INT) u32(Math.trunc(Number(cell ?? 0)))
      else f32le(Number(cell ?? 0))
    }
  })
  const size = out.length - payloadAt
  const bytes = new Uint8Array(out)
  new DataView(bytes.buffer).setUint32(sizeAt, size, true)
  return bytes
}

/** Save Database's file: the registered tables in registration order, encrypted as one block. */
export function encodeDatabase(tables: readonly DatabaseTable[]): Uint8Array {
  const parts = tables.map(encodeTable)
  const plain = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { plain.set(part, offset); offset += part.length }
  return encryptDatabase(plain)
}

// ---------------------------------------------------------------------------
// The TT Database-Manager (GUID 4db6188e:287e1410) and the host binding
// ---------------------------------------------------------------------------

/**
 * Manager state. `file` is the path Set Database Properties stored (NULL until
 * then and after every CK reset, 0x10001C00); the list holds the registered
 * arrays' names in registration order and is not de-duplicated by Load's auto
 * register (only Register Array checks). `crypted` is stored but never read.
 */
export class OriginalDatabaseManager {
  file: string | null = null
  crypted = true
  registered: string[] = []

  /** 0x10001C00. */
  reset(): void { this.file = null; this.crypted = true; this.registered = [] }
  /** 0x10002940: a path equal to the static empty string is ignored. */
  setProperties(file: string, crypted: boolean): void { if (file !== '') { this.file = file; this.crypted = crypted } }
  /** 0x10001C20: 1, or 0x15 when a registered name equals it. */
  register(name: string): number {
    if (this.registered.includes(name)) return DB_ALREADY_REGISTERED
    this.registered.push(name)
    return DB_OK
  }
  /** 0x10001E10. */
  clearRegistered(): void { this.registered = [] }
}

export interface GraphDatabaseBinding {
  readonly manager: OriginalDatabaseManager
  /** fopen(path, "rb") + fread; undefined when the open fails. */
  read(path: string): Uint8Array | undefined
  /** make the file writable, fopen(path, "wb") + fwrite; false when the open fails. */
  write(path: string, bytes: Uint8Array): boolean
  /** CKContext::OutputToConsole(Ex): developer console text. */
  console(message: string): void
  readonly arrays: {
    /** The live CKDataArray of that name as typed columns and cells, undefined if none (GetObjectByNameAndClass(name, CKCID_DATAARRAY)). */
    snapshot(name: string): DatabaseTable | undefined
    /**
     * Load's first step: an existing array is cleared (`Clear(TRUE)`) and loses every
     * column; a missing one is created (`CreateObject(CKCID_DATAARRAY, name)`,
     * `GetCurrentScene()->AddObjectToScene(array, FALSE)`).
     */
    reset(name: string): void
    /** InsertColumn per column (-1), SetKeyColumn, InsertRow(-1) per row, SetElementValue per cell. */
    fill(name: string, table: DatabaseTable): void
  }
}

/** TT Load Database's work (Load 0x10001E40). `wanted` '' loads every record. */
export function loadDatabase(database: GraphDatabaseBinding, wanted: string, autoRegister: boolean): number {
  const file = database.manager.file
  const bytes = file === null ? undefined : database.read(file)
  if (!bytes) return DB_OPEN_FAILED
  let loaded = 0
  try {
    for (const record of splitDatabase(decryptDatabase(bytes))) {
      if (wanted !== '' && record.name !== wanted) continue
      database.arrays.reset(record.name)
      if (autoRegister) database.manager.registered.push(record.name)
      database.arrays.fill(record.name, decodeTable(record.name, record.payload))
      loaded++
      if (wanted !== '') break
    }
  } catch (error) {
    if (error instanceof DatabaseFormatError) return DB_BAD_CONTENT
    throw error
  }
  return loaded < 1 ? DB_NO_ARRAY : DB_OK
}

/** TT Save Database's work (Save 0x10002420): all registered arrays, or nothing written. */
export function saveDatabase(database: GraphDatabaseBinding): number {
  const tables: DatabaseTable[] = []
  for (const name of database.manager.registered) {
    const table = database.arrays.snapshot(name)
    if (!table) return DB_ARRAY_MISSING
    tables.push(table)
  }
  const file = database.manager.file
  if (file === null || !database.write(file, encodeDatabase(tables))) return DB_SAVE_OPEN_FAILED
  return DB_OK
}

function databaseOf(context: BehaviorContext): GraphDatabaseBinding {
  const database = context.database
  if (!database) throw new Error(`${context.node.name} ${context.node.index} needs the TT Database-Manager binding`)
  return database
}

// Output pin order of the four database blocks: 0 OK, 1 Error.
const OK = 0, ERROR = 1

/** TT_DatabaseManager_RT.dll Set Database Properties (decl 0x100015E0, GUID 1436624f:34e1290a, run 0x10001710). Inputs: File (string), Crypted (bool, default TRUE). */
export const setDatabaseProperties: BehaviorFn = context => {
  const database = databaseOf(context)
  context.consumeInput(0)
  const file = context.input(0)
  // A NULL data pointer ends with the Error pin and a console line; UNVERIFIED that an empty string reads as NULL.
  if (typeof file !== 'string' || file === '') {
    context.activate(ERROR)
    database.console('no file given')
    return
  }
  database.manager.setProperties(file, context.input(1) !== false)
  context.activate(OK)
}

/** Register Array (decl 0x10001220, GUID 348773dc:19ae6322, run 0x10001340). Inputs 0 Register, 1 Clear; parameter Array. */
export const registerArray: BehaviorFn = context => {
  const database = databaseOf(context)
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    const array = context.inputObject(0)
    if (array === undefined) {
      context.activate(ERROR)
      database.console('no array given')
      return
    }
    const name = context.loader?.objectName(array) ?? array
    const result = database.manager.register(name)
    if (result === DB_ALREADY_REGISTERED) database.console('array is already registered')
    if (result === DB_OK || result === DB_ALREADY_REGISTERED) context.activate(OK)
    if (result === DB_REGISTER_FAILED || result === 0) {
      database.console('registration failed')
      context.activate(ERROR)
    }
    return
  }
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    database.manager.clearRegistered()
    context.activate(OK)
  }
}

/** Load Database (decl 0x10001000, GUID 05441494:38ac7789, run 0x1000113x). Inputs: Auto Register (bool, TRUE), Array Name (string). */
export const loadDatabaseBlock: BehaviorFn = context => {
  const database = databaseOf(context)
  context.consumeInput(0)
  const auto = context.input(0) === true || context.input(0) === 1
  const name = String(context.input(1) ?? '')
  const result = loadDatabase(database, name, auto)
  if (result === DB_OK) { context.activate(OK); return }
  if (result === DB_OPEN_FAILED) database.console('cannot open file')
  else if (result === DB_BAD_CONTENT) database.console('bad file content')
  else if (result === DB_NO_ARRAY) database.console('array not in file')
  context.activate(ERROR)
}

/** Save Database (decl 0x10001460, GUID 5d303e9d:552c0af2, run 0x10001550). */
export const saveDatabaseBlock: BehaviorFn = context => {
  const database = databaseOf(context)
  context.consumeInput(0)
  const result = saveDatabase(database)
  if (result === DB_OK) { context.activate(OK); return }
  if (result === DB_SAVE_OPEN_FAILED) database.console('cannot save file')
  else if (result === DB_ARRAY_MISSING) database.console('a registered array no longer exists; file not written')
  context.activate(ERROR)
}

// ---------------------------------------------------------------------------
// CKTimeManager (CK2.dll) and Time Settings (BuildingBlocksAddons1.dll)
// ---------------------------------------------------------------------------

/** m_LimitOptions low nibble (behavioural) and high nibble (frame) flags. Names UNVERIFIED; values and effects are from GetTimeToWaitForLimits. */
export const FRAME_FREE = 0x10, FRAME_SYNC = 0x20, FRAME_LIMIT = 0x40
export const BEHAVIORAL_SYNC = 1, BEHAVIORAL_LIMIT = 4

/**
 * The CKTimeManager members Time Settings drives, with the constructor's
 * defaults (CK2.dll 0x24017D80..): options 0x11, rate limits 60, scale 1,
 * minimum delta 1 ms, maximum 200 ms.
 */
export class OriginalTimeManager {
  /** +0x4C */ options = FRAME_FREE | BEHAVIORAL_SYNC
  /** +0x3C / +0x50 */ frameLimit = 60
  frameLimitMs = f32(1000 / 60)
  /** +0x40 / +0x54 */ behavioralLimit = 60
  behavioralLimitMs = f32(1000 / 60)
  /** +0x5C */ timeScale = 1
  /** +0x48 */ minimumDeltaMs = 1
  /** +0x44 */ maximumDeltaMs = 200

  /** 0x24017E70: only a positive rate changes anything. */
  setFrameRateLimit(rate: number): void {
    if (rate > 0) { this.frameLimit = f32(rate); this.frameLimitMs = f32(1000 / rate) }
  }
  /** 0x24017E98. */
  setBehavioralRateLimit(rate: number): void {
    if (rate > 0) { this.behavioralLimit = f32(rate); this.behavioralLimitMs = f32(1000 / rate) }
  }
  /** 0x24017EC0 / 0x24017EDB: only positive values are stored. */
  setMinimumDeltaTime(ms: number): void { if (ms > 0) this.minimumDeltaMs = f32(ms) }
  setMaximumDeltaTime(ms: number): void { if (ms > 0) this.maximumDeltaMs = f32(ms) }
  /** 0x24017E47: a non-zero argument replaces its nibble. */
  changeLimitOptions(frame: number, behavioral: number): void {
    if (frame) this.options = (this.options & 0x0f) | frame
    if (behavioral) this.options = (this.options & 0xf0) | behavioral
  }
  /** CKTimeManager::PreProcess (0x240180AB..0x24018100): the delta the scripts see. */
  scriptDeltaMs(elapsedMs: number): number {
    let delta = f32(elapsedMs)
    if (delta < this.minimumDeltaMs) delta = this.minimumDeltaMs
    if (delta > this.maximumDeltaMs) delta = this.maximumDeltaMs
    return f32(this.timeScale * delta)
  }
  /** GetTimeToWaitForLimits (0x24017EF6): ms the player still waits before the next frame and behavioural pass. */
  timeToWait(sinceFrameMs: number, sinceBehavioralMs: number): { frame: number; behavioral: number } {
    const frame = (this.options & 0x30) !== 0 ? 0 : f32(this.frameLimitMs - sinceFrameMs)
    const behavioral = (this.options & 1) !== 0 ? frame : f32(this.behavioralLimitMs - sinceBehavioralMs)
    return { frame, behavioral }
  }
}

/** The int input: `GetInputParameterValue` then `if (v <= 0) v = -v`. */
function absInt(value: GraphParameterValue): number {
  const v = Math.trunc(Number(value)) | 0
  return v > 0 ? v : -v | 0
}

/**
 * BuildingBlocksAddons1.dll Time Settings (decl 0x25114D60, GUID 060a0f8c:09203b5f, run 0x25114F10).
 * Inputs: 0 Frame Rate (enum; 1 -> 0x20, 2 -> 0x10, anything else -> 0x40), 1 Frame Limit Value (int),
 * 2 Scale Time Value, 3 Behavior Rate (enum; 1 -> 1, else 4), 4 Behavior Limit Value (int),
 * 5 Min Delta Time, 6 Max Delta Time (floats). Every number is made non-negative first.
 * Order: SetFrameRateLimit (frame mode 0x40 only), scale, SetBehavioralRateLimit (behavioural
 * mode != 1), ChangeLimitOptions, SetMinimumDeltaTime, SetMaximumDeltaTime, In off, Out on.
 */
export const timeSettings: BehaviorFn = context => {
  const time = context.time
  if (!time) throw new Error(`Time Settings ${context.node.index} needs the time manager`)
  const manager = time.manager
  const mode = Math.trunc(Number(context.input(0))) | 0
  const frameLimit = absInt(context.input(1))
  const scale = Math.abs(f32(Number(context.input(2))))
  const behaviorMode = Math.trunc(Number(context.input(3))) | 0
  const behaviorLimit = absInt(context.input(4))
  const minimum = Math.abs(f32(Number(context.input(5))))
  const maximum = Math.abs(f32(Number(context.input(6))))
  let frameFlag: number
  if (mode === 1) frameFlag = FRAME_SYNC
  else if (mode === 2) frameFlag = FRAME_FREE
  else { frameFlag = FRAME_LIMIT; manager.setFrameRateLimit(frameLimit) }
  manager.timeScale = f32(scale)
  let behaviorFlag = BEHAVIORAL_SYNC
  if (behaviorMode !== 1) { behaviorFlag = BEHAVIORAL_LIMIT; manager.setBehavioralRateLimit(behaviorLimit) }
  manager.changeLimitOptions(frameFlag, behaviorFlag)
  manager.setMinimumDeltaTime(minimum)
  manager.setMaximumDeltaTime(maximum)
  context.consumeInput(0)
  context.activate(0)
}

// ---------------------------------------------------------------------------
// Set Component, Deactivate Object, Delete Dynamic Objects, DeleteCollisionSurfaces
// ---------------------------------------------------------------------------

/** Exported type GUIDs (little-endian dwords) and their component counts. */
const COMPONENTS: Record<string, number> = {
  ee2fd457913bbb7c: 4, // CKPGUID_COLOR 57d42fee:7cbb3b91
  ae4e82486079e42f: 3, // CKPGUID_VECTOR 48824eae:2fe47960
  '3c1bb0133e584219': 3, // 13b01b3c:1942583e, same path as the vector
  '4ab3fc4e2fe47960': 2, // CKPGUID_2DVECTOR 4efcb34a:6079e42f
}

/**
 * Logics.dll Set Component (decl 0x25491890, GUID 6e800755:57b64acb, run 0x25491A20).
 * In off and Out on first; then the output parameter (its type is whatever the setting
 * morphed it to) is composed from the leading float inputs: COLOR 4, VECTOR 3, 2DVECTOR 2.
 * Other output types (the rectangle/box path 7ab20d20:693044a9) are not decoded here and fail.
 */
export const setComponent: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const type = context.node.outputs?.[0]?.type
  const count = type === undefined ? undefined : COMPONENTS[type]
  if (count === undefined) throw new Error(`Set Component ${context.node.index} composes output type ${type}, which is not decoded`)
  const value: number[] = []
  for (let slot = 0; slot < count; slot++) {
    const input = context.input(slot)
    if (typeof input !== 'number') throw new Error(`Set Component ${context.node.index} component ${slot + 1} is not a float`)
    value.push(f32(input))
  }
  context.setOutput(0, value)
}

/**
 * Narratives.dll Deactivate Object (decl 0x25685F20, GUID 160f4b7d:67de224e, run 0x25686020):
 * In off, Out on, then `CKScene::DeActivate(GetInputParameterObject(0))` on the current scene.
 * A NULL object returns CKBR_PARAMETERERROR (0xA008) after Out fired. DeActivate of a
 * CKBeObject (CK2.dll 0x2402D5F8 -> 0x2402ED90(obj, activate = 0, reset = 0)) only acts when the
 * object is in the scene and flagged ACTIVE (8): it clears ACTIVE, takes the object out of the
 * behaviour manager's registry (when it has scripts) and sends CKM_BEHAVIORDEACTIVATESCRIPT (0x11)
 * to each of its scripts. A group is a CKBeObject: only the group itself is deactivated.
 */
export const deactivateObject: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const object = context.inputObject(0)
  if (object === undefined) return
  if (!context.extra) throw new Error(`Deactivate Object ${context.node.index} needs the scene binding`)
  context.extra.deactivate(object)
}

/**
 * Narratives.dll Delete Dynamic Objects (decl 0x25681000, GUID 0cba3195:53440e4c, run 0x256810F0):
 * In off, Out on, `CKContext::DestroyAllDynamicObjects()`. CK2 only raises a flag (0x2403513B ->
 * 0x2400F3C5, object manager +0x44); the object manager's PostProcess (0x2400F504) then calls
 * `DestroyObjects` on its dynamic-object list and clears the flag, i.e. at the end of the frame.
 */
export const deleteDynamicObjects: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const dynamic = context.dynamic
  if (!dynamic) throw new Error(`Delete Dynamic Objects ${context.node.index} needs the object manager binding`)
  dynamic.destroyAll()
}

/**
 * physics_RT.dll DeleteCollisionSurfaces (decl 0x10001C40, GUID 53bf75aa:770c7021, run 0x10001D30):
 * queues a command on the Ipion manager (GUID 6bed328b:141f5148), which tries it at once
 * (0x10008160); then In off, Out on regardless. The command fails with a console line while
 * any object is still physicalized and then stays queued; otherwise it frees the surface
 * table (manager +0xBC) and replaces it with an empty 64-bucket one.
 */
export const deleteCollisionSurfaces: BehaviorFn = context => {
  const surfaces = context.collisionSurfaces
  if (!surfaces) throw new Error(`DeleteCollisionSurfaces ${context.node.index} needs the physics manager binding`)
  surfaces.delete()
  context.consumeInput(0)
  context.activate(0)
}

export const DATABASE_BEHAVIORS: BehaviorRegistry = {
  'Set Database Properties': setDatabaseProperties,
  'Register Array': registerArray,
  'Load Database': loadDatabaseBlock,
  'Save Database': saveDatabaseBlock,
  'Time Settings': timeSettings,
  'Set Component': setComponent,
  'Deactivate Object': deactivateObject,
  'Delete Dynamic Objects': deleteDynamicObjects,
  'DeleteCollisionSurfaces': deleteCollisionSurfaces,
}
