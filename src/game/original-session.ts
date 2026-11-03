// Several loaded documents run together, as one CKContext runs every loaded
// file: one message manager, one set of bindings, and each document's scripts
// reachable from the others (Execute Script, Activate Script). Documents step
// in the order they were added (the documented script order: Level first, then
// load order). Copied scripts (Object Copy) run as further instances of their
// document's graph.
import * as THREE from 'three'
import { originalEntityFrame, originalEntityObject } from './original-entity-graph.ts'
import type { GraphParticleBinding, OriginalParticleRenderer } from './original-particle-system.ts'
import { OriginalDatabaseManager, OriginalTimeManager } from './original-graph-database.ts'
import { originalArrayLayout, originalArraySetLayout } from './original-graph-array.ts'
import { originalRayIntersection } from './original-ray.ts'
import { original2dRender, original2dState, originalIs2dEntity, type Original2dDrawItem } from './original-2d-render.ts'
import { original2dUpdateExtents } from './original-2d-entity.ts'
import { OriginalTtTimerManager } from './original-graph-extra.ts'
import { OriginalPlanarFilter } from './original-planar-filter.ts'
import { GraphMessageBus, OriginalGraphRuntime, ORIGINAL_BEHAVIORS } from './original-graph.ts'
import type { BehaviorRegistry, GraphBinding, OriginalGraphData, OriginalGraphParameter } from './original-graph.ts'
import type { GraphContextBinding, GraphEffectBinding, GraphLifecycleBinding, GraphMeshUVs, GraphObjectBinding, GraphPhysicsBinding, GraphScriptBinding, GraphTimerBinding, GraphTutorialBinding } from './original-graph-bindings.ts'
import {
  CKCID,
  OriginalContext,
  type OriginalObject,
  originalAttributeBinding,
  originalContextBinding,
  originalCopyDependencies,
  originalIsChildClassOf,
  originalObjectReference,
  originalParameterClass,
  SCENE_START_ACTIVATE,
  SCENE_START_RESET,
} from './original-context.ts'

interface HostedDocument {
  /** The document the graph comes from. */
  name: string
  runtime: OriginalGraphRuntime
}

export class OriginalSession {
  readonly bus: GraphMessageBus
  readonly context: OriginalContext
  /** The TT timer manager of this context, shared by every TT_Timer. */
  readonly timer = new OriginalTtTimerManager()
  private readonly documents: HostedDocument[] = []
  /** Every hosted root script by CK_ID: the runtime that runs it and its root name there. */
  private readonly scriptIndex = new Map<number, { runtime: OriginalGraphRuntime; name: string }>()
  private readonly graphs: (stem: string) => OriginalGraphData | undefined
  private readonly binding: GraphBinding
  private readonly registry: BehaviorRegistry
  private readonly simulation: OriginalSessionSimulation | undefined
  /** The CKTimeManager (Time Settings) and the TT Database-Manager of this context. */
  readonly time = { manager: new OriginalTimeManager() }
  readonly database = new OriginalDatabaseManager()
  /** The render context's post-sprite `Planar Filter` callbacks. */
  readonly filter: OriginalPlanarFilter
  /** The last frame's 2D draw list (background then foreground), for the view. */
  frame2d: Original2dDrawItem[] = []
  /** The system clock the input manager's repetition reads, in ms since the session started. */
  private clockMs = 0
  /** DestroyAllDynamicObjects was called this frame. */
  private destroyDynamic = false
  /** Each runtime's root owners by root node (null: not a context script). */
  private readonly owners = new Map<OriginalGraphRuntime, Map<number, number | null>>()
  /** The particle manager every hosted document's emitters draw through. */
  private readonly particles: OriginalParticleRenderer | undefined

  /**
   * `graphs` gives a document's exported behavior graph; `binding` is shared
   * by every hosted document.
   */
  constructor(context: OriginalContext, graphs: (stem: string) => OriginalGraphData | undefined, binding: GraphBinding,
    options: { bus?: GraphMessageBus; registry?: BehaviorRegistry; physics?: GraphPhysicsBinding; simulation?: OriginalSessionSimulation; particles?: OriginalParticleRenderer; filter?: OriginalPlanarFilter } = {}) {
    this.context = context
    this.particles = options.particles
    this.filter = options.filter ?? new OriginalPlanarFilter()
    this.graphs = graphs
    // The session's physics (bodies keyed by context references) replaces the host's;
    // a simulation also steps after the scripts and takes Set Physics Globals.
    this.simulation = options.simulation
    const physics = options.simulation?.binding ?? options.physics
    const simulation = options.simulation
    // Fonts and 2D text are context state (original-graph-text.ts); text files stay the host's.
    const overContext = (block: string) => () => { throw new Error(`${block} runs over the CK object context in a session`) }
    const tutorial: GraphTutorialBinding = {
      createFont: overContext('TT CreateFontEx'), setFont: overContext('Set Font Properties'),
      showText: overContext('2D Text'), hideText: overContext('2D Text'),
      loadString: name => binding.tutorial?.loadString(name),
      setGlobals: (gravity, timeFactor) => {
        if (simulation) simulation.setGlobals(gravity, timeFactor)
        else if (binding.tutorial) binding.tutorial.setGlobals(gravity, timeFactor)
        else throw new Error('Set Physics Globals has no physics to set')
      },
    }
    this.binding = new Proxy(binding, {
      get: (target, key, receiver) => key === 'physics' && physics ? physics : key === 'tutorial' ? tutorial : Reflect.get(target, key, receiver),
    })
    this.bus = options.bus ?? new GraphMessageBus()
    this.registry = options.registry ?? ORIGINAL_BEHAVIORS
  }

  /** A root script by reference (`#<id>`) or by name. */
  private script(value: string): { runtime: OriginalGraphRuntime; name: string } | undefined {
    const id = /^#\d+$/.test(value) ? Number(value.slice(1)) : undefined
    if (id !== undefined) return this.scriptIndex.get(id)
    const owner = this.documents.find(document => document.runtime.hasScript(value))
    return owner ? { runtime: owner.runtime, name: value } : undefined
  }

  private owner(value: string): { runtime: OriginalGraphRuntime; name: string } {
    const found = this.script(value)
    if (!found) throw new Error(`No hosted document has a root script ${value}`)
    return found
  }

  /** The other documents' scripts, as each document's binding sees them. */
  readonly scripts: GraphScriptBinding = {
    has: value => this.script(value) !== undefined,
    isActive: value => { const { runtime, name } = this.owner(value); return runtime.isScriptActive(name) ?? false },
    request: (value, active, reset) => { const { runtime, name } = this.owner(value); runtime.requestScript(name, active, reset) },
  }

  /**
   * Host a document: its objects are loaded into the context, as CKContext::Load
   * does, and its scripts run on the session's bindings. Roots run only when
   * activated.
   */
  add(name: string, registry = this.registry): OriginalGraphRuntime | undefined {
    if (this.documents.some(document => document.name === name)) throw new Error(`Document ${name} is hosted twice`)
    if (!this.context.load(name, false)) throw new Error(`Document ${name} has no exported object table`)
    return this.host(name, registry)
  }

  /** Run a loaded document's scripts, when it has any. */
  private host(name: string, registry = this.registry): OriginalGraphRuntime | undefined {
    const saved = this.graphs(name)
    if (!saved?.roots.length) return undefined
    const data = resolveSaved(saved, name, this.context)
    const runtime = this.start(name, data, registry)
    for (const root of data.roots) {
      const script = data.nodes[String(root)]!.name
      const object = this.context.byName(script).find(item => item.classId === CKCID.BEHAVIOR && item.document === name)
      if (object) this.scriptIndex.set(object.id, { runtime, name: script })
    }
    return runtime
  }

  private start(name: string, data: OriginalGraphData, registry = this.registry): OriginalGraphRuntime {
    const runtime = new OriginalGraphRuntime(data, registry, sessionBinding(this.binding, this.context, this.scripts, {
      loaded: document => this.loaded(document),
      timer: this.timer,
      time: this.time,
      database: this.database,
      destroyDynamic: () => { this.destroyDynamic = true },
      deleteCollisionSurfaces: () => {
        if (!this.simulation?.deleteCollisionSurfaces) throw new Error('DeleteCollisionSurfaces needs the session physics')
        return this.simulation.deleteCollisionSurfaces()
      },
      copied: map => this.copied(map),
      // Each hosted runtime has its own emitters (keyed by its node indices); owners are context entities.
      particles: this.particles?.binding(owner => {
        const object = this.context.resolve(owner)
        const matrix = object && this.context.worldMatrix(object.id)
        return matrix ? new THREE.Matrix4().fromArray(matrix) : undefined
      }),
      filter: this.filter,
    }), { bus: this.bus })
    runtime.frameRoots = []
    runtime.rootGate = root => this.ownerRuns(runtime, root)
    this.documents.push({ name, runtime })
    return runtime
  }

  /** A document an Object Load brought in: its scripts join the session. */
  private loaded(document: string): void {
    if (!this.documents.some(hosted => hosted.name === document)) this.host(document)
  }

  /**
   * Copied root scripts run as a new instance of their document's graph, with
   * the references to copied objects remapped to the copies (the
   * RemapDependencies of the copied behaviors). A copy is active when its
   * original is: CKDependenciesContext::Copy activates a copied script in the
   * level scene when the original was active there.
   */
  private copied(map: ReadonlyMap<number, number>): void {
    const byRuntime = new Map<OriginalGraphRuntime, { document: string; roots: { original: string; copy: string; id: number }[] }>()
    for (const [original, copy] of map) {
      const script = this.scriptIndex.get(original)
      if (!script) continue
      const document = this.documents.find(hosted => hosted.runtime === script.runtime)!.name
      const entry = byRuntime.get(script.runtime) ?? { document, roots: [] }
      entry.roots.push({ original: script.name, copy: this.context.get(copy)!.name, id: copy })
      byRuntime.set(script.runtime, entry)
    }
    for (const [source, { document, roots }] of byRuntime) {
      const data = this.graphs(document)
      if (!data) throw new Error(`Copied scripts of ${document} have no graph`)
      const runtime = this.start(document, remapGraph(data, document, map, this.context, roots, source))
      for (const root of roots) {
        this.scriptIndex.set(root.id, { runtime, name: root.copy })
        if (source.isScriptActive(root.original)) runtime.requestScript(root.copy, true, true)
      }
    }
  }

  runtime(name: string): OriginalGraphRuntime | undefined {
    return this.documents.find(document => document.name === name)?.runtime
  }

  /**
   * Whether a root's owner is in the behavior manager: the level, or an
   * object active in the scene. A root the context does not list as a script
   * (a host-only graph) always runs.
   */
  private ownerRuns(runtime: OriginalGraphRuntime, root: number): boolean {
    let owners = this.owners.get(runtime)
    if (!owners) this.owners.set(runtime, owners = new Map())
    let owner = owners.get(root)
    if (owner === undefined) {
      const name = runtime.data.nodes[String(root)]?.name
      let script: number | undefined
      for (const [id, entry] of this.scriptIndex) if (entry.runtime === runtime && entry.name === name) { script = id; break }
      const object = script === undefined ? undefined : this.context.scriptOwner(script)
      if (script !== undefined && !object) throw new Error(`Script ${name} has no owner in the context`)
      owner = object?.id ?? null
      owners.set(root, owner)
    }
    if (owner === null) return true
    const object = this.context.get(owner)
    return !!object && (object.classId === CKCID.LEVEL || object.sceneActive)
  }

  /**
   * `CKContext::Play` of the loaded level: CKLevel::ActivateAllScript, then
   * LaunchScene's CKScene::Init, which leaves a level document's scripts
   * active only when their scene desc says START_ACTIVATE (reset with
   * START_RESET) and deactivates the rest.
   */
  play(): void {
    // LaunchScene applies the scene's environment settings when its flag (2) is set (ApplyEnvironmentSettings):
    // the background material's diffuse from the background colour, the ambient light and the fog.
    for (const [, scene] of this.context.levelScenes) {
      if (!((scene.environment ?? 0) & 2)) continue
      if (scene.backgroundTexture !== 0xffffffff || scene.startingCamera !== 0xffffffff) throw new Error('A level scene with a background texture or starting camera is not supported')
      const channel = (shift: number) => Math.fround(((scene.backgroundColor! >>> shift) & 0xff) / 255)
      // UNVERIFIED: VxColor(DWORD)'s rounding of each byte / 255.
      this.context.render.backgroundColor = [channel(16), channel(8), channel(0), channel(24)]
      this.context.render.ambientColor = scene.ambientColor!
      this.context.render.fog = { mode: scene.fogMode!, start: scene.fogStart!, end: scene.fogEnd!, density: scene.fogDensity!, color: scene.fogColor! }
    }
    for (const [id, { runtime, name }] of this.scriptIndex) {
      const script = this.context.get(id)
      if (!script?.document || !this.context.levelDocuments.has(script.document)) continue
      const flags = script.sceneFlags ?? 0
      // CKBehavior::Activate sets the flag; the script first runs in the next frame.
      if (flags & SCENE_START_ACTIVATE) runtime.requestScript(name, true, (flags & SCENE_START_RESET) !== 0)
    }
  }

  /** `CKScene::Activate` of a root script from the host, in whichever document has it. */
  activateScript(value: string, reset = true): void {
    const { runtime, name } = this.owner(value)
    runtime.activateScript(name, reset)
  }

  /**
   * One frame: the message manager delivers the previous frame's messages,
   * every document runs its active scripts, then the physics manager's
   * PostProcess steps the simulation.
   */
  step(elapsedMs: number, keys: ReadonlySet<number> = new Set()): void {
    // CKTimeManager::PreProcess clamps and scales the frame time the scripts and managers see.
    const deltaMs = this.time.manager.scriptDeltaMs(elapsedMs)
    // The input manager's PreProcess fills this frame's key buffer and button state (timeGetTime-like clock).
    this.clockMs += elapsedMs
    const input = this.binding.system?.input
    input?.preProcess(Math.trunc(this.clockMs))
    // RCKRenderManager::PreProcess: RemoveAllTemporaryCallbacks.
    if (this.context.render.shadow) this.context.render.shadow.projections = []
    this.bus.postProcess()
    for (const { runtime } of this.documents) {
      runtime.deltaMs = deltaMs
      runtime.heldKeys.clear()
      for (const key of keys) runtime.heldKeys.add(key)
      runtime.step()
    }
    this.simulation?.step(deltaMs)
    // The object manager's PostProcess destroys the dynamic objects once DestroyAllDynamicObjects asked.
    if (this.destroyDynamic) {
      this.destroyDynamic = false
      this.context.destroy(this.context.dynamicObjects().map(object => object.id))
    }
    // CKRenderContext::Render: the 2D passes update every drawn entity's extents (Pick2D reads them next frame).
    const viewport = this.context.render.viewport
    this.frame2d = viewport ? original2dRender(this.context, viewport) : []
    input?.postProcess()
  }
}

/** The session's physics world: its graph binding, its PostProcess step and its globals. */
export interface OriginalSessionSimulation {
  readonly binding: GraphPhysicsBinding
  step(deltaMs: number): void
  /** The Ipion manager's DeleteCollisionSurfaces command; false while bodies are physicalized (it stays queued). */
  deleteCollisionSurfaces?(): boolean
  setGlobals(gravity: readonly number[], timeFactor: number): void
}

/**
 * CKFile::FinishLoading's RemapObjects for a hosted document: every saved
 * object reference (an object-typed parameter, or a behavior target with its
 * class) that names a context object becomes that object's reference. A saved
 * file-index reference (`object`) resolves exactly, so same-named objects of
 * different classes stay distinct. Names are only a fallback, matched within
 * the reference's class, the document's own objects first, then the earliest
 * loaded. Names the context does not hold (the host's level objects) stay names.
 */
function resolveSaved(data: OriginalGraphData, document: string, context: OriginalContext): OriginalGraphData {
  const resolve = (name: string, cid: number) => {
    const candidates = context.byName(name).filter(object => originalIsChildClassOf(object.classId, cid))
    const object = candidates.find(item => item.document === document) ?? candidates[0]
    return object ? originalObjectReference(object.id) : undefined
  }
  const byFile = (index: number) => {
    const object = context.objectByFile(document, index)
    return object ? originalObjectReference(object.id) : undefined
  }
  const clone = JSON.parse(JSON.stringify(data)) as OriginalGraphData
  const parameter = (item: OriginalGraphParameter) => {
    if (item.object !== undefined) {
      const reference = byFile(item.object)
      if (reference !== undefined) { item.value = reference; item.null = false; return }
      // The referenced object is not loaded here (a host/level object): keep
      // the name and resolve it within the class below.
    }
    if (item.null || typeof item.value !== 'string' || item.source !== undefined) return
    const cid = originalParameterClass(item.pinType ?? item.type)
    if (cid === undefined) return
    item.value = resolve(item.value, cid) ?? item.value
  }
  for (const node of Object.values(clone.nodes)) {
    for (const list of [node.inputs, node.outputs, node.locals]) for (const item of list ?? []) parameter(item)
    const targetReference = node.targetObject === undefined ? undefined : byFile(node.targetObject)
    if (targetReference !== undefined) {
      node.target = targetReference
    } else if (typeof node.target === 'string' && node.targetSource === undefined) {
      const targetParameter = [...(node.inputs ?? []), ...(node.locals ?? [])].find(item => item.index === node.targetIndex)
      const cid = node.targetClass ?? originalParameterClass(targetParameter?.pinType ?? targetParameter?.type)
      if (cid !== undefined) node.target = resolve(node.target, cid) ?? node.target
    }
  }
  for (const operation of clone.operations ?? []) for (const item of [...operation.inputs, operation.output]) parameter(item)
  // A script's owner is a CKBeObject: messages reach it by identity, like any remapped reference.
  for (const [root, owner] of Object.entries(clone.owners ?? {})) clone.owners![root] = resolve(owner, CKCID.BEOBJECT) ?? owner
  return clone
}

/**
 * A document's graph for copied scripts: only the copied roots, renamed to
 * their copies' names, and every object reference (an object-typed parameter
 * or a behavior target) that names a copied object of this document turned
 * into the copy's reference. References to objects that were not copied stay.
 */
function remapGraph(data: OriginalGraphData, document: string, map: ReadonlyMap<number, number>, context: OriginalContext,
  roots: readonly { original: string; copy: string }[], source?: OriginalGraphRuntime): OriginalGraphData {
  const names = new Map<string, string | null>()
  for (const [original, copy] of map) {
    const object = context.get(original)
    if (object?.document !== document) continue
    names.set(object.name, names.has(object.name) ? null : originalObjectReference(copy))
  }
  const remap = (value: string) => {
    const reference = names.get(value)
    if (reference === null) throw new Error(`Copied ${document} objects share the name ${value}`)
    return reference
  }
  const clone = JSON.parse(JSON.stringify(data)) as OriginalGraphData
  const parameter = (item: OriginalGraphParameter) => {
    if (item.null || typeof item.value !== 'string') return
    if (originalParameterClass(item.pinType ?? item.type) === undefined) return
    const reference = remap(item.value)
    if (reference !== undefined) item.value = reference
  }
  for (const node of Object.values(clone.nodes)) {
    for (const list of [node.inputs, node.outputs, node.locals]) for (const item of list ?? []) parameter(item)
    if (typeof node.target === 'string') node.target = remap(node.target) ?? node.target
  }
  for (const operation of clone.operations ?? []) for (const item of [...operation.inputs, operation.output]) parameter(item)
  const kept = clone.roots.filter(root => roots.some(item => item.original === clone.nodes[String(root)]!.name))
  for (const root of kept) {
    const node = clone.nodes[String(root)]!
    node.name = roots.find(item => item.original === node.name)!.copy
    const owner = clone.owners?.[String(root)]
    if (owner !== undefined && clone.owners) clone.owners[String(root)] = remap(owner) ?? owner
  }
  clone.roots = kept
  if (source) {
    // `CKContext::CopyObjects` copies the behaviors of the copied objects but
    // not a parameter-in whose source is a behavior outside that set: the copy
    // keeps reading the template's parameter (CKParameterIn::Copy leaves such a
    // source shared). The template's Init has already resolved those locals, so
    // the copy starts with their live values instead of the saved NULL. This is a
    // snapshot at copy time: a later write to the template's parameter does not
    // reach the copy, where the original would read it live.
    const included = new Set<number>()
    const include = (index: number) => {
      if (included.has(index)) return
      included.add(index)
      for (const child of clone.nodes[String(index)]?.children ?? []) include(child)
    }
    for (const root of clone.roots) include(root)
    const owners = new Map<number, number>()
    for (const node of Object.values(clone.nodes)) {
      for (const list of [node.inputs, node.outputs, node.locals]) for (const item of list ?? []) owners.set(item.index, node.index)
    }
    for (const operation of clone.operations ?? []) for (const item of [...operation.inputs, operation.output]) owners.set(item.index, operation.owner)
    const seed = (item: OriginalGraphParameter) => {
      const owner = owners.get(item.index)
      if (owner !== undefined && included.has(owner)) return
      const live = source.value(item.index)
      if (live === undefined || live === null) return
      item.value = structuredClone(live)
      delete item.null
    }
    for (const node of Object.values(clone.nodes)) {
      for (const list of [node.inputs, node.outputs, node.locals]) for (const item of list ?? []) seed(item)
    }
    for (const operation of clone.operations ?? []) for (const item of [...operation.inputs, operation.output]) seed(item)
  }
  return clone
}

/**
 * The document binding inside a session: the context's loading, creation,
 * copying and groups, the other documents' scripts, and context references
 * (`#<id>`) turned back into names for the object and Data Array lookups of
 * the underlying binding.
 */
/**
 * A CKGroup as a behavior's object: CKGroup::Show (ObjImpls/CKGroup.cpp) sets
 * its own CK_OBJECT_VISIBLE and calls Show on every member, so a group show
 * reaches nested groups, 2D entities and 3D entities alike.
 */
function groupObject(context: OriginalContext, group: OriginalObject): GraphObjectBinding {
  const apply = (object: OriginalObject, visible: boolean): void => {
    if (originalIsChildClassOf(object.classId, CKCID.GROUP)) {
      object.state.visible = visible
      for (const id of object.members ?? []) {
        const member = context.get(id)
        if (member) apply(member, visible)
      }
    } else if (originalIs2dEntity(object)) {
      original2dState(object).visible = visible
    } else if (context.isEntity(object.id)) {
      context.entities.setVisible(originalObjectReference(object.id), visible)
    }
  }
  return new Proxy({} as GraphObjectBinding, {
    get: (_target, key) => {
      if (key === 'visible') return group.state.visible === true
      if (key === 'then') return undefined
      throw new Error(`${String(key)} of the group ${group.name} is not a group member`)
    },
    set: (_target, key, value) => {
      if (key !== 'visible') throw new Error(`${String(key)} of the group ${group.name} is not a group member`)
      apply(group, value === true)
      return true
    },
  })
}

/** How `Intersect` treats a candidate: not a 3D entity, a character, a 3D sprite or any other 3D entity. */
/**
 * A CK2dEntity as a behavior's object: CKObject::Show(CKSHOW / CKHIDE) sets
 * or clears CK_OBJECT_VISIBLE (CK2.dll 0x24020F9C); Get Position reads the
 * live pixel rect (RCK2dEntity::GetPosition with hom = FALSE, CK2_3D
 * 0x1005D369), which the render-time UpdateExtents keeps current. A 3D member
 * fails loudly.
 */
function entity2dObject(context: OriginalContext, object: OriginalObject): GraphObjectBinding {
  const state = original2dState(object)
  const position = (): [number, number, number] => {
    const viewport = context.render.viewport
    if (!viewport) throw new Error(`Get Position on the 2D entity ${object.name} needs the render context's viewport`)
    original2dUpdateExtents(state, viewport)
    if (!state.rect) throw new Error(`The 2D entity ${object.name} has no pixel rect`)
    // A CK2dEntity's GetPosition(hom = FALSE) writes a Vx2DVector (two floats).
    return [state.rect[0], state.rect[1]] as unknown as [number, number, number]
  }
  return new Proxy({} as GraphObjectBinding, {
    get: (_target, key) => {
      if (key === 'visible') return state.visible
      if (key === 'position') return position()
      if (key === 'then') return undefined
      throw new Error(`${String(key)} of the 2D entity ${object.name} is a 3D entity member`)
    },
    set: (_target, key, value) => {
      if (key !== 'visible') throw new Error(`${String(key)} of the 2D entity ${object.name} is a 3D entity member`)
      state.visible = value === true
      return true
    },
  })
}

function rayClass(classId: number): 'object' | 'character' | 'sprite' | undefined {
  if (!originalIsChildClassOf(classId, CKCID['3DENTITY'])) return undefined
  if (originalIsChildClassOf(classId, CKCID.CHARACTER)) return 'character'
  if (originalIsChildClassOf(classId, CKCID.SPRITE3D)) return 'sprite'
  return 'object'
}

/**
 * A context mesh's live texture coordinates for `TT_TextureSine`: the modifier
 * UVs of the default channel, in Virtools UV space. `commit` writes them back
 * and bumps the mesh's UV revision so the view redraws (`CKMesh::UVChanged`).
 */
function contextMeshUVs(context: OriginalContext, value: string): GraphMeshUVs | undefined {
  // The behavior's target is the mesh itself (CKBehavior::GetTarget, TT_Gravity_RT 0x1000696C).
  const mesh = context.resolve(value)
  if (!mesh || !originalIsChildClassOf(mesh.classId, CKCID.MESH)) return undefined
  const source = mesh.geometry
  if (!source) return undefined
  const uvs = Float32Array.from(source.uvs)
  return {
    uvs,
    commit: () => {
      mesh.geometry = { ...(mesh.geometry ?? source), uvs: Array.from(uvs) }
      mesh.state.uvRevision = Number(mesh.state.uvRevision ?? 0) + 1
    },
  }
}

function sessionBinding(binding: GraphBinding, context: OriginalContext, scripts: GraphScriptBinding,
  hooks: {
    loaded: (document: string) => void; copied: (map: ReadonlyMap<number, number>) => void; timer: GraphTimerBinding; particles: GraphParticleBinding | undefined
    filter: OriginalPlanarFilter
    time: { readonly manager: OriginalTimeManager }; database: OriginalDatabaseManager; destroyDynamic: () => void; deleteCollisionSurfaces: () => boolean
  }): GraphBinding {
  const contextBinding = originalContextBinding(context)
  const effect = binding.effect
  const sessionEffect: GraphEffectBinding | undefined = effect && {
    ...effect,
    meshUVs: value => contextMeshUVs(context, value),
  }
  const loader: GraphContextBinding = {
    ...contextBinding,
    ...(binding.movie ? { movie: binding.movie } : {}),
    load: (path, options) => {
      const objects = contextBinding.load(path, options)
      const document = objects?.length ? context.get(objects[0]!.id)?.document : undefined
      if (document) hooks.loaded(document)
      return objects
    },
  }
  const entity = (value: string) => {
    const object = context.resolve(value)
    return object && context.isEntity(object.id) ? originalObjectReference(object.id) : undefined
  }
  const required = (value: string) => {
    const object = context.resolve(value)
    if (!object) throw new Error(`${value} is not in the context`)
    return object
  }
  const entityReference = (value: string) => {
    const reference = entity(value)
    if (!reference) throw new Error(`${value} is not a 3D entity in the context`)
    return reference
  }
  const name = (value: string) => /^#\d+$/.test(value) ? context.resolve(value)?.name ?? value : value
  const requiredSystem = () => {
    if (!binding.system) throw new Error('The TT Database-Manager needs the host system binding for file access')
    return binding.system
  }
  const lifecycle: GraphLifecycleBinding = {
    create: (classId, objectName, dynamic) => loader.create(classId, objectName, dynamic),
    copy: (source, dependencies, dynamic) => {
      const object = context.resolve(source)
      // ObjectCopier skips NULL sources and never duplicates a level.
      if (!object || originalIsChildClassOf(object.classId, CKCID.LEVEL)) return undefined
      if (dependencies === undefined) throw new Error(`Object Copy of ${object.name} has no saved dependency options`)
      const map = context.copyObjects([object.id], originalCopyDependencies(dependencies), dynamic)
      hooks.copied(map)
      return originalObjectReference(map.get(object.id)!)
    },
  }
  const overrides: Partial<GraphBinding> = {
    ...(sessionEffect ? { effect: sessionEffect } : {}),
    scripts,
    context: loader,
    lifecycle,
    attributes: originalAttributeBinding(context),
    // The session runs in original units: context entities are the CK3dEntity transforms themselves.
    coordinateScale: 1,
    object: value => {
      const reference = entity(value)
      if (reference) {
        return originalEntityObject(context.entities, reference, 1, () => {
          // CKPGUID_BOX order is (Max, Min); the object binding's bounds are (Min, Max).
          const box = contextBinding.boundingBox(reference, true)
          return box ? [box[3]!, box[4]!, box[5]!, box[0]!, box[1]!, box[2]!] : undefined
        })
      }
      const object = context.resolve(value)
      if (object && originalIsChildClassOf(object.classId, CKCID.GROUP)) return groupObject(context, object)
      return object && originalIs2dEntity(object) ? entity2dObject(context, object) : binding.object(name(value))
    },
    frame: value => {
      const reference = entity(value)
      return reference ? originalEntityFrame(context.entities, reference, 1) : binding.frame?.(name(value))
    },
    timer: hooks.timer,
    ...(hooks.particles ? { particles: hooks.particles } : {}),
    filter: hooks.filter,
    time: hooks.time,
    dynamic: { destroyAll: hooks.destroyDynamic },
    collisionSurfaces: { delete: hooks.deleteCollisionSurfaces },
    // The TT Database-Manager reads and writes the install's files through the host's system binding;
    // the arrays it fills are the session's Data Arrays.
    database: {
      manager: hooks.database,
      read: path => requiredSystem().readFile(path),
      write: (path, bytes) => requiredSystem().writeFile(path, bytes),
      console: message => binding.system?.console(message, false),
      arrays: {
        snapshot: arrayName => {
          const rows = binding.array?.(arrayName)
          if (!rows) return undefined
          const { columns, keyColumn } = originalArrayLayout(arrayName, rows)
          return { name: arrayName, columns, keyColumn, rows: rows.map(row => row.map(cell => typeof cell === 'number' || typeof cell === 'string' ? cell : String(cell ?? ''))) }
        },
        reset: arrayName => {
          const rows = binding.array?.(arrayName)
          if (!rows) throw new Error(`Load Database would create the Data Array ${arrayName}, which the host does not hold`)
          originalArraySetLayout(rows, [])
        },
        fill: (arrayName, table) => {
          const rows = binding.array?.(arrayName)
          if (!rows) throw new Error(`Load Database fills ${arrayName}, which the host does not hold`)
          originalArraySetLayout(rows, table.columns, table.keyColumn)
          for (const row of table.rows) rows.push([...row])
        },
      },
    },
    // TT Simple Shadow's material and per-frame projections are render-context state.
    shadow: {
      create: () => { context.render.shadow = { projections: [] } },
      reset: () => { delete context.render.shadow },
      project: (target, settings) => {
        if (!context.render.shadow) throw new Error(`TT Simple Shadow projects ${target} without its material`)
        context.render.shadow.projections.push({ target, settings: { ...settings } })
      },
    },
    // The render context and cameras are context state (CKCamera front/back planes in original units).
    camera: {
      attach: value => {
        const camera = required(value)
        if (!originalIsChildClassOf(camera.classId, CKCID.CAMERA)) throw new Error(`AttachViewpointToCamera on ${camera.name}, which is not a camera`)
        context.render.camera = camera.id
      },
      setClipping: (value, near, far) => {
        const camera = required(value)
        if (!originalIsChildClassOf(camera.classId, CKCID.CAMERA)) throw new Error(`Set Clipping Planes on ${camera.name}, which is not a camera`)
        Object.assign(camera.state, { frontPlane: near, backPlane: far })
      },
    },
    extra: {
      children: value => context.childrenOf(required(value).id).map(originalObjectReference),
      name: value => required(value).name,
      position: (value, referential) => context.entities.position(entityReference(value), referential && entityReference(referential)),
      setPosition: (value, position, referential) =>
        context.entities.setPosition(entityReference(value), position, referential && entityReference(referential), false),
      show: (value, shown) => context.entities.setVisible(entityReference(value), shown),
      // CKScene::DeActivate stops the object's scripts in the scheduler; without scripts only the flag changes.
      // CKScene::DeActivate: the object leaves the behavior manager, so its scripts stop running.
      deactivate: value => { required(value).sceneActive = false },
      // CKScene::Activate(owner, FALSE): the owner joins the behavior manager (no initial value reload).
      awakeOwner: value => {
        const script = context.resolve(value)
        const owner = script && context.scriptOwner(script.id)
        if (owner && !owner.sceneActive) owner.sceneActive = true
      },
      groupObject: (group, index) => loader.members(group)?.[index],
    },
    // Ray Intersection over the context's 3D entities and meshes (RayIntersection.cpp).
    rayIntersection: ray => {
      const group = ray.group === undefined ? undefined : context.resolve(ray.group)
      if (ray.group !== undefined && !group) throw new Error(`Ray Intersection filter group ${ray.group} is not in the context`)
      const hit = originalRayIntersection(context.rayCandidates(group), ray.origin, ray.direction, ray.depth,
        ray.owner === undefined ? undefined : entity(ray.owner), ray.skipTransparent, rayClass)
      return hit && {
        object: hit.entity, faceIndex: hit.faceIndex, nearestVertex: hit.nearestVertex,
        point: hit.point, normal: hit.normal, distance: hit.distance,
      }
    },
    children: value => {
      const reference = entity(value)
      return reference ? context.entities.children(reference) : binding.children?.(name(value))
    },
    array: value => binding.array?.(name(value)),
    group: value => loader.members(value) ?? binding.group?.(name(value)),
    // A context object restores its TT Save IC value; others go to the host.
    restoreInitial: value => { if (!loader.restoreSaved(value)) binding.restoreInitial?.(name(value)) },
  }
  return new Proxy(binding, {
    get: (target, key, receiver) => key in overrides ? overrides[key as keyof GraphBinding] : Reflect.get(target, key, receiver),
  })
}
