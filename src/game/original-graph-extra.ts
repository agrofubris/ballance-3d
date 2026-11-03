// TT_Toolbox_RT's TT Extra (the extra-point pickup: a centre billboard and up
// to six small balls that orbit, fly away and home in on the ball) and
// TT_Timer, decoded from the shipped DLL (addresses below). The x87 code is
// modelled as elsewhere: every float store is Math.fround, values kept on the
// FPU stack stay doubles.
import type { BehaviorCallback, BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import type { GraphExtraBinding, GraphTimerBinding } from './original-graph-bindings.ts'
import { originalMatrixFromRotation } from './original-matrix.ts'
import { originalRotateVector } from './original-orientation.ts'

const f = Math.fround
type Vec3 = [number, number, number]

const need = <T>(context: BehaviorContext, value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${context.node.name} ${context.node.index} needs a ${what} binding`)
  return value
}
const number = (value: GraphParameterValue) => typeof value === 'number' ? value : Number(value ?? 0)
/** A BOOL parameter read into a one byte variable (`test al, al`). */
const lowByteBool = (value: GraphParameterValue) => typeof value === 'boolean' ? value : (Number(value ?? 0) & 0xff) !== 0
const floats = (value: GraphParameterValue, count: number, what: string): number[] => {
  if (!Array.isArray(value) || value.length < count) throw new Error(`${what} is not a ${count}-float parameter`)
  return value.slice(0, count).map(item => f(Number(item)))
}

export class OriginalTtTimerManager implements GraphTimerBinding {
  running = true
  elapsed = 0
  reset() { this.running = true; this.elapsed = 0 }
  pause() { this.running = false }
  play() { this.running = true }
  now() { return this.elapsed }
  elapse(deltaMs: number) { if (this.running) this.elapsed = f(this.elapsed + f(deltaMs)) }
}

/**
 * On/Reset (0), Pause (1), Play (2), Off (3); Elapsed Time out (float ms).
 * The clock is the shared TT timer manager, not per block. Inputs are tested
 * in order; On/Reset falls through to the update, Pause and Play stay active,
 * Off resets (it does NOT stop the clock: reset() sets running) and ends.
 * The update outputs `float(now + delta)` even while paused; only the manager's
 * own time is gated by `running`.
 */
const ttTimer: BehaviorFn = context => {
  const timer = need(context, context.timer, 'timer manager')
  if (context.isInputActive(0)) { timer.reset(); context.consumeInput(0); context.activate(0) }
  if (context.isInputActive(1)) { timer.pause(); context.consumeInput(1); context.activate(1); context.wait(); return }
  if (context.isInputActive(2)) { timer.play(); context.consumeInput(2); context.activate(2); context.wait(); return }
  if (context.isInputActive(3)) { timer.reset(); context.consumeInput(3); context.activate(3); return }
  const delta = f(context.deltaMs)
  context.setOutput(0, f(timer.now() + delta))
  timer.elapse(delta)
  context.wait()
}

const EXTRA_NONE = -1, EXTRA_IDLE = 0, EXTRA_ACTIVATED = 1, EXTRA_HIT = 2, EXTRA_END = 3
/** Input pins. */
const IN = { ball: 0, count: 1, activationDistance: 2, collDistance: 3, rotationSpeed: 4, awayForce: 5, awayDamping: 6, force: 7, damping: 8, forceWidth: 9, flyAwayTime: 10, hitFrames: 11, flying: 12, framedelay: 13 }
/** Locals (the list, shadow and centre objects live in the block state). */
const LOC = { activation: 0, status: 4, initialized: 5, timeCounter: 6, ballCounter: 7, timeValue: 8, nextCheck: 9, awayPosition: 10, exactness: 11 }
/** Rotation axes of small balls 1..6 (float constants in the idle branch; 0.707 is 0x3F34FDF4). */
const AXES: Vec3[] = [[0, 1, 0], [0, 0, 1], [1, 0, 0], [f(0.5), f(0.5), f(0.707)], [f(0.707), -f(0.707), 0], [-f(0.5), -f(0.5), f(0.707)]]
const PREFIX_CENTER = 14, PREFIX_BALL = 18
const F_0_001 = f(0.001)

interface SmallBall { entity: string; position: Vec3; force: number; active: boolean }
interface ExtraState { balls?: SmallBall[]; shadow?: string; center?: string }

/** 0x100019D2: the first child whose name, from `offset`, begins with `suffix` (compared over strlen(suffix) bytes). */
function childOf(extra: GraphExtraBinding, offset: number, suffix: string, target: string): string | undefined {
  for (const child of extra.children(target)) {
    const name = extra.name(child)
    if (name.slice(offset, offset + suffix.length) === suffix && name.length >= offset + suffix.length) return child
  }
  return undefined
}

/** 0x10002360: ((dz^2 + dy^2) + dx^2), unrounded x87 intermediates. */
const distanceSquared = (a: Vec3, b: Vec3) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
  return (dz * dz + dy * dy) + dx * dx
}

function deactivateExtra(context: BehaviorContext, extra: GraphExtraBinding, state: ExtraState) {
  // 0x10002160. A missing list returns CKBR_PARAMETERERROR, ignored by the caller.
  if (!state.balls) return
  const flying = lowByteBool(context.input(IN.flying))
  if (state.center) {
    const child = extra.children(state.center)[0]
    const script = child ? context.scriptOf(child, 0) : undefined
    if (script) context.script(script, false)
    extra.show(state.center, false)
  }
  if (state.shadow && !flying) extra.show(state.shadow, false)
  for (const ball of state.balls) {
    const child = extra.children(ball.entity)[0]
    const script = child ? context.scriptOf(child, 0) : undefined
    if (script) context.script(script, false)
    extra.show(ball.entity, false)
    if (script) context.script(script, false)
  }
}

function uninitializeExtra(context: BehaviorContext, extra: GraphExtraBinding, state: ExtraState) {
  // 0x10001F10 + 0x10001EC0: scripts of the balls' frames off, balls HIDDEN (push 0; the reconstruction's
  // Show() default would show them), the list freed, Initialized = FALSE, Status = -1.
  for (const ball of state.balls ?? []) {
    const child = extra.children(ball.entity)[0]
    const script = child ? context.scriptOf(child, 0) : undefined
    if (script) context.script(script, false)
    extra.show(ball.entity, false)
  }
  state.balls = undefined
  context.setLocal(LOC.initialized, false)
  context.setLocal(LOC.status, EXTRA_NONE)
}

function initializeExtra(context: BehaviorContext, extra: GraphExtraBinding, state: ExtraState) {
  // 0x10001AC0
  let status = Math.trunc(number(context.local(LOC.status)))
  if (status === EXTRA_NONE) state.balls = undefined
  else if (status === EXTRA_ACTIVATED) uninitializeExtra(context, extra, state)
  else if (state.balls) return
  let count = Math.trunc(number(context.input(IN.count)))
  if (count <= 0) count = 1
  if (count > AXES.length) throw new Error(`TT Extra ${context.node.index}: ${count} small balls (the DLL has rotation axes for 6)`)
  context.setLocal(LOC.ballCounter, count)
  const target = context.targetName()
  if (!target) throw new Error(`TT Extra ${context.node.index} has no target (CKBR_OWNERERROR)`)
  const flying = lowByteBool(context.input(IN.flying))
  const floor = childOf(extra, PREFIX_CENTER, 'Floor', target)
  const center = childOf(extra, PREFIX_CENTER, 'Ball0', target)
  if ((!flying && !floor) || !center) {
    throw new Error(`TT Extra ${context.node.index}: ${!floor ? 'no Floorglowobject ' : ''}${!center ? 'no Centerbillboard ' : ''}in the hierarchy`)
  }
  state.shadow = floor
  state.center = center
  if (floor) { extra.deactivate(floor); extra.show(floor, false) }
  const centerFrame = extra.children(center)[0]
  if (!centerFrame) throw new Error('TT Extra: no Frame at the Centerbillboard')
  const centerScript = context.scriptOf(centerFrame, 0)
  if (!centerScript) throw new Error('TT Extra: no Script at the Centerbillboard frame')
  context.script(centerScript, false)
  extra.show(center, false)
  // Per-ball force: step = float(Forcewidth / count); running value starts at float(Force - step) and gains step per ball.
  const step = f(f(number(context.input(IN.forceWidth))) / count)
  let force = f(f(number(context.input(IN.force))) - step)
  const balls: SmallBall[] = []
  for (let i = 0; i < count; i++) {
    const entity = childOf(extra, PREFIX_BALL, String(i + 1), target)
    if (!entity) throw new Error('TT Extra: missing one or more billboards')
    const frame = extra.children(entity)[0]
    if (!frame) throw new Error('TT Extra: no Frame at one of the billboards')
    const script = context.scriptOf(frame, 0)
    if (!script) throw new Error('TT Extra: no Script at one of the billboard frames')
    context.script(script, false)
    extra.show(entity, false)
    const position = extra.position(entity)
    force = f(step + force)
    balls.push({ entity, position, force, active: true })
    context.script(script, false)
  }
  state.balls = balls
  context.setLocal(LOC.timeCounter, f(number(context.input(IN.flyAwayTime))))
  context.setLocal(LOC.initialized, true)
  context.setLocal(LOC.status, EXTRA_IDLE)
}

function activateExtra(context: BehaviorContext, extra: GraphExtraBinding, state: ExtraState) {
  // 0x10002030
  if (!state.balls) throw new Error('TT Extra has no small balls (CKBR_PARAMETERERROR)')
  const flying = lowByteBool(context.input(IN.flying))
  if (state.center) extra.show(state.center, true)
  if (state.shadow && !flying) extra.show(state.shadow, true)
  for (const ball of state.balls) {
    const child = extra.children(ball.entity)[0]
    const script = child ? context.scriptOf(child, 0) : undefined
    if (script) context.script(script, true, true)
    extra.show(ball.entity, true)
    if (script) context.script(script, true, true)
  }
}

function executeIdle(context: BehaviorContext, extra: GraphExtraBinding, state: ExtraState) {
  // 0x10002400
  const target = context.targetName()
  if (!target) throw new Error(`TT Extra ${context.node.index} has no target (CKBR_OWNERERROR)`)
  const ballName = context.inputObject(IN.ball)
  if (!ballName) throw new Error(`TT Extra ${context.node.index} has no Ball (CKBR_PARAMETERERROR)`)
  const ball = extra.position(ballName)
  const activation = f(number(context.input(IN.activationDistance)))
  const activationSquared = f(activation * activation)
  if (distanceSquared(extra.position(target), ball) <= activationSquared) {
    context.setLocal(LOC.status, EXTRA_ACTIVATED)
    const flying = lowByteBool(context.input(IN.flying))
    if (state.shadow && !flying) extra.show(state.shadow, false)
    if (state.center) {
      const child = extra.children(state.center)[0]
      const script = child ? context.scriptOf(child, 0) : undefined
      if (script) context.script(script, false)
      extra.show(state.center, false)
      if (child) {
        extra.show(child, true)
        if (script) context.script(script, true, true)
      }
    }
    if (!state.balls) throw new Error('TT Extra has no small balls (CKBR_PARAMETERERROR)')
    for (const small of state.balls) small.position = extra.position(small.entity)
    context.setOutput(0, 1)
    context.activate(0)
    context.setLocal(LOC.awayPosition, [ball[0], f(ball[1] - f(2.1)), ball[2]])
    return
  }
  const angle = f(f(number(context.local(LOC.timeValue))) * f(number(context.input(IN.rotationSpeed))))
  if (!state.balls) throw new Error('TT Extra has no small balls (CKBR_PARAMETERERROR)')
  state.balls.forEach((small, index) => {
    const axis = AXES[index]
    if (!axis) throw new Error('TT Extra: rotation axis past the sixth ball is stale stack data in the DLL')
    const rotated = originalRotateVector(originalMatrixFromRotation(axis, angle), extra.position(small.entity, target))
    const length = Math.sqrt((rotated[2] * rotated[2] + rotated[1] * rotated[1]) + rotated[0] * rotated[0])
    if (length !== 2) {
      const inv = 1 / length
      extra.setPosition(small.entity, [f(2 * f(rotated[0] * inv)), f(2 * f(rotated[1] * inv)), f(2 * (inv * rotated[2]))], target)
    } else extra.setPosition(small.entity, rotated, target)
  })
}

function executeActivated(context: BehaviorContext, extra: GraphExtraBinding, state: ExtraState) {
  // 0x10002870
  const saved = floats(context.local(LOC.awayPosition), 3, 'TT Extra Away Positionsave')
  const away: Vec3 = [saved[0]!, f(saved[1]! - 3), saved[2]!]
  const delta = f(context.deltaMs)
  const remaining = f(number(context.local(LOC.timeCounter)) - delta)
  if (remaining <= 0) { context.setLocal(LOC.status, EXTRA_HIT); return }
  context.setLocal(LOC.timeCounter, remaining)
  const awayForce = f(number(context.input(IN.awayForce)))
  const damping = f(number(context.input(IN.awayDamping)))
  const k = f(f(number(context.local(LOC.timeValue))) * awayForce)
  if (!state.balls) throw new Error('TT Extra has no small balls (CKBR_PARAMETERERROR)')
  for (const small of state.balls) {
    const old = small.position
    const cur = extra.position(small.entity)
    small.position = cur
    // dx stays unrounded on the x87 stack; dy and dz go through a float store.
    const dx = cur[0] - away[0], dy = f(cur[1] - away[1]), dz = f(cur[2] - away[2])
    extra.setPosition(small.entity, [
      f(((cur[0] - old[0]) * damping + dx * k) + cur[0]),
      f(((cur[1] - old[1]) * damping + dy * k) + cur[1]),
      f(((cur[2] - old[2]) * damping + dz * k) + cur[2]),
    ])
  }
}

function executeHit(context: BehaviorContext, extra: GraphExtraBinding, state: ExtraState) {
  // 0x10002A50
  let remaining = Math.trunc(number(context.local(LOC.ballCounter)))
  if (remaining <= 0) { context.setLocal(LOC.status, EXTRA_END); context.activate(2); return }
  const ballName = context.inputObject(IN.ball)
  if (!ballName) throw new Error(`TT Extra ${context.node.index} has no Ball (CKBR_PARAMETERERROR)`)
  const ball = extra.position(ballName)
  const damping = f(number(context.input(IN.damping)))
  if (!state.balls) throw new Error('TT Extra has no small balls (CKBR_PARAMETERERROR)')
  const timeValue = f(number(context.local(LOC.timeValue)))
  const collDistance = f(number(context.input(IN.collDistance)))
  const hitGroup = context.inputObject(IN.hitFrames)
  let hits = 0
  state.balls.forEach((small, index) => {
    if (!small.active) return
    const pos = extra.position(small.entity)
    // The distance is squared; Extra_Points CollDistance is compared as is.
    if (distanceSquared(pos, ball) <= collDistance) {
      hits++
      small.active = false
      remaining--
      context.setLocal(LOC.ballCounter, remaining)
      const child = extra.children(small.entity)[0]
      const script = child ? context.scriptOf(child, 0) : undefined
      if (script) context.script(script, false)
      extra.show(small.entity, false)
      if (hitGroup) {
        const frame = extra.groupObject(hitGroup, index)
        if (frame) {
          extra.setPosition(frame, extra.position(small.entity))
          const frameScript = context.scriptOf(frame, 0)
          if (frameScript) context.script(frameScript, true, true)
        }
      }
      return
    }
    const old = small.position
    small.position = pos
    const toward = (axis: 0 | 1 | 2) => f(((ball[axis] - pos[axis]) * small.force * timeValue + (pos[axis] - old[axis]) * damping) + pos[axis])
    extra.setPosition(small.entity, [toward(0), toward(1), toward(2)])
  })
  if (hits) { context.setOutput(0, hits); context.activate(1) }
}

const ttExtra: BehaviorFn = (context, state_) => {
  const state = state_ as ExtraState
  const extra = need(context, context.extra, 'entity tree')
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.setLocal(LOC.activation, false)
    deactivateExtra(context, extra, state)
    return
  }
  let initialized = lowByteBool(context.local(LOC.initialized))
  let active = false
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    // "Extra isn't initialized yet, this could slow all down." goes to the console.
    if (!initialized) { initializeExtra(context, extra, state); initialized = true }
    active = true
    context.setLocal(LOC.activation, true)
    context.setLocal(LOC.timeValue, f(f(context.deltaMs) * F_0_001))
    if (lowByteBool(context.local(LOC.exactness))) context.setLocal(LOC.nextCheck, Math.trunc(number(context.input(IN.framedelay))))
    activateExtra(context, extra, state)
  } else {
    if (context.isInputActive(2)) {
      context.consumeInput(2)
      if (!initialized) { initializeExtra(context, extra, state); return }
    } else active = lowByteBool(context.local(LOC.activation))
    if (!active || !initialized) { context.wait(); return }
  }
  if (lowByteBool(context.local(LOC.exactness))) {
    let next = Math.trunc(number(context.local(LOC.nextCheck))) - 1
    if (next === 0) {
      context.setLocal(LOC.timeValue, f(f(context.deltaMs) * F_0_001))
      next = Math.trunc(number(context.input(IN.framedelay)))
    }
    context.setLocal(LOC.nextCheck, next)
  }
  const status = Math.trunc(number(context.local(LOC.status)))
  if (status === EXTRA_IDLE) executeIdle(context, extra, state)
  else if (status === EXTRA_ACTIVATED) executeActivated(context, extra, state)
  else if (status === EXTRA_HIT) executeHit(context, extra, state)
  context.wait()
}

/**
 * TT Extra's behavior callback: CKM_BEHAVIORRESET and
 * CKM_BEHAVIORDEACTIVATESCRIPT (as DELETE and DETACH) uninitialise an
 * initialised block: the small balls' frame scripts stop, the balls hide and
 * Initialized/Status clear.
 */
const ttExtraCallback: BehaviorCallback = (context, state) => {
  if (!lowByteBool(context.local(LOC.initialized))) return
  uninitializeExtra(context, need(context, context.extra, 'entity tree'), state as ExtraState)
}

export const EXTRA_BEHAVIORS: BehaviorRegistry = {
  TT_Timer: ttTimer,
  'TT Extra': ttExtra,
}

export const EXTRA_CALLBACKS: Record<string, BehaviorCallback> = {
  'TT Extra': ttExtraCallback,
}
