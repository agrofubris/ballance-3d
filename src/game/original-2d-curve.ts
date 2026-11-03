import type { UfoCurvePoint } from './original-ufo-animation.ts'

/** CKPGUID_2DCURVE, the parameter type GUID at offset 16 of a saved curve. */
const CURVE_GUID = '5d34ad20b125fb1a'
/** Saved CK2dCurvePoint flags carry this bit; the rest are the point flags. */
const POINT_SAVED = 0x10000000

/**
 * A CK2dCurve saved in a parameter chunk, as the exporter keeps it (hex).
 * CK2dCurve::Dump: a nested state chunk (identifier 0x100), a null object
 * array, the fitting coefficient, then per control point its flags and eleven
 * floats: position, TCB/length (unused, zero), incoming and outgoing tangents.
 * The layout was first recovered from the UFO animation's curves; anything
 * else fails loudly.
 */
export function decodeOriginal2dCurve(hex: string): UfoCurvePoint[] {
  const bytes = new Uint8Array(hex.match(/../g)?.map(byte => parseInt(byte, 16)) ?? [])
  const view = new DataView(bytes.buffer)
  const guid = [...bytes.subarray(16, 24)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  if (bytes.length < 116 || guid !== CURVE_GUID || view.getUint32(24, true) !== 0) throw new Error('Parameter is not a saved CK2dCurve')
  if (view.getUint32(100, true) !== 0x100 || view.getUint32(104, true) !== 0) throw new Error('Unsupported CK2dCurve chunk')
  const count = view.getUint32(108, true)
  let offset = 112
  for (let i = 0; i < count; i++, offset += 4) {
    if (view.getUint32(offset, true) !== 0) throw new Error('CK2dCurve control points reference objects')
  }
  if (view.getFloat32(offset, true) !== 0) throw new Error('CK2dCurve fitting is not implemented')
  offset += 4
  if (bytes.length < offset + count * 48) throw new Error('Truncated CK2dCurve')
  const points: UfoCurvePoint[] = []
  for (let i = 0; i < count; i++, offset += 48) {
    const flags = view.getUint32(offset, true)
    const value = (slot: number) => view.getFloat32(offset + 4 + slot * 4, true)
    if (!(flags & POINT_SAVED)) throw new Error('Unsupported CK2dCurve point')
    for (let slot = 2; slot < 7; slot++) {
      if (value(slot) !== 0) throw new Error('CK2dCurve TCB parameters are not implemented')
    }
    points.push({ flags: flags & ~POINT_SAVED, position: [value(0), value(1)], incoming: [value(7), value(8)], outgoing: [value(9), value(10)] })
  }
  return points
}
