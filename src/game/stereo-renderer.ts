import * as THREE from 'three'

/** Output layouts supported by the optional stereo compositor. */
export type StereoMode = 'off' | 'sbs' | 'crossview' | 'sbs-full' | 'tab' | 'tab-full' | 'leia-sr' | 'interlaced' | 'interlaced-reversed'

/** The Leia SR layout, available only when the Electron shell is running its offscreen pair. */
export const LEIA_STEREO_MODE = 'leia-sr' as const

/** The shell's Leia bridge (`electron/preload.cjs`); undefined in the browser. */
export interface ShellLeiaInfo {
  available: boolean
  active: boolean
  weaveSize: { width: number; height: number }
}

export function shellLeiaInfo(): ShellLeiaInfo | undefined {
  return typeof window === 'undefined' ? undefined : window.ballanceShell?.leia
}

/** The shell reports Leia support (a normal shell window, not necessarily started in Leia mode). */
export function shellLeiaAvailable(): boolean {
  return shellLeiaInfo()?.available === true
}

/** This run's page is the offscreen full eye pair. */
export function shellLeiaActive(): boolean {
  return shellLeiaInfo()?.active === true
}

export interface StereoSettings {
  mode: StereoMode
  /** Eye separation in the world's rendered units. */
  separation: number
  /** Distance at which the two eye views converge, in rendered units. */
  convergence: number
  /** HUD/menu pop-out, 0 = screen depth, 100 = maximum disparity (%). */
  uiDepth: number
  /** Apply this configuration automatically when the app starts. */
  defaultEnabled: boolean
}

export const DEFAULT_STEREO_SETTINGS: StereoSettings = {
  mode: 'off',
  separation: 0.08,
  convergence: 20,
  uiDepth: 0,
  defaultEnabled: false,
}

/** Overlay disparity at 100% UI Depth and the default separation. */
const HUD_MAX_FUSED_DISPARITY = 0.024
/**
 * Per-eye HUD shift magnitude in CSS pixels. Positive values put the overlay
 * in front of the screen; the mode CSS applies the appropriate inward sign
 * for SBS, crossview and interlaced layouts. Separation rules the strength of
 * the whole picture, so the shift grows with it in proportion, measured from
 * the default separation.
 */
export function computeHudEyeShift(stageWidth: number, separation: number, uiDepth: number) {
  if (!(stageWidth > 0) || !(separation > 0) || !(uiDepth > 0)) return 0
  const depth = Math.min(1, Math.max(0, uiDepth / 100))
  const fusedDisparity = HUD_MAX_FUSED_DISPARITY * depth * separation / DEFAULT_STEREO_SETTINGS.separation
  return Math.round(stageWidth * fusedDisparity / 2 * 100) / 100
}

const modeIndex: Record<StereoMode, number> = {
  off: 0,
  sbs: 1,
  crossview: 2,
  'sbs-full': 3,
  tab: 4,
  'tab-full': 5,
  interlaced: 6,
  'interlaced-reversed': 7,
  // The page is the full pair, so the composite addresses the same horizontal
  // halves as sbs-full; the index only selects that branch in the shader.
  'leia-sr': 8,
}

// Pixel-unit policy. Three's WebGLRenderer.setViewport takes CSS/logical
// units and scales by the pixel ratio internally, so this renderer never
// calls setViewport with drawing-buffer dimensions: setRenderTarget selects
// the full target/canvas viewport on its own. All sizes below are physical
// framebuffer pixels unless the name says otherwise.
export interface StereoTargetSizes {
  eyeTargetWidth: number
  eyeTargetHeight: number
}

/**
 * Drawing-buffer packing relative to one eye frame. Half layouts keep one
 * buffer and squeeze both eyes into it; full layouts keep each eye frame at
 * the selected render resolution and double the buffer along the packing axis.
 * The canvas CSS display box stays the size of the mono frame, so the browser
 * scales the doubled buffer into it. Leia SR needs no doubling: its page CSS
 * box is already the full pair, so the drawing buffer equals the window.
 */
export function computeStereoBufferScale(mode: StereoMode): { width: number; height: number } {
  if (mode === 'sbs-full') return { width: 2, height: 1 }
  if (mode === 'tab-full') return { width: 1, height: 2 }
  return { width: 1, height: 1 }
}

/** Physical size of one eye frame for the actual (possibly packed) drawing buffer. */
export function computeStereoEyeFrameSize(mode: StereoMode, drawingBufferWidth: number, drawingBufferHeight: number): { width: number; height: number } {
  const bufferWidth = Math.max(1, Math.floor(drawingBufferWidth))
  const bufferHeight = Math.max(1, Math.floor(drawingBufferHeight))
  // Leia's buffer is the full pair, so unlike the other 1:1 packings its eye
  // frame is half of it; its targets use the same half width (see
  // computeStereoTargetSizes) and its eye camera must not squeeze.
  if (mode === 'leia-sr') return { width: Math.max(1, Math.floor(bufferWidth / 2)), height: bufferHeight }
  const packing = computeStereoBufferScale(mode)
  return {
    width: Math.max(1, Math.floor(bufferWidth / packing.width)),
    height: Math.max(1, Math.floor(bufferHeight / packing.height)),
  }
}

/** Eye-camera aspect: the selected screen mode's aspect (one eye frame), never the packed buffer's. */
export function computeStereoEyeAspect(mode: StereoMode, drawingBufferWidth: number, drawingBufferHeight: number): number {
  const frame = computeStereoEyeFrameSize(mode, drawingBufferWidth, drawingBufferHeight)
  return frame.width / frame.height
}

/**
 * Physical eye-target size for a mode, actual (possibly packed) drawing-buffer
 * size and eye render scale. Horizontal layouts store each eye in half the
 * buffer's width; vertical layouts in half its height; the full layouts pack
 * eyes into a doubled buffer, so their targets are the full eye frame.
 */
export function computeStereoTargetSizes(mode: StereoMode, drawingBufferWidth: number, drawingBufferHeight: number, eyeRenderScale: number): StereoTargetSizes {
  const bufferWidth = Math.max(1, Math.floor(drawingBufferWidth))
  const bufferHeight = Math.max(1, Math.floor(drawingBufferHeight))
  const horizontal = mode === 'sbs' || mode === 'crossview' || mode === 'sbs-full' || mode === 'leia-sr'
  const vertical = mode === 'tab' || mode === 'tab-full'
  const baseWidth = horizontal ? Math.max(1, Math.floor(bufferWidth / 2)) : bufferWidth
  const baseHeight = vertical ? Math.max(1, Math.floor(bufferHeight / 2)) : bufferHeight
  const scale = Number.isFinite(eyeRenderScale) && eyeRenderScale > 0 ? Math.min(1, eyeRenderScale) : 1
  return { eyeTargetWidth: Math.max(1, Math.floor(baseWidth * scale)), eyeTargetHeight: Math.max(1, Math.floor(baseHeight * scale)) }
}

/** Canvas backing-store pixel ratio for a mode. Either interlaced mode must
 * match the live device pixel ratio exactly: any browser resampling between
 * backing-store rows and physical display rows destroys the odd/even-row
 * parity passive line interlacing requires. All adaptive reduction goes to
 * the eye buffers instead. Other modes follow the render budget. */
export function computeCanvasPixelRatio(mode: StereoMode, budgetRatio: number, _budgetMaximum: number, devicePixelRatio: number): number {
  if (mode === 'interlaced' || mode === 'interlaced-reversed') {
    return Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  }
  return budgetRatio
}

/** Eye-buffer scale relative to the canvas backing store. Always <= 1. */
export function computeEyeRenderScale(canvasPixelRatio: number, budgetRatio: number): number {
  if (!(canvasPixelRatio > 0)) return 1
  return Math.min(1, budgetRatio / canvasPixelRatio)
}

// Parallel off-axis stereo. Both eyes keep the main camera orientation and
// are displaced by half the separation along its local X axis; the
// zero-parallax plane sits at the convergence distance via an asymmetric
// frustum shift, never a camera rotation. With separation 0 the shift is 0
// and each eye reproduces the main projection. Eye cameras always use one eye
// frame's aspect: SBS/crossview store that projection in half-width targets,
// which compresses each eye horizontally for the display's half-SBS
// expansion, and tab squeezes it vertically. Full layouts and interlaced
// targets span a full eye frame, so no compression happens there.
export function offAxisProjectionShift(separation: number, convergence: number, fovDegrees: number, aspect: number): number {
  if (!(separation > 0) || !(convergence > 0) || !(aspect > 0)) return 0
  const halfFovTan = Math.tan(THREE.MathUtils.degToRad(fovDegrees) / 2)
  if (!(halfFovTan > 0)) return 0
  return separation / (2 * convergence * halfFovTan * aspect)
}

/** Position an eye camera parallel to the main camera with its frustum
 * shifted so the convergence plane stays centered. side -1 is the left eye. */
export function updateStereoEyeCamera(main: THREE.PerspectiveCamera, eye: THREE.PerspectiveCamera, side: -1 | 1, separation: number, convergence: number, aspect: number) {
  main.updateMatrixWorld()
  eye.fov = main.fov
  eye.aspect = aspect
  eye.near = main.near
  eye.far = main.far
  eye.up.copy(main.up)
  const rotation = new THREE.Quaternion().setFromRotationMatrix(main.matrixWorld)
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation).normalize()
  eye.position.setFromMatrixPosition(main.matrixWorld).addScaledVector(right, side * separation * 0.5)
  eye.quaternion.copy(rotation)
  eye.updateProjectionMatrix()
  const shift = offAxisProjectionShift(separation, convergence, main.fov, aspect)
  eye.projectionMatrix.elements[8]! += side < 0 ? shift : -shift
  eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert()
  eye.updateMatrixWorld()
}

/**
 * A pass drawn behind the scene with its own camera (the original's TT Sky).
 * `render` clears the current target and draws for the given eye camera; the
 * scene is then drawn over it without clearing.
 */
export interface StereoBackground {
  readonly visible: boolean
  render(renderer: THREE.WebGLRenderer, eye: THREE.PerspectiveCamera): void
}

/**
 * A screen-space layer drawn over the scene in each view (the original's 2D
 * entities): an orthographic camera over the window in pixels, depth cleared
 * first. In stereo each eye's copy is shifted horizontally by the HUD
 * disparity of `computeHudEyeShift` (left eye right, right eye left), so the
 * layer sits at the UI Depth like the DOM HUD.
 */
export interface StereoOverlay {
  readonly scene: THREE.Scene
  readonly camera: THREE.OrthographicCamera
  /** The window width in CSS pixels the eye shift is measured against. */
  readonly cssWidth: number
}

/**
 * An eye target that behaves like the canvas. Three only encodes shader output
 * to `outputColorSpace` (and applies tone mapping) when drawing to the canvas
 * or to an XR target; any other target receives linear working-space color, so
 * blending would run on linear values. The original (D3D) and the mono path
 * blend sRGB-encoded values, which matters for additive effects. Flagging the
 * target as XR makes Three encode to the texture's sRGB color space, and the
 * explicit RGBA8 storage keeps the blend on the encoded values (an SRGB8_ALPHA8
 * attachment would decode, blend linearly and re-encode).
 */
export function createEyeTarget(options: THREE.RenderTargetOptions, name: string) {
  const target = new THREE.WebGLRenderTarget(1, 1, { ...options, colorSpace: THREE.SRGBColorSpace, internalFormat: 'RGBA8' })
  ;(target as THREE.WebGLRenderTarget & { isXRRenderTarget: boolean }).isXRRenderTarget = true
  target.texture.name = name
  return target
}

/**
 * Renders the game twice and composites the two views into one canvas.
 *
 * The normal (off) path remains a single renderer.render call. Stereo uses
 * parallel off-axis eye cameras and a small fullscreen shader, keeping
 * physics, scene ownership and audio completely independent of display mode.
 * Eye targets reproduce the canvas' color encoding, so blending matches mono.
 */
export class StereoRenderer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly leftCamera = new THREE.PerspectiveCamera()
  private readonly rightCamera = new THREE.PerspectiveCamera()
  private readonly leftTarget: THREE.WebGLRenderTarget
  private readonly rightTarget: THREE.WebGLRenderTarget
  private readonly compositeScene = new THREE.Scene()
  private readonly compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly compositeMaterial: THREE.ShaderMaterial
  private readonly compositeQuad: THREE.Mesh
  private readonly scratchBufferSize = new THREE.Vector2()
  private settings: StereoSettings = { ...DEFAULT_STEREO_SETTINGS }
  private budgetRatio = 1
  private budgetMaximum = 1
  private devicePixelRatio = 1
  private cachedMode: StereoMode | '' = ''
  private cachedDrawingBufferWidth = 0
  private cachedDrawingBufferHeight = 0
  private cachedEyeTargetWidth = 0
  private cachedEyeTargetHeight = 0

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    const targetOptions: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
    }
    this.leftTarget = createEyeTarget(targetOptions, 'Ballance Stereo Left')
    this.rightTarget = createEyeTarget(targetOptions, 'Ballance Stereo Right')
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        leftTexture: { value: this.leftTarget.texture },
        rightTexture: { value: this.rightTarget.texture },
        mode: { value: modeIndex.off },
        bufferHeight: { value: 1 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D leftTexture;
        uniform sampler2D rightTexture;
        uniform float mode;
        uniform float bufferHeight;
        varying vec2 vUv;
        void main() {
          if (mode < 3.5 || mode > 7.5) {
            // Horizontal layouts (sbs, crossview, sbs-full, leia-sr) share the
            // buffer's width between the eyes. Half layouts use half-width
            // targets so geometry is not stretched when the two images share
            // the output canvas; full layouts use full frames in a doubled
            // buffer; leia-sr's page is the pair itself.
            bool crossview = mode > 1.5 && mode < 2.5;
            if (vUv.x < 0.5) {
              if (crossview) gl_FragColor = texture2D(rightTexture, vec2(vUv.x * 2.0, vUv.y));
              else gl_FragColor = texture2D(leftTexture, vec2(vUv.x * 2.0, vUv.y));
            } else {
              if (crossview) gl_FragColor = texture2D(leftTexture, vec2((vUv.x - 0.5) * 2.0, vUv.y));
              else gl_FragColor = texture2D(rightTexture, vec2((vUv.x - 0.5) * 2.0, vUv.y));
            }
          } else if (mode < 5.5) {
            // Vertical layouts (tab, tab-full): left eye on top, right eye on
            // the bottom. gl_FragCoord is bottom-up, so vUv.y < 0.5 is the
            // bottom of the displayed canvas.
            if (vUv.y < 0.5) gl_FragColor = texture2D(rightTexture, vec2(vUv.x, vUv.y * 2.0));
            else gl_FragColor = texture2D(leftTexture, vec2(vUv.x, (vUv.y - 0.5) * 2.0));
          } else {
            // Rows count from the top, like the menu overlay's row masks, so
            // the top row is the left eye whatever the buffer height.
            // gl_FragCoord is bottom-up. This addressing is only 1:1 with the
            // display when the canvas backing store runs at full physical
            // resolution; see the size policy in syncRenderSizes.
            bool useLeft = mod(floor(bufferHeight - gl_FragCoord.y), 2.0) < 1.0;
            if (mode > 6.5) useLeft = !useLeft;
            if (useLeft) gl_FragColor = texture2D(leftTexture, vUv);
            else gl_FragColor = texture2D(rightTexture, vUv);
          }
          // Eye targets already hold output-encoded color (see
          // createEyeTarget), so they are copied without re-encoding.
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.compositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial)
    this.compositeQuad.frustumCulled = false
    this.compositeScene.add(this.compositeQuad)
  }

  setSettings(next: StereoSettings) {
    this.settings = {
      mode: next.mode,
      separation: THREE.MathUtils.clamp(Number.isFinite(next.separation) ? next.separation : DEFAULT_STEREO_SETTINGS.separation, 0, 1),
      convergence: THREE.MathUtils.clamp(Number.isFinite(next.convergence) ? next.convergence : DEFAULT_STEREO_SETTINGS.convergence, 1, 200),
      uiDepth: THREE.MathUtils.clamp(Number.isFinite(next.uiDepth) ? next.uiDepth : DEFAULT_STEREO_SETTINGS.uiDepth, 0, 100),
      defaultEnabled: !!next.defaultEnabled,
    }
    this.compositeMaterial.uniforms.mode!.value = modeIndex[this.settings.mode]
  }

  getSettings(): StereoSettings {
    return { ...this.settings }
  }

  /** Adaptive render-budget scales; the canvas/eye split happens in sync. */
  setBudgetScale(budgetRatio: number, budgetMaximum: number, devicePixelRatio: number) {
    if (Number.isFinite(budgetRatio) && budgetRatio > 0) this.budgetRatio = budgetRatio
    if (Number.isFinite(budgetMaximum) && budgetMaximum > 0) this.budgetMaximum = budgetMaximum
    if (Number.isFinite(devicePixelRatio) && devicePixelRatio > 0) this.devicePixelRatio = devicePixelRatio
  }

  /** Owns the canvas-pixel-ratio and eye-target invariant. Only reallocates
   * backing stores when the computed dimensions actually change. */
  private syncRenderSizes() {
    const mode = this.settings.mode
    const canvasPixelRatio = computeCanvasPixelRatio(mode, this.budgetRatio, this.budgetMaximum, this.devicePixelRatio)
    if (Math.abs(this.renderer.getPixelRatio() - canvasPixelRatio) > 1e-6) this.renderer.setPixelRatio(canvasPixelRatio)
    this.renderer.getDrawingBufferSize(this.scratchBufferSize)
    const drawingBufferWidth = Math.max(1, Math.floor(this.scratchBufferSize.x))
    const drawingBufferHeight = Math.max(1, Math.floor(this.scratchBufferSize.y))
    this.compositeMaterial.uniforms.bufferHeight!.value = drawingBufferHeight
    const eyeRenderScale = mode === 'off' ? 1 : computeEyeRenderScale(canvasPixelRatio, this.budgetRatio)
    const { eyeTargetWidth, eyeTargetHeight } = computeStereoTargetSizes(mode, drawingBufferWidth, drawingBufferHeight, eyeRenderScale)
    if (mode !== this.cachedMode || drawingBufferWidth !== this.cachedDrawingBufferWidth || drawingBufferHeight !== this.cachedDrawingBufferHeight || eyeTargetWidth !== this.cachedEyeTargetWidth || eyeTargetHeight !== this.cachedEyeTargetHeight) {
      if (mode !== 'off') {
        this.leftTarget.setSize(eyeTargetWidth, eyeTargetHeight)
        this.rightTarget.setSize(eyeTargetWidth, eyeTargetHeight)
      }
      this.cachedMode = mode
      this.cachedDrawingBufferWidth = drawingBufferWidth
      this.cachedDrawingBufferHeight = drawingBufferHeight
      this.cachedEyeTargetWidth = eyeTargetWidth
      this.cachedEyeTargetHeight = eyeTargetHeight
    }
  }

  /** One view: the optional background pass, then the scene over it. */
  private renderView(scene: THREE.Scene, camera: THREE.PerspectiveCamera, background?: StereoBackground) {
    if (!background?.visible) {
      this.renderer.render(scene, camera)
      return
    }
    background.render(this.renderer, camera)
    const autoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    try {
      // The background writes no depth; only the depth left by the clear remains.
      this.renderer.render(scene, camera)
    } finally {
      this.renderer.autoClear = autoClear
    }
  }

  /** The overlay over the current view, shifted by `shift` (a fraction of the window width, positive to the right). */
  private renderOverlay(overlay: StereoOverlay, shift: number) {
    const camera = overlay.camera
    const left = camera.left, right = camera.right
    const offset = (right - left) * shift
    camera.left = left - offset; camera.right = right - offset
    camera.updateProjectionMatrix()
    const autoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    try {
      this.renderer.clearDepth()
      this.renderer.render(overlay.scene, camera)
    } finally {
      this.renderer.autoClear = autoClear
      camera.left = left; camera.right = right
      camera.updateProjectionMatrix()
    }
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, background?: StereoBackground, overlay?: StereoOverlay) {
    this.syncRenderSizes()
    if (this.settings.mode === 'off') {
      this.renderer.shadowMap.autoUpdate = true
      this.renderer.setRenderTarget(null)
      this.renderer.setScissorTest(false)
      this.renderView(scene, camera, background)
      if (overlay) this.renderOverlay(overlay, 0)
      return
    }
    const shift = overlay && overlay.cssWidth > 0 ? computeHudEyeShift(overlay.cssWidth, this.settings.separation, this.settings.uiDepth) / overlay.cssWidth : 0

    // Both eyes share one shadow-map update per displayed frame; the second
    // eye reuses it. Shadow content depends only on lights and scene state,
    // which do not change between the two eye renders of the same frame.
    // The caller's autoUpdate state is restored afterwards, so the composite
    // (which holds no lights) never triggers a second update.
    const previousShadowAutoUpdate = this.renderer.shadowMap.autoUpdate
    this.renderer.shadowMap.autoUpdate = false
    if (previousShadowAutoUpdate) this.renderer.shadowMap.needsUpdate = true
    try {
      // The eye projection must match one eye frame's aspect (the selected
      // screen mode), never the packed buffer's. SBS and crossview then pack
      // that projection into half-width targets, which is the horizontal
      // compression a half-SBS display expands again; top-and-bottom layouts
      // squeeze vertically where their buffers are not full-height.
      const eyeAspect = computeStereoEyeAspect(this.settings.mode, this.cachedDrawingBufferWidth, this.cachedDrawingBufferHeight)
      updateStereoEyeCamera(camera, this.leftCamera, -1, this.settings.separation, this.settings.convergence, eyeAspect)
      updateStereoEyeCamera(camera, this.rightCamera, 1, this.settings.separation, this.settings.convergence, eyeAspect)

      this.renderer.setScissorTest(false)
      this.renderer.setRenderTarget(this.leftTarget)
      this.renderer.clear()
      this.renderView(scene, this.leftCamera, background)
      if (overlay) this.renderOverlay(overlay, shift)
      this.renderer.setRenderTarget(this.rightTarget)
      this.renderer.clear()
      this.renderView(scene, this.rightCamera, background)
      if (overlay) this.renderOverlay(overlay, -shift)
    } finally {
      this.renderer.shadowMap.autoUpdate = previousShadowAutoUpdate
    }

    this.renderer.setRenderTarget(null)
    this.renderer.render(this.compositeScene, this.compositeCamera)
  }

  dispose() {
    this.leftTarget.dispose()
    this.rightTarget.dispose()
    this.compositeQuad.geometry.dispose()
    this.compositeMaterial.dispose()
  }
}
