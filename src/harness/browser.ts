import { harnessScenario } from './scenarios.ts'
import { runHarnessScenario } from './runner.ts'
import type { HarnessRuntime } from './types.ts'

const params = new URLSearchParams(location.search)
const scenarioId = params.get('scenario') ?? ''
const solver = params.get('solver') === 'ivp' ? 'ivp' as const : 'rapier' as const
const run = Number(params.get('run') ?? '1')
const detail = params.get('detail') === '1'
const next = params.get('next')

async function post(payload: unknown) {
  await fetch('/__harness/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
}

// Debris and spawn smoke use Math.random. Seed it from the scenario id (not the
// run index) so repeated runs of a scenario are bit-identical per solver.
function seedRandom(seed: number) {
  let state = seed >>> 0 || 1
  Math.random = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function seedFor(seed: string | number) {
  let hash = 2166136261
  const text = String(seed)
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  seedRandom(hash)
}

async function main() {
  const scenario = harnessScenario(scenarioId)
  if (!scenario) throw new Error(`Unknown harness scenario: ${scenarioId}`)
  seedFor(scenario.randomSeed ?? scenario.id)
  const { GraphHarnessRuntime } = await import('./graph-runtime.ts')
  const runtime: HarnessRuntime = new GraphHarnessRuntime(scenario, solver)
  try {
    const result = await runHarnessScenario(runtime, scenario, solver, detail)
    await post({ status: 'ok', scenario: scenario.id, solver, run, meta: result.meta, jsonl: result.rows.map(row => JSON.stringify(row)).join('\n') })
  } finally {
    try { runtime.destroy() } catch { /* the result is already posted */ }
  }
  if (next) location.assign(next)
}

main().catch(async error => {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  try { await post({ status: 'error', scenario: scenarioId, solver, run, error: message, stack }) } catch { /* the CLI timeout reports the missing result */ }
})
