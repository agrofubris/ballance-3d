import type {
  GraphAudioBinding,
  GraphBinding,
  GraphCameraBinding,
  GraphEffectBinding,
  GraphFrameBinding,
  GraphLightBinding,
  GraphObjectBinding,
  GraphSkyBinding,
  GraphTutorialBinding,
} from './original-graph-bindings.ts'
import type { GraphParameterValue } from './original-graph.ts'
import { ORIGINAL_DATA_ARRAYS, originalCurrentLevelRows, originalDataArray } from './original-data-arrays.ts'
import { SCALE } from './original-data.ts'
import type { OriginalCameraRig } from './original-camera-rig.ts'

/** Language column value the port uses for every install (English). */
export const GAMEPLAY_LANGUAGE = 2

/** What the level supplies to the Gameplay scripts. Render-space objects. */
export interface GameplayLevelSources {
  /** 1-based level id written into `CurrentLevel`. */
  level: number
  /** Authored level entities by name (`SkyLayer`, ...), or undefined. */
  object(name: string): GraphObjectBinding | undefined
  /** Authored lights by name (`Light_Ingame`). */
  light: GraphLightBinding
  /** `Texture Scroller` on a level mesh. */
  scrollTexture(name: string, vector: [number, number], channel: number): void
  sky: GraphSkyBinding
  activeBall(): string | undefined
  group?(name: string): string[] | undefined
  audio?: GraphAudioBinding
  /** Camera.nmo's frames and InGameCam, when the camera is graph-driven. */
  rig?: OriginalCameraRig
}

/** Port settings that stand in for the original options database. */
export interface GameplayOptions {
  /** `GameSettings` `Tutorial?`: the Level 1 tutorial is enabled. */
  tutorial: boolean
  /** `DB_Options` `Invert Cam Rotation?`. */
  invertRotation: boolean
  /** `GameSettings` `Language`. */
  language?: number
  /** `Load String`: the graph session reads the install's text. */
  loadString?: (name: string) => string | undefined
}

/**
 * The graph binding of Gameplay.nmo. It owns the document's Data Arrays (the
 * original options are mapped from the port settings), resolves level entities
 * and loads the tutorial text. `Set Physics Globals` records the time factor here.
 */
export class GameplayBinding implements GraphBinding {
  readonly coordinateScale = SCALE
  /** Authored object names the graph asked for that the level does not have. */
  readonly missing = new Set<string>()
  /** Set by `Set Physics Globals`: a time factor of 0 freezes the simulation. */
  frozen = false
  private readonly sources: GameplayLevelSources
  private readonly arrays = new Map<string, GraphParameterValue[][]>()
  private readonly initialArrays = new Map<string, GraphParameterValue[][]>()
  private readonly loadString?: (name: string) => string | undefined

  constructor(sources: GameplayLevelSources, options: GameplayOptions) {
    this.sources = sources
    this.loadString = options.loadString
    this.installArrays(options)
  }

  /** Every exported Data Array, with the options database mapped from the port. */
  private installArrays(options: GameplayOptions) {
    for (const arrays of Object.values(ORIGINAL_DATA_ARRAYS)) {
      for (const [name, array] of Object.entries(arrays)) this.arrays.set(name, array.rows.map(row => [...row]))
    }
    this.setCell('GameSettings', 'Language', options.language ?? GAMEPLAY_LANGUAGE)
    this.setCell('GameSettings', 'Tutorial?', options.tutorial)
    this.setCell('DB_Options', 'Invert Cam Rotation?', options.invertRotation ? 1 : 0)
    const current = originalCurrentLevelRows(this.sources.level, undefined, this.sources.activeBall())
    if (current.length === 0) throw new Error('Gameplay needs the exported CurrentLevel Data Array; regenerate the local pack')
    this.arrays.set('CurrentLevel', current)
    for (const [name, rows] of this.arrays) this.initialArrays.set(name, rows.map(row => [...row]))
  }

  private setCell(array: string, column: string, value: GraphParameterValue) {
    const source = originalDataArray(array)
    const rows = this.arrays.get(array)
    if (!source || !rows?.length) throw new Error(`Gameplay needs the exported ${array} Data Array; regenerate the local pack`)
    const index = source.columns.findIndex(item => item.name === column)
    if (index < 0) throw new Error(`${array} has no ${column} column`)
    rows[0]![index] = value
  }

  get audio(): GraphAudioBinding | undefined {
    return this.sources.audio
  }

  object(name: string): GraphObjectBinding | undefined {
    if (this.sources.rig?.has(name)) return this.sources.rig.object(name)
    const object = this.sources.object(name)
    if (!object && !this.missing.has(name)) this.missing.add(name)
    return object
  }

  array(name: string): GraphParameterValue[][] | undefined {
    return this.arrays.get(name)
  }

  activeBall(): string | undefined {
    return this.sources.activeBall()
  }

  group(name: string): string[] | undefined {
    return this.sources.group?.(name)
  }

  frame(name: string): GraphFrameBinding | undefined {
    return this.sources.rig?.frame(name)
  }

  children(name: string): string[] | undefined {
    return this.sources.rig?.children(name)
  }

  get camera(): GraphCameraBinding | undefined {
    return this.sources.rig?.camera
  }

  restoreInitial(name: string): void {
    if (this.sources.rig?.has(name)) { this.sources.rig.restoreInitial(name); return }
    const rows = this.initialArrays.get(name)
    const target = this.arrays.get(name)
    if (rows && target) { target.splice(0, target.length, ...rows.map(row => [...row])); return }
    throw new Error(`Gameplay Restore IC has no initial state for ${name}`)
  }

  readonly effect: GraphEffectBinding = {
    emit: () => {},
    stop: () => {},
    setTexture: () => {},
    setDiffuse: name => { throw new Error(`Set Diffuse on ${name} needs the object context`) },
    scrollTexture: (name, vector, channel) => this.sources.scrollTexture(name, vector, channel),
  }

  get light(): GraphLightBinding {
    return this.sources.light
  }

  get sky(): GraphSkyBinding {
    return this.sources.sky
  }

  /** Fonts and 2D text run over the object context in a session; only the text file and the physics globals are the binding's. */
  readonly tutorial: GraphTutorialBinding = {
    createFont: () => { throw new Error('TT CreateFontEx needs the object context') },
    setFont: () => { throw new Error('Set Font Properties needs the object context') },
    showText: () => { throw new Error('2D Text needs the object context') },
    hideText: () => { throw new Error('2D Text needs the object context') },
    loadString: name => {
      if (!this.loadString) throw new Error(`Load String ${name} has no text source`)
      return this.loadString(name)
    },
    setGlobals: (gravity, timeFactor) => this.setGlobals(gravity, timeFactor),
  }

  private setGlobals(gravity: number[], timeFactor: number) {
    if (gravity[0] !== 0 || gravity[1] !== -20 || gravity[2] !== 0) {
      throw new Error(`Gameplay sets gravity ${gravity.join(',')}; only the authored (0,-20,0) is supported`)
    }
    if (timeFactor !== 0 && timeFactor !== 2) throw new Error(`Gameplay sets time factor ${timeFactor}; only 0 and 2 are authored`)
    this.frozen = timeFactor === 0
  }
}
