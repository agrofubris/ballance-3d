'use strict'

/**
 * Leia SR offscreen frame capture.
 *
 * The offscreen game window paints its full eye pair through Chromium's
 * compositor, so the `paint` image already contains the DOM menu/HUD and the
 * WebGL canvas. This is the CPU-bitmap fallback; when Electron supports
 * `offscreen.useSharedTexture` the main process sends the GPU handle instead
 * (see transport.cjs and docs/leia-sr.md). `NativeImage.getBitmap()` returns the raw Windows SkBitmap
 * pixels without copying; on Windows that is BGRA (kN32_SkColorType), which is
 * exactly the byte order the SR runtime expects. We copy it immediately
 * because the returned Buffer is only valid in the current event-loop tick,
 * and keep only the newest frame.
 *
 * `encodeBmp` writes a plain 32-bit BI_RGB BMP: BGRA pixels, bottom-up rows
 * (the SkBitmap rows are top-down, so they are reversed here). No dependency.
 */

const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const BMP_FILE_HEADER_BYTES = 14
const BMP_INFO_HEADER_BYTES = 40
const BMP_PIXEL_OFFSET = BMP_FILE_HEADER_BYTES + BMP_INFO_HEADER_BYTES
const BYTES_PER_PIXEL = 4

function encodeBmp({ data, width, height }) {
  if (!Buffer.isBuffer(data)) throw new Error('encodeBmp needs a Buffer')
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`encodeBmp needs positive integer dimensions, got ${width}x${height}`)
  }
  const rowBytes = width * BYTES_PER_PIXEL
  if (data.length !== rowBytes * height) {
    throw new Error(`encodeBmp expected ${rowBytes * height} BGRA bytes for ${width}x${height}, got ${data.length}`)
  }
  const imageBytes = rowBytes * height
  const output = Buffer.alloc(BMP_PIXEL_OFFSET + imageBytes)
  output.write('BM', 0, 2, 'ascii')
  output.writeUInt32LE(output.length, 2)
  output.writeUInt32LE(BMP_PIXEL_OFFSET, 10)
  output.writeUInt32LE(BMP_INFO_HEADER_BYTES, 14)
  output.writeInt32LE(width, 18)
  output.writeInt32LE(height, 22)
  output.writeUInt16LE(1, 26)
  output.writeUInt16LE(32, 28)
  output.writeUInt32LE(0, 30)
  output.writeUInt32LE(imageBytes, 34)
  for (let row = 0; row < height; row += 1) {
    const source = (height - 1 - row) * rowBytes
    data.copy(output, BMP_PIXEL_OFFSET + row * rowBytes, source, source + rowBytes)
  }
  return output
}

function pixelSize(image) {
  const size = image.getSize()
  return { width: Math.round(size.width), height: Math.round(size.height) }
}

function createLeiaCapture({ dumpDir = null, dumpInterval = 60, now = Date.now } = {}) {
  if (dumpDir) mkdirSync(dumpDir, { recursive: true })
  let newest = null
  let paints = 0
  let dumps = 0

  const capture = {
    onPaint(image) {
      if (!image || image.isEmpty()) return null
      const { width, height } = pixelSize(image)
      const bitmap = image.getBitmap()
      const expected = width * height * BYTES_PER_PIXEL
      if (bitmap.length !== expected) {
        throw new Error(`Leia paint is ${bitmap.length} bytes, expected ${expected} for ${width}x${height} BGRA`)
      }
      paints += 1
      newest = { data: Buffer.from(bitmap), width, height, frame: paints, at: now() }
      if (dumpDir && paints % dumpInterval === 0) {
        const file = path.join(dumpDir, `frame-${String(paints).padStart(5, '0')}.bmp`)
        writeFileSync(file, encodeBmp(newest))
        newest.dump = file
        dumps += 1
      }
      return newest
    },
    get newest() { return newest },
    get stats() { return { paints, dumps, newest } },
    stop() { newest = null },
  }
  return capture
}

module.exports = { BMP_PIXEL_OFFSET, encodeBmp, createLeiaCapture }
