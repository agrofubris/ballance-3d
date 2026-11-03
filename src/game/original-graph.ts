import * as THREE from 'three'
import { originalGetCell } from './original-behaviors.ts'
import { EFFECT_BEHAVIORS } from './original-graph-effects.ts'
import { MODULE_BEHAVIORS } from './original-graph-module-behaviors.ts'
import { PHYSICS_BEHAVIORS } from './original-graph-physics.ts'
import { SCRIPT_BEHAVIORS } from './original-graph-script.ts'
import { TUTORIAL_BEHAVIORS } from './original-graph-tutorial.ts'
import { GAMEPLAY_BEHAVIORS } from './original-graph-gameplay.ts'
import { PARTICLE_BEHAVIORS, CrtRandom } from './original-particle-system.ts'
import { CONTACT_BEHAVIORS } from './original-graph-contact.ts'
import { RENDER_BEHAVIORS } from './original-graph-render.ts'
import { ARRAY_BEHAVIORS, originalArraySetCell } from './original-graph-array.ts'
import { CONTEXT_BEHAVIORS } from './original-graph-context.ts'
import { SOUND_BEHAVIORS } from './original-graph-sound.ts'
import { MATERIAL_BEHAVIORS } from './original-graph-material.ts'
import { EXTRA_BEHAVIORS, EXTRA_CALLBACKS } from './original-graph-extra.ts'
import { INTERFACE_BEHAVIORS, INTERFACE_LOAD_CALLBACKS } from './original-graph-interface.ts'
import { MENU_BEHAVIORS } from './original-graph-menu.ts'
import { CURVE_BEHAVIORS } from './original-graph-curve.ts'
import { ENVIRONMENT_BEHAVIORS } from './original-graph-environment.ts'
import { SYSTEM_BEHAVIORS, type GraphSystemBinding } from './original-graph-system.ts'
import { DATABASE_BEHAVIORS, type GraphDatabaseBinding, type OriginalTimeManager } from './original-graph-database.ts'
import { MOVIE_BEHAVIORS } from './original-graph-movie.ts'
import { CKCID, originalParameterClass } from './original-context.ts'
import { originalConvert } from './original-convert.ts'
import { crtQsort } from './original-crt-qsort.ts'
export { originalBooleanFromString, originalBooleanToString, originalConvert, originalFloatFromString, originalFloatToInteger, originalFloatToString, originalIntegerFromString, originalIntegerToString, originalPercentageFromString, originalPercentageToString, originalTimeToString } from './original-convert.ts'
import { originalNormalize } from './original-ray.ts'
import type { GraphParticleBinding } from './original-particle-system.ts'
import { authoredVectorToBinding } from './original-graph-bindings.ts'
import type { GraphContextBinding, GraphAttributeBinding, GraphExtraBinding, GraphTimerBinding, GraphAudioBinding, GraphBinding, GraphCameraBinding, GraphEffectBinding, GraphFilterBinding, GraphLifecycleBinding, GraphLightBinding, GraphObjectBinding, GraphPhysicsBinding, GraphRay, GraphRayHit, GraphShadowBinding, GraphSkyBinding, GraphTutorialBinding } from './original-graph-bindings.ts'
export type { GraphAttributeBinding, GraphAudioBinding, GraphBinding, GraphCameraBinding, GraphEffectBinding, GraphFilterBinding, GraphLifecycleBinding, GraphLightBinding, GraphObjectBinding, GraphPhysicsBinding, GraphShadowBinding, GraphSkyBinding, GraphTutorialBinding } from './original-graph-bindings.ts'

// Generic executor for the authored Virtools CKBehavior graphs exported by
// scripts/export-original-graph.py. The runtime owns parameter storage,
// activation propagation (outIO -> inIO) and data propagation
// (output -> input), so behaviors only implement their own contract.
export type GraphParameterValue = number | boolean | string | number[] | null

export interface OriginalGraphParameter {
  index: number
  value?: GraphParameterValue
  name?: string
  raw?: string
  /** CKParameter type GUID as 16 hex digits, when the exporter decoded it. */
  type?: string
  /** For a parameter-in, the parameter index it references. */
  source?: number
  /** For a parameter-out, the parameter indices its serialized links write. */
  targets?: number[]
  /** An object reference saved as NULL; `value` is then only the parameter's own name. */
  null?: boolean
  /** A parameter-in's own type GUID, when it differs from its source's `type`. */
  pinType?: string
  /** The saved object reference (the document's file index), when the value is one. */
  object?: number
  /**
   * CK_STATESAVE_PARAMETERLOCAL_MYSELF (chunk 0x200): the parameter holds its
   * behavior's owner, bound by CKParameterLocal::SetAsMyselfParameter at load.
   */
  myself?: boolean
  /**
   * A CKKeyedAnimation object input: its length and the sub-animation names
   * Play Global Animation steps (their controllers are in the object export).
   */
  keyedAnimation?: { length: number; animations: string[] }
}
export interface OriginalGraphNode {
  index: number
  name: string
  /** Prototype GUID (`d1:d2` hex) of a primitive building block; absent for scripts. */
  prototype?: string
  /** The building block's version as saved (CKBehavior::GetVersion). */
  version?: number
  target?: string
  /** Parameter index backing `target`; a live write here retargets the node. */
  targetIndex?: number
  /** For a parameter-in target, the parameter it references. */
  targetSource?: number
  /** The saved object reference backing `target`, when it is one. */
  targetObject?: number
  targetClass?: number
  children?: number[]
  links?: number[]
  inputs?: OriginalGraphParameter[]
  outputs?: OriginalGraphParameter[]
  locals?: OriginalGraphParameter[]
  inIO?: OriginalGraphParameter[]
  outIO?: OriginalGraphParameter[]
  /** CKBehavior priority (chunk 0x20); the parent compound runs higher priorities first. */
  priority?: number
}
export interface OriginalGraphLink { index: number; from: number; to: number; type: number; delay?: number }
export interface OriginalGraphData {
  source: string
  nodes: Record<string, OriginalGraphNode>
  links: OriginalGraphLink[]
  roots: number[]
  /** Root script index -> the CKBeObject that owns it (its chunk 0x800 script list). */
  owners?: Record<string, string>
  /** Scene entity hierarchy of the source document: parent name -> child names. */
  hierarchy?: Record<string, string[]>
  /** CKParameterOperations owned by compounds, outside any building block. */
  operations?: OriginalGraphOperation[]
}

/** A CKParameterOperation: `output = operation(inputs[0], inputs[1])`, computed when read. */
export interface OriginalGraphOperation {
  index: number
  name: string
  /** Operation GUID as `xxxxxxxx:xxxxxxxx`. */
  guid: string
  /** The compound behavior that owns it. */
  owner: number
  inputs: OriginalGraphParameter[]
  output: OriginalGraphParameter
}

export interface GraphRuntimeOptions {
  /** Message queue shared with other documents; a private one by default. */
  bus?: GraphMessageBus
  /**
   * Building blocks the host knowingly leaves unimplemented. Any other
   * unregistered primitive throws when it is activated.
   */
  inert?: Iterable<string>
  /** `record` collects unregistered primitives in `unimplemented` instead of throwing (coverage tooling). */
  unknown?: 'throw' | 'record'
}

export interface BehaviorContext {
  readonly node: OriginalGraphNode
  readonly frame: number
  /** Frame duration in milliseconds, the Virtools `DeltaTime`. */
  readonly deltaMs: number
  readonly inputCount: number
  /** Activation (inIO) pins of this behavior, as opposed to its parameters. */
  readonly inCount: number
  readonly outputCount: number
  readonly outCount: number
  /** The inIO slot that triggered this run. */
  readonly inputSlot: number
  isInputActive(slot: number): boolean
  consumeInput(slot: number): void
  input(slot: number): GraphParameterValue
  /**
   * An object input as `GetInputParameterObject` returns it: the name, or
   * undefined for a NULL reference (saved NULL and not written since).
   */
  inputObject(slot: number): string | undefined
  /** `CKParameterIn::GetGUID`: the input's own type GUID (16 hex digits). */
  inputType(slot: number): string | undefined
  /** `CKParameterOut::GetGUID`: the output's own type GUID. */
  outputType(slot: number): string | undefined
  /** Whether the input has a source (`CKParameterIn::GetRealSource` is not NULL). */
  inputHasSource(slot: number): boolean
  /**
   * The exported chunk bytes (hex) of the parameter an input finally reads,
   * for types the exporter keeps undecoded (a CK2dCurve, a saved buffer).
   */
  inputRaw(slot: number): string | undefined
  /** The exported chunk bytes (hex) of a local parameter. */
  localRaw(slot: number): string | undefined
  output(slot: number): GraphParameterValue
  setOutput(slot: number, value: GraphParameterValue): void
  local(slot: number): GraphParameterValue
  setLocal(slot: number, value: GraphParameterValue): void
  /** The message named by a message input: its value, or the name of the pin it reads. */
  messageKey(slot: number): GraphMessageId
  /** Fire an activation output; its links activate the target behaviors. */
  activate(slot: number): void
  /** Fire an activation output on the next frame instead of this one. */
  activateNextFrame(slot: number): void
  /** Keep this behavior active: run it again next frame until it fires. */
  wait(): void
  /** Activate or deactivate another script (Activate/Deactivate Script). */
  script(name: string, active: boolean, reset?: boolean): void
  /** Whether a key is currently held (Key Event). */
  keyDown(key: number): boolean
  /** The behavior's authored target, following a live target parameter. */
  targetName(): string
  /** Resolve the behavior's target, or a named object reference. */
  object(name?: string): GraphObjectBinding | undefined
  /** Resolve the behavior's Data Array target, or a named reference. */
  array(name?: string): GraphParameterValue[][] | undefined
  /** The live player's authored object name (`Ball_Wood`, ...). */
  activeBall(): string | undefined
  /** The document's exported scene hierarchy: parent name -> child names. */
  readonly hierarchy: Record<string, string[]> | undefined
  /** Send a message to a target (Send Message). */
  sendMessage(id: GraphMessageId, target: string | undefined, args: GraphParameterValue[]): void
  /** The owner's (or target's) messages delivered at the end of the last frame (Switch On Message). */
  lastFrameMessages(receiver?: string): GraphMessage[]
  /**
   * CKMessageManager::RegisterWait for this behavior: when a matching message
   * is delivered, `onMessage` runs and output `slot` is activated for the next
   * frame. The behavior keeps its compound active while it waits.
   */
  registerWait(id: GraphMessageId, slot: number, receiver: string | undefined, onMessage: (message: GraphMessage) => void): GraphMessageWaiter
  unregisterWait(waiter: GraphMessageWaiter): void
  /** World units per authored original unit, for proximity thresholds. */
  readonly coordinateScale: number
  /** Engine bindings for the physics/audio/effect behaviors, when supplied. */
  /**
   * Restore a scene entity to its saved initial state (`CKReadObjectState`)
   * and return the entities visited, or undefined when no binding exists.
   * `children` also visits the target's descendants depth-first, as the
   * `TT Restore IC` DLL does through `HierarchyParser`.
   */
  restoreInitial(name: string | undefined, children: boolean): string[] | undefined
  readonly physics: GraphPhysicsBinding | undefined
  readonly audio: GraphAudioBinding | undefined
  readonly effect: GraphEffectBinding | undefined
  readonly light: GraphLightBinding | undefined
  readonly tutorial: GraphTutorialBinding | undefined
  readonly sky: GraphSkyBinding | undefined
  readonly shadow: GraphShadowBinding | undefined
  readonly particles: GraphParticleBinding | undefined
  readonly camera: GraphCameraBinding | undefined
  readonly attributes: GraphAttributeBinding | undefined
  readonly lifecycle: GraphLifecycleBinding | undefined
  readonly filter: GraphFilterBinding | undefined
  readonly loader: GraphContextBinding | undefined
  readonly extra: GraphExtraBinding | undefined
  readonly timer: GraphTimerBinding | undefined
  readonly system: GraphSystemBinding | undefined
  readonly database: GraphDatabaseBinding | undefined
  readonly time: { readonly manager: OriginalTimeManager } | undefined
  readonly dynamic: { destroyAll(): void } | undefined
  readonly collisionSurfaces: { delete(): boolean } | undefined
  /** `CKBeObject::GetScript(slot)` of an object, as a reference; undefined past its scripts. */
  scriptOf(object: string, slot: number): string | undefined
  /** The object owning this behavior's root script (a particle system's frame). */
  owner(): string | undefined
  /** Member names of an authored group, or undefined when unknown. */
  group(name: string): string[] | undefined
  /** `Ray Intersection` through the binding; fails loudly without one. */
  rayIntersection(ray: GraphRay): GraphRayHit | undefined
  /**
   * `CKBehavior::IsActive` for a root script of this document: whether any of
   * its behaviors still has an activation queued for this frame, the next one or
   * a link delay. Undefined when this document has no such root script.
   */
  isScriptActive(name: string): boolean | undefined
}
export type BehaviorState = Record<string, unknown>
export type BehaviorFn = (context: BehaviorContext, state: BehaviorState) => void
export type BehaviorRegistry = Record<string, BehaviorFn>
/**
 * A block's behavior callback (CKBEHAVIOR_CALLBACKS): `reset` is
 * CKM_BEHAVIORRESET, run before the block's state is dropped;
 * `deactivateScript` is CKM_BEHAVIORDEACTIVATESCRIPT, sent to every
 * sub-behavior of a script that is deactivated.
 */
export type BehaviorCallback = (context: BehaviorContext, state: BehaviorState, message: 'reset' | 'deactivateScript') => void

/** A CKMessageType, identified by its message name (decoded from the file's CKMessageManager table). */
export type GraphMessageId = number | string
/** `target` is the destination CKBeObject (an object or group name); undefined reaches every receiver. */
export interface GraphMessage { id: GraphMessageId; target?: string; args: GraphParameterValue[] }

/** A Wait Message registration (CKMessageManager::RegisterWait). */
export interface GraphMessageWaiter { id: GraphMessageId; receiver?: string; wake(message: GraphMessage): void }

const reaches = (message: GraphMessage, receiver?: string) =>
  receiver === undefined || message.target === undefined || message.target === receiver

/**
 * The CKMessageManager. Documents that share one bus receive each other's
 * messages, as in Virtools where every loaded file posts to the same manager.
 * Messages sent during a frame are delivered by `postProcess` after every
 * script ran: they become the receivers' last-frame messages (replacing the
 * previous ones) and wake the matching waiters, once per registration.
 */
export class GraphMessageBus {
  /** Sent this frame, not delivered yet. */
  readonly messages: GraphMessage[] = []
  /** Delivered by the last `postProcess`: every receiver's last-frame messages. */
  private delivered: GraphMessage[] = []
  private readonly waiters: GraphMessageWaiter[] = []
  frame = 0

  post(message: GraphMessage) {
    this.messages.push(message)
  }

  registerWait(waiter: GraphMessageWaiter) {
    this.waiters.push(waiter)
  }

  unregisterWait(waiter: GraphMessageWaiter) {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
  }

  /** CKMessageManager::PostProcess: deliver this frame's messages. */
  postProcess() {
    this.frame++
    this.delivered = this.messages.splice(0)
    for (const message of this.delivered) {
      for (const waiter of [...this.waiters]) {
        if (waiter.id !== message.id || !reaches(message, waiter.receiver)) continue
        this.unregisterWait(waiter)
        waiter.wake(message)
      }
    }
  }

  /** A receiver's last-frame messages (CKBeObject::GetLastFrameMessage). */
  lastFrame(receiver?: string): GraphMessage[] {
    return this.delivered.filter(message => reaches(message, receiver))
  }

  /** Take a delivered message for a host that stands in for a receiver script. */
  take(id: GraphMessageId, receiver?: string): GraphMessage | undefined {
    const index = this.delivered.findIndex(message => message.id === id && reaches(message, receiver))
    return index < 0 ? undefined : this.delivered.splice(index, 1)[0]
  }

  clear() {
    this.messages.length = 0
    this.delivered = []
    this.waiters.length = 0
  }
}

type ParamOwner = { node: number; list: 'inIO' | 'outIO' | 'inputs' | 'outputs' | 'locals'; slot: number }

/** A CKBehaviorLink of one compound (m_SubBehaviorLinks) with its delay countdown. */
interface SchedulerLink { from: number; to: number; initial: number; delay: number; inDelayed: boolean }

/** A compound's graph data as CK2.dll executes it. */
interface SchedulerCompound {
  index: number
  /** Sub-behaviors in execution order: the saved order re-sorted by MSVCRT qsort on priority (SortSubs). */
  subs: number[]
  links: SchedulerLink[]
  linksFrom: Map<number, SchedulerLink[]>
  /** Links counting down a delay (m_Links). */
  delayed: SchedulerLink[]
}

/** The behavior iteration limit the documents save for CKBehaviorManager (0x13880). */
const MAX_ITERATIONS = 80000
/** The virtual compound that holds every parentless node: the root scripts. */
const TOP = -1

const number = (value: GraphParameterValue) => typeof value === 'number' ? value : Number(value ?? 0)
const bool = (value: GraphParameterValue) => typeof value === 'boolean' ? value : Number(value ?? 0) !== 0
/** CKPGUID_FLOAT and the types derived from it (angle, time, percentage), as exported type GUIDs. */
const FLOAT_DERIVED_TYPES = new Set(['3f4c8847202c2c43', '2b42b4544f0f0f73', 'f52c26113a23b030', '4e4bc8f334ccfa0f'])
/** CKPGUID_BOOL. */
const BOOL_TYPE = '8e2ad51a2019745e'
/** Logics.dll's float 1 / RAND_MAX (0x254A13EC). */
const RAND_MAX_RECIPROCAL = Math.fround(1 / 32767)

const compare = (operator: number, eq: boolean, neq: boolean, lt: boolean, lte: boolean, gt: boolean, gte: boolean) =>
  operator === 1 ? eq : operator === 2 ? neq : operator === 3 ? lt : operator === 4 ? lte : operator === 5 ? gt : operator === 6 ? gte : false

const copyValue = (value: GraphParameterValue): GraphParameterValue => Array.isArray(value) ? [...value] : value

export class OriginalGraphRuntime {
  readonly data: OriginalGraphData
  private registry: BehaviorRegistry
  private binding?: GraphBinding
  private owners = new Map<number, ParamOwner>()
  private values = new Map<number, GraphParameterValue>()
  /** Authored parameter values captured at construction, restored by reset. */
  private initialValues = new Map<number, GraphParameterValue>()
  /** Object parameters holding a NULL reference (saved NULL, not written since). */
  private readonly nullObjects = new Set<number>()
  /** Parameters saved with CK_STATESAVE_PARAMETERLOCAL_MYSELF (chunk 0x200). */
  private readonly myselfParameters = new Set<number>()
  /** Parameter operations by output parameter, and those being computed. */
  private readonly operationOutputs = new Map<number, OriginalGraphOperation>()
  private readonly operating = new Set<number>()
  private readonly initialNullObjects = new Set<number>()
  private readonly raws = new Map<number, string>()
  private states = new Map<number, BehaviorState>()
  /** Nearest containing compound/root node, for script gating. */
  private parents = new Map<number, number>()
  private dataLinks = new Map<number, number[]>()
  /** Serialized parameter-out links (chunk 0x20) keyed by source parameter. */
  private outputTargets = new Map<number, number[]>()
  /** Active behavior IO parameters (CKBehaviorIO active flag). */
  private readonly ioActive = new Set<number>()
  /** Behaviors with CKBEHAVIOR_ACTIVE. */
  private readonly activeNodes = new Set<number>()
  /** Behaviors already on an iterator stack (CKBEHAVIOR_RESERVED0). */
  private readonly reserved = new Set<number>()
  private readonly compounds = new Map<number, SchedulerCompound>()
  /** Script (de)activations applied at the next frame start (ACTIVATENEXTFRAME/DEACTIVATENEXTFRAME/RESETNEXTFRAME). */
  private readonly scriptRequests = new Map<number, { active: boolean; reset: boolean }>()
  /** Roots activated at least once (CKBEHAVIOR_LAUNCHEDONCE); a first activation always resets. */
  private readonly launched = new Set<number>()
  /** Roots whose scene activation is off (CK_SCENEOBJECT_ACTIVE cleared by a deactivation): never executed. */
  private readonly inactiveRoots = new Set<number>()
  /** Outputs a behavior asked to activate on the next frame. */
  private readonly nextFrameOutputs = new Set<number>()
  /** Set while a building block runs when it returned CKBR_ACTIVATENEXTFRAME. */
  private keepActive = false
  /** Behaviors registered with the message manager (CKBEHAVIOR_WAITSFORMESSAGE). */
  private readonly waiting = new Set<number>()
  /** Parameter-in -> the parameter it references (Virtools "real source"). */
  private paramSources = new Map<number, number>()
  /** Scripts enabled through Activate Script, keyed by behavior name. */
  readonly activeScripts = new Set<string>()
  /** Scripts disabled through Deactivate Script, keyed by behavior name. */
  readonly disabledScripts = new Set<string>()
  /** Root scripts whose activations a host postpones (see `holdScript`). */
  private readonly heldScripts = new Set<string>()
  /** Keys currently held, consumed by Key Event. */
  readonly heldKeys = new Set<number>()
  /** Message queue; private unless a shared bus was supplied, then the host advances it. */
  readonly bus: GraphMessageBus
  private readonly ownsBus: boolean
  private readonly inert: ReadonlySet<string>
  private readonly unknown: 'throw' | 'record'
  private readonly callbacks: Record<string, BehaviorCallback> = BEHAVIOR_CALLBACKS
  /** Unregistered primitives that were activated, in `unknown: 'record'` mode. */
  readonly unimplemented = new Set<string>()
  /** Non-fatal execution warnings (e.g. an activation loop that was capped). */
  readonly warnings: string[] = []
  frame = 0
  deltaMs = 1000 / 60
  /** Roots re-activated every frame. When unset, every root is fired. */
  frameRoots?: number[]
  /**
   * Whether a root script's owner is in the behavior manager this frame (an
   * object active in the scene, or the level). An active script whose owner
   * is not stays active without running. Unset, every root runs.
   */
  rootGate?: (root: number) => boolean

  constructor(data: OriginalGraphData, registry: BehaviorRegistry, binding?: GraphBinding, options: GraphRuntimeOptions = {}) {
    this.data = data
    this.registry = registry
    this.binding = binding
    this.ownsBus = !options.bus
    this.bus = options.bus ?? new GraphMessageBus()
    this.inert = new Set(options.inert ?? [])
    this.unknown = options.unknown ?? 'throw'
    for (const node of Object.values(data.nodes)) {
      if (node.targetIndex !== undefined && node.targetSource !== undefined) {
        this.paramSources.set(node.targetIndex, node.targetSource)
      }
      for (const list of ['inIO', 'outIO', 'inputs', 'outputs', 'locals'] as const) {
        node[list]?.forEach((parameter, slot) => {
          this.owners.set(parameter.index, { node: node.index, list, slot })
          if (parameter.source !== undefined) this.paramSources.set(parameter.index, parameter.source)
          if (parameter.targets?.length) this.outputTargets.set(parameter.index, parameter.targets)
          if (parameter.raw !== undefined) this.raws.set(parameter.index, parameter.raw)
          if (parameter.myself) this.myselfParameters.add(parameter.index)
          if (parameter.value !== undefined) {
            const value = copyValue(parameter.value)
            this.initialValues.set(parameter.index, value)
            this.values.set(parameter.index, copyValue(value))
          }
          if (parameter.null) {
            this.initialNullObjects.add(parameter.index)
            this.nullObjects.add(parameter.index)
          }
        })
      }
      for (const child of node.children ?? []) {
        if (!this.parents.has(child)) this.parents.set(child, node.index)
      }
      this.states.set(node.index, {})
    }
    for (const operation of data.operations ?? []) {
      this.operationOutputs.set(operation.output.index, operation)
      for (const parameter of [...operation.inputs, operation.output]) {
        if (parameter.source !== undefined) this.paramSources.set(parameter.index, parameter.source)
        if (parameter.targets?.length) this.outputTargets.set(parameter.index, parameter.targets)
        if (parameter.myself) this.myselfParameters.add(parameter.index)
        if (parameter.value !== undefined) {
          this.initialValues.set(parameter.index, copyValue(parameter.value))
          this.values.set(parameter.index, copyValue(parameter.value))
        }
        if (parameter.null) {
          this.initialNullObjects.add(parameter.index)
          this.nullObjects.add(parameter.index)
        }
      }
    }
    const activationLinks: OriginalGraphLink[] = []
    for (const link of data.links) {
      const owner = this.owners.get(link.from)
      // Activation links originate from an IO parameter (in or out); data links
      // originate from a value output.
      if (owner?.list === 'outIO' || owner?.list === 'inIO') activationLinks.push(link)
      else {
        const target = this.dataLinks.get(link.from) ?? []
        target.push(link.to)
        this.dataLinks.set(link.from, target)
      }
    }
    this.buildCompounds(activationLinks)
    // CKM_BEHAVIORLOAD reaches each loaded behavior in file order.
    for (const node of Object.values(data.nodes).sort((a, b) => a.index - b.index)) {
      const load = BEHAVIOR_LOAD_CALLBACKS[node.name]
      if (load && node.prototype) load(this.context(node, 0), this.states.get(node.index)!)
    }
  }

  /** The compound whose graph contains a link from this IO: its own input, or a sub-behavior's output. */
  private linkScope(io: number): number | undefined {
    const owner = this.owners.get(io)
    if (!owner) return undefined
    if (owner.list === 'inIO' && this.data.nodes[String(owner.node)]?.children?.length) return owner.node
    if (owner.list === 'outIO') return this.parents.get(owner.node) ?? TOP
    return undefined
  }

  /**
   * CKBehavior graph data: each compound's links in saved order (node `links`
   * when exported, otherwise the document's link order) and its sub-behaviors
   * re-sorted by MSVCRT qsort on descending priority, as HierarchyPostLoad's
   * SortSubs leaves them. Parentless nodes form the virtual top compound.
   */
  private buildCompounds(activationLinks: OriginalGraphLink[]) {
    const priority = (index: number) => this.data.nodes[String(index)]?.priority ?? 0
    const byIndex = new Map(activationLinks.map(link => [link.index, link]))
    const scoped = new Map<number, OriginalGraphLink[]>()
    for (const link of activationLinks) {
      const scope = this.linkScope(link.from)
      if (scope === undefined) continue
      const list = scoped.get(scope) ?? []
      list.push(link)
      scoped.set(scope, list)
    }
    const make = (index: number, children: number[], saved: OriginalGraphLink[]): SchedulerCompound => {
      const links = saved.map(link => ({ from: link.from, to: link.to, initial: link.delay ?? 0, delay: 0, inDelayed: false }))
      const linksFrom = new Map<number, SchedulerLink[]>()
      for (const link of links) linksFrom.set(link.from, [...linksFrom.get(link.from) ?? [], link])
      const subs = crtQsort([...children], (a, b) => priority(b) - priority(a))
      return { index, subs, links, linksFrom, delayed: [] }
    }
    for (const node of Object.values(this.data.nodes)) {
      if (!node.children?.length) continue
      const own = node.links?.map(index => byIndex.get(index)).filter((link): link is OriginalGraphLink => !!link)
      this.compounds.set(node.index, make(node.index, node.children, own?.length ? own : scoped.get(node.index) ?? []))
    }
    // Root scripts first in document order, then any other parentless node (hand-built graphs).
    const parentless = Object.values(this.data.nodes).map(node => node.index).filter(index => !this.parents.has(index))
    const top = [...this.data.roots, ...parentless.filter(index => !this.data.roots.includes(index)).sort((a, b) => a - b)]
    const topCompound = make(TOP, [], scoped.get(TOP) ?? [])
    topCompound.subs = top
    this.compounds.set(TOP, topCompound)
  }

  private context(node: OriginalGraphNode, inputSlot: number): BehaviorContext {
    // A parameter-in can reference another parameter; prefer its live value,
    // falling back to the authored value until the source is written.
    const readIndex = (index: number) => {
      const source = this.liveSource(index)
      return source !== index && this.values.has(source) ? source : index
    }
    // CKParameterLocal::SetAsMyselfParameter stores the behavior's owner as the
    // parameter's value, so a chunk-0x200 local reads as CKBehavior::GetOwner.
    const isMyself = (index: number) => {
      let current = index
      for (let guard = 0; guard < 64; guard++) {
        if (this.myselfParameters.has(current)) return true
        const source = this.paramSources.get(current)
        if (source === undefined) return false
        current = source
      }
      return false
    }
    const read = (list: 'inputs' | 'outputs' | 'locals', slot: number) => {
      const parameter = node[list]?.[slot]
      if (!parameter) return null
      if (isMyself(parameter.index)) {
        const owner = this.scriptOwner(node.index)
        if (owner !== undefined) return owner
      }
      const index = readIndex(parameter.index)
      if (isMyself(index)) {
        const owner = this.scriptOwner(node.index)
        if (owner !== undefined) return owner
      }
      return this.values.get(index) ?? (index === parameter.index ? parameter.value : undefined) ?? null
    }
    const write = (list: 'outputs' | 'locals', slot: number, value: GraphParameterValue) => {
      const parameter = node[list]?.[slot]
      if (!parameter) return
      this.setParameterValue(parameter.index, value)
    }
    // CKBehavior::GetTarget (CK2.dll 0x240035CE): the target parameter's live object. It reads the target
    // CK_ID (+0x68; the owner id +0x1C when the behavior has no target parameter) through
    // CKContext::GetObject (0x24034E9F), so a destroyed id resolves to NULL; there is no name fallback.
    // Menu_Init rewrites the target locals before it deletes anything: Op Get Object By Name 1739/1263/1779
    // (Logics.dll 0x2548C460, Get Object By Name GUID 599203f6:23b06096) stores base.nmo's ScreenModes /
    // DB_Levelfreischaltung and Language.nmo's all_keys into locals 1734/1258/1774, then Object Delete
    // 1746/1537/1786 destroys only Menu.nmo's Dummy_ScreenModes / Dummy_Freischalt / Dummy all_Keys.
    // Row Search 12147/13346 (Logics.dll 0x25497FB0) calls this GetTarget, so it searches those live arrays.
    const targetName = () => {
      const index = node.targetIndex
      if (index === undefined || index === null) return node.target ?? this.scriptOwner(node.index) ?? ''
      const live = this.values.get(this.liveSource(index))
      if (typeof live === 'string') return live
      return node.target ?? ''
    }
    const io = (list: 'inIO' | 'outIO', slot: number) => node[list]?.[slot]?.index
    return {
      node,
      frame: this.frame,
      deltaMs: this.deltaMs,
      inputCount: node.inputs?.length ?? 0,
      inCount: node.inIO?.length ?? 0,
      outputCount: node.outputs?.length ?? 0,
      outCount: node.outIO?.length ?? 0,
      inputSlot,
      isInputActive: slot => { const pin = io('inIO', slot); return pin !== undefined && this.ioActive.has(pin) },
      consumeInput: slot => { const pin = io('inIO', slot); if (pin !== undefined) this.ioActive.delete(pin) },
      input: slot => read('inputs', slot),
      inputType: slot => { const parameter = node.inputs?.[slot]; return parameter?.pinType ?? parameter?.type },
      outputType: slot => node.outputs?.[slot]?.type,
      inputHasSource: slot => node.inputs?.[slot]?.source !== undefined,
      inputObject: slot => {
        const parameter = node.inputs?.[slot]
        if (!parameter || this.nullObjects.has(readIndex(parameter.index))) return undefined
        const value = read('inputs', slot)
        return typeof value === 'string' && value ? value : undefined
      },
      inputRaw: slot => {
        const parameter = node.inputs?.[slot]
        return parameter ? this.raws.get(this.resolveSource(parameter.index)) ?? parameter.raw : undefined
      },
      localRaw: slot => node.locals?.[slot]?.raw,
      output: slot => read('outputs', slot),
      setOutput: (slot, value) => write('outputs', slot, value),
      local: slot => read('locals', slot),
      setLocal: (slot, value) => write('locals', slot, value),
      // CKBehavior::ActivateOutput: the parent follows the output's links after this block returns.
      activate: slot => { const pin = io('outIO', slot); if (pin !== undefined) this.ioActive.add(pin) },
      activateNextFrame: slot => { const pin = io('outIO', slot); if (pin !== undefined) this.nextFrameOutputs.add(pin) },
      // The block returns CKBR_ACTIVATENEXTFRAME and stays ACTIVE.
      wait: () => { this.keepActive = true },
      // CKScene::Activate/DeactivateScript: applied at the next frame start.
      script: (name, value, reset = true) => {
        // Another document's script goes to the session that runs it.
        if (!this.scriptRoots(name).length && this.binding?.scripts?.has(name)) this.binding.scripts.request(name, value, reset)
        else this.requestScript(name, value, reset)
      },
      // Controllers.dll Key Event/Key Waiter poll the CKInputManager (IsKeyDown); a
      // runtime without the session's input manager fills heldKeys instead.
      keyDown: key => this.binding?.system?.input.isKeyDown(key) ?? this.heldKeys.has(key),
      targetName,
      coordinateScale: this.binding?.coordinateScale ?? 0.25,
      object: name => this.binding?.object(name ?? targetName()),
      array: name => this.binding?.array?.(name ?? targetName()),
      activeBall: () => this.binding?.activeBall?.(),
      hierarchy: this.data.hierarchy,
      sendMessage: (id, target, args) => { this.bus.post({ id, target, args }) },
      lastFrameMessages: receiver => this.bus.lastFrame(receiver ?? this.scriptOwner(node.index)),
      registerWait: (id, slot, receiver, onMessage) => {
        const waiter: GraphMessageWaiter = {
          id,
          receiver: receiver ?? this.scriptOwner(node.index),
          wake: message => {
            this.waiting.delete(node.index)
            onMessage(message)
            const pin = io('outIO', slot)
            if (pin !== undefined) this.ioActive.add(pin)
            for (let parent = this.parents.get(node.index); parent !== undefined; parent = this.parents.get(parent)) this.activeNodes.add(parent)
          },
        }
        this.waiting.add(node.index)
        this.bus.registerWait(waiter)
        return waiter
      },
      unregisterWait: waiter => { this.bus.unregisterWait(waiter); this.waiting.delete(node.index) },
      messageKey: slot => this.messageKey(node, slot),
      restoreInitial: (name, children) => this.restoreInitial(name ?? targetName(), children),
      physics: this.binding?.physics,
      audio: this.binding?.audio,
      effect: this.binding?.effect,
      light: this.binding?.light,
      tutorial: this.binding?.tutorial,
      sky: this.binding?.sky,
      shadow: this.binding?.shadow,
      particles: this.binding?.particles,
      camera: this.binding?.camera,
      attributes: this.binding?.attributes,
      lifecycle: this.binding?.lifecycle,
      filter: this.binding?.filter,
      loader: this.binding?.context,
      extra: this.binding?.extra,
      timer: this.binding?.timer,
      system: this.binding?.system,
      database: this.binding?.database,
      time: this.binding?.time,
      dynamic: this.binding?.dynamic,
      collisionSurfaces: this.binding?.collisionSurfaces,
      scriptOf: (object, slot) => this.binding?.context?.scripts(object)[slot],
      owner: () => this.scriptOwner(node.index),
      group: name => this.binding?.group?.(name),
      rayIntersection: ray => {
        const intersect = this.binding?.rayIntersection
        if (!intersect) throw new Error(`${node.name} ${node.index} needs a ray intersection binding`)
        return intersect(ray)
      },
      isScriptActive: name => this.isScriptActive(name) ?? (this.binding?.scripts?.has(name) ? this.binding.scripts.isActive(name) : undefined),
    }
  }

  /**
   * `CKScene::Activate/DeactivateScript` from a graph: applied at the next
   * frame start (ACTIVATENEXTFRAME / DEACTIVATENEXTFRAME / RESETNEXTFRAME).
   */
  requestScript(name: string, value: boolean, reset = true): void {
    if (value) {
      this.disabledScripts.delete(name)
      this.activeScripts.add(name)
    } else {
      this.activeScripts.delete(name)
      this.disabledScripts.add(name)
    }
    for (const root of this.scriptRoots(name)) this.scriptRequests.set(root, { active: value, reset: value && reset })
    this.binding?.script?.(name, value)
  }

  /** Whether this document has a root script of that name. */
  hasScript(name: string): boolean {
    return this.scriptRoots(name).length > 0
  }

  /**
   * `CKBehavior::IsActive` of a root script: its ACTIVE flag, which stays set
   * while any of its behaviors is ACTIVE or a delayed link is counting down,
   * or the activation a request will apply at the next frame start.
   */
  isScriptActive(name: string): boolean | undefined {
    const roots = this.scriptRoots(name)
    if (!roots.length) return undefined
    return roots.some(root => {
      const request = this.scriptRequests.get(root)
      return request ? request.active : this.activeNodes.has(root)
    })
  }

  /**
   * `TT Restore IC` / `Restore IC` target resolution. A behavior without an
   * explicit target acts on its script owner, which is the document's
   * `<Document>_MF` entity; the hierarchy comes from the serialized entity
   * chunks (see scripts/original_chunks.py `entity_children`).
   */
  private restoreInitial(name: string, children: boolean): string[] | undefined {
    const restore = this.binding?.restoreInitial
    if (!restore) return undefined
    const hierarchy = this.data.hierarchy ?? {}
    const owner = `${this.data.source}_mf`.toLowerCase()
    const target = name || Object.keys(hierarchy).find(item => item.toLowerCase() === owner)
    if (!target) throw new Error(`Restore IC in ${this.data.source} has no target and no owner entity ${this.data.source}_MF`)
    const visited: string[] = []
    const visit = (entity: string) => {
      visited.push(entity)
      if (children) for (const child of this.binding?.children?.(entity) ?? hierarchy[entity] ?? []) visit(child)
    }
    visit(target)
    for (const entity of visited) restore.call(this.binding, entity)
    return visited
  }

  /** Messages queued on this runtime's bus. */
  get messages(): GraphMessage[] { return this.bus.messages }


  /** The object owning the root script that contains a node, from the exported script lists. */
  private scriptOwner(nodeIndex: number): string | undefined {
    let current = nodeIndex
    for (let parent = this.parents.get(current); parent !== undefined; parent = this.parents.get(current)) current = parent
    return this.data.owners?.[String(current)]
  }

  /** A message pin's CKMessageType, decoded by the exporter to its message name. */
  private messageKey(node: OriginalGraphNode, slot: number): GraphMessageId {
    const parameter = node.inputs?.[slot]
    if (!parameter) throw new Error(`${node.name} ${node.index} has no message input ${slot}`)
    const value = this.values.get(this.liveSource(parameter.index)) ?? this.values.get(parameter.index)
    if (typeof value === 'number' || typeof value === 'string') return value
    throw new Error(`${node.name} ${node.index} message input ${slot} has no decoded message type (re-export with a --managers dump)`)
  }

  private scriptRoots(name: string): number[] {
    return this.data.roots.filter(index => this.data.nodes[String(index)]?.name === name)
  }

  /** The top-level node (root script) containing a node. */
  private rootOf(nodeIndex: number): number {
    let current = nodeIndex
    for (let parent = this.parents.get(current); parent !== undefined; parent = this.parents.get(current)) current = parent
    return current
  }

  private priority(index: number): number {
    return this.data.nodes[String(index)]?.priority ?? 0
  }

  /** A held or deactivated root keeps its state but does not execute (see `holdScript`). */
  private held(index: number): boolean {
    if (this.parents.has(index)) return false
    if (this.inactiveRoots.has(index)) return true
    const name = this.heldScripts.size ? this.data.nodes[String(index)]?.name : undefined
    return name !== undefined && this.heldScripts.has(name)
  }

  /** CKM_BEHAVIOR(DE)ACTIVATESCRIPT to every sub-behavior: the particle systems and the blocks with callbacks. */
  private notifyScriptActivation(root: number, active: boolean): void {
    const particles = this.binding?.particles
    const visit = (index: number) => {
      particles?.scriptActivated(index, active)
      if (!active) this.callback(index, 'deactivateScript')
      for (const child of this.data.nodes[String(index)]?.children ?? []) visit(child)
    }
    visit(root)
  }

  /** Run a block's behavior callback, when its prototype has one. */
  private callback(index: number, message: 'reset' | 'deactivateScript'): void {
    const node = this.data.nodes[String(index)]
    const callback = node && this.callbacks[node.name]
    if (!callback) return
    const state = this.states.get(index) ?? {}
    this.states.set(index, state)
    callback(this.context(node, 0), state, message)
  }

  /**
   * CKBehavior::Reset on a subtree: link delays restored and delayed lists
   * emptied, IOs and ACTIVE cleared, block state dropped. A script then
   * activates its own input 0, which is all it does on its own.
   */
  private resetBehavior(index: number, script: boolean) {
    const node = this.data.nodes[String(index)]
    if (!node) return
    this.activeNodes.delete(index)
    this.reserved.delete(index)
    this.callback(index, 'reset')
    this.states.set(index, {})
    for (const pin of [...node.inIO ?? [], ...node.outIO ?? []]) this.ioActive.delete(pin.index)
    const compound = this.compounds.get(index)
    if (compound) {
      for (const link of compound.links) { link.delay = 0; link.inDelayed = false }
      compound.delayed = []
      for (const child of node.children ?? []) this.resetBehavior(child, false)
    }
    if (!script) return
    const input = node.inIO?.[0]
    if (input) this.ioActive.add(input.index)
    else this.activateWithoutInput(index)
  }

  /** Hand-built graphs only: a compound without inputs starts each child at its input 0. */
  private activateWithoutInput(index: number) {
    for (const child of this.data.nodes[String(index)]?.children ?? []) this.activate(child, 0)
  }

  /** CKBehavior::Activate on a root script: reset when asked or never launched, then ACTIVE. */
  private applyScriptActivation(root: number, active: boolean, reset: boolean) {
    if (active) {
      if (reset || !this.launched.has(root)) this.resetBehavior(root, true)
      this.launched.add(root)
      this.inactiveRoots.delete(root)
      this.activeNodes.add(root)
    } else {
      this.inactiveRoots.add(root)
      this.activeNodes.delete(root)
    }
    this.notifyScriptActivation(root, active)
  }

  /** Restore the authored graph state, as if the runtime had just been built. */
  reset(): void {
    this.values.clear()
    for (const [index, value] of this.initialValues) this.values.set(index, copyValue(value))
    this.nullObjects.clear()
    for (const index of this.initialNullObjects) this.nullObjects.add(index)
    this.states.clear()
    for (const node of Object.values(this.data.nodes)) this.states.set(node.index, {})
    this.ioActive.clear()
    this.activeNodes.clear()
    this.reserved.clear()
    this.waiting.clear()
    this.scriptRequests.clear()
    this.launched.clear()
    this.inactiveRoots.clear()
    this.nextFrameOutputs.clear()
    for (const compound of this.compounds.values()) {
      for (const link of compound.links) { link.delay = 0; link.inDelayed = false }
      compound.delayed = []
    }
    this.activeScripts.clear()
    this.disabledScripts.clear()
    // A shared bus belongs to every document on it, so only a private one is cleared.
    if (this.ownsBus) { this.bus.clear(); this.bus.frame = 0 }
    this.warnings.length = 0
    this.frame = 0
  }

  /** A triggered delayed link joins the compound's list once; re-triggers while it counts are ignored. */
  private delay(compound: SchedulerCompound, link: SchedulerLink) {
    if (!link.delay) link.delay = link.initial
    if (!link.inDelayed) { link.inDelayed = true; compound.delayed.push(link) }
  }

  /**
   * CKBehavior::Execute of a compound, as in CK2.dll: CheckIOsActivation
   * (links leaving active IOs fire or start their delay, then every ACTIVE sub
   * is stacked in sub order), the depth-first iterator loop, and
   * CheckBehaviorActivity.
   */
  private executeCompound(compound: SchedulerCompound) {
    const activate: number[] = [], deactivate: number[] = []
    for (const link of compound.links) {
      if (!this.ioActive.has(link.from)) continue
      deactivate.push(link.from)
      if (link.initial) this.delay(compound, link)
      else activate.push(link.to)
    }
    for (const pin of deactivate) this.ioActive.delete(pin)
    for (const pin of activate) {
      this.ioActive.add(pin)
      const owner = this.owners.get(pin)
      if (owner?.list === 'inIO' && owner.node !== compound.index) this.activeNodes.add(owner.node)
    }
    const stack: number[] = []
    for (let k = compound.subs.length - 1; k >= 0; k--) {
      const sub = compound.subs[k]!
      if (compound.index === TOP && this.rootGate && !this.rootGate(sub)) continue
      if (this.activeNodes.has(sub) && !this.held(sub)) { this.reserved.add(sub); stack.push(sub) }
    }
    this.iterate(compound, stack)
    this.checkActivity(compound)
  }

  /** Pop, execute and follow outputs until the stack empties (bounded like CKBehaviorManager's limit). */
  private iterate(compound: SchedulerCompound, stack: number[]) {
    let count = 0
    while (stack.length) {
      if (++count > MAX_ITERATIONS) {
        this.warnings.push(`${this.data.source}: behavior loop in compound ${compound.index} at frame ${this.frame}`)
        for (const sub of stack) this.reserved.delete(sub)
        break
      }
      const sub = stack.pop()!
      this.reserved.delete(sub)
      this.executeNode(sub)
      this.findNext(compound, sub, stack)
    }
  }

  /**
   * CKBehavior::FindNextBehaviorsToExecute: each active output of the behavior
   * that ran is cleared and followed. Undelayed links activate their
   * destination; a sub-behavior input makes its owner ACTIVE and, unless it is
   * already stacked, inserts it above every entry of equal or lower priority,
   * so it runs next.
   */
  private findNext(compound: SchedulerCompound, sub: number, stack: number[]) {
    for (const pin of this.data.nodes[String(sub)]?.outIO ?? []) {
      if (!this.ioActive.has(pin.index)) continue
      this.ioActive.delete(pin.index)
      for (const link of compound.linksFrom.get(pin.index) ?? []) {
        if (link.initial) { this.delay(compound, link); continue }
        this.ioActive.add(link.to)
        const owner = this.owners.get(link.to)
        if (owner?.list !== 'inIO' || owner.node === compound.index) continue
        this.activeNodes.add(owner.node)
        if (this.reserved.has(owner.node) || this.held(owner.node)) continue
        this.reserved.add(owner.node)
        const priority = this.priority(owner.node)
        let at = stack.length - 1
        while (at >= 0 && priority < this.priority(stack[at]!)) at--
        stack.splice(at + 1, 0, owner.node)
      }
    }
  }

  /**
   * CKBehavior::CheckBehaviorActivity: delayed links count down once per
   * Execute and, when done, activate their destination and mark its owner
   * ACTIVE (it runs from the next Execute's stack). The compound stays ACTIVE
   * while a delay is pending or a sub-behavior is ACTIVE.
   */
  private checkActivity(compound: SchedulerCompound) {
    const remaining: SchedulerLink[] = []
    for (const link of compound.delayed) {
      link.delay--
      if (link.delay > 0) { remaining.push(link); continue }
      link.delay = 0
      link.inDelayed = false
      this.ioActive.add(link.to)
      const owner = this.owners.get(link.to)
      if (owner) this.activeNodes.add(owner.node)
    }
    compound.delayed = remaining
    if (compound.index === TOP) return
    this.activeNodes.delete(compound.index)
    if (remaining.length || compound.subs.some(sub => this.activeNodes.has(sub) || this.waiting.has(sub))) this.activeNodes.add(compound.index)
  }

  /** Execute one behavior: a compound's graph, or a building block, which stays ACTIVE only if it waits. */
  private executeNode(index: number) {
    const node = this.data.nodes[String(index)]
    if (!node) { this.activeNodes.delete(index); return }
    const compound = this.compounds.get(index)
    if (compound) { this.executeCompound(compound); return }
    // A host's inert block stays inert even when the registry implements it
    // (the engine keeps presenting PE_Balloon's UFO itself).
    const behavior = node.prototype && this.inert.has(node.name) ? undefined : this.registry[node.name]
    if (!behavior) {
      this.activeNodes.delete(index)
      // A childless script is an empty compound; only primitives carry a prototype.
      if (!node.prototype || this.inert.has(node.name)) return
      if (this.unknown === 'record') { this.unimplemented.add(node.name); return }
      throw new Error(`${this.data.source}: building block ${node.name} (node ${index}, prototype ${node.prototype}) is not implemented`)
    }
    const slot = node.inIO?.findIndex(pin => this.ioActive.has(pin.index)) ?? -1
    this.keepActive = false
    behavior(this.context(node, slot), this.states.get(index)!)
    if (!this.keepActive) this.activeNodes.delete(index)
    this.keepActive = false
  }

  /** Run top-level work now from a seed, outside the frame loop (host calls). */
  private runFromTop(seed: number) {
    const top = this.compounds.get(TOP)!
    if (!this.activeNodes.has(seed) || this.held(seed)) return
    this.reserved.add(seed)
    this.iterate(top, [seed])
  }

  /**
   * `Activate Script` from a host: (re)start a named root script now and run
   * its first Execute in the caller's frame. Inside the graph, Activate Script
   * takes effect at the next frame start instead, as CKScene::Activate does.
   */
  activateScript(name: string, reset = true) {
    const roots = this.scriptRoots(name)
    if (!roots.length) throw new Error(`${this.data.source} has no root script ${name}`)
    this.disabledScripts.delete(name)
    this.activeScripts.add(name)
    for (const root of roots) {
      this.scriptRequests.delete(root)
      this.applyScriptActivation(root, true, reset)
      this.runFromTop(root)
    }
  }

  /** `Deactivate Script` from a host: the script stops now. */
  deactivateScript(name: string) {
    const roots = this.scriptRoots(name)
    if (!roots.length) throw new Error(`${this.data.source} has no root script ${name}`)
    this.activeScripts.delete(name)
    this.disabledScripts.add(name)
    for (const root of roots) {
      this.scriptRequests.delete(root)
      this.applyScriptActivation(root, false, false)
    }
  }

  /**
   * Postpone a root script while `held`: it keeps its ACTIVE behaviors, IOs
   * and delays and does not execute until the hold is released. A host uses it
   * to keep a script still without discarding its state.
   */
  holdScript(name: string, held: boolean) {
    if (held) this.heldScripts.add(name)
    else this.heldScripts.delete(name)
  }

  /** Activate a behavior's input for the next Execute of its containing scripts. */
  activate(nodeIndex: number, slot = 0) {
    const node = this.data.nodes[String(nodeIndex)]
    if (!node) return
    const pin = node.inIO?.[slot]
    if (pin) this.ioActive.add(pin.index)
    else if (node.children?.length) this.activateWithoutInput(nodeIndex)
    this.activeNodes.add(nodeIndex)
    for (let parent = this.parents.get(nodeIndex); parent !== undefined; parent = this.parents.get(parent)) this.activeNodes.add(parent)
  }

  /** CKBehavior::Reset on one behavior's subtree, for a host that cancels a running compound. */
  resetNode(nodeIndex: number) {
    if (!this.data.nodes[String(nodeIndex)]) throw new Error(`Behavior ${nodeIndex} is not in this graph`)
    this.resetBehavior(nodeIndex, false)
  }

  /** Activate a behavior's input and run its root script's graph now. */
  activateNow(nodeIndex: number, slot = 0) {
    this.activate(nodeIndex, slot)
    this.runFromTop(this.rootOf(nodeIndex))
  }

  /**
   * Run one building block now without following its outputs, for a host that
   * executes a single authored node outside the script that owns it.
   */
  runIsolated(nodeIndex: number, slot = 0) {
    const node = this.data.nodes[String(nodeIndex)]
    if (!node) return
    const pin = node.inIO?.[slot]
    if (pin) this.ioActive.add(pin.index)
    this.activeNodes.add(nodeIndex)
    this.executeNode(nodeIndex)
    for (const output of node.outIO ?? []) this.ioActive.delete(output.index)
    // A block that waits keeps running from its compound, so its ancestors stay ACTIVE.
    if (this.activeNodes.has(nodeIndex)) {
      for (let parent = this.parents.get(nodeIndex); parent !== undefined; parent = this.parents.get(parent)) this.activeNodes.add(parent)
    }
  }

  /**
   * One frame, as CKBehaviorManager::Execute: requested script (de)activations
   * apply first, then the top-level scripts execute once each. Without
   * `frameRoots` every root is re-fired each frame, a convenience for
   * hand-built graphs that no host uses.
   */
  step() {
    this.frame++
    for (const pin of this.nextFrameOutputs) {
      this.ioActive.add(pin)
      const owner = this.owners.get(pin)
      for (let parent = owner && this.parents.get(owner.node); parent !== undefined; parent = this.parents.get(parent)) this.activeNodes.add(parent)
    }
    this.nextFrameOutputs.clear()
    for (const [root, request] of this.scriptRequests) this.applyScriptActivation(root, request.active, request.reset)
    this.scriptRequests.clear()
    // The previous frame's messages are delivered before this one runs. A
    // shared bus is post-processed once per frame by its host instead.
    if (this.ownsBus) this.bus.postProcess()
    for (const root of this.frameRoots ?? this.data.roots) {
      const node = this.data.nodes[String(root)]
      if (!node || this.disabledScripts.has(node.name)) continue
      if (node.inIO?.length) for (const pin of node.inIO) this.ioActive.add(pin.index)
      else if (node.children?.length) this.activateWithoutInput(root)
      this.activeNodes.add(root)
    }
    this.executeCompound(this.compounds.get(TOP)!)
  }

  /** Read a parameter value by its dump index (for tests and inspection). */
  value(index: number): GraphParameterValue {
    const source = this.liveSource(index)
    if (source !== index && this.values.has(source)) return this.values.get(source) ?? null
    return this.values.get(index) ?? null
  }

  /**
   * Write a parameter or local from the host, propagating to its data targets
   * as `CKParameterOut::SetValue` does. Used by port patches that extend an
   * authored list (the Graphics mode-count limit).
   */
  setValue(index: number, value: GraphParameterValue): void {
    this.setParameterValue(index, value)
  }

  /**
   * The parameter a read finally uses. Reading a parameter operation's output
   * runs the operation first, as `CKParameterOut::GetValue(update)` does.
   */
  private liveSource(index: number): number {
    const source = this.resolveSource(index)
    const operation = this.operationOutputs.get(source)
    if (operation) this.runOperation(operation)
    return source
  }

  /**
   * `CKParameterOut::SetValue` (CK2.dll 0x2400A456, vtable +0x50: the value
   * copy 0x2400824D, then `DataChanged` 0x2400A4D3) and its destinations:
   * every serialized target receives the value and, when it is itself a
   * parameter-out, propagates to its own destinations. A destination cycle is
   * invalid data (CK2 would recurse forever).
   */
  private setParameterValue(index: number, value: GraphParameterValue, visiting = new Set<number>()): void {
    if (visiting.has(index)) throw new Error(`Parameter ${index} destinations form a cycle`)
    visiting.add(index)
    this.values.set(index, value)
    this.nullObjects.delete(index)
    for (const to of [...this.dataLinks.get(index) ?? [], ...this.outputTargets.get(index) ?? []]) {
      this.setParameterValue(to, value, visiting)
    }
    visiting.delete(index)
  }

  /** `CKParameterOperation::DoOperation`: read both inputs (updating them), compute, write the output. */
  private runOperation(operation: OriginalGraphOperation): void {
    if (this.operating.has(operation.index)) throw new Error(`Parameter operation ${operation.index} ${operation.name} depends on itself`)
    const name = OPERATION_NAMES[operation.guid]
    const compute = name ? ORIGINAL_OPERATIONS[name] : undefined
    if (!name || !compute) throw new Error(`Parameter operation ${operation.index} ${operation.name} (${operation.guid}) is not implemented`)
    const owner = this.data.nodes[String(operation.owner)]
    if (!owner) throw new Error(`Parameter operation ${operation.index} has no owner behavior ${operation.owner}`)
    this.operating.add(operation.index)
    try {
      const [a, b] = operation.inputs.map(parameter => {
        const source = this.liveSource(parameter.index)
        // A NULL object reference reads as NULL, not as its placeholder name.
        if (this.nullObjects.has(source)) return null
        return this.values.get(source) ?? (source === parameter.index ? parameter.value : undefined) ?? null
      })
      const context = this.context(owner, 0)
      const value = name === 'Convert' ? convertParameter(operation, a ?? null, b ?? null, context) : compute(context, a ?? null, b ?? null, operation.output.type)
      this.setParameterValue(operation.output.index, value)
    } finally {
      this.operating.delete(operation.index)
    }
  }

  /**
   * The parameter a reference finally reads. A compound's input can reference
   * a local that is itself a reference, so the chain is followed to its end.
   */
  private resolveSource(index: number): number {
    let current = index
    for (let hops = 0; hops < 32; hops++) {
      const next = this.paramSources.get(current)
      if (next === undefined) return current
      current = next
    }
    throw new Error(`Parameter ${index} references form a cycle`)
  }
  ownerOf(index: number): ParamOwner | undefined { return this.owners.get(index) }
}

// `Op` is a generic parameter operation. The operation is selected by a CKGUID
// stored in locals 1 and 2 and resolved through the engine's operation table.
// The GUIDs below are recovered from ParameterOperations.dll's registration
// calls (`mov ecx,G1; mov eax,G2; push name; push ecx; push eax`).
const OPERATION_NAMES: Record<string, string> = {
  '599203f6:23b06096': 'Get Object By Name',
  '428009b4:1caa5c78': 'Convert',
  '33cc6b49:3589282b': 'Addition',
  '67641171:6499077a': 'Subtraction',
  'fb556b23:69b22a75': 'Get Row Count',
  '6a5c5061:5efe7428': 'Get Current',
  '0f9e20cc:6ea10a47': 'Get Diffuse Color',
  '13684596:0ab57f34': 'Get Emissive Color',
  '660f5c52:0adf7be9': 'Get Element',
  '765f7aa3:33d679b2': 'Get Material List',
  '6b8c78bd:7b846d3c': 'Get Material',
  '4bc87aea:6b5b643e': 'Get Position',
  '38996b85:334e35c2': 'Multiplication',
  '250020d4:10d51b91': 'Get Script',
  '472851ba:5ccc2831': 'Get World Matrix',
  '5939156e:62ab3472': 'Get Name',
  '556a69af:076e3f09': 'Get Length',
  '2a3f4ab6:753a4a20': 'Modulo',
  '44df6f61:5f8f55c8': 'Get Count',
  '748c3502:0fea0cf1': 'Division',
  '389f72bd:7aef3482': 'Get Y',
  '6ea214cb:43be6b56': 'Min',
  '31a7649f:305e5164': 'Get Bounding Box',
  '35aa0ddb:7a5e3335': 'Get Type',
  '551c20ba:20da6d50': 'Get Script Count',
}

/**
 * A standalone `Convert` copies its input into the output's type. The shared
 * table in `original-convert.ts` is used by both the operation and
 * parameter-operation paths; unrecovered pairs fail loudly.
 */
function convertParameter(operation: OriginalGraphOperation, value: GraphParameterValue, second: GraphParameterValue, context: BehaviorContext): GraphParameterValue {
  return originalConvert(context, operation.inputs[0]?.type, operation.output.type, value, second)
}

export function originalOperationName(guid1: number, guid2: number): string | undefined {
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0')
  return OPERATION_NAMES[`${hex(guid1)}:${hex(guid2)}`]
}

/** CKPGUID_VECTOR. */
const VECTOR_TYPE = 'ae4e82486079e42f'

/** Parameter-operation implementations, keyed by the recovered operation name. */
/** An operation: its two inputs and the result parameter's type GUID (operations dispatch on it). */
export const ORIGINAL_OPERATIONS: Record<string, (context: BehaviorContext, p1: GraphParameterValue, p2: GraphParameterValue, resultType?: string) => GraphParameterValue> = {
  // ParameterOperations 0x24B4CA00: the operation converts p1 into the output
  // type (p1, p2) -> Vector 2D; both paths use the shared original-convert table.
  Convert: (context, a, b, resultType) => originalConvert(context, context?.node.inputs?.[0]?.type, resultType, a, b),
  // String + String concatenates (the string Addition); a string with any
  // other type is a different, unrecovered operation.
  Addition: (_c, a, b) => {
    if (typeof a === 'string' && typeof b === 'string') return a + b
    if (typeof a === 'string' || typeof b === 'string') throw new Error(`Addition of ${JSON.stringify(a)} and ${JSON.stringify(b)} is not recovered`)
    return number(a) + number(b)
  },
  Subtraction: (_c, a, b) => number(a) - number(b),
  Multiplication: (_c, a, b) => number(a) * number(b),
  Division: (_c, a, b) => number(a) / number(b),
  Modulo: (_c, a, b) => number(a) % number(b),
  // ParameterOperations 0x24B4A860: Min(Box) -> Vector reads the box's Min (box + 0xC).
  Min: (_c, a, b, resultType) => {
    if (resultType !== VECTOR_TYPE) return Math.min(number(a), number(b))
    if (!Array.isArray(a) || a.length !== 6) throw new Error(`Min into a vector of ${JSON.stringify(a)}, which is not a box`)
    return a.slice(3, 6) as number[]
  },
  // With a context binding the name becomes that object's reference (a CK_ID);
  // other hosts keep resolving names.
  // ParameterOperations CKObjectGetObjectByNameString: GetObjectByNameAndParentClass
  // with the result type's class. With a context binding the result is that
  // object's reference (a CK_ID); other hosts keep resolving names.
  'Get Object By Name': (context, a, _b, resultType) => {
    if (typeof a !== 'string') return null
    if (!context.loader) return a
    const cid = originalParameterClass(resultType)
    if (cid === undefined) throw new Error(`Get Object By Name into type ${resultType ?? '?'} has no recovered class`)
    return context.loader.find(a, cid) ?? null
  },
  'Get Position': (context, a) => context.object(typeof a === 'string' ? a : undefined)?.position ?? null,
  'Get Name': (context, a) => typeof a === 'string' ? context.loader?.objectName(a) ?? a : null,
  // The String Get Length: strlen. Other Get Length pairings are not recovered.
  // CKIntGetRowCountDataArray: CKDataArray::GetRowCount; a NULL array counts 0.
  'Get Row Count': (context, a) => typeof a === 'string' ? context.array(a)?.length ?? 0 : 0,
  // CKIntGetScriptCountBeObject: CKBeObject::GetScriptCount from the context; a
  // NULL object (none without a context) counts 0.
  'Get Script Count': (context, a) => typeof a === 'string' && context.loader?.has(a) ? context.loader.scriptCount(a) : 0,
  // CKScriptGetScriptBeObjectInt / ...String: the object's script at an index,
  // or its first script whose name contains the string; NULL otherwise.
  'Get Script': (context, a, b) => {
    if (typeof a !== 'string' || !context.loader?.has(a)) return null
    const scripts = context.loader.scripts(a)
    if (typeof b === 'string') return scripts.find(script => context.loader!.objectName(script)?.includes(b)) ?? null
    return scripts[Math.trunc(number(b))] ?? null
  },
  // The Group Get Count: CKGroup::GetObjectCount.
  'Get Count': (context, a) => {
    if (typeof a !== 'string') return 0
    const members = context.group(a)
    if (!members) throw new Error(`Get Count of ${a}, which is not a known group`)
    return members.length
  },
  'Get Length': (_c, a) => {
    if (typeof a === 'string') return a.length
    throw new Error(`Get Length of ${JSON.stringify(a)} is not recovered`)
  },
  // ParameterOperations Get Y: a vector's second component, or a 3D entity's world Y.
  'Get Y': (context, a) => {
    if (Array.isArray(a)) return a[1] ?? 0
    const object = context.object(typeof a === 'string' ? a : undefined)
    if (!object) return null
    if (!('position' in object)) throw new Error(`Get Y ${context.node.index} reads ${JSON.stringify(a)}, which is not a 3D entity`)
    return object.position[1]
  },
  // CK3dEntity::GetWorldMatrix: the context's entity matrix; hosts without a
  // context only know a position.
  'Get World Matrix': (context, a) => {
    if (typeof a !== 'string') return null
    if (context.loader) return context.loader.matrix(a) ?? null
    return context.object(a)?.position ?? null
  },
  'Get Type': (_c, a) => typeof a === 'string' ? a : null,
  // ParameterOperations.dll 0x24B51EC0: CK3dEntity::GetCurrentMesh, 0 without one;
  // 0x24B51550: CKMesh::GetMaterial(p2). Hosts without a context keep the
  // entity's name, and Set Diffuse acts on that object's (shared) material.
  // ParameterOperations.dll 0x24B4F040 (3DEntity, none) -> Box: GetObject(id),
  // then CK3dEntity::GetBoundingBox(FALSE) copied into the output. A NULL object
  // returns before writing and keeps the output's previous value, which is not
  // recovered, so it fails loudly.
  'Get Bounding Box': (context, a) => {
    if (!context.loader) throw new Error('Get Bounding Box needs the CK object context')
    if (typeof a !== 'string' || !context.loader.has(a)) throw new Error(`Get Bounding Box of ${JSON.stringify(a)}: a NULL object leaves the output unwritten, which is not recovered`)
    const box = context.loader.boundingBox(a, false)
    if (!box) throw new Error(`Get Bounding Box of ${a}, which is not a 3D entity`)
    return box
  },
  'Get Current': (context, a) => {
    if (typeof a !== 'string') return null
    return context.loader ? context.loader.currentMeshReference(a) ?? null : a
  },
  'Get Material': (context, a, b) => {
    if (typeof a !== 'string') return null
    if (!context.loader) return a
    // An unsourced p2 has no read pointer, and the operation passes 0.
    if (b !== null && typeof b !== 'number') throw new Error(`Get Material index ${JSON.stringify(b)} is not an integer`)
    return context.loader.meshMaterial(a, b ?? 0) ?? null
  },
  // ParameterOperations.dll 0x24B4FCF0, registered at 0x24B5B492 for
  // (Mesh, none) -> MaterialList: CKContext::GetObject(p1), then
  // CK3dEntity's mesh vtable +0x1D8 (GetMaterialCount) and +0x1DC
  // (GetMaterial(i)); each non-NULL material's CK_ID (object +4) is appended,
  // a NULL one appends 0. A NULL mesh returns before writing the output.
  // The port holds the list as the material CK_IDs; a trailing NULL ends it
  // (the binding has no material-count call).
  'Get Material List': (context, a) => {
    if (!context.loader) throw new Error(`Get Material List ${context.node.index} needs the CK object context`)
    if (typeof a !== 'string') throw new Error(`Get Material List ${context.node.index} reads ${JSON.stringify(a)}: a NULL mesh leaves the output unwritten, which is not recovered`)
    const ids: number[] = []
    for (let index = 0; ; index++) {
      const material = context.loader.meshMaterial(a, index)
      if (material === undefined) break
      const reference = /^#(\d+)$/.exec(material)
      if (!reference) throw new Error(`Get Material List ${context.node.index} got material ${material}, which is not a context reference`)
      ids.push(Number(reference[1]))
    }
    return ids
  },
  // ParameterOperations.dll 0x24B509C0, registered at 0x24B5B7D2 for
  // (MaterialList, Integer) -> Object: read p1's list pointer (NULL uses the
  // empty list) and p2's index, then XObjectArray::GetObjectA(context, index)
  // (CK2.dll import via 0x24B5DCA0) and write the element's CK_ID, 0 when the
  // index is past the end. The group pairing (0x24B5C0C2) is
  // CKGroup::GetObject(index), registered (Group, Integer) -> Object.
  'Get Element': (context, a, b) => {
    const index = b === null || b === undefined ? 0 : Math.trunc(Number(b))
    if (!Number.isFinite(index)) throw new Error(`Get Element ${context.node.index} index ${JSON.stringify(b)} is not an integer`)
    if (Array.isArray(a)) {
      const id = a[index]
      return typeof id === 'number' && id !== 0 ? `#${id}` : null
    }
    if (typeof a === 'string') {
      const members = context.group(a)
      if (!members) throw new Error(`Get Element ${context.node.index} reads ${a}, which is neither a material list nor a known group`)
      return members[index] ?? null
    }
    if (a === null || a === undefined) return null
    throw new Error(`Get Element ${context.node.index} reads ${JSON.stringify(a)}, which is not a material list`)
  },
  // ParameterOperations.dll 0x24B4E6A0 (registered 0x24B5A422) and
  // 0x24B4E720 (0x24B5A48A): read p1's CK_ID and
  // CKContext::GetObject (CK2.dll thunk 0x24B5DB9E), then copy the material's
  // VxColor from CKMaterial vtable +0x64 (GetDiffuse) / +0x74 (GetEmissive)
  // into the output (4 dwords). A NULL material returns without writing.
  'Get Diffuse Color': (context, a) => liveMaterialColor(context, a, 'diffuse', 'Get Diffuse Color'),
  'Get Emissive Color': (context, a) => liveMaterialColor(context, a, 'emissive', 'Get Emissive Color'),
}

/**
 * A material's live VxColor (4 floats in [0,1]) from the context state. The
 * original operation reads CKMaterial's colour members; documents with a
 * render export keep the loaded colours in OriginalObject.material, so the
 * host seeds `state.diffuse`/`state.emissive` when it loads a material (the
 * Set Diffuse / Set Emissive behaviors write the same members).
 */
function liveMaterialColor(context: BehaviorContext, value: GraphParameterValue, member: 'diffuse' | 'emissive', label: string): number[] {
  // A NULL material leaves the output unwritten, which the operation table cannot express.
  if (value === null || value === undefined) throw new Error(`${label} ${context.node.index} reads a NULL material: the unwritten output is not recovered`)
  if (typeof value !== 'string') throw new Error(`${label} ${context.node.index} reads ${JSON.stringify(value)}, which is not a material reference`)
  if (!context.loader) throw new Error(`${label} ${context.node.index} needs the CK object context`)
  const colour = context.loader.state(value)[member]
  if (!Array.isArray(colour) || colour.length !== 4) {
    throw new Error(`${label} ${context.node.index}: the context holds no ${member} colour for ${value} (the material's saved colour is not in its state)`)
  }
  return colour.map(Number)
}

// Behaviors translated from the recovered Virtools building-block source
// (CKBuildingBlocks) unless noted. `Op`, `Get Cell`, `Set Cell`, `Send Message`
// and `Wait Message` are engine-core behaviors whose source is not in the pack;
// they need Ghidra recovery before they can be faithful.
const CORE_BEHAVIORS: BehaviorRegistry = {
  Identity: context => {
    for (let i = 0; i < context.inputCount; i++) context.setOutput(i, context.input(i))
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  Nop: context => {
    for (let i = 0; i < context.inputCount; i++) context.consumeInput(i)
    for (let i = 0; i < context.outCount; i++) context.activate(i)
  },
  // TT_Toolbox_RT Debug.cpp: writes DebugText to the console/Debug.log only
  // while the DebugManager is in debug mode, then always fires Exit. It changes
  // no scene state, so the port passes through without writing a log.
  TT_Debug: context => {
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  Test: context => {
    const operator = number(context.input(0))
    // Object operands compare their CK_IDs: a NULL reference is ID 0.
    const objectClass = originalParameterClass(context.inputType(1)) ?? originalParameterClass(context.inputType(2))
    if (objectClass !== undefined) {
      if (operator !== 1 && operator !== 2) throw new Error(`Test ${context.node.index} orders object IDs, which is not supported`)
      // References are IDs already; a saved name is looked up in the context when there is one.
      const id = (slot: number) => {
        const value = context.inputObject(slot)
        if (value === undefined) return null
        if (/^#\d+$/.test(value) || !context.loader) return value
        return context.loader.find(value, objectClass) ?? null
      }
      const equal = id(1) === id(2)
      context.consumeInput(context.inputSlot)
      context.activate((operator === 1 ? equal : !equal) ? 0 : 1)
      return
    }
    const a = context.input(1)
    const b = context.input(2)
    context.consumeInput(context.inputSlot)
    const comparable = operator >= 1 && operator <= 6
    let result = false
    if (comparable && typeof a === 'string' && typeof b === 'string') {
      result = compare(operator, a === b, a !== b, a < b, a <= b, a > b, a >= b)
    } else if (comparable && a !== null && b !== null &&
      (typeof a === 'number' || typeof a === 'boolean') &&
      (typeof b === 'number' || typeof b === 'boolean')) {
      const na = number(a), nb = number(b)
      result = compare(operator, na === nb, na !== nb, na < nb, na <= nb, na > nb, na >= nb)
    }
    context.activate(result ? 0 : 1)
  },
  'Binary Switch': context => {
    const condition = Boolean(context.input(0))
    context.consumeInput(context.inputSlot)
    context.activate(condition ? 0 : 1)
  },
  // Logics/Behaviors/RandomSwitch.cpp (creation 0x254860C0, execution
  // 0x254861B0): one In, Out 1..N and Coef 1..N. A coefficient is the
  // probability weight of its output. With the setting "Forbid twice the
  // same" (local 0), the previous output (local 1) is skipped and not counted.
  // rand()/RAND_MAX picks res in [0,sum); the first output whose cumulative
  // coefficient reaches res fires. The DLL uses the CRT rand (import
  // 0x254A1348); each instance keeps its own CRT sequence.
  'Random Switch': (context, state) => {
    context.consumeInput(0)
    const forbid = bool(context.local(0))
    const previous = forbid ? Math.trunc(number(context.local(1))) : -1
    const coefficients = new Array<number>(context.inputCount)
    let sum = 0
    for (let index = 0; index < context.inputCount; index++) {
      if (index === previous) continue
      const coefficient = Math.fround(number(context.input(index)))
      coefficients[index] = coefficient
      sum = Math.fround(sum + coefficient)
    }
    const random = state.random instanceof CrtRandom ? state.random : (state.random = new CrtRandom())
    // sum * rand() * (1 / RAND_MAX), rounded to float once (0x2548625F..).
    const result = Math.fround(random.rand() * sum * RAND_MAX_RECIPROCAL)
    let cumulative = 0
    for (let index = 0; index < context.inputCount; index++) {
      if (index === previous) continue
      cumulative += coefficients[index]!
      if (result <= cumulative) {
        context.activate(index)
        if (forbid) context.setLocal(1, index)
        break
      }
    }
  },
  'Linear Progression': context => {
    const A = number(context.input(1)), B = number(context.input(2))
    let current: number
    if (context.isInputActive(0)) { context.consumeInput(0); current = 0; context.setOutput(1, A) }
    else { context.consumeInput(1); current = number(context.output(0)) }
    current += context.local(0) === false ? 1 : context.deltaMs
    context.setOutput(0, current)
    const duration = number(context.input(0))
    const progression = duration === 0 ? 0 : current / duration
    let position = B
    if (current > duration) context.activate(0)
    else { position = A + (B - A) * progression; context.activate(1) }
    const previous = number(context.output(1))
    context.setOutput(1, position)
    context.setOutput(2, position - previous)
    context.setOutput(3, progression)
  },
  'Group Iterator': context => {
    // A string input names an authored group; its members are resolved by the binding.
    const input = context.input(0)
    const group = typeof input === 'string' ? context.group(input) : input
    let index = number(context.output(1))
    if (context.isInputActive(0)) { context.consumeInput(0); index = 0 }
    else { context.consumeInput(1); index += 1 }
    const length = Array.isArray(group) ? group.length : 0
    if (index >= length) { context.activate(0); return }
    context.setOutput(0, ((group as unknown[])[index] ?? null) as GraphParameterValue)
    context.setOutput(1, index)
    context.activate(1)
  },
  'Binary Memory': context => {
    const first = context.isInputActive(0)
    context.consumeInput(first ? 0 : 1)
    context.setOutput(0, first)
    context.activate(first ? 0 : 1)
  },
  'Parameter Selector': context => {
    for (let i = 0; i < context.inputCount; i++) {
      if (!context.isInputActive(i)) continue
      context.consumeInput(i)
      context.setOutput(0, context.input(i))
      break
    }
    context.activate(0)
  },
  // Logics/Behaviors/SwitchOnParameter.cpp: only pins of the Test's type are
  // compared. Float-derived types with a non-zero epsilon match in
  // [t - e, t + e); strings compare with strcmp, bools by truth, anything else
  // byte for byte. Out i fires for the first match, None otherwise.
  'Switch On Parameter': context => {
    const types = context.node.inputs ?? []
    const testType = types[0]?.type
    if (!testType) throw new Error(`Switch On Parameter ${context.node.index} has no exported Test type`)
    const test = context.input(0)
    const epsilon = Math.fround(number(context.local(0)))
    for (let i = 1; i < context.inputCount; i++) {
      if (types[i]?.type !== testType) continue
      const value = context.input(i)
      let match: boolean
      if (FLOAT_DERIVED_TYPES.has(testType) && epsilon !== 0) {
        const t = Math.fround(number(test)), p = Math.fround(number(value))
        match = p >= Math.fround(t - epsilon) && p < Math.fround(t + epsilon)
      } else if (testType === BOOL_TYPE) {
        match = bool(test) === bool(value)
      } else if (FLOAT_DERIVED_TYPES.has(testType)) {
        match = Math.fround(number(test)) === Math.fround(number(value))
      } else {
        match = JSON.stringify(test ?? null) === JSON.stringify(value ?? null)
      }
      if (match) { context.consumeInput(0); context.activate(i); return }
    }
    context.consumeInput(0)
    context.activate(0)
  },
  // Waits for every activation pin (inIO), not for parameters; activations are
  // remembered across frames, so two events need not arrive together.
  'Wait For All': (context, state) => {
    const received = (state.received as boolean[] | undefined) ?? new Array<boolean>(context.inCount).fill(false)
    state.received = received
    for (let i = 0; i < context.inCount; i++) {
      if (!context.isInputActive(i)) continue
      received[i] = true
      context.consumeInput(i)
    }
    if (received.every(Boolean)) {
      state.received = new Array<boolean>(context.inCount).fill(false)
      context.activate(0)
    } else context.wait()
  },
  TimerMini: context => {
    let elapsed = number(context.output(0))
    if (context.isInputActive(0)) { context.consumeInput(0); elapsed = 0 }
    elapsed = Math.fround(elapsed + Math.fround(context.deltaMs))
    context.setOutput(0, elapsed)
    if (elapsed >= number(context.input(0))) context.activate(0)
    else context.wait()
  },
  Sequencer: context => {
    if (context.isInputActive(1)) {
      context.consumeInput(1)
      let current = number(context.output(0)) + 1
      if (current >= context.outCount - 1) current = 0
      context.setOutput(0, current)
      context.activate(current + 1)
    }
    if (context.isInputActive(0)) {
      context.consumeInput(0)
      context.setOutput(0, -1)
      context.activate(0)
    }
  },
  // Narratives.dll Activate Script (exec 0x25685290): In off and Out, then for every Script input
  // CKScene::Activate(script, Reset?) and, with the Awake Object setting (local 0, TRUE when the
  // node has none), the owner's activation in the scene when it is inactive.
  'Activate Script': context => {
    const reset = context.input(0)
    const awake = context.node.locals?.length ? context.local(0) !== false : true
    for (let i = 1; i < context.inputCount; i++) {
      const script = context.input(i)
      if (!script) continue
      context.script(String(script), true, reset === null ? true : Boolean(reset))
      if (awake) context.extra?.awakeOwner?.(String(script))
    }
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  'Deactivate Script': context => {
    for (let i = 0; i < context.inputCount; i++) {
      const script = context.input(i)
      if (script) context.script(String(script), false)
    }
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  'Send Message': context => {
    // Input 0 is the message type, input 1 the destination object (a group
    // such as `All_Sound`, written at init by `Op Get Object By Name`), 2+ the payload.
    const id = context.messageKey(0)
    const args: GraphParameterValue[] = []
    for (let i = 2; i < context.inputCount; i++) args.push(context.input(i))
    const destination = context.input(1)
    context.sendMessage(id, typeof destination === 'string' ? destination : context.node.target ?? undefined, args)
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  // Logics BroadcastMessage.cpp: Out fires, then CKMessageManager::
  // SendMessageBroadcast(Message, Type, owner) with the inputs after Type as
  // parameters (version 0x10001 has the Type pin). Every receiver here is a
  // BeObject, so only that Type is supported; another one fails loudly.
  'Broadcast Message': context => {
    context.consumeInput(context.inputSlot)
    context.activate(0)
    const id = context.messageKey(0)
    const typed = context.inputType(1) === '434e641923616f4d'
    const type = typed ? Number(context.input(1)) : 19
    if (type !== 19) throw new Error(`Broadcast Message ${context.node.index} to class ${type} is not supported`)
    const args: GraphParameterValue[] = []
    for (let i = typed ? 2 : 1; i < context.inputCount; i++) args.push(context.input(i))
    context.sendMessage(id, undefined, args)
  },
  // Logics.dll Wait Message: In registers a wait (RegisterWait with output 0
  // and the target), Stop unregisters it. Delivery copies the message
  // parameters to the outputs and activates Out for the next frame.
  'Wait Message': (context, state) => {
    if (context.isInputActive(1)) {
      context.consumeInput(1)
      if (state.waiter) context.unregisterWait(state.waiter as GraphMessageWaiter)
      state.waiter = undefined
    }
    if (context.isInputActive(0)) {
      context.consumeInput(0)
      if (state.waiter) context.unregisterWait(state.waiter as GraphMessageWaiter)
      state.waiter = context.registerWait(context.messageKey(0), 0, context.node.target || undefined, message => {
        message.args.forEach((arg, index) => context.setOutput(index, arg))
        state.waiter = undefined
      })
    }
  },
  Interpolator: context => {
    const type = context.node.outputs?.[0]?.type
    const mix = number(context.input(2))
    const start = context.input(0), end = context.input(1)
    let value: GraphParameterValue
    if (Array.isArray(start) && Array.isArray(end)) {
      if (type === 'ee2fd457913bbb7c') {
        if (bool(context.local(0))) {
          throw new Error(`Interpolator ${context.node.index} HSV color interpolation is not implemented`)
        }
      } else if (type !== 'ae4e82486079e42f' && type !== '3c1bb0133e584219' && type !== '4ab3fc4e2fe47960') {
        throw new Error(`Interpolator ${context.node.index} type ${type ?? 'unknown'} is not implemented`)
      }
      value = start.map((component, index) => {
        const target = Number(end[index] ?? component)
        return component + (target - component) * mix
      })
    } else {
      const a = number(start), b = number(end)
      value = a + (b - a) * mix
    }
    context.setOutput(0, value)
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  // Controllers/Behaviors/KeyEvent.cpp. Off only stops the block: it keeps the
  // Key State output, and an On activated in the same call waits for a later
  // frame. On resets Key State to FALSE before polling. Every key input must be
  // down (none means down), and the edges fire Pressed/Released.
  'Key Event': (context, state) => {
    if (context.isInputActive(1)) {
      context.consumeInput(1)
      state.monitoring = false
      if (context.isInputActive(0)) context.wait()
      return
    }
    if (context.isInputActive(0)) { context.consumeInput(0); state.monitoring = true; context.setOutput(0, false) }
    if (!state.monitoring) return
    const wasDown = Boolean(context.output(0))
    let down = true
    for (let i = 0; i < context.inputCount; i++) if (!context.keyDown(number(context.input(i)))) { down = false; break }
    if (!down && wasDown) context.activate(1)
    else if (down && !wasDown) context.activate(0)
    context.setOutput(0, down)
    context.wait()
  },
  // TimerMini.cpp: reset Elapsed Time on In, add DeltaTime each subsequent
  // frame (CKBR_ACTIVATENEXTFRAME), and fire Out once the time has elapsed.
  Delayer: context => {
    let elapsed = number(context.output(0))
    if (context.isInputActive(0)) { context.consumeInput(0); elapsed = 0 }
    elapsed = Math.fround(elapsed + Math.fround(context.deltaMs))
    context.setOutput(0, elapsed)
    if (elapsed >= number(context.input(0))) context.activate(0)
    else context.wait()
  },
  Op: context => {
    const name = originalOperationName(number(context.local(1)), number(context.local(2)))
    const operation = name ? ORIGINAL_OPERATIONS[name] : undefined
    if (!operation) throw new Error(`Op ${context.node.index} runs ${name ?? 'an unrecovered operation'}, which is not implemented`)
    context.setOutput(0, operation(context, context.input(0), context.input(1), context.node.outputs?.[0]?.type))
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  'Get Cell': context => {
    // Data Array target; inputs are (row, column); outputs are Found/Not Found.
    const array = context.array()
    const cell = array ? originalGetCell(array, number(context.input(0)), number(context.input(1))) : undefined
    context.setOutput(0, cell ?? null)
    context.consumeInput(context.inputSlot)
    context.activate(cell === undefined ? 1 : 0)
  },
  'Set Cell': context => {
    const array = context.array()
    const success = array ? originalArraySetCell(context, array, number(context.input(0)), number(context.input(1)), context.input(2)) : false
    context.consumeInput(context.inputSlot)
    context.activate(success ? 0 : 1)
  },
  Show: context => {
    const object = context.object()
    if (object) object.visible = true
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  Hide: context => {
    const object = context.object()
    if (object) object.visible = false
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  // 3DTrans SetPosition.cpp: In off and Out, then SetPosition(&Position,
  // Referential, KeepChildren = !Hierarchy) on the target.
  'Set Position': context => {
    context.consumeInput(context.inputSlot)
    context.activate(0)
    const position = context.input(0)
    const object = context.object()
    if (object && Array.isArray(position)) {
      const referential = context.inputObject(1)
      const hierarchy = context.input(2)
      if (object.setPositionIn) {
        const vector = authoredVectorToBinding([Number(position[0]), Number(position[1]), Number(position[2])], context.coordinateScale)
        object.setPositionIn(vector, referential, hierarchy === null ? false : hierarchy !== true)
      } else {
        // Bindings without a hierarchy place points through the referential's
        // frame when they can and write the vector as is otherwise.
        let world: [number, number, number] = [position[0]!, position[1]!, position[2]!]
        const frame = referential ? context.object(referential) : undefined
        if (frame?.toWorld) world = frame.toWorld(world)
        object.position = world
      }
    }
  },
  // Logics RayIntersection.cpp: the nearest face of the Filter group's
  // entities (every 3D object without one) within Depth along the ray, given
  // in the Referential's frame. Settings: Output Param Update, Skip Owner, Skip
  // Transparent. True when something was hit, False otherwise.
  'Ray Intersection': context => {
    context.consumeInput(context.inputSlot)
    const vector = (value: GraphParameterValue, fallback: [number, number, number]): [number, number, number] =>
      Array.isArray(value) && value.length >= 3 ? [value[0]!, value[1]!, value[2]!] : fallback
    let origin = vector(context.input(0), [0, 0, 0])
    let direction = vector(context.input(1), [0, 0, 1])
    const referential = context.input(2)
    if (typeof referential === 'string' && referential) {
      const frame = context.object(referential)
      if (!frame?.toWorld) throw new Error(`Ray Intersection ${context.node.index} referential ${referential} cannot transform points`)
      if (frame.toWorldVector) {
        direction = frame.toWorldVector(direction)
      } else {
        const zero = frame.toWorld([0, 0, 0]), end = frame.toWorld(direction)
        direction = [end[0] - zero[0], end[1] - zero[1], end[2] - zero[2]]
      }
      origin = frame.toWorld(origin)
    }
    direction = originalNormalize(direction)
    const depth = context.input(3)
    const group = context.input(4)
    const hit = context.rayIntersection({
      origin, direction, depth: typeof depth === 'number' ? depth : 100,
      ...(typeof group === 'string' && group ? { group } : {}),
      ...(context.local(1) !== false ? { owner: context.owner() } : {}),
      skipTransparent: context.local(2) === true,
    })
    if (!hit) { context.activate(1); return }
    context.setOutput(0, hit.object)
    if (context.local(0) !== false) {
      context.setOutput(1, hit.faceIndex)
      context.setOutput(2, hit.nearestVertex)
      context.setOutput(3, hit.point)
      context.setOutput(4, hit.normal)
      context.setOutput(5, hit.distance)
    }
    context.activate(0)
  },
  // 3DTrans AddScale.cpp ("Scale", 3DTransfo.dll 0x250012A0): SetScale(v, !Hierarchy, TRUE) with
  // Absolute, else AddScale; the entity call comes first, then In off and Out; no target fires
  // nothing (CKBR_OWNERERROR). Hosts without the CK3dEntity calls keep assigning the scale.
  Scale: context => {
    const scale = context.input(0)
    const object = context.object()
    if (object?.setScale || object?.addScale) {
      const vector = Array.isArray(scale) ? [Number(scale[0]), Number(scale[1]), Number(scale[2])] : [1, 1, 1]
      const keepChildren = !(context.input(1) === null ? true : context.input(1) === true || number(context.input(1)) !== 0)
      const absolute = context.input(2) === null ? false : context.input(2) === true || number(context.input(2)) !== 0
      if (context.loader && context.loader.classId(context.targetName()!) === CKCID.SPRITE3D) throw new Error(`Scale ${context.node.index} on a 3D sprite (SetSize) is not implemented`)
      if (absolute) object.setScale!(vector, keepChildren)
      else object.addScale!(vector, keepChildren)
      context.consumeInput(context.inputSlot)
      context.activate(0)
      return
    }
    if (!object && context.loader) return
    if (object && Array.isArray(scale)) object.scale = [scale[0]!, scale[1]!, scale[2]!]
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
  // 3DTrans Rotate.cpp (3DTransfo.dll 0x25001740): In off and Out first, then
  // Rotate(axis default (0,1,0), angle default 0.01, Ref, !Hierarchy). Hosts
  // without the CK3dEntity call keep the quaternion approximation.
  Rotate: context => {
    const axis = context.input(0)
    const object = context.object()
    if (object?.rotate) {
      context.consumeInput(context.inputSlot)
      context.activate(0)
      const vector = Array.isArray(axis) ? [Number(axis[0]), Number(axis[1]), Number(axis[2])] : [0, 1, 0]
      const angle = context.input(1) === null ? Math.fround(.01) : number(context.input(1))
      const hierarchy = context.input(3) === null ? true : context.input(3) === true || number(context.input(3)) !== 0
      object.rotate(vector, angle, context.inputObject(2), !hierarchy)
      return
    }
    if (object && Array.isArray(axis)) {
      const direction = new THREE.Vector3(axis[0]!, axis[1]!, axis[2]!)
      const reference = context.input(2)
      if (typeof reference === 'string' && reference) {
        const frame = context.object(reference)
        // The authored "Referential of the Axis" transforms the axis into the
        // reference's space. A target referential therefore supplies the
        // object's fixed authored orientation, not its live animation.
        if (frame?.matrix) direction.transformDirection(new THREE.Matrix4().fromArray(frame.matrix))
        else if (frame) direction.applyQuaternion(new THREE.Quaternion(...frame.rotation))
      }
      if (direction.lengthSq() === 0) direction.set(0, 1, 0)
      const rotation = new THREE.Quaternion().setFromAxisAngle(direction.normalize(), number(context.input(1)))
      const current = new THREE.Quaternion(...object.rotation)
      // Hierarchy=false rotates around the world/referential axis; true applies
      // the authored axis in the object's own hierarchy.
      object.rotation = (context.input(3) === true ? current.multiply(rotation) : rotation.multiply(current))
        .toArray() as [number, number, number, number]
    }
    context.consumeInput(context.inputSlot)
    context.activate(0)
  },
}

/** Backwards-compatible alias for the primitive registry. */
/** Full behavior registry: core script/primitive behaviors plus the physics
 * (physics_RT.dll) and recovered effect/audio behaviors. */
export const ORIGINAL_BEHAVIORS: BehaviorRegistry = {
  ...CORE_BEHAVIORS,
  ...EFFECT_BEHAVIORS,
  ...MODULE_BEHAVIORS,
  ...PHYSICS_BEHAVIORS,
  ...SCRIPT_BEHAVIORS,
  ...TUTORIAL_BEHAVIORS,
  ...GAMEPLAY_BEHAVIORS,
  ...PARTICLE_BEHAVIORS,
  ...RENDER_BEHAVIORS,
  ...ARRAY_BEHAVIORS,
  ...SOUND_BEHAVIORS,
  ...MATERIAL_BEHAVIORS,
  ...EXTRA_BEHAVIORS,
  ...INTERFACE_BEHAVIORS,
  ...MENU_BEHAVIORS,
  ...CURVE_BEHAVIORS,
  ...ENVIRONMENT_BEHAVIORS,
  ...SYSTEM_BEHAVIORS,
  ...DATABASE_BEHAVIORS,
  ...MOVIE_BEHAVIORS,
  ...CONTEXT_BEHAVIORS,
  ...CONTACT_BEHAVIORS,
}

/** Behavior callbacks by prototype name. */
export const BEHAVIOR_CALLBACKS: Record<string, BehaviorCallback> = {
  ...EXTRA_CALLBACKS,
}

/** CKM_BEHAVIORLOAD callbacks: blocks that create their own objects when their file loads. */
export const BEHAVIOR_LOAD_CALLBACKS: Record<string, (context: BehaviorContext, state: BehaviorState) => void> = {
  ...INTERFACE_LOAD_CALLBACKS,
}

/** Backwards-compatible alias for the full registry. */
export const ORIGINAL_PRIMITIVES = ORIGINAL_BEHAVIORS
