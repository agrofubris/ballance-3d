import * as THREE from 'three'

/**
 * The Virtools/D3D fixed-function lighting the original renders every mesh
 * with (CKRenderEngine: lighting on, Gouraud shading, local viewer,
 * normalized normals, colours from the material; every shipped mesh is
 * VX_LITMESH). Per vertex:
 *
 *   colour   = clamp(Ce + Ca·Ga + Cd·Σ Ld·max(N·L, 0)·att)
 *   specular = clamp(Cs·Σ Ls·(N·H)^P·att), only when P > 0.05 and N·L > 0
 *
 * with H = normalize(L + V) and, for point lights, att = 1/(a0 + a1·d + a2·d²)
 * within Range (d in original units). The texture stage then combines it with
 * the texture (MODULATE/MODULATEALPHA, or DECALALPHA), the specular is added,
 * and fog mixes towards its colour. All of this happens on the stored byte
 * values (gamma space), as on the D3D framebuffer; the shader converts the
 * result to linear only so the renderer's output encoding restores them.
 */

/** CKScene's default ambient (0x0F0F0F); no shipped file saves a scene. */
export const ORIGINAL_SCENE_AMBIENT = 15 / 255
const MAX_LIGHTS = 8
const LIGHT_POINT = 1, LIGHT_DIRECTIONAL = 3
/** VXTEXTURE_BLENDMODE values that occur in the shipped materials. */
export const TEXTUREBLEND_MODULATE = 2, TEXTUREBLEND_DECALALPHA = 3, TEXTUREBLEND_MODULATEALPHA = 4

/** An authored CKLight in the scene. */
export interface OriginalLightSource {
  readonly light: THREE.DirectionalLight | THREE.PointLight
  /** CKLight specular flag (0x200): specular = colour · power. */
  readonly specular: boolean
  /** Point lights: constant, linear and quadratic attenuation. */
  readonly attenuation?: readonly [number, number, number]
  /** Point lights: Range, in original units. */
  readonly range?: number
}

/** The scene's lights and ambient, shared by every fixed-function material. */
export class OriginalLighting {
  readonly sources: OriginalLightSource[] = []
  readonly uniforms = {
    ffAmbient: { value: new THREE.Vector3(ORIGINAL_SCENE_AMBIENT, ORIGINAL_SCENE_AMBIENT, ORIGINAL_SCENE_AMBIENT) },
    ffLightCount: { value: 0 },
    ffLightType: { value: new Int32Array(MAX_LIGHTS) },
    ffLightColor: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    ffLightSpecular: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    /** Directional: unit vector toward the light; point: its position (render space). */
    ffLightVector: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    ffLightAttenuation: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3(1, 0, 0)) },
    ffLightRange: { value: new Float32Array(MAX_LIGHTS) },
    /** Render units per original unit. */
    ffUnit: { value: 1 },
  }

  /** `unit`: render units per original unit. */
  constructor(unit: number) {
    this.uniforms.ffUnit.value = unit
  }

  add(source: OriginalLightSource) {
    if (source.light instanceof THREE.PointLight && (!source.attenuation || source.range === undefined)) throw new Error(`Point light ${source.light.name} needs its attenuation and range`)
    this.sources.push(source)
    return source
  }

  /**
   * CKLight::Setup for this frame: hidden lights are skipped; the diffuse is
   * the colour times the power (`intensity`), the specular the same when the
   * specular flag is set.
   */
  update() {
    const u = this.uniforms
    let count = 0
    for (const source of this.sources) {
      const light = source.light
      let visible = true
      for (let object: THREE.Object3D | null = light; object; object = object.parent) if (!object.visible) visible = false
      if (!visible) continue
      if (count === MAX_LIGHTS) throw new Error('More than 8 active original lights')
      light.updateMatrixWorld()
      const color = u.ffLightColor.value[count]!.set(light.color.r, light.color.g, light.color.b).multiplyScalar(light.intensity)
      u.ffLightSpecular.value[count]!.copy(source.specular ? color : new THREE.Vector3())
      const position = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld)
      if (light instanceof THREE.DirectionalLight) {
        light.target.updateMatrixWorld()
        u.ffLightType.value[count] = LIGHT_DIRECTIONAL
        u.ffLightVector.value[count]!.copy(position.sub(new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld)).normalize())
      } else {
        u.ffLightType.value[count] = LIGHT_POINT
        u.ffLightVector.value[count]!.copy(position)
        u.ffLightAttenuation.value[count]!.set(...source.attenuation!)
        u.ffLightRange.value[count] = source.range!
      }
      count++
    }
    u.ffLightCount.value = count
  }
}

const vertexShader = `
#include <common>
#include <uv_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform vec3 ffMaterialAmbient;
uniform vec3 ffAmbient;
uniform int ffLightCount;
uniform int ffLightType[${MAX_LIGHTS}];
uniform vec3 ffLightColor[${MAX_LIGHTS}];
uniform vec3 ffLightSpecular[${MAX_LIGHTS}];
uniform vec3 ffLightVector[${MAX_LIGHTS}];
uniform vec3 ffLightAttenuation[${MAX_LIGHTS}];
uniform float ffLightRange[${MAX_LIGHTS}];
uniform float ffUnit;
uniform float opacity;
#ifdef FF_PRELIT
uniform vec4 ffPrelitColor;
uniform vec3 ffPrelitSpecular;
#endif
varying vec3 vFFColor;
varying float vFFAlpha;
varying vec3 vFFSpecular;
void main() {
  #include <uv_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  #include <fog_vertex>
#ifdef FF_PRELIT
  // Lighting off: the vertex colour and specular are the prelit ones.
  vFFColor = ffPrelitColor.rgb;
  vFFAlpha = ffPrelitColor.a;
  vFFSpecular = ffPrelitSpecular;
#else
  vFFAlpha = opacity;
  vec3 worldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec3 n = normalize(inverse(transpose(mat3(modelMatrix))) * normal);
  vec3 toEye = normalize(cameraPosition - worldPosition);
  vec3 lit = vec3(0.0), shine = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= ffLightCount) break;
    vec3 l = ffLightVector[i];
    float attenuation = 1.0;
    if (ffLightType[i] == ${LIGHT_POINT}) {
      vec3 offset = ffLightVector[i] - worldPosition;
      float distance = length(offset) / ffUnit;
      if (distance > ffLightRange[i]) continue;
      l = normalize(offset);
      vec3 a = ffLightAttenuation[i];
      attenuation = 1.0 / (a.x + a.y * distance + a.z * distance * distance);
    }
    float nl = dot(n, l);
    if (nl <= 0.0) continue;
    lit += ffLightColor[i] * nl * attenuation;
#ifdef FF_SPECULAR
    shine += ffLightSpecular[i] * pow(max(dot(n, normalize(l + toEye)), 0.0), shininess) * attenuation;
#endif
  }
  vFFColor = clamp(emissive + ffMaterialAmbient * ffAmbient + diffuse * lit, 0.0, 1.0);
  vFFSpecular = clamp(specular * shine, 0.0, 1.0);
#endif
}
`

const fragmentShader = `
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphatest_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec3 vFFColor;
varying float vFFAlpha;
varying vec3 vFFSpecular;
void main() {
  #include <clipping_planes_fragment>
  vec4 color = vec4(vFFColor, vFFAlpha);
#ifdef USE_MAP
  vec4 texel = texture2D(map, vMapUv);
#ifdef FF_MAP_SRGB
  // Back to the stored bytes the D3D texture stage combines.
  texel = sRGBTransferOETF(texel);
#endif
#ifdef FF_DECALALPHA
  color.rgb = mix(color.rgb, texel.rgb, texel.a);
#else
  color *= texel;
#endif
#endif
#ifdef USE_ALPHATEST
#ifdef FF_STRICT_ALPHATEST
  if (color.a <= alphaTest) discard;
#else
  if (color.a < alphaTest) discard;
#endif
#endif
  color.rgb = min(color.rgb + vFFSpecular, vec3(1.0));
#ifdef USE_FOG
#ifdef FOG_EXP2
  float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
#else
  // VXFOG_LINEAR on eye-space depth.
  float fogFactor = clamp((vFogDepth - fogNear) / (fogFar - fogNear), 0.0, 1.0);
#endif
  color.rgb = mix(color.rgb, sRGBTransferOETF(vec4(fogColor, 1.0)).rgb, fogFactor);
#endif
  gl_FragColor = sRGBTransferEOTF(color);
  #include <logdepthbuf_fragment>
  #include <colorspace_fragment>
}
`

/**
 * A CKMaterial rendered with the fixed-function equation above. It keeps the
 * Phong material's colour, emissive, specular, shininess, opacity, map, alpha
 * test, blending and depth state, adds the material ambient and the texture
 * blend mode, and reads the scene's lights from `lighting`.
 */
export class OriginalFixedFunctionMaterial extends THREE.MeshPhongMaterial {
  readonly isOriginalFixedFunctionMaterial = true
  /** CKMaterial ambient (Ca). */
  readonly ambientColor = new THREE.Color(0, 0, 0)
  /** SpecularPower > 0.05 enables specular (CKMaterial::SetAsCurrent). */
  specularEnabled = false
  textureBlendMode = TEXTUREBLEND_MODULATEALPHA
  /** D3D GREATER: pass strictly above the reference. */
  strictAlphaTest = false
  /** `Set Prelit Color`: lighting off, vertex colour (rgba) and specular from here. */
  prelit: { color: THREE.Vector4; specular: THREE.Color } | null = null
  lighting: OriginalLighting | null = null

  constructor(parameters?: THREE.MeshPhongMaterialParameters) {
    super(parameters)
    // The equation is the material's own; the program must not depend on Three's light setup.
    this.onBeforeCompile = shader => this.compile(shader)
  }

  private compile(shader: THREE.WebGLProgramParametersWithUniforms) {
    if (!this.lighting) throw new Error(`Original material ${this.name} has no lighting`)
    if (this.textureBlendMode !== TEXTUREBLEND_MODULATE && this.textureBlendMode !== TEXTUREBLEND_MODULATEALPHA && this.textureBlendMode !== TEXTUREBLEND_DECALALPHA) {
      throw new Error(`Original material ${this.name} texture blend ${this.textureBlendMode} is not implemented`)
    }
    Object.assign(shader.uniforms, this.lighting.uniforms, {
      ffMaterialAmbient: { value: this.ambientColor },
      ffPrelitColor: { value: this.prelit?.color ?? new THREE.Vector4() },
      ffPrelitSpecular: { value: this.prelit?.specular ?? new THREE.Color() },
    })
    const defines = [
      this.specularEnabled ? '#define FF_SPECULAR' : '',
      this.textureBlendMode === TEXTUREBLEND_DECALALPHA ? '#define FF_DECALALPHA' : '',
      this.strictAlphaTest ? '#define FF_STRICT_ALPHATEST' : '',
      this.prelit ? '#define FF_PRELIT' : '',
      this.map?.colorSpace === THREE.SRGBColorSpace ? '#define FF_MAP_SRGB' : '',
    ].filter(Boolean).join('\n')
    shader.vertexShader = `${defines}\n${vertexShader}`
    shader.fragmentShader = `${defines}\n${fragmentShader}`
  }

  override customProgramCacheKey() {
    return `original-ff-${this.specularEnabled}-${this.textureBlendMode}-${this.strictAlphaTest}-${!!this.prelit}-${this.map?.colorSpace ?? ''}`
  }

  override copy(source: OriginalFixedFunctionMaterial) {
    super.copy(source)
    this.ambientColor.copy(source.ambientColor)
    this.specularEnabled = source.specularEnabled
    this.textureBlendMode = source.textureBlendMode
    this.strictAlphaTest = source.strictAlphaTest
    this.prelit = source.prelit ? { color: source.prelit.color.clone(), specular: source.prelit.specular.clone() } : null
    this.lighting = source.lighting
    return this
  }
}
