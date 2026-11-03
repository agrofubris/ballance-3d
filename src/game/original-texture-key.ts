import * as THREE from 'three'

/**
 * CKBitmapData::SetAlphaForTransparentColor (CK2.dll 0x24030617): clear each
 * colour's low bit and give every pixel that equals the key colour alpha 0,
 * every other pixel alpha 255. The key's own alpha is ignored.
 */
export function applyOriginalTextureKey(pixels: Uint8Array | Uint8ClampedArray, key: number) {
  const keyed = key & 0xfefefe
  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i]! & 0xfe, green = pixels[i + 1]! & 0xfe, blue = pixels[i + 2]! & 0xfe
    pixels[i] = red; pixels[i + 1] = green; pixels[i + 2] = blue
    pixels[i + 3] = ((red << 16) | (green << 8) | blue) === keyed ? 0 : 255
  }
  return pixels
}

/** Load a texture, applying its exported colour key through a canvas when it has one. */
export async function loadOriginalTexture(file: string, key: number | undefined): Promise<THREE.Texture> {
  if (key === undefined) return new THREE.TextureLoader().loadAsync(`/original/${file}`)
  const image = await new THREE.ImageLoader().loadAsync(`/original/${file}`)
  const canvas = document.createElement('canvas')
  canvas.width = image.width; canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error(`Cannot apply the colour key of ${file}: no 2D canvas context`)
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, image.width, image.height)
  applyOriginalTextureKey(pixels.data, key)
  context.putImageData(pixels, 0, 0)
  return new THREE.CanvasTexture(canvas)
}
