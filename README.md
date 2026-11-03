# Ballance 3D Stereo

A faithful port of Ballance (Cyparade, 2004) to a Windows desktop app and the browser,
with stereo 3D output. It does not re-create the game by hand: it reads the original
level and script documents from **your own installed copy** and runs their authored
Virtools behaviour graphs on a generic graph runtime.

**No game files are included.** You bring your own legally acquired copy; the importer
converts it on your machine and nothing is uploaded.

## Features

- All twelve levels, menus, tutorial, HUD, music and sound from the original documents.
- Stereo 3D: side-by-side (half and full), cross-view, top-and-bottom (half and full),
  row-interlaced (both eye orders), and Leia SR lenticular displays (needs Leia's SR
  Platform; without it the mode falls back to side-by-side). The 2D
  interface is drawn in both eyes with adjustable depth.
- Widescreen modes, resolution choice, fullscreen.
- Keyboard and gamepad, with rebinding and optional analog steering.

## Play on Windows (release zip)

1. Install Ballance from your own disc or ISO (for example to `C:\Games\Ballance`).
2. Download the latest `Ballance-3D-Stereo-*.zip` from the Releases page and unzip it.
3. Run `Ballance.exe`. On first start it asks for your Ballance folder and imports it
   (a few minutes). The converted pack is stored in the app's user-data folder.

The release runs on the built-in **Rapier** physics. For the original physics, see
[Exact IVP physics](#exact-ivp-physics-optional) below.

## Play from source

1. Clone this repository and run `Setup-Ballance.bat`. It downloads pinned portable
   tools into `.tools/`, asks for your Ballance folder, converts it into
   `.local/original/`, offers the optional IVP build, and opens the game in your
   browser.
2. Later, `Launch-Ballance.bat` starts the local server (`http://127.0.0.1:5173/`) and
   `Stop-Ballance.bat` stops it. `npm run app` runs the desktop app from the checkout.

See [docs/original-import.md](docs/original-import.md) for what the importer reads and
writes.

## Physics

The original game used IVP (Ipion Virtual Physics) through Virtools. The IVP source has
no licence, so it is not included and no build of it is distributed. Without it the
game runs on Rapier, and the main menu says so. Rapier matches the original closely on
rolling and slopes; moving platforms and joints differ somewhat
([docs/known-fidelity-gaps.md](docs/known-fidelity-gaps.md)).

### Exact IVP physics (optional)

You can build the IVP module yourself from its public source. You need Windows 10 or 11,
an internet connection and 10-20 minutes:

1. Get this repository (clone it, or download the source zip from the same release).
2. Run `Build-IVP.bat`. It downloads the pinned IVP source
   ([doyaGu/ivp](https://github.com/doyaGu/ivp)), Emscripten, CMake, Git and Python into
   the repository folder only, and builds `.local\ivp-simulation\`.
3. To use it in the release app, run `Build-IVP.bat "C:\path\to\Ballance-3D-Stereo"`
   (the unzipped release folder) instead, or copy `ivp-simulation.mjs` and
   `ivp-simulation.wasm` into that folder's `resources\app\.local\ivp-simulation\`.
   Restart the app; the physics notice disappears.

From source, `Setup-Ballance.bat` offers the same build, and `npm run build` bundles the
module when it is present. Keep the built files to yourself. Details:
[docs/original-ivp-wasm.md](docs/original-ivp-wasm.md).

## Controls

- **Arrow keys** roll the ball. **Shift + Left/Right** turns the camera. **Space** lifts
  the camera. **Escape** pauses or goes back. **Enter** selects; **Q** quits the tutorial.
- **Gamepad:** left stick or D-pad rolls, A selects, B goes back, X quits the tutorial,
  LB/RB turn the camera, Start pauses.
- Everything can be rebound in Options. Stereo settings are in Options → 3D Stereo.

## Development

```sh
npm install
npm run dev            # Vite dev server
npm run build          # production build; bundles IVP when .local/ivp-simulation exists
npm run build:rapier   # build without IVP (optional module at run time)
npm run lint
npm run harness -- --list   # dual-solver gameplay harness, see docs/harness.md
```

The behaviour graph runtime is described in
[docs/original-graph-runtime.md](docs/original-graph-runtime.md), the desktop shell in
[docs/electron.md](docs/electron.md) and Leia SR in [docs/leia-sr.md](docs/leia-sr.md).
The maintainer test suite is kept locally; in a public checkout `npm test` only prints a
notice.

## Credits and legal

This project's own code is released under the [MIT licence](LICENSE): fork it and
change it freely.

Ballance was made by Cyparade and published by Atari. Use your own legally acquired copy
and do not share converted game data or built IVP files. The idea of a stereo 3D port
came from [fayazara/ballance](https://github.com/fayazara/ballance) by Fayaz Ahmed.
Third-party code, references and credits are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
