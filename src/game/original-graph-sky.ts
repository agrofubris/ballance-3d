// The browser host's TT Sky background. Each `TT Sky` On builds one sky
// entity in the original (MenuLevel and Gameplay each own one); this host can
// only draw one background pass, so a new sky replaces the previous entity.
// The face materials of the level's `Sky_*` set and the menu's `MSky_*` set
// are resolved from the host's loaded sky sets.
import * as THREE from 'three'
import type { GraphObjectBinding, GraphSkyBinding, GraphSkySettings } from './original-graph-bindings.ts'
import { OriginalSkyBox } from './original-sky-box.ts'
import type { StereoBackground } from './stereo-renderer.ts'

const FACES = ['Back', 'Right', 'Front', 'Left', 'Down'] as const

export interface OriginalHostSkyOptions {
  /** The current level's sky set, keyed `MSky_<face>` like `loadSkyTextures` returns it. */
  level: () => ReadonlyMap<string, THREE.Texture>
  /** The menu's sky set (AllLevel row 4). */
  menu: ReadonlyMap<string, THREE.Texture>
}

export class OriginalHostSky implements StereoBackground {
  private readonly options: OriginalHostSkyOptions
  private current?: OriginalSkyBox
  private shown = false

  constructor(options: OriginalHostSkyOptions) {
    this.options = options
  }

  get visible(): boolean {
    return this.shown && this.current?.visible === true
  }

  readonly binding: GraphSkyBinding = {
    create: settings => this.create(settings),
    update: (materials, color) => this.update(materials, color),
    show: orientation => this.show(orientation),
    hide: () => { this.shown = false; this.current?.binding.hide() },
  }

  private textures(): Map<string, THREE.Texture> {
    const map = new Map<string, THREE.Texture>()
    const clone = (texture: THREE.Texture, target: string) => { map.set(target, texture.clone()) }
    for (const [name, texture] of this.options.menu) {
      if (name.startsWith('MSky_')) clone(texture, name)
    }
    for (const [name, texture] of this.options.level()) {
      if (name.startsWith('MSky_')) clone(texture, `Sky_${name.slice(5)}`)
    }
    for (const face of FACES) {
      if (!map.has(`Sky_${face}`) || !map.has(`MSky_${face}`)) throw new Error(`TT Sky has no texture for ${face}`)
    }
    return map
  }

  private create(settings: GraphSkySettings) {
    // The original builds a new entity per On; the old one belongs to a document that is unloading
    // (the menu) or to the same level being reset. Only the newest background can be drawn here.
    this.current?.dispose()
    this.current = new OriginalSkyBox(this.textures())
    this.current.binding.create(settings)
    this.shown = false
  }

  private update(materials: (string | null)[], color: [number, number, number, number]) {
    if (!this.current) throw new Error('TT Sky updated before it was created')
    this.current.binding.update(materials, color)
  }

  private show(orientation: GraphObjectBinding | undefined) {
    if (!this.current) throw new Error('TT Sky shown before it was created')
    this.current.binding.show(orientation)
    this.shown = true
  }

  render(renderer: THREE.WebGLRenderer, eye: THREE.PerspectiveCamera): void {
    this.current?.render(renderer, eye)
  }

  dispose(): void {
    this.current?.dispose()
    this.current = undefined
    this.shown = false
  }
}
