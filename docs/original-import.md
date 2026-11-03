# Importing your Ballance files

The importer reads your own installed copy of Ballance and writes a local asset
pack. Nothing from the install is committed to this repository. The output stays
under `.local/original`, which the app serves as `/original/`.

## What the importer reads

The install folder must contain:

- `base.cmo`
- `3D Entities` or `3D_Entities` (the code accepts either name)

From that folder the importer reads these kinds of files:

- `3D Entities/*.nmo`: level documents, shared entities, menu and camera documents
- `Textures/*.tga`, `Textures/*.bmp`, `Textures/sky/*.bmp`: textures and sky images
- `Sounds/*.wav`: sound and music recordings
- `Text/Tutorial*.txt`: tutorial text
- `Database.tdb`, `Textures/atari.avi` and the sky `.bmp` files, copied as install files

Nothing is uploaded and the install folder is only read.

## Ways to run it

1. **Desktop app importer.** Open the import window in the app and choose the
   game folder. The app looks for the install in the Windows uninstall and
   registry entries, and you can also pick the folder. The app runs
   `scripts/prepare-original.py --no-ffmpeg` as a child process. The pack is
   written to the app's user data folder (`pack`); the chunk work folder is
   `import-work` in the same place. On success the work folder is deleted. On
   failure or cancel the pack folder is deleted.
2. **`Setup-Ballance.bat`.** The portable setup checks the game folder, downloads
   the pinned tools it needs, builds the BMap converter when the vendored copy is
   missing, and runs the pipeline. Its output goes to `.local\original`.
3. **Manual run.** From the repository root:

   ```
   python scripts/prepare-original.py --game "<game folder>" --library "<BMap.dll>" --dump-chunks "<dump-chunks.exe>"
   ```

   Optional flags:

   - `--output <dir>`: output folder. Default `.local/original`.
   - `--work <dir>`: chunk dump and scratch folder. Default `.local/reference/chunks`.
   - `--no-ffmpeg`: convert images and audio with the standard library instead of
     ffmpeg.

   `--game`, `--library` and `--dump-chunks` are required.

## Tools and licences

- **Python 3.** The desktop app bundles a Python embeddable build; `Setup-Ballance.bat`
  downloads Python 3.12.10 embeddable. Licence: PSF, as stated in
  `docs/tester-build.md`.
- **BMap.** A shared library (`BMap.dll`) that parses the NMO documents, loaded
  through ctypes by `scripts/extract-original.py`. The vendored build in
  `vendor/bmap-win-x64` is built from LibCmo21, YYCCommonplace, stb and zlib 1.3.1.
  LibCmo21, YYCCommonplace and stb are MIT; zlib is its own licence. The vendored
  DLLs need `zlib.dll` next to `BMap.dll`. See `vendor/bmap-win-x64/README.txt` and
  `THIRD_PARTY.md`.
- **dump-chunks.** `vendor/bmap-win-x64/dump-chunks.exe`, built from
  `scripts/dump-original-chunks.cpp` statically against LibCmo21, YYCCommonplace
  and zlib with MSVC. To rebuild it, build static LibCmo21, YYCCommonplace and
  zlib at the revisions in `vendor/bmap-win-x64/README.txt`, then from an x64
  Developer Command Prompt:

  ```
  cl /nologo /DYYCC_OS_WINDOWS /DNOMINMAX /DYYCC_CC_MSVC /DYYCC_ENDIAN_LITTLE /DYYCC_PTRSIZE_64 /std:c++latest /O2 /EHsc /utf-8 /MT /I <libcmo21>\include /I <yyccommonplace>\include /I <stb> /I <zlib>\include scripts\dump-original-chunks.cpp /Fe:dump-chunks.exe /link <libcmo21>\lib\LibCmo.lib <yyccommonplace>\lib\YYCCommonplace.lib <zlib>\lib\zlibstatic.lib
  ```
- **ffmpeg (optional).** Used for textures and audio unless `--no-ffmpeg` is given.
  `Setup-Ballance.bat` downloads a pinned FFmpeg essentials build. The licence of
  that build is not stated in the repository (unverified).

## Pipeline steps

`prepare-original.py` prints one `STEP n/24 <name>` line per phase. The steps run
in this order:

1. Check game folder
2. Dump chunk tables
3. Extract levels
4. Extract shared entities
5. Extract transformer meshes
6. Extract menu scene
7. Extract level geometry
8. Convert textures
9. Read music data
10. Read audio data
11. Convert audio
12. Export behavior graphs
13. Export Data Arrays
14. Export object tables
15. Read hinge data
16. Read transformer clock
17. Generate harness stages
18. Read interface data
19. Read menu animation
20. Read camera and collision data
21. Read object and player data
22. Copy tutorial text
23. Export install files
24. Write manifest

`Setup-Ballance.bat` and the desktop app pass the vendored
`vendor/bmap-win-x64/dump-chunks.exe` as `--dump-chunks`.

## Output pack layout

Everything is written under the output folder (default `.local/original`).

- `manifest.json`: level list, checkpoint members and the sky and audio formats
- one `<document name in lowercase>.json` per NMO document that `extract-original.py`
  exports, for example `level_01.json` (read by `write_manifest`) and
  `levelinit.json`; the menu documents are `Menu.nmo`, `MenuLevel.nmo`,
  `Camera.nmo` and `Tutorial.nmo` (unverified which are written in full)
- `textures/`: texture PNGs
- `sky/`: sky images (`.jpg`, or `.png` with `--no-ffmpeg`)
- `audio/`: `.ogg` and `.m4a` files, or `.wav` with `--no-ffmpeg`
- `text/`: tutorial text files
- `graphs/`: exported behavior graphs
- `objects/`: object tables
- `install/`: copied install files
- `data-arrays.json`: Data Arrays (the app checks for this file)
- `music-data.json`, `audio-data.json`, `ui-data.json`, `menu-ball.json`,
  `object-data.json`, `player-data.json`, `hinge-data.json`,
  `transformer-clock-data.json`, `camera-data.json`, `collision-data.json`: data
  read by the reader scripts
- `harness-stages.json`: stage starts for the harness

## Troubleshooting

The messages below are the ones the code prints.

- `Missing <game>/3D_Entities`: the folder has no `3D_Entities` directory. The
  code accepts `3D Entities` with a space too; check the install folder.
- `Missing <game>/base.cmo`: `base.cmo` is not in the install folder.
- `BMap initialization failed`: `BMInit` returned false. Check that `BMap.dll`
  and `zlib.dll` are next to each other.
- `Missing chunk dump <path>; prepare-original.py dumps every document first`:
  the chunk dump for a document is missing from the work folder. Run the full
  pipeline again so step 2 runs.
- `Missing install file: <path>`: one of the install files listed in step 23 is
  missing from the game folder.
- Desktop app: `The selected folder is not a Ballance installation: it must
  contain base.cmo and "3D Entities" or "3D_Entities".`
- Desktop app: `The importer is missing ...`: one of Python, BMap, dump-chunks or
  `prepare-original.py` was not found. The message lists which.
- Desktop app: `The import failed (exit code N).`: the pipeline exited with an
  error. Read the log lines in the import window.
- Desktop app: `Could not start the importer: <error>`: the Python process could
  not start.
- Desktop app: `The selected folder does not contain data-arrays.json`: a pack
  was chosen that is not a complete import.
- `Asset conversion failed. See the detailed instructions in docs\original-import.md.`
  (printed by `Setup-Ballance.bat`): the step named in the `STEP n/24` line above
  it failed; its own error is printed just before.
