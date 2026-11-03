# Leia SR presenter

The `leia-sr` launch mode hands the game's full side-by-side pair to a small
native presenter, which either asks the Leia SR runtime to weave it for the
panel or shows the raw pair when the runtime is unavailable. The browser build
never offers the mode.

The architecture, the wire formats and the traps are ported from the
maintainer's Starwing LeiaSR presenter (see `Leia-SR-Implementation.md`); this
page records what applies to Ballance.

## Architecture

```
offscreen game window (2*W x H)
  -> compositor paint image (BGRA, DOM + WebGL)
  -> electron/leia/capture.cjs        newest frame only
  -> electron/leia/transport.cjs      one frame in flight, drops stale paints
  -> \\.\pipe\ballance_leia_frames    frame header + BGRA payload or GPU handle
  -> BallanceLeiaPresenter.exe        DX12 + SR-lib weaver
       -> weave into an app-owned panel-extent texture, or
       -> plain side-by-side fallback
  <- \\.\pipe\ballance_leia_ack       magic + frameId
  <- \\.\pipe\ballance_leia_input     keyboard messages and control messages
```

On Electron 33+ the shell first asks the presenter (through its stdout
capability line) whether it understands GPU shared textures. When it does, the
offscreen window is created with `offscreen.useSharedTexture`, each paint
carries an `OffscreenSharedTexture`, and only the NT handle travels through the
frame pipe. The presenter duplicates that handle from the Electron process and
samples the D3D12 texture directly, so the 3840x1080 pair is never copied to
the CPU or through the pipe. The helper acks after it has opened the texture,
and the main process then calls Electron's `release()`; the opened resource
stays alive until its GPU work has finished. Without shared support (Electron
31-32, an old helper, or `--leia-pixel`) the original BGRA paint-bitmap path is
used. If the helper cannot open a shared texture (for example Chromium and the
presenter picked different GPU adapters), it sends a control message and the
shell recreates the offscreen window with the CPU-bitmap path.

Main owns the helper lifecycle. The helper is resolved from
`process.resourcesPath/leia/BallanceLeiaPresenter.exe` first, then
`tools/leia-presenter/BallanceLeiaPresenter.exe`. A missing exe is not an
error dialog: the status window names the path and suggests
`npm run leia:build`.

The helper is started with `--monitor N` (from `shell.json`'s `leiaMonitor`,
default 0) and `--weave-size WxH` (the shell's resolved weave size). Extra
development flags can be appended with
`--leia-helper-args "<args>"` or `BALLANCE_LEIA_HELPER_ARGS`.

A helper that exits unexpectedly is restarted after one second, at most three
times. Exit code 2 means the D3D12 device was removed (the SR display-mode
switch can do that) and is restarted the same way. Exit code 3 means the user
closed the presenter window (Alt+F4); that returns the app to normal mode
instead of restarting. Once the restart budget is spent the status window
shows the last helper output as the error.

## Pipe formats

All integers are little-endian.

Frame, main to helper on `\\.\pipe\ballance_leia_frames`:

| field | type |
|---|---|
| magic | u32 `0x4149454c` ("LEIA") |
| frameId | u32 |
| width | u32 |
| height | u32 |
| format | u32, 1 = BGRA8 payload, 2 = GPU shared texture |
| payloadBytes | u32, `width * height * 4` for format 1, 24 for format 2 |

Format 1 payload is the BGRA paint bitmap (Electron's offscreen bitmap is BGRA
on Windows; the presenter uploads it into a B8G8R8A8 texture with no swizzle).
Format 2 payload:

| field | type |
|---|---|
| sourcePid | u32, the Electron main process |
| pixelFormat | u32, 1 = BGRA8, 2 = RGBA8 |
| flags | u32, bit 0 = probe only (open and release, do not present) |
| reserved | u32 |
| handle | u64, the Windows NT handle value |

Ack, helper to main on `\\.\pipe\ballance_leia_ack`: magic u32, frameId u32.

Input, helper to main on `\\.\pipe\ballance_leia_input`:

| field | type |
|---|---|
| magic | u32 `0x59454b42` ("BKEY") |
| kind | u32, 1 = key, 2 = control |
| vkCode | u32, Windows virtual-key code (kind 2: control code) |
| scanCode | u32, `(lParam >> 16) & 0xffff` (kind 2: frameId) |
| flags | u32 |

Input flags: bit 0 key up, bit 1 repeat, bit 2 extended, bit 3 shift,
bit 4 control, bit 5 alt, bit 6 caps lock. Control code 2 means the shared
texture could not be opened; the shell then restarts the offscreen window with
CPU bitmaps.

Main maps the virtual key to an Electron key name (`ArrowDown`, `Enter`,
`A`, `F1`, `num0`, punctuation, ...), sends `keyDown`, a `char` event for a
printable character with the current Shift/CapsLock state, then `keyUp` with
`webContents.sendInputEvent`. Mouse input is not forwarded.

## Presenter flags

- `--monitor N` - 0-based display index (default 0).
- `--weave-size WxH` - panel/output extent override; otherwise the monitor's
  current display mode is used.
- `--windowed` - keep the 1280x720 window instead of borderless fullscreen.
  Without it the presenter is fullscreen on the chosen monitor even when SR is
  unavailable.
- `--offscreen` - park the window outside the desktop for headless tests.
- `--self-test` - run the compose/weave-target/BMP self-test and exit; no
  pipes are opened.
- `--capture-dir D` / `--capture-frames N` - write `presented.bmp` (the frame
  about to be displayed) and `compose.bmp` (the full-SbS weaver input) for the
  first N presented frames.
- `BALLANCE_LEIA_DEBUG=1` - enable the D3D12 debug layer when the Windows
  Graphics Tools feature is installed.

Build with `npm run leia:build` (MSVC 2022 Build Tools via vswhere/vcvars64).
SR support is compiled in when `BALLANCE_SR_LIB_ROOT` (default
`.local/reference/sr-lib`) contains `SR.cpp`/`SR.hpp` and an `SR-SDK-*`
checkout. The exe is always produced; without the SDK it only has the raw-SbS
fallback.

## Focus fix

The original presenter window used `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` and
was never the active window. A tester saw the SR panel switch to 3D and drop
back to plain SBS, with Alt+Tab re-triggering it; the likely cause is that the
SR runtime engages the lens for the active window. Ballance's presenter is a
normal activatable `WS_POPUP` window with no exclusions, shows itself with
`SetForegroundWindow`/`SetActiveWindow`/`SetFocus` on startup and on a left
click, and goes fullscreen (or uses the `--weave-size` extent) without
`SWP_NOACTIVATE`. The lens hint/weaver behaviour is unchanged.

## Gotchas kept from the reference

1. Never weave into a swap-chain buffer: the weave goes into an app-owned
   panel-extent texture that is then blitted.
2. The weaver input/output are B8G8R8A8; the compose texture and weave target
   use that format.
3. Weave/output extents are forced even.
4. One plain frame is presented after a weave target is created or resized.
5. `SetShaderSRGBConversion(false, false)` avoids double gamma.
6. `SetInputTexture` is called every woven frame.
7. Every SR/OpenCV DLL is a delay-load import, so a machine without the SR
   Platform does not get a missing-DLL popup. Check with
   `dumpbin /imports tools/leia-presenter/BallanceLeiaPresenter.exe`: the SR
   DLLs appear only under "delay load imports".
8. A failed SR probe is latched off once; it is never retried per frame.
9. A failed weave presents the plain pair in the same command list and latches
   the weaver off instead of blanking the window.
10. `Delete()` exceptions during teardown are swallowed.
11. Full-resolution per-eye views are composed in the page; the presenter does
    not squeeze or upscale them.

## Testing without SR hardware

This machine has no SR panel or platform. The expected log is one probe
failure followed by the fallback:

```
ballance: leia presenter: LeiaSR unavailable (hr 0x80004002); presenting plain side-by-side
ballance: leia presenter: shared texture received id=... 3840x1080 pid=...
ballance: leia presenter: frame presented id=... (shared)
```

The shared path is active when the log says `ballance: leia shared texture
mode` and `paint fps` shows about 60 acks per second (the CPU path is around
6-20 acks/s at 3840x1080). `--leia-pixel` (or `BALLANCE_LEIA_PIXEL=1`) forces
the CPU path for comparison. `BALLANCE_LEIA_REJECT_SHARED_TEXTURE=1` on the
presenter process rejects the first shared texture and exercises the shell's
CPU-bitmap restart fallback without needing a second GPU adapter.

Run the shell with `--leia --user-data-dir <scratch>` and the helper in
`--windowed` mode with a capture folder:

```
npx electron . --leia --user-data-dir .local/reference/session-tools/67-userdata
  --leia-helper-args "--windowed --capture-dir .local/reference/session-tools/67-capture --capture-frames 3"
```

`presented.bmp` is the raw pair exactly as shown; `compose.bmp` is the
full-SbS input the weaver would consume. Both contain the menu pair. With SR
hardware the same files are the post-weave panel image and the weaver input.
Use a larger `--capture-frames` to keep a later frame after sending a key to
the presenter window.

The native `--self-test` also runs without hardware and checks the
half-SbS stretch, full-SbS 1:1 mapping, BGRA weave target and present blit:

```
tools/leia-presenter/BallanceLeiaPresenter.exe --self-test --windowed
```

## UNVERIFIED without SR hardware

- That the SR runtime engages the lens for the focused presenter window and
  keeps it engaged (the focus fix's actual purpose).
- That the weave output lands 1:1 on panel pixels, including the panel's
  current display mode and the `--weave-size` override.
- Gamma, lens alignment, head-tracked parallax and the lens hand-back on exit.
- The device-loss restart path after an SR display-mode switch.

All of that needs a panel owner running `docs/leia-sr.md` plus the
`--capture-dir` evidence.
