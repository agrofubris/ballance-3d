# Dual-solver stage harness

The harness runs the same scripted gameplay input against the authored graph
session on the IVP and Rapier backends, and records camera-independent traces. It exists to find
the first behavioral divergence between the two backends, not to render, replay,
or tune anything. Every level has a spawned, module-route and finish scenario;
the generated Level 4-12 routes are described under stage coverage.

## 132 Hz tick semantics

Ballance simulates at 132 Hz (`ORIGINAL_PSI_HZ * ORIGINAL_TIME_FACTOR`).
`dt = 1/132` and every script/trace index is a physics tick. Browser and display
frame rates never schedule scripted input: the harness page cancels the game's
`requestAnimationFrame` loop and advances the runtime `step(1/132)` in a
synchronous loop. The per-run `meta.simMs` field reports how long that tick loop actually
took. A 600-tick scenario is under 100 ms of simulation on the development
machine.

## Same script, both solvers

Scenarios are TypeScript definitions in `src/harness/scenarios.ts`
(`HarnessScenario`): level, start state, tick-bounded input segments, optional
tick-scheduled actions, assertions, and comparison tolerances.

- Input is state-based. Each tick the harness computes `{forward, lateral,
  brake}` and feeds the graph session's authored input paths, so both backends
  consume the same input abstraction.
- Scenarios may also use a stateful `HarnessController` that reads the previous
  trace sample and returns the same input to both backends. This is test-driver
  feedback (for example, steer toward a fan after the paper ball clears the
  upper grille), not gameplay logic; the controller is reset once per run.
- Starts are either the normal gameplay spawn (`kind: 'spawn'`) or explicit
  deterministic injection (`kind: 'inject'`) routed through the graph runtime's
  authored staging path, leaving sector, checkpoint, finish lifecycle, and
  player physicalization in equivalent game state.
- No gameplay logic is duplicated. The harness drives and observes the real
  graph session.
- Settlement is explicit. Injected scenarios may open with a zero-input input
  segment; `compare.startTick` then starts the canonical cross-solver
  comparison after that interval, while the complete raw trace (including the
  settling ticks) is still written for diagnostics.

## Graph runtime (default)

`npm run harness` runs the authored graph session (`GraphHarnessRuntime`). A run
starts the level the way the game does: the harness clicks through `Menu_Start` (`CurrentLevel[0][0]` is written at
preload tick 3010) and steps the authored `Load Level` / `Levelinit_build` /
`Gameplay_Ingame` scripts until the spawn materializes. The observer reads the
session's own state rather than a hand-port trace: `CurrentLevel`,
`IngameParameter`, `Energy`, the active ball's transformation/respawn scripts,
the `PE_Balloon` copy bodies and the installed force-controller keys. Contacts
and module mechanism fields (hinge, slider, pusher, chain, fan, ...) reuse the
selected backend's Rapier/IVP definitions.

For a `spawn` start, tick 0 is the first frame after
`Ball_LightningSphere` materializes. An `inject` start first runs the authored
spawn, then stages the material switch, `New Ball`'s positioning and
physicalize/wake tail (without its lightning or 3000 ms Delayer), and the sector
selection; tick 0 is the frame `Gameplay_SectorManager` runs `Activate Sector`
6525, with the ball already physical at its target. Every harness tick is one
authored script frame (1/132 s).

`--solver rapier|ivp|both` selects the backend: Rapier uses the original Rapier world
definitions, IVP the native module (required for IVP runs). Both backends share
the same authored graph; only solver state and capability fields differ.

## What is compared

Each tick records ball pose/rotation/velocities, the intended input, lifecycle
state (sector, checkpoint, finish phase, spawn, respawn), contacts
(`grounded`, semantic support IDs, contact count), and explicit events
(`spawn.begin`, `spawn.unveil`, `ball.physicalized`, `checkpoint.enter`,
`sector.activate`, `finish.wake`, `finish.boarding`, `finish.departure.begin`,
`finish.departure.end`, `ball.dead`, `level.complete`). Camera state is never
recorded.

Comparison rules:

- Tolerances belong to scenarios. `poseTolerance` is in world/render units
  (0.25 x original model units); if a scenario does not declare one, the
  comparison reports exact-equality semantics instead of inventing a default.
  `longitudinalPositionTolerance` and `longitudinalVelocityTolerance` use
  render units and render units/second.
- The canonical range is `[compare.startTick, canonicalEndTick]`. Raw traces are
  never truncated.
- Comparison stops at the first `ball.dead` in either trace; the comparison
  records `truncated` with the tick/event/solver so post-death teleports cannot
  contaminate trajectory maxima.
- Contact/support divergence requires `supportPersistence` consecutive differing
  ticks. A one-tick support flicker is reported separately as
  `firstSupportFlicker` and does not classify as a persistent divergence.
- Longitudinal parity covers the rolling lead-in before the first persistent
  contact-set or lateral divergence, not the static contact offset.
- Known-gap windows are reported independently for contact-set, lateral, and
  pose divergences; one satisfied or violated window never suppresses another
  result. Violations fail the run.
- Assertions are lifecycle/state checks evaluated per solver against the trace,
  with optional backend scoping for fields one backend truly cannot exercise.

## Known gap

- Stage 1 crowned bridge: the documented Rapier-vs-IVP contact-manifold
  difference. `stage1_stone_crown` stages the stone on the authored deck
  surface, settles for 40 zero-input ticks, then drives +X. The known-gap
  windows expect the first persistent contact-set divergence when the ball
  reaches the deck end/entry plates and the first lateral divergence shortly
  after, and only fail if those move outside the recorded windows. The
  resulting trajectories also disagree on reaching the Level 1 finish volume
  (Rapier reports a late `finishPhase`/`ball.dead`), so the scenario declares no
  assertions and passes on the recorded known-gap windows and determinism.

## Level 2 baseline

Level 2 now has four dual-solver scenarios:

- `stage2_spawn` - real level-start presentation and physicalization. Both
  backends pass all lifecycle assertions; as in Level 1, the post-physicalize
  contact settlement differs slightly (first pose divergence at tick 398,
  about 1.3 mm, growing to centimetres while the ball settles).
- `stage2_fan_transfer` - paper starts above `P_Modul_18_01`, hovers, then a
  stateful controller steers it to `P_Modul_18_12`. Both solvers engage the
  raised fan and settle near `(251.67, 19.95, 91.69)`; all 12 assertions pass.
  The lower-fan release timing differs: Rapier reports `P_Modul_18_01` active at
  tick 96 while IVP has already left that column, and the transfer reaches about
  2 render units of intermediate X divergence before both settle over the upper
  fan. This is recorded as a fan-lift timing/parity gap, not hidden by changing
  fan force or geometry.
- `stage2_bridge` - wood starts on the approach to the nine-plank
  `P_Modul_29_01` bridge, waits for grounded support, then drives across. Both
  solvers cross the far side; all four assertions pass. The first contact-set
  difference is the first plank at tick 9 (`A02_Floor_01` alone on Rapier versus
  floor plus `P_Modul_29_Platte01` on IVP), and the maximum longitudinal
  divergence is about 2.6 render units.
- `stage2_finish_ride` - the rider is staged on the Level 2
  `PE_Balloon_Platform`. Both solvers board, depart, survive and reach
  `level.complete`; all 20 assertions pass. Completion is one tick offset
  (Rapier tick 1724, IVP 1725). The same bounded finish-constraint solver gap as
  Level 1 applies.

These are recorded baselines, not claims of exact Level 2 parity. The fan
transfer timing, bridge contact onset, and finish completion offset remain
open. Levels 3-12 have the same spawn/finish coverage plus generated
fan/bridge/arm/swing/lift/sack routes where the level contains those modules.

## Commands

```sh
npm run harness -- --list
npm run harness -- stage1_spawn --solver both --repeat 2
npm run harness -- stage1_stone_crown --solver rapier
npm run harness -- stage1_stone_crown --solver ivp
npm run harness -- stage1_stone_crown --solver both
npm run harness -- stage1_wood_finish --solver both --repeat 2
npm run harness -- stage1_stone_crown --solver both --contacts
npm run harness -- stage2_fan_transfer --solver both --contacts
npm run harness -- stage2_bridge --solver both
npm run harness -- stage2_finish_ride --solver both
npm run harness -- stage3_arm --solver both --contacts
npm run harness -- stage3_bridge --solver both
npm run harness -- stage3_fan_lift --solver both
npm run harness -- stage3_finish_ride --solver both
npm run harness -- stage12_finish_ride --solver both
npm run harness -- stage12_fan_lift --solver both
npm run harness -- stage8_swing --solver both --repeat 2
```

The scenario's optional `module` selection pins one authored module instance
so the observer records that placement. Generated graphs and frames load from
`.local/original`; IVP runs require the native IVP module.

`--repeat N` runs the scenario N times per solver. Determinism is only claimed
when at least two same-solver traces were compared; with `--repeat 1` the
summary reports `unassessed`. `--contacts` enables verbose per-contact
manifolds (world normal, point, separation, feature IDs; impulses where the
backend exposes them). `--out DIR` overrides the output root and `--timeout`
sets the seconds allowed for the whole browser batch.

Initial suite: `stage1_spawn`, `stage1_stone_crown`, `stage1_wood_finish`,
`stage1_finish_reset`. `stage1_finish_ride` stages the rider directly on the
supported departing platform with zero input and requires the whole recovered
ride (departure, persistent support, survival, completion) on both backends.
Level 2 adds `stage2_spawn`, `stage2_fan_transfer`, `stage2_bridge` and
`stage2_finish_ride`. Level 3 adds `stage3_spawn`, `stage3_fan_lift`,
`stage3_arm`, `stage3_bridge` and `stage3_finish_ride`. Levels 4-12 add the
generated spawn/fan/bridge/finish set described under stage coverage.

## Output

Results are written under `.local/harness/<scenario>/<timestamp>/`
(`rapier.jsonl`, `ivp.jsonl`, optional `*.runN.jsonl`, `meta.json`,
`comparison.json`, `assertions.json`, `summary.txt`). `meta.json` carries one
entry per run with its capabilities and notes, resolved once per harness
process: `gitRevision` (full 40-character HEAD hash), `gitDirty`
(true when tracked or staged files differ from HEAD; untracked files are not
counted) and `gitBranch`. All three are `null` when git metadata is
unavailable, and the harness still runs. `.local/` is ignored; no generated
trace is part of the repository.

## Native IVP availability

Native execution needs the separately built local module at
`.local/ivp-simulation` (`python3 scripts/build-ivp-simulation.py`). If it is
absent, Rapier-only runs still work, `--solver both` runs Rapier and prints a
clean `SKIPPED` status for IVP, and the process exits successfully. No native
binary or original asset is bundled.

## Browser runner and process hygiene

The page entry `harness.html` is development-only and is not part of the
production build. The CLI starts Vite in-process (no server child process) and
launches `chrome-headless-shell` from `.tools/chrome-headless` or
`BALLANCE_CHROME`, headless, at a fixed 320x240 viewport with software WebGL.
Physics stays real; only rendering is minimal.

Cleanup runs in `finally` and on SIGINT/SIGTERM: the browser process tree is
terminated by PID with `taskkill /T`, its temporary profile directory under
`%TEMP%` is removed with retries, the in-process dev server is closed, and the
port is released. Ctrl+C therefore leaves no browser children or profile
directories behind. No screenshots, preview archives, or converted assets are
created by the harness.

## Level 3 baseline

Level 3 now has five dual-solver scenarios:

- `stage3_spawn` - spawn presentation and physicalization. All 10 assertions
  pass; the post-physicalize settling divergence matches Levels 1-2.
- `stage3_fan_lift` - paper starts above `P_Modul_18_02` with zero input. Both
  solvers engage the fan and hover at least 15 original units above its origin;
  all 6 assertions pass. The same early fan activation/timing difference as
  Level 2 appears at tick 96.
- `stage3_arm` - stone approaches `P_Modul_17_01` from the recovered 10-unit
  lever line and drives to the authored exit. Both solvers reach the exit and
  stop on static floor support; all 8 assertions pass. Maximum longitudinal
  divergence is about 0.40 render units, with first pose divergence at tick 1.
- `stage3_bridge` - wood crosses the Level 3 nine-plank `P_Modul_29_01` bridge
  and stops after the far edge. Both solvers cross; all 4 assertions pass. The
  first contact-set difference is the first plank at tick 35, and maximum
  longitudinal divergence is about 1.24 render units.
- `stage3_finish_ride` - the rider is staged on the Level 3
  `PE_Balloon_Platform`. Both solvers board, depart, survive and complete; all
  20 assertions pass, with the same one-tick completion offset and bounded
  finish-constraint gap as Levels 1-2.

`--repeat 2` runs are bit-identical per solver for the arm, bridge and finish
scenarios. These are recorded baselines, not exact Level 3 parity.

## Stage coverage

| Level | Harness scenarios | Other evidence | Main open work |
| ---: | --- | --- | --- |
| 1 | `stage1_spawn`, `stage1_stone_crown`, `stage1_wood_finish`, `stage1_transform_respawn`, `stage1_finish_reset`, `stage1_finish_ride` | gates, sliders, lift, pusher and finish tests | crown contact manifold and finish constraint solver are bounded known gaps; no uninterrupted recorded playthrough |
| 2 | `stage2_spawn`, `stage2_fan_transfer`, `stage2_bridge`, `stage2_finish_ride` | fan, chain, seesaw and module tests | fan activation/early-lift timing, bridge contact onset, finish completion offset; no full playthrough |
| 3 | `stage3_spawn`, `stage3_fan_lift`, `stage3_arm`, `stage3_bridge`, `stage3_finish_ride` | fan, arm, chain, hinge and finish tests | fan activation timing, bridge contact onset, finish completion offset; no full playthrough |
| 4-12 | generated `stageN_spawn`, `stageN_fan_lift`, `stageN_bridge` where the level has `P_Modul_29`, `stageN_finish_ride`, plus `stageN_arm` where the level has `P_Modul_17`, `stageN_swing` where the level has `P_Modul_08`, `stageN_lift` where the level has `P_Modul_03`, and `stageN_sack` for every `P_Modul_26` placement in Levels 8-12 | module adapters and staged route checks | all generated scenarios pass and are bit-identical per solver with `--repeat 2` |

Levels 4-12 use `.local/original/harness-stages.json`, generated by
`scripts/generate-harness-stages.py` from the local original pack and served as
`/original/harness-stages.json`. The generator
raycasts the authored `Phys_Floor*` triangles for bridge approaches and applies
the recovered platform-local rider offset to each `PE_Balloon_Platform`. Swing
and lift routes reuse the authored module frames: the swing scenario waits for
the recovered deck phase before staging the ball at the rail entrance and drives
along the `P_Modul_08_Fix` axis before counter-steering to the exit; the lift
scenario settles on the paired rails, drives through the doorway and asserts the
recovered spring compresses under the ball's load. Sack routes approach
perpendicular to the recovered `P_Modul_26_Halter` drive axis and counter-steer
to stay centred on the authored paired rail (Level 12's rail is only ~0.75 units
wide), then hold station on the sack origin once `lifecycle.sackTravel` leaves
zero so momentum cannot carry the ball off the rail end. The harness seeds
`Math.random` from the scenario id so debris and spawn smoke cannot make repeated
runs diverge. Level 12's ending is the UFO presentation, so its finish scenario
runs 4,200 ticks and additionally asserts the native `ufoStage` sequence
(`waiting`/`flight`/`flash`/`done`); it reaches `level.complete` on both
backends.

The remaining parity work is no longer missing levels: every level now has
spawn, fan-hover, bridge-where-present, arm-where-present, swing-where-present,
lift-where-present, sack-where-present and finish coverage. What remains is
uninterrupted playthroughs and the documented solver-fidelity gaps.

## Follow-ups (documented, not fixed here)

- `stage1_transform_respawn` observes the whole transformer sequence about 30
  ticks earlier than its authored windows (capture 95 vs 125, explode 405 vs
  438, release 424 vs 455) identically on both solvers. The stage durations are
  validated separately, so the scenario windows are stale rather than a solver
  divergence; they need to be re-derived from the current approach timing.
- Entry-plate managed-vs-foreign support identity is coarser than the platform
  identity; a future pass could tag each finish part body explicitly.
- The native player velocity convention (`world.state(...) * 0.5` with
  reflected Z) deserves a code comment in `GraphSessionObserver`.
- Native `platformColliders` is reported from the recovered hull list rather
  than introspected from the IVP compound.
