import type { OriginalUiData, OriginalUiFontStyle, OriginalUiMaterial } from './original-ui.ts'

/**
 * Pure layout helpers for the original 2D interface art. All coordinates are
 * the authored ones: sprite rectangles are normalized to the render window,
 * source rectangles are normalized texture regions, and font metrics are
 * normalized glyph cells of the 512x512 `Font_1` atlas. Nothing here touches the
 * DOM, so the layout can be tested headlessly.
 */

/** The original render window the 2D entities were authored for (4:3). */
export const UI_ASPECT = 4 / 3
/**
 * Reference window height for glyph pixel sizes. Font scales (`Set Font
 * Properties`) multiply the atlas glyph size in render-window pixels; the
 * recovered files do not state the resolution the menu was tuned at, so text is
 * scaled with the 4:3 stage as if rendered at 640x480. Unverified: this is the
 * one open calibration constant of the text renderer.
 */
export const UI_REFERENCE_HEIGHT = 480

export interface CssBox {
  left: string
  top: string
  width: string
  height: string
}

/** A sprite's rectangle as percentages of the stage. */
export function spriteBox(sprite: { rect: readonly number[] }): CssBox {
  const [x0, y0, x1, y1] = sprite.rect as [number, number, number, number]
  return { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` }
}

export interface MaterialCss {
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  backgroundRepeat?: string
  backgroundColor?: string
  backgroundBlendMode?: string
  WebkitMaskImage?: string
  maskImage?: string
  WebkitMaskSize?: string
  maskSize?: string
  WebkitMaskPosition?: string
  maskPosition?: string
  opacity?: number
  mixBlendMode?: string
}

const percent = (value: number) => Math.round(value * 1e6) / 1e4

/**
 * CSS for a texture window: the element box maps to the `uv` rectangle of the
 * atlas. `background-size` stretches the whole atlas so the window fills the
 * box, and `background-position` offsets it by the window origin.
 */
export function textureWindow(url: string, uv: readonly number[]): Pick<MaterialCss, 'backgroundImage' | 'backgroundSize' | 'backgroundPosition' | 'backgroundRepeat'> {
  const [u0, v0, u1, v1] = uv as [number, number, number, number]
  const spanU = u1 - u0, spanV = v1 - v0
  if (!(spanU > 0) || !(spanV > 0)) throw new Error(`Invalid texture window ${uv.join(',')}`)
  const x = spanU >= 1 ? 0 : u0 / (1 - spanU) * 100
  const y = spanV >= 1 ? 0 : v0 / (1 - spanV) * 100
  return {
    backgroundImage: `url(${url})`,
    backgroundSize: `${percent(1 / spanU)}% ${percent(1 / spanV)}%`,
    backgroundPosition: `${percent(x / 100)}% ${percent(y / 100)}%`,
    backgroundRepeat: 'no-repeat',
  }
}

const isWhite = (color: readonly number[]) => color[0] === 1 && color[1] === 1 && color[2] === 1
const rgba = (color: readonly number[], alpha = color[3] ?? 1) => `rgba(${Math.round(color[0]! * 255)},${Math.round(color[1]! * 255)},${Math.round(color[2]! * 255)},${alpha})`

/** Texture file URL, served from the local original pack. */
export function textureUrl(ui: OriginalUiData, name: string): string {
  const texture = ui.textures[name]
  if (!texture) throw new Error(`Original UI texture ${name} is not in the recovered data`)
  return `/original/${texture.file}`
}

/**
 * CSS for a sprite drawn with a material. Textured materials sample their atlas
 * window and are modulated by the diffuse colour (white leaves the art
 * untouched; the diffuse alpha is the sprite opacity). Untextured materials fill
 * the box with the diffuse colour. Additive (ONE, ONE) blending maps to
 * `plus-lighter`; the shipped materials otherwise use SRCALPHA/INVSRCALPHA.
 */
export function materialCss(ui: OriginalUiData, material: OriginalUiMaterial, uv: readonly number[]): MaterialCss {
  const css: MaterialCss = {}
  const alpha = material.diffuse[3] ?? 1
  if (!material.texture) {
    css.backgroundColor = rgba(material.diffuse)
    return css
  }
  const window = textureWindow(textureUrl(ui, material.texture), uv)
  Object.assign(css, window)
  if (alpha < 1) css.opacity = alpha
  if (!isWhite(material.diffuse)) {
    // Modulate by the diffuse colour, keeping the atlas alpha as the shape.
    css.backgroundColor = rgba(material.diffuse, 1)
    css.backgroundBlendMode = 'multiply'
    css.WebkitMaskImage = css.maskImage = window.backgroundImage
    css.WebkitMaskSize = css.maskSize = window.backgroundSize
    css.WebkitMaskPosition = css.maskPosition = window.backgroundPosition
  }
  if (material.blend.enabled && material.blend.source === 2 && material.blend.dest === 2) css.mixBlendMode = 'plus-lighter'
  return css
}

/** One drawn glyph in reference pixels (stage height = UI_REFERENCE_HEIGHT). */
export interface GlyphPlacement {
  code: number
  x: number
  /** Ink box size on screen. */
  width: number
  height: number
  /** Atlas window of the ink box, normalized. */
  u0: number
  v0: number
  u1: number
  v1: number
  /** Atlas size multiplier in pixels per normalized unit. */
  atlasWidth: number
  atlasHeight: number
}

export interface TextLayout {
  lines: { glyphs: GlyphPlacement[]; width: number }[]
  lineHeight: number
  width: number
  height: number
}

/** cp1252 code of a character, matching the original's 8-bit strings. */
export function glyphCode(character: string): number {
  const code = character.codePointAt(0) ?? 32
  if (code < 256) return code
  const table: Record<number, number> = { 0x20ac: 128, 0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x2122: 153 }
  return table[code] ?? 32
}

/**
 * Lay a string out with the recovered glyph table. A glyph's advance is its
 * pre-width, ink width and post-width scaled by the font's X scale, plus the
 * `Space` offset; the row height is the atlas cell height scaled by Y.
 */
export function layoutText(ui: OriginalUiData, fontName: string, text: string, style: OriginalUiFontStyle, maxWidth = Infinity): TextLayout {
  const font = ui.fonts[fontName]
  if (!font) throw new Error(`Original UI font ${fontName} is not in the recovered data`)
  const texture = ui.textures[font.texture]
  if (!texture) throw new Error(`Original UI font texture ${font.texture} is not in the recovered data`)
  const [scaleX, scaleY] = style.scale as [number, number]
  const [spaceX, spaceY] = style.space as [number, number]
  const atlasWidth = texture.width * scaleX, atlasHeight = texture.height * scaleY
  const cell = (code: number) => {
    const entry = ui.font[code]
    if (!entry) throw new Error(`Original UI font has no glyph ${code}`)
    return entry
  }
  const advance = (code: number) => {
    const entry = cell(code)
    return (entry.uprewidth + entry.uwidth + entry.upostwidth) * atlasWidth + spaceX
  }
  const wordWidth = (word: string) => [...word].reduce((sum, character) => sum + advance(glyphCode(character)), 0)
  // `2D Text` wraps at spaces inside the sprite rectangle; an explicit newline always breaks.
  const paragraphs = text.split('\n').flatMap(paragraph => {
    if (!Number.isFinite(maxWidth)) return [paragraph]
    const rows: string[] = []
    let row = ''
    for (const word of paragraph.split(' ')) {
      const candidate = row === '' ? word : `${row} ${word}`
      if (row !== '' && wordWidth(candidate) > maxWidth) {
        rows.push(row)
        row = word
      } else row = candidate
    }
    rows.push(row)
    return rows
  })
  let lineHeight = 0
  const lines = paragraphs.map(line => {
    let x = 0
    const glyphs: GlyphPlacement[] = []
    for (const character of line) {
      const code = glyphCode(character), entry = cell(code)
      const width = entry.uwidth * atlasWidth, height = entry.vwidth * atlasHeight
      lineHeight = Math.max(lineHeight, height)
      glyphs.push({
        code, x: x + entry.uprewidth * atlasWidth, width, height,
        u0: entry.ustart, v0: entry.vstart, u1: entry.ustart + entry.uwidth, v1: entry.vstart + entry.vwidth,
        atlasWidth, atlasHeight,
      })
      x += advance(code)
    }
    return { glyphs, width: x }
  })
  if (lineHeight === 0) lineHeight = cell(65).vwidth * atlasHeight
  // `Space` is the font's extra advance per glyph (x) and per line (y); the tutorial font's -1.0 tightens its lines.
  lineHeight += spaceY
  return { lines, lineHeight, width: Math.max(0, ...lines.map(line => line.width)), height: lineHeight * lines.length }
}

/** Alignment bits of `2D Text`: 0 centers; 1 left, 2 right, 4 top, 8 bottom. */
export function textAlignment(align: number) {
  return {
    horizontal: align & 1 ? 'left' as const : align & 2 ? 'right' as const : 'center' as const,
    vertical: align & 4 ? 'top' as const : align & 8 ? 'bottom' as const : 'center' as const,
  }
}

/** Shadow offset in reference pixels from the authored angle (radians) and distance. */
export function shadowOffset(style: OriginalUiFontStyle): [number, number] {
  return [Math.cos(style.shadowAngle) * style.shadowDistance, Math.sin(style.shadowAngle) * style.shadowDistance]
}

/** Stage geometry of the 4:3 UI inside a window, in window pixels. */
export function stageBox(width: number, height: number) {
  const stageWidth = Math.min(width, height * UI_ASPECT), stageHeight = Math.min(height, width / UI_ASPECT)
  return { left: (width - stageWidth) / 2, top: (height - stageHeight) / 2, width: stageWidth, height: stageHeight }
}

/** The graph session's canvas: the whole window in widescreen, otherwise the centered 4:3 stage. */
export function canvasBox(width: number, height: number, widescreen: boolean) {
  return widescreen ? { left: 0, top: 0, width, height } : stageBox(width, height)
}

export type PointerLayout = 'mono' | 'half' | 'half-vertical' | 'full'

/**
 * Map a pointer position in the window to stage coordinates (0..1). Side-by-side
 * layouts show the whole UI in each half, squeezed to half width, and
 * top-and-bottom layouts do the same vertically, so a pointer in either slot
 * addresses the same spot; interlaced and mono layouts use the whole window.
 * Full layouts display the same halves (the browser scales their doubled
 * buffer down), so they map through the half versions. Depth offsets are
 * ignored on purpose: the two eye copies fuse at the unshifted position, which
 * is where the viewer perceives the control. `box` defaults to the 4:3 stage; a
 * widescreen host passes the full-window canvas.
 *
 * `eyeFrameWidth` is the one-eye width when the page itself is the full pair
 * (Leia SR): the x fold still uses the page's half, but each half is a
 * complete, unsqueezed eye frame mapping into `box`.
 */
export function stagePointer(x: number, y: number, width: number, height: number, layout: PointerLayout, box = stageBox(width, height), eyeFrameWidth?: number): { u: number; v: number } {
  const panelWidth = layout === 'half' ? width / 2 : width
  const panelHeight = layout === 'half-vertical' ? height / 2 : height
  const foldedX = layout === 'half' ? ((x % panelWidth) + panelWidth) % panelWidth : x
  const foldedY = layout === 'half-vertical' ? ((y % panelHeight) + panelHeight) % panelHeight : y
  const monoWidth = layout === 'half' && eyeFrameWidth !== undefined ? eyeFrameWidth : width
  const monoX = (foldedX / panelWidth) * monoWidth
  const monoY = (foldedY / panelHeight) * height
  return { u: (monoX - box.left) / box.width, v: (monoY - box.top) / box.height }
}

export function pointerLayout(mode: string): PointerLayout {
  return mode === 'sbs' || mode === 'crossview' || mode === 'sbs-full' || mode === 'leia-sr' ? 'half'
    : mode === 'tab' || mode === 'tab-full' ? 'half-vertical'
    : mode === 'off' ? 'mono' : 'full'
}
