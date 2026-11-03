# IVP physics module

## What IVP is here

IVP (Ipion Virtual Physics) is the physics engine the original game used through
Virtools' physics plugin. This project can run the game on IVP through a WebAssembly
module built from the IVP SDK. The module is optional. The game also runs on Rapier,
a built-in solver.

The IVP SDK source is not included in this repository. It has no licence file in the
pinned revision. A player who wants exact IVP physics builds the module locally from
their own copy of the referenced source. The repository contains only the bridge
(`scripts/ivp-simulation-bridge.cpp`) and the build script (`scripts/build-ivp-simulation.py`).

## For players

`Build-IVP.bat` (the same as `Setup-Ballance.bat --ivp`) downloads the pinned tools and
sources below into the repository folder, builds the module into `.local\ivp-simulation\`
and, given the unzipped release folder as its argument, copies `ivp-simulation.mjs` and
`ivp-simulation.wasm` into that folder's `resources\app\.local\ivp-simulation\`. The
release is a Rapier build that asks for that optional module at start-up
(`/ivp/ivp-simulation.mjs`, served by the desktop app from its IVP folder) and falls back
to Rapier when it is missing. `--ivp <folder>` on the command line or `ivp` in the app's
`shell.json` points the app at another folder. A source checkout's `npm run build`
bundles the module instead.

## Requirements

- Python 3.
- CMake.
- Emscripten (emsdk) version 6.0.2. `Setup-Ballance.bat` pins `EMSCRIPTEN_VERSION=6.0.2` and
  `EMSDK_REVISION=5eb0bde7585670252e8ba05e9d361627bffd08b5`.
- Git, for the pinned source checkout.
- A Linux host is assumed by the build script's header patch (see below). WSL Ubuntu is not
  named in the script or in `Setup-Ballance.bat` (unverified). `Setup-Ballance.bat` runs the
  script with the Windows Python and `emsdk.bat`.

The pinned IVP SDK revision is `7579664996e68040dd0158081b04f612e6a2d515`. The build
script refuses any other checkout, and refuses a checkout with local changes.

## Build

Run from the repository root, with the Emscripten environment active (`emcmake`, `em++`,
`emcc` and `cmake` on PATH):

```
python scripts/build-ivp-simulation.py <ivp-source> <output-directory>
```

Example:

```
python scripts/build-ivp-simulation.py ../ivp .local/ivp-simulation
```

`<ivp-source>` is the IVP SDK checkout at the pinned revision. `<output-directory>` is
created if missing. Use `.local/ivp-simulation` so the dev server and production build find
the files.

The script does the following, in order:

1. Checks that `git rev-parse HEAD` in the source equals the pinned revision and that
   `git status --porcelain` is empty.
2. On Linux only: removes a `#pragma interface` block from `ivp_physics/ivp_polygon.hxx` and
   gives `IVP_Polygon` a virtual destructor. The original bytes are restored when the build ends.
3. `wasm-configure`: `emcmake cmake` with `Release`, `IVP_INCLUDE_GEOMPACK=OFF`,
   `IVP_INCLUDE_3DSIMPORT=OFF`, `IVP_INCLUDE_QHULL=ON` and `CMAKE_CXX_FLAGS=-DUNIX -ffp-contract=off`.
   Output: `wasm-build/`.
4. On Linux only: the same header patch is applied to the staged copy under `wasm-build/include/ivp/`.
5. `wasm-compile`: `cmake --build wasm-build -j 8`.
6. `wasm-link`: `em++ -std=c++17 -O2 -DUNIX -DIVP_VERSION_SDK -fno-strict-aliasing -ffp-contract=off`
   on the bridge and the libraries `ivp_compact_builder`, `ivp_controller`, `ivp_physics`,
   `ivp_collision`, `ivp_surface_manager` and `ivp_utility`. Link flags: `-sMODULARIZE=1`,
   `-sEXPORT_ES6=1`, `-sENVIRONMENT=web,node`, `-sALLOW_MEMORY_GROWTH=1`,
   `-sEXPORTED_FUNCTIONS=["_malloc","_free"]`, `-sEXPORTED_RUNTIME_METHODS=["HEAPF64","HEAPU8"]`,
   `-sASSERTIONS=1`. The Emscripten cache is `<output>/emscripten-cache`.
7. Writes `build.json`.

Each step writes its output to a log in the output directory: `wasm-configure.log`,
`wasm-compile.log` and `wasm-link.log`. A failed step stops the script with exit status 1
and the message `<step> failed with exit status N; see <log>`.

Outputs in the output directory:

- `ivp-simulation.mjs`: the ES module loader (default export is the factory).
- `ivp-simulation.wasm`: the WebAssembly binary.
- `build.json`: `revision` (the pinned revision), `source`, `floatingPointContraction: false`
  and `emscripten` (the first line of `emcc --version`).
- `wasm-build/`, `emscripten-cache/`, and the three logs.

`Setup-Ballance.bat` runs the same steps (the `:prepare_ivp` routine). It clones the
pinned IVP source and emsdk, activates emsdk 6.0.2, then runs the script. Its failure
message refers to `.local\ivp-simulation\*-compile.log`; the script writes `wasm-compile.log`
(a mismatch between the batch file and the script).

## How the module is picked up

- Development server: `scripts/local-original-assets.ts` serves `.local/ivp-simulation/`
  at `/ivp/ivp-simulation.mjs` and `/ivp/ivp-simulation.wasm`. Nothing is copied. Vite
  defines `import.meta.env.VITE_IVP_MODULE_URL` as `/ivp/ivp-simulation.mjs`. If the
  file is missing, the middleware returns 404 with `Build the local IVP module first`.
- Production build: `scripts/ivp-assets.ts` reads the two files and `build.json` from
  `.local/ivp-simulation/` when Vite runs the build. It checks that `build.json` has
  `revision` equal to the pinned revision and `floatingPointContraction: false`. It checks
  that the `.wasm` file starts with the WebAssembly magic and version bytes. It then emits both
  files to `ivp/<digest>/` in the client bundle, where `<digest>` is the first 20 hex
  characters of a SHA-256 over the file names and bytes. `VITE_IVP_MODULE_URL` is set to
  `/ivp/<digest>/ivp-simulation.mjs`.
- Missing or mismatched files in a production build: if `build.json` is wrong, the build
  fails with `Build the verified IVP SDK using scripts/build-ivp-simulation.py before building the game`.
  If a file is missing, Node's own `ENOENT` error is raised; there is no custom message
  (unverified: not run).
- Invalid `.wasm` bytes: the build fails with `Invalid IVP WebAssembly binary`.

## Build options

- `npm run build`: the normal build. It embeds the IVP module when the files exist.
- `npm run build:rapier`: runs `vite build --mode rapier`. In that mode `vite.config.ts`
  does not call `ivpAssets`, so the module is not bundled and `VITE_IVP_MODULE_URL` is unset.
- Runtime selection, in `src/game/original-graph-host.ts` (`createSimulation`):
  - `?solver=ivp`: use IVP. If the module cannot be loaded or `VITE_IVP_MODULE_URL` is unset,
    the game fails with an error (no fallback).
  - `?solver=rapier`: use Rapier. IVP is not loaded.
  - No parameter: IVP is tried first and Rapier is the fallback.
  - Any other value throws `Unknown solver <value>; expected ivp or rapier`.
- `Launch-Ballance.bat` opens `?physics=rapier` when `.local\ivp-simulation\ivp-simulation.mjs`
  is missing. The code reads `solver`, not `physics` (see the UNVERIFIED list).

## When the module is missing

If `VITE_IVP_MODULE_URL` is unset, or the module fails to load (for example a 404 in the
dev server), the host logs a warning and creates a Rapier world. The console shows
`Original graph physics backend: Rapier` (`console.info`). The menu then shows the
"Approximate physics: IVP unavailable" notice (`src/ui/original-extra-text.ts`; it is
shown when the backend is `rapier`, `src/ui/OriginalGraphApp.tsx`). The other languages
of that notice are in the same file.

If the bridge ABI is not 7, the constructor throws `Rebuild the IVP module: bridge ABI 7 is required`.

## Bridge API

The bridge is a flat C interface over one IVP environment per module instance. Every
export is `EMSCRIPTEN_KEEPALIVE`. Units, axes and handedness are the IVP SDK's own; the
bridge converts nothing. `src/game/ivp-bridge.ts` wraps each call in the class `IvpWorld`,
which packs descriptors into doubles and checks every return value.

| Function | Purpose |
| --- | --- |
| `ivp_bridge_abi` | Returns the ABI version (`kAbiVersion = 7`). |
| `ivp_new(gravity)` | Creates an environment. Returns null if gravity is not finite or the world is invalid. |
| `ivp_delete(world)` | Destroys the environment. |
| `ivp_time(world)` | Current simulation time. |
| `ivp_event_count(world)` | Number of pending contact event rows. |
| `ivp_events(world, out, capacity)` | Copies pending event rows and clears the log. |
| `ivp_contacts(world, body, out, capacity)` | Lists active friction contacts of one body, sorted by contact id. A null output returns the count. |
| `ivp_ball(world, radius, descriptor, group)` | Adds a sphere body. |
| `ivp_hull(world, count, vertices, descriptor, group)` | Adds a convex hull body. |
| `ivp_trimesh(world, faces, triangles, descriptor, group)` | Adds a triangle-mesh body. |
| `ivp_compound(world, hulls, length, packed, descriptor, group)` | Adds one body made of several hulls, from packed input. |
| `ivp_group(world, body, group)` | Changes a body's collision identifier. |
| `ivp_remove(world, body)` | Removes a body with its pairs, forces, springs and joints. |
| `ivp_pair(world, first, second, enabled)` | Enables or disables collision between two bodies. |
| `ivp_wake(world, body)` | Wakes a body. |
| `ivp_joint(world, kind, reference, attached, descriptor)` | Adds a joint: 1 hinge, 2 slider, 3 ball-and-socket. Reference zero means world space. |
| `ivp_remove_joint(world, joint)` | Removes a joint. |
| `ivp_spring(world, reference, attached, descriptor)` | Adds a spring. |
| `ivp_remove_spring(world, spring)` | Removes a spring. |
| `ivp_force(world, body, corePoint, descriptor)` | Adds a force controller (adapted from Apache-2.0 CKBuildingBlocks; see THIRD_PARTY.md). |
| `ivp_remove_force(world, force)` | Removes a force controller. |
| `ivp_step(world, dt)` | Advances the simulation. The environment sub-steps internally. |
| `ivp_push(world, body, x, y, z)` | Asynchronous impulse at the body's geometric centre. |
| `ivp_push_at(world, body, values)` | Impulse at a point: 0-2 point of application (world), 3-5 impulse. |
| `ivp_state(world, body, out)` | Reads 17 doubles: position, orientation quaternion (interpolated), core speed, rotation speed, rotational inertia, movement state. |

## Determinism

- `-ffp-contract=off` is passed to both the compile (`CMAKE_CXX_FLAGS`) and the link
  (`em++`). The bridge header says: "Every floating-point operation order is kept so that
  results stay bit-identical." `build.json` records `floatingPointContraction: false`.
- `ivp_step` passes the interval unchanged; sub-stepping is inside IVP.
- The game's default step is `1/66` s and gravity is `-20` (`src/game/ivp-bridge.ts`).
- The dual-solver harness checks bit-identical results per solver (`--repeat 2`); see
  `docs/harness.md`.

## UNVERIFIED

- WSL Ubuntu as a requirement (not named in the build script or `Setup-Ballance.bat`).
- Whether a Windows host builds the module: `Setup-Ballance.bat` runs the script on Windows;
  the Linux-only header patch is skipped there. Not run.
- The production error text for a missing `ivp-simulation.mjs` (Node `ENOENT`, not run).
- `Launch-Ballance.bat` uses `?physics=rapier`; the code reads `?solver=`. The effect of the
  batch file's URL was not checked.
- The batch file's `*-compile.log` name does not match the script's `wasm-compile.log`.
- Whether the Emscripten version string written by `build.json` equals 6.0.2 (not run).
- The `docs/` link targets and the README statements were not checked against the code.
