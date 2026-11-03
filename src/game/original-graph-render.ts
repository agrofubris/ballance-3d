import type { BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import { originalColorFromFloats, originalColorFromVxColor } from './original-color.ts'
import { CKCID, originalIsChildClassOf } from './original-context.ts'
import { originalMatrixFromEulerAngles } from './original-orientation.ts'

// Camera, orientation and prelit building blocks recovered from CKBuildingBlocks
// (fca1963). Each needs its binding; a missing one fails loudly.

const number = (value: GraphParameterValue) => typeof value === 'number' ? value : Number(value ?? 0)
const bool = (value: GraphParameterValue) => typeof value === 'boolean' ? value : number(value) !== 0
const color = (value: GraphParameterValue, fallback: [number, number, number, number]) =>
  Array.isArray(value) && value.length >= 4 ? value.slice(0, 4).map(Number) as [number, number, number, number] : fallback

/** A TARGETABLE block with no target returns CKBR_OWNERERROR without firing Out. */
function target(context: Parameters<BehaviorFn>[0]): string {
  const name = context.targetName()
  if (!name) throw new Error(`${context.node.name} ${context.node.index} has no target`)
  return name
}

/**
 * 3DTrans/Behaviors/SetEulerOrientation.cpp with Merge Angles Params: Out
 * fires, then the Euler matrix's right/up/dir rows go to
 * `CK3dEntity::SetOrientation` with the Referential and KeepChildren = !Hierarchy.
 */
const setEulerOrientation: BehaviorFn = context => {
  const name = target(context)
  if (!bool(context.local(0)) && context.inputCount !== 3) {
    throw new Error(`Set Euler Orientation ${context.node.index} uses the separate-angle layout, which is not authored`)
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
  const angles = context.input(0)
  if (!Array.isArray(angles) || angles.length < 3) throw new Error(`Set Euler Orientation ${context.node.index} has no Euler angles`)
  const hierarchy = context.inputCount > 1 && context.input(1) !== null ? bool(context.input(1)) : true
  const referential = context.input(2)
  const object = context.object(name)
  if (!object?.setOrientation) throw new Error(`Set Euler Orientation ${context.node.index} needs an orientation binding for ${name}`)
  const { right, up, dir } = originalMatrixFromEulerAngles(Number(angles[0]), Number(angles[1]), Number(angles[2]))
  object.setOrientation(dir, up, right, typeof referential === 'string' && referential ? referential : undefined, !hierarchy)
}

/** Cameras/Behaviors/SetAsActiveCamera.cpp: Out, then AttachViewpointToCamera. */
const setAsActiveCamera: BehaviorFn = context => {
  const name = target(context)
  if (!context.camera) throw new Error(`Set As Active Camera ${context.node.index} needs a camera binding`)
  context.consumeInput(context.inputSlot)
  context.activate(0)
  context.camera.attach(name)
}

/** Cameras/Behaviors/SetClippling.cpp: front and back planes, then Out. */
const setClippingPlanes: BehaviorFn = context => {
  const name = target(context)
  if (!context.camera) throw new Error(`Set Clipping Planes ${context.node.index} needs a camera binding`)
  const near = Math.fround(context.input(0) === null ? .1 : number(context.input(0)))
  const far = Math.fround(context.input(1) === null ? 200 : number(context.input(1)))
  context.camera.setClipping(name, near, far)
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

/**
 * Materials-Textures/Behaviors/SetPrelitColor.cpp (Materials.dll exec
 * 0x25502770): both colours through `RGBAFTOCOLOR(r, g, b, a)`, then the
 * current mesh turns prelit (`SetLitMode(VX_PRELITMESH)`) and every vertex
 * takes them as its diffuse and specular colour. Out fires after the write.
 * Over the CK context the mesh's state is written (litMode 0, vertexColor and
 * vertexSpecularColor as RGBA bytes, uniform over the vertices); an entity
 * without a mesh is an owner error that fires nothing. Other hosts take the
 * colours through their prelit binding.
 */
const setPrelitColor: BehaviorFn = context => {
  const name = target(context)
  const filter = originalColorFromFloats(...color(context.input(0), [1, 1, 1, .5]))
  const additional = originalColorFromFloats(...color(context.input(1), [0, 0, 0, 0]))
  const loader = context.loader
  if (loader) {
    const classId = loader.classId(name)
    if (classId === CKCID.SPRITE3D) throw new Error(`Set Prelit Color ${context.node.index} on the 3D sprite ${loader.objectName(name)} needs its material link`)
    if (classId === undefined || !originalIsChildClassOf(classId, CKCID['3DENTITY'])) {
      throw new Error(`Set Prelit Color ${context.node.index} targets ${loader.objectName(name)} (class ${classId}), not a 3D entity`)
    }
    const mesh = loader.currentMeshReference(name)
    if (!mesh) return
    Object.assign(loader.state(mesh), { litMode: 0, vertexColor: filter, vertexSpecularColor: additional })
  } else {
    if (!context.effect?.setPrelitColor) throw new Error(`Set Prelit Color ${context.node.index} needs a prelit binding`)
    context.effect.setPrelitColor(name, filter, additional)
  }
  context.consumeInput(context.inputSlot)
  context.activate(0)
}

/**
 * Visuals/Behaviors/PlanarFilter.cpp (Visuals.dll, image base 0x25780000): On
 * calls `AddPostSpriteRenderCallBack` (CKRenderContext vtable +0x90) with the
 * callback at 0x25787CD0; Off and the lifecycle callback (0x25787BE0) call
 * `RemovePostSpriteRenderCallBack` (+0x94). The callback reads the inputs live
 * every frame and draws one full-view TRIANGLEFAN after the foreground 2D
 * root, converting both colours with `RGBAFTOCOLOR(&color)`. The block stays
 * active every frame until Off.
 */
const planarFilter: BehaviorFn = (context, state) => {
  const filter = context.filter
  if (!filter) throw new Error(`Planar Filter ${context.node.index} needs a filter binding`)
  const key = String(context.node.index)
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.activate(1)
    filter.hide(key)
    state.on = false
    return
  }
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.activate(0)
    const read = () => {
      // A texture saved as NULL reads as NULL, not as its parameter's name.
      const texture = context.inputObject(2) ?? null
      return {
        color: originalColorFromVxColor(...color(context.input(0), [1, 1, 1, .5])),
        specular: originalColorFromVxColor(...color(context.input(1), [0, 0, 0, 0])),
        texture,
        sourceBlend: number(context.input(3)),
        destBlend: number(context.input(4)),
        magFilter: number(context.input(5)),
        minFilter: number(context.input(6)),
      }
    }
    filter.show(key, read)
    state.on = true
  }
  context.wait()
}

export const RENDER_BEHAVIORS: BehaviorRegistry = {
  'Planar Filter': planarFilter,
  'Set Euler Orientation': setEulerOrientation,
  'Set As Active Camera': setAsActiveCamera,
  'Set Clipping Planes': setClippingPlanes,
  'Set Prelit Color': setPrelitColor,
}
