import type { BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'

// Building blocks of the Gameplay.nmo and Balls.nmo scripts that the module graphs do not use.

const number = (value: GraphParameterValue) => typeof value === 'number' ? value : Number(value ?? 0)
const bool = (value: GraphParameterValue) => typeof value === 'boolean' ? value : number(value) !== 0
const f = Math.fround

// Materials-Textures/Behaviors/TextureScroller.cpp: Out fires first, then the
// target mesh's UVs on the given channel (-1 = the default material channel)
// move by the Scroll Vector, less the integer part of the first vertex's UV so
// the coordinates stay bounded.
const textureScroller: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  const target = context.targetName()
  const vector = context.input(0)
  if (!Array.isArray(vector) || vector.length < 2) throw new Error(`Texture Scroller ${context.node.index} has no 2D Scroll Vector`)
  const channel = context.input(1) === null ? -1 : Math.trunc(number(context.input(1)))
  const scroll = context.effect?.scrollTexture
  if (!scroll) throw new Error(`Texture Scroller ${context.node.index} has no texture binding for ${target}`)
  scroll(target, [f(vector[0]!), f(vector[1]!)], channel)
}

const DISTORTION = 0, VERTEX_COLOR = 1, ORIENTATION_OBJECT = 2, RADIUS = 3, QUADRATIC_SIDE_FACES = 4, SIDE_FACE_HEIGHT = 5, SKY_POSITION_Y = 6
const SIDE_MATERIALS = 0, TOP_MATERIAL = 1, BOTTOM_MATERIAL = 2
/** The first face-material input; side materials, then the top and bottom materials. */
const FIRST_MATERIAL = 7

const color = (value: GraphParameterValue, fallback: [number, number, number, number]): [number, number, number, number] =>
  Array.isArray(value) && value.length >= 3 ? [value[0]!, value[1]!, value[2]!, value[3] ?? 1] : fallback

// TT_Gravity_RT/Behaviors/Sky.cpp. On builds the sky entity once from the
// settings (side material count, top/bottom flags) and inputs; every active
// frame then re-assigns the face materials and vertex color, shows the entity
// at the camera with the Orientation Object's world matrix and stays active.
// Off hides it and fires Exit Off. The DLL errors without a built entity.
const ttSky: BehaviorFn = (context, state) => {
  const sky = context.sky
  if (!sky) throw new Error(`TT Sky ${context.node.index} has no sky binding`)
  const sides = Math.max(4, Math.trunc(number(context.local(SIDE_MATERIALS))))
  const top = bool(context.local(TOP_MATERIAL))
  const bottom = bool(context.local(BOTTOM_MATERIAL))
  const vertexColor = color(context.input(VERTEX_COLOR), [1, 1, 1, 0])
  const orientation = context.input(ORIENTATION_OBJECT)
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.activate(0)
    const distortion = context.input(DISTORTION) === null ? 0.3 : Math.min(1, number(context.input(DISTORTION)))
    const quadratic = context.input(QUADRATIC_SIDE_FACES) === null ? true : bool(context.input(QUADRATIC_SIDE_FACES))
    sky.create({
      distortion,
      radius: context.input(RADIUS) === null ? 70 : number(context.input(RADIUS)),
      quadratic,
      sideHeight: quadratic ? 0 : number(context.input(SIDE_FACE_HEIGHT)),
      y: number(context.input(SKY_POSITION_Y)),
      sides,
      top,
      bottom,
    })
    state.created = true
  }
  if (!state.created) return
  const materials: (string | null)[] = []
  for (let i = 0; i < sides + Number(top) + Number(bottom); i++) {
    const material = context.input(FIRST_MATERIAL + i)
    materials.push(typeof material === 'string' ? material : null)
  }
  sky.update(materials, vertexColor)
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.activate(1)
    sky.hide()
    return
  }
  sky.show(typeof orientation === 'string' ? context.object(orientation) : undefined)
  context.wait()
}

// TT_Gravity_RT/Behaviors/SimpleShadow.cpp. Off resets the shadow data and
// fires Exit Off. On resets it, creates the shadow material and fires Exit
// On. Every active frame then adds a one-shot pre-render callback, which reads
// Texture, Size Scale and Maximum Height and projects onto the floors.
const ttSimpleShadow: BehaviorFn = context => {
  const shadow = context.shadow
  if (!shadow) throw new Error(`TT Simple Shadow ${context.node.index} has no shadow binding`)
  const target = context.targetName()
  if (!target) throw new Error(`TT Simple Shadow ${context.node.index} has no target`)
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.activate(1)
    shadow.reset()
    return
  }
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.activate(0)
    shadow.reset()
    shadow.create()
  }
  const texture = context.input(0)
  shadow.project(target, {
    texture: typeof texture === 'string' ? texture : null,
    sizeScale: context.input(1) === null ? 2 : number(context.input(1)),
    maxHeight: context.input(2) === null ? 100 : number(context.input(2)),
  })
  context.wait()
}

export const GAMEPLAY_BEHAVIORS: BehaviorRegistry = {
  'Texture Scroller': textureScroller,
  'TT Sky': ttSky,
  'TT Simple Shadow': ttSimpleShadow,
}
