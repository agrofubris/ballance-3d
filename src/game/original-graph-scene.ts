import * as THREE from 'three'
import type { GraphBinding, GraphLightBinding, GraphObjectBinding } from './original-graph-bindings.ts'
import type { GraphParameterValue } from './original-graph.ts'

/**
 * Layer-2 object resolver. The graph runtime addresses scene objects by their
 * authored name (a behavior target or an input reference). This registry maps
 * those names to live Three.js objects and exposes them through the
 * `GraphObjectBinding` contract, so behaviors can read and mutate transforms
 * without knowing about the engine.
 *
 * Data Arrays (the `CurrentLevel Array`-style targets used by `Get Cell` /
 * `Set Cell`) are registered separately as row-major value grids.
 */
export class OriginalGraphScene implements GraphBinding {
  private objects = new Map<string, THREE.Object3D>()
  private lights = new Map<string, THREE.Light>()
  private arrays = new Map<string, GraphParameterValue[][]>()

  readonly light: GraphLightBinding = {
    setColor: (name, color) => {
      const object = this.lights.get(name)
      if (!object) throw new Error(`Light ${name} is not a registered scene light`)
      object.color.setRGB(color[0], color[1], color[2])
    },
  }

  /** Register objects under their `.name`; unnamed objects are ignored. */
  add(...objects: THREE.Object3D[]) {
    for (const object of objects) {
      if (!object.name) continue
      this.objects.set(object.name, object)
      if (object instanceof THREE.Light) this.lights.set(object.name, object)
    }
  }

  remove(...objects: THREE.Object3D[]) {
    for (const object of objects) {
      if (this.objects.get(object.name) === object) this.objects.delete(object.name)
      if (this.lights.get(object.name) === object) this.lights.delete(object.name)
    }
  }

  setArray(name: string, value: GraphParameterValue[][]) { this.arrays.set(name, value) }

  object(name: string): GraphObjectBinding | undefined {
    const object = this.objects.get(name)
    if (!object) return undefined
    return {
      get position() { return object.position.toArray() as [number, number, number] },
      set position(value) { object.position.set(value[0], value[1], value[2]) },
      get rotation() { return object.quaternion.toArray() as [number, number, number, number] },
      set rotation(value) { object.quaternion.set(value[0], value[1], value[2], value[3]) },
      get scale() { return object.scale.toArray() as [number, number, number] },
      set scale(value) { object.scale.set(value[0], value[1], value[2]) },
      get visible() { return object.visible },
      set visible(value) { object.visible = value },
    }
  }

  array(name: string): GraphParameterValue[][] | undefined { return this.arrays.get(name) }

  /** Names currently registered, for diagnostics. */
  get names(): string[] { return [...this.objects.keys()] }
}
