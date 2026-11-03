// CK2dEntity state and its pixel <-> homogeneous conversion, decoded from
// CK2_3D.dll (RCK2dEntity) and VxMath.dll (VxRect). The state lives in the
// context object's `state`:
//
// flags (m_Flags after Load's mask), homogeneousRect (m_HomogeneousRect, null
// when not homogeneous), rect (m_Rect in pixels; for a homogeneous entity it
// is derived from the homogeneous rect at render time), sourceRect, zOrder,
// visible. No shipped 2D entity has a parent, so parents are not modelled.
//
// Float model: x87. Every store to a float member is Math.fround; values on
// the FPU stack stay doubles (the runtime FPU control word is UNVERIFIED).

export type Original2dRect = [number, number, number, number]

export interface Original2dState {
  flags: number
  homogeneousRect: Original2dRect | null
  rect: Original2dRect | null
  sourceRect: Original2dRect
  zOrder: number
  visible: boolean
}

/** The render context's viewport: Resize leaves the view rect at (0, 0, width, height). */
export interface Original2dScreen { width: number; height: number }

export const ORIGINAL_2D_FLAGS = { ratioOffset: 0x100, homogeneous: 0x200, updateHomogeneous: 0x800 } as const

const f = Math.fround

/** A saved entity (`entity2d` of the object table) as its state. */
export function original2dFromSaved(saved: { flags: number; rect: number[]; sourceRect: number[]; zOrder: number }, hidden: boolean): Original2dState {
  const homogeneous = (saved.flags & ORIGINAL_2D_FLAGS.homogeneous) !== 0
  const rect = saved.rect.slice(0, 4) as Original2dRect
  return {
    flags: saved.flags, homogeneousRect: homogeneous ? rect : null, rect: homogeneous ? null : rect,
    sourceRect: saved.sourceRect.slice(0, 4) as Original2dRect, zOrder: saved.zOrder, visible: !hidden,
  }
}

/**
 * RCK2dEntity::GetHomogeneousRelativeRect (0x1005FD06) without a parent: the
 * view rect (ratio offset) or the window rect, translated to the origin
 * (VxRect::Translate, float stores). Both are (0, 0, width, height) here.
 */
function relativeRect(state: Original2dState, screen: Original2dScreen): Original2dRect {
  const r: Original2dRect = state.flags & ORIGINAL_2D_FLAGS.ratioOffset
    ? [0, 0, f(0 + screen.width), f(0 + screen.height)]
    : [0, 0, screen.width, screen.height]
  const dx = f(-r[0]), dy = f(-r[1])
  return [f(r[0] + dx), f(r[1] + dy), f(r[2] + dx), f(r[3] + dy)]
}

/** VxRect::TransformFromHomogeneous (VxMath 0x2429D8E0): right uses the unrounded width, bottom the stored height. */
function fromHomogeneous(rect: Original2dRect, rel: Original2dRect): Original2dRect {
  const W = rel[2] - rel[0], H = rel[3] - rel[1]
  const wt = rect[2] - rect[0], ht = f(rect[3] - rect[1])
  const left = f(W * rect[0] + rel[0]), top = f(H * rect[1] + rel[1])
  return [left, top, f(wt * W + left), f(ht * H + top)]
}

/** VxRect::TransformToHomogeneous (VxMath 0x2429D880): by 1/width and 1/height of `rel`. */
function toHomogeneous(rect: Original2dRect, rel: Original2dRect): Original2dRect {
  const invW = 1 / (rel[2] - rel[0]), invH = 1 / (rel[3] - rel[1])
  const wt = rect[2] - rect[0], ht = f(rect[3] - rect[1])
  const left = f((rect[0] - rel[0]) * invW), top = f((rect[1] - rel[1]) * invH)
  return [left, top, f(wt * invW + left), f(ht * invH + top)]
}

function homogeneousRect(state: Original2dState, call: string): Original2dRect {
  if (!(state.flags & ORIGINAL_2D_FLAGS.homogeneous) || !state.homogeneousRect) {
    throw new Error(`${call} on a non-homogeneous 2D entity (CKERR_INVALIDPARAMETER)`)
  }
  return state.homogeneousRect
}

/** GetPosition(&pos, hom = TRUE, NULL) (0x1005D369). */
export function original2dHomogeneousPosition(state: Original2dState): [number, number] {
  const rect = homogeneousRect(state, 'GetPosition(hom)')
  return [rect[0], rect[1]]
}

/** GetSize(&size, hom = TRUE) (0x1005D54A): float stores of right - left, bottom - top. */
export function original2dHomogeneousSize(state: Original2dState): [number, number] {
  const rect = homogeneousRect(state, 'GetSize(hom)')
  return [f(rect[2] - rect[0]), f(rect[3] - rect[1])]
}

/** SetHomogeneousCoordinates(on) (0x1005DBA1); every shipped entity is already homogeneous. */
export function original2dSetHomogeneousCoordinates(state: Original2dState, on: boolean, screen: Original2dScreen): void {
  const homogeneous = (state.flags & ORIGINAL_2D_FLAGS.homogeneous) !== 0
  if (on === homogeneous) return
  const rel = relativeRect(state, screen)
  if (on) {
    state.flags |= ORIGINAL_2D_FLAGS.homogeneous | ORIGINAL_2D_FLAGS.updateHomogeneous
    state.homogeneousRect = toHomogeneous(state.rect!, rel)
  } else {
    state.flags &= ~ORIGINAL_2D_FLAGS.homogeneous
    state.rect = fromHomogeneous(state.homogeneousRect!, rel)
    state.homogeneousRect = null
  }
}

/**
 * SetHomogeneousRect(rect, KeepChildren) (0x1005DA43): the rect converted from
 * homogeneous goes through SetRect (0x1005D6B9), which converts it back into
 * the homogeneous rect, so the stored values are a float round trip.
 */
export function original2dSetHomogeneousRect(state: Original2dState, rect: Original2dRect, screen: Original2dScreen): void {
  homogeneousRect(state, 'SetHomogeneousRect')
  const rel = relativeRect(state, screen)
  const pixels = fromHomogeneous(rect, rel)
  state.homogeneousRect = toHomogeneous(pixels, rel)
  state.rect = pixels
}

/** The render-time refresh (UpdateExtents 0x1005CCE5): a homogeneous entity's pixel rect. */
export function original2dUpdateExtents(state: Original2dState, screen: Original2dScreen): void {
  if (!(state.flags & ORIGINAL_2D_FLAGS.homogeneous)) return
  const rel = relativeRect(state, screen)
  if (state.flags & ORIGINAL_2D_FLAGS.updateHomogeneous) {
    state.flags &= ~ORIGINAL_2D_FLAGS.updateHomogeneous
    state.homogeneousRect = toHomogeneous(state.rect!, rel)
  } else {
    state.rect = fromHomogeneous(state.homogeneousRect!, rel)
  }
}
