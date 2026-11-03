// The CKContext's object side: loaded documents' objects with their CK class
// ids, parents and group members, in the order CKFile::FinishLoading hands them
// out. Built from the per-document object tables that
// `scripts/export-original-objects.py` writes from the user's chunk dumps.
import type { GraphAttributeBinding, GraphContextBinding, GraphRenderState } from './original-graph-bindings.ts'
import type { GraphParameterValue } from './original-graph.ts'
import { OriginalEntityGraph } from './original-entity-graph.ts'
import { originalEntityBoundingBox } from './original-bounds.ts'
import { original2dFromSaved } from './original-2d-entity.ts'
import { crtQsort } from './original-crt-qsort.ts'
import { original2dPick } from './original-2d-render.ts'
import type { OriginalMeshGeometry, OriginalRayEntity } from './original-ray.ts'

/** One file object of an exported document (file indices refer to the same file). */
export interface OriginalFileObject {
  index: number
  name: string
  class: number
  /** A CK3dEntity's saved parent (file index). */
  parent?: number
  /** A CK3dEntity's saved world matrix (Virtools row-major). */
  matrix?: number[]
  /** A CK3dEntity saved hidden (CK_STATESAVE_OBJECTHIDDEN). */
  hidden?: boolean
  /** A CKGroup's members (file indices). */
  members?: number[]
  /** The saved CKSceneObjectDesc flags: the level scene's, or the object's own record in a level-less document. */
  sceneFlags?: number
  /** A CK2dEntity's saved members (RCK2dEntity::Save chunk 0x10F000); its material is in `materials`. */
  entity2d?: { flags: number; rect: number[]; sourceRect: number[]; zOrder: number }
  /**
   * The level scene's initial value of the object (CKSaveObjectState, decoded
   * for 2D entities; other classes give only their class).
   */
  initial?: { hidden: boolean; hiddenHierarchical: boolean; entity2d: { flags: number; rect: number[]; sourceRect: number[]; zOrder: number }; materials: number[] } | { class: number }
  /** A CKCurve's saved data (RCKCurve::Load 0xFFC00000 and its points' 0x10000000): points by file index. */
  curve?: { closed: boolean; fitting: number; points: ({ index: number } & Omit<OriginalCurvePoint, 'id'>)[] }
  /** A CKObjectAnimation's saved data (ident 0x4000000): the driven entity by file index, or why it is not decoded. */
  animation?: ({ entity: number } & Omit<OriginalObjectAnimationData, 'entity'>) | { undecoded: string }
  /** A CK3dEntity's CK_3DENTITY_FLAGS (chunk 0x100000). */
  entityFlags?: number
  /** A CKCamera's saved projection (RCKCamera::Load). */
  camera?: OriginalCameraState
  /** A CKLight's saved state (RCKLight::Load). */
  light?: OriginalLightState
  /** A CKMaterial's saved colours and texture slot 0 (RCKMaterial::Load). */
  material?: { diffuse: number[]; ambient: number[]; specular: number[]; emissive: number[]; specularPower: number; texture?: number }
  /** A CKWaveSound's saved state (CKWaveSound::Save): file name, duration and DATA2 members as stored. */
  sound?: { file: string } & Record<string, unknown>
  /** Saved attributes: name and parameter value (undecoded values carry `raw`). */
  attributes?: { name: string; value?: unknown; raw?: string }[]
  /** A CKBeObject's scripts (file indices). */
  scripts?: number[]
  /**
   * Delete-mode dependency links (file indices): an entity's meshes and
   * current mesh, object animations and target; a mesh's face and channel
   * materials; a material's texture slots; a curve's control points; a data
   * array's object cells.
   */
  meshes?: number[]
  materials?: number[]
  textures?: number[]
  currentMesh?: number
  animations?: number[]
  target?: number
  controlPoints?: number[]
  channelMaterials?: number[]
  cells?: number[]
  /** Linked names the export could not resolve (used twice in their class). */
  ambiguous?: string[]
}

/** RCKCamera's saved projection (chunk 0xFC00000, RCKCamera::Load 0x1000F396). */
export interface OriginalCameraState {
  projection: 'perspective' | 'orthographic'
  horizontalFov: number
  zoom: number
  aspect: [number, number]
  near: number
  far: number
}

/** RCKLight's saved state (chunk 0x400000, RCKLight::Load 0x1001B50E). */
export interface OriginalLightState {
  /** 1 point, 2 spot, 3 directional. */
  type: 1 | 2 | 3
  /** Packed light flags; 0x200 is the specular flag. */
  flags: number
  /** RGBA floats. */
  color: [number, number, number, number]
  /** Point/spot attenuation: constant, linear, quadratic. */
  attenuation: [number, number, number]
  range: number
  power: number
  /** Spot lights: the three saved angle/flatness floats (names not decoded). */
  spot?: [number, number, number]
}

/** A CKCurvePoint's saved settings (RCKCurvePoint::Load 0x1001701D). */
export interface OriginalCurvePoint {
  id: number
  tension: number
  continuity: number
  bias: number
  linear: boolean
  savedTangents: boolean
  incoming: [number, number, number]
  outgoing: [number, number, number]
}

/** A CKObjectAnimation's linear key controllers (keys in frames: time, then the value). */
export interface OriginalObjectAnimationData {
  entity: number
  /** 0x04 position, 0x08 rotation, 0x10 scale disabled; 0x80 merged. */
  flags: number
  /** The controllers' length in frames. */
  length: number
  controllers: { type: string; track: 'position' | 'rotation' | 'scale' | 'scaleaxis'; interpolation: string; keys: number; stride: number; data: number[] }[]
}

export interface OriginalObjectTable {
  source: string
  objects: OriginalFileObject[]
  /** The document's attribute table: name -> parameter type GUID ('' for none). */
  attributeTypes?: Record<string, string>
  /** A document saved with a CKLevel: its level scene's render settings. */
  levelScene?: Record<string, number>
}

/** CK class ids (CKDefines.h). */
export const CKCID = {
  OBJECT: 1, PARAMETERIN: 2, PARAMETEROUT: 3, PARAMETEROPERATION: 4, STATE: 5, BEHAVIORLINK: 6, BEHAVIOR: 8,
  BEHAVIORIO: 9, SCENE: 10, SCENEOBJECT: 11, RENDERCONTEXT: 12, KINEMATICCHAIN: 13, OBJECTANIMATION: 15,
  ANIMATION: 16, KEYEDANIMATION: 18, BEOBJECT: 19, SYNCHRO: 20, LEVEL: 21, PLACE: 22, GROUP: 23, SOUND: 24,
  WAVESOUND: 25, MIDISOUND: 26, '2DENTITY': 27, SPRITE: 28, SPRITETEXT: 29, MATERIAL: 30, TEXTURE: 31, MESH: 32,
  '3DENTITY': 33, CAMERA: 34, TARGETCAMERA: 35, CURVEPOINT: 36, SPRITE3D: 37, LIGHT: 38, TARGETLIGHT: 39,
  CHARACTER: 40, '3DOBJECT': 41, BODYPART: 42, CURVE: 43, PARAMETERLOCAL: 45, PARAMETER: 46, RENDEROBJECT: 47,
  INTERFACEOBJECTMANAGER: 48, CRITICALSECTION: 49, GRID: 50, LAYER: 51, DATAARRAY: 52, PATCHMESH: 53,
} as const

/**
 * Each class's parent, as CKGlobals.cpp (CK2) and CK2_3D.cpp register them
 * (CKCLASSREGISTER / CKCLASSREGISTERCID).
 */
const PARENT: Record<number, number> = {
  [CKCID.PARAMETERIN]: CKCID.OBJECT, [CKCID.PARAMETER]: CKCID.OBJECT, [CKCID.PARAMETEROUT]: CKCID.PARAMETER,
  [CKCID.PARAMETERLOCAL]: CKCID.PARAMETER, [CKCID.PARAMETEROPERATION]: CKCID.OBJECT, [CKCID.BEHAVIORLINK]: CKCID.OBJECT,
  [CKCID.BEHAVIORIO]: CKCID.OBJECT, [CKCID.SCENEOBJECT]: CKCID.OBJECT, [CKCID.SYNCHRO]: CKCID.OBJECT, [CKCID.STATE]: CKCID.OBJECT,
  [CKCID.CRITICALSECTION]: CKCID.OBJECT, [CKCID.INTERFACEOBJECTMANAGER]: CKCID.OBJECT, [CKCID.BEOBJECT]: CKCID.SCENEOBJECT,
  [CKCID.BEHAVIOR]: CKCID.SCENEOBJECT, [CKCID.SCENE]: CKCID.BEOBJECT, [CKCID.LEVEL]: CKCID.BEOBJECT, [CKCID.GROUP]: CKCID.BEOBJECT,
  [CKCID.SOUND]: CKCID.BEOBJECT, [CKCID.DATAARRAY]: CKCID.BEOBJECT, [CKCID.WAVESOUND]: CKCID.SOUND, [CKCID.MIDISOUND]: CKCID.SOUND,
  [CKCID.RENDERCONTEXT]: CKCID.OBJECT, [CKCID.KINEMATICCHAIN]: CKCID.OBJECT, [CKCID.MATERIAL]: CKCID.BEOBJECT,
  [CKCID.TEXTURE]: CKCID.BEOBJECT, [CKCID.MESH]: CKCID.BEOBJECT, [CKCID.PATCHMESH]: CKCID.MESH, [CKCID.ANIMATION]: CKCID.SCENEOBJECT,
  [CKCID.KEYEDANIMATION]: CKCID.ANIMATION, [CKCID.OBJECTANIMATION]: CKCID.SCENEOBJECT, [CKCID.LAYER]: CKCID.OBJECT,
  [CKCID.RENDEROBJECT]: CKCID.BEOBJECT, [CKCID['2DENTITY']]: CKCID.RENDEROBJECT, [CKCID['3DENTITY']]: CKCID.RENDEROBJECT,
  [CKCID.CAMERA]: CKCID['3DENTITY'], [CKCID.LIGHT]: CKCID['3DENTITY'], [CKCID.CURVEPOINT]: CKCID['3DENTITY'],
  [CKCID.CURVE]: CKCID['3DENTITY'], [CKCID['3DOBJECT']]: CKCID['3DENTITY'], [CKCID.SPRITE3D]: CKCID['3DENTITY'],
  [CKCID.CHARACTER]: CKCID['3DENTITY'], [CKCID.PLACE]: CKCID['3DENTITY'], [CKCID.GRID]: CKCID['3DENTITY'],
  [CKCID.BODYPART]: CKCID['3DOBJECT'], [CKCID.TARGETCAMERA]: CKCID.CAMERA, [CKCID.TARGETLIGHT]: CKCID.LIGHT,
  [CKCID.SPRITE]: CKCID['2DENTITY'], [CKCID.SPRITETEXT]: CKCID.SPRITE,
}

/**
 * `CKParameterManager::TypeToClassID` for the object parameter types (CKPGUID_*
 * of CKEnums.h, as exported: the GUID's two dwords, little-endian bytes).
 */
const PARAMETER_CLASS: Record<string, number> = {
  ab20ec307d51f66d: CKCID.OBJECT, '7907d871f3422f40': CKCID.BEOBJECT, '372ddf5b1f73ea64': CKCID.SCENEOBJECT,
  d5058a5bd428ea31: CKCID['3DENTITY'], '1b150f5cfd47056f': CKCID.GROUP, f1524d02b2238267: CKCID.DATAARRAY,
  '6d17a47e305d401b': CKCID.BEHAVIOR, db196b284f5d1821: CKCID.BEHAVIOR, '10441940803f773a': CKCID.SOUND,
  '5e4ef74bef09f445': CKCID.WAVESOUND, '8b21814b5e14b72e': CKCID.MIDISOUND, cd12ab558b6aae22: CKCID.MATERIAL,
  '70285b15f8793618': CKCID.TEXTURE, '455353242952d165': CKCID.MESH, '6f4df23cf9046221': CKCID.CAMERA,
  '6575d81189790b5d': CKCID.TARGETCAMERA, '2f416d4b16141e5d': CKCID.LIGHT, fc225f4ed4094719: CKCID.TARGETLIGHT,
  e37116180315dc1b: CKCID['2DENTITY'], a82e7e576919905b: CKCID.SPRITE, e3692e5c096f15fe: CKCID.SPRITETEXT,
  '0b137210ba72951f': CKCID.CURVE, '4f19c55c79283472': CKCID.CURVEPOINT, '645c98357213af51': CKCID.CHARACTER,
  '0e01a14b026dbd7a': CKCID.BODYPART, ed309524f365084c: CKCID.PLACE, '87475810772f9376': CKCID.LEVEL,
  d76bae25a2738f7c: CKCID.SCENE, '58637065507b6263': CKCID.RENDEROBJECT, '1b06c823273a0370': CKCID.SPRITE3D,
  f84d2e3639354417: CKCID['3DOBJECT'], '1c4e5b30e67aa03d': CKCID.KINEMATICCHAIN, '4d47fa5b3602e619': CKCID.ANIMATION, '506547430e2ce511': CKCID.OBJECTANIMATION,
}

/** The CK class an object parameter type holds, or undefined for a non-object type. */
export function originalParameterClass(type: string | undefined): number | undefined {
  return type === undefined ? undefined : PARAMETER_CLASS[type]
}

/** `CKIsChildClassOf(cid, parent)`: the class or one of its ancestors is `parent`. */
export function originalIsChildClassOf(cid: number, parent: number): boolean {
  for (let current: number | undefined = cid; current !== undefined; current = current === CKCID.OBJECT ? undefined : PARENT[current]) {
    if (current === parent) return true
    if (current !== CKCID.OBJECT && PARENT[current] === undefined) throw new Error(`CK class ${current} has no recovered parent`)
  }
  return false
}

/** A live object of the context. */
export interface OriginalObject {
  readonly id: number
  readonly name: string
  readonly classId: number
  /** The document it was loaded from; undefined for a created object. */
  readonly document?: string
  readonly dynamic: boolean
  /** A CKCamera's saved projection. */
  readonly camera?: OriginalCameraState
  /** A CKLight's live state (the saved one, then Set Light Color). */
  light?: OriginalLightState
  /** A CKMaterial's saved colours and texture slot 0, for documents without a render export. */
  readonly material?: OriginalFileObject['material']
  members?: number[]
  /** State the building blocks set (a sound's file, a material's blend modes, ...), by CK member name. */
  readonly state: Record<string, unknown>
  /** CKBeObject attributes: name -> parameter value (undefined without a parameter). */
  readonly attributes: Map<string, unknown>
  /**
   * The scene initial value (`CKScene::SetObjectInitialValue`) of the
   * non-transform state, when one was saved: attributes (absent when the value
   * holds none), state and a 2D entity's material; or only the class of a level
   * scene value whose chunk is not decoded.
   */
  initial?: { attributes?: Map<string, unknown>; state: Record<string, unknown>; materials?: number[] } | { undecodedClass: number }
  /** A curve's points (CK_IDs) and their saved TCB settings; an animation's keys and driven entity (CK_ID). */
  readonly curve?: { closed: boolean; fitting: number; points: OriginalCurvePoint[] }
  readonly animation?: OriginalObjectAnimationData | { undecoded: string }
  /** CK_3DENTITY_FLAGS as loaded. */
  readonly entityFlags?: number
  /** Owned scripts and dependency links, as CK_IDs. */
  scripts?: number[]
  meshes?: number[]
  materials?: number[]
  textures?: number[]
  currentMesh?: number
  animations?: number[]
  target?: number
  controlPoints?: number[]
  channelMaterials?: number[]
  cells?: number[]
  ambiguous?: string[]
  /** The saved CKSceneObjectDesc flags (START_ACTIVATE 1, START_DEACTIVATE 0x10, START_RESET 0x40, ...). */
  readonly sceneFlags?: number
  /** Whether the object is active in the scene (its desc's ACTIVE): the behavior manager runs its scripts. */
  sceneActive: boolean
  /** A mesh's vertices, faces and face materials, from the document's render export. */
  geometry?: OriginalMeshGeometry
}

/** CKParameter type GUIDs whose default value is known (CKPGUID_INT, FLOAT, STRING, BOOL). */
const ATTRIBUTE_DEFAULT: Record<string, unknown> = {
  fd16575ad776e244: 0, '3f4c8847202c2c43': 0, e210d06bea175611: '', '8e2ad51a2019745e': false,
}

/** Data path kinds of CKPathManager (DATA_PATH_IDX, SOUND_PATH_IDX, BITMAP_PATH_IDX). */
export type OriginalPathKind = 'data' | 'sound' | 'bitmap'

/**
 * Copy dependency options (CKDependencies in copy mode): NONE, FULL, or a
 * per-class flag table whose missing entries take the registered defaults.
 */
export interface OriginalCopyDependencies {
  mode: 'none' | 'full' | 'custom'
  classes: Record<number, number>
}

/** CKCLASSDEFAULTCOPYDEPENDENCIES registrations (CKObject, CKSceneObject, CKBeObject: name; 3D entity: children and animations; data array: data). */
const DEFAULT_COPY: Record<number, number> = { 1: 1, 11: 1, 19: 1, 33: 6, 52: 2 }

/** CKCLASSDEFAULTOPTIONS: classes whose copies may reuse a current object keep their names. */
const CAN_USE_CURRENT = new Set<number>([30, 32])

/**
 * The 3D entity classes whose PrepareDependencies is RCK3dEntity's
 * (CK2_3D.dll 0x1000B4D5): the plain entity, camera, curve point, light,
 * 3D object and curve; the target camera and target light add a target.
 */
const ENTITY_SAME_RULE = new Set<number>([CKCID['3DENTITY'], CKCID.CAMERA, CKCID.TARGETCAMERA, CKCID.CURVEPOINT,
  CKCID.LIGHT, CKCID.TARGETLIGHT, CKCID['3DOBJECT'], CKCID.CURVE, CKCID.SPRITE3D])

/**
 * A dependency-options parameter as saved by CKDependenciesSaver (copy and
 * delete modes): the chunk identifier 0x12248766 (NONE), 0x12248767 (FULL) or
 * 0x12248768 (CUSTOM) followed by (class, flags) pairs that differ from the
 * defaults.
 */
export function originalDependencies(raw: string, label = 'Copy'): OriginalCopyDependencies {
  const words = (raw.match(/.{8}/g) ?? []).map(word => Number.parseInt(word.match(/../g)!.reverse().join(''), 16))
  const marker = words.findIndex(word => word >= 0x12248766 && word <= 0x12248768)
  if (marker < 0) throw new Error(`${label} dependencies have no recovered mode`)
  if (words[marker] === 0x12248766) return { mode: 'none', classes: {} }
  if (words[marker] === 0x12248767) return { mode: 'full', classes: {} }
  // The pairs follow the identifier's next-position word; the chunk ends with two trailer words.
  const pairs = words.slice(marker + 2, words.length - 2)
  if (pairs.length % 2) throw new Error(`${label} dependencies have an odd class table`)
  const classes: Record<number, number> = {}
  for (let i = 0; i < pairs.length; i += 2) classes[pairs[i]!] = pairs[i + 1]!
  return { mode: 'custom', classes }
}

/** The copy-mode saved dependency options (`Object Copy`). */
export const originalCopyDependencies = (raw: string): OriginalCopyDependencies => originalDependencies(raw, 'Copy')

/**
 * A context object as a parameter value. CK object parameters hold CK_IDs;
 * the graph runtime holds names, which collide (a texture and its material,
 * module copies), so context objects travel as `#<id>`. No exported name
 * starts with `#`.
 */
export const originalObjectReference = (id: number) => `#${id}`

/** CKSceneObjectDesc flags. */
export const SCENE_START_ACTIVATE = 0x1, SCENE_START_RESET = 0x40, SCENE_INTERNAL_IC = 0x80

function referenceId(value: string): number | undefined {
  return /^#\d+$/.test(value) ? Number(value.slice(1)) : undefined
}

/** Classes CKFile::FinishLoading lists as they load (its inclusion set). */
function listedOnLoad(classId: number): boolean {
  return originalIsChildClassOf(classId, CKCID.BEOBJECT) || originalIsChildClassOf(classId, CKCID.OBJECTANIMATION) ||
    originalIsChildClassOf(classId, CKCID.ANIMATION)
}

/**
 * CKContext objects. `load` creates a document's objects with fresh IDs and
 * returns the list CKFile::FinishLoading fills; the document's scripts are the
 * graph runtime's, so they are not part of this table.
 */
export class OriginalContext {
  private readonly objects = new Map<number, OriginalObject>()
  private readonly meshes: (document: string, name: string) => OriginalMeshGeometry | undefined
  /**
   * Every 3D entity's transform and parenting (CK3dEntity), keyed by its
   * reference: world, local and inverse matrices with VxMath's rounding.
   */
  readonly entities = new OriginalEntityGraph()
  /** The CKRenderContext's state the blocks set: the camera its viewpoint is attached to and the fonts by name. */
  readonly render: GraphRenderState = { fonts: new Map() }
  /**
   * The render manager's 2D roots (Get2dRoot(TRUE) / Get2dRoot(FALSE)): the
   * parentless 2D entities by id, in their children-array order.
   */
  readonly roots2d: { background: number[]; foreground: number[] } = { background: [], foreground: [] }
  /** The size of a texture's image (the host reads its file); undefined fails loudly where it is needed. */
  textureImageSize?: (texture: OriginalObject) => { width: number; height: number } | undefined
  /** A wave sound's format sample rate (the host reads the WAV header); undefined fails loudly where a pitch needs it. */
  waveSampleRate?: (sound: OriginalObject) => number | undefined
  private nextId = 1
  private readonly tables: (stem: string) => OriginalObjectTable | undefined
  /** Each loaded document's file object index -> runtime id (a saved graph reference). */
  private readonly fileIds = new Map<string, Map<number, number>>()
  /** CKAttributeManager: each attribute's parameter type and its carriers in the order they got it. */
  private readonly attributeTypes = new Map<string, string>()
  private readonly carriers = new Map<string, number[]>()
  /** `CKPathManager::ResolveFileName`: the resolved path of a file in the user's game data, or undefined. */
  readonly resolveFile: (path: string, kind: OriginalPathKind) => string | undefined

  constructor(tables: (stem: string) => OriginalObjectTable | undefined,
    resolveFile: (path: string, kind: OriginalPathKind) => string | undefined = () => undefined,
    meshes: (document: string, name: string) => OriginalMeshGeometry | undefined = () => undefined) {
    this.tables = tables
    this.resolveFile = resolveFile
    this.meshes = meshes
  }

  get(id: number): OriginalObject | undefined { return this.objects.get(id) }

  /** A loaded document's object by its saved file index (`CKObject::GetID` before remap). */
  objectByFile(document: string, index: number): OriginalObject | undefined {
    const id = this.fileIds.get(document.toLowerCase())?.get(index)
    return id === undefined ? undefined : this.objects.get(id)
  }

  /** Whether the object is a 3D entity with a transform. */
  isEntity(id: number): boolean { return this.entities.has(originalObjectReference(id)) }

  /** A 3D entity's parent (`CK3dEntity::GetParent`), or undefined. */
  parentOf(id: number): number | undefined {
    const reference = originalObjectReference(id)
    const parent = this.entities.has(reference) ? this.entities.parent(reference) : undefined
    return parent === undefined ? undefined : referenceId(parent)
  }

  /** A 3D entity's children in m_Children order. */
  childrenOf(id: number): number[] {
    const reference = originalObjectReference(id)
    return this.entities.has(reference) ? this.entities.children(reference).map(child => referenceId(child)!) : []
  }

  /**
   * `Ray Intersection` candidates: the filter group's members, or every 3D
   * object, then character, then 3D sprite (`GetObjectsListByClassID`, each
   * an exact class list in creation order). A candidate with a current mesh
   * whose geometry was not exported fails loudly.
   */
  rayCandidates(group?: OriginalObject): OriginalRayEntity[] {
    const objects = group
      ? (group.members ?? []).map(id => this.objects.get(id)).filter((object): object is OriginalObject => object !== undefined)
      : [CKCID['3DOBJECT'], CKCID.CHARACTER, CKCID.SPRITE3D].flatMap(classId => [...this.objects.values()].filter(object => object.classId === classId))
    return objects.filter(object => this.isEntity(object.id)).map(object => {
      const reference = originalObjectReference(object.id)
      const meshId = object.meshes?.[0]
      const mesh = meshId === undefined ? undefined : this.objects.get(meshId)
      if (mesh && !mesh.geometry) throw new Error(`Mesh ${mesh.name} of ${object.name} has no exported geometry`)
      return {
        reference, classId: object.classId, visible: this.entities.visible(reference),
        world: this.entities.world(reference), inverseWorld: this.entities.inverse(reference),
        ...(mesh?.geometry ? { mesh: mesh.geometry } : {}),
      }
    })
  }

  /** `GetObjectsListByClassID`: the objects of exactly this class, in creation order. */
  objectsOfClass(classId: number): OriginalObject[] {
    return [...this.objects.values()].filter(object => object.classId === classId)
  }

  /** An entity's current mesh (`GetCurrentMesh`), failing loudly when its geometry was not exported. */
  currentMesh(id: number): OriginalObject | undefined {
    const owner = this.objects.get(id)
    const mesh = owner?.meshes?.[0] === undefined ? undefined : this.objects.get(owner.meshes[0])
    if (mesh && !mesh.geometry) throw new Error(`Mesh ${mesh.name} of ${owner!.name} has no exported geometry`)
    return mesh
  }

  /**
   * A mesh's material per exported slot (CKMesh's material groups, group 0
   * holding the faces without a material): the context links the materials of
   * the slots that have one, in order, so the two lists must align.
   */
  materialSlots(id: number): (number | undefined)[] {
    const mesh = this.objects.get(id)
    if (!mesh?.geometry) throw new Error(`Mesh #${id} has no exported geometry`)
    const slots = mesh.geometry.materials
    const linked = mesh.materials ?? []
    const used = slots.filter(slot => slot !== undefined).length
    if (mesh.ambiguous?.length || linked.length !== used) {
      throw new Error(`Mesh ${mesh.name} has ${used} material slots but ${linked.length} linked materials${mesh.ambiguous?.length ? ` (ambiguous: ${mesh.ambiguous.join(', ')})` : ''}`)
    }
    let next = 0
    return slots.map(slot => slot === undefined ? undefined : linked[next++]!)
  }

  /** The object whose scripts include this behavior (`CKBehavior::GetOwner`), or undefined. */
  scriptOwner(id: number): OriginalObject | undefined {
    for (const object of this.objects.values()) if (object.scripts?.includes(id)) return object
    return undefined
  }

  /** Documents loaded with a level scene (`CKLevel`), whose scripts start as the scene says. */
  readonly levelDocuments = new Set<string>()
  /** Each level document's scene render settings (CKScene RENDERSETTINGS and environment flags). */
  readonly levelScenes = new Map<string, Record<string, number>>()

  /** A 3D entity's world matrix (Virtools row-major, original units). */
  worldMatrix(id: number): number[] | undefined {
    const reference = originalObjectReference(id)
    return this.entities.has(reference) ? this.entities.world(reference) : undefined
  }

  /** The dynamic objects (`CKContext::DestroyAllDynamicObjects`), in creation order. */
  dynamicObjects(): OriginalObject[] {
    return [...this.objects.values()].filter(object => object.dynamic)
  }

  /** Every live object with the name, in creation order. */
  byName(name: string): OriginalObject[] {
    return [...this.objects.values()].filter(object => object.name === name)
  }

  /**
   * `CKContext::GetObjectByNameAndParentClass(name, cid, NULL)`: the first live
   * object (lowest CK_ID) with that name whose class derives from `cid`.
   */
  findByClass(name: string, cid: number): OriginalObject | undefined {
    for (const object of this.objects.values()) {
      if (object.name === name && originalIsChildClassOf(object.classId, cid)) return object
    }
    return undefined
  }

  /** A `#<id>` reference exactly; a name only when one live object has it. Ambiguous names fail loudly. */
  resolve(value: string): OriginalObject | undefined {
    const id = referenceId(value)
    if (id !== undefined) return this.objects.get(id)
    const named = this.byName(value)
    if (named.length > 1) throw new Error(`Object name ${value} is ambiguous in the context (${named.length} objects)`)
    return named[0]
  }

  /** `CKContext::Load` of a file path: the document is resolved by its base name, case-insensitively. */
  load(path: string, dynamic: boolean): OriginalObject[] | undefined {
    const stem = path.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')
    const table = this.tables(stem)
    if (!table) return undefined
    for (const [name, type] of Object.entries(table.attributeTypes ?? {})) {
      const known = this.attributeTypes.get(name)
      if (known !== undefined && known !== type) throw new Error(`Attribute ${name} has type ${type} in ${table.source} but ${known} elsewhere`)
      this.attributeTypes.set(name, type)
    }
    const ids = new Map<number, number>()
    for (const file of table.objects) ids.set(file.index, this.nextId++)
    this.fileIds.set(table.source.toLowerCase(), ids)
    if (table.levelScene) { this.levelDocuments.add(table.source); this.levelScenes.set(table.source, table.levelScene) }
    const created = table.objects.map(file => {
      const object: OriginalObject = {
        id: ids.get(file.index)!, name: file.name, classId: file.class, document: table.source, dynamic, attributes: new Map(),
        // A wave sound loads its saved members; its file is the saved name (Sound Load writes a resolved one).
        state: file.sound ? (({ file: fileName, ...members }) => ({ fileName, ...members }))(file.sound)
          : file.entity2d ? { ...original2dFromSaved(file.entity2d, file.hidden === true) }
          // A material's live colours: Get Diffuse/Emissive Color read them, Set Diffuse/Emissive write them.
          : file.material ? { diffuse: [...file.material.diffuse], emissive: [...file.material.emissive] }
          : {},
        ...(file.camera ? { camera: file.camera } : {}),
        ...(file.light ? { light: structuredClone(file.light) } : {}),
        ...(file.material ? { material: file.material } : {}),
        ...(file.members ? { members: file.members.map(member => ids.get(member)).filter((id): id is number => id !== undefined) } : {}),
        ...Object.fromEntries((['scripts', 'meshes', 'materials', 'textures', 'animations', 'controlPoints', 'channelMaterials', 'cells'] as const)
          .filter(key => file[key])
          .map(key => [key, file[key]!.map(index => ids.get(index)).filter((id): id is number => id !== undefined)])),
        ...(file.currentMesh !== undefined ? { currentMesh: ids.get(file.currentMesh)! } : {}),
        ...(file.target !== undefined ? { target: ids.get(file.target)! } : {}),
        ...(file.ambiguous ? { ambiguous: [...file.ambiguous] } : {}),
        // CKScene::Init (a level's scene) and CKScene::AddObject (a loaded document's record) both
        // activate a START_ACTIVATE object; anything else, or no record, joins the scene inactive.
        ...(file.sceneFlags !== undefined ? { sceneFlags: file.sceneFlags } : {}),
        ...(file.curve ? { curve: { closed: file.curve.closed, fitting: file.curve.fitting, points: file.curve.points.map(({ index, ...point }) => ({ id: ids.get(index)!, ...point })) } } : {}),
        ...(file.animation ? { animation: 'undecoded' in file.animation ? file.animation : { ...file.animation, entity: ids.get(file.animation.entity)! } } : {}),
        ...(file.entityFlags !== undefined ? { entityFlags: file.entityFlags } : {}),
        sceneActive: ((file.sceneFlags ?? 0) & SCENE_START_ACTIVATE) !== 0,
      }
      if (originalIsChildClassOf(file.class, CKCID.MESH)) {
        const geometry = this.meshes(table.source, file.name)
        if (geometry) object.geometry = geometry
      }
      this.objects.set(object.id, object)
      // A level scene's initial value (CKScene::Load); a level-less document's record with INTERNAL_IC (0x80)
      // makes CKScene::AddObjectDesc save the object's state as it loaded (UNVERIFIED for loads without AddToScene).
      if (file.initial && 'class' in file.initial) object.initial = { undecodedClass: file.initial.class }
      else if (file.initial) {
        object.initial = {
          state: original2dFromSaved(file.initial.entity2d, file.initial.hidden) as unknown as Record<string, unknown>,
          materials: file.initial.materials.map(index => ids.get(index)).filter((id): id is number => id !== undefined),
        }
      }
      // An undecoded value is kept as its raw bytes; reading it fails loudly.
      for (const attribute of file.attributes ?? []) this.addAttribute(object, attribute.name, attribute.raw !== undefined ? { raw: attribute.raw } : attribute.value)
      return object
    })
    for (const object of created) {
      // INTERNAL_IC: the saved state after Load (attributes included).
      if (!table.levelScene && ((object.sceneFlags ?? 0) & SCENE_INTERNAL_IC)) {
        object.initial = { attributes: new Map(object.attributes), state: structuredClone(object.state), ...(object.materials ? { materials: [...object.materials] } : {}) }
      }
      // RCK2dEntity::Load ends with SetParent(NULL): the entity joins its root.
      if (originalIsChildClassOf(object.classId, CKCID['2DENTITY'])) this.append2d(object)
    }
    // Each entity loads as CK3dEntity::Load does: SetParent(saved, TRUE), then SetWorldMatrix(saved, TRUE);
    // CKObject::Load clears CK_OBJECT_VISIBLE for a hidden one.
    this.entities.add(table.objects.filter(file => file.matrix).map(file => ({
      name: originalObjectReference(ids.get(file.index)!), matrix: file.matrix!, visible: !file.hidden,
      ...(file.parent !== undefined && table.objects.some(item => item.index === file.parent && item.matrix) ? { parent: originalObjectReference(ids.get(file.parent)!) } : {}),
    })))
    // FinishLoading lists BeObjects and animations as they load, then the scripts.
    return [...created.filter(object => listedOnLoad(object.classId)), ...created.filter(object => object.classId === CKCID.BEHAVIOR)]
  }

  /** `CKContext::CreateObject` (a group starts empty). */
  create(classId: number, name: string, dynamic: boolean): OriginalObject {
    // A new wave sound has CKWaveSound's constructor members (CK2.dll, vtable 0x2403FB60):
    // m_State 1 (2D), gain 1, and the 2D settings its sources start from (priority 0.5, pitch 1, pan 0).
    const state = classId === CKCID.WAVESOUND ? { state: 1, gain: 1, priority: 0.5, pitch: 1, pan: 0 } : {}
    const object: OriginalObject = { id: this.nextId++, name, classId, dynamic, state, attributes: new Map(), sceneActive: false, ...(classId === CKCID.GROUP ? { members: [] } : {}) }
    this.objects.set(object.id, object)
    // A new 3D entity starts at the identity, without a parent.
    if (originalIsChildClassOf(classId, CKCID['3DENTITY'])) this.entities.add([{ name: originalObjectReference(object.id), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }])
    return object
  }

  /** `CKGroup::AddObject`: refused for a member already present. */
  addToGroup(group: OriginalObject, object: OriginalObject): boolean {
    if (!group.members) throw new Error(`${group.name} is not a group`)
    if (group.members.includes(object.id)) return false
    group.members.push(object.id)
    return true
  }

  private addAttribute(object: OriginalObject, name: string, value: unknown): void {
    if (!object.attributes.has(name)) {
      const list = this.carriers.get(name) ?? []
      list.push(object.id)
      this.carriers.set(name, list)
    }
    object.attributes.set(name, value)
  }

  /**
   * `CKBeObject::SetAttribute`: a missing attribute is added with its type's
   * default value. With `value` (Set Attribute's copy right after) the
   * default is overwritten at once, so only the value is kept.
   */
  setAttribute(object: OriginalObject, name: string, value?: unknown): void {
    if (object.attributes.has(name)) { if (value !== undefined) object.attributes.set(name, value); return }
    const type = this.attributeTypes.get(name)
    if (type === undefined) throw new Error(`Attribute ${name} is not registered in any loaded document`)
    if (value !== undefined) { this.addAttribute(object, name, value); return }
    if (type !== '' && !(type in ATTRIBUTE_DEFAULT)) throw new Error(`Attribute ${name} of type ${type} has no recovered default value`)
    this.addAttribute(object, name, type === '' ? undefined : ATTRIBUTE_DEFAULT[type])
  }

  /** `CKBeObject::RemoveAttribute`. */
  removeAttribute(object: OriginalObject, name: string): void {
    if (!object.attributes.delete(name)) return
    this.carriers.set(name, (this.carriers.get(name) ?? []).filter(id => id !== object.id))
  }

  /** `CKAttributeManager::GetAttributeListPtr`: the live carriers in the manager's order. */
  attributeCarriers(name: string): OriginalObject[] {
    return (this.carriers.get(name) ?? []).map(id => this.objects.get(id)).filter((object): object is OriginalObject => object !== undefined)
  }

  /**
   * `CKContext::DestroyObjects` in CK_DEPENDENCIES_DELETE mode (2): the object
   * and what its class's PrepareDependencies adds. `dependencies` is true for
   * CK_DEPENDENCIES_FULL (every class's mask 0xFFFF), false for NONE (mask 0),
   * or the saved dependencies: a custom mode has the saved mask per class
   * (classes the table omits are 0). Every BeObject takes its scripts, since
   * DELETE always takes them; with a mask a 3D entity also takes its meshes,
   * children and object animations, a camera or light its target, a mesh its
   * face and channel materials, a material its textures, a 2D entity its
   * material, a data array its object cells and a group its members (not
   * levels or scenes). A curve always takes its control points and current
   * mesh. Returns the destroyed IDs.
   */
  destroyWithDependencies(id: number, dependencies: boolean | OriginalCopyDependencies): number[] {
    // CKDependenciesContext::GetClassDependencies (CK2.dll 0x2401CC9E): FULL is 0xFFFF for every
    // class, NONE is 0, and CUSTOM reads the saved class table (0 for an omitted class).
    const mask = (cid: number) => typeof dependencies === 'boolean' ? (dependencies ? 0xffff : 0)
      : dependencies.mode === 'full' ? 0xffff : dependencies.mode === 'none' ? 0 : dependencies.classes[cid] ?? 0
    const bits = (cid: number, bit: number) => (mask(cid) & bit) !== 0
    const doomed = new Set<number>()
    const skipLevelOrScene = (object: OriginalObject) =>
      originalIsChildClassOf(object.classId, CKCID.LEVEL) || originalIsChildClassOf(object.classId, CKCID.SCENE)
    const visit = (current: number | undefined) => {
      if (current === undefined) return
      const object = this.objects.get(current)
      if (!object || doomed.has(current)) return
      doomed.add(current)
      const is = (cid: number) => originalIsChildClassOf(object.classId, cid)
      // CKBehavior::PrepareDependencies (CK2.dll 0x240063E3) is CKObject's plus, in DELETE mode,
      // CKM_BEHAVIORDETACH (callback index 4, mask 8; the table at 0x24059058 via 0x240049AE) sent
      // to the building block before its children. No port building block has a detach callback;
      // when one gets one, it must be sent here instead of being skipped.
      if (object.classId === CKCID.BEHAVIOR) return
      // CKBeObject::PrepareDependencies (CK2.dll 0x2401C680): DELETE always takes the script array
      // (+0x24); the attribute parameter objects (+0x38) are implicit in the port's attribute map.
      if (is(CKCID.BEOBJECT)) for (const script of object.scripts ?? []) visit(script)
      // CKObjectAnimation::PrepareDependencies (CK2_3D.dll 0x1005C2E1) is CKObject's: it does not
      // take the entity it drives.
      if (object.classId === CKCID.OBJECTANIMATION) return
      if (mask(CKCID['3DENTITY']) !== 0 && object.ambiguous?.length) throw new Error(`Deleting ${object.name} reaches ${object.ambiguous.join(', ')}, which the export could not resolve`)
      if (is(CKCID['3DENTITY'])) {
        // RCK3dEntity::PrepareDependencies (CK2_3D.dll 0x1000B4D5), mask of class 33: bit 1 meshes
        // (array +0x5C), bit 2 children (+0x144), bit 4 object animations (+0x70). The parent is not
        // prepared.
        if (!ENTITY_SAME_RULE.has(object.classId)) throw new Error(`Delete of ${object.name} (class ${object.classId}) has no recovered dependency rules`)
        if (bits(CKCID['3DENTITY'], 1)) for (const mesh of object.meshes ?? []) visit(mesh)
        if (bits(CKCID['3DENTITY'], 2)) for (const child of this.childrenOf(current)) visit(child)
        if (bits(CKCID['3DENTITY'], 4)) for (const animation of object.animations ?? []) visit(animation)
        // A CKSkin ([this+0x7C]) prepares its current mesh and bones; no shipped menu entity has one
        // (UNVERIFIED for others: the port does not model skins).
        if (object.classId === CKCID.TARGETCAMERA && bits(CKCID['3DENTITY'], 1)) visit(object.target)       // 0x1004404D, target +0x1C4
        if (object.classId === CKCID.TARGETLIGHT && bits(CKCID['3DENTITY'], 1)) visit(object.target)        // 0x100446E0, target +0x218
        if (object.classId === CKCID.SPRITE3D && bits(CKCID.SPRITE3D, 1)) {
          // RCKSprite3d::PrepareDependencies (CK2_3D.dll 0x100436BB), mask of class 37, bit 1: the
          // sprite material (+0x1A8). The object export keeps no sprite material link.
          if (!object.materials?.length) throw new Error(`Delete of ${object.name} with its material has no recovered material link`)
          for (const material of object.materials) visit(material)
        }
        if (object.classId === CKCID.CURVE) {
          // RCKCurve::PrepareDependencies (CK2_3D.dll 0x100166A1): the control point array (+0x1A8)
          // and the current mesh ([this+0x68]) are prepared in every mode, with no mask.
          for (const point of object.controlPoints ?? []) visit(point)
          visit(object.currentMesh)
        }
      } else if (is(CKCID['2DENTITY'])) {
        // RCK2dEntity::PrepareDependencies (CK2_3D.dll 0x1005FA5B), mask of class 27, bit 1: the
        // material (+0x94). Bit 2 takes 2D children; the exporter rejects saved 2D parents.
        if (bits(CKCID['2DENTITY'], 1)) for (const material of object.materials ?? []) visit(material)
      } else if (is(CKCID.MESH)) {
        // RCKMesh::PrepareDependencies (CK2_3D.dll 0x10028C15), mask of class 32, bit 1: the face
        // materials (vtbl+0x1D8/+0x1DC), then the channel materials (array +0xC4). PatchMesh's own
        // function (0x1003CB28) is not decoded.
        if (bits(CKCID.MESH, 1)) {
          for (const material of object.materials ?? []) visit(material)
          for (const material of object.channelMaterials ?? []) visit(material)
        }
      } else if (is(CKCID.MATERIAL)) {
        // RCKMaterial::PrepareDependencies (CK2_3D.dll 0x10065DE0), mask of class 30, bit 1: the
        // four texture slots (+0x50..0x5C). The effect CKParameter (+0xEC) is prepared
        // unconditionally but the port has no parameter objects.
        if (bits(CKCID.MATERIAL, 1)) for (const texture of object.textures ?? []) visit(texture)
      } else if (is(CKCID.GROUP)) {
        // CKGroup::PrepareDependencies (CK2.dll 0x2402BF93), mask of class 23, bit 1: the members;
        // DELETE skips Level (21) and Scene (10) members.
        if (bits(CKCID.GROUP, 1)) for (const member of object.members ?? []) {
          const target = this.objects.get(member)
          if (target && !skipLevelOrScene(target)) visit(member)
        }
      } else if (is(CKCID.DATAARRAY)) {
        // CKDataArray::PrepareDependencies (CK2.dll 0x2402A138), mask of class 52, bit 1: OBJECT
        // cells and object-typed PARAMETER cells, skipping Level and Scene. Parameter cells owned
        // by the array are prepared without the mask; the host keeps those arrays implicit.
        if (bits(CKCID.DATAARRAY, 1)) for (const cell of object.cells ?? []) {
          const target = this.objects.get(cell)
          if (target && !skipLevelOrScene(target)) visit(cell)
        }
      } else if (object.classId !== CKCID.BEOBJECT && object.classId !== CKCID.SOUND &&
        object.classId !== CKCID.WAVESOUND && object.classId !== CKCID.TEXTURE) {
        // CKSound, CKWaveSound and CKTexture use CKBeObject::PrepareDependencies unchanged.
        throw new Error(`Delete of ${object.name} (class ${object.classId}) has no recovered dependency rules`)
      }
    }
    visit(id)
    const ids = [...doomed]
    this.destroy(ids)
    return ids
  }

  /**
   * `CKContext::GetObjectSecureName` (CK2.dll 0x240379DD): a trailing
   * three-digit number is set aside, then the name takes the highest suffix
   * among objects of exactly that class sharing the prefix, plus one, as %03d.
   */
  secureName(name: string, cid: number): string {
    let base = name, highest = -1
    if (name.length > 3 && /\d{3}$/.test(name)) { highest = Number.parseInt(name.slice(-3), 10); base = name.slice(0, -3) }
    for (const object of this.objects.values()) {
      if (object.classId !== cid || !object.name.startsWith(base)) continue
      const suffix = object.name.slice(base.length)
      if (suffix) { const number = Number.parseInt(suffix, 10) || 0; if (number > highest) highest = number }
      else if (highest < 0) highest = 0
    }
    return highest === -1 ? base : `${base}${String(highest + 1).padStart(3, '0')}`
  }

  /**
   * `CKContext::CopyObjects`: the sources and what copy-mode PrepareDependencies
   * adds (CK2.dll reads the BeObject entry for every BeObject: scripts, and
   * attributes and groups on copy; a 3D entity's meshes, children and
   * animations; a mesh's materials; a material's textures; a group's members).
   * Copies keep or secure their names per the CKObject entry, take the
   * original's attributes and groups when asked, and their links point to the
   * copies when those were copied. Returns original -> copy IDs.
   */
  copyObjects(sources: readonly number[], deps: OriginalCopyDependencies, dynamic: boolean): Map<number, number> {
    const flags = (cid: number) => deps.mode === 'none' ? 0 : deps.mode === 'full' ? 0xffff : deps.classes[cid] ?? DEFAULT_COPY[cid] ?? 0
    const order: OriginalObject[] = []
    const seen = new Set<number>()
    const visit = (id: number) => {
      const object = this.objects.get(id)
      if (!object || seen.has(id)) return
      seen.add(id)
      order.push(object)
      const is = (cid: number) => originalIsChildClassOf(object.classId, cid)
      if (is(CKCID.BEOBJECT) && flags(CKCID.BEOBJECT) & 1) for (const script of object.scripts ?? []) visit(script)
      if (is(CKCID['3DENTITY'])) {
        // A 3D sprite also copies its material with flag 1 (CK_DEPENDENCIES_COPY_SPRITE3D_MATERIAL).
        if (object.classId === CKCID.SPRITE3D && flags(CKCID.SPRITE3D) & 1) throw new Error(`Copying ${object.name} with its material has no recovered material link`)
        if (![CKCID['3DENTITY'], CKCID['3DOBJECT'], CKCID.SPRITE3D].includes(object.classId as never)) throw new Error(`Copying ${object.name} (class ${object.classId}) has no recovered dependency rules`)
        if (flags(CKCID['3DENTITY']) & 1) for (const mesh of object.meshes ?? []) visit(mesh)
        if (flags(CKCID['3DENTITY']) & 2) for (const child of this.childrenOf(id)) visit(child)
      } else if (is(CKCID['2DENTITY'])) {
        // RCK2dEntity::RemapDependencies (CK2_3D 0x1005FB2D): bit 0 the material, bit 1 the parent (none is saved).
        if (object.classId !== CKCID['2DENTITY']) throw new Error(`Copying ${object.name} (class ${object.classId}) has no recovered dependency rules`)
        if (flags(CKCID['2DENTITY']) & 1) for (const material of object.materials ?? []) visit(material)
      } else if (is(CKCID.MESH)) {
        if (flags(CKCID.MESH) & 1) for (const material of object.materials ?? []) visit(material)
      } else if (is(CKCID.MATERIAL)) {
        if (flags(CKCID.MATERIAL) & 1) for (const texture of object.textures ?? []) visit(texture)
      } else if (is(CKCID.GROUP)) {
        if (flags(CKCID.GROUP) & 1) for (const member of object.members ?? []) visit(member)
      } else if (object.classId !== CKCID.BEHAVIOR && object.classId !== CKCID.TEXTURE) {
        throw new Error(`Copying ${object.name} (class ${object.classId}) has no recovered dependency rules`)
      }
    }
    for (const source of sources) visit(source)
    const map = new Map<number, number>()
    for (const original of order) map.set(original.id, this.nextId++)
    const remap = (id: number) => map.get(id) ?? id
    const objectFlags = flags(CKCID.OBJECT)
    for (const original of order) {
      let name = original.name
      if (objectFlags & 1) {
        if (!CAN_USE_CURRENT.has(original.classId) && objectFlags & 2) name = this.secureName(original.name, original.classId)
      } else {
        throw new Error(`Copying ${original.name} without CK_DEPENDENCIES_COPY_OBJECT_NAME is not supported`)
      }
      const copy: OriginalObject = {
        id: map.get(original.id)!, name, classId: original.classId, document: original.document, dynamic,
        // RCK2dEntity::Copy duplicates its rects (structured state is cloned, not shared).
        state: structuredClone(original.state), attributes: new Map(),
        ...(original.members ? { members: original.members.map(remap) } : {}),
        ...Object.fromEntries((['scripts', 'meshes', 'materials', 'textures', 'animations', 'controlPoints', 'channelMaterials', 'cells'] as const)
          .filter(key => original[key]).map(key => [key, original[key]!.map(remap)])),
        ...(original.currentMesh !== undefined ? { currentMesh: remap(original.currentMesh) } : {}),
        ...(original.target !== undefined ? { target: remap(original.target) } : {}),
        ...(original.ambiguous ? { ambiguous: [...original.ambiguous] } : {}),
        // UNVERIFIED: a copy keeps its original's scene activity (the copier's scene handling is not decoded).
        sceneActive: original.sceneActive,
        ...(original.geometry ? { geometry: original.geometry } : {}),
      }
      this.objects.set(copy.id, copy)
      if (originalIsChildClassOf(original.classId, CKCID.BEOBJECT)) {
        if (flags(CKCID.BEOBJECT) & 2) for (const [attribute, value] of original.attributes) this.addAttribute(copy, attribute, value)
        if (flags(CKCID.BEOBJECT) & 4) {
          for (const group of this.objects.values()) {
            if (group.members?.includes(original.id) && !map.has(group.id) && !group.members.includes(copy.id)) group.members.push(copy.id)
          }
        }
      }
    }
    // RCK2dEntity::Copy calls SetParent(source's parent): a parentless copy joins its root.
    for (const original of order) if (originalIsChildClassOf(original.classId, CKCID['2DENTITY'])) this.append2d(this.objects.get(map.get(original.id)!)!)
    // Copied entities take the originals' world matrices and the copied parents.
    this.entities.add(order.filter(original => this.isEntity(original.id)).map(original => {
      const parent = this.parentOf(original.id)
      return {
        name: originalObjectReference(map.get(original.id)!), matrix: this.worldMatrix(original.id)!,
        visible: this.entities.visible(originalObjectReference(original.id)),
        ...(parent !== undefined ? { parent: originalObjectReference(remap(parent)) } : {}),
      }
    }))
    return map
  }

  /** `CK3dEntity::HierarchyParser` order: the descendants, depth first, children in order. */
  descendants(id: number): OriginalObject[] {
    const result: OriginalObject[] = []
    const visit = (parent: number) => {
      for (const child of this.childrenOf(parent)) { result.push(this.objects.get(child)!); visit(child) }
    }
    visit(id)
    return result
  }

  /** `CKSaveObjectState` + `CKScene::SetObjectInitialValue` for the parts the context models. */
  saveInitial(object: OriginalObject): void {
    if (this.isEntity(object.id)) this.entities.saveInitial(originalObjectReference(object.id))
    object.initial = { attributes: new Map(object.attributes), state: structuredClone(object.state), ...(object.materials ? { materials: [...object.materials] } : {}) }
  }

  /**
   * `CKReadObjectState` of the scene initial value. An entity always has one
   * (its load-time state or a saved one); a 2D entity reloads its rects, flags,
   * visibility and material and rejoins its root (Load's SetParent(NULL)).
   * Without a value nothing happens (Narratives Restore IC). False for a Data
   * Array, whose rows the host holds.
   */
  restoreSaved(object: OriginalObject): boolean {
    if (object.classId === CKCID.DATAARRAY) return false
    const entity = this.isEntity(object.id)
    if (entity) this.entities.restore(originalObjectReference(object.id))
    const initial = object.initial
    if (!initial) return true
    if ('undecodedClass' in initial) throw new Error(`Restore IC of ${object.name}: its class ${initial.undecodedClass} initial value is not decoded`)
    if (initial.attributes) {
      object.attributes.clear()
      for (const [name, value] of initial.attributes) object.attributes.set(name, value)
    }
    for (const key of Object.keys(object.state)) delete object.state[key]
    Object.assign(object.state, structuredClone(initial.state))
    if (originalIsChildClassOf(object.classId, CKCID['2DENTITY'])) {
      object.materials = [...initial.materials ?? []]
      this.append2d(object)
    }
    return true
  }

  /**
   * RCK2dEntity::SetParent(NULL) (CK2_3D 0x1005DD22): out of both roots, onto
   * the end of the one its background flag (0x40) selects, then XArray::Sort:
   * MSVCRT qsort by `a.zOrder - b.zOrder` (0x1005C750), unstable.
   */
  append2d(object: OriginalObject): void {
    const roots = this.roots2d
    for (const list of [roots.foreground, roots.background]) { const i = list.indexOf(object.id); if (i >= 0) list.splice(i, 1) }
    const root = Number(object.state.flags) & 0x40 ? roots.background : roots.foreground
    root.push(object.id)
    if (root.length > 1) {
      const z = (id: number) => Number(this.objects.get(id)!.state.zOrder) | 0
      root.splice(0, root.length, ...crtQsort(root, (a, b) => (z(a) - z(b)) | 0))
    }
  }

  /** `CKContext::DestroyObjects`; destroyed objects also leave their groups and attribute lists. */
  destroy(ids: readonly number[]): void {
    for (const id of ids) { this.entities.remove(originalObjectReference(id)); this.objects.delete(id) }
    for (const root of [this.roots2d.background, this.roots2d.foreground]) root.splice(0, root.length, ...root.filter(id => this.objects.has(id)))
    for (const object of this.objects.values()) if (object.members) object.members = object.members.filter(id => this.objects.has(id))
    for (const [name, list] of this.carriers) this.carriers.set(name, list.filter(id => this.objects.has(id)))
  }
}

/**
 * The context as graph bindings. Loaded objects join the level; the context
 * keeps no separate scene membership yet, so `addToScene` has no further effect.
 */
export function originalContextBinding(context: OriginalContext): GraphContextBinding {
  const resolve = (value: string, label: string) => {
    const object = context.resolve(value)
    if (!object) throw new Error(`${label}: ${value} is not in the context`)
    return object
  }
  return {
    render: context.render,
    load: (path, options) => {
      const loaded = context.load(path, options.dynamic)
      // AddObjectToScene adds render objects to the render context: CKRenderedScene::AddObject (0x1006FAE5)
      // re-appends a parentless 2D entity to its root.
      if (options.addToScene) for (const object of loaded ?? []) if (originalIsChildClassOf(object.classId, CKCID['2DENTITY'])) context.append2d(object)
      return loaded?.map(object => ({ id: object.id, name: object.name, classId: object.classId, root: context.parentOf(object.id) === undefined }))
    },
    unload: ids => context.destroy(ids),
    destroy: (value, dependencies) => {
      const object = context.resolve(value)
      return object ? context.destroyWithDependencies(object.id, dependencies).map(originalObjectReference) : []
    },
    reference: id => context.get(id) ? originalObjectReference(id) : undefined,
    find: (name, cid) => { const object = context.findByClass(name, cid); return object ? originalObjectReference(object.id) : undefined },
    has: value => context.resolve(value) !== undefined,
    objectName: value => context.resolve(value)?.name,
    create: (classId, name, dynamic) => originalObjectReference(context.create(classId, name, dynamic).id),
    addToGroup: (group, object) => context.addToGroup(resolve(group, 'Add To Group'), resolve(object, 'Add To Group')),
    resolveFile: (path, kind) => context.resolveFile(path, kind),
    state: value => {
      const object = resolve(value, 'Object state')
      // CKWaveSound's DirectSound buffer format (GetFormat): the exported sound
      // state has no rate, so the host supplies it from the wave's fmt chunk.
      // Recreate on Sound Load changes the file, hence the cached file name.
      if (object.classId === CKCID.WAVESOUND && object.state.sampleRateFile !== object.state.fileName) {
        const rate = context.waveSampleRate?.(object)
        if (rate !== undefined) {
          object.state.sampleRate = rate
          object.state.sampleRateFile = object.state.fileName
        }
      }
      return object.state
    },
    saveInitial: (value, hierarchy) => {
      const object = resolve(value, 'TT Save IC')
      context.saveInitial(object)
      // Only these classes take the Hierarchy? input (TT_Toolbox_RT SaveIC.cpp).
      const entity = [CKCID['3DENTITY'], CKCID.CAMERA, CKCID.TARGETCAMERA, CKCID.CURVEPOINT, CKCID.SPRITE3D, CKCID.LIGHT,
        CKCID.TARGETLIGHT, CKCID.CHARACTER, CKCID['3DOBJECT'], CKCID.BODYPART, CKCID.CURVE].includes(object.classId as never)
      if (entity && hierarchy) for (const child of context.descendants(object.id)) context.saveInitial(child)
    },
    restoreSaved: value => { const object = context.resolve(value); return object ? context.restoreSaved(object) : false },
    scripts: value => (resolve(value, 'Get Script').scripts ?? []).map(originalObjectReference),
    scriptCount: value => resolve(value, 'Get Script Count').scripts?.length ?? 0,
    matrix: value => { const object = context.resolve(value); return object ? context.worldMatrix(object.id) : undefined },
    // A group name resolves within the Group class (the parameter's type), first match.
    members: group => {
      const object = /^#\d+$/.test(group) ? context.resolve(group) : context.findByClass(group, CKCID.GROUP)
      return object?.members?.map(originalObjectReference)
    },
    classId: value => context.resolve(value)?.classId,
    // A 2D entity's material is its first (only) material dependency.
    material2d: value => { const id = resolve(value, 'GetMaterial').materials?.[0]; return id === undefined ? undefined : originalObjectReference(id) },
    curve: value => {
      const object = context.resolve(value)
      if (!object?.curve) return undefined
      return { closed: object.curve.closed, fitting: object.curve.fitting, points: object.curve.points.map(({ id, ...point }) => ({ reference: originalObjectReference(id), ...point })) }
    },
    entityPosition: (entity, referential) => {
      const reference = (value: string) => originalObjectReference(resolve(value, 'GetPosition').id)
      return context.entities.position(reference(entity), reference(referential)) as [number, number, number]
    },
    animation: value => {
      const object = context.resolve(value)
      const animation = object?.animation
      if (!animation) return undefined
      if ('undecoded' in animation) throw new Error(`CKObjectAnimation ${object.name} is not decoded: ${animation.undecoded}`)
      return { ...animation, entity: originalObjectReference(animation.entity) }
    },
    entityFlags: value => resolve(value, 'GetFlags').entityFlags ?? 0,
    setLocalMatrix: (value, matrix) => context.entities.setLocalMatrix(originalObjectReference(resolve(value, 'SetLocalMatrix').id), matrix, false),
    textureSize: value => {
      const texture = resolve(value, 'Texture size')
      if (texture.classId !== CKCID.TEXTURE) throw new Error(`${texture.name} is not a texture`)
      if (!context.textureImageSize) throw new Error(`The size of ${texture.name} needs the host's texture images`)
      return context.textureImageSize(texture)
    },
    pick2d: point => {
      const id = original2dPick(context, point)
      return id === undefined ? undefined : originalObjectReference(id)
    },
    setMaterial2d: (value, material) => {
      const entity = resolve(value, 'SetMaterial')
      entity.materials = material === undefined ? [] : [resolve(material, 'SetMaterial').id]
    },
    // The context has one scene and no private objects unless a block marks them (state.inScene, state.private).
    objectsOfClass: (classId, options) => context.objectsOfClass(classId)
      .filter(object => !(options.skipPrivate && object.state.private === true))
      .filter(object => !(options.currentSceneOnly && object.state.inScene === false))
      .map(object => originalObjectReference(object.id)),
    textureOf: (value, slot) => {
      const id = context.resolve(value)?.textures?.[slot]
      return id === undefined || !context.get(id) ? undefined : originalObjectReference(id)
    },
    currentMesh: entity => {
      const owner = context.resolve(entity)
      return owner ? context.currentMesh(owner.id)?.geometry : undefined
    },
    setMeshUVs: (entity, uvs) => {
      const owner = context.resolve(entity)
      const mesh = owner ? context.currentMesh(owner.id) : undefined
      if (!mesh?.geometry) throw new Error(`Entity ${entity} has no mesh geometry to update`)
      mesh.geometry = { ...mesh.geometry, uvs }
      mesh.state.uvRevision = Number(mesh.state.uvRevision ?? 0) + 1
    },
    currentMeshReference: entity => {
      const owner = context.resolve(entity)
      const mesh = owner ? context.currentMesh(owner.id) : undefined
      return mesh ? originalObjectReference(mesh.id) : undefined
    },
    boundingBox: (value, local) => {
      const object = context.resolve(value)
      return object ? originalEntityBoundingBox(context, object.id, local) : undefined
    },
    meshMaterial: (value, index) => {
      const object = context.resolve(value)
      if (!object) throw new Error(`GetMaterial on ${value}, which is not in the context`)
      if (originalIsChildClassOf(object.classId, CKCID['2DENTITY'])) {
        if (index < 0) throw new Error(`CK2dEntity::GetMaterial(${index}) on ${object.name} reads before the material list`)
        const id = object.materials?.[index]
        return id === undefined ? undefined : originalObjectReference(id)
      }
      if (!originalIsChildClassOf(object.classId, CKCID.MESH)) throw new Error(`CKMesh::GetMaterial on ${value}, which is not a mesh`)
      const slots = context.materialSlots(object.id)
      // RCKMesh::GetMaterial: m_MaterialGroups[index + 1] when it exists.
      if (index < -1) throw new Error(`CKMesh::GetMaterial(${index}) on ${object.name} reads before the material groups`)
      const id = index + 1 < slots.length ? slots[index + 1] : undefined
      return id === undefined ? undefined : originalObjectReference(id)
    },
  }
}

/** The context's attributes as the graph's attribute binding (objects by reference or name). */
export function originalAttributeBinding(context: OriginalContext): GraphAttributeBinding {
  const resolve = (value: string) => {
    const object = context.resolve(value)
    if (!object) throw new Error(`Attribute call on ${value}, which is not in the context`)
    return object
  }
  return {
    has: (object, attribute) => resolve(object).attributes.has(attribute),
    value: (object, attribute) => {
      const value = resolve(object).attributes.get(attribute)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) throw new Error(`Attribute ${attribute} of ${object} has an undecoded value`)
      return value as GraphParameterValue | undefined
    },
    set: (object, attribute, value) => {
      const target = resolve(object)
      context.setAttribute(target, attribute, value)
    },
    remove: (object, attribute) => context.removeAttribute(resolve(object), attribute),
    carriers: attribute => context.attributeCarriers(attribute).map(object => originalObjectReference(object.id)),
  }
}
