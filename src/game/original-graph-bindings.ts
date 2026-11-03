// Binding contracts the graph runtime uses to reach the engine. Behaviors are
// implemented against these interfaces so they stay independent of Rapier/IVP.
import type { GraphParameterValue } from './original-graph.ts'
import type { GraphParticleBinding } from './original-particle-system.ts'
import type { GraphSystemBinding } from './original-graph-system.ts'
import type { GraphDatabaseBinding, OriginalTimeManager } from './original-graph-database.ts'
import type { GraphMovieBinding } from './original-graph-movie.ts'
import type { TextureFont } from './original-graph-text.ts'

/** A scene object a behavior can read or mutate. Coordinates are render-space. */
export interface GraphObjectBinding {
  position: [number, number, number]
  rotation: [number, number, number, number]
  scale: [number, number, number]
  visible: boolean
  /** Local mesh bounds (min xyz, max xyz) for Box Box Intersection. */
  bounds?: [number, number, number, number, number, number]
  /** Authored or live world matrix matching those bounds. */
  matrix?: number[]
  /**
   * `CK3dEntity::Transform`: a point given in this entity's frame, in world
   * space, in the binding's units. Bindings that provide it let behaviors
   * honour an authored Referential.
   */
  toWorld?(point: [number, number, number]): [number, number, number]
  /** `CK3dEntity::TransformVector`: a direction in this entity's frame, rotated (and scaled) into world space. */
  toWorldVector?(vector: [number, number, number]): [number, number, number]
  /**
   * `CK3dEntity::GetPosition(&pos, Referential)`: this entity's position in the
   * named entity's frame, in the binding's units.
   */
  positionIn?(referential: string): [number, number, number]
  /**
   * `CK3dEntity::SetPosition(&pos, Referential, KeepChildren)`: place this
   * entity at a position given in the named entity's frame (world when
   * undefined), in the binding's units. Children follow unless `keepChildren`.
   */
  setPositionIn?(position: [number, number, number], referential: string | undefined, keepChildren: boolean): void
  /**
   * `CK3dEntity::SetWorldMatrix(Mat, KeepChildren)`: a Virtools row-major
   * matrix in the binding's units (see `authoredMatrixToBinding`). Children
   * follow unless `keepChildren`.
   */
  setWorldMatrix?(matrix: number[], keepChildren: boolean): void
  /**
   * `CK3dEntity::SetParent(Parent, KeepWorldPos)`: undefined detaches. With
   * `keepWorld` the entity keeps its world matrix.
   */
  setParent?(parent: string | undefined, keepWorld: boolean): void
  /**
   * `CK3dEntity::SetOrientation` (see `originalSetOrientation`): world axes in
   * Virtools coordinates, expressed in the named referential's frame when one is
   * given. `keepChildren` preserves the children's world matrices; otherwise they
   * rotate with the entity.
   */
  setOrientation?(dir: [number, number, number], up: [number, number, number], right: [number, number, number],
    referential: string | undefined, keepChildren: boolean): void
  /** `CK3dEntity::SetScale(&scale, KeepChildren, Local = TRUE)`: absolute local scale. */
  setScale?(scale: number[], keepChildren: boolean): void
  /** `CK3dEntity::AddScale(&scale, KeepChildren, Local = TRUE)`: relative local scale. */
  addScale?(scale: number[], keepChildren: boolean): void
  /** `CK3dEntity::Rotate(&axis, angle, Ref, KeepChildren)`: axis in the referential's frame, radians. */
  rotate?(axis: number[], angle: number, referential: string | undefined, keepChildren: boolean): void
}

/**
 * Object attributes by name (`CKBeObject` attribute calls and the
 * CKAttributeManager lists). Object names are the behaviors' targets as the
 * graph writes them (`ActiveBall` included); the host resolves them.
 */
export interface GraphAttributeBinding {
  has(object: string, attribute: string): boolean
  /** The attribute's parameter value; undefined when it has no parameter. */
  value(object: string, attribute: string): GraphParameterValue | undefined
  /** `SetAttribute` (added with its default when missing), then the value when given. */
  set(object: string, attribute: string, value?: GraphParameterValue): void
  remove(object: string, attribute: string): void
  /** `GetAttributeListPtr`: every object carrying the attribute, in the manager's order. */
  carriers(attribute: string): string[]
}

/** Runtime object creation (`Object Create`, `Object Copy`). */
export interface GraphLifecycleBinding {
  /** `CKContext::CreateObject` + `CKLevel::AddObject`; returns the new object's name. */
  create(classId: number, name: string, dynamic: boolean): string
  /**
   * `CKContext::CopyObjects` for one source with the saved CKDependencies
   * parameter bytes; returns the copy's name, or undefined for a skipped source.
   */
  copy(source: string, dependencies: string | undefined, dynamic: boolean, awake: boolean): string | undefined
}

/** `Planar Filter` settings, read when the filter is drawn. */
export interface GraphFilterSettings {
  /** RGBAFTOCOLOR(&color) bytes (r, g, b, a). */
  color: [number, number, number, number]
  specular: [number, number, number, number]
  texture: string | null
  /** VXBLEND_MODE values. */
  sourceBlend: number
  destBlend: number
  /** VXTEXTURE_FILTERMODE values. */
  magFilter: number
  minFilter: number
}

/** An object a load returned, as `Object Load` sees it. */
export interface GraphLoadedObject {
  /** CK_ID: object arrays (CKPGUID_OBJECTARRAY) hold these. */
  id: number
  name: string
  classId: number
  /** A 2D or 3D entity without a parent. */
  root: boolean
}

/**
 * The CKContext's objects: loading, creation and groups. Objects are passed
 * as references (`#<id>`, exact) or names (resolved only when unique).
 */
/** The CKRenderContext state the blocks set, kept by the CK context. */
export interface GraphRenderState {
  /** The camera the viewpoint is attached to (CK_ID). */
  camera?: number
  /** The Textured Font Manager's fonts by name, in index order (TT CreateFontEx). */
  fonts: Map<string, TextureFont>
  /** The background material's diffuse (VxColor floats). */
  backgroundColor?: number[]
  /** The scene's ambient light colour (ARGB dword). */
  ambientColor?: number
  /**
   * TT Simple Shadow: its material once created, and this frame's one-shot
   * pre-render projections (the render manager drops temporary callbacks at
   * the start of every frame).
   */
  shadow?: { projections: { target: string; settings: GraphShadowSettings }[] }
  /** The render context's size in pixels (the host's centered 4:3 area); the 2D conversions need it. */
  viewport?: { width: number; height: number }
  /** The full drawing buffer; the 3D camera and the 2D presentation outside the 4:3 area need it. */
  canvas?: { width: number; height: number }
  /** VXFOG mode, start, end, density and colour (ARGB dword). */
  fog?: { mode: number; start: number; end: number; density: number; color: number }
}

/** Saved CKDependencies options: NONE, FULL, or per-class masks from a CUSTOM table. */
export interface GraphDependencyOptions {
  mode: 'none' | 'full' | 'custom'
  classes: Record<number, number>
}

export interface GraphContextBinding {
  /** The render context's state. */
  readonly render: GraphRenderState
  /** The host's movie reader (CKMovieReader), for movie textures. */
  readonly movie?: GraphMovieBinding
  /**
   * `CKContext::Load` of a file path (resolved through the data paths), then
   * `CKLevel::AddObject` of each returned object and, with `addToScene`,
   * `CKScene::AddObjectToScene`. Returns CKFile::FinishLoading's list, or
   * undefined when the file cannot be loaded.
   */
  load(path: string, options: { dynamic: boolean; addToScene: boolean }): GraphLoadedObject[] | undefined
  /** `CKContext::DestroyObjects` of what a load returned. */
  unload(ids: readonly number[]): void
  /**
   * `CKContext::DestroyObject` with the saved dependency options (true is
   * CK_DEPENDENCIES_FULL, false NONE, or a saved CUSTOM class table); returns
   * the references of every destroyed object.
   */
  destroy(value: string, dependencies: boolean | GraphDependencyOptions): string[]
  /** The reference of a live CK_ID, or undefined once destroyed. */
  reference(id: number): string | undefined
  /** `CKContext::GetObjectByNameAndParentClass(name, cid, NULL)`: the first such object's reference, or undefined. */
  find(name: string, cid: number): string | undefined
  /** Whether a reference or name is a live context object. */
  has(value: string): boolean
  /** The object's name (`CKObject::GetName`). */
  objectName(value: string): string | undefined
  /** `CKContext::CreateObject`; returns the new object's reference. */
  create(classId: number, name: string, dynamic: boolean): string
  /** `CKGroup::AddObject`; false when the object is already a member. */
  addToGroup(group: string, object: string): boolean
  /** `CKPathManager::ResolveFileName` against the user's game data; undefined when the file is missing. */
  resolveFile(path: string, kind: 'data' | 'sound' | 'bitmap'): string | undefined
  /** The object's mutable state (a sound's file, a material's settings), by CK member name. */
  state(value: string): Record<string, unknown>
  /** `TT Save IC`: the object's (and with `hierarchy` its descendants') scene initial value. */
  saveInitial(value: string, hierarchy: boolean): void
  /** Restore a saved initial value; false when the context holds none for the object. */
  restoreSaved(value: string): boolean
  /** `CKBeObject::GetScript(i)` for every i, as references. */
  scripts(value: string): string[]
  /** `CKBeObject::GetScriptCount`. */
  scriptCount(value: string): number
  /** A 3D entity's world matrix (Virtools row-major, original units), or undefined. */
  matrix(value: string): number[] | undefined
  /** A group's members as references, or undefined when it is not a context group. */
  members(group: string): string[] | undefined
  /** `CKObject::GetClassID` of a live object. */
  classId(value: string): number | undefined
  /** A CK2dEntity's material (`GetMaterial`), or undefined for NULL. */
  material2d(entity: string): string | undefined
  /**
   * `CKRenderContext::Pick2D` (CK2_3D 0x10068220) at a point in render-window
   * pixels, over the extents of the last render: the picked 2D entity, or undefined.
   */
  pick2d(point: readonly [number, number]): string | undefined
  /** A CKCurve's data with its points as references, or undefined when the object is no curve. */
  curve(value: string): { closed: boolean; fitting: number; points: ({ reference: string } & Omit<import('./original-context.ts').OriginalCurvePoint, 'id'>)[] } | undefined
  /** `CK3dEntity::GetPosition(&p, referential)` in original units. */
  entityPosition(entity: string, referential: string): [number, number, number]
  /** A CKObjectAnimation's controllers with its driven entity as a reference; an undecoded one fails loudly. */
  animation(value: string): (Omit<import('./original-context.ts').OriginalObjectAnimationData, 'entity'> & { entity: string }) | undefined
  /** `CK3dEntity::GetFlags` (CK_3DENTITY_FLAGS). */
  entityFlags(entity: string): number
  /** `CK3dEntity::SetLocalMatrix(m, KeepChildren = FALSE)` in original units. */
  setLocalMatrix(entity: string, matrix: readonly number[]): void
  /** A CKTexture's size in texels (GetWidth / GetHeight of its loaded image), or undefined. */
  textureSize(texture: string): { width: number; height: number } | undefined
  /** `CK2dEntity::SetMaterial` (CK2_3D 0x1005E111: the pointer alone, NULL allowed). */
  setMaterial2d(entity: string, material: string | undefined): void
  /**
   * `CKContext::GetObjectsListByClassID` (the exact class, creation order) as
   * references, optionally without CK_OBJECT_PRIVATE objects or objects
   * outside the current scene.
   */
  objectsOfClass(classId: number, options: { currentSceneOnly: boolean; skipPrivate: boolean }): string[]
  /** `CKMaterial::GetTexture(slot)`, or undefined. */
  textureOf(value: string, slot: number): string | undefined
  /** The driver's TextureFormats (`VxDriverDesc`) as VX_PIXELFORMAT values; absent without a render context. */
  textureFormats?(): readonly number[]
  /** `CK3dEntity::GetCurrentMesh` geometry, undefined without a mesh; a mesh that was not exported fails loudly. */
  currentMesh(entity: string): { positions: readonly number[]; normals: readonly number[]; uvs: readonly number[] } | undefined
  /** Write the current mesh's UVs (`CKMesh::UVChanged`). */
  setMeshUVs(entity: string, uvs: readonly number[]): void
  /** `CK3dEntity::GetCurrentMesh` as a reference, or undefined. */
  currentMeshReference(entity: string): string | undefined
  /** `CKMesh::GetMaterial(index)`: the material of render group index + 1, or undefined. */
  meshMaterial(mesh: string, index: number): string | undefined
  /** `CK3dEntity::GetBoundingBox(Local)` as a CKPGUID_BOX value (Max xyz, Min xyz); undefined for a non-entity. */
  boundingBox(value: string, local: boolean): number[] | undefined
}

/**
 * The entity-tree and scene calls TT Extra makes, on references. Positions are
 * in original units and Virtools axes (its offsets and squared distances are
 * authored units).
 */
export interface GraphExtraBinding {
  /** `GetChildrenCount` + `GetChild(i)`: the live children in order. */
  children(entity: string): string[]
  /** `CKObject::GetName`. */
  name(entity: string): string
  /** `CK3dEntity::GetPosition(&pos, Ref)`; world without a referential. */
  position(entity: string, referential?: string): [number, number, number]
  /** `CK3dEntity::SetPosition(&pos, Ref, KeepChildren = FALSE)`. */
  setPosition(entity: string, position: [number, number, number], referential?: string): void
  /** `CKObject::Show(CKSHOW / CKHIDE)`. */
  show(entity: string, shown: boolean): void
  /** `CKScene::DeActivate(entity)` on the current scene. */
  deactivate(entity: string): void
  /**
   * Activate Script's Awake Object: `script->GetOwner()`, and when it is not
   * IsActiveInCurrentScene, `CKScene::Activate(owner, FALSE)`.
   */
  awakeOwner?(script: string): void
  /** `CKGroup::GetObject(index)`; undefined for NULL. */
  groupObject(group: string, index: number): string | undefined
}

/**
 * The TT timer manager (a CKContext manager, GUID 60632E28:7D3B3C7D): one per
 * context, shared by every TT_Timer block, constructed running at 0 elapsed.
 */
export interface GraphTimerBinding {
  /** running = true, elapsed = 0. */
  reset(): void
  pause(): void
  play(): void
  /** The elapsed float, ms. */
  now(): number
  /** elapsed = float(elapsed + delta), only while running. */
  elapse(deltaMs: number): void
}

/** Full-view post-sprite quads (`Planar Filter`). */
export interface GraphFilterBinding {
  /** Draw a full-view quad after the sprites every frame; `read` returns the live inputs. */
  show(key: string, read: () => GraphFilterSettings): void
  hide(key: string): void
}

/** Camera selection and planes (`Set As Active Camera`, `Set Clipping Planes`). */
export interface GraphCameraBinding {
  /** `CKRenderContext::AttachViewpointToCamera`. */
  attach(name: string): void
  /** `CKCamera::SetFrontPlane` / `SetBackPlane`, in original units. */
  setClipping(name: string, near: number, far: number): void
}

/** A `Ray Intersection` query in world space, in the binding's units. */
export interface GraphRay {
  origin: [number, number, number]
  /** Normalized. */
  direction: [number, number, number]
  depth: number
  /** Filter group; every 3D object when absent. */
  group?: string
  /** Skipped entity (the behavior owner, with Skip Owner). */
  owner?: string
  skipTransparent: boolean
}

export interface GraphRayHit {
  object: string
  faceIndex: number
  nearestVertex: number
  point: [number, number, number]
  normal: [number, number, number]
  distance: number
}

/** Settings for `Physicalize` (see the local DLL recovery notes). */
export interface GraphPhysicsBody {
  fixed?: boolean
  friction?: number
  elasticity?: number
  mass?: number
  collisionGroup?: number
  startFrozen?: boolean
  enableCollision?: boolean
  automaticMassCenter?: boolean
  linearDamping?: number
  angularDamping?: number
  hulls?: string[]
  /** Concave collision meshes (`Physicalize` Concave Count inputs), built as triangle soups. */
  concave?: string[]
  /** Ball primitives (`Physicalize` Ball Count inputs): the authored mass-center offset and radius. */
  balls?: { position: [number, number, number]; radius: number }[]
  massCenter?: [number, number, number]
}

/**
 * A named authored referential frame resolved by a physics host.
 *
 * `position`, `rotation` and `axis` are render-space (SCALE applied, Z
 * reflected). `matrix` is the authored 4x4 world matrix in original units and
 * is used for inertia/frame transforms that must match the recovered asset.
 */
export interface GraphFrameBinding {
  position: [number, number, number]
  rotation: [number, number, number, number]
  axis?: [number, number, number]
  matrix?: number[]
}

/** Settings for `SetPhysicsForce` / `PhysicsImpulse`. */
export interface GraphForceSettings {
  create: boolean
  /** Authored force node, so multiple controllers may target one body. */
  controller?: number | string
  position?: [number, number, number]
  positionRef?: string
  direction?: [number, number, number]
  directionRef?: string
  value?: number
}

/** Settings for `Set Physics Hinge`/`Slider`/`BallSocket`. */
export interface GraphJointSettings {
  /** Authored behavior node, so one target may own several joints. */
  controller?: number
  object2?: string
  referential?: string
  /** Second axis point for a slider (`Set Physics Slider`). */
  referential2?: string
  limitsEnabled?: boolean
  lowerLimit?: number
  upperLimit?: number
}

/** Settings for `Set Physics Spring`. */
export interface GraphSpringSettings {
  create: boolean
  object2?: string
  position1?: [number, number, number]
  referential1?: string
  position2?: [number, number, number]
  referential2?: string
  length?: number
  constant?: number
  axialDamping?: number
  globalDamping?: number
}

/** `PhysicsContinuousContact`'s PhysicsContactData settings, times in IVP seconds. */
export interface GraphContactSettings {
  groups: number
  startDelay: number
  endDelay: number
}

/** A PhysicsContactManager change: output `group` (1-based) on or off. */
export interface GraphContactChange { group: number; active: boolean }

/**
 * A live `PhysicsContinuousContact` listener (`PhysicsContactData`). The physics
 * host updates it after every simulation step; its changes are delivered before
 * the behavior runs on the next script frame, as Virtools dispatches outputs
 * activated during simulation.
 */
export interface GraphContactListener {
  /** Changes recorded since the last poll, in the contact manager's order. */
  poll(): GraphContactChange[]
  /** Delete the listener; returns the off changes of the still-active groups. */
  stop(): GraphContactChange[]
  /** False once the body was removed and its contact data deleted. */
  readonly alive: boolean
}

export interface GraphPhysicsBinding {
  physicalize(name: string, settings: GraphPhysicsBody): void
  unphysicalize(name: string): void
  force(name: string, settings: GraphForceSettings): void
  forceScale?(behavior: number): number | undefined
  joint(kind: 'hinge' | 'slider' | 'ballSocket', name: string, settings: GraphJointSettings): void
  /** Remove the authored joint handle created for `(kind, name, controller)`. */
  destroyJoint?(kind: 'hinge' | 'slider' | 'ballSocket', name: string, controller?: number): void
  spring?(name: string, settings: GraphSpringSettings): void
  /**
   * `PhysicsContinuousContact`: attach a contact listener to the physicalized
   * target. Undefined when it has no body or already owns contact data
   * (`PhysicsObject::m_ContactData`).
   */
  continuousContact?(name: string, settings: GraphContactSettings): GraphContactListener | undefined
  wake(name: string): void
  /** Create deferred controllers at the start of a script frame. */
  startFrame?(): void
  /** Per-frame force maintenance; deltaMs is the engine tick when known. */
  step?(deltaMs?: number): void
  /** Clear runtime controllers while preserving authored body handles. */
  reset?(): void
  /** Release controllers that target a player body about to be replaced. */
  detach?(): void
}

/** A wave sound's settings as CKWaveSound reports them. */
export interface GraphSoundSettings { gain: number; pitch: number; pan: number }

export interface GraphAudioBinding {
  play(name: string, options?: { loop?: boolean; volume?: number }): void
  stop(name: string): void
  /** Update the gain of a live wave sound (CKWaveSound::SetGain). */
  gain?(name: string, gain: number): void
  /** CKWaveSound::SetPitch (Pitch Control). */
  pitch?(name: string, pitch: number): void
  /** CKWaveSound::SetPan (Panning Control). */
  pan?(name: string, pan: number): void
  /** CKWaveSound::GetGain / GetPitch / GetPan; undefined for an unknown sound. */
  properties?(name: string): GraphSoundSettings | undefined
  /**
   * `CKWaveSound::IsPlaying`: a live or still-loading source. Wave Player
   * stays active while this is true and fires End Playing when it turns false;
   * a sink without it keeps Wave Player one-shot.
   */
  playing?(name: string): boolean | undefined
}

/** A named authored light a behavior can recolor (`CKLight::SetColor`). */
export interface GraphLightBinding {
  setColor(name: string, color: [number, number, number, number]): void
}

/** Authored PlanarParticleSystem settings, in original units and milliseconds. */
export interface GraphPlanarParticleSettings {
  emissionDelayMs: number
  emissionDelayVarianceMs: number
  yawVariance: number
  pitchVariance: number
  speed: number
  speedVariance: number
  angularSpeed: number
  angularSpeedVariance: number
  lifespanMs: number
  lifespanVarianceMs: number
  maximumNumber: number
  emission: number
  emissionVariance: number
  initialSize: number
  initialSizeVariance: number
  endingSize: number
  endingSizeVariance: number
  bounce: number
  bounceVariance: number
  weight: number
  weightVariance: number
  initialColor: [number, number, number, number]
  endingColor: [number, number, number, number]
  texture: string
  initialTextureFrame: number
  textureSpeed: number
  textureFrameCount: number
  textureLoop: boolean
  realTimeMode: boolean
  deltaTimeMs: number
}

export interface GraphEffectBinding {
  emit(name: string): void
  stop(name: string): void
  setTexture(name: string, texture: string): void
  setDiffuse(name: string, color: [number, number, number, number]): void
  /** Continuous authored particle emitter; `name` is the node's target/key. */
  planar?(name: string, settings: GraphPlanarParticleSettings): void
  stopPlanar?(name: string): void
  freezePlanar?(name: string, frozen: boolean): void
  /**
   * `Texture Scroller`: move the UVs of the named mesh (an entity name stands
   * for its current mesh) by `vector` in Virtools UV space, after removing the
   * integer part of the first vertex's UV. Channel -1 is the default material.
   */
  scrollTexture?(name: string, vector: [number, number], channel: number): void
  /**
   * `TT_TextureSine`: the named mesh's modifier UVs of the default channel, in
   * Virtools UV space (u, v per vertex, in vertex order); `commit` is
   * `ModifierUVMove`.
   */
  meshUVs?(name: string): GraphMeshUVs | undefined
  /** `Set Emissive` on the named material. */
  setEmissive?(name: string, color: [number, number, number, number]): void
  /**
   * `Set Prelit Color`: the entity's current mesh turns prelit and every vertex
   * takes these ARGB colour bytes (r, g, b, a) as its diffuse and specular.
   */
  setPrelitColor?(name: string, color: [number, number, number, number], specular: [number, number, number, number]): void
}

export interface GraphMeshUVs {
  readonly uvs: Float32Array
  commit(): void
}

/** `TT Sky` construction settings, as the DLL reads them on On. */
export interface GraphSkySettings {
  /** Fraction of the remaining field of view the sky projection widens by (0..1). */
  distortion: number
  radius: number
  /** Square side faces (height = side width) instead of `sideHeight`. */
  quadratic: boolean
  sideHeight: number
  /** Sky centre height in the sky entity's frame. */
  y: number
  /** Number of side faces (`Side Materials`, at least 4). */
  sides: number
  top: boolean
  bottom: boolean
}

/** The TT Sky entity: a camera-centred, render-first box of material faces. */
export interface GraphSkyBinding {
  create(settings: GraphSkySettings): void
  /** Face materials in input order (sides, then top, then bottom) and the prelit vertex color. */
  update(materials: (string | null)[], vertexColor: [number, number, number, number]): void
  /** Show the sky this frame, oriented by the Orientation Object (identity when absent). */
  show(orientation: GraphObjectBinding | undefined): void
  hide(): void
}

/** `TT Simple Shadow` inputs read by its render callback, in original units. */
export interface GraphShadowSettings {
  /** Texture input (`HardShadow`). */
  texture: string | null
  /** Size Scale: the projected texture spans this many target widths. */
  sizeScale: number
  /** Maximum Height between the target's bottom and a floor's top. */
  maxHeight: number
}

/**
 * The `TT Simple Shadow` projector: a material channel projected straight
 * down onto the floors under the target, multiplying their colour.
 */
export interface GraphShadowBinding {
  /** On: drop any previous projection and create the shadow material. */
  create(): void
  /** Off, reset or deactivation: remove the channel from every floor and destroy the material. */
  reset(): void
  /** Register this frame's pre-render projection for the named target. */
  project(target: string, settings: GraphShadowSettings): void
}

/** Font state set by `Set Font Properties`; values are authored, in stage units. */
export interface GraphFontProperties {
  space?: number[]
  scale?: number[]
  angle?: number
  color?: number[]
  shadowColor?: number[]
  shadowDistance?: number
}

/**
 * 2D text presentation and the Gameplay_Tutorial host services. The graph
 * runtime does not draw; the host implements these with the original sprites.
 */
export interface GraphTutorialBinding {
  /** `TT CreateFontEx`: registers a font by its authored name. */
  createFont(name: string): void
  /** `Set Font Properties`: updates the registered font's live state. */
  setFont(name: string, properties: GraphFontProperties): void
  /** `2D Text` On: writes the text into a 2D entity. */
  showText(entity: string, font: string, text: string): void
  /** `2D Text` Off: clears the 2D entity's text. */
  hideText(entity: string): void
  /** `Load String`: text of an authored file, or undefined when it is missing. */
  loadString(name: string): string | undefined
  /** `Set Physics Globals`: gravity and time factor (0 freezes the simulation). */
  setGlobals(gravity: number[], timeFactor: number): void
}

/** Scripts of other loaded documents (`Execute Script`, `Activate Script` across files). */
export interface GraphScriptBinding {
  has(name: string): boolean
  /** `CKBehavior::IsActive` of that root script. */
  isActive(name: string): boolean
  /** `CKScene::Activate/DeactivateScript`, applied at that document's next frame start. */
  request(name: string, active: boolean, reset: boolean): void
}

/** Resolves authored object names (behavior targets and references). */
export interface GraphBinding {
  /**
   * The live `CK3dEntity` children of a scene entity, in m_Children order, for
   * bindings whose hierarchy changes (`Set Parent`). Undefined falls back to
   * the document's saved hierarchy.
   */
  children?(name: string): string[] | undefined
  /** World units per authored original unit (defaults to SCALE). */
  coordinateScale?: number
  object(name: string): GraphObjectBinding | undefined
  /** Named authored referential frames (joints, springs, forces). */
  frame?(name: string): GraphFrameBinding | undefined
  /** Data Array targets (`Get Cell`/`Set Cell`), row-major. */
  array?(name: string): GraphParameterValue[][] | undefined
  /** The live player's authored object name (`Ball_Wood`, ...). */
  activeBall?(): string | undefined
  /** A named authored script was started/reset or stopped. */
  script?(name: string, active: boolean): void
  /** Root scripts of the other documents of a multi-document session. */
  scripts?: GraphScriptBinding
  /**
   * `CKScene::GetObjectInitialValue` + `CKReadObjectState` for one scene
   * entity: restore its pose and visibility to the state saved when it entered
   * the scene. Physics-owned transforms are re-driven by the host as in the
   * original. Unknown entities fail loudly.
   */
  restoreInitial?(name: string): void
  physics?: GraphPhysicsBinding
  audio?: GraphAudioBinding
  effect?: GraphEffectBinding
  light?: GraphLightBinding
  tutorial?: GraphTutorialBinding
  sky?: GraphSkyBinding
  shadow?: GraphShadowBinding
  particles?: GraphParticleBinding
  camera?: GraphCameraBinding
  attributes?: GraphAttributeBinding
  lifecycle?: GraphLifecycleBinding
  filter?: GraphFilterBinding
  context?: GraphContextBinding
  /** The entity tree TT Extra walks and moves, in original units. */
  extra?: GraphExtraBinding
  /** The TT timer manager shared by every `TT_Timer`. */
  timer?: GraphTimerBinding
  /** The machine and player the start-up blocks query (registry, display drivers, cursor, ...). */
  system?: GraphSystemBinding
  /** The host's movie reader (decodes a movie file's frames into its texture). */
  movie?: GraphMovieBinding
  /** The TT Database-Manager, its file access and the arrays it fills. */
  database?: GraphDatabaseBinding
  /** The CKTimeManager Time Settings drives. */
  time?: { readonly manager: OriginalTimeManager }
  /** CKContext::DestroyAllDynamicObjects (done at the end of the frame). */
  dynamic?: { destroyAll(): void }
  /** The Ipion manager's DeleteCollisionSurfaces command. */
  collisionSurfaces?: { delete(): boolean }
  /** Member names of an authored group, for `Group Iterator`. */
  group?(name: string): string[] | undefined
  /** The nearest face a ray meets (`Ray Intersection`). */
  rayIntersection?(ray: GraphRay): GraphRayHit | undefined
}

/**
 * An authored vector or length triple (original units) in a binding's units:
 * original-unit bindings (`coordinateScale` 1) take it as is; render-space
 * bindings scale it and reflect Z, like their positions.
 */
export function authoredVectorToBinding(vector: [number, number, number], coordinateScale: number): [number, number, number] {
  if (coordinateScale === 1) return vector
  return [vector[0] * coordinateScale, vector[1] * coordinateScale, -vector[2] * coordinateScale]
}

/**
 * An authored Virtools row-major matrix (original units) in a binding's units:
 * render-space bindings conjugate it by their scale and Z reflection, so the
 * axes lose the Z sign on their mixed terms and the position is scaled.
 */
export function authoredMatrixToBinding(matrix: readonly number[], coordinateScale: number): number[] {
  if (coordinateScale === 1) return [...matrix]
  const result = [...matrix]
  for (const index of [2, 6, 8, 9]) result[index] = -result[index]!
  const [x, y, z] = authoredVectorToBinding([matrix[12]!, matrix[13]!, matrix[14]!], coordinateScale)
  result[12] = x; result[13] = y; result[14] = z
  return result
}
