// Level-setup building blocks over the CK object context, decoded from the
// shipped DLLs: Materials.dll (Set Blend Modes, Set Alpha Test, Set Material Z
// Buffer, Set MipMap Level, Change Texture Video Format), Narratives.dll
// (Texture Load), Logics.dll (Fill Group By Class) and TT_Toolbox_RT.dll
// (TT_SetMipMapping, TT_ReflectionMapping, TT_FlushTextures,
// TT_PreloadTextures).
import type { BehaviorContext, BehaviorFn, BehaviorRegistry } from './original-graph.ts'
import type { GraphContextBinding } from './original-graph-bindings.ts'
import { CKCID, originalIsChildClassOf } from './original-context.ts'
import { originalNormalize } from './original-ray.ts'

const f = Math.fround

/**
 * Context state written here (OriginalObject.state, by CK member):
 *
 * CKMaterial:  alphaBlendEnabled, sourceBlend, destBlend, textureBlendMode,
 *              alphaTestEnabled, alphaFunc (5 bits), alphaRef (byte),
 *              zWriteEnabled, zFunc (5 bits), textureMinMode, textureMagMode
 * CKTexture:   mipmapLevel (m_MipMapLevel: -1 or 0), desiredVideoFormat,
 *              videoPixelFormat (0 = UNKNOWN_PF, written by the renderer),
 *              inVideoMemory, slotCount, slotFileNames, invalid (CKBITMAPDATA_INVALID)
 * CKMesh (original-graph-render.ts, Set Prelit Color): litMode (0 = VX_PRELITMESH),
 *              vertexColor, vertexSpecularColor (RGBA bytes, uniform over the vertices)
 * Scene objects: inScene (absent = in the scene), private
 *              (CK_OBJECT_PRIVATE, absent = false)
 * CKMesh:      uvRevision (bumped by CKMesh::UVChanged); the UVs themselves
 *              replace OriginalObject.geometry.uvs.
 */

function binding(context: BehaviorContext, label: string): GraphContextBinding {
  const loader = context.loader
  if (!loader) throw new Error(`${label} ${context.node.index} needs the CK object context`)
  return loader
}

/** The behavior's target when it is a live object of the class (a NULL target is the caller's owner error). */
function target(context: BehaviorContext, label: string, cid: number): { loader: GraphContextBinding; ref: string; state: Record<string, unknown> } | undefined {
  const loader = binding(context, label)
  const ref = context.targetName()
  if (!ref || !loader.has(ref)) return undefined
  const classId = loader.classId(ref)
  if (classId === undefined || !originalIsChildClassOf(classId, cid)) {
    throw new Error(`${label} ${context.node.index} targets ${loader.objectName(ref)} (class ${classId}), not a class ${cid} object`)
  }
  return { loader, ref, state: loader.state(ref) }
}

/** `CKBehavior::GetInputParameterValue(slot)` returning CK_OK: the pin exists and holds a value. */
function pin(context: BehaviorContext, slot: number): number | boolean | string | undefined {
  if (slot >= context.inputCount) return undefined
  const value = context.input(slot)
  return value === null || value === undefined || typeof value === 'object' ? undefined : value
}
const int = (value: number | boolean | string) => Number(value) | 0

/** CKTexture::FreeVideoMemory: the rasterizer object is deleted. */
function freeVideoMemory(state: Record<string, unknown>): void {
  state.inVideoMemory = false
  state.videoPixelFormat = 0
}

/** CKTexture::UseMipmap (CK2_3D 0x1007A30F): a different m_MipMapLevel frees video memory; any non-zero value is -1. */
function textureUseMipmap(state: Record<string, unknown>, use: number): true {
  if (state.mipmapLevel !== use) freeVideoMemory(state)
  state.mipmapLevel = use !== 0 ? -1 : 0
  return true
}

/**
 * Materials.dll `Set Blend Modes` (fn 0x25501680). A NULL target is an owner
 * error before In is deactivated and Out fires. Otherwise each pin that reads
 * is applied in order: EnableAlphaBlend, SetSourceBlend, SetDestBlend,
 * SetTextureBlendMode (defaults 1, 5, 6, 2 only matter when a pin is missing).
 */
const setBlendModes: BehaviorFn = context => {
  const material = target(context, 'Set Blend Modes', CKCID.MATERIAL)
  if (!material) return
  const { state } = material
  const blend = pin(context, 0)
  if (blend !== undefined) state.alphaBlendEnabled = int(blend) !== 0
  const source = pin(context, 1)
  if (source !== undefined) state.sourceBlend = int(source)
  const destination = pin(context, 2)
  if (destination !== undefined) state.destBlend = int(destination)
  const texture = pin(context, 3)
  if (texture !== undefined) state.textureBlendMode = int(texture)
  context.consumeInput(0)
  context.activate(0)
}

/**
 * Materials.dll `Set Alpha Test` (fn 0x255012C0): In off and Out first, then a
 * NULL target is an owner error. EnableAlphaTest, SetAlphaFunc (5 bits) and
 * SetAlphaRef (low byte) for the pins that read.
 */
const setAlphaTest: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const material = target(context, 'Set Alpha Test', CKCID.MATERIAL)
  if (!material) return
  const { state } = material
  const enable = pin(context, 0)
  if (enable !== undefined) state.alphaTestEnabled = int(enable) !== 0
  const func = pin(context, 1)
  if (func !== undefined) state.alphaFunc = int(func) & 0x1f
  const ref = pin(context, 2)
  if (ref !== undefined) state.alphaRef = int(ref) & 0xff
}

/**
 * Materials.dll `Set Material Z Buffer` (fn 0x25503940): In off and Out first,
 * then a NULL target is an owner error. EnableZWrite then SetZFunc; the pin
 * results are not checked, so a missing pin keeps TRUE / VXCMP_LESSEQUAL (4).
 */
const setMaterialZBuffer: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const material = target(context, 'Set Material Z Buffer', CKCID.MATERIAL)
  if (!material) return
  const write = pin(context, 0)
  const func = pin(context, 1)
  material.state.zWriteEnabled = write === undefined ? true : int(write) !== 0
  material.state.zFunc = (func === undefined ? 4 : int(func)) & 0x1f
}

/**
 * Materials.dll `Set MipMap Level` (fn 0x255058A0): In off and Out first; a
 * NULL target returns CK_OK. CKTexture::UseMipmap(Use MipMapping) (TRUE when
 * the pin does not read).
 */
const setMipMapLevel: BehaviorFn = context => {
  context.consumeInput(0)
  context.activate(0)
  const texture = target(context, 'Set MipMap Level', CKCID.TEXTURE)
  if (!texture) return
  const use = pin(context, 0)
  textureUseMipmap(texture.state, use === undefined ? 1 : int(use))
}

/** The 14-entry VX_PIXELFORMAT table of Change Texture Video Format (Materials.dll 0x2550BE78), by enum index. */
const VIDEO_FORMATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0x13, 0x15, 0x17, 0x18, 0x1a] as const

/**
 * Materials.dll `Change Texture Video Format` (fn 0x25505350). Without In
 * active, Failed fires. Otherwise In is off, the index is read (0 when the pin
 * does not read; the table is NOT range checked, so an index past 13 reads
 * unrelated data and fails loudly here), and a NULL target is a
 * CKBR_BEHAVIORERROR (no output). A texture whose resident format already
 * matches fires Success. Otherwise SetDesiredVideoFormat (frees video memory
 * when it changes) and SystemToVideoMemory are called and the result is
 * Success only when the driver's TextureFormats list holds the format.
 */
const changeTextureVideoFormat: BehaviorFn = context => {
  if (!context.isInputActive(0)) { context.activate(1); return }
  context.consumeInput(0)
  const index = int(pin(context, 0) ?? 0)
  const texture = target(context, 'Change Texture Video Format', CKCID.TEXTURE)
  if (!texture) return
  if (index < 0 || index >= VIDEO_FORMATS.length) throw new Error(`Change Texture Video Format ${context.node.index} reads format index ${index}, outside the 14-entry table`)
  const format = VIDEO_FORMATS[index]!
  const { state } = texture
  if (Number(state.videoPixelFormat ?? 0) === format) { context.activate(0); return }
  const formats = texture.loader.textureFormats?.()
  if (!formats) { context.activate(1); return } // no render manager / render context: Failed
  if (state.desiredVideoFormat !== format) { state.desiredVideoFormat = format; freeVideoMemory(state) }
  // SystemToVideoMemory is the renderer's; the verdict is the driver list.
  context.activate(formats.includes(format) ? 0 : 1)
}

/**
 * Narratives.dll `Texture Load`, synchronous path (fn 0x256835B0; the authored
 * Use Thread setting is FALSE, TRUE fails loudly). A NULL target fires Error
 * without consuming In. Otherwise In is off, the file resolves on the DATA
 * path (category 0, not BITMAP as the reconstructed source says) and
 * CKTexture::LoadImage(file, Slot) loads it (it resolves on the BITMAP path
 * itself); Error when it fails, otherwise Loaded. The texture grows to Slot+1
 * slots and records the slot's file name.
 */
const textureLoad: BehaviorFn = context => {
  const texture = target(context, 'Texture Load', CKCID.TEXTURE)
  if (!texture) { context.activate(1); return }
  if (context.local(2) === true) throw new Error(`Texture Load ${context.node.index} uses asynchronous loading, which is not supported`)
  if (!context.isInputActive(0)) return
  context.consumeInput(0)
  const file = String(pin(context, 0) ?? '')
  const slot = int(pin(context, 1) ?? 0)
  const { state, loader } = texture
  const resolved = file === '' ? undefined : loader.resolveFile(file, 'data') ?? loader.resolveFile(file, 'bitmap')
  const slots = (state.slotFileNames ??= {}) as Record<number, string>
  if (resolved === undefined) {
    if (Number(state.slotCount ?? 0) > slot) slots[slot] = file
    context.activate(1)
    return
  }
  state.slotCount = Math.max(Number(state.slotCount ?? 0), slot + 1)
  slots[slot] = resolved
  state.mipmapUser = false
  freeVideoMemory(state)
  context.activate(0)
}

/** CKIsChildClassOf for a class with objects. */
const isChild = (classId: number, parent: number) => originalIsChildClassOf(classId, parent)

/**
 * Logics.dll `Fill Group By Class` (fn 0x25488C60). In off, Out fires, then a
 * NULL group is a parameter error. Classes i from `Class` to `Class + 1` (all
 * 0..55 when Derived Classes) with CKIsChildClassOf(i, Class): the objects of
 * exactly class i (creation order), not private and, with Only In Current
 * Scene, in the scene, join the group. A non-derived fill therefore also takes
 * class Class+1 when that class derives from Class (SOUND takes WAVESOUND,
 * 3DOBJECT takes BODYPART).
 */
const fillGroupByClass: BehaviorFn = context => {
  const loader = binding(context, 'Fill Group By Class')
  context.consumeInput(0)
  context.activate(0)
  const group = context.targetName()
  if (!group || !loader.has(group)) return
  if (loader.classId(group) !== CKCID.GROUP) throw new Error(`Fill Group By Class ${context.node.index} targets ${loader.objectName(group)}, which is not a group`)
  const type = int(pin(context, 0) ?? 0)
  const derived = pin(context, 1) === undefined ? false : int(pin(context, 1)!) !== 0
  const scene = pin(context, 2) === undefined ? true : int(pin(context, 2)!) !== 0
  const start = derived ? 0 : type
  const end = derived ? 0x37 : type + 1
  for (let i = start; i <= end; i++) {
    const objects = loader.objectsOfClass(i, { currentSceneOnly: scene, skipPrivate: true })
    if (!objects.length || !isChild(i, type)) continue
    for (const object of objects) loader.addToGroup(group, object)
  }
}

/** TT_Toolbox_RT.dll `TT_FlushTextures` (fn 0x10015890): CKRenderManager::FlushTextures frees every texture, sprite and sprite text. */
const ttFlushTextures: BehaviorFn = context => {
  const loader = binding(context, 'TT_FlushTextures')
  context.consumeInput(0)
  for (const classId of [CKCID.TEXTURE, CKCID.SPRITE, CKCID.SPRITETEXT]) {
    for (const object of loader.objectsOfClass(classId, { currentSceneOnly: false, skipPrivate: false })) freeVideoMemory(loader.state(object))
  }
  context.activate(0)
}

/**
 * TT_Toolbox_RT.dll `TT_PreloadTextures` (fn 0x10016390): every texture (exact
 * class, all scenes) that is not resident is uploaded; the count of successful
 * uploads is output 0. SystemToVideoMemory fails for an invalid bitmap.
 */
const ttPreloadTextures: BehaviorFn = context => {
  const loader = binding(context, 'TT_PreloadTextures')
  context.consumeInput(0)
  let count = 0
  for (const object of loader.objectsOfClass(CKCID.TEXTURE, { currentSceneOnly: false, skipPrivate: false })) {
    const state = loader.state(object)
    if (state.inVideoMemory === true || state.invalid === true) continue
    state.inVideoMemory = true
    count++
  }
  context.setOutput(0, count)
  context.activate(0)
}

/**
 * TT_Toolbox_RT.dll `TT_SetMipMapping` (fn 0x100176F0): when In is active it is
 * deactivated and Out fires first. The target material is dereferenced
 * unchecked (NULL fails loudly). If it has a texture in slot 0 and
 * CKTexture::UseMipmap(MipMap Count) succeeds (it always does), the material's
 * minification and magnification filters are set.
 */
const ttSetMipMapping: BehaviorFn = context => {
  if (context.isInputActive(0)) { context.consumeInput(0); context.activate(0) }
  const material = target(context, 'TT_SetMipMapping', CKCID.MATERIAL)
  if (!material) throw new Error(`TT_SetMipMapping ${context.node.index} has no material target (the original dereferences it)`)
  const texture = material.loader.textureOf(material.ref, 0)
  const min = pin(context, 0)
  const mag = pin(context, 1)
  const count = int(pin(context, 2) ?? 1)
  if (texture === undefined) return
  textureUseMipmap(material.loader.state(texture), count)
  if (min !== undefined) material.state.textureMinMode = int(min)
  if (mag !== undefined) material.state.textureMagMode = int(mag)
}

/**
 * The per-vertex loop of TT_ReflectionMapping (fn 0x10016600), single precision
 * after every operation: e = normalize(camera - vertex); r = normalize(2 (n.e) n - e);
 * u = (r.x + 1) * 0.5, v = (r.z + 1) * 0.5. `camera` is in the target's frame.
 */
export function reflectionUVs(camera: readonly number[], positions: readonly number[], normals: readonly number[], uvs: readonly number[]): number[] {
  const out = [...uvs]
  const count = Math.floor(positions.length / 3)
  for (let i = 0; i < count; i++) {
    const e = originalNormalize([f(camera[0]! - positions[i * 3]!), f(camera[1]! - positions[i * 3 + 1]!), f(camera[2]! - positions[i * 3 + 2]!)])
    const nx = normals[i * 3]!, ny = normals[i * 3 + 1]!, nz = normals[i * 3 + 2]!
    // fld ey*ny; fld ex*nx; faddp; fld ez*nz; faddp; fadd st,st
    const dot = f(f(f(e[1]! * ny) + f(e[0]! * nx)) + f(e[2]! * nz))
    const d = f(dot + dot)
    const r = originalNormalize([f(f(d * nx) - e[0]!), f(f(d * ny) - e[1]!), f(f(d * nz) - e[2]!)])
    out[i * 2] = f(f(r[0]! + 1) * 0.5)
    out[i * 2 + 1] = f(f(r[2]! + 1) * 0.5)
  }
  return out
}

/**
 * TT_Toolbox_RT.dll `TT_ReflectionMapping` (fn 0x10016600). Off (input 1)
 * wins: it is deactivated and Exit Off fires. Otherwise On is deactivated and
 * Exit On fires, then: a NULL target is an owner error; MatChannel is read and
 * never used; the Camera is dereferenced unchecked (NULL fails loudly); a
 * target without a current mesh returns CK_OK; else every vertex of the
 * current mesh gets reflection UVs from the camera position in the target's
 * frame, CKMesh::UVChanged is called and the behavior stays active for the
 * next frame (CKBR_ACTIVATENEXTFRAME).
 */
const ttReflectionMapping: BehaviorFn = context => {
  const loader = binding(context, 'TT_ReflectionMapping')
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.activate(1)
    return
  }
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.activate(0)
  }
  const entity = context.targetName()
  if (!entity || !loader.has(entity)) return
  const camera = context.inputObject(1)
  if (camera === undefined) throw new Error(`TT_ReflectionMapping ${context.node.index} has no Camera (the original dereferences it)`)
  const position = context.object(camera)?.positionIn?.(entity)
  if (!position) throw new Error(`TT_ReflectionMapping ${context.node.index} cannot express ${camera} in the frame of ${entity}`)
  const mesh = loader.currentMesh(entity)
  if (!mesh) return
  loader.setMeshUVs(entity, reflectionUVs(position, mesh.positions, mesh.normals, mesh.uvs))
  context.wait()
}

export const MATERIAL_BEHAVIORS: BehaviorRegistry = {
  'Set Blend Modes': setBlendModes,
  'Set Alpha Test': setAlphaTest,
  'Set Material Z Buffer': setMaterialZBuffer,
  'Set MipMap Level': setMipMapLevel,
  'Change Texture Video Format': changeTextureVideoFormat,
  'Texture Load': textureLoad,
  'Fill Group By Class': fillGroupByClass,
  'TT_FlushTextures': ttFlushTextures,
  'TT_PreloadTextures': ttPreloadTextures,
  'TT_SetMipMapping': ttSetMipMapping,
  'TT_ReflectionMapping': ttReflectionMapping,
}
