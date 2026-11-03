const KEYFRAME = 0x10
const VIDEO1_CODECS = new Set(['CRAM', 'MSVC', 'WHAM'])

export interface OriginalAviInfo {
  width: number
  height: number
  frames: number
  fps: number
  framePeriodMs: number
  bitsPerPixel: number
  codec: string
  handler: string
}

interface AviFrame {
  keyframe: boolean
  data: Uint8Array
}

interface AviStream {
  handler: string
  scale: number
  rate: number
  length: number
  width: number
  height: number
  bitsPerPixel: number
  codec: string
  palette: Uint8Array | undefined
}

function fourcc(bytes: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error(`AVI: truncated fourcc at ${offset}`)
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!)
}

function readStream(bytes: Uint8Array, strh: { offset: number; size: number }, strf: { offset: number; size: number }): AviStream {
  if (strh.size < 56) throw new Error(`AVI: stream header is ${strh.size} bytes`)
  if (strf.size < 40) throw new Error(`AVI: bitmap header is ${strf.size} bytes`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const handler = fourcc(bytes, strh.offset + 4)
  const scale = view.getUint32(strh.offset + 20, true)
  const rate = view.getUint32(strh.offset + 24, true)
  const length = view.getUint32(strh.offset + 32, true)
  if (scale === 0 || rate === 0) throw new Error(`AVI: stream frame rate is ${rate}/${scale}`)
  const headerSize = view.getUint32(strf.offset, true)
  if (headerSize < 40) throw new Error(`AVI: bitmap header size is ${headerSize}`)
  const width = view.getInt32(strf.offset + 4, true)
  const height = view.getInt32(strf.offset + 8, true)
  const bitsPerPixel = view.getUint16(strf.offset + 14, true)
  const codec = fourcc(bytes, strf.offset + 16)
  if (!VIDEO1_CODECS.has(codec)) throw new Error(`AVI: unsupported video codec ${JSON.stringify(codec)}`)
  if (bitsPerPixel !== 8 && bitsPerPixel !== 16) throw new Error(`AVI: Microsoft Video 1 at ${bitsPerPixel} bpp is not supported`)
  if (width <= 0 || height <= 0 || width % 4 !== 0 || height % 4 !== 0) {
    throw new Error(`AVI: ${width}x${height} is not a positive multiple of 4`)
  }
  let palette: Uint8Array | undefined
  if (bitsPerPixel === 8) {
    const used = view.getUint32(strf.offset + 32, true)
    const count = used === 0 ? 256 : used
    if (count > 256) throw new Error(`AVI: palette has ${count} entries`)
    if (headerSize + count * 4 > strf.size) throw new Error('AVI: truncated palette')
    palette = new Uint8Array(256 * 4)
    for (let i = 0; i < count; i++) {
      const source = strf.offset + headerSize + i * 4
      const target = i * 4
      palette[target] = bytes[source + 2]!
      palette[target + 1] = bytes[source + 1]!
      palette[target + 2] = bytes[source]!
      palette[target + 3] = 255
    }
  }
  return { handler, scale, rate, length, width, height, bitsPerPixel, codec, palette }
}

export class OriginalAvi {
  readonly info: OriginalAviInfo
  private readonly frames: readonly AviFrame[]
  private readonly palette: Uint8Array | undefined
  private last: { index: number; pixels: Uint8Array } | undefined

  private constructor(info: OriginalAviInfo, frames: readonly AviFrame[], palette: Uint8Array | undefined) {
    this.info = info
    this.frames = frames
    this.palette = palette
  }

  static parse(bytes: Uint8Array): OriginalAvi {
    if (bytes.length < 12 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'AVI ') {
      throw new Error('AVI: not a RIFF AVI file')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const riffEnd = 8 + view.getUint32(4, true)
    if (riffEnd > bytes.length) throw new Error('AVI: truncated RIFF body')
    let microSecPerFrame = 0
    let totalFrames = 0
    let stream: AviStream | undefined
    let streamIndex = 0
    let moviBase: number | undefined
    let index: { offset: number; size: number } | undefined

    const scan = (start: number, end: number, visit: (id: string, payload: number, size: number) => void) => {
      let offset = start
      while (offset + 8 <= end) {
        const id = fourcc(bytes, offset)
        const size = view.getUint32(offset + 4, true)
        const payload = offset + 8
        if (payload + size > end) throw new Error(`AVI: ${id} chunk overruns its parent`)
        visit(id, payload, size)
        offset = payload + size + (size & 1)
      }
      if (offset < end) throw new Error('AVI: trailing bytes in a chunk list')
    }

    let header: { start: number; end: number } | undefined
    scan(12, riffEnd, (id, payload, size) => {
      if (id === 'LIST') {
        const type = fourcc(bytes, payload)
        if (type === 'hdrl') {
          if (header) throw new Error('AVI: more than one hdrl list')
          header = { start: payload + 4, end: payload + size }
        } else if (type === 'movi') {
          if (moviBase !== undefined) throw new Error('AVI: more than one movi list')
          moviBase = payload
        }
      } else if (id === 'idx1') {
        if (index !== undefined) throw new Error('AVI: more than one idx1 chunk')
        index = { offset: payload, size }
      }
    })
    if (!header) throw new Error('AVI: no hdrl list')
    const headerList: { start: number; end: number } = header
    let streamCount = 0
    scan(headerList.start, headerList.end, (id, payload, size) => {
      if (id === 'avih') {
        if (size < 40) throw new Error('AVI: truncated main header')
        microSecPerFrame = view.getUint32(payload, true)
        totalFrames = view.getUint32(payload + 16, true)
        return
      }
      if (id !== 'LIST' || fourcc(bytes, payload) !== 'strl') return
      const number = streamCount++
      let strh: { offset: number; size: number } | undefined
      let strf: { offset: number; size: number } | undefined
      scan(payload + 4, payload + size, (child, childPayload, childSize) => {
        if (child === 'strh') strh = { offset: childPayload, size: childSize }
        else if (child === 'strf') strf = { offset: childPayload, size: childSize }
      })
      if (!strh || !strf || stream || fourcc(bytes, strh.offset) !== 'vids') return
      stream = readStream(bytes, strh, strf)
      streamIndex = number
    })
    if (!stream) throw new Error('AVI: no video stream')
    if (moviBase === undefined) throw new Error('AVI: no movi list')
    if (!index) throw new Error('AVI: no idx1 index')
    const video = stream
    const frames = video.length || totalFrames
    if (frames === 0) throw new Error('AVI: the video stream has no frames')
    const chunks: AviFrame[] = []
    for (let offset = 0; offset + 16 <= index.size; offset += 16) {
      const source = index.offset + offset
      const id = fourcc(bytes, source)
      const suffix = id.slice(2)
      const number = Number.parseInt(id.slice(0, 2), 16)
      if (number !== streamIndex) continue
      if (suffix === 'pc') throw new Error('AVI: compressed palette changes are not decoded')
      if (suffix !== 'dc') throw new Error(`AVI: unsupported video chunk ${JSON.stringify(id)}`)
      const flags = view.getUint32(source + 4, true)
      const chunkOffset = view.getUint32(source + 8, true)
      const chunkSize = view.getUint32(source + 12, true)
      const chunk = moviBase + chunkOffset
      if (chunk + 8 + chunkSize > bytes.length) throw new Error(`AVI: frame ${chunks.length} overruns the file`)
      if (fourcc(bytes, chunk) !== id) throw new Error(`AVI: frame ${chunks.length} has no ${id} chunk at its index offset`)
      if (view.getUint32(chunk + 4, true) !== chunkSize) throw new Error(`AVI: frame ${chunks.length} size disagrees with idx1`)
      chunks.push({ keyframe: (flags & KEYFRAME) !== 0, data: bytes.subarray(chunk + 8, chunk + 8 + chunkSize) })
    }
    if (chunks.length !== frames) throw new Error(`AVI: idx1 lists ${chunks.length} frames, the stream header says ${frames}`)
    const fps = video.rate / video.scale
    const framePeriodMs = microSecPerFrame !== 0 ? microSecPerFrame / 1000 : 1000 / fps
    return new OriginalAvi(Object.freeze({
      width: video.width, height: video.height, frames, fps, framePeriodMs,
      bitsPerPixel: video.bitsPerPixel, codec: video.codec, handler: video.handler,
    }), chunks, video.palette)
  }

  decodeFrame(index: number): Uint8Array {
    if (!Number.isInteger(index) || index < 0 || index >= this.frames.length) {
      throw new RangeError(`AVI: frame ${index} is outside 0..${this.frames.length - 1}`)
    }
    const frame = this.frames[index]!
    if (this.last?.index === index - 1 && !frame.keyframe) {
      const pixels = this.last.pixels.slice()
      this.decodeInto(pixels, frame)
      this.last = { index, pixels }
      return pixels
    }
    let key = index
    while (key > 0 && !this.frames[key]!.keyframe) key--
    if (!this.frames[key]!.keyframe) throw new Error(`AVI: frame ${index} has no earlier key frame`)
    const pixels = new Uint8Array(this.info.width * this.info.height * 4)
    for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255
    for (let current = key; current <= index; current++) this.decodeInto(pixels, this.frames[current]!)
    this.last = { index, pixels }
    return pixels
  }

  private decodeInto(pixels: Uint8Array, frame: AviFrame): void {
    const { width, height, bitsPerPixel } = this.info
    const data = frame.data
    const blocksPerRow = width >> 2
    const total = blocksPerRow * (height >> 2)
    const palette = this.palette
    let position = 0
    let block = 0
    const byte = () => {
      if (position >= data.length) throw new Error('AVI: truncated Video 1 frame')
      return data[position++]!
    }
    const word = () => {
      if (position + 2 > data.length) throw new Error('AVI: truncated Video 1 frame')
      const value = data[position]! | (data[position + 1]! << 8)
      position += 2
      return value
    }
    const put = (x: number, y: number, r: number, g: number, b: number) => {
      const offset = (y * width + x) * 4
      pixels[offset] = r
      pixels[offset + 1] = g
      pixels[offset + 2] = b
      pixels[offset + 3] = 255
    }
    const putIndex = (x: number, y: number, index: number) => {
      if (!palette || index >= 256 || palette[index * 4 + 3] === 0) throw new Error(`AVI: palette index ${index} is not in the file`)
      const offset = index * 4
      put(x, y, palette[offset]!, palette[offset + 1]!, palette[offset + 2]!)
    }
    const rgb = (value: number): [number, number, number] => {
      const v = value & 0x7fff
      const r = (v >> 10) & 31
      const g = (v >> 5) & 31
      const b = v & 31
      return [(r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2)]
    }
    const fill = (color: [number, number, number]) => {
      const row = Math.floor(block / blocksPerRow)
      const column = block % blocksPerRow
      const x = column * 4
      const y = height - 4 - row * 4
      for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) put(x + px, y + py, color[0], color[1], color[2])
      block++
    }
    const flags = (a: number, b: number, colorA: number, colorB: number) => {
      const row = Math.floor(block / blocksPerRow)
      const column = block % blocksPerRow
      const x = column * 4
      const y = height - 4 - row * 4
      for (let py = 0; py < 4; py++) {
        const nibble = py < 2 ? b : a
        const base = py % 2 === 0 ? 4 : 0
        for (let px = 0; px < 4; px++) {
          if (bitsPerPixel === 8) putIndex(x + px, y + py, (nibble & (1 << (base + px))) !== 0 ? colorA : colorB)
          else {
            const color = rgb((nibble & (1 << (base + px))) !== 0 ? colorA : colorB)
            put(x + px, y + py, color[0], color[1], color[2])
          }
        }
      }
      block++
    }
    const quads = (a: number, b: number, colors: [number, number][]) => {
      const row = Math.floor(block / blocksPerRow)
      const column = block % blocksPerRow
      const x = column * 4
      const y = height - 4 - row * 4
      for (let quad = 1; quad <= 4; quad++) {
        const [colorA, colorB] = colors[quad - 1]!
        const rows = quad <= 2 ? [2, 3] : [0, 1]
        const columns = quad === 1 || quad === 3 ? [0, 1] : [2, 3]
        for (const py of rows) for (const px of columns) {
          const nibble = py < 2 ? b : a
          const bit = (py % 2 === 0 ? 4 : 0) + px
          if (bitsPerPixel === 8) putIndex(x + px, y + py, (nibble & (1 << bit)) !== 0 ? colorA : colorB)
          else {
            const color = rgb((nibble & (1 << bit)) !== 0 ? colorA : colorB)
            put(x + px, y + py, color[0], color[1], color[2])
          }
        }
      }
      block++
    }
    while (block < total) {
      const a = byte()
      const b = byte()
      if (bitsPerPixel === 8) {
        if (0x84 <= b && b < 0x88) {
          block += (b - 0x84) * 256 + a
          if (block > total) throw new Error('AVI: Video 1 skip runs past the frame')
        } else if (b < 0x80) {
          const colorA = byte()
          const colorB = byte()
          flags(a, b, colorA, colorB)
        } else if (b >= 0x90) {
          const colors: [number, number][] = []
          for (let quad = 0; quad < 4; quad++) colors.push([byte(), byte()])
          quads(a, b, colors)
        } else {
          if (!palette || palette[a * 4 + 3] === 0) throw new Error(`AVI: palette index ${a} is not in the file`)
          fill([palette[a * 4]!, palette[a * 4 + 1]!, palette[a * 4 + 2]!])
        }
      } else {
        if (0x84 <= b && b < 0x88) {
          block += (b - 0x84) * 256 + a
          if (block > total) throw new Error('AVI: Video 1 skip runs past the frame')
        } else if (b < 0x80) {
          const first = word()
          if ((first & 0x8000) !== 0) {
            const colors: [number, number][] = [[first & 0x7fff, word()]]
            for (let quad = 1; quad < 4; quad++) colors.push([word(), word()])
            quads(a, b, colors)
          } else {
            flags(a, b, first, word())
          }
        } else {
          fill(rgb(a | (b << 8)))
        }
      }
    }
    if (position + 2 <= data.length) {
      if (data[position] !== 0 || data[position + 1] !== 0) throw new Error('AVI: Video 1 frame has trailing data')
      position += 2
    }
    for (; position < data.length; position++) if (data[position] !== 0) throw new Error('AVI: Video 1 frame has trailing data')
  }
}
