// How CK2_3D.dll draws and picks the context's 2D entities, decoded from the
// shipped DLL (image base 0x10000000):
//
//   CKRenderedScene::Draw 0x100704AE     background 2D root, the 3D scene, foreground 2D root
//   RCK2dEntity::SetParent 0x1005DD22    root membership; every change re-sorts the root
//   RCK2dEntity::Render 0x1005ED00       visibility, UpdateExtents, Draw, children
//   RCK2dEntity::UpdateExtents 0x1005CCE5  m_VtxPos / m_SrcRect: the rect clipped to the window or view
//   RCK2dEntity::Draw 0x1005E430         one quad of the material, its diffuse as the vertex colour
//   RCKRenderContext::_Pick2D 0x1006823B, RCK2dEntity::Pick 0x1005CABB, PreciseTexturePick 0x1002E82F
//
// The render manager's two roots are the context's `roots2d` (object ids in
// the children-array order, kept by `OriginalContext.append2d`). No shipped 2D entity has a parent or children, so
// parents are not modelled. The host's render context is the whole viewport:
// the view rect equals the window rect (CKRenderContext::Resize).
import { CKCID, originalIsChildClassOf, type OriginalContext, type OriginalObject } from './original-context.ts'
import { original2dUpdateExtents, type Original2dRect, type Original2dScreen, type Original2dState } from './original-2d-entity.ts'
import { fontByParameter, layoutText2D, textBytes, TEXT_FLAGS, type Text2DOp, type Text2DState } from './original-graph-text.ts'

const f = Math.fround

/** CK2dEntity flags the render path reads. */
const FLAG = { useSourceRect: 0x20, background: 0x40, notPickable: 0x80, ratioOffset: 0x100, clipToCameraView: 0x400, clipToParent: 0x1000 } as const

/** The render-time members: m_VtxPos (+0x6C) and m_SrcRect (+0x7C), both (0,0,0,0) until the entity is drawn. */
export interface Original2dExtents { vtxPos?: Original2dRect; vtxUVs?: Original2dRect }

type State = Original2dState & Original2dExtents & { text2d?: Map<number, Text2DState> }

export function original2dState(object: OriginalObject): State {
  return object.state as unknown as State
}

export function originalIs2dEntity(object: OriginalObject): boolean {
  return originalIsChildClassOf(object.classId, CKCID['2DENTITY'])
}

/**
 * UpdateExtents' clip (0x1005CCE5 from the source rect on): the destination
 * rect clipped to the window (or, CLIPTOCAMERAVIEW, the view rect, the same
 * here), the source rect cut in proportion. False when it lies wholly outside
 * (strictly beyond an edge); both rects are then (0,0,0,0).
 */
function updateExtents(state: State, screen: Original2dScreen): boolean {
  const src: Original2dRect = state.flags & FLAG.useSourceRect ? [...state.sourceRect] : [0, 0, 1, 1]
  state.vtxPos = [0, 0, 0, 0]
  state.vtxUVs = [0, 0, 0, 0]
  const clip: Original2dRect = [0, 0, f(screen.width), f(screen.height)]
  if (state.flags & FLAG.clipToParent) throw new Error('CLIPTOPARENT needs 2D entity parents, which the context does not model')
  const sw = f(src[2] - src[0]), sh = f(src[3] - src[1])
  // The homogeneous refresh writes m_Rect; the destination is m_Rect.
  original2dUpdateExtents(state, screen)
  if (!state.rect) throw new Error('A 2D entity without a pixel rect')
  const dst: Original2dRect = [...state.rect]
  const wdst = f(dst[2] - dst[0]), hdst = f(dst[3] - dst[1])
  if (!(dst[2] > dst[0])) dst[2] = dst[0]
  if (!(dst[3] > dst[1])) dst[3] = dst[1]
  const invW = f(1 / wdst), invH = f(1 / hdst)
  // RATIOOFFSET translates by ViewX, ViewY: 0 here.
  if (dst[2] < clip[0] || dst[0] > clip[2] || dst[3] < clip[1] || dst[1] > clip[3]) return false
  const srcLeft = src[0], srcTop = src[1]
  let d = f(clip[0] - dst[0])
  if (d > 0) { dst[0] = clip[0]; src[0] = f(d * sw * invW + src[0]) }
  d = f(clip[1] - dst[1])
  if (d > 0) { dst[1] = clip[1]; src[1] = f(d * sh * invH + src[1]) }
  d = f(dst[2] - clip[2])
  if (d > 0) { dst[2] = clip[2]; src[2] = f((wdst - d) * sw * invW + srcLeft) }
  d = f(dst[3] - clip[3])
  if (d > 0) { dst[3] = clip[3]; src[3] = f((hdst - d) * sh * invH + srcTop) }
  state.vtxPos = dst
  state.vtxUVs = src
  return true
}

/** One quad RCK2dEntity::Draw sends: integer pixels `(int)(v + 0.5)`, UVs the clipped source rect. */
export interface Original2dQuadItem {
  readonly kind: 'quad'
  readonly id: number
  readonly pass: 'background' | 'foreground'
  /** Left, top, right, bottom in window pixels. */
  readonly pixelRect: Original2dRect
  readonly uvRect: Original2dRect
  /** The context material drawn (SetAsCurrent); its diffuse, alpha included, is every vertex's colour. */
  readonly material: number
}

/** A 2D Text post-render callback's draws for its entity (CKTextureFont::Draw), in issue order. */
export interface Original2dTextItem {
  readonly kind: 'text'
  readonly id: number
  readonly pass: 'background' | 'foreground'
  /** The font's texture (a context id), which every glyph batch draws. */
  readonly texture: number
  readonly ops: readonly Text2DOp[]
  /** The Background and Caret materials of the draw, when it has them. */
  readonly backgroundMaterial?: number
  readonly caretMaterial?: number
}

export type Original2dDrawItem = Original2dQuadItem | Original2dTextItem

/**
 * The frame's 2D passes (CKRenderedScene::Draw): Render over the background
 * root, then (after the 3D scene) the foreground root, painter-style in root
 * order. An entity is drawn when visible and in the scene (the context's one
 * scene holds every object); its extents update even when it has no material,
 * which draws nothing while playing.
 */
export function original2dRender(context: OriginalContext, screen: Original2dScreen): Original2dDrawItem[] {
  const items: Original2dDrawItem[] = []
  for (const pass of ['background', 'foreground'] as const) {
    for (const id of [...context.roots2d[pass]]) {
      const object = context.get(id)
      if (!object) continue
      const state = original2dState(object)
      // The render manager drops the temporary post-render callbacks every frame, drawn or not.
      const texts = [...state.text2d?.values() ?? []].filter(text => text.registered)
      for (const text of state.text2d?.values() ?? []) text.registered = false
      // Hierarchical hide is not modelled; a hidden entity without children returns before UpdateExtents.
      if (!state.visible) continue
      const material = object.materials?.[0]
      if (updateExtents(state, screen) && material !== undefined) {
        const [l, t, r, b] = state.vtxPos!
        items.push({ kind: 'quad', id, pass, pixelRect: [Math.trunc(l + 0.5), Math.trunc(t + 0.5), Math.trunc(r + 0.5), Math.trunc(b + 0.5)], uvRect: state.vtxUVs!, material })
      }
      // The post-render callbacks run for a visible entity, clipped or not: each registered 2D Text draws its text.
      for (const text2d of texts) {
        const text = text2dItem(context, object.id, state, text2d, pass, screen)
        if (text) items.push(text)
      }
    }
  }
  return items
}

/**
 * The 2D Text render callback (Interface.dll 0x253869A0): the font of the
 * Font input (none: nothing drawn), the entity's pixel rect, the parent or
 * camera clip when the entity clips (the view rect is the window here), then
 * CKTextureFont::Draw; the extents and line count are the block's outputs.
 */
function text2dItem(context: OriginalContext, id: number, state: State, text: Text2DState, pass: 'background' | 'foreground', screen: Original2dScreen): Original2dTextItem | undefined {
  const object = context.get(id)!
  const font = fontByParameter(context.render.fonts, text.font)
  if (!font) return undefined
  if (state.flags & FLAG.clipToParent) throw new Error(`2D Text on ${object.name} clips to a parent, which the context does not model`)
  const clips = (state.flags & FLAG.clipToCameraView) !== 0
  const textureObject = context.findByClass(font.texture, CKCID.TEXTURE) ?? context.resolve(font.texture)
  if (!textureObject) throw new Error(`Font ${font.name}'s texture ${font.texture} is not in the context`)
  const materialId = (value: string | undefined) => value === undefined ? undefined : context.resolve(value)?.id
  const backgroundMaterial = materialId(text.backgroundMaterial), caretMaterial = materialId(text.caretMaterial)
  const background = backgroundMaterial === undefined ? undefined : context.get(backgroundMaterial)
  const result = layoutText2D({
    font, text: textBytes(text.text), alignment: text.alignment, margins: text.margins, offset: text.offset, indentation: text.indentation,
    flags: clips ? text.flags | TEXT_FLAGS.clipRectValid : text.flags,
    entityRect: state.rect!, screen, version2: text.version >= 0x20000,
    ...(clips ? { clipRect: [0, 0, f(screen.width), f(screen.height)] as Original2dRect } : {}),
    caretSize: text.caretSize, hasCaretMaterial: caretMaterial !== undefined,
    hasBackgroundMaterial: background !== undefined,
  })
  if (!result.drawn) return undefined
  if (result.resizeTo) throw new Error(`2D Text resizes ${object.name}, which the port does not do yet`)
  text.last = { extents: result.extents, lineCount: result.lineCount }
  return { kind: 'text', id, pass, texture: textureObject.id, ops: result.ops,
    ...(backgroundMaterial !== undefined ? { backgroundMaterial } : {}), ...(caretMaterial !== undefined ? { caretMaterial } : {}) }
}

/**
 * PreciseTexturePick (0x1002E82F): without a texture, or with the texture's
 * pick threshold 0 (CKBitmapData's constructor value; no file stores one and
 * only SetPickThreshold changes it), every point hits before a texel is read.
 */
function texturePick(context: OriginalContext, material: number): boolean {
  const texture = context.get(material)?.textures?.[0]
  if (texture === undefined) return true
  const threshold = Number(context.get(texture)?.state.pickThreshold ?? 0)
  if (threshold === 0) return true
  throw new Error(`Pick2D over a texture with pick threshold ${threshold} needs its texels`)
}

/**
 * CKRenderContext::Pick2D (0x1006823B): the foreground root, then the
 * background root, each from its last child (highest z) down. RCK2dEntity::Pick
 * skips NOTPICKABLE and invisible entities and needs the point inside the
 * extents of the last render (inclusive); with a material the texel at the
 * point's source-rect position must pass PreciseTexturePick.
 */
export function original2dPick(context: OriginalContext, point: readonly [number, number]): number | undefined {
  const [x, y] = [f(point[0]), f(point[1])]
  for (const pass of ['foreground', 'background'] as const) {
    const root = context.roots2d[pass]
    for (let i = root.length - 1; i >= 0; i--) {
      const object = context.get(root[i]!)
      if (!object) continue
      const state = original2dState(object)
      if (state.flags & FLAG.notPickable || !state.visible) continue
      const [l, t, r, b] = state.vtxPos ?? [0, 0, 0, 0]
      if (!(x >= l && x <= r && y >= t && y <= b)) continue
      const material = object.materials?.[0]
      if (material === undefined) return object.id
      // The texel would be at the point's place in the source rect.
      if (texturePick(context, material)) return object.id
    }
  }
  return undefined
}
