// Intro movie blocks, decoded from the shipped DLLs (see notes.md):
//   BuildingBlocksAddons1.dll  Movie Load   declaration 0x2510F800, creation 0x2510F890, execution 0x2510F920
//   Materials.dll              Movie Player declaration 0x25504480, creation 0x25504510, execution 0x25504630
// plus the CK2.dll / CK2_3D.dll / AVIReader.dll calls they reach:
//   CKTexture::LoadMovie              CK2_3D 0x10079257 (vtbl +0x5C; LoadImage is +0x58)
//   CKBitmapData::LoadMovieFile       CK2    0x2402FA0A  (CreateMovieInfo 0x2402FABA, CreateImage 0x2402FF59)
//   CKBitmapData::GetSlotCount        CK2    0x240302CB  (a movie answers its reader's frame count)
//   CKBitmapData::SetCurrentSlot      CK2    0x24030462  (a movie decodes the frame on demand)
//   AVIReader.dll CKMovieReader       open 0x24741400, frame count = AVIStreamLength, ReadFrame 0x247414C0
//
// Neither block knows a frame rate. Movie Load only opens the file; Movie Player spreads the
// texture's slots (a movie's frames) evenly over its Duration parameter, so the AVI's own
// 25 fps / 5 s only matter through the frame count.
//
// Texture state written here (OriginalObject.state, by CK member; extends original-graph-material.ts):
//   movie        CKBitmapData::m_MovieInfo { file, frames, width, height, current } (current = CKMovieInfo+0xC,
//                -1 after load until SetCurrentSlot(0) runs)
//   slotCount    the plain slot vector's size (Texture Load); a movie texture answers `movie.frames` instead
//   currentSlot  CKBitmapData::m_CurrentSlot (+0x18), the non-movie path of SetCurrentSlot
//   width/height the slot-0 image CreateImage(w, h, 32) allocated for the movie
//   bitmapDirty  CKBitmapData flag 4 (the renderer re-uploads)
import type { BehaviorContext, BehaviorFn, BehaviorRegistry } from './original-graph.ts'
import type { GraphContextBinding } from './original-graph-bindings.ts'
import { CKCID } from './original-context.ts'

const f = Math.fround

/** What AVIReader's open reports (CKMovieProperties: width reader+0x1C, height +0x20, AVIStreamLength frames). */
export interface GraphMovieInfo {
  /** `AVIStreamLength`: what `CKBitmapData::GetSlotCount` answers for a movie. */
  frames: number
  width: number
  height: number
  /**
   * Informational only (avih dwMicroSecPerFrame / 1000): no block reads it, Movie Player
   * divides its Duration by the frame count instead.
   */
  framePeriodMs?: number
}

/**
 * The host side of CKMovieReader. It owns the decoder (AVIReader uses VfW
 * AVIStreamGetFrame, so the host needs a decoder for the file's codec: the intro's
 * atari.avi is Microsoft Video 1 'CRAM', 16 bpp) and the texture's slot-0 image.
 */
export interface GraphMovieBinding {
  /**
   * `CKMovieReader::OpenFile` + the properties call: the movie's size and frame count, or undefined
   * when the file cannot be opened or decoded (LoadMovieFile fails). Replaces the texture's previous
   * movie, if any, and (re)creates its 32 bpp slot-0 image at the movie's size.
   */
  open(texture: string, file: string): GraphMovieInfo | undefined
  /**
   * `CKMovieReader::ReadFrame(frame)` and the blit into slot 0 (CKBitmapData::SetCurrentSlot on a movie).
   * False when the reader refuses (frame >= frame count) and nothing is written.
   */
  showFrame(texture: string, frame: number): boolean
  /** `CKMovieInfo` destruction (the reader is released); called before every LoadMovieFile and on destroy. */
  close(texture: string): void
}

/** The context binding, which carries the host's movie reader. */
type GraphMovieLoader = GraphContextBinding

export interface MovieState {
  file: string
  frames: number
  width: number
  height: number
  /** CKMovieInfo+0xC: the frame last requested; -1 until SetCurrentSlot. */
  current: number
}

interface TextureTarget { loader: GraphMovieLoader; ref: string; state: Record<string, unknown> }

function binding(context: BehaviorContext, label: string): GraphMovieLoader {
  const loader = context.loader
  if (!loader) throw new Error(`${label} ${context.node.index} needs the CK object context`)
  return loader
}

/** The behavior's CKTexture target; undefined for a NULL target (the DLL's owner error). */
function target(context: BehaviorContext, label: string): TextureTarget | undefined {
  const loader = binding(context, label)
  const ref = context.targetName()
  if (!ref || !loader.has(ref)) return undefined
  const classId = loader.classId(ref)
  if (classId !== CKCID.TEXTURE) throw new Error(`${label} ${context.node.index} targets ${loader.objectName(ref)} (class ${classId}), not a texture`)
  return { loader, ref, state: loader.state(ref) }
}

/** `CKBehavior::GetInputParameterValue(slot)` returning CK_OK: the pin exists and holds a value. */
function pin(context: BehaviorContext, slot: number): number | boolean | string | undefined {
  if (slot >= context.inputCount) return undefined
  const value = context.input(slot)
  return value === null || value === undefined || typeof value === 'object' ? undefined : value
}

/** `CKBitmapData::GetSlotCount`: the reader's frame count for a movie, else the slot vector's size. */
export function bitmapSlotCount(state: Record<string, unknown>): number {
  const movie = state.movie as MovieState | undefined
  return movie ? movie.frames : Number(state.slotCount ?? 0)
}

/**
 * `CKBitmapData::SetCurrentSlot` (CK2 0x24030462). A movie compares against CKMovieInfo+0xC, stores the
 * request BEFORE asking the reader (so a refused frame still counts as current) and returns the reader's
 * verdict; a plain bitmap ignores slots past the vector and flags the bitmap dirty when the slot changes.
 */
export function bitmapSetCurrentSlot(loader: GraphMovieLoader, ref: string, state: Record<string, unknown>, slot: number): boolean {
  const movie = state.movie as MovieState | undefined
  if (movie) {
    if (slot === movie.current) return true
    movie.current = slot
    if (!loader.movie) throw new Error(`texture ${ref} holds a movie but the host has no movie binding`)
    return loader.movie.showFrame(ref, slot)
  }
  if (slot < 0 || slot >= Number(state.slotCount ?? 0)) return false
  if (slot !== Number(state.currentSlot ?? 0)) { state.currentSlot = slot; state.bitmapDirty = true }
  return true
}

/**
 * Addons1.dll `Movie Load` (execution 0x2510F920; In "On", Out "Loaded"/"Error", input "Movie File",
 * no output parameter; class 31). A NULL target fires Error without consuming In (owner error 0xA008).
 * Otherwise In is off, the file name (a NULL pointer reads as "") goes through
 * CKTexture::LoadMovie, which resolves it on the DATA path (category 0) and calls
 * CKBitmapData::LoadMovieFile: the old movie is released, the file is opened by the movie reader plugin
 * matching its extension, the texture's slot-0 image is created at the movie's size (32 bpp) and frame 0
 * is shown. A failure prints "Movie can not be loaded, make sure movie CODEC is installed and movie
 * format is RGB" to the dev console and fires Error; success fires Loaded. Both return CKBR_OK.
 * SetOutputParameterObject(0, texture) after success has no pin to write on this prototype.
 */
export const movieLoad: BehaviorFn = context => {
  const texture = target(context, 'Movie Load')
  if (!texture) { context.activate(1); return }
  if (context.node.outputs?.length) throw new Error(`Movie Load ${context.node.index} has an output parameter the DLL would write`)
  context.consumeInput(0)
  const { loader, ref, state } = texture
  const file = String(pin(context, 0) ?? '')
  const reader = loader.movie
  if (!reader) throw new Error(`Movie Load ${context.node.index} needs the host movie binding`)
  // LoadMovieFile releases the previous CKMovieInfo before anything can fail.
  if (state.movie) reader.close(ref)
  delete state.movie
  const resolved = file === '' ? undefined : loader.resolveFile(file, 'data')
  const info = resolved === undefined ? undefined : reader.open(ref, resolved)
  if (!info) {
    context.system?.console('Movie can not be loaded, make sure movie CODEC is installed and movie format is RGB', true)
    context.activate(1)
    return
  }
  const movie: MovieState = { file: resolved!, frames: info.frames, width: info.width, height: info.height, current: -1 }
  state.movie = movie
  state.width = info.width
  state.height = info.height
  state.bitmapDirty = true
  bitmapSetCurrentSlot(loader, ref, state, 0)
  context.activate(0)
}

/**
 * Materials.dll `Movie Player` (execution 0x25504630; In "On"/"Off", Out "Synchro Out"/"One Loop Played";
 * Duration (Time, default 5000), Loop (bool, default TRUE), Starting Slot, Ending Slot (int, default 0);
 * output "Current Slot" (int); one unnamed float local = the elapsed time; class 31). It plays the
 * texture's SLOTS, so it works on a movie (slots = frames) and on a still image (one slot).
 *
 * Per run, in the DLL's order:
 *  1. Off active: Off is consumed, nothing else (CKBR_OK).
 *  2. A NULL target is an owner error (0xA004). Duration == 0 or no slots: return, nothing consumed.
 *  3. start/end are clamped to [0, count-1]; a value past count-1 becomes `count` (the DLL stores the
 *     count, not count-1). n = count when both are 0, else |end - start|. rate = n / Duration (float).
 *  4. On active: On is consumed, elapsed = 0 and the previous slot index is -1; otherwise
 *     previous = trunc(elapsed * rate) and elapsed += DeltaTime (milliseconds, CKBehaviorContext+4).
 *  5. elapsed >= Duration: "One Loop Played" fires; Loop FALSE ends the block (CKBR_OK, the local and
 *     the slot are left as they were); otherwise Duration is subtracted until elapsed < Duration.
 *  6. The elapsed time is stored; index = trunc(elapsed * rate). When it differs from the previous
 *     index the slot is start - index - 1 (start > end) or start + index, SetCurrentSlot runs,
 *     "Current Slot" is written and "Synchro Out" fires.
 *  7. The block stays active (CKBR_ACTIVATENEXTFRAME).
 * Time stays float32 where the DLL stores it (the local, the rate) and extended precision where it
 * stays on the x87 stack (the sum compared against Duration, the subtraction loop).
 */
export const moviePlayer: BehaviorFn = context => {
  if (context.isInputActive(1)) { context.consumeInput(1); return }
  const texture = target(context, 'Movie Player')
  if (!texture) return
  const { loader, ref, state } = texture
  const duration = f(Number(pin(context, 0) ?? 5000))
  if (duration === 0) return
  if (duration < 0) throw new Error(`Movie Player ${context.node.index} has a negative Duration; the DLL's wrap loop would never end`)
  const count = bitmapSlotCount(state)
  if (count === 0) return
  const clampSlot = (value: number) => {
    const slot = value | 0
    return slot < 0 ? 0 : slot > count - 1 ? count : slot
  }
  const start = clampSlot(Number(pin(context, 2) ?? 0))
  const end = clampSlot(Number(pin(context, 3) ?? 0))
  const span = start === 0 && end === 0 ? count : Math.abs(end - start)
  const rate = f(span / duration)

  let elapsed: number
  let previous: number
  let total: number
  if (context.isInputActive(0)) {
    context.consumeInput(0)
    elapsed = 0
    previous = -1
    total = 0
  } else {
    elapsed = f(Number(context.local(0) ?? 0))
    previous = Math.trunc(elapsed * rate)
    total = elapsed + context.deltaMs
    elapsed = f(total)
  }
  if (!(total < duration)) {
    context.activate(1)
    const loop = pin(context, 1) === undefined ? 1 : (Number(pin(context, 1)) | 0)
    if (loop === 0) return
    let x = elapsed - duration
    while (!(x < duration)) x -= duration
    elapsed = f(x)
  }
  context.setLocal(0, elapsed)
  const index = Math.trunc(elapsed * rate)
  if (index !== previous) {
    const slot = start > end ? start - index - 1 : start + index
    bitmapSetCurrentSlot(loader, ref, state, slot)
    context.setOutput(0, slot)
    context.activate(0)
  }
  context.wait()
}

export const MOVIE_BEHAVIORS: BehaviorRegistry = {
  'Movie Load': movieLoad,
  'Movie Player': moviePlayer,
}

