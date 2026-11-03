// Interface.dll `2D Text` (055B29FE:662D5CA0), `Set Font Properties`
// (DACFBD61:7A6E65E7) and TT_Toolbox_RT.dll `TT CreateFontEx` (260E4EB0:0E256B90)
// over the CK object context, decoded from the shipped DLLs: the Textured Font
// Manager's fonts live in `render.fonts`, a 2D entity's texts in its state
// (`text2d`, one per 2D Text behavior), and the render pass lays them out after the entity's quad.
//
//   createTextureFont / buildCharTable   0x25390130 / 0x25390200 (char table)
//   applyFontCoordinates                 TT CreateFontEx exec 0x10026540 (Data Array rows)
//   breakLines                           CKTextureFont::Draw 0x25391BF0, line breaking
//   layoutText2D                         Draw + the 2D Text render callback 0x253869A0
//   emitLine                             DrawLine 0x25390B70 (+ shadow wrapper 0x25391930)
//
// Float model: every store to a float member is Math.fround; x87 stack
// intermediates stay doubles (the FPU control word is UNVERIFIED).
import type { BehaviorContext, BehaviorFn, GraphParameterValue } from './original-graph.ts'

const f = Math.fround
/** MSVCRT _ftol: truncation toward zero. */
const ftol = (value: number) => Math.trunc(value)

// ---------------------------------------------------------------------------
// 1. constants and types
// ---------------------------------------------------------------------------

/** CKGUID(d1, d2) of the Textured Font Manager and of the `Font` parameter type (Interface.dll). */
export const FONT_MANAGER_GUID = [0x64FB5810, 0x73262D3B] as const
export const FONT_PARAMETER_GUID = [0x64FB5811, 0x33862D3B] as const

/** `2D Text` setting "Text Properties" (Interface.dll flags enum at 0x253984A8) plus the two internal bits. */
export const TEXT_FLAGS = {
  screenProportional: 0x001,
  background: 0x002,
  clipToDimension: 0x004,
  resizeVertically: 0x008,
  resizeHorizontally: 0x010,
  wordWrap: 0x020,
  justified: 0x040,
  compiled: 0x080,
  multiple: 0x100,
  showCaret: 0x200,
  /** Internal: set by 3D Text. Never set by 2D Text. */
  threeD: 0x400,
  /** Internal: OR-ed by the 2D Text callback when the entity clips to its parent / the camera view. */
  clipRectValid: 0x800,
} as const

/** `Alignment` enum (0x25398580): Center=0, bits Left=1, Right=2, Top=4, Bottom=8. */
export const TEXT_ALIGN = { left: 1, right: 2, top: 4, bottom: 8 } as const

/** `Set Font Properties` setting "Font Properties" (0x2539854C). */
export const FONT_PROPERTIES = { gradient: 1, shadow: 2, lighting: 4, disableFilter: 8 } as const

/** Six floats per character, indexed by the character code (font+0xD0, 0x18 bytes each, 256 entries). */
export const GLYPH = { ustart: 0, vstart: 1, uwidth: 2, uprewidth: 3, upostwidth: 4, vwidth: 5, stride: 6 } as const

/**
 * The Textured Font Manager's font object (Interface.dll, 0x18D4 bytes; offsets
 * in the comments). `TT CreateFontEx` creates it, `Set Font Properties` edits the
 * "properties" block and every `2D Text` draw rewrites the "per draw" block.
 */
export interface TextureFont {
  name: string
  /** Texture name and size in texels (CKTexture +0x60/+0x64). */
  texture: string
  textureWidth: number
  textureHeight: number
  /** +0xD0: 256 x [ustart, vstart, uwidth, uprewidth, upostwidth, vwidth]. */
  table: Float32Array
  /** +0xAC/+0xB0: Horizontal/Vertical Character Number (floats). */
  grid: [number, number]
  /** +0xB4..+0xC0: Font Bounds in texels (left, top, right, bottom). */
  bounds: [number, number, number, number]
  /** +0xC4 bit 0: the fixed grid (Create Font's "Proportionnal" is FALSE); proportional fonts scan the pixels. */
  fixed: boolean
  /** +0x0C: First Character. */
  firstChar: number
  /** +0x90: Space Size, the fraction of a cell a blank cell gets as width. TT CreateFontEx passes 0.3 (0x3E99999A). */
  spaceSize: number
  // ---- Set Font Properties (constructor defaults 0x2538FFE0) ----
  /** +0x10: extra advance per glyph (x) and per line (y). */
  space: [number, number]
  /** +0x18: glyph scale (x applies to the width reference W, y to the height reference H). */
  scale: [number, number]
  /** +0x20: Italic Offset: the top edge shifts right by scale.x * W * italicOffset. */
  italicOffset: number
  /** +0x34 / +0x38 / +0x3C: Color, End Color, Shadow Color as ARGB dwords (defaults white, opaque black, 0x80000000). */
  color: number
  endColor: number
  shadowColor: number
  /** +0x40: shadow offset in pixels = (-cos(angle) * distance, sin(angle) * distance). Default (4, 4). */
  shadowOffset: [number, number]
  /** +0x48: Shadow Size, which REPLACES the scale for the shadow pass. */
  shadowSize: [number, number]
  /** +0x58: Lit Material (a reference), +0x5C: FONT_PROPERTIES bits. */
  litMaterial: string | undefined
  properties: number
  /** Characters whose entry needs the texture's texels, which the port does not read (a proportional font's 255). */
  unscanned: Set<number>
}

export function newTextureFont(name: string, texture: string, textureWidth: number, textureHeight: number): TextureFont {
  return {
    name, texture, textureWidth, textureHeight,
    table: new Float32Array(256 * GLYPH.stride), grid: [16, 8], bounds: [0, 0, textureWidth, textureHeight],
    fixed: false, firstChar: 0, spaceSize: f(0.3),
    space: [0, 0], scale: [1, 1], italicOffset: 0,
    color: 0xFFFFFFFF, endColor: 0xFF000000, shadowColor: 0x80000000,
    shadowOffset: [4, 4], shadowSize: [1, 1], litMaterial: undefined, properties: 0, unscanned: new Set(),
  }
}

/** VxMath RGBAFTOCOLOR(const VxColor *) (SSE path, 0x24282540): truncated channel * 255, saturated, as 0xAARRGGBB. */
export function vxColorToArgb(r: number, g: number, b: number, a: number): number {
  const ch = (v: number) => {
    const p = f(f(v) * 255)
    if (!(p > -2147483649 && p < 2147483648)) return 0
    return Math.min(255, Math.max(0, ftol(p)))
  }
  return (((ch(a) << 24) | (ch(r) << 16) | (ch(g) << 8) | ch(b)) >>> 0)
}

// ---------------------------------------------------------------------------
// 2a. font creation: Interface.dll 0x25390130 (setup) + 0x25390200 (char table)
// ---------------------------------------------------------------------------

export interface FontTexturePixels {
  width: number
  height: number
  /** RGBA bytes, row-major, top-down (the DLL reads the 32-bit system copy from LockSurfacePtr(-1)). */
  rgba?: Uint8Array | Uint8ClampedArray
  /** CKTexture +0x70 bit 1 / +0x74: a transparent colour (ARGB). When set the scan compares whole pixels with it instead of testing alpha. */
  transparentColor?: number
}

export interface CreateFontOptions {
  name: string
  textureName: string
  pixels: FontTexturePixels
  /** Font Bounds; a zero width or height means the whole texture (0x25390130). */
  bounds: readonly [number, number, number, number]
  /** Horizontal/Vertical Character Number. */
  grid: readonly [number, number]
  /** Create Font / TT CreateFontEx pass (Proportionnal == 0). */
  fixed: boolean
  firstChar: number
  spaceSize: number
}

/**
 * CKTextureFontManager::CreateTextureFont (0x2538C030) -> font ctor 0x2538FFE0 -> 0x25390130 -> 0x25390200.
 * Replacing a font of the same name keeps its index (the caller does that with a Map).
 */
export function createTextureFont(o: CreateFontOptions): TextureFont {
  const font = newTextureFont(o.name, o.textureName, o.pixels.width, o.pixels.height)
  font.grid = [f(o.grid[0]), f(o.grid[1])]
  font.fixed = o.fixed
  font.firstChar = Math.trunc(o.firstChar)
  font.spaceSize = f(o.spaceSize)
  let [l, t, r, b] = o.bounds.map(f) as [number, number, number, number]
  if (f(r - l) === 0 || f(b - t) === 0) { l = 0; t = 0; r = f(o.pixels.width); b = f(o.pixels.height) }
  font.bounds = [l, t, r, b]
  buildCharTable(font, o.pixels)
  return font
}

/**
 * 0x25390200. `cellU = (right - left) / (texW * gridX)`, `cellV = (bottom - top) / (texH * gridY)`,
 * start `(left / texW, top / texH)`. All 256 entries start as [u0, v0, cellU, 0, 0, cellV].
 *  - fixed: cells fill left to right, top to bottom from `firstChar`, entry = [u, v, cellU, 0, 0, cellV];
 *  - proportional: each cell is scanned (see below). The pre/post widths stay 0.
 * If firstChar != 0, entry 0's vwidth is set to cellV so line heights work.
 * Writing past entry 255 corrupts memory in the DLL; here it throws.
 */
export function buildCharTable(font: TextureFont, pixels: FontTexturePixels): void {
  const tw = pixels.width, th = pixels.height
  const [gx, gy] = font.grid
  const [bl, bt, br, bb] = font.bounds
  const cellU = f((br - bl) / (tw * gx))
  const cellV = f((bb - bt) / (th * gy))
  const u0 = f(bl / tw), v0 = f(bt / th)
  const table = font.table
  for (let i = 0; i < 256; i++) table.set([u0, v0, cellU, 0, 0, cellV], i * GLYPH.stride)
  let index = font.firstChar
  const needIndex = () => { if (index < 0 || index > 255) throw new Error(`Font ${font.name} grid runs past character 255`) }
  if (font.fixed) {
    let v = v0
    for (let row = 0; row < gy; row++) {
      let u = u0
      for (let col = 0; col < gx; col++) {
        needIndex()
        table.set([u, v, cellU, 0, 0, cellV], index * GLYPH.stride)
        index++
        u = f(u + cellU)
      }
      v = f(v + cellV)
    }
  } else {
    if (!pixels.rgba) {
      // Without texels every entry stays unscanned; TT CreateFontEx overwrites 0..254 from its Data Array.
      for (let i = 0; i < 256; i++) font.unscanned.add(i)
      if (font.firstChar !== 0) table[GLYPH.vwidth] = cellV
      return
    }
    // Proportional scan 0x253903BC..0x25390908. Cell size in whole texels (truncated), pixel origin of
    // cell (col, row) = (col * cellW, row * cellH) -- the bounds' left/top are NOT added (UNVERIFIED if intended).
    const cellW = ftol(tw * cellU), cellH = ftol(th * cellV)
    const invTw = f(1 / tw)
    const key = pixels.transparentColor
    const rgba = pixels.rgba
    const inked = (x: number, y: number) => {
      const o = (y * tw + x) * 4
      if (key === undefined) return rgba[o + 3] !== 0
      const argb = ((rgba[o + 3]! << 24) | (rgba[o]! << 16) | (rgba[o + 1]! << 8) | rgba[o + 2]!) >>> 0
      return argb !== (key >>> 0)
    }
    let v = v0
    for (let row = 0; row < gy; row++) {
      let u = u0
      for (let col = 0; col < gx; col++) {
        needIndex()
        const e = index * GLYPH.stride
        table[e + GLYPH.ustart] = u; table[e + GLYPH.vstart] = v
        table[e + GLYPH.uwidth] = cellU; table[e + GLYPH.vwidth] = cellV
        const x0 = col * cellW, y0 = row * cellH
        const columnInked = (x: number) => { for (let y = 0; y < cellH; y++) if (inked(x0 + x, y0 + y)) return true; return false }
        let left = 0
        if (cellW > 0) while (left < cellW && !columnInked(left)) left++
        if (left === cellW) {
          // blank cell: space width = cell width * Space Size
          table[e + GLYPH.uwidth] = f(cellU * font.spaceSize)
        } else {
          const leftU = left * invTw
          table[e + GLYPH.ustart] = f(leftU + u)
          table[e + GLYPH.uwidth] = f(cellU - leftU)
          let right = 0
          while (right < cellW && !columnInked(cellW - 1 - right)) right++
          const w = f(table[e + GLYPH.uwidth]! - right * invTw)
          table[e + GLYPH.uwidth] = w < 0 ? 0 : w
        }
        index++
        u = f(u + cellU)
      }
      v = f(v + cellV)
    }
  }
  if (font.firstChar !== 0) table[GLYPH.vwidth] = cellV
}

/**
 * TT CreateFontEx (0x10026540) after CreateTextureFont: rows 0..254 of the FontCoordinatesData DataArray
 * (columns ustart, vstart, uwidth, uprewidth, upostwidth, vwidth, all floats) overwrite the table entries
 * of the same character codes. Entry 255 keeps the computed one. A shorter array leaves stale stack
 * values in the DLL; here it throws.
 */
export function applyFontCoordinates(font: TextureFont, rows: readonly (readonly GraphParameterValue[])[]): void {
  if (rows.length < 255) throw new Error(`Font coordinate array of ${font.name} has ${rows.length} rows, TT CreateFontEx reads 255`)
  for (let r = 0; r < 255; r++) {
    const row = rows[r]!
    for (let c = 0; c < 6; c++) {
      const value = row[c]
      if (typeof value !== 'number') throw new Error(`Font coordinate array row ${r} column ${c} is not a float`)
      font.table[r * GLYPH.stride + c] = value
    }
    font.unscanned.delete(r)
  }
}

/** A string as the DLL sees it: one byte per character (the strings are ANSI; unmappable characters become '?'). */
export function textBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  const cp1252: Record<number, number> = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    out[i] = c < 256 ? c : cp1252[c] ?? 0x3F
  }
  return out
}

// ---------------------------------------------------------------------------
// 2b. 2D Text: the render callback (0x253869A0) and CKTextureFont::Draw (0x25391BF0)
// ---------------------------------------------------------------------------

export type Rect = [left: number, top: number, right: number, bottom: number]

/** Everything one 2D Text draw reads. `font` is not modified. */
export interface Text2DDraw {
  font: Readonly<TextureFont>
  /** Text bytes (textBytes); a NUL ends it. */
  text: Uint8Array
  /** Alignment input (0 center, bit 1 left, 2 right, 4 top, 8 bottom). */
  alignment: number
  /** Margins (left, top, right, bottom), default (2, 2, 2, 2); Offset; Paragraph Indentation. */
  margins: Rect
  offset: [number, number]
  indentation: [number, number]
  /** The "Text Properties" setting (TEXT_FLAGS bits; 0x800 only when `clipRect` is given). */
  flags: number
  /** The target's pixel rect (GetRect), already translated by the view origin when it is ratio-offset. */
  entityRect: Readonly<Rect>
  /** rc->GetWidth() / GetHeight(). */
  screen: { width: number; height: number }
  /** CKBehavior::GetVersion() >= 0x20000 (the manager's byte at +0x28). All shipped 2D Text nodes but Gameplay's tutorial are 0x20000. */
  version2: boolean
  /** Font+0x80: the parent/camera clip rect when the callback computed one (flags & 0x800). */
  clipRect?: Rect
  /** Caret Size (default 0.1) and whether a Caret Material is set. */
  caretSize: number
  hasCaretMaterial: boolean
  /** The Background Material's diffuse as ARGB (needed when flags & 2 and the input is a material), else undefined. */
  backgroundColor?: number
  hasBackgroundMaterial: boolean
}

export interface TextVertex { x: number; y: number; z: number; rhw: number; u: number; v: number; color: number }
/** v0 top-left, v1 top-right, v2 bottom-right, v3 bottom-left; two triangles (0,1,2) (0,2,3). */
export type TextQuad = [TextVertex, TextVertex, TextVertex, TextVertex]

/**
 * Draw operations in the order the DLL issues them. All coordinates are window pixels
 * (the callback sets the view rect to the full window unless the entity clips to the camera).
 *  background: one TRIANGLEFAN of 4 vertices z=0, rhw=1, uv (0,0) (1,0) (1,1) (0,1), colour = material diffuse,
 *              drawn with the Background Material as current material (lit=1) and ZWRITE off.
 *  glyphs:     one TRIANGLELIST per line pass (all quads, texture = the font texture, states TEXT_RENDER_STATES).
 *  caret:      one TRIANGLEFAN with the Caret Material current, drawn BEFORE the glyph batch of its line.
 */
export type Text2DOp =
  | { kind: 'background'; rect: Rect }
  | { kind: 'glyphs'; quads: TextQuad[]; shadow: boolean }
  | { kind: 'caret'; quad: [TextVertex, TextVertex, TextVertex, TextVertex] }

export interface Text2DResult {
  ops: Text2DOp[]
  /** Output "Text Extents": font+0x70..0x7C (left, top, right, bottom) of the text block. */
  extents: Rect
  /** Output "Line Count": font+0x94. */
  lineCount: number
  /** SetSize(w, h) on the entity when Resize Verticaly/Horizontaly is set (pixels). */
  resizeTo?: { width: number; height: number }
  /** False when the draw bailed out before touching outputs (word wrap guard). */
  drawn: boolean
}

/** Render states 25391A30 sets before the glyph batches (VXRENDERSTATE / CKRST_TSS values from the SDK). */
export const TEXT_RENDER_STATES = {
  fillMode: 3 /* VXFILL_SOLID */, specularEnable: 0,
  // not lit:
  cullMode: 1 /* VXCULL_NONE */, wrap0: 0, srcBlend: 5 /* SRCALPHA */, destBlend: 6 /* INVSRCALPHA */,
  // lit (FONT_PROPERTIES.lighting): the Lit Material is made current (lit = 1) instead of the four states above.
  alphaBlendEnable: 1, zWriteEnable: 0, zEnable: 0 /* 1 for 3D Text */,
  shadeMode: 1 /* VXSHADE_FLAT; 2 GOURAUD with the gradient property */,
  tssAddress: 3 /* CLAMP */, tssTextureMapBlend: 4 /* MODULATEALPHA */,
  // filtering: FONT_PROPERTIES.disableFilter -> mag = min = NEAREST (1); else mag = LINEAR (2),
  // min = LINEARMIPLINEAR (6) when the texture has mipmaps (CKTexture vtable +0x7C > 1 or == -1), else LINEAR (2).
  fog: 'disabled by the callback for the whole text and restored afterwards when the fog mode is not none',
  texture: 'the font texture, SetTexture(tex, clamped = 0, stage 0)',
} as const

export const GLYPH_Z = f(0.01) // 0x3C23D70A
const QUARTER = f(0.25)

/** One line of the layout (the 16-byte records of the manager's line array). */
export interface TextLine {
  start: number
  /** Characters; negative for the first line of a paragraph (the DLL's marker, made positive again at draw time). */
  count: number
  spaces: number
  width: number
}

/**
 * The line breaker inside Draw (0x25391E20..0x25391F8A), instruction for instruction,
 * including its state that survives across lines (`brk`, `ebx`).
 *  fx = scale.x * W; spaceW / spaceAdj as computed in layoutText2D; availW = rect width after margins;
 *  wrap: flags & (WordWrap | Justified); indentPx = scale.x * W * uwidth(char 0) * indentation.x.
 */
export function breakLines(font: Readonly<TextureFont>, text: Uint8Array, fx: number, spaceW: number, spaceAdj: number,
  availW: number, wrap: boolean, indentPx: number): TextLine[] {
  const lines: TextLine[] = []
  const t = (i: number) => (i >= 0 && i < text.length ? text[i]! : 0)
  const T = font.table
  const widthOf = (c: number) => {
    if (font.unscanned.has(c & 0xff)) throw new Error(`Font ${font.name} character ${c & 0xff} needs a scan of the texture's texels`)
    const o = (c & 0xff) * GLYPH.stride
    return T[o + GLYPH.upostwidth]! + T[o + GLYPH.uprewidth]! + T[o + GLYPH.uwidth]!
  }
  let edi = 0
  let ebx = 1 // "previous character was a space / start of line"
  let ebp = -1 // resume pointer; the DLL starts it on a static NUL
  let brk = 0 // [1Ch]: break candidate (char count before the space), persists across lines
  let breakWidth = 0 // [28h]
  let first = 1 // [20h]: next line starts a paragraph
  if (t(0) === 0) return lines
  for (;;) {
    const start = edi
    let count = 0, spaces = 0
    let cur = first ? f(indentPx) : 0
    let endOfLine: 'newline' | 'end' | 'overflow' = 'end'
    let c = t(edi)
    while (c !== 0) {
      if (c === 0x0A) { endOfLine = 'newline'; break }
      if (c === 0x20) {
        ebx = 1
        breakWidth = cur
        brk = count
        spaces++
        ebp = edi + 1
        cur = f(cur + spaceW)
      } else {
        if (ebx) { breakWidth = f(cur - spaceW); ebx = 0; brk = count - 1; ebp = edi }
        cur = f(widthOf(c) * fx + cur + spaceAdj)
      }
      if (wrap && cur > availW) { endOfLine = 'overflow'; break }
      count++
      edi++
      c = t(edi)
    }
    if (endOfLine === 'overflow') {
      if (brk > 0) {
        count = brk
        cur = breakWidth
        spaces -= 1
        edi = ebp
        ebx = 1
      } else if (t(edi) === 0x20) {
        ebx = 1
      } else {
        cur = f(cur - f(widthOf(c) * fx + spaceAdj))
        if (ebp === edi) edi++
        ebp = edi
        ebx = 1
      }
    }
    // 0x25391F35: finish the line
    if (first) { count = -count; first = 0 }
    if (t(edi) === 0x0A) { first = 1; if (t(ebp) === 0x0A) edi++ }
    lines.push({ start, count, spaces, width: cur })
    if (t(edi) === 0) break
    if (edi !== ebp && t(ebp) !== 0x0A) edi++
    if (t(edi) === 0) break
  }
  return lines
}

/** Rectangles that do not overlap (0x253924A0, touching counts as disjoint). */
const disjoint = (a: Readonly<Rect>, b: Readonly<Rect>) => !(a[0] < b[2]) || !(b[0] < a[2]) || !(a[1] < b[3]) || !(b[1] < a[3])

/** A caret request from DrawLine: the caret box is (x, yTop, width, height) of the current glyph cell. */
export interface CaretRequest { x: number; yTop: number; width: number; height: number }

interface LineStyle {
  /** Pass-local copies of the font fields DrawLine reads (the shadow pass swaps color / scale / properties). */
  color: number
  scale: [number, number]
  properties: number
}

/**
 * DrawLine (0x25390B70), 2D branch (flags & 0x400 == 0), for `count` characters starting at `start`.
 *  x, y: the line's pen position (Draw computes them per alignment); a0 / a4: font+0xA0 (blank advance, incl. justification),
 *  font+0xA4 (extra advance per glyph); lineWidth: font+0xA8.
 * Returns the glyph quads and the carets it draws on the way (carets are separate ops that precede the batch).
 */
export function emitLine(font: Readonly<TextureFont>, W: number, H: number, text: Uint8Array, start: number, count: number,
  x: number, y: number, rect: Readonly<Rect>, flags: number, clipRect: Readonly<Rect> | undefined, style: LineStyle,
  a0: number, a4In: number, lineWidth: number): { quads: TextQuad[]; carets: CaretRequest[] } {
  const quads: TextQuad[] = []
  const carets: CaretRequest[] = []
  if (count === 0) return { quads, carets }
  const T = font.table
  let clip: Rect = [rect[0], rect[1], rect[2], rect[3]]
  if (flags & TEXT_FLAGS.clipRectValid) {
    if (!clipRect || disjoint(clip, clipRect)) return { quads, carets }
    if (clip[0] < clipRect[0]) clip[0] = clipRect[0]
    if (clip[2] > clipRect[2]) clip[2] = clipRect[2]
    if (clip[1] < clipRect[1]) clip[1] = clipRect[1]
    if (clip[3] > clipRect[3]) clip[3] = clipRect[3]
  }
  const fx = f(W * style.scale[0]), fy = f(H * style.scale[1])
  const italic = f(fx * font.italicOffset)
  const qu = f(QUARTER / font.textureWidth), qv = f(QUARTER / font.textureHeight)
  let curX = f(ftol(x + 0.5)), curY = f(ftol(y + 0.5))
  let a4 = a4In
  if (!(flags & TEXT_FLAGS.justified)) a4 = f(ftol(a4 + 0.5))
  const cellH = f(fy * T[GLYPH.vwidth]!) // all glyph quads have the height of character 0's cell
  let yTop = curY
  let yBottom = f(yTop + cellH)
  let topFrac = 0, bottomFrac = 1
  const clipV = (flags & TEXT_FLAGS.clipToDimension) !== 0
  if (clipV) {
    if (curY > clip[3]) return { quads, carets }
    if (yBottom < clip[1]) return { quads, carets }
    if (curX > clip[2]) return { quads, carets }
    if (f(curX + lineWidth) < clip[0]) return { quads, carets }
    if (curY < clip[1]) { topFrac = f((clip[1] - curY) / cellH); yTop = clip[1] }
    if (yBottom > clip[3]) { bottomFrac = f(1 - f((yBottom - clip[3]) / cellH)); yBottom = clip[3] }
  }
  let pending = false // a caret marker (character 8) waits for the next glyph
  let remaining = count
  let p = start
  const caret = (cx: number, width: number, height: number) => { carets.push({ x: cx, yTop, width, height }) }
  while (remaining !== 0) {
    const c = text[p]!
    remaining--
    if (c === 0x20) {
      if (pending) { if (flags & TEXT_FLAGS.showCaret) caret(curX, a0, f(yBottom - yTop)); pending = false }
      curX = f(curX + a0)
      p++
      continue
    }
    if (c === 8) {
      if (remaining === 0 && (flags & TEXT_FLAGS.showCaret)) caret(curX, a0, f(yBottom - yTop))
      pending = true
      p++
      continue
    }
    if (font.unscanned.has(c)) throw new Error(`Font ${font.name} character ${c} needs a scan of the texture's texels`)
    const o = c * GLYPH.stride
    const vw = T[o + GLYPH.vwidth]!
    if (vw === 0) { p++; continue }
    const gu = T[o + GLYPH.ustart]!, gv = T[o + GLYPH.vstart]!, gw = T[o + GLYPH.uwidth]!
    const pre = T[o + GLYPH.uprewidth]!, post = T[o + GLYPH.upostwidth]!
    let xl = f(f(fx * pre) + curX)
    let xr = f(f(fx * gw) + xl)
    let u0 = gu
    let u1 = f(gu + gw)
    if (clipV) {
      if (xl > clip[2]) break
      if (xr < clip[0]) { curX = f(f(f(fx * post) + a4) + xr); p++; continue }
      if (curX < clip[0]) { u0 = f(f((clip[0] - xl) / fx) + u0); xl = clip[0] }
      if (!(xr <= clip[2])) { u1 = f(u1 - f((xr - clip[2]) / fx)); xr = clip[2] }
    }
    if (pending) {
      if (flags & TEXT_FLAGS.showCaret) caret(xl, f(xr - xl), f(yBottom - yTop))
      pending = false
    }
    curX = f(f(f(fx * post) + a4) + xr)
    const px0 = f(ftol(xl + italic + 0.5) - QUARTER)
    const px1 = f(ftol(xr + italic + 0.5) - QUARTER)
    const px2 = f(ftol(xr + 0.5) - QUARTER)
    const px3 = f(ftol(xl + 0.5) - QUARTER)
    const uTop = f(u0 + qu)
    const vTop = f(f(f(topFrac * vw) + gv) + qv)
    const vBottom = f(f(bottomFrac * vw) + gv)
    const vert = (x2: number, y2: number, u: number, v: number): TextVertex => ({ x: x2, y: y2, z: GLYPH_Z, rhw: 1, u, v, color: 0 })
    quads.push([vert(px0, yTop, uTop, vTop), vert(px1, yTop, u1, vTop), vert(px2, yBottom, u1, vBottom), vert(px3, yBottom, uTop, vBottom)])
    p++
  }
  // colours: gradient runs top (Color) to bottom (End Color), clipped quads take the matching slice
  const gradient = (style.properties & FONT_PROPERTIES.gradient) !== 0
  let top = style.color, bottom = style.color
  if (gradient) {
    if (topFrac === 0 && bottomFrac === 1) { bottom = font.endColor }
    else {
      const c0 = argbChannels(style.color), c1 = argbChannels(font.endColor)
      const mix = (t: number) => vxColorToArgb(...(c0.map((a, i) => f(a + f(f(c1[i]! - a) * t))) as [number, number, number, number]))
      top = mix(topFrac); bottom = mix(bottomFrac)
    }
  }
  for (const q of quads) { q[0].color = top; q[1].color = top; q[2].color = bottom; q[3].color = bottom }
  return { quads, carets }
}

/** [r, g, b, a] floats of an ARGB dword (byte * 1/255, 0x253943B4). */
function argbChannels(argb: number): [number, number, number, number] {
  const k = f(1 / 255)
  return [f(((argb >>> 16) & 255) * k), f(((argb >>> 8) & 255) * k), f((argb & 255) * k), f(((argb >>> 24) & 255) * k)]
}

/**
 * The whole 2D Text draw: the render callback's setup (0x253869A0) + CKTextureFont::Draw (0x25391BF0).
 * Call it from the entity's post-render hook, AFTER the entity's own material quad and its children
 * (RCK2dEntity::Render 0x1005ED00: pre callbacks, Draw, children, post callbacks) and only when the entity is visible.
 * The caller must have set the view rect to the full window unless the entity clips to the camera (0x253869A0).
 */
export function layoutText2D(d: Text2DDraw): Text2DResult {
  const font = d.font
  const flags = d.flags
  if (flags & TEXT_FLAGS.multiple) throw new Error('2D Text "Multiple" (queued one-shot drawing, 0x2538CB80) is not decoded')
  if (flags & TEXT_FLAGS.threeD) throw new Error('3D Text flag on a 2D Text')
  if (font.properties & FONT_PROPERTIES.lighting) throw new Error('Lit fonts (Lit Material) are not decoded for rendering')
  if (flags & TEXT_FLAGS.compiled) {
    // The DLL records the first draw per entity id and replays it (text changes are ignored) until a
    // non-compiled draw of the same entity removes the record. The caller keeps that cache; layout is identical.
  }
  const T = font.table
  const empty: Text2DResult = { ops: [], extents: [0, 0, 0, 0], lineCount: 0, drawn: false }
  // margins applied to a working copy of the entity rect; `saved` is the rect before margins (0x25391CA5)
  const saved: Rect = [d.entityRect[0], d.entityRect[1], d.entityRect[2], d.entityRect[3]]
  const r: Rect = [
    f(d.margins[0] + d.entityRect[0]), f(d.entityRect[1] + d.margins[1]),
    f(d.entityRect[2] - d.margins[2]), f(d.entityRect[3] - d.margins[3]),
  ]
  // W / H: the references glyph sizes are multiplied with
  let W: number, H: number
  if (flags & TEXT_FLAGS.screenProportional) { W = f(d.screen.width * 1); H = f(d.screen.height * 1) }
  else { W = f(font.textureWidth * 1); H = f(font.textureHeight * 1) }
  const sx = font.scale[0], sy = font.scale[1]
  if (flags & (TEXT_FLAGS.wordWrap | TEXT_FLAGS.justified)) {
    // nothing is drawn (and no output written) when one character's relative width exceeds the rect width
    const guard = ((font.bounds[2] - font.bounds[0]) * 1) / (font.grid[0] * W * sx)
    if (guard > f(r[2] - r[0])) return empty
  }
  const fx = f(sx * W)
  let spaceAdj = font.space[0]
  const e32 = 32 * GLYPH.stride
  if (d.version2) {
    spaceAdj = f(f(f(((T[e32 + GLYPH.upostwidth]! + T[e32 + GLYPH.uprewidth]!) + T[e32 + GLYPH.uwidth]!) * font.space[0]) * fx) * f(0.1))
  }
  const spaceW = f(((T[e32 + GLYPH.upostwidth]! + T[e32 + GLYPH.uprewidth]! + T[e32 + GLYPH.uwidth]!) * fx) + spaceAdj)
  const availW = f(r[2] - r[0])
  const indentPx = f(sx * W * T[GLYPH.uwidth]! * d.indentation[0])
  const lines = breakLines(font, d.text, fx, spaceW, spaceAdj, availW, (flags & (TEXT_FLAGS.wordWrap | TEXT_FLAGS.justified)) !== 0, indentPx)
  // measure (0x25390910)
  const lineH = f(f(f(H * sy) * T[GLYPH.vwidth]!) + font.space[1])
  let maxW = 0, totalH = 0
  for (const line of lines) { if (!(line.width <= maxW)) maxW = line.width; totalH = f(totalH + lineH) }
  const lineCount = lines.length
  // block position: vertical by Top/Bottom/else centred; "x0" keys off the VERTICAL bits (0x25392081, as shipped)
  const align = d.alignment | 0
  const top = (align & TEXT_ALIGN.top) !== 0
  let y0: number
  if (top) y0 = r[1]
  else if (align & TEXT_ALIGN.bottom) y0 = f(r[3] - totalH)
  else y0 = f(f(r[3] + r[1]) * 0.5 - f(totalH * 0.5))
  let x0: number
  if (top) x0 = r[0]
  else if (align & TEXT_ALIGN.bottom) x0 = f(r[2] - maxW)
  else x0 = f(f(f(r[0] + r[2]) * 0.5) - f(maxW * 0.5))
  const extents: Rect = [x0, y0, f(maxW + x0), f(totalH + y0)]
  // resize the entity to the text (SetSize relative to its rect)
  let resizeTo: Text2DResult['resizeTo']
  // `newRect` is the DLL's copy of the entity rect ([5Ch..68h]) that the resize edits and the background quad uses
  const newRect: Rect = [saved[0], saved[1], saved[2], saved[3]]
  if (flags & (TEXT_FLAGS.resizeVertically | TEXT_FLAGS.resizeHorizontally)) {
    newRect[1] = y0
    if (!(flags & TEXT_FLAGS.justified)) { if (flags & TEXT_FLAGS.resizeHorizontally) newRect[2] = f(saved[0] + maxW) }
    if (flags & (TEXT_FLAGS.resizeVertically | TEXT_FLAGS.justified)) newRect[3] = f(y0 + totalH)
    let width = saved[2] - saved[0], height = saved[3] - saved[1]
    if (flags & TEXT_FLAGS.resizeHorizontally) width = f(newRect[2] - saved[0])
    if (flags & (TEXT_FLAGS.resizeVertically | TEXT_FLAGS.justified)) height = f(newRect[3] - y0)
    resizeTo = { width, height }
  }
  const ops: Text2DOp[] = []
  // Top alignment: the Offset's y moves the block (and it is only applied for Top)
  let y = top ? f(d.offset[1] + r[1]) : y0
  if (flags & TEXT_FLAGS.background && d.hasBackgroundMaterial) {
    ops.push({ kind: 'background', rect: [newRect[0], newRect[1], newRect[2], newRect[3]] })
  }
  const lineHDraw = lineH
  const shadowOn = (font.properties & FONT_PROPERTIES.shadow) !== 0
  const mainStyle: LineStyle = { color: font.color, scale: [sx, sy], properties: font.properties }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    let a0 = spaceW, a4 = spaceAdj
    let x: number
    const lineWidth = line.width
    if (flags & TEXT_FLAGS.justified) {
      if (line.spaces !== 0) {
        a0 = f(spaceW - f((lineWidth - availW) / line.spaces))
      } else {
        const n = Math.abs(line.count)
        if (n > 1) a4 = f(f((availW - lineWidth) / (n - 1)) + spaceAdj)
      }
      x = r[0]
    } else if (align & TEXT_ALIGN.left) x = f(d.offset[0] + r[0])
    else if (align & TEXT_ALIGN.right) x = f(r[2] - lineWidth)
    else x = f(f(f(r[0] + r[2]) * 0.5) - f(lineWidth * 0.5))
    let count = line.count
    if (count < 0) {
      count = -count
      if (align & TEXT_ALIGN.left) x = f(x + f(f(f(sx * W) * T[GLYPH.uwidth]!) * d.indentation[0]))
      if (i !== 0) y = f(y + f(f(f(H * sy) * d.indentation[1]) * T[GLYPH.vwidth]!))
    }
    const batches: { shadow: boolean; result: ReturnType<typeof emitLine> }[] = []
    if (shadowOn && ((font.shadowColor >>> 24) & 255) !== 0) {
      // 0x25391930: color <- shadow color, scale <- shadow size, gradient off, position + shadow offset
      const shadowStyle: LineStyle = { color: font.shadowColor, scale: [font.shadowSize[0], font.shadowSize[1]], properties: font.properties & ~FONT_PROPERTIES.gradient }
      batches.push({ shadow: true, result: emitLine(font, W, H, d.text, line.start, count, f(x + font.shadowOffset[0]), f(y + font.shadowOffset[1]), r, flags, d.clipRect, shadowStyle, a0, a4, lineWidth) })
    }
    batches.push({ shadow: false, result: emitLine(font, W, H, d.text, line.start, count, x, y, r, flags, d.clipRect, mainStyle, a0, a4, lineWidth) })
    for (const b of batches) {
      for (const c of b.result.carets) {
        // 0x25391700: the bottom `caretSize` of the cell; vertices (x, bottom) (x, top') (x + w, top') (x + w, bottom);
        // colour (1, 1, 1, 0.5), or the Caret Material's diffuse when it has one
        const cx = c.x, cw = c.width, ch = c.height
        const y1 = f(c.yTop + f(f(1 - d.caretSize) * ch)), y0c = f(c.yTop + ch)
        const v = (xx: number, yy: number, u: number, vv: number): TextVertex => ({ x: xx, y: yy, z: 0, rhw: 1, u, v: vv, color: d.hasCaretMaterial ? 0 : vxColorToArgb(1, 1, 1, 0.5) })
        ops.push({ kind: 'caret', quad: [v(cx, y0c, 0, 0), v(cx, y1, 1, 0), v(f(cx + cw), y1, 1, 1), v(f(cx + cw), y0c, 0, 1)] })
      }
      if (b.result.quads.length) ops.push({ kind: 'glyphs', quads: b.result.quads, shadow: b.shadow })
    }
    y = f(y + lineHDraw)
  }
  return { ops, extents, lineCount, resizeTo, drawn: true }
}

/**
 * What one `2D Text` behavior writes into entity.state.text2d, keyed by the behavior: each behavior registers its own
 * post-render callback (the callback argument is the behavior id), so several 2D Texts on one entity all draw
 * (Menu_Highscore's places: the name and the right-aligned score). The callback is temporary: the render manager
 * drops it every frame and the behavior registers it again on each run, so a text draws only in a frame its behavior
 * ran (a deactivated script's text disappears: base's `Pause Level` deactivates Gameplay_Tutorial). The renderer draws
 * the registered ones each frame the entity is visible, in the order the callbacks were last registered.
 */
export interface Text2DState {
  /** The Font input: a registered font name (or a 1-based index). */
  font: string | number
  text: string
  alignment: number
  margins: Rect
  offset: [number, number]
  indentation: [number, number]
  backgroundMaterial: string | undefined
  caretSize: number
  caretMaterial: string | undefined
  flags: number
  /** CKBehavior::GetVersion(). */
  version: number
  /** The behavior registered its temporary callback since the last render (cleared by every render pass). */
  registered: boolean
  /** Written by the renderer after each draw (outputs of the block, available to the behavior one frame later). */
  last?: { extents: Rect; lineCount: number }
}


// ---------------------------------------------------------------------------
// 4. behaviors
// ---------------------------------------------------------------------------

const number = (value: GraphParameterValue) => (typeof value === 'number' ? value : Number(value ?? 0))
const floats = (value: GraphParameterValue, count: number, what: string): number[] => {
  if (!Array.isArray(value) || value.length < count) throw new Error(`${what} is not a ${count}-float value`)
  return value.slice(0, count).map(Number)
}

/** The manager's fonts: a Map keeps insertion order, and replacing a key keeps its slot, like the 1-based index. */
function fontsOf(context: BehaviorContext): Map<string, TextureFont> {
  if (!context.loader) throw new Error(`${context.node.name} ${context.node.index} needs the CK object context`)
  return context.loader.render.fonts
}

/** CKTextureFontManager::GetFont: a Font parameter is a 1-based index (0 or past the end: no font) or, in this port, a name. */
export function fontByParameter(fonts: Map<string, TextureFont>, value: GraphParameterValue): TextureFont | undefined {
  if (typeof value === 'string') return fonts.get(value)
  const index = Math.trunc(number(value))
  if (index <= 0 || index > fonts.size) return undefined
  return [...fonts.values()][index - 1]
}

/**
 * TT_Toolbox_RT.dll TT CreateFontEx (exec 0x10026540). Activates In off and Out first, then
 * name (0), texture (1; NULL: returns 0xA008 without a font), grid (2, default 16,8), proportional (3, default TRUE),
 * bounds (4, default (0,0,texW,texH)), first character (5), FontCoordinatesData DataArray (6, required),
 * creates the font with Space Size 0.3, writes the index to output 0, then copies the array rows.
 */
const ttCreateFontEx: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  const fonts = fontsOf(context)
  const name = context.input(0)
  if (typeof name !== 'string') return // the DLL returns when the name has no data pointer
  const textureName = context.inputObject(1)
  // A NULL texture returns CKBR_PARAMETERERROR (0xA008) after Out, without a font.
  if (!textureName) return
  // The texture's size (CKTexture +0x60/+0x64); its texels are not read (only a proportional font's character 255 needs them).
  const size = context.loader!.textureSize(textureName)
  if (!size) throw new Error(`TT CreateFontEx ${context.node.index} needs the size of ${textureName}`)
  const pixels: FontTexturePixels = size
  const grid = context.input(2) === null ? [16, 8] : floats(context.input(2), 2, 'Horizontal/Vertical Character Number')
  const proportional = context.input(3) === null ? true : Boolean(context.input(3))
  const boundsInput = context.input(4)
  const bounds = Array.isArray(boundsInput) && boundsInput.length >= 4 ? boundsInput.slice(0, 4).map(Number) : [0, 0, pixels.width, pixels.height]
  const first = context.input(5) === null ? 0 : Math.trunc(number(context.input(5)))
  const arrayName = context.inputObject(6)
  const rows = arrayName ? context.array(arrayName) : undefined
  if (!rows) throw new Error(`TT CreateFontEx ${context.node.index} has no FontCoordinatesData array (the DLL dereferences NULL)`)
  const font = createTextureFont({
    name, textureName, pixels, bounds: bounds as [number, number, number, number], grid: grid as [number, number],
    fixed: !proportional, firstChar: first, spaceSize: 0.3,
  })
  applyFontCoordinates(font, rows)
  // re-creating a name replaces the font in its slot (a new object: properties return to the defaults)
  fonts.set(name, font)
  context.setOutput(0, name)
}

/**
 * Interface.dll Set Font Properties (exec 0x2538A760). In off, Out, then input 0 (Font) -> the font, else nothing.
 * Inputs: 1 Space (vec2), 2 Scale (vec2), 3 Italic Offset (float), 4 Color, 5 End Color, 6 Shadow Color
 * (colours -> ARGB through RGBAFTOCOLOR only when the read succeeds), 7 Shadow Angle (radians), 8 Shadow Distance
 * (float, default 4): offset = (-cos(angle) * distance, sin(angle) * distance) when the angle reads,
 * 9 Shadow Size (vec2), 10 Lit Material; the setting (Gradient 1, Shadow 2, Lighting 4, Disable Filter 8) goes to +0x5C.
 * The pins 6..9 are disabled by the callback (0x2538A8F0) according to the setting, but disabled pins still read.
 * Menu's 10-input instances (setting 0) lack Shadow Distance in the file: input 8 is then a vec2 (4, 0) and
 * input 9 the Lit Material; the DLL reads them positionally. With the shadow off none of it is observable.
 */
const setFontProperties: BehaviorFn = context => {
  context.consumeInput(context.inputSlot)
  context.activate(0)
  const font = fontByParameter(fontsOf(context), context.input(0))
  if (!font) return
  const vec2 = (slot: number): [number, number] | undefined => {
    const v = context.input(slot)
    return Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' ? [f(Number(v[0])), f(Number(v[1]))] : undefined
  }
  const color = (slot: number): number | undefined => {
    const v = context.input(slot)
    return Array.isArray(v) && v.length >= 4 ? vxColorToArgb(Number(v[0]), Number(v[1]), Number(v[2]), Number(v[3])) : undefined
  }
  font.space = vec2(1) ?? font.space
  font.scale = vec2(2) ?? font.scale
  const italic = context.input(3)
  if (typeof italic === 'number') font.italicOffset = f(italic)
  font.color = color(4) ?? font.color
  font.endColor = color(5) ?? font.endColor
  font.shadowColor = color(6) ?? font.shadowColor
  const angle = context.input(7)
  if (typeof angle === 'number') {
    const distance = context.inputCount > 8 && typeof context.input(8) === 'number' ? f(number(context.input(8))) : (Array.isArray(context.input(8)) ? f(Number((context.input(8) as number[])[0])) : f(4))
    font.shadowOffset = [f(-Math.cos(f(angle)) * distance), f(Math.sin(f(angle)) * distance)]
  }
  if (context.inputCount > 10) font.shadowSize = vec2(9) ?? font.shadowSize
  const lit = context.inputCount > 10 ? context.inputObject(10) : undefined
  font.litMaterial = lit ?? font.litMaterial
  font.properties = Math.trunc(number(context.local(0)))
}

/**
 * Interface.dll 2D Text (exec 0x253868E0, render callback 0x253869A0).
 *   Off (input 1): In off, Exit Off, returns CKBR_OK (the behavior ends; no callback is registered again).
 *   On  (input 0): In off, Exit On, then (setting & Multiple: one immediate draw, CKBR_OK -- unsupported here)
 *                  AddPostRenderCallBack(callback, behaviorId, temporary = TRUE) on the target; returns
 *                  CKBR_ACTIVATENEXTFRAME. Every following run (no input active) registers the temporary
 *                  callback again, so the text is drawn after the entity every frame while the behavior is active.
 * The callback reads ALL inputs at render time; here the behavior snapshots them into entity.state.text2d every run
 * (inputs cannot change between the behavior pass and the render) and the renderer calls layoutText2D after the
 * entity's quad. The outputs are written at render time: the behavior publishes the previous frame's result.
 */
const text2D: BehaviorFn = context => {
  const target = context.targetName()
  const loader = context.loader
  if (!loader) throw new Error(`2D Text ${context.node.index} needs the CK object context`)
  if (context.isInputActive(1)) {
    context.consumeInput(1)
    context.activate(1)
    if (target) (loader.state(target) as { text2d?: Map<number, Text2DState> }).text2d?.delete(context.node.index)
    return
  }
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    context.activate(0)
  }
  if (!target) { context.wait(); return }
  const flags = Math.trunc(number(context.local(0)))
  if (flags & TEXT_FLAGS.multiple) throw new Error(`2D Text ${context.node.index} uses Multiple, which is not decoded`)
  const entity = loader.state(target) as { text2d?: Map<number, Text2DState> }
  const texts = entity.text2d ??= new Map()
  const previous = texts.get(context.node.index)
  const margins = floats(context.input(3), 4, '2D Text Margins') as Rect
  const state: Text2DState = {
    font: context.input(0) as string | number,
    text: typeof context.input(1) === 'string' ? (context.input(1) as string) : '',
    alignment: Math.trunc(number(context.input(2))),
    margins,
    offset: floats(context.input(4), 2, '2D Text Offset') as [number, number],
    indentation: floats(context.input(5), 2, '2D Text Paragraph Indentation') as [number, number],
    backgroundMaterial: (flags & TEXT_FLAGS.background) ? context.inputObject(6) : undefined,
    caretSize: context.inputCount > 7 && typeof context.input(7) === 'number' ? f(number(context.input(7))) : f(0.1),
    caretMaterial: (flags & TEXT_FLAGS.showCaret) ? context.inputObject(8) : undefined,
    flags,
    version: context.node.version ?? 0,
    registered: true,
    last: previous?.last,
  }
  // re-registering moves the callback to the end of the entity's list
  texts.delete(context.node.index)
  texts.set(context.node.index, state)
  if (state.last) {
    context.setOutput(0, state.last.extents)
    context.setOutput(1, state.last.lineCount)
  }
  context.wait()
}

/** The three blocks over the context (the tutorial host keeps its own presentation without one). */
export const TEXT_CONTEXT_BEHAVIORS = { 'TT CreateFontEx': ttCreateFontEx, 'Set Font Properties': setFontProperties, '2D Text': text2D } as const
