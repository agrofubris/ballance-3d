// Object management building blocks (Narratives) over the CKContext binding.
import type { BehaviorFn, BehaviorRegistry } from './original-graph.ts'
import { CKCID, originalDependencies, originalIsChildClassOf } from './original-context.ts'

/**
 * Narratives ObjectLoader.cpp. Load: Dynamic (local 0) and Add To Current
 * Scene (input 3) pick the load options; a failed load fires Failed. Otherwise
 * Loaded fires, Loaded Objects lists the load and Master Object is the last
 * object of Filter Class (input 2) named Master Object Name (input 1), or
 * without a name the last root 2D/3D entity of that class. Unload destroys the
 * previous load and fires Unloaded. Reuse Meshes/Materials only steer the
 * duplicate dialog and do not change a fresh load.
 */
const objectLoad: BehaviorFn = (context, state) => {
  const loader = context.loader
  if (!loader) throw new Error(`Object Load ${context.node.index} needs a context binding`)
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    const dynamic = context.local(0) !== false
    const addToScene = context.input(3) !== false
    const path = String(context.input(0) ?? '')
    const loaded = loader.load(path, { dynamic, addToScene })
    if (!loaded) {
      context.activate(2)
    } else {
      context.activate(0)
      const master = String(context.input(1) ?? '')
      const filter = context.input(2) === null ? CKCID['3DOBJECT'] : Number(context.input(2))
      let found: string | null = null
      for (const object of loaded) {
        if (!originalIsChildClassOf(object.classId, filter)) continue
        if (master) { if (object.name === master) found = object.name }
        else if ((originalIsChildClassOf(object.classId, CKCID['3DENTITY']) || originalIsChildClassOf(object.classId, CKCID['2DENTITY'])) && object.root) found = object.name
      }
      state.loaded = loaded.map(object => object.id)
      context.setOutput(0, loaded.map(object => object.id))
      context.setOutput(1, found)
    }
  }
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.activate(1)
    const loaded = state.loaded as number[] | undefined
    if (loaded?.length) loader.unload(loaded)
    state.loaded = []
    context.setOutput(0, [])
  }
}

/**
 * Logics CollectionIterator.cpp. In restarts at index 0, Loop In advances;
 * past the end Out fires, otherwise Element (the object of that CK_ID, NULL
 * once destroyed) and Index are written and Loop Out fires. The index lives in
 * output 1, or local 0 when there is no such output. A missing collection
 * fires Out (a parameter error kept for compatibility).
 */
const collectionIterator: BehaviorFn = context => {
  const collection = context.input(0)
  if (!Array.isArray(collection)) {
    context.activate(0)
    return
  }
  const indexSlot = context.outputCount > 1
  let index = Number((indexSlot ? context.output(1) : context.local(0)) ?? 0)
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    index = 0
  } else {
    context.consumeInput(1)
    index++
  }
  if (index >= collection.length) {
    context.activate(0)
    return
  }
  const loader = context.loader
  if (!loader) throw new Error(`Collection Iterator ${context.node.index} needs a context binding to resolve CK_IDs`)
  context.setOutput(0, loader.reference(Number(collection[index])) ?? null)
  if (indexSlot) context.setOutput(1, index)
  else context.setLocal(0, index)
  context.activate(1)
}

/**
 * Narratives SoundLoader.cpp without its threaded mode (the authored setting
 * is off; on, it fails loudly). No target fires Failed. In stops the sound,
 * sets its file (resolved on the sound path) and its streaming flag; a file
 * that cannot be found fires Failed, otherwise Out.
 */
const soundLoad: BehaviorFn = context => {
  const loader = context.loader
  if (!loader) throw new Error(`Sound Load ${context.node.index} needs a context binding`)
  if (context.local(2) === true) throw new Error(`Sound Load ${context.node.index} uses asynchronous loading, which is not supported`)
  const sound = context.targetName()
  if (!sound || !loader.has(sound)) { context.consumeInput(context.inputSlot); context.activate(1); return }
  if (!context.isInputActive(0)) { context.consumeInput(context.inputSlot); return }
  context.consumeInput(0)
  const file = loader.resolveFile(String(context.input(0) ?? ''), 'sound')
  const state = loader.state(sound)
  state.playing = false
  if (file === undefined) { context.activate(1); return }
  state.fileName = file
  state.streamed = context.input(1) === true
  context.activate(0)
}

/**
 * Narratives ObjectDeleter.cpp (the version with Dependency Options): In off
 * and Out, then CKContext::DestroyObject(Object, 0, dependencies). A NULL
 * Object is an owner error after Out. The saved options are NONE, FULL or the
 * CUSTOM per-class table (CKDependenciesSaver 0x12248766/0x12248767/0x12248768;
 * CK2.dll reader 0x240325C5). The DLL reads the parameter's saved value, so a
 * custom option with no class entry has mask 0.
 */
const objectDelete: BehaviorFn = context => {
  const loader = context.loader
  if (!loader) throw new Error(`Object Delete ${context.node.index} needs a context binding`)
  context.consumeInput(context.inputSlot)
  context.activate(0)
  if (context.inputCount < 2) throw new Error(`Object Delete ${context.node.index} uses the old target layout, which is not authored`)
  const raw = context.inputRaw(1)
  if (raw === undefined) throw new Error(`Object Delete ${context.node.index} has no saved dependency options`)
  const dependencies = originalDependencies(raw, 'Delete')
  const object = context.inputObject(0)
  if (object === undefined) return
  loader.destroy(object, dependencies)
}

/**
 * TT_Toolbox_RT SaveIC.cpp: Out fires; with a target, its state becomes its
 * scene initial value, and with Hierarchy? so does every descendant's (entity
 * classes only). The context keeps every object in the level scene.
 */
const ttSaveIC: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  const loader = context.loader
  if (!loader) throw new Error(`TT Save IC ${context.node.index} needs a context binding`)
  const target = context.targetName()
  if (!target || !loader.has(target)) return
  loader.saveInitial(target, context.input(0) === true)
}

export const CONTEXT_BEHAVIORS: BehaviorRegistry = {
  'TT Save IC': ttSaveIC,
  'Object Delete': objectDelete,
  'Sound Load': soundLoad,
  'Object Load': objectLoad,
  'Collection Iterator': collectionIterator,
}
