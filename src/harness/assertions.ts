import type { HarnessAssertion, HarnessAssertionResult, HarnessEventName, HarnessRange, HarnessSolver, HarnessTickRecord } from './types.ts'

type Value = unknown

function pathValue(record: HarnessTickRecord, path: string): Value {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let current: unknown = record
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function eventTick(rows: HarnessTickRecord[], event: HarnessEventName): number | undefined {
  for (const row of rows) if (row.events.includes(event)) return row.tick
  return undefined
}

function resolveRange(range: HarnessRange | undefined, rows: HarnessTickRecord[], fallback: number): number | null {
  if (range === undefined) return fallback
  if (typeof range === 'number') return range
  const tick = eventTick(rows, range.event)
  return tick === undefined ? null : tick + (range.offset ?? 0)
}

function ticksBetween(rows: HarnessTickRecord[], from: number, to: number) {
  return rows.filter(row => row.tick >= from && row.tick <= to)
}

function compare(actual: Value, op: string, expected: Value, tolerance = 0) {
  if (actual === undefined || actual === null) return false
  switch (op) {
    case 'eq': return actual === expected
    case 'neq': return actual !== expected
    case 'gt': return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case 'gte': return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
    case 'lt': return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case 'lte': return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
    case 'approx': return typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) <= tolerance
    default: return false
  }
}

export function runAssertions(assertions: HarnessAssertion[], rows: HarnessTickRecord[], solver: HarnessSolver): HarnessAssertionResult[] {
  const last = rows.length - 1
  return assertions.map(assertion => {
    if (assertion.solver && assertion.solver !== solver) return { assertion, solver, passed: true, skipped: true, detail: `not applicable to ${solver}` }
    const fail = (detail: string): HarnessAssertionResult => ({ assertion, solver, passed: false, detail })
    const pass = (detail: string): HarnessAssertionResult => ({ assertion, solver, passed: true, detail })
    if (assertion.kind === 'event' || assertion.kind === 'eventAbsent') {
      const event = assertion.event!
      const tick = eventTick(rows, event)
      if (assertion.kind === 'eventAbsent') return tick === undefined ? pass(`${event} absent`) : fail(`${event} occurred at tick ${tick}`)
      if (tick === undefined) return fail(`${event} never occurred`)
      const from = resolveRange(assertion.from, rows, 0)
      const to = resolveRange(assertion.to, rows, last)
      if (from === null || to === null) return fail(`${event} range depends on a missing event`)
      return tick >= from && tick <= to ? pass(`${event} at tick ${tick} within [${from}, ${to}]`) : fail(`${event} at tick ${tick} outside [${from}, ${to}]`)
    }
    if (assertion.kind === 'phase') {
      const from = resolveRange(assertion.from, rows, 0)
      const to = resolveRange(assertion.to, rows, last)
      if (from === null || to === null) return fail('phase range depends on a missing event')
      const window = ticksBetween(rows, from, to)
      if (!window.length) return fail(`no ticks in [${from}, ${to}]`)
      const bad = window.find(row => row.lifecycle.finishPhase !== assertion.phase)
      return bad ? fail(`tick ${bad.tick} finishPhase=${bad.lifecycle.finishPhase}, expected ${assertion.phase}`) : pass(`finishPhase=${assertion.phase} through [${from}, ${to}]`)
    }
    const path = assertion.path!
    if (assertion.op === 'equalAtTicks') {
      const resolved = (assertion.ticks ?? []).map(range => resolveRange(range, rows, -1))
      if (resolved.some(tick => tick === null || tick < 0)) return fail('equalAtTicks range depends on a missing event')
      const values = resolved.map(tick => pathValue(rows[tick!]!, path))
      const expected = JSON.stringify(values[0])
      const mismatch = values.findIndex(value => JSON.stringify(value) !== expected)
      return mismatch < 0 ? pass(`${path} stable across ${resolved.join(',')}`) : fail(`${path} differs at tick ${resolved[mismatch]}: ${JSON.stringify(values[mismatch])} versus ${expected}`)
    }
    const from = resolveRange(assertion.from, rows, 0)
    const to = resolveRange(assertion.to, rows, last)
    if (from === null || to === null) return fail(`${path} range depends on a missing event`)
    const window = ticksBetween(rows, from, to)
    if (!window.length) return fail(`no ticks in [${from}, ${to}]`)
    if (assertion.op === 'someMatch' || assertion.op === 'noneMatch') {
      const pattern = new RegExp(String(assertion.value))
      const matches = window.filter(row => {
        const value = pathValue(row, path)
        return Array.isArray(value) && value.some(entry => pattern.test(String(entry)))
      })
      if (assertion.op === 'someMatch') return matches.length ? pass(`${path} matched at tick ${matches[0]!.tick}`) : fail(`${path} never matched ${assertion.value}`)
      return matches.length ? fail(`${path} matched ${assertion.value} at tick ${matches[0]!.tick}`) : pass(`${path} never matched ${assertion.value}`)
    }
    if (assertion.op === 'maxGte') {
      const values = window.map(row => pathValue(row, path)).filter((value): value is number => typeof value === 'number')
      if (!values.length) return fail(`no numeric ${path} in [${from}, ${to}]`)
      const peak = Math.max(...values)
      return peak >= Number(assertion.value) ? pass(`${path} peaked at ${peak} >= ${assertion.value} through [${from}, ${to}]`) : fail(`${path} peaked at ${peak} below ${assertion.value} through [${from}, ${to}]`)
    }
    const bad = window.find(row => !compare(pathValue(row, path), assertion.op!, assertion.value, assertion.tolerance))
    return bad
      ? fail(`tick ${bad.tick} ${path}=${JSON.stringify(pathValue(bad, path))} fails ${assertion.op} ${JSON.stringify(assertion.value)}`)
      : pass(`${path} satisfies ${assertion.op} ${JSON.stringify(assertion.value)} through [${from}, ${to}]`)
  })
}
