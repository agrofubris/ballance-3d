# Third-party material and credits

This project's own code and documentation are MIT-licensed ([LICENSE](LICENSE)).

## Ballance itself

Ballance was made by Cyparade and published by Atari. None of its files are in this
repository or in any package built from it: the game's documents, textures, sounds,
movies and text are read from the player's own installed copy and converted into
`.local/original/` on their machine (see [docs/original-import.md](docs/original-import.md)).

## Project origin

The idea of a browser port with stereo 3D started from
[fayazara/ballance](https://github.com/fayazara/ballance) by Fayaz Ahmed. That repository
has no licence file. Every file this project inherited from it has since been removed or
rewritten in a clean room: a description of what the old file did was written first, and
a separate author who never saw the old text wrote the new file from that description. The
results were checked byte for byte: the converted game pack, and per-tick physics traces of
all 87 harness scenarios with the rewritten IVP bridge.

## Reference reconstructions (Apache-2.0)

The behaviour graph runtime implements Virtools building blocks by following these public
reconstructions by doyaGu, licensed under the Apache License 2.0. Source files that follow a
specific building block name it in their comments.

| Repository | Revision | Used for |
| --- | --- | --- |
| [doyaGu/CKBuildingBlocks](https://github.com/doyaGu/CKBuildingBlocks/tree/fca1963e39e64daa480918661732b1b0e45fe7b8) | `fca1963` | building-block behaviour (logic, physics, sound, particles, 2D, collision) |
| [doyaGu/CK2](https://github.com/doyaGu/CK2/tree/122a5c896fb2d56d239063ba17d595b73de470de) | `122a5c8` | curves, time manager, object model |
| [doyaGu/VxMath](https://github.com/doyaGu/VxMath/tree/20625db68420ad1f443573d54b09bacfb8f78fa1) | `20625db` | oriented boxes, vector and matrix maths |

The licence texts are in [public/licenses/](public/licenses/) and are copied into every build.

## Physics

- **IVP** (Ipion Virtual Physics), the engine the original game used through Virtools'
  physics plugin. The source reference is [doyaGu/ivp](https://github.com/doyaGu/ivp/tree/7579664996e68040dd0158081b04f612e6a2d515)
  at `7579664`, which has no licence file. It is **not** included: a player who wants exact
  physics builds the WebAssembly module locally from their own copy of that source
  ([docs/original-ivp-wasm.md](docs/original-ivp-wasm.md)). This repository contains only
  its own bridge and build scripts.
- **Rapier** (`@dimforge/rapier3d-compat`, Apache-2.0) is the built-in solver used whenever
  the IVP module is absent. `npm run build:rapier` builds without IVP.

## Libraries and tools

- three.js (MIT), React and React DOM (MIT): rendering and interface.
- Electron (MIT) and Chromium: the desktop app. Packaged builds include their licence files
  under `LICENSES/`, together with the embeddable Python licence (PSF) used by the importer.
- `vendor/bmap-win-x64`: BMap and zlib built from MIT-licensed LibCmo21, YYCCommonplace, stb
  and zlib, and `dump-chunks.exe`, this project's `scripts/dump-original-chunks.cpp` linked
  statically against the same libraries (see its `README.txt`).
- Leia SR: the presenter in `tools/leia-presenter/` (`BallanceLeiaPresenter.exe` in the
  release) is built against the Leia SR SDK 1.34.10 through
  [SR-lib](https://github.com/bo3b/SR-lib) (Copyright (c) Bo3b Johnson, MIT). Neither is
  included in this repository, and the SR runtime DLLs are never shipped: they come with
  the player's SR Platform, and without it the mode falls back to side-by-side. The SDK's
  permission notice (Copyright 2025, Leia, Inc.) ships in the release as
  `LICENSES/LeiaSR-SDK-License.txt`. The approach follows oneup03's
  [RT64 3D](https://github.com/oneup03/rt64-3D) work and bo3b's SR-lib. Leia, Simulated
  Reality and SR are trademarks of Leia, Inc.; this project is not affiliated with Leia.
