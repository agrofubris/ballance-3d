import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer, type Plugin } from 'vite'
import { HARNESS_SCENARIOS, harnessScenario } from '../src/harness/scenarios.ts'
import { compareDeterminism, compareTraces } from '../src/harness/compare.ts'
import { runAssertions } from '../src/harness/assertions.ts'
import type { HarnessAssertionResult, HarnessDeterminism, HarnessRunMeta, HarnessRunResult, HarnessSolver } from '../src/harness/types.ts'
import { localOriginalAssets } from './local-original-assets.ts'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

interface GitMetadata { gitRevision: string | null; gitDirty: boolean | null; gitBranch: string | null }

function resolveGitMetadata(): GitMetadata {
  const run = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  let gitRevision: string | null = null
  let gitDirty: boolean | null = null
  let gitBranch: string | null = null
  try { gitRevision = run(['rev-parse', 'HEAD']) || null } catch { /* git metadata unavailable */ }
  try { gitDirty = run(['status', '--porcelain', '--untracked-files=no']).length > 0 } catch { /* git metadata unavailable */ }
  try { gitBranch = run(['branch', '--show-current']) || null } catch { /* git metadata unavailable */ }
  return { gitRevision, gitDirty, gitBranch }
}

type Flags = Record<string, string | boolean>

interface HarnessRun {
  solver: HarnessSolver
  run: number
}

interface HarnessResultPayload {
  status: 'ok' | 'error'
  scenario: string
  solver: HarnessSolver
  run: number
  meta?: HarnessRunMeta
  jsonl?: string
  error?: string
  stack?: string
}

function parseFlags(args: string[]) {
  const flags: Flags = {}
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const [name, inline] = arg.slice(2).split('=')
    if (inline !== undefined) flags[name!] = inline
    else if (args[i + 1] && !args[i + 1]!.startsWith('--')) flags[name!] = args[++i]!
    else flags[name!] = true
  }
  return { flags, positional }
}

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const socket = createTcpServer()
    socket.on('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      const port = typeof address === 'object' && address ? address.port : 0
      socket.close(() => resolvePort(port))
    })
  })
}

function resultPlugin(onResult: (payload: HarnessResultPayload) => void): Plugin {
  return {
    name: 'harness-result',
    configureServer(server) {
      server.middlewares.use('/__harness/result', (request, response) => {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => body += chunk)
        request.on('end', () => {
          try { onResult(JSON.parse(body) as HarnessResultPayload) } catch (error) { onResult({ status: 'error', scenario: '', solver: 'rapier', run: 0, error: String(error) }) }
          response.statusCode = 200
          response.end('ok')
        })
      })
    },
  }
}

function chromeExecutable() {
  const candidates = [
    process.env.BALLANCE_CHROME,
    join(repoRoot, '.tools', 'chrome-headless', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    join(repoRoot, 'node_modules', 'puppeteer', '.local-chromium'),
  ].filter((value): value is string => !!value)
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function killChrome(pid: number | undefined) {
  if (pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function removeProfile(profile: string | undefined) {
  if (!profile) return
  for (let attempt = 0; attempt < 12; attempt++) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 1 }); return } catch { sleepSync(100 + attempt * 50) }
  }
}

function runDirectory(root: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(root, stamp)
}

function formatNumber(value: number | null, digits = 6) {
  return value === null ? 'n/a' : value.toFixed(digits)
}

function buildSummary(scenario: string, comparison: ReturnType<typeof compareTraces>, assertions: HarnessAssertionResult[], ticks: Map<string, number>, skipped: string[], determinism: HarnessDeterminism[]) {
  const lines: string[] = [scenario]
  for (const [label, count] of ticks) lines.push(`${label} ticks: ${count}`)
  for (const solver of skipped) lines.push(`${solver}: SKIPPED (native IVP module unavailable; run scripts/build-ivp-simulation.py)`)
  if (comparison) {
    lines.push(`canonical comparison ticks ${comparison.startTick}..${comparison.canonicalEndTick} (pose tolerance ${formatNumber(comparison.poseTolerance)}, ${comparison.poseToleranceNote}; support persistence ${comparison.supportPersistence})`)
    if (comparison.truncated) lines.push(`comparison truncated at tick ${comparison.truncated.tick}: ${comparison.truncated.event} on ${comparison.truncated.solver}`)
    if (!comparison.longitudinalParity.applicable) lines.push(`Longitudinal parity: not applicable (${comparison.longitudinalParity.reason})`)
    else lines.push(`Longitudinal parity through tick ${comparison.longitudinalParity.throughTick}: ${comparison.longitudinalParity.passed ? 'PASS' : 'FAIL'} (max |dx| ${formatNumber(comparison.longitudinalParity.maxAbsDeltaX)} <= ${formatNumber(comparison.longitudinalParity.positionTolerance)}, max |dvx| ${formatNumber(comparison.longitudinalParity.maxAbsVelocityDeltaX)} <= ${formatNumber(comparison.longitudinalParity.velocityTolerance)})`)
    lines.push(`Lifecycle parity: ${comparison.firstLifecycleDivergence ? 'DIVERGED' : 'PASS'}`)
    if (comparison.firstLifecycleDivergence) lines.push(`  first lifecycle difference: tick ${comparison.firstLifecycleDivergence.tick} ${comparison.firstLifecycleDivergence.lifecycleKey ?? 'lifecycle'} ${comparison.firstLifecycleDivergence.lifecycle?.join(' vs ') ?? ''}`)
    if (comparison.firstSupportFlicker && comparison.firstSupportDivergence?.tick !== comparison.firstSupportFlicker.tick) lines.push(`  first contact-set flicker (ignored): tick ${comparison.firstSupportFlicker.tick}`)
    if (comparison.firstSupportDivergence) lines.push(`  first persistent contact-set difference: tick ${comparison.firstSupportDivergence.tick} (${comparison.firstSupportDivergence.supportIds?.join(' vs ')})`)
    else lines.push('  first persistent contact-set difference: none')
    if (comparison.firstLateralDivergence) lines.push(`  first lateral pose difference: tick ${comparison.firstLateralDivergence.tick} dz ${formatNumber(comparison.firstLateralDivergence.positionDelta?.[2] ?? null)}`)
    else lines.push('  first lateral pose difference: none')
    if (comparison.firstPoseDivergence) lines.push(`  first pose divergence: tick ${comparison.firstPoseDivergence.tick} distance ${formatNumber(comparison.firstPoseDivergence.positionDistance)}`)
    if (comparison.knownGap) {
      const gap = comparison.knownGap
      lines.push(`Known gap classification: ${gap.classification}`)
      const status = (label: string, item: { window: [number, number] | null; tick: number | null; inside: boolean }) =>
        lines.push(`  ${label}: tick ${item.tick ?? 'never'}${item.window ? ` window ${JSON.stringify(item.window)}` : ' (no window)'} ${item.window ? item.inside ? 'OK' : 'VIOLATION' : ''}`.trimEnd())
      status('contact-set', gap.contact)
      status('lateral', gap.lateral)
      status('pose', gap.pose)
      if (gap.longitudinal) lines.push(`  longitudinal: ${gap.longitudinal.applicable ? gap.longitudinal.passed ? 'PASS' : 'FAIL' : 'not applicable'} through tick ${gap.longitudinal.throughTick}`)
      for (const violation of gap.violations) lines.push(`  VIOLATION: ${violation}`)
    }
    lines.push(`max |dx|/|dy|/|dz|: ${comparison.maxAbsDelta.map(value => formatNumber(value)).join(' / ')}`)
    if (comparison.missingEvents.rapier.length || comparison.missingEvents.ivp.length) lines.push(`missing events: rapier [${comparison.missingEvents.rapier.join(', ')}] ivp [${comparison.missingEvents.ivp.join(', ')}]`)
    if (comparison.unavailable.rapier.length) lines.push(`rapier unavailable fields: ${comparison.unavailable.rapier.join(', ')}`)
    if (comparison.unavailable.ivp.length) lines.push(`ivp unavailable fields: ${comparison.unavailable.ivp.join(', ')}`)
  }
  for (const item of determinism) {
    if (!item.assessed) lines.push(`determinism ${item.solver}: unassessed (${item.runs} run, needs --repeat 2)`)
    else lines.push(`determinism ${item.solver}: ${item.runs} runs, ${item.bitIdentical ? 'bit-identical' : `differs at tick ${item.firstDifferenceTick} (${item.firstDifferencePath})`}`)
  }
  const failed = assertions.filter(result => !result.passed)
  const skippedAssertions = assertions.filter(result => result.skipped)
  if (failed.length) {
    lines.push(`assertion failures: ${failed.length}`)
    for (const result of failed) lines.push(`  ${result.solver}: ${result.detail}`)
  } else if (assertions.length) lines.push(`assertions: ${assertions.length - skippedAssertions.length}/${assertions.length} passed${skippedAssertions.length ? ` (${skippedAssertions.length} backend-specific skipped)` : ''}`)
  else lines.push('assertions: none')
  return lines.join('\n') + '\n'
}

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2))
  if (flags.help === true || flags.h === true) {
    console.log('usage: npm run harness -- <scenario> [--solver rapier|ivp|both] [--repeat N] [--contacts] [--out DIR] [--timeout SECONDS] [--list]')
    console.log('       The authored graph session runs on both solvers; IVP needs the native module (scripts/build-ivp-simulation.py).')
    return 0
  }
  if (flags.list === true) {
    for (const scenario of HARNESS_SCENARIOS) console.log(`${scenario.id} (level ${scenario.level + 1}, max ${scenario.maxTicks} ticks)`)
    return 0
  }
  const scenarioId = positional[0]
  if (!scenarioId) {
    console.error('harness: missing scenario id (use --list to see the scenarios)')
    return 2
  }
  const scenario = harnessScenario(scenarioId)
  if (!scenario) {
    console.error(`harness: unknown scenario ${scenarioId} (available: ${HARNESS_SCENARIOS.map(item => item.id).join(', ')})`)
    return 2
  }
  const solverArg = typeof flags.solver === 'string' ? flags.solver : 'rapier'
  if (solverArg !== 'rapier' && solverArg !== 'ivp' && solverArg !== 'both') {
    console.error(`harness: invalid solver ${solverArg}`)
    return 2
  }
  const repeat = Math.max(1, Number(typeof flags.repeat === 'string' ? flags.repeat : '1') || 1)
  const git = resolveGitMetadata()
  const detail = flags.contacts === true || flags['verbose-contacts'] === true
  const timeoutMs = Math.max(1, Number(typeof flags.timeout === 'string' ? flags.timeout : '600') || 600) * 1000
  const outRoot = typeof flags.out === 'string' ? resolve(flags.out) : join(repoRoot, '.local', 'harness', scenario.id)
  const mjs = join(repoRoot, '.local', 'ivp-simulation', 'ivp-simulation.mjs')
  const wasm = join(repoRoot, '.local', 'ivp-simulation', 'ivp-simulation.wasm')
  const nativeAvailable = existsSync(mjs) && existsSync(wasm)
  if (solverArg !== 'rapier' && !nativeAvailable) {
    console.error(`harness: IVP runs require the native module at ${join('.local', 'ivp-simulation')} (run scripts/build-ivp-simulation.py); refusing to silently degrade`)
    return 1
  }
  const requested: HarnessSolver[] = solverArg === 'both' ? ['rapier', 'ivp'] : [solverArg === 'ivp' ? 'ivp' : 'rapier']
  const skipped = requested.filter(solver => solver === 'ivp' && !nativeAvailable)
  const active = requested.filter(solver => activeSolver(solver, nativeAvailable))
  const chrome = chromeExecutable()
  if (active.length && !chrome) {
    console.error('harness: chrome-headless-shell.exe not found; set BALLANCE_CHROME or install .tools/chrome-headless')
    return 1
  }
  const runs: HarnessRun[] = []
  for (const solver of active) for (let run = 1; run <= repeat; run++) runs.push({ solver, run })
  const outputDirectory = runDirectory(outRoot)
  mkdirSync(outputDirectory, { recursive: true })
  const assertions: HarnessAssertionResult[] = []
  const determinism: HarnessDeterminism[] = []
  const ticks = new Map<string, number>()
  let server: Awaited<ReturnType<typeof createViteServer>> | undefined
  let child: ReturnType<typeof spawn> | undefined
  let profile: string | undefined
  let timer: NodeJS.Timeout | undefined
  let shuttingDown = false
  const onSignal = () => {
    if (shuttingDown) process.exit(130)
    shuttingDown = true
    if (timer) clearTimeout(timer)
    killChrome(child?.pid)
    sleepSync(400)
    removeProfile(profile)
    void server?.close().catch(() => undefined).finally(() => process.exit(130))
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    if (!runs.length) {
      const summary = buildSummary(scenario.id, null, assertions, ticks, skipped, determinism)
      writeFileSync(join(outputDirectory, 'summary.txt'), summary)
      process.stdout.write(summary)
      return 0
    }
    const port = await freePort()
    const results = new Map<string, HarnessResultPayload>()
    let resolveAll: () => void = () => undefined
    let rejectAll: (error: Error) => void = () => undefined
    const completed = new Promise<void>((resolvePromise, rejectPromise) => { resolveAll = resolvePromise; rejectAll = rejectPromise })
    const keyOf = (payload: HarnessRun) => `${payload.solver}:${payload.run}`
    const expected = new Set(runs.map(keyOf))
    const startedAt = Date.now()
    const onResult = (payload: HarnessResultPayload) => {
      if (payload.status === 'error') { rejectAll(new Error(`${payload.solver} run ${payload.run}: ${payload.error}${payload.stack ? `\n${payload.stack}` : ''}`)); return }
      if (payload.meta) Object.assign(payload.meta, git)
      results.set(keyOf(payload), payload)
      const wall = ((Date.now() - startedAt) / 1000).toFixed(1)
      const notes = payload.meta?.notes?.length ? ` notes: ${payload.meta.notes.join('; ')}` : ''
      process.stdout.write(`[harness] received ${payload.solver} run ${payload.run}: ${payload.meta?.ticks ?? '?'} ticks, sim ${payload.meta?.simMs?.toFixed(0) ?? '?'} ms, wall ${wall} s${notes}\n`)
      if ([...expected].every(key => results.has(key))) resolveAll()
    }
    server = await createViteServer({
      root: repoRoot,
      configFile: false,
      logLevel: 'error',
      clearScreen: false,
      define: { 'import.meta.env.VITE_IVP_MODULE_URL': JSON.stringify('/ivp/ivp-simulation.mjs') },
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
      plugins: [localOriginalAssets(), resultPlugin(onResult)],
    })
    await server.listen()
    process.stdout.write(`[harness] vite listening on http://127.0.0.1:${port}\n`)
    for (const solver of skipped) process.stdout.write(`[harness] ${solver}: SKIPPED (native IVP module unavailable)\n`)
    profile = mkdtempSync(join(tmpdir(), 'ballance-harness-'))
    const base = `http://127.0.0.1:${port}/harness.html`
    const urlFor = (run: HarnessRun, nextUrl?: string) => {
      const query = new URLSearchParams({ scenario: scenario.id, solver: run.solver, run: String(run.run), detail: detail ? '1' : '0' })
      if (nextUrl) query.set('next', nextUrl)
      return `${base}?${query.toString()}`
    }
    const chain = (index: number): string | undefined => {
      const run = runs[index]
      if (!run) return undefined
      return urlFor(run, chain(index + 1))
    }
    const urls = runs.map((_, index) => chain(index)!)
    const argumentsList = [
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--window-size=320,240', '--enable-logging=stderr',
      urls[0]!,
    ]
    child = spawn(chrome!, argumentsList, { stdio: ['ignore', 'ignore', 'pipe'] })
    process.stdout.write(`[harness] chrome pid ${child.pid}, ${runs.length} run(s) queued\n`)
    const chromeErrors: string[] = []
    child.stderr?.on('data', chunk => { chromeErrors.push(String(chunk)); if (chromeErrors.length > 200) chromeErrors.shift() })
    await new Promise<void>((resolveChild, rejectChild) => {
      child!.once('error', rejectChild)
      child!.once('exit', code => { if (code) rejectChild(new Error(`chrome exited with code ${code}\n${chromeErrors.slice(-20).join('')}`)) })
      timer = setTimeout(() => rejectAll(new Error(`timed out after ${timeoutMs} ms waiting for ${results.size}/${expected.size} harness runs`)), timeoutMs)
      completed.then(resolveChild).catch(rejectChild)
    })
    if (timer) clearTimeout(timer)
    for (const run of runs) {
      const payload = results.get(keyOf(run))!
      const rows = (payload.jsonl ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
      ticks.set(`${run.solver}${run.run > 1 ? `#${run.run}` : ''}`, rows.length)
      const stem = run.solver
      const file = run.run === 1 ? `${stem}.jsonl` : `${stem}.run${run.run}.jsonl`
      writeFileSync(join(outputDirectory, file), rows.map((row: unknown) => JSON.stringify(row)).join('\n') + '\n')
      if (run.run === 1) assertions.push(...runAssertions(scenario.assertions ?? [], rows, run.solver))
    }
    writeFileSync(join(outputDirectory, 'meta.json'), JSON.stringify(runs.map(run => results.get(keyOf(run))!.meta ?? null), null, 2) + '\n')
    const runRows = (run: HarnessRun) => (results.get(keyOf(run))!.jsonl ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
    for (const solver of active) {
      const solverRuns = runs.filter(run => run.solver === solver)
      if (!solverRuns.length) continue
      determinism.push(compareDeterminism(solver, solverRuns.map(run => ({ scenario: scenario.id, solver, meta: results.get(keyOf(run))!.meta!, rows: runRows(run) }))))
    }
    const runResult = (solver: HarnessSolver): HarnessRunResult | null => {
      const payload = results.get(keyOf({ solver, run: 1 }))
      if (!payload?.jsonl || !payload.meta) return null
      return { scenario: scenario.id, solver, meta: payload.meta, rows: payload.jsonl.split('\n').filter(Boolean).map(line => JSON.parse(line)) }
    }
    const comparison = compareTraces(scenario, runResult('rapier'), runResult('ivp'), determinism)
    if (comparison) writeFileSync(join(outputDirectory, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n')
    writeFileSync(join(outputDirectory, 'assertions.json'), JSON.stringify(assertions, null, 2) + '\n')
    const summary = buildSummary(scenario.id, comparison, assertions, ticks, skipped, determinism)
    writeFileSync(join(outputDirectory, 'summary.txt'), summary)
    process.stdout.write(summary)
    const determinismFailed = determinism.some(item => item.assessed && item.bitIdentical === false)
    return assertions.some(result => !result.passed) || (comparison?.knownGap?.violations.length ?? 0) > 0 || determinismFailed ? 1 : 0
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    if (timer) clearTimeout(timer)
    try { await server?.close() } catch { /* best effort */ }
    killChrome(child?.pid)
    sleepSync(300)
    removeProfile(profile)
  }
}

function activeSolver(solver: HarnessSolver, nativeAvailable: boolean) {
  return solver !== 'ivp' || nativeAvailable
}

main().then(code => { process.exitCode = code }).catch(error => {
  console.error(`harness: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
