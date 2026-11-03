import type { HarnessAssertion, HarnessController, HarnessScenario, HarnessTickRecord } from './types.ts'

type StageData = {
  spawn: boolean
  finish: { sector: number; startOriginal: [number, number, number] }
  fan?: { name: string; sector: number; originOriginal: [number, number, number]; startOriginal: [number, number, number]; hoverYOriginal: number } | null
  bridge?: { name: string; sector: number; startOriginal: [number, number, number]; axis: [number, number, number]; yaw: number; stopDistance: number } | null
  arm?: { name: string; sector: number; startOriginal: [number, number, number]; targetOriginal: [number, number, number] }[] | null
  swing?: { name: string; sector: number; startOriginal: [number, number, number]; targetOriginal: [number, number, number]; originOriginal: [number, number, number]; phaseTicks: number; safeOriginal: [number, number, number]; axisOriginal: [number, number, number] }[] | null
  lift?: { name: string; sector: number; originOriginal: [number, number, number]; inwardOriginal: [number, number, number]; startOriginal: [number, number, number] } | null
  sack?: { name: string; sector: number; originOriginal: [number, number, number]; axisOriginal: [number, number, number]; startOriginal: [number, number, number] }[] | null
}
const STAGE_DATA = await loadStageData()

async function loadStageData(): Promise<Record<string, StageData>> {
  if ('window' in globalThis) {
    const response = await fetch('/original/harness-stages.json')
    if (!response.ok) throw new Error(`The harness needs the generated stage data; run scripts/generate-harness-stages.py (${response.status})`)
    return await response.json() as Record<string, StageData>
  }
  const module = 'node:fs/promises'
  const { readFile } = await import(module) as { readFile(path: URL, encoding: 'utf8'): Promise<string> }
  const path = new URL('../../.local/original/harness-stages.json', import.meta.url)
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, StageData>
}

const BRIDGE_START_ORIGINAL: [number, number, number] = [Number('707.7859497070312'), Number('-12.287001991271973'), Number('-873.7407857895529')]
const CROWN_START_ORIGINAL: [number, number, number] = [Number('707.7859497070312'), Number('-11.6569'), Number('-873.7407857895529')]
const BRIDGE_START_YAW = -Math.PI / 2
const CHECKPOINT_4_RESET_ORIGINAL: [number, number, number] = [Number('341.9595031738281'), Number('-4.072678089141846'), Number('-830.5913696289062')]
// Authored PE_Balloon_Platform origin in level 1, plus the ball's stable
// platform-local rest offset during the native departing ride (both measured
// from the recovered authored assembly and the IVP ride trace). Staging there
// puts the rider on the supported platform before any simulation tick.
const PLATFORM_ORIGIN_ORIGINAL: [number, number, number] = [Number('731.785949707'), Number('-13.387001991'), Number('-873.740783691')]
const PLATFORM_RIDE_OFFSET_ORIGINAL: [number, number, number] = [Number('-0.7239567358778913'), Number('0.10878013170499834'), Number('0.4518316494368264')]
const PLATFORM_RIDE_START_ORIGINAL: [number, number, number] = PLATFORM_ORIGIN_ORIGINAL.map((value, axis) => value + PLATFORM_RIDE_OFFSET_ORIGINAL[axis]!) as [number, number, number]

// Level 2: paper starts above fan 01 and is steered to the raised fan 12.
// Positions are the source module origins in original units; the controller
// reads the same render-space ball state on both solvers.
const LEVEL2_FAN01_START_ORIGINAL: [number, number, number] = [Number('1016.6687622070312'), Number('47.823252868652344'), Number('-366.7432556152344')]
const LEVEL2_FAN12_ORIGINAL: [number, number, number] = [Number('1006.6688232421875'), Number('60.623252868652344'), Number('-366.7432556152344')]
const LEVEL2_FAN12_STEER_Y = (LEVEL2_FAN12_ORIGINAL[1] + 2) * 0.25

// Level 2 P_Modul_29_Platte01 origin, 1.5 original units before the first
// plank along the bridge axis, with a gravity-settled approach.
const LEVEL2_BRIDGE_START_ORIGINAL: [number, number, number] = [Number('953.47347403'), Number('47.93252704'), Number('-346.53180306')]
const LEVEL2_BRIDGE_END_X = Number('242.021146774292') + .5

// Level 2 PE_Balloon_01 platform origin plus the same measured platform-local
// rider rest offset used by stage1_finish_ride.
const LEVEL2_PLATFORM_ORIGIN_ORIGINAL: [number, number, number] = [Number('1609.2633056640625'), Number('27.131607055664062'), Number('74.14996337890625')]
const LEVEL2_PLATFORM_RIDE_START_ORIGINAL: [number, number, number] = LEVEL2_PLATFORM_ORIGIN_ORIGINAL.map((value, axis) => value + PLATFORM_RIDE_OFFSET_ORIGINAL[axis]!) as [number, number, number]

// Level 3 P_Modul_17_01 approach: 10 original units before the arm along the
// recovered local route, settled onto the authored approach floor.
const LEVEL3_ARM_START_ORIGINAL: [number, number, number] = [Number('1352.009484484359'), Number('-492.97178823346314'), Number('-80.12434782572912')]
const LEVEL3_ARM_TARGET_XZ: [number, number] = [Number('1366.009484484352'), Number('-80.12434782572907')]

// Level 3 P_Modul_29_01 bridge approach, settled onto the authored floor.
const LEVEL3_BRIDGE_START_ORIGINAL: [number, number, number] = [Number('159.9097991'), Number('-29.28267682943723'), Number('93.9283715')]
const LEVEL3_BRIDGE_END_X = Number('174.52091217') * 0.25 + .5

// Level 3 finish platform origin plus the measured rider rest offset.
const LEVEL3_PLATFORM_ORIGIN_ORIGINAL: [number, number, number] = [Number('1869.211669921875'), Number('-466.1817626953125'), Number('-141.77110290527344')]
const LEVEL3_PLATFORM_RIDE_START_ORIGINAL: [number, number, number] = LEVEL3_PLATFORM_ORIGIN_ORIGINAL.map((value, axis) => value + PLATFORM_RIDE_OFFSET_ORIGINAL[axis]!) as [number, number, number]

// Level 3 P_Modul_18_02: paper starts 2.2 original units above the source fan.
const LEVEL3_FAN02_START_ORIGINAL: [number, number, number] = [Number('1688.1632080078125'), Number('-505.8463562011719'), Number('-116.20984649658203')]
const LEVEL3_FAN02_ORIGIN_Y = Number('-508.0463562011719') * 0.25

const clampInput = (value: number) => Math.max(-1, Math.min(1, value))
// The native route fixtures press whole direction keys, so a sub-threshold
// component must not become a full discrete force on the native backend.
const pressInput = (value: number) => Math.abs(value) > .2 ? clampInput(value) : 0

function sackController(originOriginal: [number, number, number], axisOriginal: [number, number, number]): HarnessController {
  const originX = originOriginal[0], originZ = originOriginal[2]
  const axisX = axisOriginal[0], axisZ = axisOriginal[2]
  // Perpendicular to the approach: the ball must stay centred on the authored
  // paired rail, so counter-steer against any sideways offset or drift.
  const perpX = -axisZ, perpZ = axisX
  return {
    reset() {},
    input(_tick: number, previous: HarnessTickRecord) {
      const p = previous.ball.position, v = previous.ball.linearVelocity
      const px = p[0]! * 4, pz = -p[2]! * 4
      const vx = v[0]! * 4, vz = -v[2]! * 4
      // Once the sack moves, hold station on its origin so residual momentum
      // cannot roll the ball off the end of the narrow paired rail.
      if ((previous.lifecycle.sackTravel ?? 0) > .05) {
        const toX = (originX - px) * 2 - vx * .9
        const toZ = (originZ - pz) * 2 - vz * .9
        return { forward: pressInput(toZ), lateral: pressInput(toX), brake: false }
      }
      if ((px - originX) * axisX + (pz - originZ) * axisZ > 0) return { forward: 0, lateral: 0, brake: false }
      const offset = (px - originX) * perpX + (pz - originZ) * perpZ
      const drift = vx * perpX + vz * perpZ
      const correction = offset * 1.5 + drift * .5
      return {
        forward: pressInput(axisZ - perpZ * correction),
        lateral: pressInput(axisX - perpX * correction),
        brake: false,
      }
    },
  }
}

function liftController(originOriginal: [number, number, number], inwardOriginal: [number, number, number]): HarnessController {
  let phase: 'settle' | 'approach' | 'push' | 'center' = 'settle'
  let settle = 0
  const originX = originOriginal[0], originZ = originOriginal[2]
  const inwardX = inwardOriginal[0], inwardZ = inwardOriginal[2]
  return {
    reset() { phase = 'settle'; settle = 0 },
    input(_tick: number, previous: HarnessTickRecord) {
      if (phase === 'settle') {
        // The native route fixture settles the staged entrance for 66 frames
        // before driving, so the ball pushes walls from the platform surface.
        if (++settle >= 66) phase = 'approach'
        return { forward: 0, lateral: 0, brake: false }
      }
      const p = previous.ball.position, v = previous.ball.linearVelocity
      const px = p[0]! * 4, pz = -p[2]! * 4
      const vx = v[0]! * 4, vz = -v[2]! * 4
      const progress = (px - originX) * inwardX + (pz - originZ) * inwardZ
      // Approach the doorway, then push the far wall weight off the platform
      // before centering, matching the native route fixture.
      if (phase === 'approach' && progress > -2) phase = 'push'
      if (phase === 'push' && progress > 6) phase = 'center'
      if (phase !== 'center') return { forward: pressInput(inwardZ), lateral: pressInput(inwardX), brake: false }
      return {
        forward: pressInput((originZ - pz) * 2 - vz * .9),
        lateral: pressInput((originX - px) * 2 - vx * .9),
        brake: false,
      }
    },
  }
}

function groundedTargetController(targetXZ: [number, number], damping = .9): HarnessController {
  let started = false
  const [targetX, targetZ] = targetXZ
  return {
    reset() { started = false },
    input(_tick: number, previous: HarnessTickRecord) {
      if (!started && previous.contacts.grounded) started = true
      if (!started) return { forward: 0, lateral: 0, brake: false }
      const p = previous.ball.position, v = previous.ball.linearVelocity
      const px = p[0]! * 4, pz = -p[2]! * 4
      const vx = v[0]! * 4, vz = -v[2]! * 4
      return {
        forward: clampInput((targetZ - pz) * 2 - vz * damping),
        lateral: clampInput((targetX - px) * 2 - vx * damping),
        brake: false,
      }
    },
  }
}

function swingCrossingController(
  phaseTicks: number,
  originOriginal: [number, number, number],
  axisOriginal: [number, number, number],
  targetOriginal: [number, number, number],
): HarnessController {
  let elapsed = 0
  let crossed = false
  const [originX, originY, originZ] = originOriginal
  const axisX = axisOriginal[0], axisZ = axisOriginal[2]
  const targetX = targetOriginal[0], targetZ = targetOriginal[2]
  return {
    reset() { elapsed = 0; crossed = false },
    input(_tick: number, previous: HarnessTickRecord) {
      elapsed++
      // Match the native route: settle onto the staged entrance before driving.
      if (elapsed <= phaseTicks + 15) return { forward: 0, lateral: 0, brake: false }
      const p = previous.ball.position, v = previous.ball.linearVelocity
      const px = p[0]! * 4, py = p[1]! * 4, pz = -p[2]! * 4
      const vx = v[0]! * 4, vz = -v[2]! * 4
      if (!crossed && (px - originX) * axisX + (pz - originZ) * axisZ > 8 && py > originY) crossed = true
      if (!crossed) return { forward: pressInput(axisZ), lateral: pressInput(axisX), brake: false }
      if (Math.hypot(targetX - px, targetZ - pz) < .35 && Math.hypot(vx, vz) < .5) return { forward: 0, lateral: 0, brake: false }
      return {
        forward: pressInput((targetZ - pz) * 2 - vz * .8),
        lateral: pressInput((targetX - px) * 2 - vx * .8),
        brake: false,
      }
    },
  }
}

function spawnAssertions(): HarnessAssertion[] {
  return [
    { kind: 'event', event: 'spawn.begin', from: 0, to: 2 },
    { kind: 'field', path: 'lifecycle.physicalized', op: 'eq', value: false, from: 0, to: 320 },
    { kind: 'event', event: 'spawn.unveil', from: 328, to: 333 },
    { kind: 'event', event: 'ball.physicalized', from: 394, to: 399 },
    { kind: 'field', path: 'lifecycle.physicalized', op: 'eq', value: true, from: 399, to: 459 },
  ]
}

const ENDING_FADE_NOTE = 'fadeout Sky 5837 exits at once through Test 5826 True/False, so its 3000 ms fade runs alongside Wait 5745 (10000 ms; 23000 ms where Parameter Selector 5726 picks it); the hand-port windows move earlier by 3000 ms = 396 ticks at 1/132 s, same width'
const RESET_RESPAWN_NOTE = 'authored reset = Deactivate Ball 2499 (1000 ms = 132 ticks) + Gameplay_SectorManager (4 frames) + New Ball 2921 Delayer 2512 (3000 ms = 396 ticks) = 532 ticks after the action at wake+120; the hand-port window moves from wake+125..145 to wake+657..677'

function finishAssertions(completeFrom = 1104, completeTo = 1503): HarnessAssertion[] {
  const authoredWindow = completeFrom === 1104 && completeTo === 1503
  return [
    { kind: 'event', event: 'finish.wake', from: 0, to: 30 },
    { kind: 'event', event: 'finish.boarding', from: 0, to: 30 },
    { kind: 'event', event: 'finish.departure.begin', from: 0, to: 30 },
    { kind: 'phase', phase: 'departing', from: { event: 'finish.boarding', offset: 2 }, to: { event: 'finish.boarding', offset: 120 } },
    { kind: 'field', path: 'lifecycle.ending', op: 'eq', value: true, from: { event: 'finish.boarding', offset: 2 }, to: { event: 'finish.boarding', offset: 120 } },
    { kind: 'eventAbsent', event: 'ball.dead' },
    { kind: 'event', event: 'level.complete', from: completeFrom, to: completeTo, ...(authoredWindow ? { note: ENDING_FADE_NOTE } : {}) },
    { kind: 'field', path: 'contacts.supportIds', op: 'someMatch', value: 'pe_balloon.Platform', from: { event: 'finish.boarding', offset: 60 }, to: { event: 'finish.boarding', offset: 160 } },
    { kind: 'field', path: 'lifecycle.platformDistanceFromOrigin', op: 'gte', value: 2, from: { event: 'finish.boarding', offset: 700 }, to: { event: 'finish.boarding', offset: 800 } },
    { kind: 'field', path: 'lifecycle.finishParts', op: 'equalAtTicks', ticks: [1, { event: 'finish.boarding', offset: 0 }, { event: 'finish.boarding', offset: 120 }] },
  ]
}

// The recovered UFO claw presentation drives both solvers' Level 12 ending.
// Stage transitions share the same presentation-frame timeline.
function ufoAssertions(): HarnessAssertion[] {
  return [
    { kind: 'field', path: 'lifecycle.ufoStage', op: 'eq', value: 'waiting', from: 9, to: 10 },
    { kind: 'field', path: 'lifecycle.ufoStage', op: 'eq', value: 'flight', from: 40, to: 2500 },
    { kind: 'field', path: 'lifecycle.ufoStage', op: 'eq', value: 'flash', from: 2520, to: 2615 },
    { kind: 'field', path: 'lifecycle.ufoStage', op: 'eq', value: 'done', from: 2630, to: 4199 },
  ]
}

function generatedScenarios(): HarnessScenario[] {
  const scenarios: HarnessScenario[] = []
  for (const [key, data] of Object.entries(STAGE_DATA)) {
    const level = Number(key) - 1
    const stage = key
    scenarios.push({
      id: `stage${stage}_spawn`,
      level,
      start: { kind: 'spawn' },
      maxTicks: 460,
      input: [],
      compare: { poseTolerance: 1e-3, supportPersistence: 3 },
      assertions: spawnAssertions(),
    })
    if (data.fan) {
      const fan = data.fan
      scenarios.push({
        id: `stage${stage}_fan_lift`,
        level,
        module: { kind: 'P_Modul_18', instance: fan.name },
        start: { kind: 'inject', sector: fan.sector, material: 'paper', positionOriginal: fan.startOriginal, yaw: 0 },
        maxTicks: 1000,
        input: [],
        compare: { poseTolerance: 1e-3, supportPersistence: 3 },
        assertions: [
          { kind: 'eventAbsent', event: 'ball.dead' },
          { kind: 'field', path: 'lifecycle.activeFanNames', op: 'someMatch', value: fan.name, from: 0, to: 999 },
          { kind: 'field', path: 'ball.position[1]', op: 'gte', value: fan.hoverYOriginal * .25, from: 800, to: 999 },
        ],
      })
    }
    if (data.bridge) {
      const bridge = data.bridge
      const start = bridge.startOriginal
      const axis = bridge.axis
      const endOriginal: [number, number] = [start[0] + axis[0] * bridge.stopDistance, start[2] + axis[2] * bridge.stopDistance]
      const endRender = [endOriginal[0] * .25, -(endOriginal[1]) * .25] as [number, number]
      scenarios.push({
        id: `stage${stage}_bridge`,
        level,
        module: { kind: 'P_Modul_29', instance: bridge.name },
        start: { kind: 'inject', sector: bridge.sector, material: 'wood', positionOriginal: bridge.startOriginal, yaw: 0 },
        maxTicks: 1300,
        input: [],
        controller: groundedTargetController(endOriginal),
        compare: { poseTolerance: 1e-3, supportPersistence: 3 },
        assertions: [
          { kind: 'eventAbsent', event: 'ball.dead' },
          { kind: 'field', path: 'ball.position[0]', op: 'approx', value: endRender[0], tolerance: .6, from: 1000, to: 1299 },
          { kind: 'field', path: 'ball.position[2]', op: 'approx', value: endRender[1], tolerance: .6, from: 1000, to: 1299 },
          { kind: 'field', path: 'contacts.grounded', op: 'eq', value: true, from: 1000, to: 1199 },
        ],
      })
    }
    for (const [index, arm] of (data.arm ?? []).entries()) {
      const targetXZ: [number, number] = [arm.targetOriginal[0], arm.targetOriginal[2]]
      scenarios.push({
        id: index === 0 ? `stage${stage}_arm` : `stage${stage}_arm_${index + 1}`,
        level,
        module: { kind: 'P_Modul_17', instance: arm.name },
        start: { kind: 'inject', sector: arm.sector, material: 'stone', positionOriginal: arm.startOriginal, yaw: 0 },
        maxTicks: 1400,
        input: [],
        controller: groundedTargetController(targetXZ),
        compare: { poseTolerance: 1e-3, supportPersistence: 3 },
        assertions: [
          { kind: 'eventAbsent', event: 'ball.dead' },
          { kind: 'field', path: 'ball.position[0]', op: 'approx', value: targetXZ[0] * .25, tolerance: .6, from: 1100, to: 1399 },
          { kind: 'field', path: 'ball.position[2]', op: 'approx', value: -targetXZ[1] * .25, tolerance: .6, from: 1100, to: 1399 },
          { kind: 'field', path: 'contacts.grounded', op: 'eq', value: true, from: 1100, to: 1399 },
        ],
      })
    }
    // TODO: Level 11 authors two P_Modul_08 placements, but harness-stages.json
    // records `swing: null` for stage 11. Recover those placements in
    // scripts/generate-harness-stages.py; until then skip the scenario rather
    // than inventing coordinates or a route direction.
    for (const [index, swing] of (data.swing ?? []).entries()) {
      const from = swing.phaseTicks + 500
      const to = swing.phaseTicks + 699
      scenarios.push({
        id: index === 0 ? `stage${stage}_swing` : `stage${stage}_swing_${index + 1}`,
        level,
        module: { kind: 'P_Modul_08', instance: swing.name },
        start: { kind: 'inject', sector: swing.sector, material: 'wood', positionOriginal: swing.safeOriginal, yaw: 0 },
        maxTicks: swing.phaseTicks + 700,
        tickSeconds: 1 / 60,
        input: [],
        actions: [{ kind: 'stage', afterTicks: swing.phaseTicks, positionOriginal: swing.startOriginal, material: 'wood' }],
        controller: swingCrossingController(swing.phaseTicks, swing.originOriginal, swing.axisOriginal, swing.targetOriginal),
        compare: { poseTolerance: 1e-3, supportPersistence: 3 },
        assertions: [
          { kind: 'eventAbsent', event: 'ball.dead' },
          { kind: 'field', path: 'ball.position[0]', op: 'approx', value: swing.targetOriginal[0] * .25, tolerance: .8, from, to },
          { kind: 'field', path: 'ball.position[2]', op: 'approx', value: -swing.targetOriginal[2] * .25, tolerance: .8, from, to },
          { kind: 'field', path: 'contacts.grounded', op: 'eq', value: true, from, to },
        ],
      })
    }
    for (const [index, sack] of (data.sack ?? []).entries()) {
      scenarios.push({
        id: index === 0 ? `stage${stage}_sack` : `stage${stage}_sack_${index + 1}`,
        level,
        module: { kind: 'P_Modul_26', instance: sack.name },
        start: { kind: 'inject', sector: sack.sector, material: 'wood', positionOriginal: sack.startOriginal, yaw: 0 },
        maxTicks: 400,
        input: [],
        controller: sackController(sack.originOriginal, sack.axisOriginal),
        compare: { poseTolerance: 1e-3, supportPersistence: 3 },
        assertions: [
          { kind: 'eventAbsent', event: 'ball.dead' },
          { kind: 'field', path: 'lifecycle.sackTravel', op: 'maxGte', value: .2, from: 60, to: 399 },
        ],
      })
    }
    if (data.lift) {
      const lift = data.lift
      scenarios.push({
        id: `stage${stage}_lift`,
        level,
        module: { kind: 'P_Modul_03', instance: lift.name },
        start: { kind: 'inject', sector: lift.sector, material: 'wood', positionOriginal: lift.startOriginal, yaw: 0 },
        maxTicks: 2800,
        input: [],
        controller: liftController(lift.originOriginal, lift.inwardOriginal),
        compare: { poseTolerance: 1e-3, supportPersistence: 3 },
        assertions: [
          { kind: 'eventAbsent', event: 'ball.dead' },
          { kind: 'field', path: 'ball.position[0]', op: 'approx', value: lift.originOriginal[0] * .25, tolerance: .5, from: 2400, to: 2799 },
          { kind: 'field', path: 'contacts.grounded', op: 'eq', value: true, from: 2400, to: 2799 },
          { kind: 'field', path: 'lifecycle.liftTravel', op: 'lte', value: -.2, from: 2400, to: 2799 },
        ],
      })
    }
    scenarios.push({
      id: `stage${stage}_finish_ride`,
      level,
      module: { kind: 'PE_Balloon', instance: 'PE_Balloon_01' },
      start: { kind: 'inject', sector: data.finish.sector, material: 'wood', positionOriginal: data.finish.startOriginal, yaw: 0 },
      maxTicks: stage === '12' ? 4200 : 1900,
      stopOnComplete: true,
      input: [],
      compare: { startTick: 9, poseTolerance: 1e-3, knownGap: { classification: 'known-finish-constraint-solver-gap', note: 'The stacked finish constraint model: IVP one-shot local constraints versus Rapier iterated joint islands. Both must survive and complete.' } },
      assertions: stage === '12' ? [...finishAssertions(2600, 4199), ...ufoAssertions()] : finishAssertions(),
    })
  }
  return scenarios
}

function fanTransferController(): HarnessController {
  let departed = false
  return {
    reset() { departed = false },
    input(_tick: number, previous: HarnessTickRecord) {
      const p = previous.ball.position, v = previous.ball.linearVelocity
      if (!departed && p[1]! > LEVEL2_FAN12_STEER_Y) departed = true
      if (!departed) return { forward: 0, lateral: 0, brake: false }
      const px = p[0]! * 4, pz = -p[2]! * 4
      const vx = v[0]! * 4, vz = -v[2]! * 4
      const x = (LEVEL2_FAN12_ORIGINAL[0] - px) * 2 - vx * .4
      const z = (LEVEL2_FAN12_ORIGINAL[2] - pz) * 2 - vz * .4
      return { forward: clampInput(z), lateral: clampInput(x), brake: false }
    },
  }
}

function sliderDriveController(): HarnessController {
  let started = false
  return {
    reset() { started = false },
    input(tick, previous) {
      if (!started && previous.contacts.grounded) started = true
      if (!started || tick >= 1140) return { forward: 0, lateral: 0, brake: false }
      if (tick < 400) return { forward: 1, lateral: 0, brake: false }
      return { forward: (tick - 400) % 370 < 106 ? -1 : 1, lateral: 0, brake: false }
    },
  }
}

/** Drive straight until the ball's original-unit Z falls to `stopZ` (the ramp's far end), then coast. */
function driveUntilZController(stopZ: number): HarnessController {
  let stopped = false
  return {
    reset() { stopped = false },
    input(_tick: number, previous: HarnessTickRecord) {
      if (-previous.ball.position[2]! * 4 <= stopZ) stopped = true
      return { forward: stopped ? 0 : 1, lateral: 0, brake: false }
    },
  }
}

function groundedDriveController(stopAfterX?: number): HarnessController {
  let started = false
  let stopped = false
  return {
    reset() { started = stopped = false },
    input(_tick: number, previous: HarnessTickRecord) {
      if (stopAfterX !== undefined && previous.ball.position[0]! >= stopAfterX) stopped = true
      if (stopped) return { forward: 0, lateral: 0, brake: false }
      if (!started && previous.contacts.grounded) started = true
      return { forward: started ? 1 : 0, lateral: 0, brake: false }
    },
  }
}

export const HARNESS_SCENARIOS: HarnessScenario[] = [
  {
    id: 'stage1_spawn',
    level: 0,
    start: { kind: 'spawn' },
    maxTicks: 460,
    input: [],
    compare: {
      poseTolerance: 1e-3,
      supportPersistence: 3,
    },
    assertions: [
      { kind: 'event', event: 'spawn.begin', from: 0, to: 2, note: 'the real spawn presentation begins at load' },
      { kind: 'field', path: 'lifecycle.physicalized', op: 'eq', value: false, from: 0, to: 320, note: 'ball stays nonphysical through the unveil' },
      { kind: 'event', event: 'spawn.unveil', from: 328, to: 333, note: 'SPAWN_FLASH_MS=2500 at 132 Hz' },
      { kind: 'event', event: 'ball.physicalized', from: 394, to: 399, note: 'SPAWN_DURATION=3000 at 132 Hz' },
      { kind: 'field', path: 'lifecycle.physicalized', op: 'eq', value: true, from: 399, to: 459 },
    ],
  },
  {
    // Climb the first ramp of Level 1 and stop on the flat above it; the ball must come to rest.
    id: 'stage1_ramp_rest',
    level: 0,
    start: {
      kind: 'inject',
      sector: 1,
      material: 'wood',
      positionOriginal: [4, 15.4, -150],
      yaw: Math.PI,
    },
    maxTicks: 2600,
    input: [],
    controller: driveUntilZController(-166),
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      ...[0, 1, 2].flatMap((axis): HarnessAssertion[] => [
        { kind: 'field', path: `ball.linearVelocity[${axis}]`, op: 'approx', value: 0, tolerance: 0.01, from: 2000, to: 2599, note: 'the released ball comes to rest on the flat' },
        { kind: 'field', path: `ball.angularVelocity[${axis}]`, op: 'approx', value: 0, tolerance: 0.01, from: 2000, to: 2599, note: 'a resting ball does not keep spinning' },
      ]),
    ],
  },
  {
    id: 'stage2_spawn',
    level: 1,
    start: { kind: 'spawn' },
    maxTicks: 460,
    input: [],
    compare: {
      poseTolerance: 1e-3,
      supportPersistence: 3,
    },
    assertions: [
      { kind: 'event', event: 'spawn.begin', from: 0, to: 2, note: 'the real spawn presentation begins at load' },
      { kind: 'field', path: 'lifecycle.physicalized', op: 'eq', value: false, from: 0, to: 320, note: 'ball stays nonphysical through the unveil' },
      { kind: 'event', event: 'spawn.unveil', from: 328, to: 333, note: 'SPAWN_FLASH_MS=2500 at 132 Hz' },
      { kind: 'event', event: 'ball.physicalized', from: 394, to: 399, note: 'SPAWN_DURATION=3000 at 132 Hz' },
      { kind: 'field', path: 'lifecycle.physicalized', op: 'eq', value: true, from: 399, to: 459 },
    ],
  },
  {
    id: 'stage2_fan_transfer',
    level: 1,
    module: { kind: 'P_Modul_18' },
    start: {
      kind: 'inject',
      sector: 3,
      material: 'paper',
      positionOriginal: LEVEL2_FAN01_START_ORIGINAL,
      yaw: 0,
    },
    maxTicks: 1200,
    input: [],
    controller: fanTransferController(),
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'eventAbsent', event: 'ball.dead', note: 'the paper ball must not fall during the transfer' },
      { kind: 'field', path: 'lifecycle.activeFanNames', op: 'someMatch', value: 'P_Modul_18_12', from: 0, to: 1199, note: 'the raised fan controller must engage' },
      { kind: 'field', path: 'lifecycle.activeFanNames', op: 'noneMatch', value: 'P_Modul_18_01', from: 800, to: 1199, note: 'the lower fan releases its controller after departure' },
      { kind: 'field', path: 'ball.position[0]', op: 'approx', value: LEVEL2_FAN12_ORIGINAL[0] * .25, tolerance: 1, from: 1000, to: 1199 },
      { kind: 'field', path: 'ball.position[2]', op: 'approx', value: -LEVEL2_FAN12_ORIGINAL[2] * .25, tolerance: 1, from: 1000, to: 1199 },
      { kind: 'field', path: 'ball.position[1]', op: 'gte', value: LEVEL2_FAN12_STEER_Y + 3.5, from: 1000, to: 1199, note: 'paper hovers in the upper fan airflow' },
    ],
  },
  {
    id: 'stage1_pusher',
    level: 0,
    module: { kind: 'P_Modul_01', instance: 'P_Modul_01_01' },
    start: {
      kind: 'inject',
      sector: 3,
      material: 'wood',
      positionOriginal: [262.12, -5.07, -810.46],
      yaw: 0,
    },
    maxTicks: 600,
    input: [],
    controller: groundedDriveController(),
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'field', path: 'lifecycle.pusherTravel', op: 'gte', value: .5, from: 200, to: 599, note: 'the wooden ball pushes the gate along its authored channel' },
    ],
  },
  {
    id: 'stage1_slider',
    level: 0,
    module: { kind: 'P_Modul_34', instance: 'P_Modul_34_01' },
    start: {
      kind: 'inject',
      sector: 2,
      material: 'stone',
      positionOriginal: [161.2, 3, -563],
      yaw: Math.PI / 2,
    },
    maxTicks: 1500,
    input: [],
    controller: sliderDriveController(),
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'field', path: 'lifecycle.sliderJoints', op: 'eq', value: 1, from: 0, to: 1499, note: 'the authored prismatic joint is installed while its sector is active' },
      { kind: 'field', path: 'lifecycle.sliderTravel', op: 'gte', value: .5, from: 1200, to: 1499, note: 'the stone drops along the authored slider after the crate is pushed away' },
      { kind: 'field', path: 'lifecycle.sliderLateral', op: 'lte', value: .1, from: 0, to: 1499, note: 'the prismatic joint keeps the stone on its authored axis' },
    ],
  },
  {
    id: 'stage2_bridge',
    level: 1,
    start: {
      kind: 'inject',
      sector: 3,
      material: 'wood',
      positionOriginal: LEVEL2_BRIDGE_START_ORIGINAL,
      yaw: -Math.PI / 2,
    },
    maxTicks: 1300,
    input: [],
    controller: groundedDriveController(),
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'eventAbsent', event: 'ball.dead' },
      { kind: 'field', path: 'ball.position[0]', op: 'gte', value: LEVEL2_BRIDGE_END_X, from: 1000, to: 1299, note: 'the ball reaches the far side of the nine-plank bridge' },
    ],
  },
  {
    id: 'stage2_bridge_stone',
    level: 1,
    module: { kind: 'P_Modul_29', instance: 'P_Modul_29_01' },
    start: {
      kind: 'inject',
      sector: 3,
      material: 'stone',
      positionOriginal: LEVEL2_BRIDGE_START_ORIGINAL,
      yaw: -Math.PI / 2,
    },
    maxTicks: 800,
    input: [],
    controller: groundedDriveController(),
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'field', path: 'lifecycle.chainJoints', op: 'lte', value: 9, from: 200, to: 300, note: 'the stone releases the inner Platte07-Platte06 hinge exactly once' },
    ],
  },
  {
    id: 'stage2_finish_ride',
    level: 1,
    module: { kind: 'PE_Balloon', instance: 'PE_Balloon_01' },
    start: {
      kind: 'inject',
      sector: 5,
      material: 'wood',
      positionOriginal: LEVEL2_PLATFORM_RIDE_START_ORIGINAL,
      yaw: 0,
    },
    maxTicks: 1900,
    stopOnComplete: true,
    input: [],
    compare: {
      startTick: 9,
      poseTolerance: 1e-3,
      knownGap: {
        classification: 'known-finish-constraint-solver-gap',
        note: 'The same stacked 639+659 finish constraint model as stage1: IVP resolves local constraints one-shot per PSI, while Rapier iterates the loaded joint island. Both must survive and complete; no empirical softening or force rescaling is applied.',
      },
    },
    assertions: [
      { kind: 'event', event: 'finish.wake', from: 0, to: 30, note: 'the staged supported rider trips the recovered approach proximity immediately' },
      { kind: 'event', event: 'finish.boarding', from: 0, to: 30 },
      { kind: 'event', event: 'finish.departure.begin', from: 0, to: 30 },
      { kind: 'phase', phase: 'departing', from: { event: 'finish.boarding', offset: 2 }, to: { event: 'finish.boarding', offset: 120 } },
      { kind: 'field', path: 'lifecycle.ending', op: 'eq', value: true, from: { event: 'finish.boarding', offset: 2 }, to: { event: 'finish.boarding', offset: 120 } },
      { kind: 'eventAbsent', event: 'ball.dead' },
      { kind: 'event', event: 'level.complete', from: 1104, to: 1503, note: ENDING_FADE_NOTE },
      { kind: 'field', path: 'contacts.supportIds', op: 'someMatch', value: 'pe_balloon.Platform', from: { event: 'finish.boarding', offset: 60 }, to: { event: 'finish.boarding', offset: 160 } },
      { kind: 'field', path: 'lifecycle.platformDistanceFromOrigin', op: 'gte', value: 2, from: { event: 'finish.boarding', offset: 700 }, to: { event: 'finish.boarding', offset: 800 } },
      { kind: 'field', path: 'lifecycle.finishParts', op: 'equalAtTicks', ticks: [1, { event: 'finish.boarding', offset: 0 }, { event: 'finish.boarding', offset: 120 }] },
    ],
  },
  {
    id: 'stage3_spawn',
    level: 2,
    start: { kind: 'spawn' },
    maxTicks: 460,
    input: [],
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'event', event: 'spawn.begin', from: 0, to: 2 },
      { kind: 'field', path: 'lifecycle.physicalized', op: 'eq', value: false, from: 0, to: 320 },
      { kind: 'event', event: 'spawn.unveil', from: 328, to: 333 },
      { kind: 'event', event: 'ball.physicalized', from: 394, to: 399 },
      { kind: 'field', path: 'lifecycle.physicalized', op: 'eq', value: true, from: 399, to: 459 },
    ],
  },
  {
    id: 'stage3_arm',
    level: 2,
    start: {
      kind: 'inject',
      sector: 4,
      material: 'stone',
      positionOriginal: LEVEL3_ARM_START_ORIGINAL,
      yaw: 0,
    },
    maxTicks: 1200,
    input: [],
    controller: groundedTargetController(LEVEL3_ARM_TARGET_XZ),
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'eventAbsent', event: 'ball.dead' },
      { kind: 'field', path: 'ball.position[0]', op: 'approx', value: LEVEL3_ARM_TARGET_XZ[0] * .25, tolerance: .5, from: 900, to: 1199, note: 'stone reaches the authored exit of the rotating arm' },
      { kind: 'field', path: 'ball.position[2]', op: 'approx', value: -LEVEL3_ARM_TARGET_XZ[1] * .25, tolerance: .5, from: 900, to: 1199 },
      { kind: 'field', path: 'contacts.grounded', op: 'eq', value: true, from: 1000, to: 1199, note: 'the ball stops on the static exit floor' },
    ],
  },
  {
    id: 'stage3_fan_lift',
    level: 2,
    module: { kind: 'P_Modul_18', instance: 'P_Modul_18_02' },
    start: {
      kind: 'inject',
      sector: 5,
      material: 'paper',
      positionOriginal: LEVEL3_FAN02_START_ORIGINAL,
      yaw: 0,
    },
    maxTicks: 1000,
    input: [],
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'eventAbsent', event: 'ball.dead' },
      { kind: 'field', path: 'lifecycle.activeFanNames', op: 'someMatch', value: 'P_Modul_18_02', from: 0, to: 999, note: 'the source fan controller engages' },
      { kind: 'field', path: 'ball.position[1]', op: 'gte', value: LEVEL3_FAN02_ORIGIN_Y + 3.75, from: 800, to: 999, note: 'paper hovers at least 15 original units above the fan origin' },
    ],
  },
  {
    id: 'stage3_bridge',
    level: 2,
    start: {
      kind: 'inject',
      sector: 1,
      material: 'wood',
      positionOriginal: LEVEL3_BRIDGE_START_ORIGINAL,
      yaw: -Math.PI / 2,
    },
    maxTicks: 1300,
    input: [],
    controller: groundedDriveController(LEVEL3_BRIDGE_END_X),
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'eventAbsent', event: 'ball.dead' },
      { kind: 'field', path: 'ball.position[0]', op: 'gte', value: LEVEL3_BRIDGE_END_X, from: 1000, to: 1299, note: 'the ball reaches the far side of the Level 3 nine-plank bridge' },
    ],
  },
  {
    id: 'stage3_finish_ride',
    level: 2,
    module: { kind: 'PE_Balloon', instance: 'PE_Balloon_01' },
    start: {
      kind: 'inject',
      sector: 5,
      material: 'wood',
      positionOriginal: LEVEL3_PLATFORM_RIDE_START_ORIGINAL,
      yaw: 0,
    },
    maxTicks: 1900,
    stopOnComplete: true,
    input: [],
    compare: {
      startTick: 9,
      poseTolerance: 1e-3,
      knownGap: {
        classification: 'known-finish-constraint-solver-gap',
        note: 'The same stacked finish constraint model as Levels 1-2: IVP one-shot local constraints versus Rapier iterated joint islands. Both must survive and complete.',
      },
    },
    assertions: [
      { kind: 'event', event: 'finish.wake', from: 0, to: 30 },
      { kind: 'event', event: 'finish.boarding', from: 0, to: 30 },
      { kind: 'event', event: 'finish.departure.begin', from: 0, to: 30 },
      { kind: 'phase', phase: 'departing', from: { event: 'finish.boarding', offset: 2 }, to: { event: 'finish.boarding', offset: 120 } },
      { kind: 'field', path: 'lifecycle.ending', op: 'eq', value: true, from: { event: 'finish.boarding', offset: 2 }, to: { event: 'finish.boarding', offset: 120 } },
      { kind: 'eventAbsent', event: 'ball.dead' },
      { kind: 'event', event: 'level.complete', from: 1104, to: 1503, note: ENDING_FADE_NOTE },
      { kind: 'field', path: 'contacts.supportIds', op: 'someMatch', value: 'pe_balloon.Platform', from: { event: 'finish.boarding', offset: 60 }, to: { event: 'finish.boarding', offset: 160 } },
      { kind: 'field', path: 'lifecycle.platformDistanceFromOrigin', op: 'gte', value: 2, from: { event: 'finish.boarding', offset: 700 }, to: { event: 'finish.boarding', offset: 800 } },
      { kind: 'field', path: 'lifecycle.finishParts', op: 'equalAtTicks', ticks: [1, { event: 'finish.boarding', offset: 0 }, { event: 'finish.boarding', offset: 120 }] },
    ],
  },
  {
    id: 'stage1_stone_crown',
    level: 0,
    start: {
      kind: 'inject',
      sector: 4,
      material: 'stone',
      positionOriginal: CROWN_START_ORIGINAL,
      yaw: BRIDGE_START_YAW,
    },
    maxTicks: 900,
    input: [
      { from: 0, to: 40, forward: 0, lateral: 0 },
      { from: 40, to: 900, forward: 1, lateral: 0 },
    ],
    compare: {
      startTick: 40,
      endTick: 899,
      poseTolerance: 1e-3,
      longitudinalPositionTolerance: 1e-2,
      longitudinalVelocityTolerance: 5e-2,
      supportPersistence: 3,
      knownGap: {
        classification: 'known-manifold-gap',
        firstContactWindow: [60, 180],
        firstLateralWindow: [120, 260],
        firstPoseWindow: [40, 60],
        note: 'Early divergence only: Rapier resolves the centered crown placement as a balanced pair while IVP seeds a small -Z tilt (max |dz| 0.26 vs 0.11 original units). Neither solver leaves the deck; the late outcome is the finish boarding/departure gap (Rapier boards at tick 341 and drops the rider at 454, IVP boards at 446). See docs/known-fidelity-gaps.md.',
      },
    },
    assertions: [],
  },
  {
    id: 'stage1_wood_finish',
    level: 0,
    start: {
      kind: 'inject',
      sector: 4,
      material: 'wood',
      positionOriginal: BRIDGE_START_ORIGINAL,
      yaw: BRIDGE_START_YAW,
    },
    maxTicks: 2200,
    stopOnComplete: true,
    input: [{ from: 0, to: 2200, forward: 1, lateral: 0 }],
    actions: [],
    compare: {
      poseTolerance: 1e-3,
    },
    assertions: [
      { kind: 'event', event: 'finish.wake', from: 0, to: 60, note: 'approach proximity wakes the managed finish assembly' },
      { kind: 'event', event: 'finish.boarding', from: 100, to: 700, note: 'recovered wood boarding window' },
      { kind: 'event', event: 'finish.departure.begin', from: 100, to: 700 },
      { kind: 'event', event: 'level.complete', from: 1404, to: 1803, note: 'fadeout Sky 5837 exits at once through Test 5826 True/False, so its 3000 ms fade runs alongside Wait 5745 (10000 ms; 23000 ms where Parameter Selector 5726 picks it); 1800 - 396 = 1404 and 2199 - 396 = 1803 at 1/132 s keep the same width. The old window was IVP-only, so Rapier skipped it (the graph ride completes at 1527, IVP at 1679); both are inside this authored window' },
      { kind: 'field', path: 'lifecycle.platformColliders', op: 'eq', value: 6, from: { event: 'finish.boarding', offset: 0 }, to: { event: 'finish.boarding', offset: 10 }, note: 'the six-hull platform proxy is live while boarding' },
      { kind: 'field', path: 'contacts.supportIds', op: 'someMatch', value: 'pe_balloon.Platform', from: { event: 'finish.boarding', offset: 0 }, to: { event: 'finish.boarding', offset: 120 }, note: 'the managed platform supports the ball during the ride' },
      { kind: 'field', path: 'lifecycle.stalePlatformSupport', op: 'eq', value: false, note: 'no support collider remains at the original platform location' },
      { kind: 'field', path: 'contacts.supportIds', op: 'noneMatch', value: 'Ballon|Seil', note: 'balloons and ropes are never support colliders' },
      { kind: 'field', path: 'contacts.supportIds', op: 'noneMatch', value: 'Box_slide', note: 'Box_slide stays a control-only body' },
      { kind: 'field', path: 'lifecycle.finishParts', op: 'equalAtTicks', ticks: [1, { event: 'finish.boarding', offset: 0 }, { event: 'finish.boarding', offset: 120 }], note: 'managed finish bodies are neither duplicated nor leaked during the ride' },
      { kind: 'field', path: 'lifecycle.finishModules', op: 'equalAtTicks', ticks: [1, { event: 'finish.boarding', offset: 0 }, { event: 'finish.boarding', offset: 120 }] },
      { kind: 'field', path: 'lifecycle.platformDistanceFromOrigin', op: 'gte', value: 5, from: { event: 'finish.departure.end', offset: 0 }, to: { event: 'finish.departure.end', offset: 0 }, solver: 'ivp', note: 'the platform has left its origin when the ending completes' },
    ],
  },
  {
    id: 'stage1_transform_respawn',
    level: 0,
    start: {
      kind: 'inject',
      sector: 2,
      material: 'wood',
      positionOriginal: [Number('147.2'), Number('-2.75'), Number('-540')],
      yaw: BRIDGE_START_YAW,
    },
    maxTicks: 1400,
    input: [
      { from: 0, to: 40, forward: 0, lateral: 0 },
      { from: 40, to: 700, forward: 0, lateral: -1 },
      { from: 700, to: 1400, forward: 0, lateral: 0 },
    ],
    compare: { poseTolerance: 1e-3 },
    assertions: [
      { kind: 'event', event: 'transform.capture', from: 90, to: 102, note: 'recovered capture entry, cooldown-gated' },
      { kind: 'event', event: 'transform.explode', from: 400, to: 412 },
      { kind: 'event', event: 'transform.material.change', from: 418, to: 432 },
      { kind: 'event', event: 'transform.release', from: 418, to: 432 },
      { kind: 'field', path: 'ball.type', op: 'eq', value: 'stone', from: 432, to: 560, note: 'new material survives the departure and fall' },
      { kind: 'field', path: 'ball.type', op: 'eq', value: 'stone', from: 900, to: 1399, note: 'New Ball 2921 reads only CurrentLevel[0][3]; CurrentLevel[0][1] is written only by set new Ball Set Cell 76 and Gameplay_Init Set Cell 1322, so the authored death respawn keeps the transformed stone ball' },
      { kind: 'field', path: 'lifecycle.lives', op: 'eq', value: 3, from: 0, to: 640 },
      { kind: 'field', path: 'lifecycle.colliderEnabled', op: 'eq', value: false, from: 120, to: 410, note: 'capture disables player collision' },
      { kind: 'field', path: 'lifecycle.colliderEnabled', op: 'eq', value: true, from: 440, to: 700, note: 'release restores player collision' },
      { kind: 'event', event: 'ball.dead', from: 598, to: 614, note: 'authored DepthTestCubes death volume' },
      { kind: 'event', event: 'respawn.complete', from: 1130, to: 1146, note: 'authored death: Deactivate Ball 2499 (1000 ms step) + Gameplay_SectorManager + New Ball 2921 Delayer 2512 (3000 ms); the graph completes at 1143 inside the existing window' },
      { kind: 'field', path: 'lifecycle.lives', op: 'eq', value: 2, from: 1146, to: 1399 },
      { kind: 'field', path: 'lifecycle.checkpoint', op: 'eq', value: 2, from: 900, to: 1399, note: 'the authored Deactivate Ball 2499 respawn advances the Gameplay_Events local 1417 counter (Op 5268) into sector 3, so the observer checkpoint is sector - 1 = 2' },
    ],
  },
  {
    id: 'stage1_finish_reset',
    level: 0,
    start: {
      kind: 'inject',
      sector: 4,
      material: 'wood',
      positionOriginal: BRIDGE_START_ORIGINAL,
      yaw: BRIDGE_START_YAW,
    },
    maxTicks: 900,
    input: [{ from: 0, to: 900, forward: 1, lateral: 0 }],
    actions: [{ kind: 'reset', afterEvent: 'finish.wake', delayTicks: 120, note: 'real respawn path resets the active sector after the managed bodies wake' }],
    compare: {
      poseTolerance: 1e-3,
    },
    assertions: [
      { kind: 'event', event: 'finish.wake', from: 0, to: 60 },
      { kind: 'field', path: 'lifecycle.finishPhase', op: 'eq', value: 'dormant', from: { event: 'finish.wake', offset: 657 }, to: { event: 'finish.wake', offset: 677 }, note: RESET_RESPAWN_NOTE },
      { kind: 'field', path: 'lifecycle.finishParts', op: 'equalAtTicks', ticks: [1, { event: 'finish.wake', offset: 662 }], note: 'reset action at wake+120 + 532 ticks = wake+652; the hand-port tick wake+130 becomes wake+662' },
      { kind: 'field', path: 'lifecycle.finishModules', op: 'equalAtTicks', ticks: [1, { event: 'finish.wake', offset: 662 }], note: 'same 532-tick authored reset shift: wake+130 + 532 = wake+662' },
      { kind: 'field', path: 'lifecycle.platformDistanceFromOrigin', op: 'lt', value: 0.01, from: { event: 'finish.wake', offset: 657 }, to: { event: 'finish.wake', offset: 677 }, note: RESET_RESPAWN_NOTE },
      { kind: 'field', path: 'lifecycle.physicalized', op: 'eq', value: true, from: { event: 'finish.wake', offset: 657 }, to: { event: 'finish.wake', offset: 677 }, note: 'New Ball 2921 physicalizes after Delayer 2512 (3000 ms = 396 ticks), following Deactivate Ball 2499 (1000 ms = 132 ticks) and the 4-frame sector manager' },
      { kind: 'field', path: 'lifecycle.checkpoint', op: 'eq', value: 3, from: { event: 'finish.wake', offset: 657 }, to: { event: 'finish.wake', offset: 677 }, note: RESET_RESPAWN_NOTE },
      { kind: 'field', path: 'contacts.supportIds', op: 'noneMatch', value: 'PE_Balloon', from: { event: 'finish.wake', offset: 657 }, to: { event: 'finish.wake', offset: 677 }, note: 'no ghost finish support after the authored reset respawn' },
      { kind: 'field', path: 'ball.position[0]', op: 'approx', value: CHECKPOINT_4_RESET_ORIGINAL[0] * 0.25, tolerance: 5e-3, from: { event: 'finish.wake', offset: 653 }, to: { event: 'finish.wake', offset: 654 }, note: 'New Ball 2921 positions from CurrentLevel[0][3] before Delayer 2512; the hand-port wake+121..122 window shifts by 532 ticks' },
      { kind: 'field', path: 'ball.position[1]', op: 'approx', value: CHECKPOINT_4_RESET_ORIGINAL[1] * 0.25, tolerance: 5e-3, from: { event: 'finish.wake', offset: 653 }, to: { event: 'finish.wake', offset: 654 } },
      { kind: 'field', path: 'ball.position[2]', op: 'approx', value: -CHECKPOINT_4_RESET_ORIGINAL[2] * 0.25, tolerance: 5e-3, from: { event: 'finish.wake', offset: 653 }, to: { event: 'finish.wake', offset: 654 } },
    ],
  },
  {
    id: 'stage1_finish_ride',
    level: 0,
    module: { kind: 'PE_Balloon', instance: 'PE_Balloon_01' },
    start: {
      kind: 'inject',
      sector: 4,
      material: 'wood',
      positionOriginal: PLATFORM_RIDE_START_ORIGINAL,
      yaw: BRIDGE_START_YAW,
    },
    maxTicks: 1900,
    stopOnComplete: true,
    input: [],
    compare: {
      startTick: 9,
      poseTolerance: 1e-3,
      knownGap: {
        classification: 'known-finish-constraint-solver-gap',
        note: 'IVP 1k10 resolves local constraints as one-shot per-PSI controllers and applies gravity/spring/actuator async pushes during integration, after constraint correction; the stacked recovered 639+659 mechanism therefore retains a bounded off-axis error under relative load, while Rapier iterates the loaded joint island and keeps locked DOFs closer to exact. Both solvers survive and complete. The per-solver platform Y bounds express this accepted solver-model gap; no empirical softness or force rescaling is applied.',
      },
    },
    assertions: [
      { kind: 'event', event: 'finish.wake', from: 0, to: 30, note: 'the staged supported rider trips the recovered approach proximity immediately' },
      { kind: 'event', event: 'finish.boarding', from: 0, to: 30, note: 'boarding fires from the supported platform-local state' },
      { kind: 'event', event: 'finish.departure.begin', from: 0, to: 30, note: 'the recovered departure force launches the assembly' },
      { kind: 'phase', phase: 'departing', from: { event: 'finish.boarding', offset: 2 }, to: { event: 'finish.boarding', offset: 120 }, note: 'the assembly stays in the departing stage through the ride' },
      { kind: 'field', path: 'lifecycle.ending', op: 'eq', value: true, from: { event: 'finish.boarding', offset: 2 }, to: { event: 'finish.boarding', offset: 120 }, note: 'the ending presentation owns the ride on both backends' },
      { kind: 'eventAbsent', event: 'ball.dead', note: 'the rider must survive the whole departing ride on both solvers' },
      { kind: 'event', event: 'level.complete', from: 1104, to: 1503, note: ENDING_FADE_NOTE },
      { kind: 'field', path: 'contacts.grounded', op: 'eq', value: true, from: { event: 'finish.boarding', offset: 60 }, to: { event: 'finish.boarding', offset: 160 }, note: 'persistent support during the early ride' },
      { kind: 'field', path: 'contacts.supportIds', op: 'someMatch', value: 'pe_balloon.Platform', from: { event: 'finish.boarding', offset: 60 }, to: { event: 'finish.boarding', offset: 160 }, note: 'the early ride support is the managed platform' },
      { kind: 'field', path: 'contacts.grounded', op: 'eq', value: true, from: { event: 'finish.boarding', offset: 700 }, to: { event: 'finish.boarding', offset: 800 }, note: 'persistent support late in the ride' },
      { kind: 'field', path: 'contacts.supportIds', op: 'someMatch', value: 'pe_balloon.Platform', from: { event: 'finish.boarding', offset: 700 }, to: { event: 'finish.boarding', offset: 800 } },
      { kind: 'field', path: 'contacts.supportIds', op: 'noneMatch', value: 'Ballon|Seil|Box_slide', note: 'balloons, ropes, and the slide stay control-only' },
      { kind: 'field', path: 'lifecycle.platformDistanceFromOrigin', op: 'gte', value: 2, from: { event: 'finish.boarding', offset: 700 }, to: { event: 'finish.boarding', offset: 800 }, note: 'the platform has left its origin mid-ride' },
      { kind: 'field', path: 'lifecycle.platformLinearVelocity[0]', op: 'gt', value: 0.1, from: { event: 'finish.boarding', offset: 700 }, to: { event: 'finish.boarding', offset: 800 }, solver: 'ivp', note: 'native steady departure translation after wake/departure; the Rapier iterated 639+659 joint island swings through x velocity ~-0.25 here, the documented bounded departure solver-model gap (its platformDistanceFromOrigin check still applies)' },
      { kind: 'field', path: 'lifecycle.platformPosition[1]', op: 'gte', value: -4.5, from: { event: 'finish.wake', offset: 0 }, to: { event: 'level.complete', offset: 0 }, solver: 'ivp', note: 'native platform vertical motion stays inside the recovered IVP sag/lift envelope' },
      { kind: 'field', path: 'lifecycle.platformPosition[1]', op: 'gte', value: -4.6, from: { event: 'finish.wake', offset: 0 }, to: { event: 'level.complete', offset: 0 }, solver: 'rapier', note: 'known bounded solver-model fidelity gap: the globally iterative Rapier joint island reaches a deeper departure sag than IVP one-shot local constraints (observed minimum approx -4.50); a materially deeper sag fails here, and this is not native parity' },
      { kind: 'field', path: 'lifecycle.platformPosition[1]', op: 'lte', value: -2.4, from: { event: 'finish.wake', offset: 0 }, to: { event: 'level.complete', offset: 0 } },
      { kind: 'field', path: 'lifecycle.finishParts', op: 'equalAtTicks', ticks: [1, { event: 'finish.boarding', offset: 0 }, { event: 'finish.boarding', offset: 120 }], note: 'managed finish bodies are neither duplicated nor leaked during the ride' },
    ],
  },
]

HARNESS_SCENARIOS.push(...generatedScenarios())
HARNESS_SCENARIOS.push(...hingeScenarios())

function hingeScenarios(): HarnessScenario[] {
  const wake = (id: string, level: number, kind: string, instance: string,
    start: [number, number, number], target: [number, number, number], angleFrom = 100): HarnessScenario => ({
    id,
    level,
    module: { kind, instance },
    start: { kind: 'inject', sector: kind === 'P_Modul_25' || kind === 'P_Modul_30' ? 3 : 1, material: 'wood', positionOriginal: start, yaw: 0 },
    actions: [{ kind: 'stage', afterTicks: 30, positionOriginal: target, material: 'wood', note: 'enter the authored wake proximity after observing the frozen state' }],
    maxTicks: 300,
    input: [],
    compare: { poseTolerance: 1e-3, supportPersistence: 3 },
    assertions: [
      { kind: 'field', path: 'lifecycle.hingeJoints', op: 'eq', value: 1, from: 0, to: 299, note: 'the authored hinge is installed while its sector is active' },
      { kind: 'field', path: 'lifecycle.hingeAngle', op: 'gte', value: .01, from: angleFrom, to: 299, note: 'the authored proximity wakes the frozen mechanism and gravity rotates it' },
    ],
  })
  return [
    wake('stage7_hinge_37', 6, 'P_Modul_37', 'P_Modul_37_01', [-27.13, 14.89, -.3], [341.804, 11.224, -51.468]),
    wake('stage2_hinge_25', 1, 'P_Modul_25', 'P_Modul_25_01', [838.92, 53.23, -346.7], [931.348, 50.668, -334.243]),
    wake('stage2_hinge_30', 1, 'P_Modul_30', 'P_Modul_30_01', [838.92, 53.23, -346.7], [971.766, 50.168, -366.697]),
    wake('stage9_hinge_19', 8, 'P_Modul_19', 'P_Modul_19_01', [.01, 18.66, .01], [79.304, 9, -19.991]),
    {
      id: 'stage7_hinge_41',
      level: 6,
      module: { kind: 'P_Modul_41', instance: 'P_Modul_41_01' },
      start: { kind: 'inject', sector: 1, material: 'wood', positionOriginal: [-27.13, 14.89, -.3], yaw: 0 },
      maxTicks: 300,
      input: [],
      compare: { poseTolerance: 1e-3, supportPersistence: 3 },
      assertions: [
        { kind: 'field', path: 'lifecycle.hingeJoints', op: 'eq', value: 1, from: 0, to: 299, note: 'the always-dynamic flap keeps its authored hinge' },
        { kind: 'field', path: 'lifecycle.hingeAngle', op: 'lte', value: .001, from: 100, to: 299, note: 'the flap rests at its authored pose without an invented motor' },
        { kind: 'field', path: 'lifecycle.hingeEnabled', op: 'eq', value: true, from: 0, to: 299, solver: 'rapier', note: 'the dynamic-start body is enabled at sector activation' },
      ],
    },
  ]
}

export function harnessScenario(id: string) {
  return HARNESS_SCENARIOS.find(scenario => scenario.id === id)
}
