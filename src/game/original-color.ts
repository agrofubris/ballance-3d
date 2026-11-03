// VxMath.dll's two RGBAFTOCOLOR exports, which convert float colours to a
// 32-bit ARGB word differently. Both were read from the supplied DLL.

export type OriginalColorBytes = [r: number, g: number, b: number, a: number]

/** x87 FRNDINT in its default round-to-nearest-even mode. */
function roundEven(value: number) {
  const floor = Math.floor(value), diff = value - floor
  if (diff !== .5) return Math.round(value)
  return floor % 2 === 0 ? floor : floor + 1
}

/** FISTP to a 32-bit integer: out-of-range values store the integer indefinite. */
function fistp(value: number) {
  return value >= -2147483648 && value <= 2147483647 ? roundEven(value) | 0 : -2147483648
}

/**
 * `RGBAFTOCOLOR(float r, float g, float b, float a)` (export at 0x242824A0).
 * Each channel is scaled so its byte lands in place, rounded with FRNDINT and
 * masked: blue and alpha by 255, green by 255·256 and red by 255·65536. Nothing
 * clamps, so green and red keep only the integer part of their scaled byte,
 * and out-of-range values wrap. `Set Prelit Color` converts its colours here.
 * The products are exact in double precision, as on the default 64-bit x87
 * mantissa; a 24-bit precision-control setting is not reproduced.
 */
export function originalColorFromFloats(r: number, g: number, b: number, a: number): OriginalColorBytes {
  const f = Math.fround
  return [
    (fistp(f(r) * 16711680) & 0xff0000) >>> 16,
    (fistp(f(g) * 65280) & 0xff00) >>> 8,
    fistp(f(b) * 255) & 0xff,
    fistp(f(a) * 255) & 0xff,
  ]
}

/**
 * `RGBAFTOCOLOR(const VxColor *)` (export at 0x24282540) on an SSE CPU:
 * MULPS by 255, CVTTPS2PI truncation, then PACKSSDW/PACKUSWB saturation to
 * 0..255. The particle render callbacks convert their colours here.
 */
export function originalColorFromVxColor(r: number, g: number, b: number, a: number): OriginalColorBytes {
  return [originalVxColorChannel(r), originalVxColorChannel(g), originalVxColorChannel(b), originalVxColorChannel(a)]
}

/** One channel of `originalColorFromVxColor`, as a byte. */
export function originalVxColorChannel(value: number) {
  // MULPS rounds the product to float32; CVTTPS2PI stores the integer
  // indefinite (0x80000000, saturating to 0) for NaN or out-of-range values.
  const product = Math.fround(Math.fround(value) * 255)
  if (!(product > -2147483649 && product < 2147483648)) return 0
  return Math.min(255, Math.max(0, Math.trunc(product)))
}
