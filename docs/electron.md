# Electron shell

The desktop shell runs the ordinary production build (`npm run build` writes
`dist/client/`) in an Electron 39.8.10 window. It ships no game data: the player's
own prepared pack is loaded from a folder outside the app (bring your own game
files, BYOGF). Packaging and licence notes for tester builds are in
[tester-build.md](tester-build.md).

## Running

```
npm run app
```

This builds the game and starts Electron. The first run expects a prepared pack
at `.local/original` when launched from the repository. If the resolved pack
(see below) has no `data-arrays.json`, the shell opens the **Ballance setup**
importer window instead. It can convert the player's installed game into a pack
or point at an existing prepared folder; closing it quits, because the game
cannot start without a pack.

Override the locations with:

```
npm run app -- --pack <dir> --ivp <dir>
npx electron . --pack <dir> --ivp <dir>
```

Precedence is command line, then the value remembered in `shell.json`, then the
repository defaults `.local/original` and `.local/ivp-simulation`. The IVP
folder is not picked interactively: if the module is not there, the page gets
the same failed module load as the browser and the game falls back to its
Rapier solver with its normal notice.

## Leia SR mode

`leia-sr` is a launch mode, because an Electron window cannot switch to
offscreen rendering live. The 3D Stereo panel lists it after *Full top and
bottom* only in the shell (`window.ballanceShell.leia.available`); the browser
never offers it. Choosing it saves the panel settings, stores `leia: true` in
`shell.json` and relaunches. Choosing any other mode from the panel does the
same with `leia: false`. The page starts directly in `leia-sr` whenever the
shell launched the pair, regardless of the saved default-enable flag; a saved
`leia-sr` read without the pair (the browser or a normal shell window) falls
back to Off.

The launch flags are:

```
npx electron . --leia [--weave-size 1920x1080] [--leia-dump <dir>]
  [--leia-helper-args "--windowed --capture-dir <dir> --capture-frames 3"]
```

- `--leia` forces the mode for this run (it is also remembered in
  `shell.json`).
- `--weave-size WxH` is the panel's per-eye weave size; precedence is the
  flag, then `shell.json`'s `weaveSize`, then the Acer SpatialLabs 27 default
  1920x1080.
- `--leia-dump <dir>` is a debug capture aid for the CPU-bitmap path. It writes
  every 60th composited frame as a 32-bit BMP and logs the measured paint fps
  once per second.
- `--leia-helper-args "<args>"` appends presenter flags for development and
  testing (for example `--windowed`, `--capture-dir <dir>` or
  `--capture-frames N`). `BALLANCE_LEIA_HELPER_ARGS` is the environment
  equivalent; the command-line flag wins. Quoted paths are supported.
- `--leia-pixel` (or `BALLANCE_LEIA_PIXEL=1`) keeps the CPU-bitmap paint path
  instead of GPU shared textures.

The presenter's monitor comes from `shell.json`'s `leiaMonitor` (a
non-negative display index, default 0). The shell always passes `--monitor N`
and `--weave-size WxH` to the helper. See [leia-sr.md](leia-sr.md) for the
presenter, pipe and input details.

In Leia mode the game window is created offscreen at `2*W x H` content size
with device scale factor 1, so the page's CSS box is the full eye pair. The
drawing buffer is the window (no doubling), each eye target is half the width
at full height, and the per-eye DOM UI occupies an unscaled half-width slot.
This is the `sbs-full` per-eye layout without the browser scale-down that a
normal window applies.

Electron 39 can hand each compositor paint out as a D3D12 shared texture
instead of a CPU bitmap. The shell starts the presenter first and reads its
`shared-texture=1` capability line from stdout; when Electron is new enough
the offscreen window is created with `offscreen.useSharedTexture`, and only
the handle travels through the frame pipe. The presenter duplicates the NT
handle from the Electron process, opens it on its own D3D12 device and samples
it directly; the main process releases Electron's texture after the helper's
ack. If the helper cannot open the texture (another GPU adapter, an old
driver), it asks for the CPU-bitmap path and the shell recreates the offscreen
window without shared textures, so the pipe fallback is still available. The `paint` image is the compositor output, so it
contains the WebGL scene and the DOM menu/HUD together.

Capture uses `NativeImage.getBitmap()` rather than `toBitmap()`: it returns the
Windows SkBitmap bytes without copying, and on Windows those are BGRA, the byte
order the SR runtime takes. The buffer is copied immediately because it is only
valid in the current event-loop tick; only the newest frame is kept. The BMP
writer is dependency-free and flips Chromium's top-down rows to the BMP's
bottom-up order.

The presenter is a separate native helper (`BallanceLeiaPresenter.exe`,
built with `npm run leia:build`). Main resolves it from
`process.resourcesPath/leia/BallanceLeiaPresenter.exe` first and otherwise
from `tools/leia-presenter/BallanceLeiaPresenter.exe`. It opens a normal,
activatable borderless fullscreen window on the chosen monitor (`--windowed`
keeps a small window), takes the foreground when it starts and when clicked,
and presents the raw side-by-side pair when the SR runtime is unavailable.

A small status window stays open next to the presenter: it shows whether the
presenter is running, whether it is weaving or using the raw side-by-side
fallback, the acknowledged frame rate, and the last error, plus **Return to
normal mode** (Escape also works). If the exe is missing it says so and names
the build command. Closing the presenter (Alt+F4) takes the same return path.
Either way the shell stores `leia: false` and relaunches without the stale
`--leia` flag, so a Leia start always has a way back.

The presenter forwards keyboard input to main's ack/input pipe; main injects
it into the offscreen game page with `webContents.sendInputEvent`, so the
focused presenter window can drive the menu and gameplay. Mouse input is not
forwarded.

## Importing the game

When no usable pack is found, the importer window offers:

- **Game folder** — prefilled from the registry on Windows. It looks for
  `TargetDir`, `InstallPath`, `InstallLocation` or `GamePath` under
  `HKLM\SOFTWARE\WOW6432Node\Ballance` and `HKLM\SOFTWARE\Ballance`, then for
  `InstallLocation`, `InstallPath` or `GamePath` in the 32/64-bit uninstall
  keys whose `DisplayName` contains "Ballance" (case-insensitive). The first
  candidate that contains `base.cmo` and `3D Entities` or `3D_Entities` is
  used; otherwise the field starts empty. "Choose game folder" opens a native
  picker, and the same validation is shown live.
- **Import** — runs `scripts/prepare-original.py --no-ffmpeg` as a child
  process with argument arrays only (no shell string). The window shows a
  progress bar and the current phase from the script's
  `STEP <n>/<total> <name>` stdout lines. **Cancel** kills the whole process
  tree. On failure the window stays open with the last 40 log lines and the
  partial pack is deleted, so an incomplete export can never be loaded.
- **Use an existing prepared pack** — the native folder picker for a folder
  that already contains `data-arrays.json`.

The pack is written to `app.getPath('userData')/pack`; the chunk dumps and
scratch files go to `app.getPath('userData')/import-work`, which is removed
after a successful import. The pack path is then saved as `shell.json`'s
`pack` value, exactly like a manually picked pack, and the game window loads.

Tool resolution prefers a packaged tree at
`process.resourcesPath/importer/{python,bmap,dump-chunks.exe,scripts}` when it
exists (packaging is a later brief). A development run falls back to
`.tools/python-3.12.10-embed-amd64/python.exe`,
`vendor/bmap-win-x64/BMap.dll`, `vendor/bmap-win-x64/dump-chunks.exe` and
`scripts/`. A missing tool fails with an error naming it. The importer page is
plain HTML/CSS/JS under `electron/importer/`; its sandboxed preload exposes
only `window.ballanceImporter`, and the page has no Node access.

`npx electron . --remote-debugging-port=9334` exposes the Chromium debugging
endpoint, which is how the shell is smoke-tested over CDP.

## What is served from where

The window loads `app://ballance/`, a privileged custom scheme with `standard`,
`secure`, `supportFetchAPI` and `stream` privileges. It is not `file://`.

- `/` and every other path outside the two prefixes below are served from
  `dist/client/`, the unchanged browser build. Missing files return 404. Paths
  are resolved inside the directory; `..` and malformed escapes are rejected.
- `/original/*` is served from the pack folder chosen above, with the same
  path-escape check and content types as `scripts/local-original-assets.ts`.
- Requests whose base name is `ivp-simulation.mjs` or `ivp-simulation.wasm`
  under `/ivp/` are served from the IVP folder with `text/javascript` and
  `application/wasm`. This covers both the development URL and the hashed
  production module directory. No other `/ivp/` file is exposed.

Every response is sent with `Cache-Control: no-store` so a rebuilt `dist/` is
picked up immediately.

The custom scheme is the same origin on every run, so `localStorage` settings
saved by the game survive app restarts.

## Window and state

The window defaults to 1280x960 and the title "Ballance". Its size, position,
maximized and fullscreen states are remembered; F11 toggles fullscreen. There
is no menu bar. Navigation away from `app://ballance/` is blocked and the page
cannot open new windows.

Choosing a resolution in the Graphics menu resizes the window's content area to
that mode in physical pixels (`window.ballanceShell.setScreenMode(width, height)`,
converted with the display's scale factor and clamped to its work area; the
window is unmaximized and its centre kept). In fullscreen the window keeps its
size and the render-resolution scaling applies instead; the mode is applied to
the window when it leaves fullscreen. A mode as large as the display cannot be
a window, so it switches to fullscreen instead (also at launch, for a stored
mode of that size). The Leia offscreen window ignores the
request. The startup probe does not resize the window. At fractional scale
factors Windows rounds the client area, so nearby requests are tried and the
one the page measures closest to the mode is kept (within one device pixel at
125% and 150%). The chosen mode is stored as `screenMode` in `shell.json` and
re-applied at launch, because restored outer bounds read back a few DIP off at
those scales; dragging the window edge forgets it.

`shell.json` lives in Electron's `userData` directory (`app.getPath('userData')`,
normally `%APPDATA%\ballance\shell.json`) and stores the remembered pack and IVP
folders, the window state, the stereo launch state and weave size, and
`leiaMonitor`.

The game window's preload exposes only:

```js
window.ballanceShell = {
  platform: 'electron',
  version,
  leia: { available: true, active, weaveSize: { width, height } },
  setLeia(on),
}
```

with `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`.
`setLeia` stores the launch mode, flushes the game's saved settings and
relaunches. The importer window has its own preload
(`electron/importer/preload.cjs`) with only the setup calls (`context`,
`chooseGameFolder`, `choosePack`, `start`, `cancel`, progress/failure
listeners), and the Leia status window has
`electron/leia/waiting-preload.cjs` with only the return-to-normal call and a
transport-status listener; neither bridge exposes Node.

## BYOGF

The repository and a packaged app contain no NMO/CMO files, textures, audio,
level data or exported tables. Point `--pack` at the output of
`scripts/prepare-original.py` from your own Ballance install. The optional IVP
WASM module is also local build output (`scripts/build-ivp-simulation.py`), not
something the app ships.
