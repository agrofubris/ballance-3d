import * as THREE from 'three'
import type { OriginalContext, OriginalObject } from '../game/original-context.ts'
import type { OriginalSession } from '../game/original-session.ts'
import { originalObjectReference } from '../game/original-context.ts'
import { ORIGINAL_HINGES } from '../game/original-hinges.ts'
import type { HingeKind } from '../game/original-hinges.ts'
import type { GraphParameterValue } from '../game/original-graph.ts'
import type { Material } from '../game/levels.ts'
import { HARNESS_TICK_SECONDS } from './types.ts'
import type {
  HarnessCapabilities,
  HarnessContactSample,
  HarnessInputState,
  HarnessLifecycleSample,
  HarnessModuleSelection,
  HarnessObserver,
  HarnessTickRecord,
  HarnessTransformationSample,
} from './types.ts'

export function semanticId(name: string) {
  const leaf = name.slice(name.lastIndexOf('/') + 1)
  if (leaf.startsWith('PE_Balloon_')) return `pe_balloon.${leaf.slice('PE_Balloon_'.length)}`
  return leaf
}

/** One copied module instance of the session: its document and Levelinit copy suffix. */
interface ModuleInstance {
  kind: string
  document: string
  /** '' for the module document's own objects, otherwise the three-digit copy suffix. */
  suffix: string
  /** The level placement's saved name (the engine's module instance name). */
  name?: string
  /** The placement's saved matrix (the engine catalog's placement). */
  matrix?: readonly number[]
  /** The placement's PH sector cell. */
  sector?: number
}

/** A level placement saved in the level document (the engine's module instance names). */
export interface GraphSessionPlacement {
  name: string
  matrix: readonly number[]
}

/** The finish assembly a level placement instantiates. */
interface FinishInstance {
  document: string
  /** '' when the placement uses the module document's own objects. */
  suffix: string
  /** The placement's `PH` sector row. */
  sector: number
  platform: OriginalObject
  boxSlide: OriginalObject
}

/** The session physics methods the graph observer reads, whichever backend hosts them. */
export interface GraphSessionSimulation {
  body(reference: string): unknown
  references(): string[]
  jointCount(reference: string): number
  hullCount(reference: string): number | undefined
  forceKeys(): string[]
}

/** One manifold contact as the engine Rapier observer reports it (render units). */
export interface GraphSessionContact {
  other: unknown
  normal: [number, number, number]
  point: [number, number, number] | null
  separation: number | null
  normalImpulse: number | null
  tangentImpulse: [number, number] | null
  feature1: number | null
  feature2: number | null
}

export interface GraphSessionContactSample {
  count: number
  contacts: GraphSessionContact[]
}

/** What the graph observer may read from the harness graph session. */
export interface GraphSessionView {
  readonly context: OriginalContext
  readonly session: OriginalSession
  readonly simulation: GraphSessionSimulation
  readonly solver: 'ivp' | 'rapier'
  readonly notes: string[]
  /** The scenario's 0-based level (the engine starts the UFO only on level 11). */
  readonly level: number
  /** The scenario's module selection, which the engine observer prefers. */
  readonly module: HarnessModuleSelection | null
  array(name: string): GraphParameterValue[][] | undefined
  activeBall(): OriginalObject | undefined
  scriptActive(document: string, name: string): boolean
  /** A root script anywhere in the session, including module copies. */
  anyScriptActive(name: string): boolean
  /** The level document's placements, in its object-table order. */
  placements(kind: string): readonly GraphSessionPlacement[]
  /** A body's raw backend state: position, rotation, linear and angular velocity. */
  state(body: unknown): number[]
  contacts(body: unknown, detail: boolean): GraphSessionContactSample
  objectOf(body: unknown): OriginalObject | undefined
  bodyCount(): number
  colliderEnabled(body: unknown): boolean
  bodyEnabled(body: unknown): boolean
}

interface FinishSample {
  phase: HarnessLifecycleSample['finishPhase']
  active: boolean
  parts: number
  modules: number
  platform: THREE.Vector3 | null
  platformRotation: [number, number, number, number] | null
  platformLinearVelocity: [number, number, number] | null
  platformAngularVelocity: [number, number, number] | null
  colliders: number | null
  platformBody: unknown
}

interface TransformerClock {
  timers: { index: number; durationMs: number }[]
}

async function loadTransformerClock(): Promise<TransformerClock> {
  const response = await fetch('/original/transformer-clock-data.json')
  if (!response.ok) throw new Error(`The original harness needs the exported transformer clock; run scripts/prepare-original.py (${response.status})`)
  return await response.json() as TransformerClock
}

const transformerClock = await loadTransformerClock()
const CONTACTS: HarnessContactSample = { grounded: false, supportIds: [], contactCount: 0 }
const HINGE_KINDS = Object.keys(ORIGINAL_HINGES) as HingeKind[]
const MATRIX_EPSILON = 1e-3
const FINISH_KIND = 'PE_Balloon'
const FINISH_PLACEMENT_TYPE = 'PE_Levelende'
const MATERIALS = new Set<Material>(['paper', 'wood', 'stone'])
const EXPLOSION_SCRIPTS = ['Ball_Explosion_Paper', 'Ball_Explosion_Wood', 'Ball_Explosion_Stone'] as const
/** `dephysic Ball`'s 1350 ms + `Delayer` 5's 1000 ms, the authored `start Explosion` time. */
const SHATTER_AGE = (transformerClock.timers[0]!.durationMs + transformerClock.timers[1]!.durationMs) / 1000

function numberCell(rows: GraphParameterValue[][] | undefined, column: number): number {
  const value = rows?.[0]?.[column]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function ballType(ball: OriginalObject | undefined): Material {
  const type = /^Ball_(Paper|Wood|Stone)$/i.exec(ball?.name ?? '')?.[1]?.toLowerCase()
  return type === 'paper' || type === 'stone' ? type : 'wood'
}

function renderMatrix(context: OriginalContext, ball: OriginalObject | undefined) {
  if (!ball) return { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] }
  const matrix = context.worldMatrix(ball.id)
  if (!matrix) throw new Error(`The active ball ${ball.name} has no world matrix`)
  const position = new THREE.Vector3(matrix[12], matrix[13], matrix[14])
  const rotation = new THREE.Quaternion(), scale = new THREE.Vector3()
  new THREE.Matrix4().fromArray(matrix).decompose(new THREE.Vector3(), rotation, scale)
  return {
    position: [position.x * .25, position.y * .25, -position.z * .25] as [number, number, number],
    rotation: [-rotation.x, -rotation.y, rotation.z, rotation.w] as [number, number, number, number],
  }
}

/** An authored (original-unit) matrix translation in render units. */
function renderMatrixTranslation(matrix: readonly number[]): [number, number, number] {
  return [matrix[12]! * .25, matrix[13]! * .25, -matrix[14]! * .25]
}

function sameMatrix(saved: readonly number[] | undefined, current: GraphParameterValue | undefined): boolean {
  if (!Array.isArray(saved) || !Array.isArray(current) || saved.length < 16 || current.length < 16) return false
  for (let i = 0; i < 16; i++) {
    const value = current[i]
    if (typeof value !== 'number' || Math.abs(saved[i]! - value) > MATRIX_EPSILON) return false
  }
  return true
}

function copySuffixOf(context: OriginalContext, object: OriginalObject): string {
  if (!/\d{3}$/.test(object.name)) return ''
  const base = object.name.slice(0, -3)
  const original = context.byName(base).some(item => item.document === object.document && item.classId === object.classId)
  return original ? object.name.slice(-3) : ''
}

export function emptyGraphRecord(tick: number, input: HarnessInputState, solver: 'ivp' | 'rapier' = 'ivp'): HarnessTickRecord {
  const lifecycle: HarnessLifecycleSample = {
    phase: 'paused', activeSector: 0, checkpoint: 0, lives: 0,
    physicalized: false, colliderEnabled: false, transformation: null,
    spawnActive: false, spawnUnveiled: false, activeFanNames: [], riding: false, ending: false,
    respawnStage: 'idle', finishPhase: 'none', finishActive: false, finishParts: 0, finishModules: 0,
    platformPosition: null, platformRotation: null, platformLinearVelocity: null, platformAngularVelocity: null,
    platformDistanceFromOrigin: null, stalePlatformSupport: false, platformColliders: null,
    liftTravel: null, sackTravel: null, chainJoints: null, hingeAngle: null, hingeJoints: null, hingeEnabled: null,
    sliderTravel: null, sliderLateral: null, sliderJoints: null, pusherTravel: null, ufoStage: null, backendBodies: 0,
  }
  return {
    scenario: '', solver, tick, simTime: tick * HARNESS_TICK_SECONDS,
    ball: { position: [0, 0, 0], rotation: [0, 0, 0, 1], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0], type: 'wood' },
    input, lifecycle, contacts: { ...CONTACTS, supportIds: [] }, events: [],
  }
}

export class GraphSessionObserver implements HarnessObserver {
  readonly solver: 'ivp' | 'rapier'
  readonly capabilities: HarnessCapabilities
  private readonly view: GraphSessionView
  private detail = false
  private unveiled = false
  private spawnActive = false
  /** Each body's pose when it first appeared, as the engine modules record at physicalization. */
  private readonly initialStates = new Map<string, { body: unknown; state: number[] }>()
  private sackOrigin?: THREE.Vector3
  private platformOrigin?: THREE.Vector3
  /** The authored departure started and has not been reset. */
  private ending = false
  /** The authored level-complete message arrived. */
  private won = false
  /** The authored `Game Over` message arrived. */
  private lost = false
  /** `Ball Off` started the authored Deactivate Ball sequence. */
  private respawnActive = false
  private respawnStart = 0
  private respawnRemoved = false
  private respawnForming = false
  /** The authored AnimTrafo script is running. */
  private transformationActive = false
  private transformationStart = 0
  private transformationTarget: Material = 'wood'
  private transformationShattered = false
  private transformationCommitted = false
  private transformationAge = 0
  /** The last transformation sample, kept after the authored animation ends. */
  private transformationSeen = false
  /** Messages delivered or posted during the frame being sampled. */
  private messages = new Set<string>()
  /** The sample's finish-platform contact classification. */
  private platformSupport: 'managed' | 'foreign' | null = null
  /** The authored UFO row state, mirroring OriginalUfo.stage (last level only). */
  private ufo = { stage: 'idle' as 'idle' | 'waiting' | 'flight' | 'flash' | 'done', row: -1, rowAge: 0, rowAdvance: false, delay: 0, flashAge: 0, started: false }

  constructor(view: GraphSessionView) {
    this.view = view
    this.solver = view.solver
    this.capabilities = view.solver === 'rapier'
      ? { velocityInjection: true, contactManifoldDetail: true, supportIdentity: true, backendBodyCount: true }
      : { velocityInjection: false, contactManifoldDetail: false, supportIdentity: true, backendBodyCount: false }
  }

  setDetail(detail: boolean): void { this.detail = detail }

  reset(): void {
    this.unveiled = false
    this.spawnActive = false
    this.sackOrigin = this.sackPosition() ?? undefined
    this.platformOrigin = this.platformPosition() ?? undefined
    this.ending = false
    this.won = false
    this.lost = false
    this.respawnActive = false
    this.respawnStart = 0
    this.respawnRemoved = false
    this.respawnForming = false
    this.transformationActive = false
    this.transformationStart = 0
    this.transformationTarget = 'wood'
    this.transformationShattered = false
    this.transformationCommitted = false
    this.transformationAge = 0
    this.transformationSeen = false
    this.messages = new Set
    this.ufo = { stage: 'idle', row: -1, rowAge: 0, rowAdvance: false, delay: 0, flashAge: 0, started: false }
  }

  /**
   * Record the physicalization pose of every body that just appeared. The
   * harness runtime calls this after each authored frame of the staged start,
   * so the mechanism origins are the poses at physicalization.
   */
  observeBodies(): void {
    const live = new Set<string>()
    for (const reference of this.view.simulation.references()) {
      const body = this.view.simulation.body(reference)
      if (body === undefined) continue
      live.add(reference)
      if (this.initialStates.get(reference)?.body === body) continue
      this.initialStates.set(reference, { body, state: this.poseOf(body) })
    }
    for (const reference of [...this.initialStates.keys()]) if (!live.has(reference)) this.initialStates.delete(reference)
  }

  /** A raw backend state in render units, velocity convention as the engine observers. */
  private renderState(state: readonly number[]): {
    position: [number, number, number]
    rotation: [number, number, number, number]
    linearVelocity: [number, number, number]
    angularVelocity: [number, number, number]
  } {
    if (this.view.solver === 'rapier') {
      return {
        position: [state[0]!, state[1]!, state[2]!],
        rotation: [state[3]!, state[4]!, state[5]!, state[6]!],
        linearVelocity: [state[7]!, state[8]!, state[9]!],
        angularVelocity: [state[10]!, state[11]!, state[12]!],
      }
    }
    return {
      position: [state[0]! * .25, state[1]! * .25, -state[2]! * .25],
      rotation: [-state[3]!, -state[4]!, state[5]!, state[6]!],
      linearVelocity: [state[7]! * .5, state[8]! * .5, -state[9]! * .5],
      angularVelocity: [state[10]! * .5, state[11]! * .5, -state[12]! * .5],
    }
  }

  private poseOf(body: unknown): number[] {
    const state = this.view.state(body)
    const posed = this.renderState(state)
    return [...posed.position, ...posed.rotation]
  }

  private sameBody(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a === undefined || b === undefined || a === null || b === null) return false
    const left = a as { handle?: number }, right = b as { handle?: number }
    return typeof left.handle === 'number' && left.handle === right.handle
  }

  diagnostics(): string[] {
    return []
  }

  sample(tick: number, input: HarnessInputState): HarnessTickRecord {
    this.observeBodies()
    this.observeMessages()
    const view = this.view
    const ball = view.activeBall()
    const reference = ball ? originalObjectReference(ball.id) : undefined
    const handle = reference === undefined ? undefined : view.simulation.body(reference)
    const state = handle === undefined ? undefined : view.state(handle)
    const posed = state
      ? this.renderState(state)
      : {
          ...renderMatrix(view.context, ball),
          linearVelocity: [0, 0, 0] as [number, number, number],
          angularVelocity: [0, 0, 0] as [number, number, number],
        }
    const spawnActive = view.scriptActive('Balls', 'Ball_LightningSphere')
    if (spawnActive && !this.spawnActive) this.unveiled = false
    if (view.scriptActive('Balls', 'BallParticle_Frame script')) this.unveiled = true
    this.spawnActive = spawnActive
    const active = view.array('CurrentLevel')?.[0]?.[4]
    const sector = numberCell(view.array('IngameParameter'), 1)
    const hinge = this.hingeSample()
    const slider = this.sliderSample()
    const finish = this.finishSample()
    const transformation = this.transformationSample(tick)
    const respawnStage = this.respawnSample(tick, handle)
    if (finish.phase === 'departing') this.ending = true
    else if (finish.phase === 'dormant' || finish.phase === 'none') this.ending = false
    if (this.messages.has('End Level')) this.won = true
    if (this.messages.has('Game Over')) this.lost = true
    const record = emptyGraphRecord(tick, input, this.solver)
    record.ball = { ...posed, type: ballType(ball) }
    record.lifecycle = {
      ...record.lifecycle,
      phase: this.won ? 'won' : this.lost ? 'lost' : active === false ? 'paused' : 'playing',
      activeSector: sector,
      checkpoint: Math.max(0, sector - 1),
      lives: numberCell(view.array('Energy'), 1),
      physicalized: handle !== undefined,
      colliderEnabled: handle !== undefined && this.view.colliderEnabled(handle),
      transformation,
      spawnActive,
      spawnUnveiled: this.unveiled,
      activeFanNames: this.activeFanNames(),
      riding: finish.phase === 'departing',
      ending: this.ending,
      respawnStage,
      finishPhase: finish.phase,
      finishActive: finish.active,
      finishParts: finish.parts,
      finishModules: finish.modules,
      platformPosition: finish.platform ? finish.platform.toArray() as [number, number, number] : null,
      platformRotation: finish.platformRotation,
      platformLinearVelocity: finish.platformLinearVelocity,
      platformAngularVelocity: finish.platformAngularVelocity,
      platformDistanceFromOrigin: finish.platform && this.platformOrigin ? finish.platform.distanceTo(this.platformOrigin) : null,
      stalePlatformSupport: this.platformSupport === 'foreign',
      platformColliders: finish.colliders,
      liftTravel: this.liftTravel(),
      sackTravel: this.sackTravel(),
      chainJoints: this.chainJoints(),
      hingeAngle: hinge.angle,
      hingeJoints: hinge.joints,
      hingeEnabled: hinge.enabled,
      sliderTravel: slider.travel,
      sliderLateral: slider.lateral,
      sliderJoints: slider.joints,
      pusherTravel: this.pusherTravel(),
      ufoStage: this.ufoStage(finish),
      backendBodies: this.view.bodyCount(),
    }
    record.contacts = this.contacts(handle, finish.platformBody)
    record.lifecycle.stalePlatformSupport = this.platformSupport === 'foreign'
    return record
  }

  /** The messages the session posted this frame and delivered from the previous one. */
  private observeMessages(): void {
    this.messages = new Set
    const bus = this.view.session.bus
    for (const message of bus.messages) this.messages.add(String(message.id))
    for (const message of bus.lastFrame()) this.messages.add(String(message.id))
  }

  /**
   * The level's finish placement: its `PH` row is the `PE_Levelende` entry with
   * the placement's saved matrix (Levelinit's `init and load Levelende`), and
   * the row's Object is the copied `PE_Balloon_MF` the authored script runs on.
   */
  private finishInstance(): FinishInstance | undefined {
    const placements = this.view.placements(FINISH_KIND)
    if (!placements.length) return undefined
    const selected = this.view.module?.kind === FINISH_KIND ? this.view.module.instance : undefined
    const placement = selected === undefined ? placements[0] : placements.find(item => item.name === selected)
    if (!placement) throw new Error(`Level ${FINISH_KIND} has no placement named ${String(selected)}`)
    const rows = (this.view.array('PH') ?? []).filter(row => row[1] === FINISH_PLACEMENT_TYPE && sameMatrix(placement.matrix, row[2]))
    // The module document is loaded by Levelinit_build; before that (the
    // pre-session baseline) the placement has no PH row yet.
    if (!rows.length) return undefined
    if (rows.length !== 1) throw new Error(`The PH row of ${placement.name} matched ${rows.length} ${FINISH_PLACEMENT_TYPE} placements`)
    const value = rows[0]![3]
    const root = typeof value === 'string' && /^#\d+$/.test(value) ? this.view.context.get(Number(value.slice(1))) : undefined
    if (!root || root.document !== FINISH_KIND) throw new Error(`The PH row of ${placement.name} has no ${FINISH_KIND} module object`)
    const suffix = copySuffixOf(this.view.context, root)
    const entity = (base: string) => {
      const candidates = this.view.context.byName(base + suffix)
        .filter(object => object.document === FINISH_KIND && this.view.context.isEntity(object.id))
      if (candidates.length !== 1) throw new Error(`${FINISH_KIND}${suffix === '' ? '' : ' ' + suffix} has ${candidates.length} entities named ${base}${suffix}`)
      return candidates[0]!
    }
    const sector = rows[0]![0]
    if (typeof sector !== 'number' || !Number.isFinite(sector)) throw new Error(`The PH row of ${placement.name} has sector ${String(sector)}`)
    return { document: FINISH_KIND, suffix, sector, platform: entity('PE_Balloon_Platform'), boxSlide: entity('PE_Box_slide') }
  }

  /** The live bodies of the finish copy (18 when fully physicalized). */
  private finishReferences(instance: FinishInstance): string[] {
    return this.view.simulation.references().filter(reference => {
      const object = this.view.context.get(Number(reference.slice(1)))
      return !!object && object.document === instance.document && copySuffixOf(this.view.context, object) === instance.suffix
    })
  }

  private finishSample(): FinishSample {
    const empty: FinishSample = {
      phase: 'none', active: false, parts: 0, modules: 0, platform: null,
      platformRotation: null, platformLinearVelocity: null, platformAngularVelocity: null,
      colliders: null, platformBody: undefined,
    }
    const instance = this.finishInstance()
    if (!instance) return empty
    const sector = numberCell(this.view.array('IngameParameter'), 1)
    // The engine's native finish exists only while its sector is active.
    if (sector !== instance.sector) return empty
    const platformReference = originalObjectReference(instance.platform.id)
    const platformBody = this.view.simulation.body(platformReference)
    const state = platformBody === undefined ? undefined : this.renderState(this.view.state(platformBody))
    const references = this.finishReferences(instance)
    const targets = new Set(this.view.simulation.forceKeys().map(key => key.slice(0, key.lastIndexOf(':'))))
    const boxSlide = targets.has(originalObjectReference(instance.boxSlide.id))
    const woken = references.some(reference =>
      /^PE_Balloon_Ballon/.test(this.view.context.get(Number(reference.slice(1)))?.name ?? '') && targets.has(reference))
    return {
      phase: boxSlide ? 'departing' : woken ? 'ready' : 'dormant',
      active: true,
      parts: references.length,
      modules: 1,
      platform: state ? new THREE.Vector3(...state.position) : null,
      platformRotation: state ? state.rotation : null,
      platformLinearVelocity: state ? state.linearVelocity : null,
      platformAngularVelocity: state ? state.angularVelocity : null,
      colliders: platformBody === undefined ? null : this.view.simulation.hullCount(platformReference) ?? null,
      platformBody,
    }
  }

  private platformPosition(): THREE.Vector3 | null {
    return this.finishSample().platform
  }

  /**
   * The authored UFO state, mapped to the engine's OriginalUfo.stage. The
   * authored state is the `PE_UFO_Pos&Time` iterator (node 1384): each row's
   * Waiting Time is the flight wait, `Start Anim?` runs the claw (`Greif Anim`
   * 1505 -> `Play Global Animation` 1488), and the iterator's Out enters
   * `Hyperspace` (1727), whose `Bezier Progression` 1665 is the 800 ms flash.
   * The engine advances one row transition per presentation frame; the
   * authored iterator's Waiting Time values are the same rows, so the state
   * machine steps them frame by frame like OriginalUfo.step.
   */
  private ufoStage(finish: FinishSample): string {
    const ufo = this.ufo
    if (this.view.level !== 11) return 'idle'
    if (!ufo.started) {
      if (finish.phase !== 'departing') return 'idle'
      ufo.started = true
      ufo.stage = 'waiting'
      ufo.delay = 2
      ufo.row = -1
      ufo.rowAge = 0
      ufo.rowAdvance = false
      ufo.flashAge = 0
      return ufo.stage
    }
    if (ufo.stage === 'done') return ufo.stage
    const deltaMs = HARNESS_TICK_SECONDS * 1000
    if (ufo.stage === 'waiting') {
      if (--ufo.delay <= 0) {
        ufo.stage = 'flight'
        ufo.row = 0
        ufo.rowAge = 0
        ufo.rowAdvance = false
      }
      return ufo.stage
    }
    const rows = this.view.array('PE_UFO_Pos&Time')
    if (!rows || rows.length === 0) throw new Error('The authored PE_UFO_Pos&Time rows are missing')
    if (ufo.stage === 'flight') {
      if (ufo.rowAdvance) {
        ufo.row++
        if (ufo.row >= rows.length) {
          ufo.stage = 'flash'
          ufo.flashAge = 0
          return ufo.stage
        }
        ufo.rowAge = 0
        ufo.rowAdvance = false
      } else {
        const wait = rows[ufo.row]?.[3]
        if (typeof wait !== 'number' || !Number.isFinite(wait)) throw new Error(`The authored PE_UFO_Pos&Time row ${ufo.row} has no waiting time`)
        ufo.rowAge += deltaMs
        if (ufo.rowAge >= wait) ufo.rowAdvance = true
      }
      return ufo.stage
    }
    const node = this.view.session.runtime('PE_Balloon')?.data.nodes['1665']
    const duration = node?.inputs?.[0]?.value
    if (typeof duration !== 'number' || !(duration > 0)) throw new Error('The authored Hyperspace Bezier duration is missing')
    ufo.flashAge += deltaMs
    if (ufo.flashAge > duration) ufo.stage = 'done'
    return ufo.stage
  }

  /** The authored ball switch's `TrafoType` local (Trafo Manager 876, `Has Attribute` 428). */
  private transformationTargetValue(): Material | undefined {
    const value = this.view.session.runtime('Gameplay')?.value(56)
    return typeof value === 'string' && MATERIALS.has(value.toLowerCase() as Material) ? value.toLowerCase() as Material : undefined
  }

  /**
   * `AnimTrafo`'s `AnimTrafo_MF Script` is activated by `starte Trafo` 481 and
   * deactivated by its own `Exit` 265. `start Explosion` 403 runs the
   * `Ball_Explosion_*` scripts, and `set new Ball` 169 writes the new active
   * ball (CurrentLevel[0][1] through Set Cell 76).
   */
  private transformationSample(tick: number): HarnessTransformationSample | null {
    const active = this.view.session.runtime('AnimTrafo')?.isScriptActive('AnimTrafo_MF Script') ?? false
    if (active && !this.transformationActive) {
      this.transformationActive = true
      this.transformationStart = tick
      this.transformationAge = 0
      this.transformationTarget = this.transformationTargetValue() ?? 'wood'
      this.transformationShattered = false
      this.transformationCommitted = false
      this.transformationSeen = true
    }
    if (!active) {
      this.transformationActive = false
      if (!this.transformationSeen) return null
      return {
        active: false, age: this.transformationAge, target: this.transformationTarget,
        committed: this.transformationCommitted, shattered: this.transformationShattered,
      }
    }
    this.transformationSeen = true
    const target = this.transformationTargetValue()
    if (target) this.transformationTarget = target
    this.transformationAge = (tick - this.transformationStart) * HARNESS_TICK_SECONDS
    // `start Explosion` 403 runs `dephysic Ball`'s 1350 ms Delayer 568 and
    // Delayer 5's 1000 ms after `starte Trafo` 481. Its selected debris script
    // is unreachable in the session (the "Pout 0" target), so the authored
    // clock is the observable state; a debris script activation also counts.
    if (this.transformationAge >= SHATTER_AGE
      || EXPLOSION_SCRIPTS.some(name => this.view.scriptActive('Balls', name))) this.transformationShattered = true
    const ball = this.view.activeBall()
    if (ball && ballType(ball) === this.transformationTarget) this.transformationCommitted = true
    return {
      active: true, age: this.transformationAge, target: this.transformationTarget,
      committed: this.transformationCommitted, shattered: this.transformationShattered,
    }
  }

  /**
   * `Deactivate Ball` 2499 posts `Ball Off` at its start; `New Ball` 2921
   * posts `Counter active` after its Physicalize + WakeUp (P+1). The authored
   * steps between them map onto the engine `OriginalRespawn` stages: the
   * 2-frame lives test (checking), the flash and 1000 ms before Unphysicalize
   * (falling), the sector reset and New Ball entry (positioning), the 3000 ms
   * Delayer (forming) and Physicalize..WakeUp (waking). `Game Over` ends the
   * sequence without a new ball.
   */
  private respawnSample(tick: number, ball: unknown): string {
    if (this.messages.has('Game Over')) {
      this.respawnActive = false
      this.respawnRemoved = false
      this.respawnForming = false
      return 'idle'
    }
    if (!this.respawnActive) {
      if (!this.messages.has('Ball Off')) return 'idle'
      this.respawnActive = true
      this.respawnStart = tick
      this.respawnRemoved = false
      this.respawnForming = false
    }
    if (this.messages.has('Counter active')) {
      this.respawnActive = false
      this.respawnRemoved = false
      this.respawnForming = false
      return 'idle'
    }
    if (tick - this.respawnStart < 2) return 'checking'
    if (!this.respawnRemoved) {
      if (ball === undefined) this.respawnRemoved = true
      return 'falling'
    }
    if (ball === undefined) {
      if (this.spawnActive) this.respawnForming = true
      return this.respawnForming ? 'forming' : 'positioning'
    }
    return 'waking'
  }

  /**
   * The engine's `graphFanNames`: each `P_Modul_18` copy's authored
   * `SetPhysicsForce` 433 on the active ball. The session's IVP binding keys a
   * controller by the behavior instance, `<script owner>@<authored node>`, so
   * the key itself names the copy that installed the force. The owner is the
   * copy's MF object; its suffix is the Levelinit copy suffix that
   * `moduleInstances` also uses.
   */
  private activeFanNames(): string[] {
    const ball = this.view.activeBall()
    if (!ball) return []
    const reference = originalObjectReference(ball.id)
    const sector = numberCell(this.view.array('IngameParameter'), 1)
    const names = new Set<string>()
    const instances = this.moduleInstances('P_Modul_18')
    for (const key of this.view.simulation.forceKeys()) {
      const targetEnd = key.indexOf(':')
      if (targetEnd <= 0 || key.slice(0, targetEnd) !== reference) continue
      const controller = key.slice(targetEnd + 1)
      const nodeAt = controller.lastIndexOf('@')
      if (nodeAt < 0 || controller.slice(nodeAt + 1) !== '433') continue
      const owner = controller.slice(0, nodeAt)
      const object = /^#\d+$/.test(owner) ? this.view.context.get(Number(owner.slice(1))) : undefined
      const suffix = object ? copySuffixOf(this.view.context, object) : ''
      // A pool copy serves one placement per sector; the suffix names the copy,
      // the active sector names the placement using it.
      const instance = instances.find(item => item.suffix === suffix && item.sector === sector)
      if (instance?.name) names.add(instance.name)
    }
    return [...names].sort()
  }

  /** Every hosted copy of a module kind, in level placement order. */
  private moduleInstances(kind: string): ModuleInstance[] {
    const rows = this.view.array('PH_Groups')
    const row = rows?.find(item => item[0] === kind)
    if (!row) return []
    const amount = row[1]
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
      throw new Error(`The session's PH_Groups amount for ${kind} is ${String(amount)}`)
    }
    const instances: ModuleInstance[] = []
    for (const placement of this.view.placements(kind)) {
      const ph = (this.view.array('PH') ?? []).filter(item => item[1] === kind && sameMatrix(placement.matrix, item[2]))
      if (ph.length !== 1) throw new Error(`The PH row of ${placement.name} matched ${ph.length} ${kind} placements`)
      const value = ph[0]![3]
      const object = typeof value === 'string' && /^#\d+$/.test(value) ? this.view.context.get(Number(value.slice(1))) : undefined
      if (!object || object.document !== kind) throw new Error(`The PH row of ${placement.name} has no ${kind} module object`)
      const sector = ph[0]![0]
      if (typeof sector !== 'number' || !Number.isFinite(sector)) throw new Error(`The PH row of ${placement.name} has sector ${String(sector)}`)
      instances.push({ kind, document: kind, suffix: copySuffixOf(this.view.context, object), name: placement.name, matrix: placement.matrix, sector })
    }
    // PH_Groups holds the pool size (the maximum placements of this kind in
    // one sector), not the number of saved placements: a pool copy serves one
    // placement per sector. Every distinct copy suffix must be in the pool.
    const copies = new Set(instances.map(instance => instance.suffix))
    if (copies.size !== amount) throw new Error(`PH_Groups lists ${amount} ${kind} copies, but the level's PH rows use ${copies.size}`)
    return instances
  }

  /**
   * The engine observers' contact sample: every manifold contact counts; a
   * contact whose render-space normal has y > 0.3 adds the other body's
   * semantic name to the supports.
   */
  private contacts(ball: unknown, platform: unknown): HarnessContactSample {
    this.platformSupport = null
    if (ball === undefined) return { grounded: false, supportIds: [], contactCount: 0 }
    const sample = this.view.contacts(ball, this.detail)
    const supports = new Set<string>()
    const details: NonNullable<HarnessContactSample['contacts']> = []
    for (const contact of sample.contacts) {
      const name = this.bodyName(contact.other)
      const id = semanticId(name)
      if (id === 'pe_balloon.Platform') this.platformSupport = this.sameBody(contact.other, platform) ? 'managed' : 'foreign'
      if (contact.normal[1] > 0.3) supports.add(id)
      if (this.detail) {
        details.push({
          id,
          normal: contact.normal,
          point: contact.point,
          separation: contact.separation,
          normalImpulse: contact.normalImpulse,
          tangentImpulse: contact.tangentImpulse,
          feature1: contact.feature1,
          feature2: contact.feature2,
        })
      }
    }
    const supportIds = [...supports].sort()
    return { grounded: supportIds.length > 0, supportIds, contactCount: sample.count, ...(this.detail ? { contacts: details } : {}) }
  }

  /** The session's body-to-entity mapping, with Levelinit copy suffixes removed. */
  private bodyName(body: unknown): string {
    const object = this.view.objectOf(body)
    if (object) return object.name.slice(0, object.name.length - copySuffixOf(this.view.context, object).length)
    const handle = (body as { handle?: number }).handle
    return `body:${handle ?? String(body)}`
  }

  /** The engine's selected module instance, or the first placement of the kind. */
  private moduleInstance(kind: string, prefer?: string): ModuleInstance | undefined {
    const rows = this.view.array('PH_Groups')
    const row = rows?.find(item => item[0] === kind)
    if (!row) {
      if (prefer !== undefined) throw new Error(`The scenario selects ${prefer}, but the session lists no ${kind} instance`)
      return undefined
    }
    const amount = row[1]
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
      throw new Error(`The session's PH_Groups amount for ${kind} is ${String(amount)}`)
    }
    if (amount === 0) {
      if (prefer !== undefined) throw new Error(`The scenario selects ${prefer}, but the level has no ${kind} placement`)
      return undefined
    }
    const placements = this.view.placements(kind)
    const placement = prefer === undefined ? placements[0] : placements.find(item => item.name === prefer)
    if (prefer !== undefined && !placement) throw new Error(`Level ${kind} has no placement named ${prefer}`)
    if (!placement) throw new Error(`The session lists ${amount} ${kind} instances, but the level document saves no ${kind} placement`)
    const ph = (this.view.array('PH') ?? []).filter(item => item[1] === kind && sameMatrix(placement.matrix, item[2]))
    if (ph.length !== 1) {
      throw new Error(`The PH row of ${placement.name} matched ${ph.length} ${kind} placements`)
    }
    const value = ph[0]![3]
    const object = typeof value === 'string' && /^#\d+$/.test(value)
      ? this.view.context.get(Number(value.slice(1)))
      : undefined
    if (!object) throw new Error(`The PH row of ${placement.name} has no ${kind} module object`)
    if (object.document !== kind) throw new Error(`The PH row of ${placement.name} points at ${object.name} of ${object.document}`)
    return { kind, document: kind, suffix: copySuffixOf(this.view.context, object), name: placement.name, matrix: placement.matrix }
  }

  /** One authored entity inside the selected copy: its base name plus the copy suffix. */
  private entity(instance: ModuleInstance, base: string): OriginalObject | undefined {
    const candidates = this.view.context.byName(base + instance.suffix)
      .filter(object => object.document === instance.document && this.view.context.isEntity(object.id))
    if (candidates.length > 1) throw new Error(`${instance.kind} has ${candidates.length} entities named ${base}${instance.suffix}`)
    return candidates[0]
  }

  private bodyOf(object: OriginalObject | undefined): { reference: string; body: unknown } | undefined {
    if (!object) return undefined
    const reference = originalObjectReference(object.id)
    const body = this.view.simulation.body(reference)
    return body === undefined ? undefined : { reference, body }
  }

  private copyReferences(instance: ModuleInstance): string[] {
    const references: string[] = []
    for (const reference of this.view.simulation.references()) {
      const object = this.view.context.get(Number(reference.slice(1)))
      if (!object || object.document !== instance.document) continue
      if (copySuffixOf(this.view.context, object) === instance.suffix) references.push(reference)
    }
    return references
  }

  private initial(reference: string): number[] | undefined {
    return this.initialStates.get(reference)?.state
  }

  /** The engine observer's lift travel, in render units. */
  private liftTravel(): number | null {
    const instance = this.moduleInstance('P_Modul_03')
    if (!instance) return null
    const body = this.bodyOf(this.entity(instance, 'P_Modul_03_Floor'))
    const low = this.entity(instance, 'P_Modul_03_frame_low')
    const high = this.entity(instance, 'P_Modul_03_frame_high')
    const initial = body ? this.initial(body.reference) : undefined
    if (!body || !initial || !low || !high) return null
    const lowMatrix = this.view.context.worldMatrix(low.id)
    const highMatrix = this.view.context.worldMatrix(high.id)
    if (!lowMatrix || !highMatrix) return null
    const start = renderMatrixTranslation(lowMatrix)
    const end = renderMatrixTranslation(highMatrix)
    const axis = new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize()
    const position = this.renderState(this.view.state(body.body)).position
    return (position[0] - initial[0]!) * axis.x
      + (position[1] - initial[1]!) * axis.y
      + (position[2] - initial[2]!) * axis.z
  }

  /** `IvpHarnessObserver.sackPosition`: the selected sack body in render units. */
  private sackPosition(): THREE.Vector3 | null {
    const selected = this.view.module?.kind === 'P_Modul_26' ? this.view.module.instance : undefined
    const instance = this.moduleInstance('P_Modul_26', selected)
    if (!instance) return null
    const body = this.bodyOf(this.entity(instance, 'P_Modul_26_Sack'))
    if (!body) return null
    const position = this.renderState(this.view.state(body.body)).position
    return new THREE.Vector3(position[0], position[1], position[2])
  }

  private sackTravel(): number | null {
    const position = this.sackPosition()
    if (!position || !this.sackOrigin) return null
    return Math.hypot(position.x - this.sackOrigin.x, position.z - this.sackOrigin.z)
  }

  /** `OriginalIvpRuntime.chainJoints`: the first chain module's installed joints. */
  private chainJoints(): number | null {
    const instance = this.moduleInstance('P_Modul_29')
    if (!instance) return null
    return this.copyReferences(instance).reduce((total, reference) => total + this.view.simulation.jointCount(reference), 0)
  }

  private hingeSample(): { angle: number | null; joints: number | null; enabled: boolean | null } {
    const kind = this.hingeKind()
    if (!kind) return { angle: null, joints: null, enabled: null }
    const selected = this.view.module?.kind === kind ? this.view.module.instance : undefined
    const instance = this.moduleInstance(kind, selected)
    if (!instance) return { angle: null, joints: null, enabled: null }
    const body = this.bodyOf(this.entity(instance, ORIGINAL_HINGES[kind].target))
    if (!body) return { angle: null, joints: null, enabled: null }
    const enabled = this.solver === 'rapier' ? this.view.bodyEnabled(body.body) : null
    const initial = this.initial(body.reference)
    if (!initial) return { angle: null, joints: this.view.simulation.jointCount(body.reference), enabled }
    const state = this.view.state(body.body)
    const current = new THREE.Quaternion(state[3]!, state[4]!, state[5]!, state[6]!)
    const delta = current.multiply(new THREE.Quaternion(initial[3]!, initial[4]!, initial[5]!, initial[6]!).invert())
    return {
      angle: 2 * Math.acos(Math.min(1, Math.abs(delta.w))),
      joints: this.view.simulation.jointCount(body.reference),
      enabled,
    }
  }

  /** `BaseObserver.hingeKind`: the selected hinge, else the active sector's first hinge placement. */
  private hingeKind(): HingeKind | undefined {
    const selected = this.view.module?.kind as HingeKind | undefined
    if (selected && HINGE_KINDS.includes(selected)) return selected
    const sector = numberCell(this.view.array('IngameParameter'), 1)
    for (const row of this.view.array('PH') ?? []) {
      if (row[0] !== sector || typeof row[1] !== 'string') continue
      if (HINGE_KINDS.includes(row[1] as HingeKind)) return row[1] as HingeKind
    }
    return undefined
  }

  private sliderSample(): { travel: number | null; lateral: number | null; joints: number | null } {
    const selected = this.view.module?.kind === 'P_Modul_34' ? this.view.module.instance : undefined
    const instance = this.moduleInstance('P_Modul_34', selected)
    if (!instance) return { travel: null, lateral: null, joints: null }
    const stone = this.entity(instance, 'P_Modul_34_Schiebestein')
    const frame1 = this.entity(instance, 'P_Modul_34_Slider_Frame01')
    const frame2 = this.entity(instance, 'P_Modul_34_Slider_Frame02')
    const body = this.bodyOf(stone)
    const initial = body ? this.initial(body.reference) : undefined
    const startMatrix = frame1 ? this.view.context.worldMatrix(frame1.id) : undefined
    const endMatrix = frame2 ? this.view.context.worldMatrix(frame2.id) : undefined
    if (!body || !initial || !startMatrix || !endMatrix) return { travel: null, lateral: null, joints: null }
    const start = new THREE.Vector3(...renderMatrixTranslation(startMatrix))
    const end = new THREE.Vector3(...renderMatrixTranslation(endMatrix))
    const axis = end.clone().sub(start).normalize()
    const state = this.renderState(this.view.state(body.body)).position
    const position = new THREE.Vector3(state[0], state[1], state[2])
    const travel = position.clone().sub(new THREE.Vector3(initial[0]!, initial[1]!, initial[2]!)).dot(axis)
    const delta = position.sub(start)
    const lateral = delta.addScaledVector(axis, -delta.dot(axis)).length()
    return { travel, lateral, joints: this.view.simulation.jointCount(body.reference) }
  }

  private pusherTravel(): number | null {
    const selected = this.view.module?.kind === 'P_Modul_01' ? this.view.module.instance : undefined
    const instance = this.moduleInstance('P_Modul_01', selected)
    if (!instance?.matrix) return null
    const body = this.bodyOf(this.entity(instance, 'P_Modul_01_Pusher'))
    if (!body) return null
    const matrix = new THREE.Matrix4().fromArray(instance.matrix as number[])
    const origin = renderMatrixTranslation(instance.matrix)
    const axis = new THREE.Vector3(1, 0, 0).transformDirection(matrix)
    axis.z *= -1
    const position = this.renderState(this.view.state(body.body)).position
    return (position[0] - origin[0]) * axis.x
      + (position[1] - origin[1]) * axis.y
      + (position[2] - origin[2]) * axis.z
  }
}
