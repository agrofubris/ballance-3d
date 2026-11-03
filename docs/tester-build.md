# Tester build (E5) prep

The tester build is an unpacked or zipped Electron folder with no game content
(BYOGF): the tester imports their own installation or points at a prepared
pack. This page lists what to build, what to include, how to exercise the Leia
paths without an SR panel, and the licence blockers that must be decided before
any tester zip is uploaded.

## Build

```
npm run build            # normal app; embeds the local IVP WASM
npm run build:rapier     # app without the IVP module (Rapier fallback)
npm run leia:build       # tools/leia-presenter/BallanceLeiaPresenter.exe
npx electron --version   # must be 39.8.10
```

`npm run build:rapier` uses `vite build --mode rapier`; it omits
`dist/client/ivp/` and leaves `VITE_IVP_MODULE_URL` unset, so the game shows
its normal "Approximate physics: IVP unavailable" notice and runs on Rapier.

## Package contents

Include:

- `dist/client/` and `electron/`, with `package.json` and the Electron runtime
  (or the output of the future electron-builder step).
- The importer tools chosen for the throwaway-ffmpeg build: the Windows
  embeddable Python, `vendor/bmap-win-x64`, a built `dump-chunks.exe`, and
  `scripts/`.
- `tools/leia-presenter/BallanceLeiaPresenter.exe` **only** once the SR-lib
  redistribution question below is settled.
- The notices for Electron/Chromium, the Python embeddable (PSF), BMap and the
  other MIT libraries, plus any presenter notices.

Never include:

- `.local/` (packs, references, tests, captures, chunk dumps, oracle files).
- `tests/`, `shareable/`, generated harness scenarios, logs or screenshots.
- Original game files or any converted media from the tester's installation.
- The IVP WASM module unless the licence question below is settled.
- Any SR SDK DLL, import library, header or third-party tree; the presenter
  delay-loads the SR Platform DLLs installed on the tester's machine.

## Leia evidence without an SR panel

The presenter can run windowed and write the frame it displays plus the
full-SbS weave input:

```
npx electron . --leia --leia-helper-args="--windowed --capture-dir <dir> --capture-frames 3"
```

The whole helper argument string must be one value. In PowerShell this also
works and avoids the nested quoting:

```
$env:BALLANCE_LEIA_HELPER_ARGS = "--windowed --capture-dir $dir --capture-frames 3"
npx electron . --leia
```

`presented.bmp` is the raw pair as displayed (3840x1080 with the default weave
size); `compose.bmp` is the 7680x1080 input the weaver would consume. Both are
written before the first three presented frames, so start the app with a pack
that is already imported.

Shared-texture path: the log must contain

```
ballance: leia shared texture mode
ballance: leia painting started (shared texture)
ballance: leia presenter: frame presented id=... (shared)
```

and the once-per-second `paint fps` line should show ~55-60 pipe acks at
3840x1080 (`shared=<n>/0`). `--leia-pixel` (or `BALLANCE_LEIA_PIXEL=1`) forces
the CPU path for comparison. `BALLANCE_LEIA_REJECT_SHARED_TEXTURE=1` in the
presenter environment tests the automatic CPU fallback: the log shows the
control message, a new offscreen window with `shared=false`, and CPU frames.

## Offscreen Gamepad API

When painting starts, the shell logs:

```
ballance: leia Gamepad API present count=N [<id> axes=<n>, ...]
```

The count is the number of connected pads, not the `getGamepads()` array
length. If a pad is connected but the count is zero, check the Windows
controller panel and Steam/DS4 background hooks before blaming the app. The
gamepad dead-zone arming (an axis is ignored until it reports a centred value
once) applies in this page too.

## Licence blockers (decide before the zip)

- **SR-lib / Simulated Reality SDK.** The SR-lib source (`SR.cpp`/`SR.hpp`)
  is MIT per `SR-SDK-1.34.10/License.txt`, while the SDK's `x64/EULA.rtf` calls
  the software a commercial licence and asks to contact `help@leiainc.com`. The
  presenter compiles `SR.cpp` and import-links the SDK delay-load DLLs; the
  SDK files themselves are never copied. Decide whether the compiled presenter
  may ship to testers, or omit it (normal stereo modes still work; Leia mode
  reports the missing helper) until Leia confirms redistribution.
- **IVP WASM.** `.local/tooling/src/ivp` is a fork of `nillerusr/source-physics`
  with no LICENSE file; its `ivp_docs/ivp_manual.rtf` is an evaluation-copy
  manual copyright Ipion Software GmbH. The normal build embeds the module in
  `dist/client/ivp/`. Ship `npm run build:rapier` unless redistribution
  permission is obtained.
- **Importer.** Python embeddable (PSF), BMap/zlib/stb (MIT) and our
  `dump-chunks` source are distributable with notices; the import pipeline is
  ffmpeg-free.

## Tester smoke checklist

0. The executable is unsigned: tell testers about the SmartScreen "More info" >
   "Run anyway" prompt before they launch it.
1. Launch, import or pick a pack, and reach the main menu.
2. Watch the intro: Atari clip and sound, logo/clouds splash, menu.
3. Start Level 1; check the HUD, eyes, pause menu and a camera turn
   (Shift+arrows).
4. Controller: no drift at rest, d-pad, analog steering and camera stick if
   enabled.
5. Graphics: select each resolution up to the native/widescreen size; the
   background fills the window and the 2D art keeps its 4:3 area.
6. Stereo: SBS, cross-view, full SBS, TaB, Full-TaB.
7. Leia (if shipped): focused presenter window, keyboard forwarding, raw-SbS
   fallback with no SR platform, and the capture BMPs.
