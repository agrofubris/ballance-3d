// Dx5InputManager.dll's CKInputManager as the menu blocks read it, decoded
// from the shipped DLL: the per-frame keyboard event buffer with keyboard
// repetition (PreProcess 0x24AC1C30, PostProcess 0x24AC1E30), the mouse
// button bytes (poll 0x24AC2910) and the cursor visibility. A host queues the
// device events it receives; the session runs PreProcess before the scripts
// and PostProcess after them.

/** One DIDEVICEOBJECTDATA of the keyboard buffer: a DIK scan code, pressed (data bit 7) or released, its time in ms. */
export interface GraphKeyEvent { key: number; pressed: boolean; time: number }

/** CKInputManager (GUID F787C904:0) as the behaviors use it; hosts provide it as `system.input`. */
export interface GraphInputManager {
  /** The manager's PreProcess (before the behaviors), at the system time in ms. */
  preProcess(now: number): void
  /** The manager's PostProcess (after the frame). */
  postProcess(): void
  /** GetNumberOfKeyInBuffer / GetKeyFromBuffer (vtbl +0x9C / +0xA0): this frame's events, repeats included. */
  keyBuffer(): readonly GraphKeyEvent[]
  /** IsKeyDown (vtbl +0x80): held, and still on the frame its release is read. */
  isKeyDown(key: number): boolean
  /** EnableKeyboardRepetition (vtbl +0x78). */
  enableKeyboardRepetition(enable: boolean): void
  /**
   * VxScanCodeToAscii (VxMath.dll 0x24284D20): the byte the keyboard layout
   * gives the key with the current modifiers (MapVirtualKey + ToAscii); 0 for none.
   */
  scanCodeToAscii(key: number): number
  /** IsMouseButtonDown (vtbl +0xA4): bit 0 of the button byte. */
  mouseButtonDown(button: number): boolean
  /** GetMousePosition(FALSE) (vtbl +0xB4): pixels from the render window's origin, sampled by PreProcess. */
  mousePosition(): [number, number]
  /** GetCursorVisibility (vtbl +0xE4; 1 after construction, ShowCursor sets it). */
  cursorVisible(): boolean
}

/**
 * The manager's state machine over queued device events. Key and mouse
 * button bytes: bit 0 down, bit 1 released this frame (PostProcess zeroes a
 * byte with bit 1, so a release still reads down for its frame).
 */
export class OriginalInputManager implements GraphInputManager {
  private readonly keys = new Uint8Array(256)
  private readonly times = new Int32Array(256)
  private readonly buttons = [0, 0, 0, 0]
  private pending: GraphKeyEvent[] = []
  private pendingButtons: { button: number; pressed: boolean }[] = []
  private events: GraphKeyEvent[] = []
  private position: [number, number] = [0, 0]
  private sampled: [number, number] = [0, 0]
  private repetition = false
  private visible = true
  /**
   * The repetition delay and interval come from Windows (250 * (SPI_GETKEYBOARDDELAY + 1) and
   * trunc(1000 / (SPI_GETKEYBOARDSPEED + 2.5)) ms); the defaults are Windows' (delay 1, speed 31).
   */
  private readonly toAscii: (key: number) => number
  readonly delayMs: number
  readonly intervalMs: number
  constructor(toAscii: (key: number) => number, delayMs = 500, intervalMs = 29) {
    this.toAscii = toAscii
    this.delayMs = delayMs
    this.intervalMs = intervalMs
  }

  /** A key event from the device, in arrival order (a host drops the OS's own auto-repeat). */
  key(key: number, pressed: boolean, time: number): void { this.pending.push({ key, pressed, time }) }
  /** A mouse button event (DIMOFS_BUTTON0..3). */
  button(button: number, pressed: boolean): void { this.pendingButtons.push({ button, pressed }) }
  /** The cursor's position relative to the render window. */
  move(x: number, y: number): void { this.position = [x, y] }

  /** PreProcess: this frame's buffer from the queued events, the key and button bytes, the repeats, the cursor sample. */
  preProcess(now: number): void {
    this.events = this.pending.slice(0, 256)
    this.pending = []
    for (const event of this.events) {
      if (event.key > 0xff) continue
      if (event.pressed) { this.keys[event.key]! |= 1; this.times[event.key] = event.time }
      else { this.keys[event.key]! |= 2; this.times[event.key] = event.time - this.times[event.key]! }
    }
    if (this.repetition) {
      for (let key = 0; key < 256; key++) {
        if (this.keys[key] !== 1) continue
        let t = this.times[key]!
        if (t > 0 && (now - t) >>> 0 > this.delayMs) { t = -t; this.times[key] = t }
        if (t >= 0) continue
        let excess = (now + t - this.delayMs) >>> 0
        while (excess > this.intervalMs) {
          t -= this.intervalMs
          this.times[key] = t
          if (this.events.length < 256) this.events.push({ key, pressed: true, time: -t })
          excess -= this.intervalMs
        }
      }
    }
    for (const { button, pressed } of this.pendingButtons) if (button >= 0 && button < 4) this.buttons[button]! |= pressed ? 1 : 2
    this.pendingButtons = []
    this.sampled = [...this.position]
  }

  /** PostProcess: bytes released this frame go back to zero. */
  postProcess(): void {
    for (let i = 0; i < 256; i++) if (this.keys[i]! & 2) this.keys[i] = 0
    for (let i = 0; i < 4; i++) if (this.buttons[i]! & 2) this.buttons[i] = 0
  }

  keyBuffer(): readonly GraphKeyEvent[] { return this.events }
  isKeyDown(key: number): boolean { return key <= 0xff && (this.keys[key]! & 1) !== 0 }
  enableKeyboardRepetition(enable: boolean): void { this.repetition = enable }
  scanCodeToAscii(key: number): number { return this.toAscii(key) }
  mouseButtonDown(button: number): boolean { return (this.buttons[button]! & 1) !== 0 }
  mousePosition(): [number, number] { return [...this.sampled] }
  cursorVisible(): boolean { return this.visible }
  /** ShowCursor (Show Mouse Cursor). */
  showCursor(show: boolean): void { this.visible = show }
}
