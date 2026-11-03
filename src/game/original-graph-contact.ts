// BuildingBlocks/physics_RT.dll PhysicsContinuousContact (prototype
// 199e4cf1:545a78fe): a delayed contact-state listener on one 3D entity.
// The physics host owns the listener (PhysicsContactData + IVP friction
// listener); this block creates and stops it and reports its outputs.
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import type { GraphContactListener } from './original-graph-bindings.ts'

const f = Math.fround
const number = (value: GraphParameterValue) => typeof value === 'number' ? value : Number(value ?? 0)

/**
 * The block's target (Sound's `Active Ball` parameter, which its own Get Cell
 * fills). Over the context a name that is no live object is a NULL target.
 */
function targetName(context: BehaviorContext): string | undefined {
  const target = context.targetName()
  if (!target) return undefined
  return context.loader && !context.loader.has(target) ? undefined : target
}

/**
 * PhysicsContinuousContact (creation 0x10001090, execution 0x100011E0).
 * - Create: if local 1 (the PhysicsContactData) is NULL, get the target and
 *   build the listener with inputs Time Delay Start/End and local 0
 *   Number Group Output (clamped to the output pairs); no body means no data.
 *   The behavior then stays active for the next frame.
 * - Stop: delete the listener; its destructor fires contact off for every
 *   active group.
 * - Otherwise the behavior polls the changes recorded during the last
 *   simulation and fires the matching contact on/off output.
 * Outputs are ordered contact on/off per group (0x1000114E..); the manager
 * activates 2*index on and 2*index+1 off.
 */
const physicsContinuousContact: BehaviorFn = (context, state) => {
  const name = `PhysicsContinuousContact ${context.node.index}`
  const physics = context.physics
  if (!physics) throw new Error(`${name} needs the session physics`)
  let contact = state.contact as GraphContactListener | undefined

  // CKIpionManager::Simulate runs the contact listener during the physics step
  // and PhysicsContactManager::Process after it; Virtools dispatches their
  // activated outputs on the next script frame.
  if (contact) {
    for (const change of contact.poll()) context.activate(2 * (change.group - 1) + (change.active ? 0 : 1))
    if (!contact.alive) { contact = undefined; delete state.contact }
  }

  if (context.isInputActive(0)) {
    context.consumeInput(0)
    if (!contact) {
      if (!physics.continuousContact) throw new Error(`${name} needs a continuous-contact physics binding`)
      // A NULL target: the Create callback makes no data and the block waits for the next Create.
      const target = targetName(context)
      if (!target) { context.wait(); return }
      const groups = Math.max(0, Math.min(Math.trunc(number(context.local(0))), Math.floor(context.outCount / 2)))
      contact = physics.continuousContact(target, {
        groups, startDelay: f(number(context.input(0))), endDelay: f(number(context.input(1))),
      })
      if (contact) state.contact = contact
    }
    context.wait()
    return
  }

  if (context.isInputActive(1)) {
    context.consumeInput(1)
    for (const change of contact?.stop() ?? []) context.activate(2 * (change.group - 1) + (change.active ? 0 : 1))
    delete state.contact
    return
  }

  // CKBR_ACTIVATENEXTFRAME: no input still keeps the block running.
  context.wait()
}

export const CONTACT_BEHAVIORS: BehaviorRegistry = {
  PhysicsContinuousContact: physicsContinuousContact,
}
