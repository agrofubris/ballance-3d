/** The image and audio formats a prepared pack records in its manifest. */

export type OriginalSkyFormat = 'jpg' | 'png'
export type OriginalAudioFormat = 'ogg' | 'm4a' | 'wav'

export interface OriginalPackFormats {
  sky: OriginalSkyFormat
  audio: readonly OriginalAudioFormat[]
}

/** Packs without a formats field are the original ffmpeg-made packs. */
export const DEFAULT_ORIGINAL_PACK_FORMATS: OriginalPackFormats = { sky: 'jpg', audio: ['ogg', 'm4a'] }

const SKY_FORMATS: ReadonlySet<string> = new Set(['jpg', 'png'])
const AUDIO_FORMATS: ReadonlySet<string> = new Set(['ogg', 'm4a', 'wav'])

/** Parse a manifest's formats field; unknown values fail instead of guessing. */
export function parseOriginalPackFormats(manifest: unknown): OriginalPackFormats {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('The original pack manifest is not an object')
  }
  const formats = (manifest as { formats?: unknown }).formats
  if (formats === undefined) return DEFAULT_ORIGINAL_PACK_FORMATS
  if (formats === null || typeof formats !== 'object' || Array.isArray(formats)) {
    throw new Error('The original pack manifest formats field is not an object')
  }
  const sky = (formats as { sky?: unknown }).sky
  if (typeof sky !== 'string' || !SKY_FORMATS.has(sky)) {
    throw new Error(`Unknown original pack sky format ${JSON.stringify(sky)}`)
  }
  const audio = (formats as { audio?: unknown }).audio
  if (!Array.isArray(audio) || audio.length === 0 || !audio.every(format => typeof format === 'string' && AUDIO_FORMATS.has(format))) {
    throw new Error(`Unknown original pack audio formats ${JSON.stringify(audio)}`)
  }
  return { sky: sky as OriginalSkyFormat, audio: [...new Set(audio as OriginalAudioFormat[])] }
}

/** A sky face's pack-relative path for the recorded image format. */
export function originalSkyFile(letter: string, face: string, formats: OriginalPackFormats): string {
  return `sky/Sky_${letter}_${face}.${formats.sky}`
}

/** A sound's pack-relative path for one recorded audio format. */
export function originalAudioFile(name: string, format: OriginalAudioFormat): string {
  const stem = name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  if (!stem) throw new Error(`Audio name ${JSON.stringify(name)} has no file stem`)
  return `audio/${stem}.${format}`
}

let pending: Promise<OriginalPackFormats> | undefined

/** Load and cache the pack's recorded formats; a missing manifest fails loudly. */
export function loadOriginalPackFormats(url = '/original/manifest.json'): Promise<OriginalPackFormats> {
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`The original pack manifest is unavailable (${response.status})`)
      return parseOriginalPackFormats(await response.json())
    })()
  }
  return pending
}
