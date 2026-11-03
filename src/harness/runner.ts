import { HARNESS_TICK_SECONDS } from './types.ts'
import type {
  HarnessEventName,
  HarnessInputState,
  HarnessRunResult,
  HarnessRuntime,
  HarnessScenario,
  HarnessSolver,
  HarnessTickRecord,
} from './types.ts'

const ZERO_INPUT: HarnessInputState = { forward: 0, lateral: 0, brake: false }

function inputAt(scenario: HarnessScenario, tick: number): HarnessInputState {
  for (let i = scenario.input.length - 1; i >= 0; i--) {
    const segment = scenario.input[i]!
    if (tick >= segment.from && tick < segment.to) {
      return { forward: segment.forward ?? 0, lateral: segment.lateral ?? 0, brake: segment.brake ?? false }
    }
  }
  return { ...ZERO_INPUT }
}

function deriveEvents(previous: HarnessTickRecord, current: HarnessTickRecord): HarnessEventName[] {
  const events: HarnessEventName[] = []
  const p = previous.lifecycle, c = current.lifecycle
  if (!p.spawnActive && c.spawnActive) events.push('spawn.begin')
  if (!p.spawnUnveiled && c.spawnUnveiled) events.push('spawn.unveil')
  if (!p.physicalized && c.physicalized) events.push('ball.physicalized')
  if (c.checkpoint > p.checkpoint) events.push('checkpoint.enter', 'sector.activate')
  if (p.finishPhase === 'dormant' && c.finishPhase !== 'dormant' && c.finishPhase !== 'none') events.push('finish.wake')
  if (p.finishPhase !== 'departing' && c.finishPhase === 'departing') events.push('finish.boarding')
  if (!p.ending && c.ending) events.push('finish.departure.begin')
  if (p.phase !== 'won' && c.phase === 'won') events.push('finish.departure.end', 'level.complete')
  if (!p.transformation?.active && c.transformation?.active) events.push('transform.capture')
  if (!p.transformation?.shattered && c.transformation?.shattered) events.push('transform.explode')
  if (previous.ball.type !== current.ball.type) events.push('transform.material.change')
  if (!p.transformation?.committed && c.transformation?.committed) events.push('transform.release')
  if (p.respawnStage === 'idle' && c.respawnStage !== 'idle') events.push('ball.dead', 'respawn.begin')
  if (p.respawnStage !== 'idle' && c.respawnStage === 'idle') events.push('respawn.complete')
  return events
}

export async function runHarnessScenario(runtime: HarnessRuntime, scenario: HarnessScenario, solver: HarnessSolver, detail: boolean): Promise<HarnessRunResult> {
  const moduleSelection = scenario.module ?? null
  runtime.setDetail(detail || scenario.sample?.contacts === true)
  const notes = runtime.notes
  const prepared = await runtime.prepare(scenario)
  runtime.suspend()
  const rows: HarnessTickRecord[] = []
  const eventTicks = new Map<HarnessEventName, number>()
  const fired = new Set<NonNullable<HarnessScenario['actions']>[number]>()
  let previous = prepared.baseline
  const dt = scenario.tickSeconds ?? HARNESS_TICK_SECONDS
  scenario.controller?.reset()
  const loopStarted = performance.now()
  const record = (tick: number, sample: HarnessTickRecord) => {
    sample.scenario = scenario.id
    sample.module = moduleSelection
    sample.events = deriveEvents(previous, sample)
    for (const event of sample.events) if (!eventTicks.has(event)) eventTicks.set(event, tick)
    rows.push(sample)
    previous = sample
  }
  const applyActions = (tick: number) => {
    for (const action of scenario.actions ?? []) {
      if (fired.has(action)) continue
      if (action.kind === 'stage') {
        if (tick < action.afterTicks) continue
        fired.add(action)
        runtime.stagePlayerInPlace(action)
        notes.push(`stage action fired at tick ${tick}`)
        continue
      }
      const after = eventTicks.get(action.afterEvent)
      if (after === undefined || tick < after + action.delayTicks) continue
      fired.add(action)
      runtime.respawn()
      notes.push(`reset action fired at tick ${tick} (${action.afterEvent}+${action.delayTicks})`)
    }
  }
  let start = 0
  if (prepared.first) {
    record(0, prepared.first)
    applyActions(0)
    start = 1
  }
  for (let tick = start; tick < scenario.maxTicks; tick++) {
    const input = scenario.controller ? scenario.controller.input(tick, previous) : inputAt(scenario, tick)
    runtime.setInput(input)
    runtime.step(dt)
    const sample = runtime.sample(tick, input)
    if (tick === 5 && (detail || scenario.sample?.contacts === true)) notes.push(...runtime.diagnostics())
    record(tick, sample)
    applyActions(tick)
    if (scenario.stopOnComplete !== false && (sample.lifecycle.phase === 'won' || sample.lifecycle.phase === 'lost')) break
  }
  return {
    scenario: scenario.id,
    solver,
    meta: {
      scenario: scenario.id,
      solver,
      module: moduleSelection,
      level: scenario.level,
      ticks: rows.length,
      startTick: 0,
      simMs: performance.now() - loopStarted,
      contacts: detail || scenario.sample?.contacts === true,
      capabilities: runtime.capabilities,
      notes,
      gitRevision: null,
      gitDirty: null,
      gitBranch: null,
    },
    rows,
  }
}
