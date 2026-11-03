// Physics behaviors from BuildingBlocks/physics_RT.dll and the recovered
// TT Set Dynamic Position / Per Second controls. Each behavior only talks to
// the engine through the GraphPhysicsBinding contract, so the runtime stays
// independent of the concrete physics backend.
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import { authoredVectorToBinding, type GraphForceSettings, type GraphJointSettings, type GraphPhysicsBody, type GraphSpringSettings } from './original-graph-bindings.ts'
import { originalCollisionGroups } from './original-collisions.ts'
import { originalDynamicPositionStep } from './original-dynamic-position.ts'

const number = (v: GraphParameterValue) => typeof v === 'number' ? v : Number(v ?? 0)
const f = Math.fround

function vector(value: GraphParameterValue): [number, number, number] | undefined {
  return Array.isArray(value) ? [number(value[0]), number(value[1]), number(value[2])] : undefined
}

function text(value: GraphParameterValue): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function targetName(context: BehaviorContext): string {
  return context.targetName()
}

// Behaviors that act on a list of targets (the authored `Physicalize Walls`
// and `De Physicalize` compounds) author the names as leading string inputs.
// The runtime value type has no string-array form, so the list is the run of
// string inputs before the first non-string input.
function leadingStringInputs(context: BehaviorContext): { names: string[]; offset: number } {
  const names: string[] = []
  let offset = 0
  while (offset < context.inputCount) {
    const value = context.input(offset)
    if (typeof value !== 'string' || value.length === 0) break
    names.push(value)
    offset++
  }
  return { names, offset }
}

function targetList(context: BehaviorContext): { names: string[]; offset: number } {
  const leading = leadingStringInputs(context)
  if (leading.names.length > 0) return leading
  const target = targetName(context)
  return { names: target.length > 0 ? [target] : [], offset: 0 }
}

// The authored identifiers are the IVP collision-group names. `Levelinit` uses
// the lower-case "ball", which is the same category as "Ball".
function collisionGroup(value: GraphParameterValue): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  return originalCollisionGroups(value.toLowerCase() === 'ball' ? 'Ball' : value)
}

function physicalizeBody(context: BehaviorContext, offset = 0): GraphPhysicsBody {
  // Convex, Ball and Concave Count are local settings in this file version; the
  // authored graph then stores each mesh/primitive in the input slots following
  // Collision Surface. Files without the locals put the counts in inputs 12-14
  // (physics_RT.dll 0x10002130), so accept those as fallbacks only then.
  const hasLocalCounts = (context.node.locals?.length ?? 0) > 0
  const countOf = (value: GraphParameterValue) => Number.isFinite(number(value)) ? Math.max(0, Math.trunc(number(value))) : 0
  const count = (slot: number) => countOf(context.local(slot))
  const authoredCount = (slot: number) => countOf(context.input(offset + slot))
  const convexCount = hasLocalCounts ? count(0) : authoredCount(12)
  const ballCount = hasLocalCounts ? count(1) : authoredCount(13)
  const concaveCount = hasLocalCounts ? count(2) : authoredCount(14)
  const hulls: string[] = []
  const concave: string[] = []
  const balls: { position: [number, number, number]; radius: number }[] = []
  if (ballCount > 0) {
    // physics_RT.dll 0x100023F7: a nonzero Ball Count takes the ball path
    // (0x100075D0 -> 0x10013A10 -> IVP_Ball, 0x10030010). The convex/concave
    // counts and arrays are not passed to it, so this branch wins when the
    // counts are combined. The authored nodes use Ball Count 1.
    if (ballCount > 1) throw new Error(`Physicalize ${targetName(context)} has Ball Count ${ballCount}, which is not recovered`)
    const start = offset + 11 + convexCount
    for (let i = 0; i < ballCount; i++) {
      const position = vector(context.input(start + i * 2))
      if (position === undefined) throw new Error(`Physicalize ${targetName(context)} has no position for ball ${i + 1}`)
      const radius = number(context.input(start + i * 2 + 1))
      if (!(radius > 0)) throw new Error(`Physicalize ${targetName(context)} has invalid radius ${radius} for ball ${i + 1}`)
      balls.push({ position, radius })
    }
  } else {
    for (let i = 0; i < convexCount; i++) {
      const hull = text(context.input(offset + 11 + i))
      if (hull !== undefined) hulls.push(hull)
    }
    if (hulls.length === 0 && convexCount > 0) {
      const hull = text(context.input(offset + 11))
      if (hull !== undefined) hulls.push(hull)
    }
    // The editor callback auto-fills a missing Convex input from the owner's
    // current mesh. The ending graph relies on this for Parameter Selector
    // bodies (ropes/balloons/plates): Convex Count is one but input 11 is unset.
    if (hulls.length === 0 && convexCount > 0) {
      const target = targetName(context)
      if (target.length > 0) hulls.push(target)
    }
    // physics_RT.dll's Physicalize helper (0x10002380) builds a ledge soup
    // from the convex hulls and the concave meshes when no ball is authored.
    // The authored floors use Concave Count 1, so their mesh slots after the
    // convex ones are triangle soups (0x10006FB0 inserts each face at
    // 0x10038430), not convex hulls.
    for (let i = 0; i < concaveCount; i++) {
      const mesh = text(context.input(offset + 11 + convexCount + i))
      if (mesh === undefined) throw new Error(`Physicalize ${targetName(context)} has no mesh for concave ${i + 1}`)
      concave.push(mesh)
    }
  }

  const body: GraphPhysicsBody = {
    fixed: Boolean(context.input(offset + 0)),
    friction: number(context.input(offset + 1)),
    elasticity: number(context.input(offset + 2)),
    mass: number(context.input(offset + 3)),
    startFrozen: Boolean(context.input(offset + 5)),
    enableCollision: Boolean(context.input(offset + 6)),
    automaticMassCenter: Boolean(context.input(offset + 7)),
    linearDamping: number(context.input(offset + 8)),
    angularDamping: number(context.input(offset + 9)),
  }
  const group = collisionGroup(context.input(offset + 4))
  if (group !== undefined) body.collisionGroup = group
  if (hulls.length > 0) body.hulls = hulls
  if (concave.length > 0) body.concave = concave
  if (balls.length > 0) body.balls = balls
  const massCenter = vector(context.local(3)) ?? vector(context.input(offset + 15))
  if (massCenter) body.massCenter = massCenter
  return body
}

const physicalize: BehaviorFn = context => {
  // A Physicalize node also owns the Unphysicalize input (slot 1), matching the
  // shipped prototype; its destroy path activates Out2.
  if (!context.isInputActive(0) && context.isInputActive(1)) {
    context.consumeInput(1)
    context.physics?.unphysicalize(targetName(context))
    context.activate(1)
    return
  }
  context.consumeInput(0)
  if (!context.physics) {
    context.activate(1)
    return
  }
  context.physics.physicalize(targetName(context), physicalizeBody(context))
  context.activate(0)
}

// The DLL has no standalone `Unphysicalize` behavior: the string is the second
// input of `Physicalize` (`0x10002158` pushes it). The authored `De Physicalize`
// compounds (`Balls` nodes 872/985/1184) iterate a group and drive that input;
// at runtime the target list is supplied as leading string inputs, otherwise the
// behavior target is unphysicalized.
const unphysicalize: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  const { names } = targetList(context)
  for (const name of names) context.physics?.unphysicalize(name)
  context.activate(0)
}

// `Physicalize Walls` is an authored compound script (P_Modul_03 node 344),
// not a DLL behavior; its eight children are ordinary `Physicalize` nodes for
// P_Modul_03_Gate and P_Modul_03_Wall01..07. The graph runtime does not yet
// expose compound children to a behavior, so the wall names and per-wall body
// settings cannot be read here. `targetList` accepts them as leading string
// inputs followed by the usual Physicalize layout; the authored compound has no
// inputs, so it remains TODO(recovery) until compounds execute their children.
// TODO(recovery): physics_RT.dll has no "Physicalize Walls" declaration string
// (searched the whole DLL), so there is no address to decompile; the source is
// the authored P_Modul_03 graph node 344 with children 72/107/142/181/216/
// 251/286/321. The compound also wires inIO 1 (`De-Physicalize`), handled below.
const physicalizeWalls: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  const { names, offset } = targetList(context)
  if (context.inputSlot === 1) {
    for (const name of names) context.physics?.unphysicalize(name)
    context.activate(1)
    return
  }
  const settings = physicalizeBody(context, offset)
  for (const name of names) context.physics?.physicalize(name, settings)
  context.activate(0)
}

// The real layout is Position, Pos Referential, Direction, Direction Ref,
// Force Value; IVP_Handle is a local, not an input. A documented six-slot
// layout prefixes IVP_Handle, so detect the vector at slot 0 or slot 1.
function forceLayoutOffset(context: BehaviorContext): number {
  if (Array.isArray(context.input(0))) return 0
  if (Array.isArray(context.input(1))) return 1
  return 0
}

/**
 * The persistent controller key names the behavior instance, not just the
 * authored node: in a session one binding serves every module copy, and each
 * P_Modul_18 copy's node 433 is a distinct controller. The script owner is
 * the copied module's MF object (`#id` after remapping, a name in a document
 * graph), so `owner@node` keeps two fans apart while one copy retargeting its
 * ball still replaces its own controller. `@` keeps the binding's
 * `<target>:<controller>` separator unambiguous.
 */
function forceController(context: BehaviorContext): string | number {
  const owner = context.owner()
  // A hand-built graph has no script owner; its runtime is the only instance.
  return owner === undefined ? context.node.index : `${owner}@${context.node.index}`
}

function forceSettings(context: BehaviorContext, scale?: number): GraphForceSettings {
  const offset = forceLayoutOffset(context)
  const value = number(context.input(offset + 4))
  return {
    create: true,
    controller: forceController(context),
    position: vector(context.input(offset)),
    positionRef: text(context.input(offset + 1)),
    direction: vector(context.input(offset + 2)),
    directionRef: text(context.input(offset + 3)),
    value: scale === undefined ? value : value * scale,
  }
}

// `Physics Force` is the authored P_Modul_18 compound script (node 449); its
// worker is an ordinary `SetPhysicsForce` node that applies a continuous force.
// physics_RT.dll has no `Physics Force` behavior declaration (the string at
// 0x100676e8 is referenced at 0x100044e1/0x100044f2, not registered as a
// prototype), so the alias below reuses the recovered SetPhysicsForce path.
const setPhysicsForce: BehaviorFn = (context, state) => {
  const create = context.isInputActive(0) || context.inputSlot === 0
  context.consumeInput(context.inputSlot)
  const scale = context.physics?.forceScale?.(context.node.index)
  if (create) {
    context.physics?.force(targetName(context), forceSettings(context, scale))
    context.activate(0)
    state.scale = scale
    if (scale !== undefined) context.wait()
    return
  }
  if (context.inputSlot < 0 && state.scale !== undefined) {
    if (scale !== state.scale) {
      context.physics?.force(targetName(context), { create: false, controller: forceController(context) })
      context.physics?.force(targetName(context), forceSettings(context, scale))
    }
    state.scale = scale
    if (scale !== undefined) context.wait()
    return
  }
  context.physics?.force(targetName(context), { create: false, controller: forceController(context) })
  context.activate(1)
  state.scale = undefined
}

const physicsImpulse: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.physics?.force(targetName(context), forceSettings(context))
  context.activate(0)
}

type JointKind = 'hinge' | 'slider' | 'ballSocket'

function jointSettings(context: BehaviorContext, kind: JointKind): GraphJointSettings {
  if (kind === 'slider') {
    // Set Physics Slider uses Object2, Axis Point 1, Axis Point 2, Limits,
    // Lower, Upper (six slots). A documented variant prefixes IVP_Handle,
    // shifting every slot by one; the legacy five-slot ordering replaces the
    // second axis point with the limit flag.
    const offset = typeof context.input(0) === 'string' ? 0 : 1
    if (context.inputCount - offset >= 6) {
      return {
        object2: text(context.input(offset)),
        referential: text(context.input(offset + 1)),
        referential2: text(context.input(offset + 2)),
        limitsEnabled: Boolean(context.input(offset + 3)),
        lowerLimit: number(context.input(offset + 4)),
        upperLimit: number(context.input(offset + 5)),
      }
    }
    return {
      object2: text(context.input(offset)),
      referential: text(context.input(offset + 1)),
      limitsEnabled: Boolean(context.input(offset + 2)),
      lowerLimit: number(context.input(offset + 3)),
      upperLimit: number(context.input(offset + 4)),
    }
  }
  // Hinge and ball-socket graphs use five inputs (Object2 first). The
  // documented layout prefixes IVP_Handle, making six.
  const offset = context.inputCount >= 6 ? 1 : 0
  return {
    object2: text(context.input(offset)),
    referential: text(context.input(offset + 1)),
    limitsEnabled: Boolean(context.input(offset + 2)),
    lowerLimit: number(context.input(offset + 3)),
    upperLimit: number(context.input(offset + 4)),
  }
}

function jointBehavior(kind: JointKind): BehaviorFn {
  return context => {
    const create = context.isInputActive(0) || context.inputSlot === 0
    context.consumeInput(context.inputSlot)
    if (create) {
      context.physics?.joint(kind, targetName(context), { ...jointSettings(context, kind), controller: context.node.index })
      context.activate(0)
    } else {
      context.physics?.destroyJoint?.(kind, targetName(context), context.node.index)
      context.activate(1)
    }
  }
}

// `Set Physics Ball Joint` (creation 0x10005011, execution 0x10005120, handler
// 0x100052f0) declares Object2, Position 1, Referential 1, plus the
// `Specify 2 Points?` setting (local 1, default FALSE). The handler only reads
// those three inputs: it transforms Position 1 by Referential 1 and creates a
// ball joint between the target and Object2. The legacy port alias
// `Set Physics BallSocket` used the five-input Hinge ordering (Object2,
// Referential, Limitations, Lower, Upper); both layouts are accepted here.
function ballJointSettings(context: BehaviorContext): GraphJointSettings {
  let offset = 0
  if (context.inputCount >= 4 && typeof context.input(0) !== 'string' && typeof context.input(1) === 'string') offset = 1
  const settings: GraphJointSettings = {}
  const object2 = text(context.input(offset))
  if (object2 !== undefined) settings.object2 = object2
  const second = context.input(offset + 1)
  if (Array.isArray(second)) {
    const referential = text(context.input(offset + 2))
    if (referential !== undefined) settings.referential = referential
  } else {
    const referential = text(second)
    if (referential !== undefined) settings.referential = referential
    settings.limitsEnabled = Boolean(context.input(offset + 2))
    settings.lowerLimit = number(context.input(offset + 3))
    settings.upperLimit = number(context.input(offset + 4))
  }
  return settings
}

const ballJoint: BehaviorFn = context => {
  const create = context.isInputActive(0) || context.inputSlot === 0
  context.consumeInput(context.inputSlot)
  if (create) {
    context.physics?.joint('ballSocket', targetName(context), { ...ballJointSettings(context), controller: context.node.index })
    context.activate(0)
  } else {
    context.physics?.destroyJoint?.('ballSocket', targetName(context), context.node.index)
    context.activate(1)
  }
}

// `Set Physics Spring` (creation 0x100061c1, execution 0x10006360, handler
// 0x10006490) inputs are Object2, Position 1, Referential 1, Position 2,
// Referential 2, Length (1), Constant (1), Linear Dampening (0.1), Global
// Dampening (0.1). The handler anchors Position 1 through Referential 1 on the
// target and Position 2 through Referential 2 on Object2; the binding converts
// both to world render-space points and then to each body's local anchor.
const setPhysicsSpring: BehaviorFn = context => {
  const create = context.isInputActive(0) || context.inputSlot === 0
  context.consumeInput(context.inputSlot)
  if (!create) {
    context.physics?.spring?.(targetName(context), { create: false })
    context.activate(1)
    return
  }
  const settings: GraphSpringSettings = {
    create: true,
    object2: text(context.input(0)),
    position1: vector(context.input(1)),
    referential1: text(context.input(2)),
    position2: vector(context.input(3)),
    referential2: text(context.input(4)),
    length: number(context.input(5)),
    constant: number(context.input(6)),
    axialDamping: number(context.input(7)),
    globalDamping: number(context.input(8)),
  }
  context.physics?.spring?.(targetName(context), settings)
  context.activate(0)
}

const physicsWakeup: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.physics?.wake(targetName(context))
  context.activate(0)
}

const physicsCollDetection: BehaviorFn = (context, state) => {
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    state.armed = false
    return
  }
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    state.armed = true
  }
  if (!state.armed) return
  if (!context.physics) {
    // No physics backend: report the collision output rather than staying armed.
    state.armed = false
    context.activate(0)
    return
  }
  // The binding has no collision-listener callback yet, so remain armed.
  context.wait()
}

function storedVector(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined
  return [number(value[0] as GraphParameterValue), number(value[1] as GraphParameterValue), number(value[2] as GraphParameterValue)]
}

/**
 * TT_Toolbox_RT.dll `TT Set Dynamic Position`, callback 0x10004a80. Local 0
 * is the active flag, local 1 the previous position.
 * - On: Out On, set active, save the target's position and wait; no update.
 * - Off: clear active, then still run one update and fire Out Off.
 * - Otherwise: one update, then wait while active.
 * The update reads both positions with `GetPosition(&p, Coordinate-System)`,
 * applies `originalDynamicPositionStep`, writes `SetPosition(&p, Coordinate-
 * System, FALSE)` (children follow) and sets output 0 to the new position;
 * outputs 1-3 are never written. A missing target or Object is a parameter
 * error in the DLL; here it fails loudly.
 */
const dynamicPosition: BehaviorFn = context => {
  const name = `TT Set Dynamic Position ${context.node.index}`
  const referential = context.inputObject(10)
  const moved = context.object()
  if (!moved) throw new Error(`${name} target ${context.targetName() || '(none)'} is not in the scene`)
  const positionOf = (object: NonNullable<typeof moved>, label: string): [number, number, number] => {
    if (referential === undefined) return [f(object.position[0]), f(object.position[1]), f(object.position[2])]
    if (!object.positionIn) throw new Error(`${name} ${label} cannot be read in referential ${referential}`)
    return object.positionIn(referential).map(f) as [number, number, number]
  }
  let active: boolean
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    active = false
    context.setLocal(0, false)
  } else if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.activate(0)
    context.setLocal(0, true)
    context.setLocal(1, positionOf(moved, 'target'))
    context.wait()
    return
  } else {
    active = context.local(0) === true
  }

  const objectName = context.inputObject(0)
  const reference = objectName === undefined ? undefined : context.object(objectName)
  if (!reference) throw new Error(`${name} Object ${objectName ?? '(NULL)'} is not in the scene`)
  if (number(context.input(11)) !== 0) throw new Error(`${name} has a MaxDistance2Target, which is not authored`)
  const target = positionOf(reference, `Object ${objectName}`)
  const previous = storedVector(context.local(1))
  if (!previous) throw new Error(`${name} has no saved previous position`)
  const current = positionOf(moved, 'target')
  context.setLocal(1, current)
  const force: [number, number, number] = [number(context.input(1)), number(context.input(2)), number(context.input(3))]
  const damping: [number, number, number] = [number(context.input(4)), number(context.input(5)), number(context.input(6))]
  // Offset is an authored length in the referential's frame.
  const offset = authoredVectorToBinding([number(context.input(7)), number(context.input(8)), number(context.input(9))], context.coordinateScale)
  const next = originalDynamicPositionStep(current, previous, target, force, damping, context.deltaMs, offset)
  if (referential === undefined) moved.position = next
  else {
    if (!moved.setPositionIn) throw new Error(`${name} target cannot be placed in referential ${referential}`)
    moved.setPositionIn(next, referential, false)
  }
  context.setOutput(0, next)
  if (active) context.wait()
  else context.activate(1)
}

// Logics/Behaviors/PerSecond.cpp: every output is its input times
// DeltaTime * 0.001f, component by component for vector types.
const perSecond: BehaviorFn = context => {
  const seconds = f(f(context.deltaMs) * f(0.001))
  for (let i = 0; i < context.outputCount; i++) {
    const value = context.input(i)
    context.setOutput(i, Array.isArray(value) ? value.map(component => f(f(component) * seconds)) : f(number(value) * seconds))
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

export const PHYSICS_BEHAVIORS: BehaviorRegistry = {
  Physicalize: physicalize,
  'Physicalize Walls': physicalizeWalls,
  Unphysicalize: unphysicalize,
  'De Physicalize': unphysicalize,
  SetPhysicsForce: setPhysicsForce,
  'Set Physics Force': setPhysicsForce,
  'Physics Force': setPhysicsForce,
  PhysicsImpulse: physicsImpulse,
  'Physics Impulse': physicsImpulse,
  'Set Physics Hinge': jointBehavior('hinge'),
  'Set Physics Slider': jointBehavior('slider'),
  'Set Physics Ball Joint': ballJoint,
  'Set Physics BallSocket': ballJoint,
  'Set Physics Spring': setPhysicsSpring,
  'Physics WakeUp': physicsWakeup,
  'Physics Wakeup': physicsWakeup,
  PhysicsCollDetection: physicsCollDetection,
  'TT Set Dynamic Position': dynamicPosition,
  'Set Dynamic Position': dynamicPosition,
  'Per Second': perSecond,
}
