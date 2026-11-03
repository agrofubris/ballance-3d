// WorldEnvironments.dll `Set Background Color` and `Set Fog` over the CK
// object context. Both act on the current render context, whose state the
// context keeps in `render`:
//
// backgroundColor: the background material's diffuse (VxColor floats)
// fog: { mode (VXFOG_MODE), start, end, density, color (ARGB dword) }
import type { BehaviorContext, BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import type { GraphRenderState } from './original-graph-bindings.ts'
import { originalColorFromFloats } from './original-color.ts'

/** The render context's state, kept by the CK context. */
function renderOf(context: BehaviorContext): GraphRenderState {
  const render = context.loader?.render
  if (!render) throw new Error(`${context.node.name} ${context.node.index} needs the CK object context`)
  return render
}

const floats = (value: GraphParameterValue, fallback: number[]) =>
  Array.isArray(value) && value.length >= fallback.length ? value.slice(0, fallback.length).map(Number) : fallback

/**
 * Set Background Color (exec 0x25882180): In off, Out, then the background
 * material's diffuse takes the colour input (default 0,0,0,0) as is.
 */
const setBackgroundColor: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  renderOf(context).backgroundColor = floats(context.input(0), [0, 0, 0, 0]).map(Math.fround)
}

/**
 * Set Fog (exec 0x258827D0): In off, Out, then the render context's fog:
 * mode VXFOG_LINEAR for any nonzero input 0, else none; start, end (default
 * 10), density (default 1) and RGBAFTOCOLOR(r, g, b, 1). Without its local the
 * DLL scales start and end by 2.8 (0x25885100); no authored instance lacks it.
 */
const setFog: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  if (!context.node.locals?.length) throw new Error(`Set Fog ${context.node.index} has no local, whose start/end scaling is not ported`)
  const number = (slot: number, fallback: number) => { const value = context.input(slot); return Math.fround(typeof value === 'number' ? value : fallback) }
  const [r, g, b] = floats(context.input(4), [0, 0, 0])
  const [cr, cg, cb, ca] = originalColorFromFloats(r!, g!, b!, 1)
  renderOf(context).fog = {
    mode: number(0, 0) !== 0 ? 3 : 0, start: number(1, 0), end: number(2, 10), density: number(3, 1),
    color: ((ca << 24) | (cr << 16) | (cg << 8) | cb) >>> 0,
  }
}

export const ENVIRONMENT_BEHAVIORS: BehaviorRegistry = {
  'Set Background Color': setBackgroundColor,
  'Set Fog': setFog,
}
