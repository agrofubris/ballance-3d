import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { GameplayBinding } from '../game/original-gameplay-binding.ts'
import { OriginalInputManager } from '../game/original-input-manager.ts'
import { OriginalParticleRenderer } from '../game/original-particle-system.ts'
import { OriginalContextPhysics } from '../game/original-context-physics.ts'
import { OriginalContextPhysicsRapier } from '../game/original-context-physics-rapier.ts'
import { GRAVITY, PHYSICS_STEP } from '../game/original-physics.ts'
import { IvpWorld } from '../game/ivp-bridge.ts'
import { OriginalAvi } from '../game/original-avi.ts'
import type { OriginalSessionSimulation } from '../game/original-session.ts'
import {
  createOriginalSession,
  loadOriginalInstall,
  ORIGINAL_SESSION_DOCUMENTS,
  type OriginalInstall,
  type OriginalSessionCreated,
} from '../game/original-session-loader.ts'
import { originalObjectReference, type OriginalContext, type OriginalObject, type OriginalObjectTable } from '../game/original-context.ts'
import type { GraphAudioBinding, GraphSkyBinding } from '../game/original-graph-bindings.ts'
import type { GraphMovieBinding } from '../game/original-graph-movie.ts'
import type { GraphSystemBinding } from '../game/original-graph-system.ts'
import type { GraphParameterValue, OriginalGraphRuntime } from '../game/original-graph.ts'
import type { Material } from '../game/levels.ts'
import { GraphSessionObserver, emptyGraphRecord, type GraphSessionPlacement, type GraphSessionView } from './graph-observer.ts'
import { HARNESS_TICK_SECONDS } from './types.ts'
import type {
  HarnessCapabilities,
  HarnessInputState,
  HarnessModuleSelection,
  HarnessPrepared,
  HarnessRuntime,
  HarnessScenario,
  HarnessStageAction,
  HarnessStart,
  HarnessTickRecord,
} from './types.ts'

const ZERO_INPUT: HarnessInputState = { forward: 0, lateral: 0, brake: false }
const GRAPH_CAPABILITIES: Record<'ivp' | 'rapier', HarnessCapabilities> = {
  ivp: { velocityInjection: false, contactManifoldDetail: false, supportIdentity: false, backendBodyCount: false },
  rapier: { velocityInjection: true, contactManifoldDetail: true, supportIdentity: true, backendBodyCount: true },
}
let rapierReady: Promise<void> | undefined
/** The menu click that opens the level list (512,150) and presses its first button (512,88). */
const MENU_LIST_TICK = 2002
const LEVEL_BUTTON_TICK = 3000
/** `Menu_Start`'s Button 1 sets CurrentLevel[0][0] through Op 2387 / Set Cell 2339. */
const CURRENT_LEVEL_TICK = 3010
const PRELOAD_LIMIT = 20000

/**
 * Authored Gameplay.nmo nodes the staged starts run. `Trafo Manager` polls
 * `Get Nearest In Group` 17 over its `Trafos` group and `Has Attribute` 428
 * copies that trafo's `TrafoType` into the manager's local 56; `set new Ball`
 * 169 switches on that value, writes `CurrentLevel[0][1]` (Set Cell 76) and
 * `Ingame.locals[1]` (Identity 42), swaps the ball and finally physicalizes
 * it. `New Ball` 2921 is the BallManager's own spawn entry.
 */
const TRAFO_NEAREST_NODE = 17
const TRAFO_ATTRIBUTE_NODE = 428
const SET_NEW_BALL_NODE = 169
/** `dephysic Ball`'s `Physicalize` node; input 1 is Unphysicalize. */
const UNPHYSICALIZE_BALL_NODE = 562
/**
 * `New Ball` 2921's staged path: the reset-cell read and the ball/camera
 * matrices (2538 -> local 10, 2742, 2506, 2728), the level-1 tutorial gate
 * (2863), the kept pre-lightning writes (2735, 2899, 2892), and the
 * physicalize compound (2721, which owns WakeUp 2620 and the tail links to
 * 2879, 2886, 2526, 2755, 2545 and 2748). The lightning nodes (2869, 2520)
 * and Delayer 2512 are the only skipped New Ball steps.
 */
const NEW_BALL_NODE = 2921
const NEW_BALL_RESET_CELL_NODE = 2538
const NEW_BALL_BALL_MATRIX_NODE = 2742
const NEW_BALL_RESTORE_CAMERA_NODE = 2506
const NEW_BALL_CAMERA_MATRIX_NODE = 2728
const NEW_BALL_TUTORIAL_NODE = 2863
const NEW_BALL_CAMNAV_NODE = 2735
const NEW_BALL_INGAME_LOCAL_NODE = 2899
const NEW_BALL_EVENTS_LOCAL_NODE = 2892
/** `physicalize new Ball`'s compound; its link 2701 delays WakeUp by one frame. */
const PHYSICALIZE_NEW_BALL_NODE = 2721
/** `BallManager`'s `Deactivate Ball`: the authored death path (it costs a life). */
const DEACTIVATE_BALL_NODE = 2499
/** `Trafo Manager` local 56 holds the trafo type `set new Ball` switches on. */
const TRAFO_TYPE_LOCAL = 56
/** `Gameplay_Events` locals[2] (`set Resetpoint` 5338 reads it; `Deactivate Ball` resets to it). */
const SECTOR_COUNTER_LOCAL = 1417
/** `activate Sektor`'s Op 5268 adds one to the sector counter. */
const SECTOR_COUNTER_ADD_NODE = 5268
/** `set Resetpoint` copies `ResetPoints[counter][0]` into `CurrentLevel[0][3]`. */
const SET_RESETPOINT_NODE = 5338
/** `activate next Checkpoint` activates `Checkpoints[counter - 1]`; link 5250 waits 2 frames. */
const NEXT_CHECKPOINT_NODE = 5258
/** The delayed half of 5258, run after the sector activation without stepping the session. */
const NEXT_CHECKPOINT_MATRIX_NODE = 5220
const NEXT_CHECKPOINT_SHOW_NODE = 5226
const NEXT_CHECKPOINT_RESUME_NODE = 5202
const NEXT_CHECKPOINT_SCRIPT_NODE = 5182
const NEXT_CHECKPOINT_ACTIVATE_NODE = 5143
/** Get Row 5190's object output, written by the first half of 5258. */
const NEXT_CHECKPOINT_OBJECT_OUTPUT = 5146
/** Frames the authored sector manager may take before `Activate Sector` 6525 runs (its link is 4). */
const SECTOR_ACTIVATION_LIMIT = 60
/** ORIGINAL_DIK_CODES: arrows 200/208/203/205. */
const UP_KEY = 200
const DOWN_KEY = 208
const LEFT_KEY = 203
const RIGHT_KEY = 205

/** Documents Levelinit may Object Load besides the menu, characters and balls. */
const MODULE_DOCUMENTS = [
  'P_Modul_03', 'P_Modul_08', 'P_Modul_17', 'P_Modul_18', 'P_Modul_19', 'P_Modul_25',
  'P_Modul_26', 'P_Modul_29', 'P_Modul_30', 'P_Modul_37', 'P_Modul_41', 'P_Trafo_Paper',
]

function prefetchDocuments(level: number): string[] {
  const base = ORIGINAL_SESSION_DOCUMENTS.filter(document => !/^Level_/i.test(document))
  return [...new Set([...base, `Level_${String(level + 1).padStart(2, '0')}`, ...MODULE_DOCUMENTS])]
}

const SILENT_AUDIO: GraphAudioBinding = {
  play() {},
  stop() {},
  gain() {},
  pitch() {},
  pan() {},
}

const EMPTY_SKY: GraphSkyBinding = {
  create() {},
  update() {},
  show() {},
  hide() {},
}

/**
 * The harness's second runtime: the authored graph session the browser host
 * runs under `?original=graph`, without a renderer, audio output or stereo.
 * It starts a level through the menu's Load Level path and exposes the
 * session's own state to the harness observer.
 */
export class GraphHarnessRuntime implements HarnessRuntime, GraphSessionView {
  readonly solver: 'ivp' | 'rapier'
  readonly notes: string[] = []
  context!: OriginalContext
  session!: OriginalSessionCreated['session']
  simulation!: OriginalContextPhysics | OriginalContextPhysicsRapier
  world?: IvpWorld
  rapierWorld?: RAPIER.World
  private readonly scenario: HarnessScenario
  private readonly input = new OriginalInputManager(() => 0)
  private observer?: GraphSessionObserver
  private binding?: GameplayBinding
  private install?: OriginalInstall
  private detail = false
  /** The scenario's frame duration and the runner's next tick (for input errors). */
  private frameSeconds = HARNESS_TICK_SECONDS
  private harnessTick = 0
  /** Keys queued through the input manager, so only edges produce device events. */
  private readonly heldKeys = new Set<number>()
  /** The level document's saved placements, used to match the engine's module instance names. */
  private placementTable: GraphSessionPlacement[] = []

  constructor(scenario: HarnessScenario, solver: 'ivp' | 'rapier' = 'ivp') {
    this.scenario = scenario
    this.solver = solver
  }

  get module(): HarnessModuleSelection | null { return this.scenario.module ?? null }

  get level(): number { return this.scenario.level }

  get capabilities() { return this.observer?.capabilities ?? GRAPH_CAPABILITIES[this.solver] }

  setDetail(detail: boolean) {
    this.detail = detail
    this.observer?.setDetail(detail)
  }

  diagnostics() { return this.observer?.diagnostics() ?? [] }

  sample(tick: number, input: HarnessInputState): HarnessTickRecord {
    return this.observer?.sample(tick, input) ?? emptyGraphRecord(tick, input, this.solver)
  }

  /** A body's raw backend state (IVP original units, Rapier render units). */
  state(body: unknown): number[] {
    return this.solver === 'rapier'
      ? this.rapierSimulation().state(body as RAPIER.RigidBody)
      : this.world!.state(body as number)
  }

  contacts(body: unknown, detail: boolean) {
    if (this.solver === 'rapier') return this.rapierSimulation().contacts(body as RAPIER.RigidBody, detail)
    const contacts = this.world!.contacts(body as number).map(contact => ({
      other: contact.other,
      normal: [contact.normal[0], contact.normal[1], -contact.normal[2]] as [number, number, number],
      point: null,
      separation: null,
      normalImpulse: contact.normalForce,
      tangentImpulse: null,
      feature1: null,
      feature2: null,
    }))
    return { count: contacts.length, contacts }
  }

  objectOf(body: unknown): OriginalObject | undefined {
    if (this.solver === 'rapier') return this.rapierSimulation().objectOf(body as RAPIER.RigidBody)
    for (const reference of this.simulation.references()) {
      if (this.simulation.body(reference) !== body) continue
      return this.context.get(Number(reference.slice(1)))
    }
    return undefined
  }

  bodyEnabled(body: unknown): boolean {
    if (this.solver === 'rapier') return (body as RAPIER.RigidBody).isEnabled()
    return body !== undefined
  }

  bodyCount(): number {
    return this.solver === 'rapier' ? this.rapierWorld?.bodies.len() ?? 0 : 0
  }

  colliderEnabled(body: unknown): boolean {
    if (this.solver === 'rapier') return this.rapierSimulation().colliderEnabled(body as RAPIER.RigidBody)
    return body !== undefined
  }


  private rapierSimulation(): OriginalContextPhysicsRapier {
    if (!(this.simulation instanceof OriginalContextPhysicsRapier)) throw new Error('The graph session has no Rapier simulation')
    return this.simulation
  }

  async prepare(scenario: HarnessScenario): Promise<HarnessPrepared> {
    this.frameSeconds = scenario.tickSeconds ?? HARNESS_TICK_SECONDS
    this.notes.push(`graph runtime: level ${scenario.level + 1} starts through the authored Menu_Start click and CurrentLevel[0][0]`)
    this.notes.push(`graph runtime: phase reads CurrentLevel[0][4] (paused when false), the Gameplay End Level message (won) and Game Over (lost); activeSector/checkpoint/lives read IngameParameter/Energy; contacts and the module mechanism fields are observed with the engine ${this.solver === 'rapier' ? 'Rapier' : 'IVP'} definitions`)
    this.notes.push("graph runtime: finish phase/parts/platform read the PE_Balloon copy's bodies and authored balloon/departure forces; transformation reads AnimTrafo_MF Script and the authored 1350+1000 ms explosion clock; respawn stage reads the authored Ball Off/Counter active sequence; fans read the P_Modul_18 force controller key")
    this.notes.push(`graph runtime: riding maps to the authored departing finish state (the ${this.solver === 'rapier' ? 'Rapier' : 'IVP'} engine never sets its riding flag); phase lost is decoded from the authored Game Over message only; ufoStage follows the authored PE_UFO_Pos&Time iterator and Hyperspace's 800 ms Bezier on the last level, and backendBodies is ${this.solver === 'rapier' ? 'the Rapier world body count' : 'unavailable (IVP)'}; a persistent force controller key names the behavior instance that installed it (its script owner plus the authored node), so activeFanNames reads the P_Modul_18 copy from the key`)
    this.notes.push('graph runtime: an inject start stages the ball through New Ball 2921\'s positioning nodes and its physicalize/wake tail without the lightning or the 3000 ms Delayer, so the ball is physical at its target at tick 0')
    const baseline = this.sample(-1, ZERO_INPUT)
    this.install = await loadOriginalInstall()
    let simulation: OriginalSessionSimulation | ((context: OriginalContext) => OriginalSessionSimulation)
    if (this.solver === 'rapier') {
      await (rapierReady ??= RAPIER.init())
      this.rapierWorld = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 })
      this.rapierWorld.timestep = PHYSICS_STEP
      this.notes.push(`graph runtime: Rapier world gravity ${GRAVITY}, timestep ${PHYSICS_STEP} (the engine's original Rapier path)`)
      simulation = (context: OriginalContext): OriginalSessionSimulation => {
        const created = new OriginalContextPhysicsRapier(context, this.rapierWorld!)
        this.simulation = created
        return created
      }
    } else {
      const { default: createIvp } = await import(/* @vite-ignore */ import.meta.env.VITE_IVP_MODULE_URL)
      this.world = new IvpWorld(await createIvp())
      simulation = (context: OriginalContext): OriginalSessionSimulation => {
        const created = new OriginalContextPhysics(context, this.world!)
        this.simulation = created
        return created
      }
    }
    const created = await createOriginalSession({
      install: this.install,
      system: this.systemBinding(this.install),
      movie: this.movieBinding(this.install),
      input: this.input,
      binding: context => this.createBinding(context),
      simulation,
      particles: new OriginalParticleRenderer(new Map(), 1),
      play: true,
      prefetch: prefetchDocuments(scenario.level),
    })
    this.context = created.context
    this.session = created.session
    this.context.render.viewport = { width: 1024, height: 768 }
    await this.loadPlacements()
    this.observer = new GraphSessionObserver(this)
    this.observer.setDetail(this.detail)
    const anchor = this.preload(scenario.level + 1)
    if (scenario.start.kind === 'spawn') {
      this.notes.push(`graph runtime: tick 0 is the first frame after the authored Ball_LightningSphere materialization began (preload tick ${anchor})`)
    } else {
      const start = scenario.start
      this.notes.push(`graph runtime: inject start runs the spawn to its materialization (preload tick ${anchor}), then the ball switch, New Ball's positioning and physicalize, and finally the authored sector activation`)
      this.selectMaterial(start.material)
      const ticks = this.stageAt(start.positionOriginal, start.rotation, start.yaw, true, scenario.level === 0)
      this.selectSector(start.sector)
      this.notes.push(`graph runtime: inject tick 0 is the frame the authored Gameplay_SectorManager runs Activate Sector 6525 (New Ball's positioning and physicalize ran as staging with ${ticks} stepped frames; its WakeUp 2620 delay-1 link runs on the next authored frame)`)
    }
    this.observer.reset()
    this.harnessTick = 1
    return { baseline, first: this.sample(0, ZERO_INPUT) }
  }

  array(name: string): GraphParameterValue[][] | undefined {
    return this.binding?.array(name)
  }

  placements(kind: string): readonly GraphSessionPlacement[] {
    return this.placementTable.filter(item => item.name.startsWith(kind + '_'))
  }

  /** The level document's placements in its saved object-table order (the engine's module order). */
  private async loadPlacements(): Promise<void> {
    const document = `Level_${String(this.scenario.level + 1).padStart(2, '0')}`
    const response = await fetch(`/original/objects/${document}.json`)
    if (!response.ok) throw new Error(`harness: the original session has no object table for ${document}`)
    const table = await response.json() as OriginalObjectTable
    this.placementTable = table.objects
      .filter(object => typeof object.name === 'string' && Array.isArray(object.matrix))
      .map(object => ({ name: object.name, matrix: object.matrix! }))
  }

  activeBall(): OriginalObject | undefined {
    const value = this.binding?.array('CurrentLevel')?.[0]?.[1]
    return typeof value === 'string' ? this.ballObject(value) : undefined
  }

  scriptActive(document: string, name: string): boolean {
    return this.session?.runtime(document)?.isScriptActive(name) ?? false
  }

  anyScriptActive(name: string): boolean {
    return this.session?.scripts.has(name) === true && this.session.scripts.isActive(name)
  }

  suspend() {}

  /**
   * `Ball Navigation` reads the arrows through `Key Event` and applies each
   * held key as a force in the `Cam_OrientRef` frame (up +Z, down -Z, left -X,
   * right +X of the camera). The harness input is an analog steering vector in
   * those same camera axes, so each component maps to one authored key.
   */
  setInput(input: HarnessInputState) {
    for (const [axis, value] of [['forward', input.forward], ['lateral', input.lateral]] as const) {
      if (!Number.isFinite(value)) throw new Error(`harness: ${this.scenario.id} tick ${this.harnessTick} emits ${axis} ${value}`)
    }
    // As the engine's IVP path (original-engine.ts, the `held` set): any non-zero
    // component holds that axis's key; the authored force has no magnitude.
    if (input.brake) throw new Error(`harness: ${this.scenario.id} tick ${this.harnessTick} emits brake, but the authored keyboard has no brake key`)
    const desired = new Set<number>()
    if (input.forward > 0) desired.add(UP_KEY)
    if (input.forward < 0) desired.add(DOWN_KEY)
    if (input.lateral < 0) desired.add(LEFT_KEY)
    if (input.lateral > 0) desired.add(RIGHT_KEY)
    const time = Math.trunc(this.harnessTick * this.frameSeconds * 1000)
    for (const key of this.heldKeys) if (!desired.has(key)) { this.input.key(key, false, time); this.heldKeys.delete(key) }
    for (const key of desired) if (!this.heldKeys.has(key)) { this.input.key(key, true, time); this.heldKeys.add(key) }
  }

  step(dt: number) {
    this.frameSeconds = dt
    this.session.step(dt * 1000)
    this.harnessTick++
  }

  stagePlayer(start: Extract<HarnessStart, { kind: 'inject' }>, position: [number, number, number]): void {
    // The engine adapter passes render-space positions; the authored cells are
    // in original units (x, y, -z) * 4.
    const original: [number, number, number] = [position[0] * 4, position[1] * 4, -position[2] * 4]
    this.selectMaterial(start.material)
    this.stageAt(original, start.rotation, start.yaw)
    if (this.solver === 'rapier' && (start.linearVelocity || start.angularVelocity)) {
      const ball = this.activeBall()
      const body = ball ? this.simulation.body(originalObjectReference(ball.id)) : undefined
      if (!body) throw new Error('harness: the staged Rapier ball has no body for velocity injection')
      const rigid = body as RAPIER.RigidBody
      if (start.linearVelocity) rigid.setLinvel({ x: start.linearVelocity[0], y: start.linearVelocity[1], z: start.linearVelocity[2] }, true)
      if (start.angularVelocity) rigid.setAngvel({ x: start.angularVelocity[0], y: start.angularVelocity[1], z: start.angularVelocity[2] }, true)
    }
  }

  /**
   * A mid-run restage runs the same instant New Ball path as an inject start
   * (without a sector change): unphysicalize, switch the material, write the
   * reset point, then position the ball/camera and run the authored
   * physicalize/wake tail. The scenarios were written for one-frame staging;
   * the tail needs one authored WakeUp frame here.
   */
  stagePlayerInPlace(action: HarnessStageAction): void {
    const gameplay = this.gameplayRuntime()
    gameplay.runIsolated(UNPHYSICALIZE_BALL_NODE, 1)
    this.selectMaterial(action.material)
    const ticks = this.stageAt(action.positionOriginal, undefined, 0)
    this.notes.push(`stage action: New Ball's staged path physicalized in ${ticks} authored frames inside the tick; its WakeUp 2620 delay-1 link runs on the next authored frame (the scenarios were written for one-frame staging)`)
  }

  /** A scenario respawn is a death respawn; run the authored Deactivate Ball here. */
  respawn(): void {
    this.gameplayRuntime().activateNow(DEACTIVATE_BALL_NODE)
    this.notes.push('reset action: authored Deactivate Ball 2499 (a death respawn; it costs a life)')
  }

  destroy() {
    this.world?.dispose()
    this.rapierWorld?.free()
  }

  /**
   * Step the menu into the level, set the cell its button writes, and stop when
   * the authored spawn begins. The cursor starts hidden (Default Level shows it
   * off); `Cursor On/Off` needs two distinct mouse positions after Mouse On to
   * run its second Move output, which shows it, so each click is preceded by a
   * two-pixel approach move.
   */
  private preload(level: number): number {
    for (let tick = 1; tick <= PRELOAD_LIMIT; tick++) {
      if (tick === MENU_LIST_TICK - 2) this.input.move(496, 140)
      if (tick === MENU_LIST_TICK - 1) this.input.move(512, 150)
      if (tick === MENU_LIST_TICK) this.input.button(0, true)
      if (tick === MENU_LIST_TICK + 2) this.input.button(0, false)
      if (tick === LEVEL_BUTTON_TICK - 2) this.input.move(496, 80)
      if (tick === LEVEL_BUTTON_TICK - 1) this.input.move(512, 88)
      if (tick === LEVEL_BUTTON_TICK) this.input.button(0, true)
      if (tick === LEVEL_BUTTON_TICK + 2) this.input.button(0, false)
      if (tick === CURRENT_LEVEL_TICK) this.setCurrentLevel(level)
      this.session.step(HARNESS_TICK_SECONDS * 1000)
      this.observer?.observeBodies()
      if (!this.scriptActive('Balls', 'Ball_LightningSphere')) continue
      const selected = Number(this.binding?.array('CurrentLevel')?.[0]?.[0])
      if (selected !== level) throw new Error(`harness: the graph session loaded CurrentLevel ${String(selected)} instead of ${level}`)
      return tick
    }
    throw new Error(`harness: the graph session did not reach the authored spawn within ${PRELOAD_LIMIT} ticks`)
  }

  private setCurrentLevel(level: number) {
    const rows = this.binding?.array('CurrentLevel')
    if (!rows?.[0]) throw new Error('harness: the graph session has no CurrentLevel array to select the level')
    rows[0][0] = level
  }

  private gameplayRuntime(): OriginalGraphRuntime {
    const runtime = this.session.runtime('Gameplay')
    if (!runtime) throw new Error('harness: the graph session has no Gameplay runtime for the authored start')
    return runtime
  }

  /** One authored script frame, outside the harness tick counter. */
  private stepSession(count = 1) {
    for (let i = 0; i < count; i++) {
      this.session.step(this.frameSeconds * 1000)
      this.observer?.observeBodies()
    }
  }

  /**
   * The authored sector switch (`Checkpoint reached` path). `set Resetpoint`
   * 5338 copies `ResetPoints[counter][0]` into `CurrentLevel[0][3]` while the
   * counter still names the old sector, then `activate Sektor` 5306 writes
   * `IngameParameter[0][2]` = old (Set Cell 5287), adds one to the counter
   * (`Gameplay_Events.locals[2]`, Op 5268), writes `[0][1]` = new (Set Cell
   * 5298) and runs `Execute Script` 5276 on `Gameplay_SectorManager`. Two
   * frames later `activate next Checkpoint` 5258 reads the counter, positions,
   * shows and activates `Checkpoints[counter - 1]`, toggling
   * `CurrentLevel[0][4]` around its 2-frame link 5250.
   *
   * The counter and `set Resetpoint` writes are authored before the sector
   * manager. 5258 cannot run before it: 5258's activated checkpoint starts
   * polling at once, and the staged ball can already be inside that
   * checkpoint, so the authored "Checkpoint reached" path (`set Resetpoint`
   * 5338 -> `activate Sektor` 5306) would advance the sector during the
   * manager's settle. The harness therefore finishes 5258 after the activation
   * frame, executing its delayed half directly instead of stepping the session
   * (which would move the new sector's modules past tick 0).
   *
   * The preload stops on the spawn sphere, with `Gameplay_Events`' level-start
   * root still queued; its first frame writes the authored counter (1) and
   * Checkpoints[0], so it runs first as staging.
   */
  private selectSector(sector: number) {
    const rows = this.array('IngameParameter')
    if (!rows?.[0]) throw new Error('harness: the graph session has no IngameParameter array to select the sector')
    const gameplay = this.gameplayRuntime()
    this.stepSession(1)
    let counter = Number(gameplay.value(SECTOR_COUNTER_LOCAL))
    if (!Number.isInteger(counter) || counter < 1) throw new Error(`harness: Gameplay_Events locals[2] is ${String(counter)}, not a sector counter`)
    if (counter > sector) throw new Error(`harness: the graph session is already in sector ${counter}, cannot reach sector ${sector} without the authored decrement`)
    // Sector 1 is the level-start state: Init CurrentLevel already copied
    // ResetPoints[0] and `set first Checkpoint` activated Checkpoints[0].
    if (sector > 1) {
      while (counter < sector - 1) {
        gameplay.runIsolated(SECTOR_COUNTER_ADD_NODE)
        counter = Number(gameplay.value(SECTOR_COUNTER_LOCAL))
      }
      gameplay.runIsolated(SET_RESETPOINT_NODE)
    }
    while (counter < sector) {
      gameplay.runIsolated(SECTOR_COUNTER_ADD_NODE)
      counter = Number(gameplay.value(SECTOR_COUNTER_LOCAL))
    }
    // `activate Sektor`'s Set Cells 5287/5298: old sector in column 2, new in
    // column 1; the sector manager's Get Cell 6003 reads column 1.
    rows[0][2] = sector - 1
    rows[0][1] = sector
    // `Gameplay_SectorManager`: Set Cell 5979 pauses at once, Deactivate
    // Sector runs, and four frames later Set Cell 6193 resumes and Activate
    // Sector 6525 launches the new sector's module copies. That frame is the
    // engine's tick 0, the first after the sector's modules are recreated.
    const currentLevel = this.array('CurrentLevel')
    if (!currentLevel?.[0]) throw new Error('harness: the graph session has no CurrentLevel array to read the sector activation')
    this.session.activateScript('Gameplay_SectorManager')
    if (currentLevel[0][4] !== false) throw new Error(`harness: Gameplay_SectorManager did not pause the level before deactivating the old sector (CurrentLevel[0][4]=${String(currentLevel[0][4])}, counter=${String(gameplay.value(SECTOR_COUNTER_LOCAL))})`)
    const frames = this.stepUntilSectorActivation(currentLevel)
    if (Number(rows[0][1]) !== sector) throw new Error(`harness: Gameplay_SectorManager selected sector ${String(rows[0][1])} instead of ${sector}`)
    if (sector > 1) this.finishNextCheckpoint(gameplay)
    const resetRow = this.array('ResetPoints')?.[sector - 1]?.[0]
    const resetCell = this.array('CurrentLevel')?.[0]?.[3]
    if (!Array.isArray(resetRow) || !Array.isArray(resetCell)
      || resetRow.length < 16 || resetCell.length < 16
      || resetRow.some((value, index) => value !== resetCell[index])) {
      throw new Error(`harness: sector ${sector} did not leave ResetPoints[${sector - 1}][0] in CurrentLevel[0][3]`)
    }
    this.notes.push(`inject start: Gameplay_Events locals[2]=${counter}, IngameParameter[0][2]=${sector - 1}, [0][1]=${sector}, set Resetpoint and next Checkpoint before Gameplay_SectorManager`)
    if (sector > 1) {
      this.notes.push(`inject start: set Resetpoint 5338 (ResetPoints[${sector - 1}][0]) and, after the sector activation, activate next Checkpoint 5258 (Checkpoints[${sector - 1}]) with its delayed half run directly`)
    } else {
      this.notes.push('inject start: sector 1 keeps the level-start ResetPoints[0] and Checkpoints[0] state')
    }
    this.notes.push(`inject start: Gameplay_SectorManager activated sector ${sector} on the ${frames}. authored frame after its pause; tick 0 is that frame`)
  }

  /**
   * Step the sector manager until `Activate Sector` 6525 runs. Set Cell 6193
   * writes `CurrentLevel[0][4] = true` in the same frame, right before 6525,
   * and the manager paused the cell synchronously; the false-to-true edge is
   * the authored activation event, not a frame count.
   */
  private stepUntilSectorActivation(rows: GraphParameterValue[][]): number {
    for (let frame = 1; frame <= SECTOR_ACTIVATION_LIMIT; frame++) {
      this.stepSession(1)
      if (rows[0]?.[4] === true) return frame
    }
    throw new Error(`harness: Gameplay_SectorManager did not activate the new sector within ${SECTOR_ACTIVATION_LIMIT} frames`)
  }

  /**
   * `activate next Checkpoint` 5258 after the activation frame. Its first half
   * (Op 5235, Get Row 5190, Set Cell 5166 false, Get Script 5154, Activate
   * Script 5173) runs as authored; link 5250's two frames are skipped and its
   * destination (Set World Matrix 5220, Show 5226, Set Cell 5202 true, Get
   * Script 5182, Activate Script 5143) runs directly. The compound is then
   * reset so its pending delay cannot fire during the first harness tick. The
   * checkpoint script activation request still takes effect next frame.
   */
  private finishNextCheckpoint(gameplay: OriginalGraphRuntime): void {
    gameplay.runIsolated(NEXT_CHECKPOINT_NODE)
    if (typeof gameplay.value(NEXT_CHECKPOINT_OBJECT_OUTPUT) !== 'string') {
      gameplay.resetNode(NEXT_CHECKPOINT_NODE)
      throw new Error('harness: activate next Checkpoint found no Checkpoints row for the new sector')
    }
    for (const node of [
      NEXT_CHECKPOINT_MATRIX_NODE,
      NEXT_CHECKPOINT_SHOW_NODE,
      NEXT_CHECKPOINT_RESUME_NODE,
      NEXT_CHECKPOINT_SCRIPT_NODE,
      NEXT_CHECKPOINT_ACTIVATE_NODE,
    ]) gameplay.runIsolated(node)
    gameplay.resetNode(NEXT_CHECKPOINT_NODE)
  }

  /**
   * The authored ball switch without a transformer animation: put the active
   * ball on a `P_Trafo_<material>` carrier so `Get Nearest In Group` 17 finds
   * it, run `Has Attribute` 428 to copy its `TrafoType` into Trafo Manager
   * local 56, then run `set new Ball` 169. That compound writes
   * `CurrentLevel[0][1]` (Set Cell 76) and `Ingame.locals[1]` (Identity 42),
   * swaps the active ball and activates Gameplay_Refresh.
   */
  private selectMaterial(material: Material) {
    const carrier = this.context.attributeCarriers('TrafoType')
      .find(object => /^P_Trafo_/i.test(object.name) && object.attributes.get('TrafoType') === material)
    if (!carrier) throw new Error(`harness: level ${this.scenario.level + 1} has no P_Trafo_ carrier for ${material}`)
    const gameplay = this.gameplayRuntime()
    const ball = this.activeBall()
    if (!ball) throw new Error(`harness: the graph session has no active ball for the ${material} switch`)
    const target = this.context.worldMatrix(carrier.id)
    const matrix = this.context.worldMatrix(ball.id)?.slice()
    if (!target || !matrix) throw new Error(`harness: the ${material} carrier or the active ball has no world matrix`)
    matrix[12] = target[12]!
    matrix[13] = target[13]!
    matrix[14] = target[14]!
    this.context.entities.setWorldMatrix(originalObjectReference(ball.id), matrix, false)
    gameplay.runIsolated(TRAFO_NEAREST_NODE, 0)
    gameplay.runIsolated(TRAFO_ATTRIBUTE_NODE, 0)
    const written = gameplay.value(TRAFO_TYPE_LOCAL)
    if (written !== material) throw new Error(`harness: the authored ball switch read TrafoType ${String(written)} instead of ${material}`)
    gameplay.activateNow(SET_NEW_BALL_NODE)
    // Set Cell 76 (CurrentLevel[0][1]), Identity 42, the attributes, matrices
    // and Set Parent all run synchronously; link 164's two frames delay only
    // this compound's Out -> `physicalize new Ball` 341. One frame lets the
    // switch's queued Activate Script 141 take effect; then cancel the pending
    // physicalize rather than stepping the whole session (and every active
    // module) through the rest of its delay.
    this.stepSession(1)
    gameplay.resetNode(SET_NEW_BALL_NODE)
    const switched = this.activeBall()
    if (!switched || !new RegExp(`^Ball_${material}$`, 'i').test(switched.name)) {
      throw new Error(`harness: the authored ball switch selected ${switched?.name ?? '(none)'} instead of Ball_${material}`)
    }
    // The switch wrote the active ball but did not position it; New Ball below
    // positions the reset point and physicalizes it from there.
    gameplay.runIsolated(UNPHYSICALIZE_BALL_NODE, 1)
    this.notes.push(`inject start: material ${material} through Trafo Manager (P_Trafo carrier ${carrier.name}, Get Nearest 17, Has Attribute 428, set new Ball 169)`)
  }

  /**
   * `CurrentLevel[0][3]` is the authored reset point `New Ball` reads. `yaw` is
   * the scenario's camera heading; the graph's steering frame is
   * `Cam_MF`'s reset rotation times `Cam_OrientRef`'s authored 90-degree local
   * rotation, so the cell uses `angle = pi/2 - yaw` about Y.
   */
  private writeResetPoint(position: [number, number, number], rotation?: [number, number, number, number], yaw?: number) {
    const rows = this.array('CurrentLevel')
    if (!rows?.[0]) throw new Error('harness: the graph session has no CurrentLevel array to write the reset point')
    const quaternion = rotation
      ? new THREE.Quaternion(-rotation[0], -rotation[1], rotation[2], rotation[3]).normalize()
      : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 - (yaw ?? Math.PI / 2))
    rows[0][3] = new THREE.Matrix4()
      .compose(new THREE.Vector3(position[0], position[1], position[2]), quaternion, new THREE.Vector3(1, 1, 1))
      .toArray()
  }

  /**
   * Stage the ball at a synthetic pose without losing the authored reset
   * point: `CurrentLevel[0][3]` is the cell New Ball positions from, so the
   * sector's value (`ResetPoints[sector - 1][0]`, or row 0 at level start) is
   * saved, replaced by the scenario pose for the positioning nodes, and
   * restored afterwards. A later Deactivate Ball/New Ball respawn therefore
   * uses the authored sector reset, while tick 0 still sees the injected pose.
   */
  private stageAt(
    position: [number, number, number],
    rotation?: [number, number, number, number],
    yaw?: number,
    physicalize = true,
    skipTutorial = false,
  ): number {
    const rows = this.array('CurrentLevel')
    if (!rows?.[0]) throw new Error('harness: the graph session has no CurrentLevel array to stage the ball')
    const authored = rows[0][3]
    this.writeResetPoint(position, rotation, yaw)
    this.positionBall()
    let ticks = 0
    if (physicalize) {
      this.prepareBall(skipTutorial)
      ticks = this.physicalizeBall()
    }
    rows[0][3] = authored ?? rows[0][3]!
    return ticks
  }

  /**
   * `New Ball` 2921's positioning: read the reset point into local 10 (Get Cell
   * 2538), set the ball and `Cam_MF`/child matrices (2742, 2506, 2728) and stop
   * before the tutorial gate, the pre-Delayer writes and `physicalize new Ball`
   * 2721. An inject start runs this before the sector activation, so every
   * module's first sample already sees the ball at its target. The material
   * switch swapped the ball at the trafo carrier, so the ball matrix is
   * verified at the reset point before the sector settle.
   */
  private positionBall(): void {
    const gameplay = this.gameplayRuntime()
    // The preload's own New Ball is still in its 3000 ms Delayer; cancel it so
    // its tail (WakeUp, Counter active, Out -> the death-volume Group Iterator)
    // does not run a second time on the staged ball.
    gameplay.resetNode(NEW_BALL_NODE)
    gameplay.runIsolated(NEW_BALL_RESET_CELL_NODE)
    gameplay.runIsolated(NEW_BALL_BALL_MATRIX_NODE)
    gameplay.runIsolated(NEW_BALL_RESTORE_CAMERA_NODE)
    gameplay.runIsolated(NEW_BALL_CAMERA_MATRIX_NODE)
    this.verifyBallAtResetPoint()
  }

  /**
   * `New Ball` 2921's steps between the matrices and the physicalize: the
   * level-1 tutorial gate (2863; the other levels fall through its tests) and
   * the non-lightning pre-Delayer writes (CamNav 2735, Ingame.locals[30] 2899,
   * Gameplay_Events.locals[8] 2892). An inject start runs them before the
   * sector activation, so its level-1 gate is skipped like the post-sector
   * counter would make it fall through to Nop 2832.
   */
  private prepareBall(injectStart = false): void {
    const gameplay = this.gameplayRuntime()
    const level = this.scenario.level + 1
    const sector = Number(this.array('IngameParameter')?.[0]?.[1])
    if ((injectStart && level === 1) || (level === 1 && sector === 1)) {
      this.notes.push("stageBall: skipped New Ball's 2863 level-1 tutorial gate (level 1, Tutorial? on)")
    } else {
      gameplay.runIsolated(NEW_BALL_TUTORIAL_NODE)
    }
    gameplay.runIsolated(NEW_BALL_CAMNAV_NODE)
    gameplay.runIsolated(NEW_BALL_INGAME_LOCAL_NODE)
    gameplay.runIsolated(NEW_BALL_EVENTS_LOCAL_NODE)
  }

  /**
   * `physicalize new Ball` 2721. Its internal link 2701 delays WakeUp 2620 by
   * one authored frame; that frame also runs the kept tail in authored order
   * (Ball_Shadow 2879/2886, locals[8] false via 2526, Counter active 2755,
   * BallNav 2545/2748). The delay belongs to the next authored frame, so this
   * steps none and returns 0.
   */
  private physicalizeBall(): number {
    this.gameplayRuntime().activateNow(PHYSICALIZE_NEW_BALL_NODE)
    const ball = this.activeBall()
    if (!ball || this.simulation.body(originalObjectReference(ball.id)) === undefined) {
      throw new Error('harness: New Ball 2721 did not physicalize the active ball at the reset point')
    }
    return 0
  }

  /** The material switch moved the ball to its trafo carrier; New Ball 2742 must put it back at the reset point. */
  private verifyBallAtResetPoint(): void {
    const ball = this.activeBall()
    const cell = this.array('CurrentLevel')?.[0]?.[3]
    const matrix = ball ? this.context.worldMatrix(ball.id) : undefined
    if (!ball || !Array.isArray(cell) || cell.length < 16 || !matrix) {
      throw new Error('harness: the staged ball, its world matrix or the reset point is missing')
    }
    for (let index = 12; index < 15; index++) {
      const value = cell[index]
      if (typeof value !== 'number' || Math.abs(matrix[index]! - value) > 1e-3) {
        throw new Error(`harness: New Ball 2742 left the active ball at ${matrix.slice(12, 15).join(',')} instead of the reset point ${cell.slice(12, 15).join(',')}`)
      }
    }
  }

  /** The active-ball cell is a context reference after Levelinit; a bare name may match copies in several documents. */
  private ballObject(value: string): OriginalObject | undefined {
    if (/^#\d+$/.test(value)) {
      const object = this.context.get(Number(value.slice(1)))
      return object && this.context.isEntity(object.id) ? object : undefined
    }
    const candidates = this.context.byName(value).filter(object => this.context.isEntity(object.id))
    const level = candidates.find(object => object.document?.toLowerCase() === `level_${String(this.scenario.level + 1).padStart(2, '0')}`)
    return level ?? candidates[0]
  }

  private createBinding(context: OriginalContext): GameplayBinding {
    const binding = new GameplayBinding({
      level: this.scenario.level + 1,
      object: () => undefined,
      light: {
        setColor: (name, color) => {
          const light = context.resolve(name)
          if (!light?.light) throw new Error(`Set Light Color on ${name}, which is not a context light`)
          light.light.color = [color[0], color[1], color[2], color[3]]
        },
      },
      scrollTexture: () => {},
      sky: EMPTY_SKY,
      activeBall: () => this.bindingName(),
      audio: SILENT_AUDIO,
    }, { tutorial: false, invertRotation: false })
    this.binding = binding
    return binding
  }

  /** The Gameplay binding's active-ball name, after the first binding exists. */
  private bindingName(): string {
    const value = this.binding?.array('CurrentLevel')?.[0]?.[1]
    if (typeof value !== 'string' || !value) return 'Ball_Wood'
    return this.ballObject(value)?.name ?? value
  }

  private movieBinding(install: OriginalInstall): GraphMovieBinding {
    // The host's AVI reader supplies the authored movie timing; headless, no frame is decoded.
    return {
      open: (_texture, file) => {
        const bytes = install.readFile(file)
        if (!bytes) return undefined
        const { info } = OriginalAvi.parse(bytes)
        return { frames: info.frames, width: info.width, height: info.height, framePeriodMs: info.framePeriodMs }
      },
      showFrame: () => true,
      close: () => {},
    }
  }

  private systemBinding(install: OriginalInstall): GraphSystemBinding {
    const input = this.input
    let installed = { driver: 0, mode: 0 }
    const written = new Map<string, Uint8Array>()
    const key = (path: string) => path.split('\\').join('/').replace(/^\.\.\//, '')
    return {
      input,
      playerActive: () => true,
      registryDword: (section, name) => {
        const value = /ballance\.settings/i.test(section) ? install.registry(name) : undefined
        return typeof value === 'number' ? value : undefined
      },
      registryString: (section, name) => {
        const value = /ballance\.settings/i.test(section) ? install.registry(name) : undefined
        return typeof value === 'string' ? value : undefined
      },
      environment: () => undefined,
      currentDirectory: () => 'C:/games/ballance/Bin',
      osVersion: () => ({ platformId: 2, major: 5, minor: 1 }),
      memoryStatus: () => ({ loadPercent: 30, totalPhysical: 512 * 2 ** 20, availablePhysical: 256 * 2 ** 20, totalVirtual: 2047 * 2 ** 20, availableVirtual: 1900 * 2 ** 20 }),
      displayDrivers: () => [{
        description: 'Direct3D HAL', name: 'Direct3D HAL', ready: true,
        modes: [{ width: 640, height: 480, bpp: 16, refresh: 60 }, { width: 800, height: 600, bpp: 16, refresh: 60 }, { width: 1024, height: 768, bpp: 32, refresh: 60 }],
        videoMemoryBytes: 64 * 2 ** 20,
      }],
      get installed() { return installed },
      changeScreenMode: (driver, mode) => { installed = { driver, mode }; return true },
      exit: () => { throw new Error('TT Exit to System') },
      showCursor: show => input.showCursor(show),
      mouse: () => {
        const [x, y] = input.mousePosition()
        return { x, y, wheel: 0, left: input.mouseButtonDown(0), right: input.mouseButtonDown(1), middle: input.mouseButtonDown(2) }
      },
      debug: false,
      console() {},
      enableProfiling() {},
      profileStats: () => ({ frameMs: 15, times: [], behavior: [], render: [] }),
      textures: () => [],
      physicsProfileCount: () => 0,
      readFile: path => written.get(key(path)) ?? install.readFile(path),
      writeFile: (path, bytes) => { written.set(key(path), bytes); return true },
      paths: () => [],
      renamePath() {},
    }
  }
}
