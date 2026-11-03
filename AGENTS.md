# Agent guide

## Standing goal

Ballance runs from its authored NMO/CMO behavior graphs on a **generic Virtools
graph runtime**. The hand-ported module logic of the first interpretation was
validated against the graphs in the dual-solver harness and removed (commit
502bd84); levels, modules, menus and the tutorial now run from the graphs, and
the harness runs only the graph session.

Remaining work (see [docs/original-graph-runtime.md](docs/original-graph-runtime.md)):

1. **Behavior layer** — the open items in the runtime document: opaque locals
   the exporter does not decode, `2D Text`/`Set 2D Material`/light controls,
   `Deactivate Object`, and hosting `Levelinit_build` past `Set Prelit Color`.
   The behavior matrix `Known` column is the work queue.
2. **Hand-port knowledge left in the physics backends** — the dead hand-port
   code is purged; what remains are rules first taken from the removed
   hand-ports rather than from the original: the Rapier fallback's per-module
   anchors, joint wake and solver iterations. The IVP graph physics now follows
   physics_RT.dll for these rules (hinges, sliders and springs constrain against
   the FixCube body; the slider axis is the handler's float arithmetic). IVP is
   the faithful backend; Rapier is the approximate fallback, whose rules cannot
   be checked against the DLL because the DLL does not use Rapier.
3. **Validation** — keep every emitted harness scenario passing on both
   solvers, bit-identical per solver with `--repeat 2`.

Definition of done: every behavior used by gameplay is implemented and decoded,
nothing in gameplay depends on hand-port knowledge, and all emitted harness
scenarios pass on both backends.

## Constraints

- Work in the repository root on the current branch.
  Never reset, clean or discard the working tree. Do not commit unless asked.
- Keep changes faithful to the recovered original; no invented behavior or
  empirical tuning. Unsupported data must fail loudly rather than guess.
- Do not launch the original `Player.exe` from automation. With the maintainer's
  approval for the session, `scripts/original-oracle.py` may run the original
  game files as a short, windowed oracle (see
  [docs/original-oracle.md](docs/original-oracle.md)). Ask before downloading
  anything, and scan any download for malware before running it.

## Repository and data policy

- Correctness is measured against the recovered original, but the repository
  must stay distributable under the bring-your-own-game-files model.
- Never commit original game files or extracted/derived data that conflicts
  with redistribution: NMO/CMO/DLL/EXE/ISO files, textures, meshes, audio, level
  documents, exported behavior graphs, Data Arrays, decompiled listings,
  generated oracles or behavior matrices, extracted UI text, and release
  archives.
- Generate and load such data under `.local/` (served as `/original/`) from the
  user's install. Graph exports go to `.local/original/graphs/`; Data Arrays
  go to `.local/original/data-arrays.json`; recovered UI metadata, the menu
  ball animation and tutorial text go to `.local/original/ui-data.json`,
  `.local/original/menu-ball.json` and `.local/original/text/`.
- Commits may contain hand-written source, tooling, prose documentation,
  schemas, and small independently measured numeric constants. Bulk extracted
  tables and creative strings stay local.
- Tests, worker/deploy files, `shareable/`, release zips, and extracted assets
  are maintainer-local and ignored.
- Before pushing, verify `git ls-files` contains no forbidden paths and that
  generated local data is not staged.

## Verification (run after changes)

```
npx tsc -b
npm test
npm run lint
npm run build
```

For renderer/effects or harness changes, also run the relevant harness scenario
with both solvers and `--repeat 2` (bit-identical per solver), e.g.:

```
npm run harness -- stage8_swing --solver both --repeat 2
```

A hidden Vite dev server must be running at `http://127.0.0.1:5173/`
(`Test-Ballance.bat` / `scripts/dev-server.ps1`).

## Key paths

- Original pack: `.local/original/*.json`; chunk dumps: `.local/reference/chunks/*.tsv`.
- Graph export: `scripts/export-original-graph.py`; chunk reader `scripts/original_chunks.py`.
- Graph runtime: `src/game/original-graph.ts`; primitives `src/game/original-behaviors.ts`.
- Exported graphs: `.local/original/graphs/` (generated on demand, never committed).
- Behavior work queue: `.local/reference/behavior-matrix.md`, `.local/reference/behavior-matrix.json`.
- Harness: `src/harness/`; docs `docs/harness.md`.
