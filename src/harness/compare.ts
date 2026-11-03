import type { HarnessComparison, HarnessDeterminism, HarnessDivergence, HarnessEventName, HarnessEventTiming, HarnessKnownGap, HarnessKnownGapWindow, HarnessRunResult, HarnessScenario, HarnessSolver, HarnessTickRecord } from './types.ts'

const LIFECYCLE_KEYS = ['finishPhase', 'checkpoint', 'activeSector', 'physicalized', 'phase', 'activeFanNames'] as const

function lifecycleEqual(a: unknown, b: unknown) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => value === b[index])
  return a === b
}

export function orientationAngle(a: readonly number[], b: readonly number[]) {
  // Backend quaternions can drift a few ulps away from unit length (Rapier in
  // particular). Normalize before taking the angle; otherwise identical
  // rotations report a spurious ~1e-3 rad difference from the norm defect.
  const an = Math.hypot(a[0]!, a[1]!, a[2]!, a[3]!)
  const bn = Math.hypot(b[0]!, b[1]!, b[2]!, b[3]!)
  if (an === 0 || bn === 0) return 0
  const dot = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!) / (an * bn)
  return 2 * Math.acos(Math.min(1, dot))
}

function divergenceAt(rapier: HarnessTickRecord, ivp: HarnessTickRecord): HarnessDivergence {
  const rp = rapier.ball.position, ip = ivp.ball.position
  const rv = rapier.ball.linearVelocity, iv = ivp.ball.linearVelocity
  const rw = rapier.ball.angularVelocity, iw = ivp.ball.angularVelocity
  const dx = rp[0] - ip[0], dy = rp[1] - ip[1], dz = rp[2] - ip[2]
  const lifecycleKey = firstLifecycleMismatch(rapier, ivp) ?? null
  return {
    tick: rapier.tick,
    positionDelta: [dx, dy, dz],
    positionDistance: Math.hypot(dx, dy, dz),
    velocityDelta: [rv[0] - iv[0], rv[1] - iv[1], rv[2] - iv[2]],
    angularVelocityDelta: [rw[0] - iw[0], rw[1] - iw[1], rw[2] - iw[2]],
    orientationDeltaAngle: orientationAngle(rapier.ball.rotation, ivp.ball.rotation),
    supportIds: [rapier.contacts.supportIds.join('|'), ivp.contacts.supportIds.join('|')],
    lifecycle: lifecycleKey ? [String(rapier.lifecycle[lifecycleKey]), String(ivp.lifecycle[lifecycleKey])] : null,
    lifecycleKey,
  }
}

function eventMap(rows: HarnessTickRecord[]) {
  const map = new Map<HarnessEventName, number>()
  for (const row of rows) for (const event of row.events) if (!map.has(event)) map.set(event, row.tick)
  return map
}

function firstLifecycleMismatch(a: HarnessTickRecord, b: HarnessTickRecord) {
  return LIFECYCLE_KEYS.find(key => !lifecycleEqual(a.lifecycle[key], b.lifecycle[key]))
}

function firstDifference(a: unknown, b: unknown, path: string): string | null {
  if (Object.is(a, b)) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`
    for (let i = 0; i < a.length; i++) {
      const found = firstDifference(a[i], b[i], `${path}[${i}]`)
      if (found) return found
    }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`)
      if (found) return found
    }
    return null
  }
  return path
}

export function compareDeterminism(solver: HarnessSolver, runs: HarnessRunResult[]): HarnessDeterminism {
  const first = runs[0]
  const second = runs[1]
  if (!first || !second) return { solver, runs: runs.length, assessed: false, bitIdentical: null, firstDifferenceTick: null, firstDifferencePath: null, maxPositionDistance: null }
  let firstDifferenceTick: number | null = null
  let firstDifferencePath: string | null = null
  let maxPositionDistance = 0
  const length = Math.min(first.rows.length, second.rows.length)
  for (let tick = 0; tick < length; tick++) {
    const a = first.rows[tick]!, b = second.rows[tick]!
    const distance = Math.hypot(a.ball.position[0] - b.ball.position[0], a.ball.position[1] - b.ball.position[1], a.ball.position[2] - b.ball.position[2])
    maxPositionDistance = Math.max(maxPositionDistance, distance)
    if (firstDifferenceTick === null) {
      const path = firstDifference({ ...a, scenario: '' }, { ...b, scenario: '' }, '')
      if (path !== null) { firstDifferenceTick = tick; firstDifferencePath = path }
    }
  }
  return {
    solver,
    runs: runs.length,
    assessed: true,
    bitIdentical: firstDifferenceTick === null && first.rows.length === second.rows.length,
    firstDifferenceTick,
    firstDifferencePath,
    maxPositionDistance,
  }
}

function wakeWindow(tick: number | null, window: [number, number] | undefined): HarnessKnownGapWindow {
  if (!window) return { window: null, tick, inside: tick !== null }
  return { window, tick, inside: tick !== null && tick >= window[0] && tick <= window[1] }
}

export function compareTraces(scenario: HarnessScenario, rapier: HarnessRunResult | null, ivp: HarnessRunResult | null, determinism: HarnessDeterminism[]): HarnessComparison | null {
  if (!rapier || !ivp) return null
  const rapierRows = new Map(rapier.rows.map(row => [row.tick, row]))
  const ivpRows = new Map(ivp.rows.map(row => [row.tick, row]))
  const poseTolerance = scenario.compare?.poseTolerance ?? 0
  const poseToleranceNote = scenario.compare?.poseTolerance === undefined
    ? 'exact equality (scenario does not declare poseTolerance)'
    : 'scenario-declared pose tolerance, render units (0.25 x original model units)'
  const supportPersistence = Math.max(1, scenario.compare?.supportPersistence ?? 1)
  const startTick = scenario.compare?.startTick ?? 0
  const lastTick = Math.max(...rapierRows.keys(), ...ivpRows.keys())
  const declaredEndTick = Math.min(scenario.compare?.endTick ?? lastTick, lastTick)
  let truncated: HarnessComparison['truncated'] = null
  for (const [solver, rows] of [['rapier', rapierRows], ['ivp', ivpRows]] as const) {
    for (const [tick, row] of rows) {
      if (row.events.includes('ball.dead') && (!truncated || tick < truncated.tick)) truncated = { tick, event: 'ball.dead', solver }
    }
  }
  const canonicalEndTick = truncated ? Math.min(declaredEndTick, truncated.tick - 1) : declaredEndTick
  let firstPoseDivergence: HarnessDivergence | null = null
  let firstLateralDivergence: HarnessDivergence | null = null
  let firstSupportFlicker: HarnessDivergence | null = null
  let firstSupportDivergence: HarnessDivergence | null = null
  let firstLifecycleDivergence: HarnessDivergence | null = null
  let maxPositionDistance = 0
  const maxAbsDelta: [number, number, number] = [0, 0, 0]
  const maxAbsVelocityDelta: [number, number, number] = [0, 0, 0]
  const maxAbsAngularVelocityDelta: [number, number, number] = [0, 0, 0]
  let maxOrientationDeltaAngle = 0
  for (let tick = startTick; tick <= canonicalEndTick; tick++) {
    const a = rapierRows.get(tick), b = ivpRows.get(tick)
    if (!a || !b) continue
    const divergence = divergenceAt(a, b)
    const [dx, dy, dz] = divergence.positionDelta!
    maxPositionDistance = Math.max(maxPositionDistance, divergence.positionDistance ?? 0)
    maxAbsDelta[0] = Math.max(maxAbsDelta[0], Math.abs(dx)); maxAbsDelta[1] = Math.max(maxAbsDelta[1], Math.abs(dy)); maxAbsDelta[2] = Math.max(maxAbsDelta[2], Math.abs(dz))
    divergence.velocityDelta!.forEach((value, index) => maxAbsVelocityDelta[index] = Math.max(maxAbsVelocityDelta[index]!, Math.abs(value)))
    divergence.angularVelocityDelta!.forEach((value, index) => maxAbsAngularVelocityDelta[index] = Math.max(maxAbsAngularVelocityDelta[index]!, Math.abs(value)))
    maxOrientationDeltaAngle = Math.max(maxOrientationDeltaAngle, divergence.orientationDeltaAngle ?? 0)
    if (!firstPoseDivergence && (divergence.positionDistance ?? 0) > poseTolerance) firstPoseDivergence = divergence
    if (!firstLateralDivergence && Math.abs(dz) > poseTolerance) firstLateralDivergence = divergence
    const supportDiffers = a.contacts.supportIds.join('|') !== b.contacts.supportIds.join('|')
    if (supportDiffers && !firstSupportFlicker) firstSupportFlicker = divergence
    if (supportDiffers && !firstSupportDivergence) {
      let persistent = true
      for (let offset = 1; offset < supportPersistence; offset++) {
        const nextA = rapierRows.get(tick + offset), nextB = ivpRows.get(tick + offset)
        if (!nextA || !nextB || nextA.contacts.supportIds.join('|') === nextB.contacts.supportIds.join('|')) { persistent = false; break }
      }
      if (persistent) firstSupportDivergence = divergence
    }
    if (!firstLifecycleDivergence && divergence.lifecycleKey) firstLifecycleDivergence = divergence
  }
  const rapierEvents = eventMap(rapier.rows), ivpEvents = eventMap(ivp.rows)
  const eventNames = new Set<HarnessEventName>([...rapierEvents.keys(), ...ivpEvents.keys()])
  const eventTiming: HarnessEventTiming[] = [...eventNames].map(event => {
    const r = rapierEvents.get(event) ?? null, i = ivpEvents.get(event) ?? null
    return { event, rapier: r, ivp: i, deltaTicks: r === null || i === null ? null : i - r }
  }).sort((a, b) => (a.rapier ?? a.ivp ?? 0) - (b.rapier ?? b.ivp ?? 0))
  const firstEventDivergence = eventTiming.find(item => item.deltaTicks !== 0 && item.deltaTicks !== null) ?? eventTiming.find(item => item.deltaTicks === null) ?? null
  const known = scenario.compare?.knownGap
  let knownGap: HarnessKnownGap | null = null
  if (known) {
    const contact = wakeWindow(firstSupportDivergence?.tick ?? null, known.firstContactWindow)
    const lateral = wakeWindow(firstLateralDivergence?.tick ?? null, known.firstLateralWindow)
    const pose = wakeWindow(firstPoseDivergence?.tick ?? null, known.firstPoseWindow)
    const violations: string[] = []
    if (known.firstContactWindow && !contact.inside) violations.push(`first contact divergence at tick ${contact.tick ?? 'never'} outside known window ${JSON.stringify(known.firstContactWindow)}`)
    if (known.firstLateralWindow && !lateral.inside) violations.push(`first lateral divergence at tick ${lateral.tick ?? 'never'} outside known window ${JSON.stringify(known.firstLateralWindow)}`)
    if (known.firstPoseWindow && !pose.inside) violations.push(`first pose divergence at tick ${pose.tick ?? 'never'} outside known window ${JSON.stringify(known.firstPoseWindow)}`)
    knownGap = { classification: known.classification, contact, lateral, pose, longitudinal: null, violations }
  }
  const declaredTolerances = scenario.compare?.longitudinalPositionTolerance !== undefined || scenario.compare?.longitudinalVelocityTolerance !== undefined
  const positionTolerance = scenario.compare?.longitudinalPositionTolerance ?? 0
  const velocityTolerance = scenario.compare?.longitudinalVelocityTolerance ?? 0
  // Longitudinal parity covers the rolling lead-in only: it ends before the
  // first contact-set or lateral divergence, not at the static contact offset.
  const firstTrajectoryDivergence = Math.min(
    firstSupportDivergence?.tick ?? canonicalEndTick + 1,
    firstLateralDivergence?.tick ?? canonicalEndTick + 1,
  )
  const throughTick = Math.min(firstTrajectoryDivergence - 1, canonicalEndTick)
  const applicable = declaredTolerances && throughTick >= startTick
  const reason = !declaredTolerances ? 'scenario does not declare longitudinal tolerances' : throughTick < startTick ? 'no pre-divergence ticks in the canonical range' : null
  let maxAbsDeltaX = 0
  let maxAbsVelocityDeltaX = 0
  if (applicable) {
    for (let tick = startTick; tick <= throughTick; tick++) {
      const a = rapierRows.get(tick), b = ivpRows.get(tick)
      if (!a || !b) continue
      maxAbsDeltaX = Math.max(maxAbsDeltaX, Math.abs(a.ball.position[0] - b.ball.position[0]))
      maxAbsVelocityDeltaX = Math.max(maxAbsVelocityDeltaX, Math.abs(a.ball.linearVelocity[0] - b.ball.linearVelocity[0]))
    }
  }
  const longitudinalParity = {
    applicable,
    reason,
    throughTick,
    maxAbsDeltaX,
    maxAbsVelocityDeltaX,
    positionTolerance,
    velocityTolerance,
    passed: !applicable || (maxAbsDeltaX <= positionTolerance && maxAbsVelocityDeltaX <= velocityTolerance),
  }
  if (knownGap) knownGap.longitudinal = { applicable, passed: longitudinalParity.passed, throughTick }
  const unavailable = {
    rapier: capabilityNotes(rapier),
    ivp: capabilityNotes(ivp),
  }
  return {
    scenario: scenario.id,
    solvers: ['rapier', 'ivp'],
    ticks: { rapier: rapier.rows.length, ivp: ivp.rows.length },
    startTick,
    endTick: declaredEndTick,
    canonicalEndTick,
    truncated,
    poseTolerance,
    poseToleranceNote,
    supportPersistence,
    firstPoseDivergence,
    firstLateralDivergence,
    firstSupportFlicker,
    firstSupportDivergence,
    firstLifecycleDivergence,
    firstEventDivergence,
    maxPositionDistance,
    maxAbsDelta,
    maxAbsVelocityDelta,
    maxAbsAngularVelocityDelta,
    maxOrientationDeltaAngle,
    longitudinalParity,
    eventTiming,
    missingEvents: {
      rapier: [...ivpEvents.keys()].filter(event => !rapierEvents.has(event)),
      ivp: [...rapierEvents.keys()].filter(event => !ivpEvents.has(event)),
    },
    knownGap,
    unavailable,
    determinism,
  }
}

function capabilityNotes(run: HarnessRunResult) {
  const notes: string[] = []
  if (!run.meta.capabilities.velocityInjection) notes.push('linear/angular velocity injection')
  if (!run.meta.capabilities.contactManifoldDetail) notes.push('detailed contact manifolds')
  if (!run.meta.capabilities.backendBodyCount) notes.push('backend body count')
  return notes
}
