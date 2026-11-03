import { originalParameterClass } from './original-context.ts'
import type { BehaviorContext, GraphParameterValue } from './original-graph.ts'

/** CKParameter type GUIDs (`ParameterTypes`) as the exporter writes them. */
export const ORIGINAL_STRING_TYPE = 'e210d06bea175611'
export const ORIGINAL_FLOAT_TYPE = '3f4c8847202c2c43'
export const ORIGINAL_INTEGER_TYPE = 'fd16575ad776e244'
export const ORIGINAL_TIME_TYPE = '2b42b4544f0f0f73'
export const ORIGINAL_BOOLEAN_TYPE = '8e2ad51a2019745e'
export const ORIGINAL_PERCENTAGE_TYPE = '4e4bc8f334ccfa0f'
export const ORIGINAL_VECTOR2D_TYPE = '4ab3fc4e2fe47960'

/** C `%.Nd`: at least N digits, zero padded, with the sign before them. */
function originalPaddedInteger(value: number, width: number): string {
  const digits = String(Math.abs(value)).padStart(width, '0')
  return value < 0 ? `-${digits}` : digits
}

/** C `printf` with `%g` (default precision 6) removes a fraction's trailing zeros. */
function originalTrimFraction(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

/** MSVCRT `sprintf("%g", value)`: six significant digits, trailing zeros removed. */
function originalFormatG(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`%g of ${value} is not recovered`)
  if (value === 0) return Object.is(value, -0) ? '-0' : '0'
  const negative = value < 0
  const magnitude = Math.abs(value)
  const [mantissa, exponentText] = magnitude.toExponential(5).split('e')
  const exponent = Number(exponentText)
  if (exponent >= -4 && exponent < 6) {
    const fixed = magnitude.toFixed(5 - exponent)
    return (negative ? '-' : '') + originalTrimFraction(fixed)
  }
  const digits = String(Math.abs(exponent)).padStart(2, '0')
  return (negative ? '-' : '') + originalTrimFraction(mantissa!) + 'e' + (exponent < 0 ? '-' : '+') + digits
}

/**
 * CKPGUID_FLOAT's string function in CK2.dll 0x240342CE: value direction
 * `sprintf(buffer, "%g", (double)floatValue)` (format at 0x24059960).
 */
export function originalFloatToString(value: number): string {
  return originalFormatG(Math.fround(value))
}

/**
 * CKPGUID_TIME's string function in CK2.dll 0x240343FD: MSVCRT `_ftol`
 * truncates the float milliseconds, `div` splits minutes (60000) and seconds
 * (1000), and `sprintf` uses `%.2dm %.2ds %.3dms` (0x2405A844).
 */
export function originalTimeToString(value: number): string {
  const float = Math.fround(value)
  if (!Number.isFinite(float)) throw new Error(`Time to string of ${value} is not recovered`)
  const total = Math.trunc(float)
  const minutes = Math.trunc(total / 60000)
  const remainder = total % 60000
  const seconds = Math.trunc(remainder / 1000)
  const milliseconds = remainder % 1000
  return `${originalPaddedInteger(minutes, 2)}m ${originalPaddedInteger(seconds, 2)}s ${originalPaddedInteger(milliseconds, 3)}ms`
}

/**
 * CKPGUID_INTEGER's string function in CK2.dll 0x24033BA2: the value direction
 * is `sprintf(buffer, "%d", value)` (%d at 0x240594D4), a signed 32-bit int.
 */
export function originalIntegerToString(value: number): string {
  return String(Math.trunc(value) | 0)
}

/**
 * CKPGUID_BOOLEAN's string function in CK2.dll 0x24034228: the value direction
 * writes "TRUE" (0x2405A828) for a non-zero value and "FALSE" (0x2405A820)
 * otherwise.
 */
export function originalBooleanToString(value: GraphParameterValue): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return value !== 0 ? 'TRUE' : 'FALSE'
  throw new Error(`Boolean to string of ${JSON.stringify(value)} is not recovered`)
}

/**
 * CKPGUID_PERCENTAGE's string function in CK2.dll 0x2403435B: multiplication by
 * 100.0f (0x2403FF4C) then `sprintf("%g%%")` (%g%% at 0x2405A834).
 */
export function originalPercentageToString(value: number): string {
  return originalFormatG(Math.fround(value) * 100) + '%'
}

/**
 * CKPGUID_INTEGER's string function in CK2.dll 0x24033BA2, string direction:
 * `sscanf(input, "%d", &value)` (%d at 0x240594D4). A non-number leaves the
 * value at 0; overflow wraps modulo 2^32 as MSVCRT's scanf does.
 */
export function originalIntegerFromString(value: string): number {
  const match = /^[ \t\n\r\f\v]*([+-]?)(\d+)/.exec(value)
  if (!match) return 0
  const magnitude = BigInt(match[2]) & 0xffffffffn
  const wrapped = match[1] === '-' ? (0x100000000n - magnitude) & 0xffffffffn : magnitude
  return wrapped >= 0x80000000n ? Number(wrapped) - 0x100000000 : Number(wrapped)
}

/**
 * CKPGUID_FLOAT's string function in CK2.dll 0x240342CE, string direction:
 * `sscanf(input, "%f", &value)` (%f at 0x2405A830); a non-number leaves 0.
 */
export function originalFloatFromString(value: string): number {
  const match = /^[ \t\n\r\f\v]*([+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?)/.exec(value)
  return match ? Math.fround(Number(match[1])) : 0
}

/**
 * CKPGUID_BOOLEAN's string function in CK2.dll 0x24034228, string direction:
 * `strncpy(buffer, input, 5)` then `_strcmpi(buffer, "TRUE")`; only a
 * case-insensitive "TRUE" gives 1, everything else gives 0.
 */
export function originalBooleanFromString(value: string): boolean {
  return value.toLowerCase() === 'true'
}

/**
 * CKPGUID_PERCENTAGE's string function in CK2.dll 0x2403435B, string direction:
 * `sscanf(input, "%f%%", &value)` (%f%% at 0x2405A83C) then multiplication by
 * 0.01f (0x2403F1C0); a non-number leaves 0.
 */
export function originalPercentageFromString(value: string): number {
  return Math.fround(Math.fround(originalFloatFromString(value)) * Math.fround(0.01))
}

/**
 * Float to Integer in ParameterOperations.dll 0x24B45710: `fld` the float and
 * call MSVCRT `_ftol` (0x24B5DD20, imported at 0x24B5E110), which truncates
 * toward zero and yields 0x80000000 for NaN or an out-of-range value.
 */
export function originalFloatToInteger(value: number): number {
  const float = Math.fround(value)
  if (!Number.isFinite(float)) return -0x80000000
  const truncated = Math.trunc(float)
  return truncated < -0x80000000 || truncated > 0x7fffffff ? -0x80000000 : truncated | 0
}

function originalConvertNumber(value: GraphParameterValue, pair: string): number {
  if (typeof value !== 'number') throw new Error(`Convert ${pair} of ${JSON.stringify(value)} is not recovered`)
  return value
}

function originalConvertString(value: GraphParameterValue, pair: string): string {
  if (typeof value !== 'string') throw new Error(`Convert ${pair} of ${JSON.stringify(value)} is not recovered`)
  return value
}

/**
 * CKParameterOperation Convert (ParameterOperations.dll GUID 428009B4:1CAA5C78)
 * for the pairs the shipped graphs use. The operation and parameter-operation
 * paths both call this, so they cannot disagree. Unrecovered pairs fail loudly.
 */
export function originalConvert(
  context: BehaviorContext | undefined,
  sourceType: string | undefined,
  resultType: string | undefined,
  value: GraphParameterValue,
  second: GraphParameterValue = null,
): GraphParameterValue {
  if (resultType === ORIGINAL_VECTOR2D_TYPE) {
    if (typeof value !== 'number' || typeof second !== 'number') {
      throw new Error(`Convert into a 2D vector of ${JSON.stringify(value)} and ${JSON.stringify(second)} is not recovered`)
    }
    return [Math.fround(value), Math.fround(second)]
  }
  if (sourceType !== undefined && sourceType === resultType) return value
  if (sourceType === ORIGINAL_STRING_TYPE) {
    const text = originalConvertString(value, `from ${sourceType} to ${resultType ?? '?'}`)
    if (resultType === ORIGINAL_INTEGER_TYPE) return originalIntegerFromString(text)
    if (resultType === ORIGINAL_FLOAT_TYPE) return originalFloatFromString(text)
    if (resultType === ORIGINAL_BOOLEAN_TYPE) return originalBooleanFromString(text)
    if (resultType === ORIGINAL_PERCENTAGE_TYPE) return originalPercentageFromString(text)
    const cid = originalParameterClass(resultType)
    if (cid !== undefined) {
      if (/^#\d+$/.test(text) || !context?.loader) return text
      return context.loader.find(text, cid) ?? null
    }
  }
  if (sourceType === ORIGINAL_INTEGER_TYPE) {
    const number = originalConvertNumber(value, `from ${sourceType} to ${resultType ?? '?'}`)
    if (resultType === ORIGINAL_STRING_TYPE) return originalIntegerToString(number)
    if (resultType === ORIGINAL_FLOAT_TYPE) return Math.fround(number)
  }
  if (sourceType === ORIGINAL_FLOAT_TYPE) {
    const number = originalConvertNumber(value, `from ${sourceType} to ${resultType ?? '?'}`)
    if (resultType === ORIGINAL_STRING_TYPE) return originalFloatToString(number)
    if (resultType === ORIGINAL_INTEGER_TYPE) return originalFloatToInteger(number)
  }
  if (sourceType === ORIGINAL_TIME_TYPE && resultType === ORIGINAL_STRING_TYPE) {
    return originalTimeToString(originalConvertNumber(value, `from ${sourceType} to ${resultType}`))
  }
  if (sourceType === ORIGINAL_BOOLEAN_TYPE && resultType === ORIGINAL_STRING_TYPE) return originalBooleanToString(value)
  if (sourceType === ORIGINAL_PERCENTAGE_TYPE && resultType === ORIGINAL_STRING_TYPE) {
    return originalPercentageToString(originalConvertNumber(value, `from ${sourceType} to ${resultType}`))
  }
  throw new Error(`Convert from ${sourceType ?? '?'} to ${resultType ?? '?'} of ${JSON.stringify(value)} is not recovered`)
}
