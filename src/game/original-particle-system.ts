import * as THREE from 'three'
import type { BehaviorFn, BehaviorRegistry, GraphParameterValue } from './original-graph.ts'
import { originalVxColorChannel } from './original-color.ts'

// TT_ParticleSystems_RT: GeneralParticleSystem.cpp (the behavior), ParticleEmitter.cpp
// (ReadInputs, InitiateDirection, AddParticles, UpdateParticles), SphericalEmitter.cpp,
// PointEmitter.cpp and ParticleSystemRenderCallbacks.cpp (RenderParticles_L,
// RenderParticles_OS, RenderParticles_FS).
// Particles live in world space, in original units and milliseconds.

/** Particle.h render modes. */
export const PR_LINE = 2
/** RenderParticles_S (0x2508E240): camera-facing quads, `size` wide. */
export const PR_SPRITE = 3
export const PR_OSPRITE = 5
export const PR_FSPRITE = 7
/** Particle.h evolutions. */
const PE_SIZE = 0x1, PE_COLOR = 0x2, PE_TEXTURE = 0x4
/** Particle.h variances. */
const PV_SPEED = 0x1, PV_ANGULARSPEED = 0x2, PV_LIFESPAN = 0x4, PV_EMISSION = 0x8, PV_INITIALSIZE = 0x10, PV_ENDINGSIZE = 0x20
const PV_INITIALCOLOR = 0x200, PV_ENDINGCOLOR = 0x400, PV_INITIALTEXTURE = 0x800, PV_SPEEDTEXTURE = 0x1000
/** Particle.h loop modes. */
const PL_NOLOOP = 0, PL_LOOP = 1, PL_PINGPONG = 2

/** Particle.h input indices. */
const EMISSIONDELAY = 0, EMISSIONDELAYVAR = 1, YAWVARIATION = 2, PITCHVARIATION = 3, SPEED = 4, SPEEDVARIATION = 5, ANGSPEED = 6, ANGSPEEDVARIATION = 7
const LIFE = 8, LIFEVARIATION = 9, NUMBER = 10, EMITION = 11, EMITIONVARIATION = 12
const STARTSIZE = 13, STARTSIZEVARIANCE = 14, ENDSIZE = 15, ENDSIZEVARIANCE = 16
const STARTCOLOR = 23, STARTCOLORVARIANCE = 24, ENDCOLOR = 25, ENDCOLORVARIANCE = 26
const TEXTURE = 27, STARTTEXTURE = 28, STARTTEXTUREVARIANCE = 29, SPEEDTEXTURE = 30, SPEEDTEXTUREVARIANCE = 31, TEXTURECOUNT = 32, TEXTURELOOP = 33
/** GeneralParticleSystem locals: Emitter, Activity, EmissionTime, then the settings. */
const PARTICLENUMBER = 3, RENDERMODES = 4, SRCBLEND = 5, DESTBLEND = 6, EVOLUTIONS = 8, VARIANCES = 9, DEFLECTORS = 10, INTERACTORS = 12

const INACTIVE = 0, ACTIVE = 1, FREEZED = 2

/** VXBLEND_* factors the particle documents author. */
const BLEND_FACTORS: Record<number, THREE.BlendingDstFactor> = {
  1: THREE.ZeroFactor,
  2: THREE.OneFactor,
  3: THREE.SrcColorFactor,
  4: THREE.OneMinusSrcColorFactor,
  5: THREE.SrcAlphaFactor,
  6: THREE.OneMinusSrcAlphaFactor,
  7: THREE.DstAlphaFactor,
  8: THREE.OneMinusDstAlphaFactor,
  9: THREE.DstColorFactor,
  10: THREE.OneMinusDstColorFactor,
}

const f = Math.fround

/** The particle DLL's RANDNUM and RANDNUMP factors (0x250931C8, 0x250931CC): float literals near 1/16383 and 1/32767. */
const RANDNUM_SCALE = 6.10389033681713e-05
const RANDNUMP_SCALE = 3.0518498533638194e-05

/**
 * The CRT `rand()` the particle DLL calls (MSVC: `x = x·214013 + 2531011`,
 * `(x >> 16) & 0x7fff`), seeded as without `srand`. Virtools shares it with
 * every caller in the process, so only its distribution is reproduced.
 */
export class CrtRandom {
  private state: number
  constructor(seed = 1) { this.state = seed >>> 0 }
  rand(): number {
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0
    return (this.state >>> 16) & 0x7fff
  }
  /** RANDNUM (TT_ParticleSystems_RT 0x2508100D): (rand() − 0x3FFF) times the float 0x38800203, about [−1, 1]. */
  randnum(): number { return f((this.rand() - 0x3fff) * RANDNUM_SCALE) }
  /** RANDNUMP (0x250810B6): rand() times the float 0x380000FD, about [0, 1]. */
  randnump(): number { return f(this.rand() * RANDNUMP_SCALE) }
}

/** The emitter shapes ParticleManager::CreateNewEmitter builds for the behaviors ported here. */
/** `timepoint` is TT_TimedependentPointParticlesystem's TimePointEmitter, a PointEmitter that emits along its path. */
export type ParticleEmitterShape = 'spherical' | 'point' | 'timepoint'

/** The settings a GeneralParticleSystem reads at load (`ReadSettings`). */
export interface ParticleSettings {
  /** Defaults to the SphericalEmitter. */
  shape?: ParticleEmitterShape
  maximum: number
  renderMode: number
  srcBlend: number
  destBlend: number
  evolutions: number
  variances: number
}

export interface Particle {
  pos: THREE.Vector3
  dir: THREE.Vector3
  color: [number, number, number, number]
  deltaColor: [number, number, number, number]
  size: number
  deltaSize: number
  life: number
  angle: number
  deltaAngle: number
  deltaTime: number
  currentFrame: number
  currentFrametime: number
  deltaFrametime: number
}

type Color = [number, number, number, number]

/** ParticleEmitter with the SphericalEmitter or PointEmitter shape. */
export class OriginalParticleEmitter {
  readonly settings: ParticleSettings
  /** Newest first, as the emitter's linked list. */
  particles: Particle[] = []
  active = false
  /** TimePointEmitter (0x250831F0): m_Position starts at VxVector::axis0, m_Time at 0, and the first call only records the position. */
  private timePosition: [number, number, number] = [1, 0, 0]
  private time = 0
  private firstTime = true
  /** m_EmissionDelay, an int member: the time-point ReadInputs stores `_ftol(Emission Delay)`, a rate per second. */
  private emissionRate = 0
  private readonly random: CrtRandom
  // Member defaults from the ParticleEmitter constructor.
  yawVariation = 0; pitchVariation = 0
  speed = 0; speedVariation = 0; angularSpeed = 0; angularSpeedVariation = 0
  life = 0; lifeVariation = 0; totalParticles = 0; emitsPerFrame = 0; emitsVar = 0
  startSize = 0; startSizeVar = 0; endSize = 0; endSizeVar = 0
  startColor: Color = [0.6, 0.6, 0.8, 1]; startColorVar: Color = [0, 0, 0, 0]
  endColor: Color = [0, 0, 0, 0]; endColorVar: Color = [0, 0, 0, 0]
  texture: string | null = null
  initialTextureFrame = 0; initialTextureFrameVariance = 0; speedTextureFrame = 0; speedTextureFrameVariance = 0
  textureFrameCount = 0; textureFrameLoop = PL_NOLOOP

  constructor(settings: ParticleSettings, random: CrtRandom) {
    if (settings.renderMode !== PR_LINE && settings.renderMode !== PR_SPRITE && settings.renderMode !== PR_OSPRITE && settings.renderMode !== PR_FSPRITE) {
      throw new Error(`Particle render mode ${settings.renderMode} is not implemented`)
    }
    if (!BLEND_FACTORS[settings.srcBlend] || !BLEND_FACTORS[settings.destBlend]) {
      throw new Error(`Particle blend ${settings.srcBlend}/${settings.destBlend} is not implemented`)
    }
    this.settings = settings
    this.random = random
  }

  /** InitParticleSystem: an empty pool. */
  init() {
    this.particles = []
  }

  /** ParticleEmitter::ReadInputs; unset inputs keep the member value. */
  readInputs(input: (slot: number) => GraphParameterValue) {
    const { variances, evolutions } = this.settings
    const num = (slot: number, current: number) => { const value = input(slot); return typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : current }
    // TimePointEmitter::ReadInputs (0x25083290) reads Emission Delay first.
    if (this.settings.shape === 'timepoint') this.emissionRate = Math.trunc(f(num(EMISSIONDELAY, this.emissionRate)))
    const color = (slot: number, current: Color): Color => { const value = input(slot); return Array.isArray(value) && value.length >= 4 ? [value[0]!, value[1]!, value[2]!, value[3]!] : current }
    this.yawVariation = num(YAWVARIATION, this.yawVariation)
    this.pitchVariation = num(PITCHVARIATION, this.pitchVariation)
    this.speed = num(SPEED, this.speed)
    if (variances & PV_SPEED) this.speedVariation = num(SPEEDVARIATION, this.speedVariation)
    this.angularSpeed = num(ANGSPEED, this.angularSpeed)
    if (variances & PV_ANGULARSPEED) this.angularSpeedVariation = num(ANGSPEEDVARIATION, this.angularSpeedVariation)
    this.startSize = num(STARTSIZE, this.startSize)
    if (variances & PV_INITIALSIZE) this.startSizeVar = num(STARTSIZEVARIANCE, this.startSizeVar)
    if (evolutions & PE_SIZE) {
      this.endSize = num(ENDSIZE, this.endSize)
      if (variances & PV_ENDINGSIZE) this.endSizeVar = num(ENDSIZEVARIANCE, this.endSizeVar)
    }
    this.life = num(LIFE, this.life)
    if (variances & PV_LIFESPAN) this.lifeVariation = num(LIFEVARIATION, this.lifeVariation)
    this.totalParticles = Math.trunc(num(NUMBER, this.totalParticles))
    this.emitsPerFrame = Math.trunc(num(EMITION, this.emitsPerFrame))
    if (variances & PV_EMISSION) this.emitsVar = Math.trunc(num(EMITIONVARIATION, this.emitsVar))
    this.startColor = color(STARTCOLOR, this.startColor)
    if (variances & PV_INITIALCOLOR) this.startColorVar = color(STARTCOLORVARIANCE, this.startColorVar)
    if (evolutions & PE_COLOR) {
      this.endColor = color(ENDCOLOR, this.endColor)
      if (variances & PV_ENDINGCOLOR) this.endColorVar = color(ENDCOLORVARIANCE, this.endColorVar)
    }
    const texture = input(TEXTURE)
    // The exporter names a null texture reference after its parameter.
    this.texture = typeof texture === 'string' && texture !== 'Texture' ? texture : null
    this.initialTextureFrame = Math.trunc(num(STARTTEXTURE, this.initialTextureFrame))
    if (variances & PV_INITIALTEXTURE) this.initialTextureFrameVariance = Math.trunc(num(STARTTEXTUREVARIANCE, this.initialTextureFrameVariance))
    if (evolutions & PE_TEXTURE) {
      this.speedTextureFrame = Math.trunc(num(SPEEDTEXTURE, this.speedTextureFrame))
      if (variances & PV_SPEEDTEXTURE) this.speedTextureFrameVariance = Math.trunc(num(SPEEDTEXTUREVARIANCE, this.speedTextureFrameVariance))
    }
    this.textureFrameCount = Math.trunc(num(TEXTURECOUNT, this.textureFrameCount))
    this.textureFrameLoop = Math.trunc(num(TEXTURELOOP, this.textureFrameLoop))
  }

  /**
   * InitiateParticle and InitiateDirection. SphericalEmitter samples a
   * normalized cube point through the entity matrix and keeps the surface
   * normal; PointEmitter starts at the entity position and uses
   * ParticleEmitter::InitiateDirection, a yaw/pitch cone around the entity Z
   * axis through `TransformVector` (rotation and scale, no translation).
   */
  private initiate(entity: THREE.Matrix4, particle: Particle, position?: THREE.Vector3) {
    const random = this.random
    if (this.settings.shape === 'point' || this.settings.shape === 'timepoint') {
      // AddParticles2 places a time-point particle on the path before InitiateDirection.
      if (position) particle.pos.copy(position)
      else particle.pos.setFromMatrixPosition(entity)
      // The four RANDNUM calls in source order.
      let z = f(Math.cos(this.pitchVariation * random.randnum()))
      const x = f(z * Math.sin(this.yawVariation * random.randnum()))
      z = f(z * Math.cos(this.yawVariation * random.randnum()))
      const y = f(Math.sin(this.pitchVariation * random.randnum()))
      particle.dir.set(x, y, z).applyMatrix3(new THREE.Matrix3().setFromMatrix4(entity))
      return
    }
    const local = new THREE.Vector3(random.randnum(), random.randnum(), random.randnum()).normalize()
    particle.pos.copy(local).applyMatrix4(entity)
    // SphericalEmitter::InitiateDirection keeps the surface normal.
    particle.dir.copy(local).transformDirection(entity)
  }

  /** ParticleEmitter::AddParticles. */
  addParticles(entity: THREE.Matrix4) {
    const { variances } = this.settings
    let emits = variances & PV_EMISSION ? this.emitsPerFrame + Math.trunc(this.emitsVar * this.random.randnum()) : this.emitsPerFrame
    if (emits <= 0) return
    do {
      if (!this.emit(entity)) break
    } while (--emits)
  }

  /**
   * ParticleEmitter::AddParticles2 (0x25083540), the TimePointEmitter's
   * emission: rate x time above 0.9 fires floor(rate x time) particles (at
   * least one) along the path from the last position to the entity, then the
   * path starts again at the entity. The first call only records the position.
   */
  addParticlesTimed(entity: THREE.Matrix4, deltaMs: number) {
    if (!this.active) return
    const delta = f(deltaMs)
    const time = f((this.time + delta) * f(0.001))
    const emits = this.settings.variances & PV_EMISSION ? this.random.randnum() * this.emitsVar + this.emissionRate : this.emissionRate
    const product = emits * time
    const position = new THREE.Vector3().setFromMatrixPosition(entity)
    const current: [number, number, number] = [f(position.x), f(position.y), f(position.z)]
    if (product <= f(0.9) || this.firstTime) {
      this.time = f(this.time + delta)
      if (this.firstTime) { this.firstTime = false; this.timePosition = current }
      return
    }
    let count = Math.trunc(product)
    this.time = 0
    // x stays on the x87 stack; y and z go through float stores of the difference and 1/n.
    const inverse = 1 / count, inverseFloat = f(inverse)
    const step = [
      f((this.timePosition[0] - current[0]) * inverse),
      f(f(this.timePosition[1] - current[1]) * inverseFloat),
      f(f(this.timePosition[2] - current[2]) * inverseFloat),
    ]
    const at = [...current]
    do {
      if (!this.emit(entity, new THREE.Vector3(at[0], at[1], at[2]))) break
      for (let axis = 0; axis < 3; axis++) at[axis] = f(step[axis]! + at[axis]!)
    } while (--count > 0)
    this.timePosition = current
  }

  /** One particle of AddParticles / AddParticles2; false when the pool or Maximum Number is exhausted. */
  private emit(entity: THREE.Matrix4, position?: THREE.Vector3): boolean {
    const { variances, evolutions, renderMode } = this.settings
    const random = this.random
    if (this.particles.length >= this.settings.maximum || this.particles.length >= this.totalParticles) return false
    const p: Particle = {
      pos: new THREE.Vector3(), dir: new THREE.Vector3(), color: [0, 0, 0, 0], deltaColor: [0, 0, 0, 0],
      size: 0, deltaSize: 0, life: 0, angle: 0, deltaAngle: 0, deltaTime: 0.01, currentFrame: 0, currentFrametime: 0, deltaFrametime: 0,
    }
    this.particles.unshift(p)
    // The shipped AddParticles (0x250820E0) draws no m_Density rand(), unlike the SDK source.
    this.initiate(entity, p, position)
    p.dir.multiplyScalar(variances & PV_SPEED ? this.speed + this.speedVariation * random.randnum() : this.speed)
    // AddParticles' jump table (0x250821C2): modes 3 and 7 share the angular-speed branch.
    if (renderMode === PR_FSPRITE || renderMode === PR_SPRITE) {
      p.angle = 0
      p.deltaAngle = variances & PV_ANGULARSPEED ? this.angularSpeed + this.angularSpeedVariation * random.randnum() : 0
    } else {
      // PR_LINE and PR_OSPRITE use the angular speed as latency.
      p.angle = this.angularSpeed
      p.deltaAngle = this.angularSpeedVariation
    }
    p.life = variances & PV_LIFESPAN ? this.life + this.lifeVariation * random.randnum() : this.life
    if (p.life <= 0) p.life = 0.001
    const invlife = 1 / p.life
    for (let c = 0; c < 4; c++) p.color[c] = variances & PV_INITIALCOLOR ? this.startColor[c]! + this.startColorVar[c]! * random.randnum() : this.startColor[c]!
    if (evolutions & PE_COLOR) {
      for (let c = 0; c < 4; c++) {
        const end = variances & PV_ENDINGCOLOR ? this.endColor[c]! + this.endColorVar[c]! * random.randnum() : this.endColor[c]!
        p.deltaColor[c] = (end - p.color[c]!) * invlife
      }
    }
    p.size = variances & PV_INITIALSIZE ? this.startSize + this.startSizeVar * random.randnum() : this.startSize
    if (evolutions & PE_SIZE) {
      p.deltaSize = ((variances & PV_ENDINGSIZE ? this.endSize + this.endSizeVar * random.randnum() : this.endSize) - p.size) * invlife
    }
    // 0x25082516: modes 3 and 5..9 start their texture frames.
    if (renderMode === PR_SPRITE || renderMode === PR_OSPRITE || renderMode === PR_FSPRITE) {
      p.currentFrame = variances & PV_INITIALTEXTURE ? this.initialTextureFrame + Math.trunc(this.initialTextureFrameVariance * random.randnump()) : this.initialTextureFrame
      p.currentFrametime = 0
      p.deltaFrametime = evolutions & PE_TEXTURE && this.textureFrameCount > 1
        ? variances & PV_SPEEDTEXTURE ? this.speedTextureFrame + this.speedTextureFrameVariance * random.randnum() : this.speedTextureFrame
        : 0
    }
    return true
  }

  /** ParticleEmitter::UpdateParticles (no interactors or deflectors). */
  updateParticles(rdeltat: number) {
    const { evolutions, renderMode } = this.settings
    const alive: Particle[] = []
    for (const p of this.particles) {
      if (p.life <= 0) continue
      const deltat = p.life < rdeltat ? p.life : rdeltat
      p.angle += p.deltaAngle * deltat
      p.pos.addScaledVector(p.dir, deltat)
      if (evolutions & PE_COLOR) {
        for (let c = 0; c < 4; c++) p.color[c] = Math.min(1, Math.max(0, p.color[c]! + p.deltaColor[c]! * deltat))
      }
      if (evolutions & PE_SIZE) p.size += p.deltaSize * deltat
      if (p.deltaFrametime && evolutions & PE_TEXTURE && renderMode !== 4) this.advanceFrame(p, deltat)
      p.life -= deltat
      p.deltaTime = deltat
      alive.push(p)
    }
    this.particles = alive
  }

  private advanceFrame(p: Particle, deltat: number) {
    p.currentFrametime += deltat
    let dft = p.deltaFrametime, step = 1
    if (p.deltaFrametime < 0) { dft = -p.deltaFrametime; step = -1 }
    while (p.currentFrametime > dft) {
      p.currentFrame += step
      if (p.currentFrame >= this.textureFrameCount) {
        if (this.textureFrameLoop === PL_NOLOOP) p.currentFrame = this.textureFrameCount - 1
        else if (this.textureFrameLoop === PL_LOOP) p.currentFrame = 0
        else if (this.textureFrameLoop === PL_PINGPONG) { p.currentFrame = this.textureFrameCount - 2; p.deltaFrametime = -p.deltaFrametime }
      } else if (p.currentFrame < 0) {
        if (this.textureFrameLoop === PL_NOLOOP) p.currentFrame = 0
        else if (this.textureFrameLoop === PL_LOOP) p.currentFrame = this.textureFrameCount - 1
        else if (this.textureFrameLoop === PL_PINGPONG) { p.currentFrame = 1; p.deltaFrametime = -p.deltaFrametime }
      }
      p.currentFrametime -= dft
    }
  }
}

/** What a SphericalParticleSystem needs from its host. */
export interface GraphParticleBinding {
  /** The process-wide CRT generator (`RANDNUM` in the behavior itself). */
  readonly random: CrtRandom
  /** The emitter of one behavior instance, created at load (`CKM_BEHAVIORLOAD`) from its settings and inputs. */
  emitter(key: number, settings: ParticleSettings, input: (slot: number) => GraphParameterValue): OriginalParticleEmitter
  /** World matrix of the behavior's frame entity, in original units. */
  entity(owner: string): THREE.Matrix4 | undefined
  /** ShowParticles: attach or detach the render callback. */
  show(emitter: OriginalParticleEmitter, shown: boolean): void
  /**
   * CKM_BEHAVIORACTIVATESCRIPT / CKM_BEHAVIORDEACTIVATESCRIPT for behavior
   * `key`: its particles are shown again or hidden, and kept.
   */
  scriptActivated(key: number, active: boolean): void
}

const settingsOf = (local: (slot: number) => GraphParameterValue, shape: ParticleEmitterShape): ParticleSettings => {
  const int = (slot: number) => {
    const value = local(slot)
    if (typeof value !== 'number') throw new Error(`Particle system setting ${slot} is not exported`)
    return Math.trunc(value)
  }
  if (int(DEFLECTORS) !== 0 || int(INTERACTORS) !== 0) throw new Error('Particle deflectors and interactors are not implemented')
  return { shape, maximum: int(PARTICLENUMBER), renderMode: int(RENDERMODES), srcBlend: int(SRCBLEND), destBlend: int(DESTBLEND), evolutions: int(EVOLUTIONS), variances: int(VARIANCES) }
}

/**
 * GeneralParticleSystem.cpp for one emitter shape. On resets the emission
 * clock to the delay so one batch leaves on activation; Off stops emitting and
 * fires Exit Off once the last particle has died; Freeze toggles.
 */
const generalParticleSystem = (shape: ParticleEmitterShape): BehaviorFn => (context, state) => {
  const binding = context.particles
  if (!binding) throw new Error(`${context.node.name} ${context.node.index} has no particle binding`)
  const owner = context.owner()
  if (!owner) throw new Error(`${context.node.name} ${context.node.index} has no owner frame`)
  const emitter = binding.emitter(context.node.index, settingsOf(context.local, shape), slot => context.input(slot))
  // A reset behavior (Activate Script with reset) runs InitParticleSystem;
  // the activity starts from its saved local.
  if (state.activity === undefined) {
    emitter.init()
    const saved = context.local(1)
    state.activity = typeof saved === 'number' ? Math.trunc(saved) : INACTIVE
    state.emissionTime = 0
  }
  let activity = state.activity as number
  if (context.isInputActive(2)) {
    context.consumeInput(2)
    context.activate(2)
    if (activity & FREEZED) { activity &= ~FREEZED; emitter.active = true } else { activity |= FREEZED; emitter.active = false }
  } else if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.activate(0)
    // The clock starts at the delay so a batch is emitted on activation.
    state.emissionTime = typeof context.input(EMISSIONDELAY) === 'number' ? context.input(EMISSIONDELAY) : 0
    emitter.active = true
    activity |= ACTIVE
    binding.show(emitter, true)
  } else if (context.isInputActive(1)) {
    context.consumeInput(1)
    activity = INACTIVE
    emitter.active = false
  }
  state.activity = activity
  if (activity & FREEZED) return
  emitter.readInputs(slot => context.input(slot))
  const entity = binding.entity(owner)
  if (!entity) throw new Error(`${context.node.name} ${context.node.index} frame ${owner} is not in the scene`)
  const deltaTime = context.deltaMs
  let emissionTime = (state.emissionTime as number) + deltaTime
  if (activity) {
    const variance = context.input(EMISSIONDELAYVAR)
    const delay = (typeof context.input(EMISSIONDELAY) === 'number' ? context.input(EMISSIONDELAY) as number : 0) +
      (typeof variance === 'number' ? variance : 0) * binding.random.randnum()
    // The time-point system calls AddParticles2 instead of the delay loop and leaves the clock alone.
    if (shape === 'timepoint') emitter.addParticlesTimed(entity, deltaTime)
    else if (delay > 0) {
      while (emissionTime >= delay) { emissionTime -= delay; emitter.addParticles(entity) }
    } else emitter.addParticles(entity)
  }
  emitter.updateParticles(deltaTime)
  state.emissionTime = emissionTime
  if (!activity && emitter.particles.length === 0) {
    binding.show(emitter, false)
    context.activate(1)
    return
  }
  context.wait()
}

export const PARTICLE_BEHAVIORS: BehaviorRegistry = {
  SphericalParticleSystem: generalParticleSystem('spherical'),
  'Point Particle System': generalParticleSystem('point'),
  TT_TimedependentPointParticlesystem: generalParticleSystem('timepoint'),
}

/** The render callbacks' `RGBAFTOCOLOR(&color)`: the VxColor-pointer form. */
const byte = (value: number) => originalVxColorChannel(value) / 255

interface Draw {
  emitter: OriginalParticleEmitter
  object: THREE.LineSegments | THREE.Mesh
}

/**
 * The particle render callbacks. Each shown emitter is drawn after the scene
 * with its authored blend factors, Z test on and Z write off (blending is
 * enabled for these factors), culling off and texture MODULATEALPHA. Geometry
 * is rebuilt every frame from the particles, in original units under a group
 * that maps them to render space.
 */
export class OriginalParticleRenderer {
  readonly group = new THREE.Group()
  readonly random = new CrtRandom()
  private readonly draws = new Map<OriginalParticleEmitter, Draw>()
  private readonly textures: Map<string, THREE.Texture>

  constructor(textures: Map<string, THREE.Texture>, scale: number) {
    this.textures = textures
    this.group.name = 'original-particles'
    this.group.scale.set(scale, scale, -scale)
  }

  /**
   * The particle binding of one document instance (a placed module): its own
   * emitters by behavior node, its frames by `entities`, drawn here.
   */
  binding(entities: (owner: string) => THREE.Matrix4 | undefined): GraphParticleBinding & { readonly emitters: ReadonlyMap<number, OriginalParticleEmitter>; release(): void } {
    const emitters = new Map<number, OriginalParticleEmitter>()
    return {
      random: this.random,
      emitters,
      emitter: (key, settings, input) => {
        let emitter = emitters.get(key)
        if (!emitter) {
          emitter = new OriginalParticleEmitter(settings, this.random)
          emitter.readInputs(input)
          emitters.set(key, emitter)
        }
        return emitter
      },
      entity: entities,
      show: (emitter, shown) => this.show(emitter, shown),
      scriptActivated: (key, active) => {
        const emitter = emitters.get(key)
        if (emitter) this.show(emitter, active)
      },
      release: () => {
        for (const emitter of emitters.values()) this.show(emitter, false)
        emitters.clear()
      },
    }
  }

  get drawn(): number {
    return this.draws.size
  }

  private show(emitter: OriginalParticleEmitter, shown: boolean) {
    const existing = this.draws.get(emitter)
    if (!shown) {
      if (existing) { existing.object.removeFromParent(); existing.object.geometry.dispose(); (existing.object.material as THREE.Material).dispose(); this.draws.delete(emitter) }
      return
    }
    if (existing) return
    const { renderMode, srcBlend, destBlend } = emitter.settings
    const blend = {
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false, fog: false, vertexColors: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: BLEND_FACTORS[srcBlend]!, blendDst: BLEND_FACTORS[destBlend]!,
    }
    const geometry = new THREE.BufferGeometry()
    let object: THREE.LineSegments | THREE.Mesh
    if (renderMode === PR_LINE) {
      // RenderParticles_L draws untextured.
      object = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial(blend))
    } else {
      object = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial(blend))
    }
    object.frustumCulled = false
    object.renderOrder = 4
    this.group.add(object)
    this.draws.set(emitter, { emitter, object })
  }

  /** Rebuild every shown emitter's geometry for this frame's camera (render space). */
  render(camera: THREE.Camera) {
    camera.updateMatrixWorld()
    // The viewpoint's axes in original space (render Z is reflected).
    const reflect = new THREE.Vector3(1, 1, -1)
    const camright = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiply(reflect).normalize()
    const camup = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiply(reflect).normalize()
    const camdir = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2).multiply(reflect).normalize()
    for (const { emitter, object } of this.draws.values()) {
      if (object instanceof THREE.LineSegments) { this.writeLines(emitter, object.geometry); continue }
      // ParticleEmitter::SetState binds the emitter's current texture.
      const material = object.material as THREE.MeshBasicMaterial
      const map = emitter.texture === null ? null : this.textures.get(emitter.texture)
      if (map === undefined) throw new Error(`Particle texture ${emitter.texture} is not loaded`)
      if (material.map !== map) { material.map = map; material.needsUpdate = true }
      if (emitter.settings.renderMode === PR_FSPRITE) this.writeFacingSprites(emitter, object.geometry, camright, camup)
      else if (emitter.settings.renderMode === PR_SPRITE) this.writeSprites(emitter, object.geometry, camright, camup)
      else this.writeOrientedSprites(emitter, object.geometry, camdir)
    }
  }

  private writeLines(emitter: OriginalParticleEmitter, geometry: THREE.BufferGeometry) {
    const positions: number[] = [], colors: number[] = []
    const color = new THREE.Color()
    const push = (pos: THREE.Vector3, rgba: number[]) => {
      positions.push(pos.x, pos.y, pos.z)
      color.setRGB(byte(rgba[0]!), byte(rgba[1]!), byte(rgba[2]!), THREE.SRGBColorSpace)
      colors.push(color.r, color.g, color.b, byte(rgba[3]!))
    }
    for (const p of emitter.particles) {
      push(p.pos.clone().addScaledVector(p.dir, -p.deltaTime), p.color.map((c, i) => c - p.deltaColor[i]! * p.deltaTime))
      push(p.pos.clone().addScaledVector(p.dir, p.angle), p.color)
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  }

  private writeOrientedSprites(emitter: OriginalParticleEmitter, geometry: THREE.BufferGeometry, camdir: THREE.Vector3) {
    const positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = []
    let changeuv = false, step = 1, framehc = 0
    if (emitter.textureFrameCount > 1) { changeuv = true; framehc = 1 + Math.trunc(Math.sqrt(emitter.textureFrameCount - 1)); step = 1 / framehc }
    const color = new THREE.Color()
    const rgba = (value: number[]) => { color.setRGB(byte(value[0]!), byte(value[1]!), byte(value[2]!), THREE.SRGBColorSpace); return [color.r, color.g, color.b, byte(value[3]!)] }
    let vertex = 0
    for (const p of emitter.particles) {
      const old = p.pos.clone().addScaledVector(p.dir, -p.deltaTime)
      const oldsize = p.size - p.deltaSize * p.deltaTime
      const pos = p.pos.clone().addScaledVector(p.dir, p.angle)
      const vv = pos.clone().sub(old).normalize()
      const ww = new THREE.Vector3().crossVectors(camdir, vv).normalize()
      const col = rgba(p.color), oldcol = rgba(p.color.map((c, i) => c - p.deltaColor[i]! * p.deltaTime))
      let u = 0, v = 0
      if (changeuv) { let c = p.currentFrame; while (c >= framehc) { v += step; c -= framehc } u = c * step }
      const corners: [THREE.Vector3, number[], number, number][] = [
        [pos.clone().addScaledVector(vv, p.size).addScaledVector(ww, p.size), col, u, v],
        [pos.clone().addScaledVector(vv, p.size).addScaledVector(ww, -p.size), col, u + step, v],
        [old.clone().addScaledVector(vv, -oldsize).addScaledVector(ww, -oldsize), oldcol, u + step, v + step],
        [old.clone().addScaledVector(vv, -oldsize).addScaledVector(ww, oldsize), oldcol, u, v + step],
      ]
      for (const [position, c, cu, cv] of corners) {
        positions.push(position.x, position.y, position.z)
        colors.push(...c)
        // Three.js samples with v up.
        uvs.push(cu, 1 - cv)
      }
      indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3)
      vertex += 4
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
  }

  /** RenderParticles_FS: one camera-facing triangle per particle, turned by its angle. */
  /** RenderParticles_S: one camera-facing quad per particle, `size` wide, turned by its angle. */
  private writeSprites(emitter: OriginalParticleEmitter, geometry: THREE.BufferGeometry, camright: THREE.Vector3, camup: THREE.Vector3) {
    const positions: number[] = [], colors: number[] = [], uvs: number[] = [], indices: number[] = []
    let changeuv = false, step = 1, framehc = 0
    if (emitter.textureFrameCount > 1) { changeuv = true; framehc = 1 + Math.trunc(Math.sqrt(emitter.textureFrameCount - 1)); step = 1 / framehc }
    const color = new THREE.Color()
    let u = 0, v = 0
    let vertex = 0
    for (const p of emitter.particles) {
      // halfsize = m_Size * 0.5f; cr/cu = camera right/up scaled by it.
      const half = p.size * 0.5
      let cr = camright.clone().multiplyScalar(half)
      let cu = camup.clone().multiplyScalar(half)
      if (p.angle) {
        const cosa = Math.cos(p.angle), sina = Math.sin(p.angle)
        const rcr = cr.clone().multiplyScalar(cosa).addScaledVector(cu, -sina)
        const rcu = cr.clone().multiplyScalar(sina).addScaledVector(cu, cosa)
        cr = rcr; cu = rcu
      }
      color.setRGB(byte(p.color[0]), byte(p.color[1]), byte(p.color[2]), THREE.SRGBColorSpace)
      const col = [color.r, color.g, color.b, byte(p.color[3])]
      if (changeuv) { v = 0; let c = p.currentFrame; while (c >= framehc) { v += step; c -= framehc } u = c * step }
      // Vertex order of the DLL: (-cr,+cu) (+cr,+cu) (+cr,-cu) (-cr,-cu).
      const corners: [THREE.Vector3, number, number][] = [
        [p.pos.clone().sub(cr).add(cu), u, v],
        [p.pos.clone().add(cr).add(cu), u + step, v],
        [p.pos.clone().add(cr).sub(cu), u + step, v + step],
        [p.pos.clone().sub(cr).sub(cu), u, v + step],
      ]
      for (const [position, cu2, cv] of corners) {
        positions.push(position.x, position.y, position.z)
        colors.push(...col)
        // Three.js samples with v up.
        uvs.push(cu2, 1 - cv)
      }
      indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3)
      vertex += 4
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
  }

  private writeFacingSprites(emitter: OriginalParticleEmitter, geometry: THREE.BufferGeometry, camright: THREE.Vector3, camup: THREE.Vector3) {
    const positions: number[] = [], colors: number[] = [], uvs: number[] = []
    let changeuv = false, step = 1, framehc = 0
    if (emitter.textureFrameCount > 1) { changeuv = true; framehc = 1 + Math.trunc(Math.sqrt(emitter.textureFrameCount - 1)); step = 1 / framehc }
    const color = new THREE.Color()
    let u = 0, v = 0
    for (const p of emitter.particles) {
      let cr = camright.clone().multiplyScalar(p.size * 0.5)
      let cu = camup.clone().multiplyScalar(p.size * 0.5)
      if (p.angle) {
        const cosa = Math.cos(p.angle), sina = Math.sin(p.angle)
        const rcr = cr.clone().multiplyScalar(cosa).addScaledVector(cu, -sina)
        const rcu = cr.clone().multiplyScalar(sina).addScaledVector(cu, cosa)
        cr = rcr; cu = rcu
      }
      color.setRGB(byte(p.color[0]), byte(p.color[1]), byte(p.color[2]), THREE.SRGBColorSpace)
      const col = [color.r, color.g, color.b, byte(p.color[3])]
      if (changeuv) { v = 0; let c = p.currentFrame; while (c >= framehc) { v += step; c -= framehc } u = c * step }
      const corners: [THREE.Vector3, number, number][] = [
        [p.pos.clone().add(cu), u + step * 0.5, v],
        [p.pos.clone().add(cr).sub(cu), u + step, v + step],
        [p.pos.clone().sub(cr).sub(cu), u, v + step],
      ]
      for (const [position, cu2, cv] of corners) {
        positions.push(position.x, position.y, position.z)
        colors.push(...col)
        // Three.js samples with v up.
        uvs.push(cu2, 1 - cv)
      }
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  }

  dispose() {
    for (const emitter of [...this.draws.keys()]) this.show(emitter, false)
    this.group.removeFromParent()
  }
}
